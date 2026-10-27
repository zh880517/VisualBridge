// Mutable Graph document types, cloning and structural edge helpers.
import { validateFieldValue } from "@visualbridge/module-sdk";
import type { FieldDefinition } from "@visualbridge/module-sdk";
import type { GraphDynamicPortGroupDefinition, GraphNodeTypeDefinition } from "../graphCatalog";
import { cloneJsonObject, cloneJsonValue } from "./json";
import { resolveTypedNodePort } from "./ports";
import type {
  GraphDefinition,
  GraphDocument,
  GraphEdge,
  GraphEndpoint,
  GraphNode,
  GraphResolvedPort,
  GraphTypedNode,
  JsonValue,
  MutableGraphDefinition,
  MutableGraphDocument,
  MutableGraphNode,
  MutableGraphSubgraphNode,
} from "./types";
import { GRAPH_DOCUMENT_FORMAT_VERSION } from "./types";


export function cloneDocument(document: GraphDocument): MutableGraphDocument {
  return {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    rootGraphId: document.rootGraphId,
    graphs: document.graphs.map(cloneGraph),
  };
}

export function cloneGraph(graph: GraphDefinition): MutableGraphDefinition {
  return {
    id: graph.id,
    ...(graph.graphTypeId === undefined ? {} : { graphTypeId: graph.graphTypeId }),
    title: graph.title,
    properties: cloneJsonObject(graph.properties),
    interfacePorts: graph.interfacePorts.map((port) => ({ ...port })),
    nodes: graph.nodes.map(cloneNode),
    edges: graph.edges.map(cloneEdge),
  };
}

export function cloneNode(node: GraphNode): MutableGraphNode {
  return node.kind === "node"
    ? {
        ...node,
        position: { ...node.position },
        properties: cloneJsonObject(node.properties),
        dynamicPorts: node.dynamicPorts.map((port) => ({ ...port, value: cloneJsonValue(port.value) })),
      }
    : {
        ...node,
        position: { ...node.position },
        properties: cloneJsonObject(node.properties),
        dynamicPorts: node.dynamicPorts.map((port) => ({ ...port, value: cloneJsonValue(port.value) })),
      };
}

export function cloneEdge(edge: GraphEdge): GraphEdge {
  return { ...edge, source: { ...edge.source }, target: { ...edge.target } };
}

export function removeOwnedGraph(document: MutableGraphDocument, graphId: string): void {
  const graph = document.graphs.find((candidate) => candidate.id === graphId);
  graph?.nodes.forEach((node) => {
    if (node.kind === "subgraph") {
      removeOwnedGraph(document, node.subgraphId);
    }
  });
  document.graphs = document.graphs.filter((candidate) => candidate.id !== graphId);
}

export function allNodes(document: GraphDocument): readonly GraphNode[] {
  return document.graphs.flatMap((graph) => graph.nodes);
}

export function allEdges(document: GraphDocument): readonly GraphEdge[] {
  return document.graphs.flatMap((graph) => graph.edges);
}

export function edgeUsesNode(edge: GraphEdge, nodeId: string): boolean {
  return (edge.source.kind === "node" && edge.source.nodeId === nodeId)
    || (edge.target.kind === "node" && edge.target.nodeId === nodeId);
}

export function edgeUsesNodePort(edge: GraphEdge, nodeId: string, portId: string): boolean {
  return (edge.source.kind === "node" && edge.source.nodeId === nodeId && edge.source.portId === portId)
    || (edge.target.kind === "node" && edge.target.nodeId === nodeId && edge.target.portId === portId);
}

export function edgeUsesAtomicNodeResolvedPort(
  edge: GraphEdge,
  node: GraphTypedNode,
  port: GraphResolvedPort,
  nodeType: GraphNodeTypeDefinition,
): boolean {
  const sourceMatches = edge.source.kind === "node"
    && edge.source.nodeId === node.id
    && resolveTypedNodePort(node, nodeType, edge.source.portId)?.id === port.id;
  const targetMatches = edge.target.kind === "node"
    && edge.target.nodeId === node.id
    && resolveTypedNodePort(node, nodeType, edge.target.portId)?.id === port.id;
  return sourceMatches || targetMatches;
}

export function edgeUsesInterfacePort(edge: GraphEdge, portId: string): boolean {
  return (edge.source.kind === "interface" && edge.source.portId === portId)
    || (edge.target.kind === "interface" && edge.target.portId === portId);
}

export function sameConnection(left: GraphEdge, right: GraphEdge): boolean {
  return left.kind === right.kind && sameEndpoint(left.source, right.source) && sameEndpoint(left.target, right.target);
}

export function sameEndpoint(left: GraphEndpoint, right: GraphEndpoint): boolean {
  return left.kind === right.kind
    && left.portId === right.portId
    && (left.kind === "interface" || (right.kind === "node" && left.nodeId === right.nodeId));
}

export function endpointKey(endpoint: GraphEndpoint, resolvedPortId = endpoint.portId): string {
  return endpoint.kind === "node"
    ? `${endpoint.kind}:${endpoint.nodeId}:${resolvedPortId}`
    : `${endpoint.kind}:${resolvedPortId}`;
}

export function serializeEndpoint(endpoint: GraphEndpoint): GraphEndpoint {
  return endpoint.kind === "node"
    ? { kind: endpoint.kind, nodeId: endpoint.nodeId, portId: endpoint.portId }
    : { kind: endpoint.kind, portId: endpoint.portId };
}

export function matchesDynamicPortValue(value: JsonValue, group: GraphDynamicPortGroupDefinition): boolean {
  return !validateFieldValue(value as import("@visualbridge/module-sdk").JsonValue, group.item, "value")
    .some((diagnostic) => diagnostic.severity === "error");
}

export function hasPropertyValue(
  properties: Readonly<Record<string, JsonValue>>,
  definition: FieldDefinition,
): boolean {
  return [definition.id, ...definition.aliases].some((propertyId) => properties[propertyId] !== undefined);
}
