using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using VisualBridge.Runtime;

namespace VisualBridge.Editor
{
    public enum VisualBridgeEntityCompileMode
    {
        Generate,
        Check,
    }

    public sealed class VisualBridgeEntityCompileOutput
    {
        internal VisualBridgeEntityCompileOutput(string path, string expectedSha256, string previousSha256, bool changed)
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

    public sealed class VisualBridgeEntityCompileResult
    {
        internal VisualBridgeEntityCompileResult(
            VisualBridgeEntityCompileMode mode,
            IReadOnlyList<VisualBridgeEntityCompileOutput> outputs,
            IReadOnlyList<string> staleOutputs)
        {
            Mode = mode;
            Outputs = outputs;
            StaleOutputs = staleOutputs;
        }

        public VisualBridgeEntityCompileMode Mode { get; }

        public IReadOnlyList<VisualBridgeEntityCompileOutput> Outputs { get; }

        public IReadOnlyList<string> StaleOutputs { get; }

        public bool DriftDetected => Outputs.Any(output => output.Changed) || StaleOutputs.Count != 0;
    }

    /// <summary>
    /// Entity Compiler：把 `.vbentity` 文档按 Document Type 路由编译成确定性产物、source mapping 与独立
    /// manifest（manifest.entity.json，与 Structured Compiler 共用输出根但互不接管对方产物）。文档校验只依赖
    /// Entity Catalog 的字段定义（JSON 级），不实例化业务类型；序列化、Hash 与原子提交复用 Structured Compiler。
    /// </summary>
    public static class VisualBridgeEntityCompiler
    {
        private const string ArtifactKind = "visualbridge.entity.compiled";
        private const string MappingKind = "visualbridge.entity.sourceMapping";
        private const string ManifestKind = "visualbridge.entity.compileManifest";
        // 独立于 Structured 的 manifest.json，两个编译器不得互相覆盖托管清单。
        private const string ManifestFileName = "manifest.entity.json";

        public static VisualBridgeEntityCompileResult Compile(string unityProjectRoot, VisualBridgeEntityCompileMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            VisualBridgeStructuredCompiler.RequireFrozenOutputRoot(profile);
            VisualBridgeStructuredCompiler.RejectOutputAlias(profile.CompileOutputRoot);

            var catalogCheck = VisualBridgeEntityCatalogExporter.Export(profile.ProjectRoot, VisualBridgeCatalogExportMode.Check);
            if (catalogCheck.DriftDetected)
            {
                var paths = string.Join(", ", catalogCheck.Outputs.Where(output => output.Changed).Select(output => output.Path));
                throw Error("compile.catalogDrift", "$.catalogExports", "Generated Entity Catalogs are stale: " + paths);
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
                return new VisualBridgeEntityCompileOutput(
                    plan.FullPath,
                    plan.Hash,
                    previousHash,
                    previousBytes == null || !previousBytes.SequenceEqual(plan.Bytes));
            }).ToArray();

            VisualBridgeStructuredCompiler.VerifyInputs(inputSnapshots.Values);
            if (mode == VisualBridgeEntityCompileMode.Generate && (outputs.Any(output => output.Changed) || stalePaths.Length != 0))
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

            return new VisualBridgeEntityCompileResult(mode, outputs, stalePaths);
        }

        private static Registry BuildRegistry(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            // 只遍历 .vbentitycatalog 导出单元；注册类型必须带 entity metadata 且 catalogId 与导出一致。
            var catalogExports = new Dictionary<string, VisualBridgeResolvedCatalogExport>(VisualBridgeStructuredCompiler.FilePathComparer);
            foreach (var export in profile.CatalogExports)
            {
                if (!export.OutputPath.EndsWith(".vbentitycatalog", StringComparison.Ordinal))
                {
                    continue;
                }

                var relativeOutput = VisualBridgeStructuredCompiler.RelativePathInside(project.RootPath, export.OutputPath, "$.catalogExports.output");
                if (!catalogExports.TryAdd(export.OutputPath, export))
                {
                    throw Error("compile.duplicateCatalog", relativeOutput, "Catalog output is registered more than once.");
                }

                foreach (var registeredName in export.Types)
                {
                    var type = Type.GetType(registeredName, false, false);
                    if (type == null)
                    {
                        throw Error("compile.typeNotFound", registeredName, "Registered entity type could not be resolved.");
                    }

                    ValidateRegisteredMetadata(type, registeredName, export.CatalogId);
                }
            }

            var catalogByPath = new Dictionary<string, CatalogDescriptor>(VisualBridgeStructuredCompiler.FilePathComparer);
            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "entity"))
            {
                foreach (var catalogRelativePath in documentType.Catalogs)
                {
                    var catalogPath = VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalogRelativePath, documentType.Id + ".catalogs");
                    if (!File.Exists(catalogPath))
                    {
                        throw Error("compile.catalogNotFound", catalogRelativePath, "Entity Catalog does not exist.");
                    }

                    if (!catalogExports.TryGetValue(catalogPath, out var export))
                    {
                        throw Error("compile.catalogUntrusted", catalogRelativePath, "Entity Catalog is not an output registered by the Unity Integration Profile.");
                    }

                    if (!catalogByPath.ContainsKey(catalogPath))
                    {
                        var bytes = VisualBridgeStructuredCompiler.ReadInputBytes(catalogPath);
                        var hash = VisualBridgeStructuredCompiler.HashBytes(bytes);
                        var catalog = VisualBridgeIntegrationProfileLoader.ReadStrictObject(catalogPath, "compile.catalogInvalidJson");
                        VisualBridgeEntityCatalogValidator.Validate(catalog);
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
            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "entity"))
            {
                var catalogs = documentType.Catalogs
                    .Select(relative => catalogByPath[VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, relative, documentType.Id + ".catalogs")])
                    .OrderBy(value => value.RelativePath, StringComparer.Ordinal)
                    .ToArray();
                var entityType = ResolveEntityType(catalogs, documentType.Id);
                // 身份索引跨该 Document Type 声明的全部 Catalog 合并，冲突在注册期即失败。
                var componentTypes = BuildIdentityIndex(catalogs, "componentTypes");
                var componentGroups = BuildIdentityIndex(catalogs, "componentGroups");
                routes.Add(documentType.Id, new RouteDescriptor(
                    documentType,
                    entityType,
                    catalogs,
                    componentTypes,
                    componentGroups,
                    ResolveAllowedGroupIds(entityType, componentGroups)));
            }

            return new Registry(routes);
        }

        private static void ValidateRegisteredMetadata(Type type, string registeredName, string expectedCatalogId)
        {
            var entityTypeAttributes = type.CustomAttributes
                .Where(attribute => attribute.AttributeType == typeof(VisualBridgeEntityTypeAttribute))
                .ToArray();
            var componentAttributes = type.CustomAttributes
                .Where(attribute => attribute.AttributeType == typeof(VisualBridgeEntityComponentAttribute))
                .ToArray();
            if (entityTypeAttributes.Length == 0 && componentAttributes.Length == 0)
            {
                throw Error("compile.entityTypeMetadataMissing", registeredName, "Type does not declare VisualBridgeEntityType or VisualBridgeEntityComponent metadata.");
            }

            if (entityTypeAttributes.Length != 0 && componentAttributes.Length != 0
                || entityTypeAttributes.Length > 1
                || componentAttributes.Length > 1)
            {
                throw Error("compile.duplicateMetadata", registeredName, "Type must declare exactly one VisualBridge entity metadata attribute.");
            }

            var attribute = entityTypeAttributes.Length != 0 ? entityTypeAttributes[0] : componentAttributes[0];
            var catalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, registeredName);
            if (!string.Equals(catalogId, expectedCatalogId, StringComparison.Ordinal))
            {
                throw Error("compile.catalogMetadataMismatch", registeredName, "Entity metadata belongs to a different Catalog.");
            }
        }

        private static Dictionary<string, JObject> BuildIdentityIndex(IReadOnlyList<CatalogDescriptor> catalogs, string arrayName)
        {
            var index = new Dictionary<string, JObject>(StringComparer.Ordinal);
            foreach (var catalog in catalogs)
            {
                foreach (var definition in ((JArray)catalog.Root[arrayName]).Cast<JObject>())
                {
                    foreach (var identity in Identities(definition))
                    {
                        if (!index.TryAdd(identity, definition))
                        {
                            throw Error("compile.componentIdentityConflict", identity, $"Entity Catalog '{arrayName}' identity '{identity}' is declared more than once.");
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

        private static bool MatchesIdentity(JObject definition, string identity)
        {
            if (string.Equals(definition.Value<string>("id"), identity, StringComparison.Ordinal))
            {
                return true;
            }

            return definition["aliases"] is JArray aliases && aliases.Values<string>().Contains(identity, StringComparer.Ordinal);
        }

        private static JObject ResolveEntityType(IReadOnlyList<CatalogDescriptor> catalogs, string identity)
        {
            var matches = catalogs
                .SelectMany(catalog => ((JArray)catalog.Root["entityTypes"]).Cast<JObject>())
                .Where(definition => MatchesIdentity(definition, identity))
                .ToArray();
            if (matches.Length == 0)
            {
                throw Error("compile.entityTypeUnknown", identity, "Identity does not resolve to an Entity Type declared by the Document Type Catalogs.");
            }

            if (matches.Length != 1)
            {
                throw Error("compile.entityTypeAmbiguous", identity, "Identity resolves to multiple Entity Types declared by the Document Type Catalogs.");
            }

            return matches[0];
        }

        private static JObject ResolveComponentType(RouteDescriptor route, string componentTypeId, string path)
        {
            var matches = route.Catalogs
                .SelectMany(catalog => ((JArray)catalog.Root["componentTypes"]).Cast<JObject>())
                .Where(definition => MatchesIdentity(definition, componentTypeId))
                .ToArray();
            if (matches.Length == 0)
            {
                throw Error("compile.componentTypeUnknown", path, $"Unknown Component Type '{componentTypeId}'.");
            }

            if (matches.Length != 1)
            {
                throw Error("compile.componentTypeAmbiguous", path, $"Component Type '{componentTypeId}' resolves to multiple definitions.");
            }

            var componentType = matches[0];
            if (!route.AllowedGroupIds.Contains(componentType.Value<string>("groupId")))
            {
                throw Error("compile.componentGroupNotAllowed", path, $"Component Type group '{componentType.Value<string>("groupId")}' is not allowed by Entity Type '{route.EntityType.Value<string>("id")}'.");
            }

            return componentType;
        }

        private static IReadOnlyCollection<string> ResolveAllowedGroupIds(
            JObject entityType,
            IReadOnlyDictionary<string, JObject> componentGroups)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            foreach (var identity in ((JArray)entityType["allowedComponentGroupIds"]).Values<string>())
            {
                // 白名单允许写组 alias；统一物化为规范组 ID 后再比较。
                result.Add(componentGroups.TryGetValue(identity, out var group) ? group.Value<string>("id") : identity);
            }

            return result;
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

                if (matches[0].Editor != "entity")
                {
                    continue;
                }

                if (!routes.TryGetValue(matches[0].Id, out var route))
                {
                    throw Error("compile.entityTypeUnknown", matches[0].Id, "Entity route has no registered Entity Type metadata.");
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
            var root = VisualBridgeIntegrationProfileLoader.ReadStrictObject(routed.FullPath, "compile.documentInvalidJson");
            VisualBridgeStructuredCompiler.RequireKeys(
                root,
                routed.RelativePath,
                new[] { "formatVersion", "documentId", "entityTypeId", "title", "properties", "components" });
            if (root["formatVersion"].Type != JTokenType.Integer || root["formatVersion"].Value<long>() != 1)
            {
                throw Error("compile.documentUnsupportedVersion", routed.RelativePath + ".formatVersion", "Expected integer formatVersion 1.");
            }

            var documentId = VisualBridgeStructuredCompiler.RequireIdentifier(root["documentId"], routed.RelativePath + ".documentId");
            RequireNonEmptyString(root["title"], routed.RelativePath + ".title");

            if (root["entityTypeId"].Type != JTokenType.String)
            {
                throw Error("compile.entityTypeUnknown", routed.RelativePath + ".entityTypeId", "Expected an Entity Type identifier.");
            }

            var entityType = ResolveEntityType(routed.Route.Catalogs, root["entityTypeId"].Value<string>());
            if (!string.Equals(entityType.Value<string>("id"), routed.Route.EntityType.Value<string>("id"), StringComparison.Ordinal))
            {
                throw Error("compile.entityTypeMismatch", routed.RelativePath + ".entityTypeId", "Document Entity Type differs from the Document Type route.");
            }

            if (!(root["properties"] is JObject properties))
            {
                throw Error("compile.typeMismatch", routed.RelativePath + ".properties", "Expected an object.");
            }

            if (!(root["components"] is JArray components))
            {
                throw Error("compile.typeMismatch", routed.RelativePath + ".components", "Expected an array.");
            }

            var mappings = new List<JObject>();
            var dataProperties = MaterializeObject(
                (JArray)entityType["properties"],
                properties,
                "properties",
                "data.properties",
                mappings,
                false);
            var dataComponents = BuildComponents(routed.Route, components, routed.RelativePath, mappings);

            var catalogInputs = new JArray(routed.Route.Catalogs.Select(catalog => new JObject
            {
                ["catalogId"] = catalog.Root.Value<string>("catalogId"),
                ["path"] = catalog.RelativePath,
                ["sha256"] = catalog.Hash,
            }));
            var artifactRelativePath = "documents/" + project.ProjectId + "/" + routed.Route.DocumentType.Id + "/" + documentId + ".vbcompiled.json";
            var artifact = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ArtifactKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = routed.Route.DocumentType.Id,
                ["documentId"] = documentId,
                ["entityTypeId"] = routed.Route.EntityType.Value<string>("id"),
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
                    ["properties"] = dataProperties,
                    ["components"] = dataComponents,
                },
            };
            var artifactBytes = VisualBridgeStructuredCompiler.Serialize(artifact);
            var artifactHash = VisualBridgeStructuredCompiler.HashBytes(artifactBytes);

            var mappingRelativePath = "mappings/" + project.ProjectId + "/" + routed.Route.DocumentType.Id + "/" + documentId + ".vbsource.json";
            var mapping = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = MappingKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = routed.Route.DocumentType.Id,
                ["documentId"] = documentId,
                ["entityTypeId"] = routed.Route.EntityType.Value<string>("id"),
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

        private static JArray BuildComponents(
            RouteDescriptor route,
            JArray components,
            string relativePath,
            ICollection<JObject> mappings)
        {
            var dataComponents = new JArray();
            var componentIds = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < components.Count; index++)
            {
                var componentPath = relativePath + ".components[" + index + "]";
                if (!(components[index] is JObject component))
                {
                    throw Error("compile.typeMismatch", componentPath, "Expected an object.");
                }

                VisualBridgeStructuredCompiler.RequireKeys(component, componentPath, new[] { "id", "componentTypeId", "enabled", "properties" });
                var componentId = VisualBridgeStructuredCompiler.RequireIdentifier(component["id"], componentPath + ".id");
                if (!componentIds.Add(componentId))
                {
                    throw Error("compile.componentIdentityConflict", componentPath + ".id", $"Component id '{componentId}' is already used in this document.");
                }

                if (component["componentTypeId"].Type != JTokenType.String)
                {
                    throw Error("compile.componentTypeUnknown", componentPath + ".componentTypeId", "Expected a Component Type identifier.");
                }

                var componentType = ResolveComponentType(route, component["componentTypeId"].Value<string>(), componentPath + ".componentTypeId");
                if (component["enabled"].Type != JTokenType.Boolean)
                {
                    throw Error("compile.typeMismatch", componentPath + ".enabled", "Expected a boolean.");
                }

                if (!(component["properties"] is JObject componentProperties))
                {
                    throw Error("compile.typeMismatch", componentPath + ".properties", "Expected an object.");
                }

                var materializedProperties = MaterializeObject(
                    (JArray)componentType["properties"],
                    componentProperties,
                    componentPath + ".properties",
                    "data.components[" + index + "].properties",
                    mappings,
                    false);
                dataComponents.Add(new JObject
                {
                    ["id"] = componentId,
                    ["componentTypeId"] = componentType.Value<string>("id"),
                    ["enabled"] = component["enabled"].Value<bool>(),
                    ["properties"] = materializedProperties,
                });
            }

            return dataComponents;
        }

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

                throw Error("compile.unknownField", sourcePath + "." + property.Name, $"Unknown field '{property.Name}'.");
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
                // 缺失字段用 Catalog defaultValue 物化，origin 记为 metadataDefault。
                var token = property == null ? definition["defaultValue"].DeepClone() : property.Value;
                var fieldSourcePath = sourcePath + "." + (property == null ? fieldId : property.Name);
                var fieldArtifactPath = artifactPath + "." + fieldId;
                json[fieldId] = MaterializeValue(definition, token, fieldSourcePath, fieldArtifactPath, mappings, usesDefault);
                mappings.Add(new JObject
                {
                    ["sourcePath"] = fieldSourcePath,
                    ["artifactPath"] = fieldArtifactPath,
                    ["origin"] = usesDefault ? "metadataDefault" : "document",
                });
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

        private static void RequireNonEmptyString(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String || string.IsNullOrWhiteSpace(token.Value<string>()))
            {
                throw Error("compile.invalidString", path, "Expected a non-empty string.");
            }
        }

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
                    throw Error("compile.manifestInvalid", $"manifest.outputs[{index}]", "Expected an object.");
                }

                VisualBridgeStructuredCompiler.RequireKeys(output, $"manifest.outputs[{index}]", new[] { "kind", "path", "sha256" });
                var path = output["path"].Type == JTokenType.String ? output.Value<string>("path") : null;
                VisualBridgeStructuredCompiler.ValidateOutputRelativePath(path, $"manifest.outputs[{index}].path");
                VisualBridgeStructuredCompiler.RequireHash(output["sha256"], $"manifest.outputs[{index}].sha256");
                if (!unique.Add(path))
                {
                    throw Error("compile.manifestInvalid", $"manifest.outputs[{index}].path", "Duplicate managed output path.");
                }

                result.Add(path);
            }

            return result;
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
                JObject entityType,
                IReadOnlyList<CatalogDescriptor> catalogs,
                IReadOnlyDictionary<string, JObject> componentTypes,
                IReadOnlyDictionary<string, JObject> componentGroups,
                IReadOnlyCollection<string> allowedGroupIds)
            {
                DocumentType = documentType;
                EntityType = entityType;
                Catalogs = catalogs;
                ComponentTypes = componentTypes;
                ComponentGroups = componentGroups;
                AllowedGroupIds = allowedGroupIds;
            }

            public VisualBridgeAuthoringDocumentType DocumentType { get; }

            public JObject EntityType { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }

            // componentType 身份索引：跨声明 Catalog 合并，仅用于注册期冲突检测。
            public IReadOnlyDictionary<string, JObject> ComponentTypes { get; }

            // group 身份索引：用于把白名单 alias 物化为规范组 ID。
            public IReadOnlyDictionary<string, JObject> ComponentGroups { get; }

            public IReadOnlyCollection<string> AllowedGroupIds { get; }
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
    }
}
