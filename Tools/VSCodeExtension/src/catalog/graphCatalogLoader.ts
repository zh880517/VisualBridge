import {
  createEmptyGraphCatalogRegistry,
  graphCatalogAdapter,
  type GraphCatalog,
  type GraphCatalogRegistry,
} from "@visualbridge/graph";
import type { ProjectContext } from "../project/projectRegistry";
import { loadCatalogRegistry, type CatalogRegistryLoadResult } from "./catalogRegistryLoader";

export type GraphCatalogLoadResult = CatalogRegistryLoadResult<GraphCatalog, GraphCatalogRegistry>;

export function loadGraphCatalogRegistry(
  project: ProjectContext,
  catalogPaths: readonly string[],
): Promise<GraphCatalogLoadResult> {
  return loadCatalogRegistry(project, catalogPaths, graphCatalogAdapter, createEmptyGraphCatalogRegistry);
}
