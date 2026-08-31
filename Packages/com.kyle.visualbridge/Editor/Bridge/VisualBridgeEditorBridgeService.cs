using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 面向 Editor 的 bridge 服务。用 Integration Profile 的 authoring 项目
    /// 匹配已发布的发现记录；多个窗口匹配时要求显式选择，连接失败按退避重试。
    /// </summary>
    public sealed class VisualBridgeEditorBridgeService
    {
        private static readonly TimeSpan InitialBackoff = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan MaximumBackoff = TimeSpan.FromSeconds(30);

        private VisualBridgeEditorBridgeClient client;

        public static VisualBridgeEditorBridgeService Instance { get; } = new VisualBridgeEditorBridgeService();

        public VisualBridgeEditorBridgeClient Client => client;

        public VisualBridgeBridgeWindow ConnectedWindow { get; private set; }

        public bool IsConnected => client != null && client.State == VisualBridgeBridgeConnectionState.Connected;

        public static string UnityProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(UnityEngine.Application.dataPath, ".."));
        }

        /// <summary>
        /// 加载 Unity 项目的 Integration Profile，返回项目根包含该 authoring
        /// 项目的存活 bridge 窗口。
        /// </summary>
        public IReadOnlyList<VisualBridgeBridgeWindow> FindWindows(string unityProjectRoot = null, string discoveryDirectory = null)
        {
            var root = unityProjectRoot ?? UnityProjectRoot();
            var profile = VisualBridgeIntegrationProfileLoader.Load(root);
            var authoringRoot = Path.GetDirectoryName(profile.AuthoringProjectPath);
            return FindWindowsForAuthoringRoot(authoringRoot, discoveryDirectory);
        }

        public IReadOnlyList<VisualBridgeBridgeWindow> FindWindowsForAuthoringRoot(string authoringRoot, string discoveryDirectory = null)
        {
            if (string.IsNullOrEmpty(authoringRoot))
            {
                throw new ArgumentException("Authoring root is required.", nameof(authoringRoot));
            }

            var matches = new List<VisualBridgeBridgeWindow>();
            foreach (var window in VisualBridgeEditorBridgeDiscovery.EnumerateWindows(null, discoveryDirectory))
            {
                if (window.ProjectRoots.Any(projectRoot => VisualBridgeEditorBridgeDiscovery.IsSamePath(projectRoot, authoringRoot)))
                {
                    matches.Add(window);
                }
            }

            return matches;
        }

        /// <summary>
        /// 连接显式指定的窗口。连接永远不会静默挑选窗口，
        /// 调用方必须从候选列表中选定一个。
        /// </summary>
        public VisualBridgeEditorBridgeClient Connect(VisualBridgeBridgeWindow window, int timeoutMs = 3000)
        {
            if (window == null)
            {
                throw new ArgumentNullException(nameof(window));
            }

            Disconnect();
            var instance = new VisualBridgeEditorBridgeClient(window, Guid.NewGuid().ToString(), new[] { "open", "reveal" });
            try
            {
                instance.Connect(timeoutMs);
            }
            catch
            {
                instance.Dispose();
                throw;
            }

            client = instance;
            ConnectedWindow = window;
            return client;
        }

        public void Disconnect()
        {
            client?.Dispose();
            client = null;
            ConnectedWindow = null;
        }

        public VisualBridgeBridgeMessage OpenDocument(string documentPath, int timeoutMs = 5000)
        {
            EnsureConnected();
            return client.SendRequest(
                VisualBridgeEditorBridgeValidator.CreateOpen(NewRequestId(), documentPath),
                timeoutMs);
        }

        public VisualBridgeBridgeMessage RevealReference(string referenceValue, bool referenceIsNumber, int timeoutMs = 5000)
        {
            EnsureConnected();
            return client.SendRequest(
                VisualBridgeEditorBridgeValidator.CreateReveal(NewRequestId(), referenceValue, referenceIsNumber),
                timeoutMs);
        }

        /// <summary>
        /// 带重新发现与重连退避执行 open 请求，用于窗口可能仍在启动的场景。
        /// 要求恰好一个匹配窗口——歧义永远以显式选择错误呈现，绝不猜测。
        /// </summary>
        public VisualBridgeBridgeMessage OpenDocumentWithRetry(
            string documentPath,
            string unityProjectRoot = null,
            int totalTimeoutMs = 30000,
            Action<string> progress = null,
            string discoveryDirectory = null)
        {
            return RequestWithRetry(
                connectedClient => connectedClient.SendRequest(
                    VisualBridgeEditorBridgeValidator.CreateOpen(NewRequestId(), documentPath),
                    5000),
                unityProjectRoot,
                totalTimeoutMs,
                progress,
                discoveryDirectory);
        }

        public VisualBridgeBridgeMessage RevealReferenceWithRetry(
            string referenceValue,
            bool referenceIsNumber,
            string unityProjectRoot = null,
            int totalTimeoutMs = 30000,
            Action<string> progress = null,
            string discoveryDirectory = null)
        {
            return RequestWithRetry(
                connectedClient => connectedClient.SendRequest(
                    VisualBridgeEditorBridgeValidator.CreateReveal(NewRequestId(), referenceValue, referenceIsNumber),
                    5000),
                unityProjectRoot,
                totalTimeoutMs,
                progress,
                discoveryDirectory);
        }

        private VisualBridgeBridgeMessage RequestWithRetry(
            Func<VisualBridgeEditorBridgeClient, VisualBridgeBridgeMessage> send,
            string unityProjectRoot,
            int totalTimeoutMs,
            Action<string> progress,
            string discoveryDirectory)
        {
            var stopwatch = Stopwatch.StartNew();
            var backoff = InitialBackoff;
            VisualBridgeIntegrationException lastFailure = null;
            while (stopwatch.ElapsedMilliseconds < totalTimeoutMs)
            {
                progress?.Invoke("discovering windows");
                IReadOnlyList<VisualBridgeBridgeWindow> windows;
                try
                {
                    windows = FindWindows(unityProjectRoot, discoveryDirectory);
                }
                catch (VisualBridgeIntegrationException exception)
                {
                    lastFailure = exception;
                    windows = new VisualBridgeBridgeWindow[0];
                }

                if (windows.Count == 0)
                {
                    progress?.Invoke("no matching window");
                }
                else if (windows.Count > 1)
                {
                    throw VisualBridgeEditorBridgeValidator.Error(
                        "bridge.windowAmbiguous",
                        "$",
                        $"{windows.Count} windows serve this authoring project; connect to one explicitly.");
                }
                else
                {
                    progress?.Invoke($"connecting to window {windows[0].WindowId}");
                    try
                    {
                        Disconnect();
                        var connected = Connect(windows[0]);
                        progress?.Invoke("sending request");
                        return send(connected);
                    }
                    catch (VisualBridgeIntegrationException exception)
                    {
                        lastFailure = exception;
                        progress?.Invoke($"attempt failed: {exception.Code}");
                    }
                }

                var remaining = totalTimeoutMs - stopwatch.ElapsedMilliseconds;
                if (remaining <= 0)
                {
                    break;
                }

                var delay = (int)Math.Min(Math.Min(backoff.TotalMilliseconds, remaining), MaximumBackoff.TotalMilliseconds);
                Thread.Sleep(delay);
                backoff = TimeSpan.FromTicks(Math.Min(backoff.Ticks * 2, MaximumBackoff.Ticks));
            }

            throw lastFailure
                ?? VisualBridgeEditorBridgeValidator.Error("bridge.timeout", "$", "Timed out waiting for a matching bridge window.");
        }

        private void EnsureConnected()
        {
            if (!IsConnected)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connect to a window before sending requests.");
            }
        }

        private static string NewRequestId()
        {
            return "req-" + Guid.NewGuid().ToString("N");
        }
    }
}
