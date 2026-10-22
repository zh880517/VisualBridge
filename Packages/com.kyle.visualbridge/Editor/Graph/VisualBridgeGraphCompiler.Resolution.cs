using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeGraphCompiler
    {
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

    }
}
