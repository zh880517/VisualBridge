/**
 * B2 会话控制器契约（宿主与模块之间的唯一接口）。
 *
 * 形状对齐附录 D.5 的 `SessionController` / `SessionEffect` / `SessionHost`，并只为 B2 的最小
 * 落地放宽两点：
 * - `state` 允许返回 Promise：Catalog 读取、Reference 校验与 Provider 校验都是异步宿主查询
 *   （B3 接管语义编排、`SessionHost` 收窄为查询面之后再收回同步形态）；
 * - `apply.operations` 在 B2 只承载"整份文档替换"（文本会话替换文本、多源会话替换已解析文档），
 *   C1/B3 接入 `semantic` facet 后改为真正的 Operation 列表。
 *
 * **本文件禁止 import `vscode`**：控制器必须能在假宿主下测试。
 *
 * 这里是**唯一**定义：四个领域包与 VS Code 扩展此前各持一份字节相同的副本，C1 收口到 Core，
 * 各自改为 `export type *` 转出（SDK 侧经 `export type *` 自然流出给模块作者）。
 */
import type { JsonValue } from "../Form/field";
import type { ReferenceDefinition, ReferenceLocation, ReferenceOccurrence } from "../Reference/reference";
import type { DocumentDiagnostic, DocumentParseResult } from "./document";

/** Webview 消息（JSON 对象）；宿主只做透传与修订号盖章，不解释领域字段。 */
export type ModuleSessionMessage = Readonly<Record<string, JsonValue>>;

/** 多源文档的一份源文件；`path` 是相对 Project Root 的 `/` 分隔路径。 */
export interface ModuleSessionSource {
  readonly path: string;
  /** 该源覆盖的逻辑分表 id（Table 分表用；单文件源省略）。 */
  readonly sheetIds?: readonly string[];
  /** 宿主记录的磁盘基线 Hash；写回前用它做冲突检测。 */
  readonly baseHash?: string;
}

/**
 * 会话文档快照。
 *
 * `revision` 由宿主维护：文本会话是 `TextDocument.version`，多源会话是 `CustomDocument.revision`。
 * 控制器只能读它，陈旧编辑的整批拒绝由宿主在 effect 执行前完成。
 */
export interface ModuleSessionDocument {
  readonly projectId: string;
  readonly documentTypeId: string;
  /** 相对 Project Root 的 `/` 分隔路径。 */
  readonly path: string;
  /** 文本会话的当前文本；多源会话为空串。 */
  readonly text: string;
  readonly revision: number;
  readonly isDirty: boolean;
  /** 多源会话：宿主已解析的文档（纯 JSON）。 */
  readonly document?: JsonValue;
  /** 多源会话：上次保存的文档快照（撤销/脏判断用）。 */
  readonly savedDocument?: JsonValue;
  /** 多源会话：当前源文件清单。 */
  readonly sources?: readonly ModuleSessionSource[];
  /** 多源会话：打开时装载的 Catalog 快照（Table 现状是打开时缓存，不随 Catalog 变化重载）。 */
  readonly catalog?: ModuleSessionCatalog;
  /** 模块在当前 Project File 中声明的已验证 `options`。 */
  readonly options?: ModuleSessionMessage;
}

/** Catalog 查询结果；宿主负责读取、解析与缓存。 */
export interface ModuleSessionCatalog {
  readonly ready: boolean;
  readonly registry: unknown;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

/** 状态推送的附加信息（来自 `onDidChangeTextDocument` 事件）。 */
export interface ModuleSessionStateEvent {
  readonly documentChanged?: boolean;
  readonly historyAction?: "undo" | "redo";
}

/** 会话控制器可用的宿主查询面。**只有查询**，改变状态一律返回 effect。 */
export interface ModuleSessionHost {
  /** 按当前 Document Type 的 Catalog 声明重新装载。 */
  loadCatalog(): Promise<ModuleSessionCatalog>;
  /** 校验一组引用的当前解析结果。 */
  validateReferences(references: readonly ReferenceOccurrence[]): Promise<readonly DocumentDiagnostic[]>;
  /** 对比编辑前后的引用，返回新诊断与本次新增的错误。 */
  validateReferenceChange(
    previous: readonly ReferenceOccurrence[],
    next: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly introducedErrors: readonly DocumentDiagnostic[];
  }>;
  /**
   * 走 Project Provider 的 Validator。
   *
   * `source` 是待校验内容的原件（文本会话传新文本，多源会传递增后的 JSON 文本串），
   * 由宿主负责 Hash，模块拿不到文件与 crypto。
   */
  validateProviderDocument(input: {
    readonly documentTypeId: string;
    readonly path: string;
    readonly content: JsonValue;
    readonly source: string | Uint8Array;
  }): Promise<readonly DocumentDiagnostic[]>;
  log(level: "debug" | "info" | "warning" | "error", message: string): void;
}

/** `apply` effect 的载荷：整份文档替换。 */
export type ModuleSessionApplyOperation =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "sources"; readonly document: JsonValue };

/** 控制器返回、由宿主按序执行的效果（附录 D.5）。 */
export type ModuleSessionEffect =
  | {
      readonly kind: "apply";
      readonly operations: ModuleSessionApplyOperation;
      readonly label?: string;
    }
  | { readonly kind: "post"; readonly message: ModuleSessionMessage }
  | { readonly kind: "reveal"; readonly location: ReferenceLocation }
  | { readonly kind: "openDocument"; readonly path: string; readonly documentTypeId?: string }
  | { readonly kind: "clipboard.write"; readonly text: string }
  | {
      readonly kind: "notify";
      readonly severity: "info" | "warning" | "error";
      readonly message: string;
    };

/** 会话控制器；不得 import `vscode`，必须能在假宿主下测试。 */
export interface ModuleSessionController {
  /** 计算出要推给 Webview 的完整状态消息（宿主负责盖章修订号并发布诊断）。 */
  state(
    document: ModuleSessionDocument,
    host: ModuleSessionHost,
  ): JsonValue | Promise<JsonValue>;
  /** 处理一条 Webview 消息；所有改状态的动作都以 effect 返回。 */
  handle(
    message: ModuleSessionMessage,
    document: ModuleSessionDocument,
    host: ModuleSessionHost,
  ): Promise<readonly ModuleSessionEffect[]>;
  /**
   * `applyOperations` 的同步预检：返回非空表示整批拒绝（例如稳定身份改名必须走 Reference Refactor）。
   *
   * 它在宿主做外部修改确认之前执行，保持改造前的拒绝顺序。
   */
  checkOperations?(operations: unknown): string | undefined;
  dispose?(): void;
}

/** 文本会话的 `storage: "text"` facet：编解码只做 parse/render，校验与操作属于控制器。 */
export interface ModuleTextCodec<TDocument = JsonValue> {
  parse(text: string): DocumentParseResult<TDocument>;
  render(document: TDocument): string;
}

/** 多源文档的一份源文件；`path` 相对 Project Root，`bytes` 保留二进制（XLSX）。 */
export interface ModuleSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** `storage: "sources"` 调用时由宿主注入的上下文。 */
export interface ModuleSourcesContext {
  readonly projectId: string;
  readonly documentTypeId: string;
  /** 模块在 Project File 中声明的已验证 `options`。 */
  readonly options: ModuleSessionMessage | undefined;
  readonly catalog: ModuleSessionCatalog;
}

export type ModuleSourcesParseResult =
  | {
      readonly success: true;
      readonly document: JsonValue;
      readonly diagnostics: readonly DocumentDiagnostic[];
      /** 每个源文件承载的逻辑分表 id；宿主登记引用数据与改名定位时要用。 */
      readonly sheetsBySource?: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] };

/**
 * 多源文档的 `storage: "sources"` facet（附录 D.3）。
 *
 * 与 SDK 的文本版 `SourcesStorage` 的差别只有 `bytes`（Table 的 XLSX 是二进制），
 * C1 对齐 SDK 契约时需回填附录 D.3（已登记在 B2 回报 risks）。
 */
export interface ModuleSourcesStorage {
  readonly kind: "sources";
  /**
   * 从同目录候选文件里挑出属于同一逻辑文档的源（Table 分表家族）。
   *
   * 宿主先做与领域无关的过滤（同 Project、同 Document Type、同扩展名），`active` 是当前打开的文件
   * ——Table 用它区分单文件 XLSX 与 CSV 分表家族。
   */
  planSources(
    active: ModuleSourceFile,
    candidatePaths: readonly string[],
    context: ModuleSourcesContext,
  ): readonly string[];
  parse(
    files: readonly ModuleSourceFile[],
    context: ModuleSourcesContext,
  ): Promise<ModuleSourcesParseResult>;
  /** 返回各源的新字节；未变化的源也必须返回（宿主按 `baseHash` 决定哪些真正写盘）。 */
  render(
    document: JsonValue,
    previous: readonly ModuleSourceFile[],
    context: ModuleSourcesContext,
  ): Promise<readonly ModuleSourceFile[]>;
}

/**
 * 已有稳定键改名的分类结果；宿主（多源编辑器）据此调用 Reference Refactor 服务。
 *
 * `definition` 是 Core 的 `ReferenceDefinition`，`location` 指向承载该键的源文件与行。
 */
export type ModuleSourcesKeyRenamePlan =
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly message: string }
  | {
      readonly kind: "rename";
      readonly definition: ReferenceDefinition;
      readonly location: ReferenceLocation;
      readonly oldValue: string | number;
      readonly newValue: string | number;
    };

/** 多源会话控制器额外暴露"已有稳定键改名"的分类（宿主据此调用 Reference Refactor 服务）。 */
export interface ModuleSourcesSessionController extends ModuleSessionController {
  planKeyRename(
    document: ModuleSessionDocument,
    operations: unknown,
  ): ModuleSourcesKeyRenamePlan;
}

/**
 * 会话工厂：宿主在**打开文档时**调用它，得到本次会话的控制器。
 *
 * 注册面只能带工厂而不能带实例——`activate` 发生在任何文档打开之前。`document` 的句柄类型由
 * 各域自行决定（`ModuleSessionDocument` 只是 B2 的最小形态）；宿主不解释它，原样传回。
 */
export interface ModuleSessionFactory<TDocument = unknown> {
  createController(document: TDocument): ModuleSessionController;
}
