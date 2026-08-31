using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Batch entry points for the Editor Bridge. The E2E methods run in a real
    /// (non-batchmode) Unity Editor session via -executeMethod, together with an
    /// isolated VS Code Extension Host, and write a structured result file that
    /// the orchestrating test reads. Menu entries reuse the same service.
    /// </summary>
    public static class VisualBridgeBridgeBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;

        private const int E2ETotalTimeoutMs = 180_000;

        [MenuItem("Tools/VisualBridge/Editor Bridge/Open Sample Document in VS Code")]
        private static void OpenSampleDocumentFromMenu()
        {
            var response = VisualBridgeEditorBridgeService.Instance.OpenDocumentWithRetry(
                "Config/Game.gamesettings", null, E2ETotalTimeoutMs, message => Debug.Log($"[bridge] {message}"));
            Debug.Log($"[bridge] open result: {(response.IsOk ? "ok" : response.ErrorCode)}");
        }

        /// <summary>
        /// Runs the bridge open and reveal round trip against a live VS Code window.
        /// Configured through environment variables so the same method serves the
        /// automated E2E gate and manual verification.
        /// </summary>
        public static void RunE2E()
        {
            var documentPath = Environment.GetEnvironmentVariable("VISUALBRIDGE_BRIDGE_E2E_DOCUMENT") ?? "Config/Game.gamesettings";
            var referenceValue = Environment.GetEnvironmentVariable("VISUALBRIDGE_BRIDGE_E2E_REFERENCE") ?? "sample.unity.game.settings.default";
            var resultPath = Environment.GetEnvironmentVariable("VISUALBRIDGE_BRIDGE_E2E_RESULT");
            if (string.IsNullOrEmpty(resultPath))
            {
                Debug.LogError("[bridge] VISUALBRIDGE_BRIDGE_E2E_RESULT is required for the bridge E2E run.");
                EditorApplication.Exit(FailureExitCode);
                return;
            }

            var result = new System.Text.StringBuilder();
            var exitCode = SuccessExitCode;
            try
            {
                var openResponse = VisualBridgeEditorBridgeService.Instance.OpenDocumentWithRetry(
                    documentPath, null, E2ETotalTimeoutMs, message => Debug.Log($"[bridge] open: {message}"));
                result.Append($"open={(openResponse.IsOk ? "ok" : openResponse.ErrorCode)}\n");
                if (!openResponse.IsOk)
                {
                    exitCode = FailureExitCode;
                }

                var revealResponse = VisualBridgeEditorBridgeService.Instance.RevealReferenceWithRetry(
                    referenceValue, false, null, E2ETotalTimeoutMs, message => Debug.Log($"[bridge] reveal: {message}"));
                result.Append($"reveal={(revealResponse.IsOk ? "ok" : revealResponse.ErrorCode)}\n");
                if (!revealResponse.IsOk)
                {
                    exitCode = FailureExitCode;
                }
            }
            catch (Exception exception)
            {
                result.Append($"error={exception.Message}\n");
                exitCode = FailureExitCode;
            }

            try
            {
                File.WriteAllText(resultPath, result.ToString());
            }
            catch (Exception exception)
            {
                Debug.LogError($"[bridge] failed to write the E2E result: {exception.Message}");
                EditorApplication.Exit(FailureExitCode);
                return;
            }

            EditorApplication.Exit(exitCode);
        }
    }
}
