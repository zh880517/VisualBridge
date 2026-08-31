using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    public static class VisualBridgeEntityCompilerBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;
        public const int DriftExitCode = 2;

        public static void Generate()
        {
            RunBatch(VisualBridgeEntityCompileMode.Generate);
        }

        public static void Check()
        {
            RunBatch(VisualBridgeEntityCompileMode.Check);
        }

        [MenuItem("Tools/VisualBridge/Generate Entity Compiled Data")]
        private static void GenerateFromMenu()
        {
            RunMenu(VisualBridgeEntityCompileMode.Generate);
        }

        [MenuItem("Tools/VisualBridge/Check Entity Compiled Data")]
        private static void CheckFromMenu()
        {
            RunMenu(VisualBridgeEntityCompileMode.Check);
        }

        private static void RunBatch(VisualBridgeEntityCompileMode mode)
        {
            try
            {
                var result = VisualBridgeEntityCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                EditorApplication.Exit(mode == VisualBridgeEntityCompileMode.Check && result.DriftDetected
                    ? DriftExitCode
                    : SuccessExitCode);
            }
            catch (Exception exception)
            {
                Debug.LogError("VisualBridge Entity compile failed: " + exception);
                EditorApplication.Exit(FailureExitCode);
            }
        }

        private static void RunMenu(VisualBridgeEntityCompileMode mode)
        {
            try
            {
                var result = VisualBridgeEntityCompiler.Compile(ProjectRoot(), mode);
                LogResult(result);
                if (mode == VisualBridgeEntityCompileMode.Check && result.DriftDetected)
                {
                    EditorUtility.DisplayDialog("VisualBridge", "Entity compiled data has drift. See the Console for details.", "OK");
                }
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("VisualBridge", "Entity compile failed. See the Console for details.", "OK");
            }
        }

        private static string ProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }

        private static void LogResult(VisualBridgeEntityCompileResult result)
        {
            foreach (var output in result.Outputs)
            {
                var status = output.Changed
                    ? result.Mode == VisualBridgeEntityCompileMode.Check ? "drift" : "generated"
                    : "unchanged";
                Debug.Log($"VisualBridge Entity compiled output {status}: {output.Path} ({output.ExpectedSha256})");
            }

            foreach (var staleOutput in result.StaleOutputs)
            {
                Debug.Log($"VisualBridge Entity stale output {(result.Mode == VisualBridgeEntityCompileMode.Check ? "detected" : "removed")}: {staleOutput}");
            }
        }
    }
}
