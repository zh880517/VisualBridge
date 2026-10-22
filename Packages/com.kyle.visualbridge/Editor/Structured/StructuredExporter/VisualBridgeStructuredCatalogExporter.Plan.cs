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
    public static partial class VisualBridgeStructuredCatalogExporter
    {
        private static ExportPlan BuildPlan(string projectRoot, VisualBridgeResolvedCatalogExport export)
        {
            var catalogAttribute = default(CatalogMetadata);
            var configTypes = new List<JObject>();
            var sourceTypes = new List<JObject>();
            var typeIdentities = new HashSet<string>(StringComparer.Ordinal);

            foreach (var registeredName in export.Types)
            {
                var type = Type.GetType(registeredName, false, false);
                if (type == null)
                {
                    throw Error("catalog.typeNotFound", registeredName, "Registered type could not be resolved.");
                }

                ValidateRootType(type, registeredName);
                var assemblyCatalog = ReadCatalogMetadata(type.Assembly, export.CatalogId);
                if (assemblyCatalog == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, $"Assembly does not declare catalog metadata for '{export.CatalogId}'.");
                }

                if (!string.Equals(assemblyCatalog.Title, export.Title, StringComparison.Ordinal))
                {
                    throw Error("catalog.titleMismatch", registeredName, "Profile and assembly catalog titles differ.");
                }

                catalogAttribute = catalogAttribute ?? assemblyCatalog;
                var configMetadata = ReadConfigMetadata(type);
                if (configMetadata == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, "Type does not declare VisualBridgeStructuredConfig metadata.");
                }

                if (!string.Equals(configMetadata.CatalogId, export.CatalogId, StringComparison.Ordinal))
                {
                    throw Error("catalog.catalogIdMismatch", registeredName, "Type metadata belongs to a different catalog.");
                }

                ValidateIdentifier(configMetadata.Id, registeredName + ".id");
                ValidateNonEmpty(configMetadata.Title, registeredName + ".title");
                ValidateAliases(configMetadata.Id, configMetadata.Aliases, registeredName + ".aliases");
                foreach (var identity in new[] { configMetadata.Id }.Concat(configMetadata.Aliases))
                {
                    if (!typeIdentities.Add(identity))
                    {
                        throw Error("catalog.identityConflict", registeredName, $"Config type identity '{identity}' is already used.");
                    }
                }

                var fields = BuildFields(type, new HashSet<Type>(), registeredName);
                var configType = new JObject
                {
                    ["id"] = configMetadata.Id,
                    ["title"] = configMetadata.Title,
                    ["aliases"] = new JArray(configMetadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                };
                if (configMetadata.Description != null)
                {
                    ValidateNonEmpty(configMetadata.Description, registeredName + ".description");
                    configType["description"] = configMetadata.Description;
                }

                configType["source"] = new JObject
                {
                    ["providerId"] = ProviderId,
                    ["typeName"] = registeredName,
                };
                configType["properties"] = fields;
                configTypes.Add(configType);
                sourceTypes.Add(new JObject
                {
                    ["assemblyQualifiedName"] = registeredName,
                    ["config"] = Canonicalize(configType),
                });
            }

            if (catalogAttribute == null)
            {
                throw Error("catalog.empty", export.CatalogId, "Catalog export has no registered types.");
            }

            configTypes.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            sourceTypes.Sort((left, right) =>
            {
                var idComparison = StringComparer.Ordinal.Compare(
                    left["config"]?.Value<string>("id"),
                    right["config"]?.Value<string>("id"));
                return idComparison != 0
                    ? idComparison
                    : StringComparer.Ordinal.Compare(
                        left.Value<string>("assemblyQualifiedName"),
                        right.Value<string>("assemblyQualifiedName"));
            });
            var snapshot = new JObject
            {
                ["formatVersion"] = 1,
                ["providerId"] = ProviderId,
                ["catalogId"] = export.CatalogId,
                ["title"] = export.Title,
                ["types"] = new JArray(sourceTypes),
            };
            var snapshotBytes = Utf8WithoutBom.GetBytes(WriteCompact(Canonicalize(snapshot)));
            var sourceHash = HashBytes(snapshotBytes);
            var catalog = new JObject
            {
                ["formatVersion"] = 1,
                ["catalogId"] = export.CatalogId,
                ["title"] = export.Title,
                ["source"] = new JObject
                {
                    ["status"] = "current",
                    ["providerId"] = ProviderId,
                    ["sourceHash"] = sourceHash,
                },
                ["configTypes"] = new JArray(configTypes),
            };
            VisualBridgeStructuredCatalogValidator.Validate(catalog);
            var bytes = Utf8WithoutBom.GetBytes(WriteIndented(catalog));
            return new ExportPlan(projectRoot, export.OutputPath, bytes, HashBytes(bytes), catalog);
        }
        private static void ValidateAuthoringProjectBindings(VisualBridgeResolvedProfile profile, IReadOnlyList<ExportPlan> plans)
        {
            var project = VisualBridgeAuthoringProjectParser.Parse(profile.AuthoringProjectPath);
            var pathComparer = Path.DirectorySeparatorChar == '\\' ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
            var plansByPath = plans.ToDictionary(plan => Path.GetFullPath(plan.OutputPath), pathComparer);
            var bindings = new Dictionary<ExportPlan, Dictionary<string, List<string>>>();
            var globalIdentities = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var plan in plans)
            {
                var perConfig = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                foreach (var config in ((JArray)plan.Catalog["configTypes"]).Cast<JObject>())
                {
                    var canonicalId = config.Value<string>("id");
                    perConfig.Add(canonicalId, new List<string>());
                    foreach (var identity in new[] { canonicalId }.Concat(((JArray)config["aliases"]).Values<string>()))
                    {
                        if (globalIdentities.TryGetValue(identity, out var owner))
                        {
                            throw Error(
                                "profile.catalogIdentityConflict",
                                plan.OutputPath,
                                $"Config identity '{identity}' is already exported by '{owner}'.");
                        }

                        globalIdentities.Add(identity, plan.OutputPath);
                    }
                }

                bindings.Add(plan, perConfig);
            }

            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "structured"))
            {
                foreach (var relativeCatalog in documentType.Catalogs)
                {
                    var catalogPath = VisualBridgeAuthoringProjectParser.ResolveInsideProject(
                        project,
                        relativeCatalog,
                        documentType.Id + ".catalogs");
                    if (!plansByPath.TryGetValue(catalogPath, out var plan))
                    {
                        continue;
                    }

                    var matches = ((JArray)plan.Catalog["configTypes"])
                        .Cast<JObject>()
                        .Where(config => string.Equals(config.Value<string>("id"), documentType.Id, StringComparison.Ordinal)
                            || ((JArray)config["aliases"]).Values<string>().Contains(documentType.Id, StringComparer.Ordinal))
                        .ToArray();
                    if (matches.Length == 0)
                    {
                        throw Error(
                            "profile.catalogDocumentTypeUnbound",
                            documentType.Id,
                            $"Structured Document Type does not resolve to a Config Type in Unity-owned Catalog '{relativeCatalog}'.");
                    }

                    if (matches.Length != 1)
                    {
                        throw Error(
                            "profile.catalogDocumentTypeAmbiguous",
                            documentType.Id,
                            $"Structured Document Type resolves to multiple Config Types in Unity-owned Catalog '{relativeCatalog}'.");
                    }

                    bindings[plan][matches[0].Value<string>("id")].Add(documentType.Id);
                }
            }

            foreach (var plan in plans)
            {
                var relative = MakeRelativePath(project.RootPath, plan.OutputPath);
                if (relative.StartsWith("../", StringComparison.Ordinal)
                    || !project.DocumentTypes.Any(documentType => documentType.Editor == "structured"
                        && documentType.Catalogs.Any(catalog => pathComparer.Equals(
                            VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalog, documentType.Id + ".catalogs"),
                            plan.OutputPath))))
                {
                    throw Error("profile.catalogNotDeclared", plan.OutputPath, "Export output is not declared by a Structured Document Type.");
                }

                foreach (var config in bindings[plan])
                {
                    if (config.Value.Count == 0)
                    {
                        throw Error(
                            "profile.configDocumentTypeMissing",
                            config.Key,
                            $"Exported Config Type is not covered by a Structured Document Type that declares Catalog '{relative}'.");
                    }

                    if (config.Value.Count != 1)
                    {
                        throw Error(
                            "profile.configDocumentTypeAmbiguous",
                            config.Key,
                            "Exported Config Type is covered by multiple Structured Document Types: "
                                + string.Join(", ", config.Value.OrderBy(value => value, StringComparer.Ordinal)));
                    }
                }
            }
        }
    }
}
