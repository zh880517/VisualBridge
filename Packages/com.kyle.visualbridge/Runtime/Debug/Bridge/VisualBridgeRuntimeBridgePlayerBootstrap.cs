using System;
using System.IO;
using UnityEngine;

namespace VisualBridge.Diagnostics.Bridge
{
    /// <summary>
    /// Player 腿自动监听（附录 A.8 的 <c>AutoListenInPlayer</c>）：独立 Player 没有 Editor
    /// 的 Play 模式钩子，必须在 <c>BeforeSceneLoad</c> 自建 Runtime Bridge 监听，并在退出时回收。
    /// 端口段与开关来自环境变量（与 runtime-e2e 注入的 <c>VISUALBRIDGE_RUNTIME_E2E_PORT_RANGE</c> 同形）：
    /// <c>VISUALBRIDGE_RUNTIME_AUTO_LISTEN=0</c> 关闭监听，<c>VISUALBRIDGE_RUNTIME_PORT_RANGE=28300-28349</c> 指定端口段。
    /// 绑定 <c>0.0.0.0</c> 且**不带 token**（附录 E.3 已接受的风险），启动时打印显式警告。
    /// 心跳与轮询线程由 server 自己维护；查询 pump 在这里挂到 PlayerLoop 上。
    /// </summary>
    public static class VisualBridgeRuntimeBridgePlayerBootstrap
    {
        public const string AutoListenEnvironmentVariable = "VISUALBRIDGE_RUNTIME_AUTO_LISTEN";
        public const string PortRangeEnvironmentVariable = "VISUALBRIDGE_RUNTIME_PORT_RANGE";
        public const int DefaultPortRangeStart = 28300;
        public const int DefaultPortRangeEnd = 28349;
        /// <summary>Player 端点 id 前缀（sessionId = <c>player-&lt;pid&gt;#bootId</c>）。</summary>
        public const string InstancePrefix = "player-";

        private static VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer server;

        /// <summary>Player 构建是否自动监听（环境变量缺省开启，附录 A.8）。</summary>
        public static bool AutoListenInPlayer
        {
            get
            {
                var raw = Environment.GetEnvironmentVariable(AutoListenEnvironmentVariable);
                return !string.Equals(raw, "0", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(raw, "false", StringComparison.OrdinalIgnoreCase);
            }
        }

        /// <summary>当前 Player 监听（未启动时为 null）。</summary>
        public static VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer CurrentServer => server;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void AutoListen()
        {
            if (Application.isEditor)
            {
                // Editor 的 Play 模式由 VisualBridgeRuntimeBridgeHost 以 editor-play 身份监听；
                // 这里再建一条会变成两个端点。
                return;
            }

            if (!AutoListenInPlayer)
            {
                Debug.Log($"[runtime-bridge] player auto-listen disabled by {AutoListenEnvironmentVariable}.");
                return;
            }

            TryStart(0, out var detail);
            Debug.Log($"[runtime-bridge] player auto-listen: {detail}");
        }

        /// <summary>
        /// 启动 Player 监听。返回 false 时 <paramref name="detail"/> 说明原因（端口段耗尽/绑定失败等）。
        /// 测试可传 <paramref name="artifactsRoot"/> 与 <paramref name="bindAllInterfaces"/>，避免依赖真实构建。
        /// </summary>
        public static bool TryStart(
            int preferredPort,
            out string detail,
            string artifactsRoot = null,
            bool bindAllInterfaces = true)
        {
            if (server != null)
            {
                detail = $"listener already running on port {server.TcpPort}.";
                return true;
            }

            var root = artifactsRoot ?? Path.Combine(Application.streamingAssetsPath, "VisualBridge", "Compiled");
            try
            {
                Directory.CreateDirectory(root);
            }
            catch (Exception exception) when (exception is IOException || exception is UnauthorizedAccessException)
            {
                detail = $"cannot prepare artifacts root '{root}': {exception.Message}";
                Debug.LogError($"[runtime-bridge] player auto-listen failed: {detail}");
                return false;
            }

            ResolvePortRange(out var portRangeStart, out var portRangeEnd);
            var instanceId = InstancePrefix + System.Diagnostics.Process.GetCurrentProcess().Id;
            try
            {
                // 无 token + 绑定全部网卡：这是 Player 腿对局域网开放、且不做认证的既定设计。
                server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    instanceId,
                    "player",
                    preferredPort,
                    string.Empty,
                    root,
                    1,
                    message => Debug.Log(message),
                    bindAllInterfaces: bindAllInterfaces,
                    portRangeStart: portRangeStart,
                    portRangeEnd: portRangeEnd);
            }
            catch (Exception exception)
            {
                detail = $"cannot start player listener on ports {portRangeStart}-{portRangeEnd}: {exception.Message}";
                Debug.LogError($"[runtime-bridge] player auto-listen failed: {detail}");
                return false;
            }

            VisualBridgeDebugQueryPump.EnsureInstalled();
            Application.quitting += Stop;
            Debug.LogWarning(
                $"[runtime-bridge] WARNING: player listener bound to {server.ListenAddress}:{server.TcpPort} without authentication "
                + "(局域网内无认证); any machine on the same network can connect and read snapshots.");
            detail = $"instanceId={instanceId} port={server.TcpPort} address={server.ListenAddress} auth=none range={portRangeStart}-{portRangeEnd}";
            return true;
        }

        /// <summary>停止 Player 监听（幂等；Player 退出时自动调用）。</summary>
        public static void Stop()
        {
            var current = server;
            server = null;
            if (current == null)
            {
                return;
            }

            Application.quitting -= Stop;
            current.Dispose();
        }

        /// <summary>解析 <c>VISUALBRIDGE_RUNTIME_PORT_RANGE=start-end</c>；非法或缺省时回落到附录 A.8 的默认段。</summary>
        public static void ResolvePortRange(out int portRangeStart, out int portRangeEnd)
        {
            portRangeStart = DefaultPortRangeStart;
            portRangeEnd = DefaultPortRangeEnd;
            var raw = Environment.GetEnvironmentVariable(PortRangeEnvironmentVariable);
            if (string.IsNullOrEmpty(raw))
            {
                return;
            }

            var separator = raw.IndexOf('-');
            if (separator <= 0
                || !int.TryParse(raw.Substring(0, separator), out var start)
                || !int.TryParse(raw.Substring(separator + 1), out var end)
                || start <= 0 || end < start || end > 65535)
            {
                Debug.LogWarning($"[runtime-bridge] ignoring invalid {PortRangeEnvironmentVariable}='{raw}'.");
                return;
            }

            portRangeStart = start;
            portRangeEnd = end;
        }
    }
}
