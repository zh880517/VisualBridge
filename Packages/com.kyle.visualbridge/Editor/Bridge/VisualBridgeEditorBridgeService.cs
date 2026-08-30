using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Editor-facing bridge service. Resolves the Integration Profile's authoring
    /// project against published discovery records, requires an explicit window
    /// choice when several windows match, and retries connection with backoff.
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
        /// Loads the Integration Profile for the Unity project and returns the live
        /// bridge windows whose project roots contain the profile's authoring project.
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
        /// Connects to the explicitly chosen window. Connecting never silently
        /// picks a window; the caller selects one from the candidate list.
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
        /// Runs an open request with re-discovery and reconnect backoff; used when
        /// the window may be starting up. Requires exactly one matching window —
        /// ambiguity always surfaces as an explicit-choice error, never a guess.
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
