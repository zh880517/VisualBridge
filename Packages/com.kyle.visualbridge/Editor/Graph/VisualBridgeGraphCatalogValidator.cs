using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Graph Catalog V4 严格校验器：镜像 visualbridge-graph-catalog.schema.json 的根、dataType、
    /// graphType、nodeType、端口与动态端口组契约；字段模型复用 Structured Validator 的共享校验。
    /// </summary>
    internal static class VisualBridgeGraphCatalogValidator
    {
        public static void Validate(JObject catalog)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                catalog,
                "$",
                new[] { "formatVersion", "catalogId", "title", "source", "dataTypes", "graphTypes", "nodeTypes" },
                Array.Empty<string>());
            VisualBridgeStructuredCatalogValidator.RequireInteger(catalog["formatVersion"], "$.formatVersion", 4);
            VisualBridgeStructuredCatalogValidator.RequireIdentifier(catalog["catalogId"], "$.catalogId");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(catalog["title"], "$.title");
            VisualBridgeStructuredCatalogValidator.ValidateSource(
                VisualBridgeStructuredCatalogValidator.RequireObject(catalog["source"], "$.source"),
                "$.source");

            var dataTypeIds = ValidateDataTypes(
                VisualBridgeStructuredCatalogValidator.RequireArray(catalog["dataTypes"], "$.dataTypes", false),
                "$.dataTypes");

            var graphTypeIdentities = new HashSet<string>(StringComparer.Ordinal);
            var graphTypes = VisualBridgeStructuredCatalogValidator.RequireArray(catalog["graphTypes"], "$.graphTypes", false);
            for (var index = 0; index < graphTypes.Count; index++)
            {
                ValidateGraphType(
                    VisualBridgeStructuredCatalogValidator.RequireObject(graphTypes[index], $"$.graphTypes[{index}]"),
                    $"$.graphTypes[{index}]",
                    catalog.Value<string>("catalogId"),
                    graphTypeIdentities);
            }

            var nodeTypeIdentities = new HashSet<string>(StringComparer.Ordinal);
            var nodeTypes = VisualBridgeStructuredCatalogValidator.RequireArray(catalog["nodeTypes"], "$.nodeTypes", false);
            for (var index = 0; index < nodeTypes.Count; index++)
            {
                ValidateNodeType(
                    VisualBridgeStructuredCatalogValidator.RequireObject(nodeTypes[index], $"$.nodeTypes[{index}]"),
                    $"$.nodeTypes[{index}]",
                    dataTypeIds,
                    nodeTypeIdentities);
            }
        }

        private static HashSet<string> ValidateDataTypes(JArray dataTypes, string path)
        {
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var acceptsLists = new List<KeyValuePair<string, IReadOnlyList<string>>>();
            for (var index = 0; index < dataTypes.Count; index++)
            {
                var dataTypePath = $"{path}[{index}]";
                var dataType = VisualBridgeStructuredCatalogValidator.RequireObject(dataTypes[index], dataTypePath);
                VisualBridgeStructuredCatalogValidator.RequireKeys(
                    dataType,
                    dataTypePath,
                    new[] { "id", "title" },
                    new[] { "color", "acceptsAnySource", "accepts" });
                var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(dataType["id"], dataTypePath + ".id");
                if (string.Equals(id, "any", StringComparison.Ordinal))
                {
                    throw Error("catalog.invalidIdentifier", dataTypePath + ".id", "Data type id 'any' is reserved.");
                }

                AddIdentity(ids, id, dataTypePath + ".id");
                VisualBridgeStructuredCatalogValidator.RequireString(dataType["title"], dataTypePath + ".title");
                if (dataType["color"] != null)
                {
                    var color = VisualBridgeStructuredCatalogValidator.RequireString(dataType["color"], dataTypePath + ".color");
                    if (color.Length != 7 || color[0] != '#' || color.Skip(1).Any(character => !IsHex(character)))
                    {
                        throw Error("catalog.invalidColor", dataTypePath + ".color", "Expected a #RRGGBB color.");
                    }
                }

                RequireOptionalBoolean(dataType["acceptsAnySource"], dataTypePath + ".acceptsAnySource");
                if (dataType["accepts"] != null)
                {
                    acceptsLists.Add(new KeyValuePair<string, IReadOnlyList<string>>(
                        dataTypePath,
                        RequireIdentifierList(dataType["accepts"], dataTypePath + ".accepts")));
                }
            }

            // accepts 可能前向引用同数组内后声明的 dataType，引用检查放在两遍收集之后。
            foreach (var entry in acceptsLists)
            {
                foreach (var accepted in entry.Value)
                {
                    if (!ids.Contains(accepted))
                    {
                        throw Error("catalog.invalidReference", entry.Key + ".accepts", $"Unknown data type '{accepted}'.");
                    }
                }
            }

            return ids;
        }

        private static void ValidateGraphType(JObject graphType, string path, string catalogId, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                graphType,
                path,
                new[] { "id", "title", "supportedCatalogIds", "portConnectionRules", "properties" },
                new[] { "aliases", "description", "usage", "source", "allowedNodeSelectors", "nodeConstraints", "initialNodes", "allowSubgraphs", "allowedSubgraphTypeIds" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(graphType["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            VisualBridgeStructuredCatalogValidator.RequireString(graphType["title"], path + ".title");
            if (graphType["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(graphType["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            if (graphType["description"] != null)
            {
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(graphType["description"], path + ".description");
            }

            if (graphType["usage"] != null)
            {
                RequireEnumValue(graphType["usage"], path + ".usage", new[] { "root", "subgraph", "any" });
            }

            if (graphType["source"] != null)
            {
                ValidateNodeSource(graphType["source"], path + ".source");
            }

            var supportedCatalogIds = RequireIdentifierList(
                VisualBridgeStructuredCatalogValidator.RequireArray(graphType["supportedCatalogIds"], path + ".supportedCatalogIds", true),
                path + ".supportedCatalogIds");
            if (!supportedCatalogIds.Contains(catalogId, StringComparer.Ordinal))
            {
                throw Error("catalog.invalidReference", path + ".supportedCatalogIds", "supportedCatalogIds must include the owning catalog.");
            }

            var rules = VisualBridgeStructuredCatalogValidator.RequireObject(graphType["portConnectionRules"], path + ".portConnectionRules");
            VisualBridgeStructuredCatalogValidator.RequireKeys(rules, path + ".portConnectionRules", new[] { "input", "output" }, Array.Empty<string>());
            RequireEnumValue(rules["input"], path + ".portConnectionRules.input", new[] { "single", "multiple" });
            RequireEnumValue(rules["output"], path + ".portConnectionRules.output", new[] { "single", "multiple" });

            if (graphType["allowedNodeSelectors"] != null)
            {
                var selectors = VisualBridgeStructuredCatalogValidator.RequireArray(graphType["allowedNodeSelectors"], path + ".allowedNodeSelectors", false);
                for (var index = 0; index < selectors.Count; index++)
                {
                    ValidateNodeSelector(
                        VisualBridgeStructuredCatalogValidator.RequireObject(selectors[index], $"{path}.allowedNodeSelectors[{index}]"),
                        $"{path}.allowedNodeSelectors[{index}]");
                }
            }

            if (graphType["nodeConstraints"] != null)
            {
                var constraints = VisualBridgeStructuredCatalogValidator.RequireArray(graphType["nodeConstraints"], path + ".nodeConstraints", false);
                for (var index = 0; index < constraints.Count; index++)
                {
                    ValidateNodeConstraint(
                        VisualBridgeStructuredCatalogValidator.RequireObject(constraints[index], $"{path}.nodeConstraints[{index}]"),
                        $"{path}.nodeConstraints[{index}]");
                }
            }

            if (graphType["initialNodes"] != null)
            {
                var initialNodes = VisualBridgeStructuredCatalogValidator.RequireArray(graphType["initialNodes"], path + ".initialNodes", false);
                for (var index = 0; index < initialNodes.Count; index++)
                {
                    var initialNodePath = $"{path}.initialNodes[{index}]";
                    var initialNode = VisualBridgeStructuredCatalogValidator.RequireObject(initialNodes[index], initialNodePath);
                    VisualBridgeStructuredCatalogValidator.RequireKeys(initialNode, initialNodePath, new[] { "nodeTypeId" }, new[] { "title" });
                    VisualBridgeStructuredCatalogValidator.RequireIdentifier(initialNode["nodeTypeId"], initialNodePath + ".nodeTypeId");
                    if (initialNode["title"] != null)
                    {
                        VisualBridgeStructuredCatalogValidator.RequireString(initialNode["title"], initialNodePath + ".title");
                    }
                }
            }

            RequireOptionalBoolean(graphType["allowSubgraphs"], path + ".allowSubgraphs");
            var allowSubgraphs = graphType["allowSubgraphs"] == null || graphType["allowSubgraphs"].Value<bool>();
            if (graphType["allowedSubgraphTypeIds"] != null)
            {
                if (!allowSubgraphs)
                {
                    throw Error("catalog.invalidMetadata", path + ".allowedSubgraphTypeIds", "allowedSubgraphTypeIds requires allowSubgraphs.");
                }

                RequireIdentifierList(graphType["allowedSubgraphTypeIds"], path + ".allowedSubgraphTypeIds");
            }

            var properties = VisualBridgeStructuredCatalogValidator.RequireArray(graphType["properties"], path + ".properties", false);
            VisualBridgeStructuredCatalogValidator.ValidateFields(properties, path + ".properties");
        }

        private static void ValidateNodeType(JObject nodeType, string path, HashSet<string> dataTypeIds, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                nodeType,
                path,
                new[] { "id", "title", "category", "ports", "properties" },
                new[] { "aliases", "icon", "menuPath", "tags", "traits", "source", "subgraph", "dynamicPortGroups" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(nodeType["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            VisualBridgeStructuredCatalogValidator.RequireString(nodeType["title"], path + ".title");
            if (nodeType["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(nodeType["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(nodeType["category"], path + ".category");
            if (nodeType["icon"] != null)
            {
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(nodeType["icon"], path + ".icon");
            }

            if (nodeType["menuPath"] != null)
            {
                var menuPath = VisualBridgeStructuredCatalogValidator.RequireArray(nodeType["menuPath"], path + ".menuPath", false);
                for (var index = 0; index < menuPath.Count; index++)
                {
                    VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(menuPath[index], $"{path}.menuPath[{index}]");
                }
            }

            if (nodeType["tags"] != null)
            {
                RequireIdentifierList(nodeType["tags"], path + ".tags");
            }

            if (nodeType["traits"] != null)
            {
                RequireIdentifierList(nodeType["traits"], path + ".traits");
            }

            if (nodeType["source"] != null)
            {
                ValidateNodeSource(nodeType["source"], path + ".source");
            }

            var isSubgraph = nodeType["subgraph"] != null;
            if (isSubgraph)
            {
                var subgraph = VisualBridgeStructuredCatalogValidator.RequireObject(nodeType["subgraph"], path + ".subgraph");
                VisualBridgeStructuredCatalogValidator.RequireKeys(subgraph, path + ".subgraph", Array.Empty<string>(), new[] { "graphTypeIds" });
                if (subgraph["graphTypeIds"] != null)
                {
                    RequireIdentifierList(subgraph["graphTypeIds"], path + ".subgraph.graphTypeIds");
                }
            }

            // 端口与动态端口组共享 nodeType 内的身份命名空间。
            var portIdentities = new HashSet<string>(StringComparer.Ordinal);
            var ports = VisualBridgeStructuredCatalogValidator.RequireArray(nodeType["ports"], path + ".ports", false);
            for (var index = 0; index < ports.Count; index++)
            {
                var portPath = $"{path}.ports[{index}]";
                var port = VisualBridgeStructuredCatalogValidator.RequireObject(ports[index], portPath);
                var kind = ValidatePort(port, portPath, dataTypeIds, portIdentities);
                if (isSubgraph && kind == "flow")
                {
                    throw Error("catalog.invalidPort", portPath + ".kind", "Subgraph node types cannot declare flow ports.");
                }
            }

            if (nodeType["dynamicPortGroups"] != null)
            {
                var groups = VisualBridgeStructuredCatalogValidator.RequireArray(nodeType["dynamicPortGroups"], path + ".dynamicPortGroups", false);
                for (var index = 0; index < groups.Count; index++)
                {
                    var groupPath = $"{path}.dynamicPortGroups[{index}]";
                    var group = VisualBridgeStructuredCatalogValidator.RequireObject(groups[index], groupPath);
                    var kind = ValidateDynamicPortGroup(group, groupPath, dataTypeIds, portIdentities);
                    if (isSubgraph && kind == "flow")
                    {
                        throw Error("catalog.invalidPort", groupPath + ".port.kind", "Subgraph node types cannot declare flow ports.");
                    }
                }
            }

            var properties = VisualBridgeStructuredCatalogValidator.RequireArray(nodeType["properties"], path + ".properties", false);
            VisualBridgeStructuredCatalogValidator.ValidateFields(properties, path + ".properties");
        }

        private static string ValidatePort(JObject port, string path, HashSet<string> dataTypeIds, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                port,
                path,
                new[] { "id", "title", "kind", "direction" },
                new[] { "aliases", "description", "dataTypeId", "maxConnections" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(port["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            if (port["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(port["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(port["title"], path + ".title");
            if (port["description"] != null)
            {
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(port["description"], path + ".description");
            }

            var kind = RequireEnumValue(port["kind"], path + ".kind", new[] { "flow", "data" });
            RequireEnumValue(port["direction"], path + ".direction", new[] { "input", "output" });
            if (kind == "data")
            {
                if (port["dataTypeId"] == null)
                {
                    throw Error("catalog.missingProperty", path + ".dataTypeId", "Data ports require dataTypeId.");
                }

                var dataTypeId = VisualBridgeStructuredCatalogValidator.RequireIdentifier(port["dataTypeId"], path + ".dataTypeId");
                if (!dataTypeIds.Contains(dataTypeId))
                {
                    throw Error("catalog.invalidReference", path + ".dataTypeId", $"Unknown data type '{dataTypeId}'.");
                }
            }
            else if (port["dataTypeId"] != null)
            {
                throw Error("catalog.invalidPort", path + ".dataTypeId", "Flow ports cannot declare dataTypeId.");
            }

            if (port["maxConnections"] != null)
            {
                RequirePositiveInteger(port["maxConnections"], path + ".maxConnections");
            }

            return kind;
        }

        private static string ValidateDynamicPortGroup(JObject group, string path, HashSet<string> dataTypeIds, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                group,
                path,
                new[] { "id", "title", "port", "item" },
                new[] { "aliases", "description", "listPortMode", "maxItems" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(group["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            if (group["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(group["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            VisualBridgeStructuredCatalogValidator.RequireString(group["title"], path + ".title");
            if (group["description"] != null)
            {
                VisualBridgeStructuredCatalogValidator.RequireString(group["description"], path + ".description");
            }

            var listPortMode = "list";
            if (group["listPortMode"] != null)
            {
                listPortMode = RequireEnumValue(group["listPortMode"], path + ".listPortMode", new[] { "list", "element" });
            }

            var template = VisualBridgeStructuredCatalogValidator.RequireObject(group["port"], path + ".port");
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                template,
                path + ".port",
                new[] { "kind", "direction" },
                new[] { "dataTypeId", "maxConnections" });
            var kind = RequireEnumValue(template["kind"], path + ".port.kind", new[] { "flow", "data" });
            var direction = RequireEnumValue(template["direction"], path + ".port.direction", new[] { "input", "output" });
            if (kind == "data")
            {
                if (template["dataTypeId"] == null)
                {
                    throw Error("catalog.missingProperty", path + ".port.dataTypeId", "Data port templates require dataTypeId.");
                }

                var dataTypeId = VisualBridgeStructuredCatalogValidator.RequireIdentifier(template["dataTypeId"], path + ".port.dataTypeId");
                if (!dataTypeIds.Contains(dataTypeId))
                {
                    throw Error("catalog.invalidReference", path + ".port.dataTypeId", $"Unknown data type '{dataTypeId}'.");
                }
            }
            else if (template["dataTypeId"] != null)
            {
                throw Error("catalog.invalidPort", path + ".port.dataTypeId", "Flow port templates cannot declare dataTypeId.");
            }

            if (template["maxConnections"] != null)
            {
                RequirePositiveInteger(template["maxConnections"], path + ".port.maxConnections");
            }

            // 与 VS Code 生产解析器一致：凡显式声明 listPortMode 的组（list 或 element）都要求 data + input 模板。
            if (listPortMode != null && (kind != "data" || direction != "input"))
            {
                throw Error("catalog.invalidPort", path + ".port", "Groups with an explicit listPortMode require a data input port template.");
            }

            var item = VisualBridgeStructuredCatalogValidator.RequireObject(group["item"], path + ".item");
            VisualBridgeStructuredCatalogValidator.ValidateValueDefinition(item, path + ".item");
            if (listPortMode == "element"
                && !string.Equals(
                    template.Value<string>("dataTypeId"),
                    item.Value<string>("dataTypeId"),
                    StringComparison.Ordinal))
            {
                throw Error("catalog.invalidPort", path + ".port.dataTypeId", "Element mode port dataTypeId must match the item dataTypeId.");
            }

            if (group["maxItems"] != null)
            {
                RequirePositiveInteger(group["maxItems"], path + ".maxItems");
            }

            return kind;
        }

        private static void ValidateNodeSelector(JObject selector, string path)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(selector, path, Array.Empty<string>(), new[] { "nodeTypeIds", "tags", "traits" });
            var hasDimension = false;
            foreach (var dimension in new[] { "nodeTypeIds", "tags", "traits" })
            {
                if (selector[dimension] == null)
                {
                    continue;
                }

                RequireIdentifierList(
                    VisualBridgeStructuredCatalogValidator.RequireArray(selector[dimension], path + "." + dimension, true),
                    path + "." + dimension);
                hasDimension = true;
            }

            if (!hasDimension)
            {
                throw Error("catalog.missingProperty", path, "Node selector requires at least one dimension.");
            }
        }

        private static void ValidateNodeConstraint(JObject constraint, string path)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(constraint, path, new[] { "id", "selector" }, new[] { "minInstances", "maxInstances" });
            VisualBridgeStructuredCatalogValidator.RequireIdentifier(constraint["id"], path + ".id");
            ValidateNodeSelector(
                VisualBridgeStructuredCatalogValidator.RequireObject(constraint["selector"], path + ".selector"),
                path + ".selector");
            var hasBound = false;
            foreach (var bound in new[] { "minInstances", "maxInstances" })
            {
                if (constraint[bound] != null)
                {
                    RequireNonNegativeInteger(constraint[bound], path + "." + bound);
                    hasBound = true;
                }
            }

            if (!hasBound)
            {
                throw Error("catalog.missingProperty", path, "Node constraint requires minInstances or maxInstances.");
            }
        }

        private static void ValidateNodeSource(JToken token, string path)
        {
            var source = VisualBridgeStructuredCatalogValidator.RequireObject(token, path);
            VisualBridgeStructuredCatalogValidator.RequireKeys(source, path, new[] { "providerId", "typeName" }, new[] { "assemblyName", "wrapperTypeName" });
            VisualBridgeStructuredCatalogValidator.RequireIdentifier(source["providerId"], path + ".providerId");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(source["typeName"], path + ".typeName");
        }

        private static string RequireEnumValue(JToken token, string path, IReadOnlyList<string> values)
        {
            var value = VisualBridgeStructuredCatalogValidator.RequireString(token, path);
            if (!values.Contains(value, StringComparer.Ordinal))
            {
                throw Error("catalog.invalidEnum", path, $"Expected one of [{string.Join(", ", values)}].");
            }

            return value;
        }

        private static IReadOnlyList<string> RequireIdentifierList(JToken token, string path)
        {
            var array = token is JArray values ? values : null;
            if (array == null)
            {
                throw Error("catalog.invalidArray", path, "Expected an array.");
            }

            var result = new List<string>(array.Count);
            for (var index = 0; index < array.Count; index++)
            {
                result.Add(VisualBridgeStructuredCatalogValidator.RequireIdentifier(array[index], $"{path}[{index}]"));
            }

            return result;
        }

        private static void RequireOptionalBoolean(JToken token, string path)
        {
            if (token != null && token.Type != JTokenType.Boolean)
            {
                throw Error("catalog.invalidBoolean", path, "Expected a boolean.");
            }
        }

        private static void RequirePositiveInteger(JToken token, string path)
        {
            if (token.Type != JTokenType.Integer || token.Value<long>() < 1)
            {
                throw Error("catalog.invalidNumber", path, "Expected an integer >= 1.");
            }
        }

        private static void RequireNonNegativeInteger(JToken token, string path)
        {
            if (token.Type != JTokenType.Integer || token.Value<long>() < 0)
            {
                throw Error("catalog.invalidNumber", path, "Expected an integer >= 0.");
            }
        }

        private static void AddIdentity(HashSet<string> identities, string identity, string path)
        {
            if (!identities.Add(identity))
            {
                throw Error("catalog.identityConflict", path, $"Identity '{identity}' is already used.");
            }
        }

        private static bool IsHex(char value)
        {
            return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F');
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }
    }
}
