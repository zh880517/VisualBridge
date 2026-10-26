/**
 * Table 会话控制器与 `storage: "sources"` facet（B2）。
 *
 * 多源会话的领域逻辑：源文件规划、解析、渲染、Operation 应用、引用校验、Provider Validator、
 * 状态消息与"已有稳定行键改名"的分类。**不得 import `vscode`**：文件读取、事务写回、
 * 冲突检测与 Reference Refactor 调用都在宿主。
 */
import {
  compareUtf16CodeUnits,
  referenceValuesEqual,
  type DocumentDiagnostic,
  type JsonValue,
  type ReferenceDefinition,
  type ReferenceLocation,
} from "@visualbridge/core";
import { parseCsvTable, serializeCsvTable } from "./csvCodec";
import { resolveTableLayoutFromOptions, TABLE_LAYOUT_OPTION, type TableLayoutDefinition } from "./projectTableLayout";
import {
  matchTableSheetDefinitions,
  resolveTableColumn,
  resolveTableSheet,
  resolveTableType,
  type TableCatalogRegistry,
  type TableTypeDefinition,
} from "./tableCatalog";
import {
  applyTableOperations,
  validateTableDocument,
  type TableDocument,
  type TableSheet,
} from "./tableDocument";
import { collectTableReferences } from "./tableReferences";
import { parseXlsxTable, serializeXlsxTable } from "./xlsxCodec";
import type {
  ModuleSessionCatalog,
  ModuleSessionController,
  ModuleSessionDocument,
  ModuleSessionEffect,
  ModuleSessionHost,
  ModuleSessionMessage,
  ModuleSessionSource,
  ModuleSourcesContext,
  ModuleSourcesKeyRenamePlan,
  ModuleSourcesParseResult,
  ModuleSourcesSessionController,
  ModuleSourceFile,
  ModuleSourcesStorage,
} from "./moduleSessionContract";

const OPERATION_FAILED_MESSAGE = "Table document is invalid.";

/** `storage: "sources"` facet：Table 的源规划、解析与渲染。 */
export const tableSourcesStorage: ModuleSourcesStorage = {
  kind: "sources",
  planSources(active, candidates, context) {
    // 单文件 XLSX 不参与 CSV 分表家族枚举（旧实现用魔数判断，这里保持一致）。
    if (isXlsx(active.bytes)) {
      return [active.path];
    }
    const registry = context.catalog.registry as TableCatalogRegistry;
    const tableType = resolveTableType(registry, context.documentTypeId);
    if (tableType === undefined) {
      return [active.path];
    }
    const planned = candidates.filter((candidate) => {
      const physicalName = basenameWithoutExtension(candidate);
      return matchTableSheetDefinitions(tableType, physicalName)
        .some((sheet) => sheet.partition !== undefined);
    });
    if (!planned.includes(active.path)) {
      planned.push(active.path);
    }
    return planned.sort((left, right) => compareUtf16CodeUnits(left, right));
  },

  async parse(files, context) {
    const registry = context.catalog.registry as TableCatalogRegistry;
    const tableType = resolveTableType(registry, context.documentTypeId);
    if (tableType === undefined) {
      return failure({
        severity: "error",
        code: "table.typeMissing",
        path: "tableType",
        message: `Table Catalog does not declare '${context.documentTypeId}' or an alias.`,
      });
    }
    const layout = resolveTableLayoutFromOptions(context.options);
    if (layout === undefined) {
      return failure({
        severity: "error",
        code: "table.layoutNotConfigured",
        path: TABLE_LAYOUT_OPTION,
        message: "VisualBridge Project must configure tableLayout.nameKeyRow and tableLayout.dataStartRow.",
      });
    }
    const active = files[0];
    if (active === undefined) {
      return failure({
        severity: "error",
        code: "table.sourceMissing",
        path: "$",
        message: "Table document has no source file.",
      });
    }
    if (isXlsx(active.bytes)) {
      const parsed = await parseXlsxTable(active.bytes, tableType, layout);
      return parsed.success
        ? {
            success: true,
            document: parsed.document as unknown as JsonValue,
            diagnostics: [...parsed.diagnostics, ...validateTableDocument(parsed.document, tableType)],
            sheetsBySource: {
              [active.path]: parsed.document.sheets.map((sheet) => sheet.id),
            },
          }
        : { success: false, diagnostics: parsed.diagnostics };
    }

    const sheets: TableSheet[] = [];
    const diagnostics: DocumentDiagnostic[] = [];
    const sheetsBySource: Record<string, readonly string[]> = {};
    for (const file of files) {
      const physicalName = basenameWithoutExtension(file.path);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch (errorValue) {
        return failure({
          severity: "error",
          code: "table.invalidEncoding",
          path: file.path,
          message: `Unable to decode '${physicalName}' as UTF-8: ${formatError(errorValue)}`,
        });
      }
      const parsed = parseCsvTable(text, tableType, layout, physicalName);
      if (!parsed.success) {
        return {
          success: false,
          diagnostics: parsed.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            path: `${physicalName}.${diagnostic.path}`,
          })),
        };
      }
      sheets.push(...parsed.document.sheets);
      sheetsBySource[file.path] = parsed.document.sheets.map((sheet) => sheet.id);
      diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `${physicalName}.${diagnostic.path}`,
      })));
    }
    const document: TableDocument = { format: "csv", sheets };
    return {
      success: true,
      document: document as unknown as JsonValue,
      diagnostics: [...diagnostics, ...validateTableDocument(document, tableType)],
      sheetsBySource,
    };
  },

  async render(document, previous, context) {
    const registry = context.catalog.registry as TableCatalogRegistry;
    const tableType = resolveTableType(registry, context.documentTypeId);
    const layout = resolveTableLayoutFromOptions(context.options);
    if (tableType === undefined || layout === undefined) {
      throw new Error("Table Catalog or layout is unavailable; cannot render Table sources.");
    }
    const parsed = document as unknown as TableDocument;
    const marked = markAllCellsChanged(parsed, tableType);
    if (parsed.format === "xlsx") {
      const active = previous[0];
      if (active === undefined) {
        throw new Error("Table document has no source file.");
      }
      return [{
        path: active.path,
        bytes: await serializeXlsxTable(active.bytes, marked, tableType, layout),
      }];
    }
    const rendered: ModuleSourceFile[] = [];
    for (const file of previous) {
      const physicalName = basenameWithoutExtension(file.path);
      const sourceSheets = marked.sheets.filter((sheet) => sheet.name === physicalName);
      const originalText = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      rendered.push({
        path: file.path,
        bytes: new TextEncoder().encode(
          serializeCsvTable({ format: "csv", sheets: sourceSheets }, tableType, originalText),
        ),
      });
    }
    return rendered;
  },
};

/** 多源会话控制器（Table）。 */
export function createTableSessionController(): ModuleSourcesSessionController {
  return {
    state(document, host) {
      return buildState(document, host);
    },

    async handle(message, document, host) {
      if (message.type !== "applyOperations") {
        return [];
      }
      return applyOperations(message, document, host);
    },

    planKeyRename(document, operations) {
      return classifyExistingKeyRename(document, operations);
    },
  };
}

async function buildState(
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<JsonValue> {
  const tableDocument = snapshot.document as unknown as TableDocument | undefined;
  const tableType = tableTypeOf(snapshot);
  if (tableDocument === undefined || tableType === undefined || snapshot.catalog === undefined) {
    // 成功打开的文档不会走到这里：Catalog 与已解析文档在打开阶段就位。
    // 该消息类型只作为"状态无法构造"的宿主侧载体，Table Webview 不处理它。
    return {
      type: "tableInvalid",
      revision: snapshot.revision,
      isDirty: snapshot.isDirty,
      diagnostics: [{
        severity: "error",
        code: tableDocument === undefined ? "table.documentMissing" : "table.typeMissing",
        path: "tableType",
        message: "Table Catalog or document is unavailable.",
      }] as unknown as JsonValue,
    };
  }
  const diagnostics = [
    ...validateTableDocument(tableDocument, tableType),
    ...await host.validateReferences(collectTableReferences(tableDocument, tableType)),
    ...await host.validateProviderDocument({
      documentTypeId: snapshot.documentTypeId,
      path: snapshot.path,
      content: tableDocument as unknown as JsonValue,
      source: JSON.stringify(tableDocument),
    }),
  ];
  return {
    type: "tableState",
    revision: snapshot.revision,
    document: tableDocument as unknown as JsonValue,
    tableType: tableType as unknown as JsonValue,
    isDirty: snapshot.isDirty,
    diagnostics: diagnostics as unknown as JsonValue,
  };
}

async function applyOperations(
  message: ModuleSessionMessage,
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<readonly ModuleSessionEffect[]> {
  const tableDocument = snapshot.document as unknown as TableDocument | undefined;
  const tableType = tableTypeOf(snapshot);
  if (tableDocument === undefined || tableType === undefined) {
    return [{ kind: "post", message: rejected(OPERATION_FAILED_MESSAGE) }];
  }

  const applied = applyTableOperations(tableDocument, message.operations, tableType);
  if (!applied.success) {
    return [{
      kind: "post",
      message: rejected(formatDiagnostics(applied.diagnostics), applied.diagnostics),
    }];
  }

  const referenceResult = await host.validateReferenceChange(
    collectTableReferences(tableDocument, tableType),
    collectTableReferences(applied.document, tableType),
  );
  if (referenceResult.introducedErrors.length > 0) {
    return [{
      kind: "post",
      message: rejected(
        formatDiagnostics(referenceResult.introducedErrors),
        [...applied.diagnostics, ...referenceResult.diagnostics],
      ),
    }];
  }

  const providerDiagnostics = await host.validateProviderDocument({
    documentTypeId: snapshot.documentTypeId,
    path: snapshot.path,
    content: applied.document as unknown as JsonValue,
    source: JSON.stringify(applied.document),
  });
  const providerErrors = providerDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (providerErrors.length > 0) {
    return [{
      kind: "post",
      message: rejected(
        formatDiagnostics(providerErrors),
        [...applied.diagnostics, ...referenceResult.diagnostics, ...providerDiagnostics],
      ),
    }];
  }

  return [
    {
      kind: "apply",
      operations: { kind: "sources", document: applied.document as unknown as JsonValue },
      label: "Edit VisualBridge Table",
    },
    { kind: "post", message: { type: "operationCompleted", changed: true } },
  ];
}

/**
 * 已有稳定行键的改名必须走 Reference Refactor：宿主拿到 `rename` 计划后调用重构服务，
 * `blocked` 与 `none` 由宿主转成拒绝消息或继续普通 Operation 流程。
 */
function classifyExistingKeyRename(
  snapshot: ModuleSessionDocument,
  operations: unknown,
): ModuleSourcesKeyRenamePlan {
  const tableDocument = snapshot.document as unknown as TableDocument | undefined;
  const savedDocument = snapshot.savedDocument as unknown as TableDocument | undefined;
  const tableType = tableTypeOf(snapshot);
  if (tableDocument === undefined || savedDocument === undefined || tableType === undefined) {
    return { kind: "none" };
  }
  if (!Array.isArray(operations)) return { kind: "none" };

  const intents = operations.flatMap((operation): ModuleSourcesKeyRenamePlan[] => {
    if (!isRecord(operation)
      || operation.type !== "table.setCell"
      || typeof operation.sheetId !== "string"
      || typeof operation.rowId !== "string"
      || typeof operation.columnId !== "string"
      || (typeof operation.value !== "string" && typeof operation.value !== "number")) {
      return [];
    }
    const sheet = tableDocument.sheets.find((candidate) => candidate.id === operation.sheetId);
    const row = sheet?.rows.find((candidate) => candidate.id === operation.rowId);
    const savedSheet = savedDocument.sheets.find((candidate) => candidate.id === operation.sheetId);
    const savedRow = savedSheet?.rows.find((candidate) => candidate.id === operation.rowId);
    const sheetDefinition = sheet === undefined ? undefined : resolveTableSheet(tableType, sheet.definitionId);
    const keyColumn = sheetDefinition?.keyColumnId === undefined
      ? undefined
      : resolveTableColumn(sheetDefinition, sheetDefinition.keyColumnId);
    const editedColumn = sheetDefinition === undefined
      ? undefined
      : resolveTableColumn(sheetDefinition, operation.columnId);
    if (sheet === undefined
      || sheetDefinition === undefined
      || row === undefined
      || savedRow === undefined
      || keyColumn === undefined
      || editedColumn?.id !== keyColumn.id) {
      return [];
    }
    const oldValue = row.cells[keyColumn.id];
    if ((typeof oldValue !== "string" && typeof oldValue !== "number")
      || referenceValuesEqual(oldValue, operation.value)) {
      return [];
    }
    const source = sourceOfSheet(snapshot.sources, sheet);
    if (source === undefined) {
      return [{ kind: "blocked", message: "The physical source for this existing Table row is unavailable." }];
    }
    return [{
      kind: "rename",
      definition: {
        kind: "table.row",
        target: {
          tableTypeId: tableType.id,
          sheetId: sheetDefinition.id,
          documentTypeId: snapshot.documentTypeId,
        },
        allowMissing: false,
      } satisfies ReferenceDefinition,
      location: {
        projectId: snapshot.projectId,
        documentTypeId: snapshot.documentTypeId,
        path: source,
        sheetId: sheet.id,
        rowId: row.id,
      } satisfies ReferenceLocation,
      oldValue,
      newValue: operation.value,
    }];
  });
  if (intents.length === 0) return { kind: "none" };
  if (operations.length !== 1 || intents.length !== 1 || intents[0]?.kind !== "rename") {
    return {
      kind: "blocked",
      message: "An existing Table key rename must be the only operation in its batch.",
    };
  }
  return intents[0]!;
}

function tableTypeOf(snapshot: ModuleSessionDocument): TableTypeDefinition | undefined {
  if (snapshot.catalog === undefined) return undefined;
  return resolveTableType(snapshot.catalog.registry as TableCatalogRegistry, snapshot.documentTypeId);
}

function sourceOfSheet(
  sources: readonly ModuleSessionSource[] | undefined,
  sheet: TableSheet,
): string | undefined {
  return sources?.find((source) => source.sheetIds?.includes(sheet.id))?.path;
}

function rejected(
  message: string,
  diagnostics?: readonly DocumentDiagnostic[],
): ModuleSessionMessage {
  return {
    type: "operationRejected",
    message,
    ...(diagnostics === undefined ? {} : { diagnostics: diagnostics as unknown as JsonValue }),
  };
}

function markAllCellsChanged(document: TableDocument, tableType: TableTypeDefinition): TableDocument {
  return {
    format: document.format,
    sheets: document.sheets.map((sheet) => {
      const definition = resolveTableSheet(tableType, sheet.definitionId);
      const columnIds = definition?.columns.map((column) => column.id) ?? [];
      return {
        ...sheet,
        rows: sheet.rows.map((row) => ({ ...row, changedColumnIds: columnIds })),
      };
    }),
  };
}

function failure(diagnostic: DocumentDiagnostic): ModuleSourcesParseResult {
  return { success: false, diagnostics: [diagnostic] };
}

function basenameWithoutExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatDiagnostics(diagnostics: readonly DocumentDiagnostic[]): string {
  const first = diagnostics[0];
  return first === undefined ? OPERATION_FAILED_MESSAGE : `${first.path}: ${first.message}`;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
