import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  containsReferenceRefactorGuardedRename,
  REFERENCE_REFACTOR_REQUIRED_MESSAGE,
} from "../document/lifecycleOperationGuard";
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import {
  GRAPH_EDITOR_ID,
  applyGraphOperations,
  collectGraphReferences,
  findDanglingGraphElementReferenceDiagnostics,
  getReplacementCandidates,
  parseGraphDocument,
  serializeGraphDocument,
  validateGraphDocument,
} from "@visualbridge/graph";
import {
  GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
  GraphRevealMailbox,
  createGraphEditorHtml,
  type GraphRevealTarget,
} from "@visualbridge/graph-editor";
import { loadGraphCatalogRegistry } from "../catalog/graphCatalogLoader";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";
import { handleReferenceMessage } from "../reference/referenceMessages";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import { GraphExecutionDebugController, type GraphExecutionDebugTestState } from "./graphExecutionDebugController";
import { WebviewEpoch } from "./webviewEpoch";

const OVERWRITE = "覆盖";
const DISCARD_AND_RELOAD = "放弃并刷新";
let nextGraphEditorSessionId = 0;

interface WebviewMessage {
  readonly type?: unknown;
  readonly webviewToken?: unknown;
  readonly instanceId?: unknown;
  readonly documentVersion?: unknown;
  readonly operations?: unknown;
  readonly graphId?: unknown;
  readonly nodeId?: unknown;
  readonly text?: unknown;
  readonly requestId?: unknown;
  readonly definition?: unknown;
  readonly value?: unknown;
  readonly found?: unknown;
  readonly message?: unknown;
  readonly executionId?: unknown;
  readonly eventCount?: unknown;
  readonly cursor?: unknown;
  readonly executingNodeId?: unknown;
  readonly mode?: unknown;
}

interface GraphStateOptions {
  readonly documentChanged?: boolean;
  readonly historyAction?: "undo" | "redo";
}

export class GraphEditorSession {
  public readonly testSessionId = ++nextGraphEditorSessionId;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly catalogDisposables: vscode.Disposable[] = [];
  // TextDocument 冲突刻意比较解码后的 UTF-8 文本；Project Transaction 使用精确字节 Hash。
  private baseDiskTextHash = "";
  private operationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private webviewReady = false;
  private readyGeneration = 0;
  private readonly webviewEpoch = new WebviewEpoch();
  private readonly revealMailbox = new GraphRevealMailbox();
  private lastRevealResult: { readonly target: GraphRevealTarget; readonly found: boolean } | undefined;
  private readonly debugController: GraphExecutionDebugController;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private match: DocumentMatch,
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly publishDiagnostics: (diagnostics: readonly vscode.Diagnostic[]) => void,
    private readonly output: vscode.OutputChannel,
  ) {
    // 执行调试使用独立 Runtime 连接（观察者语义），不与 DAP 检查会话共享。
    this.debugController = new GraphExecutionDebugController({
      postMessage: (message) => this.postMessage(message),
      getDocumentId: () => {
        const parseResult = parseGraphDocument(this.document.getText());
        return parseResult.success ? parseResult.document.documentId : undefined;
      },
      output: (line) => this.output.appendLine(`[graph-debug] ${line}`),
    });
  }

  public async open(): Promise<void> {
    this.baseDiskTextHash = await this.readDiskTextHash();
    this.webviewEpoch.begin(createNonce());
    const nonce = createNonce();
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewRoot, "graphEditor.js"),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(webviewRoot, "graphEditor.css"),
    );
    this.panel.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    this.panel.webview.html = createGraphEditorHtml({
      cspSource: this.panel.webview.cspSource,
      nonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
      metadata: {
        projectId: this.match.project.definition.projectId,
        documentType: this.match.documentType.id,
        relativePath: this.match.relativePath,
      },
    });

    this.configureCatalogWatchers();
    let webviewWasVisible = this.panel.visible;

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        const webviewEpoch = this.webviewEpoch.capture();
        this.operationQueue = this.operationQueue
          .then(() => this.handleMessage(message, webviewEpoch))
          .catch((error: unknown) => {
            if (!this.isCurrentWebviewEpoch(webviewEpoch)
              || (message.type !== "ready" && !this.webviewEpoch.acceptsMessage(message.webviewToken))) {
              return;
            }
            this.output.appendLine(`[graph] Operation failed: ${formatError(error)}`);
            if (message.type === "ready") {
              return;
            }
            return this.rejectOperation(`Graph 操作失败：${formatError(error)}`);
          });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (sameUri(event.document.uri, this.document.uri)) {
          void this.sendState({
            documentChanged: true,
            ...(event.reason === vscode.TextDocumentChangeReason.Undo
              ? { historyAction: "undo" as const }
              : event.reason === vscode.TextDocumentChangeReason.Redo
                ? { historyAction: "redo" as const }
                : {}),
          });
        } else if (this.getCatalogUris().some((catalogUri) => sameUri(event.document.uri, catalogUri))) {
          void this.sendState();
        }
      }),
      // WorkspaceEdit 的变更事件与 isDirty 落脏存在时序窗口，磁盘基线不能在这里提前更新。
      vscode.workspace.onDidSaveTextDocument((savedDocument) => {
        if (sameUri(savedDocument.uri, this.document.uri)) {
          this.baseDiskTextHash = hashText(savedDocument.getText());
          void this.sendState();
        }
      }),
      this.projects.onDidChange(() => {
        const nextMatch = this.projects.resolveDocument(this.document.uri);
        if (nextMatch === undefined || nextMatch.documentType.editor !== GRAPH_EDITOR_ID) {
          this.panel.dispose();
          void vscode.commands.executeCommand("vscode.openWith", this.document.uri, "default");
          return;
        }
        this.match = nextMatch;
        this.configureCatalogWatchers();
        void this.sendState();
      }),
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.onDidChangeViewState((event) => {
        const visible = event.webviewPanel.visible;
        if (!visible && webviewWasVisible) {
          this.webviewEpoch.invalidate();
          this.webviewReady = false;
          this.revealMailbox.markUnavailable();
        } else if (visible && !webviewWasVisible) {
          this.webviewEpoch.begin(createNonce());
          void this.requestWebviewReady();
        }
        webviewWasVisible = visible;
      }),
    );
    void this.requestWebviewReady();
  }

  public async reveal(target: GraphRevealTarget): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.revealMailbox.enqueue(target);
    this.panel.reveal();
    await this.sendPendingReveal();
  }

  public get isReady(): boolean {
    return this.webviewReady
      && this.webviewEpoch.isReady
      && !this.disposed
      && this.panel.active
      && this.panel.visible;
  }

  public assertIdentityOperationsAllowedForTest(operations: unknown): void {
    if (containsReferenceRefactorGuardedRename("graph", operations)) {
      throw new Error(REFERENCE_REFACTOR_REQUIRED_MESSAGE);
    }
  }

  public async applyOperationsForTest(operations: unknown): Promise<void> {
    const webviewToken = this.webviewEpoch.currentToken;
    if (!this.isReady || webviewToken === undefined) {
      throw new Error("No ready Graph editor session was found.");
    }
    const webviewEpoch = this.webviewEpoch.capture();
    const operation = this.operationQueue
      .catch(() => undefined)
      .then(() => this.handleMessage({
        type: "applyOperations",
        webviewToken,
        documentVersion: this.document.version,
        operations,
      }, webviewEpoch));
    this.operationQueue = operation;
    await operation;
  }

  /** 测试注入执行调试消息（带 epoch token，与真实 Webview 消息同路径）。 */
  public async sendDebugMessageForTest(message: unknown): Promise<void> {
    const webviewToken = this.webviewEpoch.currentToken;
    if (!this.isReady || webviewToken === undefined) {
      throw new Error("No ready Graph editor session was found.");
    }
    const webviewEpoch = this.webviewEpoch.capture();
    const operation = this.operationQueue
      .catch(() => undefined)
      .then(() => this.handleMessage({
        ...(message as { readonly type?: unknown }),
        webviewToken,
      }, webviewEpoch));
    this.operationQueue = operation;
    await operation;
  }

  public get debugTestState(): GraphExecutionDebugTestState {
    return this.debugController.testState;
  }

  public get testState(): {
    readonly ready: boolean;
    readonly readyGeneration: number;
    readonly readyToken?: string;
    readonly active: boolean;
    readonly visible: boolean;
    readonly lastRevealResult?: { readonly target: GraphRevealTarget; readonly found: boolean };
    readonly debugState?: GraphExecutionDebugTestState;
  } {
    const state = {
      ready: this.webviewReady && this.webviewEpoch.isReady && !this.disposed,
      readyGeneration: this.readyGeneration,
      active: this.panel.active,
      visible: this.panel.visible,
      ...(this.lastRevealResult === undefined ? {} : { lastRevealResult: this.lastRevealResult }),
      debugState: this.debugController.testState,
    };
    const readyToken = this.webviewEpoch.isReady ? this.webviewEpoch.currentToken : undefined;
    return readyToken === undefined ? state : { ...state, readyToken };
  }

  private async handleMessage(message: WebviewMessage, webviewEpoch: number): Promise<void> {
    if (!this.isCurrentWebviewEpoch(webviewEpoch)) {
      return;
    }
    if (message.type === "ready") {
      await this.handleReady(message, webviewEpoch);
      return;
    }
    if (!this.webviewEpoch.acceptsMessage(message.webviewToken)) {
      return;
    }
    if (message.type === GRAPH_REVEAL_RESULT_MESSAGE_TYPE) {
      if (typeof message.requestId !== "string" || typeof message.found !== "boolean") {
        return;
      }
      const delivered = this.revealMailbox.deliverable;
      if (this.revealMailbox.acknowledge(message.requestId)) {
        if (delivered?.requestId === message.requestId) {
          this.lastRevealResult = { target: delivered.target, found: message.found };
        }
        if (!message.found) {
          this.output.appendLine(
            `[graph] Reveal target was not found in ${this.match.relativePath}: ${typeof message.message === "string" ? message.message : "unknown target"}`,
          );
        }
      }
      return;
    }
    if (await handleReferenceMessage(message, this.panel.webview, this.match.project, this.references)) {
      return;
    }
    if (message.type === "requestReplacementCandidates") {
      await this.sendReplacementCandidates(message);
      return;
    }
    if (message.type === "writeClipboard") {
      if (typeof message.text === "string" && message.text.length <= 2_000_000) {
        await vscode.env.clipboard.writeText(message.text);
      }
      return;
    }
    if (message.type === "readClipboard") {
      await this.postMessage({ type: "clipboardData", text: await vscode.env.clipboard.readText() });
      return;
    }
    if (message.type === "requestGraphExecutionInstances"
      || message.type === "subscribeGraphExecution"
      || message.type === "unsubscribeGraphExecution"
      || message.type === "requestGraphExecutionDebugState"
      || message.type === "graphDebugAck") {
      await this.debugController.handleWebviewMessage(message);
      return;
    }
    if (message.type !== "applyOperations") {
      return;
    }
    if (typeof message.documentVersion !== "number" || message.documentVersion !== this.document.version) {
      await this.sendState();
      await this.rejectOperation("文档已发生变化，编辑器已刷新，请重试刚才的操作。");
      return;
    }
    const documentVersion = message.documentVersion;
    // 节点/接口端口/动态端口删除是普通单文件 Operation：不再路由到 Safe Delete，
    // 同文档悬空引用由 apply 流程的引用检查拒绝，跨文档引用由持有方校验兜底。
    if (containsReferenceRefactorGuardedRename("graph", message.operations)) {
      await this.rejectOperation(REFERENCE_REFACTOR_REQUIRED_MESSAGE);
      return;
    }
    if (!await this.confirmExternalChanges()) {
      return;
    }
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
      return;
    }

    const parseResult = parseGraphDocument(this.document.getText());
    if (!parseResult.success) {
      this.updateDiagnostics(parseResult.diagnostics);
      await this.sendInvalid(parseResult.diagnostics);
      await this.rejectOperation("Graph Document 当前无效，无法应用操作。");
      return;
    }

    const catalogResult = await loadGraphCatalogRegistry(
      this.match.project,
      this.match.documentType.catalogs,
    );
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
      return;
    }
    if (!catalogResult.ready && operationsRequireCatalog(message.operations)) {
      this.updateDiagnostics([...parseResult.diagnostics, ...catalogResult.diagnostics]);
      await this.rejectOperation(formatCatalogUnavailable(catalogResult.diagnostics));
      return;
    }
    const operationResult = applyGraphOperations(parseResult.document, message.operations, catalogResult.registry);
    if (!operationResult.success) {
      this.updateDiagnostics([...catalogResult.diagnostics, ...operationResult.diagnostics]);
      await this.rejectOperation(formatDiagnostics(operationResult.diagnostics));
      return;
    }
    // 元素删除是单文件 Operation：同文档内仍引用被删元素时原子拒绝。
    const dangling = findDanglingGraphElementReferenceDiagnostics(
      parseResult.document,
      operationResult.document,
      catalogResult.registry,
    );
    if (dangling.length > 0) {
      this.updateDiagnostics([...catalogResult.diagnostics, ...operationResult.diagnostics, ...dangling]);
      await this.rejectOperation(formatDiagnostics(dangling));
      return;
    }
    if (catalogResult.ready) {
      const referenceResult = await this.references.validateChange(
        this.match.project,
        collectGraphReferences(parseResult.document, catalogResult.registry),
        collectGraphReferences(operationResult.document, catalogResult.registry),
      );
      if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
        return;
      }
      if (referenceResult.introducedErrors.length > 0) {
        this.updateDiagnostics([...catalogResult.diagnostics, ...operationResult.diagnostics, ...referenceResult.diagnostics]);
        await this.rejectOperation(formatDiagnostics(referenceResult.introducedErrors));
        return;
      }
    }

    const nextText = serializeGraphDocument(operationResult.document);
    const providerDiagnostics = await this.references.validateProviderDocument(this.match.project, {
      documentTypeId: this.match.documentType.id,
      path: this.match.relativePath,
      sourceHash: hashText(nextText),
      content: operationResult.document as unknown as JsonValue,
    });
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
      return;
    }
    const providerErrors = providerDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (providerErrors.length > 0) {
      this.updateDiagnostics([...catalogResult.diagnostics, ...operationResult.diagnostics, ...providerDiagnostics]);
      await this.rejectOperation(formatDiagnostics(providerErrors));
      return;
    }
    if (nextText === this.document.getText()) {
      await this.postMessage({
        type: "operationCompleted",
        documentVersion: this.document.version,
        changed: false,
      });
      await this.sendState();
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullDocumentRange(this.document), nextText);
    if (!await vscode.workspace.applyEdit(edit)) {
      await this.rejectOperation("VS Code 未能应用 Graph 修改。");
      return;
    }

    this.output.appendLine(
      `[graph] Applied operations to ${this.match.relativePath} at document version ${this.document.version}.`,
    );
    await this.postMessage({
      type: "operationCompleted",
      documentVersion: this.document.version,
      changed: true,
    });
    await this.sendState();
  }

  private async confirmExternalChanges(): Promise<boolean> {
    const diskBytes = await vscode.workspace.fs.readFile(this.document.uri);
    const diskText = new TextDecoder("utf-8", { fatal: true }).decode(diskBytes);
    const diskTextHash = hashText(diskText);
    if (diskTextHash === this.baseDiskTextHash) {
      return true;
    }
    if (diskText === this.document.getText()) {
      this.baseDiskTextHash = diskTextHash;
      return true;
    }

    if (!this.document.isDirty) {
      this.baseDiskTextHash = diskTextHash;
      if (diskText !== this.document.getText()) {
        await this.replaceDocumentText(diskText);
        if (!await this.document.save()) {
          await this.rejectOperation("文件已发生外部修改，但 VS Code 未能完成刷新。");
          return false;
        }
        await this.sendState();
        await this.rejectOperation("文件已被外部修改，编辑器已刷新，请重试刚才的操作。");
        return false;
      }
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `Graph 文件 '${this.match.relativePath}' 已被外部修改。`,
      { modal: true, detail: "覆盖将保留当前编辑内容；放弃并刷新将丢弃尚未保存的本地修改。" },
      OVERWRITE,
      DISCARD_AND_RELOAD,
    );
    if (choice === OVERWRITE) {
      this.baseDiskTextHash = diskTextHash;
      return true;
    }
    if (choice === DISCARD_AND_RELOAD) {
      await this.replaceDocumentText(diskText);
      const saved = await this.document.save();
      if (!saved) {
        await this.rejectOperation("无法完成放弃并刷新，文档未保存。");
        return false;
      }
      this.baseDiskTextHash = diskTextHash;
      await this.sendState();
      await this.rejectOperation("已放弃本地修改并读取磁盘版本。");
      return false;
    }

    await this.rejectOperation("已取消操作，未写入任何修改。");
    return false;
  }

  private async replaceDocumentText(text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullDocumentRange(this.document), text);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error("VS Code rejected the document refresh edit.");
    }
  }

  private async sendState(options: GraphStateOptions = {}): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const webviewEpoch = this.webviewEpoch.capture();
    const documentVersion = this.document.version;
    const sourceText = this.document.getText();
    const result = parseGraphDocument(sourceText);
    this.updateDiagnostics(result.diagnostics);
    if (!result.success) {
      return this.sendInvalid(result.diagnostics, options);
    }
    const catalogResult = await loadGraphCatalogRegistry(
      this.match.project,
      this.match.documentType.catalogs,
    );
    const diagnostics = [
      ...result.diagnostics,
      ...catalogResult.diagnostics,
      ...(catalogResult.ready ? validateGraphDocument(result.document, catalogResult.registry) : []),
      ...(catalogResult.ready
        ? await this.references.validate(
            this.match.project,
            collectGraphReferences(result.document, catalogResult.registry),
          )
        : []),
      ...await this.references.validateProviderDocument(this.match.project, {
        documentTypeId: this.match.documentType.id,
        path: this.match.relativePath,
        sourceHash: hashText(sourceText),
        content: result.document as unknown as JsonValue,
      }),
    ];
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
      return false;
    }
    this.updateDiagnostics(diagnostics);
    return this.postMessage({
      type: "graphState",
      documentVersion: this.document.version,
      document: result.document,
      catalogRegistry: catalogResult.registry,
      catalogReady: catalogResult.ready,
      isDirty: this.document.isDirty,
      ...(options.documentChanged === true ? { documentChanged: true } : {}),
      ...(options.historyAction === undefined ? {} : { historyAction: options.historyAction }),
      diagnostics,
    });
  }

  private async sendReplacementCandidates(message: WebviewMessage): Promise<void> {
    if (
      typeof message.documentVersion !== "number"
      || message.documentVersion !== this.document.version
      || typeof message.graphId !== "string"
      || typeof message.nodeId !== "string"
    ) {
      await this.sendState();
      return;
    }
    const parseResult = parseGraphDocument(this.document.getText());
    if (!parseResult.success) {
      await this.sendInvalid(parseResult.diagnostics);
      return;
    }
    const catalogResult = await loadGraphCatalogRegistry(
      this.match.project,
      this.match.documentType.catalogs,
    );
    await this.postMessage({
      type: "replacementCandidates",
      documentVersion: this.document.version,
      graphId: message.graphId,
      nodeId: message.nodeId,
      nodeTypeIds: catalogResult.ready
        ? getReplacementCandidates(
            parseResult.document,
            message.graphId,
            message.nodeId,
            catalogResult.registry,
          ).map((nodeType) => nodeType.id)
        : [],
    });
  }

  private async sendPendingReveal(): Promise<void> {
    const pendingReveal = this.revealMailbox.deliverable;
    if (this.disposed || pendingReveal === undefined) {
      return;
    }
    if (!await this.postMessage(pendingReveal)) {
      this.revealMailbox.markUnavailable();
    }
  }

  private getCatalogUris(): readonly vscode.Uri[] {
    return this.match.documentType.catalogs.map(
      (catalogPath) => vscode.Uri.joinPath(this.match.project.rootUri, ...catalogPath.split("/")),
    );
  }

  private configureCatalogWatchers(): void {
    for (const disposable of this.catalogDisposables.splice(0)) {
      disposable.dispose();
    }
    this.match.documentType.catalogs.forEach((catalogPath) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        this.match.project.rootUri,
        catalogPath,
      ));
      this.catalogDisposables.push(
        watcher,
        watcher.onDidCreate(() => void this.sendState()),
        watcher.onDidChange(() => void this.sendState()),
        watcher.onDidDelete(() => void this.sendState()),
      );
    });
  }

  private async sendInvalid(
    diagnostics: readonly DocumentDiagnostic[],
    options: GraphStateOptions = {},
  ): Promise<boolean> {
    return this.postMessage({
      type: "graphInvalid",
      documentVersion: this.document.version,
      isDirty: this.document.isDirty,
      ...(options.documentChanged === true ? { documentChanged: true } : {}),
      ...(options.historyAction === undefined ? {} : { historyAction: options.historyAction }),
      diagnostics,
    });
  }

  private async rejectOperation(message: string): Promise<void> {
    await this.postMessage({ type: "operationRejected", message });
  }

  private updateDiagnostics(items: readonly DocumentDiagnostic[]): void {
    if (this.disposed) {
      return;
    }
    const diagnostics = items.map((item) => {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        `${item.path}: ${item.message}`,
        item.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.code = item.code;
      diagnostic.source = "VisualBridge";
      return diagnostic;
    });
    this.publishDiagnostics(diagnostics);
  }

  private async readDiskTextHash(): Promise<string> {
    try {
      const diskText = new TextDecoder("utf-8", { fatal: true }).decode(
        await vscode.workspace.fs.readFile(this.document.uri),
      );
      return hashText(diskText);
    } catch {
      return hashText(this.document.getText());
    }
  }

  private async handleReady(message: WebviewMessage, webviewEpoch: number): Promise<void> {
    if (typeof message.instanceId !== "string" || message.instanceId.length === 0) {
      return;
    }
    if (message.webviewToken === undefined) {
      await this.requestWebviewReady();
      return;
    }
    if (!this.panel.visible || !this.webviewEpoch.canAcceptReady(message.webviewToken)) {
      return;
    }
    if (!await this.sendState()
      || !this.isCurrentWebviewEpoch(webviewEpoch)
      || !this.panel.visible
      || !this.webviewEpoch.markReady(message.webviewToken)) {
      return;
    }
    this.webviewReady = true;
    this.readyGeneration += 1;
    this.revealMailbox.markReady();
    await this.sendPendingReveal();
  }

  private async requestWebviewReady(): Promise<void> {
    const token = this.webviewEpoch.currentToken;
    if (this.disposed || !this.panel.visible || token === undefined) {
      return;
    }
    await this.postMessage({ type: "requestReady", webviewToken: token });
  }

  private async postMessage(message: unknown): Promise<boolean> {
    if (this.disposed) return false;
    try {
      return await this.panel.webview.postMessage(message);
    } catch (errorValue) {
      if (!this.disposed && !/Webview is disposed/u.test(formatError(errorValue))) {
        this.output.appendLine(`[graph] Failed to post a Webview message for ${this.match.relativePath}: ${formatError(errorValue)}`);
      }
      return false;
    }
  }

  private isCurrentWebviewEpoch(webviewEpoch: number): boolean {
    return !this.disposed && this.webviewEpoch.isCurrent(webviewEpoch);
  }

  private isCurrentOperation(documentVersion: number, webviewEpoch: number): boolean {
    return this.document.version === documentVersion && this.isCurrentWebviewEpoch(webviewEpoch);
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.webviewEpoch.invalidate();
    this.webviewReady = false;
    // 关闭页面即退订：断开执行调试的 Runtime 连接（§19.5 断开语义）。
    this.debugController.dispose();
    for (const disposable of this.catalogDisposables.splice(0)) {
      disposable.dispose();
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function createNonce(): string {
  return createHash("sha256")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex");
}

function formatDiagnostics(diagnostics: readonly DocumentDiagnostic[]): string {
  const first = diagnostics[0];
  return first === undefined ? "Graph 操作无效。" : `${first.path}: ${first.message}`;
}

function formatCatalogUnavailable(diagnostics: readonly DocumentDiagnostic[]): string {
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return firstError === undefined
    ? "Graph Catalog 尚未就绪，无法执行依赖 Catalog 的操作。"
    : `Graph Catalog 尚未就绪：${firstError.path}: ${firstError.message}`;
}

function operationsRequireCatalog(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((operation) => {
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
      return false;
    }
    const candidate = operation as {
      readonly type?: unknown;
      readonly node?: { readonly nodeTypeId?: unknown };
      readonly subgraph?: { readonly graphTypeId?: unknown };
    };
    const type = candidate.type;
    if (type === "graph.addSubgraph") {
      return typeof candidate.node?.nodeTypeId === "string"
        || typeof candidate.subgraph?.graphTypeId === "string";
    }
    return typeof type === "string" && CATALOG_OPERATION_TYPES.has(type);
  });
}

const CATALOG_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "graph.addNode",
  "graph.replaceNodeType",
  "graph.addDynamicPort",
  "graph.updateDynamicPort",
  "graph.addEdge",
  "graph.assignType",
]);

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
