/**
 * 通用文档编辑器入口（B2）。
 *
 * 按 `HostModuleRegistry` 的 editor 可用性分派到两类会话：
 * - `storage: "text"` → `ModuleTextEditorSession`（Entity / Graph / Structured 共用一份实现）；
 * - `storage: "sources"` → 交给多源编辑器视图（`ModuleSourcesEditorProvider`）。
 *
 * 宿主内不再有按 `editor` 字面量分支的会话代码：领域差异全部来自模块的 `session` / `storage`
 * facet（进程内适配见 `moduleEditorFacets.ts`，C2 换成 ModuleLoader）。模块不可用时仍回退 B1 的
 * 只读 Shell，保持 Restricted Mode 门禁。
 */
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { ReferenceLocation } from "@visualbridge/core";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";
import type { HostModuleRegistry } from "../modules/hostModuleRegistry";
import type { ModuleEditorAvailability, ModuleEditorFallbackReason } from "../modules/moduleRegistration";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import { SOURCES_EDITOR_VIEW_TYPE } from "../document/moduleSourcesEditorProvider";
import { loadModuleEditorFacets, type ModuleEditorFacets } from "./moduleEditorFacets";
import { ModuleTextEditorSession } from "./moduleTextEditorSession";
import { createReadonlyShellHtml, readonlyShellTitle } from "./readonlyShell";
import type { DebugFacetWindowBridge, DebugFacetWindowMessage } from "../debug/debugFacetWindowBridge";

export const DEFAULT_EDITOR_VIEW_TYPE = "visualbridge.documentEditor";
export const OPTIONAL_EDITOR_VIEW_TYPE = "visualbridge.documentEditor.option";

interface ReadonlyShellState {
  readonly reason: ModuleEditorFallbackReason;
  readonly message: string;
  readonly moduleId?: string;
}

interface ReadonlyShell {
  readonly documentUri: vscode.Uri;
  readonly panel: vscode.WebviewPanel;
  readonly match: DocumentMatch;
  state: ReadonlyShellState;
  text: string;
}

export class DocumentEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly textSessions = new Map<string, Set<ModuleTextEditorSession>>();
  /** 调试 facet 增量的 Webview 转发桥（G1a）；在扩展激活装配完后由 `attachDebugFacetWindowBridge` 注入。 */
  private debugFacetWindow: DebugFacetWindowBridge | undefined;
  private readonly pendingReveals = new Map<string, unknown>();
  private readonly initializedPanels = new Map<string, Set<vscode.WebviewPanel>>();
  /** 同一文档可以开多个只读 Shell（split），每个面板各自维护原因文案。 */
  private readonly readonlyShells = new Map<string, Set<ReadonlyShell>>();
  private readonly pendingReopens = new Set<string>();
  /** 文本会话面板 → 它所属的文档；模块转 failed/stale 时据此关闭会话。 */
  private readonly sessionPanels = new Map<
    vscode.WebviewPanel,
    { readonly documentUri: vscode.Uri; readonly match: DocumentMatch }
  >();
  private readonly sessionDiagnostics = new Map<
    string,
    Map<symbol, readonly vscode.Diagnostic[]>
  >();
  private refreshingShells = false;
  private readonly documentOpenedEmitter = new vscode.EventEmitter<DocumentMatch>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
    private readonly modules: HostModuleRegistry,
  ) {}

  /**
   * 文本编辑器会话打开完成（E10：宿主据此在"图页面打开"时按需连接 Runtime 桥）。
   * 只发成功打开的事件；模块回退/多源编辑器不算。
   */
  public readonly onDidOpenDocument = this.documentOpenedEmitter.event;

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const match = this.projects.resolveDocument(document.uri);
    if (match === undefined) {
      webviewPanel.dispose();
      await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      return;
    }

    // 模块未装载（未信任 / 加载失败 / 已停用 / 未声明）时回退只读 Shell：不进入领域会话，
    // 也不把文档交给多源编辑器，从而保证 Restricted Mode 下不执行任何模块代码。
    await this.modules.ensureProject(match.project);
    const availability = this.modules.editorAvailability(match.project, match.documentType.editor);
    if (availability.kind === "unavailable") {
      this.showReadonlyShell(document, webviewPanel, match, availability);
      return;
    }

    const facets = await this.loadFacets(match, availability.moduleId);
    if (facets === undefined) {
      webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [] };
      webviewPanel.title = `${match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
      webviewPanel.webview.html = createEditorHtml(webviewPanel.webview, match, document.getText());
      this.registerFallbackPanel(document, webviewPanel);
      return;
    }

    if (facets.storage === "sources") {
      webviewPanel.dispose();
      await vscode.commands.executeCommand("vscode.openWith", document.uri, SOURCES_EDITOR_VIEW_TYPE);
      return;
    }

    webviewPanel.title = `${match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
    const diagnosticsOwner = this.createDiagnosticsOwner(document.uri);
    const session = new ModuleTextEditorSession({
      extensionUri: this.extensionUri,
      document,
      panel: webviewPanel,
      match,
      projects: this.projects,
      references: this.references,
      publishDiagnostics: diagnosticsOwner.publish,
      output: this.output,
      facets,
      controller: facets.createController(),
      options: moduleOptions(match, availability.moduleId),
      onWebviewReady: () => this.hydrateDebugFacetSession(session),
      onDebugFacetResync: (message) => this.debugFacetWindow?.handleWebviewMessage(facets.editor, message).replies ?? [],
    });
    const uriKey = document.uri.toString();
    let sessions = this.textSessions.get(uriKey);
    if (sessions === undefined) {
      sessions = new Set();
      this.textSessions.set(uriKey, sessions);
    }
    sessions.add(session);
    this.sessionPanels.set(webviewPanel, { documentUri: document.uri, match });
    const panelSubscription = webviewPanel.onDidDispose(() => {
      this.sessionPanels.delete(webviewPanel);
      diagnosticsOwner.dispose();
      this.removeSession(uriKey, session);
    });
    try {
      await session.open();
      const pendingReveal = this.pendingReveals.get(uriKey);
      if (pendingReveal !== undefined) {
        this.pendingReveals.delete(uriKey);
        await session.reveal(pendingReveal);
      }
      // E10：页面已真正打开（webview 会话就绪）才通知宿主按需连接 Runtime 桥。
      this.documentOpenedEmitter.fire(match);
    } catch (error) {
      panelSubscription.dispose();
      this.sessionPanels.delete(webviewPanel);
      diagnosticsOwner.dispose();
      this.removeSession(uriKey, session);
      throw error;
    }
  }

  public isEditorReady(uri: vscode.Uri): boolean {
    const uriKey = uri.toString();
    return [...this.textSessions.get(uriKey) ?? []].some((session) => session.isReady)
      || (this.initializedPanels.get(uriKey)?.size ?? 0) > 0;
  }

  /** 只读 Shell 的当前状态（宿主测试断言用）。 */
  public getReadonlyShellState(uri: vscode.Uri): {
    readonly active: boolean;
    readonly reason?: ModuleEditorFallbackReason;
    readonly message?: string;
    readonly moduleId?: string;
  } {
    const shells = this.readonlyShells.get(uri.toString());
    const shell = shells === undefined ? undefined : [...shells][0];
    if (shell === undefined) return { active: false };
    return {
      active: true,
      reason: shell.state.reason,
      message: shell.state.message,
      ...(shell.state.moduleId === undefined ? {} : { moduleId: shell.state.moduleId }),
    };
  }

  /**
   * 模块状态变化后重算：
   * - 领域会话失去模块时关闭，避免继续跑领域代码；
   * - 已可用的只读 Shell 重新按正常路径打开，其余只更新提示文案。
   * 模块装载完成（例如授予 Trust）后无需重载窗口。
   */
  public refreshModuleAvailability(): void {
    this.closeUnavailableSessions();
    if (this.refreshingShells || this.readonlyShells.size === 0) return;
    this.refreshingShells = true;
    const reopen: vscode.Uri[] = [];
    try {
      for (const [uriKey, shells] of [...this.readonlyShells]) {
        for (const shell of [...shells]) {
          if (this.readonlyShells.get(uriKey) !== shells) continue;
          const availability = this.modules.editorAvailability(shell.match.project, shell.match.documentType.editor);
          if (availability.kind === "available") {
            shell.panel.dispose();
            reopen.push(shell.documentUri);
            continue;
          }
          this.updateReadonlyShell(shell, availability);
        }
      }
    } finally {
      this.refreshingShells = false;
    }
    for (const uri of reopen) this.scheduleEditorReopen(uri);
  }

  public getGraphEditorTestState(uri: vscode.Uri): {
    readonly sessionCount: number;
    readonly readySessionCount: number;
    readonly activeSessionCount: number;
    readonly visibleSessionCount: number;
    readonly maxReadyGeneration: number;
    readonly diagnosticOwnerCount: number;
    readonly publishedDiagnosticCount: number;
    readonly sessionIds: readonly number[];
    readonly readyTokens: readonly string[];
    readonly lastRevealResults: readonly {
      readonly target: unknown;
      readonly found: boolean;
    }[];
    readonly debugStates: readonly unknown[];
  } {
    const uriKey = uri.toString();
    const sessions = [...this.textSessions.get(uriKey) ?? []];
    const states = sessions.map((session) => session.testState);
    return {
      sessionCount: states.length,
      readySessionCount: states.filter((state) => state.ready).length,
      activeSessionCount: states.filter((state) => state.active).length,
      visibleSessionCount: states.filter((state) => state.visible).length,
      sessionIds: sessions.map((session) => session.testSessionId),
      readyTokens: states.flatMap((state) => state.readyToken === undefined ? [] : [state.readyToken]),
      lastRevealResults: states.flatMap((state) => (
        state.lastRevealResult === undefined ? [] : [state.lastRevealResult]
      )),
      debugStates: sessions.flatMap((session) => session.debugTestState === undefined ? [] : [session.debugTestState]),
      maxReadyGeneration: states.reduce(
        (maximum, state) => Math.max(maximum, state.readyGeneration),
        0,
      ),
      diagnosticOwnerCount: this.sessionDiagnostics.get(uriKey)?.size ?? 0,
      publishedDiagnosticCount: this.diagnostics.get(uri)?.length ?? 0,
    };
  }

  /** 首个 Graph 会话的执行调试状态（测试轮询用）。 */
  public getGraphEditorDebugState(uri: vscode.Uri): unknown {
    return [...this.textSessions.get(uri.toString()) ?? []][0]?.debugTestState;
  }

  /** 向首个 Graph 会话注入执行调试消息（带 token，与真实 Webview 同路径）。 */
  public async sendGraphEditorDebugMessage(uri: vscode.Uri, message: unknown): Promise<void> {
    const session = [...this.textSessions.get(uri.toString()) ?? []][0];
    if (session === undefined) throw new Error("No active graph editor session was found.");
    await session.sendDebugMessageForTest(message);
  }

  /** 装配调试 facet 的 Webview 转发桥（G1a；必须在 `DebugFacetHost.rebuild` 之前调用）。 */
  public attachDebugFacetWindowBridge(bridge: DebugFacetWindowBridge): void {
    this.debugFacetWindow = bridge;
    for (const sessions of this.textSessions.values()) {
      for (const session of sessions) {
        this.hydrateDebugFacetSession(session);
      }
    }
  }

  /** 向某 editor 的全部已打开 Webview 广播（桥的 `broadcast` 回调）。 */
  public broadcastDebugFacet(editor: string, message: DebugFacetWindowMessage): number {
    let posted = 0;
    for (const sessions of this.textSessions.values()) {
      for (const session of sessions) {
        if (!session.matchesEditor(editor)) continue;
        void session.postHostMessage(message);
        posted += 1;
      }
    }

    return posted;
  }

  /** Graph 执行调试窗口的 facet 状态（G1a 宿主测试；与旧 `getGraphEditorDebugState` 分开）。 */
  public getGraphEditorFacetDebugState(uri: vscode.Uri): {
    readonly sessions: readonly unknown[];
    readonly lastAck?: unknown;
  } {
    const sessions = [...this.textSessions.get(uri.toString()) ?? []];
    const lastAck = sessions
      .map((session) => session.debugFacetTestState.lastAck)
      .find((ack) => ack !== undefined);
    return {
      sessions: sessions.map((session) => session.debugFacetTestState),
      ...(lastAck === undefined ? {} : { lastAck }),
    };
  }

  private hydrateDebugFacetSession(session: ModuleTextEditorSession): void {
    const bridge = this.debugFacetWindow;
    if (bridge === undefined || !session.isReady) return;
    for (const message of bridge.snapshotMessages(session.editorName)) {
      void session.postHostMessage(message);
    }
  }

  public getEntityEditorTestState(uri: vscode.Uri): {
    readonly sessionCount: number;
    readonly readySessionCount: number;
    readonly lastRevealResults: readonly {
      readonly target: unknown;
      readonly found: boolean;
    }[];
  } {
    const states = [...this.textSessions.get(uri.toString()) ?? []].map((session) => session.testState);
    return {
      sessionCount: states.length,
      readySessionCount: states.filter((state) => state.ready).length,
      lastRevealResults: states.flatMap((state) => (
        state.lastRevealResult === undefined ? [] : [state.lastRevealResult]
      )),
    };
  }

  public assertIdentityOperationsAllowedForTest(
    uri: vscode.Uri,
    editor: string,
    operations: unknown,
  ): void {
    const session = [...this.textSessions.get(uri.toString()) ?? []][0];
    if (session === undefined) throw new Error(`No active ${editor} editor session was found.`);
    session.assertOperationsAllowedForTest(operations);
  }

  public async applyOperationsForTest(
    uri: vscode.Uri,
    editor: string,
    operations: unknown,
    revisionOverride?: number,
  ): Promise<void> {
    const session = [...this.textSessions.get(uri.toString()) ?? []][0];
    if (session === undefined) throw new Error(`No active ${editor} editor session was found.`);
    await session.applyOperationsForTest(operations, revisionOverride);
  }

  /** 最近一次拒绝文案（宿主测试断言"可读提示"用）。 */
  public getLastRejection(uri: vscode.Uri): string | undefined {
    return [...this.textSessions.get(uri.toString()) ?? []][0]?.lastRejection;
  }

  /** 最近一次 `operationCompleted`（宿主测试断言宿主盖章的修订号用）。 */
  public getLastOperationCompleted(uri: vscode.Uri): Readonly<Record<string, unknown>> | undefined {
    return [...this.textSessions.get(uri.toString()) ?? []][0]?.lastOperationCompleted;
  }

  public async applyOperationsAfterExternalWriteForTest(
    uri: vscode.Uri,
    externalText: string,
    operations: unknown,
  ): Promise<void> {
    const session = [...this.textSessions.get(uri.toString()) ?? []][0];
    if (session === undefined) throw new Error("No active structured editor session was found.");
    await session.applyOperationsAfterExternalWriteForTest(externalText, operations);
  }

  /** 元素级定位：目标形状由模块的 `reveal` facet 解析（Graph 节点 / Entity 组件…）。 */
  public async revealElementReference(location: ReferenceLocation): Promise<void> {
    if (!isProjectRelativePath(location.path)) {
      throw new Error("Invalid VisualBridge reference location.");
    }
    const project = this.projects.projects.find(
      (candidate) => candidate.definition.projectId === location.projectId,
    );
    if (project === undefined) {
      throw new Error(`VisualBridge Project '${location.projectId}' is not open.`);
    }
    const uri = vscode.Uri.joinPath(project.rootUri, ...location.path.split("/"));
    const match = this.projects.resolveDocument(uri);
    if (match?.project.markerUri.toString() !== project.markerUri.toString()
      || match.documentType.id !== location.documentTypeId) {
      throw new Error("Reference location is outside its declared Project Document Type.");
    }
    await this.modules.ensureProject(project);
    const availability = this.modules.editorAvailability(project, match.documentType.editor);
    if (availability.kind === "unavailable") {
      // 只读回退：定位目标形状由模块解析，模块未加载时不解析任何领域数据，只打开只读 Shell。
      await vscode.commands.executeCommand("vscode.openWith", uri, OPTIONAL_EDITOR_VIEW_TYPE);
      return;
    }
    const facets = await this.loadFacets(match, availability.moduleId);
    const target = facets?.reveal?.readTarget(location);
    if (target === undefined) {
      throw new Error(facets?.reveal?.invalidLocationMessage ?? "Invalid VisualBridge reference location.");
    }
    const uriKey = uri.toString();
    const session = [...this.textSessions.get(uriKey) ?? []][0];
    if (session !== undefined) {
      await session.reveal(target);
      return;
    }
    this.pendingReveals.set(uriKey, target);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, OPTIONAL_EDITOR_VIEW_TYPE);
    } catch (error) {
      if (this.pendingReveals.get(uriKey) === target) {
        this.pendingReveals.delete(uriKey);
      }
      throw error;
    }
  }

  private async loadFacets(match: DocumentMatch, moduleId: string): Promise<ModuleEditorFacets | undefined> {
    try {
      const bundle = this.modules.modulesFor(match.project)
        .find((module) => module.id === moduleId)?.bundle;
      return await loadModuleEditorFacets(
        match.project,
        moduleId,
        match.documentType.editor,
        bundle,
        { references: this.references, log: (line) => this.output.appendLine(line) },
      );
    } catch (errorValue) {
      this.output.appendLine(`[modules] Editor facets for '${moduleId}' failed to load: ${String(errorValue)}`);
      return undefined;
    }
  }

  private registerFallbackPanel(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
    const documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      void webviewPanel.webview.postMessage({ type: "documentChanged", text: event.document.getText() });
    });
    const projectSubscription = this.projects.onDidChange(() => {
      const refreshedMatch = this.projects.resolveDocument(document.uri);
      if (refreshedMatch === undefined) {
        webviewPanel.dispose();
        void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      }
    });
    webviewPanel.onDidDispose(() => {
      documentSubscription.dispose();
      projectSubscription.dispose();
      this.removeInitializedPanel(document.uri.toString(), webviewPanel);
    });
    this.addInitializedPanel(document.uri.toString(), webviewPanel);
  }

  private closeUnavailableSessions(): void {
    for (const [panel, owner] of [...this.sessionPanels]) {
      const availability = this.modules.editorAvailability(owner.match.project, owner.match.documentType.editor);
      // `stale` 只是模块定义变化→重载的瞬态；等重载落定再决定是否关闭。
      if (availability.kind === "available" || availability.reason === "stale") continue;
      panel.dispose();
      this.scheduleEditorReopen(owner.documentUri);
    }
  }

  /**
   * 面板 dispose 与重新打开不能在同一拍：VS Code 会聚焦正在关闭的标签页，
   * 最终没有编辑器被真正打开（Restricted Mode 授予 Trust 后的自动装载路径）。
   */
  private scheduleEditorReopen(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.pendingReopens.has(key)) return;
    this.pendingReopens.add(key);
    setTimeout(() => {
      this.pendingReopens.delete(key);
      void vscode.commands.executeCommand("vscode.openWith", uri, OPTIONAL_EDITOR_VIEW_TYPE).then(
        undefined,
        (errorValue: unknown) => {
          this.output.appendLine(`[modules] Reopening '${key}' failed: ${String(errorValue)}`);
        },
      );
    }, 50);
  }

  private showReadonlyShell(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    match: DocumentMatch,
    availability: Extract<ModuleEditorAvailability, { readonly kind: "unavailable" }>,
  ): void {
    const uriKey = document.uri.toString();
    webviewPanel.webview.options = { enableScripts: false, localResourceRoots: [] };
    webviewPanel.title = readonlyShellTitle(match, document.uri);
    webviewPanel.webview.html = createReadonlyShellHtml(webviewPanel.webview, match, document.getText(), availability.message);

    const shell: ReadonlyShell = {
      documentUri: document.uri,
      panel: webviewPanel,
      match,
      state: {
        reason: availability.reason,
        message: availability.message,
        ...(availability.moduleId === undefined ? {} : { moduleId: availability.moduleId }),
      },
      text: document.getText(),
    };
    let shells = this.readonlyShells.get(uriKey);
    if (shells === undefined) {
      shells = new Set();
      this.readonlyShells.set(uriKey, shells);
    }
    shells.add(shell);

    const documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== uriKey) return;
      shell.text = event.document.getText();
      webviewPanel.webview.html = createReadonlyShellHtml(webviewPanel.webview, match, shell.text, shell.state.message);
    });
    const projectSubscription = this.projects.onDidChange(() => {
      if (this.projects.resolveDocument(document.uri) === undefined) {
        webviewPanel.dispose();
        void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
        return;
      }
      this.refreshModuleAvailability();
    });
    webviewPanel.onDidDispose(() => {
      documentSubscription.dispose();
      projectSubscription.dispose();
      shell.text = "";
      shells?.delete(shell);
      if (shells !== undefined && shells.size === 0) this.readonlyShells.delete(uriKey);
      this.removeInitializedPanel(uriKey, webviewPanel);
    });
    this.addInitializedPanel(uriKey, webviewPanel);
    this.output.appendLine(
      `[modules] '${match.relativePath}' uses the read-only shell (${availability.reason}).`,
    );
  }

  private updateReadonlyShell(
    shell: ReadonlyShell,
    availability: Extract<ModuleEditorAvailability, { readonly kind: "unavailable" }>,
  ): void {
    if (shell.state.reason === availability.reason && shell.state.message === availability.message) return;
    shell.state = {
      reason: availability.reason,
      message: availability.message,
      ...(availability.moduleId === undefined ? {} : { moduleId: availability.moduleId }),
    };
    shell.panel.webview.html = createReadonlyShellHtml(shell.panel.webview, shell.match, shell.text, availability.message);
  }

  private removeSession(uriKey: string, session: ModuleTextEditorSession): void {
    const sessions = this.textSessions.get(uriKey);
    sessions?.delete(session);
    if (sessions?.size === 0) {
      this.textSessions.delete(uriKey);
    }
  }

  private createDiagnosticsOwner(uri: vscode.Uri): {
    readonly publish: (diagnostics: readonly vscode.Diagnostic[]) => void;
    readonly dispose: () => void;
  } {
    const uriKey = uri.toString();
    const owner = Symbol(uriKey);
    let disposed = false;
    return {
      publish: (diagnostics) => {
        if (disposed) {
          return;
        }
        let snapshots = this.sessionDiagnostics.get(uriKey);
        if (snapshots === undefined) {
          snapshots = new Map();
          this.sessionDiagnostics.set(uriKey, snapshots);
        }
        snapshots.set(owner, diagnostics);
        this.publishDiagnostics(uri, snapshots);
      },
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const snapshots = this.sessionDiagnostics.get(uriKey);
        snapshots?.delete(owner);
        if (snapshots === undefined || snapshots.size === 0) {
          this.sessionDiagnostics.delete(uriKey);
          this.diagnostics.delete(uri);
          return;
        }
        this.publishDiagnostics(uri, snapshots);
      },
    };
  }

  private publishDiagnostics(
    uri: vscode.Uri,
    snapshots: ReadonlyMap<symbol, readonly vscode.Diagnostic[]>,
  ): void {
    const published = new Map<string, vscode.Diagnostic>();
    for (const diagnostics of snapshots.values()) {
      for (const diagnostic of diagnostics) {
        published.set(diagnosticIdentity(diagnostic), diagnostic);
      }
    }
    this.diagnostics.set(uri, [...published.values()]);
  }

  private addInitializedPanel(uriKey: string, panel: vscode.WebviewPanel): void {
    let panels = this.initializedPanels.get(uriKey);
    if (panels === undefined) {
      panels = new Set();
      this.initializedPanels.set(uriKey, panels);
    }
    panels.add(panel);
  }

  private removeInitializedPanel(uriKey: string, panel: vscode.WebviewPanel): void {
    const panels = this.initializedPanels.get(uriKey);
    panels?.delete(panel);
    if (panels?.size === 0) {
      this.initializedPanels.delete(uriKey);
    }
  }
}

function moduleOptions(match: DocumentMatch, moduleId: string): Record<string, import("@visualbridge/core").JsonValue> | undefined {
  return match.project.definition.modules.find((module) => module.id === moduleId)?.options;
}

function diagnosticIdentity(diagnostic: vscode.Diagnostic): string {
  const code = typeof diagnostic.code === "object"
    ? `${diagnostic.code.value}:${diagnostic.code.target.toString()}`
    : String(diagnostic.code ?? "");
  const { start, end } = diagnostic.range;
  return [
    start.line,
    start.character,
    end.line,
    end.character,
    diagnostic.severity,
    diagnostic.source ?? "",
    code,
    diagnostic.message,
  ].join("\u0000");
}

function isProjectRelativePath(value: string): boolean {
  return !value.includes("\\")
    && !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function createEditorHtml(
  webview: vscode.Webview,
  match: DocumentMatch,
  documentText: string,
): string {
  const nonce = createNonce();
  const initialText = JSON.stringify(documentText).replaceAll("<", "\\u003c");
  const projectId = escapeHtml(match.project.definition.projectId);
  const documentType = escapeHtml(match.documentType.id);
  const editor = escapeHtml(match.documentType.editor);
  const relativePath = escapeHtml(match.relativePath);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>VisualBridge Editor</title>
  <style>
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
    dt { font-weight: 600; }
    dd { margin: 0; font-family: var(--vscode-editor-font-family); }
    main { padding: 20px; }
    .notice { margin: 0 0 12px; color: var(--vscode-descriptionForeground); }
    pre { box-sizing: border-box; min-height: 240px; margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; border: 1px solid var(--vscode-input-border); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  </style>
</head>
<body>
  <header>
    <h1>VisualBridge Document</h1>
    <dl>
      <dt>Project</dt><dd>${projectId}</dd>
      <dt>Type</dt><dd>${documentType}</dd>
      <dt>Editor module</dt><dd>${editor}</dd>
      <dt>Path</dt><dd>${relativePath}</dd>
    </dl>
  </header>
  <main>
    <p class="notice">The document shell is active. Domain-specific editing will load here.</p>
    <pre id="source"></pre>
  </main>
  <script nonce="${nonce}">
    const source = document.getElementById('source');
    source.textContent = ${initialText};
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'documentChanged') {
        source.textContent = event.data.text;
      }
    });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
