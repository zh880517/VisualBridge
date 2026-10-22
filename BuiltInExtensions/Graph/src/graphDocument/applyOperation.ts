// Individual Graph operation application and structural mutation helpers.
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  resolveDynamicPortGroup,
  resolveGraphType,
  resolveListPortDefinition,
  resolveNodeType,
  resolvePortDefinition,
  type GraphCatalogRegistry,
} from "../graphCatalog";
import { error } from "./diagnostics";
import { cloneJsonObject, cloneJsonValue } from "./json";
import {
  allEdges,
  allNodes,
  cloneEdge,
  cloneGraph,
  cloneNode,
  edgeUsesInterfacePort,
  edgeUsesNode,
  edgeUsesNodePort,
  hasPropertyValue,
  matchesDynamicPortValue,
  removeOwnedGraph,
} from "./mutable";
import { replacementIssue } from "./replacement";
import type {
  GraphEdge,
  GraphEndpoint,
  GraphOperation,
  GraphTypedNode,
  JsonValue,
  MutableGraphDefinition,
  MutableGraphDocument,
  MutableGraphInterfacePort,
  MutableGraphSubgraphNode,
} from "./types";
import { resolveEndpoint, validateSemanticEdge } from "./validationEdges";


export function applyOperation(
  document: MutableGraphDocument,
  operation: GraphOperation,
  index: number,
  catalog?: GraphCatalogRegistry,
): DocumentDiagnostic | undefined {
  const path = `operations[${index}]`;
  const graph = document.graphs.find((candidate) => candidate.id === operation.graphId);
  if (graph === undefined) {
    return error("graph.graphNotFound", `${path}.graphId`, `Graph '${operation.graphId}' does not exist.`);
  }
  switch (operation.type) {
    case "graph.renameElement":
      return renameElement(document, graph, operation, path);
    case "graph.addNode":
      if (allNodes(document).some((node) => node.id === operation.node.id)) {
        return error("graph.nodeAlreadyExists", path, `Node '${operation.node.id}' already exists.`);
      }
      if (catalog !== undefined) {
        const nodeType = resolveNodeType(catalog, operation.node.nodeTypeId);
        if (nodeType === undefined) {
          return error("graph.unknownNodeType", `${path}.node.nodeTypeId`, `Node type '${operation.node.nodeTypeId}' is not in the catalog.`);
        }
        if (nodeType.subgraph !== undefined) {
          return error("graph.subgraphTypeRequiresSubgraph", `${path}.node.nodeTypeId`, `Node type '${nodeType.id}' must be created as a subgraph.`);
        }
      }
      graph.nodes.push(cloneNode(operation.node));
      return undefined;
    case "graph.addSubgraph":
      if (allNodes(document).some((node) => node.id === operation.node.id)) {
        return error("graph.nodeAlreadyExists", path, `Node '${operation.node.id}' already exists.`);
      }
      if (document.graphs.some((candidate) => candidate.id === operation.subgraph.id)) {
        return error("graph.graphAlreadyExists", path, `Graph '${operation.subgraph.id}' already exists.`);
      }
      if (operation.node.subgraphId !== operation.subgraph.id) {
        return error("graph.subgraphIdMismatch", path, "Subgraph node and embedded graph IDs must match.");
      }
      if (catalog !== undefined && operation.node.nodeTypeId !== undefined) {
        const nodeType = resolveNodeType(catalog, operation.node.nodeTypeId);
        if (nodeType?.subgraph === undefined) {
          return error("graph.invalidSubgraphNodeType", `${path}.node.nodeTypeId`, `Node type '${operation.node.nodeTypeId}' is not a subgraph node type.`);
        }
      }
      graph.nodes.push(cloneNode(operation.node));
      document.graphs.push(cloneGraph(operation.subgraph));
      return undefined;
    case "graph.removeNode": {
      const nodeIndex = graph.nodes.findIndex((node) => node.id === operation.nodeId);
      const node = graph.nodes[nodeIndex];
      if (nodeIndex < 0 || node === undefined) {
        return error("graph.nodeNotFound", path, `Node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      graph.nodes.splice(nodeIndex, 1);
      graph.edges = graph.edges.filter((edge) => !edgeUsesNode(edge, operation.nodeId));
      if (node.kind === "subgraph") {
        removeOwnedGraph(document, node.subgraphId);
      }
      return undefined;
    }
    case "graph.moveNode": {
      const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined) {
        return error("graph.nodeNotFound", path, `Node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      node.position = { ...operation.position };
      return undefined;
    }
    case "graph.updateNode": {
      const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined) {
        return error("graph.nodeNotFound", path, `Node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      node.title = operation.title;
      node.properties = cloneJsonObject(operation.properties);
      return undefined;
    }
    case "graph.replaceNodeType": {
      const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined || node.nodeTypeId === undefined) {
        return error("graph.nodeNotFound", path, `Typed node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      if (catalog === undefined) {
        return error("graph.catalogRequired", path, "A Graph Catalog is required to replace node types.");
      }
      const targetType = resolveNodeType(catalog, operation.nodeTypeId);
      if (targetType === undefined) {
        return error("graph.unknownNodeType", `${path}.nodeTypeId`, `Node type '${operation.nodeTypeId}' is not in the catalog.`);
      }
      if ((targetType.subgraph !== undefined) !== (node.kind === "subgraph")) {
        return error("graph.incompatibleReplacement", path, "Atomic and subgraph node types cannot replace each other.");
      }
      const issue = replacementIssue(document, graph, node as GraphTypedNode, targetType, catalog);
      if (issue !== undefined) {
        return error("graph.incompatibleReplacement", path, issue);
      }
      node.nodeTypeId = targetType.id;
      const nextProperties = cloneJsonObject(node.properties);
      targetType.properties.forEach((property) => {
        if (!hasPropertyValue(nextProperties, property)) {
          nextProperties[property.id] = cloneJsonValue(property.defaultValue as JsonValue);
        }
      });
      node.properties = nextProperties;
      return undefined;
    }
    case "graph.addDynamicPort": {
      const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined || node.nodeTypeId === undefined) {
        return error("graph.nodeNotFound", path, `Typed node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      const nodeType = catalog === undefined ? undefined : resolveNodeType(catalog, node.nodeTypeId);
      if (nodeType === undefined) {
        return error("graph.catalogRequired", path, "A known Catalog node type is required to add a dynamic port.");
      }
      const group = resolveDynamicPortGroup(nodeType, operation.port.groupId);
      if (group === undefined) {
        return error("graph.unknownDynamicPortGroup", `${path}.port.groupId`, `Dynamic port group '${operation.port.groupId}' is not declared by '${nodeType.id}'.`);
      }
      if (
        node.dynamicPorts.some((port) => port.id === operation.port.id)
        || resolvePortDefinition(nodeType, operation.port.id) !== undefined
        || resolveListPortDefinition(nodeType, operation.port.id) !== undefined
      ) {
        return error("graph.dynamicPortAlreadyExists", `${path}.port.id`, `Port id '${operation.port.id}' is already used on node '${node.id}'.`);
      }
      const groupCount = node.dynamicPorts.filter((port) => resolveDynamicPortGroup(nodeType, port.groupId)?.id === group.id).length;
      if (group.maxItems !== undefined && groupCount >= group.maxItems) {
        return error("graph.tooManyDynamicPorts", path, `Dynamic port group '${group.id}' allows at most ${group.maxItems} items.`);
      }
      if (!matchesDynamicPortValue(operation.port.value, group)) {
        return error("graph.dynamicPortValueTypeMismatch", `${path}.port.value`, `Dynamic port value must be ${group.item.valueType}.`);
      }
      node.dynamicPorts.push({ ...operation.port, groupId: group.id, value: cloneJsonValue(operation.port.value) });
      return undefined;
    }
    case "graph.updateDynamicPort": {
      const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined || node.nodeTypeId === undefined) {
        return error("graph.nodeNotFound", path, `Typed node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      const port = node.dynamicPorts.find((candidate) => candidate.id === operation.portId);
      if (port === undefined) {
        return error("graph.dynamicPortNotFound", `${path}.portId`, `Dynamic port '${operation.portId}' does not exist on node '${node.id}'.`);
      }
      const nodeType = catalog === undefined ? undefined : resolveNodeType(catalog, node.nodeTypeId);
      const group = nodeType === undefined ? undefined : resolveDynamicPortGroup(nodeType, port.groupId);
      if (group === undefined) {
        return error("graph.unknownDynamicPortGroup", path, `Dynamic port group '${port.groupId}' cannot be resolved.`);
      }
      if (!matchesDynamicPortValue(operation.value, group)) {
        return error("graph.dynamicPortValueTypeMismatch", `${path}.value`, `Dynamic port value must be ${group.item.valueType}.`);
      }
      port.title = operation.title;
      port.value = cloneJsonValue(operation.value);
      return undefined;
    }
    case "graph.removeDynamicPort": {
      const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined || node.nodeTypeId === undefined) {
        return error("graph.nodeNotFound", path, `Typed node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      const portIndex = node.dynamicPorts.findIndex((candidate) => candidate.id === operation.portId);
      if (portIndex < 0) {
        return error("graph.dynamicPortNotFound", `${path}.portId`, `Dynamic port '${operation.portId}' does not exist on node '${node.id}'.`);
      }
      node.dynamicPorts.splice(portIndex, 1);
      graph.edges = graph.edges.filter((edge) => !edgeUsesNodePort(edge, node.id, operation.portId));
      return undefined;
    }
    case "graph.reorderDynamicPorts": {
      const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined || node.nodeTypeId === undefined) {
        return error("graph.nodeNotFound", path, `Typed node '${operation.nodeId}' does not exist in graph '${graph.id}'.`);
      }
      const existingIds = new Set(node.dynamicPorts.map((port) => port.id));
      const requestedIds = new Set(operation.portIds);
      if (
        requestedIds.size !== operation.portIds.length
        || requestedIds.size !== existingIds.size
        || operation.portIds.some((portId) => !existingIds.has(portId))
      ) {
        return error("graph.invalidDynamicPortOrder", `${path}.portIds`, "Dynamic port order must contain every current port id exactly once.");
      }
      const byId = new Map(node.dynamicPorts.map((port) => [port.id, port]));
      node.dynamicPorts = operation.portIds.flatMap((portId) => {
        const port = byId.get(portId);
        return port === undefined ? [] : [port];
      });
      return undefined;
    }
    case "graph.addEdge":
      if (allEdges(document).some((edge) => edge.id === operation.edge.id)) {
        return error("graph.edgeAlreadyExists", path, `Edge '${operation.edge.id}' already exists.`);
      }
      {
        const lockDiagnostic = lockDynamicInterfacePortsForEdge(document, graph, operation.edge, path, catalog);
        if (lockDiagnostic !== undefined) {
          return lockDiagnostic;
        }
        const edgeDiagnostics: DocumentDiagnostic[] = [];
        const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
        const graphById = new Map(document.graphs.map((candidate) => [candidate.id, candidate]));
        validateSemanticEdge(
          graph,
          operation.edge,
          `${path}.edge`,
          nodeById,
          graphById,
          catalog,
          edgeDiagnostics,
        );
        const blocking = edgeDiagnostics[0];
        if (blocking !== undefined) {
          return error("graph.invalidNewConnection", `${path}.edge`, blocking.message);
        }
      }
      graph.edges.push(cloneEdge(operation.edge));
      return undefined;
    case "graph.removeEdge": {
      const edgeIndex = graph.edges.findIndex((edge) => edge.id === operation.edgeId);
      if (edgeIndex < 0) {
        return error("graph.edgeNotFound", path, `Edge '${operation.edgeId}' does not exist in graph '${graph.id}'.`);
      }
      graph.edges.splice(edgeIndex, 1);
      return undefined;
    }
    case "graph.assignType": {
      if (graph.graphTypeId !== undefined) {
        return error("graph.graphTypeAlreadyAssigned", path, `Graph '${graph.id}' already has type '${graph.graphTypeId}'.`);
      }
      if (catalog === undefined) {
        return error("graph.catalogRequired", path, "A Graph Catalog is required to assign a Graph Type.");
      }
      const graphType = resolveGraphType(catalog, operation.graphTypeId);
      if (graphType === undefined) {
        return error("graph.unknownGraphType", `${path}.graphTypeId`, `Graph type '${operation.graphTypeId}' is not in the catalog.`);
      }
      graph.graphTypeId = graphType.id;
      graphType.properties.forEach((property) => {
        if (!hasPropertyValue(graph.properties, property)) {
          graph.properties[property.id] = cloneJsonValue(property.defaultValue as JsonValue);
        }
      });
      return undefined;
    }
    case "graph.updateGraph":
      graph.title = operation.title;
      graph.properties = cloneJsonObject(operation.properties);
      return undefined;
    case "graph.addInterfacePort":
      if (graph.interfacePorts.some((port) => port.id === operation.port.id)) {
        return error("graph.interfacePortAlreadyExists", path, `Interface port '${operation.port.id}' already exists.`);
      }
      graph.interfacePorts.push({ ...operation.port });
      return undefined;
    case "graph.updateInterfacePort": {
      const port = graph.interfacePorts.find((candidate) => candidate.id === operation.portId);
      if (port === undefined) {
        return error("graph.interfacePortNotFound", path, `Interface port '${operation.portId}' does not exist.`);
      }
      port.title = operation.title;
      return undefined;
    }
    case "graph.removeInterfacePort": {
      const portIndex = graph.interfacePorts.findIndex((port) => port.id === operation.portId);
      if (portIndex < 0) {
        return error("graph.interfacePortNotFound", path, `Interface port '${operation.portId}' does not exist.`);
      }
      graph.interfacePorts.splice(portIndex, 1);
      graph.edges = graph.edges.filter((edge) => !edgeUsesInterfacePort(edge, operation.portId));
      for (const ownerGraph of document.graphs) {
        const ownerNode = ownerGraph.nodes.find(
          (node): node is MutableGraphSubgraphNode => node.kind === "subgraph" && node.subgraphId === graph.id,
        );
        if (ownerNode !== undefined) {
          ownerGraph.edges = ownerGraph.edges.filter(
            (edge) => !edgeUsesNodePort(edge, ownerNode.id, operation.portId),
          );
        }
      }
      return undefined;
    }
    case "graph.reorderInterfacePorts": {
      const existingIds = new Set(graph.interfacePorts.map((port) => port.id));
      const requestedIds = new Set(operation.portIds);
      if (
        requestedIds.size !== operation.portIds.length
        || requestedIds.size !== existingIds.size
        || operation.portIds.some((portId) => !existingIds.has(portId))
      ) {
        return error(
          "graph.invalidInterfacePortOrder",
          `${path}.portIds`,
          "Interface port order must contain every current port id exactly once.",
        );
      }
      const byId = new Map(graph.interfacePorts.map((port) => [port.id, port]));
      graph.interfacePorts = operation.portIds.flatMap((portId) => {
        const port = byId.get(portId);
        return port === undefined ? [] : [port];
      });
      return undefined;
    }
  }
}

export function renameElement(
  document: MutableGraphDocument,
  graph: MutableGraphDefinition,
  operation: Extract<GraphOperation, { readonly type: "graph.renameElement" }>,
  path: string,
): DocumentDiagnostic | undefined {
  if (operation.elementId === operation.newElementId) {
    return error("graph.sameElementId", `${path}.newElementId`, "The new element ID must be different.");
  }
  if (operation.elementKind === "graph") {
    if (graph.id !== operation.elementId) {
      return error("graph.graphNotFound", `${path}.elementId`, `Graph '${operation.elementId}' does not exist.`);
    }
    if (document.graphs.some((candidate) => candidate.id === operation.newElementId)) {
      return error("graph.graphAlreadyExists", `${path}.newElementId`, `Graph '${operation.newElementId}' already exists.`);
    }
    graph.id = operation.newElementId;
    if (document.rootGraphId === operation.elementId) document.rootGraphId = operation.newElementId;
    document.graphs.forEach((owner) => owner.nodes.forEach((node) => {
      if (node.kind === "subgraph" && node.subgraphId === operation.elementId) {
        node.subgraphId = operation.newElementId;
      }
    }));
    return undefined;
  }
  if (operation.elementKind === "node") {
    const node = graph.nodes.find((candidate) => candidate.id === operation.elementId);
    if (node === undefined) {
      return error("graph.nodeNotFound", `${path}.elementId`, `Node '${operation.elementId}' does not exist in graph '${graph.id}'.`);
    }
    if (allNodes(document).some((candidate) => candidate.id === operation.newElementId)) {
      return error("graph.nodeAlreadyExists", `${path}.newElementId`, `Node '${operation.newElementId}' already exists.`);
    }
    node.id = operation.newElementId;
    graph.edges.forEach((edge) => {
      renameNodeEndpoint(edge.source, operation.elementId, operation.newElementId);
      renameNodeEndpoint(edge.target, operation.elementId, operation.newElementId);
    });
    return undefined;
  }
  if (operation.elementKind === "interfacePort") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === operation.elementId);
    if (port === undefined) {
      return error("graph.interfacePortNotFound", `${path}.elementId`, `Interface port '${operation.elementId}' does not exist.`);
    }
    if (graph.interfacePorts.some((candidate) => candidate.id === operation.newElementId)) {
      return error("graph.interfacePortAlreadyExists", `${path}.newElementId`, `Interface port '${operation.newElementId}' already exists.`);
    }
    port.id = operation.newElementId;
    graph.edges.forEach((edge) => {
      renameInterfaceEndpoint(edge.source, operation.elementId, operation.newElementId);
      renameInterfaceEndpoint(edge.target, operation.elementId, operation.newElementId);
    });
    document.graphs.forEach((ownerGraph) => ownerGraph.nodes.forEach((node) => {
      if (node.kind !== "subgraph" || node.subgraphId !== graph.id) return;
      ownerGraph.edges.forEach((edge) => {
        renameNodePortEndpoint(edge.source, node.id, operation.elementId, operation.newElementId);
        renameNodePortEndpoint(edge.target, node.id, operation.elementId, operation.newElementId);
      });
    }));
    return undefined;
  }
  const node = graph.nodes.find((candidate) => candidate.id === operation.nodeId);
  const port = node?.dynamicPorts.find((candidate) => candidate.id === operation.elementId);
  if (node === undefined || port === undefined) {
    return error(
      "graph.dynamicPortNotFound",
      `${path}.elementId`,
      `Dynamic port '${operation.elementId}' does not exist on node '${operation.nodeId ?? ""}'.`,
    );
  }
  if (node.dynamicPorts.some((candidate) => candidate.id === operation.newElementId)) {
    return error("graph.dynamicPortAlreadyExists", `${path}.newElementId`, `Dynamic port '${operation.newElementId}' already exists.`);
  }
  port.id = operation.newElementId;
  graph.edges.forEach((edge) => {
    renameNodePortEndpoint(edge.source, node.id, operation.elementId, operation.newElementId);
    renameNodePortEndpoint(edge.target, node.id, operation.elementId, operation.newElementId);
  });
  return undefined;
}

export function renameNodeEndpoint(endpoint: GraphEndpoint, oldId: string, newId: string): void {
  if (endpoint.kind === "node" && endpoint.nodeId === oldId) {
    (endpoint as { nodeId: string }).nodeId = newId;
  }
}

export function renameInterfaceEndpoint(endpoint: GraphEndpoint, oldId: string, newId: string): void {
  if (endpoint.kind === "interface" && endpoint.portId === oldId) {
    (endpoint as { portId: string }).portId = newId;
  }
}

export function renameNodePortEndpoint(endpoint: GraphEndpoint, nodeId: string, oldId: string, newId: string): void {
  if (endpoint.kind === "node" && endpoint.nodeId === nodeId && endpoint.portId === oldId) {
    (endpoint as { portId: string }).portId = newId;
  }
}

export function lockDynamicInterfacePortsForEdge(
  document: MutableGraphDocument,
  graph: MutableGraphDefinition,
  edge: GraphEdge,
  path: string,
  catalog?: GraphCatalogRegistry,
): DocumentDiagnostic | undefined {
  if (edge.kind !== "data") {
    return undefined;
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const graphById = new Map(document.graphs.map((candidate) => [candidate.id, candidate]));
  const source = resolveEndpoint(graph, edge.source, nodeById, graphById, catalog).port;
  const target = resolveEndpoint(graph, edge.target, nodeById, graphById, catalog).port;
  const sourceDynamic = resolveMutableDynamicInterfacePort(document, graph, edge.source);
  const targetDynamic = resolveMutableDynamicInterfacePort(document, graph, edge.target);
  const sourceConcreteType = source?.dataTypeId === undefined || source.dataTypeId === "any"
    ? undefined
    : source.dataTypeId;
  const targetConcreteType = target?.dataTypeId === undefined || target.dataTypeId === "any"
    ? undefined
    : target.dataTypeId;

  if (sourceDynamic?.dataTypeId === "any" && targetConcreteType !== undefined) {
    sourceDynamic.dataTypeId = targetConcreteType;
  }
  if (targetDynamic?.dataTypeId === "any" && sourceConcreteType !== undefined) {
    targetDynamic.dataTypeId = sourceConcreteType;
  }
  if (sourceDynamic?.dataTypeId === "any" || targetDynamic?.dataTypeId === "any") {
    return error(
      "graph.unresolvedDynamicInterfaceType",
      `${path}.edge`,
      "A dynamic interface port must connect to a concrete data type before it can be used.",
    );
  }
  return undefined;
}

export function resolveMutableDynamicInterfacePort(
  document: MutableGraphDocument,
  graph: MutableGraphDefinition,
  endpoint: GraphEndpoint,
): MutableGraphInterfacePort | undefined {
  if (endpoint.kind === "interface") {
    return graph.interfacePorts.find(
      (port) => port.id === endpoint.portId && port.kind === "data" && port.dynamic === true,
    );
  }
  const node = graph.nodes.find((candidate) => candidate.id === endpoint.nodeId);
  if (node?.kind !== "subgraph") {
    return undefined;
  }
  return document.graphs.find((candidate) => candidate.id === node.subgraphId)?.interfacePorts.find(
    (port) => port.id === endpoint.portId && port.kind === "data" && port.dynamic === true,
  );
}

export function unlockUnconnectedDynamicInterfacePorts(document: MutableGraphDocument): void {
  document.graphs.forEach((graph) => graph.interfacePorts.forEach((port) => {
    if (port.kind !== "data" || port.dynamic !== true || port.dataTypeId === "any") {
      return;
    }
    const connectedInside = graph.edges.some((edge) =>
      edge.kind === "data"
      && (edge.source.kind === "interface" && edge.source.portId === port.id
        || edge.target.kind === "interface" && edge.target.portId === port.id),
    );
    const connectedOutside = document.graphs.some((ownerGraph) => {
      const ownerNodeIds = new Set(ownerGraph.nodes.flatMap((node) =>
        node.kind === "subgraph" && node.subgraphId === graph.id ? [node.id] : [],
      ));
      return ownerNodeIds.size > 0 && ownerGraph.edges.some((edge) =>
        edge.kind === "data"
        && (edge.source.kind === "node" && ownerNodeIds.has(edge.source.nodeId) && edge.source.portId === port.id
          || edge.target.kind === "node" && ownerNodeIds.has(edge.target.nodeId) && edge.target.portId === port.id),
      );
    });
    if (!connectedInside && !connectedOutside) {
      port.dataTypeId = "any";
    }
  }));
}
