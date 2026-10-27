// Structural and catalog-aware Graph document validation.
import { validateFieldValue } from "@visualbridge/module-sdk";
import type { DocumentDiagnostic, FieldDefinition } from "@visualbridge/module-sdk";
import {
  isNodeTypeAllowed,
  matchesNodeSelector,
  resolveDynamicPortGroup,
  resolveGraphType,
  resolveListPortDefinition,
  resolveNodeType,
  resolvePortDefinition,
  resolvePropertyDefinition,
  type GraphCatalogRegistry,
  type GraphNodeTypeDefinition,
  type GraphTypeDefinition,
} from "../graphCatalog";
import { error, warning } from "./diagnostics";
import { sameConnection } from "./mutable";
import { getTypedNodePorts } from "./ports";
import type {
  GraphAtomicNode,
  GraphDefinition,
  GraphDocument,
  GraphEndpoint,
  GraphNode,
  GraphSubgraphNode,
  JsonValue,
} from "./types";


export function validateStructure(document: GraphDocument): DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = [];
  const graphIds = new Set<string>();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const graphById = new Map<string, GraphDefinition>();
  document.graphs.forEach((graph, graphIndex) => {
    if (graphIds.has(graph.id)) {
      diagnostics.push(error("graph.duplicateGraphId", `graphs[${graphIndex}].id`, `Duplicate graph id '${graph.id}'.`));
    }
    graphIds.add(graph.id);
    graphById.set(graph.id, graph);
  });
  if (!graphIds.has(document.rootGraphId)) {
    diagnostics.push(error("graph.missingRootGraph", "rootGraphId", `Root graph '${document.rootGraphId}' does not exist.`));
  }

  const owners = new Map<string, string>();
  document.graphs.forEach((graph, graphIndex) => {
    const localNodeIds = new Set<string>();
    const localPortIds = new Set<string>();
    graph.interfacePorts.forEach((port, portIndex) => {
      if (localPortIds.has(port.id)) {
        diagnostics.push(error(
          "graph.duplicateInterfacePortId",
          `graphs[${graphIndex}].interfacePorts[${portIndex}].id`,
          `Duplicate interface port id '${port.id}'.`,
        ));
      }
      localPortIds.add(port.id);
    });
    graph.nodes.forEach((node, nodeIndex) => {
      if (nodeIds.has(node.id)) {
        diagnostics.push(error("graph.duplicateNodeId", `graphs[${graphIndex}].nodes[${nodeIndex}].id`, `Duplicate node id '${node.id}'.`));
      }
      nodeIds.add(node.id);
      localNodeIds.add(node.id);
      const dynamicPortIds = new Set<string>();
      node.dynamicPorts.forEach((port, portIndex) => {
        if (dynamicPortIds.has(port.id)) {
          diagnostics.push(error(
            "graph.duplicateDynamicPortId",
            `graphs[${graphIndex}].nodes[${nodeIndex}].dynamicPorts[${portIndex}].id`,
            `Duplicate dynamic port id '${port.id}' on node '${node.id}'.`,
          ));
        }
        dynamicPortIds.add(port.id);
      });
      if (node.kind === "subgraph") {
        if (node.subgraphId === document.rootGraphId) {
          diagnostics.push(error("graph.rootGraphOwned", `graphs[${graphIndex}].nodes[${nodeIndex}].subgraphId`, "The root graph cannot be embedded."));
        }
        if (!graphIds.has(node.subgraphId)) {
          diagnostics.push(error("graph.missingSubgraph", `graphs[${graphIndex}].nodes[${nodeIndex}].subgraphId`, `Subgraph '${node.subgraphId}' does not exist.`));
        } else if (owners.has(node.subgraphId)) {
          diagnostics.push(error("graph.multipleSubgraphOwners", `graphs[${graphIndex}].nodes[${nodeIndex}].subgraphId`, `Subgraph '${node.subgraphId}' already has an owner.`));
        } else {
          owners.set(node.subgraphId, graph.id);
        }
      }
    });
    graph.edges.forEach((edge, edgeIndex) => {
      const path = `graphs[${graphIndex}].edges[${edgeIndex}]`;
      if (edgeIds.has(edge.id)) {
        diagnostics.push(error("graph.duplicateEdgeId", `${path}.id`, `Duplicate edge id '${edge.id}'.`));
      }
      edgeIds.add(edge.id);
      validateEndpointExists(edge.source, `${path}.source`, localNodeIds, localPortIds, diagnostics);
      validateEndpointExists(edge.target, `${path}.target`, localNodeIds, localPortIds, diagnostics);
      if (graph.edges.slice(0, edgeIndex).some((candidate) => sameConnection(candidate, edge))) {
        diagnostics.push(error("graph.duplicateConnection", path, "An identical connection already exists."));
      }
    });
  });
  document.graphs.forEach((graph, graphIndex) => {
    if (graph.id !== document.rootGraphId && !owners.has(graph.id)) {
      diagnostics.push(error("graph.orphanSubgraph", `graphs[${graphIndex}].id`, `Embedded graph '${graph.id}' has no owning subgraph node.`));
    }
  });
  validateContainmentCycles(document, graphById, diagnostics);
  return diagnostics;
}

export function validateAtomicNode(
  node: GraphAtomicNode | (GraphSubgraphNode & { readonly nodeTypeId: string }),
  path: string,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  if (catalog === undefined) {
    return;
  }
  const nodeType = resolveNodeType(catalog, node.nodeTypeId);
  if (nodeType === undefined) {
    diagnostics.push(warning("graph.unknownNodeType", `${path}.nodeTypeId`, `Unknown node type '${node.nodeTypeId}'. Original data is preserved.`));
    return;
  }
  if (nodeType.id !== node.nodeTypeId) {
    diagnostics.push(warning("graph.nodeTypeAlias", `${path}.nodeTypeId`, `Node type '${node.nodeTypeId}' is an alias of '${nodeType.id}'.`));
  }
  if (node.kind === "node" && nodeType.subgraph !== undefined) {
    diagnostics.push(error("graph.subgraphTypeUsedForAtomicNode", `${path}.nodeTypeId`, `Node type '${nodeType.id}' must own an embedded subgraph.`));
  }
  const propertyOwners = new Map<string, string>();
  Object.entries(node.properties).forEach(([propertyId, value]) => {
    const definition = resolvePropertyDefinition(nodeType, propertyId);
    if (definition === undefined) {
      diagnostics.push(warning("graph.unknownNodeProperty", `${path}.properties.${propertyId}`, `Property '${propertyId}' is not declared by '${nodeType.id}' and is preserved.`));
    } else {
      const previousPropertyId = propertyOwners.get(definition.id);
      if (previousPropertyId !== undefined) {
        diagnostics.push(error(
          "graph.duplicateSemanticProperty",
          `${path}.properties.${propertyId}`,
          `Properties '${previousPropertyId}' and '${propertyId}' both resolve to '${definition.id}'.`,
        ));
      } else {
        propertyOwners.set(definition.id, propertyId);
      }
      if (definition.id !== propertyId) {
        diagnostics.push(warning(
          "graph.nodePropertyAlias",
          `${path}.properties.${propertyId}`,
          `Property '${propertyId}' is an alias of '${definition.id}'.`,
        ));
      }
      validateFieldValue(
        value as import("@visualbridge/module-sdk").JsonValue,
        definition,
        `${path}.properties.${propertyId}`,
        diagnostics,
      );
    }
  });
  const groupCounts = new Map<string, number>();
  node.dynamicPorts.forEach((port, portIndex) => {
    const portPath = `${path}.dynamicPorts[${portIndex}]`;
    if (resolvePortDefinition(nodeType, port.id) !== undefined) {
      diagnostics.push(error(
        "graph.dynamicPortIdCollision",
        `${portPath}.id`,
        `Dynamic port id '${port.id}' collides with a static port identity on '${nodeType.id}'.`,
      ));
    }
    if (resolveListPortDefinition(nodeType, port.id) !== undefined) {
      diagnostics.push(error(
        "graph.dynamicPortIdCollision",
        `${portPath}.id`,
        `Dynamic item id '${port.id}' collides with a whole-List port identity on '${nodeType.id}'.`,
      ));
    }
    const group = resolveDynamicPortGroup(nodeType, port.groupId);
    if (group === undefined) {
      diagnostics.push(warning(
        "graph.unknownDynamicPortGroup",
        `${portPath}.groupId`,
        `Dynamic port group '${port.groupId}' is not declared by '${nodeType.id}'. Original data is preserved.`,
      ));
      return;
    }
    if (group.id !== port.groupId) {
      diagnostics.push(warning(
        "graph.dynamicPortGroupAlias",
        `${portPath}.groupId`,
        `Dynamic port group '${port.groupId}' is an alias of '${group.id}'.`,
      ));
    }
    groupCounts.set(group.id, (groupCounts.get(group.id) ?? 0) + 1);
    validateFieldValue(
      port.value as import("@visualbridge/module-sdk").JsonValue,
      group.item,
      `${portPath}.value`,
      diagnostics,
    );
  });
  nodeType.dynamicPortGroups.forEach((group) => {
    const count = groupCounts.get(group.id) ?? 0;
    if (group.maxItems !== undefined && count > group.maxItems) {
      diagnostics.push(error(
        "graph.tooManyDynamicPorts",
        `${path}.dynamicPorts`,
        `Dynamic port group '${group.id}' has ${count} items but allows ${group.maxItems}.`,
      ));
    }
  });
}

export function validateGraphType(
  graph: GraphDefinition,
  path: string,
  document: GraphDocument,
  ownerByGraphId: ReadonlyMap<string, { readonly graph: GraphDefinition; readonly node: GraphSubgraphNode }>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): GraphTypeDefinition | undefined {
  if (catalog === undefined || catalog.graphTypes.length === 0) {
    return undefined;
  }
  if (graph.graphTypeId === undefined) {
    diagnostics.push(warning("graph.missingGraphType", `${path}.graphTypeId`, "Graph Type is not assigned. Existing data is preserved."));
    return undefined;
  }
  const graphType = resolveGraphType(catalog, graph.graphTypeId);
  if (graphType === undefined) {
    diagnostics.push(warning("graph.unknownGraphType", `${path}.graphTypeId`, `Unknown Graph Type '${graph.graphTypeId}'. Existing data is preserved.`));
    return undefined;
  }
  if (graphType.id !== graph.graphTypeId) {
    diagnostics.push(warning("graph.graphTypeAlias", `${path}.graphTypeId`, `Graph Type '${graph.graphTypeId}' is an alias of '${graphType.id}'.`));
  }
  const isRoot = graph.id === document.rootGraphId;
  if ((isRoot && graphType.usage === "subgraph") || (!isRoot && graphType.usage === "root")) {
    diagnostics.push(error(
      "graph.invalidGraphTypeUsage",
      `${path}.graphTypeId`,
      `Graph Type '${graphType.id}' cannot be used as ${isRoot ? "a root graph" : "an embedded subgraph"}.`,
    ));
  }
  validateDeclaredProperties(graph.properties, graphType.properties, `${path}.properties`, `Graph Type '${graphType.id}'`, diagnostics);
  const owner = ownerByGraphId.get(graph.id);
  if (owner !== undefined) {
    const parentType = owner.graph.graphTypeId === undefined ? undefined : resolveGraphType(catalog, owner.graph.graphTypeId);
    if (parentType !== undefined) {
      if (
        parentType.allowSubgraphs
        &&
        parentType.allowedSubgraphTypeIds !== undefined
        && !parentType.allowedSubgraphTypeIds.some((id) => resolveGraphType(catalog, id)?.id === graphType.id)
      ) {
        diagnostics.push(error(
          "graph.subgraphTypeNotAllowed",
          `${path}.graphTypeId`,
          `Parent Graph Type '${parentType.id}' does not allow subgraph type '${graphType.id}'.`,
        ));
      }
    }
  }
  return graphType;
}

export function validateSubgraphNode(
  node: GraphSubgraphNode,
  path: string,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  if (catalog === undefined || node.nodeTypeId === undefined) {
    if (catalog !== undefined && catalog.graphTypes.length > 0) {
      diagnostics.push(warning("graph.untypedSubgraphNode", `${path}.nodeTypeId`, "Subgraph call has no node type. Existing data is preserved."));
    }
    return;
  }
  const nodeType = resolveNodeType(catalog, node.nodeTypeId);
  if (nodeType === undefined) {
    diagnostics.push(warning("graph.unknownNodeType", `${path}.nodeTypeId`, `Unknown node type '${node.nodeTypeId}'. Original data is preserved.`));
    return;
  }
  if (nodeType.subgraph === undefined) {
    diagnostics.push(error("graph.atomicTypeUsedForSubgraph", `${path}.nodeTypeId`, `Node type '${nodeType.id}' is not a subgraph call type.`));
    return;
  }
  validateAtomicNode(node as GraphSubgraphNode & { readonly nodeTypeId: string }, path, catalog, diagnostics);
  const childGraph = graphById.get(node.subgraphId);
  const childType = childGraph?.graphTypeId === undefined ? undefined : resolveGraphType(catalog, childGraph.graphTypeId);
  if (
    childType !== undefined
    && nodeType.subgraph.graphTypeIds !== undefined
    && !nodeType.subgraph.graphTypeIds.some((id) => resolveGraphType(catalog, id)?.id === childType.id)
  ) {
    diagnostics.push(error(
      "graph.subgraphCallTypeMismatch",
      `${path}.nodeTypeId`,
      `Subgraph node type '${nodeType.id}' cannot contain Graph Type '${childType.id}'.`,
    ));
  }
  if (childGraph !== undefined) {
    const occupiedPortIds = new Set<string>();
    getTypedNodePorts(node as GraphSubgraphNode & { readonly nodeTypeId: string }, nodeType).forEach((port) => {
      occupiedPortIds.add(port.id);
      const definition = resolvePortDefinition(nodeType, port.id);
      definition?.aliases.forEach((alias) => occupiedPortIds.add(alias));
    });
    childGraph.interfacePorts.forEach((port, index) => {
      if (occupiedPortIds.has(port.id)) {
        diagnostics.push(error(
          "graph.subgraphPortIdCollision",
          `${path}.subgraphId`,
          `Subgraph interface port '${port.id}' collides with a static or dynamic port on '${nodeType.id}' (interface index ${index}).`,
        ));
      }
    });
  }
}

export function validateNodeAllowed(
  node: GraphNode,
  path: string,
  graphType: GraphTypeDefinition | undefined,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  if (node.kind === "subgraph" && graphType !== undefined && !graphType.allowSubgraphs) {
    diagnostics.push(error(
      "graph.subgraphsNotAllowed",
      `${path}.subgraphId`,
      `Graph Type '${graphType.id}' does not allow subgraphs.`,
    ));
  }
  if (node.kind === "subgraph" && graphType !== undefined && node.nodeTypeId === undefined) {
    diagnostics.push(error(
      "graph.typedSubgraphNodeRequired",
      `${path}.nodeTypeId`,
      `Graph Type '${graphType.id}' requires embedded subgraphs to use a Catalog subgraph node type.`,
    ));
  }
  if (graphType === undefined || catalog === undefined) {
    return;
  }
  const nodeType = node.nodeTypeId === undefined ? undefined : resolveNodeType(catalog, node.nodeTypeId);
  if (nodeType !== undefined && isNodeTypeAllowed(graphType, nodeType)) {
    return;
  }
  diagnostics.push(error(
    "graph.nodeTypeNotAllowed",
    `${path}.nodeTypeId`,
    nodeType === undefined
      ? `Graph Type '${graphType.id}' cannot verify an untyped or unknown node.`
      : `Graph Type '${graphType.id}' does not allow node type '${nodeType.id}'.`,
  ));
}

export function validateNodeConstraints(
  graph: GraphDefinition,
  path: string,
  graphType: GraphTypeDefinition | undefined,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  if (graphType === undefined || catalog === undefined) {
    return;
  }
  graphType.nodeConstraints.forEach((constraint) => {
    const count = graph.nodes.filter((node) => {
      const nodeType = node.nodeTypeId === undefined ? undefined : resolveNodeType(catalog, node.nodeTypeId);
      return nodeType !== undefined && matchesNodeSelector(nodeType, constraint.selector);
    }).length;
    const constraintPath = `${path}.nodeConstraints.${constraint.id}`;
    if (constraint.minInstances !== undefined && count < constraint.minInstances) {
      diagnostics.push(error(
        "graph.tooFewNodeInstances",
        constraintPath,
        `Constraint '${constraint.id}' requires at least ${constraint.minInstances} matching nodes; found ${count}.`,
      ));
    }
    if (constraint.maxInstances !== undefined && count > constraint.maxInstances) {
      diagnostics.push(error(
        "graph.tooManyNodeInstances",
        constraintPath,
        `Constraint '${constraint.id}' allows at most ${constraint.maxInstances} matching nodes; found ${count}.`,
      ));
    }
  });
}

export function validateDeclaredProperties(
  properties: Readonly<Record<string, JsonValue>>,
  definitions: readonly FieldDefinition[],
  path: string,
  owner: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const propertyOwners = new Map<string, string>();
  Object.entries(properties).forEach(([propertyId, value]) => {
    const definition = definitions.find((candidate) => candidate.id === propertyId || candidate.aliases.includes(propertyId));
    if (definition === undefined) {
      diagnostics.push(warning("graph.unknownGraphProperty", `${path}.${propertyId}`, `Property '${propertyId}' is not declared by ${owner} and is preserved.`));
      return;
    }
    const previousPropertyId = propertyOwners.get(definition.id);
    if (previousPropertyId !== undefined) {
      diagnostics.push(error("graph.duplicateSemanticGraphProperty", `${path}.${propertyId}`, `Properties '${previousPropertyId}' and '${propertyId}' both resolve to '${definition.id}'.`));
    } else {
      propertyOwners.set(definition.id, propertyId);
    }
    if (definition.id !== propertyId) {
      diagnostics.push(warning("graph.graphPropertyAlias", `${path}.${propertyId}`, `Property '${propertyId}' is an alias of '${definition.id}'.`));
    }
    validateFieldValue(
      value as import("@visualbridge/module-sdk").JsonValue,
      definition,
      `${path}.${propertyId}`,
      diagnostics,
    );
  });
}

export function validateEndpointExists(
  endpoint: GraphEndpoint,
  path: string,
  nodeIds: ReadonlySet<string>,
  interfacePortIds: ReadonlySet<string>,
  diagnostics: DocumentDiagnostic[],
): void {
  if (endpoint.kind === "node" && !nodeIds.has(endpoint.nodeId)) {
    diagnostics.push(error("graph.missingEndpointNode", `${path}.nodeId`, `Node '${endpoint.nodeId}' does not exist in this graph.`));
  }
  if (endpoint.kind === "interface" && !interfacePortIds.has(endpoint.portId)) {
    diagnostics.push(error("graph.missingInterfacePort", `${path}.portId`, `Interface port '${endpoint.portId}' does not exist in this graph.`));
  }
}

export function validateContainmentCycles(
  document: GraphDocument,
  graphById: ReadonlyMap<string, GraphDefinition>,
  diagnostics: DocumentDiagnostic[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (graphId: string): void => {
    if (visiting.has(graphId)) {
      diagnostics.push(error("graph.subgraphContainmentCycle", "graphs", `Subgraph containment cycle includes '${graphId}'.`));
      return;
    }
    if (visited.has(graphId)) {
      return;
    }
    visiting.add(graphId);
    graphById.get(graphId)?.nodes.forEach((node) => {
      if (node.kind === "subgraph") {
        visit(node.subgraphId);
      }
    });
    visiting.delete(graphId);
    visited.add(graphId);
  };
  visit(document.rootGraphId);
}
