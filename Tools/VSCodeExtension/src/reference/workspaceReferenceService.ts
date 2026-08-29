import * as nodePath from "node:path";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import {
  ReferenceService,
  type DocumentDiagnostic,
  type ReferenceCandidate,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type ReferenceResolution,
} from "@visualbridge/core";
import {
  createTableRowReferenceProvider,
  parseCsvTable,
  parseXlsxTable,
  resolveTableType,
  type TableDocument,
  type TableReferenceDocument,
  type TableSheet,
  type TableTypeDefinition,
} from "@visualbridge/table";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";

export const REVEAL_REFERENCE_COMMAND = "visualbridge.revealReference";

interface ReferenceQuickPickItem extends vscode.QuickPickItem {
  readonly candidate: ReferenceCandidate;
}

export class WorkspaceReferenceService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tableDocuments = new Map<string, Promise<readonly TableReferenceDocument[]>>();
  private readonly openTableDocuments = new Map<string, {
    readonly projectKey: string;
    readonly sourcePaths: ReadonlySet<string>;
    readonly document: TableReferenceDocument;
    readonly sequence: number;
  }>();
  private openTableSequence = 0;

  public constructor(
    projects: ProjectRegistry,
    private readonly output: vscode.OutputChannel,
  ) {
    const clear = (): void => this.tableDocuments.clear();
    this.disposables.push(
      projects.onDidChange(clear),
      vscode.workspace.onDidCreateFiles(clear),
      vscode.workspace.onDidDeleteFiles(clear),
      vscode.workspace.onDidRenameFiles(clear),
      vscode.workspace.onDidSaveTextDocument(clear),
      vscode.workspace.onDidChangeTextDocument(clear),
    );
  }

  public search(
    project: ProjectContext,
    definition: ReferenceDefinition,
    query = "",
    limit = 200,
  ): Promise<readonly ReferenceCandidate[]> {
    return this.createService(project).search(definition, query, limit);
  }

  public resolve(
    project: ProjectContext,
    definition: ReferenceDefinition,
    value: string | number,
  ): Promise<ReferenceResolution> {
    return this.createService(project).resolve(definition, value);
  }

  public invalidate(): void {
    this.tableDocuments.clear();
  }

  public validate(
    project: ProjectContext,
    occurrences: readonly ReferenceOccurrence[],
  ) {
    return this.createService(project).validate(occurrences);
  }

  public async validateChange(
    project: ProjectContext,
    before: readonly ReferenceOccurrence[],
    after: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly introducedErrors: readonly DocumentDiagnostic[];
  }> {
    const service = this.createService(project);
    const baseline = diagnosticCounts(await service.validate(before));
    const diagnostics = await service.validate(after);
    const introducedErrors = diagnostics.filter((diagnostic) => {
      if (diagnostic.severity !== "error") {
        return false;
      }
      const key = diagnosticKey(diagnostic);
      const count = baseline.get(key) ?? 0;
      if (count === 0) {
        return true;
      }
      baseline.set(key, count - 1);
      return false;
    });
    return { diagnostics, introducedErrors };
  }

  public async pick(
    project: ProjectContext,
    definition: ReferenceDefinition,
    currentValue: string | number,
  ): Promise<ReferenceCandidate | undefined> {
    const candidates = await this.search(project, definition, "", 200);
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(
        `没有找到 '${definition.kind}' 的可选引用；请检查目标表格、Catalog 和引用选择器。`,
      );
      return undefined;
    }
    const items: ReferenceQuickPickItem[] = candidates.map((candidate) => ({
      label: candidate.title,
      description: `${String(candidate.value)}${sameReferenceValue(candidate.value, currentValue) ? " · 当前" : ""}`,
      ...(candidate.location === undefined
        ? candidate.description === undefined ? {} : { detail: candidate.description }
        : { detail: `${candidate.description ?? definition.kind} — ${candidate.location.path}` }),
      candidate,
    }));
    return (await vscode.window.showQuickPick(items, {
      title: "选择 VisualBridge 引用",
      placeHolder: "按名称、稳定 ID 或来源文件筛选",
      matchOnDescription: true,
      matchOnDetail: true,
    }))?.candidate;
  }

  public async reveal(
    project: ProjectContext,
    definition: ReferenceDefinition,
    value: string | number,
  ): Promise<void> {
    const resolution = await this.resolve(project, definition, value);
    let candidate = resolution.candidates[0];
    if (resolution.status === "ambiguous") {
      const items: ReferenceQuickPickItem[] = resolution.candidates.map((entry) => ({
        label: entry.title,
        description: String(entry.value),
        ...(entry.location?.path === undefined ? {} : { detail: entry.location.path }),
        candidate: entry,
      }));
      candidate = (await vscode.window.showQuickPick(items, {
        title: "选择要打开的引用目标",
        matchOnDescription: true,
        matchOnDetail: true,
      }))?.candidate;
    }
    if (candidate?.location === undefined) {
      void vscode.window.showWarningMessage(`引用 '${String(value)}' 当前无法定位。`);
      return;
    }
    await vscode.commands.executeCommand(REVEAL_REFERENCE_COMMAND, candidate.location);
  }

  public updateTableDocument(
    ownerId: string,
    project: ProjectContext,
    documentTypeId: string,
    tableType: TableTypeDefinition,
    document: TableDocument,
    sources: readonly { readonly uri: vscode.Uri; readonly sheetIds: readonly string[] }[],
  ): void {
    const projectKey = project.markerUri.toString();
    const sourcePaths = sources.map((source) => relativeProjectPath(project, source.uri)).sort();
    const sheetPaths: Record<string, string> = {};
    sources.forEach((source) => {
      const relativePath = relativeProjectPath(project, source.uri);
      source.sheetIds.forEach((sheetId) => { sheetPaths[sheetId] = relativePath; });
    });
    this.openTableDocuments.set(ownerId, {
      projectKey,
      sourcePaths: new Set(sourcePaths),
      document: referenceDocument(
        project,
        documentTypeId,
        sourcePaths[0] ?? "",
        document,
        tableType,
        sheetPaths,
      ),
      sequence: ++this.openTableSequence,
    });
  }

  public removeTableDocument(ownerId: string): void {
    this.openTableDocuments.delete(ownerId);
  }

  public dispose(): void {
    this.tableDocuments.clear();
    this.openTableDocuments.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private createService(project: ProjectContext): ReferenceService {
    return new ReferenceService([
      createTableRowReferenceProvider(() => this.loadTableDocuments(project)),
    ]);
  }

  private async loadTableDocuments(project: ProjectContext): Promise<readonly TableReferenceDocument[]> {
    const key = project.markerUri.toString();
    const existing = this.tableDocuments.get(key);
    let loading = existing;
    if (loading === undefined) {
      loading = loadProjectTableDocuments(project, this.output).catch((errorValue: unknown) => {
        this.tableDocuments.delete(key);
        throw errorValue;
      });
      this.tableDocuments.set(key, loading);
    }
    const diskDocuments = await loading;
    const overrides = selectCurrentOverrides(
      [...this.openTableDocuments.values()].filter((entry) => entry.projectKey === key),
    );
    const visibleDiskDocuments = diskDocuments.filter((document) => !overrides.some((entry) => (
      entry.document.documentTypeId === document.documentTypeId
      && documentSourcePaths(document).some((path) => entry.sourcePaths.has(path))
    )));
    return [...visibleDiskDocuments, ...overrides.map((entry) => entry.document)]
      .sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
  }
}

async function loadProjectTableDocuments(
  project: ProjectContext,
  output: vscode.OutputChannel,
): Promise<readonly TableReferenceDocument[]> {
  const layout = project.definition.tableLayout;
  if (layout === undefined) {
    return [];
  }
  const result: TableReferenceDocument[] = [];
  for (const documentType of project.definition.documentTypes.filter((candidate) => candidate.editor === "table")) {
    const catalog = await loadTableCatalogRegistry(project, documentType.catalogs);
    const tableType = catalog.ready ? resolveTableType(catalog.registry, documentType.id) : undefined;
    if (tableType === undefined) {
      output.appendLine(`[reference] Table Catalog for '${documentType.id}' is unavailable; row references cannot be indexed.`);
      continue;
    }
    const uris = await findDocumentUris(project, documentType.id, documentType.include);
    const csvGroups = new Map<string, vscode.Uri[]>();
    for (const uri of uris) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (isXlsx(bytes)) {
        const parsed = await parseXlsxTable(bytes, tableType, layout);
        if (parsed.success) {
          const relativePath = relativeProjectPath(project, uri);
          result.push(referenceDocument(
            project,
            documentType.id,
            relativePath,
            parsed.document,
            tableType,
            Object.fromEntries(parsed.document.sheets.map((sheet) => [sheet.id, relativePath])),
          ));
        } else {
          output.appendLine(`[reference] Skipped invalid Table '${uri.fsPath}': ${formatDiagnostics(parsed.diagnostics)}`);
        }
        continue;
      }
      const key = `${nodePath.dirname(uri.fsPath).toLocaleLowerCase()}\u0000${nodePath.extname(uri.fsPath).toLocaleLowerCase()}`;
      const group = csvGroups.get(key) ?? [];
      group.push(uri);
      csvGroups.set(key, group);
    }
    for (const group of csvGroups.values()) {
      const sheets: TableSheet[] = [];
      const sheetPaths: Record<string, string> = {};
      for (const uri of group.sort((left, right) => left.path.localeCompare(right.path))) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const physicalName = nodePath.basename(uri.fsPath, nodePath.extname(uri.fsPath));
          const parsed = parseCsvTable(text, tableType, layout, physicalName);
          if (!parsed.success) {
            output.appendLine(`[reference] Skipped invalid Table '${uri.fsPath}': ${formatDiagnostics(parsed.diagnostics)}`);
            continue;
          }
          const relativePath = relativeProjectPath(project, uri);
          sheets.push(...parsed.document.sheets);
          parsed.document.sheets.forEach((sheet) => { sheetPaths[sheet.id] = relativePath; });
        } catch (errorValue) {
          output.appendLine(`[reference] Skipped unreadable Table '${uri.fsPath}': ${formatError(errorValue)}`);
        }
      }
      if (sheets.length > 0) {
        const firstPath = sheetPaths[sheets[0]!.id]!;
        result.push(referenceDocument(
          project,
          documentType.id,
          firstPath,
          { format: "csv", sheets },
          tableType,
          sheetPaths,
        ));
      }
    }
  }
  return result.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
}

async function findDocumentUris(
  project: ProjectContext,
  documentTypeId: string,
  includes: readonly string[],
): Promise<readonly vscode.Uri[]> {
  const result = new Map<string, vscode.Uri>();
  for (const include of includes) {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(project.rootUri, include));
    for (const uri of uris) {
      const relativePath = relativeProjectPath(project, uri);
      const documentType = project.definition.documentTypes.find((candidate) => candidate.id === documentTypeId);
      if (documentType !== undefined
        && documentType.include.some((pattern) => minimatchPath(pattern, relativePath))
        && !documentType.exclude.some((pattern) => minimatchPath(pattern, relativePath))) {
        result.set(uri.toString(), uri);
      }
    }
  }
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function referenceDocument(
  project: ProjectContext,
  documentTypeId: string,
  path: string,
  document: TableDocument,
  tableType: TableTypeDefinition,
  sheetPaths: Readonly<Record<string, string>>,
): TableReferenceDocument {
  return {
    projectId: project.definition.projectId,
    documentTypeId,
    path,
    document,
    tableType,
    sheetPaths,
  };
}

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  return nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

function documentSourcePaths(document: TableReferenceDocument): readonly string[] {
  return [...new Set([document.path, ...Object.values(document.sheetPaths ?? {})])];
}

function selectCurrentOverrides<T extends {
  readonly document: TableReferenceDocument;
  readonly sourcePaths: ReadonlySet<string>;
  readonly sequence: number;
}>(entries: readonly T[]): readonly T[] {
  const selected: T[] = [];
  for (const entry of [...entries].sort((left, right) => right.sequence - left.sequence)) {
    if (!selected.some((current) => (
      current.document.documentTypeId === entry.document.documentTypeId
      && [...entry.sourcePaths].some((path) => current.sourcePaths.has(path))
    ))) {
      selected.push(entry);
    }
  }
  return selected;
}

function minimatchPath(pattern: string, relativePath: string): boolean {
  return minimatch(relativePath, pattern, { dot: true, nocase: process.platform === "win32" });
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function sameReferenceValue(left: string | number, right: string | number): boolean {
  return typeof left === typeof right && left === right;
}

function formatDiagnostics(diagnostics: readonly { readonly path: string; readonly message: string }[]): string {
  const first = diagnostics[0];
  return first === undefined ? "Unknown Table error." : `${first.path}: ${first.message}`;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function diagnosticCounts(diagnostics: readonly DocumentDiagnostic[]): Map<string, number> {
  const result = new Map<string, number>();
  diagnostics.filter((diagnostic) => diagnostic.severity === "error").forEach((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    result.set(key, (result.get(key) ?? 0) + 1);
  });
  return result;
}

function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`;
}
