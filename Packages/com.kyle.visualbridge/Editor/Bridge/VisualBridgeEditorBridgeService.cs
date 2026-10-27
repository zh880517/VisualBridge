using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using Newtonsoft.Json.Linq;
using UnityEditor;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 面向 Editor 的 bridge 服务。用 Integration Profile 的 authoring 项目
    /// 匹配已发布的发现记录；多个窗口匹配时要求显式选择，连接失败按退避重试。
    /// 握手身份在进程内稳定（editor-&lt;pid&gt;）。会话身份（sessionId / recordPath /
    /// debugEnabled）由 <see cref="VisualBridgeSessionState"/> 经 SessionState 跨
    /// Domain Reload 保存：重连时以 resumeSessionId 续接，并优先连回上次的发现记录。
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

        /// <summary>已持久化的会话身份；没有会话时是 <see cref="VisualBridgeSessionState.Empty"/>。</summary>
        public VisualBridgeSessionState Session => VisualBridgeSessionState.Load();

        /// <summary>Editor 进程内稳定的拨号方端点标识（Domain Reload 不改变）。</summary>
        public static string LocalEndpointId()
        {
            return "editor-" + Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

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
            var previousSession = Session;
            var contractHash = VisualBridgeDebugContractFingerprint.Read(UnityProjectRoot());
            var instance = new VisualBridgeEditorBridgeClient(
                window,
                LocalEndpointId(),
                contractHash,
                previousSession.HasSession ? previousSession.SessionId : null);
            try
            {
                instance.Connect(timeoutMs);
            }
            catch
            {
                instance.Dispose();
                throw;
            }

            // 会话身份跨 Domain Reload 保存：下次连接以 resumeSessionId 续接，
            // 服务端据此返回 resumed（不匹配时安全起新会话，并以新 sessionId 覆盖）。
            previousSession
                .WithConnection(instance.SessionId, window.RecordPath, instance.ServerDebugEnabled)
                .Save();
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
            var mayReuseRememberedWindow = true;
            VisualBridgeIntegrationException lastFailure = null;
            while (stopwatch.ElapsedMilliseconds < totalTimeoutMs)
            {
                progress?.Invoke("discovering windows");
                IReadOnlyList<VisualBridgeBridgeWindow> windows;
                // 只有第一次尝试复用上次连接窗口：失败说明记录已不可用，后续一律重新枚举。
                var remembered = mayReuseRememberedWindow
                    ? TryReuseRememberedWindow(unityProjectRoot, discoveryDirectory, progress)
                    : null;
                mayReuseRememberedWindow = false;
                if (remembered != null)
                {
                    windows = new[] { remembered };
                }
                else
                {
                    try
                    {
                        windows = FindWindows(unityProjectRoot, discoveryDirectory);
                    }
                    catch (VisualBridgeIntegrationException exception)
                    {
                        lastFailure = exception;
                        windows = new VisualBridgeBridgeWindow[0];
                    }
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
                ?? VisualBridgeEditorBridgeValidator.Error("runtime.noEndpoint", "$", "No live bridge window was discovered.");
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

        /// <summary>
        /// 复用上次连接窗口的发现记录：会话续接只对**同一个** VS Code 窗口有意义，
        /// 凭记录路径直接复核比重新枚举更确定。记录已删除、心跳过期、发布进程已死或
        /// 项目根不匹配时返回 null，调用方退回枚举（附录 A.7 的陈旧判定仍由 LoadRecord 执行）。
        /// 显式指定发现目录（测试/手工）时不做复用，避免读到目录外的旧记录。
        /// </summary>
        private VisualBridgeBridgeWindow TryReuseRememberedWindow(
            string unityProjectRoot,
            string discoveryDirectory,
            Action<string> progress)
        {
            var recordPath = Session.RecordPath;
            if (string.IsNullOrEmpty(recordPath) || discoveryDirectory != null || !File.Exists(recordPath))
            {
                return null;
            }

            try
            {
                var root = unityProjectRoot ?? UnityProjectRoot();
                var profile = VisualBridgeIntegrationProfileLoader.Load(root);
                var authoringRoot = Path.GetDirectoryName(profile.AuthoringProjectPath);
                var window = VisualBridgeEditorBridgeDiscovery.LoadRecord(recordPath);
                if (!string.Equals(window.Role, "vscode", StringComparison.Ordinal))
                {
                    return null;
                }

                if (!window.ProjectRoots.Any(projectRoot => VisualBridgeEditorBridgeDiscovery.IsSamePath(projectRoot, authoringRoot)))
                {
                    return null;
                }

                progress?.Invoke($"reusing the remembered window {window.WindowId}");
                return window;
            }
            catch (VisualBridgeIntegrationException exception)
            {
                progress?.Invoke($"remembered window unusable: {exception.Code}");
                return null;
            }
            catch (IOException exception)
            {
                progress?.Invoke($"remembered window unreadable: {exception.Message}");
                return null;
            }
        }
    }

    /// <summary>
    /// 读取 D2 调试生成器产出的 <c>debug-contracts.json</c> 指纹，供 Editor 握手使用。
    /// 本类只读取、不计算 Fingerprint（附录 A.3 的"无契约时空串"）：
    /// 契约层 <c>manifest.schemaVersion</c> 不等于 <see cref="ContractSchemaVersion"/>
    /// 时该目录契约不加载，按无契约处理。
    /// </summary>
    internal static class VisualBridgeDebugContractFingerprint
    {
        /// <summary>调试契约文件格式版本（D2 回填附录 B.5 的 manifest.schemaVersion）。</summary>
        public const int ContractSchemaVersion = 2;

        private static readonly Regex HashPattern = new Regex("^[0-9a-f]{16}$", RegexOptions.Compiled);

        public const string Empty = "";

        /// <summary>返回工程的调试契约指纹；无产物、格式不符或字段非法时返回空串。</summary>
        public static string Read(string unityProjectRoot)
        {
            if (string.IsNullOrWhiteSpace(unityProjectRoot))
            {
                return Empty;
            }

            // 握手可能在后台线程执行：这里不能用 AssetDatabase 读取 ScriptableObject 配置。
            // 只认默认产物根；自定义 ArtifactsRoot 的工程按"无契约"处理（降级 JSON，不拒连）。
            var artifactsRoot = VisualBridgeDebugGeneratorSettings.DefaultArtifactsRoot;

            string contractPath;
            try
            {
                contractPath = Path.Combine(
                    Path.GetFullPath(unityProjectRoot),
                    artifactsRoot.Replace('/', Path.DirectorySeparatorChar),
                    "debug-contracts.json");
            }
            catch
            {
                return Empty;
            }

            try
            {
                if (!File.Exists(contractPath))
                {
                    return Empty;
                }

                var value = VisualBridgeIntegrationProfileLoader.ReadStrictObject(contractPath, "debug.contractsInvalid");
                var manifest = value["manifest"] as JObject;
                if (manifest == null || manifest["schemaVersion"] == null || manifest["schemaVersion"].Type != JTokenType.Integer)
                {
                    return Empty;
                }

                if (manifest["schemaVersion"].Value<int>() != ContractSchemaVersion)
                {
                    // 契约层拒绝：版本不符时不加载该目录契约。
                    return Empty;
                }

                var hash = value["contractHash"];
                if (hash == null || hash.Type != JTokenType.String || !HashPattern.IsMatch(hash.Value<string>()))
                {
                    return Empty;
                }

                return hash.Value<string>();
            }
            catch
            {
                return Empty;
            }
        }
    }
}
