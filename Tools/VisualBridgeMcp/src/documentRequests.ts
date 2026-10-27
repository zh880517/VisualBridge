/**
 * `visualbridge_catalog` / `visualbridge_document` 的宿主侧请求结构。
 *
 * B4 删除了按 editor 分派的 Adapter Registry：请求只携带选择器，路由由
 * `McpDocumentService` + 模块 facet 完成。
 */

export type CatalogAction = "read" | "search";

export interface DocumentCatalogRequest {
  readonly action: CatalogAction;
  readonly projectFile?: string;
  readonly documentTypeId?: string;
  readonly kind?: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly selector: Readonly<Record<string, unknown>>;
}

export type DocumentAction = "read" | "search" | "validate" | "apply";

export interface DocumentRequest {
  readonly action: DocumentAction;
  readonly projectFile?: string;
  readonly documentTypeId?: string;
  readonly path: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly selector: Readonly<Record<string, unknown>>;
  readonly baseHash?: string;
  readonly operations?: unknown;
}
