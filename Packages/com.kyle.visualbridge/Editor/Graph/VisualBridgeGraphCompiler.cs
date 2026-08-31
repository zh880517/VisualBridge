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
    public static class VisualBridgeGraphCompiler
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

        private static Registry BuildRegistry(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            // 只信任 Profile 注册的 .vbgraphcatalog 导出单元（graph catalog 由 Unity 导出）。
            var catalogExports = new Dictionary<string, VisualBridgeResolvedCatalogExport>(VisualBridgeStructuredCompiler.FilePathComparer);
            foreach (var export in profile.CatalogExports)
            {
                if (!export.OutputPath.EndsWith(".vbgraphcatalog", StringComparison.Ordinal))
                {
                    continue;
                }

                var relativeOutput = VisualBridgeStructuredCompiler.RelativePathInside(project.RootPath, export.OutputPath, "$.catalogExports.output");
                if (!catalogExports.TryAdd(export.OutputPath, export))
                {
                    throw Error("compile.duplicateCatalog", relativeOutput, "Catalog output is registered more than once.");
                }
            }

            var catalogByPath = new Dictionary<string, CatalogDescriptor>(VisualBridgeStructuredCompiler.FilePathComparer);
            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "graph"))
            {
                if (documentType.Catalogs.Count == 0)
                {
                    throw Error("compile.catalogMissing", documentType.Id, "Graph Document Type must declare at least one Catalog.");
                }

                foreach (var catalogRelativePath in documentType.Catalogs)
                {
                    var catalogPath = VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalogRelativePath, documentType.Id + ".catalogs");
                    if (!File.Exists(catalogPath))
                    {
                        throw Error("compile.catalogNotFound", catalogRelativePath, "Graph Catalog does not exist.");
                    }

                    if (!catalogExports.TryGetValue(catalogPath, out var export))
                    {
                        throw Error("compile.catalogUntrusted", catalogRelativePath, "Graph Catalog is not an output registered by the Unity Integration Profile.");
                    }

                    if (!catalogByPath.ContainsKey(catalogPath))
                    {
                        var bytes = VisualBridgeStructuredCompiler.ReadInputBytes(catalogPath);
                        var hash = VisualBridgeStructuredCompiler.HashBytes(bytes);
                        var catalog = VisualBridgeIntegrationProfileLoader.ReadStrictObject(catalogPath, "compile.catalogInvalidJson");
                        VisualBridgeGraphCatalogValidator.Validate(catalog);
                        if (!string.Equals(catalog.Value<string>("catalogId"), export.CatalogId, StringComparison.Ordinal))
                        {
                            throw Error("compile.catalogMetadataMismatch", catalogRelativePath, "Catalog ID differs from the Unity Integration Profile.");
                        }

                        catalogByPath.Add(catalogPath, new CatalogDescriptor(catalogRelativePath, catalogPath, hash, catalog));
                        VisualBridgeStructuredCompiler.AddInput(inputs, catalogPath, bytes, hash);
                    }
                }
            }

            var routes = new Dictionary<string, RouteDescriptor>(StringComparer.Ordinal);
            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "graph"))
            {
                var catalogs = documentType.Catalogs
                    .Select(relative => catalogByPath[VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, relative, documentType.Id + ".catalogs")])
                    .OrderBy(value => value.RelativePath, StringComparer.Ordinal)
                    .ToArray();
                routes.Add(documentType.Id, new RouteDescriptor(
                    documentType,
                    catalogs,
                    BuildIdentityIndex(catalogs, "nodeTypes"),
                    BuildIdentityIndex(catalogs, "graphTypes"),
                    BuildIdentityIndex(catalogs, "dataTypes")));
            }

            return new Registry(routes);
        }

        // 身份索引跨该 Document Type 声明的全部 Catalog 合并（对应 VS Code buildGraphCatalogRegistry 语义）。
        private static Dictionary<string, IndexedDefinition> BuildIdentityIndex(IReadOnlyList<CatalogDescriptor> catalogs, string arrayName)
        {
            var index = new Dictionary<string, IndexedDefinition>(StringComparer.Ordinal);
            foreach (var catalog in catalogs)
            {
                foreach (var definition in ((JArray)catalog.Root[arrayName]).Cast<JObject>())
                {
                    foreach (var identity in Identities(definition))
                    {
                        if (!index.TryAdd(identity, new IndexedDefinition(definition, catalog.Root.Value<string>("catalogId"))))
                        {
                            throw Error("compile.identityConflict", identity, $"Graph Catalog '{arrayName}' identity '{identity}' is declared more than once.");
                        }
                    }
                }
            }

            return index;
        }

        private static IEnumerable<string> Identities(JObject definition)
        {
            yield return definition.Value<string>("id");
            if (definition["aliases"] is JArray aliases)
            {
                foreach (var alias in aliases.Values<string>())
                {
                    yield return alias;
                }
            }
        }

        private static IReadOnlyList<RoutedDocument> DiscoverDocuments(
            VisualBridgeAuthoringProject project,
            IReadOnlyDictionary<string, RouteDescriptor> routes)
        {
            var discovered = new HashSet<string>(VisualBridgeStructuredCompiler.FilePathComparer);
            foreach (var relativeRoot in project.DocumentRoots.OrderBy(value => value, StringComparer.Ordinal))
            {
                var fullRoot = relativeRoot == "."
                    ? project.RootPath
                    : VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, relativeRoot, "$.documentRoots");
                if (!Directory.Exists(fullRoot))
                {
                    throw Error("compile.documentRootNotFound", relativeRoot, "Document root does not exist.");
                }

                VisualBridgeStructuredCompiler.EnumerateFilesStrict(project.RootPath, fullRoot, discovered);
            }

            var result = new List<RoutedDocument>();
            foreach (var fullPath in discovered.OrderBy(value => value, VisualBridgeStructuredCompiler.FilePathComparer))
            {
                var relativePath = VisualBridgeStructuredCompiler.RelativePathInside(project.RootPath, fullPath, "document");
                if (!VisualBridgeAuthoringProjectParser.IsInsideDocumentRoots(project, relativePath))
                {
                    throw Error("compile.documentOutsideRoot", relativePath, "Discovered document is outside declared document roots.");
                }

                var matches = project.DocumentTypes
                    .Where(documentType => VisualBridgeAuthoringProjectParser.Matches(documentType, relativePath))
                    .ToArray();
                if (matches.Length == 0)
                {
                    continue;
                }

                if (matches.Length != 1)
                {
                    throw Error(
                        "compile.ambiguousRoute",
                        relativePath,
                        "Document matches multiple Document Types: " + string.Join(", ", matches.Select(value => value.Id).OrderBy(value => value, StringComparer.Ordinal)));
                }

                if (matches[0].Editor != "graph")
                {
                    continue;
                }

                if (!routes.TryGetValue(matches[0].Id, out var route))
                {
                    throw Error("compile.catalogMissing", matches[0].Id, "Graph route has no registered Graph Catalogs.");
                }

                result.Add(new RoutedDocument(fullPath, relativePath, route));
            }

            return result;
        }

        private static IEnumerable<VisualBridgeStructuredCompiler.OutputPlan> BuildDocumentOutputs(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            RoutedDocument routed,
            byte[] documentBytes,
            string documentHash,
            IReadOnlyDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            var route = routed.Route;
            var root = VisualBridgeIntegrationProfileLoader.ReadStrictObject(routed.FullPath, "compile.documentInvalidJson");
            VisualBridgeStructuredCompiler.RequireKeys(
                root,
                routed.RelativePath,
                new[] { "formatVersion", "documentId", "rootGraphId", "graphs" });
            if (root["formatVersion"].Type != JTokenType.Integer || root["formatVersion"].Value<long>() != 3)
            {
                // 编译器 V1 只接受 Graph V3；V2 文档报 unsupportedVersion。
                throw Error("compile.documentUnsupportedVersion", routed.RelativePath + ".formatVersion", "Expected integer formatVersion 3.");
            }

            var documentId = VisualBridgeStructuredCompiler.RequireIdentifier(root["documentId"], routed.RelativePath + ".documentId");
            var rootGraphId = VisualBridgeStructuredCompiler.RequireIdentifier(root["rootGraphId"], routed.RelativePath + ".rootGraphId");
            if (!(root["graphs"] is JArray graphArray) || graphArray.Count == 0)
            {
                throw Error("compile.invalidStructure", routed.RelativePath + ".graphs", "Expected a non-empty array.");
            }

            var graphs = new List<GraphDefinition>(graphArray.Count);
            for (var index = 0; index < graphArray.Count; index++)
            {
                graphs.Add(ParseGraph(graphArray[index], index, routed.RelativePath + ".graphs[" + index + "]"));
            }

            var model = ValidateStructure(graphs, rootGraphId, routed.RelativePath);
            var mappings = new List<JObject>();
            var dataGraphs = BuildDataGraphs(route, model, routed.RelativePath, mappings);

            var catalogInputs = new JArray(route.Catalogs.Select(catalog => new JObject
            {
                ["catalogId"] = catalog.Root.Value<string>("catalogId"),
                ["path"] = catalog.RelativePath,
                ["sha256"] = catalog.Hash,
            }));
            var artifactRelativePath = "documents/" + project.ProjectId + "/" + route.DocumentType.Id + "/" + documentId + ".vbcompiled.json";
            var artifact = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ArtifactKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = route.DocumentType.Id,
                ["documentId"] = documentId,
                ["inputs"] = new JObject
                {
                    ["integrationProfileSha256"] = inputs[profile.ProfilePath].Hash,
                    ["projectSha256"] = inputs[profile.AuthoringProjectPath].Hash,
                    ["document"] = new JObject
                    {
                        ["path"] = routed.RelativePath,
                        ["sha256"] = documentHash,
                    },
                    ["catalogs"] = catalogInputs,
                },
                ["data"] = new JObject
                {
                    ["graphs"] = dataGraphs,
                },
            };
            var artifactBytes = VisualBridgeStructuredCompiler.Serialize(artifact);
            var artifactHash = VisualBridgeStructuredCompiler.HashBytes(artifactBytes);

            var mappingRelativePath = "mappings/" + project.ProjectId + "/" + route.DocumentType.Id + "/" + documentId + ".vbsource.json";
            var mapping = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = MappingKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = route.DocumentType.Id,
                ["documentId"] = documentId,
                ["inputs"] = new JObject
                {
                    ["integrationProfileSha256"] = inputs[profile.ProfilePath].Hash,
                    ["projectSha256"] = inputs[profile.AuthoringProjectPath].Hash,
                    ["catalogs"] = catalogInputs.DeepClone(),
                },
                ["source"] = new JObject
                {
                    ["path"] = routed.RelativePath,
                    ["sha256"] = documentHash,
                },
                ["artifact"] = new JObject
                {
                    ["path"] = artifactRelativePath,
                    ["sha256"] = artifactHash,
                },
                ["mappings"] = new JArray(mappings.OrderBy(value => value.Value<string>("artifactPath"), StringComparer.Ordinal)),
            };
            var mappingBytes = VisualBridgeStructuredCompiler.Serialize(mapping);
            return new[]
            {
                VisualBridgeStructuredCompiler.CreateOutput(profile.CompileOutputRoot, artifactRelativePath, artifactBytes, "artifact"),
                VisualBridgeStructuredCompiler.CreateOutput(profile.CompileOutputRoot, mappingRelativePath, mappingBytes, "sourceMapping"),
            };
        }

        // ---- 文档解析（镜像 visualbridge-graph.schema.json / graphDocument.ts 的读取层）----

        private static GraphDefinition ParseGraph(JToken token, int index, string path)
        {
            if (!(token is JObject value))
            {
                throw Error("compile.invalidStructure", path, "Expected an object.");
            }

            RequireKeys(value, path, new[] { "id", "title", "properties", "interfacePorts", "nodes", "edges" }, new[] { "graphTypeId" });
            var graphTypeId = value["graphTypeId"] == null
                ? null
                : VisualBridgeStructuredCompiler.RequireIdentifier(value["graphTypeId"], path + ".graphTypeId");
            if (!(value["properties"] is JObject properties))
            {
                throw Error("compile.typeMismatch", path + ".properties", "Expected an object.");
            }

            return new GraphDefinition(
                index,
                VisualBridgeStructuredCompiler.RequireIdentifier(value["id"], path + ".id"),
                graphTypeId,
                RequireString(value["title"], path + ".title"),
                properties,
                ParseInterfacePorts(RequireArray(value["interfacePorts"], path + ".interfacePorts"), path + ".interfacePorts"),
                ParseNodes(RequireArray(value["nodes"], path + ".nodes"), path + ".nodes"),
                ParseEdges(RequireArray(value["edges"], path + ".edges"), path + ".edges"));
        }

        private static IReadOnlyList<InterfacePortDefinition> ParseInterfacePorts(JArray array, string basePath)
        {
            var result = new List<InterfacePortDefinition>(array.Count);
            for (var index = 0; index < array.Count; index++)
            {
                var path = basePath + "[" + index + "]";
                if (!(array[index] is JObject value))
                {
                    throw Error("compile.invalidStructure", path, "Expected an object.");
                }

                RequireKeys(value, path, new[] { "id", "title", "kind", "direction" }, new[] { "dataTypeId", "maxConnections", "dynamic" });
                var kind = RequireEnum(value["kind"], path + ".kind", new[] { "flow", "data" });
                var direction = RequireEnum(value["direction"], path + ".direction", new[] { "input", "output" });
                var dataTypeId = value["dataTypeId"] == null
                    ? null
                    : VisualBridgeStructuredCompiler.RequireIdentifier(value["dataTypeId"], path + ".dataTypeId");
                long? maxConnections = null;
                if (value["maxConnections"] != null)
                {
                    if (value["maxConnections"].Type != JTokenType.Integer || value["maxConnections"].Value<long>() < 1)
                    {
                        throw Error("compile.typeMismatch", path + ".maxConnections", "Expected an integer >= 1.");
                    }

                    maxConnections = value["maxConnections"].Value<long>();
                }

                var dynamic = value["dynamic"] != null && RequireBoolean(value["dynamic"], path + ".dynamic");
                if (kind == "data" && dataTypeId == null)
                {
                    throw Error("compile.missingDataType", path + ".dataTypeId", "Data interface ports require dataTypeId.");
                }

                if (kind == "flow" && dataTypeId != null)
                {
                    throw Error("compile.invalidInterfacePort", path + ".dataTypeId", "Flow interface ports cannot declare dataTypeId.");
                }

                if (kind == "flow" && dynamic)
                {
                    throw Error("compile.invalidInterfacePort", path + ".dynamic", "Flow interface ports cannot be dynamic.");
                }

                result.Add(new InterfacePortDefinition(
                    VisualBridgeStructuredCompiler.RequireIdentifier(value["id"], path + ".id"),
                    RequireString(value["title"], path + ".title"),
                    kind,
                    direction,
                    dataTypeId,
                    maxConnections,
                    dynamic));
            }

            return result;
        }

        private static IReadOnlyList<NodeDefinition> ParseNodes(JArray array, string basePath)
        {
            var result = new List<NodeDefinition>(array.Count);
            for (var index = 0; index < array.Count; index++)
            {
                var path = basePath + "[" + index + "]";
                if (!(array[index] is JObject value))
                {
                    throw Error("compile.invalidStructure", path, "Expected an object.");
                }

                var kind = RequireEnum(value["kind"], path + ".kind", new[] { "node", "subgraph" });
                if (kind == "node")
                {
                    RequireKeys(value, path, new[] { "kind", "id", "nodeTypeId", "title", "position", "properties" }, new[] { "dynamicPorts" });
                }
                else
                {
                    RequireKeys(value, path, new[] { "kind", "id", "subgraphId", "title", "position", "properties" }, new[] { "nodeTypeId", "dynamicPorts" });
                }

                var position = ParsePosition(value["position"], path + ".position");
                if (!(value["properties"] is JObject properties))
                {
                    throw Error("compile.typeMismatch", path + ".properties", "Expected an object.");
                }

                var dynamicPorts = value["dynamicPorts"] == null
                    ? new List<DynamicPortDefinition>()
                    : ParseDynamicPorts(RequireArray(value["dynamicPorts"], path + ".dynamicPorts"), path + ".dynamicPorts");
                string nodeTypeId = null;
                if (kind == "node")
                {
                    nodeTypeId = VisualBridgeStructuredCompiler.RequireIdentifier(value["nodeTypeId"], path + ".nodeTypeId");
                }
                else if (value["nodeTypeId"] != null)
                {
                    nodeTypeId = VisualBridgeStructuredCompiler.RequireIdentifier(value["nodeTypeId"], path + ".nodeTypeId");
                }

                result.Add(new NodeDefinition(
                    kind,
                    VisualBridgeStructuredCompiler.RequireIdentifier(value["id"], path + ".id"),
                    nodeTypeId,
                    kind == "subgraph"
                        ? VisualBridgeStructuredCompiler.RequireIdentifier(value["subgraphId"], path + ".subgraphId")
                        : null,
                    RequireString(value["title"], path + ".title"),
                    position,
                    properties,
                    dynamicPorts));
            }

            return result;
        }

        private static IReadOnlyList<DynamicPortDefinition> ParseDynamicPorts(JArray array, string basePath)
        {
            var result = new List<DynamicPortDefinition>(array.Count);
            for (var index = 0; index < array.Count; index++)
            {
                var path = basePath + "[" + index + "]";
                if (!(array[index] is JObject value))
                {
                    throw Error("compile.invalidStructure", path, "Expected an object.");
                }

                RequireKeys(value, path, new[] { "id", "groupId", "title", "value" }, Array.Empty<string>());
                result.Add(new DynamicPortDefinition(
                    VisualBridgeStructuredCompiler.RequireIdentifier(value["id"], path + ".id"),
                    VisualBridgeStructuredCompiler.RequireIdentifier(value["groupId"], path + ".groupId"),
                    RequireString(value["title"], path + ".title"),
                    value["value"].DeepClone()));
            }

            return result;
        }

        private static IReadOnlyList<EdgeDefinition> ParseEdges(JArray array, string basePath)
        {
            var result = new List<EdgeDefinition>(array.Count);
            for (var index = 0; index < array.Count; index++)
            {
                var path = basePath + "[" + index + "]";
                if (!(array[index] is JObject value))
                {
                    throw Error("compile.invalidStructure", path, "Expected an object.");
                }

                RequireKeys(value, path, new[] { "id", "kind", "source", "target" }, Array.Empty<string>());
                result.Add(new EdgeDefinition(
                    VisualBridgeStructuredCompiler.RequireIdentifier(value["id"], path + ".id"),
                    RequireEnum(value["kind"], path + ".kind", new[] { "flow", "data" }),
                    ParseEndpoint(value["source"], path + ".source"),
                    ParseEndpoint(value["target"], path + ".target")));
            }

            return result;
        }

        private static EndpointDefinition ParseEndpoint(JToken token, string path)
        {
            if (!(token is JObject value))
            {
                throw Error("compile.invalidStructure", path, "Expected an object.");
            }

            var kind = RequireEnum(value["kind"], path + ".kind", new[] { "node", "interface" });
            if (kind == "node")
            {
                RequireKeys(value, path, new[] { "kind", "nodeId", "portId" }, Array.Empty<string>());
                return new EndpointDefinition(
                    kind,
                    VisualBridgeStructuredCompiler.RequireIdentifier(value["nodeId"], path + ".nodeId"),
                    VisualBridgeStructuredCompiler.RequireIdentifier(value["portId"], path + ".portId"));
            }

            RequireKeys(value, path, new[] { "kind", "portId" }, Array.Empty<string>());
            return new EndpointDefinition(
                kind,
                null,
                VisualBridgeStructuredCompiler.RequireIdentifier(value["portId"], path + ".portId"));
        }

        private static PositionDefinition ParsePosition(JToken token, string path)
        {
            if (!(token is JObject value))
            {
                throw Error("compile.typeMismatch", path, "Expected an object.");
            }

            RequireKeys(value, path, new[] { "x", "y" }, Array.Empty<string>());
            return new PositionDefinition(RequireNumber(value["x"], path + ".x"), RequireNumber(value["y"], path + ".y"));
        }

        // ---- 结构校验（镜像 validateStructure，错误码统一映射为 compile.*）----

        private static DocumentModel ValidateStructure(IReadOnlyList<GraphDefinition> graphs, string rootGraphId, string relativePath)
        {
            var graphIds = new HashSet<string>(StringComparer.Ordinal);
            var nodeIds = new HashSet<string>(StringComparer.Ordinal);
            var edgeIds = new HashSet<string>(StringComparer.Ordinal);
            var graphById = new Dictionary<string, GraphDefinition>(StringComparer.Ordinal);
            for (var index = 0; index < graphs.Count; index++)
            {
                if (!graphIds.Add(graphs[index].Id))
                {
                    throw Error("compile.duplicateId", relativePath + ".graphs[" + index + "].id", "Duplicate graph id '" + graphs[index].Id + "'.");
                }

                graphById.Add(graphs[index].Id, graphs[index]);
            }

            if (!graphIds.Contains(rootGraphId))
            {
                throw Error("compile.missingRootGraph", relativePath + ".rootGraphId", "Root graph '" + rootGraphId + "' does not exist.");
            }

            // subgraphId → 拥有它的 subgraph 节点（含宿主图）。
            var ownerByGraphId = new Dictionary<string, SubgraphOwner>(StringComparer.Ordinal);
            for (var graphIndex = 0; graphIndex < graphs.Count; graphIndex++)
            {
                var graph = graphs[graphIndex];
                var localNodeIds = new HashSet<string>(StringComparer.Ordinal);
                var localPortIds = new HashSet<string>(StringComparer.Ordinal);
                for (var portIndex = 0; portIndex < graph.InterfacePorts.Count; portIndex++)
                {
                    if (!localPortIds.Add(graph.InterfacePorts[portIndex].Id))
                    {
                        throw Error(
                            "compile.duplicateId",
                            relativePath + ".graphs[" + graphIndex + "].interfacePorts[" + portIndex + "].id",
                            "Duplicate interface port id '" + graph.InterfacePorts[portIndex].Id + "'.");
                    }
                }

                for (var nodeIndex = 0; nodeIndex < graph.Nodes.Count; nodeIndex++)
                {
                    var node = graph.Nodes[nodeIndex];
                    var nodePath = relativePath + ".graphs[" + graphIndex + "].nodes[" + nodeIndex + "]";
                    if (!nodeIds.Add(node.Id))
                    {
                        throw Error("compile.duplicateId", nodePath + ".id", "Duplicate node id '" + node.Id + "'.");
                    }

                    localNodeIds.Add(node.Id);
                    var dynamicPortIds = new HashSet<string>(StringComparer.Ordinal);
                    for (var portIndex = 0; portIndex < node.DynamicPorts.Count; portIndex++)
                    {
                        if (!dynamicPortIds.Add(node.DynamicPorts[portIndex].Id))
                        {
                            throw Error(
                                "compile.duplicateId",
                                nodePath + ".dynamicPorts[" + portIndex + "].id",
                                "Duplicate dynamic port id '" + node.DynamicPorts[portIndex].Id + "' on node '" + node.Id + "'.");
                        }
                    }

                    if (node.Kind != "subgraph")
                    {
                        continue;
                    }

                    if (node.SubgraphId == rootGraphId)
                    {
                        throw Error("compile.invalidStructure", nodePath + ".subgraphId", "The root graph cannot be embedded.");
                    }

                    if (!graphById.ContainsKey(node.SubgraphId))
                    {
                        throw Error("compile.missingSubgraph", nodePath + ".subgraphId", "Subgraph '" + node.SubgraphId + "' does not exist.");
                    }

                    if (ownerByGraphId.ContainsKey(node.SubgraphId))
                    {
                        throw Error("compile.multipleSubgraphOwners", nodePath + ".subgraphId", "Subgraph '" + node.SubgraphId + "' already has an owner.");
                    }

                    ownerByGraphId.Add(node.SubgraphId, new SubgraphOwner(graph, node));
                }

                for (var edgeIndex = 0; edgeIndex < graph.Edges.Count; edgeIndex++)
                {
                    var edge = graph.Edges[edgeIndex];
                    var edgePath = relativePath + ".graphs[" + graphIndex + "].edges[" + edgeIndex + "]";
                    if (!edgeIds.Add(edge.Id))
                    {
                        throw Error("compile.duplicateId", edgePath + ".id", "Duplicate edge id '" + edge.Id + "'.");
                    }

                    ValidateEndpointExists(edge.Source, edgePath + ".source", localNodeIds, localPortIds);
                    ValidateEndpointExists(edge.Target, edgePath + ".target", localNodeIds, localPortIds);
                    for (var prior = 0; prior < edgeIndex; prior++)
                    {
                        if (SameConnection(graph.Edges[prior], edge))
                        {
                            throw Error("compile.duplicateConnection", edgePath, "An identical connection already exists.");
                        }
                    }
                }
            }

            for (var index = 0; index < graphs.Count; index++)
            {
                if (graphs[index].Id != rootGraphId && !ownerByGraphId.ContainsKey(graphs[index].Id))
                {
                    throw Error("compile.orphanSubgraph", relativePath + ".graphs[" + index + "].id", "Embedded graph '" + graphs[index].Id + "' has no owning subgraph node.");
                }
            }

            ValidateContainmentCycles(graphById, rootGraphId, relativePath);
            return new DocumentModel(graphs, rootGraphId, graphById, ownerByGraphId);
        }

        private static void ValidateEndpointExists(EndpointDefinition endpoint, string path, HashSet<string> nodeIds, HashSet<string> portIds)
        {
            if (endpoint.Kind == "node" && !nodeIds.Contains(endpoint.NodeId))
            {
                throw Error("compile.invalidPort", path + ".nodeId", "Node '" + endpoint.NodeId + "' does not exist in this graph.");
            }

            if (endpoint.Kind == "interface" && !portIds.Contains(endpoint.PortId))
            {
                throw Error("compile.invalidPort", path + ".portId", "Interface port '" + endpoint.PortId + "' does not exist in this graph.");
            }
        }

        private static bool SameConnection(EdgeDefinition left, EdgeDefinition right)
        {
            return left.Kind == right.Kind && SameEndpoint(left.Source, right.Source) && SameEndpoint(left.Target, right.Target);
        }

        private static bool SameEndpoint(EndpointDefinition left, EndpointDefinition right)
        {
            return left.Kind == right.Kind
                && left.PortId == right.PortId
                && (left.Kind == "interface" || left.NodeId == right.NodeId);
        }

        private static void ValidateContainmentCycles(Dictionary<string, GraphDefinition> graphById, string rootGraphId, string relativePath)
        {
            var visiting = new HashSet<string>(StringComparer.Ordinal);
            var visited = new HashSet<string>(StringComparer.Ordinal);
            Visit(rootGraphId);
            void Visit(string graphId)
            {
                if (visiting.Contains(graphId))
                {
                    throw Error("compile.subgraphContainmentCycle", relativePath + ".graphs", "Subgraph containment cycle includes '" + graphId + "'.");
                }

                if (visited.Contains(graphId))
                {
                    return;
                }

                visiting.Add(graphId);
                if (graphById.TryGetValue(graphId, out var graph))
                {
                    foreach (var node in graph.Nodes)
                    {
                        if (node.Kind == "subgraph")
                        {
                            Visit(node.SubgraphId);
                        }
                    }
                }

                visiting.Remove(graphId);
                visited.Add(graphId);
            }
        }

        // ---- 语义校验 + 产物构建（镜像 validateGraphDocument 的语义层，warning 一律 error）----

        private static JArray BuildDataGraphs(RouteDescriptor route, DocumentModel model, string relativePath, ICollection<JObject> mappings)
        {
            // 先解析全部 graphType（缺失/未知/usage 错误按文档顺序 fail-closed）。
            var graphTypeByGraphId = new Dictionary<string, IndexedDefinition>(StringComparer.Ordinal);
            for (var index = 0; index < model.Graphs.Count; index++)
            {
                var graph = model.Graphs[index];
                var path = relativePath + ".graphs[" + index + "]";
                if (graph.GraphTypeId == null)
                {
                    throw Error("compile.graphTypeMissing", path + ".graphTypeId", "Graph Type is not assigned.");
                }

                var graphType = ResolveGraphType(route, graph.GraphTypeId);
                if (graphType == null)
                {
                    throw Error("compile.graphTypeUnknown", path + ".graphTypeId", "Unknown Graph Type '" + graph.GraphTypeId + "'.");
                }

                var usage = graphType.Definition["usage"] == null ? "any" : graphType.Definition.Value<string>("usage");
                var isRoot = graph.Id == model.RootGraphId;
                if ((isRoot && usage == "subgraph") || (!isRoot && usage == "root"))
                {
                    throw Error(
                        "compile.invalidGraphTypeUsage",
                        path + ".graphTypeId",
                        "Graph Type '" + graphType.Id + "' cannot be used as " + (isRoot ? "a root graph" : "an embedded subgraph") + ".");
                }

                graphTypeByGraphId.Add(graph.Id, graphType);
            }

            // 产物顺序：root 图最前，其余按 id；节点/边按 id 排序，接口端口与动态端口保留文档顺序。
            var ordered = model.Graphs
                .OrderBy(graph => graph.Id == model.RootGraphId ? 0 : 1)
                .ThenBy(graph => graph.Id, StringComparer.Ordinal)
                .ToArray();
            var dataGraphs = new JArray();
            for (var graphIndex = 0; graphIndex < ordered.Length; graphIndex++)
            {
                dataGraphs.Add(BuildDataGraph(route, model, ordered[graphIndex], graphIndex, graphTypeByGraphId, relativePath, mappings));
            }

            return dataGraphs;
        }

        private static JObject BuildDataGraph(
            RouteDescriptor route,
            DocumentModel model,
            GraphDefinition graph,
            int artifactGraphIndex,
            IReadOnlyDictionary<string, IndexedDefinition> graphTypeByGraphId,
            string relativePath,
            ICollection<JObject> mappings)
        {
            var graphPath = relativePath + ".graphs[" + graph.Index + "]";
            var graphSourcePath = "graphs[" + graph.Id + "]";
            var graphArtifactPath = "data.graphs[" + artifactGraphIndex + "]";
            var graphType = graphTypeByGraphId[graph.Id];

            // 父 graphType 的 subgraph 白名单（对应 validateGraphType 的 subgraphTypeNotAllowed）。
            if (model.OwnerByGraphId.TryGetValue(graph.Id, out var owner))
            {
                var parentType = graphTypeByGraphId[owner.Graph.Id];
                var allowSubgraphs = parentType.Definition["allowSubgraphs"] == null || parentType.Definition["allowSubgraphs"].Value<bool>();
                if (allowSubgraphs && parentType.Definition["allowedSubgraphTypeIds"] is JArray whitelist)
                {
                    var allowed = whitelist.Values<string>().Any(identity =>
                    {
                        var candidate = ResolveGraphType(route, identity);
                        return candidate != null && candidate.Id == graphType.Id;
                    });
                    if (!allowed)
                    {
                        throw Error(
                            "compile.subgraphTypeNotAllowed",
                            graphPath + ".graphTypeId",
                            "Parent Graph Type '" + parentType.Id + "' does not allow subgraph type '" + graphType.Id + "'.");
                    }
                }
            }

            var interfacePorts = new JArray();
            for (var index = 0; index < graph.InterfacePorts.Count; index++)
            {
                var port = graph.InterfacePorts[index];
                var portPath = graphPath + ".interfacePorts[" + index + "]";
                if (port.DataTypeId != null && port.DataTypeId != "any" && !route.DataTypes.ContainsKey(port.DataTypeId))
                {
                    throw Error("compile.dataTypeUnknown", portPath + ".dataTypeId", "Data type '" + port.DataTypeId + "' is not declared by the Graph Catalog.");
                }

                if (port.Dynamic && graph.Id == model.RootGraphId)
                {
                    throw Error("compile.rootDynamicInterfacePort", portPath + ".dynamic", "Dynamic data parameters are only supported by embedded subgraphs.");
                }

                if (port.Dynamic && port.DataTypeId == "any" && IsDynamicInterfacePortConnected(model, graph, port))
                {
                    throw Error("compile.unresolvedDynamicInterfaceType", portPath + ".dataTypeId", "A connected dynamic interface port must resolve to a concrete data type.");
                }

                var portJson = new JObject
                {
                    ["id"] = port.Id,
                    ["title"] = port.Title,
                    ["kind"] = port.Kind,
                    ["direction"] = port.Direction,
                };
                if (port.DataTypeId != null)
                {
                    portJson["dataTypeId"] = port.DataTypeId;
                }

                if (port.MaxConnections != null)
                {
                    portJson["maxConnections"] = port.MaxConnections;
                }

                if (port.Dynamic)
                {
                    portJson["dynamic"] = true;
                }

                interfacePorts.Add(portJson);
            }

            var properties = MaterializeObject(
                (JArray)graphType.Definition["properties"],
                graph.Properties,
                graphSourcePath + ".properties",
                graphArtifactPath + ".properties",
                mappings,
                false);

            var nodes = new List<JObject>();
            var nodeTypesByNodeId = new Dictionary<string, IndexedDefinition>(StringComparer.Ordinal);
            // 节点按产物顺序（id 排序）校验并物化；错误路径仍指向文档索引。
            var orderedNodes = graph.Nodes
                .Select((node, index) => new { Node = node, Index = index })
                .OrderBy(value => value.Node.Id, StringComparer.Ordinal)
                .ToArray();
            foreach (var entry in orderedNodes)
            {
                var node = entry.Node;
                var nodePath = graphPath + ".nodes[" + entry.Index + "]";
                var nodeType = ResolveNodeDefinition(route, node, nodePath);
                nodeTypesByNodeId.Add(node.Id, nodeType);

                var nodeArtifactPath = graphArtifactPath + ".nodes[" + nodes.Count + "]";
                var nodeSourcePath = "graphs[" + graph.Id + "].nodes[" + node.Id + "]";
                nodes.Add(BuildDataNode(route, model, graph, node, nodeType, nodePath, nodeSourcePath, nodeArtifactPath, mappings));
            }

            ValidateNodeConstraints(graph, graphPath, graphType, nodeTypesByNodeId);

            var edges = new List<JObject>();
            var canonicalEdges = new List<CanonicalEdge>();
            for (var index = 0; index < graph.Edges.Count; index++)
            {
                var edge = graph.Edges[index];
                var edgePath = graphPath + ".edges[" + index + "]";
                var source = ResolveEndpoint(route, model, graph, nodeTypesByNodeId, edge.Source, edgePath + ".source");
                var target = ResolveEndpoint(route, model, graph, nodeTypesByNodeId, edge.Target, edgePath + ".target");
                if (source.Direction != "output")
                {
                    throw Error("compile.invalidSourceDirection", edgePath + ".source", "An edge source must be an output port.");
                }

                if (target.Direction != "input")
                {
                    throw Error("compile.invalidTargetDirection", edgePath + ".target", "An edge target must be an input port.");
                }

                if (source.Kind != edge.Kind || target.Kind != edge.Kind)
                {
                    throw Error("compile.edgeKindMismatch", edgePath, "Edge kind '" + edge.Kind + "' does not match both ports.");
                }

                if (edge.Kind == "data"
                    && source.DataTypeId != null
                    && target.DataTypeId != null
                    && !IsDataTypeAssignable(route, source.DataTypeId, target.DataTypeId))
                {
                    throw Error(
                        "compile.dataTypeMismatch",
                        edgePath,
                        "Data type '" + source.DataTypeId + "' cannot connect to '" + target.DataTypeId + "'.");
                }

                canonicalEdges.Add(new CanonicalEdge(edge, source.Id, target.Id, edgePath));
                edges.Add(new JObject
                {
                    ["id"] = edge.Id,
                    ["kind"] = edge.Kind,
                    ["source"] = SerializeEndpoint(edge.Source, source.Id),
                    ["target"] = SerializeEndpoint(edge.Target, target.Id),
                });
            }

            ValidateSemanticDuplicateConnections(canonicalEdges);
            ValidateCardinality(route, model, graph, graphPath, graphType, nodeTypesByNodeId, canonicalEdges);

            return new JObject
            {
                ["id"] = graph.Id,
                ["graphTypeId"] = graphType.Id,
                ["title"] = graph.Title,
                ["properties"] = properties,
                ["interfacePorts"] = interfacePorts,
                ["nodes"] = new JArray(nodes.OrderBy(node => node.Value<string>("id"), StringComparer.Ordinal)),
                ["edges"] = new JArray(edges.OrderBy(edge => edge.Value<string>("id"), StringComparer.Ordinal)),
            };
        }

        private static bool IsDynamicInterfacePortConnected(DocumentModel model, GraphDefinition graph, InterfacePortDefinition port)
        {
            var connectedInside = graph.Edges.Any(edge =>
                edge.Kind == "data"
                && ((edge.Source.Kind == "interface" && edge.Source.PortId == port.Id)
                    || (edge.Target.Kind == "interface" && edge.Target.PortId == port.Id)));
            if (connectedInside)
            {
                return true;
            }

            return model.OwnerByGraphId.TryGetValue(graph.Id, out var owner) && owner.Graph.Edges.Any(edge =>
                edge.Kind == "data"
                && ((edge.Source.Kind == "node" && edge.Source.NodeId == owner.Node.Id && edge.Source.PortId == port.Id)
                    || (edge.Target.Kind == "node" && edge.Target.NodeId == owner.Node.Id && edge.Target.PortId == port.Id)));
        }

        private static IndexedDefinition ResolveNodeDefinition(RouteDescriptor route, NodeDefinition node, string nodePath)
        {
            if (node.Kind == "subgraph" && node.NodeTypeId == null)
            {
                throw Error("compile.untypedSubgraphNode", nodePath + ".nodeTypeId", "Subgraph call has no node type.");
            }

            var nodeType = ResolveNodeType(route, node.NodeTypeId);
            if (nodeType == null)
            {
                throw Error("compile.nodeTypeUnknown", nodePath + ".nodeTypeId", "Unknown node type '" + node.NodeTypeId + "'.");
            }

            if (node.Kind == "node" && nodeType.Definition["subgraph"] != null)
            {
                throw Error("compile.subgraphTypeUsedForAtomicNode", nodePath + ".nodeTypeId", "Node type '" + nodeType.Id + "' must own an embedded subgraph.");
            }

            if (node.Kind == "subgraph" && nodeType.Definition["subgraph"] == null)
            {
                throw Error("compile.atomicTypeUsedForSubgraph", nodePath + ".nodeTypeId", "Node type '" + nodeType.Id + "' is not a subgraph call type.");
            }

            return nodeType;
        }

        private static JObject BuildDataNode(
            RouteDescriptor route,
            DocumentModel model,
            GraphDefinition graph,
            NodeDefinition node,
            IndexedDefinition nodeType,
            string nodePath,
            string nodeSourcePath,
            string nodeArtifactPath,
            ICollection<JObject> mappings)
        {
            var properties = MaterializeObject(
                (JArray)nodeType.Definition["properties"],
                node.Properties,
                nodeSourcePath + ".properties",
                nodeArtifactPath + ".properties",
                mappings,
                false);

            var dynamicPorts = new JArray();
            var groupCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var index = 0; index < node.DynamicPorts.Count; index++)
            {
                var dynamicPort = node.DynamicPorts[index];
                var portPath = nodePath + ".dynamicPorts[" + index + "]";
                if (ResolvePortDefinition(nodeType.Definition, dynamicPort.Id) != null)
                {
                    throw Error("compile.dynamicPortIdCollision", portPath + ".id", "Dynamic port id '" + dynamicPort.Id + "' collides with a static port identity on '" + nodeType.Id + "'.");
                }

                if (ResolveListPortDefinition(nodeType.Definition, dynamicPort.Id) != null)
                {
                    throw Error("compile.dynamicPortIdCollision", portPath + ".id", "Dynamic item id '" + dynamicPort.Id + "' collides with a whole-List port identity on '" + nodeType.Id + "'.");
                }

                var group = ResolveDynamicPortGroup(nodeType.Definition, dynamicPort.GroupId);
                if (group == null)
                {
                    throw Error("compile.unknownDynamicPortGroup", portPath + ".groupId", "Dynamic port group '" + dynamicPort.GroupId + "' is not declared by '" + nodeType.Id + "'.");
                }

                groupCounts.TryGetValue(group.Value<string>("id"), out var count);
                groupCounts[group.Value<string>("id")] = count + 1;
                ValidateFieldValue(dynamicPort.Value, (JObject)group["item"], portPath + ".value");
                dynamicPorts.Add(new JObject
                {
                    ["id"] = dynamicPort.Id,
                    ["groupId"] = group.Value<string>("id"),
                    ["title"] = dynamicPort.Title,
                    ["value"] = dynamicPort.Value.DeepClone(),
                });
            }

            foreach (var group in DynamicPortGroups(nodeType.Definition))
            {
                groupCounts.TryGetValue(group.Value<string>("id"), out var count);
                if (group["maxItems"] != null && count > group["maxItems"].Value<long>())
                {
                    throw Error(
                        "compile.tooManyDynamicPorts",
                        nodePath + ".dynamicPorts",
                        "Dynamic port group '" + group.Value<string>("id") + "' has " + count + " items but allows " + group["maxItems"].Value<long>() + ".");
                }
            }

            if (node.Kind == "subgraph")
            {
                ValidateSubgraphNode(route, model, node, nodeType, nodePath);
            }

            ValidateNodeAllowed(route, graph, node, nodeType, nodePath);

            var nodeJson = new JObject
            {
                ["kind"] = node.Kind,
                ["id"] = node.Id,
                ["nodeTypeId"] = nodeType.Id,
            };
            if (node.Kind == "subgraph")
            {
                nodeJson["subgraphId"] = node.SubgraphId;
            }

            nodeJson["title"] = node.Title;
            nodeJson["position"] = new JObject
            {
                ["x"] = node.Position.X.DeepClone(),
                ["y"] = node.Position.Y.DeepClone(),
            };
            nodeJson["properties"] = properties;
            nodeJson["dynamicPorts"] = dynamicPorts;
            return nodeJson;
        }

        private static void ValidateSubgraphNode(RouteDescriptor route, DocumentModel model, NodeDefinition node, IndexedDefinition nodeType, string nodePath)
        {
            // subgraph 调用类型的目标类型必须包含子图 graphType。
            if (model.GraphById.TryGetValue(node.SubgraphId, out var childGraph)
                && childGraph.GraphTypeId != null
                && ResolveGraphType(route, childGraph.GraphTypeId) is IndexedDefinition childType
                && nodeType.Definition["subgraph"]?["graphTypeIds"] is JArray graphTypeIds)
            {
                var match = graphTypeIds.Values<string>().Any(identity =>
                {
                    var candidate = ResolveGraphType(route, identity);
                    return candidate != null && candidate.Id == childType.Id;
                });
                if (!match)
                {
                    throw Error(
                        "compile.subgraphCallTypeMismatch",
                        nodePath + ".nodeTypeId",
                        "Subgraph node type '" + nodeType.Id + "' cannot contain Graph Type '" + childType.Id + "'.");
                }
            }

            if (model.GraphById.TryGetValue(node.SubgraphId, out var child))
            {
                // subgraph 节点端口与子图 interfacePort 身份冲突。
                var occupiedPortIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var port in GetTypedNodePorts(node, nodeType.Definition))
                {
                    occupiedPortIds.Add(port.Id);
                    var definition = ResolvePortDefinition(nodeType.Definition, port.Id);
                    if (definition != null && definition["aliases"] is JArray aliases)
                    {
                        foreach (var alias in aliases.Values<string>())
                        {
                            occupiedPortIds.Add(alias);
                        }
                    }
                }

                foreach (var port in child.InterfacePorts)
                {
                    if (occupiedPortIds.Contains(port.Id))
                    {
                        throw Error(
                            "compile.subgraphPortIdCollision",
                            nodePath + ".subgraphId",
                            "Subgraph interface port '" + port.Id + "' collides with a static or dynamic port on '" + nodeType.Id + "'.");
                    }
                }
            }
        }

        private static void ValidateNodeAllowed(RouteDescriptor route, GraphDefinition graph, NodeDefinition node, IndexedDefinition nodeType, string nodePath)
        {
            var graphType = ResolveGraphType(route, graph.GraphTypeId);
            if (node.Kind == "subgraph" && graphType != null)
            {
                var allowSubgraphs = graphType.Definition["allowSubgraphs"] == null || graphType.Definition["allowSubgraphs"].Value<bool>();
                if (!allowSubgraphs)
                {
                    throw Error("compile.subgraphsNotAllowed", nodePath + ".subgraphId", "Graph Type '" + graphType.Id + "' does not allow subgraphs.");
                }
            }

            if (!IsNodeTypeAllowed(graphType.Definition, nodeType))
            {
                throw Error(
                    "compile.nodeTypeNotAllowed",
                    nodePath + ".nodeTypeId",
                    "Graph Type '" + graphType.Id + "' does not allow node type '" + nodeType.Id + "'.");
            }
        }

        private static void ValidateNodeConstraints(
            GraphDefinition graph,
            string graphPath,
            IndexedDefinition graphType,
            IReadOnlyDictionary<string, IndexedDefinition> nodeTypesByNodeId)
        {
            if (!(graphType.Definition["nodeConstraints"] is JArray constraints))
            {
                return;
            }

            foreach (var constraint in constraints.Cast<JObject>())
            {
                var count = 0;
                foreach (var node in graph.Nodes)
                {
                    if (nodeTypesByNodeId.TryGetValue(node.Id, out var nodeType) && MatchesNodeSelector(nodeType.Definition, (JObject)constraint["selector"]))
                    {
                        count++;
                    }
                }

                var constraintPath = graphPath + ".nodeConstraints." + constraint.Value<string>("id");
                if (constraint["minInstances"] != null && count < constraint["minInstances"].Value<long>())
                {
                    throw Error(
                        "compile.tooFewNodeInstances",
                        constraintPath,
                        "Constraint '" + constraint.Value<string>("id") + "' requires at least " + constraint["minInstances"].Value<long>() + " matching nodes; found " + count + ".");
                }

                if (constraint["maxInstances"] != null && count > constraint["maxInstances"].Value<long>())
                {
                    throw Error(
                        "compile.tooManyNodeInstances",
                        constraintPath,
                        "Constraint '" + constraint.Value<string>("id") + "' allows at most " + constraint["maxInstances"].Value<long>() + " matching nodes; found " + count + ".");
                }
            }
        }

        private static void ValidateSemanticDuplicateConnections(IReadOnlyList<CanonicalEdge> edges)
        {
            var connections = new HashSet<string>(StringComparer.Ordinal);
            foreach (var edge in edges)
            {
                var key = edge.Edge.Kind
                    + "|" + EndpointKey(edge.Edge.Source, edge.SourcePortId)
                    + "|" + EndpointKey(edge.Edge.Target, edge.TargetPortId);
                if (!connections.Add(key))
                {
                    throw Error(
                        "compile.duplicateSemanticConnection",
                        edge.Path,
                        "Connections using canonical and aliased port IDs cannot target the same endpoints twice.");
                }
            }
        }

        private static void ValidateCardinality(
            RouteDescriptor route,
            DocumentModel model,
            GraphDefinition graph,
            string graphPath,
            IndexedDefinition graphType,
            IReadOnlyDictionary<string, IndexedDefinition> nodeTypesByNodeId,
            IReadOnlyList<CanonicalEdge> edges)
        {
            var counts = new Dictionary<string, CardinalityEndpoint>(StringComparer.Ordinal);
            foreach (var edge in edges)
            {
                RegisterEndpoint(edge.Edge.Source, "source");
                RegisterEndpoint(edge.Edge.Target, "target");
            }

            foreach (var entry in counts)
            {
                var endpoint = entry.Value;
                var port = ResolveEndpoint(route, model, graph, nodeTypesByNodeId, endpoint.Endpoint, graphPath);
                var maxConnections = GetEffectiveMaxConnections(graphType.Definition, port);
                if (maxConnections != null && entry.Value.Count > maxConnections)
                {
                    throw Error(
                        "compile.tooManyConnections",
                        graphPath + ".edges",
                        EndpointKey(endpoint.Endpoint, port.Id) + " has " + entry.Value.Count + " connections but allows " + maxConnections + ".");
                }
            }

            void RegisterEndpoint(EndpointDefinition endpoint, string role)
            {
                var port = ResolveEndpoint(route, model, graph, nodeTypesByNodeId, endpoint, graphPath);
                var key = role + "|" + EndpointKey(endpoint, port.Id);
                counts.TryGetValue(key, out var current);
                counts[key] = new CardinalityEndpoint(endpoint, (current?.Count ?? 0) + 1);
            }
        }

        // 有效连接上限 = min(graphType 规则, 端口 maxConnections)；缺省维度视为无上限。
        private static long? GetEffectiveMaxConnections(JObject graphType, ResolvedPort port)
        {
            var rules = (JObject)graphType["portConnectionRules"];
            var graphTypeLimit = rules != null && rules[port.Direction]?.Value<string>() == "single" ? 1 : default(long?);
            if (graphTypeLimit == null)
            {
                return port.MaxConnections;
            }

            return port.MaxConnections == null ? graphTypeLimit : Math.Min(graphTypeLimit.Value, port.MaxConnections.Value);
        }

        private static ResolvedPort ResolveEndpoint(
            RouteDescriptor route,
            DocumentModel model,
            GraphDefinition graph,
            IReadOnlyDictionary<string, IndexedDefinition> nodeTypesByNodeId,
            EndpointDefinition endpoint,
            string path)
        {
            if (endpoint.Kind == "interface")
            {
                var port = graph.InterfacePorts.FirstOrDefault(candidate => candidate.Id == endpoint.PortId);
                if (port == null)
                {
                    throw Error("compile.invalidPort", path, "Interface port '" + endpoint.PortId + "' does not exist.");
                }

                // 接口端口的声明方向是父图视角；图内使用时翻转，effective input 强制上限 1。
                var effectiveDirection = port.Direction == "input" ? "output" : "input";
                return new ResolvedPort(
                    port.Id,
                    port.Kind,
                    effectiveDirection,
                    port.DataTypeId,
                    effectiveDirection == "input" ? 1 : port.MaxConnections);
            }

            var node = graph.Nodes.FirstOrDefault(candidate => candidate.Id == endpoint.NodeId);
            if (node == null)
            {
                throw Error("compile.invalidPort", path, "Node '" + endpoint.NodeId + "' does not exist.");
            }

            var nodeType = nodeTypesByNodeId[node.Id];
            if (node.Kind == "subgraph")
            {
                var typedPort = ResolveTypedNodePort(node, nodeType.Definition, endpoint.PortId);
                if (typedPort != null)
                {
                    return typedPort;
                }

                // 子图 interfacePort 的声明方向已是父图视角，按原样使用。
                if (model.GraphById.TryGetValue(node.SubgraphId, out var child))
                {
                    var port = child.InterfacePorts.FirstOrDefault(candidate => candidate.Id == endpoint.PortId);
                    if (port != null)
                    {
                        return new ResolvedPort(port.Id, port.Kind, port.Direction, port.DataTypeId, port.MaxConnections);
                    }
                }

                throw Error("compile.invalidPort", path, "Subgraph port '" + endpoint.PortId + "' does not exist.");
            }

            var staticPort = ResolvePortDefinition(nodeType.Definition, endpoint.PortId);
            if (staticPort != null)
            {
                return ToResolvedPort(staticPort);
            }

            var dynamicPort = GetTypedNodePorts(node, nodeType.Definition).FirstOrDefault(candidate => candidate.Id == endpoint.PortId);
            if (dynamicPort == null)
            {
                throw Error("compile.invalidPort", path, "Port '" + endpoint.PortId + "' does not exist on '" + nodeType.Id + "'.");
            }

            return dynamicPort;
        }

        private static ResolvedPort ResolveTypedNodePort(NodeDefinition node, JObject nodeType, string portId)
        {
            var staticPort = ResolvePortDefinition(nodeType, portId);
            if (staticPort != null)
            {
                return ToResolvedPort(staticPort);
            }

            var listPort = ResolveListPortDefinition(nodeType, portId);
            if (listPort != null)
            {
                return listPort;
            }

            return GetTypedNodePorts(node, nodeType).FirstOrDefault(candidate => candidate.Id == portId);
        }

        private static JObject ResolvePortDefinition(JObject nodeType, string portId)
        {
            return StaticPorts(nodeType).FirstOrDefault(port =>
                port.Value<string>("id") == portId
                || (port["aliases"] is JArray aliases && aliases.Values<string>().Contains(portId, StringComparer.Ordinal)));
        }

        // 与 VS Code 生产解析一致：只有显式声明 listPortMode == "list" 的组才是 whole-List 端口。
        private static ResolvedPort ResolveListPortDefinition(JObject nodeType, string portId)
        {
            foreach (var group in DynamicPortGroups(nodeType))
            {
                if (group.Value<string>("listPortMode") != "list")
                {
                    continue;
                }

                if (group.Value<string>("id") == portId
                    || (group["aliases"] is JArray aliases && aliases.Values<string>().Contains(portId, StringComparer.Ordinal)))
                {
                    var template = (JObject)group["port"];
                    return new ResolvedPort(
                        group.Value<string>("id"),
                        template.Value<string>("kind"),
                        template.Value<string>("direction"),
                        template["dataTypeId"]?.Value<string>(),
                        template["maxConnections"]?.Type == JTokenType.Integer ? template["maxConnections"].Value<long>() : default(long?));
                }
            }

            return null;
        }

        private static JObject ResolveDynamicPortGroup(JObject nodeType, string groupId)
        {
            return DynamicPortGroups(nodeType).FirstOrDefault(group =>
                group.Value<string>("id") == groupId
                || (group["aliases"] is JArray aliases && aliases.Values<string>().Contains(groupId, StringComparer.Ordinal)));
        }

        // 静态端口 + whole-List 端口 + element 模式动态端口（镜像 getTypedNodePorts）。
        private static IEnumerable<ResolvedPort> GetTypedNodePorts(NodeDefinition node, JObject nodeType)
        {
            foreach (var port in StaticPorts(nodeType))
            {
                yield return ToResolvedPort(port);
            }

            foreach (var group in DynamicPortGroups(nodeType))
            {
                if (group.Value<string>("listPortMode") == "list")
                {
                    var listPort = ResolveListPortDefinition(nodeType, group.Value<string>("id"));
                    if (listPort != null)
                    {
                        yield return listPort;
                    }
                }
            }

            foreach (var dynamicPort in node.DynamicPorts)
            {
                var group = ResolveDynamicPortGroup(nodeType, dynamicPort.GroupId);
                if (group == null || group.Value<string>("listPortMode") == "list")
                {
                    continue;
                }

                var template = (JObject)group["port"];
                yield return new ResolvedPort(
                    dynamicPort.Id,
                    template.Value<string>("kind"),
                    template.Value<string>("direction"),
                    template["dataTypeId"]?.Value<string>(),
                    template["maxConnections"]?.Type == JTokenType.Integer ? template["maxConnections"].Value<long>() : default(long?));
            }
        }

        private static ResolvedPort ToResolvedPort(JObject port)
        {
            return new ResolvedPort(
                port.Value<string>("id"),
                port.Value<string>("kind"),
                port.Value<string>("direction"),
                port["dataTypeId"]?.Value<string>(),
                port["maxConnections"]?.Type == JTokenType.Integer ? port["maxConnections"].Value<long>() : default(long?));
        }

        private static IEnumerable<JObject> StaticPorts(JObject nodeType)
        {
            return nodeType["ports"] is JArray ports ? ports.Cast<JObject>() : Enumerable.Empty<JObject>();
        }

        private static IEnumerable<JObject> DynamicPortGroups(JObject nodeType)
        {
            return nodeType["dynamicPortGroups"] is JArray groups ? groups.Cast<JObject>() : Enumerable.Empty<JObject>();
        }

        // isNodeTypeAssignable 语义：相同、任一侧 "any"、target.accepts 含 source、target.acceptsAnySource。
        private static bool IsDataTypeAssignable(RouteDescriptor route, string sourceDataTypeId, string targetDataTypeId)
        {
            if (sourceDataTypeId == targetDataTypeId || sourceDataTypeId == "any" || targetDataTypeId == "any")
            {
                return true;
            }

            if (!route.DataTypes.TryGetValue(targetDataTypeId, out var target))
            {
                return false;
            }

            return (target.Definition["acceptsAnySource"] != null && target.Definition["acceptsAnySource"].Value<bool>())
                || (target.Definition["accepts"] is JArray accepts && accepts.Values<string>().Contains(sourceDataTypeId, StringComparer.Ordinal));
        }

        // catalogAllowed（supportedCatalogIds）+ selector 匹配（nodeTypeIds OR / tags OR / traits AND，三维 AND）。
        private static bool IsNodeTypeAllowed(JObject graphType, IndexedDefinition nodeType)
        {
            var supportedCatalogIds = graphType["supportedCatalogIds"] is JArray supported
                ? supported.Values<string>()
                : Enumerable.Empty<string>();
            if (!supportedCatalogIds.Contains(nodeType.CatalogId, StringComparer.Ordinal))
            {
                return false;
            }

            if (!(graphType["allowedNodeSelectors"] is JArray selectors))
            {
                return true;
            }

            return selectors.Cast<JObject>().Any(selector => MatchesNodeSelector(nodeType.Definition, selector));
        }

        private static bool MatchesNodeSelector(JObject nodeType, JObject selector)
        {
            if (selector["nodeTypeIds"] is JArray nodeTypeIds)
            {
                var nodeTypeMatch = nodeTypeIds.Values<string>().Any(identity =>
                    identity == nodeType.Value<string>("id")
                    || (nodeType["aliases"] is JArray aliases && aliases.Values<string>().Contains(identity, StringComparer.Ordinal)));
                if (!nodeTypeMatch)
                {
                    return false;
                }
            }

            if (selector["tags"] is JArray tags)
            {
                var nodeTags = nodeType["tags"] is JArray nodeTagArray ? nodeTagArray.Values<string>() : Enumerable.Empty<string>();
                if (!tags.Values<string>().Any(tag => nodeTags.Contains(tag, StringComparer.Ordinal)))
                {
                    return false;
                }
            }

            if (selector["traits"] is JArray traits)
            {
                var nodeTraits = nodeType["traits"] is JArray nodeTraitArray ? nodeTraitArray.Values<string>() : Enumerable.Empty<string>();
                if (!traits.Values<string>().All(trait => nodeTraits.Contains(trait, StringComparer.Ordinal)))
                {
                    return false;
                }
            }

            return true;
        }

        private static IndexedDefinition ResolveNodeType(RouteDescriptor route, string identity)
        {
            return identity == null ? null : route.NodeTypes.GetValueOrDefault(identity);
        }

        private static IndexedDefinition ResolveGraphType(RouteDescriptor route, string identity)
        {
            return identity == null ? null : route.GraphTypes.GetValueOrDefault(identity);
        }

        private static JObject SerializeEndpoint(EndpointDefinition endpoint, string canonicalPortId)
        {
            if (endpoint.Kind == "node")
            {
                return new JObject
                {
                    ["kind"] = "node",
                    ["nodeId"] = endpoint.NodeId,
                    ["portId"] = canonicalPortId,
                };
            }

            return new JObject
            {
                ["kind"] = "interface",
                ["portId"] = canonicalPortId,
            };
        }

        private static string EndpointKey(EndpointDefinition endpoint, string canonicalPortId)
        {
            return endpoint.Kind == "node"
                ? endpoint.Kind + ":" + endpoint.NodeId + ":" + canonicalPortId
                : endpoint.Kind + ":" + canonicalPortId;
        }

        // ---- 属性物化（镜像 Entity Compiler 的 JSON 级实现：别名 canonical 化 + defaultValue 物化）----

        private static JObject MaterializeObject(
            JArray definitions,
            JObject value,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
            var json = new JObject();
            var canonical = new Dictionary<string, JObject>(StringComparer.Ordinal);
            var aliases = new Dictionary<string, JObject>(StringComparer.Ordinal);
            foreach (var definition in definitions.Cast<JObject>())
            {
                canonical.Add(definition.Value<string>("id"), definition);
                if (definition["aliases"] is JArray definitionAliases)
                {
                    foreach (var alias in definitionAliases.Values<string>())
                    {
                        aliases.Add(alias, definition);
                    }
                }
            }

            foreach (var property in value.Properties())
            {
                if (canonical.ContainsKey(property.Name) || aliases.ContainsKey(property.Name))
                {
                    continue;
                }

                throw Error("compile.unknownField", sourcePath + "." + property.Name, "Unknown field '" + property.Name + "'.");
            }

            foreach (var definition in definitions.Cast<JObject>().OrderBy(item => item.Value<string>("id"), StringComparer.Ordinal))
            {
                var fieldId = definition.Value<string>("id");
                var matches = new List<JProperty>();
                var canonicalProperty = value.Property(fieldId, StringComparison.Ordinal);
                if (canonicalProperty != null)
                {
                    matches.Add(canonicalProperty);
                }

                if (definition["aliases"] is JArray fieldAliases)
                {
                    matches.AddRange(fieldAliases.Values<string>()
                        .Select(alias => value.Property(alias, StringComparison.Ordinal))
                        .Where(property => property != null));
                }

                if (matches.Count > 1)
                {
                    throw Error(
                        "compile.fieldIdentityConflict",
                        sourcePath + "." + fieldId,
                        "Canonical field ID and aliases must not be present together.");
                }

                var property = matches.SingleOrDefault();
                var usesDefault = inheritedDefault || property == null;
                // 缺失字段用 Catalog defaultValue 物化，origin 记为 metadataDefault（sourcePath 省略）。
                var token = property == null ? definition["defaultValue"].DeepClone() : property.Value;
                var fieldSourcePath = sourcePath + "." + (property == null ? fieldId : property.Name);
                var fieldArtifactPath = artifactPath + "." + fieldId;
                json[fieldId] = MaterializeValue(definition, token, fieldSourcePath, fieldArtifactPath, mappings, usesDefault);
                var mapping = new JObject();
                if (!usesDefault)
                {
                    mapping["sourcePath"] = fieldSourcePath;
                }

                mapping["artifactPath"] = fieldArtifactPath;
                mapping["origin"] = usesDefault ? "metadataDefault" : "document";
                mappings.Add(mapping);
            }

            return json;
        }

        private static JToken MaterializeValue(
            JObject definition,
            JToken token,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
            switch (definition.Value<string>("valueType"))
            {
                case "string":
                    VisualBridgeStructuredCompiler.RequireTokenType(token, JTokenType.String, sourcePath, "a string");
                    RequireEnumOption(definition, token, sourcePath);
                    return token.DeepClone();
                case "boolean":
                    VisualBridgeStructuredCompiler.RequireTokenType(token, JTokenType.Boolean, sourcePath, "a boolean");
                    RequireEnumOption(definition, token, sourcePath);
                    return token.DeepClone();
                case "number":
                    return MaterializeNumber(definition, token, sourcePath);
                case "array":
                    if (!(token is JArray array))
                    {
                        throw Error("compile.typeMismatch", sourcePath, "Expected an array.");
                    }

                    var items = new JArray();
                    var itemDefinition = (JObject)definition["item"];
                    for (var index = 0; index < array.Count; index++)
                    {
                        items.Add(MaterializeValue(
                            itemDefinition,
                            array[index],
                            sourcePath + "[" + index + "]",
                            artifactPath + "[" + index + "]",
                            mappings,
                            inheritedDefault));
                    }

                    return items;
                case "object":
                    if (!(token is JObject objectValue))
                    {
                        throw Error("compile.typeMismatch", sourcePath, "Expected an object.");
                    }

                    return MaterializeObject((JArray)definition["fields"], objectValue, sourcePath, artifactPath, mappings, inheritedDefault);
                default:
                    throw Error("compile.typeMismatch", sourcePath, "Unsupported Catalog valueType.");
            }
        }

        private static JToken MaterializeNumber(JObject definition, JToken token, string sourcePath)
        {
            if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
            {
                throw Error("compile.typeMismatch", sourcePath, "Expected a JSON number.");
            }

            var number = token.Value<double>();
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                throw Error("compile.numberOutOfRange", sourcePath, "Number must be finite.");
            }

            if (IsIntegralDefinition(definition) && token.Type != JTokenType.Integer)
            {
                throw Error("compile.typeMismatch", sourcePath, "Expected an integral JSON number.");
            }

            if (definition["editor"] is JObject editor)
            {
                if (editor["min"] != null && editor["min"].Type != JTokenType.Null && number < editor["min"].Value<double>())
                {
                    throw Error("compile.numberOutOfRange", sourcePath, "Number is below the declared editor minimum.");
                }

                if (editor["max"] != null && editor["max"].Type != JTokenType.Null && number > editor["max"].Value<double>())
                {
                    throw Error("compile.numberOutOfRange", sourcePath, "Number is above the declared editor maximum.");
                }
            }

            RequireEnumOption(definition, token, sourcePath);
            return token.DeepClone();
        }

        private static void RequireEnumOption(JObject definition, JToken token, string sourcePath)
        {
            if (!(definition["editor"] is JObject editor) || !(editor["options"] is JArray options))
            {
                return;
            }

            // select 编辑器（枚举）的值必须命中 options 之一。
            for (var index = 0; index < options.Count; index++)
            {
                if (JToken.DeepEquals(((JObject)options[index])["value"], token))
                {
                    return;
                }
            }

            throw Error("compile.enumValueInvalid", sourcePath, "Value is not one of the declared editor options.");
        }

        private static bool IsIntegralDefinition(JObject definition)
        {
            if (definition["editor"] is JObject editor
                && editor["integer"] != null
                && editor["integer"].Type == JTokenType.Boolean
                && editor["integer"].Value<bool>())
            {
                return true;
            }

            switch (definition.Value<string>("dataTypeId"))
            {
                case "byte":
                case "sbyte":
                case "short":
                case "ushort":
                case "int":
                case "uint":
                    return true;
                default:
                    return false;
            }
        }

        private static void ValidateFieldValue(JToken value, JObject definition, string sourcePath)
        {
            // 动态端口 value 只做值校验（无物化），复用 MaterializeValue 的校验路径。
            MaterializeValue(definition, value, sourcePath, sourcePath, new List<JObject>(), false);
        }

        // ---- Manifest / stale / 解析辅助 ----

        private static VisualBridgeStructuredCompiler.OutputPlan BuildManifest(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IReadOnlyList<VisualBridgeStructuredCompiler.OutputPlan> outputs,
            IReadOnlyDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            var manifest = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ManifestKind,
                ["projectId"] = project.ProjectId,
                ["inputs"] = new JArray(inputs.Values
                    .Select(input => new JObject
                    {
                        ["path"] = VisualBridgeStructuredCompiler.InputDisplayPath(profile, project, input.Path),
                        ["sha256"] = input.Hash,
                    })
                    .OrderBy(value => value.Value<string>("path"), StringComparer.Ordinal)),
                ["outputs"] = new JArray(outputs.OrderBy(output => output.RelativePath, StringComparer.Ordinal).Select(output => new JObject
                {
                    ["kind"] = output.Kind,
                    ["path"] = output.RelativePath,
                    ["sha256"] = output.Hash,
                })),
            };
            return VisualBridgeStructuredCompiler.CreateOutput(
                profile.CompileOutputRoot,
                ManifestFileName,
                VisualBridgeStructuredCompiler.Serialize(manifest),
                "manifest");
        }

        private static IReadOnlyList<string> ReadPreviousManagedPaths(string outputRoot)
        {
            var manifestPath = Path.Combine(outputRoot, ManifestFileName);
            if (!File.Exists(manifestPath))
            {
                return Array.Empty<string>();
            }

            VisualBridgeStructuredCompiler.RejectOutputAlias(manifestPath);
            var manifest = VisualBridgeIntegrationProfileLoader.ReadStrictObject(manifestPath, "compile.manifestInvalidJson");
            VisualBridgeStructuredCompiler.RequireKeys(manifest, "manifest", new[] { "formatVersion", "kind", "projectId", "inputs", "outputs" });
            if (manifest["formatVersion"].Type != JTokenType.Integer || manifest["formatVersion"].Value<long>() != 1)
            {
                throw Error("compile.manifestInvalid", "manifest.formatVersion", "Expected formatVersion 1.");
            }

            if (manifest["kind"].Type != JTokenType.String || manifest.Value<string>("kind") != ManifestKind)
            {
                throw Error("compile.manifestInvalid", "manifest.kind", "Unexpected manifest kind.");
            }

            if (!(manifest["inputs"] is JArray) || !(manifest["outputs"] is JArray outputs))
            {
                throw Error("compile.manifestInvalid", "manifest", "Expected input and output arrays.");
            }

            var result = new List<string>(outputs.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < outputs.Count; index++)
            {
                if (!(outputs[index] is JObject output))
                {
                    throw Error("compile.manifestInvalid", "manifest.outputs[" + index + "]", "Expected an object.");
                }

                VisualBridgeStructuredCompiler.RequireKeys(output, "manifest.outputs[" + index + "]", new[] { "kind", "path", "sha256" });
                var path = output["path"].Type == JTokenType.String ? output.Value<string>("path") : null;
                VisualBridgeStructuredCompiler.ValidateOutputRelativePath(path, "manifest.outputs[" + index + "].path");
                VisualBridgeStructuredCompiler.RequireHash(output["sha256"], "manifest.outputs[" + index + "].sha256");
                if (!unique.Add(path))
                {
                    throw Error("compile.manifestInvalid", "manifest.outputs[" + index + "].path", "Duplicate managed output path.");
                }

                result.Add(path);
            }

            return result;
        }

        private static void RequireKeys(JObject value, string path, IEnumerable<string> required, IEnumerable<string> optional)
        {
            var requiredSet = new HashSet<string>(required, StringComparer.Ordinal);
            var allowed = new HashSet<string>(requiredSet, StringComparer.Ordinal);
            allowed.UnionWith(optional);
            foreach (var property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw Error("compile.unknownProperty", path + "." + property.Name, "Unknown property '" + property.Name + "'.");
                }
            }

            foreach (var name in requiredSet)
            {
                if (value.Property(name, StringComparison.Ordinal) == null)
                {
                    throw Error("compile.missingProperty", path + "." + name, "Missing property '" + name + "'.");
                }
            }
        }

        private static JArray RequireArray(JToken token, string path)
        {
            if (!(token is JArray value))
            {
                throw Error("compile.typeMismatch", path, "Expected an array.");
            }

            return value;
        }

        private static string RequireString(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("compile.typeMismatch", path, "Expected a string.");
            }

            return token.Value<string>();
        }

        private static string RequireEnum(JToken token, string path, IReadOnlyList<string> values)
        {
            var value = RequireString(token, path);
            if (!values.Contains(value, StringComparer.Ordinal))
            {
                throw Error("compile.typeMismatch", path, "Expected one of [" + string.Join(", ", values) + "].");
            }

            return value;
        }

        private static bool RequireBoolean(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.Boolean)
            {
                throw Error("compile.typeMismatch", path, "Expected a boolean.");
            }

            return token.Value<bool>();
        }

        private static JToken RequireNumber(JToken token, string path)
        {
            if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float))
            {
                throw Error("compile.typeMismatch", path, "Expected a number.");
            }

            var number = token.Value<double>();
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                throw Error("compile.typeMismatch", path, "Expected a finite number.");
            }

            return token;
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

        private sealed class Registry
        {
            public Registry(IReadOnlyDictionary<string, RouteDescriptor> routes)
            {
                Routes = routes;
            }

            public IReadOnlyDictionary<string, RouteDescriptor> Routes { get; }
        }

        private sealed class RouteDescriptor
        {
            public RouteDescriptor(
                VisualBridgeAuthoringDocumentType documentType,
                IReadOnlyList<CatalogDescriptor> catalogs,
                IReadOnlyDictionary<string, IndexedDefinition> nodeTypes,
                IReadOnlyDictionary<string, IndexedDefinition> graphTypes,
                IReadOnlyDictionary<string, IndexedDefinition> dataTypes)
            {
                DocumentType = documentType;
                Catalogs = catalogs;
                NodeTypes = nodeTypes;
                GraphTypes = graphTypes;
                DataTypes = dataTypes;
            }

            public VisualBridgeAuthoringDocumentType DocumentType { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }

            // nodeType/graphType/dataType 身份索引：跨声明 Catalog 合并，id+alias 均可解析。
            public IReadOnlyDictionary<string, IndexedDefinition> NodeTypes { get; }

            public IReadOnlyDictionary<string, IndexedDefinition> GraphTypes { get; }

            public IReadOnlyDictionary<string, IndexedDefinition> DataTypes { get; }
        }

        private sealed class CatalogDescriptor
        {
            public CatalogDescriptor(string relativePath, string fullPath, string hash, JObject root)
            {
                RelativePath = relativePath;
                FullPath = fullPath;
                Hash = hash;
                Root = root;
            }

            public string RelativePath { get; }

            public string FullPath { get; }

            public string Hash { get; }

            public JObject Root { get; }
        }

        private sealed class IndexedDefinition
        {
            public IndexedDefinition(JObject definition, string catalogId)
            {
                Definition = definition;
                CatalogId = catalogId;
                Id = definition.Value<string>("id");
            }

            public JObject Definition { get; }

            public string CatalogId { get; }

            public string Id { get; }
        }

        private sealed class RoutedDocument
        {
            public RoutedDocument(string fullPath, string relativePath, RouteDescriptor route)
            {
                FullPath = fullPath;
                RelativePath = relativePath;
                Route = route;
            }

            public string FullPath { get; }

            public string RelativePath { get; }

            public RouteDescriptor Route { get; }
        }

        private sealed class DocumentModel
        {
            public DocumentModel(
                IReadOnlyList<GraphDefinition> graphs,
                string rootGraphId,
                IReadOnlyDictionary<string, GraphDefinition> graphById,
                IReadOnlyDictionary<string, SubgraphOwner> ownerByGraphId)
            {
                Graphs = graphs;
                RootGraphId = rootGraphId;
                GraphById = graphById;
                OwnerByGraphId = ownerByGraphId;
            }

            public IReadOnlyList<GraphDefinition> Graphs { get; }

            public string RootGraphId { get; }

            public IReadOnlyDictionary<string, GraphDefinition> GraphById { get; }

            public IReadOnlyDictionary<string, SubgraphOwner> OwnerByGraphId { get; }
        }

        private sealed class SubgraphOwner
        {
            public SubgraphOwner(GraphDefinition graph, NodeDefinition node)
            {
                Graph = graph;
                Node = node;
            }

            public GraphDefinition Graph { get; }

            public NodeDefinition Node { get; }
        }

        private sealed class GraphDefinition
        {
            public GraphDefinition(
                int index,
                string id,
                string graphTypeId,
                string title,
                JObject properties,
                IReadOnlyList<InterfacePortDefinition> interfacePorts,
                IReadOnlyList<NodeDefinition> nodes,
                IReadOnlyList<EdgeDefinition> edges)
            {
                Index = index;
                Id = id;
                GraphTypeId = graphTypeId;
                Title = title;
                Properties = properties;
                InterfacePorts = interfacePorts;
                Nodes = nodes;
                Edges = edges;
            }

            public int Index { get; }

            public string Id { get; }

            public string GraphTypeId { get; }

            public string Title { get; }

            public JObject Properties { get; }

            public IReadOnlyList<InterfacePortDefinition> InterfacePorts { get; }

            public IReadOnlyList<NodeDefinition> Nodes { get; }

            public IReadOnlyList<EdgeDefinition> Edges { get; }
        }

        private sealed class InterfacePortDefinition
        {
            public InterfacePortDefinition(
                string id,
                string title,
                string kind,
                string direction,
                string dataTypeId,
                long? maxConnections,
                bool dynamic)
            {
                Id = id;
                Title = title;
                Kind = kind;
                Direction = direction;
                DataTypeId = dataTypeId;
                MaxConnections = maxConnections;
                Dynamic = dynamic;
            }

            public string Id { get; }

            public string Title { get; }

            public string Kind { get; }

            public string Direction { get; }

            public string DataTypeId { get; }

            public long? MaxConnections { get; }

            public bool Dynamic { get; }
        }

        private sealed class NodeDefinition
        {
            public NodeDefinition(
                string kind,
                string id,
                string nodeTypeId,
                string subgraphId,
                string title,
                PositionDefinition position,
                JObject properties,
                IReadOnlyList<DynamicPortDefinition> dynamicPorts)
            {
                Kind = kind;
                Id = id;
                NodeTypeId = nodeTypeId;
                SubgraphId = subgraphId;
                Title = title;
                Position = position;
                Properties = properties;
                DynamicPorts = dynamicPorts;
            }

            public string Kind { get; }

            public string Id { get; }

            public string NodeTypeId { get; }

            public string SubgraphId { get; }

            public string Title { get; }

            public PositionDefinition Position { get; }

            public JObject Properties { get; }

            public IReadOnlyList<DynamicPortDefinition> DynamicPorts { get; }
        }

        private sealed class PositionDefinition
        {
            public PositionDefinition(JToken x, JToken y)
            {
                X = x;
                Y = y;
            }

            public JToken X { get; }

            public JToken Y { get; }
        }

        private sealed class DynamicPortDefinition
        {
            public DynamicPortDefinition(string id, string groupId, string title, JToken value)
            {
                Id = id;
                GroupId = groupId;
                Title = title;
                Value = value;
            }

            public string Id { get; }

            public string GroupId { get; }

            public string Title { get; }

            public JToken Value { get; }
        }

        private sealed class EdgeDefinition
        {
            public EdgeDefinition(string id, string kind, EndpointDefinition source, EndpointDefinition target)
            {
                Id = id;
                Kind = kind;
                Source = source;
                Target = target;
            }

            public string Id { get; }

            public string Kind { get; }

            public EndpointDefinition Source { get; }

            public EndpointDefinition Target { get; }
        }

        private sealed class EndpointDefinition
        {
            public EndpointDefinition(string kind, string nodeId, string portId)
            {
                Kind = kind;
                NodeId = nodeId;
                PortId = portId;
            }

            public string Kind { get; }

            public string NodeId { get; }

            public string PortId { get; }
        }

        private sealed class ResolvedPort
        {
            public ResolvedPort(string id, string kind, string direction, string dataTypeId, long? maxConnections)
            {
                Id = id;
                Kind = kind;
                Direction = direction;
                DataTypeId = dataTypeId;
                MaxConnections = maxConnections;
            }

            public string Id { get; }

            public string Kind { get; }

            public string Direction { get; }

            public string DataTypeId { get; }

            public long? MaxConnections { get; }
        }

        private sealed class CanonicalEdge
        {
            public CanonicalEdge(EdgeDefinition edge, string sourcePortId, string targetPortId, string path)
            {
                Edge = edge;
                SourcePortId = sourcePortId;
                TargetPortId = targetPortId;
                Path = path;
            }

            public EdgeDefinition Edge { get; }

            public string SourcePortId { get; }

            public string TargetPortId { get; }

            public string Path { get; }
        }

        private sealed class CardinalityEndpoint
        {
            public CardinalityEndpoint(EndpointDefinition endpoint, int count)
            {
                Endpoint = endpoint;
                Count = count;
            }

            public EndpointDefinition Endpoint { get; }

            public int Count { get; }
        }
    }
}
