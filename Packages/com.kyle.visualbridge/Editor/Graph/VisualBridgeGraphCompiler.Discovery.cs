using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeGraphCompiler
    {
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

    }
}
