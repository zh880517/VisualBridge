/**
 * 进程内模块 editor facet 登记（B3 的临时形态；C2 接入 ModuleLoader 后整文件删除）。
 *
 * 这是宿主**唯一**知道"有哪些内置领域"的地方：四个领域包各自导出 `catalog` / `create` /
 * `document`（语义与引用）facet，本文件只做 editor → facet 的登记与按 Document Type 装载
 * Catalog。其它宿主文件一律通过 `documentFacetFor` 取 facet，因此不再有
 * `SUPPORTED_*` 列表或 `editor === "graph"` 之类的分支。
 *
 * 领域包与 editor 包在宿主 bundle 内（B1 已登记为 C1/C2 的遗留项），因此这里用静态 import；
 * 真正的"模块未加载不求值"由 C2 的 bundle 装载完成。
 */
import type { DocumentFacet, DocumentTypeDefinition } from "@visualbridge/core";
import {
  entityCatalogFacet,
  entityCreateFacet,
  entityDocumentFacet,
} from "@visualbridge/entity";
import {
  graphCatalogFacet,
  graphCreateFacet,
  graphDocumentFacet,
} from "@visualbridge/graph";
import {
  structuredCatalogFacet,
  structuredCreateFacet,
  structuredDocumentFacet,
} from "@visualbridge/structured";
import {
  tableCatalogFacet,
  tableCreateFacet,
  tableDocumentFacet,
} from "@visualbridge/table";
import type {
  CatalogFacet,
  CatalogRegistryLoadResult,
  CatalogWithSource,
} from "../catalog/catalogRegistryLoader";
import { loadCatalogRegistry } from "../catalog/catalogRegistryLoader";
import type { ModuleCreateFacet } from "../editor/moduleEditorFacets";
import type { ProjectContext } from "../project/projectRegistry";

/** 一个 editor 的宿主侧面：语义/引用 facet + Catalog facet + 创建 facet。 */
export interface HostDocumentFacet {
  readonly moduleId: string;
  readonly facet: DocumentFacet<unknown, unknown>;
  readonly catalog: CatalogFacet<CatalogWithSource, unknown>;
  readonly create?: ModuleCreateFacet;
}

/** 四个内置领域的登记表；顺序只影响 Catalog 视图与创建列表的并列顺序。 */
const ENTRIES: readonly HostDocumentFacet[] = [
  {
    moduleId: "visualbridge.entity",
    facet: entityDocumentFacet,
    catalog: entityCatalogFacet,
    create: entityCreateFacet,
  },
  {
    moduleId: "visualbridge.graph",
    facet: graphDocumentFacet,
    catalog: graphCatalogFacet,
    create: graphCreateFacet,
  },
  {
    moduleId: "visualbridge.structured",
    facet: structuredDocumentFacet,
    catalog: structuredCatalogFacet,
    create: structuredCreateFacet,
  },
  {
    moduleId: "visualbridge.table",
    facet: tableDocumentFacet,
    catalog: tableCatalogFacet,
    create: tableCreateFacet,
  },
];

const BY_EDITOR = new Map(ENTRIES.map((entry) => [entry.facet.editor, entry]));

/**
 * 全部已登记 facet。B3 的临时形态是固定的四个内置登记项；创建命令再用
 * `isEditorAvailable` 过滤掉未加载模块，因此最终列表仍来自 facet。
 */
export function documentFacetEntries(): readonly HostDocumentFacet[] {
  return ENTRIES;
}

/** 按 editor 取 facet；未登记领域返回 `undefined`。 */
export function documentFacetFor(editor: string): HostDocumentFacet | undefined {
  return BY_EDITOR.get(editor);
}

/** 按 editor 取 `catalog` facet；未登记领域返回 `undefined`。 */
export function catalogFacetFor(editor: string): CatalogFacet<CatalogWithSource, unknown> | undefined {
  return BY_EDITOR.get(editor)?.catalog;
}

/** 按 Document Type 装载 Catalog Registry；没有 facet 时返回 `undefined`。 */
export function loadDocumentTypeCatalogRegistry(
  project: ProjectContext,
  documentType: Pick<DocumentTypeDefinition, "editor" | "catalogs">,
): Promise<CatalogRegistryLoadResult<CatalogWithSource, unknown>> | undefined {
  const facet = catalogFacetFor(documentType.editor);
  return facet === undefined ? undefined : loadCatalogRegistry(project, documentType.catalogs, facet);
}
