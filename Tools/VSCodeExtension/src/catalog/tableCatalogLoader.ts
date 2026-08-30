import {
  createEmptyTableCatalogRegistry,
  tableCatalogAdapter,
  type TableCatalog,
  type TableCatalogRegistry,
} from "@visualbridge/table";
import type { ProjectContext } from "../project/projectRegistry";
import { loadCatalogRegistry, type CatalogRegistryLoadResult } from "./catalogRegistryLoader";

export type TableCatalogLoadResult = CatalogRegistryLoadResult<TableCatalog, TableCatalogRegistry>;

export function loadTableCatalogRegistry(
  project: ProjectContext,
  catalogPaths: readonly string[],
): Promise<TableCatalogLoadResult> {
  return loadCatalogRegistry(project, catalogPaths, tableCatalogAdapter, createEmptyTableCatalogRegistry);
}
