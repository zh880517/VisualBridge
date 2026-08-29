import type { DocumentDiagnostic, DocumentParseResult, JsonValue, TableLayoutDefinition } from "@visualbridge/core";
import { cloneJsonValue } from "@visualbridge/core";
import type ExcelJS = require("exceljs");
import { decodeTableCell, encodeTableCell } from "./cellCodec";
import type { TableColumnDefinition, TableSheetDefinition, TableTypeDefinition } from "./tableCatalog";
import { matchTableSheetDefinitions } from "./tableCatalog";
import { createRowId, type TableDocument, type TableRow, type TableSheet } from "./tableDocument";

export async function parseXlsxTable(
  bytes: Uint8Array,
  tableType: TableTypeDefinition,
  layout: TableLayoutDefinition,
): Promise<DocumentParseResult<TableDocument>> {
  const ExcelJS = loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(toArrayBuffer(bytes));
  } catch (errorValue) {
    return failure("table.invalidXlsx", "$", formatError(errorValue));
  }
  const diagnostics: DocumentDiagnostic[] = [];
  const sheets: TableSheet[] = [];
  const matchedDefinitionIds = new Set<string>();
  workbook.eachSheet((worksheet) => {
    const matches = matchTableSheetDefinitions(tableType, worksheet.name);
    if (matches.length === 0) {
      return;
    }
    if (matches.length > 1) {
      diagnostics.push(error(
        "table.ambiguousSheet",
        `sheets.${worksheet.name}`,
        `Worksheet '${worksheet.name}' matches multiple Table Sheet definitions.`,
      ));
      return;
    }
    const definition = matches[0]!;
    matchedDefinitionIds.add(definition.id);
    const parsed = parseWorksheet(worksheet, definition, layout, diagnostics);
    if (parsed !== undefined) {
      sheets.push(parsed);
    }
  });
  tableType.sheets.forEach((definition) => {
    if (!matchedDefinitionIds.has(definition.id)) {
      diagnostics.push(error(
        "table.missingSheet",
        `sheets.${definition.id}`,
        definition.partition === undefined
          ? `Workbook does not contain worksheet '${definition.name}' or an exported alias.`
          : `Workbook does not contain a worksheet matching '${definition.partition.namePattern}'.`,
      ));
    }
  });
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, diagnostics };
  }
  return { success: true, document: { format: "xlsx", sheets }, diagnostics };
}

export async function serializeXlsxTable(
  originalBytes: Uint8Array,
  document: TableDocument,
  tableType: TableTypeDefinition,
  layout: TableLayoutDefinition,
): Promise<Uint8Array> {
  const ExcelJS = loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(originalBytes));
  for (const sheet of document.sheets) {
    const definition = tableType.sheets.find((candidate) => candidate.id === sheet.definitionId);
    const worksheet = workbook.getWorksheet(sheet.name);
    if (definition === undefined || worksheet === undefined) {
      throw new Error(`Cannot serialize unknown worksheet '${sheet.name}'.`);
    }
    const originalDataRowCount = Math.max(0, worksheet.actualRowCount - layout.dataStartRow + 1);
    const structuralChange = sheet.rows.length !== originalDataRowCount
      || sheet.rows.some((row, index) => row.sourceRowNumber !== layout.dataStartRow + index);
    if (structuralChange) {
      rewriteWorksheetRows(worksheet, sheet, definition, layout, originalDataRowCount);
    } else {
      patchWorksheetCells(worksheet, sheet, definition);
    }
  }
  const output = await workbook.xlsx.writeBuffer();
  return Uint8Array.from(Buffer.from(output));
}

function parseWorksheet(
  worksheet: ExcelJS.Worksheet,
  definition: TableSheetDefinition,
  layout: TableLayoutDefinition,
  diagnostics: DocumentDiagnostic[],
): TableSheet | undefined {
  if (worksheet.actualRowCount < layout.nameKeyRow) {
    diagnostics.push(error(
      "table.missingNameKeyRow",
      `sheets.${worksheet.name}.rows[${layout.nameKeyRow}]`,
      `Worksheet does not contain configured name-key row ${layout.nameKeyRow}.`,
    ));
    return undefined;
  }
  const nameKeys = readRowText(worksheet.getRow(layout.nameKeyRow), worksheet.actualColumnCount);
  const columnIndexes = resolveColumnIndexes(nameKeys, definition, `sheets.${worksheet.name}`, diagnostics);
  const headerRows: string[][] = [];
  for (let rowNumber = 1; rowNumber < layout.dataStartRow; rowNumber += 1) {
    headerRows.push(readRowText(worksheet.getRow(rowNumber), worksheet.actualColumnCount));
  }
  const rows: TableRow[] = [];
  const usedIds = new Set<string>();
  for (let sourceRowNumber = layout.dataStartRow; sourceRowNumber <= worksheet.actualRowCount; sourceRowNumber += 1) {
    const worksheetRow = worksheet.getRow(sourceRowNumber);
    const rawCells = readRowText(worksheetRow, worksheet.actualColumnCount);
    if (rawCells.every((cell) => cell.length === 0)) {
      continue;
    }
    const cells: Record<string, JsonValue> = {};
    definition.columns.forEach((column) => {
      const columnIndex = columnIndexes[column.id];
      if (columnIndex === undefined) {
        cells[column.id] = cloneJsonValue(column.defaultValue);
        return;
      }
      try {
        cells[column.id] = decodeTableCell(readCellValue(worksheetRow.getCell(columnIndex + 1)), column);
      } catch (errorValue) {
        diagnostics.push(error(
          "table.invalidCell",
          `sheets.${worksheet.name}.rows[${sourceRowNumber}].${column.id}`,
          formatError(errorValue),
        ));
        cells[column.id] = cloneJsonValue(column.defaultValue);
      }
    });
    rows.push({
      id: createRowId(definition, cells, sourceRowNumber, usedIds, worksheet.name),
      cells,
      sourceRowNumber,
      rawCells,
      changedColumnIds: [],
    });
  }
  return {
    id: definition.partition === undefined ? definition.id : `${definition.id}:${worksheet.name}`,
    definitionId: definition.id,
    title: definition.title,
    name: worksheet.name,
    headerRows,
    columnIndexes,
    rows,
  };
}

function patchWorksheetCells(
  worksheet: ExcelJS.Worksheet,
  sheet: TableSheet,
  definition: TableSheetDefinition,
): void {
  sheet.rows.forEach((row) => {
    if (row.sourceRowNumber === undefined) {
      throw new Error(`Row '${row.id}' has no source row during non-structural write.`);
    }
    row.changedColumnIds.forEach((columnId) => {
      const column = definition.columns.find((candidate) => candidate.id === columnId);
      const columnIndex = sheet.columnIndexes[columnId];
      const value = row.cells[columnId];
      if (column === undefined || columnIndex === undefined || value === undefined) {
        throw new Error(`Cannot write column '${columnId}' in row '${row.id}'.`);
      }
      worksheet.getRow(row.sourceRowNumber!).getCell(columnIndex + 1).value = toExcelCellValue(value, column);
    });
  });
}

function rewriteWorksheetRows(
  worksheet: ExcelJS.Worksheet,
  sheet: TableSheet,
  definition: TableSheetDefinition,
  layout: TableLayoutDefinition,
  originalDataRowCount: number,
): void {
  const maximumColumn = Math.max(
    worksheet.actualColumnCount,
    ...Object.values(sheet.columnIndexes).map((index) => index + 1),
  );
  const snapshots = new Map<number, RowSnapshot>();
  for (let rowNumber = layout.dataStartRow; rowNumber < layout.dataStartRow + originalDataRowCount; rowNumber += 1) {
    snapshots.set(rowNumber, snapshotRow(worksheet.getRow(rowNumber), maximumColumn));
  }
  const insertedValues = sheet.rows.map((row) => {
    const snapshot = row.sourceRowNumber === undefined ? undefined : snapshots.get(row.sourceRowNumber);
    const values = snapshot === undefined ? createEmptyRowValues(maximumColumn) : [...snapshot.values];
    definition.columns.forEach((column) => {
      const columnIndex = sheet.columnIndexes[column.id];
      const value = row.cells[column.id];
      if (columnIndex === undefined || value === undefined) {
        throw new Error(`Cannot write column '${column.id}' in row '${row.id}'.`);
      }
      values[columnIndex] = toExcelCellValue(value, column);
    });
    return values;
  });
  worksheet.spliceRows(layout.dataStartRow, originalDataRowCount, ...insertedValues);
  sheet.rows.forEach((row, index) => {
    const snapshot = row.sourceRowNumber === undefined ? undefined : snapshots.get(row.sourceRowNumber);
    if (snapshot === undefined) {
      return;
    }
    const target = worksheet.getRow(layout.dataStartRow + index);
    if (snapshot.height !== undefined) {
      target.height = snapshot.height;
    }
    snapshot.styles.forEach((style, columnIndex) => {
      target.getCell(columnIndex + 1).style = style;
    });
  });
}

function snapshotRow(row: ExcelJS.Row, maximumColumn: number): RowSnapshot {
  const values: ExcelJS.CellValue[] = [];
  const styles: Partial<ExcelJS.Style>[] = [];
  for (let columnNumber = 1; columnNumber <= maximumColumn; columnNumber += 1) {
    const cell = row.getCell(columnNumber);
    values.push(cell.value);
    styles.push(cell.style);
  }
  return { values, styles, ...(row.height === undefined ? {} : { height: row.height }) };
}

function createEmptyRowValues(maximumColumn: number): ExcelJS.CellValue[] {
  return Array.from({ length: maximumColumn }, () => null);
}

function toExcelCellValue(value: JsonValue, column: TableColumnDefinition): ExcelJS.CellValue {
  if (column.cellEncoding.kind === "scalar") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
  }
  return encodeTableCell(value, column);
}

function readRowText(row: ExcelJS.Row, maximumColumn: number): string[] {
  const result: string[] = [];
  for (let columnNumber = 1; columnNumber <= maximumColumn; columnNumber += 1) {
    result.push(readCellValue(row.getCell(columnNumber)));
  }
  return result;
}

function readCellValue(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined && value.result !== null) {
      return String(value.result);
    }
    if ("text" in value && typeof value.text === "string") {
      return value.text;
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
  }
  return String(value);
}

function resolveColumnIndexes(
  nameKeys: readonly string[],
  sheet: TableSheetDefinition,
  path: string,
  diagnostics: DocumentDiagnostic[],
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  sheet.columns.forEach((column) => {
    const allowed = new Set([column.nameKey, ...column.nameKeyAliases]);
    const matches = nameKeys.flatMap((nameKey, index) => allowed.has(nameKey.trim()) ? [index] : []);
    if (matches.length === 0) {
      diagnostics.push(error(
        "table.missingColumn",
        `${path}.columns.${column.id}`,
        `Name-key row does not contain '${column.nameKey}' or an exported alias.`,
      ));
    } else if (matches.length > 1) {
      diagnostics.push(error(
        "table.ambiguousColumn",
        `${path}.columns.${column.id}`,
        `Name-key row contains more than one match for '${column.nameKey}'.`,
      ));
    } else {
      result[column.id] = matches[0]!;
    }
  });
  return result;
}

function failure(code: string, path: string, message: string): DocumentParseResult<never> {
  return { success: false, diagnostics: [error(code, path, message)] };
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface RowSnapshot {
  readonly values: readonly ExcelJS.CellValue[];
  readonly styles: readonly Partial<ExcelJS.Style>[];
  readonly height?: number;
}

function loadExcelJs(): typeof ExcelJS {
  // Keep the workbook implementation out of the extension activation path.
  // The Webview consumes the dedicated browser-only entrypoint and never calls this loader.
  return require("exceljs") as typeof ExcelJS;
}
