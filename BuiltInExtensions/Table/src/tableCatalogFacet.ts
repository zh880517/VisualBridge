/**
 * Table 模块的 `catalog` facet（附录 D.3）。
 *
 * 宿主只依赖结构：Catalog 扩展名、解析/建注册表、可浏览定义、Document Type 绑定校验。
 * 本文件不 import 任何宿主类型，因此 C1 搬到 `Modules/` 时可以原样登记。
 */
import { compareUtf16CodeUnits } from "@visualbridge/core";
import {
  TABLE_EDITOR_ID,
  createEmptyTableCatalogRegistry,
  resolveTableType,
  type TableCatalog,
  type TableCatalogRegistry,
} from "./tableCatalog";
import { tableCatalogAdapter } from "./tableDocumentAdapter";

export const tableCatalogFacet = {
  editor: TABLE_EDITOR_ID,
  extensions: [".vbtablecatalog"],
  parse: tableCatalogAdapter.parse,
  build: tableCatalogAdapter.build,
  createRegistry: () => createEmptyTableCatalogRegistry(),
  definitions: (catalog: unknown) => catalogDefinitions(catalog as TableCatalog),
  registryDefinitions: (registry: unknown) => registryDefinitions(registry as TableCatalogRegistry),
  bindingIssue: (registry: unknown, documentTypeId: string) => (
    resolveTableType(registry as TableCatalogRegistry, documentTypeId) === undefined
      ? {
        code: "projectCatalog.tableTypeMissing",
        message: `Table Document Type '${documentTypeId}' does not resolve to a Table Type ID or alias in its Catalog Registry.`,
      }
      : undefined
  ),
};

function catalogDefinitions(catalog: TableCatalog) {
  return catalog.tableTypes.map((entry) => definition("tableType", entry));
}

function registryDefinitions(registry: TableCatalogRegistry) {
  return registry.tableTypes.map((entry) => definition("tableType", entry));
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
