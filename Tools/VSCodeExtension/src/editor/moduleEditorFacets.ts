/**
 * 进程内模块 editor 面（B2 的临时适配层，C2 接入 ModuleLoader 后整文件删除）。
 *
 * 唯一按 `modules[].id` 把 `@visualbridge/entity|graph|structured|table` 的 session/storage facet
 * 与 Webview 资产、Catalog facet 装配起来的地方。`documentEditorProvider` /
 * `moduleSourcesEditorProvider` 只认 `HostModuleRegistry.editorAvailability` 给出的 moduleId，
 * 因此宿主内没有按 editor 字面量分支的会话代码。
 *
 * 领域包与 editor 包一律**动态 import**：登记表在模块未加载时不会求值任何领域代码
 * （附录 D.2 授权边界）；C2 换成 bundle 自带 facets 后删除本文件。
 */
import type * as vscode from "vscode";
import * as nodePath from "node:path";
import type { DocumentDiagnostic, JsonValue, OwnedStableIdentity, ReferenceLocation } from "@visualbridge/core";
import type { DocumentMatch, ProjectContext } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import type {
  ModuleSessionCatalog,
  ModuleSessionController,
  ModuleSourcesKeyRenamePlan,
  ModuleSourcesParseResult,
  ModuleSourcesStorage,
} from "../document/moduleSessionContract";
import { loadDocumentTypeCatalogRegistry } from "../modules/documentFacetRegistry";
import { GraphExecutionDebugController } from "./graphExecutionDebugController";

export const ENTITY_MODULE_ID = "visualbridge.entity";
export const GRAPH_MODULE_ID = "visualbridge.graph";
export const STRUCTURED_MODULE_ID = "visualbridge.structured";
export const TABLE_MODULE_ID = "visualbridge.table";

/** 定位 mailbox 的宿主侧结构；Editor 包各自实现同名成员集合。 */
export interface ModuleRevealMailbox {
  enqueue(target: unknown): unknown;
  markReady(): void;
  markUnavailable(): void;
  readonly deliverable: unknown;
  acknowledge(requestId: string): boolean;
  /** Table 的 mailbox 额外暴露就绪态与未送达目标；Entity/Graph 没有这两个成员。 */
  readonly isReady?: boolean;
  readonly pendingTarget?: unknown;
  cancel?(): void;
}

export interface ModuleRevealFacet {
  readonly resultMessageType: string;
  createMailbox(): ModuleRevealMailbox;
  readTarget(location: ReferenceLocation): unknown | undefined;
  /** 位置形状不合法时的可读错误（与改造前各会话的文案一致）。 */
  readonly invalidLocationMessage: string;
}

export interface ModuleWebviewMetadata {
  readonly projectId: string;
  readonly documentType: string;
  readonly relativePath: string;
}

export interface ModuleWebviewFacet {
  /** `dist/webview/` 下的脚本与样式文件名。 */
  readonly script: string;
  readonly style: string;
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
    readonly diagnostics: readonly DocumentDiagnostic[];
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
  createHostMessageHandler?(context: ModuleHostMessageContext): ModuleHostMessageHandler | undefined;
}

export interface ModuleEditorFacetServices {
  readonly references: WorkspaceReferenceService;
}

const cache = new Map<string, Promise<ModuleEditorFacets | undefined>>();

/**
 * 按 moduleId 取 editor 面。
 *
 * 未登记的 moduleId 返回 `undefined`（调用方回退只读 Shell）；登记但装配失败时抛错，
 * 由调用方按"模块不可用"处理并记 Output。
 */
export function loadModuleEditorFacets(
  moduleId: string,
  services: ModuleEditorFacetServices,
): Promise<ModuleEditorFacets | undefined> {
  const cached = cache.get(moduleId);
  if (cached !== undefined) return cached;
  const loading = createFacets(moduleId, services);
  cache.set(moduleId, loading);
  return loading;
}

/** 仅测试用：丢弃缓存（模块定义变化后可以重新装配）。 */
export function resetModuleEditorFacetsForTest(): void {
  cache.clear();
}

async function createFacets(
  moduleId: string,
  services: ModuleEditorFacetServices,
): Promise<ModuleEditorFacets | undefined> {
  switch (moduleId) {
    case ENTITY_MODULE_ID: return loadEntityFacets();
    case GRAPH_MODULE_ID: return loadGraphFacets();
    case STRUCTURED_MODULE_ID: return loadStructuredFacets();
    case TABLE_MODULE_ID: return loadTableFacets(services);
    default: return undefined;
  }
}

/**
 * 会话侧 Catalog 装载：只按 Document Type 的 editor 取模块 `catalog` facet，宿主不自带领域列表。
 *
 * 没有 facet 的领域返回一条可读错误（模块未登记），与会话"Catalog 不可用"的既有形状一致。
 */
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

async function loadEntityFacets(): Promise<ModuleEditorFacets> {
  const [domain, editor] = await Promise.all([
    import("@visualbridge/entity"),
    import("@visualbridge/entity-editor"),
  ]);
  return {
    moduleId: ENTITY_MODULE_ID,
    editor: domain.ENTITY_EDITOR_ID,
    storage: "text",
    webview: {
      script: "entityEditor.js",
      style: "entityEditor.css",
      createHtml: (input) => editor.createEntityEditorHtml(input),
    },
    reveal: {
      resultMessageType: editor.ENTITY_REVEAL_RESULT_MESSAGE_TYPE,
      createMailbox: () => new editor.EntityRevealMailbox(),
      readTarget: (location) => editor.readEntityRevealTarget(location),
      invalidLocationMessage: "Invalid Entity component reference location.",
    },
    loadCatalog: loadCatalogForMatch,
    createController: () => domain.createEntitySessionController(),
  };
}

async function loadGraphFacets(): Promise<ModuleEditorFacets> {
  const [domain, editor] = await Promise.all([
    import("@visualbridge/graph"),
    import("@visualbridge/graph-editor"),
  ]);
  return {
    moduleId: GRAPH_MODULE_ID,
    editor: domain.GRAPH_EDITOR_ID,
    storage: "text",
    webview: {
      script: "graphEditor.js",
      style: "graphEditor.css",
      createHtml: (input) => editor.createGraphEditorHtml(input),
    },
    reveal: {
      resultMessageType: editor.GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
      createMailbox: () => new editor.GraphRevealMailbox(),
      readTarget: (location) => editor.readGraphRevealTarget(location),
      invalidLocationMessage: "Invalid Graph element reference location.",
    },
    loadCatalog: loadCatalogForMatch,
    createController: () => domain.createGraphSessionController(),
    createHostMessageHandler: (context) => createGraphDebugHandler(domain, context),
  };
}

async function loadStructuredFacets(): Promise<ModuleEditorFacets> {
  const [domain, editor] = await Promise.all([
    import("@visualbridge/structured"),
    import("@visualbridge/structured-editor"),
  ]);
  return {
    moduleId: STRUCTURED_MODULE_ID,
    editor: domain.STRUCTURED_EDITOR_ID,
    storage: "text",
    webview: {
      script: "structuredEditor.js",
      style: "structuredEditor.css",
      createHtml: (input) => editor.createStructuredEditorHtml(input),
    },
    loadCatalog: loadCatalogForMatch,
    createController: () => domain.createStructuredSessionController(),
  };
}

async function loadTableFacets(services: ModuleEditorFacetServices): Promise<ModuleEditorFacets> {
  const [domain, editor] = await Promise.all([
    import("@visualbridge/table"),
    import("@visualbridge/table-editor"),
  ]);
  const storage: ModuleSourcesStorage = domain.tableSourcesStorage;
  return {
    moduleId: TABLE_MODULE_ID,
    editor: domain.TABLE_EDITOR_ID,
    storage: "sources",
    webview: {
      script: "tableEditor.js",
      style: "tableEditor.css",
      createHtml: (input) => editor.createTableEditorHtml(input),
    },
    reveal: {
      resultMessageType: editor.TABLE_REVEAL_RESULT_MESSAGE_TYPE,
      createMailbox: () => new editor.TableRevealMailbox(),
      readTarget: (location) => readTableRevealTarget(location),
      invalidLocationMessage: "Invalid Table reference location.",
    },
    sources: {
      storage,
      publishDocument: (input) => {
        const registry = input.catalog.registry as ReturnType<typeof domain.createEmptyTableCatalogRegistry>;
        const tableType = domain.resolveTableType(registry, input.documentTypeId);
        if (tableType === undefined) return;
        const sourcePaths = input.sources.map((source) => relativeProjectPath(input.project, source.uri));
        const sheetPaths: Record<string, string> = {};
        input.sources.forEach((source) => {
          const sourcePath = relativeProjectPath(input.project, source.uri);
          source.sheetIds.forEach((sheetId) => { sheetPaths[sheetId] = sourcePath; });
        });
        services.references.updateModuleDocument(input.ownerId, input.project, {
          moduleId: TABLE_MODULE_ID,
          documentTypeId: input.documentTypeId,
          sourcePaths,
          data: domain.createTableReferenceData({
            projectId: input.project.definition.projectId,
            documentTypeId: input.documentTypeId,
            path: sourcePaths[0] ?? "",
            document: input.document as unknown as Parameters<typeof domain.validateTableDocument>[0],
            tableType,
            sheetPaths,
          }),
        });
      },
      removeDocument: (ownerId) => services.references.removeModuleDocument(ownerId),
    },
    loadCatalog: loadCatalogForMatch,
    createController: () => domain.createTableSessionController(),
  };
}

const GRAPH_DEBUG_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "requestGraphExecutionInstances",
  "subscribeGraphExecution",
  "unsubscribeGraphExecution",
  "requestGraphExecutionDebugState",
  "graphDebugAck",
]);

function createGraphDebugHandler(
  domain: typeof import("@visualbridge/graph"),
  context: ModuleHostMessageContext,
): ModuleHostMessageHandler {
  // 执行调试使用独立 Runtime 连接（观察者语义），不与 DAP 检查会话共享。
  const controller = new GraphExecutionDebugController({
    postMessage: (message) => context.postMessage(message),
    getDocumentId: () => {
      const parsed = domain.parseGraphDocument(context.getText());
      return parsed.success ? parsed.document.documentId : undefined;
    },
    output: (line) => context.log(line),
  });
  return {
    async handle(message) {
      if (typeof message.type !== "string" || !GRAPH_DEBUG_MESSAGE_TYPES.has(message.type)) {
        return false;
      }
      await controller.handleWebviewMessage(message);
      return true;
    },
    get testState() {
      return controller.testState;
    },
    dispose: () => controller.dispose(),
  };
}

function readTableRevealTarget(location: ReferenceLocation): unknown | undefined {
  if (location.sheetId === undefined || location.rowId === undefined) return undefined;
  return { sheetId: location.sheetId, rowId: location.rowId };
}

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  return nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

// 供测试/C1 核对多源 storage 面时引用契约类型；避免仅类型引用被摇树掉。
export type { ModuleSourcesKeyRenamePlan, ModuleSourcesParseResult };
