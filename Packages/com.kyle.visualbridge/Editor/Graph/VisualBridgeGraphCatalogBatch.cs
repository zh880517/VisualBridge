using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    public static class VisualBridgeGraphCatalogBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;
        public const int DriftExitCode = 2;

        public static void Generate()
        {
            Run(VisualBridgeCatalogExportMode.Generate);
        }

        public static void Check()
        {
            Run(VisualBridgeCatalogExportMode.Check);
        }

        [MenuItem("Tools/VisualBridge/Generate Graph Catalogs")]
        private static void GenerateFromMenu()
        {
            var result = VisualBridgeGraphCatalogExporter.Export(ProjectRoot(), VisualBridgeCatalogExportMode.Generate);
            LogResult(result);
        }

        private static void Run(VisualBridgeCatalogExportMode mode)
        {
            try
            {
                var result = VisualBridgeGraphCatalogExporter.Export(ProjectRoot(), mode);
                LogResult(result);
                if (mode == VisualBridgeCatalogExportMode.Check && result.DriftDetected)
                {
                    EditorApplication.Exit(DriftExitCode);
                    return;
                }

                EditorApplication.Exit(SuccessExitCode);
            }
            catch (Exception exception)
            {
                Debug.LogError("VisualBridge graph catalog export failed: " + exception);
                EditorApplication.Exit(FailureExitCode);
            }
        }

        private static string ProjectRoot()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        }

        private static void LogResult(VisualBridgeCatalogExportResult result)
        {
            foreach (var output in result.Outputs)
            {
                var status = output.Changed
                    ? result.Mode == VisualBridgeCatalogExportMode.Check ? "drift" : "generated"
                    : "unchanged";
                Debug.Log($"VisualBridge graph catalog {status}: {output.Path} ({output.ExpectedSha256})");
            }
        }
    }
}
