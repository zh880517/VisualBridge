// Graph document parsing and value readers.
import type { DocumentDiagnostic, DocumentParseResult } from "@visualbridge/core";
import { error, failure, formatError } from "./diagnostics";
import { isFiniteNumber, isJsonValue, isRecord } from "./json";
import {
  GRAPH_DOCUMENT_FORMAT_VERSION,
  type GraphDefinition,
  type GraphDocument,
  type GraphDynamicPort,
  type GraphEdge,
  type GraphEndpoint,
  type GraphInterfacePort,
  type GraphNode,
  type GraphPosition,
  type JsonValue,
} from "./types";
import { validateStructure } from "./validationStructure";


export function parseGraphDocument(text: string): DocumentParseResult<GraphDocument> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("graph.invalidJson", "$", formatError(errorValue));
  }
  return parseGraphDocumentValue(value);
}

export function parseGraphDocumentValue(value: unknown): DocumentParseResult<GraphDocument> {
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

export function readGraphs(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphDefinition[] {
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

export function readNodes(value: unknown, basePath: string, diagnostics: DocumentDiagnostic[]): readonly GraphNode[] {
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

export function readDynamicPorts(
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

export function readEdges(value: unknown, basePath: string, diagnostics: DocumentDiagnostic[]): readonly GraphEdge[] {
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

export function readEndpoint(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): GraphEndpoint | undefined {
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

export function readInterfacePorts(
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
    checkKeys(entry, ["id", "title", "kind", "direction", "dataTypeId", "maxConnections", "dynamic"], path, diagnostics);
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
    const dynamic = entry.dynamic === undefined
      ? false
      : readBoolean(entry.dynamic, `${path}.dynamic`, diagnostics);
    if (kind === "data" && dataTypeId === undefined) {
      diagnostics.push(error("graph.missingDataType", `${path}.dataTypeId`, "Data interface ports require dataTypeId."));
    }
    if (kind === "flow" && dataTypeId !== undefined) {
      diagnostics.push(error("graph.unexpectedDataType", `${path}.dataTypeId`, "Flow interface ports cannot declare dataTypeId."));
    }
    if (kind === "flow" && dynamic === true) {
      diagnostics.push(error("graph.unexpectedDynamicInterfacePort", `${path}.dynamic`, "Flow interface ports cannot be dynamic."));
    }
    return id === undefined || title === undefined || kind === undefined || direction === undefined || dynamic === undefined
      ? []
      : [{
          id,
          title,
          kind,
          direction,
          ...(dataTypeId === undefined ? {} : { dataTypeId }),
          ...(maxConnections === undefined ? {} : { maxConnections }),
          ...(dynamic ? { dynamic: true } : {}),
        }];
  });
}

export function readPosition(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): GraphPosition | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
    diagnostics.push(error("graph.invalidPosition", path, "Position x and y must be finite numbers."));
    return undefined;
  }
  checkKeys(value, ["x", "y"], path, diagnostics);
  return { x: value.x, y: value.y };
}

export function readProperties(
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

export function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("graph.invalidIdentifier", path, "Expected an identifier using letters, digits, '.', '_' or '-'."));
    return undefined;
  }
  return value;
}

export function readIdentifierList(
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

export function readString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string") {
    diagnostics.push(error("graph.invalidString", path, "Expected a string."));
    return undefined;
  }
  return value;
}

export function readBoolean(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): boolean | undefined {
  if (typeof value !== "boolean") {
    diagnostics.push(error("graph.invalidBoolean", path, "Expected a boolean."));
    return undefined;
  }
  return value;
}

export function readPositiveInteger(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    diagnostics.push(error("graph.invalidPositiveInteger", path, "Expected a positive integer."));
    return undefined;
  }
  return value;
}

export function readEnum<const TValue extends string>(
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

export function checkKeys(
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
