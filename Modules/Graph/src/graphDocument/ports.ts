// Port resolution and Graph-Type compatibility helpers.
import {
  isNodeTypeAllowed,
  matchesNodeSelector,
  resolveDynamicPortGroup,
  resolveGraphType,
  resolveListPortDefinition,
  resolveNodeType,
  resolvePortDefinition,
  type GraphCatalogRegistry,
  type GraphNodeTypeDefinition,
} from "../graphCatalog";
import { EMPTY_CATALOG } from "./factory";
import type {
  GraphAtomicNode,
  GraphDefinition,
  GraphDocument,
  GraphNode,
  GraphResolvedPort,
  GraphSubgraphNode,
  GraphTypedNode,
} from "./types";


export function getGraphNodePorts(
  document: GraphDocument,
  node: GraphNode,
  catalog?: GraphCatalogRegistry,
): readonly GraphResolvedPort[] {
  if (node.kind === "node") {
    const nodeType = resolveNodeType(catalog ?? EMPTY_CATALOG, node.nodeTypeId);
    return nodeType === undefined ? [] : getAtomicNodePorts(node, nodeType);
  }
  const interfacePorts = document.graphs.find((graph) => graph.id === node.subgraphId)?.interfacePorts ?? [];
  if (node.nodeTypeId === undefined) {
    return interfacePorts;
  }
  const nodeType = resolveNodeType(catalog ?? EMPTY_CATALOG, node.nodeTypeId);
  return nodeType === undefined
    ? interfacePorts
    : [...getTypedNodePorts(node as GraphSubgraphNode & { readonly nodeTypeId: string }, nodeType), ...interfacePorts];
}

export function isNodeTypeAllowedForGraph(
  graph: GraphDefinition,
  nodeType: GraphNodeTypeDefinition,
  catalog: GraphCatalogRegistry,
): boolean {
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphType(catalog, graph.graphTypeId);
  return graphType === undefined || isNodeTypeAllowed(graphType, nodeType);
}

export function replacementRespectsNodeConstraints(
  graph: GraphDefinition,
  node: GraphTypedNode,
  targetType: GraphNodeTypeDefinition,
  catalog: GraphCatalogRegistry,
): boolean {
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphType(catalog, graph.graphTypeId);
  if (graphType === undefined) {
    return true;
  }
  const sourceType = resolveNodeType(catalog, node.nodeTypeId);
  return graphType.nodeConstraints.every((constraint) => {
    const before = graph.nodes.filter((candidate) => {
      const candidateType = candidate.nodeTypeId === undefined ? undefined : resolveNodeType(catalog, candidate.nodeTypeId);
      return candidateType !== undefined && matchesNodeSelector(candidateType, constraint.selector);
    }).length;
    const after = before
      - (sourceType !== undefined && matchesNodeSelector(sourceType, constraint.selector) ? 1 : 0)
      + (matchesNodeSelector(targetType, constraint.selector) ? 1 : 0);
    return (constraint.minInstances === undefined || after >= constraint.minInstances)
      && (constraint.maxInstances === undefined || after <= constraint.maxInstances);
  });
}

export function getAtomicNodePorts(
  node: GraphAtomicNode,
  nodeType: GraphNodeTypeDefinition,
): readonly GraphResolvedPort[] {
  return getTypedNodePorts(node, nodeType);
}

export function getTypedNodePorts(
  node: GraphAtomicNode | (GraphSubgraphNode & { readonly nodeTypeId: string }),
  nodeType: GraphNodeTypeDefinition,
): readonly GraphResolvedPort[] {
  return [
    ...nodeType.ports,
    ...nodeType.dynamicPortGroups.flatMap((group) => {
      const port = group.listPortMode === "list"
        ? resolveListPortDefinition(nodeType, group.id)
        : undefined;
      return port === undefined ? [] : [port];
    }),
    ...node.dynamicPorts.flatMap((dynamicPort) => {
      const group = resolveDynamicPortGroup(nodeType, dynamicPort.groupId);
      return group === undefined || group.listPortMode === "list"
        ? []
        : [{
            id: dynamicPort.id,
            title: dynamicPort.title,
            kind: group.port.kind,
            direction: group.port.direction,
            ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
            ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
          }];
    }),
  ];
}

export function resolveTypedNodePort(
  node: GraphAtomicNode | (GraphSubgraphNode & { readonly nodeTypeId: string }),
  nodeType: GraphNodeTypeDefinition,
  portId: string,
): GraphResolvedPort | undefined {
  return resolvePortDefinition(nodeType, portId)
    ?? resolveListPortDefinition(nodeType, portId)
    ?? getTypedNodePorts(node, nodeType).find((port) => port.id === portId);
}

export function resolveAtomicNodePort(
  node: GraphAtomicNode,
  nodeType: GraphNodeTypeDefinition,
  portId: string,
): GraphResolvedPort | undefined {
  return resolvePortDefinition(nodeType, portId)
    ?? getAtomicNodePorts(node, nodeType).find((port) => port.id === portId);
}
