/**
 * 模块 editor 的宿主语义面契约（附录 D.3 的 `storage` / `semantic` / `referenceData` / `references`）。
 *
 * 宿主只依赖这份结构：文档解析、渲染、语义校验、引用收集、引用数据提取、生命周期目标
 * 全部由模块实现。B3 先以进程内 facet 登记（C1 搬进 `Modules/` 后由 `EditorRegistration`
 * 原样实现同一份结构）。
 *
 * 方法用 method 语法声明：模块用具体 `TDocument`/`TRegistry` 实现后可以直接赋给
 * `DocumentFacet<unknown, unknown>`——这与 `SemanticDocumentAdapter` 处理逆变的手法一致。
 */
import type { JsonValue } from "../Form/field";
import type { ReferenceLocation, ReferenceOccurrence, ReferenceProvider } from "../Reference/reference";
import type { DocumentDiagnostic, DocumentOperationResult } from "./document";
import type { DocumentDescriptor } from "./documentAdapter";
import type {
  DocumentLifecycleDeleteTarget,
  OwnedStableIdentity,
  StableIdentityRemap,
} from "./documentLifecycle";

/** facet 拿到的只读宿主视图；不含文件访问、`vscode` 与写入能力。 */
export interface DocumentFacetContext<TRegistry = unknown> {
  readonly projectId: string;
  readonly documentTypeId: string;
  /** 文档的主源路径（多源文档是首源），相对 Project Root。 */
  readonly path: string;
  /** 该文档的全部物理源；单文本源文档只有一项。 */
  readonly sourcePaths: readonly string[];
  /** Document Type 的 Catalog Registry；该领域不消费 Catalog（或 Registry 无效）时为 undefined。 */
  readonly registry: TRegistry | undefined;
  /** Project File 的已验证数据（纯 JSON）：`tableLayout` 等模块选项由模块自行解析。 */
  readonly projectDefinition: JsonValue;
  /** 本模块在 Project File 中声明的已验证 `options`。 */
  readonly moduleOptions: JsonValue | undefined;
}

/** 多源文档的一份物理源；`path` 相对 Project Root，`bytes` 保留二进制（XLSX）。 */
export interface DocumentFacetSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type DocumentFacetParseResult<TDocument> =
  | {
      readonly success: true;
      readonly document: TDocument;
      readonly diagnostics: readonly DocumentDiagnostic[];
      /** 本模块登记进语义快照的不透明引用数据；缺省表示该文档没有引用数据。 */
      readonly referenceData?: unknown;
      /** 每个物理源承载的逻辑分表 id（多源文档用）。 */
      readonly sheetsBySource?: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] };

export interface DocumentReferenceMutationRequest {
  readonly projectId: string;
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly value: string | number;
}

/** 反向引用视图里一条来源引用的定位与可读标题（由持有该文档的模块解析 occurrencePath）。 */
export interface DocumentFacetIncomingReference {
  /** 来源文档/子文档的可读标题。 */
  readonly title: string;
  readonly nodeTitle?: string;
  readonly fieldPath?: string;
  readonly location: ReferenceLocation;
}

/** 一个 Reference kind 的模块登记（附录 D.3 `references` facet）。 */
export interface DocumentReferenceKindFacet {
  readonly kind: string;
  /**
   * `loadReferenceData` 返回本模块登记进语义快照的不透明引用数据聚合。
   *
   * 模块在这里收窄到自己的类型——这是 facet 边界上唯一的断言点。
   */
  createProvider(loadReferenceData: () => Promise<readonly unknown[]>): ReferenceProvider;
  /** 目标改名后引用的新值；不改变值时返回 undefined（宿主负责改写文档）。 */
  rename?(request: DocumentReferenceMutationRequest): string | number | undefined;
  /** 目标删除后引用的替换值；无法替换时返回 undefined（宿主按悬空引用阻断删除）。 */
  deleteTarget?(request: DocumentReferenceMutationRequest): string | number | undefined;
}

/** 一个 editor 的完整宿主语义面。 */
export interface DocumentFacet<TDocument = unknown, TRegistry = unknown> {
  readonly editor: string;
  /** `text`：单文本源；`sources`：多源（CSV 分表 / XLSX）。 */
  readonly storage: "text" | "sources";
  readonly references: readonly DocumentReferenceKindFacet[];

  /** 单文本源解析（`storage: "text"`）。 */
  parseText?(
    text: string,
    context: DocumentFacetContext<TRegistry>,
  ): DocumentFacetParseResult<TDocument> | Promise<DocumentFacetParseResult<TDocument>>;
  /** 从同目录候选里挑出属于同一逻辑文档的源（`storage: "sources"`）。 */
  planSources?(
    active: DocumentFacetSourceFile,
    candidatePaths: readonly string[],
    context: DocumentFacetContext<TRegistry>,
  ): readonly string[];
  /** 多源解析（`storage: "sources"`）。 */
  parseSources?(
    files: readonly DocumentFacetSourceFile[],
    context: DocumentFacetContext<TRegistry>,
  ): DocumentFacetParseResult<TDocument> | Promise<DocumentFacetParseResult<TDocument>>;
  /** 把文档渲染回各物理源的新字节；未变化的源也必须返回。 */
  renderSources(
    document: TDocument,
    sources: readonly DocumentFacetSourceFile[],
    context: DocumentFacetContext<TRegistry>,
  ): Promise<readonly DocumentFacetSourceFile[]>;

  describe(document: TDocument, context: DocumentFacetContext<TRegistry>): DocumentDescriptor;
  validate(document: TDocument, context: DocumentFacetContext<TRegistry>): readonly DocumentDiagnostic[];
  collectReferences(document: TDocument, context: DocumentFacetContext<TRegistry>): readonly ReferenceOccurrence[];
  applyOperations(
    document: TDocument,
    operations: unknown,
    context: DocumentFacetContext<TRegistry>,
  ): DocumentOperationResult<TDocument>;
  replaceReferenceValues(
    document: TDocument,
    context: DocumentFacetContext<TRegistry>,
    occurrencePaths: ReadonlySet<string>,
    replacement: string | number,
  ): DocumentOperationResult<TDocument>;
  renameDocumentId?(
    document: TDocument,
    documentId: string,
    context: DocumentFacetContext<TRegistry>,
  ): DocumentOperationResult<TDocument>;
  /** 引用目标自身改名（`graph.element` / `entity.component` / `table.row`）。 */
  renameTarget?(
    document: TDocument,
    target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
    previous: string | number,
    replacement: string | number,
    context: DocumentFacetContext<TRegistry>,
  ): DocumentOperationResult<TDocument>;
  /** 把本模块文档里的 occurrencePath 解析成反向引用视图需要的定位信息。 */
  incomingReference?(
    document: TDocument,
    context: DocumentFacetContext<TRegistry>,
    occurrencePath: string,
  ): DocumentFacetIncomingReference | undefined;
  /**
   * Operations 预检：返回非空表示整批拒绝（例如稳定身份改名必须走 Reference Refactor）。
   *
   * 与 B2 会话控制器的 `checkOperations` 同义；宿主在解析文档之后、应用 Operations 之前调用，
   * 因此可以给出指向具体 operation 的诊断而不依赖任何领域类型。
   */
  guardOperations?(
    document: TDocument,
    operations: unknown,
    context: DocumentFacetContext<TRegistry>,
  ): readonly DocumentDiagnostic[];
  /**
   * apply 之后、写盘之前的语义不变量校验（例如删除元素后同文档不得残留指向它的引用）。
   *
   * Reference 校验解析目标时读取写入前的字节，拦不住"同一次 apply 内目标消失"；这类不变量
   * 只能由持有文档语义的模块比较前后文档得出。
   */
  validateTransition?(
    before: TDocument,
    after: TDocument,
    context: DocumentFacetContext<TRegistry>,
  ): readonly DocumentDiagnostic[];

  collectOwnedIdentities(
    document: TDocument,
    context: DocumentFacetContext<TRegistry>,
  ): readonly OwnedStableIdentity[];
  collectAddressableIdentityKeys?(
    document: TDocument,
    context: DocumentFacetContext<TRegistry>,
  ): ReadonlySet<string>;
  remapOwnedIdentities(
    document: TDocument,
    context: DocumentFacetContext<TRegistry>,
    remap: readonly StableIdentityRemap[],
  ): DocumentOperationResult<TDocument>;
  deleteOwnedTarget(
    document: TDocument,
    target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
    context: DocumentFacetContext<TRegistry>,
  ): DocumentOperationResult<TDocument>;
}
