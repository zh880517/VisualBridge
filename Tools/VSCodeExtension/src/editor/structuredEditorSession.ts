import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as vscode from "vscode";
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import {
  STRUCTURED_EDITOR_ID,
  applyStructuredOperations,
  collectStructuredReferences,
  parseStructuredDocument,
  resolveStructuredConfigType,
  serializeStructuredDocument,
  validateStructuredDocument,
} from "@visualbridge/structured";
import { createStructuredEditorHtml } from "@visualbridge/structured-editor";
import { loadStructuredCatalogRegistry } from "../catalog/structuredCatalogLoader";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";
import { handleReferenceMessage } from "../reference/referenceMessages";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import { WebviewEpoch } from "./webviewEpoch";

const OVERWRITE = "覆盖";
const DISCARD_AND_RELOAD = "放弃并刷新";

interface WebviewMessage {
  readonly type?: unknown;
  readonly webviewToken?: unknown;
  readonly instanceId?: unknown;
  readonly documentVersion?: unknown;
  readonly operations?: unknown;
  readonly requestId?: unknown;
  readonly definition?: unknown;
  readonly value?: unknown;
}

interface StructuredStateOptions {
  readonly documentChanged?: boolean;
  readonly historyAction?: "undo" | "redo";
}

export class StructuredEditorSession {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly catalogDisposables: vscode.Disposable[] = [];
  // TextDocument conflicts intentionally compare decoded UTF-8 text. Project Transactions use exact-byte hashes.
  private baseDiskTextHash = "";
  private operationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private webviewReady = false;
  private readonly webviewEpoch = new WebviewEpoch();
  private confirmExternalChangesTestHook: (() => Promise<void>) | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private match: DocumentMatch,
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly publishDiagnostics: (diagnostics: readonly vscode.Diagnostic[]) => void,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async open(): Promise<void> {
    this.baseDiskTextHash = await this.readDiskTextHash();
    this.webviewEpoch.begin(createNonce());
    const nonce = createNonce();
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "structuredEditor.js"));
    const styleUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "structuredEditor.css"));
    this.panel.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    this.panel.webview.html = createStructuredEditorHtml({
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
          .catch((errorValue: unknown) => {
            if (!this.isCurrentWebviewEpoch(webviewEpoch)
              || (message.type !== "ready" && !this.webviewEpoch.acceptsMessage(message.webviewToken))) {
              return;
            }
            this.output.appendLine(`[structured] Operation failed: ${formatError(errorValue)}`);
            if (message.type === "ready") {
              return;
            }
            return this.rejectOperation(`Structured Config 操作失败：${formatError(errorValue)}`);
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
            this.baseDiskTextHash = hashText(event.document.getText());
          }
        } else if (this.getCatalogUris().some((catalogUri) => sameUri(event.document.uri, catalogUri))) {
          void this.sendState();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((savedDocument) => {
        if (sameUri(savedDocument.uri, this.document.uri)) {
          this.baseDiskTextHash = hashText(savedDocument.getText());
          void this.sendState();
        }
      }),
      this.projects.onDidChange(() => {
        const nextMatch = this.projects.resolveDocument(this.document.uri);
        if (nextMatch === undefined || nextMatch.documentType.editor !== STRUCTURED_EDITOR_ID) {
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
        } else if (visible && !webviewWasVisible) {
          this.webviewEpoch.begin(createNonce());
          void this.requestWebviewReady();
        }
        webviewWasVisible = visible;
      }),
    );
    void this.requestWebviewReady();
  }

  public get isReady(): boolean {
    return this.webviewReady
      && this.webviewEpoch.isReady
      && !this.disposed
      && this.panel.active
      && this.panel.visible;
  }

  public async applyOperationsForTest(operations: unknown): Promise<void> {
    const webviewToken = this.webviewEpoch.currentToken;
    if (!this.isReady || webviewToken === undefined) {
      throw new Error("No ready Structured editor session was found.");
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

  public async applyOperationsAfterExternalWriteForTest(
    externalText: string,
    operations: unknown,
  ): Promise<void> {
    writeFileSync(this.document.uri.fsPath, externalText, "utf8");
    this.confirmExternalChangesTestHook = async () => {
      if (!await this.reloadDocumentFromDisk(externalText)) {
        throw new Error("VS Code failed to reload the deterministic external-change test refresh.");
      }
      this.baseDiskTextHash = hashText(externalText);
    };
    try {
      await this.applyOperationsForTest(operations);
    } finally {
      this.confirmExternalChangesTestHook = undefined;
    }
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
    if (await handleReferenceMessage(message, this.panel.webview, this.match.project, this.references)) {
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
    if (!await this.confirmExternalChanges()) {
      return;
    }
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
      return;
    }

    const parseResult = parseStructuredDocument(this.document.getText());
    if (!parseResult.success) {
      this.updateDiagnostics(parseResult.diagnostics);
      await this.sendInvalid(parseResult.diagnostics);
      await this.rejectOperation("Structured Config 当前无效，无法应用操作。");
      return;
    }
    const catalogResult = await loadStructuredCatalogRegistry(this.match.project, this.match.documentType.catalogs);
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
      return;
    }
    if (!catalogResult.ready) {
      this.updateDiagnostics([...parseResult.diagnostics, ...catalogResult.diagnostics]);
      await this.rejectOperation(formatCatalogUnavailable(catalogResult.diagnostics));
      return;
    }
    const operationResult = applyStructuredOperations(
      parseResult.document,
      message.operations,
      catalogResult.registry,
      this.match.documentType.id,
    );
    if (!operationResult.success) {
      this.updateDiagnostics([...catalogResult.diagnostics, ...operationResult.diagnostics]);
      await this.rejectOperation(formatDiagnostics(operationResult.diagnostics));
      return;
    }
    const referenceResult = await this.references.validateChange(
      this.match.project,
      collectStructuredReferences(parseResult.document, catalogResult.registry, this.match.documentType.id),
      collectStructuredReferences(operationResult.document, catalogResult.registry, this.match.documentType.id),
    );
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) {
      return;
    }
    if (referenceResult.introducedErrors.length > 0) {
      this.updateDiagnostics([
        ...catalogResult.diagnostics,
        ...operationResult.diagnostics,
        ...referenceResult.diagnostics,
      ]);
      await this.rejectOperation(formatDiagnostics(referenceResult.introducedErrors));
      return;
    }

    const nextText = serializeStructuredDocument(operationResult.document);
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
      await this.rejectOperation("VS Code 未能应用 Structured Config 修改。");
      return;
    }
    this.output.appendLine(
      `[structured] Applied operations to ${this.match.relativePath} at document version ${this.document.version}.`,
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
    const testHook = this.confirmExternalChangesTestHook;
    this.confirmExternalChangesTestHook = undefined;
    await testHook?.();
    if (diskTextHash === this.baseDiskTextHash) {
      return true;
    }
    if (!this.document.isDirty) {
      if (diskText !== this.document.getText()) {
        if (!await this.reloadDocumentFromDisk(diskText)) {
          await this.rejectOperation("文件已发生外部修改，但 VS Code 未能完成刷新。");
          return false;
        }
        this.baseDiskTextHash = diskTextHash;
        await this.sendState();
        await this.rejectOperation("文件已被外部修改，编辑器已刷新，请重试刚才的操作。");
        return false;
      }
      this.baseDiskTextHash = diskTextHash;
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `Structured Config '${this.match.relativePath}' 已被外部修改。`,
      { modal: true, detail: "覆盖将保留当前编辑内容；放弃并刷新将丢弃尚未保存的本地修改。" },
      OVERWRITE,
      DISCARD_AND_RELOAD,
    );
    if (choice === OVERWRITE) {
      this.baseDiskTextHash = diskTextHash;
      return true;
    }
    if (choice === DISCARD_AND_RELOAD) {
      if (!await this.reloadDocumentFromDisk(diskText)) {
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

  private async reloadDocumentFromDisk(expectedText: string): Promise<boolean> {
    await vscode.commands.executeCommand("workbench.action.files.revert");
    return !this.document.isDirty && this.document.getText() === expectedText;
  }

  private async replaceDocumentText(text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullDocumentRange(this.document), text);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error("VS Code rejected the document refresh edit.");
    }
  }

  private async sendState(options: StructuredStateOptions = {}): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const webviewEpoch = this.webviewEpoch.capture();
    const documentVersion = this.document.version;
    const sourceText = this.document.getText();
    const result = parseStructuredDocument(sourceText);
    if (!result.success) {
      this.updateDiagnostics(result.diagnostics);
      return this.sendInvalid(result.diagnostics, options);
    }
    const catalogResult = await loadStructuredCatalogRegistry(this.match.project, this.match.documentType.catalogs);
    const configType = catalogResult.ready
      ? resolveStructuredConfigType(catalogResult.registry, this.match.documentType.id)
      : undefined;
    const diagnostics = [
      ...result.diagnostics,
      ...catalogResult.diagnostics,
      ...(catalogResult.ready
        ? validateStructuredDocument(result.document, catalogResult.registry, this.match.documentType.id)
        : []),
      ...(catalogResult.ready
        ? await this.references.validate(
            this.match.project,
            collectStructuredReferences(result.document, catalogResult.registry, this.match.documentType.id),
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
    if (configType === undefined) {
      return this.sendInvalid(diagnostics, options);
    }
    return this.postMessage({
      type: "structuredState",
      documentVersion: this.document.version,
      document: result.document,
      configType,
      isDirty: this.document.isDirty,
      ...(options.documentChanged === true ? { documentChanged: true } : {}),
      ...(options.historyAction === undefined ? {} : { historyAction: options.historyAction }),
      diagnostics,
    });
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
    options: StructuredStateOptions = {},
  ): Promise<boolean> {
    return this.postMessage({
      type: "structuredInvalid",
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
    this.publishDiagnostics(items.map((item) => {
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
        this.output.appendLine(`[structured] Failed to post a Webview message for ${this.match.relativePath}: ${formatError(errorValue)}`);
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
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex");
}

function formatDiagnostics(diagnostics: readonly DocumentDiagnostic[]): string {
  const first = diagnostics[0];
  return first === undefined ? "Structured Config 操作无效。" : `${first.path}: ${first.message}`;
}

function formatCatalogUnavailable(diagnostics: readonly DocumentDiagnostic[]): string {
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return firstError === undefined
    ? "Structured Catalog 尚未就绪。"
    : `Structured Catalog 尚未就绪：${firstError.path}: ${firstError.message}`;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
