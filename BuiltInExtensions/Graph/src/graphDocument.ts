import type {
  DocumentDiagnostic,
  DocumentOperationResult,
  DocumentParseResult,
} from "@visualbridge/core";

export const GRAPH_DOCUMENT_FORMAT_VERSION = 1;
export const GRAPH_EDITOR_ID = "graph";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

export interface GraphNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly position: GraphPosition;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface GraphEndpoint {
  readonly nodeId: string;
  readonly portId: string;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: GraphEndpoint;
  readonly target: GraphEndpoint;
}

export interface GraphDocument {
  readonly formatVersion: typeof GRAPH_DOCUMENT_FORMAT_VERSION;
  readonly documentId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export type GraphOperation =
  | { readonly type: "graph.addNode"; readonly node: GraphNode }
  | { readonly type: "graph.removeNode"; readonly nodeId: string }
  | { readonly type: "graph.moveNode"; readonly nodeId: string; readonly position: GraphPosition }
  | {
      readonly type: "graph.updateNode";
      readonly nodeId: string;
      readonly nodeType: string;
      readonly title: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }
  | { readonly type: "graph.addEdge"; readonly edge: GraphEdge }
  | { readonly type: "graph.removeEdge"; readonly edgeId: string };

export function parseGraphDocument(text: string): DocumentParseResult<GraphDocument> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return parseFailure("graph.invalidJson", "$", formatJsonError(error));
  }

  return parseGraphDocumentValue(value);
}

export function serializeGraphDocument(document: GraphDocument): string {
  const normalized: GraphDocument = {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    nodes: [...document.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        position: { x: node.position.x, y: node.position.y },
        properties: sortJsonObject(node.properties),
      })),
    edges: [...document.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => ({
        id: edge.id,
        source: { nodeId: edge.source.nodeId, portId: edge.source.portId },
        target: { nodeId: edge.target.nodeId, portId: edge.target.portId },
      })),
  };

  return `${JSON.stringify(normalized, undefined, 2)}\n`;
}

export function applyGraphOperations(
  document: GraphDocument,
  operationsValue: unknown,
): DocumentOperationResult<GraphDocument> {
  const operationResult = parseOperations(operationsValue);
  if (!operationResult.success) {
    return operationResult;
  }

  const working: MutableGraphDocument = cloneDocument(document);
  for (let index = 0; index < operationResult.operations.length; index += 1) {
    const operation = operationResult.operations[index];
    if (operation === undefined) {
      continue;
    }
    const diagnostic = applyOperation(working, operation, index);
    if (diagnostic !== undefined) {
      return { success: false, diagnostics: [diagnostic] };
    }
  }

  const diagnostics = validateGraphDocument(working);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, diagnostics };
  }

  return { success: true, document: working, diagnostics };
}

export function validateGraphDocument(document: GraphDocument): readonly DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  document.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      diagnostics.push(error("graph.duplicateNodeId", `nodes[${index}].id`, `Duplicate node id '${node.id}'.`));
    }
    nodeIds.add(node.id);
  });

  document.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) {
      diagnostics.push(error("graph.duplicateEdgeId", `edges[${index}].id`, `Duplicate edge id '${edge.id}'.`));
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source.nodeId)) {
      diagnostics.push(error(
        "graph.missingSourceNode",
        `edges[${index}].source.nodeId`,
        `Source node '${edge.source.nodeId}' does not exist.`,
      ));
    }
    if (!nodeIds.has(edge.target.nodeId)) {
      diagnostics.push(error(
        "graph.missingTargetNode",
        `edges[${index}].target.nodeId`,
        `Target node '${edge.target.nodeId}' does not exist.`,
      ));
    }
  });

  return diagnostics;
}

function parseGraphDocumentValue(value: unknown): DocumentParseResult<GraphDocument> {
  if (!isRecord(value)) {
    return parseFailure("graph.invalidRoot", "$", "Graph document must contain a JSON object.");
  }

  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(value, ["formatVersion", "documentId", "nodes", "edges"], "$", diagnostics);
  if (value.formatVersion !== GRAPH_DOCUMENT_FORMAT_VERSION) {
    diagnostics.push(error(
      "graph.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${GRAPH_DOCUMENT_FORMAT_VERSION}.`,
    ));
  }

  const documentId = readIdentifier(value.documentId, "documentId", diagnostics);
  const nodes = readNodes(value.nodes, diagnostics);
  const edges = readEdges(value.edges, diagnostics);
  if (documentId === undefined) {
    return { success: false, diagnostics };
  }

  const document: GraphDocument = {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId,
    nodes,
    edges,
  };
  diagnostics.push(...validateGraphDocument(document));
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { success: false, diagnostics }
    : { success: true, document, diagnostics };
}

function readNodes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphNode[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graph.invalidNodes", "nodes", "Expected an array."));
    return [];
  }

  return value.flatMap((entry, index) => {
    const path = `nodes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graph.invalidNode", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "type", "title", "position", "properties"], path, diagnostics);

    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const type = readIdentifier(entry.type, `${path}.type`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const position = readPosition(entry.position, `${path}.position`, diagnostics);
    const properties = readProperties(entry.properties, `${path}.properties`, diagnostics);
    return id === undefined || type === undefined || title === undefined || position === undefined || properties === undefined
      ? []
      : [{ id, type, title, position, properties }];
  });
}

function readEdges(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphEdge[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graph.invalidEdges", "edges", "Expected an array."));
    return [];
  }

  return value.flatMap((entry, index) => {
    const path = `edges[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graph.invalidEdge", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "source", "target"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const source = readEndpoint(entry.source, `${path}.source`, diagnostics);
    const target = readEndpoint(entry.target, `${path}.target`, diagnostics);
    return id === undefined || source === undefined || target === undefined
      ? []
      : [{ id, source, target }];
  });
}

function readEndpoint(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphEndpoint | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graph.invalidEndpoint", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["nodeId", "portId"], path, diagnostics);
  const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
  const portId = readIdentifier(value.portId, `${path}.portId`, diagnostics);
  return nodeId === undefined || portId === undefined ? undefined : { nodeId, portId };
}

function readPosition(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphPosition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graph.invalidPosition", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["x", "y"], path, diagnostics);
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
    diagnostics.push(error("graph.invalidPosition", path, "Position x and y must be finite numbers."));
    return undefined;
  }
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
  return diagnostics.length > 0
    ? { success: false, diagnostics }
    : { success: true, operations };
}

function parseOperation(
  value: unknown,
  index: number,
  diagnostics: DocumentDiagnostic[],
): GraphOperation | undefined {
  const path = `operations[${index}]`;
  if (!isRecord(value) || typeof value.type !== "string") {
    diagnostics.push(error("graph.invalidOperation", path, "Expected an operation object with a type."));
    return undefined;
  }

  switch (value.type) {
    case "graph.addNode": {
      const result = readNodes([value.node], diagnostics);
      const node = result[0];
      return node === undefined ? undefined : { type: value.type, node };
    }
    case "graph.removeNode": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      return nodeId === undefined ? undefined : { type: value.type, nodeId };
    }
    case "graph.moveNode": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const position = readPosition(value.position, `${path}.position`, diagnostics);
      return nodeId === undefined || position === undefined ? undefined : { type: value.type, nodeId, position };
    }
    case "graph.updateNode": {
      const nodeId = readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      const nodeType = readIdentifier(value.nodeType, `${path}.nodeType`, diagnostics);
      const title = readString(value.title, `${path}.title`, diagnostics);
      const properties = readProperties(value.properties, `${path}.properties`, diagnostics);
      return nodeId === undefined || nodeType === undefined || title === undefined || properties === undefined
        ? undefined
        : { type: value.type, nodeId, nodeType, title, properties };
    }
    case "graph.addEdge": {
      const result = readEdges([value.edge], diagnostics);
      const edge = result[0];
      return edge === undefined ? undefined : { type: value.type, edge };
    }
    case "graph.removeEdge": {
      const edgeId = readIdentifier(value.edgeId, `${path}.edgeId`, diagnostics);
      return edgeId === undefined ? undefined : { type: value.type, edgeId };
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
): DocumentDiagnostic | undefined {
  const path = `operations[${index}]`;
  switch (operation.type) {
    case "graph.addNode":
      if (document.nodes.some((node) => node.id === operation.node.id)) {
        return error("graph.nodeAlreadyExists", path, `Node '${operation.node.id}' already exists.`);
      }
      document.nodes.push(operation.node);
      return undefined;
    case "graph.removeNode": {
      const nodeIndex = document.nodes.findIndex((node) => node.id === operation.nodeId);
      if (nodeIndex < 0) {
        return error("graph.nodeNotFound", path, `Node '${operation.nodeId}' does not exist.`);
      }
      document.nodes.splice(nodeIndex, 1);
      document.edges = document.edges.filter(
        (edge) => edge.source.nodeId !== operation.nodeId && edge.target.nodeId !== operation.nodeId,
      );
      return undefined;
    }
    case "graph.moveNode": {
      const node = document.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined) {
        return error("graph.nodeNotFound", path, `Node '${operation.nodeId}' does not exist.`);
      }
      node.position = operation.position;
      return undefined;
    }
    case "graph.updateNode": {
      const node = document.nodes.find((candidate) => candidate.id === operation.nodeId);
      if (node === undefined) {
        return error("graph.nodeNotFound", path, `Node '${operation.nodeId}' does not exist.`);
      }
      node.type = operation.nodeType;
      node.title = operation.title;
      node.properties = operation.properties;
      return undefined;
    }
    case "graph.addEdge":
      if (document.edges.some((edge) => edge.id === operation.edge.id)) {
        return error("graph.edgeAlreadyExists", path, `Edge '${operation.edge.id}' already exists.`);
      }
      document.edges.push(operation.edge);
      return undefined;
    case "graph.removeEdge": {
      const edgeIndex = document.edges.findIndex((edge) => edge.id === operation.edgeId);
      if (edgeIndex < 0) {
        return error("graph.edgeNotFound", path, `Edge '${operation.edgeId}' does not exist.`);
      }
      document.edges.splice(edgeIndex, 1);
      return undefined;
    }
  }
}

interface MutableGraphNode {
  id: string;
  type: string;
  title: string;
  position: GraphPosition;
  properties: Readonly<Record<string, JsonValue>>;
}

interface MutableGraphDocument {
  formatVersion: typeof GRAPH_DOCUMENT_FORMAT_VERSION;
  documentId: string;
  nodes: MutableGraphNode[];
  edges: GraphEdge[];
}

function cloneDocument(document: GraphDocument): MutableGraphDocument {
  return {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    nodes: document.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      properties: cloneJsonObject(node.properties),
    })),
    edges: document.edges.map((edge) => ({
      ...edge,
      source: { ...edge.source },
      target: { ...edge.target },
    })),
  };
}

function readIdentifier(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("graph.invalidIdentifier", path, "Expected an identifier using letters, digits, '.', '_' or '-'."));
    return undefined;
  }
  return value;
}

function readString(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): string | undefined {
  if (typeof value !== "string") {
    diagnostics.push(error("graph.invalidString", path, "Expected a string."));
    return undefined;
  }
  return value;
}

function checkKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push(error("graph.unknownProperty", path === "$" ? key : `${path}.${key}`, `Unknown property '${key}'.`));
    }
  }
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

function sortJsonObject(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key] as JsonValue)]),
  );
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

function parseFailure(code: string, path: string, message: string): DocumentParseResult<never> {
  return { success: false, diagnostics: [error(code, path, message)] };
}

function formatJsonError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : "Unknown JSON parse error.";
}
