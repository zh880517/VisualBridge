/**
 * 模块 SDK 的公开契约。
 *
 * 该入口只导出类型与 `MODULE_API_VERSION`（以及被 re-export 的 Core/Protocol 类型）；
 * 模块 bundle 由 `./build` 打成单个文件，宿主侧装载由 NodeHost 负责。
 * `apiVersion` 是宿主的门禁；`sdkVersion` 只用于诊断。
 */

import type {
  CatalogAdapter,
  DocumentCodec,
  DocumentDiagnostic,
  DocumentParseResult,
  JsonValue,
  ReferenceCandidate,
  ReferenceLocation,
  ReferenceProvider,
  ReferenceResolveRequest,
  ReferenceSearchRequest,
  SemanticDocumentAdapter,
} from "@visualbridge/core";

// 模块作者直接使用 Core 的公开类型与 Protocol 生成的领域类型，避免复制契约。
export type * from "@visualbridge/core";
export type * from "../../Protocol/Generated/contracts";

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

export interface CreateChoice {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

/** 新建文档的候选与初始内容；Quick Pick 与保存对话框由宿主负责。 */
export interface CreateFacet<TRegistry = unknown> {
  choices(context: EditorContext<TRegistry>): readonly CreateChoice[];
  render(choice: CreateChoice, context: EditorContext<TRegistry>): JsonObject;
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

export interface SessionFacet<TDocument, TRegistry> {
  createController(input: SessionControllerInput<TRegistry>): SessionController<TDocument>;
}

/** MCP 侧的只读查询入口；由宿主转成工具输出。 */
export interface McpFacet<TDocument, TRegistry> {
  queryCatalog(registry: TRegistry | undefined, request: JsonObject): JsonValue;
  queryDocument(action: "read" | "search", document: TDocument, request: JsonObject): JsonValue;
}

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
  readonly storage: TextStorage<TDocument, TRegistry> | SourcesStorage<TDocument, TRegistry>;
  readonly catalog?: {
    readonly extensions: readonly string[];
    readonly adapter: CatalogAdapter<unknown, TRegistry>;
  };
  readonly semantic: SemanticDocumentAdapter<TDocument, EditorContext<TRegistry>>;
  referenceData?(document: TDocument, context: EditorContext<TRegistry>): unknown;
  readonly references?: readonly ReferenceKindRegistration[];
  readonly create?: CreateFacet<TRegistry>;
  readonly session: SessionFacet<TDocument, TRegistry>;
  /** bundle `webviews` 中的 key。 */
  readonly webview: string;
  readonly webviewTitle: string;
  readonly reveal?: {
    readTarget(location: ReferenceLocation): JsonValue | undefined;
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
