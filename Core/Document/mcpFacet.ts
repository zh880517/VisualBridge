/**
 * 模块的 `mcp` facet 契约（附录 D.3 的 `mcp`）。
 *
 * 只承载**领域查询**：宿主负责文件 IO、校验编排、Project Transaction 写入与分页；模块负责
 * "文档/注册表里有哪些可查询的定义与条目、读出来长什么样"。因此这里的入参只有查询条件，
 * 返回值只有宿主可原样序列化的 JSON。
 */
import type { JsonValue } from "../Form/field";
import type { DocumentFacetContext } from "./documentFacet";

/** Catalog 查询条件；`kind` 由 `visualbridge_catalog` 的 `kind` 参数直接透传。 */
export interface McpCatalogQueryRequest {
  readonly action: "read" | "search";
  readonly documentTypeId: string;
  readonly kind: string;
  readonly query: string;
  readonly selector: Readonly<Record<string, JsonValue>>;
}

/** Document 查询条件；`mode` 区分整文档读取与文档内条目搜索。 */
export interface McpDocumentQueryRequest {
  readonly query: string;
  readonly selector: Readonly<Record<string, JsonValue>>;
}

/**
 * 查询结果按宿主可渲染的形态返回：
 * - `read`：并入文档读取响应的字段（`document` / `tableType` / `sheets` / `format`），可附带
 *   需要宿主持久分页的元素列表；
 * - `counts` / `definitions` / `results`：Catalog 汇总、Catalog 定义列表、搜索条目；
 * - `unsupported`：该 kind 不受此领域支持（宿主转成 `catalog.kindUnsupported`）。
 *
 * `fields` 允许任意结果形态附带领域附加字段，宿主只做浅合并，不解释其含义。
 */
export type McpQueryResult =
  | {
      readonly kind: "read";
      readonly fields: Readonly<Record<string, JsonValue>>;
      /** 需要宿主持久分页的文档内列表（例如某个 Table 分表的行）。 */
      readonly page?: {
        readonly fields: Readonly<Record<string, JsonValue>>;
        readonly items: readonly JsonValue[];
      };
    }
  | {
      readonly kind: "counts";
      readonly counts: Readonly<Record<string, number>>;
      readonly fields?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "definitions";
      readonly definitions: readonly JsonValue[];
      readonly fields?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "results";
      readonly results: readonly JsonValue[];
      readonly fields?: Readonly<Record<string, JsonValue>>;
    }
  /** 请求本身不成立（例如 selector 字段类型错误）；宿主按 `code` 抛公开错误。 */
  | { readonly kind: "invalidRequest"; readonly code: string; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string };

/** 一个 editor 的 MCP 查询面。 */
export interface McpFacet<TDocument = unknown, TRegistry = unknown> {
  readonly editor: string;
  queryCatalog(registry: TRegistry, request: McpCatalogQueryRequest): McpQueryResult;
  queryDocument(
    mode: "read" | "search",
    document: TDocument,
    request: McpDocumentQueryRequest,
    context: DocumentFacetContext<TRegistry>,
  ): McpQueryResult;
}
