using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using VisualBridge.Runtime;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Graph Catalog Exporter：按 Profile 中 `.vbgraphcatalog` 输出路由，从显式 metadata 的普通
    /// C# 类型确定性导出 Graph Catalog V4（dataTypes/graphTypes/nodeTypes）。字段模型、序列化与
    /// 原子写复用 Structured Exporter 的共享实现；C# 全名只作 source 追踪信息。
    /// </summary>
    public static class VisualBridgeGraphCatalogExporter
    {
        public const string ProviderId = VisualBridgeStructuredCatalogExporter.ProviderId;

        private static readonly Regex ColorPattern = new Regex("^#[0-9A-Fa-f]{6}$", RegexOptions.CultureInvariant);

        public static VisualBridgeCatalogExportResult Export(string unityProjectRoot, VisualBridgeCatalogExportMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            var plans = profile.CatalogExports
                .Where(export => export.OutputPath.EndsWith(".vbgraphcatalog", StringComparison.Ordinal))
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
            var dataTypeAssemblies = new HashSet<Assembly>();
            var dataTypeIdentifiers = new HashSet<string>(StringComparer.Ordinal);
            var dataTypes = new List<JObject>();
            var graphTypeIdentities = new HashSet<string>(StringComparer.Ordinal);
            var nodeTypeIdentities = new HashSet<string>(StringComparer.Ordinal);
            var graphTypes = new List<JObject>();
            var nodeTypes = new List<JObject>();
            var sourceGraphTypes = new List<JObject>();
            var sourceNodeTypes = new List<JObject>();

            // 第一遍先解析全部类型并收集所在程序集声明的 dataType，
            // 使 graphType/nodeType 的数据类型引用不依赖注册顺序。
            var resolved = new List<KeyValuePair<string, Type>>();
            foreach (var registeredName in export.Types)
            {
                var type = Type.GetType(registeredName, false, false);
                if (type == null)
                {
                    throw Error("catalog.typeNotFound", registeredName, "Registered type could not be resolved.");
                }

                VisualBridgeStructuredCatalogExporter.ValidateRootType(type, registeredName);
                var assemblyTitle = ReadGraphCatalogTitle(type.Assembly, export.CatalogId);
                if (assemblyTitle == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, $"Assembly does not declare graph catalog metadata for '{export.CatalogId}'.");
                }

                if (!string.Equals(assemblyTitle, export.Title, StringComparison.Ordinal))
                {
                    throw Error("catalog.titleMismatch", registeredName, "Profile and assembly graph catalog titles differ.");
                }

                catalogTitle = catalogTitle ?? assemblyTitle;
                ReadDataTypes(type.Assembly, dataTypeAssemblies, dataTypeIdentifiers, dataTypes);
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
                var graphMetadata = ReadGraphTypeMetadata(type);
                var nodeMetadata = ReadNodeTypeMetadata(type);
                if (graphMetadata == null && nodeMetadata == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, "Type does not declare VisualBridgeGraphType or VisualBridgeNodeType metadata.");
                }

                if (graphMetadata != null && nodeMetadata != null)
                {
                    throw Error("catalog.duplicateMetadata", registeredName, "Type declares both graph type and node type metadata.");
                }

                var metadataCatalogId = graphMetadata != null ? graphMetadata.CatalogId : nodeMetadata.CatalogId;
                if (!string.Equals(metadataCatalogId, export.CatalogId, StringComparison.Ordinal))
                {
                    throw Error("catalog.catalogIdMismatch", registeredName, "Type metadata belongs to a different catalog.");
                }

                if (graphMetadata != null)
                {
                    var graphType = BuildGraphType(graphMetadata, type, registeredName, export.CatalogId, graphTypeIdentities);
                    graphTypes.Add(graphType);
                    sourceGraphTypes.Add(new JObject
                    {
                        ["assemblyQualifiedName"] = registeredName,
                        ["graphType"] = VisualBridgeStructuredCatalogExporter.Canonicalize(graphType),
                    });
                }
                else
                {
                    var nodeType = BuildNodeType(nodeMetadata, type, registeredName, nodeTypeIdentities);
                    nodeTypes.Add(nodeType);
                    sourceNodeTypes.Add(new JObject
                    {
                        ["assemblyQualifiedName"] = registeredName,
                        ["nodeType"] = VisualBridgeStructuredCatalogExporter.Canonicalize(nodeType),
                    });
                }
            }

            dataTypes.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            graphTypes.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            nodeTypes.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            SortSourceEntries(sourceGraphTypes, "graphType");
            SortSourceEntries(sourceNodeTypes, "nodeType");
            var snapshot = new JObject
            {
                ["formatVersion"] = 4,
                ["providerId"] = ProviderId,
                ["catalogId"] = export.CatalogId,
                ["title"] = export.Title,
                ["dataTypes"] = new JArray(dataTypes.Select(VisualBridgeStructuredCatalogExporter.Canonicalize)),
                ["graphTypes"] = new JArray(sourceGraphTypes),
                ["nodeTypes"] = new JArray(sourceNodeTypes),
            };
            var snapshotBytes = VisualBridgeStructuredCatalogExporter.Utf8WithoutBom.GetBytes(
                VisualBridgeStructuredCatalogExporter.WriteCompact(VisualBridgeStructuredCatalogExporter.Canonicalize(snapshot)));
            var sourceHash = VisualBridgeStructuredCatalogExporter.HashBytes(snapshotBytes);
            var catalog = new JObject
            {
                ["formatVersion"] = 4,
                ["catalogId"] = export.CatalogId,
                ["title"] = export.Title,
                ["source"] = new JObject
                {
                    ["status"] = "current",
                    ["providerId"] = ProviderId,
                    ["sourceHash"] = sourceHash,
                },
                ["dataTypes"] = new JArray(dataTypes),
                ["graphTypes"] = new JArray(graphTypes),
                ["nodeTypes"] = new JArray(nodeTypes),
            };
            VisualBridgeGraphCatalogValidator.Validate(catalog);
            var bytes = VisualBridgeStructuredCatalogExporter.Utf8WithoutBom.GetBytes(VisualBridgeStructuredCatalogExporter.WriteIndented(catalog));
            return new VisualBridgeStructuredCatalogExporter.ExportPlan(projectRoot, export.OutputPath, bytes, VisualBridgeStructuredCatalogExporter.HashBytes(bytes), catalog);
        }

        private static JObject BuildGraphType(
            GraphTypeMetadata metadata,
            Type type,
            string registeredName,
            string catalogId,
            HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.Id, registeredName + ".id");
            VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Title, registeredName + ".title");
            VisualBridgeStructuredCatalogExporter.ValidateAliases(metadata.Id, metadata.Aliases, registeredName + ".aliases");
            foreach (var identity in new[] { metadata.Id }.Concat(metadata.Aliases))
            {
                if (!identities.Add(identity))
                {
                    throw Error("catalog.identityConflict", registeredName, $"Graph type identity '{identity}' is already used.");
                }
            }

            var graphType = new JObject
            {
                ["id"] = metadata.Id,
                ["aliases"] = new JArray(metadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                ["title"] = metadata.Title,
            };
            if (metadata.Description != null)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Description, registeredName + ".description");
                graphType["description"] = metadata.Description;
            }

            if (metadata.Usage == VisualBridgeGraphUsage.Root)
            {
                graphType["usage"] = "root";
            }
            else if (metadata.Usage == VisualBridgeGraphUsage.Subgraph)
            {
                graphType["usage"] = "subgraph";
            }

            graphType["source"] = new JObject
            {
                ["providerId"] = ProviderId,
                ["typeName"] = registeredName,
            };
            foreach (var supportedCatalogId in metadata.SupportedCatalogIds)
            {
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(supportedCatalogId, registeredName + ".supportedCatalogIds");
            }

            if (!metadata.SupportedCatalogIds.Contains(catalogId, StringComparer.Ordinal))
            {
                throw Error("catalog.invalidReference", registeredName + ".supportedCatalogIds", "supportedCatalogIds must include the owning catalog.");
            }

            graphType["supportedCatalogIds"] = new JArray(metadata.SupportedCatalogIds.OrderBy(value => value, StringComparer.Ordinal));
            graphType["portConnectionRules"] = new JObject
            {
                ["input"] = ConnectionModeName(metadata.PortConnectionInput),
                ["output"] = ConnectionModeName(metadata.PortConnectionOutput),
            };

            if (metadata.AllowedNodeTypeIds.Length > 0 || metadata.AllowedNodeTags.Length > 0 || metadata.AllowedNodeTraits.Length > 0)
            {
                foreach (var nodeTypeId in metadata.AllowedNodeTypeIds)
                {
                    VisualBridgeStructuredCatalogExporter.ValidateIdentifier(nodeTypeId, registeredName + ".allowedNodeTypeIds");
                }

                foreach (var tag in metadata.AllowedNodeTags)
                {
                    VisualBridgeStructuredCatalogExporter.ValidateIdentifier(tag, registeredName + ".allowedNodeTags");
                }

                foreach (var trait in metadata.AllowedNodeTraits)
                {
                    VisualBridgeStructuredCatalogExporter.ValidateIdentifier(trait, registeredName + ".allowedNodeTraits");
                }

                var selector = new JObject();
                if (metadata.AllowedNodeTypeIds.Length > 0)
                {
                    selector["nodeTypeIds"] = new JArray(metadata.AllowedNodeTypeIds.OrderBy(value => value, StringComparer.Ordinal));
                }

                if (metadata.AllowedNodeTags.Length > 0)
                {
                    selector["tags"] = new JArray(metadata.AllowedNodeTags.OrderBy(value => value, StringComparer.Ordinal));
                }

                if (metadata.AllowedNodeTraits.Length > 0)
                {
                    selector["traits"] = new JArray(metadata.AllowedNodeTraits);
                }

                graphType["allowedNodeSelectors"] = new JArray(selector);
            }

            graphType["properties"] = VisualBridgeStructuredCatalogExporter.BuildFields(type, new HashSet<Type>(), registeredName);

            var constraints = ReadNodeConstraints(type);
            if (constraints.Count > 0)
            {
                var constraintIdentities = new HashSet<string>(StringComparer.Ordinal);
                var nodeConstraints = new JArray();
                foreach (var constraint in constraints)
                {
                    VisualBridgeStructuredCatalogExporter.ValidateIdentifier(constraint.Id, registeredName + ".nodeConstraint.id");
                    if (!constraintIdentities.Add(constraint.Id))
                    {
                        throw Error("catalog.identityConflict", registeredName, $"Node constraint identity '{constraint.Id}' is already used.");
                    }

                    VisualBridgeStructuredCatalogExporter.ValidateIdentifier(constraint.NodeTypeId, registeredName + ".nodeConstraint.nodeTypeId");
                    var nodeConstraint = new JObject
                    {
                        ["id"] = constraint.Id,
                        ["selector"] = new JObject
                        {
                            ["nodeTypeIds"] = new JArray(constraint.NodeTypeId),
                        },
                    };
                    if (constraint.MinInstances >= 0)
                    {
                        nodeConstraint["minInstances"] = constraint.MinInstances;
                    }

                    if (constraint.MaxInstances >= 0)
                    {
                        nodeConstraint["maxInstances"] = constraint.MaxInstances;
                    }

                    nodeConstraints.Add(nodeConstraint);
                }

                graphType["nodeConstraints"] = nodeConstraints;
            }

            var initialNodes = ReadInitialNodes(type);
            if (initialNodes.Count > 0)
            {
                var initialNodeArray = new JArray();
                foreach (var initialNode in initialNodes.OrderBy(value => value.NodeTypeId, StringComparer.Ordinal))
                {
                    VisualBridgeStructuredCatalogExporter.ValidateIdentifier(initialNode.NodeTypeId, registeredName + ".initialNode.nodeTypeId");
                    var node = new JObject
                    {
                        ["nodeTypeId"] = initialNode.NodeTypeId,
                    };
                    if (initialNode.Title != null)
                    {
                        VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(initialNode.Title, registeredName + ".initialNode.title");
                        node["title"] = initialNode.Title;
                    }

                    initialNodeArray.Add(node);
                }

                graphType["initialNodes"] = initialNodeArray;
            }

            if (!metadata.AllowSubgraphs)
            {
                graphType["allowSubgraphs"] = false;
            }

            if (metadata.AllowedSubgraphTypeIds.Length > 0)
            {
                foreach (var subgraphTypeId in metadata.AllowedSubgraphTypeIds)
                {
                    VisualBridgeStructuredCatalogExporter.ValidateIdentifier(subgraphTypeId, registeredName + ".allowedSubgraphTypeIds");
                }

                graphType["allowedSubgraphTypeIds"] = new JArray(metadata.AllowedSubgraphTypeIds.OrderBy(value => value, StringComparer.Ordinal));
            }

            return graphType;
        }

        private static JObject BuildNodeType(
            NodeTypeMetadata metadata,
            Type type,
            string registeredName,
            HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.Id, registeredName + ".id");
            VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Title, registeredName + ".title");
            VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Category, registeredName + ".category");
            if (metadata.Description != null)
            {
                throw Error("catalog.invalidMetadata", registeredName, "Node types do not support Description in V4.");
            }

            VisualBridgeStructuredCatalogExporter.ValidateAliases(metadata.Id, metadata.Aliases, registeredName + ".aliases");
            foreach (var identity in new[] { metadata.Id }.Concat(metadata.Aliases))
            {
                if (!identities.Add(identity))
                {
                    throw Error("catalog.identityConflict", registeredName, $"Node type identity '{identity}' is already used.");
                }
            }

            foreach (var staticField in type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                if (staticField.CustomAttributes.Any(value => value.AttributeType == typeof(VisualBridgePortAttribute))
                    || staticField.CustomAttributes.Any(value => value.AttributeType == typeof(VisualBridgeDynamicPortGroupAttribute)))
                {
                    throw Error("catalog.staticFieldUnsupported", registeredName + "." + staticField.Name, "Annotated static fields are unsupported.");
                }
            }

            // GetFields(DeclaredOnly) 的返回顺序不稳定，用 MetadataToken 还原字段声明顺序。
            var ports = new JArray();
            var dynamicPortGroups = new JArray();
            var portIdentities = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                .OrderBy(value => value.MetadataToken))
            {
                var portMetadata = ReadPortMetadata(field);
                var groupMetadata = ReadDynamicPortGroupMetadata(field);
                var hasFieldMetadata = field.CustomAttributes.Any(value => value.AttributeType == typeof(VisualBridgeFieldAttribute));
                if ((portMetadata != null || groupMetadata != null) && hasFieldMetadata)
                {
                    throw Error("catalog.duplicateMetadata", registeredName + "." + field.Name, "Field declares both port and property metadata.");
                }

                if (portMetadata != null && groupMetadata != null)
                {
                    throw Error("catalog.duplicateMetadata", registeredName + "." + field.Name, "Field declares both static port and dynamic port group metadata.");
                }

                if (portMetadata != null)
                {
                    ports.Add(BuildPort(portMetadata, field, registeredName + "." + field.Name, portIdentities));
                }

                if (groupMetadata != null)
                {
                    dynamicPortGroups.Add(BuildDynamicPortGroup(groupMetadata, field, registeredName + "." + field.Name, portIdentities));
                }
            }

            var nodeType = new JObject
            {
                ["id"] = metadata.Id,
                ["aliases"] = new JArray(metadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                ["title"] = metadata.Title,
            };
            if (metadata.Icon != null)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Icon, registeredName + ".icon");
                nodeType["icon"] = metadata.Icon;
            }

            nodeType["category"] = metadata.Category;
            foreach (var segment in metadata.MenuPath)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(segment, registeredName + ".menuPath");
            }

            nodeType["menuPath"] = new JArray(metadata.MenuPath);
            foreach (var tag in metadata.Tags)
            {
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(tag, registeredName + ".tags");
            }

            nodeType["tags"] = new JArray(metadata.Tags.OrderBy(value => value, StringComparer.Ordinal));
            foreach (var trait in metadata.Traits)
            {
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(trait, registeredName + ".traits");
            }

            nodeType["traits"] = new JArray(metadata.Traits);
            nodeType["source"] = new JObject
            {
                ["providerId"] = ProviderId,
                ["typeName"] = registeredName,
            };
            foreach (var graphTypeId in metadata.SubgraphGraphTypeIds)
            {
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(graphTypeId, registeredName + ".subgraphGraphTypeIds");
            }

            if (metadata.SubgraphGraphTypeIds.Length > 0)
            {
                nodeType["subgraph"] = new JObject
                {
                    ["graphTypeIds"] = new JArray(metadata.SubgraphGraphTypeIds.OrderBy(value => value, StringComparer.Ordinal)),
                };
            }

            nodeType["ports"] = ports;
            if (dynamicPortGroups.Count > 0)
            {
                nodeType["dynamicPortGroups"] = dynamicPortGroups;
            }

            nodeType["properties"] = VisualBridgeStructuredCatalogExporter.BuildFields(type, new HashSet<Type>(), registeredName);
            return nodeType;
        }

        private static JObject BuildPort(PortMetadata metadata, FieldInfo field, string path, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.Id, path + ".id");
            VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Title, path + ".title");
            VisualBridgeStructuredCatalogExporter.ValidateAliases(metadata.Id, metadata.Aliases, path + ".aliases");
            foreach (var identity in new[] { metadata.Id }.Concat(metadata.Aliases))
            {
                if (!identities.Add(identity))
                {
                    throw Error("catalog.identityConflict", path, $"Port identity '{identity}' is already used.");
                }
            }

            var port = new JObject
            {
                ["id"] = metadata.Id,
                ["aliases"] = new JArray(metadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                ["title"] = metadata.Title,
            };
            if (metadata.Description != null)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Description, path + ".description");
                port["description"] = metadata.Description;
            }

            port["kind"] = metadata.Kind == VisualBridgePortKind.Flow ? "flow" : "data";
            port["direction"] = metadata.Direction == VisualBridgePortDirection.Input ? "input" : "output";
            if (metadata.Kind == VisualBridgePortKind.Data)
            {
                var dataTypeId = metadata.DataTypeId ?? InferPortDataTypeId(field.FieldType, path);
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(dataTypeId, path + ".dataTypeId");
                port["dataTypeId"] = dataTypeId;
            }
            else if (metadata.DataTypeId != null)
            {
                throw Error("catalog.invalidMetadata", path, "Flow ports cannot declare DataTypeId.");
            }

            if (metadata.MaxConnections > 0)
            {
                port["maxConnections"] = metadata.MaxConnections;
            }

            return port;
        }

        private static JObject BuildDynamicPortGroup(DynamicPortGroupMetadata metadata, FieldInfo field, string path, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.Id, path + ".id");
            VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Title, path + ".title");
            VisualBridgeStructuredCatalogExporter.ValidateAliases(metadata.Id, metadata.Aliases, path + ".aliases");
            foreach (var identity in new[] { metadata.Id }.Concat(metadata.Aliases))
            {
                if (!identities.Add(identity))
                {
                    throw Error("catalog.identityConflict", path, $"Dynamic port group identity '{identity}' is already used.");
                }
            }

            if (!(field.FieldType.IsGenericType && field.FieldType.GetGenericTypeDefinition() == typeof(List<>)))
            {
                throw Error("catalog.invalidMetadata", path, "Dynamic port group fields must be List<T>.");
            }

            var itemType = field.FieldType.GetGenericArguments()[0];
            var item = VisualBridgeStructuredCatalogExporter.BuildValueDefinition(
                itemType,
                VisualBridgeStructuredCatalogExporter.FieldMetadata.ForNestedValue(),
                new HashSet<Type>(),
                path + ".item",
                false);
            var group = new JObject
            {
                ["id"] = metadata.Id,
                ["aliases"] = new JArray(metadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                ["title"] = metadata.Title,
            };
            if (metadata.Description != null)
            {
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Description, path + ".description");
                group["description"] = metadata.Description;
            }

            var templateDataTypeId = metadata.DataTypeId;
            if (metadata.ListPortMode == VisualBridgeListPortMode.List)
            {
                if (templateDataTypeId == null)
                {
                    throw Error("catalog.invalidMetadata", path, "List mode dynamic port groups require DataTypeId.");
                }
            }
            else
            {
                templateDataTypeId = templateDataTypeId ?? item.Value<string>("dataTypeId");
                group["listPortMode"] = "element";
            }

            VisualBridgeStructuredCatalogExporter.ValidateIdentifier(templateDataTypeId, path + ".port.dataTypeId");
            group["port"] = new JObject
            {
                ["kind"] = "data",
                ["direction"] = metadata.Direction == VisualBridgePortDirection.Input ? "input" : "output",
                ["dataTypeId"] = templateDataTypeId,
            };
            group["item"] = item;
            if (metadata.MaxItems > 0)
            {
                group["maxItems"] = metadata.MaxItems;
            }

            return group;
        }

        private static string InferPortDataTypeId(Type type, string path)
        {
            if (type == typeof(int)) return "int";
            if (type == typeof(float)) return "float";
            if (type == typeof(double)) return "double";
            if (type == typeof(string)) return "string";
            if (type == typeof(bool)) return "bool";
            throw Error("catalog.invalidPortDataType", path, $"Cannot infer a data type id from '{type.FullName}'.");
        }

        private static void ReadDataTypes(
            Assembly assembly,
            HashSet<Assembly> visitedAssemblies,
            HashSet<string> identifiers,
            List<JObject> dataTypes)
        {
            if (!visitedAssemblies.Add(assembly))
            {
                return;
            }

            foreach (var attribute in assembly.CustomAttributes.Where(value => value.AttributeType == typeof(VisualBridgeGraphDataTypeAttribute)))
            {
                var metadata = new DataTypeMetadata
                {
                    Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, assembly.FullName),
                    Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, assembly.FullName),
                };
                foreach (var argument in attribute.NamedArguments)
                {
                    switch (argument.MemberName)
                    {
                        case nameof(VisualBridgeGraphDataTypeAttribute.Color): metadata.Color = argument.TypedValue.Value as string; break;
                        case nameof(VisualBridgeGraphDataTypeAttribute.AcceptsAnySource): metadata.AcceptsAnySource = (bool)argument.TypedValue.Value; break;
                        case nameof(VisualBridgeGraphDataTypeAttribute.Accepts): metadata.Accepts = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, assembly.FullName); break;
                        default: throw Error("catalog.unknownMetadata", assembly.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                    }
                }

                var path = assembly.FullName + ".dataType";
                VisualBridgeStructuredCatalogExporter.ValidateIdentifier(metadata.Id, path + ".id");
                VisualBridgeStructuredCatalogExporter.ValidateNonEmpty(metadata.Title, path + ".title");
                if (!identifiers.Add(metadata.Id))
                {
                    throw Error("catalog.identityConflict", assembly.FullName, $"Data type identity '{metadata.Id}' is already used.");
                }

                var dataType = new JObject
                {
                    ["id"] = metadata.Id,
                    ["title"] = metadata.Title,
                };
                if (metadata.Color != null)
                {
                    if (!ColorPattern.IsMatch(metadata.Color))
                    {
                        throw Error("catalog.invalidColor", path + ".color", "Expected a #RRGGBB color.");
                    }

                    dataType["color"] = metadata.Color;
                }

                if (metadata.AcceptsAnySource)
                {
                    dataType["acceptsAnySource"] = true;
                }

                if (metadata.Accepts.Length > 0)
                {
                    var accepted = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var acceptedId in metadata.Accepts)
                    {
                        VisualBridgeStructuredCatalogExporter.ValidateIdentifier(acceptedId, path + ".accepts");
                        if (!accepted.Add(acceptedId))
                        {
                            throw Error("catalog.duplicateIdentifier", path + ".accepts", $"Duplicate identifier '{acceptedId}'.");
                        }
                    }

                    dataType["accepts"] = new JArray(metadata.Accepts.OrderBy(value => value, StringComparer.Ordinal));
                }

                dataTypes.Add(dataType);
            }
        }

        private static string ReadGraphCatalogTitle(Assembly assembly, string catalogId)
        {
            var matches = new List<string>();
            foreach (var attribute in assembly.CustomAttributes.Where(value => value.AttributeType == typeof(VisualBridgeGraphCatalogAttribute)))
            {
                var attributeCatalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, assembly.FullName);
                if (attributeCatalogId == catalogId)
                {
                    matches.Add(VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, assembly.FullName));
                }
            }

            if (matches.Count > 1)
            {
                throw Error("catalog.duplicateMetadata", assembly.FullName, $"Assembly declares graph catalog '{catalogId}' more than once.");
            }

            return matches.SingleOrDefault();
        }

        private static GraphTypeMetadata ReadGraphTypeMetadata(Type type)
        {
            var attributes = type.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeGraphTypeAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", type.FullName, "Type declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new GraphTypeMetadata
            {
                CatalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, type.FullName),
                Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, type.FullName),
                Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 2, type.FullName),
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgeGraphTypeAttribute.Aliases): result.Aliases = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeGraphTypeAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeGraphTypeAttribute.Usage): result.Usage = (VisualBridgeGraphUsage)(int)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeGraphTypeAttribute.SupportedCatalogIds): result.SupportedCatalogIds = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeGraphTypeAttribute.PortConnectionInput): result.PortConnectionInput = (VisualBridgePortConnectionMode)(int)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeGraphTypeAttribute.PortConnectionOutput): result.PortConnectionOutput = (VisualBridgePortConnectionMode)(int)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeGraphTypeAttribute.AllowedNodeTypeIds): result.AllowedNodeTypeIds = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeGraphTypeAttribute.AllowedNodeTags): result.AllowedNodeTags = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeGraphTypeAttribute.AllowedNodeTraits): result.AllowedNodeTraits = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeGraphTypeAttribute.AllowSubgraphs): result.AllowSubgraphs = (bool)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeGraphTypeAttribute.AllowedSubgraphTypeIds): result.AllowedSubgraphTypeIds = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    default: throw Error("catalog.unknownMetadata", type.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static NodeTypeMetadata ReadNodeTypeMetadata(Type type)
        {
            var attributes = type.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeNodeTypeAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", type.FullName, "Type declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new NodeTypeMetadata
            {
                CatalogId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, type.FullName),
                Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, type.FullName),
                Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 2, type.FullName),
                Category = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 3, type.FullName),
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgeNodeTypeAttribute.Aliases): result.Aliases = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeNodeTypeAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeNodeTypeAttribute.Icon): result.Icon = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeNodeTypeAttribute.MenuPath): result.MenuPath = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeNodeTypeAttribute.Tags): result.Tags = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeNodeTypeAttribute.Traits): result.Traits = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeNodeTypeAttribute.SubgraphGraphTypeIds): result.SubgraphGraphTypeIds = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, type.FullName); break;
                    default: throw Error("catalog.unknownMetadata", type.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static List<ConstraintMetadata> ReadNodeConstraints(Type type)
        {
            var constraints = new List<ConstraintMetadata>();
            foreach (var attribute in type.CustomAttributes.Where(value => value.AttributeType == typeof(VisualBridgeGraphNodeConstraintAttribute)))
            {
                var constraint = new ConstraintMetadata
                {
                    Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, type.FullName),
                    NodeTypeId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, type.FullName),
                };
                foreach (var argument in attribute.NamedArguments)
                {
                    switch (argument.MemberName)
                    {
                        case nameof(VisualBridgeGraphNodeConstraintAttribute.MinInstances): constraint.MinInstances = (int)argument.TypedValue.Value; break;
                        case nameof(VisualBridgeGraphNodeConstraintAttribute.MaxInstances): constraint.MaxInstances = (int)argument.TypedValue.Value; break;
                        default: throw Error("catalog.unknownMetadata", type.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                    }
                }

                constraints.Add(constraint);
            }

            constraints.Sort((left, right) => StringComparer.Ordinal.Compare(left.Id, right.Id));
            return constraints;
        }

        private static List<InitialNodeMetadata> ReadInitialNodes(Type type)
        {
            var initialNodes = new List<InitialNodeMetadata>();
            foreach (var attribute in type.CustomAttributes.Where(value => value.AttributeType == typeof(VisualBridgeGraphInitialNodeAttribute)))
            {
                var initialNode = new InitialNodeMetadata
                {
                    NodeTypeId = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, type.FullName),
                };
                foreach (var argument in attribute.NamedArguments)
                {
                    switch (argument.MemberName)
                    {
                        case nameof(VisualBridgeGraphInitialNodeAttribute.Title): initialNode.Title = argument.TypedValue.Value as string; break;
                        default: throw Error("catalog.unknownMetadata", type.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                    }
                }

                initialNodes.Add(initialNode);
            }

            return initialNodes;
        }

        private static PortMetadata ReadPortMetadata(FieldInfo field)
        {
            var attributes = field.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgePortAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", field.Name, "Field declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new PortMetadata
            {
                Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, field.Name),
                Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, field.Name),
                Kind = (VisualBridgePortKind)(int)attribute.ConstructorArguments[2].Value,
                Direction = (VisualBridgePortDirection)(int)attribute.ConstructorArguments[3].Value,
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgePortAttribute.Aliases): result.Aliases = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, field.Name); break;
                    case nameof(VisualBridgePortAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgePortAttribute.DataTypeId): result.DataTypeId = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgePortAttribute.MaxConnections): result.MaxConnections = (int)argument.TypedValue.Value; break;
                    default: throw Error("catalog.unknownMetadata", field.Name, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static DynamicPortGroupMetadata ReadDynamicPortGroupMetadata(FieldInfo field)
        {
            var attributes = field.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeDynamicPortGroupAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", field.Name, "Field declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new DynamicPortGroupMetadata
            {
                Id = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 0, field.Name),
                Title = VisualBridgeStructuredCatalogExporter.ReadConstructorString(attribute, 1, field.Name),
                Direction = (VisualBridgePortDirection)(int)attribute.ConstructorArguments[2].Value,
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgeDynamicPortGroupAttribute.Aliases): result.Aliases = VisualBridgeStructuredCatalogExporter.ReadStringArray(argument.TypedValue, field.Name); break;
                    case nameof(VisualBridgeDynamicPortGroupAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeDynamicPortGroupAttribute.ListPortMode): result.ListPortMode = (VisualBridgeListPortMode)(int)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeDynamicPortGroupAttribute.DataTypeId): result.DataTypeId = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeDynamicPortGroupAttribute.MaxItems): result.MaxItems = (int)argument.TypedValue.Value; break;
                    default: throw Error("catalog.unknownMetadata", field.Name, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static string ConnectionModeName(VisualBridgePortConnectionMode mode)
        {
            return mode == VisualBridgePortConnectionMode.Single ? "single" : "multiple";
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
            var graphTypeNamespaces = new Dictionary<string, string>(StringComparer.Ordinal);
            var nodeTypeNamespaces = new Dictionary<string, string>(StringComparer.Ordinal);
            var dataTypeNamespaces = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var plan in plans)
            {
                CollectNamespace(plan, "graphTypes", graphTypeNamespaces);
                CollectNamespace(plan, "nodeTypes", nodeTypeNamespaces);
                CollectNamespace(plan, "dataTypes", dataTypeNamespaces);
            }

            var pathComparer = Path.DirectorySeparatorChar == '\\' ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
            foreach (var plan in plans)
            {
                if (!project.DocumentTypes.Any(documentType => documentType.Editor == "graph"
                    && documentType.Catalogs.Any(catalog => pathComparer.Equals(
                        VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalog, documentType.Id + ".catalogs"),
                        plan.OutputPath))))
                {
                    throw Error("profile.catalogNotDeclared", plan.OutputPath, "Export output is not declared by a Graph Document Type.");
                }
            }
        }

        private static void CollectNamespace(VisualBridgeStructuredCatalogExporter.ExportPlan plan, string arrayName, Dictionary<string, string> namespaces)
        {
            foreach (var entry in ((JArray)plan.Catalog[arrayName]).Cast<JObject>())
            {
                var canonicalId = entry.Value<string>("id");
                var aliases = entry["aliases"] as JArray;
                var identities = aliases != null
                    ? new[] { canonicalId }.Concat(aliases.Values<string>())
                    : new[] { canonicalId };
                foreach (var identity in identities)
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

        private sealed class DataTypeMetadata
        {
            public string Id { get; set; }

            public string Title { get; set; }

            public string Color { get; set; }

            public bool AcceptsAnySource { get; set; }

            public string[] Accepts { get; set; } = Array.Empty<string>();
        }

        private sealed class GraphTypeMetadata
        {
            public string CatalogId { get; set; }

            public string Id { get; set; }

            public string Title { get; set; }

            public string[] Aliases { get; set; } = Array.Empty<string>();

            public string Description { get; set; }

            public VisualBridgeGraphUsage Usage { get; set; } = VisualBridgeGraphUsage.Any;

            public string[] SupportedCatalogIds { get; set; } = Array.Empty<string>();

            public VisualBridgePortConnectionMode PortConnectionInput { get; set; } = VisualBridgePortConnectionMode.Multiple;

            public VisualBridgePortConnectionMode PortConnectionOutput { get; set; } = VisualBridgePortConnectionMode.Multiple;

            public string[] AllowedNodeTypeIds { get; set; } = Array.Empty<string>();

            public string[] AllowedNodeTags { get; set; } = Array.Empty<string>();

            public string[] AllowedNodeTraits { get; set; } = Array.Empty<string>();

            public bool AllowSubgraphs { get; set; } = true;

            public string[] AllowedSubgraphTypeIds { get; set; } = Array.Empty<string>();
        }

        private sealed class NodeTypeMetadata
        {
            public string CatalogId { get; set; }

            public string Id { get; set; }

            public string Title { get; set; }

            public string Category { get; set; }

            public string[] Aliases { get; set; } = Array.Empty<string>();

            public string Description { get; set; }

            public string Icon { get; set; }

            public string[] MenuPath { get; set; } = Array.Empty<string>();

            public string[] Tags { get; set; } = Array.Empty<string>();

            public string[] Traits { get; set; } = Array.Empty<string>();

            public string[] SubgraphGraphTypeIds { get; set; } = Array.Empty<string>();
        }

        private sealed class ConstraintMetadata
        {
            public string Id { get; set; }

            public string NodeTypeId { get; set; }

            public int MinInstances { get; set; } = -1;

            public int MaxInstances { get; set; } = -1;
        }

        private sealed class InitialNodeMetadata
        {
            public string NodeTypeId { get; set; }

            public string Title { get; set; }
        }

        private sealed class PortMetadata
        {
            public string Id { get; set; }

            public string Title { get; set; }

            public VisualBridgePortKind Kind { get; set; }

            public VisualBridgePortDirection Direction { get; set; }

            public string[] Aliases { get; set; } = Array.Empty<string>();

            public string Description { get; set; }

            public string DataTypeId { get; set; }

            public int MaxConnections { get; set; }
        }

        private sealed class DynamicPortGroupMetadata
        {
            public string Id { get; set; }

            public string Title { get; set; }

            public VisualBridgePortDirection Direction { get; set; }

            public string[] Aliases { get; set; } = Array.Empty<string>();

            public string Description { get; set; }

            public VisualBridgeListPortMode ListPortMode { get; set; } = VisualBridgeListPortMode.List;

            public string DataTypeId { get; set; }

            public int MaxItems { get; set; }
        }
    }
}
