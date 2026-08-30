import * as vscode from "vscode";
import {
  IncrementalSemanticSnapshotStore,
  searchIndexedDocuments,
  sortIndexedDocuments,
  summarizeDocumentIndex,
  type DocumentDiagnostic,
  type DocumentIndexSummary,
  type IndexedDocument,
  type IndexedDocumentReference,
} from "@visualbridge/core";
import type { ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceProjectProviderService } from "../provider/workspaceProjectProviderService";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import {
  buildReferenceSnapshots,
  planWorkspaceSemanticSources,
  type PreparedWorkspaceDocument,
} from "./workspaceSemanticSnapshotBuilder";

const SUPPORTED_EDITORS = new Set(["graph", "entity", "structured", "table"]);

export interface IncomingDocumentReference {
  readonly source: IndexedDocument;
  readonly reference: IndexedDocumentReference;
}

export type DocumentIndexRefreshResult =
  | { readonly status: "applied"; readonly epoch: number; readonly documents: readonly IndexedDocument[] }
  | { readonly status: "superseded"; readonly epoch: number }
  | { readonly status: "cancelled"; readonly epoch: number }
  | { readonly status: "failed"; readonly epoch: number; readonly message: string };

export interface DocumentIndexProgress {
  readonly epoch: number;
  readonly phase: "discover" | "semantic" | "reference" | "provider";
  readonly completed: number;
  readonly total: number;
  readonly loaded: number;
  readonly reused: number;
}

export interface DocumentIndexRefreshStats {
  readonly epoch: number;
  readonly planned: number;
  readonly loaded: number;
  readonly reused: number;
}

export class WorkspaceDocumentIndex implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly progressEmitter = new vscode.EventEmitter<DocumentIndexProgress>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fileWatchers: vscode.Disposable[] = [];
  private readonly semanticStore = new IncrementalSemanticSnapshotStore<PreparedWorkspaceDocument>();
  private documentsValue: readonly IndexedDocument[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<DocumentIndexRefreshResult> | undefined;
  private refreshRequested = false;
  private refreshVersion = 0;
  private activeRefreshController: AbortController | undefined;
  private pendingSignal: AbortSignal | undefined;
  private validationPublished = false;
  private loadingValue = false;
  private refreshStatsValue: DocumentIndexRefreshStats = { epoch: 0, planned: 0, loaded: 0, reused: 0 };

  public readonly onDidChange = this.changeEmitter.event;
  public readonly onDidProgress = this.progressEmitter.event;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
    private readonly providers?: WorkspaceProjectProviderService,
  ) {
    this.disposables.push(
      this.changeEmitter,
      this.progressEmitter,
      projects.onDidChange(() => {
        this.configureWatchers();
        this.scheduleRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isIndexedUri(document.uri)) this.scheduleRefresh();
      }),
    );
  }

  public get documents(): readonly IndexedDocument[] { return this.documentsValue; }
  public get loading(): boolean { return this.loadingValue; }
  public get summary(): DocumentIndexSummary { return summarizeDocumentIndex(this.documentsValue); }
  public get refreshStats(): DocumentIndexRefreshStats { return this.refreshStatsValue; }

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
      }) ? [{ source, reference }] : []
    ))).sort((left, right) => compareOrdinal(
      `${left.source.title}\u0000${left.reference.occurrence.path}`,
      `${right.source.title}\u0000${right.reference.occurrence.path}`,
    ));
  }

  public async validateAll(): Promise<DocumentIndexSummary> {
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "VisualBridge: validating authoring documents",
      cancellable: true,
    }, async (progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      const progressSubscription = this.onDidProgress((event) => {
        progress.report({ message: `${event.phase} ${event.completed}/${event.total}` });
      });
      try {
        return await this.refresh(controller.signal);
      } finally {
        cancellation.dispose();
        progressSubscription.dispose();
      }
    });
    if (result.status === "applied") {
      this.validationPublished = true;
      this.publishDiagnostics();
    }
    return this.summary;
  }

  public async refresh(signal?: AbortSignal): Promise<DocumentIndexRefreshResult> {
    this.refreshRequested = true;
    this.pendingSignal = signal;
    this.refreshVersion += 1;
    this.activeRefreshController?.abort();
    this.semanticStore.cancel();
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    const running = (async (): Promise<DocumentIndexRefreshResult> => {
      let result: DocumentIndexRefreshResult;
      do {
        this.refreshRequested = false;
        const requestedVersion = this.refreshVersion;
        const requestedSignal = this.pendingSignal;
        this.pendingSignal = undefined;
        result = await this.refreshOnce(requestedVersion, requestedSignal);
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

  public async rebuild(signal?: AbortSignal): Promise<DocumentIndexRefreshResult> {
    this.semanticStore.invalidate();
    return this.refresh(signal);
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.activeRefreshController?.abort();
    this.semanticStore.cancel();
    this.disposeWatchers();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async refreshOnce(refreshVersion: number, externalSignal?: AbortSignal): Promise<DocumentIndexRefreshResult> {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const controller = new AbortController();
    this.activeRefreshController = controller;
    const removeAbortListener = forwardAbort(externalSignal, controller);
    this.loadingValue = true;
    this.changeEmitter.fire();
    try {
      this.progressEmitter.fire({ epoch: refreshVersion, phase: "discover", completed: 0, total: 0, loaded: 0, reused: 0 });
      const planned = await planWorkspaceSemanticSources(this.projects.projects, controller.signal);
      throwIfAborted(controller.signal);
      const semantic = await this.semanticStore.rebuild(planned, {
        signal: controller.signal,
        onProgress: (item) => this.progressEmitter.fire({ epoch: refreshVersion, phase: "semantic", ...item }),
      });
      if (semantic.status !== "applied") return { status: semantic.status, epoch: refreshVersion };
      if (refreshVersion !== this.refreshVersion) return { status: "superseded", epoch: refreshVersion };

      const prepared = semantic.snapshot.values;
      const snapshots = buildReferenceSnapshots(this.projects.projects, prepared);
      const currentProjects = new Map(this.projects.projects.map((project) => [project.markerUri.toString(), project]));
      const loaded: IndexedDocument[] = [];
      for (const [index, entry] of prepared.entries()) {
        throwIfAborted(controller.signal);
        const progressBase = {
          epoch: refreshVersion,
          completed: index,
          total: prepared.length,
          loaded: semantic.snapshot.loaded,
          reused: semantic.snapshot.reused,
        };
        this.progressEmitter.fire({ ...progressBase, phase: "reference" });
        const project = currentProjects.get(entry.projectKey);
        if (project === undefined) throw new Error(`Project snapshot owner '${entry.projectKey}' is unavailable.`);
        const snapshot = snapshots.get(entry.projectKey);
        if (snapshot === undefined) throw new Error(`Project snapshot '${project.definition.projectId}' is unavailable.`);
        const referenceResult = await this.references.analyzeSnapshot(
          project,
          snapshot,
          entry.occurrences,
          controller.signal,
        );
        throwIfAborted(controller.signal);
        this.progressEmitter.fire({ ...progressBase, phase: "provider" });
        const providerDiagnostics = entry.providerSnapshot === undefined
          ? []
          : await this.providers?.validateDocument(
            project,
            entry.providerSnapshot,
            controller.signal,
            snapshot.dependencyKey,
          ) ?? [];
        loaded.push({
          ...entry.document,
          diagnostics: [...entry.diagnostics, ...referenceResult.diagnostics, ...providerDiagnostics],
          references: referenceResult.references,
        });
      }
      throwIfAborted(controller.signal);
      if (refreshVersion !== this.refreshVersion) return { status: "superseded", epoch: refreshVersion };

      for (const project of this.projects.projects) {
        const snapshot = snapshots.get(project.markerUri.toString());
        if (snapshot !== undefined) this.references.updateProjectSnapshot(project, snapshot);
      }
      this.documentsValue = sortIndexedDocuments(loaded);
      this.refreshStatsValue = Object.freeze({
        epoch: refreshVersion,
        planned: planned.length,
        loaded: semantic.snapshot.loaded,
        reused: semantic.snapshot.reused,
      });
      if (this.validationPublished) this.publishDiagnostics();
      const summary = this.summary;
      this.output.appendLine(
        `[documents] Indexed ${summary.documentCount} document(s): ${summary.errorCount} error(s), ${summary.warningCount} warning(s), ${summary.referenceCount} reference(s); semantic ${semantic.snapshot.loaded} loaded, ${semantic.snapshot.reused} reused.`,
      );
      return { status: "applied", epoch: refreshVersion, documents: this.documentsValue };
    } catch (errorValue) {
      if (isAbortError(errorValue) || controller.signal.aborted) {
        return { status: refreshVersion === this.refreshVersion ? "cancelled" : "superseded", epoch: refreshVersion };
      }
      const message = formatError(errorValue);
      if (refreshVersion === this.refreshVersion) this.output.appendLine(`[documents] Index refresh failed: ${message}`);
      return { status: "failed", epoch: refreshVersion, message };
    } finally {
      removeAbortListener();
      if (this.activeRefreshController === controller) this.activeRefreshController = undefined;
      if (refreshVersion === this.refreshVersion) {
        this.loadingValue = false;
        this.changeEmitter.fire();
      }
    }
  }

  private configureWatchers(): void {
    this.disposeWatchers();
    const seen = new Set<string>();
    for (const project of this.projects.projects) {
      for (const documentType of project.definition.documentTypes.filter((entry) => SUPPORTED_EDITORS.has(entry.editor))) {
        for (const pattern of [...documentType.include, ...documentType.catalogs]) {
          const key = `${project.rootUri.toString()}\u0000${pattern}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.rootUri, pattern));
          this.fileWatchers.push(
            watcher,
            watcher.onDidCreate((uri) => this.scheduleRefreshForUri(uri)),
            watcher.onDidChange((uri) => this.scheduleRefreshForUri(uri)),
            watcher.onDidDelete((uri) => this.scheduleRefreshForUri(uri)),
          );
        }
      }
    }
  }

  private disposeWatchers(): void {
    for (const disposable of this.fileWatchers.splice(0)) disposable.dispose();
  }

  private scheduleRefresh(): void {
    if (this.refreshPromise !== undefined) {
      this.refreshRequested = true;
      this.refreshVersion += 1;
      this.activeRefreshController?.abort();
      this.semanticStore.cancel();
      return;
    }
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 200);
  }

  private scheduleRefreshForUri(uri: vscode.Uri): void {
    if (this.isIndexedUri(uri)) this.scheduleRefresh();
  }

  private isIndexedUri(uri: vscode.Uri): boolean {
    if (this.projects.resolveDocument(uri) !== undefined) return true;
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

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = (): void => controller.abort();
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Workspace document index refresh was cancelled.", "AbortError");
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
