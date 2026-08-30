using System;
using System.Collections.Generic;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Minimal Editor Bridge window: lists matching VS Code windows, requires an
    /// explicit selection, and sends open/reveal requests from the Unity Editor.
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
        private bool connected;

        [MenuItem("Tools/VisualBridge/Editor Bridge/Open in VS Code…")]
        public static void Open()
        {
            GetWindow<VisualBridgeEditorBridgeWindow>(true, "VisualBridge Editor Bridge");
        }

        private void OnEnable()
        {
            // Domain Reload clears all static and instance state; refresh from scratch.
            windows = new VisualBridgeBridgeWindow[0];
            selectedWindow = 0;
            connected = false;
            busy = false;
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

                    if (GUILayout.Button("Connect"))
                    {
                        ConnectSelected();
                    }

                    using (new EditorGUI.DisabledScope(!connected))
                    {
                        if (GUILayout.Button("Disconnect"))
                        {
                            VisualBridgeEditorBridgeService.Instance.Disconnect();
                            connected = VisualBridgeEditorBridgeService.Instance.IsConnected;
                            AppendLog("disconnected");
                        }
                    }
                }
            }

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
                connected = VisualBridgeEditorBridgeService.Instance.IsConnected;
                AppendLog($"discovery: {windows.Length} matching window(s)");
            }
            catch (Exception exception)
            {
                windows = new VisualBridgeBridgeWindow[0];
                AppendLog($"discovery failed: {exception.Message}");
            }
        }

        private void ConnectSelected()
        {
            if (windows.Length == 0)
            {
                AppendLog("no window to connect to");
                return;
            }

            try
            {
                var window = windows[Math.Min(selectedWindow, windows.Length - 1)];
                VisualBridgeEditorBridgeService.Instance.Connect(window);
                connected = VisualBridgeEditorBridgeService.Instance.IsConnected;
                AppendLog($"connected to {window.WindowId} (generation {window.Generation})");
            }
            catch (Exception exception)
            {
                connected = false;
                AppendLog($"connect failed: {exception.Message}");
            }
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
                    connected = service.IsConnected;
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
                        return;
                    }

                    action = mainThreadQueue.Dequeue();
                }

                action();
            }
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
