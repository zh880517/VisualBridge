/**
 * 模块 SDK 的公开契约。
 *
 * 该入口只导出类型与 `MODULE_API_VERSION`（以及被 re-export 的 Core/Protocol 类型）；
 * 模块 bundle 由 `./build` 打成单个文件，宿主侧装载由 NodeHost 负责。
 * `apiVersion` 是宿主的门禁；`sdkVersion` 只用于诊断。
 */

import type {
  CatalogFacet,
  CatalogWithSource,
  CreateFacet,
  CreateFacetInput,
  DocumentCodec,
  DocumentDiagnostic,
  DocumentFacet,
  DocumentParseResult,
  JsonValue,
  McpFacet,
  ModuleSessionFactory,
  ReferenceCandidate,
  ReferenceLocation,
  ReferenceProvider,
  ReferenceResolveRequest,
  ReferenceSearchRequest,
} from "@visualbridge/core";

// 模块作者直接使用 Core 的公开类型与 Protocol 生成的领域类型，避免复制契约。
export type * from "@visualbridge/core";
export type * from "../../Protocol/Generated/contracts";

/**
 * 模块运行时面（附录 D.3）：SDK 是模块**唯一**的类型与运行时来源。
 *
 * 领域模块的语义实现需要这批 Core 纯函数（确定性排序、JSON 规范化、Catalog 定义解析、
 * 字段默认值与校验、引用值比较、引用查询与工程解析）。它们是模块自包含打包的必要条件——
 * 模块源码只 import `@visualbridge/module-sdk`，esbuild 把它们一起打进 `.vbmodule.js`；
 * `scripts/assemble.mjs` 负责把 Core 的 dist JS 装进本包并把 `@visualbridge/core` 改写成包内
 * 相对路径，因此消费方无需安装任何其它 workspace 包。
 *
 * `ReferenceService` / `parseProjectFile` / `findMatchingDocumentTypes` 供模块测试搭夹具用
 * （模块测试同样只允许依赖 SDK tgz）。
 *
 * 该清单只做**增量**扩展：新增导出不改变 `MODULE_API_VERSION`，删除或改签名才需要动它。
 */
export {
  canonicalJsonStringify,
  cloneJsonValue,
  collectFieldReferences,
  collectFieldValueReferences,
  compareUtf16CodeUnits,
  createDefaultProperties,
  createUnknownCatalogSource,
  DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
  findMatchingDocumentTypes,
  isJsonValue,
  normalizeJsonValue,
  normalizeReferenceQuery,
  paginateReferenceCandidates,
  parseCatalogSourceDefinition,
  parseFieldDefinitions,
  parseFieldValueDefinition,
  parseProjectFile,
  ReferenceService,
  referenceValuesEqual,
  replaceFieldReferenceValues,
  replaceFieldValueReferences,
  resolveFieldDefinition,
  serializeCatalogSourceDefinition,
  serializeFieldDefinition,
  serializeFieldValueDefinition,
  validateFieldProperties,
  validateFieldValue,
} from "@visualbridge/core";

/** 模块与宿主之间的契约版本；宿主只接受 `manifest.apiVersion` 等于该值的 bundle。 */
export const MODULE_API_VERSION = 1;

/** JSON 对象；与 Core 的 `ProjectModuleOptions` 形状一致。 */
export type JsonObject = Readonly<Record<string, JsonValue>>;

export type ModuleLogLevel = "debug" | "info" | "warning" | "error";

/** 模块日志出口；宿主负责落盘、过滤与展示。 */
export type ModuleLogFunction = (
  level: ModuleLogLevel,
  message: string,
  details?: JsonValue,
) => void;

export interface ModuleManifest {
  /** 必须与 Project File 中 `modules[].id` 相同。 */
  readonly id: string;
  /** 模块自身版本；只用于展示。 */
  readonly version: string;
  /** 整数，且必须等于 `MODULE_API_VERSION`。 */
  readonly apiVersion: number;
  /** 模块编译时使用的 SDK 版本；只诊断、不门禁。 */
  readonly sdkVersion?: string;
  /** 模块提供的 editor id；必须唯一。 */
  readonly editors: readonly string[];
}

export interface ModuleWebview {
  /** Webview 的 IIFE 脚本文本。 */
  readonly script: string;
  /** Webview 的 CSS 文本；无样式时为空字符串。 */
  readonly style: string;
}

/** 模块 bundle 的运行时形状；`buildModule` 保证导出这三个成员。 */
export interface ModuleBundle {
  readonly manifest: ModuleManifest;
  activate(host: ModuleHost): ModuleRegistration | Promise<ModuleRegistration>;
  readonly webviews: Readonly<Record<string, ModuleWebview>>;
}

/** Project File 中与本模块相关的只读视图；不含文件访问能力。 */
export interface ModuleProjectView {
  readonly projectId: string;
  readonly moduleId: string;
  readonly documentTypes: readonly ModuleProjectDocumentType[];
  /** 模块 `options` 的经验证结果；未声明时为 undefined。 */
  readonly options: JsonObject | undefined;
}

export interface ModuleProjectDocumentType {
  readonly id: string;
  readonly editor: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly catalogs: readonly string[];
}

/** HostApi 的 Catalog 查询入口；宿主负责读取、构建与缓存。 */
export interface ModuleCatalogHost {
  get<TRegistry = unknown>(documentTypeId: string): TRegistry | undefined;
}

/** HostApi 的 Reference 查询入口；写回一律经宿主的事务/编辑流程。 */
export interface ModuleReferenceHost {
  search(request: ReferenceSearchRequest): Promise<readonly ReferenceCandidate[]>;
  resolve(request: ReferenceResolveRequest): Promise<readonly ReferenceCandidate[]>;
}

/** 调试展示宿主；只有模块声明了 `debug.categories` 时宿主才应提供。 */
export interface ModuleDebugHost {
  subscribe(category: string, listener: (record: DebugRecord) => void): () => void;
}

/**
 * `activate` 收到的宿主能力。
 *
 * 不提供文件访问、`vscode` 或写入接口；模块与宿主同权限、同进程。
 */
export interface ModuleHost {
  readonly log: ModuleLogFunction;
  readonly project: ModuleProjectView;
  readonly catalogs: ModuleCatalogHost;
  readonly references: ModuleReferenceHost;
  readonly debug?: ModuleDebugHost;
}

/** facet 调用时由宿主注入的上下文。 */
export interface EditorContext<TRegistry = unknown> {
  readonly project: ModuleProjectView;
  readonly documentType: ModuleProjectDocumentType;
  readonly registry: TRegistry | undefined;
  readonly catalogs: ModuleCatalogHost;
  readonly log: ModuleLogFunction;
}

/** 单文本源文档的编解码器。 */
export interface TextStorage<TDocument, TRegistry> {
  readonly kind?: "text";
  readonly codec: DocumentCodec<TDocument, string, EditorContext<TRegistry>>;
}

/** Sources 文档的一份源文本。 */
export interface ModuleSourceText {
  readonly path: string;
  readonly text: string;
}

/** 多源文档的规划、解析与渲染器；`render` 返回各源的新文本。 */
export interface SourcesStorage<TDocument, TRegistry> {
  readonly kind?: "sources";
  planSources(paths: readonly string[]): readonly string[];
  parse(
    sources: readonly ModuleSourceText[],
    context: EditorContext<TRegistry>,
  ): DocumentParseResult<TDocument> | Promise<DocumentParseResult<TDocument>>;
  render(
    document: TDocument,
    previous: readonly ModuleSourceText[],
    context: EditorContext<TRegistry>,
  ): readonly ModuleSourceText[] | Promise<readonly ModuleSourceText[]>;
}

export interface ReferenceKindMutationRequest {
  readonly project: ModuleProjectView;
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly value: string | number;
}

/**
 * 一个 Reference kind 的提供者。
 *
 * `rename` / `deleteTarget` 只返回替换后的引用值；实际的文档改写与 WorkspaceEdit
 * 由宿主编排。
 */
export interface ReferenceKindRegistration {
  readonly kind: string;
  createProvider(view: ModuleProjectView): ReferenceProvider;
  rename?(request: ReferenceKindMutationRequest): string | number | undefined;
  deleteTarget?(request: ReferenceKindMutationRequest): string | number | undefined;
}

export interface SessionControllerInput<TRegistry = unknown> {
  readonly project: ModuleProjectView;
  readonly documentType: ModuleProjectDocumentType;
  readonly registry: TRegistry | undefined;
  readonly host: SessionHost;
}

/** 会话控制器可用的查询能力；改变状态的动作用 `SessionEffect` 返回。 */
export interface SessionHost {
  readonly catalogs: ModuleCatalogHost;
  readonly references: ModuleReferenceHost;
  readonly log: ModuleLogFunction;
}

/** 会话文档快照；`revision` 由宿主维护，用于陈旧编辑整批拒绝。 */
export interface SessionDocument<TDocument> {
  readonly path: string;
  readonly documentTypeId: string;
  readonly document: TDocument;
  readonly revision: number;
}

/** Webview 会话控制器；不得 import `vscode`，必须能在假宿主下测试。 */
export interface SessionController<TDocument> {
  state(document: SessionDocument<TDocument>): JsonValue;
  handle(
    message: JsonObject,
    document: SessionDocument<TDocument>,
    host: SessionHost,
  ): Promise<readonly SessionEffect[]>;
  dispose?(): void;
}

export type SessionEffect =
  | { readonly kind: "apply"; readonly operations: unknown; readonly label?: string }
  | { readonly kind: "post"; readonly message: JsonValue }
  | { readonly kind: "reveal"; readonly location: ReferenceLocation }
  | { readonly kind: "openDocument"; readonly path: string; readonly documentTypeId?: string }
  | { readonly kind: "clipboard.write"; readonly text: string }
  | {
      readonly kind: "notify";
      readonly severity: "info" | "warning" | "error";
      readonly message: string;
    };

/** 调试记录；模块只消费已解码记录，拿不到原始字节。 */
export interface DebugRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly category: string;
  readonly frame: number;
  readonly method: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly wireBytes: number;
  readonly at: number;
}

export type DebugRenderUpdate = JsonObject;

/** 分类展示 facet；同一分类被多个模块认领时由宿主按 Project 顺序保留第一个。 */
export interface DebugFacet {
  readonly categories: readonly string[];
  onRecord(record: DebugRecord, context: EditorContext<unknown>): DebugRenderUpdate | undefined;
  readonly windowTitle?: string;
}

/**
 * 一个 editor 的完整注册面。
 *
 * 方法签名使用 method 语法，便于模块用具体 `TDocument`/`TRegistry` 实现后赋给
 * `EditorRegistration<unknown, unknown>`。
 */
export interface EditorRegistration<TDocument = unknown, TRegistry = unknown> {
  readonly editor: string;
  /**
   * 宿主语义面：**直接使用 Core 的 `DocumentFacet`**（B2/B3/B4 的实际契约）。
   *
   * SDK 不再自带一份"语义适配器"声明：Core 的同名 facet 经 `export type *` 自然流出，
   * 模块作者与宿主因此对着同一个类型检查（`typecheck/contractsParity.ts` 把这条钉死）。
   * `storage`（`"text"` / `"sources"`）已由 `DocumentFacet` 自带，故不再单独声明。
   */
  readonly semantic: DocumentFacet<TDocument, TRegistry>;
  /** Catalog 面：**直接使用 Core 的 `CatalogFacet`**（B3/B4 的实际契约）。 */
  readonly catalog?: CatalogFacet<CatalogWithSource, TRegistry>;
  referenceData?(document: TDocument, context: EditorContext<TRegistry>): unknown;
  readonly references?: readonly ReferenceKindRegistration[];
  /** 创建面：**直接使用 Core 的 CreateFacet**（四域真实形状，prepare + createDocument）。 */
  readonly create?: CreateFacet<CreateFacetInput>;
  /**
   * 会话面：**工厂**。
   *
   * `activate` 发生在任何文档打开之前，因此注册面只能登记"打开文档时怎么造控制器"；
   * 控制器类型来自 Core（`ModuleSessionFactory` / `ModuleSessionController`）。
   */
  readonly session: ModuleSessionFactory;
  /** bundle `webviews` 中的 key。 */
  readonly webview: string;
  readonly webviewTitle: string;
  /**
   * 定位面（附录 D.3）：把引用位置翻译成 Webview 认识的定位消息，并负责"已就绪才投递"。
   *
   * 为什么需要消息类型：Webview 脚本是模块自己打的，它只监听自己那两个字面量
   * （例如 `revealEntityComponent` / `entityRevealResult`）。宿主零领域知识，只能由模块把
   * 两个类型名一起登记，否则宿主发什么 Webview 都不认。`readTarget` 只做"位置 → 目标"的
   * 纯翻译，真正的"目标是否存在"校验留在模块 Webview 里（C2 之前就是这样分工的）。
   */
  readonly reveal?: {
    /** Webview 监听的定位请求消息类型。 */
    readonly messageType: string;
    /** Webview 回传结果的类型。 */
    readonly resultMessageType: string;
    /** 位置不合法时返回 undefined（宿主据此报只读提示）。 */
    readTarget(location: ReferenceLocation): JsonValue | undefined;
    createMailbox(): RevealMailbox;
  };
  readonly mcp?: McpFacet<TDocument, TRegistry>;
  /** 该 editor 的 Operation JSON Schema；由 `visualbridge_project` 返回。 */
  readonly operationSchema?: JsonObject;
  readonly debug?: DebugFacet;
}

export interface ModuleRegistration {
  /**
   * 模块作者通常用具体的 `TDocument`/`TRegistry` 实现 facet；容器必须接受不同实参，
   * 因此这里不再用 `unknown` 制造逆变冲突。
   */
  readonly editors: readonly EditorRegistration<any, any>[];
  validateOptions?(options: JsonObject | undefined): readonly DocumentDiagnostic[];
  dispose?(): void;
}

/**
 * 定位消息信箱（附录 D.3 `reveal.createMailbox`）。
 *
 * 宿主在 Webview 就绪前后都可能拿到定位请求，信箱的职责就是"先攒着、就绪再投递"：
 * - `enqueue` 只记录待投递目标（返回什么宿主不解释）；
 * - `markReady` / `markUnavailable` 由宿主在握手/隐藏时调用；
 * - `deliverable` 是**当前可投递**的请求（未就绪时必须是 undefined）；
 * - `acknowledge(requestId)` 在收到 Webview 结果后确认，返回 false 表示不是它发的那一条。
 *
 * `isReady` / `pendingTarget` / `cancel` 是 Table（多面板）用到的可选成员；其它域不实现。
 * 参数用 `unknown` 是刻意的：目标类型是各域自己的 interface，`JsonValue` 的索引签名会拒绝它们。
 */
export interface RevealMailbox {
  enqueue(target: unknown): unknown;
  markReady(): void;
  markUnavailable(): void;
  readonly deliverable: unknown;
  acknowledge(requestId: string): boolean;
  readonly isReady?: boolean;
  readonly pendingTarget?: unknown;
  cancel?(): void;
}
