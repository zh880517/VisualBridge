using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Editor Bridge 的 batch 入口。E2E 方法在真实（非 batchmode）Unity Editor 会话中
    /// 经 -executeMethod 与隔离的 VS Code Extension Host 一起运行，并写出结构化结果文件
    /// 供编排测试读取；菜单入口复用同一服务。
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
        /// 对存活的 VS Code 窗口执行 bridge open/reveal 往返。通过环境变量配置，
        /// 使同一方法既服务自动化 E2E 门槛也服务手工验证。
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
