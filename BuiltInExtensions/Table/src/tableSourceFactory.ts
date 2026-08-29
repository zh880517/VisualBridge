import type { DocumentDiagnostic, TableLayoutDefinition } from "@visualbridge/core";
import { stringify } from "csv-stringify/sync";
import type ExcelJS = require("exceljs");
import {
  matchTableSheetDefinitions,
  type TableSheetDefinition,
  type TableTypeDefinition,
} from "./tableCatalog";

export type TableSourceCreateResult =
  | { readonly success: true; readonly bytes: Uint8Array }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] };

export function createEmptyCsvTableSource(
  tableType: TableTypeDefinition,
  layout: TableLayoutDefinition,
  physicalName: string,
): TableSourceCreateResult {
  if (tableType.csv === undefined) {
    return failure("table.csvNotConfigured", "csv", "Table Type does not declare a CSV delimiter.");
  }
  const matches = matchTableSheetDefinitions(tableType, physicalName);
  const sheet = matches.length === 1
    ? matches[0]
    : matches.length === 0 && tableType.sheets.length === 1 && tableType.sheets[0]?.partition === undefined
      ? tableType.sheets[0]
      : undefined;
  if (sheet === undefined) {
    return failure(
      "table.csvSheetAmbiguous",
      "sheets",
      `No single Table Sheet definition matches CSV '${physicalName}'.`,
    );
  }
  const rows = createHeaderRows(sheet, layout);
  const text = stringify(rows, {
    delimiter: tableType.csv.delimiter,
    record_delimiter: "\n",
    eof: true,
  });
  return { success: true, bytes: new TextEncoder().encode(text) };
}

export async function createEmptyXlsxTableSource(
  tableType: TableTypeDefinition,
  layout: TableLayoutDefinition,
): Promise<TableSourceCreateResult> {
  try {
    const ExcelJS = loadExcelJs();
    const workbook = new ExcelJS.Workbook();
    const usedNames = new Set<string>();
    for (const sheet of tableType.sheets) {
      const physicalName = createInitialWorksheetName(sheet);
      if (usedNames.has(physicalName)) {
        return failure(
          "table.duplicateInitialSheetName",
          `sheets.${sheet.id}`,
          `Initial worksheet name '${physicalName}' is not unique.`,
        );
      }
      usedNames.add(physicalName);
      const worksheet = workbook.addWorksheet(physicalName);
      createHeaderRows(sheet, layout).forEach((row, rowIndex) => {
        const worksheetRow = worksheet.getRow(rowIndex + 1);
        row.forEach((value, columnIndex) => {
          worksheetRow.getCell(columnIndex + 1).value = value;
        });
        worksheetRow.commit();
      });
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return { success: true, bytes: Uint8Array.from(Buffer.from(buffer)) };
  } catch (errorValue) {
    return failure("table.createXlsxFailed", "$", formatError(errorValue));
  }
}

function createHeaderRows(
  sheet: TableSheetDefinition,
  layout: TableLayoutDefinition,
): string[][] {
  const rows = Array.from(
    { length: layout.dataStartRow - 1 },
    () => Array.from({ length: sheet.columns.length }, () => ""),
  );
  const nameKeyRow = rows[layout.nameKeyRow - 1];
  sheet.columns.forEach((column, index) => {
    if (nameKeyRow !== undefined) {
      nameKeyRow[index] = column.nameKey;
    }
  });
  const descriptionRowIndex = rows.findIndex((_row, index) => index !== layout.nameKeyRow - 1);
  const descriptionRow = rows[descriptionRowIndex];
  if (descriptionRow !== undefined) {
    sheet.columns.forEach((column, index) => {
      descriptionRow[index] = column.title;
    });
  }
  return rows;
}

function createInitialWorksheetName(sheet: TableSheetDefinition): string {
  return sheet.partition === undefined
    ? sheet.name
    : sheet.partition.namePattern.replace("{part}", "Main");
}

function failure(code: string, path: string, message: string): TableSourceCreateResult {
  return { success: false, diagnostics: [{ severity: "error", code, path, message }] };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function loadExcelJs(): typeof ExcelJS {
  return require("exceljs") as typeof ExcelJS;
}
