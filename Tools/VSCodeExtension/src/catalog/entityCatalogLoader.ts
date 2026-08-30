import {
  createEmptyEntityCatalogRegistry,
  entityCatalogAdapter,
  type EntityCatalog,
  type EntityCatalogRegistry,
} from "@visualbridge/entity";
import type { ProjectContext } from "../project/projectRegistry";
import { loadCatalogRegistry, type CatalogRegistryLoadResult } from "./catalogRegistryLoader";

export type EntityCatalogLoadResult = CatalogRegistryLoadResult<EntityCatalog, EntityCatalogRegistry>;

export function loadEntityCatalogRegistry(
  project: ProjectContext,
  catalogPaths: readonly string[],
): Promise<EntityCatalogLoadResult> {
  return loadCatalogRegistry(project, catalogPaths, entityCatalogAdapter, createEmptyEntityCatalogRegistry);
}
