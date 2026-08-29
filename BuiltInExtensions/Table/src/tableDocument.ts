import {
  replaceFieldReferenceValues,
  type DocumentDiagnostic,
  type JsonValue,
} from "@visualbridge/core";
import { cloneJsonValue, createDefaultProperties, validateFieldValue } from "@visualbridge/core";
import type { TableSheetDefinition, TableTypeDefinition } from "./tableCatalog";
import { resolveTableColumn, resolveTableSheet } from "./tableCatalog";

export type TableDocumentFormat = "csv" | "xlsx";

export interface TableRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, JsonValue>>;
  readonly sourceRowNumber?: number;
  readonly rawCells: readonly string[];
  readonly changedColumnIds: readonly string[];
}

export interface TableSheet {
  readonly id: string;
  readonly definitionId: string;
  readonly title: string;
  readonly name: string;
  readonly headerRows: readonly (readonly string[])[];
  readonly columnIndexes: Readonly<Record<string, number>>;
  readonly rows: readonly TableRow[];
}

export interface TableDocument {
  readonly format: TableDocumentFormat;
  readonly sheets: readonly TableSheet[];
}

export interface EffectiveTableRow {
  readonly sheetId: string;
  readonly sheetName: string;
  readonly row: TableRow;
}

export interface EffectiveTableRowsResult {
  readonly rows: readonly EffectiveTableRow[];
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export type TableOperation =
  | {
      readonly type: "table.setCell";
      readonly sheetId: string;
      readonly rowId: string;
      readonly columnId: string;
      readonly value: JsonValue;
    }
  | {
      readonly type: "table.insertRow";
      readonly sheetId: string;
      readonly rowId: string;
      readonly index?: number;
      readonly cells?: Readonly<Record<string, JsonValue>>;
    }
  | { readonly type: "table.removeRow"; readonly sheetId: string; readonly rowId: string }
  | { readonly type: "table.moveRow"; readonly sheetId: string; readonly rowId: string; readonly index: number }
  | {
      readonly type: "table.duplicateRow";
      readonly sheetId: string;
      readonly rowId: string;
      readonly newRowId: string;
      readonly index?: number;
    };

export type TableOperationResult =
  | { readonly success: true; readonly document: TableDocument; readonly diagnostics: readonly DocumentDiagnostic[] }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] };

export function validateTableDocument(
  document: TableDocument,
  tableType: TableTypeDefinition,
): readonly DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = [];
  const partitionKeys = new Map<string, Map<string, { readonly rowId: string; readonly sheetName: string }>>();
  for (const sheet of document.sheets) {
    const definition = resolveTableSheet(tableType, sheet.definitionId);
    if (definition === undefined) {
      diagnostics.push(warning("table.unknownSheet", `sheets.${sheet.id}`, `Unknown sheet '${sheet.id}' is preserved.`));
      continue;
    }
    for (const column of definition.columns) {
      if (sheet.columnIndexes[column.id] === undefined) {
        diagnostics.push(error(
          "table.missingColumn",
          `sheets.${sheet.id}.columns.${column.id}`,
          `The name-key row does not contain '${column.nameKey}' or an exported alias.`,
        ));
      }
    }
    const rowIds = new Set<string>();
    const keyValues = new Map<string, string>();
    sheet.rows.forEach((row, rowIndex) => {
      if (rowIds.has(row.id)) {
        diagnostics.push(error("table.duplicateRowId", `sheets.${sheet.id}.rows[${rowIndex}]`, `Duplicate row ID '${row.id}'.`));
      }
      rowIds.add(row.id);
      definition.columns.forEach((column) => {
        const value = row.cells[column.id];
        if (value === undefined) {
          diagnostics.push(error(
            "table.missingCell",
            `sheets.${sheet.id}.rows[${rowIndex}].${column.id}`,
            `Missing value for column '${column.id}'.`,
          ));
          return;
        }
        validateFieldValue(value, column, `sheets.${sheet.id}.rows[${rowIndex}].${column.id}`, diagnostics);
      });
      if (definition.keyColumnId !== undefined) {
        const keyColumn = resolveTableColumn(definition, definition.keyColumnId);
        const keyValue = keyColumn === undefined ? undefined : row.cells[keyColumn.id];
        const identity = keyValue === undefined ? "" : stableValueKey(keyValue);
        if (identity.length === 0) {
          diagnostics.push(error(
            "table.emptyKey",
            `sheets.${sheet.id}.rows[${rowIndex}].${definition.keyColumnId}`,
            "Key column cannot be empty.",
          ));
        } else {
          const existing = keyValues.get(identity);
          if (existing !== undefined) {
            diagnostics.push(error(
              "table.duplicateKey",
              `sheets.${sheet.id}.rows[${rowIndex}].${definition.keyColumnId}`,
              `Duplicate key '${displayValue(keyValue!)}' is already used by row '${existing}'.`,
            ));
          } else {
            keyValues.set(identity, row.id);
          }
        }
      }
      if (definition.partition !== undefined) {
        const deduplicateColumn = resolveTableColumn(definition, definition.partition.deduplicateByColumnId);
        const deduplicateValue = deduplicateColumn === undefined ? undefined : row.cells[deduplicateColumn.id];
        if (deduplicateValue !== undefined) {
          const identity = stableValueKey(deduplicateValue);
          let values = partitionKeys.get(definition.id);
          if (values === undefined) {
            values = new Map();
            partitionKeys.set(definition.id, values);
          }
          const existing = values.get(identity);
          if (existing !== undefined) {
            const message = `Duplicate partition key '${displayValue(deduplicateValue)}' also appears in '${existing.sheetName}'.`;
            diagnostics.push(definition.partition.duplicatePolicy === "error"
              ? error(
                  "table.duplicatePartitionKey",
                  `sheets.${sheet.id}.rows[${rowIndex}].${deduplicateColumn?.id}`,
                  message,
                )
              : warning(
                  "table.partitionDuplicateResolved",
                  `sheets.${sheet.id}.rows[${rowIndex}].${deduplicateColumn?.id}`,
                  `${message} Policy '${definition.partition.duplicatePolicy}' determines the effective row.`,
                ));
          } else {
            values.set(identity, { rowId: row.id, sheetName: sheet.name });
          }
        }
      }
    });
  }
  return diagnostics;
}

/**
 * Resolves the logical row stream represented by one Sheet definition. Physical
 * partition order is the stable document/sheet order established by the codec.
 * Sources remain lossless; keepFirst/keepLast only affect the logical view.
 */
export function resolveEffectiveTableRows(
  document: TableDocument,
  tableType: TableTypeDefinition,
  sheetDefinitionId: string,
): EffectiveTableRowsResult {
  const definition = resolveTableSheet(tableType, sheetDefinitionId);
  if (definition === undefined) {
    return {
      rows: [],
      diagnostics: [error("table.unknownSheet", `sheets.${sheetDefinitionId}`, `Unknown sheet '${sheetDefinitionId}'.`)],
    };
  }
  const physicalRows = document.sheets
    .filter((sheet) => sheet.definitionId === definition.id)
    .flatMap((sheet) => sheet.rows.map((row) => ({ sheetId: sheet.id, sheetName: sheet.name, row })));
  if (definition.partition === undefined) {
    return { rows: physicalRows, diagnostics: [] };
  }
  const column = resolveTableColumn(definition, definition.partition.deduplicateByColumnId);
  if (column === undefined) {
    return {
      rows: physicalRows,
      diagnostics: [error(
        "table.unknownDeduplicateColumn",
        `sheets.${definition.id}.partition.deduplicateByColumnId`,
        `Unknown de-duplicate column '${definition.partition.deduplicateByColumnId}'.`,
      )],
    };
  }
  const result: EffectiveTableRow[] = [];
  const indexes = new Map<string, number>();
  const diagnostics: DocumentDiagnostic[] = [];
  for (const entry of physicalRows) {
    const value = entry.row.cells[column.id];
    if (value === undefined) {
      continue;
    }
    const identity = stableValueKey(value);
    const existingIndex = indexes.get(identity);
    if (existingIndex === undefined) {
      indexes.set(identity, result.length);
      result.push(entry);
      continue;
    }
    if (definition.partition.duplicatePolicy === "error") {
      diagnostics.push(error(
        "table.duplicatePartitionKey",
        `sheets.${entry.sheetId}.rows.${entry.row.id}.${column.id}`,
        `Duplicate partition key '${displayValue(value)}' also appears in '${result[existingIndex]?.sheetName}'.`,
      ));
      result.push(entry);
    } else if (definition.partition.duplicatePolicy === "keepLast") {
      result.splice(existingIndex, 1);
      for (const [key, index] of indexes) {
        if (index > existingIndex) {
          indexes.set(key, index - 1);
        }
      }
      indexes.set(identity, result.length);
      result.push(entry);
    }
  }
  return { rows: result, diagnostics };
}

export function applyTableOperations(
  document: TableDocument,
  operations: unknown,
  tableType: TableTypeDefinition,
): TableOperationResult {
  if (!Array.isArray(operations)) {
    return { success: false, diagnostics: [operationError("operations", "Expected an operation array.")] };
  }
  const baselineErrors = new Set(validateTableDocument(document, tableType)
    .filter((diagnostic) => diagnostic.severity === "error")
    .map(diagnosticKey));
  const working = cloneTableDocument(document);
  const diagnostics: DocumentDiagnostic[] = [];
  operations.forEach((operation, index) => applyOperation(working, operation, `operations[${index}]`, tableType, diagnostics));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, diagnostics };
  }
  const validation = validateTableDocument(working, tableType);
  const newErrors = validation.filter(
    (diagnostic) => diagnostic.severity === "error" && !baselineErrors.has(diagnosticKey(diagnostic)),
  );
  if (newErrors.length > 0) {
    return { success: false, diagnostics: newErrors };
  }
  return { success: true, document: working, diagnostics: validation };
}

export function replaceTableReferenceValues(
  document: TableDocument,
  tableType: TableTypeDefinition,
  occurrencePaths: ReadonlySet<string>,
  replacement: string | number,
): TableOperationResult {
  const operations: TableOperation[] = [];
  for (const sheet of document.sheets) {
    const definition = resolveTableSheet(tableType, sheet.definitionId);
    if (definition === undefined) {
      continue;
    }
    for (const row of sheet.rows) {
      const basePath = `sheets.${sheet.id}.rows.${row.id}.cells`;
      const cells = replaceFieldReferenceValues(
        row.cells,
        definition.columns,
        basePath,
        (occurrence) => occurrencePaths.has(occurrence.path),
        replacement,
      );
      for (const column of definition.columns) {
        if (cells.changedPaths.some((path) => path === `${basePath}.${column.id}` || path.startsWith(`${basePath}.${column.id}.`) || path.startsWith(`${basePath}.${column.id}[`))) {
          operations.push({
            type: "table.setCell",
            sheetId: sheet.id,
            rowId: row.id,
            columnId: column.id,
            value: cells.properties[column.id]!,
          });
        }
      }
    }
  }
  return applyTableOperations(document, operations, tableType);
}

function applyOperation(
  document: MutableTableDocument,
  value: unknown,
  path: string,
  tableType: TableTypeDefinition,
  diagnostics: DocumentDiagnostic[],
): void {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.sheetId !== "string") {
    diagnostics.push(operationError(path, "Expected an operation with type and sheetId."));
    return;
  }
  const sheet = document.sheets.find((candidate) => candidate.id === value.sheetId);
  const sheetDefinition = sheet === undefined ? undefined : resolveTableSheet(tableType, sheet.definitionId);
  if (sheet === undefined || sheetDefinition === undefined) {
    diagnostics.push(operationError(`${path}.sheetId`, `Unknown sheet '${value.sheetId}'.`));
    return;
  }
  if (value.type === "table.setCell") {
    const row = readRow(sheet, value.rowId, `${path}.rowId`, diagnostics);
    const column = typeof value.columnId === "string" ? resolveTableColumn(sheetDefinition, value.columnId) : undefined;
    if (column === undefined) {
      diagnostics.push(operationError(`${path}.columnId`, "Unknown column."));
      return;
    }
    if (row === undefined || !isJsonValue(value.value)) {
      if (!isJsonValue(value.value)) {
        diagnostics.push(operationError(`${path}.value`, "Expected a finite JSON value."));
      }
      return;
    }
    const fieldDiagnostics = validateFieldValue(value.value, column, `${path}.value`);
    if (fieldDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      diagnostics.push(...fieldDiagnostics);
      return;
    }
    row.cells[column.id] = cloneJsonValue(value.value);
    if (!row.changedColumnIds.includes(column.id)) {
      row.changedColumnIds.push(column.id);
    }
    return;
  }
  if (value.type === "table.insertRow") {
    if (typeof value.rowId !== "string" || value.rowId.length === 0 || sheet.rows.some((row) => row.id === value.rowId)) {
      diagnostics.push(operationError(`${path}.rowId`, "Expected a unique non-empty row ID."));
      return;
    }
    const cells = createDefaultProperties(sheetDefinition.columns);
    if (value.cells !== undefined) {
      if (!isRecord(value.cells) || !Object.values(value.cells).every(isJsonValue)) {
        diagnostics.push(operationError(`${path}.cells`, "Expected a JSON object."));
        return;
      }
      Object.entries(value.cells).forEach(([columnId, cellValue]) => {
        const column = resolveTableColumn(sheetDefinition, columnId);
        if (column === undefined) {
          diagnostics.push(operationError(`${path}.cells.${columnId}`, "Unknown column."));
        } else {
          cells[column.id] = cloneJsonValue(cellValue as JsonValue);
        }
      });
    }
    const index = readInsertIndex(value.index, sheet.rows.length, `${path}.index`, diagnostics);
    if (index === undefined) {
      return;
    }
    sheet.rows.splice(index, 0, {
      id: value.rowId,
      cells,
      rawCells: [],
      changedColumnIds: sheetDefinition.columns.map((column) => column.id),
    });
    return;
  }
  if (value.type === "table.removeRow") {
    const index = sheet.rows.findIndex((row) => row.id === value.rowId);
    if (index < 0) {
      diagnostics.push(operationError(`${path}.rowId`, "Unknown row."));
      return;
    }
    sheet.rows.splice(index, 1);
    return;
  }
  if (value.type === "table.moveRow") {
    const index = sheet.rows.findIndex((row) => row.id === value.rowId);
    if (index < 0) {
      diagnostics.push(operationError(`${path}.rowId`, "Unknown row."));
      return;
    }
    if (typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0 || value.index >= sheet.rows.length) {
      diagnostics.push(operationError(`${path}.index`, "Expected an in-range row index."));
      return;
    }
    const [row] = sheet.rows.splice(index, 1);
    if (row !== undefined) {
      sheet.rows.splice(value.index, 0, row);
    }
    return;
  }
  if (value.type === "table.duplicateRow") {
    const row = readRow(sheet, value.rowId, `${path}.rowId`, diagnostics);
    if (row === undefined) {
      return;
    }
    if (typeof value.newRowId !== "string" || value.newRowId.length === 0 || sheet.rows.some((entry) => entry.id === value.newRowId)) {
      diagnostics.push(operationError(`${path}.newRowId`, "Expected a unique non-empty row ID."));
      return;
    }
    const sourceIndex = sheet.rows.indexOf(row);
    const index = readInsertIndex(value.index ?? sourceIndex + 1, sheet.rows.length, `${path}.index`, diagnostics);
    if (index === undefined) {
      return;
    }
    sheet.rows.splice(index, 0, {
      id: value.newRowId,
      cells: cloneCells(row.cells),
      ...(row.sourceRowNumber === undefined ? {} : { sourceRowNumber: row.sourceRowNumber }),
      rawCells: [...row.rawCells],
      changedColumnIds: sheetDefinition.columns.map((column) => column.id),
    });
    return;
  }
  diagnostics.push(operationError(`${path}.type`, `Unknown Table operation '${value.type}'.`));
}

function readRow(
  sheet: MutableTableSheet,
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): MutableTableRow | undefined {
  if (typeof value !== "string") {
    diagnostics.push(operationError(path, "Expected a row ID."));
    return undefined;
  }
  const row = sheet.rows.find((candidate) => candidate.id === value);
  if (row === undefined) {
    diagnostics.push(operationError(path, `Unknown row '${value}'.`));
  }
  return row;
}

function readInsertIndex(
  value: unknown,
  length: number,
  path: string,
  diagnostics: DocumentDiagnostic[],
): number | undefined {
  if (value === undefined) {
    return length;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > length) {
    diagnostics.push(operationError(path, "Expected an insert index between zero and the row count."));
    return undefined;
  }
  return value;
}

export function createRowId(
  sheet: TableSheetDefinition,
  cells: Readonly<Record<string, JsonValue>>,
  sourceRowNumber: number,
  usedIds: Set<string>,
  physicalSheetId = sheet.id,
): string {
  let base = `${physicalSheetId}:row-${sourceRowNumber}`;
  if (sheet.keyColumnId !== undefined) {
    const keyColumn = resolveTableColumn(sheet, sheet.keyColumnId);
    const keyValue = keyColumn === undefined ? undefined : cells[keyColumn.id];
    if (keyValue !== undefined) {
      base = `${physicalSheetId}:key-${stableValueKey(keyValue)}`;
    }
  }
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}#${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function cloneTableDocument(document: TableDocument): MutableTableDocument {
  return {
    format: document.format,
    sheets: document.sheets.map((sheet) => ({
      id: sheet.id,
      definitionId: sheet.definitionId,
      title: sheet.title,
      name: sheet.name,
      headerRows: sheet.headerRows.map((row) => [...row]),
      columnIndexes: { ...sheet.columnIndexes },
      rows: sheet.rows.map((row) => ({
        id: row.id,
        cells: cloneCells(row.cells),
        ...(row.sourceRowNumber === undefined ? {} : { sourceRowNumber: row.sourceRowNumber }),
        rawCells: [...row.rawCells],
        changedColumnIds: [...row.changedColumnIds],
      })),
    })),
  };
}

function cloneCells(cells: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(cells).map(([key, value]) => [key, cloneJsonValue(value)]));
}

function stableValueKey(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function displayValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationError(path: string, message: string): DocumentDiagnostic {
  return error("table.operationRejected", path, message);
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function warning(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "warning", code, path, message };
}

interface MutableTableRow {
  id: string;
  cells: Record<string, JsonValue>;
  sourceRowNumber?: number;
  rawCells: string[];
  changedColumnIds: string[];
}

interface MutableTableSheet {
  id: string;
  definitionId: string;
  title: string;
  name: string;
  headerRows: string[][];
  columnIndexes: Record<string, number>;
  rows: MutableTableRow[];
}

interface MutableTableDocument {
  format: TableDocumentFormat;
  sheets: MutableTableSheet[];
}
