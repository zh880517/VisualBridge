/**
 * Table 编辑器的模块门禁。
 *
 * `visualbridge.tableEditor` 是独立注册的 Custom Editor，Table 文档可以不经
 * `visualbridge.openDocument` 被直接打开（`vscode.openWith`、新建命令、reveal、
 * 未保存文档面板）。这里用 wrapper provider 在所有入口上做同一道检查：
 * Table 模块未加载时不解析任何表格源，只渲染只读 Shell。
 */
import * as vscode from "vscode";
import type { HostModuleRegistry } from "../modules/hostModuleRegistry";
import type { ModuleEditorAvailability } from "../modules/moduleRegistration";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";
import { createReadonlyShellHtml, readonlyShellTitle } from "./readonlyShell";
import { TABLE_EDITOR_VIEW_TYPE, type TableCustomDocument, type TableEditorProvider } from "./tableEditorProvider";

type Unavailable = Extract<ModuleEditorAvailability, { readonly kind: "unavailable" }>;

/** 只读 Shell 的占位文档：不解析表格源，也不进入 Table 领域会话。 */
class ReadonlyShellDocument implements vscode.CustomDocument {
  public constructor(
    public readonly uri: vscode.Uri,
    public readonly match: DocumentMatch,
    public readonly availability: Unavailable,
  ) {}

  public dispose(): void {}
}

type GatedTableDocument = TableCustomDocument | ReadonlyShellDocument;

/** 只读 Shell 的写入语义：四个 CustomDocument 写入口一律明确拒绝，不做静默 no-op。 */
const READONLY_SHELL_WRITE_MESSAGE = "A read-only VisualBridge shell cannot be saved, reverted, or backed up.";

interface ShellPanel {
  readonly panel: vscode.WebviewPanel;
  readonly documentUri: vscode.Uri;
  readonly match: DocumentMatch;
  readonly document: ReadonlyShellDocument;
  reason: string;
  message: string;
}

interface TablePanelOwner {
  readonly uri: vscode.Uri;
  readonly match: DocumentMatch;
  readonly document: TableCustomDocument;
}

export class TableEditorGate implements vscode.CustomEditorProvider<GatedTableDocument>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<GatedTableDocument>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly shells = new Map<string, Set<ShellPanel>>();
  private readonly tablePanels = new Map<vscode.WebviewPanel, TablePanelOwner>();
  private readonly pendingReopens = new Set<string>();
  private readonly warnedDirty = new Set<string>();

  public readonly onDidChangeCustomDocument = this.changeEmitter.event;

  public constructor(
    private readonly delegate: TableEditorProvider,
    private readonly projects: ProjectRegistry,
    private readonly modules: HostModuleRegistry,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(
      this.changeEmitter,
      this.delegate.onDidChangeCustomDocument((event) => {
        this.changeEmitter.fire(event as unknown as vscode.CustomDocumentEditEvent<GatedTableDocument>);
      }),
    );
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<GatedTableDocument> {
    const match = this.projects.resolveDocument(uri);
    if (match !== undefined) {
      await this.modules.ensureProject(match.project);
      const availability = this.modules.editorAvailability(match.project, match.documentType.editor);
      if (availability.kind === "unavailable") {
        this.output.appendLine(
          `[modules] '${match.relativePath}' table editor gated (${availability.reason}).`,
        );
        return new ReadonlyShellDocument(uri, match, availability);
      }
    }
    return this.delegate.openCustomDocument(uri, openContext);
  }

  public async resolveCustomEditor(
    document: GatedTableDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (document instanceof ReadonlyShellDocument) {
      this.showShell(document, webviewPanel);
      return;
    }
    // 记录真实 Table 会话面板：模块失效时必须关闭，不能继续跑表格领域代码。
    const match = this.projects.resolveDocument(document.uri);
    if (match !== undefined) {
      this.tablePanels.set(webviewPanel, { uri: document.uri, match, document });
      webviewPanel.onDidDispose(() => this.tablePanels.delete(webviewPanel));
    }
    await this.delegate.resolveCustomEditor(document, webviewPanel);
  }

  public saveCustomDocument(document: GatedTableDocument, _token: vscode.CancellationToken): Promise<void> {
    return document instanceof ReadonlyShellDocument
      ? Promise.reject(new Error(READONLY_SHELL_WRITE_MESSAGE))
      : this.delegate.saveCustomDocument(document);
  }

  public saveCustomDocumentAs(
    document: GatedTableDocument,
    destination: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    return document instanceof ReadonlyShellDocument
      ? Promise.reject(new Error(READONLY_SHELL_WRITE_MESSAGE))
      : this.delegate.saveCustomDocumentAs(document, destination);
  }

  public revertCustomDocument(document: GatedTableDocument, _token: vscode.CancellationToken): Promise<void> {
    return document instanceof ReadonlyShellDocument
      ? Promise.reject(new Error(READONLY_SHELL_WRITE_MESSAGE))
      : this.delegate.revertCustomDocument(document);
  }

  public backupCustomDocument(
    document: GatedTableDocument,
    context: vscode.CustomDocumentBackupContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    if (document instanceof ReadonlyShellDocument) {
      return Promise.reject(new Error(READONLY_SHELL_WRITE_MESSAGE));
    }
    return this.delegate.backupCustomDocument(document, context);
  }

  /**
   * 仅测试用：对只读 Shell 调用四个 CustomDocument 写入口，返回被拒绝的入口名。
   * 四个入口都必须是明确拒绝（而不是静默 no-op），否则"只读"在 VS Code 侧无法观察到。
   */
  public async assertReadonlyShellRejectsWritesForTest(uri: vscode.Uri): Promise<readonly string[]> {
    const entries = this.shells.get(uri.toString());
    const shell = entries === undefined ? undefined : [...entries][0];
    if (shell === undefined) return [];
    const token = new vscode.CancellationTokenSource().token;
    const operations: readonly [string, () => Promise<unknown>][] = [
      ["save", () => this.saveCustomDocument(shell.document, token)],
      ["saveAs", () => this.saveCustomDocumentAs(shell.document, shell.documentUri, token)],
      ["revert", () => this.revertCustomDocument(shell.document, token)],
      ["backup", () => this.backupCustomDocument(shell.document, { destination: shell.documentUri }, token)],
    ];
    const rejected: string[] = [];
    for (const [name, operation] of operations) {
      try {
        await operation();
      } catch {
        rejected.push(name);
      }
    }
    return rejected;
  }

  public getReadonlyShellState(uri: vscode.Uri): {
    readonly active: boolean;
    readonly reason?: string;
    readonly message?: string;
  } {
    const entries = this.shells.get(uri.toString());
    const first = entries === undefined ? undefined : [...entries][0];
    return first === undefined
      ? { active: false }
      : { active: true, reason: first.reason, message: first.message };
  }

  public isReadonlyShellActive(uri: vscode.Uri): boolean {
    return (this.shells.get(uri.toString())?.size ?? 0) > 0;
  }

  /** 模块状态变化后重算：Table 模块恢复可用时把只读 Shell 换回真实编辑器。 */
  public refreshModuleAvailability(): void {
    // 1) 已打开的真实 Table 会话在模块失效时关闭；重新打开会走门禁变成只读 Shell。
    for (const [panel, owner] of [...this.tablePanels]) {
      const availability = this.modules.editorAvailability(owner.match.project, owner.match.documentType.editor);
      const uriKey = owner.uri.toString();
      if (availability.kind === "available") {
        this.warnedDirty.delete(uriKey);
        continue;
      }
      // `stale` 只是模块定义变化→重载的瞬态；先不动面板，等重载落定再决定。
      if (availability.reason === "stale") continue;
      // dirty 的 Table 自定义文档没有 backup-on-dispose，直接 dispose 会静默丢未保存编辑；
      // 这里保留面板并提示一次，保存/关闭后再回退只读。
      if (owner.document.isDirty) {
        this.warnDirtyTable(owner.uri);
        continue;
      }
      panel.dispose();
      this.scheduleReopenUri(owner.uri);
    }
    // 2) 只读 Shell 在模块恢复后换回真实编辑器。
    for (const [uriKey, entries] of [...this.shells]) {
      for (const shell of [...entries]) {
        const availability = this.modules.editorAvailability(shell.match.project, shell.match.documentType.editor);
        if (availability.kind === "available") {
          shell.panel.dispose();
          entries.delete(shell);
          this.scheduleReopenUri(shell.documentUri);
          continue;
        }
        this.updateShell(shell, availability);
      }
      if (entries.size === 0) this.shells.delete(uriKey);
    }
  }

  public dispose(): void {
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    this.shells.clear();
    this.tablePanels.clear();
    this.pendingReopens.clear();
    this.warnedDirty.clear();
  }

  private warnDirtyTable(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.warnedDirty.has(key)) return;
    this.warnedDirty.add(key);
    void vscode.window.showWarningMessage(
      `模块已停用，'${vscode.workspace.asRelativePath(uri)}' 有未保存的表格编辑；已保留当前编辑器以免丢失，保存或关闭后再回退只读。`,
    );
  }

  private showShell(document: ReadonlyShellDocument, panel: vscode.WebviewPanel): void {
    const uriKey = document.uri.toString();
    panel.title = readonlyShellTitle(document.match, document.uri);
    panel.webview.options = { enableScripts: false, localResourceRoots: [] };
    panel.webview.html = createReadonlyShellHtml(panel.webview, document.match, "", document.availability.message);

    const entry: ShellPanel = {
      panel,
      documentUri: document.uri,
      match: document.match,
      document,
      reason: document.availability.reason,
      message: document.availability.message,
    };
    let entries = this.shells.get(uriKey);
    if (entries === undefined) {
      entries = new Set();
      this.shells.set(uriKey, entries);
    }
    entries.add(entry);

    panel.onDidDispose(() => {
      entries?.delete(entry);
      if (entries !== undefined && entries.size === 0) this.shells.delete(uriKey);
    });
  }

  private updateShell(shell: ShellPanel, availability: Unavailable): void {
    if (shell.reason === availability.reason && shell.message === availability.message) return;
    shell.reason = availability.reason;
    shell.message = availability.message;
    shell.panel.webview.html = createReadonlyShellHtml(
      shell.panel.webview,
      shell.match,
      "",
      availability.message,
    );
  }

  private scheduleReopenUri(uri: vscode.Uri): void {
    const uriKey = uri.toString();
    if (this.pendingReopens.has(uriKey)) return;
    this.pendingReopens.add(uriKey);
    // 与 DocumentEditorProvider 相同：面板 dispose 与重新打开不能同拍。
    setTimeout(() => {
      this.pendingReopens.delete(uriKey);
      void vscode.commands.executeCommand("vscode.openWith", uri, TABLE_EDITOR_VIEW_TYPE).then(
        undefined,
        (errorValue: unknown) => {
          this.output.appendLine(`[modules] Reopening '${uriKey}' with the table editor failed: ${String(errorValue)}`);
        },
      );
    }, 50);
  }
}
