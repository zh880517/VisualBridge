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

    public static class VisualBridgeStructuredCompiler
    {
        private const string OutputRelativeRoot = "Library/VisualBridge/Compiled";
        private const string ArtifactKind = "visualbridge.structured.compiled";
        private const string MappingKind = "visualbridge.structured.sourceMapping";
        private const string ManifestKind = "visualbridge.structured.compileManifest";

        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false, true);
        private static readonly StringComparer FilePathComparer = Path.DirectorySeparatorChar == '\\'
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

        private static Registry BuildRegistry(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IDictionary<string, InputSnapshot> inputs)
        {
            var catalogExports = new Dictionary<string, VisualBridgeResolvedCatalogExport>(FilePathComparer);
            var configByCanonicalId = new Dictionary<string, ConfigDescriptor>(StringComparer.Ordinal);
            var configAliases = new Dictionary<string, ConfigDescriptor>(StringComparer.Ordinal);
            foreach (var export in profile.CatalogExports)
            {
                var relativeOutput = RelativePathInside(project.RootPath, export.OutputPath, "$.catalogExports.output");
                if (!catalogExports.TryAdd(export.OutputPath, export))
                {
                    throw Error("compile.duplicateCatalog", relativeOutput, "Catalog output is registered more than once.");
                }

                foreach (var registeredName in export.Types)
                {
                    var type = Type.GetType(registeredName, false, false);
                    if (type == null)
                    {
                        throw Error("compile.typeNotFound", registeredName, "Registered config type could not be resolved.");
                    }

                    var descriptor = ReadConfigDescriptor(type, registeredName, export.CatalogId);
                    if (configByCanonicalId.ContainsKey(descriptor.Id) || configAliases.ContainsKey(descriptor.Id))
                    {
                        throw Error("compile.configIdentityConflict", descriptor.Id, "Config identity is declared more than once.");
                    }

                    configByCanonicalId.Add(descriptor.Id, descriptor);
                    foreach (var alias in descriptor.Aliases)
                    {
                        if (configByCanonicalId.ContainsKey(alias) || configAliases.ContainsKey(alias))
                        {
                            throw Error("compile.configIdentityConflict", alias, "Config identity is declared more than once.");
                        }

                        configAliases.Add(alias, descriptor);
                    }
                }
            }

            var catalogByPath = new Dictionary<string, CatalogDescriptor>(FilePathComparer);
            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "structured"))
            {
                if (documentType.Catalogs.Count == 0)
                {
                    throw Error("compile.catalogMissing", documentType.Id, "Structured Document Type must declare at least one Catalog.");
                }

                foreach (var catalogRelativePath in documentType.Catalogs)
                {
                    var catalogPath = VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalogRelativePath, documentType.Id + ".catalogs");
                    if (!File.Exists(catalogPath))
                    {
                        throw Error("compile.catalogNotFound", catalogRelativePath, "Structured Catalog does not exist.");
                    }

                    if (!catalogExports.TryGetValue(catalogPath, out var export))
                    {
                        throw Error("compile.catalogUntrusted", catalogRelativePath, "Structured Catalog is not an output registered by the Unity Integration Profile.");
                    }

                    if (!catalogByPath.ContainsKey(catalogPath))
                    {
                        var bytes = ReadInputBytes(catalogPath);
                        var hash = HashBytes(bytes);
                        var catalog = VisualBridgeIntegrationProfileLoader.ReadStrictObject(catalogPath, "compile.catalogInvalidJson");
                        VisualBridgeStructuredCatalogValidator.Validate(catalog);
                        if (!string.Equals(catalog.Value<string>("catalogId"), export.CatalogId, StringComparison.Ordinal))
                        {
                            throw Error("compile.catalogIdMismatch", catalogRelativePath, "Catalog ID differs from the Unity Integration Profile.");
                        }

                        var descriptor = new CatalogDescriptor(catalogRelativePath, catalogPath, hash, catalog);
                        catalogByPath.Add(catalogPath, descriptor);
                        AddInput(inputs, catalogPath, bytes, hash);
                    }
                }
            }

            var routes = new Dictionary<string, RouteDescriptor>(StringComparer.Ordinal);
            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "structured"))
            {
                ConfigDescriptor config;
                if (!configByCanonicalId.TryGetValue(documentType.Id, out config)
                    && !configAliases.TryGetValue(documentType.Id, out config))
                {
                    throw Error("compile.configTypeUnknown", documentType.Id, "Document Type ID does not resolve to registered C# Config metadata.");
                }

                var catalogs = documentType.Catalogs
                    .Select(relative => catalogByPath[VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, relative, documentType.Id + ".catalogs")])
                    .OrderBy(value => value.RelativePath, StringComparer.Ordinal)
                    .ToArray();
                var definitions = catalogs
                    .SelectMany(catalog => ((JArray)catalog.Root["configTypes"]).Cast<JObject>().Select(value => new { Catalog = catalog, Definition = value }))
                    .Where(value => string.Equals(value.Definition.Value<string>("id"), documentType.Id, StringComparison.Ordinal)
                        || ((JArray)value.Definition["aliases"]).Values<string>().Contains(documentType.Id, StringComparer.Ordinal))
                    .ToArray();
                if (definitions.Length == 0)
                {
                    throw Error("compile.configTypeUnknown", documentType.Id, "Document Type ID is not declared by its Structured Catalogs.");
                }

                if (definitions.Length != 1)
                {
                    throw Error("compile.configTypeAmbiguous", documentType.Id, "Document Type ID is declared by multiple Structured Catalogs.");
                }

                var source = definitions[0].Definition["source"] as JObject;
                if (source == null
                    || !string.Equals(source.Value<string>("providerId"), VisualBridgeStructuredCatalogExporter.ProviderId, StringComparison.Ordinal)
                    || !string.Equals(source.Value<string>("typeName"), config.RegisteredName, StringComparison.Ordinal)
                    || !string.Equals(config.CatalogId, definitions[0].Catalog.Root.Value<string>("catalogId"), StringComparison.Ordinal))
                {
                    throw Error("compile.catalogMetadataMismatch", documentType.Id, "Catalog source does not match the registered C# Config metadata.");
                }

                config.Fields = BuildFieldDescriptors(config.Type, (JArray)definitions[0].Definition["properties"], new HashSet<Type>(), config.RegisteredName);
                routes.Add(documentType.Id, new RouteDescriptor(documentType, config, catalogs));
            }

            foreach (var config in configByCanonicalId.Values)
            {
                var matchingRoutes = routes.Values
                    .Where(route => ReferenceEquals(route.Config, config)
                        && route.Catalogs.Any(catalog => string.Equals(catalog.Root.Value<string>("catalogId"), config.CatalogId, StringComparison.Ordinal)))
                    .ToArray();
                if (matchingRoutes.Length == 0)
                {
                    throw Error("compile.configRouteMissing", config.Id, "Exported Config metadata is not covered by a Structured Document Type.");
                }

                if (matchingRoutes.Length != 1)
                {
                    throw Error(
                        "compile.configRouteAmbiguous",
                        config.Id,
                        "Exported Config metadata is covered by multiple Structured Document Types: "
                            + string.Join(", ", matchingRoutes.Select(route => route.DocumentType.Id).OrderBy(value => value, StringComparer.Ordinal)));
                }
            }

            return new Registry(routes, catalogByPath.Values.OrderBy(value => value.RelativePath, StringComparer.Ordinal).ToArray());
        }

        private static IReadOnlyList<RoutedDocument> DiscoverDocuments(
            VisualBridgeAuthoringProject project,
            IReadOnlyDictionary<string, RouteDescriptor> routes)
        {
            var discovered = new HashSet<string>(FilePathComparer);
            foreach (var relativeRoot in project.DocumentRoots.OrderBy(value => value, StringComparer.Ordinal))
            {
                var fullRoot = relativeRoot == "."
                    ? project.RootPath
                    : VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, relativeRoot, "$.documentRoots");
                if (!Directory.Exists(fullRoot))
                {
                    throw Error("compile.documentRootNotFound", relativeRoot, "Document root does not exist.");
                }

                EnumerateFilesStrict(project.RootPath, fullRoot, discovered);
            }

            var result = new List<RoutedDocument>();
            foreach (var fullPath in discovered.OrderBy(value => value, FilePathComparer))
            {
                var relativePath = RelativePathInside(project.RootPath, fullPath, "document");
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

                if (matches[0].Editor != "structured")
                {
                    continue;
                }

                if (!routes.TryGetValue(matches[0].Id, out var route))
                {
                    throw Error("compile.configTypeUnknown", matches[0].Id, "Structured route has no registered Config metadata.");
                }

                result.Add(new RoutedDocument(fullPath, relativePath, route));
            }

            return result;
        }

        private static IEnumerable<OutputPlan> BuildDocumentOutputs(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            Registry registry,
            RoutedDocument routed,
            byte[] documentBytes,
            string documentHash,
            IReadOnlyDictionary<string, InputSnapshot> inputs)
        {
            var root = VisualBridgeIntegrationProfileLoader.ReadStrictObject(routed.FullPath, "compile.documentInvalidJson");
            RequireDocumentKeys(root, routed.RelativePath);
            if (root["formatVersion"].Type != JTokenType.Integer || root["formatVersion"].Value<long>() != 1)
            {
                throw Error("compile.documentUnsupportedVersion", routed.RelativePath + ".formatVersion", "Expected integer formatVersion 1.");
            }

            var documentId = RequireIdentifier(root["documentId"], routed.RelativePath + ".documentId");
            if (!(root["properties"] is JObject properties))
            {
                throw Error("compile.documentInvalidProperties", routed.RelativePath + ".properties", "Expected an object.");
            }

            var mappings = new List<JObject>();
            var materialized = MaterializeObject(
                routed.Route.Config.Type,
                routed.Route.Config.Fields,
                properties,
                "properties",
                "data",
                mappings,
                false);
            GC.KeepAlive(materialized.Value);

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
                ["configTypeId"] = routed.Route.Config.Id,
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
                ["data"] = materialized.Json,
            };
            var artifactBytes = Serialize(artifact);
            var artifactHash = HashBytes(artifactBytes);

            var mappingRelativePath = "mappings/" + project.ProjectId + "/" + routed.Route.DocumentType.Id + "/" + documentId + ".vbsource.json";
            var mapping = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = MappingKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = routed.Route.DocumentType.Id,
                ["documentId"] = documentId,
                ["configTypeId"] = routed.Route.Config.Id,
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
            var mappingBytes = Serialize(mapping);
            return new[]
            {
                CreateOutput(profile.CompileOutputRoot, artifactRelativePath, artifactBytes, "artifact"),
                CreateOutput(profile.CompileOutputRoot, mappingRelativePath, mappingBytes, "sourceMapping"),
            };
        }

        private static MaterializedValue MaterializeObject(
            Type type,
            IReadOnlyList<FieldDescriptor> fields,
            JObject value,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
#pragma warning disable SYSLIB0050
            var instance = FormatterServices.GetUninitializedObject(type);
#pragma warning restore SYSLIB0050
            var json = new JObject();
            var canonical = new Dictionary<string, FieldDescriptor>(fields.ToDictionary(field => field.Id, StringComparer.Ordinal), StringComparer.Ordinal);
            var aliases = new Dictionary<string, FieldDescriptor>(StringComparer.Ordinal);
            foreach (var field in fields)
            {
                foreach (var alias in field.Aliases)
                {
                    aliases.Add(alias, field);
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

            foreach (var field in fields.OrderBy(field => field.Id, StringComparer.Ordinal))
            {
                var matches = new List<JProperty>();
                var canonicalProperty = value.Property(field.Id, StringComparison.Ordinal);
                if (canonicalProperty != null) matches.Add(canonicalProperty);
                matches.AddRange(field.Aliases
                    .Select(alias => value.Property(alias, StringComparison.Ordinal))
                    .Where(property => property != null));
                if (matches.Count > 1)
                {
                    throw Error(
                        "compile.fieldIdentityConflict",
                        sourcePath + "." + field.Id,
                        "Canonical field ID and aliases must not be present together.");
                }

                var property = matches.SingleOrDefault();
                var usesDefault = inheritedDefault || property == null;
                var token = property == null ? field.DefaultValue.DeepClone() : property.Value;
                var fieldSourcePath = sourcePath + "." + (property == null ? field.Id : property.Name);
                var fieldArtifactPath = artifactPath + "." + field.Id;
                var materialized = MaterializeValue(
                    field.Field.FieldType,
                    field,
                    token,
                    fieldSourcePath,
                    fieldArtifactPath,
                    mappings,
                    usesDefault);
                try
                {
                    field.Field.SetValue(instance, materialized.Value);
                }
                catch (Exception exception)
                {
                    throw Error("compile.fieldAssignmentFailed", fieldSourcePath, exception.Message);
                }

                json[field.Id] = materialized.Json;
                mappings.Add(new JObject
                {
                    ["sourcePath"] = fieldSourcePath,
                    ["artifactPath"] = fieldArtifactPath,
                    ["origin"] = usesDefault ? "metadataDefault" : "document",
                });
            }

            return new MaterializedValue(instance, json);
        }

        private static MaterializedValue MaterializeValue(
            Type type,
            FieldDescriptor descriptor,
            JToken token,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
            if (type == typeof(string))
            {
                RequireTokenType(token, JTokenType.String, sourcePath, "string");
                return new MaterializedValue(token.Value<string>(), new JValue(token.Value<string>()));
            }

            if (type == typeof(bool))
            {
                RequireTokenType(token, JTokenType.Boolean, sourcePath, "boolean");
                return new MaterializedValue(token.Value<bool>(), new JValue(token.Value<bool>()));
            }

            if (IsSupportedNumber(type))
            {
                return MaterializeNumber(type, token, sourcePath);
            }

            if (type.IsEnum)
            {
                RequireTokenType(token, JTokenType.String, sourcePath, "enum name string");
                var name = token.Value<string>();
                if (!Enum.GetNames(type).Contains(name, StringComparer.Ordinal))
                {
                    throw Error("compile.enumValueInvalid", sourcePath, $"'{name}' is not a declared member of enum '{type.FullName}'.");
                }

                return new MaterializedValue(Enum.Parse(type, name, false), new JValue(name));
            }

            if (TryGetListItem(type, out var itemType))
            {
                if (!(token is JArray array))
                {
                    throw Error("compile.typeMismatch", sourcePath, "Expected an array.");
                }

                var itemValues = new object[array.Count];
                var jsonItems = new JArray();
                for (var index = 0; index < array.Count; index++)
                {
                    var item = MaterializeValue(
                        itemType,
                        descriptor.Item,
                        array[index],
                        sourcePath + "[" + index + "]",
                        artifactPath + "[" + index + "]",
                        mappings,
                        inheritedDefault);
                    itemValues[index] = item.Value;
                    jsonItems.Add(item.Json);
                }

                object listValue;
                if (type.IsArray)
                {
                    var result = Array.CreateInstance(itemType, itemValues.Length);
                    for (var index = 0; index < itemValues.Length; index++)
                    {
                        result.SetValue(itemValues[index], index);
                    }

                    listValue = result;
                }
                else
                {
                    var result = (IList)Activator.CreateInstance(type);
                    foreach (var itemValue in itemValues)
                    {
                        result.Add(itemValue);
                    }

                    listValue = result;
                }

                return new MaterializedValue(listValue, jsonItems);
            }

            if (!(token is JObject objectValue))
            {
                throw Error("compile.typeMismatch", sourcePath, "Expected an object.");
            }

            return MaterializeObject(type, descriptor.Fields, objectValue, sourcePath, artifactPath, mappings, inheritedDefault);
        }

        private static MaterializedValue MaterializeNumber(Type type, JToken token, string path)
        {
            if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
            {
                throw Error("compile.typeMismatch", path, "Expected a JSON number.");
            }

            if (IsIntegral(type) && token.Type != JTokenType.Integer)
            {
                throw Error("compile.typeMismatch", path, $"Expected an integral JSON number for '{type.FullName}'.");
            }

            try
            {
                var value = token.Value<decimal>();
                object converted;
                if (type == typeof(byte)) converted = checked((byte)value);
                else if (type == typeof(sbyte)) converted = checked((sbyte)value);
                else if (type == typeof(short)) converted = checked((short)value);
                else if (type == typeof(ushort)) converted = checked((ushort)value);
                else if (type == typeof(int)) converted = checked((int)value);
                else if (type == typeof(uint)) converted = checked((uint)value);
                else if (type == typeof(float))
                {
                    var number = (float)value;
                    if (float.IsNaN(number) || float.IsInfinity(number)) throw new OverflowException();
                    converted = number;
                }
                else if (type == typeof(double))
                {
                    var number = (double)value;
                    if (double.IsNaN(number) || double.IsInfinity(number)) throw new OverflowException();
                    converted = number;
                }
                else throw new InvalidOperationException("Unsupported numeric type.");

                return new MaterializedValue(converted, token.DeepClone());
            }
            catch (Exception exception) when (exception is OverflowException || exception is FormatException || exception is InvalidCastException)
            {
                throw Error("compile.numberOutOfRange", path, $"Number is outside the range of '{type.FullName}'.");
            }
        }

        private static IReadOnlyList<FieldDescriptor> BuildFieldDescriptors(
            Type type,
            JArray definitions,
            HashSet<Type> stack,
            string path)
        {
            if (!stack.Add(type))
            {
                throw Error("compile.typeCycle", path, "Recursive config objects are unsupported.");
            }

            try
            {
                var fields = new List<FieldDescriptor>();
                foreach (var field in type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    var metadata = ReadFieldMetadata(field);
                    if (metadata == null)
                    {
                        continue;
                    }

                    if (field.IsInitOnly || field.IsLiteral)
                    {
                        throw Error("compile.fieldReadOnly", path + "." + field.Name, "Annotated config fields must be writable.");
                    }

                    var matches = definitions.Cast<JObject>()
                        .Where(definition => string.Equals(definition.Value<string>("id"), metadata.Id, StringComparison.Ordinal))
                        .ToArray();
                    if (matches.Length != 1)
                    {
                        throw Error("compile.catalogMetadataMismatch", path + "." + field.Name, "Catalog field does not match C# metadata.");
                    }

                    var descriptor = new FieldDescriptor(field, metadata.Id, metadata.Aliases, matches[0]["defaultValue"].DeepClone());
                    BuildValueDescriptor(descriptor, field.FieldType, matches[0], stack, path + "." + field.Name);
                    fields.Add(descriptor);
                }

                var catalogIds = new HashSet<string>(definitions.Cast<JObject>().Select(value => value.Value<string>("id")), StringComparer.Ordinal);
                var fieldIds = new HashSet<string>(fields.Select(value => value.Id), StringComparer.Ordinal);
                if (!catalogIds.SetEquals(fieldIds))
                {
                    throw Error("compile.catalogMetadataMismatch", path, "Catalog fields differ from registered C# metadata.");
                }

                return fields.OrderBy(value => value.Id, StringComparer.Ordinal).ToArray();
            }
            finally
            {
                stack.Remove(type);
            }
        }

        private static void BuildValueDescriptor(FieldDescriptor descriptor, Type type, JObject definition, HashSet<Type> stack, string path)
        {
            var expectedValueType = definition.Value<string>("valueType");
            if (type == typeof(string)) RequireValueType(expectedValueType, "string", path);
            else if (type == typeof(bool)) RequireValueType(expectedValueType, "boolean", path);
            else if (IsSupportedNumber(type)) RequireValueType(expectedValueType, "number", path);
            else if (type.IsEnum) RequireValueType(expectedValueType, "string", path);
            else if (TryGetListItem(type, out var itemType))
            {
                RequireValueType(expectedValueType, "array", path);
                if (!(definition["item"] is JObject itemDefinition))
                {
                    throw Error("compile.catalogMetadataMismatch", path, "Array Catalog definition is missing item metadata.");
                }

                descriptor.Item = FieldDescriptor.ForValue(itemDefinition["defaultValue"].DeepClone());
                BuildValueDescriptor(descriptor.Item, itemType, itemDefinition, stack, path + "[]");
            }
            else
            {
                RequireValueType(expectedValueType, "object", path);
                if (!(definition["fields"] is JArray fields))
                {
                    throw Error("compile.catalogMetadataMismatch", path, "Object Catalog definition is missing fields.");
                }

                descriptor.Fields = BuildFieldDescriptors(type, fields, stack, path);
            }
        }

        private static ConfigDescriptor ReadConfigDescriptor(Type type, string registeredName, string expectedCatalogId)
        {
            var attributes = type.CustomAttributes
                .Where(attribute => attribute.AttributeType == typeof(VisualBridgeStructuredConfigAttribute))
                .ToArray();
            if (attributes.Length != 1)
            {
                throw Error("compile.configMetadataMissing", registeredName, "Config type must declare exactly one VisualBridgeStructuredConfig attribute.");
            }

            var attribute = attributes[0];
            var catalogId = ReadConstructorString(attribute, 0, registeredName);
            var id = ReadConstructorString(attribute, 1, registeredName);
            var aliases = Array.Empty<string>();
            foreach (var argument in attribute.NamedArguments)
            {
                if (argument.MemberName == nameof(VisualBridgeStructuredConfigAttribute.Aliases))
                {
                    aliases = ReadStringArray(argument.TypedValue, registeredName);
                }
            }

            if (!string.Equals(catalogId, expectedCatalogId, StringComparison.Ordinal))
            {
                throw Error("compile.catalogMetadataMismatch", registeredName, "Config metadata belongs to a different Catalog.");
            }

            RequireIdentifier(new JValue(id), registeredName + ".id");
            foreach (var alias in aliases)
            {
                RequireIdentifier(new JValue(alias), registeredName + ".aliases");
            }

            return new ConfigDescriptor(type, registeredName, catalogId, id, aliases);
        }

        private static FieldMetadata ReadFieldMetadata(FieldInfo field)
        {
            var attributes = field.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeFieldAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("compile.fieldMetadataDuplicate", field.Name, "Field declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var aliases = Array.Empty<string>();
            foreach (var argument in attribute.NamedArguments)
            {
                if (argument.MemberName == nameof(VisualBridgeFieldAttribute.Aliases))
                {
                    aliases = ReadStringArray(argument.TypedValue, field.Name);
                }
            }

            return new FieldMetadata(
                ReadConstructorString(attribute, 0, field.Name),
                aliases);
        }

        private static string ReadConstructorString(CustomAttributeData attribute, int index, string path)
        {
            if (attribute.ConstructorArguments.Count <= index || !(attribute.ConstructorArguments[index].Value is string value))
            {
                throw Error("compile.invalidMetadata", path, "Expected a string constructor argument.");
            }

            return value;
        }

        private static string[] ReadStringArray(CustomAttributeTypedArgument argument, string path)
        {
            if (argument.Value == null)
            {
                return Array.Empty<string>();
            }

            if (!(argument.Value is IList values))
            {
                throw Error("compile.invalidMetadata", path, "Expected a string array.");
            }

            var result = new string[values.Count];
            for (var index = 0; index < values.Count; index++)
            {
                var item = (CustomAttributeTypedArgument)values[index];
                if (!(item.Value is string value))
                {
                    throw Error("compile.invalidMetadata", path, "Expected a string array.");
                }

                result[index] = value;
            }

            return result;
        }

        private static OutputPlan BuildManifest(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IReadOnlyList<OutputPlan> outputs,
            IReadOnlyDictionary<string, InputSnapshot> inputs)
        {
            var manifest = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ManifestKind,
                ["projectId"] = project.ProjectId,
                ["inputs"] = new JArray(inputs.Values
                    .Select(input => new JObject
                    {
                        ["path"] = InputDisplayPath(profile, project, input.Path),
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
            return CreateOutput(profile.CompileOutputRoot, "manifest.json", Serialize(manifest), "manifest");
        }

        private static string InputDisplayPath(VisualBridgeResolvedProfile profile, VisualBridgeAuthoringProject project, string path)
        {
            if (IsInside(profile.ProjectRoot, path))
            {
                return RelativePathInside(profile.ProjectRoot, path, "input");
            }

            if (IsInside(project.RootPath, path))
            {
                return RelativePathInside(project.RootPath, path, "input");
            }

            throw Error("compile.inputOutsideProject", path, "Compiler input is outside the Unity Project.");
        }

        private static IReadOnlyList<string> ReadPreviousManagedPaths(string outputRoot)
        {
            var manifestPath = Path.Combine(outputRoot, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                return Array.Empty<string>();
            }

            RejectOutputAlias(manifestPath);
            var manifest = VisualBridgeIntegrationProfileLoader.ReadStrictObject(manifestPath, "compile.manifestInvalidJson");
            RequireKeys(manifest, "manifest", new[] { "formatVersion", "kind", "projectId", "inputs", "outputs" });
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

                RequireKeys(output, $"manifest.outputs[{index}]", new[] { "kind", "path", "sha256" });
                var path = output["path"].Type == JTokenType.String ? output.Value<string>("path") : null;
                ValidateOutputRelativePath(path, $"manifest.outputs[{index}].path");
                RequireHash(output["sha256"], $"manifest.outputs[{index}].sha256");
                if (!unique.Add(path))
                {
                    throw Error("compile.manifestInvalid", $"manifest.outputs[{index}].path", "Duplicate managed output path.");
                }

                result.Add(path);
            }

            return result;
        }

        private static void CommitTransaction(
            string outputRoot,
            IReadOnlyList<OutputPlan> plans,
            IReadOnlyList<VisualBridgeStructuredCompileOutput> outputs,
            IReadOnlyList<string> stalePaths,
            IEnumerable<InputSnapshot> inputs)
        {
            var changes = plans.Zip(outputs, (plan, output) => new TransactionFile(plan.FullPath, plan.Bytes, output.PreviousSha256, output.Changed))
                .Where(value => value.Changed)
                .ToList();
            changes.AddRange(stalePaths.Select(path => new TransactionFile(path, null, HashFile(path), true)));
            changes = changes.OrderBy(value => value.Path.EndsWith("manifest.json", StringComparison.Ordinal) ? 1 : 0)
                .ThenBy(value => value.Path, FilePathComparer)
                .ToList();
            for (var index = 0; index < changes.Count; index++)
            {
                changes[index].TransactionIndex = index;
                var state = InspectOutputFile(changes[index].Path);
                if (!string.Equals(state.Hash, changes[index].BaselineHash, StringComparison.Ordinal))
                {
                    throw Error("compile.outputChangedBeforeReplace", changes[index].Path, "Output changed after planning and before transaction staging.");
                }

                changes[index].BaselineExists = state.Exists;
                changes[index].BaselineIdentity = state.Identity;
            }

            var transactionId = Guid.NewGuid().ToString("N");
            try
            {
                RejectOutputAlias(outputRoot);
                foreach (var change in changes.Where(value => value.Bytes != null))
                {
                    RejectOutputAlias(change.Path);
                    var directory = Path.GetDirectoryName(change.Path);
                    Directory.CreateDirectory(directory);
                    RejectOutputAlias(change.Path);
                    change.TemporaryPath = Path.Combine(directory, $".visualbridge.{transactionId}.{change.TransactionIndex}.tmp");
                    RejectOutputAlias(change.TemporaryPath);
                    using (var stream = new FileStream(change.TemporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        stream.Write(change.Bytes, 0, change.Bytes.Length);
                        stream.Flush(true);
                    }
                }

                VerifyInputs(inputs);
                VerifyTransactionTargets(outputRoot, changes);

                foreach (var change in changes)
                {
                    VerifyTransactionTarget(outputRoot, change);
                    var directory = Path.GetDirectoryName(change.Path);
                    change.BackupPath = Path.Combine(directory, $".visualbridge.{transactionId}.{change.TransactionIndex}.bak");
                    RejectOutputAlias(change.BackupPath);
                    if (change.Bytes == null)
                    {
                        File.Move(change.Path, change.BackupPath);
                        change.Applied = true;
                    }
                    else if (File.Exists(change.Path))
                    {
                        File.Replace(change.TemporaryPath, change.Path, change.BackupPath);
                        change.Applied = true;
                    }
                    else
                    {
                        File.Move(change.TemporaryPath, change.Path);
                        change.Applied = true;
                        change.Created = true;
                    }
                }
            }
            catch
            {
                RollBack(outputRoot, changes);
                throw;
            }
            finally
            {
                foreach (var change in changes)
                {
                    TryDelete(change.TemporaryPath);
                }
            }

            foreach (var change in changes)
            {
                TryDelete(change.BackupPath);
            }
        }

        private static void VerifyTransactionTargets(string outputRoot, IEnumerable<TransactionFile> changes)
        {
            RejectOutputAlias(outputRoot);
            foreach (var change in changes)
            {
                VerifyTransactionTarget(outputRoot, change);
            }
        }

        private static void VerifyTransactionTarget(string outputRoot, TransactionFile change)
        {
            RejectOutputAlias(outputRoot);
            var state = InspectOutputFile(change.Path);
            if (state.Exists != change.BaselineExists
                || !string.Equals(state.Identity, change.BaselineIdentity, StringComparison.Ordinal)
                || !string.Equals(state.Hash, change.BaselineHash, StringComparison.Ordinal))
            {
                throw Error("compile.outputChangedBeforeReplace", change.Path, "Output identity or content changed before atomic replacement.");
            }
        }

        private static void RollBack(string outputRoot, IEnumerable<TransactionFile> changes)
        {
            foreach (var change in changes.Where(value => value.Applied).Reverse())
            {
                try
                {
                    RejectOutputAlias(outputRoot);
                    RejectOutputAlias(change.Path);
                    RejectOutputAlias(change.BackupPath);
                    if (change.Created)
                    {
                        if (File.Exists(change.Path)) File.Delete(change.Path);
                    }
                    else if (File.Exists(change.BackupPath))
                    {
                        if (File.Exists(change.Path)) File.Delete(change.Path);
                        File.Move(change.BackupPath, change.Path);
                    }
                }
                catch
                {
                    // Preserve the original exception. Any surviving backup remains beside its target for manual recovery.
                }
            }
        }

        private static void VerifyInputs(IEnumerable<InputSnapshot> inputs)
        {
            foreach (var input in inputs)
            {
                if (!File.Exists(input.Path) || !string.Equals(HashFile(input.Path), input.Hash, StringComparison.Ordinal))
                {
                    throw Error("compile.inputChanged", input.Path, "Compiler input changed while the compile plan was being built.");
                }
            }
        }

        private static void EnumerateFilesStrict(string projectRoot, string directory, ISet<string> files)
        {
            var pending = new Stack<string>();
            pending.Push(directory);
            while (pending.Count != 0)
            {
                var current = pending.Pop();
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                {
                    throw Error("compile.pathAliasForbidden", RelativePathInside(projectRoot, current, "documentRoot"), "Symlink or junction directories are forbidden.");
                }

                foreach (var entry in Directory.GetFileSystemEntries(current).OrderBy(value => value, FilePathComparer))
                {
                    var attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        throw Error("compile.pathAliasForbidden", RelativePathInside(projectRoot, entry, "document"), "Symlink or junction entries are forbidden.");
                    }

                    if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
                    else files.Add(Path.GetFullPath(entry));
                }
            }
        }

        private static void RequireFrozenOutputRoot(VisualBridgeResolvedProfile profile)
        {
            var expected = Path.GetFullPath(Path.Combine(profile.ProjectRoot, OutputRelativeRoot.Replace('/', Path.DirectorySeparatorChar)));
            if (!FilePathComparer.Equals(expected, profile.CompileOutputRoot))
            {
                throw Error("compile.outputRootMismatch", "$.compileOutputRoot", $"V1 compileOutputRoot must be exactly '{OutputRelativeRoot}'.");
            }
        }

        private static OutputPlan CreateOutput(string outputRoot, string relativePath, byte[] bytes, string kind)
        {
            var fullPath = ResolveOutputPath(outputRoot, relativePath);
            return new OutputPlan(relativePath, fullPath, bytes, HashBytes(bytes), kind);
        }

        private static string ResolveOutputPath(string outputRoot, string relativePath)
        {
            ValidateOutputRelativePath(relativePath, "output");
            var root = Path.GetFullPath(outputRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var path = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!IsInside(root, path))
            {
                throw Error("compile.outputOutsideRoot", relativePath, "Output path leaves compileOutputRoot.");
            }

            return path;
        }

        private static void ValidateOutputRelativePath(string path, string jsonPath)
        {
            if (string.IsNullOrEmpty(path)
                || path.StartsWith("/", StringComparison.Ordinal)
                || path.Contains("\\")
                || path.Contains(":")
                || path.Contains("//")
                || path.Split('/').Any(segment => segment.Length == 0 || segment == "." || segment == ".."))
            {
                throw Error("compile.outputPathInvalid", jsonPath, "Expected a normalized output-relative path.");
            }
        }

        private static void RejectDuplicateOutputPaths(IEnumerable<OutputPlan> plans)
        {
            var unique = new HashSet<string>(StringComparer.Ordinal);
            foreach (var plan in plans)
            {
                if (!unique.Add(plan.RelativePath))
                {
                    throw Error("compile.outputCollision", plan.RelativePath, "Multiple documents resolve to the same compiled output path.");
                }
            }
        }

        private static void RejectOutputAlias(string path)
        {
            var fullPath = Path.GetFullPath(path);
            var current = Path.GetPathRoot(fullPath);
            foreach (var segment in fullPath.Substring(current.Length).Split(Path.DirectorySeparatorChar))
            {
                current = Path.Combine(current, segment);
                if (!File.Exists(current) && !Directory.Exists(current)) return;
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                {
                    throw Error("compile.outputAliasForbidden", path, "compileOutputRoot must not contain symlink or junction segments.");
                }
            }

            if (File.Exists(fullPath))
            {
                GetWindowsFileIdentity(fullPath, true);
            }
        }

        private static OutputFileState InspectOutputFile(string path)
        {
            RejectOutputAlias(path);
            if (!File.Exists(path))
            {
                return new OutputFileState(false, null, null);
            }

            var identityBefore = GetWindowsFileIdentity(path, true);
            var hash = HashFile(path);
            var identityAfter = GetWindowsFileIdentity(path, true);
            if (!string.Equals(identityBefore, identityAfter, StringComparison.Ordinal))
            {
                throw Error("compile.outputChangedBeforeReplace", path, "Output identity changed while it was inspected.");
            }

            return new OutputFileState(true, identityAfter, hash);
        }

        private static string GetWindowsFileIdentity(string path, bool rejectHardLinks)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                return null;
            }

            var handle = CreateFile(
                path,
                0,
                FileShareRead | FileShareWrite | FileShareDelete,
                IntPtr.Zero,
                OpenExisting,
                0,
                IntPtr.Zero);
            if (handle == InvalidHandleValue)
            {
                throw Error("compile.outputIdentityUnavailable", path, $"Cannot inspect output file identity (Win32 {Marshal.GetLastWin32Error()}).");
            }

            try
            {
                if (!GetFileInformationByHandle(handle, out var information))
                {
                    throw Error("compile.outputIdentityUnavailable", path, $"Cannot inspect output file identity (Win32 {Marshal.GetLastWin32Error()}).");
                }

                if (rejectHardLinks && information.NumberOfLinks > 1)
                {
                    throw Error("compile.outputHardLinkForbidden", path, "Existing managed outputs must not have hard-link aliases.");
                }

                return information.VolumeSerialNumber.ToString("x8", CultureInfo.InvariantCulture)
                    + ":"
                    + information.FileIndexHigh.ToString("x8", CultureInfo.InvariantCulture)
                    + information.FileIndexLow.ToString("x8", CultureInfo.InvariantCulture);
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint FileShareDelete = 0x00000004;
        private const uint OpenExisting = 3;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public uint CreationTimeLow;
            public uint CreationTimeHigh;
            public uint LastAccessTimeLow;
            public uint LastAccessTimeHigh;
            public uint LastWriteTimeLow;
            public uint LastWriteTimeHigh;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
        private static extern IntPtr CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(IntPtr file, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static void RequireDocumentKeys(JObject value, string path)
        {
            RequireKeys(value, path, new[] { "formatVersion", "documentId", "properties" });
        }

        private static void RequireKeys(JObject value, string path, IEnumerable<string> required)
        {
            var allowed = new HashSet<string>(required, StringComparer.Ordinal);
            foreach (var property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw Error("compile.unknownProperty", path + "." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var property in allowed)
            {
                if (value.Property(property, StringComparison.Ordinal) == null)
                {
                    throw Error("compile.missingProperty", path + "." + property, $"Missing property '{property}'.");
                }
            }
        }

        private static string RequireIdentifier(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("compile.invalidIdentifier", path, "Expected a stable identifier.");
            }

            var value = token.Value<string>();
            if (value.Length == 0
                || value.Length > 128
                || !IsAsciiAlphaNumeric(value[0])
                || value.Any(character => !IsAsciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-'))
            {
                throw Error("compile.invalidIdentifier", path, "Expected a stable identifier.");
            }

            return value;
        }

        private static void RequireHash(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("compile.invalidHash", path, "Expected a lowercase SHA-256 hash.");
            }

            var value = token.Value<string>();
            if (value.Length != 64 || value.Any(character => !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))))
            {
                throw Error("compile.invalidHash", path, "Expected a lowercase SHA-256 hash.");
            }
        }

        private static void RequireTokenType(JToken token, JTokenType type, string path, string expected)
        {
            if (token == null || token.Type != type)
            {
                throw Error("compile.typeMismatch", path, "Expected " + expected + ".");
            }
        }

        private static void RequireValueType(string actual, string expected, string path)
        {
            if (!string.Equals(actual, expected, StringComparison.Ordinal))
            {
                throw Error("compile.catalogMetadataMismatch", path, $"Expected Catalog valueType '{expected}', found '{actual}'.");
            }
        }

        private static bool TryGetListItem(Type type, out Type itemType)
        {
            if (type.IsArray && type.GetArrayRank() == 1)
            {
                itemType = type.GetElementType();
                return true;
            }

            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>))
            {
                itemType = type.GetGenericArguments()[0];
                return true;
            }

            itemType = null;
            return false;
        }

        private static bool IsSupportedNumber(Type type)
        {
            return type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(int)
                || type == typeof(uint)
                || type == typeof(float)
                || type == typeof(double);
        }

        private static bool IsIntegral(Type type)
        {
            return type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(int)
                || type == typeof(uint);
        }

        private static byte[] Serialize(JToken token)
        {
            var builder = new StringBuilder();
            using (var writer = new StringWriter(builder, CultureInfo.InvariantCulture))
            using (var json = new JsonTextWriter(writer))
            {
                json.Formatting = Formatting.Indented;
                json.Indentation = 2;
                json.IndentChar = ' ';
                json.StringEscapeHandling = StringEscapeHandling.EscapeNonAscii;
                json.Culture = CultureInfo.InvariantCulture;
                token.WriteTo(json);
                json.Flush();
            }

            return Utf8WithoutBom.GetBytes(builder.ToString().Replace("\r\n", "\n") + "\n");
        }

        private static byte[] ReadInputBytes(string path)
        {
            try
            {
                return File.ReadAllBytes(path);
            }
            catch (Exception exception)
            {
                throw Error("compile.inputReadFailed", path, exception.Message);
            }
        }

        private static void AddInput(IDictionary<string, InputSnapshot> inputs, string path)
        {
            var bytes = ReadInputBytes(path);
            AddInput(inputs, path, bytes, HashBytes(bytes));
        }

        private static void AddInput(IDictionary<string, InputSnapshot> inputs, string path, byte[] bytes, string hash)
        {
            var fullPath = Path.GetFullPath(path);
            if (inputs.TryGetValue(fullPath, out var existing) && !string.Equals(existing.Hash, hash, StringComparison.Ordinal))
            {
                throw Error("compile.inputChanged", fullPath, "Input changed while it was being read.");
            }

            inputs[fullPath] = new InputSnapshot(fullPath, bytes, hash);
        }

        private static string HashFile(string path)
        {
            return File.Exists(path) ? HashBytes(File.ReadAllBytes(path)) : null;
        }

        private static string HashBytes(byte[] bytes)
        {
            using (var sha256 = SHA256.Create())
            {
                return string.Concat(sha256.ComputeHash(bytes).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        private static string RelativePathInside(string root, string path, string jsonPath)
        {
            var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var fullPath = Path.GetFullPath(path);
            if (!IsInside(fullRoot, fullPath))
            {
                throw Error("compile.pathOutsideProject", jsonPath, "Path leaves the expected project root.");
            }

            var rootUri = new Uri(fullRoot + Path.DirectorySeparatorChar);
            return Uri.UnescapeDataString(rootUri.MakeRelativeUri(new Uri(fullPath)).ToString()).Replace('\\', '/');
        }

        private static bool IsInside(string root, string candidate)
        {
            var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var fullCandidate = Path.GetFullPath(candidate);
            return string.Equals(fullRoot, fullCandidate, comparison)
                || fullCandidate.StartsWith(fullRoot + Path.DirectorySeparatorChar, comparison);
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        private static void TryDelete(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // A stale transaction helper is safer than changing the reported compile result after commit.
            }
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

        private sealed class Registry
        {
            public Registry(IReadOnlyDictionary<string, RouteDescriptor> routes, IReadOnlyList<CatalogDescriptor> catalogs)
            {
                Routes = routes;
                Catalogs = catalogs;
            }

            public IReadOnlyDictionary<string, RouteDescriptor> Routes { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }
        }

        private sealed class RouteDescriptor
        {
            public RouteDescriptor(
                VisualBridgeAuthoringDocumentType documentType,
                ConfigDescriptor config,
                IReadOnlyList<CatalogDescriptor> catalogs)
            {
                DocumentType = documentType;
                Config = config;
                Catalogs = catalogs;
            }

            public VisualBridgeAuthoringDocumentType DocumentType { get; }

            public ConfigDescriptor Config { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }
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

        private sealed class ConfigDescriptor
        {
            public ConfigDescriptor(Type type, string registeredName, string catalogId, string id, IReadOnlyList<string> aliases)
            {
                Type = type;
                RegisteredName = registeredName;
                CatalogId = catalogId;
                Id = id;
                Aliases = aliases;
            }

            public Type Type { get; }
            public string RegisteredName { get; }
            public string CatalogId { get; }
            public string Id { get; }
            public IReadOnlyList<string> Aliases { get; }
            public IReadOnlyList<FieldDescriptor> Fields { get; set; }
        }

        private sealed class FieldDescriptor
        {
            public FieldDescriptor(FieldInfo field, string id, IReadOnlyList<string> aliases, JToken defaultValue)
            {
                Field = field;
                Id = id;
                Aliases = aliases;
                DefaultValue = defaultValue;
                Fields = Array.Empty<FieldDescriptor>();
            }

            private FieldDescriptor(JToken defaultValue)
            {
                Aliases = Array.Empty<string>();
                DefaultValue = defaultValue;
                Fields = Array.Empty<FieldDescriptor>();
            }

            public FieldInfo Field { get; }
            public string Id { get; }
            public IReadOnlyList<string> Aliases { get; }
            public JToken DefaultValue { get; }
            public IReadOnlyList<FieldDescriptor> Fields { get; set; }
            public FieldDescriptor Item { get; set; }

            public static FieldDescriptor ForValue(JToken defaultValue)
            {
                return new FieldDescriptor(defaultValue);
            }
        }

        private sealed class FieldMetadata
        {
            public FieldMetadata(string id, IReadOnlyList<string> aliases)
            {
                Id = id;
                Aliases = aliases;
            }

            public string Id { get; }
            public IReadOnlyList<string> Aliases { get; }
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

        private sealed class MaterializedValue
        {
            public MaterializedValue(object value, JToken json)
            {
                Value = value;
                Json = json;
            }

            public object Value { get; }
            public JToken Json { get; }
        }

        private sealed class InputSnapshot
        {
            public InputSnapshot(string path, byte[] bytes, string hash)
            {
                Path = path;
                Bytes = bytes;
                Hash = hash;
            }

            public string Path { get; }
            public byte[] Bytes { get; }
            public string Hash { get; }
        }

        private sealed class OutputPlan
        {
            public OutputPlan(string relativePath, string fullPath, byte[] bytes, string hash, string kind)
            {
                RelativePath = relativePath;
                FullPath = fullPath;
                Bytes = bytes;
                Hash = hash;
                Kind = kind;
            }

            public string RelativePath { get; }
            public string FullPath { get; }
            public byte[] Bytes { get; }
            public string Hash { get; }
            public string Kind { get; }
        }

        private sealed class OutputFileState
        {
            public OutputFileState(bool exists, string identity, string hash)
            {
                Exists = exists;
                Identity = identity;
                Hash = hash;
            }

            public bool Exists { get; }
            public string Identity { get; }
            public string Hash { get; }
        }

        private sealed class TransactionFile
        {
            public TransactionFile(string path, byte[] bytes, string baselineHash, bool changed)
            {
                Path = path;
                Bytes = bytes;
                BaselineHash = baselineHash;
                Changed = changed;
            }

            public string Path { get; }
            public byte[] Bytes { get; }
            public string BaselineHash { get; }
            public bool Changed { get; }
            public bool BaselineExists { get; set; }
            public string BaselineIdentity { get; set; }
            public string TemporaryPath { get; set; }
            public string BackupPath { get; set; }
            public bool Applied { get; set; }
            public bool Created { get; set; }
            public int TransactionIndex { get; set; }
        }
    }
}
