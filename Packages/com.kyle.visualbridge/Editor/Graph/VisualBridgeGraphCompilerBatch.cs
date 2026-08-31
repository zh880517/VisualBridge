using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    public static class VisualBridgeGraphCompilerBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;
        public const int DriftExitCode = 2;

        public static void Generate()
        {
            RunBatch(VisualBridgeGraphCompileMode.Generate);
        }

        public static void Check()
        {
            RunBatch(VisualBridgeGraphCompileMode.Check);
        }

        [MenuItem("Tools/VisualBridge/Generate Graph Compiled Data")]
        private static void GenerateFromMenu()
        {
            RunMenu(VisualBridgeGraphCompileMode.Generate);
        }

        [MenuItem("Tools/VisualBridge/Check Graph Compiled Data")]
        private static void CheckFromMenu()
        {
            RunMenu(VisualBridgeGraphCompileMode.Check);
        }

        private static void RunBatch(VisualBridgeGraphCompileMode mode)
        {
            try
            {
                var result = VisualBridgeGraphCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                EditorApplication.Exit(mode == VisualBridgeGraphCompileMode.Check && result.DriftDetected
                    ? DriftExitCode
                    : SuccessExitCode);
            }
            catch (Exception exception)
            {
                Debug.LogError("VisualBridge Graph compile failed: " + exception);
                EditorApplication.Exit(FailureExitCode);
            }
        }

        private static void RunMenu(VisualBridgeGraphCompileMode mode)
        {
            try
            {
                var result = VisualBridgeGraphCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                if (mode == VisualBridgeGraphCompileMode.Check && result.DriftDetected)
                {
                    EditorUtility.DisplayDialog("VisualBridge", "Graph compiled data has drift. See the Console for details.", "OK");
                }
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("VisualBridge", "Graph compile failed. See the Console for details.", "OK");
            }
        }

        private static string ProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }

        private static void LogResult(VisualBridgeGraphCompileResult result)
        {
            foreach (var output in result.Outputs)
            {
                var status = output.Changed
                    ? result.Mode == VisualBridgeGraphCompileMode.Check ? "drift" : "generated"
                    : "unchanged";
                Debug.Log($"VisualBridge Graph compiled output {status}: {output.Path} ({output.ExpectedSha256})");
            }

            foreach (var staleOutput in result.StaleOutputs)
            {
                Debug.Log($"VisualBridge Graph stale output {(result.Mode == VisualBridgeGraphCompileMode.Check ? "detected" : "removed")}: {staleOutput}");
            }
        }
    }
}
