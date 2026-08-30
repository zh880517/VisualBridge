using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Kyl.VisualBridge.Editor
{
    public static class VisualBridgeStructuredCompilerBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;
        public const int DriftExitCode = 2;

        public static void Generate()
        {
            RunBatch(VisualBridgeStructuredCompileMode.Generate);
        }

        public static void Check()
        {
            RunBatch(VisualBridgeStructuredCompileMode.Check);
        }

        [MenuItem("Tools/VisualBridge/Generate Structured Compiled Data")]
        private static void GenerateFromMenu()
        {
            RunMenu(VisualBridgeStructuredCompileMode.Generate);
        }

        [MenuItem("Tools/VisualBridge/Check Structured Compiled Data")]
        private static void CheckFromMenu()
        {
            RunMenu(VisualBridgeStructuredCompileMode.Check);
        }

        private static void RunBatch(VisualBridgeStructuredCompileMode mode)
        {
            try
            {
                var result = VisualBridgeStructuredCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                EditorApplication.Exit(mode == VisualBridgeStructuredCompileMode.Check && result.DriftDetected
                    ? DriftExitCode
                    : SuccessExitCode);
            }
            catch (Exception exception)
            {
                Debug.LogError("VisualBridge Structured compile failed: " + exception);
                EditorApplication.Exit(FailureExitCode);
            }
        }

        private static void RunMenu(VisualBridgeStructuredCompileMode mode)
        {
            try
            {
                var result = VisualBridgeStructuredCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                if (mode == VisualBridgeStructuredCompileMode.Check && result.DriftDetected)
                {
                    EditorUtility.DisplayDialog("VisualBridge", "Structured compiled data has drift. See the Console for details.", "OK");
                }
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("VisualBridge", "Structured compile failed. See the Console for details.", "OK");
            }
        }

        private static string ProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }

        private static void LogResult(VisualBridgeStructuredCompileResult result)
        {
            foreach (var output in result.Outputs)
            {
                var status = output.Changed
                    ? result.Mode == VisualBridgeStructuredCompileMode.Check ? "drift" : "generated"
                    : "unchanged";
                Debug.Log($"VisualBridge Structured compiled output {status}: {output.Path} ({output.ExpectedSha256})");
            }

            foreach (var staleOutput in result.StaleOutputs)
            {
                Debug.Log($"VisualBridge Structured stale output {(result.Mode == VisualBridgeStructuredCompileMode.Check ? "detected" : "removed")}: {staleOutput}");
            }
        }
    }
}
