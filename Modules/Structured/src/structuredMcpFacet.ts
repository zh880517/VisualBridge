/**
 * Structured Config 模块的 `mcp` facet（附录 D.3）：Catalog 定义浏览、字段搜索。
 */
import type { JsonValue, McpFacet, McpQueryResult } from "@visualbridge/module-sdk";
import { compareUtf16CodeUnits } from "@visualbridge/module-sdk";
import { resolveStructuredConfigType, type StructuredCatalogRegistry } from "./structuredCatalog";
import type { StructuredDocument } from "./structuredDocument";

export const structuredMcpFacet: McpFacet<StructuredDocument, StructuredCatalogRegistry> = {
  editor: "structured",

  queryCatalog(registry, request) {
    const required = resolveStructuredConfigType(registry, request.documentTypeId);
    const fields = {
      catalogs: registry.catalogs as unknown as JsonValue,
      ...(required === undefined ? {} : { requiredConfigTypeId: required.id }),
    };
    const kind = request.kind.length === 0 ? "summary" : request.kind;
    if (request.action === "read") {
      if (kind === "summary") return { kind: "counts", counts: { configTypes: registry.configTypes.length }, fields };
      if (kind === "configTypes") {
        return { kind: "definitions", definitions: registry.configTypes as unknown as readonly JsonValue[], fields };
      }
      return unsupported(`Structured Catalog kind '${kind}' is not supported.`);
    }
    if (kind !== "configTypes") {
      return unsupported(`Structured Catalog kind '${kind}' is not searchable.`);
    }
    const query = request.query.trim().toLowerCase();
    const definitions = (registry.configTypes as unknown as readonly JsonValue[])
      .filter((definition) => query.length === 0 || JSON.stringify(definition).toLowerCase().includes(query))
      .sort((left, right) => compareUtf16CodeUnits(titleOf(left), titleOf(right))
        || compareUtf16CodeUnits(idOf(left), idOf(right)));
    return { kind: "results", results: definitions, fields };
  },

  queryDocument(mode, document, request, context) {
    if (mode === "read") {
      const configType = context.registry === undefined
        ? undefined
        : resolveStructuredConfigType(context.registry, context.documentTypeId);
      return {
        kind: "read",
        fields: configType === undefined ? {} : { configType: configType as unknown as JsonValue },
      };
    }
    const query = request.query.trim().toLowerCase();
    const entries: (Record<string, unknown> & { searchText: string })[] = [];
    collectStructuredSearchValues(document.properties, "properties", entries);
    return {
      kind: "results",
      results: entries
        .filter((entry) => query.length === 0 || entry.searchText.includes(query))
        .map(({ searchText: _searchText, ...entry }) => entry as unknown as JsonValue),
    };
  },
};

function collectStructuredSearchValues(
  value: unknown,
  path: string,
  entries: (Record<string, unknown> & { searchText: string })[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStructuredSearchValues(entry, `${path}[${index}]`, entries));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .forEach(([key, entry]) => collectStructuredSearchValues(entry, `${path}.${key}`, entries));
    return;
  }
  entries.push({
    kind: "field",
    path,
    value,
    searchText: `${path} ${String(value)}`.toLowerCase(),
  });
}

function idOf(definition: JsonValue): string {
  return String((definition as { id?: unknown }).id ?? "");
}

function titleOf(definition: JsonValue): string {
  return String((definition as { title?: unknown }).title ?? "");
}

function unsupported(message: string): McpQueryResult {
  return { kind: "unsupported", message };
}
