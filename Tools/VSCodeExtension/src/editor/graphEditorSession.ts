import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  containsLifecycleGuardedRemoval,
  containsReferenceRefactorGuardedRename,
  lifecycleDeleteTarget,
  LIFECYCLE_REQUIRED_MESSAGE,
  REFERENCE_REFACTOR_REQUIRED_MESSAGE,
} from "../document/lifecycleOperationGuard";
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  GRAPH_EDITOR_ID,
  applyGraphOperations,
  collectGraphReferences,
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
}

interface GraphStateOptions {
  readonly documentChanged?: boolean;
  readonly historyAction?: "undo" | "redo";
}

export class GraphEditorSession {
  public readonly testSessionId = ++nextGraphEditorSessionId;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly catalogDisposables: vscode.Disposable[] = [];
  private baseDiskHash = "";
  private operationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private webviewReady = false;
  private readyGeneration = 0;
  private readonly webviewEpoch = new WebviewEpoch();
  private readonly revealMailbox = new GraphRevealMailbox();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private match: DocumentMatch,
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async open(): Promise<void> {
    this.baseDiskHash = await this.readDiskHash();
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
          if (!event.document.isDirty) {
            void this.updateDiskBaseline();
          }
        } else if (this.getCatalogUris().some((catalogUri) => sameUri(event.document.uri, catalogUri))) {
          void this.sendState();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((savedDocument) => {
        if (sameUri(savedDocument.uri, this.document.uri)) {
          void this.updateDiskBaseline().then(() => this.sendState());
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

  public get testState(): {
    readonly ready: boolean;
    readonly readyGeneration: number;
    readonly readyToken?: string;
    readonly active: boolean;
    readonly visible: boolean;
  } {
    const state = {
      ready: this.webviewReady && this.webviewEpoch.isReady && !this.disposed,
      readyGeneration: this.readyGeneration,
      active: this.panel.active,
      visible: this.panel.visible,
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
      if (this.revealMailbox.acknowledge(message.requestId)) {
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
      await this.panel.webview.postMessage({ type: "clipboardData", text: await vscode.env.clipboard.readText() });
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
    if (containsLifecycleGuardedRemoval("graph", message.operations)) {
      const target = lifecycleDeleteTarget("graph", message.operations);
      if (target === undefined || this.document.isDirty) {
        await this.rejectOperation(this.document.isDirty
          ? "lifecycle.workspaceDirty: Save or revert this document before Safe Delete."
          : LIFECYCLE_REQUIRED_MESSAGE);
        return;
      }
      const result = await vscode.commands.executeCommand("visualbridge.safeDeleteElement", {
        projectId: this.match.project.definition.projectId,
        documentTypeId: this.match.documentType.id,
        path: this.match.relativePath,
        target,
      });
      if (result !== undefined) await this.sendState({ documentChanged: true });
      return;
    }
    if (containsReferenceRefactorGuardedRename("graph", message.operations)) {
      await this.rejectOperation(REFERENCE_REFACTOR_REQUIRED_MESSAGE);
      return;
    }
    if (!await this.confirmExternalChanges()) {
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
    if (catalogResult.ready) {
      const referenceResult = await this.references.validateChange(
        this.match.project,
        collectGraphReferences(parseResult.document, catalogResult.registry),
        collectGraphReferences(operationResult.document, catalogResult.registry),
      );
      if (referenceResult.introducedErrors.length > 0) {
        this.updateDiagnostics([...catalogResult.diagnostics, ...operationResult.diagnostics, ...referenceResult.diagnostics]);
        await this.rejectOperation(formatDiagnostics(referenceResult.introducedErrors));
        return;
      }
    }

    const nextText = serializeGraphDocument(operationResult.document);
    if (nextText === this.document.getText()) {
      await this.panel.webview.postMessage({
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
    await this.panel.webview.postMessage({
      type: "operationCompleted",
      documentVersion: this.document.version,
      changed: true,
    });
    await this.sendState();
  }

  private async confirmExternalChanges(): Promise<boolean> {
    const diskBytes = await vscode.workspace.fs.readFile(this.document.uri);
    const diskHash = hashBytes(diskBytes);
    if (diskHash === this.baseDiskHash) {
      return true;
    }

    const diskText = new TextDecoder("utf-8", { fatal: true }).decode(diskBytes);
    if (!this.document.isDirty) {
      this.baseDiskHash = diskHash;
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
      this.baseDiskHash = diskHash;
      return true;
    }
    if (choice === DISCARD_AND_RELOAD) {
      await this.replaceDocumentText(diskText);
      const saved = await this.document.save();
      if (!saved) {
        await this.rejectOperation("无法完成放弃并刷新，文档未保存。");
        return false;
      }
      this.baseDiskHash = diskHash;
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
    const result = parseGraphDocument(this.document.getText());
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
    ];
    this.updateDiagnostics(diagnostics);
    return this.panel.webview.postMessage({
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
    await this.panel.webview.postMessage({
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
    if (!await this.panel.webview.postMessage(pendingReveal)) {
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
    return this.panel.webview.postMessage({
      type: "graphInvalid",
      documentVersion: this.document.version,
      isDirty: this.document.isDirty,
      ...(options.documentChanged === true ? { documentChanged: true } : {}),
      ...(options.historyAction === undefined ? {} : { historyAction: options.historyAction }),
      diagnostics,
    });
  }

  private async rejectOperation(message: string): Promise<void> {
    await this.panel.webview.postMessage({ type: "operationRejected", message });
  }

  private updateDiagnostics(items: readonly DocumentDiagnostic[]): void {
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
    this.diagnostics.set(this.document.uri, diagnostics);
  }

  private async readDiskHash(): Promise<string> {
    try {
      return hashBytes(await vscode.workspace.fs.readFile(this.document.uri));
    } catch {
      return hashText(this.document.getText());
    }
  }

  private async updateDiskBaseline(): Promise<void> {
    this.baseDiskHash = await this.readDiskHash();
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
    await this.panel.webview.postMessage({ type: "requestReady", webviewToken: token });
  }

  private isCurrentWebviewEpoch(webviewEpoch: number): boolean {
    return !this.disposed && this.webviewEpoch.isCurrent(webviewEpoch);
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.webviewEpoch.invalidate();
    this.webviewReady = false;
    for (const disposable of this.catalogDisposables.splice(0)) {
      disposable.dispose();
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.diagnostics.delete(this.document.uri);
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
