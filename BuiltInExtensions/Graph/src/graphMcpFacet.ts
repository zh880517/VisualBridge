/**
 * Graph 模块的 `mcp` facet（附录 D.3）：Catalog 定义浏览、文档内条目搜索。
 *
 * 宿主只提供 Catalog Registry 与已解析文档；这里不读文件、不写文件、不感知 MCP 工具形状。
 */
import type { JsonValue, McpFacet, McpQueryResult } from "@visualbridge/core";
import { compareUtf16CodeUnits } from "@visualbridge/core";
import { searchGraphNodeTypes, type GraphCatalogRegistry } from "./graphCatalog";
import type { GraphDocument } from "./graphDocument";

const GRAPH_SEARCH_KINDS: ReadonlySet<string> = new Set(["all", "graph", "node", "port", "edge", "field"]);

export const graphMcpFacet: McpFacet<GraphDocument, GraphCatalogRegistry> = {
  editor: "graph",

  queryCatalog(registry, request) {
    const fields = { catalogs: registry.catalogs as unknown as JsonValue };
    const kind = request.kind.length === 0 ? "summary" : request.kind;
    if (request.action === "read") {
      if (kind === "summary") return { kind: "counts", counts: graphCatalogCounts(registry), fields };
      if (kind !== "nodeTypes" && kind !== "graphTypes" && kind !== "dataTypes") {
        return unsupported(`Graph Catalog kind '${kind}' is not supported.`);
      }
      return { kind: "definitions", definitions: graphCatalogDefinitions(registry, kind), fields };
    }
    return searchCatalog(registry, kind, request);
  },

  queryDocument(mode, document, request) {
    if (mode === "read") return { kind: "read", fields: {} };
    const kind = optionalString(request.selector.kind);
    if (request.selector.kind !== undefined && kind === undefined) {
      return invalid("request.invalidSelector", "selector.kind must be a string.");
    }
    // 省略 kind 即全量搜索（与改造前的 `?? "all"` 一致）；只有值非法才是不支持的 search kind。
    const searchKind = kind ?? "all";
    if (!GRAPH_SEARCH_KINDS.has(searchKind)) {
      return invalid("document.searchKindUnsupported", `Graph Document search kind '${searchKind}' is not supported.`);
    }
    const query = normalizeSearchQuery(request.query);
    const entries = graphSearchEntries(document)
      .filter((entry) => searchKind === "all" || entry.kind === searchKind)
      .filter((entry) => query.length === 0 || entry.searchText.includes(query));
    return {
      kind: "results",
      results: entries.map(({ searchText: _searchText, ...entry }) => entry as unknown as JsonValue),
    };
  },
};

export function graphCatalogCounts(registry: GraphCatalogRegistry): Readonly<Record<string, number>> {
  return {
    dataTypes: registry.dataTypes.length,
    graphTypes: registry.graphTypes.length,
    nodeTypes: registry.nodeTypes.length,
  };
}

export function graphCatalogDefinitions(registry: GraphCatalogRegistry, kind: string): readonly JsonValue[] {
  const source = kind === "dataTypes"
    ? registry.dataTypes
    : kind === "graphTypes"
      ? registry.graphTypes
      : registry.nodeTypes;
  return source as unknown as readonly JsonValue[];
}

function searchCatalog(
  registry: GraphCatalogRegistry,
  kind: string,
  request: { readonly query: string; readonly selector: Readonly<Record<string, JsonValue>> },
): McpQueryResult {
  if (kind !== "nodeTypes" && kind !== "graphTypes" && kind !== "dataTypes") {
    return unsupported(`Graph Catalog kind '${kind}' is not searchable.`);
  }
  if (kind !== "nodeTypes") {
    const query = request.query.trim().toLowerCase();
    const definitions = graphCatalogDefinitions(registry, kind)
      .filter((definition) => query.length === 0 || JSON.stringify(definition).toLowerCase().includes(query))
      .sort((left, right) =>
        compareUtf16CodeUnits(String((left as { id?: unknown }).id), String((right as { id?: unknown }).id)));
    return { kind: "results", results: definitions };
  }
  const graphTypeId = optionalString(request.selector.graphTypeId);
  if (request.selector.graphTypeId !== undefined && graphTypeId === undefined) {
    return invalid("request.invalidSelector", "selector.graphTypeId must be a string.");
  }
  const includeSubgraphNodeTypes = optionalBoolean(request.selector.includeSubgraphNodeTypes);
  if (request.selector.includeSubgraphNodeTypes !== undefined && includeSubgraphNodeTypes === undefined) {
    return invalid("request.invalidSelector", "selector.includeSubgraphNodeTypes must be a boolean.");
  }
  return {
    kind: "results",
    results: searchGraphNodeTypes(registry, {
      query: request.query,
      ...(graphTypeId === undefined ? {} : { graphTypeId }),
      includeSubgraphNodeTypes: includeSubgraphNodeTypes ?? true,
      limit: Math.max(1, registry.nodeTypes.length),
    }) as unknown as readonly JsonValue[],
  };
}

function graphSearchEntries(document: GraphDocument): readonly (Record<string, unknown> & {
  readonly kind: string;
  readonly searchText: string;
})[] {
  const entries: (Record<string, unknown> & { kind: string; searchText: string })[] = [];
  document.graphs.forEach((graph, graphIndex) => {
    const graphPath = `graphs[${graphIndex}]`;
    entries.push({
      kind: "graph",
      graphId: graph.id,
      graphTypeId: graph.graphTypeId,
      title: graph.title,
      path: graphPath,
      searchText: `${graph.id} ${graph.graphTypeId ?? ""} ${graph.title}`.toLowerCase(),
    });
    collectSearchValues(graph.properties, `${graphPath}.properties`, { graphId: graph.id }, entries);
    graph.interfacePorts.forEach((port, portIndex) => entries.push({
      kind: "port",
      graphId: graph.id,
      portId: port.id,
      title: port.title,
      path: `${graphPath}.interfacePorts[${portIndex}]`,
      searchText: `${port.id} ${port.title} ${port.kind} ${port.direction} ${port.dataTypeId ?? ""}`.toLowerCase(),
    }));
    graph.nodes.forEach((node, nodeIndex) => {
      const nodePath = `${graphPath}.nodes[${nodeIndex}]`;
      entries.push({
        kind: "node",
        graphId: graph.id,
        nodeId: node.id,
        nodeTypeId: node.nodeTypeId,
        title: node.title,
        path: nodePath,
        searchText: `${node.id} ${node.nodeTypeId ?? ""} ${node.title}`.toLowerCase(),
      });
      collectSearchValues(node.properties, `${nodePath}.properties`, { graphId: graph.id, nodeId: node.id }, entries);
      node.dynamicPorts.forEach((port, portIndex) => entries.push({
        kind: "port",
        graphId: graph.id,
        nodeId: node.id,
        portId: port.id,
        title: port.title,
        path: `${nodePath}.dynamicPorts[${portIndex}]`,
        searchText: `${port.id} ${port.groupId} ${port.title}`.toLowerCase(),
      }));
    });
    graph.edges.forEach((edge, edgeIndex) => entries.push({
      kind: "edge",
      graphId: graph.id,
      edgeId: edge.id,
      edgeKind: edge.kind,
      path: `${graphPath}.edges[${edgeIndex}]`,
      searchText: JSON.stringify(edge).toLowerCase(),
    }));
  });
  return entries;
}

function collectSearchValues(
  value: unknown,
  path: string,
  location: Readonly<Record<string, unknown>>,
  entries: (Record<string, unknown> & { kind: string; searchText: string })[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSearchValues(entry, `${path}[${index}]`, location, entries));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .forEach(([key, entry]) => collectSearchValues(entry, `${path}.${key}`, location, entries));
    return;
  }
  entries.push({
    kind: "field",
    ...location,
    path,
    value,
    searchText: `${path} ${String(value)}`.toLowerCase(),
  });
}

function normalizeSearchQuery(query: string): string {
  return query.normalize("NFC").trim().toLowerCase();
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
