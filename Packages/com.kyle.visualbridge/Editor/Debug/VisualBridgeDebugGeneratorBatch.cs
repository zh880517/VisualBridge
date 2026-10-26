using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 调试契约生成器的 Unity 入口（D2 的 <c>IGenerate</c>/<c>ICheck</c>）：菜单与 batchmode
    /// <c>-executeMethod VisualBridge.Editor.VisualBridgeDebugGeneratorBatch.Generate/.Check</c> 共用同一服务。
    /// 退出码：0 成功、1 执行失败、2 Check 发现 drift（与三域 Compiler 一致）。
    /// </summary>
    public static class VisualBridgeDebugGeneratorBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;
        public const int DriftExitCode = 2;

        public static void Generate()
        {
            RunBatch(VisualBridgeDebugGenerateMode.Generate);
        }

        public static void Check()
        {
            RunBatch(VisualBridgeDebugGenerateMode.Check);
        }

        [MenuItem("Tools/VisualBridge/Generate Debug Contracts")]
        private static void GenerateFromMenu()
        {
            RunMenu(VisualBridgeDebugGenerateMode.Generate);
        }

        [MenuItem("Tools/VisualBridge/Check Debug Contracts")]
        private static void CheckFromMenu()
        {
            RunMenu(VisualBridgeDebugGenerateMode.Check);
        }

        private static void RunBatch(VisualBridgeDebugGenerateMode mode)
        {
            try
            {
                var result = Compile(mode);
                LogResult(result);
                EditorApplication.Exit(ExitCode(mode, result));
            }
            catch (VisualBridgeDebugGeneratorException exception)
            {
                Debug.LogError("VisualBridge debug contract " + ModeName(mode) + " failed [" + exception.Code + "]: "
                    + exception.Message);
                EditorApplication.Exit(FailureExitCode);
            }
            catch (Exception exception)
            {
                Debug.LogError("VisualBridge debug contract " + ModeName(mode) + " failed: " + exception);
                EditorApplication.Exit(FailureExitCode);
            }
        }

        /// <summary>batchmode 退出码映射：Check 发现 drift → 2，其余成功 → 0；失败路径统一 1。</summary>
        internal static int ExitCode(VisualBridgeDebugGenerateMode mode, VisualBridgeDebugCompileResult result)
        {
            return mode == VisualBridgeDebugGenerateMode.Check && result.DriftDetected
                ? DriftExitCode
                : SuccessExitCode;
        }

        private static void RunMenu(VisualBridgeDebugGenerateMode mode)
        {            try
            {
                var result = Compile(mode);
                LogResult(result);
                if (mode == VisualBridgeDebugGenerateMode.Check && result.DriftDetected)
                {
                    EditorUtility.DisplayDialog(
                        "VisualBridge",
                        "Generated debug contracts have drift. See the Console for details.",
                        "OK");
                }
            }
            catch (VisualBridgeDebugGeneratorException exception)
            {
                Debug.LogError("VisualBridge debug contract " + ModeName(mode) + " failed [" + exception.Code + "]: "
                    + exception.Message);
                EditorUtility.DisplayDialog("VisualBridge", "Debug contract " + ModeName(mode) + " failed. See the Console.", "OK");
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("VisualBridge", "Debug contract " + ModeName(mode) + " failed. See the Console.", "OK");
            }
        }

        private static VisualBridgeDebugCompileResult Compile(VisualBridgeDebugGenerateMode mode)
        {
            var projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            var config = VisualBridgeDebugConfig.LoadOrDefault();
            var settings = new VisualBridgeDebugGeneratorSettings(projectRoot)
            {
                ArtifactsRoot = config.ArtifactsRoot,
            };
            return VisualBridgeDebugGenerator.Compile(settings, mode);
        }

        private static void LogResult(VisualBridgeDebugCompileResult result)
        {
            foreach (var output in result.Outputs)
            {
                var status = output.Changed
                    ? result.Mode == VisualBridgeDebugGenerateMode.Check ? "drift" : "generated"
                    : "unchanged";
                Debug.Log($"VisualBridge debug contract output {status}: {output.Path} ({output.ExpectedSha256})");
            }

            foreach (var staleOutput in result.StaleOutputs)
            {
                Debug.Log($"VisualBridge debug contract stale output "
                    + (result.Mode == VisualBridgeDebugGenerateMode.Check ? "detected" : "removed")
                    + ": " + staleOutput);
            }

            Debug.Log($"VisualBridge debug contract hash: {result.ContractHash}");
        }

        private static string ModeName(VisualBridgeDebugGenerateMode mode)
        {
            return mode == VisualBridgeDebugGenerateMode.Check ? "check" : "generate";
        }
    }
}
