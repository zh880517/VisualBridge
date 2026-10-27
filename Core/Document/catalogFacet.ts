/**
 * 模块 editor 的 Catalog 面契约（附录 D.3 的 `catalog`）。
 *
 * Catalog 的文件读取、解析与建注册表原本只在 VS Code 宿主内（B3），B4 让 MCP 也需要同一套
 * "装载 Catalog Registry"能力，因此把**结构**收回 Core；两个宿主各自注入文件 IO 与错误映射。
 */
import type { CatalogSourceDefinition } from "../Catalog/catalogSource";
import type { DocumentDiagnostic, DocumentParseResult } from "./document";

/** 一个可浏览的 Catalog 定义（与领域无关）。 */
export interface CatalogDefinitionEntry {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
}

/** Document Type → Catalog 绑定不可解析（Structured/Table 的 type id/alias 校验）。 */
export interface CatalogBindingIssue {
  readonly code: string;
  readonly message: string;
}

/** 宿主读取 + 解析后的通用 Catalog 视图；`catalogId`/`title` 供引用回指与展示。 */
export interface CatalogWithSource {
  readonly catalogId: string;
  readonly title: string;
  readonly source: CatalogSourceDefinition;
}

/** 一个 editor 的 Catalog facet：宿主只依赖这份结构，不知道任何领域类型。 */
export interface CatalogFacet<TCatalog extends CatalogWithSource = CatalogWithSource, TRegistry = unknown> {
  readonly editor: string;
  /** 该 editor 的 Catalog 文件扩展名（含点）。 */
  readonly extensions: readonly string[];
  parse(text: string, sourcePath: string): DocumentParseResult<TCatalog>;
  build(catalogs: readonly TCatalog[]): DocumentParseResult<TRegistry>;
  createRegistry(): TRegistry;
  definitions(catalog: TCatalog): readonly CatalogDefinitionEntry[];
  registryDefinitions(registry: TRegistry): readonly CatalogDefinitionEntry[];
  bindingIssue?(registry: TRegistry, documentTypeId: string): CatalogBindingIssue | undefined;
}

/** 一次 Catalog Registry 装载的完整结果；`ready=false` 时 `registry` 是空注册表。 */
export interface CatalogRegistryLoadResult<TCatalog, TRegistry> {
  readonly registry: TRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly sources: readonly CatalogSourceInspection<TCatalog>[];
  readonly ready: boolean;
}

export interface CatalogSourceInspection<TCatalog> {
  readonly path: string;
  readonly contentHash?: string;
  readonly catalog?: TCatalog;
  readonly diagnostics: readonly DocumentDiagnostic[];
}
