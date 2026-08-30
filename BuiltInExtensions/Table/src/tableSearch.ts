import type { JsonValue } from "@visualbridge/core";
import { encodeTableCell } from "./cellCodec";
import { formatTableRowDisplayName, type TableColumnDefinition, type TableSheetDefinition } from "./tableCatalog";
import type { TableRow } from "./tableDocument";

export function buildTableRowSearchText(
  row: Pick<TableRow, "cells">,
  definition: TableSheetDefinition,
): string {
  return normalizeTableSearchText([
    formatTableRowDisplayName(row.cells, definition),
    ...definition.columns.map((column) => formatSearchCell(row.cells[column.id], column)),
  ].join(" "));
}

export function normalizeTableSearchQuery(query: string): readonly string[] {
  return normalizeTableSearchText(query).trim().split(/\s+/u).filter(Boolean);
}

export function matchesTableRowSearch(
  row: Pick<TableRow, "cells">,
  definition: TableSheetDefinition,
  query: string,
): boolean {
  const terms = normalizeTableSearchQuery(query);
  if (terms.length === 0) {
    return true;
  }
  const searchText = buildTableRowSearchText(row, definition);
  return terms.every((term) => searchText.includes(term));
}

function normalizeTableSearchText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function formatSearchCell(
  value: JsonValue | undefined,
  definition: TableColumnDefinition,
): string {
  if (value === undefined) {
    return "";
  }
  try {
    return encodeTableCell(value, definition);
  } catch {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
}
