import { createHash, randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  applyProjectOperations,
  parseProjectFile,
  type ProjectFileIssue,
} from "@visualbridge/core";
import { createProjectEditorHtml } from "@visualbridge/project-editor";
import { validateCatalogBindings } from "../catalog/catalogBrowser";
import { WebviewEpoch } from "../editor/webviewEpoch";
import type { ProjectRegistry } from "./projectRegistry";

export const PROJECT_SETTINGS_EDITOR_VIEW_TYPE = "visualbridge.projectSettingsEditor";

interface WebviewMessage {
  readonly type?: unknown;
  readonly webviewToken?: unknown;
  readonly instanceId?: unknown;
  readonly documentVersion?: unknown;
  readonly sourceHash?: unknown;
  readonly operations?: unknown;
}

export class ProjectSettingsEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly sessions = new Map<string, Set<ProjectSettingsEditorSession>>();
  private readonly mutationQueues = new Map<string, Promise<void>>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectRegistry,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const session = new ProjectSettingsEditorSession(
      this.extensionUri,
      document,
      panel,
      this.projects,
      this.output,
      (mutation) => this.enqueueMutation(document.uri, mutation),
      () => this.removeSession(document.uri, session),
    );
    const key = document.uri.toString();
    const entries = this.sessions.get(key) ?? new Set<ProjectSettingsEditorSession>();
    entries.add(session);
    this.sessions.set(key, entries);
    await session.open();
  }

  public isReady(uri: vscode.Uri): boolean {
    return [...this.sessions.get(uri.toString()) ?? []].some((session) => session.isReady);
  }

  public getTestState(uri: vscode.Uri): ProjectSettingsTestState | undefined {
    return [...this.sessions.get(uri.toString()) ?? []][0]?.testState;
  }

  public async applyOperationsForTest(
    uri: vscode.Uri,
    sourceHash: string,
    operations: unknown,
  ): Promise<ProjectSettingsTestState> {
    const session = [...this.sessions.get(uri.toString()) ?? []][0];
    if (session === undefined) throw new Error("No Project Settings editor session is active.");
    await session.applyOperations(sourceHash, operations);
    return session.testState;
  }

  public dispose(): void {
    for (const sessions of this.sessions.values()) sessions.forEach((session) => session.dispose());
    this.sessions.clear();
  }

  private removeSession(uri: vscode.Uri, session: ProjectSettingsEditorSession): void {
    const key = uri.toString();
    const entries = this.sessions.get(key);
    entries?.delete(session);
    if (entries?.size === 0) this.sessions.delete(key);
  }

  private enqueueMutation(uri: vscode.Uri, mutation: () => Promise<void>): Promise<void> {
    const key = uri.toString();
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(mutation).finally(() => {
      if (this.mutationQueues.get(key) === current) this.mutationQueues.delete(key);
    });
    this.mutationQueues.set(key, current);
    return current;
  }
}

interface ProjectSettingsTestState {
  readonly ready: boolean;
  readonly documentVersion: number;
  readonly sourceHash: string;
  readonly isDirty: boolean;
  readonly projectId?: string;
  readonly issues: readonly ProjectFileIssue[];
}

class ProjectSettingsEditorSession {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly webviewEpoch = new WebviewEpoch();
  private baseDiskHash = "";
  private operationQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly projects: ProjectRegistry,
    private readonly output: vscode.OutputChannel,
    private readonly runExclusive: (mutation: () => Promise<void>) => Promise<void>,
    private readonly onDispose: () => void,
  ) {}

  public async open(): Promise<void> {
    this.baseDiskHash = await this.readDiskHash();
    this.webviewEpoch.begin(createNonce());
    const nonce = createNonce();
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    this.panel.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    this.panel.webview.html = createProjectEditorHtml({
      cspSource: this.panel.webview.cspSource,
      nonce,
      scriptUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "projectEditor.js")).toString(),
      styleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "projectEditor.css")).toString(),
    });
    this.panel.title = "VisualBridge Project Settings";
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        const epoch = this.webviewEpoch.capture();
        this.operationQueue = this.operationQueue.then(() => this.handleMessage(message, epoch)).catch((error) => {
          this.output.appendLine(`[project-settings] ${formatError(error)}`);
          return this.rejectOperation(`Project Settings 操作失败：${formatError(error)}`);
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (sameUri(event.document.uri, this.document.uri)) void this.sendState();
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (sameUri(saved.uri, this.document.uri)) {
          void this.readDiskHash().then((hash) => { this.baseDiskHash = hash; });
        }
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
    void this.requestReady();
  }

  public get isReady(): boolean {
    return !this.disposed && this.webviewEpoch.isReady;
  }

  public get testState(): ProjectSettingsTestState {
    const parsed = parseProjectFile(this.document.getText());
    return {
      ready: this.isReady,
      documentVersion: this.document.version,
      sourceHash: hashText(this.document.getText()),
      isDirty: this.document.isDirty,
      ...(parsed.success ? { projectId: parsed.value.projectId, issues: [] } : { issues: parsed.issues }),
    };
  }

  public async applyOperations(sourceHash: string, operations: unknown): Promise<void> {
    return this.runExclusive(() => this.applyOperationsExclusive(sourceHash, operations));
  }

  private async applyOperationsExclusive(sourceHash: string, operations: unknown): Promise<void> {
    if (hashText(this.document.getText()) !== sourceHash) {
      throw new Error("Project Settings sourceHash conflict; the document changed before apply.");
    }
    await this.assertNoExternalChange();
    const parsed = parseProjectFile(this.document.getText());
    if (!parsed.success) throw new Error("Project File is invalid and cannot accept structured Operations.");
    const result = applyProjectOperations(parsed.value, operations);
    if (!result.success) throw new Error(formatIssues(result.issues));
    const duplicate = this.projects.projects.find((project) => (
      !sameUri(project.markerUri, this.document.uri)
      && project.definition.projectId === result.document.projectId
    ));
    if (duplicate !== undefined) throw new Error(`Project ID '${result.document.projectId}' already exists in the workspace.`);
    const workspaceIssues = await this.projects.validateDefinition(this.document.uri, result.document);
    if (workspaceIssues.length > 0) throw new Error(workspaceIssues.join("\n"));
    const catalogIssues = await validateCatalogBindings({
      markerUri: this.document.uri,
      rootUri: this.document.uri.with({ path: this.document.uri.path.replace(/\/[^/]+$/, "") }),
      definition: result.document,
    });
    if (catalogIssues.length > 0) throw new Error(formatIssues(catalogIssues));
    if (hashText(this.document.getText()) !== sourceHash) {
      throw new Error("Project Settings sourceHash conflict; the document changed during validation.");
    }
    await this.assertNoExternalChange();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullDocumentRange(this.document), result.text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code rejected the Project Settings WorkspaceEdit.");
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.webviewEpoch.invalidate();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.onDispose();
  }

  private async handleMessage(message: WebviewMessage, epoch: number): Promise<void> {
    if (!this.webviewEpoch.isCurrent(epoch)) return;
    if (message.type === "ready") {
      if (typeof message.instanceId !== "string" || message.instanceId.length === 0) return;
      if (message.webviewToken === undefined) {
        await this.requestReady();
        return;
      }
      if (this.webviewEpoch.markReady(String(message.webviewToken))) await this.sendState();
      return;
    }
    if (!this.webviewEpoch.acceptsMessage(message.webviewToken) || message.type !== "applyOperations") return;
    if (message.documentVersion !== this.document.version || typeof message.sourceHash !== "string") {
      await this.sendState();
      await this.rejectOperation("Project File 已发生变化，页面已刷新，请重试。");
      return;
    }
    try {
      await this.applyOperations(message.sourceHash, message.operations);
    } catch (error) {
      await this.rejectOperation(formatError(error));
    }
  }

  private async requestReady(): Promise<void> {
    const token = this.webviewEpoch.currentToken;
    if (token !== undefined) await this.panel.webview.postMessage({ type: "requestReady", webviewToken: token });
  }

  private async sendState(): Promise<void> {
    if (!this.webviewEpoch.isReady || this.disposed) return;
    const text = this.document.getText();
    const parsed = parseProjectFile(text);
    await this.panel.webview.postMessage(parsed.success ? {
      type: "projectState",
      documentVersion: this.document.version,
      sourceHash: hashText(text),
      project: parsed.value,
      isDirty: this.document.isDirty,
      issues: [],
    } : {
      type: "projectInvalid",
      documentVersion: this.document.version,
      sourceHash: hashText(text),
      isDirty: this.document.isDirty,
      issues: parsed.issues,
    });
  }

  private async rejectOperation(message: string): Promise<void> {
    if (!this.webviewEpoch.isReady || this.disposed) return;
    await this.panel.webview.postMessage({ type: "operationRejected", message });
  }

  private async assertNoExternalChange(): Promise<void> {
    const diskHash = await this.readDiskHash();
    const expected = this.document.isDirty ? this.baseDiskHash : hashText(this.document.getText());
    if (diskHash !== expected) {
      throw new Error("Project File changed on disk outside this editor; reload or compare it before retrying.");
    }
  }

  private async readDiskHash(): Promise<string> {
    return hashBytes(await vscode.workspace.fs.readFile(this.document.uri));
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
}

function hashText(value: string): string {
  return hashBytes(new TextEncoder().encode(value));
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createNonce(): string {
  return randomBytes(24).toString("base64url");
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function formatIssues(issues: readonly ProjectFileIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
