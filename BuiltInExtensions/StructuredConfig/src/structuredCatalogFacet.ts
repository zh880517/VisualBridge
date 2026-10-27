/**
 * Structured 模块的 `catalog` facet（附录 D.3）。
 *
 * 宿主只依赖结构：Catalog 扩展名、解析/建注册表、可浏览定义、Document Type 绑定校验。
 * 本文件不 import 任何宿主类型，因此 C1 搬到 `Modules/` 时可以原样登记。
 */
import { compareUtf16CodeUnits } from "@visualbridge/core";
import {
  STRUCTURED_EDITOR_ID,
  createEmptyStructuredCatalogRegistry,
  resolveStructuredConfigType,
  type StructuredCatalog,
  type StructuredCatalogRegistry,
} from "./structuredCatalog";
import { structuredCatalogAdapter } from "./structuredDocumentAdapter";

export const structuredCatalogFacet = {
  editor: STRUCTURED_EDITOR_ID,
  extensions: [".vbstructuredcatalog"],
  parse: structuredCatalogAdapter.parse,
  build: structuredCatalogAdapter.build,
  createRegistry: () => createEmptyStructuredCatalogRegistry(),
  definitions: (catalog: unknown) => catalogDefinitions(catalog as StructuredCatalog),
  registryDefinitions: (registry: unknown) => registryDefinitions(registry as StructuredCatalogRegistry),
  bindingIssue: (registry: unknown, documentTypeId: string) => (
    resolveStructuredConfigType(registry as StructuredCatalogRegistry, documentTypeId) === undefined
      ? {
        code: "projectCatalog.structuredTypeMissing",
        message: `Structured Document Type '${documentTypeId}' does not resolve to a Config Type ID or alias in its Catalog Registry.`,
      }
      : undefined
  ),
};

function catalogDefinitions(catalog: StructuredCatalog) {
  return catalog.configTypes.map((entry) => definition("configType", entry));
}

function registryDefinitions(registry: StructuredCatalogRegistry) {
  return registry.configTypes.map((entry) => definition("configType", entry));
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
