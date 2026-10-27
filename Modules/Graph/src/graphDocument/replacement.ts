// Lossless node type replacement candidate and compatibility checks.
import { validateFieldValue } from "@visualbridge/module-sdk";
import {
  isDataTypeAssignable,
  resolveDynamicPortGroup,
  resolveGraphType,
  resolveListPortDefinition,
  resolveNodeType,
  resolvePortDefinition,
  resolvePropertyDefinition,
  type GraphCatalogRegistry,
  type GraphNodeTypeDefinition,
} from "../graphCatalog";
import { edgeUsesAtomicNodeResolvedPort, edgeUsesNode, matchesDynamicPortValue } from "./mutable";
import {
  getTypedNodePorts,
  isNodeTypeAllowedForGraph,
  replacementRespectsNodeConstraints,
  resolveTypedNodePort,
} from "./ports";
import type {
  GraphDefinition,
  GraphDocument,
  GraphResolvedPort,
  GraphTypedNode,
} from "./types";
import { getEffectiveMaxConnections, resolveEndpoint } from "./validationEdges";


export function getReplacementCandidates(
  document: GraphDocument,
  graphId: string,
  nodeId: string,
  catalog: GraphCatalogRegistry,
): readonly GraphNodeTypeDefinition[] {
  const graph = document.graphs.find((candidate) => candidate.id === graphId);
  const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
  if (graph === undefined || node === undefined || node.nodeTypeId === undefined) {
    return [];
  }
  const typedNode = node as GraphTypedNode;
  const currentTypeId = resolveNodeType(catalog, node.nodeTypeId)?.id ?? node.nodeTypeId;
  return catalog.nodeTypes.filter(
    (targetType) => targetType.id !== currentTypeId
      && (targetType.subgraph !== undefined) === (node.kind === "subgraph")
      && isNodeTypeAllowedForGraph(graph, targetType, catalog)
      && replacementRespectsNodeConstraints(graph, typedNode, targetType, catalog)
      && replacementIssue(document, graph, typedNode, targetType, catalog) === undefined,
  );
}

export function replacementIssue(
  document: GraphDocument,
  graph: GraphDefinition,
  node: GraphTypedNode,
  targetType: GraphNodeTypeDefinition,
  catalog: GraphCatalogRegistry,
): string | undefined {
  const childGraph = node.kind === "subgraph"
    ? document.graphs.find((candidate) => candidate.id === node.subgraphId)
    : undefined;
  if (node.kind === "subgraph") {
    const childType = childGraph?.graphTypeId === undefined ? undefined : resolveGraphType(catalog, childGraph.graphTypeId);
    if (
      childType !== undefined
      && targetType.subgraph?.graphTypeIds !== undefined
      && !targetType.subgraph.graphTypeIds.some((id) => resolveGraphType(catalog, id)?.id === childType.id)
    ) {
      return `Subgraph node type '${targetType.title}' cannot contain Graph Type '${childType.id}'.`;
    }
    const interfacePortIds = new Set(childGraph?.interfacePorts.map((port) => port.id) ?? []);
    const targetPortIds = new Set<string>();
    getTypedNodePorts(node, targetType).forEach((port) => {
      targetPortIds.add(port.id);
      resolvePortDefinition(targetType, port.id)?.aliases.forEach((alias) => targetPortIds.add(alias));
    });
    if ([...interfacePortIds].some((portId) => targetPortIds.has(portId))) {
      return `A static or dynamic port on '${targetType.title}' collides with the child graph interface.`;
    }
  }
  for (const propertyId of Object.keys(node.properties)) {
    const property = resolvePropertyDefinition(targetType, propertyId);
    if (property === undefined) {
      return `Property '${propertyId}' is not supported by '${targetType.title}'.`;
    }
    const value = node.properties[propertyId];
    if (
      value !== undefined
      && validateFieldValue(value as import("@visualbridge/module-sdk").JsonValue, property, propertyId)
        .some((diagnostic) => diagnostic.severity === "error")
    ) {
      return `Property '${propertyId}' is incompatible with '${targetType.title}'.`;
    }
  }
  const dynamicGroupCounts = new Map<string, number>();
  for (const dynamicPort of node.dynamicPorts) {
    if (resolvePortDefinition(targetType, dynamicPort.id) !== undefined) {
      return `Dynamic port '${dynamicPort.id}' collides with a static port on '${targetType.title}'.`;
    }
    if (resolveListPortDefinition(targetType, dynamicPort.id) !== undefined) {
      return `Dynamic item '${dynamicPort.id}' collides with a whole-List port on '${targetType.title}'.`;
    }
    const group = resolveDynamicPortGroup(targetType, dynamicPort.groupId);
    if (group === undefined) {
      return `Dynamic port group '${dynamicPort.groupId}' is not supported by '${targetType.title}'.`;
    }
    if (!matchesDynamicPortValue(dynamicPort.value, group)) {
      return `Dynamic port '${dynamicPort.id}' value is incompatible with '${targetType.title}'.`;
    }
    dynamicGroupCounts.set(group.id, (dynamicGroupCounts.get(group.id) ?? 0) + 1);
  }
  for (const group of targetType.dynamicPortGroups) {
    if (group.maxItems !== undefined && (dynamicGroupCounts.get(group.id) ?? 0) > group.maxItems) {
      return `Dynamic port group '${group.id}' exceeds the limit on '${targetType.title}'.`;
    }
  }
  const connected = graph.edges.filter((edge) => edgeUsesNode(edge, node.id));
  const nodeById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const graphById = new Map(document.graphs.map((candidate) => [candidate.id, candidate]));
  const replacementPort = (portId: string): GraphResolvedPort | undefined =>
    resolveTypedNodePort(node, targetType, portId)
    ?? childGraph?.interfacePorts.find((port) => port.id === portId);
  for (const edge of connected) {
    const sourceMatches = edge.source.kind === "node" && edge.source.nodeId === node.id;
    const targetMatches = edge.target.kind === "node" && edge.target.nodeId === node.id;
    const sourcePort = sourceMatches
      ? replacementPort(edge.source.portId)
      : resolveEndpoint(graph, edge.source, nodeById, graphById, catalog).port;
    const targetPort = targetMatches
      ? replacementPort(edge.target.portId)
      : resolveEndpoint(graph, edge.target, nodeById, graphById, catalog).port;
    if (sourcePort === undefined || sourcePort.kind !== edge.kind || sourcePort.direction !== "output") {
      return `Connected source port '${edge.source.portId}' is incompatible with '${targetType.title}'.`;
    }
    if (targetPort === undefined || targetPort.kind !== edge.kind || targetPort.direction !== "input") {
      return `Connected target port '${edge.target.portId}' is incompatible with '${targetType.title}'.`;
    }
    if (
      edge.kind === "data"
      && sourcePort.dataTypeId !== undefined
      && targetPort.dataTypeId !== undefined
      && !isDataTypeAssignable(catalog, sourcePort.dataTypeId, targetPort.dataTypeId)
    ) {
      return `Connected data ports are incompatible with '${targetType.title}'.`;
    }
  }
  for (const port of getTypedNodePorts(node, targetType)) {
    const maxConnections = getEffectiveMaxConnections(graph, port, catalog);
    if (maxConnections === undefined) {
      continue;
    }
    const connectionCount = connected.filter(
      (edge) => edgeUsesAtomicNodeResolvedPort(edge, node, port, targetType),
    ).length;
    if (connectionCount > maxConnections) {
      return `Port '${port.id}' allows ${maxConnections} connections but currently has ${connectionCount}.`;
    }
  }
  return undefined;
}
