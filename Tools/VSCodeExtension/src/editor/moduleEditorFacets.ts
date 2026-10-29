/**
 * 模块 editor 面（C2：完全由 ModuleLoader 的注册面装配）。
 *
 * 本文件只认 SDK 的 `EditorRegistration`：`semantic` / `catalog` / `create` / `session` /
 * `reveal` / `references` 与 bundle 里的 `webviews` 文本。**不 import 任何领域包**，
 * 因此宿主 bundle 里不再有 Entity/Graph/Structured/Table 的代码（附录 D.6）。
 *
 * Webview 资产：bundle 里的脚本文本/样式文本由 `bundleModuleSource` 解包到
 * `<globalStorage>/modules/<sha256>/`，这里只拿解包后的绝对 URI。
 */
import * as vscode from "vscode";
import * as nodePath from "node:path";
import type {
  DocumentFacet,
  DocumentFacetContext,
  DocumentFacetParseResult,
  DocumentFacetSourceFile,
  JsonValue,
  OwnedStableIdentity,
  ReferenceLocation,
} from "@visualbridge/core";
import type { CatalogFacet, CatalogWithSource } from "../catalog/catalogRegistryLoader";
import type { EditorRegistration, RevealMailbox } from "@visualbridge/module-sdk";
import { loadDocumentTypeCatalogRegistry } from "../modules/documentFacetRegistry";
import type { DocumentMatch, ProjectContext } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import type {
  ModuleSessionCatalog,
  ModuleSessionController,
  ModuleSourcesContext,
  ModuleSourcesKeyRenamePlan,
  ModuleSourcesParseResult,
  ModuleSourcesStorage,
} from "../document/moduleSessionContract";
import type { HostModuleBundle } from "../modules/moduleRegistration";
import { GraphExecutionDebugController, isGraphDebugMessage } from "./graphExecutionDebugController";
import { createModuleWebviewHtml } from "./moduleWebviewHtml";

/** 定位 mailbox 的宿主侧视图：直接复用 SDK 的 `RevealMailbox`（不再自抄一份接口）。 */
export type ModuleRevealMailbox = RevealMailbox;

export interface ModuleRevealFacet extends NonNullable<EditorRegistration["reveal"]> {
  /** 位置形状不合法时的可读错误。 */
  readonly invalidLocationMessage: string;
}

/**
 * 用登记的消息类型盖章投递对象。
 *
 * `reveal.messageType` 是模块登记的、Webview 真正监听的类型名（附录 D.3）：宿主按登记值盖章，
 * 模块 mailbox 自造不同类型的消息不会悄悄生效，也避免"登记了却没用"的死字段。
 */
export function stampRevealMessage(facet: ModuleRevealFacet | undefined, deliverable: unknown): unknown {
  if (facet === undefined || deliverable === null || typeof deliverable !== "object" || Array.isArray(deliverable)) {
    return deliverable;
  }
  return { ...(deliverable as Readonly<Record<string, unknown>>), type: facet.messageType };
}

export interface ModuleWebviewMetadata {
  readonly projectId: string;
  readonly documentType: string;
  readonly relativePath: string;
}

export interface ModuleWebviewFacet {
  /** 解包后的脚本与样式文件（`<globalStorage>/modules/<sha256>/`）。 */
  readonly script: vscode.Uri;
  readonly style: vscode.Uri;
  /** 解包目录：`webview.localResourceRoots` 必须包含它。 */
  readonly resourceRoot: vscode.Uri;
  createHtml(input: {
    readonly cspSource: string;
    readonly nonce: string;
    readonly scriptUri: string;
    readonly styleUri: string;
    readonly metadata: ModuleWebviewMetadata;
  }): string;
}

/** 宿主先处理的调试窗口消息（不转发给控制器）。 */
export interface ModuleHostMessageContext {
  readonly match: DocumentMatch;
  postMessage(message: unknown): Promise<boolean>;
  getText(): string;
  log(line: string): void;
}

export interface ModuleHostMessageHandler {
  /** 返回 true 表示已消费；未消费的消息继续走控制器。 */
  handle(message: Readonly<Record<string, unknown>>): Promise<boolean>;
  readonly testState?: unknown;
  dispose?(): void;
}

/** 多源文档登记/注销引用数据用（`WorkspaceReferenceService.updateModuleDocument`）。 */
export interface ModuleSourcesPublishInput {
  readonly ownerId: string;
  readonly project: ProjectContext;
  readonly documentTypeId: string;
  readonly document: JsonValue;
  readonly savedDocument: JsonValue;
  readonly sources: readonly { readonly uri: vscode.Uri; readonly sheetIds: readonly string[] }[];
  readonly catalog: ModuleSessionCatalog;
}

export interface ModuleSourcesFacet {
  readonly storage: ModuleSourcesStorage;
  publishDocument?(input: ModuleSourcesPublishInput): void;
  removeDocument?(ownerId: string): void;
}

/**
 * `create` facet 的输入（附录 D.3）：宿主已解析 Project / Document Type / Catalog。
 *
 * 模块拿不到文件系统与 `vscode`：保存对话框、Quick Pick、生命周期 preview/apply 都由宿主负责。
 */
export interface ModuleCreateInput {
  readonly projectId: string;
  /** Project File 的已验证数据（纯 JSON；Table 需要 `tableLayout`）。 */
  readonly projectDefinition: JsonValue;
  readonly documentType: {
    readonly id: string;
    readonly editor: string;
    readonly catalogs: readonly string[];
    readonly include: readonly string[];
  };
  readonly catalog: {
    readonly ready: boolean;
    readonly registry: unknown;
    readonly diagnostics: readonly import("@visualbridge/core").DocumentDiagnostic[];
  };
  /** 稳定 ID 生成器：模块的 create facet 不能自己引入 `node:crypto`。 */
  readonly newStableId: (prefix: string) => string;
}

/** 一条创建选项（宿主渲染为 Quick Pick 项）。 */
export interface ModuleCreateOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

/** 一次创建选择（宿主按序提问；只有一项时直接采用）。 */
export interface ModuleCreateQuestion {
  readonly id: string;
  readonly title: string;
  readonly placeholder?: string;
  readonly options: readonly ModuleCreateOption[];
}

export type ModuleCreatePreparation =
  | { readonly kind: "unavailable"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly questions: readonly ModuleCreateQuestion[];
      /** 保存对话框的兜底扩展名（不含点）。 */
      readonly fallbackExtension: string;
      defaultFileName(answers: Readonly<Record<string, string>>): string;
      /** Lifecycle create 的 parameters；`target.name` 是不含扩展名的文件名。 */
      parameters(
        answers: Readonly<Record<string, string>>,
        target: { readonly path: string; readonly name: string },
      ): Readonly<Record<string, JsonValue>>;
    };

export type ModuleCreateDocumentResult =
  | {
      readonly success: true;
      readonly sources: readonly { readonly path: string; readonly bytes: Uint8Array }[];
      readonly ownedIdentities: readonly OwnedStableIdentity[];
    }
  | { readonly success: false; readonly message: string };

/**
 * 模块的 `create` facet（附录 D.3）。
 *
 * `prepare` 只产出"问什么、默认文件名、参数"；`createDocument` 只用参数构造新文档字节，
 * 宿主因此没有按 editor 分支的创建逻辑与类型清单。
 */
export interface ModuleCreateFacet {
  prepare(input: ModuleCreateInput): ModuleCreatePreparation;
  createDocument(
    input: ModuleCreateInput & {
      readonly parameters: Readonly<Record<string, JsonValue>>;
      readonly targetPath: string;
    },
  ): Promise<ModuleCreateDocumentResult>;
}

/** 一个模块为单个 editor 提供的全部宿主侧面。 */
export interface ModuleEditorFacets {
  readonly moduleId: string;
  readonly editor: string;
  readonly storage: "text" | "sources";
  readonly webview: ModuleWebviewFacet;
  readonly reveal?: ModuleRevealFacet;
  readonly sources?: ModuleSourcesFacet;
  loadCatalog(match: DocumentMatch): Promise<ModuleSessionCatalog>;
  createController(): ModuleSessionController;
  /**
   * 从文档文本解析语义 `documentId`（G1d 的 facet 文档作用域）。
   *
   * 与旧 `graphExecution` 路径的 `getDocumentId()` 同源（模块 `parseText` → `document.documentId`），
   * 因此"产生实例的文档"与"显示增量的 Webview"用的是同一个标识。解析失败/异步结果返回
   * `undefined`（宿主按"身份未知"降级为 editor 面投递）。
   */
  readDocumentId(text: string, match: DocumentMatch): string | undefined;
  createHostMessageHandler?(context: ModuleHostMessageContext): ModuleHostMessageHandler | undefined;
}

export interface ModuleEditorFacetServices {
  readonly references: WorkspaceReferenceService;
  /** 宿主 OutputChannel；模块面里的非致命失败必须留下痕迹，不能静默丢弃。 */
  readonly log: (line: string) => void;
}

/**
 * 按 (Project, moduleId, editor) 取 editor 面。
 *
 * 不做缓存：装配是纯闭包构造（无 IO），模块重载后必须立即看到新注册面。
 * 未装载的 moduleId 返回 `undefined`（调用方回退只读 Shell）。
 */
export async function loadModuleEditorFacets(
  project: ProjectContext,
  moduleId: string,
  editor: string,
  bundle: HostModuleBundle | undefined,
  services: ModuleEditorFacetServices,
): Promise<ModuleEditorFacets | undefined> {
  if (bundle === undefined) return undefined;
  const editorRegistration = bundle.registration.editors.find((candidate) => candidate.editor === editor);
  const webviewKey = editorRegistration?.webview;
  const assets = webviewKey === undefined ? undefined : bundle.webviews[webviewKey];
  if (editorRegistration === undefined || assets === undefined) return undefined;
  return createFacets(project, moduleId, editorRegistration, assets, services);
}

function createFacets(
  project: ProjectContext,
  moduleId: string,
  editorRegistration: HostModuleBundle["registration"]["editors"][number],
  assets: HostModuleBundle["webviews"][string],
  services: ModuleEditorFacetServices,
): ModuleEditorFacets {
  const facet = editorRegistration.semantic as DocumentFacet<unknown, unknown>;
  const editor = editorRegistration.editor;
  const webviewTitle = editorRegistration.webviewTitle;
  const base = {
    moduleId,
    editor,
    storage: facet.storage,
    webview: {
      script: assets.script,
      style: assets.style,
      resourceRoot: assets.resourceRoot,
      createHtml: (input: {
        readonly cspSource: string;
        readonly nonce: string;
        readonly scriptUri: string;
        readonly styleUri: string;
        readonly metadata: ModuleWebviewMetadata;
      }) => createModuleWebviewHtml({
        title: webviewTitle,
        cspSource: input.cspSource,
        nonce: input.nonce,
        scriptUri: input.scriptUri,
        styleUri: input.styleUri,
        metadata: input.metadata,
      }),
    },
    loadCatalog: (match: DocumentMatch) => loadCatalogForMatch(match),
    createController: (): ModuleSessionController => (
      editorRegistration.session.createController(undefined)
    ),
    // 文档作用域（G1d）：宿主按需解析当前文本的 `documentId`，不引入第二套"文档身份"判定。
    readDocumentId: (text, match) => documentIdOf(facet, match.project, match, text),
  } satisfies Omit<ModuleEditorFacets, "reveal" | "sources" | "createHostMessageHandler">;

  const reveal = editorRegistration.reveal;
  const sources = facet.storage === "sources" ? createSourcesFacet(facet, moduleId, project, services) : undefined;
  return {
    ...base,
    ...(reveal === undefined ? {} : {
      reveal: {
        messageType: reveal.messageType,
        resultMessageType: reveal.resultMessageType,
        createMailbox: () => reveal.createMailbox(),
        readTarget: (location: ReferenceLocation) => reveal.readTarget(location),
        invalidLocationMessage: `Invalid reference location for editor '${editor}'.`,
      } satisfies ModuleRevealFacet,
    }),
    ...(sources === undefined ? {} : { sources }),
    createHostMessageHandler: (context) => createRuntimeDebugHandler(facet, context),
  };
}

/** 会话侧 Catalog 装载：只按 Document Type 的 editor 取模块 `catalog` facet。 */
async function loadCatalogForMatch(match: DocumentMatch): Promise<ModuleSessionCatalog> {
  const loading = loadDocumentTypeCatalogRegistry(match.project, match.documentType);
  if (loading === undefined) {
    return {
      ready: false,
      registry: undefined,
      diagnostics: [{
        severity: "error",
        code: "module.catalogFacetMissing",
        path: "catalogs",
        message: `No module catalog facet is registered for editor '${match.documentType.editor}'.`,
      }],
    };
  }
  const result = await loading;
  return { ready: result.ready, registry: result.registry, diagnostics: result.diagnostics };
}

/**
 * 多源文档的宿主侧面。
 *
 * `storage` 直接由 `semantic` 的三个方法拼出来（`planSources` / `parseSources` / `renderSources`），
 * 因此宿主不需要知道 CSV/XLSX 的差别。
 *
 * `publishDocument` 需要"当前内存文档"的引用数据，而 facet 只在解析结果里给出 `referenceData`。
 * 这里用 `renderSources` + `parseSources` 组合出当前状态并取 `referenceData`；代价是每次改动
 * 一次序列化 + 解析，因此按 `ownerId` 合并（250ms 防抖），且只保留最后一次。
 */
function createSourcesFacet(
  facet: DocumentFacet<unknown, unknown>,
  moduleId: string,
  project: ProjectContext,
  services: ModuleEditorFacetServices,
): ModuleSourcesFacet | undefined {
  if (facet.planSources === undefined || facet.parseSources === undefined || facet.renderSources === undefined) {
    return undefined;
  }
  const planSources = facet.planSources.bind(facet);
  const parseSources = facet.parseSources.bind(facet);
  const renderSources = facet.renderSources.bind(facet);
  const pending = new Map<string, NodeJS.Timeout>();
  const moduleOptions = project.definition.modules.find((module) => module.id === moduleId)?.options;

  /**
   * 会话契约（`ModuleSourcesContext`）只带 project/documentType/options/catalog；
   * facet 契约还要 `path` / `sourcePaths` / `projectDefinition`。路径从本次调用的文件列表推出，
   * Project File 与模块 options 由宿主补齐（否则 Table 的 `tableLayout` 会丢）。
   */
  const facetContext = (
    context: ModuleSourcesContext,
    paths: readonly string[],
  ): DocumentFacetContext => ({
    projectId: context.projectId,
    documentTypeId: context.documentTypeId,
    path: paths[0] ?? "",
    sourcePaths: paths,
    registry: context.catalog.ready ? context.catalog.registry : undefined,
    projectDefinition: project.definition as unknown as JsonValue,
    moduleOptions: context.options ?? moduleOptions,
  });

  const storage: ModuleSourcesStorage = {
    kind: "sources",
    planSources: (active, candidatePaths, context) => planSources(
      active,
      candidatePaths,
      facetContext(context, [active.path, ...candidatePaths]),
    ),
    parse: async (files, context) => {
      const parsed = await parseSources(files, facetContext(context, files.map((file) => file.path)));
      return parsed.success
        ? {
          success: true,
          document: parsed.document as JsonValue,
          diagnostics: parsed.diagnostics,
          ...(parsed.sheetsBySource === undefined ? {} : { sheetsBySource: parsed.sheetsBySource }),
        }
        : { success: false, diagnostics: parsed.diagnostics };
    },
    render: (document, previous, context) => renderSources(
      document,
      previous,
      facetContext(context, previous.map((file) => file.path)),
    ),
  };

  return {
    storage,
    publishDocument: (input) => {
      const previous = pending.get(input.ownerId);
      if (previous !== undefined) clearTimeout(previous);
      pending.set(input.ownerId, setTimeout(() => {
        pending.delete(input.ownerId);
        void publishSourcesReferenceData(facet, moduleId, project, services, input);
      }, 250));
    },
    removeDocument: (ownerId) => {
      const previous = pending.get(ownerId);
      if (previous !== undefined) {
        clearTimeout(previous);
        pending.delete(ownerId);
      }
      services.references.removeModuleDocument(ownerId);
    },
  };
}

async function publishSourcesReferenceData(
  facet: DocumentFacet<unknown, unknown>,
  moduleId: string,
  project: ProjectContext,
  services: ModuleEditorFacetServices,
  input: ModuleSourcesPublishInput,
): Promise<void> {
  const sourcePaths = input.sources.map((source) => relativeProjectPath(project, source.uri));
  const context = facetContext(project, input.documentTypeId, sourcePaths, undefined);
  const previous: DocumentFacetSourceFile[] = [];
  for (const source of input.sources) {
    try {
      previous.push({ path: relativeProjectPath(project, source.uri), bytes: await readSourceBytes(source.uri) });
    } catch (errorValue) {
      services.log(
        `[modules] '${moduleId}' 的引用数据未更新：读取源文件失败（${source.uri.toString()}）：${formatError(errorValue)}`,
      );
      return;
    }
  }
  try {
    const rendered = await facet.renderSources!(input.document, previous, context);
    const parsed = await facet.parseSources!(rendered, context);
    if (!parsed.success) {
      services.log(
        `[modules] '${moduleId}' 的引用数据未更新：模块重新解析保存后的源文件失败（`
        + `${parsed.diagnostics.map((item) => item.message).join("; ") || "no diagnostics"}）`,
      );
      return;
    }
    if (parsed.referenceData === undefined) return;
    services.references.updateModuleDocument(input.ownerId, project, {
      moduleId,
      documentTypeId: input.documentTypeId,
      sourcePaths,
      data: parsed.referenceData,
    });
  } catch (errorValue) {
    // 引用数据是索引的附加值：渲染/解析失败不应打断保存流程，但必须写进 OutputChannel。
    services.log(
      `[modules] '${moduleId}' 的引用数据未更新：渲染/解析抛出异常：${formatError(errorValue)}`,
    );
  }
}

async function readSourceBytes(uri: vscode.Uri): Promise<Uint8Array> {
  return vscode.workspace.fs.readFile(uri);
}

/** 执行调试消息的宿主侧处理器；延迟创建，只有真的收到调试消息才连接 Runtime Bridge。 */
function createRuntimeDebugHandler(
  facet: DocumentFacet<unknown, unknown>,
  context: ModuleHostMessageContext,
): ModuleHostMessageHandler {
  let controller: GraphExecutionDebugController | undefined;
  return {
    async handle(message) {
      const type = message.type;
      if (typeof type !== "string" || !isGraphDebugMessage(type)) return false;
      controller ??= new GraphExecutionDebugController({
        postMessage: (outgoing) => context.postMessage(outgoing),
        getDocumentId: () => documentIdOf(facet, context.match.project, context.match, context.getText()),
        output: (line) => context.log(line),
      });
      await controller.handleWebviewMessage(message);
      return true;
    },
    get testState() {
      return controller?.testState;
    },
    dispose: () => controller?.dispose(),
  };
}

/** 文档 id 是 Core 的通用约定（`documentId`），由模块自己的解析器给出。 */
function documentIdOf(
  facet: DocumentFacet<unknown, unknown>,
  project: ProjectContext,
  match: DocumentMatch,
  text: string,
): string | undefined {
  if (facet.parseText === undefined) return undefined;
  // facet 边界：四个内置域的 `parseText` 都是同步的；契约允许 Promise，这里只接受同步结果。
  const parsed = facet.parseText(text, facetContext(
    project,
    match.documentType.id,
    [match.relativePath],
    undefined,
  )) as DocumentFacetParseResult<unknown>;
  if (!parsed.success) return undefined;
  const document = parsed.document;
  if (typeof document !== "object" || document === null) return undefined;
  const value = (document as { readonly documentId?: unknown }).documentId;
  return typeof value === "string" ? value : undefined;
}

function facetContext(
  project: ProjectContext,
  documentTypeId: string,
  sourcePaths: readonly string[],
  registry: unknown,
): DocumentFacetContext {
  return {
    projectId: project.definition.projectId,
    documentTypeId,
    path: sourcePaths[0] ?? "",
    sourcePaths,
    registry,
    projectDefinition: project.definition as unknown as JsonValue,
    moduleOptions: undefined,
  };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  return nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

// 供测试/C1 核对多源 storage 面时引用契约类型；避免仅类型引用被摇树掉。
export type { ModuleSourcesKeyRenamePlan, ModuleSourcesParseResult };
export type { CatalogFacet, CatalogWithSource };
