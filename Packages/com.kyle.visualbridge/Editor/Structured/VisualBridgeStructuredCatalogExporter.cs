using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using VisualBridge.Runtime;

namespace VisualBridge.Editor
{
    public enum VisualBridgeCatalogExportMode
    {
        Generate,
        Check,
    }

    public sealed class VisualBridgeCatalogExportOutput
    {
        internal VisualBridgeCatalogExportOutput(string path, string expectedSha256, string previousSha256, bool changed)
        {
            Path = path;
            ExpectedSha256 = expectedSha256;
            PreviousSha256 = previousSha256;
            Changed = changed;
        }

        public string Path { get; }

        public string ExpectedSha256 { get; }

        public string PreviousSha256 { get; }

        public bool Changed { get; }
    }

    public sealed class VisualBridgeCatalogExportResult
    {
        internal VisualBridgeCatalogExportResult(VisualBridgeCatalogExportMode mode, IReadOnlyList<VisualBridgeCatalogExportOutput> outputs)
        {
            Mode = mode;
            Outputs = outputs;
        }

        public VisualBridgeCatalogExportMode Mode { get; }

        public IReadOnlyList<VisualBridgeCatalogExportOutput> Outputs { get; }

        public bool DriftDetected => Outputs.Any(output => output.Changed);
    }

    public static partial class VisualBridgeStructuredCatalogExporter
    {
        public const string ProviderId = "unity.csharp";

        internal static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false, true);
        private static readonly Regex ColorPattern = new Regex("^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$", RegexOptions.CultureInvariant);

        public static VisualBridgeCatalogExportResult Export(string unityProjectRoot, VisualBridgeCatalogExportMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            var plans = profile.CatalogExports
                .Where(export => export.OutputPath.EndsWith(".vbstructuredcatalog", StringComparison.Ordinal))
                .Select(export => BuildPlan(profile.ProjectRoot, export))
                .OrderBy(plan => plan.OutputPath, StringComparer.Ordinal)
                .ToArray();
            ValidateAuthoringProjectBindings(profile, plans);

            var outputs = new List<VisualBridgeCatalogExportOutput>(plans.Length);
            foreach (var plan in plans)
            {
                var existingBytes = File.Exists(plan.OutputPath) ? File.ReadAllBytes(plan.OutputPath) : null;
                outputs.Add(new VisualBridgeCatalogExportOutput(
                    plan.OutputPath,
                    plan.ExpectedHash,
                    existingBytes == null ? null : HashBytes(existingBytes),
                    existingBytes == null || !existingBytes.SequenceEqual(plan.Bytes)));
            }

            if (mode == VisualBridgeCatalogExportMode.Generate)
            {
                for (var index = 0; index < plans.Length; index++)
                {
                    if (outputs[index].Changed)
                    {
                        WriteAtomically(plans[index], outputs[index].PreviousSha256);
                    }
                }
            }

            return new VisualBridgeCatalogExportResult(mode, outputs);
        }

        internal static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

        internal sealed class ExportPlan
        {
            public ExportPlan(string projectRoot, string outputPath, byte[] bytes, string expectedHash, JObject catalog)
            {
                ProjectRoot = projectRoot;
                OutputPath = outputPath;
                Bytes = bytes;
                ExpectedHash = expectedHash;
                Catalog = catalog;
            }

            public string ProjectRoot { get; }

            public string OutputPath { get; }

            public byte[] Bytes { get; }

            public string ExpectedHash { get; }

            public JObject Catalog { get; }
        }

        private sealed class CatalogMetadata
        {
            public string CatalogId { get; set; }
            public string Title { get; set; }
        }

        private sealed class ConfigMetadata
        {
            public string CatalogId { get; set; }
            public string Id { get; set; }
            public string Title { get; set; }
            public string[] Aliases { get; set; } = Array.Empty<string>();
            public string Description { get; set; }
        }

        internal sealed class FieldMetadata
        {
            public string Id { get; set; }
            public string Title { get; set; }
            public string[] Aliases { get; set; } = Array.Empty<string>();
            public string Description { get; set; }
            public int Order { get; set; }
            public string DataTypeId { get; set; }
            public string DefaultJson { get; set; }
            public VisualBridgeEditorKind Editor { get; set; }
            public bool ReadOnly { get; set; }
            public bool Integer { get; set; }
            public double Min { get; set; } = double.NaN;
            public double Max { get; set; } = double.NaN;
            public double Step { get; set; } = double.NaN;
            public string ReferenceKind { get; set; }
            public string ReferenceTargetJson { get; set; }
            public bool AllowMissingReference { get; set; }

            public static FieldMetadata ForNestedValue()
            {
                return new FieldMetadata();
            }
        }
    }
}
