import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { DocumentDiagnostic, TableLayoutDefinition } from "@visualbridge/core";
import {
  TABLE_EDITOR_ID,
  applyTableOperations,
  matchTableSheetDefinitions,
  parseCsvTable,
  parseXlsxTable,
  resolveTableSheet,
  resolveTableType,
  serializeCsvTable,
  serializeXlsxTable,
  validateTableDocument,
  type TableDocument,
  type TableSheet,
  type TableTypeDefinition,
} from "@visualbridge/table";
import { createTableEditorHtml } from "@visualbridge/table-editor";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";

export const TABLE_EDITOR_VIEW_TYPE = "visualbridge.tableEditor";

interface WebviewMessage {
  readonly type?: unknown;
  readonly revision?: unknown;
  readonly operations?: unknown;
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
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stateEmitter.dispose();
  }
}

export class TableEditorProvider implements vscode.CustomEditorProvider<TableCustomDocument>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<TableCustomDocument>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panels = new Map<TableCustomDocument, Set<vscode.WebviewPanel>>();
  private operationQueue: Promise<void> = Promise.resolve();

  public readonly onDidChangeCustomDocument = this.changeEmitter.event;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectRegistry,
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
    const document = new TableCustomDocument(uri, match, tableType, layout, loaded.sources, loaded.document);
    this.updateDiagnostics(document, [...catalogResult.diagnostics, ...loaded.diagnostics]);
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
    const stateSubscription = document.onDidChangeState(() => void this.sendState(document));
    const messageSubscription = panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this.operationQueue = this.operationQueue
        .then(() => this.handleMessage(document, panel, message))
        .catch((errorValue: unknown) => {
          this.output.appendLine(`[table] Operation failed: ${formatError(errorValue)}`);
          return panel.webview.postMessage({ type: "operationRejected", message: formatError(errorValue) }).then(() => undefined);
        });
    });
    panel.onDidDispose(() => {
      stateSubscription.dispose();
      messageSubscription.dispose();
      const currentPanels = this.panels.get(document);
      currentPanels?.delete(panel);
      if (currentPanels?.size === 0) {
        this.panels.delete(document);
      }
    });
    await this.sendState(document);
  }

  public async saveCustomDocument(document: TableCustomDocument): Promise<void> {
    await this.saveToSources(document, document.sources);
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
  }

  private async handleMessage(
    document: TableCustomDocument,
    panel: vscode.WebviewPanel,
    message: WebviewMessage,
  ): Promise<void> {
    if (message.type === "ready") {
      await this.sendState(document);
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
    const before = cloneTableDocument(document.document);
    const after = cloneTableDocument(result.document);
    document.update(after);
    this.updateDiagnostics(document, result.diagnostics);
    this.changeEmitter.fire({
      document,
      label: "Edit VisualBridge Table",
      undo: async () => document.update(before),
      redo: async () => document.update(after),
    });
    this.output.appendLine(`[table] Applied operations to ${document.match.relativePath} at revision ${document.revision}.`);
    await panel.webview.postMessage({ type: "operationCompleted", changed: true });
  }

  private async saveToSources(document: TableCustomDocument, sources: readonly TableSource[]): Promise<void> {
    const conflict = await findConflict(sources);
    if (conflict !== undefined) {
      throw new Error(`Save refused because '${nodePath.basename(conflict.uri.fsPath)}' changed on disk.`);
    }
    const rendered = await renderAllSources(document);
    for (const source of sources) {
      const bytes = rendered.get(source.uri.toString());
      if (bytes !== undefined && hashBytes(bytes) !== source.baseHash) {
        await atomicWrite(source.uri, bytes);
      }
    }
    document.markSaved(rendered);
    this.updateDiagnostics(document, validateTableDocument(document.document, document.tableType));
  }

  private async sendState(document: TableCustomDocument): Promise<void> {
    const diagnostics = validateTableDocument(document.document, document.tableType);
    this.updateDiagnostics(document, diagnostics);
    const message = {
      type: "tableState",
      revision: document.revision,
      document: document.document,
      tableType: document.tableType,
      isDirty: document.isDirty,
      diagnostics,
    };
    await Promise.all([...this.panels.get(document) ?? []].map((panel) => panel.webview.postMessage(message)));
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
      if (hashBytes(bytes) !== source.baseHash) {
        return source;
      }
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
      // Best-effort cleanup only.
    }
    throw errorValue;
  }
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
