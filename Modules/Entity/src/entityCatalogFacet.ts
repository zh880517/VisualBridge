/**
 * Entity 模块的 `catalog` facet（附录 D.3）。
 *
 * 宿主只依赖结构：Catalog 扩展名、解析/建注册表、可浏览定义、Document Type 绑定校验。
 * 本文件不 import 任何宿主类型，因此 C1 搬到 `Modules/` 时可以原样登记。
 */
import { compareUtf16CodeUnits } from "@visualbridge/module-sdk";
import {
  ENTITY_EDITOR_ID,
  createEmptyEntityCatalogRegistry,
  type EntityCatalog,
  type EntityCatalogRegistry,
} from "./entityCatalog";
import { entityCatalogAdapter } from "./entityDocumentAdapter";

export const entityCatalogFacet = {
  editor: ENTITY_EDITOR_ID,
  extensions: [".vbentitycatalog"],
  parse: entityCatalogAdapter.parse,
  build: entityCatalogAdapter.build,
  createRegistry: () => createEmptyEntityCatalogRegistry(),
  definitions: (catalog: unknown) => catalogDefinitions(catalog as EntityCatalog),
  registryDefinitions: (registry: unknown) => registryDefinitions(registry as EntityCatalogRegistry),
};

function catalogDefinitions(catalog: EntityCatalog) {
  return [
    ...catalog.componentGroups.map((entry) => definition("componentGroup", entry)),
    ...catalog.entityTypes.map((entry) => definition("entityType", entry)),
    ...catalog.componentTypes.map((entry) => definition("componentType", entry)),
  ];
}

function registryDefinitions(registry: EntityCatalogRegistry) {
  return [
    ...registry.componentGroups.map((entry) => definition("componentGroup", entry)),
    ...registry.entityTypes.map((entry) => definition("entityType", entry)),
    ...registry.componentTypes.map((entry) => definition("componentType", entry)),
  ];
}

function definition(
  kind: string,
  entry: { readonly id: string; readonly title: string; readonly aliases?: readonly string[] },
) {
  return {
    kind,
    id: entry.id,
    title: entry.title,
    aliases: [...entry.aliases ?? []].sort(compareUtf16CodeUnits),
  };
}
