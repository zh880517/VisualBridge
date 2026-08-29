import type { DocumentLifecycleDeleteTarget } from "@visualbridge/core";

const GUARDED_OPERATION_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  entity: new Set(["entity.removeComponent"]),
  graph: new Set(["graph.removeNode", "graph.removeInterfacePort", "graph.removeDynamicPort"]),
  table: new Set(["table.removeRow"]),
};

const REFACTOR_GUARDED_OPERATION_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  entity: new Set(["entity.renameComponent"]),
  graph: new Set(["graph.renameElement"]),
};

export function containsLifecycleGuardedRemoval(editor: string, operations: unknown): boolean {
  const guarded = GUARDED_OPERATION_TYPES[editor];
  return guarded !== undefined
    && Array.isArray(operations)
    && operations.some((operation) => (
      typeof operation === "object"
      && operation !== null
      && !Array.isArray(operation)
      && guarded.has((operation as { readonly type?: unknown }).type as string)
    ));
}

export function lifecycleDeleteTarget(
  editor: string,
  operations: unknown,
): Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }> | undefined {
  if (!Array.isArray(operations) || operations.length !== 1) return undefined;
  const candidate = operations[0];
  if (typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
    || GUARDED_OPERATION_TYPES[editor]?.has((candidate as { readonly type?: unknown }).type as string) !== true) {
    return undefined;
  }
  const operation = candidate as Record<string, unknown>;
  if (editor === "entity" && operation.type === "entity.removeComponent" && typeof operation.componentId === "string") {
    return { kind: "entity.component", componentId: operation.componentId };
  }
  if (editor === "table" && operation.type === "table.removeRow"
    && typeof operation.sheetId === "string" && typeof operation.rowId === "string") {
    return { kind: "table.row", sheetId: operation.sheetId, rowId: operation.rowId };
  }
  if (editor !== "graph" || typeof operation.graphId !== "string") return undefined;
  if (operation.type === "graph.removeNode" && typeof operation.nodeId === "string") {
    return { kind: "graph.element", graphId: operation.graphId, elementKind: "node", elementId: operation.nodeId };
  }
  if (operation.type === "graph.removeInterfacePort" && typeof operation.portId === "string") {
    return { kind: "graph.element", graphId: operation.graphId, elementKind: "interfacePort", elementId: operation.portId };
  }
  if (operation.type === "graph.removeDynamicPort"
    && typeof operation.nodeId === "string" && typeof operation.portId === "string") {
    return {
      kind: "graph.element",
      graphId: operation.graphId,
      elementKind: "dynamicPort",
      elementId: operation.portId,
      nodeId: operation.nodeId,
    };
  }
  return undefined;
}

export function containsReferenceRefactorGuardedRename(editor: string, operations: unknown): boolean {
  const guarded = REFACTOR_GUARDED_OPERATION_TYPES[editor];
  return guarded !== undefined
    && Array.isArray(operations)
    && operations.some((operation) => (
      typeof operation === "object"
      && operation !== null
      && !Array.isArray(operation)
      && guarded.has((operation as { readonly type?: unknown }).type as string)
    ));
}

export const LIFECYCLE_REQUIRED_MESSAGE =
  "lifecycle.required: This target can only be removed through Safe Delete preview/apply.";

export const REFERENCE_REFACTOR_REQUIRED_MESSAGE =
  "refactor.required: Stable identity renames must use Reference Refactor preview/apply.";
