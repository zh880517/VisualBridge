import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "@visualbridge/node-host";
import { referenceValuesEqual } from "@visualbridge/core";
import {
  containsLifecycleGuardedRemoval,
  lifecycleDeleteTarget,
  LIFECYCLE_REQUIRED_MESSAGE,
} from "../document/lifecycleOperationGuard";
import type {
  DocumentDiagnostic,
  JsonValue,
  ReferenceDefinition,
  ReferenceLocation,
  TableLayoutDefinition,
} from "@visualbridge/core";
import {
  TABLE_EDITOR_ID,
  applyTableOperations,
  collectTableReferences,
  matchTableSheetDefinitions,
  parseCsvTable,
  parseXlsxTable,
  resolveTableColumn,
  resolveTableSheet,
  resolveTableType,
  serializeCsvTable,
  serializeXlsxTable,
  validateTableDocument,
  type TableDocument,
  type TableSheet,
  type TableTypeDefinition,
} from "@visualbridge/table";
import {
  TABLE_REVEAL_RESULT_MESSAGE_TYPE,
  TableRevealMailbox,
  chooseReadyTableRevealRecipient,
  createTableEditorHtml,
  type TableRevealResult,
  type TableRevealTarget,
} from "@visualbridge/table-editor";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import type { DocumentMatch, ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import { handleReferenceMessage } from "../reference/referenceMessages";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import type {
  WorkspaceReferenceTargetRenameRequest,
  WorkspaceReferenceTargetRenameResult,
} from "../refactor/workspaceReferenceRefactor";
import { WebviewEpoch } from "./webviewEpoch";

export const TABLE_EDITOR_VIEW_TYPE = "visualbridge.tableEditor";

interface WebviewMessage {
  readonly type?: unknown;
  readonly webviewToken?: unknown;
  readonly instanceId?: unknown;
  readonly revision?: unknown;
  readonly operations?: unknown;
  readonly requestId?: unknown;
  readonly definition?: unknown;
  readonly value?: unknown;
  readonly found?: unknown;
  readonly message?: unknown;
}

interface PendingTableReveal {
  readonly sequence: number;
  readonly target: TableRevealTarget;
}

interface TablePanelRevealState {
  readonly mailbox: TableRevealMailbox;
  readonly epoch: WebviewEpoch;
  sourceUri: string | undefined;
  sourceTarget: TableRevealTarget | undefined;
  revealGeneration: number | undefined;
  lastReveal: {
    readonly sourceUri: string;
    readonly target: TableRevealTarget;
    readonly result: TableRevealResult;
  } | undefined;
}

interface TableSource {
  readonly uri: vscode.Uri;
  readonly physicalName: string;
  readonly sheetIds: readonly string[];
  originalBytes: Uint8Array;
  baseHash: string;
}

interface BackupSource {
  readonly uri: string;
  readonly bytes: string;
}

interface TableBackup {
  readonly formatVersion: 1;
  readonly sources: readonly BackupSource[];
}

export class TableCustomDocument implements vscode.CustomDocument {
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private disposed = false;

  public revision = 1;
  public savedDocument: TableDocument;

  public readonly onDidChangeState = this.stateEmitter.event;

  public constructor(
    public readonly uri: vscode.Uri,
    public readonly match: DocumentMatch,
    public readonly tableType: TableTypeDefinition,
    public readonly layout: TableLayoutDefinition,
    public readonly sources: TableSource[],
    public document: TableDocument,
    private readonly didUpdate?: (document: TableCustomDocument) => void,
    private readonly didDispose?: (document: TableCustomDocument) => void,
  ) {
    this.savedDocument = cloneTableDocument(document);
  }

  public get isDirty(): boolean {
    return stableDocument(this.document) !== stableDocument(this.savedDocument);
  }

  public update(next: TableDocument): void {
    this.document = cloneTableDocument(next);
    this.revision += 1;
    this.stateEmitter.fire();
    this.didUpdate?.(this);
  }

  public markSaved(sourceBytes: ReadonlyMap<string, Uint8Array>): void {
    this.savedDocument = cloneTableDocument(this.document);
    for (const source of this.sources) {
      const bytes = sourceBytes.get(source.uri.toString());
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.didDispose?.(this);
    this.stateEmitter.dispose();
  }
}

export class TableEditorProvider implements vscode.CustomEditorProvider<TableCustomDocument>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<TableCustomDocument>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panels = new Map<TableCustomDocument, Set<vscode.WebviewPanel>>();
  private readonly panelRevealStates = new Map<vscode.WebviewPanel, TablePanelRevealState>();
  private readonly pendingReveals = new Map<string, PendingTableReveal>();
  private readonly documentRevealGenerations = new Map<TableCustomDocument, number>();
  private readonly testPausedRevealPanels = new Set<vscode.WebviewPanel>();
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
  ) {
    this.disposables.push(this.changeEmitter);
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
  ): Promise<TableCustomDocument> {
    const match = this.projects.resolveDocument(uri);
    if (match === undefined || match.documentType.editor !== TABLE_EDITOR_ID) {
      throw new Error("The file is not configured as a VisualBridge Table document.");
    }
    const layout = match.project.definition.tableLayout;
    if (layout === undefined) {
      throw new Error("VisualBridge Project must configure tableLayout.nameKeyRow and tableLayout.dataStartRow.");
    }
    const catalogResult = await loadTableCatalogRegistry(match.project, match.documentType.catalogs);
    if (!catalogResult.ready) {
      throw new Error(formatCatalogUnavailable(catalogResult.diagnostics));
    }
    const tableType = resolveTableType(catalogResult.registry, match.documentType.id);
    if (tableType === undefined) {
      throw new Error(`Table Catalog does not declare '${match.documentType.id}' or an alias.`);
    }
    const backup = openContext.backupId === undefined
      ? undefined
      : await readBackup(vscode.Uri.parse(openContext.backupId));
    const loaded = await loadTableSources(uri, match, tableType, layout, this.projects, backup);
    const document = new TableCustomDocument(
      uri,
      match,
      tableType,
      layout,
      loaded.sources,
      loaded.document,
      (current) => this.updateReferenceDocument(current),
      (current) => this.references.removeTableDocument(current.uri.toString()),
    );
    this.updateReferenceDocument(document);
    this.updateDiagnostics(document, [
      ...catalogResult.diagnostics,
      ...loaded.diagnostics,
      ...await this.references.validate(
        document.match.project,
        collectTableReferences(document.document, document.tableType),
      ),
      ...await this.providerDiagnostics(document),
    ]);
    return document;
  }

  public async resolveCustomEditor(
    document: TableCustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.title = `${document.match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
    const nonce = createNonce();
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "tableEditor.js"));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "tableEditor.css"));
    panel.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    panel.webview.html = createTableEditorHtml({
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
    const revealState: TablePanelRevealState = {
      mailbox: new TableRevealMailbox(),
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
          this.output.appendLine(`[table] Operation failed: ${formatError(errorValue)}`);
          if (message.type === "ready") {
            return;
          }
          return panel.webview.postMessage({ type: "operationRejected", message: formatError(errorValue) }).then(() => undefined);
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
        revealState.mailbox.cancel();
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
          this.output.appendLine(`[table] Reveal handoff failed: ${formatError(errorValue)}`);
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
    readonly lastRevealResult?: TableRevealResult;
    readonly lastRevealTarget?: TableRevealTarget;
  } {
    const uriKey = uri.toString();
    const matchingPanels = [...this.panels]
      .filter(([document]) => document.sources.some((source) => source.uri.toString() === uriKey))
      .flatMap(([, panels]) => [...panels]);
    const base = {
      panelCount: matchingPanels.length,
      activeReadyPanelCount: matchingPanels.filter((panel) => {
        const state = this.panelRevealStates.get(panel);
        return state?.mailbox.isReady === true && panel.active && panel.visible;
      }).length,
      pendingRevealCount: (this.pendingReveals.has(uriKey) ? 1 : 0)
        + matchingPanels.filter((panel) => this.panelRevealStates.get(panel)?.mailbox.pendingTarget !== undefined).length,
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
    if (location.sheetId === undefined || location.rowId === undefined) {
      throw new Error("Table reference location is missing sheetId or rowId.");
    }
    const project = this.projects.projects.find((candidate) => candidate.definition.projectId === location.projectId);
    if (project === undefined) {
      throw new Error(`VisualBridge Project '${location.projectId}' is not open.`);
    }
    const uri = vscode.Uri.joinPath(project.rootUri, ...location.path.split("/"));
    const match = this.projects.resolveDocument(uri);
    if (match?.project.markerUri.toString() !== project.markerUri.toString()
      || match.documentType.editor !== TABLE_EDITOR_ID
      || match.documentType.id !== location.documentTypeId) {
      throw new Error("Table reference location is outside its declared Project Document Type.");
    }
    const target = { sheetId: location.sheetId, rowId: location.rowId };
    const sourceUri = uri.toString();
    const revealGeneration = ++this.revealSequence;
    this.clearRevealResults(sourceUri);
    for (const [document, panels] of this.panels) {
      if (!document.sources.some((source) => source.uri.toString() === sourceUri)) {
        continue;
      }
      this.beginDocumentReveal(document, revealGeneration);
      const panel = chooseRevealPanel(panels);
      const state = panel === undefined ? undefined : this.panelRevealStates.get(panel);
      if (panel === undefined || state === undefined) {
        break;
      }
      state.sourceUri = sourceUri;
      state.sourceTarget = target;
      state.revealGeneration = revealGeneration;
      state.mailbox.enqueue(target);
      panel.reveal();
      await this.sendPanelReveal(panel, state, state.epoch.capture());
      return;
    }
    const pending: PendingTableReveal = { sequence: revealGeneration, target };
    this.pendingReveals.set(sourceUri, pending);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, TABLE_EDITOR_VIEW_TYPE);
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
      .sort((left, right) => left.toString().localeCompare(right.toString()));
  }

  public pauseNextRevealForTest(uri: vscode.Uri): boolean {
    const uriKey = uri.toString();
    for (const [document, panels] of this.panels) {
      if (!document.sources.some((source) => source.uri.toString() === uriKey)) {
        continue;
      }
      const panel = chooseRevealPanel(panels);
      const state = panel === undefined ? undefined : this.panelRevealStates.get(panel);
      if (panel !== undefined && state?.mailbox.isReady === true) {
        this.testPausedRevealPanels.add(panel);
        return true;
      }
    }
    return false;
  }

  public async saveCustomDocument(document: TableCustomDocument): Promise<void> {
    await this.saveToSources(document, document.sources);
  }

  public async applyOperationsForTest(uri: vscode.Uri, operations: unknown): Promise<void> {
    const document = this.openDocument(uri);
    const identityRefactor = await this.applyExistingKeyRefactor(document, operations, false);
    if (identityRefactor !== undefined) {
      if (!identityRefactor.success) throw new Error(`${identityRefactor.code}: ${identityRefactor.message}`);
      return;
    }
    const result = applyTableOperations(document.document, operations, document.tableType);
    if (!result.success) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    document.update(result.document);
  }

  public async saveForTest(uri: vscode.Uri): Promise<number> {
    const document = this.openDocument(uri);
    return this.saveToSources(document, document.sources);
  }

  public async saveCustomDocumentAs(
    document: TableCustomDocument,
    destination: vscode.Uri,
  ): Promise<void> {
    if (document.sources.length !== 1) {
      throw new Error("A partitioned CSV family cannot be saved with Save As; save the logical table in place.");
    }
    const source = document.sources[0]!;
    const bytes = await renderSource(document, source);
    await atomicWrite(destination, bytes);
  }

  public async revertCustomDocument(document: TableCustomDocument): Promise<void> {
    const loaded = await loadTableSources(
      document.uri,
      document.match,
      document.tableType,
      document.layout,
      this.projects,
    );
    document.sources.splice(0, document.sources.length, ...loaded.sources);
    document.document = cloneTableDocument(loaded.document);
    document.savedDocument = cloneTableDocument(loaded.document);
    document.revision += 1;
    document.update(document.document);
    this.updateDiagnostics(document, loaded.diagnostics);
  }

  public async backupCustomDocument(
    document: TableCustomDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    const rendered = await renderAllSources(document);
    const backup: TableBackup = {
      formatVersion: 1,
      sources: document.sources.map((source) => ({
        uri: source.uri.toString(),
        bytes: Buffer.from(rendered.get(source.uri.toString()) ?? source.originalBytes).toString("base64"),
      })),
    };
    await vscode.workspace.fs.writeFile(context.destination, Buffer.from(JSON.stringify(backup), "utf8"));
    return {
      id: context.destination.toString(),
      delete: async () => vscode.workspace.fs.delete(context.destination),
    };
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panels.clear();
    this.panelRevealStates.clear();
    this.pendingReveals.clear();
    this.documentRevealGenerations.clear();
    this.testPausedRevealPanels.clear();
  }

  private async applyExistingKeyRefactor(
    document: TableCustomDocument,
    operations: unknown,
    confirm: boolean,
  ): Promise<WorkspaceReferenceTargetRenameResult | undefined> {
    const intent = classifyExistingTableKeyRename(document, operations);
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
    document: TableCustomDocument,
    panel: vscode.WebviewPanel,
    message: WebviewMessage,
    webviewEpoch: number,
  ): Promise<void> {
    const initialState = this.panelRevealStates.get(panel);
    if (initialState === undefined || !this.isCurrentPanelEpoch(panel, initialState, webviewEpoch)) {
      return;
    }
    if (message.type === "ready") {
      await this.handlePanelReady(document, panel, initialState, message, webviewEpoch);
      return;
    }
    if (!initialState.epoch.acceptsMessage(message.webviewToken)) {
      return;
    }
    if (message.type === TABLE_REVEAL_RESULT_MESSAGE_TYPE) {
      if (typeof message.requestId !== "string" || typeof message.found !== "boolean") {
        return;
      }
      if (initialState.mailbox.acknowledge(message.requestId) !== true) {
        return;
      }
      const isCurrentReveal = initialState.revealGeneration !== undefined
        && initialState.revealGeneration === this.documentRevealGenerations.get(document);
      const result: TableRevealResult = {
        type: TABLE_REVEAL_RESULT_MESSAGE_TYPE,
        requestId: message.requestId,
        found: message.found,
        ...(typeof message.message === "string" ? { message: message.message } : {}),
      };
      initialState.lastReveal = !isCurrentReveal
        || initialState.sourceUri === undefined
        || initialState.sourceTarget === undefined
        ? undefined
        : { sourceUri: initialState.sourceUri, target: initialState.sourceTarget, result };
      initialState.sourceUri = undefined;
      initialState.sourceTarget = undefined;
      initialState.revealGeneration = undefined;
      if (isCurrentReveal && !result.found) {
        this.output.appendLine(`[table] Reveal target was not found: ${result.message ?? "unknown target"}`);
      }
      const panels = this.panels.get(document);
      if (panels !== undefined) {
        await this.handoffPendingReveal(document, panels);
      }
      return;
    }
    if (await handleReferenceMessage(message, panel.webview, document.match.project, this.references)) {
      return;
    }
    if (message.type !== "applyOperations") {
      return;
    }
    if (typeof message.revision !== "number" || message.revision !== document.revision) {
      await this.sendState(document);
      await panel.webview.postMessage({
        type: "operationRejected",
        message: "文档已发生变化，编辑器已刷新，请重试刚才的操作。",
      });
      return;
    }
    if (containsLifecycleGuardedRemoval("table", message.operations)) {
      const target = lifecycleDeleteTarget("table", message.operations);
      if (target === undefined || document.isDirty) {
        await panel.webview.postMessage({
          type: "operationRejected",
          message: document.isDirty
            ? "lifecycle.workspaceDirty: Save or revert this Table before Safe Delete."
            : LIFECYCLE_REQUIRED_MESSAGE,
        });
        return;
      }
      const result = await vscode.commands.executeCommand("visualbridge.safeDeleteElement", {
        projectId: document.match.project.definition.projectId,
        documentTypeId: document.match.documentType.id,
        path: document.match.relativePath,
        target,
      });
      if (result !== undefined) {
        await this.revertCustomDocument(document);
        await this.sendState(document);
      }
      return;
    }
    const identityRefactor = await this.applyExistingKeyRefactor(document, message.operations, true);
    if (identityRefactor !== undefined) {
      if (!identityRefactor.success) {
        await panel.webview.postMessage({
          type: "operationRejected",
          message: `${identityRefactor.code}: ${identityRefactor.message}`,
        });
      } else {
        await this.sendState(document);
        await panel.webview.postMessage({ type: "operationCompleted", changed: true });
      }
      return;
    }
    const conflict = await findConflict(document.sources);
    if (conflict !== undefined) {
      await panel.webview.postMessage({
        type: "operationRejected",
        message: `分表 '${nodePath.basename(conflict.uri.fsPath)}' 已被外部修改；为避免覆盖，操作已拒绝，请重新加载。`,
      });
      return;
    }
    const result = applyTableOperations(document.document, message.operations, document.tableType);
    if (!result.success) {
      this.updateDiagnostics(document, result.diagnostics);
      await panel.webview.postMessage({ type: "operationRejected", message: formatDiagnostics(result.diagnostics) });
      return;
    }
    const referenceResult = await this.references.validateChange(
      document.match.project,
      collectTableReferences(document.document, document.tableType),
      collectTableReferences(result.document, document.tableType),
    );
    if (referenceResult.introducedErrors.length > 0) {
      this.updateDiagnostics(document, [...result.diagnostics, ...referenceResult.diagnostics]);
      await panel.webview.postMessage({
        type: "operationRejected",
        message: formatDiagnostics(referenceResult.introducedErrors),
      });
      return;
    }
    const providerDiagnostics = await this.references.validateProviderDocument(document.match.project, {
      documentTypeId: document.match.documentType.id,
      path: document.match.relativePath,
      sourceHash: hashBytes(Buffer.from(JSON.stringify(result.document), "utf8")),
      content: result.document as unknown as JsonValue,
    });
    const providerErrors = providerDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (providerErrors.length > 0) {
      this.updateDiagnostics(document, [...result.diagnostics, ...referenceResult.diagnostics, ...providerDiagnostics]);
      await panel.webview.postMessage({
        type: "operationRejected",
        message: formatDiagnostics(providerErrors),
      });
      return;
    }
    const before = cloneTableDocument(document.document);
    const after = cloneTableDocument(result.document);
    document.update(after);
    this.updateDiagnostics(document, [...result.diagnostics, ...referenceResult.diagnostics, ...providerDiagnostics]);
    this.changeEmitter.fire({
      document,
      label: "Edit VisualBridge Table",
      undo: async () => document.update(before),
      redo: async () => document.update(after),
    });
    this.output.appendLine(`[table] Applied operations to ${document.match.relativePath} at revision ${document.revision}.`);
    await panel.webview.postMessage({ type: "operationCompleted", changed: true });
  }

  private async saveToSources(document: TableCustomDocument, sources: readonly TableSource[]): Promise<number> {
    const rendered = await renderAllSources(document);
    const writes = sources.flatMap((source) => {
      const bytes = rendered.get(source.uri.toString());
      return bytes === undefined || hashBytes(bytes) === source.baseHash ? [] : [{
        path: relativeProjectPath(document.match.project, source.uri),
        absolutePath: source.uri.fsPath,
        before: source.originalBytes,
        after: bytes,
      }];
    });
    if (writes.length > 0) {
      if (document.match.project.rootUri.scheme !== "file" || sources.some((source) => source.uri.scheme !== "file")) {
        throw new Error("Table project transactions currently require a local file workspace.");
      }
      try {
        const result = await withProjectTransaction(
          document.match.project.rootUri.fsPath,
          (transaction) => transaction.commit(writes),
        );
        if (result.maintenance !== undefined) {
          this.output.appendLine(`[table] ${result.maintenance.code}: ${result.maintenance.message}`);
        }
      } catch (errorValue) {
        throw tableSaveTransactionError(errorValue);
      }
    }
    document.markSaved(rendered);
    this.updateDiagnostics(document, await this.semanticDiagnostics(document));
    return writes.length;
  }

  private openDocument(uri: vscode.Uri): TableCustomDocument {
    const key = uri.toString();
    const document = [...this.panels.keys()].find((candidate) => candidate.uri.toString() === key);
    if (document === undefined) throw new Error(`Table '${uri.fsPath}' is not open.`);
    return document;
  }

  private async sendState(document: TableCustomDocument, targetPanel?: vscode.WebviewPanel): Promise<boolean> {
    const diagnostics = await this.semanticDiagnostics(document);
    this.updateDiagnostics(document, diagnostics);
    const message = {
      type: "tableState",
      revision: document.revision,
      document: document.document,
      tableType: document.tableType,
      isDirty: document.isDirty,
      diagnostics,
    };
    const panels = targetPanel === undefined
      ? [...this.panels.get(document) ?? []].filter(
          (panel) => this.panelRevealStates.get(panel)?.mailbox.isReady === true,
        )
      : [targetPanel];
    const results = await Promise.all(panels.map((panel) => panel.webview.postMessage(message)));
    return panels.length > 0 && results.every((posted) => posted);
  }

  private async semanticDiagnostics(document: TableCustomDocument): Promise<readonly DocumentDiagnostic[]> {
    return [
      ...validateTableDocument(document.document, document.tableType),
      ...await this.references.validate(
        document.match.project,
        collectTableReferences(document.document, document.tableType),
      ),
      ...await this.providerDiagnostics(document),
    ];
  }

  private providerDiagnostics(document: TableCustomDocument): Promise<readonly DocumentDiagnostic[]> {
    return this.references.validateProviderDocument(document.match.project, {
      documentTypeId: document.match.documentType.id,
      path: document.match.relativePath,
      sourceHash: hashBytes(Buffer.from(JSON.stringify(document.document), "utf8")),
      content: document.document as unknown as JsonValue,
    });
  }

  private claimPendingReveal(document: TableCustomDocument, state: TablePanelRevealState): void {
    const candidates = document.sources
      .map((source) => ({ sourceUri: source.uri.toString(), pending: this.pendingReveals.get(source.uri.toString()) }))
      .filter((entry): entry is { readonly sourceUri: string; readonly pending: PendingTableReveal } => (
        entry.pending !== undefined
      ));
    if (candidates.length === 0 || state.mailbox.pendingTarget !== undefined) {
      return;
    }
    const selected = candidates.sort((left, right) => right.pending.sequence - left.pending.sequence)[0];
    candidates.forEach((entry) => this.pendingReveals.delete(entry.sourceUri));
    if (selected !== undefined) {
      const currentGeneration = this.documentRevealGenerations.get(document);
      if (currentGeneration !== undefined && selected.pending.sequence < currentGeneration) {
        return;
      }
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
    state: TablePanelRevealState,
    webviewEpoch: number,
  ): Promise<void> {
    if (!this.isCurrentPanelEpoch(panel, state, webviewEpoch) || !state.epoch.isReady) {
      return;
    }
    const request = state.mailbox.deliverable;
    if (request === undefined) {
      return;
    }
    if (this.testPausedRevealPanels.delete(panel)) {
      return;
    }
    if (!await panel.webview.postMessage(request)
      && this.isCurrentPanelEpoch(panel, state, webviewEpoch)) {
      state.mailbox.markUnavailable();
    }
  }

  private async handoffPendingReveal(
    document: TableCustomDocument,
    panels: ReadonlySet<vscode.WebviewPanel>,
  ): Promise<void> {
    const panel = chooseReadyTableRevealRecipient([...panels].flatMap((candidate) => {
      const state = this.panelRevealStates.get(candidate);
      return state === undefined ? [] : [{
        value: candidate,
        mailbox: state.mailbox,
        active: candidate.active,
        visible: candidate.visible,
      }];
    }));
    const state = panel === undefined ? undefined : this.panelRevealStates.get(panel);
    if (panel === undefined || state === undefined) {
      return;
    }
    this.claimPendingReveal(document, state);
    if (state.mailbox.pendingTarget === undefined) {
      return;
    }
    panel.reveal();
    await this.sendPanelReveal(panel, state, state.epoch.capture());
  }

  private clearPendingReveals(document: TableCustomDocument): void {
    document.sources.forEach((source) => this.pendingReveals.delete(source.uri.toString()));
  }

  private beginDocumentReveal(document: TableCustomDocument, generation: number): void {
    this.documentRevealGenerations.set(document, generation);
    this.clearPendingReveals(document);
    this.cancelPanelReveals(document);
  }

  private cancelPanelReveals(document: TableCustomDocument): void {
    for (const panel of this.panels.get(document) ?? []) {
      const state = this.panelRevealStates.get(panel);
      if (state === undefined) {
        continue;
      }
      state.mailbox.cancel();
      state.sourceUri = undefined;
      state.sourceTarget = undefined;
      state.revealGeneration = undefined;
    }
  }

  private clearRevealResults(sourceUri: string): void {
    for (const state of this.panelRevealStates.values()) {
      if (state.lastReveal?.sourceUri === sourceUri) {
        state.lastReveal = undefined;
      }
    }
  }

  private restorePendingReveal(document: TableCustomDocument, state: TablePanelRevealState): void {
    const target = state.mailbox.pendingTarget;
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
    document: TableCustomDocument,
    panel: vscode.WebviewPanel,
    state: TablePanelRevealState,
    message: WebviewMessage,
    webviewEpoch: number,
  ): Promise<void> {
    if (typeof message.instanceId !== "string" || message.instanceId.length === 0) {
      return;
    }
    if (message.webviewToken === undefined) {
      await this.requestPanelReady(panel, state);
      return;
    }
    if (!panel.visible || !state.epoch.canAcceptReady(message.webviewToken)) {
      return;
    }
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

  private async requestPanelReady(panel: vscode.WebviewPanel, state: TablePanelRevealState): Promise<void> {
    const token = state.epoch.currentToken;
    if (this.panelRevealStates.get(panel) !== state || !panel.visible || token === undefined) {
      return;
    }
    await panel.webview.postMessage({ type: "requestReady", webviewToken: token });
  }

  private isCurrentPanelEpoch(
    panel: vscode.WebviewPanel,
    state: TablePanelRevealState,
    webviewEpoch: number,
  ): boolean {
    return this.panelRevealStates.get(panel) === state && state.epoch.isCurrent(webviewEpoch);
  }

  private updateDiagnostics(document: TableCustomDocument, items: readonly DocumentDiagnostic[]): void {
    this.diagnostics.set(document.uri, items.map((item) => {
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

  private updateReferenceDocument(document: TableCustomDocument): void {
    this.references.updateTableDocument(
      document.uri.toString(),
      document.match.project,
      document.match.documentType.id,
      document.tableType,
      document.document,
      document.sources,
    );
  }
}

function chooseRevealPanel(panels: ReadonlySet<vscode.WebviewPanel>): vscode.WebviewPanel | undefined {
  const values = [...panels];
  return values.find((panel) => panel.active && panel.visible)
    ?? values.find((panel) => panel.visible)
    ?? values[0];
}

async function loadTableSources(
  uri: vscode.Uri,
  match: DocumentMatch,
  tableType: TableTypeDefinition,
  layout: TableLayoutDefinition,
  projects: ProjectRegistry,
  backup?: TableBackup,
): Promise<{ readonly sources: TableSource[]; readonly document: TableDocument; readonly diagnostics: readonly DocumentDiagnostic[] }> {
  const backupBytes = new Map((backup?.sources ?? []).map((source) => [source.uri, Uint8Array.from(Buffer.from(source.bytes, "base64"))]));
  const activeDiskBytes = await vscode.workspace.fs.readFile(uri);
  const activeBytes = backupBytes.get(uri.toString()) ?? activeDiskBytes;
  if (isXlsx(activeBytes)) {
    const parsed = await parseXlsxTable(activeBytes, tableType, layout);
    if (!parsed.success) {
      throw new Error(formatDiagnostics(parsed.diagnostics));
    }
    return {
      sources: [{
        uri,
        physicalName: nodePath.basename(uri.fsPath),
        sheetIds: parsed.document.sheets.map((sheet) => sheet.id),
        originalBytes: activeDiskBytes,
        baseHash: hashBytes(activeDiskBytes),
      }],
      document: parsed.document,
      diagnostics: [...parsed.diagnostics, ...validateTableDocument(parsed.document, tableType)],
    };
  }

  const candidates = await findCsvFamilyUris(uri, match, tableType, projects);
  const sources: TableSource[] = [];
  const sheets: TableSheet[] = [];
  const diagnostics: DocumentDiagnostic[] = [];
  for (const candidate of candidates) {
    const diskBytes = await vscode.workspace.fs.readFile(candidate);
    const bytes = backupBytes.get(candidate.toString()) ?? diskBytes;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (errorValue) {
      throw new Error(`Unable to decode '${nodePath.basename(candidate.fsPath)}' as UTF-8: ${formatError(errorValue)}`);
    }
    const physicalName = nodePath.basename(candidate.fsPath, nodePath.extname(candidate.fsPath));
    const parsed = parseCsvTable(text, tableType, layout, physicalName);
    if (!parsed.success) {
      throw new Error(`${nodePath.basename(candidate.fsPath)}: ${formatDiagnostics(parsed.diagnostics)}`);
    }
    sheets.push(...parsed.document.sheets);
    diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: `${physicalName}.${diagnostic.path}`,
    })));
    sources.push({
      uri: candidate,
      physicalName,
      sheetIds: parsed.document.sheets.map((sheet) => sheet.id),
      originalBytes: diskBytes,
      baseHash: hashBytes(diskBytes),
    });
  }
  const document: TableDocument = { format: "csv", sheets };
  diagnostics.push(...validateTableDocument(document, tableType));
  return { sources, document, diagnostics };
}

async function findCsvFamilyUris(
  activeUri: vscode.Uri,
  activeMatch: DocumentMatch,
  tableType: TableTypeDefinition,
  projects: ProjectRegistry,
): Promise<readonly vscode.Uri[]> {
  if (!tableType.sheets.some((sheet) => sheet.partition !== undefined)) {
    return [activeUri];
  }
  const directory = activeUri.with({ path: nodePath.posix.dirname(activeUri.path) });
  const extension = nodePath.extname(activeUri.path).toLocaleLowerCase();
  const entries = await vscode.workspace.fs.readDirectory(directory);
  const candidates = entries.flatMap(([name, type]) => {
    if (type !== vscode.FileType.File || nodePath.extname(name).toLocaleLowerCase() !== extension) {
      return [];
    }
    const candidate = vscode.Uri.joinPath(directory, name);
    const candidateMatch = projects.resolveDocument(candidate);
    if (candidateMatch?.project.markerUri.toString() !== activeMatch.project.markerUri.toString()
      || candidateMatch.documentType.id !== activeMatch.documentType.id) {
      return [];
    }
    const physicalName = nodePath.basename(name, nodePath.extname(name));
    return matchTableSheetDefinitions(tableType, physicalName).some((sheet) => sheet.partition !== undefined)
      ? [candidate]
      : [];
  });
  if (!candidates.some((candidate) => candidate.toString() === activeUri.toString())) {
    candidates.push(activeUri);
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

async function renderAllSources(document: TableCustomDocument): Promise<ReadonlyMap<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const source of document.sources) {
    result.set(source.uri.toString(), await renderSource(document, source));
  }
  return result;
}

async function renderSource(document: TableCustomDocument, source: TableSource): Promise<Uint8Array> {
  const marked = markAllCellsChanged(document.document, document.tableType);
  if (document.document.format === "xlsx") {
    return serializeXlsxTable(source.originalBytes, marked, document.tableType, document.layout);
  }
  const sourceSheets = marked.sheets.filter((sheet) => source.sheetIds.includes(sheet.id));
  const originalText = new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes);
  return Buffer.from(serializeCsvTable({ format: "csv", sheets: sourceSheets }, document.tableType, originalText), "utf8");
}

function markAllCellsChanged(document: TableDocument, tableType: TableTypeDefinition): TableDocument {
  return {
    format: document.format,
    sheets: document.sheets.map((sheet) => {
      const definition = resolveTableSheet(tableType, sheet.definitionId);
      const columnIds = definition?.columns.map((column) => column.id) ?? [];
      return {
        ...sheet,
        rows: sheet.rows.map((row) => ({ ...row, changedColumnIds: columnIds })),
      };
    }),
  };
}

async function findConflict(sources: readonly TableSource[]): Promise<TableSource | undefined> {
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

type ExistingTableKeyRenameIntent =
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly message: string }
  | {
      readonly kind: "rename";
      readonly definition: ReferenceDefinition;
      readonly location: ReferenceLocation;
      readonly oldValue: string | number;
      readonly newValue: string | number;
    };

function classifyExistingTableKeyRename(
  document: TableCustomDocument,
  operations: unknown,
): ExistingTableKeyRenameIntent {
  if (!Array.isArray(operations)) return { kind: "none" };
  const intents = operations.flatMap((operation): ExistingTableKeyRenameIntent[] => {
    if (!isRecord(operation)
      || operation.type !== "table.setCell"
      || typeof operation.sheetId !== "string"
      || typeof operation.rowId !== "string"
      || typeof operation.columnId !== "string"
      || (typeof operation.value !== "string" && typeof operation.value !== "number")) {
      return [];
    }
    const sheet = document.document.sheets.find((candidate) => candidate.id === operation.sheetId);
    const row = sheet?.rows.find((candidate) => candidate.id === operation.rowId);
    const savedSheet = document.savedDocument.sheets.find((candidate) => candidate.id === operation.sheetId);
    const savedRow = savedSheet?.rows.find((candidate) => candidate.id === operation.rowId);
    const sheetDefinition = sheet === undefined ? undefined : resolveTableSheet(document.tableType, sheet.definitionId);
    const keyColumn = sheetDefinition?.keyColumnId === undefined
      ? undefined
      : resolveTableColumn(sheetDefinition, sheetDefinition.keyColumnId);
    const editedColumn = sheetDefinition === undefined
      ? undefined
      : resolveTableColumn(sheetDefinition, operation.columnId);
    if (sheet === undefined
      || sheetDefinition === undefined
      || row === undefined
      || savedRow === undefined
      || keyColumn === undefined
      || editedColumn?.id !== keyColumn.id) {
      return [];
    }
    const oldValue = row.cells[keyColumn.id];
    if ((typeof oldValue !== "string" && typeof oldValue !== "number")
      || referenceValuesEqual(oldValue, operation.value)) {
      return [];
    }
    const source = document.sources.find((candidate) => candidate.sheetIds.includes(sheet.id));
    if (source === undefined) {
      return [{ kind: "blocked", message: "The physical source for this existing Table row is unavailable." }];
    }
    return [{
      kind: "rename",
      definition: {
        kind: "table.row",
        target: {
          tableTypeId: document.tableType.id,
          sheetId: sheetDefinition.id,
          documentTypeId: document.match.documentType.id,
        },
        allowMissing: false,
      },
      location: {
        projectId: document.match.project.definition.projectId,
        documentTypeId: document.match.documentType.id,
        path: relativeProjectPath(document.match.project, source.uri),
        sheetId: sheet.id,
        rowId: row.id,
      },
      oldValue,
      newValue: operation.value,
    }];
  });
  if (intents.length === 0) return { kind: "none" };
  if (operations.length !== 1 || intents.length !== 1 || intents[0]?.kind !== "rename") {
    return {
      kind: "blocked",
      message: "An existing Table key rename must be the only operation in its batch.",
    };
  }
  return intents[0];
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
      // Best-effort cleanup only.
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
    return new Error(`Table save transaction failed (${errorValue.code}); no partial CSV family was committed. ${errorValue.message}`);
  }
  return errorValue instanceof Error ? errorValue : new Error(String(errorValue));
}

async function readBackup(uri: vscode.Uri): Promise<TableBackup> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
  const value = JSON.parse(text) as Partial<TableBackup>;
  if (value.formatVersion !== 1 || !Array.isArray(value.sources)) {
    throw new Error("Invalid VisualBridge Table backup.");
  }
  return value as TableBackup;
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
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

function createNonce(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex");
}

function cloneTableDocument(document: TableDocument): TableDocument {
  return JSON.parse(JSON.stringify(document)) as TableDocument;
}

function stableDocument(document: TableDocument): string {
  return JSON.stringify(document);
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
