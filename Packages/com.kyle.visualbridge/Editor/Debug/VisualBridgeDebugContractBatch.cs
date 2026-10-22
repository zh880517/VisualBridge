using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>调试契约生成入口：命令行与菜单共用同一套核心。</summary>
    public static class VisualBridgeDebugContractBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;

        public static void Generate()
        {
            RunBatch(VisualBridgeDebugContractCompileMode.Generate);
        }

        public static void Check()
        {
            RunBatch(VisualBridgeDebugContractCompileMode.Check);
        }

        [MenuItem("Tools/VisualBridge/Debug/Generate Debug Contracts")]
        private static void GenerateFromMenu()
        {
            try
            {
                var result = VisualBridgeDebugContractCompiler.Compile(
                    ProjectRoot(),
                    VisualBridgeDebugContractCompileMode.Generate);
                LogResult(result);
                if (result.DriftDetected)
                {
                    EditorUtility.DisplayDialog(
                        "VisualBridge",
                        "Debug contract generation failed. See the Console for details.",
                        "OK");
                }
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogException(exception);
                EditorUtility.DisplayDialog(
                    "VisualBridge",
                    "Debug contract generation failed. See the Console for details.",
                    "OK");
            }
        }

        private static void RunBatch(VisualBridgeDebugContractCompileMode mode)
        {
            try
            {
                var result = VisualBridgeDebugContractCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                EditorApplication.Exit(result.DriftDetected ? FailureExitCode : SuccessExitCode);
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogError("VisualBridge debug contract batch failed: " + exception);
                EditorApplication.Exit(FailureExitCode);
            }
        }

        private static void LogResult(VisualBridgeDebugContractCompileResult result)
        {
            foreach (string error in result.Errors)
            {
                UnityEngine.Debug.LogError("VisualBridge debug contract: " + error);
            }

            foreach (string path in result.DriftPaths)
            {
                UnityEngine.Debug.LogError("VisualBridge debug contract drift: " + path);
            }

            foreach (string path in result.WrittenPaths)
            {
                UnityEngine.Debug.Log("VisualBridge debug contract generated: " + path);
            }
        }

        private static string ProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }
    }
}
