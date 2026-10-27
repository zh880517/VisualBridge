import { createUnknownCatalogSource } from "@visualbridge/module-sdk";
import type { GraphCatalog, GraphCatalogRegistry } from "./types";
import { GRAPH_CATALOG_FORMAT_VERSION } from "./types";

export function createEmptyGraphCatalog(catalogId = "empty"): GraphCatalog {
  return {
    formatVersion: GRAPH_CATALOG_FORMAT_VERSION,
    catalogId,
    title: catalogId,
    source: createUnknownCatalogSource(),
    dataTypes: [],
    graphTypes: [],
    nodeTypes: [],
  };
}

export function createEmptyGraphCatalogRegistry(): GraphCatalogRegistry {
  return {
    catalogs: [],
    dataTypes: [],
    graphTypes: [],
    nodeTypes: [],
  };
}
