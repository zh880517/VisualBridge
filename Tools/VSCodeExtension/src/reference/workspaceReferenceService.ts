import * as vscode from "vscode";
import {
  createDocumentReferenceProvider,
  ReferenceService,
  type DocumentReferenceDocument,
  type DocumentDiagnostic,
  type ProjectProviderDocumentSnapshot,
  type ReferenceCandidate,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type ReferenceProvider,
  type ReferenceResolution,
} from "@visualbridge/core";
import { documentFacetEntries } from "../modules/documentFacetRegistry";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceProjectProviderService } from "../provider/workspaceProjectProviderService";
import { loadProjectReferenceSnapshots } from "../document/workspaceSemanticSnapshotBuilder";
import { projectSemanticSnapshotDependencyKey } from "../document/projectSemanticDependency";
import { selectCurrentOverrides } from "./openDocumentOverrides";

export const REVEAL_REFERENCE_COMMAND = "visualbridge.revealReference";

/** 一个文档为某模块贡献的引用数据（宿主只做信封，不解释 `data`）。 */
export interface WorkspaceReferenceDataEntry {
  readonly documentTypeId: string;
  readonly sourcePaths: readonly string[];
  readonly data: unknown;
}

/** 每个 Project 的语义快照：内建 `document` 候选 + 按模块分组的引用数据。 */
export interface WorkspaceProjectSemanticSnapshot {
  readonly dependencyKey: string;
  readonly documents: readonly DocumentReferenceDocument[];
  readonly referenceData: Readonly<Record<string, readonly WorkspaceReferenceDataEntry[]>>;
}

interface ReferenceQuickPickItem extends vscode.QuickPickItem {
  readonly candidate: ReferenceCandidate;
}

interface OpenDocumentReferenceData {
  readonly projectKey: string;
  readonly moduleId: string;
  readonly documentTypeId: string;
  readonly sourcePaths: ReadonlySet<string>;
  readonly data: unknown;
  readonly sequence: number;
}

export class WorkspaceReferenceService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fallbackSnapshots = new Map<string, Promise<WorkspaceProjectSemanticSnapshot>>();
  private readonly openDocuments = new Map<string, OpenDocumentReferenceData>();
  private readonly snapshots = new Map<string, WorkspaceProjectSemanticSnapshot>();
  private openDocumentSequence = 0;

  public constructor(
    projects: ProjectRegistry,
    private readonly output: vscode.OutputChannel,
    private readonly providers?: WorkspaceProjectProviderService,
  ) {
    const clearFallback = (): void => this.invalidateFallback();
    this.disposables.push(
      projects.onDidChange(() => this.invalidate()),
      vscode.workspace.onDidCreateFiles(clearFallback),
      vscode.workspace.onDidDeleteFiles(clearFallback),
      vscode.workspace.onDidRenameFiles(clearFallback),
      vscode.workspace.onDidSaveTextDocument(clearFallback),
      vscode.workspace.onDidChangeTextDocument(clearFallback),
    );
  }

  public async search(
    project: ProjectContext,
    definition: ReferenceDefinition,
    query = "",
    limit = 200,
  ): Promise<readonly ReferenceCandidate[]> {
    return (await this.createService(project)).search(definition, query, limit);
  }

  public async resolve(
    project: ProjectContext,
    definition: ReferenceDefinition,
    value: string | number,
    signal?: AbortSignal,
  ): Promise<ReferenceResolution> {
    return (await this.createService(project)).resolve(definition, value, signal);
  }

  public invalidate(): void {
    this.invalidateFallback();
    this.snapshots.clear();
  }

  private invalidateFallback(): void {
    this.openDocuments.clear();
    this.fallbackSnapshots.clear();
  }

  public updateProjectSnapshot(
    project: ProjectContext,
    snapshot: WorkspaceProjectSemanticSnapshot,
  ): void {
    const key = project.markerUri.toString();
    const referenceData: Record<string, readonly WorkspaceReferenceDataEntry[]> = {};
    for (const [moduleId, entries] of Object.entries(snapshot.referenceData)) {
      referenceData[moduleId] = Object.freeze(entries.map((entry) => Object.freeze({
        documentTypeId: entry.documentTypeId,
        sourcePaths: Object.freeze([...entry.sourcePaths]) as readonly string[],
        data: entry.data,
      })));
    }
    this.snapshots.set(key, Object.freeze({
      dependencyKey: snapshot.dependencyKey,
      documents: Object.freeze([...snapshot.documents]),
      referenceData: Object.freeze(referenceData),
    }));
    this.fallbackSnapshots.delete(key);
  }

  public removeProjectSnapshot(project: ProjectContext): void {
    const key = project.markerUri.toString();
    this.snapshots.delete(key);
    this.fallbackSnapshots.delete(key);
  }

  public async validate(
    project: ProjectContext,
    occurrences: readonly ReferenceOccurrence[],
    signal?: AbortSignal,
  ) {
    return (await this.createService(project)).validate(occurrences, signal);
  }

  public async analyze(
    project: ProjectContext,
    occurrences: readonly ReferenceOccurrence[],
    signal?: AbortSignal,
  ) {
    return (await this.createService(project)).analyzeOccurrences(occurrences, signal);
  }

  public async analyzeSnapshot(
    project: ProjectContext,
    snapshot: WorkspaceProjectSemanticSnapshot,
    occurrences: readonly ReferenceOccurrence[],
    signal?: AbortSignal,
  ) {
    return (await this.createService(project, snapshot)).analyzeOccurrences(occurrences, signal);
  }

  public async validateChange(
    project: ProjectContext,
    before: readonly ReferenceOccurrence[],
    after: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly introducedErrors: readonly DocumentDiagnostic[];
  }> {
    const service = await this.createService(project);
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

  public async validateProviderDocument(
    project: ProjectContext,
    snapshot: ProjectProviderDocumentSnapshot,
  ): Promise<readonly DocumentDiagnostic[]> {
    return this.providers?.validateDocument(project, snapshot) ?? [];
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

  /**
   * 已打开文档的实时引用数据（编辑中、尚未落盘时优先于快照）。
   *
   * `data` 的形状由模块自己决定：宿主只按 (moduleId, documentTypeId, sourcePaths) 覆盖快照条目。
   */
  public updateModuleDocument(
    ownerId: string,
    project: ProjectContext,
    input: {
      readonly moduleId: string;
      readonly documentTypeId: string;
      readonly sourcePaths: readonly string[];
      readonly data: unknown;
    },
  ): void {
    this.openDocuments.set(ownerId, {
      projectKey: project.markerUri.toString(),
      moduleId: input.moduleId,
      documentTypeId: input.documentTypeId,
      sourcePaths: new Set(input.sourcePaths),
      data: input.data,
      sequence: ++this.openDocumentSequence,
    });
  }

  public removeModuleDocument(ownerId: string): void {
    this.openDocuments.delete(ownerId);
  }

  public dispose(): void {
    this.openDocuments.clear();
    this.fallbackSnapshots.clear();
    this.snapshots.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async createService(
    project: ProjectContext,
    snapshotOverride?: WorkspaceProjectSemanticSnapshot,
  ): Promise<ReferenceService> {
    const snapshot = snapshotOverride ?? this.snapshots.get(project.markerUri.toString());
    const loadSnapshot = () => this.loadSnapshot(project, snapshotOverride);
    const providers: ReferenceProvider[] = [
      createDocumentReferenceProvider(async () => (await loadSnapshot()).documents),
    ];
    for (const entry of documentFacetEntries()) {
      // `references` 在契约里是必填，但 bundle 求值后宿主无法强制：缺失时按"没有引用 kind"
      // 处理，避免一个不合规模块让整个文档索引失败（契约校验属于 Loader 的 `registrationInvalid`）。
      for (const kind of entry.facet.references ?? []) {
        providers.push(kind.createProvider(async () => (
          this.withOpenDocuments(project, entry.moduleId, await loadSnapshot())
        )));
      }
    }
    providers.push(...await this.providers?.referenceProviders(project) ?? []);
    return new ReferenceService(providers, snapshot?.dependencyKey);
  }

  private loadSnapshot(
    project: ProjectContext,
    override?: WorkspaceProjectSemanticSnapshot,
  ): Promise<WorkspaceProjectSemanticSnapshot> {
    if (override !== undefined) return Promise.resolve(override);
    const key = project.markerUri.toString();
    const existing = this.snapshots.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    const cached = this.fallbackSnapshots.get(key);
    if (cached !== undefined) return cached;
    const loading = loadProjectReferenceSnapshots([project], new AbortController().signal)
      .then((snapshots) => snapshots.get(key))
      .then((value) => value ?? {
        dependencyKey: projectSemanticSnapshotDependencyKey(project.definition, []),
        documents: [],
        referenceData: {},
      })
      .catch((errorValue: unknown) => {
        this.fallbackSnapshots.delete(key);
        this.output.appendLine(`[reference] Semantic snapshot for '${project.definition.projectId}' is unavailable: ${formatError(errorValue)}`);
        throw errorValue;
      });
    this.fallbackSnapshots.set(key, loading);
    return loading;
  }

  private withOpenDocuments(
    project: ProjectContext,
    moduleId: string,
    snapshot: WorkspaceProjectSemanticSnapshot,
  ): readonly unknown[] {
    const entries = snapshot.referenceData[moduleId] ?? [];
    const projectKey = project.markerUri.toString();
    const overrides = selectCurrentOverrides([...this.openDocuments.values()]
      .filter((entry) => entry.projectKey === projectKey && entry.moduleId === moduleId));
    if (overrides.length === 0) {
      return entries.map((entry) => entry.data);
    }
    const visible = entries.filter((entry) => !overrides.some((override) => (
      override.documentTypeId === entry.documentTypeId
      && entry.sourcePaths.some((path) => override.sourcePaths.has(path))
    )));
    return [...visible.map((entry) => entry.data), ...overrides.map((entry) => entry.data)];
  }
}

function sameReferenceValue(left: string | number, right: string | number): boolean {
  return typeof left === typeof right && left === right;
}

function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.severity}\u0000${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`;
}

function diagnosticCounts(diagnostics: readonly DocumentDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? "Unknown error.");
}
