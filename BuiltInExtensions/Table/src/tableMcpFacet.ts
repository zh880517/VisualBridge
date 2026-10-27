/**
 * Table 模块的 `mcp` facet（附录 D.3）：Catalog 定义浏览、物理分表读取与行搜索。
 *
 * 分页、游标与投影仍由宿主负责；这里只按 selector 选出"该返回哪些行"。
 */
import type { JsonValue, McpFacet, McpQueryResult } from "@visualbridge/core";
import { canonicalJsonStringify, compareUtf16CodeUnits } from "@visualbridge/core";
import {
  formatTableRowDisplayName,
  resolveTableColumn,
  resolveTableSheet,
  resolveTableType,
  type RegisteredTableTypeDefinition,
  type TableCatalogRegistry,
} from "./tableCatalog";
import { buildTableRowSearchText, normalizeTableSearchQuery } from "./tableSearch";
import { resolveEffectiveTableRows, type TableDocument, type TableRow } from "./tableDocument";

export const tableMcpFacet: McpFacet<TableDocument, TableCatalogRegistry> = {
  editor: "table",

  queryCatalog(registry, request) {
    const fields = { catalogs: registry.catalogs as unknown as JsonValue };
    const kind = request.kind.length === 0 ? "summary" : request.kind;
    if (request.action === "read") {
      if (kind === "summary") {
        return { kind: "counts", counts: tableCatalogCounts(registry.tableTypes), fields };
      }
      if (kind !== "tableTypes" && kind !== "sheets" && kind !== "columns") {
        return unsupported(`Table Catalog kind '${kind}' is not supported.`);
      }
      return { kind: "definitions", definitions: tableCatalogDefinitions(registry.tableTypes, kind), fields };
    }
    if (kind === "summary") {
      return unsupported("Table Catalog summary is not searchable.");
    }
    if (kind !== "tableTypes" && kind !== "sheets" && kind !== "columns") {
      return unsupported(`Table Catalog kind '${kind}' is not searchable.`);
    }
    const query = normalizeCatalogQuery(request.query);
    const results = tableCatalogDefinitions(registry.tableTypes, kind)
      .filter((definition) => query.length === 0 || JSON.stringify(definition).toLowerCase().includes(query))
      .sort((left, right) => compareUtf16CodeUnits(
        canonicalJsonStringify(left),
        canonicalJsonStringify(right),
      ));
    return { kind: "results", results };
  },

  queryDocument(mode, document, request, context) {
    const tableType = context.registry === undefined
      ? undefined
      : resolveTableType(context.registry, context.documentTypeId);
    if (tableType === undefined) {
      return invalid("document.editorUnsupported", "Table Catalog Registry does not resolve the Document Type.");
    }
    if (mode === "read") {
      const sheetId = optionalString(request.selector.sheetId);
      if (request.selector.sheetId !== undefined && sheetId === undefined) {
        return invalid("request.invalidSelector", "selector.sheetId must be a string.");
      }
      const sheet = sheetId === undefined
        ? undefined
        : document.sheets.find((candidate) => candidate.id === sheetId);
      if (sheetId !== undefined && sheet === undefined) {
        return invalid("table.sheetNotFound", `Unknown physical sheet '${sheetId}'.`);
      }
      return {
        kind: "read",
        fields: {
          // `format` 属于物理存储而不是宿主通用 identity：由 Table 自己作为领域字段补充。
          format: document.format,
          tableType: {
            id: tableType.id,
            title: tableType.title,
            catalogId: tableType.catalogId,
          },
          sheets: document.sheets.map((candidate) => ({
            id: candidate.id,
            definitionId: candidate.definitionId,
            title: candidate.title,
            name: candidate.name,
            rowCount: candidate.rows.length,
          })),
        },
        ...(sheet === undefined ? {} : {
          page: {
            fields: { sheetId: sheet.id },
            items: sheet.rows.map(semanticRow),
          },
        }),
      };
    }
    const sheetDefinitionId = optionalString(request.selector.sheetDefinitionId);
    if (request.selector.sheetDefinitionId !== undefined && sheetDefinitionId === undefined) {
      return invalid("request.invalidSelector", "selector.sheetDefinitionId must be a string.");
    }
    const effectiveOnly = optionalBoolean(request.selector.effectiveOnly);
    if (request.selector.effectiveOnly !== undefined && effectiveOnly === undefined) {
      return invalid("request.invalidSelector", "selector.effectiveOnly must be a boolean.");
    }
    const definition = sheetDefinitionId === undefined
      ? undefined
      : resolveTableSheet(tableType, sheetDefinitionId);
    if (sheetDefinitionId !== undefined && definition === undefined) {
      return invalid("table.sheetDefinitionNotFound", `Unknown Sheet definition '${sheetDefinitionId}'.`);
    }
    const definitions = definition === undefined ? tableType.sheets : [definition];
    const useEffectiveRows = effectiveOnly ?? true;
    const terms = normalizeTableSearchQuery(request.query);
    const results: Record<string, unknown>[] = [];
    for (const sheetDefinition of definitions) {
      const entries = useEffectiveRows
        ? resolveEffectiveTableRows(document, tableType, sheetDefinition.id).rows
        : document.sheets
          .filter((sheet) => sheet.definitionId === sheetDefinition.id)
          .flatMap((sheet) => sheet.rows.map((row) => ({ sheetId: sheet.id, sheetName: sheet.name, row })));
      for (const entry of entries) {
        const searchText = buildTableRowSearchText(entry.row, sheetDefinition);
        if (!terms.every((term) => searchText.includes(term))) continue;
        results.push({
          kind: "row",
          sheetDefinitionId: sheetDefinition.id,
          sheetId: entry.sheetId,
          sheetName: entry.sheetName,
          rowId: entry.row.id,
          displayName: formatTableRowDisplayName(entry.row.cells, sheetDefinition),
          cells: entry.row.cells,
        });
      }
    }
    return {
      kind: "results",
      // 改造前的搜索响应在顶层回显表身份与生效行范围，便于调用方复述分页游标的作用域。
      fields: {
        format: document.format,
        ...(sheetDefinitionId === undefined ? {} : { sheetDefinitionId }),
        effectiveOnly: useEffectiveRows,
      },
      results: results as unknown as readonly JsonValue[],
    };
  },
};

export function tableCatalogCounts(tableTypes: readonly RegisteredTableTypeDefinition[]): Readonly<Record<string, number>> {
  return {
    tableTypes: tableTypes.length,
    sheets: tableTypes.reduce((count, tableType) => count + tableType.sheets.length, 0),
    columns: tableTypes.reduce(
      (count, tableType) => count + tableType.sheets.reduce(
        (sheetCount, sheet) => sheetCount + sheet.columns.length,
        0,
      ),
      0,
    ),
  };
}

export function tableCatalogDefinitions(
  tableTypes: readonly RegisteredTableTypeDefinition[],
  kind: string,
): readonly JsonValue[] {
  switch (kind) {
    case "tableTypes":
      return tableTypes.map((tableType) => ({ ...tableType })) as unknown as readonly JsonValue[];
    case "sheets":
      return tableTypes.flatMap((tableType) => tableType.sheets.map((sheet) => ({
        tableTypeId: tableType.id,
        catalogId: tableType.catalogId,
        ...sheet,
      }))) as unknown as readonly JsonValue[];
    case "columns":
      return tableTypes.flatMap((tableType) => tableType.sheets.flatMap((sheet) => sheet.columns.map((column) => ({
        tableTypeId: tableType.id,
        sheetId: sheet.id,
        catalogId: tableType.catalogId,
        ...column,
      })))) as unknown as readonly JsonValue[];
    default:
      return [];
  }
}

function normalizeCatalogQuery(query: string): string {
  return query.normalize("NFC").trim().toLowerCase();
}

function semanticRow(row: TableRow): JsonValue {
  return {
    id: row.id,
    cells: row.cells as unknown as JsonValue,
    ...(row.sourceRowNumber === undefined ? {} : { sourceRowNumber: row.sourceRowNumber }),
  };
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function unsupported(message: string): McpQueryResult {
  return { kind: "unsupported", message };
}

function invalid(code: string, message: string): McpQueryResult {
  return { kind: "invalidRequest", code, message };
}
