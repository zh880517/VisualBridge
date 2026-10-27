import type { CSSProperties } from "react";
import type { JsonValue } from "@visualbridge/module-sdk";
import type {
  DataTypeDefinition,
  GraphAtomicNode,
  GraphClipboardPayload,
  GraphDefinition,
  GraphDocument,
  GraphEdgeModel,
  GraphNodeEndpoint,
  Selection,
  SelectionHistoryEntry,
  SelectionSnapshot,
} from "../types";

export function keepValidSelection(selection: Selection | undefined, graph: GraphDefinition): Selection | undefined {
  if (selection === undefined) {
    return undefined;
  }
  const nodeIds = selection.nodeIds.filter((nodeId) => graph.nodes.some((node) => node.id === nodeId));
  const edgeIds = selection.edgeIds.filter((edgeId) => graph.edges.some((edge) => edge.id === edgeId));
  return nodeIds.length === 0 && edgeIds.length === 0 ? undefined : { nodeIds, edgeIds };
}

export function createSelectionSnapshot(graphId: string, selection: Selection | undefined): SelectionSnapshot {
  return {
    graphId,
    selection: selection === undefined
      ? undefined
      : { nodeIds: [...selection.nodeIds], edgeIds: [...selection.edgeIds] },
  };
}

export function consumeSelectionHistory(
  action: "undo" | "redo" | undefined,
  undoStack: SelectionHistoryEntry[],
  redoStack: SelectionHistoryEntry[],
): SelectionSnapshot | undefined {
  if (action === "undo") {
    const entry = undoStack.pop();
    if (entry !== undefined) {
      redoStack.push(entry);
      return entry.before;
    }
  }
  if (action === "redo") {
    const entry = redoStack.pop();
    if (entry !== undefined) {
      undoStack.push(entry);
      return entry.after;
    }
  }
  return undefined;
}

export function selectionsEqual(left: Selection | undefined, right: Selection | undefined): boolean {
  if (left === right) {
    return true;
  }
  return left !== undefined
    && right !== undefined
    && left.nodeIds.length === right.nodeIds.length
    && left.edgeIds.length === right.edgeIds.length
    && left.nodeIds.every((id, index) => id === right.nodeIds[index])
    && left.edgeIds.every((id, index) => id === right.edgeIds[index]);
}

export function findGraphPath(document: GraphDocument, targetGraphId: string): readonly GraphDefinition[] {
  const byId = new Map(document.graphs.map((graph) => [graph.id, graph]));
  const visit = (graphId: string, path: readonly GraphDefinition[]): readonly GraphDefinition[] | undefined => {
    const graph = byId.get(graphId);
    if (graph === undefined || path.some((item) => item.id === graphId)) {
      return undefined;
    }
    const nextPath = [...path, graph];
    if (graphId === targetGraphId) {
      return nextPath;
    }
    for (const node of graph.nodes) {
      if (node.kind === "subgraph") {
        const result = visit(node.subgraphId, nextPath);
        if (result !== undefined) {
          return result;
        }
      }
    }
    return undefined;
  };
  return visit(document.rootGraphId, []) ?? [];
}

export function parseGraphClipboardPayload(text: string): GraphClipboardPayload | undefined {
  if (text.length === 0 || text.length > 2_000_000) {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (
      !isRecordValue(value)
      || value.format !== "visualbridge.graph-clipboard"
      || value.version !== 1
      || !Array.isArray(value.nodes)
      || value.nodes.length === 0
      || !value.nodes.every(isClipboardAtomicNode)
      || !Array.isArray(value.edges)
      || !value.edges.every(isClipboardEdge)
    ) {
      return undefined;
    }
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    if (nodeIds.size !== value.nodes.length || value.edges.some((edge) =>
      !nodeIds.has(edge.source.nodeId) || !nodeIds.has(edge.target.nodeId),
    )) {
      return undefined;
    }
    return {
      format: "visualbridge.graph-clipboard",
      version: 1,
      nodes: value.nodes.map(cloneGraphAtomicNode),
      edges: value.edges.map(cloneGraphEdge),
    };
  } catch {
    return undefined;
  }
}

function isClipboardAtomicNode(value: unknown): value is GraphAtomicNode {
  return isRecordValue(value)
    && value.kind === "node"
    && isIdentifierValue(value.id)
    && isIdentifierValue(value.nodeTypeId)
    && typeof value.title === "string"
    && isRecordValue(value.position)
    && typeof value.position.x === "number"
    && Number.isFinite(value.position.x)
    && typeof value.position.y === "number"
    && Number.isFinite(value.position.y)
    && isJsonObject(value.properties)
    && Array.isArray(value.dynamicPorts)
    && value.dynamicPorts.every((port) =>
      isRecordValue(port)
      && isIdentifierValue(port.id)
      && isIdentifierValue(port.groupId)
      && typeof port.title === "string"
      && isJsonValue(port.value),
    );
}

function isClipboardEdge(value: unknown): value is GraphEdgeModel & {
  readonly source: GraphNodeEndpoint;
  readonly target: GraphNodeEndpoint;
} {
  return isRecordValue(value)
    && isIdentifierValue(value.id)
    && (value.kind === "flow" || value.kind === "data")
    && isClipboardNodeEndpoint(value.source)
    && isClipboardNodeEndpoint(value.target);
}

function isClipboardNodeEndpoint(value: unknown): value is GraphNodeEndpoint {
  return isRecordValue(value)
    && value.kind === "node"
    && isIdentifierValue(value.nodeId)
    && isIdentifierValue(value.portId);
}

function isIdentifierValue(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneGraphAtomicNode(node: GraphAtomicNode): GraphAtomicNode {
  return JSON.parse(JSON.stringify(node)) as GraphAtomicNode;
}

export function cloneGraphEdge(edge: GraphEdgeModel): GraphEdgeModel {
  return JSON.parse(JSON.stringify(edge)) as GraphEdgeModel;
}

export function reorderIds(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): readonly string[] | undefined {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) {
    return undefined;
  }
  const result = ids.filter((id) => id !== sourceId);
  const targetIndex = result.indexOf(targetId);
  result.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceId);
  return result;
}

export function newId(prefix: string): string {
  const suffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);
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
  return isJsonObject(value);
}

const DEFAULT_GRAPH_DATA_TYPE_COLORS = [
  "#4DA3FF",
  "#FF8A65",
  "#66BB6A",
  "#AB77E6",
  "#F2C94C",
  "#26C6DA",
  "#EC6F9F",
  "#9CCC65",
  "#FFB74D",
  "#7E8CE0",
  "#26A69A",
  "#B0BEC5",
] as const;

export type GraphDataColorStyle = CSSProperties & { readonly "--graph-data-color": string };

export function resolveGraphDataTypeColor(
  dataTypeId: string | undefined,
  dataTypes: readonly DataTypeDefinition[],
): string | undefined {
  if (dataTypeId === undefined) {
    return undefined;
  }
  const configuredColor = dataTypes.find((dataType) => dataType.id === dataTypeId)?.color;
  if (configuredColor !== undefined) {
    return configuredColor;
  }
  if (dataTypeId === "any") {
    return "#B8BEC5";
  }
  let hash = 2166136261;
  for (let index = 0; index < dataTypeId.length; index += 1) {
    hash ^= dataTypeId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return DEFAULT_GRAPH_DATA_TYPE_COLORS[(hash >>> 0) % DEFAULT_GRAPH_DATA_TYPE_COLORS.length];
}

export function graphDataTypeStyle(
  dataTypeId: string | undefined,
  dataTypes: readonly DataTypeDefinition[],
): GraphDataColorStyle | undefined {
  const color = resolveGraphDataTypeColor(dataTypeId, dataTypes);
  return color === undefined ? undefined : { "--graph-data-color": color };
}
