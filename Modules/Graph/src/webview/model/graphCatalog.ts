import {
  compareUtf16CodeUnits,
  createDefaultProperties as createDefaultFieldProperties,
  type JsonValue,
} from "@visualbridge/module-sdk";
import { INTERFACE_INPUT_NODE_ID, INTERFACE_OUTPUT_NODE_ID } from "../runtime";
import type {
  ConnectionCandidateEndpoint,
  ConnectionNodeOption,
  ConnectionPlan,
  DeleteSelectionPlan,
  DynamicPortGroupDefinition,
  GraphCatalogRegistry,
  GraphDefinition,
  GraphDocument,
  GraphEdgeModel,
  GraphEndpoint,
  GraphNodeModel,
  GraphPosition,
  GraphTypeDefinition,
  NodeSelector,
  NodeTypeDefinition,
  PortDefinition,
  PortDirection,
  Selection,
  SubgraphTypeOption,
} from "../types";

export function createDefaultProperties(nodeType: NodeTypeDefinition): Readonly<Record<string, JsonValue>> {
  return createDefaultFieldProperties(nodeType.properties);
}

export function createDefaultGraphProperties(graphType: GraphTypeDefinition): Readonly<Record<string, JsonValue>> {
  return createDefaultFieldProperties(graphType.properties);
}

export function resolveNodeTypeDefinition(registry: GraphCatalogRegistry, nodeTypeId: string): NodeTypeDefinition | undefined {
  return registry.nodeTypes.find((nodeType) => nodeType.id === nodeTypeId || nodeType.aliases.includes(nodeTypeId));
}

export function resolveGraphTypeDefinition(registry: GraphCatalogRegistry, graphTypeId: string): GraphTypeDefinition | undefined {
  return registry.graphTypes.find((graphType) => graphType.id === graphTypeId || graphType.aliases.includes(graphTypeId));
}

function matchesNodeSelectorDefinition(nodeType: NodeTypeDefinition, selector: NodeSelector): boolean {
  const nodeTypeMatch = selector.nodeTypeIds === undefined
    || selector.nodeTypeIds.some((id) => id === nodeType.id || nodeType.aliases.includes(id));
  const tagMatch = selector.tags === undefined
    || selector.tags.some((tag) => nodeType.tags?.includes(tag) ?? false);
  const traitMatch = selector.traits === undefined
    || selector.traits.every((trait) => nodeType.traits?.includes(trait) ?? false);
  return nodeTypeMatch && tagMatch && traitMatch;
}

export function isNodeTypeAvailable(
  graph: GraphDefinition,
  nodeType: NodeTypeDefinition,
  catalogRegistry: GraphCatalogRegistry,
  flavor: "atomic" | "subgraph",
): boolean {
  if ((flavor === "atomic") === (nodeType.subgraph !== undefined)) {
    return false;
  }
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  if (graphType !== undefined && !graphType.supportedCatalogIds.includes(nodeType.catalogId)) {
    return false;
  }
  if (
    graphType?.allowedNodeSelectors !== undefined
    && !graphType.allowedNodeSelectors.some((selector) => matchesNodeSelectorDefinition(nodeType, selector))
  ) {
    return false;
  }
  return graphType?.nodeConstraints.every((constraint) => {
    if (constraint.maxInstances === undefined || !matchesNodeSelectorDefinition(nodeType, constraint.selector)) {
      return true;
    }
    const count = graph.nodes.filter((node) => {
      const currentType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
      return currentType !== undefined && matchesNodeSelectorDefinition(currentType, constraint.selector);
    }).length;
    return count < constraint.maxInstances;
  }) ?? true;
}

export function isNodeTypeRequiredByGraph(
  graph: GraphDefinition,
  nodeType: NodeTypeDefinition,
  catalogRegistry: GraphCatalogRegistry,
): boolean {
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  return graphType?.nodeConstraints.some((constraint) =>
    (constraint.minInstances ?? 0) > 0
    && constraint.maxInstances === 1
    && matchesNodeSelectorDefinition(nodeType, constraint.selector),
  ) ?? false;
}

export function planDeleteSelection(
  graph: GraphDefinition,
  selection: Selection,
  catalogRegistry: GraphCatalogRegistry,
): DeleteSelectionPlan {
  const selectedNodeIds = new Set(selection.nodeIds);
  const selectedEdgeIds = new Set(selection.edgeIds);
  const graphType = graph.graphTypeId === undefined
    ? undefined
    : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  const constrainedCounts = (graphType?.nodeConstraints ?? []).flatMap((constraint) => {
    const minimum = constraint.minInstances ?? 0;
    return minimum === 0 ? [] : [{
      constraint,
      minimum,
      remaining: graph.nodes.filter((node) => {
        const nodeType = node.nodeTypeId === undefined
          ? undefined
          : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
        return nodeType !== undefined && matchesNodeSelectorDefinition(nodeType, constraint.selector);
      }).length,
    }];
  });
  const nodeIds: string[] = [];
  const retainedNodeIds: string[] = [];
  for (const node of graph.nodes) {
    if (!selectedNodeIds.has(node.id)) {
      continue;
    }
    const nodeType = node.nodeTypeId === undefined
      ? undefined
      : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
    const matchingConstraints = nodeType === undefined
      ? []
      : constrainedCounts.filter(({ constraint }) => matchesNodeSelectorDefinition(nodeType, constraint.selector));
    if (matchingConstraints.some(({ minimum, remaining }) => remaining <= minimum)) {
      retainedNodeIds.push(node.id);
      continue;
    }
    nodeIds.push(node.id);
    matchingConstraints.forEach((count) => {
      count.remaining -= 1;
    });
  }
  return {
    nodeIds,
    edgeIds: graph.edges.filter((edge) => selectedEdgeIds.has(edge.id)).map((edge) => edge.id),
    retainedNodeIds,
  };
}

export function getConnectionNodeOptions(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  fromPort: PortDefinition,
  fromRole: "source" | "target",
): readonly ConnectionNodeOption[] {
  const requiredDirection: PortDirection = fromRole === "source" ? "input" : "output";
  return catalogRegistry.nodeTypes.flatMap((nodeType) => {
    if (!isNodeTypeAvailable(graph, nodeType, catalogRegistry, "atomic")) {
      return [];
    }
    const creationPorts: readonly PortDefinition[] = [
      ...nodeType.ports,
      ...(nodeType.dynamicPortGroups ?? []).flatMap((group) => group.listPortMode === "list"
        ? [{
            id: group.id,
            aliases: group.aliases,
            title: group.title,
            kind: group.port.kind,
            direction: group.port.direction,
            ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
            ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
          }]
        : []),
    ];
    return creationPorts.flatMap((port) => {
      if (port.direction !== requiredDirection || port.kind !== fromPort.kind) {
        return [];
      }
      const sourcePort = fromRole === "source" ? fromPort : port;
      const targetPort = fromRole === "source" ? port : fromPort;
      return arePortsCompatible(catalogRegistry, sourcePort, targetPort) ? [{ nodeType, port }] : [];
    });
  // Localized title collation is UI-only; the selected IDs remain the semantic payload.
  }).sort((left, right) =>
    left.nodeType.title.localeCompare(right.nodeType.title)
    || left.port.title.localeCompare(right.port.title),
  );
}

function arePortsCompatible(
  catalogRegistry: GraphCatalogRegistry,
  sourcePort: PortDefinition,
  targetPort: PortDefinition,
): boolean {
  if (sourcePort.kind !== targetPort.kind || sourcePort.direction !== "output" || targetPort.direction !== "input") {
    return false;
  }
  if (sourcePort.kind !== "data" || sourcePort.dataTypeId === undefined || targetPort.dataTypeId === undefined) {
    return true;
  }
  if (
    sourcePort.dataTypeId === targetPort.dataTypeId
    || sourcePort.dataTypeId === "any"
    || targetPort.dataTypeId === "any"
  ) {
    return true;
  }
  const targetDataType = catalogRegistry.dataTypes.find(
    (dataType) => dataType.id === targetPort.dataTypeId,
  );
  return targetDataType?.acceptsAnySource === true
    || targetDataType?.accepts.includes(sourcePort.dataTypeId) === true;
}

export function planConnectionCandidate(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  source: ConnectionCandidateEndpoint,
  target: ConnectionCandidateEndpoint,
): ConnectionPlan {
  if (!arePortsCompatible(catalogRegistry, source.port, target.port)) {
    return {
      replacementEdgeIds: [],
      issue: source.port.kind !== target.port.kind
        ? "流程端口和数据端口不能互相连接。"
        : source.port.kind === "data"
          ? `数据类型“${source.port.dataTypeId ?? "any"}”不能连接到“${target.port.dataTypeId ?? "any"}”。`
          : "端口方向不兼容。",
    };
  }
  const sourceEndpoint = toGraphEndpoint(source.canvasNodeId, source.portId);
  const targetEndpoint = toGraphEndpoint(target.canvasNodeId, target.portId);
  if (graph.edges.some((edge) =>
    endpointsEquivalent(edge.source, sourceEndpoint, graph, catalogRegistry)
    && endpointsEquivalent(edge.target, targetEndpoint, graph, catalogRegistry),
  )) {
    return { replacementEdgeIds: [], issue: "这两个端口之间已经存在连接。" };
  }
  const replacementEdgeIds = new Set([
    ...getReplaceableConnectionEdgeIds(graph, catalogRegistry, source, "source"),
    ...getReplaceableConnectionEdgeIds(graph, catalogRegistry, target, "target"),
  ]);
  const issue = getConnectionCapacityIssue(graph, catalogRegistry, source, "source", replacementEdgeIds)
    ?? getConnectionCapacityIssue(graph, catalogRegistry, target, "target", replacementEdgeIds);
  return {
    replacementEdgeIds: [...replacementEdgeIds].sort(compareUtf16CodeUnits),
    ...(issue === undefined ? {} : { issue }),
  };
}

function endpointsEquivalent(
  left: GraphEndpoint,
  right: GraphEndpoint,
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "node" && right.kind === "node" && left.nodeId !== right.nodeId) {
    return false;
  }
  return canonicalCanvasPortId(left, graph, catalogRegistry) === canonicalCanvasPortId(right, graph, catalogRegistry);
}

export function getEffectiveMaxConnections(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  port: PortDefinition,
): number | undefined {
  const graphType = graph.graphTypeId === undefined
    ? undefined
    : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  const graphTypeLimit = graphType?.portConnectionRules[port.direction] === "single" ? 1 : undefined;
  if (graphTypeLimit === undefined) {
    return port.maxConnections;
  }
  return port.maxConnections === undefined ? graphTypeLimit : Math.min(graphTypeLimit, port.maxConnections);
}

export function getConnectionCapacityIssue(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  endpoint: ConnectionCandidateEndpoint,
  role: "source" | "target",
  ignoredEdgeIds: ReadonlySet<string> = new Set(),
): string | undefined {
  const maxConnections = getEffectiveMaxConnections(graph, catalogRegistry, endpoint.port);
  if (
    maxConnections === undefined
    || countCanvasPortConnections(
      graph,
      catalogRegistry,
      endpoint.canvasNodeId,
      endpoint.portId,
      role,
      ignoredEdgeIds,
    ) < maxConnections
  ) {
    return undefined;
  }
  return `${role === "source" ? "输出" : "输入"}端口“${endpoint.port.title}”已达到最大连接数。`;
}

function getReplaceableConnectionEdgeIds(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  endpoint: ConnectionCandidateEndpoint,
  role: "source" | "target",
): readonly string[] {
  return getEffectiveMaxConnections(graph, catalogRegistry, endpoint.port) === 1
    ? findCanvasPortConnections(graph, catalogRegistry, endpoint.canvasNodeId, endpoint.portId, role).map((edge) => edge.id)
    : [];
}

function countCanvasPortConnections(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  canvasNodeId: string,
  portId: string,
  role: "source" | "target",
  ignoredEdgeIds: ReadonlySet<string> = new Set(),
): number {
  return findCanvasPortConnections(graph, catalogRegistry, canvasNodeId, portId, role, ignoredEdgeIds).length;
}

function findCanvasPortConnections(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  canvasNodeId: string,
  portId: string,
  role: "source" | "target",
  ignoredEdgeIds: ReadonlySet<string> = new Set(),
): readonly GraphEdgeModel[] {
  const requestedEndpoint = toGraphEndpoint(canvasNodeId, portId);
  const canonicalPortId = canonicalCanvasPortId(requestedEndpoint, graph, catalogRegistry);
  return graph.edges.filter((edge) => {
    if (ignoredEdgeIds.has(edge.id)) {
      return false;
    }
    const endpoint = role === "source" ? edge.source : edge.target;
    if (endpoint.kind !== requestedEndpoint.kind) {
      return false;
    }
    if (
      endpoint.kind === "node"
      && requestedEndpoint.kind === "node"
      && endpoint.nodeId !== requestedEndpoint.nodeId
    ) {
      return false;
    }
    return canonicalCanvasPortId(endpoint, graph, catalogRegistry) === canonicalPortId;
  });
}

export function eventClientPosition(event: MouseEvent | TouchEvent): GraphPosition | undefined {
  if (event instanceof MouseEvent) {
    return { x: event.clientX, y: event.clientY };
  }
  const touch = event.changedTouches.item(0) ?? event.touches.item(0);
  return touch === null ? undefined : { x: touch.clientX, y: touch.clientY };
}

export function getSubgraphOptions(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
): readonly SubgraphTypeOption[] {
  const parentType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  if (parentType !== undefined && !parentType.allowSubgraphs) {
    return [];
  }
  const graphTypes = catalogRegistry.graphTypes.filter((graphType) => {
    if (graphType.usage === "root") {
      return false;
    }
    return parentType?.allowedSubgraphTypeIds === undefined
      || parentType.allowedSubgraphTypeIds.some((id) => resolveGraphTypeDefinition(catalogRegistry, id)?.id === graphType.id);
  });
  return catalogRegistry.nodeTypes.flatMap((nodeType) => {
    if (nodeType.subgraph === undefined || !isNodeTypeAvailable(graph, nodeType, catalogRegistry, "subgraph")) {
      return [];
    }
    return graphTypes.flatMap((graphType) => (
      nodeType.subgraph?.graphTypeIds === undefined
      || nodeType.subgraph.graphTypeIds.some((id) => resolveGraphTypeDefinition(catalogRegistry, id)?.id === graphType.id)
        ? [{ graphType, nodeType }]
        : []
    ));
  });
}

export function canonicalCanvasPortId(
  endpoint: GraphEndpoint,
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
): string {
  if (endpoint.kind === "interface") {
    return endpoint.portId;
  }
  const node = graph.nodes.find((candidate) => candidate.id === endpoint.nodeId);
  if (node?.nodeTypeId === undefined) {
    return endpoint.portId;
  }
  const nodeType = resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
  const staticPortId = nodeType?.ports.find(
    (port) => port.id === endpoint.portId || (port.aliases?.includes(endpoint.portId) ?? false),
  )?.id;
  if (staticPortId !== undefined) {
    return staticPortId;
  }
  return nodeType?.dynamicPortGroups?.find((group) =>
    group.listPortMode === "list"
    && (group.id === endpoint.portId || group.aliases.includes(endpoint.portId)),
  )?.id ?? endpoint.portId;
}

export function portsForNode(
  document: GraphDocument,
  graph: GraphDefinition,
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition | undefined,
): readonly PortDefinition[] {
  if (node.kind === "subgraph") {
    const interfacePorts = document.graphs.find((candidate) => candidate.id === node.subgraphId)?.interfacePorts ?? [];
    if (nodeType !== undefined) {
      return [...typedNodePorts(node, nodeType), ...interfacePorts];
    }
    const interfaceIds = new Set(interfacePorts.map((port) => port.id));
    return [...interfacePorts, ...inferUnknownNodePorts(graph, node.id).filter((port) => !interfaceIds.has(port.id))];
  }
  if (nodeType !== undefined) {
    return typedNodePorts(node, nodeType);
  }
  return inferUnknownNodePorts(graph, node.id);
}

function inferUnknownNodePorts(graph: GraphDefinition, nodeId: string): readonly PortDefinition[] {
  const used = new Map<string, PortDefinition>();
  graph.edges.forEach((edge) => {
    if (edge.source.kind === "node" && edge.source.nodeId === nodeId) {
      used.set(`output:${edge.source.portId}`, { id: edge.source.portId, title: edge.source.portId, kind: edge.kind, direction: "output", ...(edge.kind === "data" ? { dataTypeId: "any" } : {}) });
    }
    if (edge.target.kind === "node" && edge.target.nodeId === nodeId) {
      used.set(`input:${edge.target.portId}`, { id: edge.target.portId, title: edge.target.portId, kind: edge.kind, direction: "input", ...(edge.kind === "data" ? { dataTypeId: "any" } : {}) });
    }
  });
  return [...used.values()];
}

function typedNodePorts(
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition,
): readonly PortDefinition[] {
  return [
    ...nodeType.ports,
    ...(nodeType.dynamicPortGroups ?? []).flatMap((group) => group.listPortMode === "list"
      ? [{
          id: group.id,
          aliases: group.aliases,
          title: group.title,
          kind: group.port.kind,
          direction: group.port.direction,
          ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
          ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
        }]
      : []),
    ...node.dynamicPorts.flatMap((dynamicPort) => {
      const group = resolveDynamicPortGroupDefinition(nodeType, dynamicPort.groupId);
      return group === undefined || group.listPortMode === "list"
        ? []
        : [{
            id: dynamicPort.id,
            aliases: [],
            title: dynamicPort.title,
            kind: group.port.kind,
            direction: group.port.direction,
            ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
            ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
          }];
    }),
  ];
}

export function overriddenNodeProperties(
  graph: GraphDefinition,
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition | undefined,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (nodeType === undefined) {
    return result;
  }
  graph.edges.forEach((edge) => {
    if (edge.kind !== "data" || edge.target.kind !== "node" || edge.target.nodeId !== node.id) {
      return;
    }
    const port = nodeType.ports.find(
      (candidate) => candidate.id === edge.target.portId || (candidate.aliases?.includes(edge.target.portId) ?? false),
    );
    if (port?.direction !== "input") {
      return;
    }
    const portIds = new Set([port.id, ...(port.aliases ?? [])]);
    nodeType.properties.forEach((property) => {
      if ([property.id, ...(property.aliases ?? [])].some((propertyId) => portIds.has(propertyId))) {
        result.add(property.id);
      }
    });
  });
  return result;
}

export function connectedNodeInputPorts(
  document: GraphDocument,
  graph: GraphDefinition,
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition | undefined,
): ReadonlySet<string> {
  const ports = portsForNode(document, graph, node, nodeType);
  const result = new Set<string>();
  graph.edges.forEach((edge) => {
    if (edge.target.kind !== "node" || edge.target.nodeId !== node.id) {
      return;
    }
    const port = ports.find((candidate) =>
      candidate.id === edge.target.portId || (candidate.aliases?.includes(edge.target.portId) ?? false),
    );
    if (port?.direction === "input") {
      result.add(port.id);
    }
  });
  return result;
}

function resolveDynamicPortGroupDefinition(
  nodeType: NodeTypeDefinition,
  groupId: string,
): DynamicPortGroupDefinition | undefined {
  return nodeType.dynamicPortGroups?.find(
    (group) => group.id === groupId || group.aliases.includes(groupId),
  );
}

export function findCanvasPort(
  document: GraphDocument,
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  canvasNodeId: string,
  portId: string,
  role: "source" | "target",
): PortDefinition | undefined {
  if (canvasNodeId === INTERFACE_INPUT_NODE_ID && role === "source") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === portId && candidate.direction === "input");
    return port === undefined ? undefined : { ...port, direction: "output" };
  }
  if (canvasNodeId === INTERFACE_OUTPUT_NODE_ID && role === "target") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === portId && candidate.direction === "output");
    return port === undefined ? undefined : { ...port, direction: "input", maxConnections: 1 };
  }
  const node = graph.nodes.find((candidate) => candidate.id === canvasNodeId);
  if (node === undefined) {
    return undefined;
  }
  const nodeType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
  return portsForNode(document, graph, node, nodeType).find(
    (port) => port.id === portId || (port.aliases?.includes(portId) ?? false),
  );
}

export function toGraphEndpoint(canvasNodeId: string, portId: string): GraphEndpoint {
  return canvasNodeId === INTERFACE_INPUT_NODE_ID || canvasNodeId === INTERFACE_OUTPUT_NODE_ID
    ? { kind: "interface", portId }
    : { kind: "node", nodeId: canvasNodeId, portId };
}

export function emptyCatalogRegistry(): GraphCatalogRegistry {
  return { catalogs: [], dataTypes: [], graphTypes: [], nodeTypes: [] };
}
