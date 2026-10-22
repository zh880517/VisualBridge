using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeGraphCompiler
    {
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

    }
}
