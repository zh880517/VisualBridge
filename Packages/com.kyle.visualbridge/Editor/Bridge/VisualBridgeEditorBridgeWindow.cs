using System;
using System.Collections.Generic;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 最小 Editor Bridge 窗口：列出匹配的 VS Code 窗口、要求显式选择，
    /// 并从 Unity Editor 发送 open/reveal 请求。
    /// </summary>
    public sealed class VisualBridgeEditorBridgeWindow : EditorWindow
    {
        private const string DefaultDocumentPath = "Config/Game.gamesettings";

        private readonly List<string> log = new List<string>();
        private readonly Queue<Action> mainThreadQueue = new Queue<Action>();
        private string documentPath = DefaultDocumentPath;
        private string referenceValue = string.Empty;
        private Vector2 logScroll;
        private VisualBridgeBridgeWindow[] windows = new VisualBridgeBridgeWindow[0];
        private int selectedWindow;
        private bool busy;
        private bool lastConnected;
        private bool lastReconnecting;

        /// <summary>服务实时连接状态；窗口不缓存它（Domain Reload 后缓存会撒谎）。</summary>
        private static bool IsConnected => VisualBridgeEditorBridgeService.Instance.IsConnected;

        [MenuItem("Tools/VisualBridge/Editor Bridge/Open in VS Code…")]
        public static void Open()
        {
            GetWindow<VisualBridgeEditorBridgeWindow>(true, "VisualBridge Editor Bridge");
        }

        private void OnEnable()
        {
            // Domain Reload 会清空全部静态与实例状态，必须整体重建。
            windows = new VisualBridgeBridgeWindow[0];
            selectedWindow = 0;
            busy = false;
            lastConnected = IsConnected;
            lastReconnecting = VisualBridgeEditorBridgeAutoConnect.IsReconnecting;
            AppendLog("Editor Bridge ready. Discovery re-scans on Refresh.");
            EditorApplication.update += DrainMainThreadQueue;
        }

        private void OnDisable()
        {
            EditorApplication.update -= DrainMainThreadQueue;
            VisualBridgeEditorBridgeService.Instance.Disconnect();
        }

        private void OnGUI()
        {
            // E5：连接状态每帧从服务实时读取——不要缓存到字段里（Domain Reload 后缓存会撒谎，
            // 自动连接器随后连上也不会让窗口自己重画）。
            var connected = IsConnected;

            var runtimeServer = VisualBridgeRuntimeBridgeHost.CurrentServer;
            if (runtimeServer != null
                && runtimeServer.ListenAddress.Equals(System.Net.IPAddress.Any)
                && runtimeServer.Token.Length == 0)
            {
                // Player 腿的监听 0.0.0.0 无认证（附录 E.3 接受的风险）：必须让用户看见，
                // 不能只写 Debug.Log。
                EditorGUILayout.HelpBox(
                    $"Runtime Bridge listens on 0.0.0.0:{runtimeServer.TcpPort} without a token — "
                    + "局域网内无认证，同一网络中的任何机器都能连接并读取快照。",
                    MessageType.Error);
            }
            else if (VisualBridge.Diagnostics.Bridge.VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenInPlayer)
            {
                // 没在监听也照样警告：构建出的 Player 会以同样方式暴露（AutoListenInPlayer）。
                VisualBridge.Diagnostics.Bridge.VisualBridgeRuntimeBridgePlayerBootstrap.ResolvePortRange(
                    out var rangeStart, out var rangeEnd);
                EditorGUILayout.HelpBox(
                    $"Player builds auto-listen on 0.0.0.0:{rangeStart}-{rangeEnd} without a token "
                    + "(AutoListenInPlayer) — 局域网内无认证，同一网络中的任何机器都能连接并读取快照。"
                    + $" 设置环境变量 {VisualBridge.Diagnostics.Bridge.VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable}=0 可关闭。",
                    MessageType.Warning);
            }

            EditorGUILayout.LabelField("Matching VS Code windows", EditorStyles.boldLabel);
            if (windows.Length == 0)
            {
                EditorGUILayout.HelpBox("No window found for this project's authoring root. Start VS Code with the VisualBridge extension, then Refresh.", MessageType.Info);
            }
            else
            {
                var labels = new string[windows.Length];
                for (var index = 0; index < windows.Length; index++)
                {
                    labels[index] = $"{windows[index].WindowId} (generation {windows[index].Generation})";
                }

                selectedWindow = EditorGUILayout.Popup("Window", Math.Min(selectedWindow, windows.Length - 1), labels);
            }

            using (new EditorGUILayout.HorizontalScope())
            {
                using (new EditorGUI.DisabledScope(busy))
                {
                    if (GUILayout.Button("Refresh"))
                    {
                        RefreshWindows();
                    }

                    using (new EditorGUI.DisabledScope(!connected))
                    {
                        if (GUILayout.Button("Disconnect"))
                        {
                            VisualBridgeEditorBridgeService.Instance.Disconnect();
                            VisualBridgeSessionState.Clear();
                            AppendLog("disconnected (session cleared)");
                        }
                    }
                }
            }

            // E5：编辑器模式没有"启动传输 / 手动连接"这一步——VS Code 监听、Unity 自动拨号。
            var client = VisualBridgeEditorBridgeService.Instance.Client;
            var status = DescribeStatus(
                VisualBridgeEditorBridgeAutoConnect.IsReconnecting,
                VisualBridgeEditorBridgeAutoConnect.FailedAttempts,
                connected,
                client != null && client.Resumed);
            EditorGUILayout.HelpBox(status, connected ? MessageType.Info : MessageType.Warning);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Requests", EditorStyles.boldLabel);
            documentPath = EditorGUILayout.TextField("Document path", documentPath);
            using (new EditorGUI.DisabledScope(!connected || busy))
            {
                if (GUILayout.Button("Open document"))
                {
                    RunRequest("open", service => Describe(service.OpenDocument(documentPath)));
                }

                referenceValue = EditorGUILayout.TextField("Reference", referenceValue);
                if (GUILayout.Button("Reveal reference"))
                {
                    long numeric;
                    var isNumber = long.TryParse(referenceValue, out numeric);
                    RunRequest("reveal", service => Describe(service.RevealReference(referenceValue, isNumber)));
                }
            }

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Log", EditorStyles.boldLabel);
            logScroll = EditorGUILayout.BeginScrollView(logScroll, GUILayout.MinHeight(120));
            foreach (var line in log)
            {
                EditorGUILayout.SelectableLabel(line, GUILayout.Height(EditorGUIUtility.singleLineHeight));
            }

            EditorGUILayout.EndScrollView();
        }

        /// <summary>
        /// 窗口状态文案（纯函数，便于 EditMode 断言三种状态）：连接中 / 已恢复 / 新会话。
        /// </summary>
        internal static string DescribeStatus(bool reconnecting, int failedAttempts, bool connected, bool resumed)
        {
            if (reconnecting)
            {
                return $"Connecting to VS Code… (attempt {failedAttempts + 1})";
            }

            if (connected)
            {
                return resumed ? "Reconnected (session resumed)." : "Connected (new session).";
            }

            return "Disconnected. Unity reconnects automatically after a domain reload; disconnect here only to drop the session.";
        }

        private static string Describe(VisualBridgeBridgeMessage response)
        {
            return response.IsOk
                ? "ok"
                : $"error {response.ErrorCode}";
        }

        private void RefreshWindows()
        {
            try
            {
                windows = new List<VisualBridgeBridgeWindow>(VisualBridgeEditorBridgeService.Instance.FindWindows()).ToArray();
                selectedWindow = 0;
                AppendLog($"discovery: {windows.Length} matching window(s)");
                if (IsConnected)
                {
                    DescribeConnection();
                }
            }
            catch (Exception exception)
            {
                windows = new VisualBridgeBridgeWindow[0];
                AppendLog($"discovery failed: {exception.Message}");
            }
        }

        /// <summary>E5：手动连接入口已删除——编辑器模式由自动连接器拨号，这里只展示连接详情。</summary>
        private void DescribeConnection()
        {
            var client = VisualBridgeEditorBridgeService.Instance.Client;
            if (client == null)
            {
                AppendLog("no connection (auto-connect dials the VS Code window)");
                return;
            }

            AppendLog($"connected to {client.Window.WindowId} (generation {client.Window.Generation})");
            // 指纹层不拒连：两侧 hash 都展示出来，数据面按 payloads 降级。
            AppendLog(
                $"contract client='{client.ContractHash}' server='{client.ServerContractHash}' "
                + $"payloads=[{string.Join(",", client.ServerPayloads ?? Array.Empty<string>())}] "
                + $"session={client.SessionId} resumed={client.Resumed} debugEnabled={client.ServerDebugEnabled}");
        }

        private void RunRequest(string label, Func<VisualBridgeEditorBridgeService, string> send)
        {
            busy = true;
            var service = VisualBridgeEditorBridgeService.Instance;
            var captured = send;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string result;
                try
                {
                    result = captured(service);
                }
                catch (Exception exception)
                {
                    result = $"failed: {exception.Message}";
                }

                EnqueueOnMainThread(() =>
                {
                    busy = false;
                    AppendLog($"{label}: {result}");
                });
            });
        }

        private void EnqueueOnMainThread(Action action)
        {
            lock (mainThreadQueue)
            {
                mainThreadQueue.Enqueue(action);
            }
        }

        private void DrainMainThreadQueue()
        {
            while (true)
            {
                Action action;
                lock (mainThreadQueue)
                {
                    if (mainThreadQueue.Count == 0)
                    {
                        break;
                    }

                    action = mainThreadQueue.Dequeue();
                }

                action();
            }

            // 自动连接器在后台把状态改掉时窗口不会自己重画：这里检测跳变并主动 Repaint，
            // 让"重连中 → 已恢复/新会话"真的出现在界面上。
            var connected = IsConnected;
            var reconnecting = VisualBridgeEditorBridgeAutoConnect.IsReconnecting;
            if (connected == lastConnected && reconnecting == lastReconnecting)
            {
                return;
            }

            if (connected && !lastConnected)
            {
                DescribeConnection();
            }

            lastConnected = connected;
            lastReconnecting = reconnecting;
            Repaint();
        }

        private void AppendLog(string line)
        {
            log.Add($"[{DateTime.Now:HH:mm:ss}] {line}");
            if (log.Count > 100)
            {
                log.RemoveRange(0, log.Count - 100);
            }

            logScroll.y = float.MaxValue;
            Repaint();
        }
    }
}
