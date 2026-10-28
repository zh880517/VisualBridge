using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>自动重连的下一步动作。</summary>
    internal enum VisualBridgeAutoConnectAction
    {
        /// <summary>没有可续接的会话或已经连着：什么都不做。</summary>
        Skip,

        /// <summary>发现记录新鲜：立刻重连（<c>hello</c> 带 SessionState 里的 <c>resumeSessionId</c>）。</summary>
        Connect,

        /// <summary>暂时没有可连的窗口：按退避再试。</summary>
        Retry,

        /// <summary>退避已用尽：放弃并清空持久化会话。</summary>
        GiveUp,
    }

    internal readonly struct VisualBridgeAutoConnectDecision
    {
        public VisualBridgeAutoConnectDecision(VisualBridgeAutoConnectAction action, int delayMilliseconds)
        {
            Action = action;
            DelayMilliseconds = delayMilliseconds;
        }

        public VisualBridgeAutoConnectAction Action { get; }

        public int DelayMilliseconds { get; }
    }

    /// <summary>
    /// Domain Reload 后自动重连的决策策略（附录 A.8 的重连语义）。抽成纯函数是为了让
    /// "退避 1 s / 2 s / 4 s 三次后放弃并清空"可以被单测钉住，而不用等真实计时。
    /// </summary>
    internal static class VisualBridgeAutoConnectPolicy
    {
        public static readonly IReadOnlyList<int> BackoffMilliseconds = new[] { 1000, 2000, 4000 };

        public static VisualBridgeAutoConnectDecision Decide(bool hasSession, bool isConnected, int liveWindowCount, int failedAttempts)
        {
            if (isConnected || !hasSession)
            {
                return new VisualBridgeAutoConnectDecision(VisualBridgeAutoConnectAction.Skip, 0);
            }

            if (liveWindowCount > 0)
            {
                return new VisualBridgeAutoConnectDecision(VisualBridgeAutoConnectAction.Connect, 0);
            }

            return failedAttempts >= BackoffMilliseconds.Count
                ? new VisualBridgeAutoConnectDecision(VisualBridgeAutoConnectAction.GiveUp, 0)
                : new VisualBridgeAutoConnectDecision(VisualBridgeAutoConnectAction.Retry, BackoffMilliseconds[failedAttempts]);
        }
    }

    /// <summary>
    /// 编辑器模式的重连交换机（E5）：每次 Domain Reload 后检查 SessionState，
    /// 有活跃会话且发现记录新鲜时立刻重连，<c>hello</c> 带 <c>resumeSessionId</c>；
    /// 没有窗口可连时按 1 s / 2 s / 4 s 退避 3 次，然后放弃并清空持久化会话。
    /// 只在交互式 Editor 会话里运行（batchmode 的自动化编排自己决定连接时机），
    /// 需要时可用 <c>VISUALBRIDGE_BRIDGE_AUTOCONNECT=1</c> 强制打开。
    /// </summary>
    [InitializeOnLoad]
    public static class VisualBridgeEditorBridgeAutoConnect
    {
        private const string LogPrefix = "[bridge] auto-connect";

        /// <summary>单次尝试的握手预算：reload 后主线程只等这么久，失败交给退避。</summary>
        private const int ConnectTimeoutMs = 1500;

        /// <summary>已连接时刷新 <c>lastSeenUtc</c> 的间隔；远小于 15 s 宽限，保证长会话后 reload 仍可续接。</summary>
        private const double LivenessIntervalSeconds = 5.0;

        private static bool ticking;
        private static int failedAttempts;
        private static double nextAttemptAt;
        private static double nextLivenessAt;

        /// <summary>发现目录覆盖（仅 EditMode 测试注入，生产路径为 null = 系统临时目录）。</summary>
        internal static string DiscoveryDirectoryOverride;

        static VisualBridgeEditorBridgeAutoConnect()
        {
            // delayCall：静态构造发生在 reload 中间，此时连 socket 会打扰资产导入。
            EditorApplication.delayCall += () => Start("domain reload");
            EditorApplication.update += MaintainSessionLiveness;
            // 服务端会在空闲时主动推通道 0 的控制消息（附录 A.2 的 debugSetEnabled）：
            // 请求/响应模型没有读循环，必须由主线程逐帧非阻塞收，否则面板点一次开关就等 4 s 超时。
            EditorApplication.update += PumpBridgeControlMessages;
        }

        /// <summary>是否正在等待重试（供窗口/状态栏读取）。</summary>
        public static bool IsReconnecting => ticking;

        /// <summary>本轮已失败的尝试次数。</summary>
        public static int FailedAttempts => failedAttempts;

        /// <summary>开始一轮自动重连（幂等：已经在跑就不重复启动）。</summary>
        public static void Start(string reason)
        {
            if (UnityEditorInternal.InternalEditorUtility.inBatchMode
                && Environment.GetEnvironmentVariable("VISUALBRIDGE_BRIDGE_AUTOCONNECT") != "1")
            {
                return;
            }

            if (ticking)
            {
                return;
            }

            failedAttempts = 0;
            nextAttemptAt = EditorApplication.timeSinceStartup;
            ticking = true;
            EditorApplication.update += Tick;
            TryOnce(reason);
        }

        /// <summary>停止重试（不改变已持久化的会话）。</summary>
        public static void Stop()
        {
            if (!ticking)
            {
                return;
            }

            ticking = false;
            EditorApplication.update -= Tick;
        }

        private static void Tick()
        {
            if (!ticking || EditorApplication.timeSinceStartup < nextAttemptAt)
            {
                return;
            }

            TryOnce("retry");
        }

        private static void TryOnce(string reason)
        {
            var service = VisualBridgeEditorBridgeService.Instance;
            var session = service.Session;
            if (session.IsReconnectGraceExpired(DateTime.UtcNow))
            {
                // 超过 15 s 宽限（附录 A.8）：旧会话不再续接。清空本地会话数据后按新会话
                // 重连，hello 不携带 resumeSessionId；服务端也会换新 sessionId。
                VisualBridgeSessionState.Clear();
                session = VisualBridgeSessionState.Empty;
                Debug.LogWarning(
                    $"{LogPrefix}: reconnect grace of {VisualBridgeSessionState.ReconnectGraceMs} ms expired ({reason}); stored session cleared, starting a new session.");
            }

            var windows = service.FindWindows(null, DiscoveryDirectoryOverride);
            var decision = VisualBridgeAutoConnectPolicy.Decide(
                session.HasSession,
                service.IsConnected,
                windows.Count,
                failedAttempts);
            switch (decision.Action)
            {
                case VisualBridgeAutoConnectAction.Skip:
                    Stop();
                    return;

                case VisualBridgeAutoConnectAction.Connect:
                    break;

                case VisualBridgeAutoConnectAction.Retry:
                    failedAttempts++;
                    nextAttemptAt = EditorApplication.timeSinceStartup + decision.DelayMilliseconds / 1000.0;
                    Debug.Log($"{LogPrefix}: no live VS Code window ({reason}); retry {failedAttempts} in {decision.DelayMilliseconds} ms.");
                    return;

                default:
                    // 放弃：清空持久化会话，下一次连接从全新会话开始（绝不假装续接）。
                    Stop();
                    VisualBridgeSessionState.Clear();
                    Debug.LogWarning($"{LogPrefix}: giving up after {failedAttempts} attempts ({reason}); stored session cleared.");
                    return;
            }

            var window = SelectWindow(service, windows);
            if (window == null)
            {
                failedAttempts++;
                nextAttemptAt = EditorApplication.timeSinceStartup + DecisionBackoff(failedAttempts);
                return;
            }

            try
            {
                var client = service.Connect(window, ConnectTimeoutMs);
                Stop();
                Debug.Log($"{LogPrefix}: reconnected to {window.WindowId} session={client.SessionId} resumed={client.Resumed} ({reason}).");
            }
            catch (Exception exception)
            {
                failedAttempts++;
                if (failedAttempts > VisualBridgeAutoConnectPolicy.BackoffMilliseconds.Count)
                {
                    Stop();
                    VisualBridgeSessionState.Clear();
                    Debug.LogWarning($"{LogPrefix}: giving up after {failedAttempts} attempts ({reason}): {exception.Message}");
                    return;
                }

                nextAttemptAt = EditorApplication.timeSinceStartup + DecisionBackoff(failedAttempts);
                Debug.LogWarning($"{LogPrefix}: attempt {failedAttempts} failed ({reason}): {exception.Message}");
            }
        }

        private static double DecisionBackoff(int attempts)
        {
            var index = Math.Min(attempts, VisualBridgeAutoConnectPolicy.BackoffMilliseconds.Count) - 1;
            return VisualBridgeAutoConnectPolicy.BackoffMilliseconds[Math.Max(0, index)] / 1000.0;
        }

        /// <summary>
        /// 每帧（不节流）收一次服务端主动推来的控制消息：面板的开关命令带着 4 s 超时回滚，
        /// 用 5 s 的存活节拍去收必然超时，所以这里跟 <see cref="EditorApplication.update"/> 同频。
        /// </summary>
        private static void PumpBridgeControlMessages()
        {
            VisualBridgeEditorBridgeService.Instance.Pump();
        }

        /// <summary>
        /// 连接存活期间周期刷新会话的 <c>lastSeenUtc</c>。没有这一步，长会话后 Domain Reload
        /// 会用"连接建立时刻"判断宽限，把本可续接的会话误判成过期。
        /// </summary>
        private static void MaintainSessionLiveness()
        {
            if (EditorApplication.timeSinceStartup < nextLivenessAt)
            {
                return;
            }

            nextLivenessAt = EditorApplication.timeSinceStartup + LivenessIntervalSeconds;
            var service = VisualBridgeEditorBridgeService.Instance;
            if (service.IsConnected)
            {
                service.TouchSessionLiveness(DateTime.UtcNow);
            }
        }

        /// <summary>优先连回上次那条记录；记录已消失时退回唯一候选，多个候选则不猜。</summary>
        private static VisualBridgeBridgeWindow SelectWindow(
            VisualBridgeEditorBridgeService service,
            IReadOnlyList<VisualBridgeBridgeWindow> windows)
        {
            var previous = service.Session;
            foreach (var candidate in windows)
            {
                if (previous.HasSession
                    && string.Equals(candidate.RecordPath, previous.RecordPath, StringComparison.Ordinal))
                {
                    return candidate;
                }
            }

            return windows.Count == 1 ? windows[0] : null;
        }
    }
}
