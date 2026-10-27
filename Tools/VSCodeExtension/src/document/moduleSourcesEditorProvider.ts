/**
 * 通用多源文档编辑器（B2，`storage: "sources"`）。
 *
 * 从 `tableEditorProvider.ts` 抽出的宿主侧骨架：`CustomDocument` 生命周期、多源读取、备份/恢复、
 * revert、脏状态、Project Transaction 写回（保留 `baseHash` 校验）与 effect 执行器。领域逻辑
 * （源规划、解析、渲染、Operation 应用、引用与 Provider 校验）全部委托模块的
 * `storage: "sources"` 与 `session` facet。
 *
 * 视图 id 仍是 `visualbridge.tableEditor`：它是 `package.json` 的注册名，重命名归 C1。
 */
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "@visualbridge/node-host";
import { compareUtf16CodeUnits, type DocumentDiagnostic, type JsonValue, type ReferenceLocation } from "@visualbridge/core";
import type { HostModuleRegistry } from "../modules/hostModuleRegistry";
import type { DocumentMatch, ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import { handleReferenceMessage } from "../reference/referenceMessages";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import type {
  WorkspaceReferenceTargetRenameRequest,
  WorkspaceReferenceTargetRenameResult,
} from "../refactor/workspaceReferenceRefactor";
import {
  loadModuleEditorFacets,
  type ModuleEditorFacets,
  type ModuleRevealMailbox,
} from "../editor/moduleEditorFacets";
import { WebviewEpoch } from "../editor/webviewEpoch";
import type {
  ModuleSessionCatalog,
  ModuleSessionController,
  ModuleSessionDocument,
  ModuleSessionEffect,
  ModuleSessionHost,
  ModuleSessionMessage,
  ModuleSessionSource,
  ModuleSourcesContext,
  ModuleSourceFile,
} from "./moduleSessionContract";

export const SOURCES_EDITOR_VIEW_TYPE = "visualbridge.tableEditor";

const OVERWRITE = "覆盖";
const DISCARD_AND_RELOAD = "放弃并刷新";
const STALE_REVISION_MESSAGE = "文档已发生变化，编辑器已刷新，请重试刚才的操作。";

interface WebviewMessage extends Readonly<Record<string, unknown>> {
  readonly type?: unknown;
  readonly webviewToken?: unknown;
  readonly instanceId?: unknown;
  readonly revision?: unknown;
  readonly operations?: unknown;
  readonly requestId?: unknown;
  readonly found?: unknown;
  readonly message?: unknown;
}

interface PendingReveal {
  readonly sequence: number;
  readonly target: unknown;
}

interface PanelRevealState {
  readonly mailbox: ModuleRevealMailbox;
  readonly epoch: WebviewEpoch;
  sourceUri: string | undefined;
  sourceTarget: unknown;
  revealGeneration: number | undefined;
  lastReveal: {
    readonly sourceUri: string;
    readonly target: unknown;
    readonly result: { readonly found: boolean; readonly message?: string };
  } | undefined;
}

/** 一份物理源文件的宿主状态（磁盘基线用原始字节与 Hash）。 */
interface SourceState {
  readonly uri: vscode.Uri;
  readonly path: string;
  readonly sheetIds: readonly string[];
  originalBytes: Uint8Array;
  baseHash: string;
}

interface BackupSource {
  readonly uri: string;
  readonly bytes: string;
}

interface SourcesBackup {
  readonly formatVersion: 1;
  readonly sources: readonly BackupSource[];
}

export class ModuleSourcesCustomDocument implements vscode.CustomDocument {
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private disposed = false;

  public revision = 1;
  public savedDocument: JsonValue;
  /** 磁盘源不可解析时从备份恢复：没有可比较的"已保存基线"，强制为脏。 */
  private forcedDirty = false;

  public readonly onDidChangeState = this.stateEmitter.event;

  public constructor(
    public readonly uri: vscode.Uri,
    public readonly match: DocumentMatch,
    public readonly moduleId: string,
    public readonly facets: ModuleEditorFacets,
    public readonly catalog: ModuleSessionCatalog,
    public readonly options: ModuleSessionMessage | undefined,
    public readonly controller: ModuleSessionController,
    public readonly sources: SourceState[],
    public document: JsonValue,
    savedDocument: JsonValue,
    forceDirty = false,
    private readonly didUpdate?: (document: ModuleSourcesCustomDocument) => void,
    private readonly didDispose?: (document: ModuleSourcesCustomDocument) => void,
  ) {
    // 从备份恢复时 `savedDocument` 是磁盘上的解析结果，`document` 是备份里的未保存内容，
    // 因此恢复出的 CustomDocument 与 VS Code 的语义一致：脏的。
    this.savedDocument = cloneJson(savedDocument);
    this.forcedDirty = forceDirty;
  }

  public get isDirty(): boolean {
    return this.forcedDirty || stableDocument(this.document) !== stableDocument(this.savedDocument);
  }

  public get sourceFiles(): readonly ModuleSourceFile[] {
    return this.sources.map((source) => ({ path: source.path, bytes: source.originalBytes }));
  }

  public get sessionSources(): readonly ModuleSessionSource[] {
    return this.sources.map((source) => ({
      path: source.path,
      sheetIds: source.sheetIds,
      baseHash: source.baseHash,
    }));
  }

  public update(next: JsonValue): void {
    this.document = cloneJson(next);
    this.revision += 1;
    this.stateEmitter.fire();
    this.didUpdate?.(this);
  }

  /** revert/重新装载后清除"磁盘不可解析"的强制脏标记。 */
  public markReverted(): void {
    this.forcedDirty = false;
  }

  public markSaved(sourceBytes: ReadonlyMap<string, Uint8Array>): void {
    this.savedDocument = cloneJson(this.document);
    this.forcedDirty = false;
    for (const source of this.sources) {
      const bytes = sourceBytes.get(source.path);
      if (bytes !== undefined) {
        source.originalBytes = bytes;
        source.baseHash = hashBytes(bytes);
      }
    }
    this.revision += 1;
    this.stateEmitter.fire();
    this.didUpdate?.(this);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.didDispose?.(this);
    this.stateEmitter.dispose();
  }
}

export class ModuleSourcesEditorProvider
implements vscode.CustomEditorProvider<ModuleSourcesCustomDocument>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ModuleSourcesCustomDocument>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panels = new Map<ModuleSourcesCustomDocument, Set<vscode.WebviewPanel>>();
  private readonly panelRevealStates = new Map<vscode.WebviewPanel, PanelRevealState>();
  private readonly pendingReveals = new Map<string, PendingReveal>();
  private readonly documentRevealGenerations = new Map<ModuleSourcesCustomDocument, number>();
  private readonly testPausedRevealPanels = new Set<vscode.WebviewPanel>();
  /** 每个文档最近一次拒绝文案（宿主测试断言"可读提示"用）。 */
  private readonly lastRejections = new Map<string, string>();
  /** 每个文档最近一次 `operationCompleted`（宿主测试断言宿主盖章的 revision 用）。 */
  private readonly lastOperationCompleted = new Map<string, Readonly<Record<string, unknown>>>();
  /** 每个文档最近一次发布的诊断"去重前/去重后"（宿主测试断言 open 阶段去重真的生效）。 */
  private readonly lastPublishedDiagnostics = new Map<string, {
    readonly raw: readonly DocumentDiagnostic[];
    readonly published: readonly DocumentDiagnostic[];
  }>();
  private revealSequence = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private referenceTargetRenamer: ((
    request: WorkspaceReferenceTargetRenameRequest,
  ) => Promise<WorkspaceReferenceTargetRenameResult>) | undefined;

  public readonly onDidChangeCustomDocument = this.changeEmitter.event;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
    private readonly modules: HostModuleRegistry,
  ) {
    this.disposables.push(this.changeEmitter);
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
  ): Promise<ModuleSourcesCustomDocument> {
    const match = this.projects.resolveDocument(uri);
    if (match === undefined) {
      throw new Error(
        `The file '${vscode.workspace.asRelativePath(uri)}' is not part of a loaded VisualBridge Project.`,
      );
    }
    // moduleId 一律来自注册表：宿主不再复刻 editor → module 的字面量映射。
    await this.modules.ensureProject(match.project);
    const availability = this.modules.editorAvailability(match.project, match.documentType.editor);
    if (availability.kind !== "available") {
      throw new Error(availability.message);
    }
    const moduleId = availability.moduleId;
    const facets = await loadModuleEditorFacets(moduleId, {
      references: this.references,
    });
    if (facets === undefined || facets.storage !== "sources" || facets.sources === undefined) {
      throw new Error(
        `No in-process multi-source editor is registered for editor '${match.documentType.editor}';`
        + " check the Project module declaration.",
      );
    }
    const catalog = await facets.loadCatalog(match);
    if (!catalog.ready) {
      throw new Error(formatCatalogUnavailable(catalog.diagnostics));
    }
    const backup = openContext.backupId === undefined
      ? undefined
      : await readBackup(vscode.Uri.parse(openContext.backupId));
    const options = moduleOptions(match, moduleId);
    const loaded = await loadSources(uri, match, facets, catalog, options, this.projects, backup);
    const controller = facets.createController();
    const document = new ModuleSourcesCustomDocument(
      uri,
      match,
      moduleId,
      facets,
      catalog,
      options,
      controller,
      loaded.sources,
      loaded.document,
      loaded.savedDocument,
      loaded.forceDirty,
      (current) => {
        this.publishReferenceDocument(current);
        this.notifyDocumentChange();
      },
      (current) => facets.sources?.removeDocument?.(current.uri.toString()),
    );
    this.publishReferenceDocument(document);
    // 与改造前一致：open 只并 Catalog + 源解析/校验 + Reference/Provider。
    // `loaded.diagnostics` 与控制器 state 都会产出一次 `validateTableDocument`，
    // `updateDiagnostics` 按诊断身份去重，Problems 里不会出现重复条目。
    this.updateDiagnostics(document, [
      ...catalog.diagnostics,
      ...loaded.diagnostics,
      ...await this.semanticDiagnostics(document),
    ]);
    return document;
  }

  public async resolveCustomEditor(
    document: ModuleSourcesCustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const facets = document.facets;
    panel.title = `${document.match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
    const nonce = createNonce();
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, facets.webview.script));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, facets.webview.style));
    panel.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    panel.webview.html = facets.webview.createHtml({
      cspSource: panel.webview.cspSource,
      nonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
      metadata: {
        projectId: document.match.project.definition.projectId,
        documentType: document.match.documentType.id,
        relativePath: document.match.relativePath,
      },
    });

    let documentPanels = this.panels.get(document);
    if (documentPanels === undefined) {
      documentPanels = new Set();
      this.panels.set(document, documentPanels);
    }
    documentPanels.add(panel);
    const revealState: PanelRevealState = {
      mailbox: facets.reveal?.createMailbox() ?? unavailableMailbox(),
      epoch: new WebviewEpoch(),
      sourceUri: undefined,
      sourceTarget: undefined,
      revealGeneration: undefined,
      lastReveal: undefined,
    };
    revealState.epoch.begin(createNonce());
    this.panelRevealStates.set(panel, revealState);
    let panelWasVisible = panel.visible;
    const stateSubscription = document.onDidChangeState(() => void this.sendState(document));
    const messageSubscription = panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      const webviewEpoch = revealState.epoch.capture();
      this.operationQueue = this.operationQueue
        .then(() => this.handleMessage(document, panel, message, webviewEpoch))
        .catch((errorValue: unknown) => {
          if (!this.isCurrentPanelEpoch(panel, revealState, webviewEpoch)
            || (message.type !== "ready" && !revealState.epoch.acceptsMessage(message.webviewToken))) {
            return;
          }
          this.output.appendLine(`[${facets.editor}] Operation failed: ${formatError(errorValue)}`);
          if (message.type === "ready") return;
          return this.reject(document, panel, formatError(errorValue)).then(() => undefined);
        });
    });
    const viewStateSubscription = panel.onDidChangeViewState((event) => {
      const visible = event.webviewPanel.visible;
      if (!visible && panelWasVisible) {
        revealState.epoch.invalidate();
        revealState.mailbox.markUnavailable();
      } else if (visible && !panelWasVisible) {
        revealState.epoch.begin(createNonce());
        void this.requestPanelReady(panel, revealState);
      }
      panelWasVisible = visible;
    });
    panel.onDidDispose(() => {
      revealState.epoch.invalidate();
      const currentPanels = this.panels.get(document);
      currentPanels?.delete(panel);
      if (currentPanels?.size === 0) {
        this.clearPendingReveals(document);
        revealState.mailbox.markUnavailable();
        revealState.sourceUri = undefined;
        revealState.sourceTarget = undefined;
        revealState.revealGeneration = undefined;
      } else if (currentPanels !== undefined) {
        this.restorePendingReveal(document, revealState);
      }
      this.testPausedRevealPanels.delete(panel);
      this.panelRevealStates.delete(panel);
      stateSubscription.dispose();
      messageSubscription.dispose();
      viewStateSubscription.dispose();
      if (currentPanels?.size === 0) {
        this.panels.delete(document);
        this.documentRevealGenerations.delete(document);
      } else if (currentPanels !== undefined) {
        void this.handoffPendingReveal(document, currentPanels).catch((errorValue: unknown) => {
          this.output.appendLine(`[${facets.editor}] Reveal handoff failed: ${formatError(errorValue)}`);
        });
      }
    });
    void this.requestPanelReady(panel, revealState);
  }

  public isEditorReady(uri: vscode.Uri): boolean {
    for (const [document, panels] of this.panels) {
      if (document.sources.some((source) => source.uri.toString() === uri.toString())
        && [...panels].some((panel) => {
          const state = this.panelRevealStates.get(panel);
          return state?.mailbox.isReady === true && panel.active && panel.visible;
        })) {
        return true;
      }
    }
    return false;
  }

  public getTestState(uri: vscode.Uri): {
    readonly panelCount: number;
    readonly activeReadyPanelCount: number;
    readonly pendingRevealCount: number;
    readonly dirty: boolean;
    /** 当前文档修订号；测试用它断言"陈旧整批拒绝"没有推进修订。 */
    readonly revision: number;
    readonly lastRevealResult?: { readonly found: boolean; readonly message?: string };
    readonly lastRevealTarget?: unknown;
  } {
    const uriKey = uri.toString();
    const matchingDocuments = [...this.panels]
      .filter(([document]) => document.sources.some((source) => source.uri.toString() === uriKey));
    const matchingPanels = matchingDocuments.flatMap(([, panels]) => [...panels]);
    const base = {
      panelCount: matchingPanels.length,
      activeReadyPanelCount: matchingPanels.filter((panel) => {
        const state = this.panelRevealStates.get(panel);
        return state?.mailbox.isReady === true && panel.active && panel.visible;
      }).length,
      pendingRevealCount: (this.pendingReveals.has(uriKey) ? 1 : 0)
        + matchingPanels.filter((panel) => this.panelRevealStates.get(panel)?.mailbox.pendingTarget !== undefined).length,
      dirty: matchingDocuments.some(([document]) => document.isDirty),
      revision: matchingDocuments[0]?.[0].revision ?? 0,
    };
    const lastReveal = matchingPanels
      .map((panel) => this.panelRevealStates.get(panel)?.lastReveal)
      .find((reveal) => reveal?.sourceUri === uriKey);
    return lastReveal === undefined
      ? base
      : { ...base, lastRevealResult: lastReveal.result, lastRevealTarget: lastReveal.target };
  }

  public async revealReference(value: unknown): Promise<void> {
    const location = readReferenceLocation(value);
    if (location === undefined) {
      throw new Error("Invalid Table reference location.");
    }
    const project = this.projects.projects.find((candidate) => candidate.definition.projectId === location.projectId);
    if (project === undefined) {
      throw new Error(`VisualBridge Project '${location.projectId}' is not open.`);
    }
    const uri = vscode.Uri.joinPath(project.rootUri, ...location.path.split("/"));
    const match = this.projects.resolveDocument(uri);
    if (match?.project.markerUri.toString() !== project.markerUri.toString()
      || match.documentType.id !== location.documentTypeId) {
      throw new Error("Table reference location is outside its declared Project Document Type.");
    }
    await this.modules.ensureProject(project);
    const availability = this.modules.editorAvailability(project, match.documentType.editor);
    const facets = availability.kind === "available"
      ? await loadModuleEditorFacets(availability.moduleId, { references: this.references })
      : undefined;
    const target = facets?.reveal?.readTarget(location);
    if (target === undefined) {
      throw new Error(facets?.reveal?.invalidLocationMessage ?? "Invalid Table reference location.");
    }
    const sourceUri = uri.toString();
    const revealGeneration = ++this.revealSequence;
    this.clearRevealResults(sourceUri);
    for (const [document, panels] of this.panels) {
      if (!document.sources.some((source) => source.uri.toString() === sourceUri)) continue;
      this.beginDocumentReveal(document, revealGeneration);
      const panel = chooseRevealPanel(panels);
      const state = panel === undefined ? undefined : this.panelRevealStates.get(panel);
      if (panel === undefined || state === undefined) break;
      state.sourceUri = sourceUri;
      state.sourceTarget = target;
      state.revealGeneration = revealGeneration;
      state.mailbox.enqueue(target);
      panel.reveal();
      await this.sendPanelReveal(panel, state, state.epoch.capture());
      return;
    }
    const pending: PendingReveal = { sequence: revealGeneration, target };
    this.pendingReveals.set(sourceUri, pending);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, SOURCES_EDITOR_VIEW_TYPE);
    } catch (error) {
      if (this.pendingReveals.get(sourceUri) === pending) {
        this.pendingReveals.delete(sourceUri);
      }
      throw error;
    }
  }

  public hasOpenProject(project: ProjectContext): boolean {
    return [...this.panels.keys()].some((document) => (
      document.match.project.markerUri.toString() === project.markerUri.toString()
    ));
  }

  public hasDirtyProject(project: ProjectContext): boolean {
    return [...this.panels.keys()].some((document) => (
      document.isDirty
      && document.match.project.markerUri.toString() === project.markerUri.toString()
    ));
  }

  private readonly documentChangeEmitter = new vscode.EventEmitter<void>();
  /** 任意多源文档内容或保存状态变化时触发（供"未保存文档"树视图刷新）。 */
  public readonly onDidChangeDocuments = this.documentChangeEmitter.event;

  private notifyDocumentChange(): void {
    this.documentChangeEmitter.fire();
  }

  public listDirtyDocuments(): readonly ModuleSourcesCustomDocument[] {
    return [...this.panels.keys()].filter((document) => document.isDirty);
  }

  public setReferenceTargetRenamer(
    renamer: (request: WorkspaceReferenceTargetRenameRequest) => Promise<WorkspaceReferenceTargetRenameResult>,
  ): void {
    this.referenceTargetRenamer = renamer;
  }

  public async refreshAfterReferenceRefactor(
    project: ProjectContext,
    sourcePaths: readonly string[],
  ): Promise<void> {
    const expected = new Set(sourcePaths.map((path) => vscode.Uri.joinPath(project.rootUri, ...path.split("/")).toString()));
    const documents = [...this.panels.keys()].filter((document) => (
      document.match.project.markerUri.toString() === project.markerUri.toString()
      && document.sources.some((source) => expected.has(source.uri.toString()))
    ));
    for (const document of documents) {
      await this.revertCustomDocument(document);
      await this.sendState(document);
    }
  }

  public openProjectSourceUris(project: ProjectContext): readonly vscode.Uri[] {
    return [...new Map([...this.panels.keys()]
      .filter((document) => document.match.project.markerUri.toString() === project.markerUri.toString())
      .flatMap((document) => document.sources)
      .map((source) => [source.uri.toString(), source.uri])).values()]
      .sort((left, right) => compareUtf16CodeUnits(left.toString(), right.toString()));
  }

  public pauseNextRevealForTest(uri: vscode.Uri): boolean {
    const uriKey = uri.toString();
    for (const [document, panels] of this.panels) {
      if (!document.sources.some((source) => source.uri.toString() === uriKey)) continue;
      const panel = chooseRevealPanel(panels);
      const state = panel === undefined ? undefined : this.panelRevealStates.get(panel);
      if (panel !== undefined && state !== undefined) {
        this.testPausedRevealPanels.add(panel);
        return true;
      }
    }
    return false;
  }

  public async saveCustomDocument(document: ModuleSourcesCustomDocument): Promise<void> {
    await this.saveToSources(document);
  }

  /**
   * 宿主测试用：**不建面板**直接走一次 open 路径，返回 open 阶段诊断的去重前/去重后身份。
   *
   * 面板 ready 之后 `state.diagnostics` 会覆盖 open 阶段诊断，只在 ready 之后断言就无法证明
   * `updateDiagnostics` 的去重真的生效；这里给出可观测的 open 阶段快照。
   */
  public async openDiagnosticsForTest(uri: vscode.Uri): Promise<{
    readonly raw: readonly DocumentDiagnostic[];
    readonly published: readonly DocumentDiagnostic[];
  }> {
    const document = await this.openCustomDocument(
      uri,
      {} as vscode.CustomDocumentOpenContext,
    );
    document.dispose();
    return this.lastPublishedDiagnostics.get(uri.toString()) ?? { raw: [], published: [] };
  }

  public async applyOperationsForTest(uri: vscode.Uri, operations: unknown): Promise<void> {
    const document = this.openDocument(uri);
    await this.applyOperations(document, operations, document.revision, undefined, false);
  }

  /**
   * 用给定的（可能陈旧的）revision 走**与 Webview 相同**的生产执行器，验证整批拒绝。
   *
   * `panel` 传 undefined 只是不向 Webview 发消息；revision 校验、稳定键改名、源冲突检测与
   * effect 执行都是同一份代码，不再有测试专用的旁路校验。
   */
  public async applyOperationsWithRevisionForTest(
    uri: vscode.Uri,
    operations: unknown,
    revision: number,
  ): Promise<void> {
    const document = this.openDocument(uri);
    await this.applyOperations(document, operations, revision, undefined, false);
  }

  /**
   * 生产与宿主测试共用的 apply 执行器。
   *
   * `panel === undefined` 表示测试入口：不向 Webview 发消息，但拒绝文案仍被记录；
   * 两条路径都执行同一套 revision 校验、稳定键改名、源冲突检测与 effect 执行。
   */
  private async applyOperations(
    document: ModuleSourcesCustomDocument,
    operations: unknown,
    expectedRevision: number,
    panel: vscode.WebviewPanel | undefined,
    confirmRefactor: boolean,
  ): Promise<void> {
    if (document.revision !== expectedRevision) {
      if (panel !== undefined) {
        await this.sendState(document);
      }
      await this.reject(document, panel, STALE_REVISION_MESSAGE);
      return;
    }
    const refactor = await this.applyExistingKeyRefactor(document, operations, confirmRefactor);
    if (refactor !== undefined) {
      if (!refactor.success) {
        if (panel === undefined) throw new Error(`${refactor.code}: ${refactor.message}`);
        await this.reject(document, panel, `${refactor.code}: ${refactor.message}`);
        return;
      }
      if (panel !== undefined) {
        await this.sendState(document);
        await this.postToPanel(document, panel, { type: "operationCompleted", changed: true });
      }
      return;
    }
    const conflict = await findConflict(document.sources);
    if (conflict !== undefined) {
      const message = `分表 '${nodePath.basename(conflict.uri.fsPath)}' 已被外部修改；为避免覆盖，操作已拒绝，请重新加载。`;
      if (panel === undefined) throw new Error(message);
      await this.reject(document, panel, message);
      return;
    }
    const effects = await document.controller.handle(
      { type: "applyOperations", operations: operations as JsonValue },
      this.createSnapshot(document),
      this.createHost(document),
    );
    await this.executeEffects(document, panel, effects, expectedRevision);
  }

  /** 最近一次拒绝文案；没有拒绝时为 undefined。 */
  public getLastRejection(uri: vscode.Uri): string | undefined {
    return this.lastRejections.get(uri.toString());
  }

  /** 最近一次 `operationCompleted`；宿主测试据此断言修订号是 apply 之后的值。 */
  public getLastOperationCompleted(uri: vscode.Uri): Readonly<Record<string, unknown>> | undefined {
    return this.lastOperationCompleted.get(uri.toString());
  }

  public async revertForTest(uri: vscode.Uri): Promise<void> {
    await this.revertCustomDocument(this.openDocument(uri));
  }

  public async saveForTest(uri: vscode.Uri): Promise<number> {
    const document = this.openDocument(uri);
    return this.saveToSources(document);
  }

  /** 备份内容（测试与 VS Code 的 `backupCustomDocument` 共用同一实现）。 */
  public async backupForTest(uri: vscode.Uri, destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    const document = this.openDocument(uri);
    return this.writeBackup(document, destination);
  }

  /**
   * 从备份恢复出的文档摘要（"编辑后崩溃恢复"用例用：不经过 Webview）。
   *
   * `save` 为 true 时把恢复出的内容按正常保存路径写回源文件（受 Project Transaction
   * 的 `baseHash` 校验约束），返回值因此能证明"恢复 → 保存"整条链路。
   */
  public async restoreFromBackupForTest(
    uri: vscode.Uri,
    backupUri: vscode.Uri,
    save = false,
  ): Promise<{
    readonly revision: number;
    /** 恢复出的文档相对磁盘是否是脏的（备份里必须带着未保存编辑）。 */
    readonly restoredDirty: boolean;
    readonly isDirty: boolean;
    readonly document: JsonValue;
    readonly savedWrites: number;
  }> {
    const document = await this.openCustomDocument(uri, {
      backupId: backupUri.toString(),
      untitledDocumentData: undefined,
    });
    try {
      const restoredDirty = document.isDirty;
      const savedWrites = save ? await this.saveToSources(document) : 0;
      return {
        revision: document.revision,
        restoredDirty,
        isDirty: document.isDirty,
        document: document.document,
        savedWrites,
      };
    } finally {
      document.dispose();
    }
  }

  public async saveCustomDocumentAs(
    document: ModuleSourcesCustomDocument,
    destination: vscode.Uri,
  ): Promise<void> {
    if (document.sources.length !== 1) {
      throw new Error("A partitioned source family cannot be saved with Save As; save the logical table in place.");
    }
    const rendered = await this.renderAllSources(document);
    const source = document.sources[0]!;
    const bytes = rendered.get(source.path);
    if (bytes === undefined) {
      throw new Error("Table source rendering did not produce the active source.");
    }
    await atomicWrite(destination, bytes);
  }

  public async revertCustomDocument(document: ModuleSourcesCustomDocument): Promise<void> {
    const loaded = await loadSources(
      document.uri,
      document.match,
      document.facets,
      document.catalog,
      document.options,
      this.projects,
    );
    document.sources.splice(0, document.sources.length, ...loaded.sources);
    document.document = cloneJson(loaded.document);
    document.savedDocument = cloneJson(loaded.savedDocument);
    document.markReverted();
    document.revision += 1;
    document.update(document.document);
    this.updateDiagnostics(document, loaded.diagnostics);
  }

  public async backupCustomDocument(
    document: ModuleSourcesCustomDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    return this.writeBackup(document, context.destination);
  }

  public dispose(): void {
    this.documentChangeEmitter.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panels.clear();
    this.panelRevealStates.clear();
    this.pendingReveals.clear();
    this.documentRevealGenerations.clear();
    this.testPausedRevealPanels.clear();
  }

  private async writeBackup(
    document: ModuleSourcesCustomDocument,
    destination: vscode.Uri,
  ): Promise<vscode.CustomDocumentBackup> {
    const rendered = await this.renderAllSources(document);
    const backup: SourcesBackup = {
      formatVersion: 1,
      sources: document.sources.map((source) => ({
        uri: source.uri.toString(),
        bytes: Buffer.from(rendered.get(source.path) ?? source.originalBytes).toString("base64"),
      })),
    };
    await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(backup), "utf8"));
    return {
      id: destination.toString(),
      delete: async () => vscode.workspace.fs.delete(destination),
    };
  }

  private async applyExistingKeyRefactor(
    document: ModuleSourcesCustomDocument,
    operations: unknown,
    confirm: boolean,
  ): Promise<WorkspaceReferenceTargetRenameResult | undefined> {
    const plan = document.controller as ModuleSourcesSessionControllerLike;
    if (typeof plan.planKeyRename !== "function") return undefined;
    const intent = plan.planKeyRename(this.createSnapshot(document), operations);
    if (intent.kind === "none") return undefined;
    if (intent.kind === "blocked") {
      return { success: false, code: "refactor.required", message: intent.message };
    }
    if (document.isDirty) {
      return {
        success: false,
        code: "refactor.workspaceDirty",
        message: "Save or revert this Table before renaming an existing stable row key.",
      };
    }
    if (this.referenceTargetRenamer === undefined) {
      return {
        success: false,
        code: "refactor.required",
        message: "Stable Table key renames require the Workspace Reference Refactor service.",
      };
    }
    return this.referenceTargetRenamer({
      projectId: document.match.project.definition.projectId,
      definition: intent.definition,
      location: intent.location,
      oldValue: intent.oldValue,
      newValue: intent.newValue,
      confirm,
    });
  }

  private async handleMessage(
    document: ModuleSourcesCustomDocument,
    panel: vscode.WebviewPanel,
    message: WebviewMessage,
    webviewEpoch: number,
  ): Promise<void> {
    const initialState = this.panelRevealStates.get(panel);
    if (initialState === undefined || !this.isCurrentPanelEpoch(panel, initialState, webviewEpoch)) return;
    if (message.type === "ready") {
      await this.handlePanelReady(document, panel, initialState, message, webviewEpoch);
      return;
    }
    if (!initialState.epoch.acceptsMessage(message.webviewToken)) return;
    if (document.facets.reveal !== undefined && message.type === document.facets.reveal.resultMessageType) {
      this.handleRevealResult(document, initialState, message);
      return;
    }
    if (await handleReferenceMessage(message, panel.webview, document.match.project, this.references)) {
      return;
    }
    if (message.type !== "applyOperations") return;
    if (typeof message.revision !== "number") {
      await this.reject(document, panel, STALE_REVISION_MESSAGE);
      return;
    }
    await this.applyOperations(document, message.operations, message.revision, panel, true);
  }

  private handleRevealResult(
    document: ModuleSourcesCustomDocument,
    state: PanelRevealState,
    message: WebviewMessage,
  ): void {
    if (typeof message.requestId !== "string" || typeof message.found !== "boolean") return;
    if (state.mailbox.acknowledge(message.requestId) !== true) return;
    const isCurrentReveal = state.revealGeneration !== undefined
      && state.revealGeneration === this.documentRevealGenerations.get(document);
    const result = {
      found: message.found,
      ...(typeof message.message === "string" ? { message: message.message } : {}),
    };
    state.lastReveal = !isCurrentReveal
      || state.sourceUri === undefined
      || state.sourceTarget === undefined
      ? undefined
      : { sourceUri: state.sourceUri, target: state.sourceTarget, result };
    state.sourceUri = undefined;
    state.sourceTarget = undefined;
    state.revealGeneration = undefined;
    if (isCurrentReveal && !result.found) {
      this.output.appendLine(
        `[${document.facets.editor}] Reveal target was not found: ${result.message ?? "unknown target"}`,
      );
    }
    const panels = this.panels.get(document);
    if (panels !== undefined) {
      void this.handoffPendingReveal(document, panels);
    }
  }

  private async reject(
    document: ModuleSourcesCustomDocument,
    panel: vscode.WebviewPanel | undefined,
    message: string,
  ): Promise<void> {
    this.lastRejections.set(document.uri.toString(), message);
    if (panel === undefined) return;
    await this.postToPanel(document, panel, { type: "operationRejected", message });
  }

  /** 宿主统一盖章：多源会话的修订号字段是 `revision`。 */
  private async postToPanel(
    document: ModuleSourcesCustomDocument,
    panel: vscode.WebviewPanel,
    message: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const stamped = { ...message, revision: document.revision } as Record<string, unknown>;
    if (stamped.type === "operationCompleted") {
      this.lastOperationCompleted.set(document.uri.toString(), stamped);
    }
    await panel.webview.postMessage(stamped);
  }

  private async executeEffects(
    document: ModuleSourcesCustomDocument,
    panel: vscode.WebviewPanel | undefined,
    effects: readonly ModuleSessionEffect[],
    expectedRevision: number,
  ): Promise<void> {
    for (const effect of effects) {
      switch (effect.kind) {
        case "apply": {
          if (document.revision !== expectedRevision) {
            this.output.appendLine(
              `[${document.facets.editor}] Rejected a stale effect batch for ${document.match.relativePath}.`,
            );
            await this.reject(document, panel, STALE_REVISION_MESSAGE);
            if (panel !== undefined) {
              await this.sendState(document);
            }
            return;
          }
          if (effect.operations.kind !== "sources") {
            throw new Error("A multi-source editor session may only apply a multi-source document.");
          }
          const before = cloneJson(document.document);
          const after = cloneJson(effect.operations.document);
          document.update(after);
          // 测试入口（panel === undefined）没有 Webview/撤销栈：与改造前一样只更新文档，
          // 不向 VS Code 报 CustomDocument 编辑事件，避免污染后续用例的编辑器状态。
          if (panel !== undefined) {
            this.changeEmitter.fire({
              document,
              label: effect.label ?? "Edit VisualBridge Document",
              undo: async () => document.update(before),
              redo: async () => document.update(after),
            });
          }
          this.updateDiagnostics(document, await this.semanticDiagnostics(document));
          this.output.appendLine(
            `[${document.facets.editor}] Applied operations to ${document.match.relativePath} at revision ${document.revision}.`,
          );
          break;
        }
        case "post": {
          const stamped = { ...effect.message, revision: document.revision } as ModuleSessionMessage;
          this.publishMessageDiagnostics(document, stamped);
          if (stamped.type === "operationRejected" && typeof stamped.message === "string") {
            this.lastRejections.set(document.uri.toString(), stamped.message);
          }
          if (stamped.type === "operationCompleted") {
            this.lastOperationCompleted.set(document.uri.toString(), stamped);
          }
          if (panel !== undefined) {
            await panel.webview.postMessage(stamped);
          }
          break;
        }
        case "notify": {
          if (effect.severity === "error") void vscode.window.showErrorMessage(effect.message);
          else if (effect.severity === "warning") void vscode.window.showWarningMessage(effect.message);
          else void vscode.window.showInformationMessage(effect.message);
          break;
        }
        case "clipboard.write": {
          await vscode.env.clipboard.writeText(effect.text);
          break;
        }
        case "reveal": {
          // reveal effect 携带 `ReferenceLocation`；用它走与 reference bridge 相同的定位路径。
          if (panel === undefined || document.facets.reveal === undefined) break;
          const target = document.facets.reveal.readTarget(effect.location);
          if (target === undefined) break;
          const state = this.panelRevealStates.get(panel);
          if (state === undefined) break;
          state.mailbox.enqueue(target);
          panel.reveal();
          await this.sendPanelReveal(panel, state, state.epoch.capture());
          break;
        }
        case "openDocument": {
          const uri = vscode.Uri.joinPath(document.match.project.rootUri, ...effect.path.split("/"));
          await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.documentEditor.option");
          break;
        }
      }
    }
  }

  private publishMessageDiagnostics(
    document: ModuleSourcesCustomDocument,
    message: ModuleSessionMessage,
  ): void {
    const diagnostics = message.diagnostics;
    if (!Array.isArray(diagnostics)) return;
    this.updateDiagnostics(document, diagnostics as unknown as readonly DocumentDiagnostic[]);
  }

  private async saveToSources(document: ModuleSourcesCustomDocument): Promise<number> {
    const rendered = await this.renderAllSources(document);
    const writes = document.sources.flatMap((source) => {
      const bytes = rendered.get(source.path);
      return bytes === undefined || hashBytes(bytes) === source.baseHash ? [] : [{
        path: source.path,
        absolutePath: source.uri.fsPath,
        before: source.originalBytes,
        after: bytes,
      }];
    });
    if (writes.length > 0) {
      if (document.match.project.rootUri.scheme !== "file"
        || document.sources.some((source) => source.uri.scheme !== "file")) {
        throw new Error("Table project transactions currently require a local file workspace.");
      }
      try {
        const result = await withProjectTransaction(
          document.match.project.rootUri.fsPath,
          (transaction) => transaction.commit(writes),
        );
        if (result.maintenance !== undefined) {
          this.output.appendLine(`[${document.facets.editor}] ${result.maintenance.code}: ${result.maintenance.message}`);
        }
      } catch (errorValue) {
        throw tableSaveTransactionError(errorValue);
      }
    }
    document.markSaved(rendered);
    this.updateDiagnostics(document, await this.semanticDiagnostics(document));
    return writes.length;
  }

  private async renderAllSources(document: ModuleSourcesCustomDocument): Promise<ReadonlyMap<string, Uint8Array>> {
    const storage = document.facets.sources?.storage;
    if (storage === undefined) {
      throw new Error("The multi-source editor storage facet is unavailable.");
    }
    const rendered = await storage.render(
      document.document,
      document.sourceFiles,
      sourcesContext(document),
    );
    return new Map(rendered.map((file) => [file.path, file.bytes]));
  }

  private openDocument(uri: vscode.Uri): ModuleSourcesCustomDocument {
    const key = uri.toString();
    const document = [...this.panels.keys()].find((candidate) => candidate.uri.toString() === key);
    if (document === undefined) throw new Error(`Table '${uri.fsPath}' is not open.`);
    return document;
  }

  private async sendState(
    document: ModuleSourcesCustomDocument,
    targetPanel?: vscode.WebviewPanel,
  ): Promise<boolean> {
    const state = await document.controller.state(this.createSnapshot(document), this.createHost(document));
    if (!isRecord(state)) return false;
    this.publishMessageDiagnostics(document, state);
    const message = { ...state, revision: document.revision };
    const panels = targetPanel === undefined
      ? [...this.panels.get(document) ?? []].filter(
          (panel) => this.panelRevealStates.get(panel)?.mailbox.isReady === true,
        )
      : [targetPanel];
    const results = await Promise.all(panels.map((panel) => panel.webview.postMessage(message)));
    return panels.length > 0 && results.every((posted) => posted);
  }

  private async semanticDiagnostics(document: ModuleSourcesCustomDocument): Promise<readonly DocumentDiagnostic[]> {
    const state = await document.controller.state(this.createSnapshot(document), this.createHost(document));
    if (!isRecord(state) || !Array.isArray(state.diagnostics)) return [];
    return state.diagnostics as unknown as readonly DocumentDiagnostic[];
  }

  private createSnapshot(document: ModuleSourcesCustomDocument): ModuleSessionDocument {
    return {
      projectId: document.match.project.definition.projectId,
      documentTypeId: document.match.documentType.id,
      path: document.match.relativePath,
      text: "",
      revision: document.revision,
      isDirty: document.isDirty,
      document: document.document,
      savedDocument: document.savedDocument,
      sources: document.sessionSources,
      catalog: document.catalog,
      ...(document.options === undefined ? {} : { options: document.options }),
    };
  }

  private createHost(document: ModuleSourcesCustomDocument): ModuleSessionHost {
    const references = this.references;
    const project = document.match.project;
    const facets = document.facets;
    return {
      loadCatalog: async () => document.catalog,
      validateReferences: (occurrences) => references.validate(project, occurrences),
      validateReferenceChange: (previous, next) => references.validateChange(project, previous, next),
      validateProviderDocument: (input) => references.validateProviderDocument(project, {
        documentTypeId: input.documentTypeId,
        path: input.path,
        sourceHash: hashSource(input.source),
        content: input.content,
      }),
      log: (level, message) => {
        if (level === "debug") return;
        this.output.appendLine(`[${facets.editor}] ${message}`);
      },
    };
  }

  private claimPendingReveal(document: ModuleSourcesCustomDocument, state: PanelRevealState): void {
    const candidates = document.sources
      .map((source) => ({
        sourceUri: source.uri.toString(),
        pending: this.pendingReveals.get(source.uri.toString()),
      }))
      .filter((entry): entry is { readonly sourceUri: string; readonly pending: PendingReveal } => (
        entry.pending !== undefined
      ));
    if (candidates.length === 0 || state.mailbox.deliverable !== undefined) return;
    const selected = candidates.sort((left, right) => right.pending.sequence - left.pending.sequence)[0];
    candidates.forEach((entry) => this.pendingReveals.delete(entry.sourceUri));
    if (selected !== undefined) {
      const currentGeneration = this.documentRevealGenerations.get(document);
      if (currentGeneration !== undefined && selected.pending.sequence < currentGeneration) return;
      if (currentGeneration === undefined || selected.pending.sequence > currentGeneration) {
        this.cancelPanelReveals(document);
        this.documentRevealGenerations.set(document, selected.pending.sequence);
      }
      state.sourceUri = selected.sourceUri;
      state.sourceTarget = selected.pending.target;
      state.revealGeneration = selected.pending.sequence;
      state.mailbox.enqueue(selected.pending.target);
    }
  }

  private async sendPanelReveal(
    panel: vscode.WebviewPanel,
    state: PanelRevealState,
    webviewEpoch: number,
  ): Promise<void> {
    if (!this.isCurrentPanelEpoch(panel, state, webviewEpoch) || !state.epoch.isReady) return;
    const request = state.mailbox.deliverable;
    if (request === undefined) return;
    if (this.testPausedRevealPanels.delete(panel)) return;
    if (!await panel.webview.postMessage(request)
      && this.isCurrentPanelEpoch(panel, state, webviewEpoch)) {
      state.mailbox.markUnavailable();
    }
  }

  private async handoffPendingReveal(
    document: ModuleSourcesCustomDocument,
    panels: ReadonlySet<vscode.WebviewPanel>,
  ): Promise<void> {
    const panel = chooseReadyRevealPanel(panels, this.panelRevealStates);
    const state = panel === undefined ? undefined : this.panelRevealStates.get(panel);
    if (panel === undefined || state === undefined) return;
    this.claimPendingReveal(document, state);
    if (state.mailbox.deliverable === undefined) return;
    panel.reveal();
    await this.sendPanelReveal(panel, state, state.epoch.capture());
  }

  private clearPendingReveals(document: ModuleSourcesCustomDocument): void {
    document.sources.forEach((source) => this.pendingReveals.delete(source.uri.toString()));
  }

  private beginDocumentReveal(document: ModuleSourcesCustomDocument, generation: number): void {
    this.documentRevealGenerations.set(document, generation);
    this.clearPendingReveals(document);
    this.cancelPanelReveals(document);
  }

  private cancelPanelReveals(document: ModuleSourcesCustomDocument): void {
    for (const panel of this.panels.get(document) ?? []) {
      const state = this.panelRevealStates.get(panel);
      if (state === undefined) continue;
      // Table 的 cancel 只清未送达目标，不改 mailbox 就绪态（就绪态由 ready 握手维护）。
      state.mailbox.cancel?.();
      state.sourceUri = undefined;
      state.sourceTarget = undefined;
      state.revealGeneration = undefined;
    }
  }

  private clearRevealResults(sourceUri: string): void {
    for (const state of this.panelRevealStates.values()) {
      if (state.lastReveal?.sourceUri === sourceUri) state.lastReveal = undefined;
    }
  }

  private restorePendingReveal(document: ModuleSourcesCustomDocument, state: PanelRevealState): void {
    const target = state.sourceTarget;
    const generation = state.revealGeneration;
    if (state.sourceUri !== undefined
      && target !== undefined
      && generation !== undefined
      && generation === this.documentRevealGenerations.get(document)
      && !this.pendingReveals.has(state.sourceUri)) {
      this.pendingReveals.set(state.sourceUri, { sequence: generation, target });
    }
  }

  private async handlePanelReady(
    document: ModuleSourcesCustomDocument,
    panel: vscode.WebviewPanel,
    state: PanelRevealState,
    message: WebviewMessage,
    webviewEpoch: number,
  ): Promise<void> {
    if (typeof message.instanceId !== "string" || message.instanceId.length === 0) return;
    if (message.webviewToken === undefined) {
      await this.requestPanelReady(panel, state);
      return;
    }
    if (!panel.visible || !state.epoch.canAcceptReady(message.webviewToken)) return;
    if (!await this.sendState(document, panel)
      || !this.isCurrentPanelEpoch(panel, state, webviewEpoch)
      || !panel.visible
      || !state.epoch.markReady(message.webviewToken)) {
      return;
    }
    state.mailbox.markReady();
    this.claimPendingReveal(document, state);
    await this.sendPanelReveal(panel, state, webviewEpoch);
  }

  private async requestPanelReady(
    panel: vscode.WebviewPanel,
    state: PanelRevealState,
  ): Promise<void> {
    const token = state.epoch.currentToken;
    if (this.panelRevealStates.get(panel) !== state || !panel.visible || token === undefined) return;
    await panel.webview.postMessage({ type: "requestReady", webviewToken: token });
  }

  private isCurrentPanelEpoch(
    panel: vscode.WebviewPanel,
    state: PanelRevealState,
    webviewEpoch: number,
  ): boolean {
    return this.panelRevealStates.get(panel) === state && state.epoch.isCurrent(webviewEpoch);
  }

  private updateDiagnostics(
    document: ModuleSourcesCustomDocument,
    items: readonly DocumentDiagnostic[],
  ): void {
    const published = dedupeDiagnostics(items);
    this.lastPublishedDiagnostics.set(document.uri.toString(), { raw: [...items], published: [...published] });
    this.diagnostics.set(document.uri, published.map((item) => {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        `${item.path}: ${item.message}`,
        item.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.code = item.code;
      diagnostic.source = "VisualBridge";
      return diagnostic;
    }));
  }

  private publishReferenceDocument(document: ModuleSourcesCustomDocument): void {
    const publish = document.facets.sources?.publishDocument;
    if (publish === undefined) return;
    publish({
      ownerId: document.uri.toString(),
      project: document.match.project,
      documentTypeId: document.match.documentType.id,
      document: document.document,
      savedDocument: document.savedDocument,
      sources: document.sources.map((source) => ({ uri: source.uri, sheetIds: source.sheetIds })),
      catalog: document.catalog,
    });
  }
}

/** 多源会话控制器在宿主侧的额外成员（`planKeyRename`）；调用前已确保存在。 */
interface ModuleSourcesSessionControllerLike extends ModuleSessionController {
  planKeyRename?(
    document: ModuleSessionDocument,
    operations: unknown,
  ): import("./moduleSessionContract").ModuleSourcesKeyRenamePlan;
}



async function loadSources(
  uri: vscode.Uri,
  match: DocumentMatch,
  facets: ModuleEditorFacets,
  catalog: ModuleSessionCatalog,
  options: ModuleSessionMessage | undefined,
  projects: ProjectRegistry,
  backup?: SourcesBackup,
): Promise<{
  readonly sources: SourceState[];
  readonly document: JsonValue;
  /** 磁盘上的解析结果；有备份时它与 `document` 不同（恢复出的文档是脏的）。 */
  readonly savedDocument: JsonValue;
  /** 磁盘源不可解析时没有可比较基线：恢复出的文档必须强制为脏。 */
  readonly forceDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}> {
  const storage = facets.sources?.storage;
  if (storage === undefined) {
    throw new Error("The multi-source editor storage facet is unavailable.");
  }
  const backupBytes = new Map(
    (backup?.sources ?? []).map((source) => [source.uri, Uint8Array.from(Buffer.from(source.bytes, "base64"))]),
  );
  const activeDiskBytes = await vscode.workspace.fs.readFile(uri);
  const activeBytes = backupBytes.get(uri.toString()) ?? activeDiskBytes;
  const activePath = relativeProjectPath(match.project, uri);
  const candidates = await findCandidatePaths(uri, match, projects);
  const planned = storage.planSources(
    { path: activePath, bytes: activeBytes },
    candidates,
    { projectId: match.project.definition.projectId, documentTypeId: match.documentType.id, options, catalog },
  );
  const files: ModuleSourceFile[] = [];
  const diskFiles: ModuleSourceFile[] = [];
  const diskBytes = new Map<string, Uint8Array>();
  for (const path of planned) {
    const sourceUri = vscode.Uri.joinPath(match.project.rootUri, ...path.split("/"));
    const disk = sourceUri.toString() === uri.toString()
      ? activeDiskBytes
      : await vscode.workspace.fs.readFile(sourceUri);
    diskBytes.set(path, disk);
    diskFiles.push({ path, bytes: disk });
    files.push({ path, bytes: backupBytes.get(sourceUri.toString()) ?? disk });
  }
  const context: ModuleSourcesContext = {
    projectId: match.project.definition.projectId,
    documentTypeId: match.documentType.id,
    options,
    catalog,
  };
  const parsed = await storage.parse(files, context);
  if (!parsed.success) {
    throw new Error(formatDiagnostics(parsed.diagnostics));
  }
  // 有备份时，磁盘解析结果是"已保存"基线：备份内容相对它才是未保存编辑。
  // 磁盘源本身不可解析（崩溃后源损坏）时没有可比较基线，必须强制为脏而不是把备份当基线。
  let savedDocument = parsed.document;
  let forceDirty = false;
  if (backup !== undefined) {
    const diskParsed = await storage.parse(diskFiles, context);
    if (diskParsed.success) {
      savedDocument = diskParsed.document;
    } else {
      forceDirty = true;
    }
  }
  const sources: SourceState[] = files.map((file) => {
    const disk = diskBytes.get(file.path) ?? file.bytes;
    return {
      uri: vscode.Uri.joinPath(match.project.rootUri, ...file.path.split("/")),
      path: file.path,
      sheetIds: parsed.sheetsBySource?.[file.path] ?? [],
      originalBytes: disk,
      baseHash: hashBytes(disk),
    };
  });
  return { sources, document: parsed.document, savedDocument, forceDirty, diagnostics: parsed.diagnostics };
}

/**
 * 与领域无关的候选源枚举：同目录、同扩展名、解析到同一 Project 与同一 Document Type。
 * 具体哪些属于同一逻辑文档由 `storage.planSources` 决定（Table 用它筛分表家族）。
 */
async function findCandidatePaths(
  uri: vscode.Uri,
  match: DocumentMatch,
  projects: ProjectRegistry,
): Promise<readonly string[]> {
  const activePath = relativeProjectPath(match.project, uri);
  const directory = uri.with({ path: nodePath.posix.dirname(uri.path) });
  const extension = nodePath.extname(uri.path).toLowerCase();
  let entries: readonly [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return [activePath];
  }
  const paths: string[] = [activePath];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || nodePath.extname(name).toLowerCase() !== extension) continue;
    const candidate = vscode.Uri.joinPath(directory, name);
    const candidateMatch = projects.resolveDocument(candidate);
    if (candidateMatch?.project.markerUri.toString() !== match.project.markerUri.toString()
      || candidateMatch.documentType.id !== match.documentType.id) {
      continue;
    }
    const candidatePath = relativeProjectPath(match.project, candidate);
    if (!paths.includes(candidatePath)) paths.push(candidatePath);
  }
  return paths.sort((left, right) => compareUtf16CodeUnits(left, right));
}

function sourcesContext(document: ModuleSourcesCustomDocument): ModuleSourcesContext {
  return {
    projectId: document.match.project.definition.projectId,
    documentTypeId: document.match.documentType.id,
    options: document.options,
    catalog: document.catalog,
  };
}

function moduleOptions(match: DocumentMatch, moduleId: string): ModuleSessionMessage | undefined {
  return match.project.definition.modules.find((module) => module.id === moduleId)?.options;
}

function chooseRevealPanel(panels: ReadonlySet<vscode.WebviewPanel>): vscode.WebviewPanel | undefined {
  const values = [...panels];
  return values.find((panel) => panel.active && panel.visible)
    ?? values.find((panel) => panel.visible)
    ?? values[0];
}

/** 与旧 `chooseReadyTableRevealRecipient` 同义：优先就绪、无待送达目标的面板。 */
function chooseReadyRevealPanel(
  panels: ReadonlySet<vscode.WebviewPanel>,
  states: ReadonlyMap<vscode.WebviewPanel, PanelRevealState>,
): vscode.WebviewPanel | undefined {
  const recipients = [...panels].flatMap((panel) => {
    const state = states.get(panel);
    return state === undefined
      ? []
      : [{ panel, state, active: panel.active, visible: panel.visible }];
  });
  const available = recipients.filter((recipient) => (
    recipient.state.mailbox.isReady === true
    && recipient.state.mailbox.pendingTarget === undefined
  ));
  return available.find((recipient) => recipient.active && recipient.visible)?.panel
    ?? available.find((recipient) => recipient.visible)?.panel
    ?? available[0]?.panel;
}

function unavailableMailbox(): ModuleRevealMailbox {
  return {
    enqueue: () => undefined,
    markReady: () => undefined,
    markUnavailable: () => undefined,
    get deliverable() { return undefined; },
    acknowledge: () => false,
  };
}

async function findConflict(sources: readonly SourceState[]): Promise<SourceState | undefined> {
  for (const source of sources) {
    try {
      const bytes = await vscode.workspace.fs.readFile(source.uri);
      if (hashBytes(bytes) !== source.baseHash) return source;
    } catch {
      return source;
    }
  }
  return undefined;
}

async function atomicWrite(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  const temporary = uri.with({ path: `${uri.path}.visualbridge-${createNonce()}.tmp` });
  try {
    await vscode.workspace.fs.writeFile(temporary, bytes);
    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
  } catch (errorValue) {
    try {
      await vscode.workspace.fs.delete(temporary);
    } catch {
      // 仅尽力清理临时文件。
    }
    throw errorValue;
  }
}

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  if (project.rootUri.scheme !== "file" || uri.scheme !== "file") {
    throw new Error("Table project transactions currently require a local file workspace.");
  }
  const path = nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/");
  if (path.length === 0 || path === ".." || path.startsWith("../") || nodePath.posix.isAbsolute(path)) {
    throw new Error(`Table source '${uri.fsPath}' is outside the VisualBridge Project.`);
  }
  return path;
}

function tableSaveTransactionError(errorValue: unknown): Error {
  if (errorValue instanceof ProjectTransactionConflict) {
    const details = isRecord(errorValue.details) ? errorValue.details : undefined;
    const path = typeof details?.path === "string" ? details.path : undefined;
    const source = path === undefined ? "a Table source" : `'${nodePath.posix.basename(path)}'`;
    if (errorValue.reason === "writeInProgress") {
      return new Error("Table save refused because another VisualBridge project writer is active; no source was written.");
    }
    return new Error(`Table save refused because ${source} changed on disk; no source was written.`);
  }
  if (errorValue instanceof ProjectTransactionFailure) {
    return new Error(
      `Table save transaction failed (${errorValue.code}); no partial source family was committed. ${errorValue.message}`,
    );
  }
  return errorValue instanceof Error ? errorValue : new Error(String(errorValue));
}

async function readBackup(uri: vscode.Uri): Promise<SourcesBackup> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
  const value = JSON.parse(text) as Partial<SourcesBackup>;
  if (value.formatVersion !== 1 || !Array.isArray(value.sources)) {
    throw new Error("Invalid VisualBridge Table backup.");
  }
  return value as SourcesBackup;
}

function readReferenceLocation(value: unknown): ReferenceLocation | undefined {
  if (!isRecord(value)
    || !isIdentifier(value.projectId)
    || !isIdentifier(value.documentTypeId)
    || !isProjectRelativePath(value.path)
    || (value.sheetId !== undefined && !isTableLocationId(value.sheetId))
    || (value.rowId !== undefined && !isTableLocationId(value.rowId))) {
    return undefined;
  }
  return {
    projectId: value.projectId,
    documentTypeId: value.documentTypeId,
    path: value.path,
    ...(value.sheetId === undefined ? {} : { sheetId: value.sheetId }),
    ...(value.rowId === undefined ? {} : { rowId: value.rowId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isTableLocationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isProjectRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashSource(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createNonce(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex");
}

/** 同一诊断可能由"源解析 + 控制器 state"两条路径各产一次；按身份去重保持改造前条数。 */
function dedupeDiagnostics(items: readonly DocumentDiagnostic[]): readonly DocumentDiagnostic[] {
  const seen = new Set<string>();
  const result: DocumentDiagnostic[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function stableDocument(value: JsonValue): string {
  return JSON.stringify(value);
}

function formatDiagnostics(diagnostics: readonly DocumentDiagnostic[]): string {
  const first = diagnostics[0];
  return first === undefined ? "Table document is invalid." : `${first.path}: ${first.message}`;
}

function formatCatalogUnavailable(diagnostics: readonly DocumentDiagnostic[]): string {
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return firstError === undefined
    ? "Table Catalog is unavailable."
    : `Table Catalog is unavailable: ${firstError.path}: ${firstError.message}`;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
