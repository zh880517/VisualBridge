import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  searchIndexedDocuments,
  sortIndexedDocuments,
  summarizeDocumentIndex,
  type DocumentDiagnostic,
  type DocumentIndexSummary,
  type DocumentTypeDefinition,
  type IndexedDocument,
  type IndexedDocumentReference,
  type JsonValue,
  type ReferenceOccurrence,
} from "@visualbridge/core";
import {
  collectEntityReferences,
  parseEntityDocument,
  validateEntityDocument,
} from "@visualbridge/entity";
import {
  collectGraphReferences,
  parseGraphDocument,
  validateGraphDocument,
} from "@visualbridge/graph";
import {
  collectStructuredReferences,
  parseStructuredDocument,
  resolveStructuredConfigType,
  validateStructuredDocument,
} from "@visualbridge/structured";
import {
  collectTableReferences,
  matchTableSheetDefinitions,
  parseCsvTable,
  parseXlsxTable,
  resolveTableType,
  validateTableDocument,
  type TableDocument,
  type TableSheet,
  type TableTypeDefinition,
} from "@visualbridge/table";
import { minimatch } from "minimatch";
import { loadEntityCatalogRegistry } from "../catalog/entityCatalogLoader";
import { loadGraphCatalogRegistry } from "../catalog/graphCatalogLoader";
import { loadStructuredCatalogRegistry } from "../catalog/structuredCatalogLoader";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceProjectProviderService } from "../provider/workspaceProjectProviderService";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";

const SUPPORTED_EDITORS = new Set(["graph", "entity", "structured", "table"]);

export interface IncomingDocumentReference {
  readonly source: IndexedDocument;
  readonly reference: IndexedDocumentReference;
}

export type DocumentIndexRefreshResult =
  | { readonly status: "applied"; readonly epoch: number; readonly documents: readonly IndexedDocument[] }
  | { readonly status: "superseded"; readonly epoch: number }
  | { readonly status: "failed"; readonly epoch: number; readonly message: string };

export class WorkspaceDocumentIndex implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fileWatchers: vscode.Disposable[] = [];
  private documentsValue: readonly IndexedDocument[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<DocumentIndexRefreshResult> | undefined;
  private refreshRequested = false;
  private refreshVersion = 0;
  private validationPublished = false;
  private loadingValue = false;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
    private readonly providers?: WorkspaceProjectProviderService,
  ) {
    this.disposables.push(
      this.changeEmitter,
      projects.onDidChange(() => {
        this.configureWatchers();
        this.scheduleRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isIndexedUri(document.uri)) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  public get documents(): readonly IndexedDocument[] {
    return this.documentsValue;
  }

  public get loading(): boolean {
    return this.loadingValue;
  }

  public get summary(): DocumentIndexSummary {
    return summarizeDocumentIndex(this.documentsValue);
  }

  public async initialize(): Promise<void> {
    this.configureWatchers();
    await this.refresh();
  }

  public search(query: string): readonly IndexedDocument[] {
    return searchIndexedDocuments(this.documentsValue, query);
  }

  public incomingReferences(target: IndexedDocument): readonly IncomingDocumentReference[] {
    const targetPaths = new Set(target.sourcePaths);
    return this.documentsValue.flatMap((source) => source.references.flatMap((reference) => (
      reference.resolution.candidates.some((candidate) => {
        const location = candidate.location;
        return location?.projectId === target.projectId
          && location.documentTypeId === target.documentTypeId
          && targetPaths.has(location.path);
      })
        ? [{ source, reference }]
        : []
    ))).sort((left, right) => (
      `${left.source.title}\u0000${left.reference.occurrence.path}`
        .localeCompare(`${right.source.title}\u0000${right.reference.occurrence.path}`)
    ));
  }

  public async validateAll(): Promise<DocumentIndexSummary> {
    await this.refresh();
    this.validationPublished = true;
    this.publishDiagnostics();
    return this.summary;
  }

  public async refresh(): Promise<DocumentIndexRefreshResult> {
    this.refreshRequested = true;
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    const running = (async (): Promise<DocumentIndexRefreshResult> => {
      let result: DocumentIndexRefreshResult;
      do {
        this.refreshRequested = false;
        result = await this.refreshOnce();
      } while (this.refreshRequested || result.status === "superseded");
      return result;
    })();
    this.refreshPromise = running;
    try {
      return await running;
    } finally {
      if (this.refreshPromise === running) this.refreshPromise = undefined;
    }
  }

  private async refreshOnce(): Promise<DocumentIndexRefreshResult> {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const refreshVersion = ++this.refreshVersion;
    this.loadingValue = true;
    this.changeEmitter.fire();
    try {
      const loaded = (await Promise.all(this.projects.projects.map((project) => this.loadProject(project)))).flat();
      if (refreshVersion !== this.refreshVersion) {
        return { status: "superseded", epoch: refreshVersion };
      }
      this.documentsValue = sortIndexedDocuments(loaded);
      if (this.validationPublished) {
        this.publishDiagnostics();
      }
      const summary = this.summary;
      this.output.appendLine(
        `[documents] Indexed ${summary.documentCount} document(s): ${summary.errorCount} error(s), ${summary.warningCount} warning(s), ${summary.referenceCount} reference(s).`,
      );
      return { status: "applied", epoch: refreshVersion, documents: this.documentsValue };
    } catch (errorValue) {
      const message = formatError(errorValue);
      if (refreshVersion === this.refreshVersion) {
        this.output.appendLine(`[documents] Index refresh failed: ${message}`);
      }
      return { status: "failed", epoch: refreshVersion, message };
    } finally {
      if (refreshVersion === this.refreshVersion) {
        this.loadingValue = false;
        this.changeEmitter.fire();
      }
    }
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.disposeWatchers();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async loadProject(project: ProjectContext): Promise<readonly IndexedDocument[]> {
    const documents: IndexedDocument[] = [];
    for (const documentType of project.definition.documentTypes.filter((entry) => SUPPORTED_EDITORS.has(entry.editor))) {
      const uris = await findDocumentUris(project, documentType);
      if (documentType.editor === "graph") {
        const catalog = await loadGraphCatalogRegistry(project, documentType.catalogs);
        for (const uri of uris) {
          const path = relativeProjectPath(project, uri);
          try {
            const text = await readText(uri);
            const parsed = parseGraphDocument(text);
            if (!parsed.success) {
              documents.push(invalidDocument(project, documentType, path, [
                ...catalog.diagnostics,
                ...parsed.diagnostics,
              ]));
              continue;
            }
            const semanticDiagnostics = catalog.ready
              ? validateGraphDocument(parsed.document, catalog.registry)
              : [];
            const occurrences = catalog.ready
              ? collectGraphReferences(parsed.document, catalog.registry)
              : [];
            const referenceResult = await this.resolveReferences(project, occurrences);
            const providerDiagnostics = await this.providers?.validateDocument(project, {
              documentTypeId: documentType.id,
              path,
              sourceHash: hashText(text),
              content: parsed.document as unknown as JsonValue,
            }) ?? [];
            const root = parsed.document.graphs.find((graph) => graph.id === parsed.document.rootGraphId);
            documents.push({
              projectId: project.definition.projectId,
              documentTypeId: documentType.id,
              editor: documentType.editor,
              path,
              sourcePaths: [path],
              title: root?.title ?? fileTitle(path),
              documentId: parsed.document.documentId,
              diagnostics: [
                ...parsed.diagnostics,
                ...catalog.diagnostics,
                ...semanticDiagnostics,
                ...referenceResult.diagnostics,
                ...providerDiagnostics,
              ],
              references: referenceResult.references,
            });
          } catch (errorValue) {
            documents.push(unreadableDocument(project, documentType, path, errorValue));
          }
        }
      } else if (documentType.editor === "entity") {
        const catalog = await loadEntityCatalogRegistry(project, documentType.catalogs);
        for (const uri of uris) {
          const path = relativeProjectPath(project, uri);
          try {
            const text = await readText(uri);
            const parsed = parseEntityDocument(text);
            if (!parsed.success) {
              documents.push(invalidDocument(project, documentType, path, [
                ...catalog.diagnostics,
                ...parsed.diagnostics,
              ]));
              continue;
            }
            const semanticDiagnostics = catalog.ready
              ? validateEntityDocument(parsed.document, catalog.registry)
              : [];
            const occurrences = catalog.ready
              ? collectEntityReferences(parsed.document, catalog.registry)
              : [];
            const referenceResult = await this.resolveReferences(project, occurrences);
            const providerDiagnostics = await this.providers?.validateDocument(project, {
              documentTypeId: documentType.id,
              path,
              sourceHash: hashText(text),
              content: parsed.document as unknown as JsonValue,
            }) ?? [];
            documents.push({
              projectId: project.definition.projectId,
              documentTypeId: documentType.id,
              editor: documentType.editor,
              path,
              sourcePaths: [path],
              title: parsed.document.title,
              documentId: parsed.document.documentId,
              diagnostics: [
                ...parsed.diagnostics,
                ...catalog.diagnostics,
                ...semanticDiagnostics,
                ...referenceResult.diagnostics,
                ...providerDiagnostics,
              ],
              references: referenceResult.references,
            });
          } catch (errorValue) {
            documents.push(unreadableDocument(project, documentType, path, errorValue));
          }
        }
      } else if (documentType.editor === "structured") {
        const catalog = await loadStructuredCatalogRegistry(project, documentType.catalogs);
        const configType = catalog.ready
          ? resolveStructuredConfigType(catalog.registry, documentType.id)
          : undefined;
        for (const uri of uris) {
          const path = relativeProjectPath(project, uri);
          try {
            const text = await readText(uri);
            const parsed = parseStructuredDocument(text);
            if (!parsed.success) {
              documents.push(invalidDocument(project, documentType, path, [
                ...catalog.diagnostics,
                ...parsed.diagnostics,
              ]));
              continue;
            }
            const semanticDiagnostics = catalog.ready
              ? validateStructuredDocument(parsed.document, catalog.registry, documentType.id)
              : [];
            const occurrences = catalog.ready
              ? collectStructuredReferences(parsed.document, catalog.registry, documentType.id)
              : [];
            const referenceResult = await this.resolveReferences(project, occurrences);
            const providerDiagnostics = await this.providers?.validateDocument(project, {
              documentTypeId: documentType.id,
              path,
              sourceHash: hashText(text),
              content: parsed.document as unknown as JsonValue,
            }) ?? [];
            documents.push({
              projectId: project.definition.projectId,
              documentTypeId: documentType.id,
              editor: documentType.editor,
              path,
              sourcePaths: [path],
              title: configType?.title ?? fileTitle(path),
              documentId: parsed.document.documentId,
              diagnostics: [
                ...parsed.diagnostics,
                ...catalog.diagnostics,
                ...semanticDiagnostics,
                ...referenceResult.diagnostics,
                ...providerDiagnostics,
              ],
              references: referenceResult.references,
            });
          } catch (errorValue) {
            documents.push(unreadableDocument(project, documentType, path, errorValue));
          }
        }
      } else if (documentType.editor === "table") {
        documents.push(...await this.loadTableDocuments(project, documentType, uris));
      }
    }
    return documents;
  }

  private async loadTableDocuments(
    project: ProjectContext,
    documentType: DocumentTypeDefinition,
    uris: readonly vscode.Uri[],
  ): Promise<readonly IndexedDocument[]> {
    const layout = project.definition.tableLayout;
    const catalog = await loadTableCatalogRegistry(project, documentType.catalogs);
    const tableType = catalog.ready ? resolveTableType(catalog.registry, documentType.id) : undefined;
    if (layout === undefined || tableType === undefined) {
      const diagnostics = [
        ...catalog.diagnostics,
        ...(layout === undefined ? [{
          severity: "error" as const,
          code: "table.layoutNotConfigured",
          path: "tableLayout",
          message: "The project does not configure tableLayout.",
        }] : []),
        ...(catalog.ready && tableType === undefined ? [{
          severity: "error" as const,
          code: "table.unknownTableType",
          path: "documentType.id",
          message: `Document Type '${documentType.id}' does not resolve to a Table Type.`,
        }] : []),
      ];
      return uris.map((uri) => invalidDocument(
        project,
        documentType,
        relativeProjectPath(project, uri),
        diagnostics,
      ));
    }

    const result: IndexedDocument[] = [];
    const remaining = new Map(uris.map((uri) => [uri.toString(), uri]));
    while (remaining.size > 0) {
      const active = [...remaining.values()].sort((left, right) => left.path.localeCompare(right.path))[0]!;
      const activeBytes = await vscode.workspace.fs.readFile(active);
      if (isXlsx(activeBytes)) {
        remaining.delete(active.toString());
        result.push(await this.loadXlsxDocument(project, documentType, tableType, layout, catalog.diagnostics, active, activeBytes));
        continue;
      }
      const family = selectCsvFamily(active, [...remaining.values()], tableType);
      family.forEach((uri) => remaining.delete(uri.toString()));
      result.push(await this.loadCsvDocument(project, documentType, tableType, layout, catalog.diagnostics, family));
    }
    return result;
  }

  private async loadXlsxDocument(
    project: ProjectContext,
    documentType: DocumentTypeDefinition,
    tableType: TableTypeDefinition,
    layout: NonNullable<ProjectContext["definition"]["tableLayout"]>,
    catalogDiagnostics: readonly DocumentDiagnostic[],
    uri: vscode.Uri,
    bytes: Uint8Array,
  ): Promise<IndexedDocument> {
    const path = relativeProjectPath(project, uri);
    try {
      const parsed = await parseXlsxTable(bytes, tableType, layout);
      if (!parsed.success) {
        return invalidDocument(project, documentType, path, [...catalogDiagnostics, ...parsed.diagnostics]);
      }
      return await this.createTableIndexEntry(
        project,
        documentType,
        tableType,
        parsed.document,
        [path],
        [...catalogDiagnostics, ...parsed.diagnostics],
      );
    } catch (errorValue) {
      return unreadableDocument(project, documentType, path, errorValue);
    }
  }

  private async loadCsvDocument(
    project: ProjectContext,
    documentType: DocumentTypeDefinition,
    tableType: TableTypeDefinition,
    layout: NonNullable<ProjectContext["definition"]["tableLayout"]>,
    catalogDiagnostics: readonly DocumentDiagnostic[],
    uris: readonly vscode.Uri[],
  ): Promise<IndexedDocument> {
    const sourcePaths = uris.map((uri) => relativeProjectPath(project, uri)).sort();
    const diagnostics: DocumentDiagnostic[] = [...catalogDiagnostics];
    const sheets: TableSheet[] = [];
    for (const uri of uris) {
      const physicalName = nodePath.basename(uri.fsPath, nodePath.extname(uri.fsPath));
      try {
        const parsed = parseCsvTable(await readText(uri), tableType, layout, physicalName);
        if (!parsed.success) {
          diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            path: `${physicalName}.${diagnostic.path}`,
          })));
        } else {
          sheets.push(...parsed.document.sheets);
          diagnostics.push(...parsed.diagnostics);
        }
      } catch (errorValue) {
        diagnostics.push({
          severity: "error",
          code: "document.unreadable",
          path: physicalName,
          message: formatError(errorValue),
        });
      }
    }
    return this.createTableIndexEntry(
      project,
      documentType,
      tableType,
      { format: "csv", sheets },
      sourcePaths,
      diagnostics,
    );
  }

  private async createTableIndexEntry(
    project: ProjectContext,
    documentType: DocumentTypeDefinition,
    tableType: TableTypeDefinition,
    document: TableDocument,
    sourcePaths: readonly string[],
    diagnostics: readonly DocumentDiagnostic[],
  ): Promise<IndexedDocument> {
    const semanticDiagnostics = validateTableDocument(document, tableType);
    const referenceResult = await this.resolveReferences(
      project,
      collectTableReferences(document, tableType),
    );
    const providerDiagnostics = await this.providers?.validateDocument(project, {
      documentTypeId: documentType.id,
      path: sourcePaths[0] ?? "",
      sourceHash: hashText(JSON.stringify(document)),
      content: document as unknown as JsonValue,
    }) ?? [];
    return {
      projectId: project.definition.projectId,
      documentTypeId: documentType.id,
      editor: documentType.editor,
      path: sourcePaths[0] ?? "",
      sourcePaths,
      title: tableType.title,
      diagnostics: [...diagnostics, ...semanticDiagnostics, ...referenceResult.diagnostics, ...providerDiagnostics],
      references: referenceResult.references,
    };
  }

  private async resolveReferences(
    project: ProjectContext,
    occurrences: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly references: readonly IndexedDocumentReference[];
  }> {
    const [diagnostics, references] = await Promise.all([
      this.references.validate(project, occurrences),
      Promise.all(occurrences.map(async (occurrence) => ({
        occurrence,
        resolution: await this.references.resolve(project, occurrence.definition, occurrence.value),
      }))),
    ]);
    return { diagnostics, references };
  }

  private configureWatchers(): void {
    this.disposeWatchers();
    const seen = new Set<string>();
    for (const project of this.projects.projects) {
      for (const documentType of project.definition.documentTypes.filter((entry) => SUPPORTED_EDITORS.has(entry.editor))) {
        for (const pattern of [...documentType.include, ...documentType.catalogs]) {
          const key = `${project.rootUri.toString()}\u0000${pattern}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.rootUri, pattern));
          this.fileWatchers.push(
            watcher,
            watcher.onDidCreate(() => this.scheduleRefresh()),
            watcher.onDidChange(() => this.scheduleRefresh()),
            watcher.onDidDelete(() => this.scheduleRefresh()),
          );
        }
      }
    }
  }

  private disposeWatchers(): void {
    for (const disposable of this.fileWatchers.splice(0)) {
      disposable.dispose();
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshPromise !== undefined) {
      this.refreshRequested = true;
      return;
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 200);
  }

  private isIndexedUri(uri: vscode.Uri): boolean {
    if (this.projects.resolveDocument(uri) !== undefined) {
      return true;
    }
    return this.projects.projects.some((project) => project.definition.documentTypes.some((documentType) => (
      documentType.catalogs.some((catalogPath) => vscode.Uri.joinPath(
        project.rootUri,
        ...catalogPath.split("/"),
      ).toString() === uri.toString())
    )));
  }

  private publishDiagnostics(): void {
    this.diagnostics.clear();
    for (const project of this.projects.projects) {
      const projectDocuments = this.documentsValue.filter((document) => document.projectId === project.definition.projectId);
      for (const document of projectDocuments) {
        const uri = vscode.Uri.joinPath(project.rootUri, ...document.path.split("/"));
        this.diagnostics.set(uri, document.diagnostics.map(toVscodeDiagnostic));
      }
    }
  }
}

async function findDocumentUris(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
): Promise<readonly vscode.Uri[]> {
  const result = new Map<string, vscode.Uri>();
  for (const include of documentType.include) {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(project.rootUri, include));
    for (const uri of uris) {
      const path = relativeProjectPath(project, uri);
      if (
        documentType.include.some((pattern) => matches(pattern, path))
        && !documentType.exclude.some((pattern) => matches(pattern, path))
      ) {
        result.set(uri.toString(), uri);
      }
    }
  }
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function selectCsvFamily(
  active: vscode.Uri,
  candidates: readonly vscode.Uri[],
  tableType: TableTypeDefinition,
): readonly vscode.Uri[] {
  if (!tableType.sheets.some((sheet) => sheet.partition !== undefined)) {
    return [active];
  }
  const activeDirectory = nodePath.dirname(active.fsPath).toLocaleLowerCase();
  const activeExtension = nodePath.extname(active.fsPath).toLocaleLowerCase();
  const physicalName = nodePath.basename(active.fsPath, nodePath.extname(active.fsPath));
  const activeIsPartition = matchTableSheetDefinitions(tableType, physicalName)
    .some((sheet) => sheet.partition !== undefined);
  if (!activeIsPartition) {
    return [active];
  }
  return candidates.filter((candidate) => {
    if (
      nodePath.dirname(candidate.fsPath).toLocaleLowerCase() !== activeDirectory
      || nodePath.extname(candidate.fsPath).toLocaleLowerCase() !== activeExtension
    ) {
      return false;
    }
    const name = nodePath.basename(candidate.fsPath, nodePath.extname(candidate.fsPath));
    return matchTableSheetDefinitions(tableType, name).some((sheet) => sheet.partition !== undefined);
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function invalidDocument(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  diagnostics: readonly DocumentDiagnostic[],
): IndexedDocument {
  return {
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    editor: documentType.editor,
    path,
    sourcePaths: [path],
    title: fileTitle(path),
    diagnostics,
    references: [],
  };
}

function unreadableDocument(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  errorValue: unknown,
): IndexedDocument {
  return invalidDocument(project, documentType, path, [{
    severity: "error",
    code: "document.unreadable",
    path: "$",
    message: formatError(errorValue),
  }]);
}

function toVscodeDiagnostic(item: DocumentDiagnostic): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 1),
    `${item.path}: ${item.message}`,
    item.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.code = item.code;
  diagnostic.source = "VisualBridge Workspace";
  return diagnostic;
}

function matches(pattern: string, relativePath: string): boolean {
  return minimatch(relativePath, pattern, { dot: true, nocase: process.platform === "win32" });
}

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  return nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

function fileTitle(path: string): string {
  return nodePath.basename(path, nodePath.extname(path));
}

async function readText(uri: vscode.Uri): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (openDocument !== undefined) {
    return openDocument.getText();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && bytes[2] === 0x03
    && bytes[3] === 0x04;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
