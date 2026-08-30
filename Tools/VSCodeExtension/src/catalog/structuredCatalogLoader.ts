import {
  createEmptyStructuredCatalogRegistry,
  structuredCatalogAdapter,
  type StructuredCatalog,
  type StructuredCatalogRegistry,
} from "@visualbridge/structured";
import type { ProjectContext } from "../project/projectRegistry";
import { loadCatalogRegistry, type CatalogRegistryLoadResult } from "./catalogRegistryLoader";

export type StructuredCatalogLoadResult = CatalogRegistryLoadResult<StructuredCatalog, StructuredCatalogRegistry>;

export function loadStructuredCatalogRegistry(
  project: ProjectContext,
  catalogPaths: readonly string[],
): Promise<StructuredCatalogLoadResult> {
  return loadCatalogRegistry(project, catalogPaths, structuredCatalogAdapter, createEmptyStructuredCatalogRegistry);
}
