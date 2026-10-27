/**
 * Table 模块的宿主语义面（附录 D.3 的 `storage: "sources"` / `semantic` / `referenceData` /
 * `references`）。
 *
 * 多源规划、解析与渲染复用 B2 的 `tableSourcesStorage`；`table.row` 的改名（稳定键单元格）
 * 也在本模块完成，宿主不再知道 Table 的 key column 与重复键规则。
 */
import type {
  DocumentDiagnostic,
  DocumentFacet,
  DocumentFacetContext,
  DocumentFacetSourceFile,
  DocumentOperationResult,
  JsonValue,
} from "@visualbridge/module-sdk";
import { referenceValuesEqual } from "@visualbridge/module-sdk";
import {
  createEmptyTableCatalogRegistry,
  resolveTableColumn,
  resolveTableSheet,
  resolveTableType,
  type TableCatalogRegistry,
  type TableTypeDefinition,
} from "./tableCatalog";
import { applyTableOperations, type TableDocument } from "./tableDocument";
import { checkTableKeyRename } from "./tableKeyRename";
import { tableDocumentAdapter } from "./tableDocumentAdapter";
import { createTableRowReferenceProvider, TABLE_ROW_REFERENCE_KIND, type TableReferenceDocument } from "./tableReferences";
import { tableSourcesStorage } from "./tableSession";

type TableTarget = Exclude<import("@visualbridge/module-sdk").DocumentLifecycleDeleteTarget, { readonly kind: "document" }>;

export const tableDocumentFacet: DocumentFacet<TableDocument, TableCatalogRegistry> = {
  editor: tableDocumentAdapter.editor,
  storage: "sources",
  references: [{
    kind: TABLE_ROW_REFERENCE_KIND,
    createProvider: (loadReferenceData) => createTableRowReferenceProvider(
      // facet 边界：引用数据由本模块写入，这里收窄回 TableReferenceDocument。
      async () => await loadReferenceData() as readonly TableReferenceDocument[],
    ),
  }],

  planSources(active, candidatePaths, context) {
    return tableSourcesStorage.planSources(active, candidatePaths, sourcesContext(context));
  },

  async parseSources(files, context) {
    const parsed = await tableSourcesStorage.parse(files, sourcesContext(context));
    if (!parsed.success) return { success: false, diagnostics: parsed.diagnostics };
    const document = parsed.document as unknown as TableDocument;
    const tableType = resolveType(context);
    if (tableType === undefined) return { success: true, document, diagnostics: parsed.diagnostics };
    return {
      success: true,
      document,
      diagnostics: parsed.diagnostics,
      referenceData: referenceData(context, document, tableType, parsed.sheetsBySource),
      ...(parsed.sheetsBySource === undefined ? {} : { sheetsBySource: parsed.sheetsBySource }),
    };
  },

  async renderSources(document, sources, context) {
    return tableSourcesStorage.render(document as unknown as JsonValue, sources, sourcesContext(context));
  },

  describe(document, context) {
    const tableType = resolveType(context);
    return { title: tableType?.title ?? baseName(context.path) };
  },

  validate(document, context) {
    const tableType = resolveType(context);
    return tableType === undefined ? [] : tableDocumentAdapter.validate(document, { tableType });
  },

  collectReferences(document, context) {
    const tableType = resolveType(context);
    return tableType === undefined ? [] : tableDocumentAdapter.collectReferences(document, { tableType });
  },

  applyOperations(document, operations, context) {
    const tableType = resolveType(context);
    if (tableType === undefined) return missingTableType();
    return applyTableOperations(document, operations, tableType);
  },

  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    const tableType = resolveType(context);
    if (tableType === undefined) return missingTableType();
    return tableDocumentAdapter.replaceReferenceValues(document, { tableType }, occurrencePaths, replacement);
  },

  renameTarget(document, target, previous, replacement, context) {
    if (target.kind !== "table.row") return targetKindFailure(target.kind);
    const tableType = resolveType(context);
    if (tableType === undefined) return missingTableType();
    const sheetId = requiredString(target.sheetId, "target.sheetId");
    const rowId = requiredString(target.rowId, "target.rowId");
    const sheet = document.sheets.find((candidate) => candidate.id === sheetId);
    const row = sheet?.rows.find((candidate) => candidate.id === rowId);
    const definition = sheet === undefined ? undefined : resolveTableSheet(tableType, sheet.definitionId);
    const keyColumnId = definition?.keyColumnId;
    if (sheet === undefined || row === undefined || keyColumnId === undefined) {
      return failure("table.keyUnavailable", "target", "The target Table row or key column no longer exists.");
    }
    const duplicate = document.sheets.some((candidateSheet) => (
      candidateSheet.definitionId === sheet.definitionId
      && candidateSheet.rows.some((candidateRow) => (
        (candidateSheet.id !== sheet.id || candidateRow.id !== row.id)
        && (typeof candidateRow.cells[keyColumnId] === "string" || typeof candidateRow.cells[keyColumnId] === "number")
        && referenceValuesEqual(candidateRow.cells[keyColumnId] as string | number, replacement)
      ))
    ));
    const check = checkTableKeyRename({
      keyColumnId,
      currentValue: row.cells[keyColumnId],
      oldValue: previous,
      newValue: replacement,
      duplicateExists: duplicate,
    });
    if (!check.ok) return failure(check.code, "target", check.message);
    return applyTableOperations(document, [{
      type: "table.setCell",
      sheetId: sheet.id,
      rowId: row.id,
      columnId: keyColumnId,
      value: replacement,
    }], tableType);
  },

  guardOperations(document, operations, context) {
    const tableType = context.registry === undefined
      ? undefined
      : resolveTableType(context.registry, context.documentTypeId);
    if (tableType === undefined || !Array.isArray(operations)) return [];
    return operations.flatMap((raw, index): readonly DocumentDiagnostic[] => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
      const operation = raw as Readonly<Record<string, unknown>>;
      // 行删除不受守卫（单文件 Operation，悬空引用由持有方校验兜底）；
      // 仅键列修改仍必须走 Reference Refactor。
      if (operation.type !== "table.setCell"
        || typeof operation.sheetId !== "string"
        || typeof operation.columnId !== "string") return [];
      const sheet = document.sheets.find((candidate) => candidate.id === operation.sheetId);
      const definition = sheet === undefined ? undefined : resolveTableSheet(tableType, sheet.definitionId);
      const column = definition === undefined ? undefined : resolveTableColumn(definition, operation.columnId);
      const keyColumn = definition?.keyColumnId === undefined
        ? undefined
        : resolveTableColumn(definition, definition.keyColumnId);
      if (column === undefined || keyColumn === undefined || column.id !== keyColumn.id) return [];
      return [{
        severity: "error",
        code: "lifecycle.required",
        path: `operations[${index}].type`,
        message: "Changing a Table row key requires visualbridge_refactor_reference so every exact semantic reference is updated atomically.",
      }];
    });
  },

  collectOwnedIdentities(document, context) {
    const tableType = resolveType(context);
    if (tableType === undefined) throw new Error("Table Catalog Registry is unavailable.");
    return tableDocumentAdapter.lifecycle!.collectOwnedIdentities(document, context.documentTypeId, { tableType });
  },

  collectAddressableIdentityKeys(document, context) {
    const tableType = resolveType(context);
    if (tableType === undefined) return new Set<string>();
    return tableDocumentAdapter.lifecycle!.collectAddressableIdentityKeys!(document, context.documentTypeId, { tableType });
  },

  remapOwnedIdentities(document, context, remap) {
    const tableType = resolveType(context);
    if (tableType === undefined) return missingTableType();
    return tableDocumentAdapter.lifecycle!.remapOwnedIdentities(document, context.documentTypeId, remap, { tableType });
  },

  deleteOwnedTarget(document, target: TableTarget, context) {
    const tableType = resolveType(context);
    if (tableType === undefined) return missingTableType();
    return tableDocumentAdapter.lifecycle!.deleteOwnedTarget(document, target, { tableType });
  },
};

function sourcesContext(context: DocumentFacetContext<TableCatalogRegistry>) {
  return {
    projectId: context.projectId,
    documentTypeId: context.documentTypeId,
    options: recordOrUndefined(context.moduleOptions),
    catalog: {
      ready: context.registry !== undefined,
      registry: context.registry ?? createEmptyTableCatalogRegistry(),
      diagnostics: [] as readonly DocumentDiagnostic[],
    },
  };
}

function resolveType(context: DocumentFacetContext<TableCatalogRegistry>): TableTypeDefinition | undefined {
  return resolveTableType(context.registry ?? createEmptyTableCatalogRegistry(), context.documentTypeId);
}

function referenceData(
  context: DocumentFacetContext<TableCatalogRegistry>,
  document: TableDocument,
  tableType: TableTypeDefinition,
  sheetsBySource: Readonly<Record<string, readonly string[]>> | undefined,
): TableReferenceDocument {
  const sheetPaths: Record<string, string> = {};
  for (const [sourcePath, sheetIds] of Object.entries(sheetsBySource ?? {})) {
    for (const sheetId of sheetIds) sheetPaths[sheetId] = sourcePath;
  }
  return createTableReferenceData({
    projectId: context.projectId,
    documentTypeId: context.documentTypeId,
    path: context.path,
    document,
    tableType,
    sheetPaths,
  });
}

/** 构造 `table.row` 引用的候选数据；宿主与解析路径共用，避免两处拼同一形状。 */
export function createTableReferenceData(input: {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly path: string;
  readonly document: TableDocument;
  readonly tableType: TableTypeDefinition;
  readonly sheetPaths: Readonly<Record<string, string>>;
}): TableReferenceDocument {
  return {
    projectId: input.projectId,
    documentTypeId: input.documentTypeId,
    path: input.path,
    document: input.document,
    tableType: input.tableType,
    sheetPaths: input.sheetPaths,
  };
}

function recordOrUndefined(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
}

function baseName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(separator + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string.`);
  return value;
}

function targetKindFailure(kind: string): DocumentOperationResult<never> {
  return failure("table.targetKind", "target.kind", `Table cannot rename '${kind}' targets.`);
}

function missingTableType(): DocumentOperationResult<never> {
  return failure("table.typeMissing", "tableType", "Table Catalog does not declare this Document Type.");
}

function failure(code: string, path: string, message: string): DocumentOperationResult<never> {
  const diagnostic: DocumentDiagnostic = { severity: "error", code, path, message };
  return { success: false, diagnostics: [diagnostic] };
}
