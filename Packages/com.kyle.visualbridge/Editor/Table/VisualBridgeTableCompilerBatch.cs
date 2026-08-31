using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    public static class VisualBridgeTableCompilerBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;
        public const int DriftExitCode = 2;

        public static void Generate()
        {
            RunBatch(VisualBridgeTableCompileMode.Generate);
        }

        public static void Check()
        {
            RunBatch(VisualBridgeTableCompileMode.Check);
        }

        [MenuItem("Tools/VisualBridge/Generate Table Compiled Data")]
        private static void GenerateFromMenu()
        {
            RunMenu(VisualBridgeTableCompileMode.Generate);
        }

        [MenuItem("Tools/VisualBridge/Check Table Compiled Data")]
        private static void CheckFromMenu()
        {
            RunMenu(VisualBridgeTableCompileMode.Check);
        }

        private static void RunBatch(VisualBridgeTableCompileMode mode)
        {
            try
            {
                var result = VisualBridgeTableCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                EditorApplication.Exit(mode == VisualBridgeTableCompileMode.Check && result.DriftDetected
                    ? DriftExitCode
                    : SuccessExitCode);
            }
            catch (Exception exception)
            {
                Debug.LogError("VisualBridge Table compile failed: " + exception);
                EditorApplication.Exit(FailureExitCode);
            }
        }

        private static void RunMenu(VisualBridgeTableCompileMode mode)
        {
            try
            {
                var result = VisualBridgeTableCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                if (mode == VisualBridgeTableCompileMode.Check && result.DriftDetected)
                {
                    EditorUtility.DisplayDialog("VisualBridge", "Table compiled data has drift. See the Console for details.", "OK");
                }
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("VisualBridge", "Table compile failed. See the Console for details.", "OK");
            }
        }

        private static string ProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }

        private static void LogResult(VisualBridgeTableCompileResult result)
        {
            foreach (var output in result.Outputs)
            {
                var status = output.Changed
                    ? result.Mode == VisualBridgeTableCompileMode.Check ? "drift" : "generated"
                    : "unchanged";
                Debug.Log($"VisualBridge Table compiled output {status}: {output.Path} ({output.ExpectedSha256})");
            }

            foreach (var staleOutput in result.StaleOutputs)
            {
                Debug.Log($"VisualBridge Table stale output {(result.Mode == VisualBridgeTableCompileMode.Check ? "detected" : "removed")}: {staleOutput}");
            }
        }
    }
}
