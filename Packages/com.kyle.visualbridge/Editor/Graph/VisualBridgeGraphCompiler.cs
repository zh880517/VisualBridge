using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public enum VisualBridgeGraphCompileMode
    {
        Generate,
        Check,
    }

    public sealed class VisualBridgeGraphCompileOutput
    {
        internal VisualBridgeGraphCompileOutput(string path, string expectedSha256, string previousSha256, bool changed)
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

    public sealed class VisualBridgeGraphCompileResult
    {
        internal VisualBridgeGraphCompileResult(
            VisualBridgeGraphCompileMode mode,
            IReadOnlyList<VisualBridgeGraphCompileOutput> outputs,
            IReadOnlyList<string> staleOutputs)
        {
            Mode = mode;
            Outputs = outputs;
            StaleOutputs = staleOutputs;
        }

        public VisualBridgeGraphCompileMode Mode { get; }

        public IReadOnlyList<VisualBridgeGraphCompileOutput> Outputs { get; }

        public IReadOnlyList<string> StaleOutputs { get; }

        public bool DriftDetected => Outputs.Any(output => output.Changed) || StaleOutputs.Count != 0;
    }

    /// <summary>
    /// Graph Compiler：把 Graph V3 文档（`.vbflow` 等）按 `editor == "graph"` 的 Document Type 路由编译成
    /// 确定性产物、source mapping 与独立 manifest（manifest.graph.json）。文档校验为纯 JSON 级对照 Graph
    /// Catalog（无反射物化）；VS Code 侧 warning 级诊断在此一律 fail-closed；别名引用统一 canonical 化，
    /// 缺失属性以 Catalog defaultValue 物化。序列化、Hash 与原子提交复用 Structured Compiler。
    /// </summary>
    public static partial class VisualBridgeGraphCompiler
    {
        private const string ArtifactKind = "visualbridge.graph.compiled";
        private const string MappingKind = "visualbridge.graph.sourceMapping";
        private const string ManifestKind = "visualbridge.graph.compileManifest";
        // 独立于 Structured/Entity/Table 的 manifest，各编译器不得互相覆盖托管清单。
        private const string ManifestFileName = "manifest.graph.json";

        public static VisualBridgeGraphCompileResult Compile(string unityProjectRoot, VisualBridgeGraphCompileMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            VisualBridgeStructuredCompiler.RequireFrozenOutputRoot(profile);
            VisualBridgeStructuredCompiler.RejectOutputAlias(profile.CompileOutputRoot);

            // Graph Catalog 由 Unity 导出，编译前先做 drift 检查（对齐 Entity Compiler）。
            var catalogCheck = VisualBridgeGraphCatalogExporter.Export(profile.ProjectRoot, VisualBridgeCatalogExportMode.Check);
            if (catalogCheck.DriftDetected)
            {
                var paths = string.Join(", ", catalogCheck.Outputs.Where(output => output.Changed).Select(output => output.Path));
                throw Error("compile.catalogDrift", "$.catalogExports", "Generated Graph Catalogs are stale: " + paths);
            }

            var project = VisualBridgeAuthoringProjectParser.Parse(profile.AuthoringProjectPath);
            var inputSnapshots = new Dictionary<string, VisualBridgeStructuredCompiler.InputSnapshot>(VisualBridgeStructuredCompiler.FilePathComparer);
            VisualBridgeStructuredCompiler.AddInput(inputSnapshots, profile.ProfilePath);
            VisualBridgeStructuredCompiler.AddInput(inputSnapshots, profile.AuthoringProjectPath);

            var registry = BuildRegistry(profile, project, inputSnapshots);
            var routedDocuments = DiscoverDocuments(project, registry.Routes);
            var plans = new List<VisualBridgeStructuredCompiler.OutputPlan>();
            foreach (var document in routedDocuments.OrderBy(value => value.RelativePath, StringComparer.Ordinal))
            {
                var documentBytes = VisualBridgeStructuredCompiler.ReadInputBytes(document.FullPath);
                var documentHash = VisualBridgeStructuredCompiler.HashBytes(documentBytes);
                VisualBridgeStructuredCompiler.AddInput(inputSnapshots, document.FullPath, documentBytes, documentHash);
                plans.AddRange(BuildDocumentOutputs(
                    profile,
                    project,
                    document,
                    documentBytes,
                    documentHash,
                    inputSnapshots));
            }

            plans = plans.OrderBy(value => value.RelativePath, StringComparer.Ordinal).ToList();
            VisualBridgeStructuredCompiler.RejectDuplicateOutputPaths(plans);
            var manifest = BuildManifest(profile, project, plans, inputSnapshots);
            plans.Add(manifest);
            plans = plans.OrderBy(value => value.RelativePath, StringComparer.Ordinal).ToList();

            VisualBridgeStructuredCompiler.RejectOutputAlias(VisualBridgeStructuredCompiler.ResolveOutputPath(profile.CompileOutputRoot, ManifestFileName));
            var previousManagedPaths = ReadPreviousManagedPaths(profile.CompileOutputRoot);
            var nextManagedPaths = new HashSet<string>(
                plans.Where(value => value.RelativePath != ManifestFileName).Select(value => value.RelativePath),
                StringComparer.Ordinal);
            var stalePaths = previousManagedPaths
                .Where(path => !nextManagedPaths.Contains(path))
                .Select(path => VisualBridgeStructuredCompiler.ResolveOutputPath(profile.CompileOutputRoot, path))
                .Where(File.Exists)
                .OrderBy(path => path, VisualBridgeStructuredCompiler.FilePathComparer)
                .ToArray();
            foreach (var stalePath in stalePaths)
            {
                VisualBridgeStructuredCompiler.RejectOutputAlias(stalePath);
            }

            var outputs = plans.Select(plan =>
            {
                VisualBridgeStructuredCompiler.RejectOutputAlias(plan.FullPath);
                var previousBytes = File.Exists(plan.FullPath) ? File.ReadAllBytes(plan.FullPath) : null;
                var previousHash = previousBytes == null ? null : VisualBridgeStructuredCompiler.HashBytes(previousBytes);
                return new VisualBridgeGraphCompileOutput(
                    plan.FullPath,
                    plan.Hash,
                    previousHash,
                    previousBytes == null || !previousBytes.SequenceEqual(plan.Bytes));
            }).ToArray();

            VisualBridgeStructuredCompiler.VerifyInputs(inputSnapshots.Values);
            if (mode == VisualBridgeGraphCompileMode.Generate && (outputs.Any(output => output.Changed) || stalePaths.Length != 0))
            {
                // 事务接口以 Structured 输出为载体，仅传递基线 Hash 与变更标记。
                var transactionOutputs = plans
                    .Zip(outputs, (plan, output) => new VisualBridgeStructuredCompileOutput(
                        plan.FullPath,
                        output.ExpectedSha256,
                        output.PreviousSha256,
                        output.Changed))
                    .ToArray();
                VisualBridgeStructuredCompiler.CommitTransaction(
                    profile.CompileOutputRoot,
                    plans,
                    transactionOutputs,
                    stalePaths,
                    inputSnapshots.Values);
            }

            return new VisualBridgeGraphCompileResult(mode, outputs, stalePaths);
        }

    }
}
