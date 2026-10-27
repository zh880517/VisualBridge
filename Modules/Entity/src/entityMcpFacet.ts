/**
 * Entity 模块的 `mcp` facet（附录 D.3）：Catalog 定义浏览、文档内条目搜索。
 */
import type { JsonValue, McpFacet, McpQueryResult } from "@visualbridge/module-sdk";
import { compareUtf16CodeUnits } from "@visualbridge/module-sdk";
import {
  searchEntityComponentTypes,
  type EntityCatalogRegistry,
} from "./entityCatalog";
import type { EntityDocument } from "./entityDocument";

export const entityMcpFacet: McpFacet<EntityDocument, EntityCatalogRegistry> = {
  editor: "entity",

  queryCatalog(registry, request) {
    const fields = { catalogs: registry.catalogs as unknown as JsonValue };
    const kind = request.kind.length === 0 ? "summary" : request.kind;
    if (request.action === "read") {
      if (kind === "summary") {
        return {
          kind: "counts",
          counts: {
            componentGroups: registry.componentGroups.length,
            entityTypes: registry.entityTypes.length,
            componentTypes: registry.componentTypes.length,
          },
          fields,
        };
      }
      if (kind !== "componentGroups" && kind !== "entityTypes" && kind !== "componentTypes") {
        return unsupported(`Entity Catalog kind '${kind}' is not supported.`);
      }
      return { kind: "definitions", definitions: entityDefinitions(registry, kind), fields };
    }
    if (kind === "componentTypes") {
      const entityTypeId = optionalString(request.selector.entityTypeId);
      if (request.selector.entityTypeId !== undefined && entityTypeId === undefined) {
        return invalid("request.invalidSelector", "selector.entityTypeId must be a string.");
      }
      return {
        kind: "results",
        results: searchEntityComponentTypes(registry, {
          query: request.query,
          ...(entityTypeId === undefined ? {} : { entityTypeId }),
          limit: Math.max(1, registry.componentTypes.length),
        }) as unknown as readonly JsonValue[],
      };
    }
    if (kind !== "entityTypes" && kind !== "componentGroups") {
      return unsupported(`Entity Catalog kind '${kind}' is not searchable.`);
    }
    const terms = queryTerms(request.query);
    const results = entityDefinitions(registry, kind)
      .filter((definition) => terms.every((term) => JSON.stringify(definition).toLowerCase().includes(term)))
      .sort((left, right) => compareUtf16CodeUnits(titleOf(left), titleOf(right))
        || compareUtf16CodeUnits(idOf(left), idOf(right)));
    return { kind: "results", results };
  },

  queryDocument(mode, document) {
    if (mode === "read") return { kind: "read", fields: {} };
    return { kind: "results", results: entitySearchEntries(document) as unknown as readonly JsonValue[] };
  },
};

function entityDefinitions(registry: EntityCatalogRegistry, kind: string): readonly JsonValue[] {
  const source = kind === "componentGroups"
    ? registry.componentGroups
    : kind === "entityTypes"
      ? registry.entityTypes
      : registry.componentTypes;
  return source as unknown as readonly JsonValue[];
}

function entitySearchEntries(document: EntityDocument): readonly (Record<string, unknown> & {
  readonly searchText: string;
})[] {
  const entries: (Record<string, unknown> & { searchText: string })[] = [{
    kind: "entity",
    id: document.documentId,
    entityTypeId: document.entityTypeId,
    title: document.title,
    path: "$",
    searchText: `${document.documentId} ${document.entityTypeId} ${document.title}`.toLowerCase(),
  }];
  collectValueEntries(document.properties, "properties", undefined, entries);
  document.components.forEach((component, index) => {
    entries.push({
      kind: "component",
      id: component.id,
      componentId: component.id,
      componentTypeId: component.componentTypeId,
      enabled: component.enabled,
      path: `components[${index}]`,
      searchText: `${component.id} ${component.componentTypeId}`.toLowerCase(),
    });
    collectValueEntries(component.properties, `components[${index}].properties`, component.id, entries);
  });
  return entries;
}

function collectValueEntries(
  value: unknown,
  path: string,
  componentId: string | undefined,
  entries: (Record<string, unknown> & { searchText: string })[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectValueEntries(entry, `${path}[${index}]`, componentId, entries));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .forEach(([key, entry]) => collectValueEntries(entry, `${path}.${key}`, componentId, entries));
    return;
  }
  entries.push({
    kind: "field",
    path,
    ...(componentId === undefined ? {} : { componentId }),
    value,
    searchText: `${path} ${String(value)}`.toLowerCase(),
  });
}

function queryTerms(query: string): readonly string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
}

function idOf(definition: JsonValue): string {
  return String((definition as { id?: unknown }).id ?? "");
}

function titleOf(definition: JsonValue): string {
  return String((definition as { title?: unknown }).title ?? "");
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function unsupported(message: string): McpQueryResult {
  return { kind: "unsupported", message };
}

function invalid(code: string, message: string): McpQueryResult {
  return { kind: "invalidRequest", code, message };
}
