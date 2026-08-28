import type {
  DocumentDiagnostic,
  DocumentOperationResult,
  DocumentParseResult,
} from "@visualbridge/core";
import {
  isDataTypeAssignable,
  isNodeTypeAllowed,
  matchesNodeSelector,
  resolveDynamicPortGroup,
  resolveGraphType,
  resolvePortDefinition,
  resolvePropertyDefinition,
  resolveNodeType,
  type GraphCatalogRegistry,
  type GraphDynamicPortGroupDefinition,
  type GraphNodeTypeDefinition,
  type GraphPortDirection,
  type GraphPortKind,
  type GraphPropertyDefinition,
  type GraphTypeDefinition,
} from "./graphCatalog";

export const GRAPH_DOCUMENT_FORMAT_VERSION = 3;
export const GRAPH_EDITOR_ID = "graph";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

interface GraphNodeBase {
  readonly id: string;
  readonly title: string;
  readonly position: GraphPosition;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface GraphAtomicNode extends GraphNodeBase {
  readonly kind: "node";
  readonly nodeTypeId: string;
  readonly dynamicPorts: readonly GraphDynamicPort[];
}

export interface GraphDynamicPort {
  readonly id: string;
  readonly groupId: string;
  readonly title: string;
  readonly value: JsonValue;
}

export interface GraphSubgraphNode extends GraphNodeBase {
  readonly kind: "subgraph";
  readonly nodeTypeId?: string;
  readonly subgraphId: string;
  readonly dynamicPorts: readonly GraphDynamicPort[];
}

export type GraphNode = GraphAtomicNode | GraphSubgraphNode;
type GraphTypedNode = GraphAtomicNode | (GraphSubgraphNode & { readonly nodeTypeId: string });

export interface GraphNodeEndpoint {
  readonly kind: "node";
  readonly nodeId: string;
  readonly portId: string;
}

export interface GraphInterfaceEndpoint {
  readonly kind: "interface";
  readonly portId: string;
}

export type GraphEndpoint = GraphNodeEndpoint | GraphInterfaceEndpoint;

export interface GraphEdge {
  readonly id: string;
  readonly kind: GraphPortKind;
  readonly source: GraphEndpoint;
  readonly target: GraphEndpoint;
}

export interface GraphInterfacePort {
  readonly id: string;
  readonly title: string;
  readonly kind: GraphPortKind;
  readonly direction: GraphPortDirection;
  readonly dataTypeId?: string;
  readonly maxConnections?: number;
}

export interface GraphDefinition {
  readonly id: string;
  readonly graphTypeId?: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly interfacePorts: readonly GraphInterfacePort[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphDocument {
  readonly formatVersion: typeof GRAPH_DOCUMENT_FORMAT_VERSION;
  readonly documentId: string;
  readonly rootGraphId: string;
  readonly graphs: readonly GraphDefinition[];
}

export type GraphOperation =
  | { readonly type: "graph.addNode"; readonly graphId: string; readonly node: GraphAtomicNode }
  | {
      readonly type: "graph.addSubgraph";
      readonly graphId: string;
      readonly node: GraphSubgraphNode;
      readonly subgraph: GraphDefinition;
    }
  | { readonly type: "graph.removeNode"; readonly graphId: string; readonly nodeId: string }
  | {
      readonly type: "graph.moveNode";
      readonly graphId: string;
      readonly nodeId: string;
      readonly position: GraphPosition;
    }
  | {
      readonly type: "graph.updateNode";
      readonly graphId: string;
      readonly nodeId: string;
      readonly title: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly type: "graph.replaceNodeType";
      readonly graphId: string;
      readonly nodeId: string;
      readonly nodeTypeId: string;
    }
  | {
      readonly type: "graph.addDynamicPort";
      readonly graphId: string;
      readonly nodeId: string;
      readonly port: GraphDynamicPort;
    }
  | {
      readonly type: "graph.updateDynamicPort";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portId: string;
      readonly title: string;
      readonly value: JsonValue;
    }
  | {
      readonly type: "graph.removeDynamicPort";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portId: string;
    }
  | {
      readonly type: "graph.reorderDynamicPorts";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portIds: readonly string[];
    }
  | { readonly type: "graph.addEdge"; readonly graphId: string; readonly edge: GraphEdge }
  | { readonly type: "graph.removeEdge"; readonly graphId: string; readonly edgeId: string }
  | {
      readonly type: "graph.assignType";
      readonly graphId: string;
      readonly graphTypeId: string;
    }
  | {
      readonly type: "graph.updateGraph";
      readonly graphId: string;
      readonly title: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }
  | { readonly type: "graph.addInterfacePort"; readonly graphId: string; readonly port: GraphInterfacePort }
  | {
      readonly type: "graph.updateInterfacePort";
      readonly graphId: string;
      readonly portId: string;
      readonly title: string;
    }
  | { readonly type: "graph.removeInterfacePort"; readonly graphId: string; readonly portId: string };

export interface GraphResolvedPort {
  readonly id: string;
  readonly title: string;
  readonly kind: GraphPortKind;
  readonly direction: GraphPortDirection;
  readonly dataTypeId?: string;
  readonly maxConnections?: number;
}

export function createEmptyGraphDocument(
  documentId: string,
  rootGraphId: string,
  graphTypeId?: string,
  catalog?: GraphCatalogRegistry,
  createNodeId?: () => string,
): GraphDocument {
  const graph = createGraphDefinition(rootGraphId, "Root", graphTypeId, catalog, createNodeId);
  return {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId,
    rootGraphId,
    graphs: [graph],
  };
}

export function createGraphDefinition(
  graphId: string,
  title: string,
  graphTypeId?: string,
  catalog?: GraphCatalogRegistry,
  createNodeId?: () => string,
): GraphDefinition {
  const resolvedCatalog = catalog ?? EMPTY_CATALOG;
  const graphType = graphTypeId === undefined || catalog === undefined
    ? undefined
    : resolveGraphType(resolvedCatalog, graphTypeId);
  const properties = createDefaultPropertyValues(graphType?.properties ?? []);
  const nodes = graphType === undefined || createNodeId === undefined
    ? []
    : graphType.initialNodes.flatMap((initialNode, index) => {
        const nodeType = resolveNodeType(resolvedCatalog, initialNode.nodeTypeId);
        return nodeType === undefined || nodeType.subgraph !== undefined
          ? []
          : [{
              kind: "node" as const,
              id: createNodeId(),
              nodeTypeId: nodeType.id,
              title: initialNode.title ?? nodeType.title,
              position: { x: 80 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 180 },
              properties: createDefaultPropertyValues(nodeType.properties),
              dynamicPorts: [],
            }];
      });
  return {
    id: graphId,
    ...(graphType === undefined ? {} : { graphTypeId: graphType.id }),
    title,
    properties,
    interfacePorts: [],
    nodes,
    edges: [],
  };
}

export function createDefaultPropertyValues(
  definitions: readonly GraphPropertyDefinition[],
): Readonly<Record<string, JsonValue>> {
  const properties: Record<string, JsonValue> = {};
  definitions.forEach((property) => {
    if (property.defaultValue !== undefined) {
      properties[property.id] = cloneJsonValue(property.defaultValue);
    }
  });
  return properties;
}

export function parseGraphDocument(text: string): DocumentParseResult<GraphDocument> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("graph.invalidJson", "$", formatError(errorValue));
  }
  return parseGraphDocumentValue(value);
}

export function serializeGraphDocument(document: GraphDocument): string {
  const normalized: GraphDocument = {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    rootGraphId: document.rootGraphId,
    graphs: [...document.graphs]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((graph) => ({
        id: graph.id,
        ...(graph.graphTypeId === undefined ? {} : { graphTypeId: graph.graphTypeId }),
        title: graph.title,
        properties: sortJsonObject(graph.properties),
        interfacePorts: [...graph.interfacePorts]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((port) => ({
            id: port.id,
            title: port.title,
            kind: port.kind,
            direction: port.direction,
            ...(port.dataTypeId === undefined ? {} : { dataTypeId: port.dataTypeId }),
            ...(port.maxConnections === undefined ? {} : { maxConnections: port.maxConnections }),
          })),
        nodes: [...graph.nodes]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((node) => node.kind === "node"
            ? {
                kind: node.kind,
                id: node.id,
                nodeTypeId: node.nodeTypeId,
                title: node.title,
                position: { ...node.position },
                properties: sortJsonObject(node.properties),
                dynamicPorts: node.dynamicPorts.map((port) => ({
                  id: port.id,
                  groupId: port.groupId,
                  title: port.title,
                  value: sortJsonValue(port.value),
                })),
              }
            : {
                kind: node.kind,
                id: node.id,
                ...(node.nodeTypeId === undefined ? {} : { nodeTypeId: node.nodeTypeId }),
                subgraphId: node.subgraphId,
                title: node.title,
                position: { ...node.position },
                properties: sortJsonObject(node.properties),
                dynamicPorts: node.dynamicPorts.map((port) => ({
                  id: port.id,
                  groupId: port.groupId,
                  title: port.title,
                  value: sortJsonValue(port.value),
                })),
              }),
        edges: [...graph.edges]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((edge) => ({
            id: edge.id,
            kind: edge.kind,
            source: serializeEndpoint(edge.source),
            target: serializeEndpoint(edge.target),
          })),
      })),
  };
  return `${JSON.stringify(normalized, undefined, 2)}\n`;
}

export function applyGraphOperations(
  document: GraphDocument,
  operationsValue: unknown,
  catalog?: GraphCatalogRegistry,
): DocumentOperationResult<GraphDocument> {
  const parsed = parseOperations(operationsValue);
  if (!parsed.success) {
    return parsed;
  }

  const baselineErrors = diagnosticCounts(validateGraphDocument(document, catalog));
  const working = cloneDocument(document);
  for (let index = 0; index < parsed.operations.length; index += 1) {
    const operation = parsed.operations[index];
    if (operation === undefined) {
      continue;
    }
    const diagnostic = applyOperation(working, operation, index, catalog);
    if (diagnostic !== undefined) {
      return { success: false, diagnostics: [diagnostic] };
    }
  }

  const diagnostics = validateGraphDocument(working, catalog);
  const introducedErrors = diagnostics.filter((diagnostic) => {
    if (diagnostic.severity !== "error") {
      return false;
    }
    const key = diagnosticKey(diagnostic);
    const remainingBaselineCount = baselineErrors.get(key) ?? 0;
    if (remainingBaselineCount === 0) {
      return true;
    }
    baselineErrors.set(key, remainingBaselineCount - 1);
    return false;
  });
  if (introducedErrors.length > 0) {
    return { success: false, diagnostics: introducedErrors };
  }
  return { success: true, document: working, diagnostics };
}

export function validateGraphDocument(
  document: GraphDocument,
  catalog?: GraphCatalogRegistry,
): readonly DocumentDiagnostic[] {
  const diagnostics = validateStructure(document);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return diagnostics;
  }

  const graphById = new Map(document.graphs.map((graph) => [graph.id, graph]));
  const ownerByGraphId = new Map<string, { readonly graph: GraphDefinition; readonly node: GraphSubgraphNode }>();
  document.graphs.forEach((graph) => graph.nodes.forEach((node) => {
    if (node.kind === "subgraph") {
      ownerByGraphId.set(node.subgraphId, { graph, node });
    }
  }));
  document.graphs.forEach((graph, graphIndex) => {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const graphPath = `graphs[${graphIndex}]`;
    const graphType = validateGraphType(graph, graphPath, document, ownerByGraphId, catalog, diagnostics);
    if (catalog !== undefined) {
      const dataTypeIds = new Set(["any", ...catalog.dataTypes.map((dataType) => dataType.id)]);
      graph.interfacePorts.forEach((port, portIndex) => {
        if (port.dataTypeId !== undefined && !dataTypeIds.has(port.dataTypeId)) {
          diagnostics.push(error(
            "graph.unknownInterfaceDataType",
            `graphs[${graphIndex}].interfacePorts[${portIndex}].dataTypeId`,
            `Data type '${port.dataTypeId}' is not declared by the Graph Catalog.`,
          ));
        }
      });
    }
    graph.nodes.forEach((node, nodeIndex) => {
      if (node.kind === "node") {
        validateAtomicNode(node, `graphs[${graphIndex}].nodes[${nodeIndex}]`, catalog, diagnostics);
      } else {
        validateSubgraphNode(node, `${graphPath}.nodes[${nodeIndex}]`, graphById, catalog, diagnostics);
      }
      validateNodeAllowed(node, `${graphPath}.nodes[${nodeIndex}]`, graphType, catalog, diagnostics);
    });
    validateNodeConstraints(graph, graphPath, graphType, catalog, diagnostics);
    graph.edges.forEach((edge, edgeIndex) => {
      validateSemanticEdge(
        graph,
        edge,
        `graphs[${graphIndex}].edges[${edgeIndex}]`,
        nodeById,
        graphById,
        catalog,
        diagnostics,
      );
    });
    validateSemanticDuplicateConnections(graph, graphIndex, nodeById, graphById, catalog, diagnostics);
    validateCardinality(graph, graphIndex, nodeById, graphById, catalog, diagnostics);
  });
  return diagnostics;
}

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

function parseGraphDocumentValue(value: unknown): DocumentParseResult<GraphDocument> {
  if (!isRecord(value)) {
    return failure("graph.invalidRoot", "$", "Graph document must contain a JSON object.");
  }
  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(value, ["formatVersion", "documentId", "rootGraphId", "graphs"], "$", diagnostics);
  if (value.formatVersion !== 2 && value.formatVersion !== GRAPH_DOCUMENT_FORMAT_VERSION) {
    diagnostics.push(error(
      "graph.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${GRAPH_DOCUMENT_FORMAT_VERSION}.`,
    ));
  }
  const documentId = readIdentifier(value.documentId, "documentId", diagnostics);
  const rootGraphId = readIdentifier(value.rootGraphId, "rootGraphId", diagnostics);
  const graphs = readGraphs(value.graphs, diagnostics);
  if (documentId === undefined || rootGraphId === undefined) {
    return { success: false, diagnostics };
  }
  const document: GraphDocument = {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId,
    rootGraphId,
    graphs,
  };
  diagnostics.push(...validateStructure(document));
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { success: false, diagnostics }
    : { success: true, document, diagnostics };
}

function readGraphs(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(error("graph.invalidGraphs", "graphs", "Expected a non-empty array."));
    return [];
  }
  return value.flatMap<GraphDefinition>((entry, index) => {
    const path = `graphs[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graph.invalidGraph", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "graphTypeId", "title", "properties", "interfacePorts", "nodes", "edges"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const graphTypeId = entry.graphTypeId === undefined
      ? undefined
      : readIdentifier(entry.graphTypeId, `${path}.graphTypeId`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const properties = readProperties(entry.properties, `${path}.properties`, diagnostics);
    const interfacePorts = readInterfacePorts(entry.interfacePorts, `${path}.interfacePorts`, diagnostics);
    const nodes = readNodes(entry.nodes, `${path}.nodes`, diagnostics);
    const edges = readEdges(entry.edges, `${path}.edges`, diagnostics);
    return id === undefined || title === undefined || properties === undefined
      ? []
      : [{ id, ...(graphTypeId === undefined ? {} : { graphTypeId }), title, properties, interfacePorts, nodes, edges }];
  });
}

function readNodes(value: unknown, basePath: string, diagnostics: DocumentDiagnostic[]): readonly GraphNode[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graph.invalidNodes", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap<GraphNode>((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graph.invalidNode", path, "Expected an object."));
      return [];
    }
    const kind = readEnum(entry.kind, ["node", "subgraph"] as const, `${path}.kind`, diagnostics);
    if (kind === "node") {
      checkKeys(entry, ["kind", "id", "nodeTypeId", "title", "position", "properties", "dynamicPorts"], path, diagnostics);
    } else if (kind === "subgraph") {
      checkKeys(entry, ["kind", "id", "nodeTypeId", "subgraphId", "title", "position", "properties", "dynamicPorts"], path, diagnostics);
    }
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const position = readPosition(entry.position, `${path}.position`, diagnostics);
    const properties = readProperties(entry.properties, `${path}.properties`, diagnostics);
    if (kind === undefined || id === undefined || title === undefined || position === undefined || properties === undefined) {
      return [];
    }
    if (kind === "node") {
      const nodeTypeId = readIdentifier(entry.nodeTypeId, `${path}.nodeTypeId`, diagnostics);
      const dynamicPorts = entry.dynamicPorts === undefined
        ? []
        : readDynamicPorts(entry.dynamicPorts, `${path}.dynamicPorts`, diagnostics);
      return nodeTypeId === undefined ? [] : [{ kind, id, nodeTypeId, title, position, properties, dynamicPorts }];
    }
    const nodeTypeId = entry.nodeTypeId === undefined
      ? undefined
      : readIdentifier(entry.nodeTypeId, `${path}.nodeTypeId`, diagnostics);
    const subgraphId = readIdentifier(entry.subgraphId, `${path}.subgraphId`, diagnostics);
    const dynamicPorts = entry.dynamicPorts === undefined
      ? []
      : readDynamicPorts(entry.dynamicPorts, `${path}.dynamicPorts`, diagnostics);
    return subgraphId === undefined
      ? []
      : [{ kind, id, ...(nodeTypeId === undefined ? {} : { nodeTypeId }), subgraphId, title, position, properties, dynamicPorts }];
  });
}

function readDynamicPorts(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphDynamicPort[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graph.invalidDynamicPorts", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graph.invalidDynamicPort", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "groupId", "title", "value"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const groupId = readIdentifier(entry.groupId, `${path}.groupId`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const portValue = isJsonValue(entry.value) ? entry.value : undefined;
    if (portValue === undefined) {
      diagnostics.push(error("graph.invalidDynamicPortValue", `${path}.value`, "Expected a JSON value."));
    }
    return id === undefined || groupId === undefined || title === undefined || portValue === undefined
      ? []
      : [{ id, groupId, title, value: portValue }];
  });
}

function readEdges(value: unknown, basePath: string, diagnostics: DocumentDiagnostic[]): readonly GraphEdge[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graph.invalidEdges", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graph.invalidEdge", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "kind", "source", "target"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const kind = readEnum(entry.kind, ["flow", "data"] as const, `${path}.kind`, diagnostics);
    const source = readEndpoint(entry.source, `${path}.source`, diagnostics);
    const target = readEndpoint(entry.target, `${path}.target`, diagnostics);
    return id === undefined || kind === undefined || source === undefined || target === undefined
      ? []
      : [{ id, kind, source, target }];
  });
}

function readEndpoint(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): GraphEndpoint | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graph.invalidEndpoint", path, "Expected an object."));
    return undefined;
  }
  const kind = readEnum(value.kind, ["node", "interface"] as const, `${path}.kind`, diagnostics);
  if (kind === "node") {
    checkKeys(value, ["kind", "nodeId", "portId"], path, diagnostics);
    const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
    const portId = readIdentifier(value.portId, `${path}.portId`, diagnostics);
    return nodeId === undefined || portId === undefined ? undefined : { kind, nodeId, portId };
  }
  if (kind === "interface") {
    checkKeys(value, ["kind", "portId"], path, diagnostics);
    const portId = readIdentifier(value.portId, `${path}.portId`, diagnostics);
    return portId === undefined ? undefined : { kind, portId };
  }
  return undefined;
}

function readInterfacePorts(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphInterfacePort[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graph.invalidInterfacePorts", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graph.invalidInterfacePort", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "title", "kind", "direction", "dataTypeId", "maxConnections"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const kind = readEnum(entry.kind, ["flow", "data"] as const, `${path}.kind`, diagnostics);
    const direction = readEnum(entry.direction, ["input", "output"] as const, `${path}.direction`, diagnostics);
    const dataTypeId = entry.dataTypeId === undefined
      ? undefined
      : readIdentifier(entry.dataTypeId, `${path}.dataTypeId`, diagnostics);
    const maxConnections = entry.maxConnections === undefined
      ? undefined
      : readPositiveInteger(entry.maxConnections, `${path}.maxConnections`, diagnostics);
    if (kind === "data" && dataTypeId === undefined) {
      diagnostics.push(error("graph.missingDataType", `${path}.dataTypeId`, "Data interface ports require dataTypeId."));
    }
    if (kind === "flow" && dataTypeId !== undefined) {
      diagnostics.push(error("graph.unexpectedDataType", `${path}.dataTypeId`, "Flow interface ports cannot declare dataTypeId."));
    }
    return id === undefined || title === undefined || kind === undefined || direction === undefined
      ? []
      : [{ id, title, kind, direction, ...(dataTypeId === undefined ? {} : { dataTypeId }), ...(maxConnections === undefined ? {} : { maxConnections }) }];
  });
}

function parseOperations(value: unknown):
  | { readonly success: true; readonly operations: readonly GraphOperation[] }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { success: false, diagnostics: [error("graph.invalidOperations", "operations", "Expected a non-empty operation array.")] };
  }
  const diagnostics: DocumentDiagnostic[] = [];
  const operations = value.flatMap((entry, index) => {
    const operation = parseOperation(entry, index, diagnostics);
    return operation === undefined ? [] : [operation];
  });
  return diagnostics.length > 0 ? { success: false, diagnostics } : { success: true, operations };
}

function parseOperation(value: unknown, index: number, diagnostics: DocumentDiagnostic[]): GraphOperation | undefined {
  const path = `operations[${index}]`;
  if (!isRecord(value) || typeof value.type !== "string") {
    diagnostics.push(error("graph.invalidOperation", path, "Expected an operation object with a type."));
    return undefined;
  }
  const graphId = readIdentifier(value.graphId, `${path}.graphId`, diagnostics);
  switch (value.type) {
    case "graph.addNode": {
      const node = readNodes([value.node], `${path}.node`, diagnostics)[0];
      return graphId === undefined || node?.kind !== "node" ? undefined : { type: value.type, graphId, node };
    }
    case "graph.addSubgraph": {
      const node = readNodes([value.node], `${path}.node`, diagnostics)[0];
      const subgraph = readGraphs([value.subgraph], diagnostics)[0];
      return graphId === undefined || node?.kind !== "subgraph" || subgraph === undefined
        ? undefined
        : { type: value.type, graphId, node, subgraph };
    }
    case "graph.removeNode": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      return graphId === undefined || nodeId === undefined ? undefined : { type: value.type, graphId, nodeId };
    }
    case "graph.moveNode": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const position = readPosition(value.position, `${path}.position`, diagnostics);
      return graphId === undefined || nodeId === undefined || position === undefined
        ? undefined
        : { type: value.type, graphId, nodeId, position };
    }
    case "graph.updateNode": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const title = readString(value.title, `${path}.title`, diagnostics);
      const properties = readProperties(value.properties, `${path}.properties`, diagnostics);
      return graphId === undefined || nodeId === undefined || title === undefined || properties === undefined
        ? undefined
        : { type: value.type, graphId, nodeId, title, properties };
    }
    case "graph.replaceNodeType": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const nodeTypeId = readIdentifier(value.nodeTypeId, `${path}.nodeTypeId`, diagnostics);
      return graphId === undefined || nodeId === undefined || nodeTypeId === undefined
        ? undefined
        : { type: value.type, graphId, nodeId, nodeTypeId };
    }
    case "graph.addDynamicPort": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const port = readDynamicPorts([value.port], `${path}.port`, diagnostics)[0];
      return graphId === undefined || nodeId === undefined || port === undefined
        ? undefined
        : { type: value.type, graphId, nodeId, port };
    }
    case "graph.updateDynamicPort": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const portId = readIdentifier(value.portId, `${path}.portId`, diagnostics);
      const title = readString(value.title, `${path}.title`, diagnostics);
      const portValue = isJsonValue(value.value) ? value.value : undefined;
      if (portValue === undefined) {
        diagnostics.push(error("graph.invalidDynamicPortValue", `${path}.value`, "Expected a JSON value."));
      }
      return graphId === undefined || nodeId === undefined || portId === undefined || title === undefined || portValue === undefined
        ? undefined
        : { type: value.type, graphId, nodeId, portId, title, value: portValue };
    }
    case "graph.removeDynamicPort": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const portId = readIdentifier(value.portId, `${path}.portId`, diagnostics);
      return graphId === undefined || nodeId === undefined || portId === undefined
        ? undefined
        : { type: value.type, graphId, nodeId, portId };
    }
    case "graph.reorderDynamicPorts": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const portIds = readIdentifierList(value.portIds, `${path}.portIds`, diagnostics);
      return graphId === undefined || nodeId === undefined || portIds === undefined
        ? undefined
        : { type: value.type, graphId, nodeId, portIds };
    }
    case "graph.addEdge": {
      const edge = readEdges([value.edge], `${path}.edge`, diagnostics)[0];
      return graphId === undefined || edge === undefined ? undefined : { type: value.type, graphId, edge };
    }
    case "graph.removeEdge": {
      const edgeId = readIdentifier(value.edgeId, `${path}.edgeId`, diagnostics);
      return graphId === undefined || edgeId === undefined ? undefined : { type: value.type, graphId, edgeId };
    }
    case "graph.assignType": {
      const graphTypeId = readIdentifier(value.graphTypeId, `${path}.graphTypeId`, diagnostics);
      return graphId === undefined || graphTypeId === undefined
        ? undefined
        : { type: value.type, graphId, graphTypeId };
    }
    case "graph.updateGraph": {
      const title = readString(value.title, `${path}.title`, diagnostics);
      const properties = readProperties(value.properties, `${path}.properties`, diagnostics);
      return graphId === undefined || title === undefined || properties === undefined
        ? undefined
        : { type: value.type, graphId, title, properties };
    }
    case "graph.addInterfacePort": {
      const port = readInterfacePorts([value.port], `${path}.port`, diagnostics)[0];
      return graphId === undefined || port === undefined ? undefined : { type: value.type, graphId, port };
    }
    case "graph.updateInterfacePort": {
      const portId = readIdentifier(value.portId, `${path}.portId`, diagnostics);
      const title = readString(value.title, `${path}.title`, diagnostics);
      return graphId === undefined || portId === undefined || title === undefined
        ? undefined
        : { type: value.type, graphId, portId, title };
    }
    case "graph.removeInterfacePort": {
      const portId = readIdentifier(value.portId, `${path}.portId`, diagnostics);
      return graphId === undefined || portId === undefined ? undefined : { type: value.type, graphId, portId };
    }
    default:
      diagnostics.push(error("graph.unknownOperation", `${path}.type`, `Unknown operation '${value.type}'.`));
      return undefined;
  }
}

function applyOperation(
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
        if (!hasPropertyValue(nextProperties, property) && property.defaultValue !== undefined) {
          nextProperties[property.id] = cloneJsonValue(property.defaultValue);
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
        if (!hasPropertyValue(graph.properties, property) && property.defaultValue !== undefined) {
          graph.properties[property.id] = cloneJsonValue(property.defaultValue);
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
  }
}

function validateStructure(document: GraphDocument): DocumentDiagnostic[] {
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

function validateAtomicNode(
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
      if (!matchesPropertyType(value, definition)) {
        diagnostics.push(error("graph.propertyTypeMismatch", `${path}.properties.${propertyId}`, `Property '${propertyId}' must be ${definition.valueType}.`));
      }
    }
  });
  nodeType.properties.forEach((property) => {
    if (property.required && !hasPropertyValue(node.properties, property) && property.defaultValue === undefined) {
      diagnostics.push(error("graph.missingRequiredProperty", `${path}.properties.${property.id}`, `Required property '${property.id}' is missing.`));
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
    if (!matchesDynamicPortValue(port.value, group)) {
      diagnostics.push(error(
        "graph.dynamicPortValueTypeMismatch",
        `${portPath}.value`,
        `Dynamic port value must be ${group.item.valueType}.`,
      ));
    }
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

function validateGraphType(
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

function validateSubgraphNode(
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

function validateNodeAllowed(
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

function isNodeTypeAllowedForGraph(
  graph: GraphDefinition,
  nodeType: GraphNodeTypeDefinition,
  catalog: GraphCatalogRegistry,
): boolean {
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphType(catalog, graph.graphTypeId);
  return graphType === undefined || isNodeTypeAllowed(graphType, nodeType);
}

function replacementRespectsNodeConstraints(
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

function validateNodeConstraints(
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

function validateDeclaredProperties(
  properties: Readonly<Record<string, JsonValue>>,
  definitions: readonly GraphPropertyDefinition[],
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
    if (!matchesPropertyType(value, definition)) {
      diagnostics.push(error("graph.graphPropertyTypeMismatch", `${path}.${propertyId}`, `Property '${propertyId}' must be ${definition.valueType}.`));
    }
  });
  definitions.forEach((property) => {
    if (property.required && !hasPropertyValue(properties, property) && property.defaultValue === undefined) {
      diagnostics.push(error("graph.missingRequiredGraphProperty", `${path}.${property.id}`, `Required property '${property.id}' is missing.`));
    }
  });
}

function validateSemanticEdge(
  graph: GraphDefinition,
  edge: GraphEdge,
  path: string,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  const source = resolveEndpoint(graph, edge.source, nodeById, graphById, catalog);
  const target = resolveEndpoint(graph, edge.target, nodeById, graphById, catalog);
  if (source.issue !== undefined) {
    diagnostics.push(source.unknownNodeType
      ? warning("graph.unresolvedSourcePort", `${path}.source`, source.issue)
      : error("graph.invalidSourcePort", `${path}.source`, source.issue));
  }
  if (source.usedAlias) {
    diagnostics.push(warning("graph.portAlias", `${path}.source.portId`, `Port '${edge.source.portId}' is an alias of '${source.port?.id}'.`));
  }
  if (target.issue !== undefined) {
    diagnostics.push(target.unknownNodeType
      ? warning("graph.unresolvedTargetPort", `${path}.target`, target.issue)
      : error("graph.invalidTargetPort", `${path}.target`, target.issue));
  }
  if (target.usedAlias) {
    diagnostics.push(warning("graph.portAlias", `${path}.target.portId`, `Port '${edge.target.portId}' is an alias of '${target.port?.id}'.`));
  }
  if (source.port === undefined || target.port === undefined) {
    return;
  }
  if (source.port.direction !== "output") {
    diagnostics.push(error("graph.invalidSourceDirection", `${path}.source`, "An edge source must be an output port."));
  }
  if (target.port.direction !== "input") {
    diagnostics.push(error("graph.invalidTargetDirection", `${path}.target`, "An edge target must be an input port."));
  }
  if (source.port.kind !== edge.kind || target.port.kind !== edge.kind) {
    diagnostics.push(error("graph.edgeKindMismatch", path, `Edge kind '${edge.kind}' does not match both ports.`));
  }
  if (
    edge.kind === "data"
    && source.port.dataTypeId !== undefined
    && target.port.dataTypeId !== undefined
    && catalog !== undefined
    && !isDataTypeAssignable(catalog, source.port.dataTypeId, target.port.dataTypeId)
  ) {
    diagnostics.push(error(
      "graph.dataTypeMismatch",
      path,
      `Data type '${source.port.dataTypeId}' cannot connect to '${target.port.dataTypeId}'.`,
    ));
  }
}

function validateCardinality(
  graph: GraphDefinition,
  graphIndex: number,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  const counts = new Map<string, { readonly count: number; readonly endpoint: GraphEndpoint; readonly role: EndpointRole }>();
  graph.edges.forEach((edge) => {
    ([{ endpoint: edge.source, role: "source" }, { endpoint: edge.target, role: "target" }] as const).forEach(({ endpoint, role }) => {
      const resolved = resolveEndpoint(graph, endpoint, nodeById, graphById, catalog);
      const key = `${role}|${endpointKey(endpoint, resolved.port?.id)}`;
      const current = counts.get(key);
      counts.set(key, { endpoint, role, count: (current?.count ?? 0) + 1 });
    });
  });
  counts.forEach(({ count, endpoint, role }) => {
    const resolved = resolveEndpoint(graph, endpoint, nodeById, graphById, catalog);
    const maxConnections = resolved.port === undefined
      ? undefined
      : getEffectiveMaxConnections(graph, resolved.port, catalog);
    if (maxConnections !== undefined && count > maxConnections) {
      diagnostics.push(error(
        "graph.tooManyConnections",
        `graphs[${graphIndex}].edges`,
        `${endpointKey(endpoint)} has ${count} connections but allows ${maxConnections}.`,
      ));
    }
  });
}

function getEffectiveMaxConnections(
  graph: GraphDefinition,
  port: GraphResolvedPort,
  catalog: GraphCatalogRegistry | undefined,
): number | undefined {
  const graphType = graph.graphTypeId === undefined || catalog === undefined
    ? undefined
    : resolveGraphType(catalog, graph.graphTypeId);
  const graphTypeLimit = graphType?.portConnectionRules[port.direction] === "single" ? 1 : undefined;
  if (graphTypeLimit === undefined) {
    return port.maxConnections;
  }
  return port.maxConnections === undefined ? graphTypeLimit : Math.min(graphTypeLimit, port.maxConnections);
}

function validateSemanticDuplicateConnections(
  graph: GraphDefinition,
  graphIndex: number,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  const connections = new Set<string>();
  graph.edges.forEach((edge, edgeIndex) => {
    const source = resolveEndpoint(graph, edge.source, nodeById, graphById, catalog);
    const target = resolveEndpoint(graph, edge.target, nodeById, graphById, catalog);
    const key = `${edge.kind}|${endpointKey(edge.source, source.port?.id)}|${endpointKey(edge.target, target.port?.id)}`;
    if (connections.has(key)) {
      diagnostics.push(error(
        "graph.duplicateSemanticConnection",
        `graphs[${graphIndex}].edges[${edgeIndex}]`,
        "Connections using canonical and aliased port IDs cannot target the same endpoints twice.",
      ));
    }
    connections.add(key);
  });
}

type EndpointRole = "source" | "target";

function resolveEndpoint(
  graph: GraphDefinition,
  endpoint: GraphEndpoint,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog?: GraphCatalogRegistry,
): { readonly port?: GraphResolvedPort; readonly issue?: string; readonly unknownNodeType?: boolean; readonly usedAlias?: boolean } {
  if (endpoint.kind === "interface") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === endpoint.portId);
    if (port === undefined) {
      return { issue: `Interface port '${endpoint.portId}' does not exist.` };
    }
    const effectiveDirection: GraphPortDirection = port.direction === "input" ? "output" : "input";
    return {
      port: {
        ...port,
        direction: effectiveDirection,
        ...(effectiveDirection === "input" ? { maxConnections: 1 } : {}),
      },
    };
  }
  const node = nodeById.get(endpoint.nodeId);
  if (node === undefined) {
    return { issue: `Node '${endpoint.nodeId}' does not exist.` };
  }
  if (node.kind === "subgraph") {
    const subgraph = graphById.get(node.subgraphId);
    const nodeType = catalog === undefined || node.nodeTypeId === undefined
      ? undefined
      : resolveNodeType(catalog, node.nodeTypeId);
    const typedPort = nodeType === undefined ? undefined : resolveTypedNodePort(node as GraphSubgraphNode & { readonly nodeTypeId: string }, nodeType, endpoint.portId);
    const port = typedPort ?? subgraph?.interfacePorts.find((candidate) => candidate.id === endpoint.portId);
    return port === undefined
      ? {
          issue: node.nodeTypeId !== undefined && nodeType === undefined
            ? `Subgraph node type '${node.nodeTypeId}' is unknown; port '${endpoint.portId}' cannot be verified.`
            : `Subgraph port '${endpoint.portId}' does not exist.`,
          ...(node.nodeTypeId !== undefined && nodeType === undefined ? { unknownNodeType: true } : {}),
        }
      : { port, usedAlias: port.id !== endpoint.portId };
  }
  if (catalog === undefined) {
    return { issue: `Catalog is unavailable for node type '${node.nodeTypeId}'.`, unknownNodeType: true };
  }
  const nodeType = resolveNodeType(catalog, node.nodeTypeId);
  if (nodeType === undefined) {
    return { issue: `Node type '${node.nodeTypeId}' is unknown; port '${endpoint.portId}' cannot be verified.`, unknownNodeType: true };
  }
  const port = resolveAtomicNodePort(node, nodeType, endpoint.portId);
  return port === undefined
    ? { issue: `Port '${endpoint.portId}' does not exist on '${nodeType.id}'.` }
    : { port, usedAlias: port.id !== endpoint.portId };
}

function getAtomicNodePorts(
  node: GraphAtomicNode,
  nodeType: GraphNodeTypeDefinition,
): readonly GraphResolvedPort[] {
  return getTypedNodePorts(node, nodeType);
}

function getTypedNodePorts(
  node: GraphAtomicNode | (GraphSubgraphNode & { readonly nodeTypeId: string }),
  nodeType: GraphNodeTypeDefinition,
): readonly GraphResolvedPort[] {
  return [
    ...nodeType.ports,
    ...node.dynamicPorts.flatMap((dynamicPort) => {
      const group = resolveDynamicPortGroup(nodeType, dynamicPort.groupId);
      return group === undefined
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

function resolveTypedNodePort(
  node: GraphAtomicNode | (GraphSubgraphNode & { readonly nodeTypeId: string }),
  nodeType: GraphNodeTypeDefinition,
  portId: string,
): GraphResolvedPort | undefined {
  return resolvePortDefinition(nodeType, portId)
    ?? getTypedNodePorts(node, nodeType).find((port) => port.id === portId);
}

function resolveAtomicNodePort(
  node: GraphAtomicNode,
  nodeType: GraphNodeTypeDefinition,
  portId: string,
): GraphResolvedPort | undefined {
  return resolvePortDefinition(nodeType, portId)
    ?? getAtomicNodePorts(node, nodeType).find((port) => port.id === portId);
}

function replacementIssue(
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
    if (value !== undefined && !matchesPropertyType(value, property)) {
      return `Property '${propertyId}' is incompatible with '${targetType.title}'.`;
    }
  }
  for (const property of targetType.properties) {
    if (property.required && !hasPropertyValue(node.properties, property) && property.defaultValue === undefined) {
      return `Required property '${property.id}' has no value or default.`;
    }
  }
  const dynamicGroupCounts = new Map<string, number>();
  for (const dynamicPort of node.dynamicPorts) {
    if (resolvePortDefinition(targetType, dynamicPort.id) !== undefined) {
      return `Dynamic port '${dynamicPort.id}' collides with a static port on '${targetType.title}'.`;
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

function validateEndpointExists(
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

function validateContainmentCycles(
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

interface MutableGraphNodeBase {
  id: string;
  title: string;
  position: GraphPosition;
  properties: Record<string, JsonValue>;
}

interface MutableGraphAtomicNode extends MutableGraphNodeBase {
  kind: "node";
  nodeTypeId: string;
  dynamicPorts: MutableGraphDynamicPort[];
}

interface MutableGraphDynamicPort {
  id: string;
  groupId: string;
  title: string;
  value: JsonValue;
}

interface MutableGraphSubgraphNode extends MutableGraphNodeBase {
  kind: "subgraph";
  nodeTypeId?: string;
  subgraphId: string;
  dynamicPorts: MutableGraphDynamicPort[];
}

type MutableGraphNode = MutableGraphAtomicNode | MutableGraphSubgraphNode;

interface MutableGraphDefinition {
  id: string;
  graphTypeId?: string;
  title: string;
  properties: Record<string, JsonValue>;
  interfacePorts: MutableGraphInterfacePort[];
  nodes: MutableGraphNode[];
  edges: GraphEdge[];
}

interface MutableGraphInterfacePort {
  id: string;
  title: string;
  kind: GraphPortKind;
  direction: GraphPortDirection;
  dataTypeId?: string;
  maxConnections?: number;
}

interface MutableGraphDocument {
  formatVersion: typeof GRAPH_DOCUMENT_FORMAT_VERSION;
  documentId: string;
  rootGraphId: string;
  graphs: MutableGraphDefinition[];
}

function cloneDocument(document: GraphDocument): MutableGraphDocument {
  return {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    rootGraphId: document.rootGraphId,
    graphs: document.graphs.map(cloneGraph),
  };
}

function cloneGraph(graph: GraphDefinition): MutableGraphDefinition {
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

function cloneNode(node: GraphNode): MutableGraphNode {
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

function cloneEdge(edge: GraphEdge): GraphEdge {
  return { ...edge, source: { ...edge.source }, target: { ...edge.target } };
}

function removeOwnedGraph(document: MutableGraphDocument, graphId: string): void {
  const graph = document.graphs.find((candidate) => candidate.id === graphId);
  graph?.nodes.forEach((node) => {
    if (node.kind === "subgraph") {
      removeOwnedGraph(document, node.subgraphId);
    }
  });
  document.graphs = document.graphs.filter((candidate) => candidate.id !== graphId);
}

function allNodes(document: GraphDocument): readonly GraphNode[] {
  return document.graphs.flatMap((graph) => graph.nodes);
}

function allEdges(document: GraphDocument): readonly GraphEdge[] {
  return document.graphs.flatMap((graph) => graph.edges);
}

function edgeUsesNode(edge: GraphEdge, nodeId: string): boolean {
  return (edge.source.kind === "node" && edge.source.nodeId === nodeId)
    || (edge.target.kind === "node" && edge.target.nodeId === nodeId);
}

function edgeUsesNodePort(edge: GraphEdge, nodeId: string, portId: string): boolean {
  return (edge.source.kind === "node" && edge.source.nodeId === nodeId && edge.source.portId === portId)
    || (edge.target.kind === "node" && edge.target.nodeId === nodeId && edge.target.portId === portId);
}

function edgeUsesAtomicNodeResolvedPort(
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

function edgeUsesInterfacePort(edge: GraphEdge, portId: string): boolean {
  return (edge.source.kind === "interface" && edge.source.portId === portId)
    || (edge.target.kind === "interface" && edge.target.portId === portId);
}

function sameConnection(left: GraphEdge, right: GraphEdge): boolean {
  return left.kind === right.kind && sameEndpoint(left.source, right.source) && sameEndpoint(left.target, right.target);
}

function sameEndpoint(left: GraphEndpoint, right: GraphEndpoint): boolean {
  return left.kind === right.kind
    && left.portId === right.portId
    && (left.kind === "interface" || (right.kind === "node" && left.nodeId === right.nodeId));
}

function endpointKey(endpoint: GraphEndpoint, resolvedPortId = endpoint.portId): string {
  return endpoint.kind === "node"
    ? `${endpoint.kind}:${endpoint.nodeId}:${resolvedPortId}`
    : `${endpoint.kind}:${resolvedPortId}`;
}

function serializeEndpoint(endpoint: GraphEndpoint): GraphEndpoint {
  return endpoint.kind === "node"
    ? { kind: endpoint.kind, nodeId: endpoint.nodeId, portId: endpoint.portId }
    : { kind: endpoint.kind, portId: endpoint.portId };
}

function matchesPropertyType(value: JsonValue, definition: GraphPropertyDefinition): boolean {
  return definition.valueType === "json" || typeof value === definition.valueType;
}

function matchesDynamicPortValue(value: JsonValue, group: GraphDynamicPortGroupDefinition): boolean {
  return group.item.valueType === "json" || typeof value === group.item.valueType;
}

function hasPropertyValue(
  properties: Readonly<Record<string, JsonValue>>,
  definition: GraphPropertyDefinition,
): boolean {
  return [definition.id, ...definition.aliases].some((propertyId) => properties[propertyId] !== undefined);
}

function diagnosticCounts(diagnostics: readonly DocumentDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  diagnostics.filter((diagnostic) => diagnostic.severity === "error").forEach((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.code}|${diagnostic.path}`;
}

function readPosition(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): GraphPosition | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
    diagnostics.push(error("graph.invalidPosition", path, "Position x and y must be finite numbers."));
    return undefined;
  }
  checkKeys(value, ["x", "y"], path, diagnostics);
  return { x: value.x, y: value.y };
}

function readProperties(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): Readonly<Record<string, JsonValue>> | undefined {
  if (!isRecord(value) || !isJsonValue(value)) {
    diagnostics.push(error("graph.invalidProperties", path, "Expected a JSON object."));
    return undefined;
  }
  return value;
}

function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("graph.invalidIdentifier", path, "Expected an identifier using letters, digits, '.', '_' or '-'."));
    return undefined;
  }
  return value;
}

function readIdentifierList(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graph.invalidIdentifierList", path, "Expected an array of stable identifiers."));
    return undefined;
  }
  const result = value.flatMap((entry, index) => {
    const id = readIdentifier(entry, `${path}[${index}]`, diagnostics);
    return id === undefined ? [] : [id];
  });
  return result.length === value.length ? result : undefined;
}

function readString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string") {
    diagnostics.push(error("graph.invalidString", path, "Expected a string."));
    return undefined;
  }
  return value;
}

function readPositiveInteger(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    diagnostics.push(error("graph.invalidPositiveInteger", path, "Expected a positive integer."));
    return undefined;
  }
  return value;
}

function readEnum<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): TValue | undefined {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    diagnostics.push(error("graph.invalidEnum", path, `Expected one of: ${allowed.join(", ")}.`));
    return undefined;
  }
  return value as TValue;
}

function checkKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const allowed = new Set(allowedKeys);
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) {
      diagnostics.push(error("graph.unknownProperty", path === "$" ? key : `${path}.${key}`, `Unknown property '${key}'.`));
    }
  });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonObject(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sortJsonObject(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key] as JsonValue)]));
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isRecord(value)) {
    return sortJsonObject(value as Record<string, JsonValue>);
  }
  return value;
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function warning(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "warning", code, path, message };
}

function failure(code: string, path: string, message: string): DocumentParseResult<never> {
  return { success: false, diagnostics: [error(code, path, message)] };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : "Unknown JSON parse error.";
}

const EMPTY_CATALOG: GraphCatalogRegistry = {
  catalogs: [],
  dataTypes: [],
  graphTypes: [],
  nodeTypes: [],
};
