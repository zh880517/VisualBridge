// Graph operation batch parsing and application entry points.
import type { DocumentDiagnostic, DocumentOperationResult } from "@visualbridge/module-sdk";
import type { GraphCatalogRegistry } from "../graphCatalog";
import { applyOperation, unlockUnconnectedDynamicInterfacePorts } from "./applyOperation";
import { diagnosticCounts, diagnosticKey, error } from "./diagnostics";
import { isJsonValue, isRecord } from "./json";
import { cloneDocument } from "./mutable";
import {
  readDynamicPorts,
  readEdges,
  readGraphs,
  readIdentifier,
  readIdentifierList,
  readInterfacePorts,
  readNodes,
  readPosition,
  readProperties,
  readString,
} from "./parse";
import type { GraphDocument, GraphOperation } from "./types";
import { validateGraphDocument } from "./validation";


export function renameGraphDocumentId(
  document: GraphDocument,
  documentId: string,
  catalog?: GraphCatalogRegistry,
): DocumentOperationResult<GraphDocument> {
  if (!isStableIdentifier(documentId)) {
    return { success: false, diagnostics: [error("graph.invalidIdentifier", "documentId", "Expected a stable identifier.")] };
  }
  if (document.documentId === documentId) {
    return { success: false, diagnostics: [error("graph.sameDocumentId", "documentId", "The new document ID must be different.")] };
  }
  const next: GraphDocument = { ...document, documentId };
  const diagnostics = validateGraphDocument(next, catalog);
  return { success: true, document: next, diagnostics };
}

export function isStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
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
    unlockUnconnectedDynamicInterfacePorts(working);
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

export function parseOperations(value: unknown):
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

export function parseOperation(value: unknown, index: number, diagnostics: DocumentDiagnostic[]): GraphOperation | undefined {
  const path = `operations[${index}]`;
  if (!isRecord(value) || typeof value.type !== "string") {
    diagnostics.push(error("graph.invalidOperation", path, "Expected an operation object with a type."));
    return undefined;
  }
  const graphId = readIdentifier(value.graphId, `${path}.graphId`, diagnostics);
  switch (value.type) {
    case "graph.renameElement": {
      const elementKind = value.elementKind === "graph"
        || value.elementKind === "node"
        || value.elementKind === "interfacePort"
        || value.elementKind === "dynamicPort"
        ? value.elementKind
        : undefined;
      if (elementKind === undefined) {
        diagnostics.push(error("graph.invalidElementKind", `${path}.elementKind`, "Expected graph, node, interfacePort, or dynamicPort."));
      }
      const elementId = readIdentifier(value.elementId, `${path}.elementId`, diagnostics);
      const newElementId = readIdentifier(value.newElementId, `${path}.newElementId`, diagnostics);
      const nodeId = value.nodeId === undefined ? undefined : readIdentifier(value.nodeId, `${path}.nodeId`, diagnostics);
      if (elementKind === "dynamicPort" && nodeId === undefined) {
        diagnostics.push(error("graph.missingNodeId", `${path}.nodeId`, "A dynamicPort rename requires its owning nodeId."));
      }
      return graphId === undefined || elementKind === undefined || elementId === undefined || newElementId === undefined
        || (elementKind === "dynamicPort" && nodeId === undefined)
        ? undefined
        : { type: value.type, graphId, elementKind, elementId, newElementId, ...(nodeId === undefined ? {} : { nodeId }) };
    }
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
    case "graph.reorderInterfacePorts": {
      const portIds = readIdentifierList(value.portIds, `${path}.portIds`, diagnostics);
      return graphId === undefined || portIds === undefined
        ? undefined
        : { type: value.type, graphId, portIds };
    }
    default:
      diagnostics.push(error("graph.unknownOperation", `${path}.type`, `Unknown operation '${value.type}'.`));
      return undefined;
  }
}
