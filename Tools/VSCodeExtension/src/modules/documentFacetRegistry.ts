/**
 * 已装载模块的 editor facet 登记表（C2：内容来自 bundle，宿主不再持有领域清单）。
 *
 * 宿主里所有"按 editor 找语义/Catalog/创建 facet"的代码都走 `documentFacetFor`，因此不存在
 * `SUPPORTED_*` 列表或 `editor === "graph"` 之类的分支。登记项由 `bundleModuleSource` 在
 * 模块装载成功后写入，Project 关闭/重载时按 owner 撤销。
 *
 * 表结构是 `editor → (ownerKey → 条目)`，**最近登记者为当前**：
 * - 同一 editor 可能被多个 Project 声明（本仓库 TestData 里 table 就有三处），facet 内容虽然
 *   等价，但所属 bundle 版本可能不同；重载某个 Project 后必须让"刚登记的那一份"生效，
 *   否则编辑器会话用新 bundle、语义索引/Catalog/创建/引用重构却仍用旧 bundle 的 facet。
 * - 条目带 `ownerKey`/`moduleId`/`hash` 作为可观测来源，测试据此断言"当前项来自新 bundle"。
 * - unregister 只摘掉该 owner 的条目；被摘掉的是当前项时回退到剩余条目里最近登记的那个
 *   （按登记序号），不会变成 `undefined`。
 */
import type { DocumentFacet, DocumentTypeDefinition } from "@visualbridge/core";
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
  /** 该 facet 所属 bundle 的实际 hash；用于区分"同一 editor 的旧/新版本"。 */
  readonly hash?: string;
  readonly facet: DocumentFacet<unknown, unknown>;
  readonly catalog?: CatalogFacet<CatalogWithSource, unknown>;
  readonly create?: ModuleCreateFacet;
}

interface OwnedFacet {
  readonly entry: HostDocumentFacet;
  readonly ownerKey: string;
  /** 全局单调登记序号：越大越"新"，用来确定当前项与回退顺序。 */
  readonly sequence: number;
}

/** editor → (ownerKey → 条目)。 */
const BY_EDITOR = new Map<string, Map<string, OwnedFacet>>();
let nextSequence = 1;

function currentOf(owned: Map<string, OwnedFacet>): OwnedFacet | undefined {
  let current: OwnedFacet | undefined;
  for (const candidate of owned.values()) {
    if (current === undefined || candidate.sequence > current.sequence) current = candidate;
  }
  return current;
}

/**
 * 登记一批 facet（同一 owner 重复调用是幂等的，并以本次登记为最新）。
 *
 * 不保留"先登记者"：重载后的新条目必须成为当前项，否则整张表会停在启动时的旧 bundle 版本。
 */
export function registerDocumentFacets(ownerKey: string, facets: readonly HostDocumentFacet[]): void {
  for (const entry of facets) {
    const editor = entry.facet.editor;
    const owned = BY_EDITOR.get(editor) ?? new Map<string, OwnedFacet>();
    BY_EDITOR.set(editor, owned);
    owned.set(ownerKey, { entry, ownerKey, sequence: nextSequence++ });
  }
}

/** 撤销某个 Project 的登记；其它 Project 仍在用的 editor 保留，并回退到最近登记的剩余项。 */
export function unregisterDocumentFacets(ownerKey: string): void {
  for (const [editor, owned] of [...BY_EDITOR]) {
    owned.delete(ownerKey);
    if (owned.size === 0) BY_EDITOR.delete(editor);
  }
}

/** 全部已登记 facet（每个 editor 一项：当前项）；按 editor 排序，保证创建列表与 Catalog 视图顺序稳定。 */
export function documentFacetEntries(): readonly HostDocumentFacet[] {
  const entries: HostDocumentFacet[] = [];
  for (const owned of BY_EDITOR.values()) {
    const current = currentOf(owned);
    if (current !== undefined) entries.push(current.entry);
  }
  return entries.sort((left, right) => left.facet.editor.localeCompare(right.facet.editor));
}

/** 按 editor 取 facet；未登记领域返回 `undefined`。 */
export function documentFacetFor(editor: string): HostDocumentFacet | undefined {
  const owned = BY_EDITOR.get(editor);
  return owned === undefined ? undefined : currentOf(owned)?.entry;
}

/** 按 editor 取 `catalog` facet；未登记领域返回 `undefined`。 */
export function catalogFacetFor(editor: string): CatalogFacet<CatalogWithSource, unknown> | undefined {
  return documentFacetFor(editor)?.catalog;
}

/** 按 Document Type 装载 Catalog Registry；没有 facet 时返回 `undefined`。 */
export function loadDocumentTypeCatalogRegistry(
  project: ProjectContext,
  documentType: Pick<DocumentTypeDefinition, "editor" | "catalogs">,
): Promise<CatalogRegistryLoadResult<CatalogWithSource, unknown>> | undefined {
  const facet = catalogFacetFor(documentType.editor);
  return facet === undefined ? undefined : loadCatalogRegistry(project, documentType.catalogs, facet);
}

/** 仅测试用：登记表的可观测来源（每个 editor 的当前项与全部条目）。 */
export function documentFacetSourcesForTest(): readonly {
  readonly editor: string;
  readonly current: { readonly ownerKey: string; readonly moduleId: string; readonly hash: string | undefined } | undefined;
  readonly all: readonly {
    readonly ownerKey: string;
    readonly moduleId: string;
    readonly hash: string | undefined;
    readonly current: boolean;
  }[];
}[] {
  return [...BY_EDITOR.entries()]
    .map(([editor, owned]) => {
      const current = currentOf(owned);
      return {
        editor,
        current: current === undefined
          ? undefined
          : { ownerKey: current.ownerKey, moduleId: current.entry.moduleId, hash: current.entry.hash },
        all: [...owned.values()]
          .sort((left, right) => left.sequence - right.sequence)
          .map((item) => ({
            ownerKey: item.ownerKey,
            moduleId: item.entry.moduleId,
            hash: item.entry.hash,
            current: item === current,
          })),
      };
    })
    .sort((left, right) => left.editor.localeCompare(right.editor));
}

/** 仅测试用：清空登记表。 */
export function resetDocumentFacetsForTest(): void {
  BY_EDITOR.clear();
  nextSequence = 1;
}
