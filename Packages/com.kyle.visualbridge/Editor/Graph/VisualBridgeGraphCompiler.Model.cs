using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeGraphCompiler
    {
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
                IReadOnlyList<CatalogDescriptor> catalogs,
                IReadOnlyDictionary<string, IndexedDefinition> nodeTypes,
                IReadOnlyDictionary<string, IndexedDefinition> graphTypes,
                IReadOnlyDictionary<string, IndexedDefinition> dataTypes)
            {
                DocumentType = documentType;
                Catalogs = catalogs;
                NodeTypes = nodeTypes;
                GraphTypes = graphTypes;
                DataTypes = dataTypes;
            }

            public VisualBridgeAuthoringDocumentType DocumentType { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }

            // nodeType/graphType/dataType 身份索引：跨声明 Catalog 合并，id+alias 均可解析。
            public IReadOnlyDictionary<string, IndexedDefinition> NodeTypes { get; }

            public IReadOnlyDictionary<string, IndexedDefinition> GraphTypes { get; }

            public IReadOnlyDictionary<string, IndexedDefinition> DataTypes { get; }
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

        private sealed class IndexedDefinition
        {
            public IndexedDefinition(JObject definition, string catalogId)
            {
                Definition = definition;
                CatalogId = catalogId;
                Id = definition.Value<string>("id");
            }

            public JObject Definition { get; }

            public string CatalogId { get; }

            public string Id { get; }
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

        private sealed class DocumentModel
        {
            public DocumentModel(
                IReadOnlyList<GraphDefinition> graphs,
                string rootGraphId,
                IReadOnlyDictionary<string, GraphDefinition> graphById,
                IReadOnlyDictionary<string, SubgraphOwner> ownerByGraphId)
            {
                Graphs = graphs;
                RootGraphId = rootGraphId;
                GraphById = graphById;
                OwnerByGraphId = ownerByGraphId;
            }

            public IReadOnlyList<GraphDefinition> Graphs { get; }

            public string RootGraphId { get; }

            public IReadOnlyDictionary<string, GraphDefinition> GraphById { get; }

            public IReadOnlyDictionary<string, SubgraphOwner> OwnerByGraphId { get; }
        }

        private sealed class SubgraphOwner
        {
            public SubgraphOwner(GraphDefinition graph, NodeDefinition node)
            {
                Graph = graph;
                Node = node;
            }

            public GraphDefinition Graph { get; }

            public NodeDefinition Node { get; }
        }

        private sealed class GraphDefinition
        {
            public GraphDefinition(
                int index,
                string id,
                string graphTypeId,
                string title,
                JObject properties,
                IReadOnlyList<InterfacePortDefinition> interfacePorts,
                IReadOnlyList<NodeDefinition> nodes,
                IReadOnlyList<EdgeDefinition> edges)
            {
                Index = index;
                Id = id;
                GraphTypeId = graphTypeId;
                Title = title;
                Properties = properties;
                InterfacePorts = interfacePorts;
                Nodes = nodes;
                Edges = edges;
            }

            public int Index { get; }

            public string Id { get; }

            public string GraphTypeId { get; }

            public string Title { get; }

            public JObject Properties { get; }

            public IReadOnlyList<InterfacePortDefinition> InterfacePorts { get; }

            public IReadOnlyList<NodeDefinition> Nodes { get; }

            public IReadOnlyList<EdgeDefinition> Edges { get; }
        }

        private sealed class InterfacePortDefinition
        {
            public InterfacePortDefinition(
                string id,
                string title,
                string kind,
                string direction,
                string dataTypeId,
                long? maxConnections,
                bool dynamic)
            {
                Id = id;
                Title = title;
                Kind = kind;
                Direction = direction;
                DataTypeId = dataTypeId;
                MaxConnections = maxConnections;
                Dynamic = dynamic;
            }

            public string Id { get; }

            public string Title { get; }

            public string Kind { get; }

            public string Direction { get; }

            public string DataTypeId { get; }

            public long? MaxConnections { get; }

            public bool Dynamic { get; }
        }

        private sealed class NodeDefinition
        {
            public NodeDefinition(
                string kind,
                string id,
                string nodeTypeId,
                string subgraphId,
                string title,
                PositionDefinition position,
                JObject properties,
                IReadOnlyList<DynamicPortDefinition> dynamicPorts)
            {
                Kind = kind;
                Id = id;
                NodeTypeId = nodeTypeId;
                SubgraphId = subgraphId;
                Title = title;
                Position = position;
                Properties = properties;
                DynamicPorts = dynamicPorts;
            }

            public string Kind { get; }

            public string Id { get; }

            public string NodeTypeId { get; }

            public string SubgraphId { get; }

            public string Title { get; }

            public PositionDefinition Position { get; }

            public JObject Properties { get; }

            public IReadOnlyList<DynamicPortDefinition> DynamicPorts { get; }
        }

        private sealed class PositionDefinition
        {
            public PositionDefinition(JToken x, JToken y)
            {
                X = x;
                Y = y;
            }

            public JToken X { get; }

            public JToken Y { get; }
        }

        private sealed class DynamicPortDefinition
        {
            public DynamicPortDefinition(string id, string groupId, string title, JToken value)
            {
                Id = id;
                GroupId = groupId;
                Title = title;
                Value = value;
            }

            public string Id { get; }

            public string GroupId { get; }

            public string Title { get; }

            public JToken Value { get; }
        }

        private sealed class EdgeDefinition
        {
            public EdgeDefinition(string id, string kind, EndpointDefinition source, EndpointDefinition target)
            {
                Id = id;
                Kind = kind;
                Source = source;
                Target = target;
            }

            public string Id { get; }

            public string Kind { get; }

            public EndpointDefinition Source { get; }

            public EndpointDefinition Target { get; }
        }

        private sealed class EndpointDefinition
        {
            public EndpointDefinition(string kind, string nodeId, string portId)
            {
                Kind = kind;
                NodeId = nodeId;
                PortId = portId;
            }

            public string Kind { get; }

            public string NodeId { get; }

            public string PortId { get; }
        }

        private sealed class ResolvedPort
        {
            public ResolvedPort(string id, string kind, string direction, string dataTypeId, long? maxConnections)
            {
                Id = id;
                Kind = kind;
                Direction = direction;
                DataTypeId = dataTypeId;
                MaxConnections = maxConnections;
            }

            public string Id { get; }

            public string Kind { get; }

            public string Direction { get; }

            public string DataTypeId { get; }

            public long? MaxConnections { get; }
        }

        private sealed class CanonicalEdge
        {
            public CanonicalEdge(EdgeDefinition edge, string sourcePortId, string targetPortId, string path)
            {
                Edge = edge;
                SourcePortId = sourcePortId;
                TargetPortId = targetPortId;
                Path = path;
            }

            public EdgeDefinition Edge { get; }

            public string SourcePortId { get; }

            public string TargetPortId { get; }

            public string Path { get; }
        }

        private sealed class CardinalityEndpoint
        {
            public CardinalityEndpoint(EndpointDefinition endpoint, int count)
            {
                Endpoint = endpoint;
                Count = count;
            }

            public EndpointDefinition Endpoint { get; }

            public int Count { get; }
        }
    }
}
