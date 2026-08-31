using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using VisualBridge.Runtime;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Entity Catalog Exporter：按 Profile 中 `.vbentitycatalog` 输出路由，从显式 metadata 的普通
    /// C# 类型确定性导出 Component Group、Entity Type 与 Component Type。字段模型、序列化与
    /// 原子写复用 Structured Exporter 的共享实现；C# 全名只作 source 追踪信息。
    /// </summary>
    public static class VisualBridgeEntityCatalogExporter
    {
        public const string ProviderId = VisualBridgeStructuredCatalogExporter.ProviderId;

        public static VisualBridgeCatalogExportResult Export(string unityProjectRoot, VisualBridgeCatalogExportMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            var plans = profile.CatalogExports
                .Where(export => export.OutputPath.EndsWith(".vbentitycatalog", StringComparison.Ordinal))
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
                    existingBytes == null ? null : VisualBridgeStructuredCatalogExporter.HashBytes(existingBytes),
                    existingBytes == null || !existingBytes.SequenceEqual(plan.Bytes)));
            }

            if (mode == VisualBridgeCatalogExportMode.Generate)
            {
                for (var index = 0; index < plans.Length; index++)
                {
                    if (outputs[index].Changed)
                    {
                        VisualBridgeStructuredCatalogExporter.WriteAtomically(plans[index], outputs[index].PreviousSha256);
                    }
                }
            }

            return new VisualBridgeCatalogExportResult(mode, outputs);
        }

        private static VisualBridgeStructuredCatalogExporter.ExportPlan BuildPlan(string projectRoot, VisualBridgeResolvedCatalogExport export)
        {
            var catalogTitle = default(string);
            var groupAssemblies = new HashSet<Assembly>();
            var groupIdentifiers = new HashSet<string>(StringComparer.Ordinal);
            var componentGroups = new List<JObject>();
            var entityTypeIdentifiers = new HashSet<string>(StringComparer.Ordinal);
            var componentTypeIdentifiers = new HashSet<string>(StringComparer.Ordinal);
            var entityTypes = new List<JObject>();
            var componentTypes = new List<JObject>();
            var sourceEntityTypes = new List<JObject>();
            var sourceComponentTypes = new List<JObject>();

            // 第一遍先解析全部类型并收集所有程序集声明的 Component Group，
            // 使 entityType/componentType 的组引用不依赖注册顺序。
            var resolved = new List<KeyValuePair<string, Type>>();
            foreach (var registeredName in export.Types)
            {
                var type = Type.GetType(registeredName, false, false);
                if (type == null)
                {
                    throw Error("catalog.typeNotFound", registeredName, "Registered type could not be resolved.");
                }

                VisualBridgeStructuredCatalogExporter.ValidateRootType(type, registeredName);
                var assemblyTitle = ReadEntityCatalogTitle(type.Assembly, export.CatalogId);
                if (assemblyTitle == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, $"Assembly does not declare entity catalog metadata for '{export.CatalogId}'.");
                }

                if (!string.Equals(assemblyTitle, export.Title, StringComparison.Ordinal))
                {
                    throw Error("catalog.titleMismatch", registeredName, "Profile and assembly entity catalog titles differ.");
                }

                catalogTitle = catalogTitle ?? assemblyTitle;
                ReadComponentGroups(type.Assembly, export.CatalogId, groupAssemblies, groupIdentifiers, componentGroups);
                resolved.Add(new KeyValuePair<string, Type>(registeredName, type));
            }

            if (catalogTitle == null)
            {
                throw Error("catalog.empty", export.CatalogId, "Catalog export has no registered types.");
            }

            foreach (var entry in resolved)
            {
                var registeredName = entry.Key;
                var type = entry.Value;
                var entityTypeMetadata = ReadEntityTypeMetadata(type);
                var componentMetadata = ReadComponentMetadata(type);
                if (entityTypeMetadata == null && componentMetadata == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, "Type does not declare VisualBridgeEntityType or VisualBridgeEntityComponent metadata.");
                }

                if (entityTypeMetadata != null && componentMetadata != null)
                {
                    throw Error("catalog.duplicateMetadata", registeredName, "Type declares both entity type and component metadata.");
                }

                var metadataCatalogId = entityTypeMetadata != null ? entityTypeMetadata.CatalogId : componentMetadata.CatalogId;
                if (!string.Equals(metadataCatalogId, export.CatalogId, StringComparison.Ordinal))
                {
                    throw Error("catalog.catalogIdMismatch", registeredName, "Type metadata belongs to a different catalog.");
                }

                var properties = VisualBridgeStructuredCatalogExporter.BuildFields(type, new HashSet<Type>(), registeredName);
                if (entityTypeMetadata != null)
                {
                    var entityType = BuildEntityType(entityTypeMetadata, properties, groupIdentifiers, registeredName, entityTypeIdentifiers);
                    entityTypes.Add(entityType);
                    sourceEntityTypes.Add(new JObject
                    {
                        ["assemblyQualifiedName"] = registeredName,
                        ["entityType"] = VisualBridgeStructuredCatalogExporter.Canonicalize(entityType),
                    });
                }
                else
                {
                    var componentType = BuildComponentType(componentMetadata, properties, groupIdentifiers, registeredName, componentTypeIdentifiers);
                    componentTypes.Add(componentType);
                    sourceComponentTypes.Add(new JObject
                    {
                        ["assemblyQualifiedName"] = registeredName,
                        ["componentType"] = VisualBridgeStructuredCatalogExporter.Canonicalize(componentType),
                    });
                }
            }

            componentGroups.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            entityTypes.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            componentTypes.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            SortSourceEntries(sourceEntityTypes, "entityType");
            SortSourceEntries(sourceComponentTypes, "componentType");
            var snapshot = new JObject
            {
                ["formatVersion"] = 1,
                ["providerId"] = ProviderId,
                ["catalogId"] = export.CatalogId,
                ["title"] = export.Title,
                ["componentGroups"] = new JArray(componentGroups.Select(VisualBridgeStructuredCatalogExporter.Canonicalize)),
                ["entityTypes"] = new JArray(sourceEntityTypes),
                ["componentTypes"] = new JArray(sourceComponentTypes),
            };
            var snapshotBytes = VisualBridgeStructuredCatalogExporter.Utf8WithoutBom.GetBytes(
                VisualBridgeStructuredCatalogExporter.WriteCompact(VisualBridgeStructuredCatalogExporter.Canonicalize(snapshot)));
            var sourceHash = VisualBridgeStructuredCatalogExporter.HashBytes(snapshotBytes);
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
                ["componentGroups"] = new JArray(componentGroups),
                ["entityTypes"] = new JArray(entityTypes),
                ["componentTypes"] = new JArray(componentTypes),
            };
            VisualBridgeEntityCatalogValidator.Validate(catalog);
            var bytes = VisualBridgeStructuredCatalogExporter.Utf8WithoutBom.GetBytes(VisualBridgeStructuredCatalogExporter.WriteIndented(catalog));
            return new VisualBridgeStructuredCatalogExporter.ExportPlan(projectRoot, export.OutputPath, bytes, VisualBridgeStructuredCatalogExporter.HashBytes(bytes), catalog);
        }

        private static JObject BuildEntityType(
            EntityTypeMetadata metadata,
            JArray properties,
            HashSet<string> groupIdentifiers,
            string registeredName,
            HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.Id, registeredName + ".id");
            VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Title, registeredName + ".title");
            VisualBridgeStructuredCatalogExporter.ValidateAliases(metadata.Id, metadata.Aliases, registeredName + ".aliases");
            foreach (var identity in new[] { metadata.Id }.Concat(metadata.Aliases))
            {
                if (!identities.Add(identity))
                {
                    throw Error("catalog.identityConflict", registeredName, $"Entity type identity '{identity}' is already used.");
                }
            }

            foreach (var groupId in metadata.AllowedComponentGroupIds)
            {
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(groupId, registeredName + ".allowedComponentGroupIds");
                if (!groupIdentifiers.Contains(groupId))
                {
                    throw Error("catalog.invalidReference", registeredName + ".allowedComponentGroupIds", $"Unknown component group '{groupId}'.");
                }
            }

            var entityType = new JObject
            {
                ["id"] = metadata.Id,
                ["title"] = metadata.Title,
                ["aliases"] = new JArray(metadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                ["allowedComponentGroupIds"] = new JArray(metadata.AllowedComponentGroupIds.OrderBy(value => value, StringComparer.Ordinal)),
            };
            if (metadata.Description != null)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Description, registeredName + ".description");
                entityType["description"] = metadata.Description;
            }

            entityType["properties"] = properties;
            return entityType;
        }

        private static JObject BuildComponentType(
            ComponentMetadata metadata,
            JArray properties,
            HashSet<string> groupIdentifiers,
            string registeredName,
            HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.Id, registeredName + ".id");
            VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Title, registeredName + ".title");
            VisualBridgeStructuredCatalogExporter.ValidateAliases(metadata.Id, metadata.Aliases, registeredName + ".aliases");
            foreach (var identity in new[] { metadata.Id }.Concat(metadata.Aliases))
            {
                if (!identities.Add(identity))
                {
                    throw Error("catalog.identityConflict", registeredName, $"Component type identity '{identity}' is already used.");
                }
            }

            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.GroupId, registeredName + ".groupId");
            if (!groupIdentifiers.Contains(metadata.GroupId))
            {
                throw Error("catalog.invalidReference", registeredName + ".groupId", $"Unknown component group '{metadata.GroupId}'.");
            }

            foreach (var segment in metadata.MenuPath)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(segment, registeredName + ".menuPath");
            }

            var componentType = new JObject
            {
                ["id"] = metadata.Id,
                ["title"] = metadata.Title,
                ["aliases"] = new JArray(metadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                ["groupId"] = metadata.GroupId,
                ["menuPath"] = new JArray(metadata.MenuPath),
            };
            if (metadata.Description != null)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Description, registeredName + ".description");
                componentType["description"] = metadata.Description;
            }

            componentType["source"] = new JObject
            {
                ["providerId"] = ProviderId,
                ["typeName"] = registeredName,
            };
            componentType["properties"] = properties;
            return componentType;
        }

        private static void ReadComponentGroups(
            Assembly assembly,
            string catalogId,
            HashSet<Assembly> groupAssemblies,
            HashSet<string> groupIdentifiers,
            List<JObject> componentGroups)
        {
            if (!groupAssemblies.Add(assembly))
            {
                return;
            }

            var groups = new List<GroupMetadata>();
            foreach (var attribute in assembly.CustomAttributes.Where(value => value.AttributeType == typeof(VisualBridgeEntityComponentGroupAttribute)))
            {
                var attributeCatalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, assembly.FullName);
                if (attributeCatalogId != catalogId)
                {
                    continue;
                }

                var group = new GroupMetadata
                {
                    CatalogId = attributeCatalogId,
                    Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, assembly.FullName),
                    Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 2, assembly.FullName),
                };
                foreach (var argument in attribute.NamedArguments)
                {
                    switch (argument.MemberName)
                    {
                        case nameof(VisualBridgeEntityComponentGroupAttribute.Aliases):
                            group.Aliases = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, assembly.FullName);
                            break;
                        default:
                            throw Error("catalog.unknownMetadata", assembly.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                    }
                }

                groups.Add(group);
            }

            foreach (var group in groups)
            {
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(group.Id, assembly.FullName + ".componentGroup.id");
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(group.Title, assembly.FullName + ".componentGroup.title");
                VisualBridgeStructuredCatalogExporter.ValidateAliases(group.Id, group.Aliases, assembly.FullName + ".componentGroup.aliases");
                foreach (var identity in new[] { group.Id }.Concat(group.Aliases))
                {
                    if (!groupIdentifiers.Add(identity))
                    {
                        throw Error("catalog.identityConflict", assembly.FullName, $"Component group identity '{identity}' is already used.");
                    }
                }

                componentGroups.Add(new JObject
                {
                    ["id"] = group.Id,
                    ["title"] = group.Title,
                    ["aliases"] = new JArray(group.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                });
            }
        }

        private static string ReadEntityCatalogTitle(Assembly assembly, string catalogId)
        {
            var matches = new List<string>();
            foreach (var attribute in assembly.CustomAttributes.Where(value => value.AttributeType == typeof(VisualBridgeEntityCatalogAttribute)))
            {
                var attributeCatalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, assembly.FullName);
                if (attributeCatalogId == catalogId)
                {
                    matches.Add(VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, assembly.FullName));
                }
            }

            if (matches.Count > 1)
            {
                throw Error("catalog.duplicateMetadata", assembly.FullName, $"Assembly declares entity catalog '{catalogId}' more than once.");
            }

            return matches.SingleOrDefault();
        }

        private static EntityTypeMetadata ReadEntityTypeMetadata(Type type)
        {
            var attributes = type.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeEntityTypeAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", type.FullName, "Type declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new EntityTypeMetadata
            {
                CatalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, type.FullName),
                Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, type.FullName),
                Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 2, type.FullName),
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgeEntityTypeAttribute.Aliases): result.Aliases = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeEntityTypeAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeEntityTypeAttribute.AllowedComponentGroupIds): result.AllowedComponentGroupIds = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    default: throw Error("catalog.unknownMetadata", type.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static ComponentMetadata ReadComponentMetadata(Type type)
        {
            var attributes = type.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeEntityComponentAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", type.FullName, "Type declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new ComponentMetadata
            {
                CatalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, type.FullName),
                Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, type.FullName),
                Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 2, type.FullName),
                GroupId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 3, type.FullName),
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgeEntityComponentAttribute.Aliases): result.Aliases = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeEntityComponentAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeEntityComponentAttribute.MenuPath): result.MenuPath = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    default: throw Error("catalog.unknownMetadata", type.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static void SortSourceEntries(List<JObject> entries, string propertyName)
        {
            entries.Sort((left, right) =>
            {
                var idComparison = StringComparer.Ordinal.Compare(
                    left[propertyName]?.Value<string>("id"),
                    right[propertyName]?.Value<string>("id"));
                return idComparison != 0
                    ? idComparison
                    : StringComparer.Ordinal.Compare(
                        left.Value<string>("assemblyQualifiedName"),
                        right.Value<string>("assemblyQualifiedName"));
            });
        }

        private static void ValidateAuthoringProjectBindings(VisualBridgeResolvedProfile profile, IReadOnlyList<VisualBridgeStructuredCatalogExporter.ExportPlan> plans)
        {
            if (plans.Count == 0)
            {
                return;
            }

            var project = VisualBridgeAuthoringProjectParser.Parse(profile.AuthoringProjectPath);
            var entityTypeNamespaces = new Dictionary<string, string>(StringComparer.Ordinal);
            var componentTypeNamespaces = new Dictionary<string, string>(StringComparer.Ordinal);
            var groupNamespaces = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var plan in plans)
            {
                CollectNamespace(plan, "entityTypes", entityTypeNamespaces);
                CollectNamespace(plan, "componentTypes", componentTypeNamespaces);
                CollectNamespace(plan, "componentGroups", groupNamespaces);
            }

            var pathComparer = Path.DirectorySeparatorChar == '\\' ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
            foreach (var plan in plans)
            {
                if (!project.DocumentTypes.Any(documentType => documentType.Editor == "entity"
                    && documentType.Catalogs.Any(catalog => pathComparer.Equals(
                        VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalog, documentType.Id + ".catalogs"),
                        plan.OutputPath))))
                {
                    throw Error("profile.catalogNotDeclared", plan.OutputPath, "Export output is not declared by an Entity Document Type.");
                }
            }
        }

        private static void CollectNamespace(VisualBridgeStructuredCatalogExporter.ExportPlan plan, string arrayName, Dictionary<string, string> namespaces)
        {
            foreach (var entry in ((JArray)plan.Catalog[arrayName]).Cast<JObject>())
            {
                var canonicalId = entry.Value<string>("id");
                foreach (var identity in new[] { canonicalId }.Concat(((JArray)entry["aliases"]).Values<string>()))
                {
                    if (namespaces.TryGetValue(identity, out var owner))
                    {
                        throw Error(
                            "profile.catalogIdentityConflict",
                            plan.OutputPath,
                            $"{arrayName} identity '{identity}' is already exported by '{owner}'.");
                    }

                    namespaces.Add(identity, plan.OutputPath);
                }
            }
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

        private sealed class GroupMetadata
        {
            public string CatalogId { get; set; }

            public string Id { get; set; }

            public string Title { get; set; }

            public string[] Aliases { get; set; } = Array.Empty<string>();
        }

        private sealed class EntityTypeMetadata
        {
            public string CatalogId { get; set; }

            public string Id { get; set; }

            public string Title { get; set; }

            public string[] Aliases { get; set; } = Array.Empty<string>();

            public string Description { get; set; }

            public string[] AllowedComponentGroupIds { get; set; } = Array.Empty<string>();
        }

        private sealed class ComponentMetadata
        {
            public string CatalogId { get; set; }

            public string Id { get; set; }

            public string Title { get; set; }

            public string GroupId { get; set; }

            public string[] Aliases { get; set; } = Array.Empty<string>();

            public string Description { get; set; }

            public string[] MenuPath { get; set; } = Array.Empty<string>();
        }
    }
}
