using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using VisualBridge.Runtime;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public enum VisualBridgeStructuredCompileMode
    {
        Generate,
        Check,
    }

    public sealed class VisualBridgeStructuredCompileOutput
    {
        internal VisualBridgeStructuredCompileOutput(string path, string expectedSha256, string previousSha256, bool changed)
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

    public sealed class VisualBridgeStructuredCompileResult
    {
        internal VisualBridgeStructuredCompileResult(
            VisualBridgeStructuredCompileMode mode,
            IReadOnlyList<VisualBridgeStructuredCompileOutput> outputs,
            IReadOnlyList<string> staleOutputs)
        {
            Mode = mode;
            Outputs = outputs;
            StaleOutputs = staleOutputs;
        }

        public VisualBridgeStructuredCompileMode Mode { get; }

        public IReadOnlyList<VisualBridgeStructuredCompileOutput> Outputs { get; }

        public IReadOnlyList<string> StaleOutputs { get; }

        public bool DriftDetected => Outputs.Any(output => output.Changed) || StaleOutputs.Count != 0;
    }

    public static partial class VisualBridgeStructuredCompiler
    {
        private const string OutputRelativeRoot = "Library/VisualBridge/Compiled";
        private const string ArtifactKind = "visualbridge.structured.compiled";
        private const string MappingKind = "visualbridge.structured.sourceMapping";
        private const string ManifestKind = "visualbridge.structured.compileManifest";

        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false, true);
        internal static readonly StringComparer FilePathComparer = Path.DirectorySeparatorChar == '\\'
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;

        public static VisualBridgeStructuredCompileResult Compile(string unityProjectRoot, VisualBridgeStructuredCompileMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            RequireFrozenOutputRoot(profile);
            RejectOutputAlias(profile.CompileOutputRoot);

            var catalogCheck = VisualBridgeStructuredCatalogExporter.Export(profile.ProjectRoot, VisualBridgeCatalogExportMode.Check);
            if (catalogCheck.DriftDetected)
            {
                var paths = string.Join(", ", catalogCheck.Outputs.Where(output => output.Changed).Select(output => output.Path));
                throw Error("compile.catalogDrift", "$.catalogExports", "Generated Structured Catalogs are stale: " + paths);
            }

            var project = VisualBridgeAuthoringProjectParser.Parse(profile.AuthoringProjectPath);
            var inputSnapshots = new Dictionary<string, InputSnapshot>(FilePathComparer);
            AddInput(inputSnapshots, profile.ProfilePath);
            AddInput(inputSnapshots, profile.AuthoringProjectPath);

            var registry = BuildRegistry(profile, project, inputSnapshots);
            var routedDocuments = DiscoverDocuments(project, registry.Routes);
            var plans = new List<OutputPlan>();
            foreach (var document in routedDocuments.OrderBy(value => value.RelativePath, StringComparer.Ordinal))
            {
                var documentBytes = ReadInputBytes(document.FullPath);
                var documentHash = HashBytes(documentBytes);
                AddInput(inputSnapshots, document.FullPath, documentBytes, documentHash);
                plans.AddRange(BuildDocumentOutputs(
                    profile,
                    project,
                    registry,
                    document,
                    documentBytes,
                    documentHash,
                    inputSnapshots));
            }

            plans = plans.OrderBy(value => value.RelativePath, StringComparer.Ordinal).ToList();
            RejectDuplicateOutputPaths(plans);
            var manifest = BuildManifest(profile, project, plans, inputSnapshots);
            plans.Add(manifest);
            plans = plans.OrderBy(value => value.RelativePath, StringComparer.Ordinal).ToList();

            RejectOutputAlias(ResolveOutputPath(profile.CompileOutputRoot, "manifest.json"));
            var previousManagedPaths = ReadPreviousManagedPaths(profile.CompileOutputRoot);
            var nextManagedPaths = new HashSet<string>(
                plans.Where(value => value.RelativePath != "manifest.json").Select(value => value.RelativePath),
                StringComparer.Ordinal);
            var stalePaths = previousManagedPaths
                .Where(path => !nextManagedPaths.Contains(path))
                .Select(path => ResolveOutputPath(profile.CompileOutputRoot, path))
                .Where(File.Exists)
                .OrderBy(path => path, FilePathComparer)
                .ToArray();
            foreach (var stalePath in stalePaths)
            {
                RejectOutputAlias(stalePath);
            }

            var outputs = plans.Select(plan =>
            {
                RejectOutputAlias(plan.FullPath);
                var previousBytes = File.Exists(plan.FullPath) ? File.ReadAllBytes(plan.FullPath) : null;
                var previousHash = previousBytes == null ? null : HashBytes(previousBytes);
                return new VisualBridgeStructuredCompileOutput(
                    plan.FullPath,
                    plan.Hash,
                    previousHash,
                    previousBytes == null || !previousBytes.SequenceEqual(plan.Bytes));
            }).ToArray();

            VerifyInputs(inputSnapshots.Values);
            if (mode == VisualBridgeStructuredCompileMode.Generate && (outputs.Any(output => output.Changed) || stalePaths.Length != 0))
            {
                CommitTransaction(profile.CompileOutputRoot, plans, outputs, stalePaths, inputSnapshots.Values);
            }

            return new VisualBridgeStructuredCompileResult(mode, outputs, stalePaths);
        }

    }
}
