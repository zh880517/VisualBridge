import type { DocumentDiagnostic, DocumentParseResult, JsonValue, TableLayoutDefinition } from "@visualbridge/core";
import { cloneJsonValue } from "@visualbridge/core";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { decodeTableCell, encodeTableCell } from "./cellCodec";
import type { TableSheetDefinition, TableTypeDefinition } from "./tableCatalog";
import { matchTableSheetDefinitions } from "./tableCatalog";
import { createRowId, type TableDocument, type TableRow } from "./tableDocument";

export function parseCsvTable(
  text: string,
  tableType: TableTypeDefinition,
  layout: TableLayoutDefinition,
  physicalName = tableType.sheets[0]?.name ?? "Table",
): DocumentParseResult<TableDocument> {
  if (tableType.csv === undefined) {
    return failure("table.csvNotConfigured", "csv", "Table Type does not declare a CSV delimiter.");
  }
  const sheetDefinition = selectCsvSheet(tableType, physicalName);
  if (sheetDefinition === undefined) {
    return failure(
      "table.csvSheetAmbiguous",
      "sheets",
      `No single Table Sheet definition matches CSV '${physicalName}'.`,
    );
  }
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      delimiter: tableType.csv.delimiter,
      relax_column_count: true,
      skip_empty_lines: false,
    }) as string[][];
  } catch (errorValue) {
    return failure("table.invalidCsv", "$", formatError(errorValue));
  }
  if (records.length < layout.nameKeyRow) {
    return failure(
      "table.missingNameKeyRow",
      `rows[${layout.nameKeyRow}]`,
      `CSV does not contain configured name-key row ${layout.nameKeyRow}.`,
    );
  }
  const diagnostics: DocumentDiagnostic[] = [];
  const nameKeys = records[layout.nameKeyRow - 1] ?? [];
  const columnIndexes = resolveColumnIndexes(nameKeys, sheetDefinition, diagnostics);
  const headerRows = records.slice(0, layout.dataStartRow - 1).map((row) => [...row]);
  const rows: TableRow[] = [];
  const usedIds = new Set<string>();
  records.slice(layout.dataStartRow - 1).forEach((rawCells, relativeIndex) => {
    if (rawCells.every((cell) => cell.length === 0)) {
      return;
    }
    const sourceRowNumber = layout.dataStartRow + relativeIndex;
    const cells: Record<string, JsonValue> = {};
    for (const column of sheetDefinition.columns) {
      const columnIndex = columnIndexes[column.id];
      if (columnIndex === undefined) {
        cells[column.id] = cloneJsonValue(column.defaultValue);
        continue;
      }
      try {
        cells[column.id] = decodeTableCell(rawCells[columnIndex] ?? "", column);
      } catch (errorValue) {
        diagnostics.push(error(
          "table.invalidCell",
          `rows[${sourceRowNumber}].${column.id}`,
          formatError(errorValue),
        ));
        cells[column.id] = cloneJsonValue(column.defaultValue);
      }
    }
    rows.push({
      id: createRowId(sheetDefinition, cells, sourceRowNumber, usedIds, physicalName),
      cells,
      sourceRowNumber,
      rawCells: [...rawCells],
      changedColumnIds: [],
    });
  });
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, diagnostics };
  }
  const physicalId = sheetDefinition.partition === undefined
    ? sheetDefinition.id
    : `${sheetDefinition.id}:${physicalName}`;
  return {
    success: true,
    document: {
      format: "csv",
      sheets: [{
        id: physicalId,
        definitionId: sheetDefinition.id,
        title: sheetDefinition.title,
        name: physicalName,
        headerRows,
        columnIndexes,
        rows,
      }],
    },
    diagnostics,
  };
}

export function serializeCsvTable(
  document: TableDocument,
  tableType: TableTypeDefinition,
  originalText: string,
): string {
  if (tableType.csv === undefined) {
    throw new Error("Table Type does not declare a CSV delimiter.");
  }
  const sheet = document.sheets[0];
  if (sheet === undefined) {
    throw new Error("CSV Table Document must contain one sheet.");
  }
  const definition = tableType.sheets.find((candidate) => candidate.id === sheet.definitionId);
  if (definition === undefined) {
    throw new Error(`Unknown Table Sheet definition '${sheet.definitionId}'.`);
  }
  const records = sheet.headerRows.map((row) => [...row]);
  for (const row of sheet.rows) {
    const rawCells = [...row.rawCells];
    for (const column of definition.columns) {
      const columnIndex = sheet.columnIndexes[column.id];
      if (columnIndex === undefined) {
        throw new Error(`Name-key row does not contain '${column.nameKey}'.`);
      }
      while (rawCells.length <= columnIndex) {
        rawCells.push("");
      }
      if (row.sourceRowNumber === undefined || row.changedColumnIds.includes(column.id)) {
        const value = row.cells[column.id];
        if (value === undefined) {
          throw new Error(`Row '${row.id}' is missing column '${column.id}'.`);
        }
        rawCells[columnIndex] = encodeTableCell(value, column);
      }
    }
    records.push(rawCells);
  }
  const recordDelimiter = originalText.includes("\r\n") ? "\r\n" : "\n";
  return stringify(records, {
    delimiter: tableType.csv.delimiter,
    record_delimiter: recordDelimiter,
    eof: originalText.endsWith("\n"),
  });
}

function selectCsvSheet(
  tableType: TableTypeDefinition,
  physicalName: string,
): TableSheetDefinition | undefined {
  const matches = matchTableSheetDefinitions(tableType, physicalName);
  if (matches.length === 1) {
    return matches[0];
  }
  return tableType.sheets.length === 1 ? tableType.sheets[0] : undefined;
}

function resolveColumnIndexes(
  nameKeys: readonly string[],
  sheet: TableSheetDefinition,
  diagnostics: DocumentDiagnostic[],
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  sheet.columns.forEach((column) => {
    const allowed = new Set([column.nameKey, ...column.nameKeyAliases]);
    const matches = nameKeys.flatMap((nameKey, index) => allowed.has(nameKey.trim()) ? [index] : []);
    if (matches.length === 0) {
      diagnostics.push(error(
        "table.missingColumn",
        `columns.${column.id}`,
        `Name-key row does not contain '${column.nameKey}' or an exported alias.`,
      ));
    } else if (matches.length > 1) {
      diagnostics.push(error(
        "table.ambiguousColumn",
        `columns.${column.id}`,
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
