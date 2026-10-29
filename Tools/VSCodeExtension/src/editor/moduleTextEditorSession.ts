/**
 * 通用文本会话（B2）。
 *
 * Entity / Graph / Structured 三个领域的宿主侧行为在这里只有一份：epoch 与 token 握手、
 * `WorkspaceEdit` 写回、`onDidChangeTextDocument` / `onDidSaveTextDocument`、Catalog watcher、
 * 诊断发布、reference bridge、定位 mailbox 与 effect 执行器。领域逻辑全部经
 * `ModuleSessionController`（模块内的 `session` facet）完成。
 *
 * 宿主先处理、不转发给控制器的消息（附录 D.5）：生命周期握手、reference bridge、调试窗口消息；
 * 剪贴板与 `requestReplacementCandidates` 之外的未知消息一律交给控制器。
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as vscode from "vscode";
import { handleReferenceMessage } from "../reference/referenceMessages";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";
import type { DocumentDiagnostic } from "@visualbridge/core";
import type {
  ModuleEditorFacets,
  ModuleHostMessageHandler,
  ModuleRevealMailbox,
} from "./moduleEditorFacets";
import { stampRevealMessage } from "./moduleEditorFacets";
import { WebviewEpoch } from "./webviewEpoch";
import type {
  ModuleSessionCatalog,
  ModuleSessionController,
  ModuleSessionDocument,
  ModuleSessionEffect,
  ModuleSessionHost,
  ModuleSessionMessage,
  ModuleSessionStateEvent,
} from "../document/moduleSessionContract";
import {
  DEBUG_FACET_ACK_MESSAGE,
  DEBUG_FACET_RESYNC_MESSAGE,
  type DebugFacetAck,
} from "../debug/debugFacetWindowBridge";

const OVERWRITE = "覆盖";
const DISCARD_AND_RELOAD = "放弃并刷新";
const STALE_REVISION_MESSAGE = "文档已发生变化，编辑器已刷新，请重试刚才的操作。";
const READY_RETRY_INTERVAL_MS = 250;
const READY_RETRY_LIMIT = 40;
let nextTextSessionId = 0;

interface WebviewMessage extends Readonly<Record<string, unknown>> {
  readonly type?: unknown;
  readonly webviewToken?: unknown;
  readonly instanceId?: unknown;
  readonly documentVersion?: unknown;
  readonly operations?: unknown;
  readonly requestId?: unknown;
  readonly found?: unknown;
  readonly message?: unknown;
  readonly text?: unknown;
}

export interface ModuleTextEditorSessionOptions {
  readonly extensionUri: vscode.Uri;
  readonly document: vscode.TextDocument;
  readonly panel: vscode.WebviewPanel;
  readonly match: DocumentMatch;
  readonly projects: ProjectRegistry;
  readonly references: WorkspaceReferenceService;
  readonly publishDiagnostics: (diagnostics: readonly vscode.Diagnostic[]) => void;
  readonly output: vscode.OutputChannel;
  readonly facets: ModuleEditorFacets;
  readonly controller: ModuleSessionController;
  readonly options: ModuleSessionMessage | undefined;
  /** Webview 完成 epoch 握手后回调（G1a：此时才投递调试 facet 水化快照）。 */
  readonly onWebviewReady?: () => void | Promise<void>;
  /** 调试 facet 的"重新同步"请求：返回要投回**本** Webview 的消息。 */
  readonly onDebugFacetResync?: (
    message: Readonly<Record<string, unknown>>,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
}

export class ModuleTextEditorSession {
  public readonly testSessionId = ++nextTextSessionId;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly catalogDisposables: vscode.Disposable[] = [];
  /** 文本冲突比较解码后的 UTF-8 文本；Project Transaction 使用精确字节 Hash。 */
  private baseDiskTextHash = "";
  private operationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private webviewReady = false;
  private readyGeneration = 0;
  /** `requestReady` 的有界重发（与 sources 面板同一套策略：首帧消息可能丢）。 */
  private readyRetry: NodeJS.Timeout | undefined;
  private readyAttempts = 0;
  private readyExhausted = false;
  private readonly webviewEpoch = new WebviewEpoch();
  private readonly revealMailbox: ModuleRevealMailbox | undefined;
  private readonly hostMessageHandler: ModuleHostMessageHandler | undefined;
  private lastRevealResult: { readonly target: unknown; readonly found: boolean } | undefined;
  /** 最近一次推给 Webview 的拒绝文案（宿主测试断言"可读提示"用）。 */
  private lastRejectionForTest: string | undefined;
  /** 最近一次 `operationCompleted`（宿主测试断言修订号盖章用）。 */
  private lastOperationCompletedForTest: Readonly<Record<string, unknown>> | undefined;
  /** 当前文档的语义 `documentId` 缓存（G1d；按 `TextDocument.version` 失效）。 */
  private documentIdCache: { readonly version: number; readonly value: string | undefined } | undefined;
  /** 调试 facet Webview 的最近回执（G1a；宿主测试据此断言增量内容与顺序）。 */
  private lastDebugFacetAck: DebugFacetAck | undefined;
  private confirmExternalChangesTestHook: (() => Promise<void>) | undefined;
  private match: DocumentMatch;
  private readonly options: ModuleTextEditorSessionOptions;

  public constructor(options: ModuleTextEditorSessionOptions) {
    this.options = options;
    this.match = options.match;
    this.revealMailbox = options.facets.reveal?.createMailbox();
    this.hostMessageHandler = options.facets.createHostMessageHandler?.({
      match: options.match,
      postMessage: (message) => this.postMessage(message),
      getText: () => options.document.getText(),
      log: (line) => options.output.appendLine(`[${options.facets.editor}-debug] ${line}`),
    });
  }

  public async open(): Promise<void> {
    const { document, panel, facets } = this.options;
    this.baseDiskTextHash = await this.readDiskTextHash();
    this.webviewEpoch.begin(createNonce());
    const nonce = createNonce();
    const webviewRoot = vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview");
    // 脚本/样式来自模块 bundle 的解包目录（`<globalStorage>/modules/<sha256>/`），
    // 不再是 `dist/webview` 下按 editor 命名的静态文件；两者都要进 localResourceRoots。
    const scriptUri = panel.webview.asWebviewUri(facets.webview.script);
    const styleUri = panel.webview.asWebviewUri(facets.webview.style);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot, facets.webview.resourceRoot],
    };
    panel.webview.html = facets.webview.createHtml({
      cspSource: panel.webview.cspSource,
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
    let webviewWasVisible = panel.visible;

    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        const webviewEpoch = this.webviewEpoch.capture();
        this.operationQueue = this.operationQueue
          .then(() => this.handleMessage(message, webviewEpoch))
          .catch((errorValue: unknown) => {
            if (!this.isCurrentWebviewEpoch(webviewEpoch)
              || (message.type !== "ready" && !this.webviewEpoch.acceptsMessage(message.webviewToken))) {
              return;
            }
            this.options.output.appendLine(`[${facets.editor}] Operation failed: ${formatError(errorValue)}`);
            if (message.type === "ready") {
              return;
            }
            return this.rejectOperation(`${editorLabel(facets.editor)} 操作失败：${formatError(errorValue)}`);
          });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (sameUri(event.document.uri, document.uri)) {
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
        if (sameUri(savedDocument.uri, document.uri)) {
          this.baseDiskTextHash = hashText(savedDocument.getText());
          void this.sendState();
        }
      }),
      this.options.projects.onDidChange(() => {
        const nextMatch = this.options.projects.resolveDocument(document.uri);
        if (nextMatch === undefined || nextMatch.documentType.editor !== facets.editor) {
          panel.dispose();
          void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
          return;
        }
        this.match = nextMatch;
        this.configureCatalogWatchers();
        void this.sendState();
      }),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((event) => {
        const visible = event.webviewPanel.visible;
        if (!visible && webviewWasVisible) {
          this.webviewEpoch.invalidate();
          this.webviewReady = false;
          this.revealMailbox?.markUnavailable();
        } else if (visible && !webviewWasVisible) {
          this.webviewEpoch.begin(createNonce());
          // 新 epoch 重新计时：旧 epoch 的耗尽状态不能带过来。
          this.readyAttempts = 0;
          this.readyExhausted = false;
          void this.requestWebviewReady();
        }
        webviewWasVisible = visible;
      }),
    );
    void this.requestWebviewReady();
  }

  public async reveal(target: unknown): Promise<void> {
    if (this.disposed || this.revealMailbox === undefined) return;
    this.revealMailbox.enqueue(target);
    this.options.panel.reveal();
    await this.sendPendingReveal();
  }

  public get isReady(): boolean {
    return this.webviewReady
      && this.webviewEpoch.isReady
      && !this.disposed
      && this.options.panel.active
      && this.options.panel.visible;
  }

  /** 该会话所属的 editor 面（调试 facet 广播按它过滤）。 */
  public get editorName(): string {
    return this.options.facets.editor;
  }

  /** 该会话是否属于给定 editor 面（同一文档可能被不同 editor 打开）。 */
  public matchesEditor(editor: string): boolean {
    return this.options.facets.editor === editor;
  }

  /**
   * 当前文档的语义 `documentId`（G1d 的 facet 文档作用域）。
   *
   * 与旧 `graphExecution` 路径的 `getDocumentId()` 同源（模块 `parseText` → `document.documentId`），
   * 解析失败为 `undefined`（宿主按"身份未知"降级为 editor 面投递）。广播按事件调用它，
   * 因此按文档版本缓存：一次编辑只重新解析一次，而不是每条增量都解析。
   */
  public get documentId(): string | undefined {
    const version = this.options.document.version;
    const cached = this.documentIdCache;
    if (cached !== undefined && cached.version === version) {
      return cached.value;
    }

    let value: string | undefined;
    try {
      value = this.options.facets.readDocumentId(this.options.document.getText(), this.match);
    } catch (errorValue) {
      // 解析抛错是模块缺陷，但不能打断调试广播：按"身份未知"降级，并把原因留在 OutputChannel。
      this.options.output.appendLine(
        `[${this.options.facets.editor}] failed to resolve the document id for ${this.match.relativePath}: ${formatError(errorValue)}`,
      );
      value = undefined;
    }

    this.documentIdCache = { version, value };
    return value;
  }

  public assertOperationsAllowedForTest(operations: unknown): void {
    const message = this.options.controller.checkOperations?.(operations);
    if (message !== undefined) throw new Error(message);
  }

  public async applyOperationsForTest(operations: unknown, revisionOverride?: number): Promise<void> {
    const webviewToken = this.webviewEpoch.currentToken;
    if (!this.isReady || webviewToken === undefined) {
      throw new Error(`No ready ${editorLabel(this.options.facets.editor)} editor session was found.`);
    }
    const webviewEpoch = this.webviewEpoch.capture();
    const operation = this.operationQueue
      .catch(() => undefined)
      .then(() => this.handleMessage({
        type: "applyOperations",
        webviewToken,
        documentVersion: revisionOverride ?? this.options.document.version,
        operations,
      }, webviewEpoch));
    this.operationQueue = operation;
    await operation;
  }

  /** 最近一次拒绝文案；没有拒绝时为 undefined。 */
  public get lastRejection(): string | undefined {
    return this.lastRejectionForTest;
  }

  /** 最近一次 `operationCompleted`；宿主测试据此断言修订号是 apply 之后的值。 */
  public get lastOperationCompleted(): Readonly<Record<string, unknown>> | undefined {
    return this.lastOperationCompletedForTest;
  }

  /** 只给 Structured 的外部修改用例用的确定性钩子：先写盘并刷新，再走同一条 apply 路径。 */
  public async applyOperationsAfterExternalWriteForTest(
    externalText: string,
    operations: unknown,
  ): Promise<void> {
    writeFileSync(this.options.document.uri.fsPath, externalText, "utf8");
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

  /** 测试注入执行调试消息（带 epoch token，与真实 Webview 消息同路径）。 */
  public async sendDebugMessageForTest(message: unknown): Promise<void> {
    const webviewToken = this.webviewEpoch.currentToken;
    if (!this.isReady || webviewToken === undefined) {
      throw new Error(`No ready ${editorLabel(this.options.facets.editor)} editor session was found.`);
    }
    const webviewEpoch = this.webviewEpoch.capture();
    const operation = this.operationQueue
      .catch(() => undefined)
      .then(() => this.handleMessage({
        ...(message as Record<string, unknown>),
        webviewToken,
      }, webviewEpoch));
    this.operationQueue = operation;
    await operation;
  }

  public get debugTestState(): unknown {
    return this.hostMessageHandler?.testState;
  }

  /** Graph 执行调试窗口的 facet 状态（G1a；与旧 `debugTestState` 分开，旧路径测试不受影响）。 */
  public get debugFacetTestState(): {
    readonly lastAck?: DebugFacetAck;
    readonly ready: boolean;
    readonly visible: boolean;
  } {
    return {
      ready: this.webviewReady && this.webviewEpoch.isReady && !this.disposed,
      visible: this.options.panel.visible,
      ...(this.lastDebugFacetAck === undefined ? {} : { lastAck: this.lastDebugFacetAck }),
    };
  }

  /** 分类级调试 facet 消息（水化/增量/重置）；由宿主桥构造后投到本会话 Webview。 */
  public async postHostMessage(message: unknown): Promise<boolean> {
    return this.postMessage(message);
  }

  public get testState(): {
    readonly ready: boolean;
    readonly readyGeneration: number;
    readonly readyToken?: string;
    readonly active: boolean;
    readonly visible: boolean;
    readonly lastRevealResult?: { readonly target: unknown; readonly found: boolean };
    readonly debugState?: unknown;
  } {
    const state = {
      ready: this.webviewReady && this.webviewEpoch.isReady && !this.disposed,
      readyGeneration: this.readyGeneration,
      active: this.options.panel.active,
      visible: this.options.panel.visible,
      ...(this.lastRevealResult === undefined ? {} : { lastRevealResult: this.lastRevealResult }),
      debugState: this.hostMessageHandler?.testState,
    };
    const readyToken = this.webviewEpoch.isReady ? this.webviewEpoch.currentToken : undefined;
    return readyToken === undefined ? state : { ...state, readyToken };
  }

  private async handleMessage(message: WebviewMessage, webviewEpoch: number): Promise<void> {
    if (!this.isCurrentWebviewEpoch(webviewEpoch)) return;
    if (message.type === "ready") {
      await this.handleReady(message, webviewEpoch);
      return;
    }
    if (!this.webviewEpoch.acceptsMessage(message.webviewToken)) return;

    // 宿主先处理（不转发给控制器）：定位结果、reference bridge、剪贴板、调试窗口消息。
    if (this.options.facets.reveal !== undefined
      && message.type === this.options.facets.reveal.resultMessageType) {
      this.handleRevealResult(message);
      return;
    }
    if (await handleReferenceMessage(
      message as ModuleSessionMessage,
      this.options.panel.webview,
      this.match.project,
      this.options.references,
    )) {
      return;
    }
    if (message.type === DEBUG_FACET_ACK_MESSAGE) {
      this.recordDebugFacetAck(message);
      return;
    }
    if (message.type === DEBUG_FACET_RESYNC_MESSAGE) {
      const replies = await this.options.onDebugFacetResync?.(message) ?? [];
      for (const reply of replies) {
        await this.postMessage(reply);
      }
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
    if (this.hostMessageHandler !== undefined && await this.hostMessageHandler.handle(message)) {
      return;
    }

    if (message.type === "applyOperations") {
      if (typeof message.documentVersion !== "number"
        || message.documentVersion !== this.options.document.version) {
        await this.sendState();
        await this.rejectOperation(STALE_REVISION_MESSAGE);
        return;
      }
      const expectedRevision = message.documentVersion;
      // 稳定身份改名的预检在外部修改确认之前，保持改造前的拒绝顺序。
      const guarded = this.options.controller.checkOperations?.(message.operations);
      if (guarded !== undefined) {
        await this.rejectOperation(guarded);
        return;
      }
      if (!await this.confirmExternalChanges()) return;
      if (!this.isCurrentOperation(expectedRevision, webviewEpoch)) return;
      const effects = await this.options.controller.handle(
        message as ModuleSessionMessage,
        this.createSnapshot(),
        this.createHost(),
      );
      await this.executeEffects(effects, expectedRevision);
      return;
    }

    const effects = await this.options.controller.handle(
      message as ModuleSessionMessage,
      this.createSnapshot(),
      this.createHost(),
    );
    await this.executeEffects(effects, this.options.document.version);
  }

  /**
   * effect 执行器：按序执行，`apply` 前再做一次 revision 校验；陈旧则整批拒绝并给可读提示。
   */
  private async executeEffects(
    effects: readonly ModuleSessionEffect[],
    expectedRevision: number,
  ): Promise<void> {
    let applied = false;
    for (const effect of effects) {
      if (this.disposed) return;
      switch (effect.kind) {
        case "apply": {
          if (this.options.document.version !== expectedRevision) {
            this.options.output.appendLine(
              `[${this.options.facets.editor}] Rejected a stale effect batch for ${this.match.relativePath}.`,
            );
            await this.rejectOperation(STALE_REVISION_MESSAGE);
            await this.sendState();
            return;
          }
          if (effect.operations.kind === "text") {
            await this.applyText(effect.operations.text);
            applied = true;
          }
          break;
        }
        case "post": {
          this.publishMessageDiagnostics(effect.message);
          // 修订号统一由宿主盖章：控制器在 apply 之前填的 `documentVersion` 已过期，
          // `operationCompleted` 必须携带 apply 之后的 `TextDocument.version`。
          await this.postMessage({ ...effect.message, documentVersion: this.options.document.version });
          break;
        }
        case "reveal": {
          // reveal effect 携带 `ReferenceLocation`；控制器不接触定位目标形状，由 editor 面解析。
          const target = this.options.facets.reveal?.readTarget(effect.location);
          if (target !== undefined && this.revealMailbox !== undefined) {
            this.revealMailbox.enqueue(target);
            this.options.panel.reveal();
            await this.sendPendingReveal();
          }
          break;
        }
        case "openDocument": {
          const project = this.match.project;
          const uri = vscode.Uri.joinPath(project.rootUri, ...effect.path.split("/"));
          await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.documentEditor.option");
          break;
        }
        case "clipboard.write": {
          await vscode.env.clipboard.writeText(effect.text);
          break;
        }
        case "notify": {
          if (effect.severity === "error") {
            void vscode.window.showErrorMessage(effect.message);
          } else if (effect.severity === "warning") {
            void vscode.window.showWarningMessage(effect.message);
          } else {
            void vscode.window.showInformationMessage(effect.message);
          }
          break;
        }
      }
    }
    if (applied) {
      this.options.output.appendLine(
        `[${this.options.facets.editor}] Applied operations to ${this.match.relativePath} at document version ${this.options.document.version}.`,
      );
      await this.sendState();
    }
  }

  private recordDebugFacetAck(message: WebviewMessage): void {
    if (typeof message.category !== "string" || message.category.length === 0) return;
    if (typeof message.eventCount !== "number" || typeof message.cursor !== "number") return;
    this.lastDebugFacetAck = {
      category: message.category,
      state: message.state === "replay" ? "replay" : "follow",
      eventCount: message.eventCount,
      cursor: message.cursor,
      executingNodeId: typeof message.executingNodeId === "string" ? message.executingNodeId : null,
      ...(typeof message.instanceId === "string" ? { instanceId: message.instanceId } : {}),
      ...(typeof message.instanceCount === "number" ? { instanceCount: message.instanceCount } : {}),
      ...(typeof message.currentNodeId === "string" || message.currentNodeId === null
        ? { currentNodeId: message.currentNodeId }
        : {}),
      ...(typeof message.frameIndex === "number" ? { frameIndex: message.frameIndex } : {}),
      ...(typeof message.updateCount === "number" ? { updateCount: message.updateCount } : {}),
    };
  }

  private handleRevealResult(message: WebviewMessage): void {
    const reveal = this.options.facets.reveal;
    if (reveal === undefined || this.revealMailbox === undefined) return;
    if (typeof message.requestId !== "string" || typeof message.found !== "boolean") return;
    const delivered = this.revealMailbox.deliverable as { readonly requestId: string; readonly target: unknown } | undefined;
    if (!this.revealMailbox.acknowledge(message.requestId)) return;
    if (delivered?.requestId !== message.requestId) return;
    this.lastRevealResult = { target: delivered.target, found: message.found };
    if (!message.found) {
      this.options.output.appendLine(
        `[${this.options.facets.editor}] Reveal target was not found in ${this.match.relativePath}: ${typeof message.message === "string" ? message.message : "unknown target"}`,
      );
    }
  }

  private async confirmExternalChanges(): Promise<boolean> {
    const diskBytes = await vscode.workspace.fs.readFile(this.options.document.uri);
    const diskText = new TextDecoder("utf-8", { fatal: true }).decode(diskBytes);
    const diskTextHash = hashText(diskText);
    const testHook = this.confirmExternalChangesTestHook;
    this.confirmExternalChangesTestHook = undefined;
    await testHook?.();
    const document = this.options.document;
    if (diskTextHash === this.baseDiskTextHash) return true;
    if (diskText === document.getText()) {
      this.baseDiskTextHash = diskTextHash;
      return true;
    }
    if (!document.isDirty) {
      if (diskText !== document.getText()) {
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
      `${editorLabel(this.options.facets.editor)} 文件 '${this.match.relativePath}' 已被外部修改。`,
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

  /**
   * 用磁盘内容刷新**本会话的**文档。
   *
   * 不用 `workbench.action.files.revert`：它作用于当前活动编辑器，会话面板不是活动编辑器时
   * （split、程序化 apply）会刷新错编辑器或静默失败。这里对目标 URI 做 WorkspaceEdit 再
   * `document.save()`，与改造前 Entity/Graph 的做法一致，失败时返回 false 由调用方给可读提示。
   */
  private async reloadDocumentFromDisk(expectedText: string): Promise<boolean> {
    const document = this.options.document;
    if (document.getText() !== expectedText) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullDocumentRange(document), expectedText);
      if (!await vscode.workspace.applyEdit(edit)) {
        return false;
      }
    }
    if (!document.isDirty) {
      return document.getText() === expectedText;
    }
    if (!await document.save()) {
      return false;
    }
    return document.getText() === expectedText && !document.isDirty;
  }

  private async applyText(text: string): Promise<void> {
    const document = this.options.document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullDocumentRange(document), text);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error(`${editorLabel(this.options.facets.editor)} 修改未能写入 VS Code。`);
    }
  }

  private async sendState(options: ModuleSessionStateEvent = {}): Promise<boolean> {
    if (this.disposed) return false;
    const webviewEpoch = this.webviewEpoch.capture();
    const documentVersion = this.options.document.version;
    const state = await this.options.controller.state(this.createSnapshot(), this.createHost());
    if (!this.isCurrentOperation(documentVersion, webviewEpoch)) return false;
    if (!isRecord(state)) return false;
    this.publishMessageDiagnostics(state);
    return this.postMessage({
      ...state,
      documentVersion,
      ...(options.documentChanged === true ? { documentChanged: true } : {}),
      ...(options.historyAction === undefined ? {} : { historyAction: options.historyAction }),
    });
  }

  private publishMessageDiagnostics(message: Readonly<Record<string, unknown>>): void {
    const diagnostics = message.diagnostics;
    if (!Array.isArray(diagnostics)) return;
    this.updateDiagnostics(diagnostics as readonly DocumentDiagnostic[]);
  }

  private updateDiagnostics(items: readonly DocumentDiagnostic[]): void {
    if (this.disposed) return;
    this.options.publishDiagnostics(items.map((item) => {
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

  private createSnapshot(): ModuleSessionDocument {
    return {
      projectId: this.match.project.definition.projectId,
      documentTypeId: this.match.documentType.id,
      path: this.match.relativePath,
      text: this.options.document.getText(),
      revision: this.options.document.version,
      isDirty: this.options.document.isDirty,
      ...(this.options.options === undefined ? {} : { options: this.options.options }),
    };
  }

  private createHost(): ModuleSessionHost {
    const facets = this.options.facets;
    const references = this.options.references;
    const project = this.match.project;
    return {
      loadCatalog: async (): Promise<ModuleSessionCatalog> => facets.loadCatalog(this.match),
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
        this.options.output.appendLine(`[${facets.editor}] ${message}`);
      },
    };
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

  private async sendPendingReveal(): Promise<void> {
    const pendingReveal = this.revealMailbox?.deliverable;
    if (this.disposed || pendingReveal === undefined) return;
    // 消息类型以模块登记的类型为准（附录 D.3），不信任 mailbox 自造的类型。
    if (!await this.postMessage(stampRevealMessage(this.options.facets.reveal, pendingReveal))) {
      this.revealMailbox?.markUnavailable();
    }
  }

  private async rejectOperation(message: string): Promise<void> {
    await this.postMessage({ type: "operationRejected", message });
  }

  private async readDiskTextHash(): Promise<string> {
    try {
      const diskText = new TextDecoder("utf-8", { fatal: true }).decode(
        await vscode.workspace.fs.readFile(this.options.document.uri),
      );
      return hashText(diskText);
    } catch {
      return hashText(this.options.document.getText());
    }
  }

  private async handleReady(message: WebviewMessage, webviewEpoch: number): Promise<void> {
    if (typeof message.instanceId !== "string" || message.instanceId.length === 0) return;
    if (message.webviewToken === undefined) {
      await this.requestWebviewReady();
      return;
    }
    if (!this.options.panel.visible || !this.webviewEpoch.canAcceptReady(message.webviewToken)) return;
    if (!await this.sendState()
      || !this.isCurrentWebviewEpoch(webviewEpoch)
      || !this.options.panel.visible
      || !this.webviewEpoch.markReady(message.webviewToken)) {
      return;
    }
    this.webviewReady = true;
    this.readyGeneration += 1;
    if (this.readyRetry !== undefined) {
      clearTimeout(this.readyRetry);
      this.readyRetry = undefined;
    }
    this.readyAttempts = 0;
    this.readyExhausted = false;
    this.revealMailbox?.markReady();
    await this.sendPendingReveal();
    // 调试 facet 水化必须在 `ready` 之后：早发会被 Webview 的 epoch 过滤掉。
    await this.options.onWebviewReady?.();
  }

  private async requestWebviewReady(): Promise<void> {
    const token = this.webviewEpoch.currentToken;
    if (this.disposed || !this.options.panel.visible || token === undefined) return;
    if (this.readyRetry !== undefined) {
      clearTimeout(this.readyRetry);
      this.readyRetry = undefined;
    }
    await this.postMessage({ type: "requestReady", webviewToken: token });
    if (this.webviewReady || this.readyAttempts >= READY_RETRY_LIMIT) {
      if (this.webviewReady) return;
      if (!this.readyExhausted) {
        this.readyExhausted = true;
        const reason = `模块 Webview 在 ${READY_RETRY_LIMIT} 次 requestReady 内没有回 ready（${editorLabel(this.options.facets.editor)}），面板会停在空白页。`;
        this.options.output.appendLine(`[modules] ${reason}`);
        vscode.window.setStatusBarMessage(`VisualBridge: ${reason} 请重新打开该编辑器。`, 8_000);
      }
      return;
    }
    this.readyAttempts += 1;
    this.readyRetry = setTimeout(() => {
      this.readyRetry = undefined;
      void this.requestWebviewReady();
    }, READY_RETRY_INTERVAL_MS);
    this.readyRetry.unref?.();
  }

  private async postMessage(message: unknown): Promise<boolean> {
    if (this.disposed) return false;
    if (isRecord(message)) {
      if (message.type === "operationRejected" && typeof message.message === "string") {
        this.lastRejectionForTest = message.message;
      }
      if (message.type === "operationCompleted") {
        this.lastOperationCompletedForTest = message;
      }
    }
    try {
      return await this.options.panel.webview.postMessage(message);
    } catch (errorValue) {
      if (!this.disposed && !/Webview is disposed/u.test(formatError(errorValue))) {
        this.options.output.appendLine(
          `[${this.options.facets.editor}] Failed to post a Webview message for ${this.match.relativePath}: ${formatError(errorValue)}`,
        );
      }
      return false;
    }
  }

  private isCurrentWebviewEpoch(webviewEpoch: number): boolean {
    return !this.disposed && this.webviewEpoch.isCurrent(webviewEpoch);
  }

  private isCurrentOperation(documentVersion: number, webviewEpoch: number): boolean {
    return this.options.document.version === documentVersion && this.isCurrentWebviewEpoch(webviewEpoch);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.webviewEpoch.invalidate();
    this.webviewReady = false;
    if (this.readyRetry !== undefined) {
      clearTimeout(this.readyRetry);
      this.readyRetry = undefined;
    }
    this.hostMessageHandler?.dispose?.();
    this.options.controller.dispose?.();
    for (const disposable of this.catalogDisposables.splice(0)) {
      disposable.dispose();
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}

function editorLabel(editor: string): string {
  switch (editor) {
    case "entity": return "Entity";
    case "graph": return "Graph";
    case "structured": return "Structured Config";
    default: return editor;
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashSource(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function createNonce(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex");
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
