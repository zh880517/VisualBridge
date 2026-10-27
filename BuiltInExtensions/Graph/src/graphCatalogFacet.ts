/**
 * Graph 模块的 `catalog` facet（附录 D.3）。
 *
 * 宿主只依赖结构：Catalog 扩展名、解析/建注册表、可浏览定义、Document Type 绑定校验。
 * 本文件不 import 任何宿主类型，因此 C1 搬到 `Modules/` 时可以原样登记。
 */
import { compareUtf16CodeUnits } from "@visualbridge/core";
import {
  createEmptyGraphCatalogRegistry,
  type GraphCatalog,
  type GraphCatalogRegistry,
} from "./graphCatalog";
import { GRAPH_EDITOR_ID } from "./graphDocument";
import { graphCatalogAdapter } from "./graphDocumentAdapter";

export const graphCatalogFacet = {
  editor: GRAPH_EDITOR_ID,
  extensions: [".vbgraphcatalog"],
  parse: graphCatalogAdapter.parse,
  build: graphCatalogAdapter.build,
  createRegistry: () => createEmptyGraphCatalogRegistry(),
  definitions: (catalog: unknown) => catalogDefinitions(catalog as GraphCatalog),
  registryDefinitions: (registry: unknown) => registryDefinitions(registry as GraphCatalogRegistry),
};

function catalogDefinitions(catalog: GraphCatalog) {
  return [
    ...catalog.dataTypes.map((entry) => definition("dataType", entry)),
    ...catalog.graphTypes.map((entry) => definition("graphType", entry)),
    ...catalog.nodeTypes.map((entry) => definition("nodeType", entry)),
  ];
}

function registryDefinitions(registry: GraphCatalogRegistry) {
  return [
    ...registry.dataTypes.map((entry) => definition("dataType", entry)),
    ...registry.graphTypes.map((entry) => definition("graphType", entry)),
    ...registry.nodeTypes.map((entry) => definition("nodeType", entry)),
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
