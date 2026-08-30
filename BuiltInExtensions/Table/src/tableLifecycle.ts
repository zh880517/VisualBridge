import {
  compareUtf16CodeUnits,
  referenceValuesEqual,
  type DocumentDiagnostic,
  type DocumentLifecycleDeleteTarget,
  type JsonValue,
  type OwnedStableIdentity,
  type StableIdentityRemap,
} from "@visualbridge/core";
import { resolveTableColumn, resolveTableSheet, type TableTypeDefinition } from "./tableCatalog";
import {
  applyTableOperations,
  resolveEffectiveTableRows,
  type TableDocument,
  type TableOperation,
} from "./tableDocument";

export interface TableOwnedIdentity extends OwnedStableIdentity {
  readonly identityKey: string;
  readonly kind: "table.row" | "table.dedup";
  readonly collisionScope: string;
  readonly value: string | number;
}

export type TableStableIdentityRemap = StableIdentityRemap;

export function collectTableOwnedIdentities(
  document: TableDocument,
  tableType: TableTypeDefinition,
  documentTypeId: string,
): readonly TableOwnedIdentity[] {
  const identities = new Map<string, TableOwnedIdentity>();
  for (const sheet of document.sheets) {
    const definition = resolveTableSheet(tableType, sheet.definitionId);
    if (definition === undefined) continue;
    const keyColumn = definition.keyColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.keyColumnId);
    const deduplicateColumn = definition.partition?.deduplicateByColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.partition.deduplicateByColumnId);
    for (const row of sheet.rows) {
      if (keyColumn !== undefined) {
        const value = row.cells[keyColumn.id];
        if (typeof value === "string" || typeof value === "number") {
          const identityKey = tableRowIdentityKey(definition.id, value);
          // A stable Table identity is the typed key value, not a physical row. Partition
          // duplicates therefore share one explicit remap, while every physical occurrence
          // is still rewritten below. keepFirst/keepLast only chooses the effective view.
          if (!identities.has(identityKey)) identities.set(identityKey, {
            identityKey,
            kind: "table.row",
            collisionScope: `${documentTypeId}:${tableType.id}:${definition.id}:row`,
            value,
            reference: {
              definition: {
                kind: "table.row",
                target: {
                  tableTypeId: tableType.id,
                  sheetId: definition.id,
                  documentTypeId,
                },
                allowMissing: false,
              },
            },
          });
        }
      }
      if (deduplicateColumn !== undefined && deduplicateColumn.id !== keyColumn?.id) {
        const value = row.cells[deduplicateColumn.id];
        if (typeof value === "string" || typeof value === "number") {
          const identityKey = tableDedupIdentityKey(definition.id, value);
          if (!identities.has(identityKey)) identities.set(identityKey, {
            identityKey,
            kind: "table.dedup",
            collisionScope: `${documentTypeId}:${tableType.id}:${definition.id}:dedup`,
            value,
          });
        }
      }
    }
  }
  return [...identities.values()].sort((left, right) => compareUtf16CodeUnits(left.identityKey, right.identityKey));
}

export function collectAddressableTableIdentityKeys(
  document: TableDocument,
  tableType: TableTypeDefinition,
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const definition of tableType.sheets) {
    const keyColumn = definition.keyColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.keyColumnId);
    if (keyColumn === undefined) continue;
    for (const entry of resolveEffectiveTableRows(document, tableType, definition.id).rows) {
      const value = entry.row.cells[keyColumn.id];
      if (typeof value === "string" || typeof value === "number") {
        const identityKey = tableRowIdentityKey(definition.id, value);
        counts.set(identityKey, (counts.get(identityKey) ?? 0) + 1);
      }
    }
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([identityKey]) => identityKey));
}

export function remapTableOwnedIdentities(
  document: TableDocument,
  tableType: TableTypeDefinition,
  documentTypeId: string,
  remaps: readonly TableStableIdentityRemap[],
): ReturnType<typeof applyTableOperations> {
  const identities = collectTableOwnedIdentities(document, tableType, documentTypeId);
  const parsed = requireCompleteRemap(identities, remaps);
  if (!parsed.success) return parsed;
  const operations: TableOperation[] = [];
  for (const sheet of document.sheets) {
    const definition = resolveTableSheet(tableType, sheet.definitionId);
    if (definition === undefined) continue;
    const keyColumn = definition.keyColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.keyColumnId);
    const deduplicateColumn = definition.partition?.deduplicateByColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.partition.deduplicateByColumnId);
    for (const row of sheet.rows) {
      const columns = [
        ...(keyColumn === undefined ? [] : [{
          columnId: keyColumn.id,
          key: tableRowIdentityKey,
        }]),
        ...(deduplicateColumn === undefined
          || deduplicateColumn.id === keyColumn?.id
          ? []
          : [{
              columnId: deduplicateColumn.id,
              key: tableDedupIdentityKey,
            }]),
      ];
      for (const column of columns) {
        const value = row.cells[column.columnId];
        if (typeof value !== "string" && typeof value !== "number") continue;
        const replacement = parsed.byKey.get(column.key(definition.id, value))!.to;
        operations.push({
          type: "table.setCell",
          sheetId: sheet.id,
          rowId: row.id,
          columnId: column.columnId,
          value: replacement,
        });
      }
    }
  }
  return operations.length === 0
    ? { success: true, document, diagnostics: [] }
    : applyTableOperations(document, operations, tableType);
}

export function deleteTableOwnedTarget(
  document: TableDocument,
  tableType: TableTypeDefinition,
  target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
): ReturnType<typeof applyTableOperations> {
  return target.kind === "table.row"
    ? applyTableOperations(document, [{ type: "table.removeRow", sheetId: target.sheetId, rowId: target.rowId }], tableType)
    : { success: false, diagnostics: [error("target", `Table lifecycle cannot delete '${target.kind}'.`)] };
}

export function tableRowIdentityKey(sheetDefinitionId: string, value: string | number): string {
  return `table.row:${JSON.stringify([sheetDefinitionId, typeof value, value])}`;
}

export function tableDedupIdentityKey(sheetDefinitionId: string, value: string | number): string {
  return `table.dedup:${JSON.stringify([sheetDefinitionId, typeof value, value])}`;
}

function requireCompleteRemap(
  identities: readonly TableOwnedIdentity[],
  remaps: readonly TableStableIdentityRemap[],
): { readonly success: true; readonly byKey: ReadonlyMap<string, TableStableIdentityRemap> }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] } {
  const diagnostics: DocumentDiagnostic[] = [];
  const byKey = new Map<string, TableStableIdentityRemap>();
  remaps.forEach((remap, index) => {
    if (byKey.has(remap.identityKey)) {
      diagnostics.push(error(`stableIdRemap[${index}].identityKey`, "Duplicate identity remap key."));
    } else {
      byKey.set(remap.identityKey, remap);
    }
  });
  const expected = new Set(identities.map((entry) => entry.identityKey));
  identities.forEach((entry) => {
    const remap = byKey.get(entry.identityKey);
    if (remap === undefined) {
      diagnostics.push(error("stableIdRemap", `Missing remap for '${entry.identityKey}'.`));
    } else if (!referenceValuesEqual(remap.from, entry.value)) {
      diagnostics.push(error("stableIdRemap", `Remap '${entry.identityKey}' does not match the owned Table key.`));
    } else if (typeof remap.to !== typeof remap.from || referenceValuesEqual(remap.to, remap.from)) {
      diagnostics.push(error("stableIdRemap", `Remap '${entry.identityKey}' must preserve key type and change its value.`));
    }
  });
  for (const key of byKey.keys()) {
    if (!expected.has(key)) diagnostics.push(error("stableIdRemap", `Unexpected remap '${key}'.`));
  }
  const targets = new Set<string>();
  remaps.forEach((remap) => {
    const owned = identities.find((identity) => identity.identityKey === remap.identityKey);
    const target = `${owned?.kind ?? "unknown"}\u0000${owned?.collisionScope ?? "unknown"}\u0000${typeof remap.to}\u0000${String(remap.to)}`;
    if (targets.has(target)) diagnostics.push(error("stableIdRemap", `Duplicate Table key target '${String(remap.to)}'.`));
    targets.add(target);
  });
  return diagnostics.length > 0 ? { success: false, diagnostics } : { success: true, byKey };
}

function error(path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code: "lifecycle.invalidStableIdRemap", path, message };
}
