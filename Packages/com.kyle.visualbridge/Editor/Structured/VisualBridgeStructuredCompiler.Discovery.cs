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
    public static partial class VisualBridgeStructuredCompiler
    {
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
                if (!export.OutputPath.EndsWith(".vbstructuredcatalog", StringComparison.Ordinal))
                {
                    continue;
                }

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

    }
}
