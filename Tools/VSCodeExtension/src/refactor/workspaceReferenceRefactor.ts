import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { withProjectTransaction } from "@visualbridge/node-host";
import {
  compareUtf16CodeUnits,
  createReferenceValueRenamePlan,
  documentIndexKey,
  referenceValuesEqual,
  type DocumentFacet,
  type DocumentFacetContext,
  type DocumentFacetSourceFile,
  type DocumentLifecycleDeleteTarget,
  type DocumentTypeDefinition,
  type IndexedDocument,
  type IndexedDocumentReference,
  type JsonValue,
  type ReferenceLocation,
  type ReferenceOccurrence,
  type ReferenceValueRenamePlan,
} from "@visualbridge/core";
import {
  documentFacetEntries,
  documentFacetFor,
  loadDocumentTypeCatalogRegistry,
  type HostDocumentFacet,
} from "../modules/documentFacetRegistry";
import {
  findCrossProjectBlocker,
  firstWorkspaceBlocker,
  hasSourceChanges,
  isCrossProjectReferenceRefactor,
  noChangeRenameFailure,
  selectTargetCandidate,
  uniqueIndexedDocuments,
  type RefactorBlocker,
  type WorkspaceReferenceTargetRenameRequest,
  type WorkspaceReferenceTargetRenameResult,
} from "./workspaceReferenceRefactorPlan";

export type {
  WorkspaceReferenceTargetRenameRequest,
  WorkspaceReferenceTargetRenameResult,
} from "./workspaceReferenceRefactorPlan";
import type { WorkspaceDocumentIndex } from "../document/workspaceDocumentIndex";
import type { TableEditorProvider } from "../editor/tableEditorProvider";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";

interface PreparedWrite {
  readonly uri: vscode.Uri;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
}

export class WorkspaceReferenceRefactor {
  private committedRefreshFailureForTest: {
    readonly phase: "tableEditor" | "documentIndex";
    readonly message: string;
  } | undefined;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly documents: WorkspaceDocumentIndex,
    private readonly references: WorkspaceReferenceService,
    private readonly tables: TableEditorProvider,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async rename(
    source: IndexedDocument,
    selected: IndexedDocumentReference,
  ): Promise<void> {
    const project = this.findProject(source.projectId);
    const target = selected.resolution.status === "resolved"
      ? selected.resolution.candidates[0]
      : undefined;
    if (project === undefined || target?.location === undefined) {
      void vscode.window.showWarningMessage("Only a uniquely resolved reference target can be renamed.");
      return;
    }
    if (isCrossProjectReferenceRefactor(project.definition.projectId, target.location.projectId)) {
      void vscode.window.showWarningMessage("Cross-project reference refactors are not supported.");
      return;
    }
    const newValue = await promptReplacement(selected.occurrence.value);
    if (newValue === undefined) {
      return;
    }
    const planned = createReferenceValueRenamePlan(this.documents.documents, selected, newValue);
    if (!planned.success) {
      void vscode.window.showWarningMessage(planned.message);
      return;
    }
    if (!supportsRenameKind(planned.plan.kind)) {
      void vscode.window.showWarningMessage(`Reference Provider '${planned.plan.kind}' does not expose a rename adapter.`);
      return;
    }
    const result = await this.applyPlan(project, planned.plan, { confirm: true });
    if (result.success) {
      if (result.maintenance === undefined) {
        void vscode.window.showInformationMessage(
          `Renamed ${String(planned.plan.oldValue)} to ${String(planned.plan.newValue)} in ${result.fileCount} source file(s) and ${result.referenceCount} reference occurrence(s).`,
        );
      } else {
        void vscode.window.showWarningMessage(result.maintenance.message);
      }
    } else if (result.code !== "refactor.cancelled") {
      void vscode.window.showWarningMessage(result.message);
    }
  }

  public async renameTarget(
    request: WorkspaceReferenceTargetRenameRequest,
  ): Promise<WorkspaceReferenceTargetRenameResult> {
    const project = this.findProject(request.projectId);
    if (project === undefined || request.location.projectId !== request.projectId) {
      return blocked("refactor.targetUnavailable", "The reference target Project is not open.");
    }
    const resolution = await this.references.resolve(project, request.definition, request.oldValue);
    if (resolution.status === "providerUnavailable") {
      return blocked(
        "refactor.targetUnavailable",
        resolution.message ?? `Reference provider '${request.definition.kind}' is unavailable.`,
      );
    }
    const selection = selectTargetCandidate(request.location, resolution);
    if (!selection.ok) return blocked(selection.blocker.code, selection.blocker.message);
    const target = selection.candidate;
    const planned = createReferenceValueRenamePlan(this.documents.documents, {
      occurrence: {
        definition: request.definition,
        value: request.oldValue,
        path: "$target",
      },
      resolution: { status: "resolved", candidates: [target] },
    }, request.newValue);
    if (!planned.success) return blocked(`refactor.${planned.reason}`, planned.message);
    if (!supportsRenameKind(planned.plan.kind)) {
      return blocked("refactor.unsupportedTarget", `Reference Provider '${planned.plan.kind}' does not expose a rename adapter.`);
    }
    const result = await this.applyPlan(project, planned.plan, {
      confirm: request.confirm,
      allowOpenTableTarget: true,
    });
    if (result.success && result.maintenance !== undefined) {
      void vscode.window.showWarningMessage(result.maintenance.message);
    }
    return result;
  }

  public failCommittedRefreshForTest(
    phase: "tableEditor" | "documentIndex",
    message: string,
  ): void {
    this.committedRefreshFailureForTest = { phase, message };
  }

  private async applyPlan(
    project: ProjectContext,
    plan: ReferenceValueRenamePlan,
    options: { readonly confirm: boolean; readonly allowOpenTableTarget?: boolean },
  ): Promise<WorkspaceReferenceTargetRenameResult> {
    const newResolution = await this.references.resolve(project, {
      kind: plan.kind,
      target: plan.target.target,
      allowMissing: false,
    }, plan.newValue);
    if (newResolution.status !== "missing") {
      return blocked(
        "refactor.targetCollision",
        `Rename refused because '${String(plan.newValue)}' already resolves to ${newResolution.candidates.length} target(s).`,
      );
    }
    const location = plan.target.location;
    const targetDocument = location === undefined ? undefined : this.documents.documents.find((document) => (
      document.projectId === location.projectId
      && document.documentTypeId === location.documentTypeId
      && document.sourcePaths.includes(location.path)
    ));
    if (targetDocument === undefined) {
      return blocked("refactor.targetUnavailable", "The resolved target is no longer an indexed document.");
    }
    const affected = uniqueIndexedDocuments([
      targetDocument,
      ...plan.changes.flatMap((change) => {
        const document = this.documents.documents.find((candidate) => documentIndexKey(candidate) === documentIndexKey(change));
        return document === undefined ? [] : [document];
      }),
    ]);
    const crossProject = findCrossProjectBlocker(
      project.definition.projectId,
      affected.map((document) => document.projectId),
    );
    if (crossProject !== undefined) return blocked(crossProject.code, crossProject.message);
    const allowedTarget = options.allowOpenTableTarget ? targetDocument : undefined;
    const openConflict = this.findOpenConflict(affected, project, allowedTarget);
    if (openConflict !== undefined) return blocked(openConflict.code, openConflict.message);

    let prepared: readonly PreparedWrite[];
    try {
      prepared = (await Promise.all(affected.map((document) => this.prepareDocument(
        project,
        document,
        new Set(plan.changes
          .filter((change) => documentIndexKey(change) === documentIndexKey(document))
          .map((change) => change.occurrencePath)),
        plan.newValue,
        plan.oldValue,
        documentIndexKey(document) === documentIndexKey(targetDocument) ? plan : undefined,
      )))).flat();
    } catch (errorValue) {
      this.output.appendLine(`[refactor] Preview failed: ${formatError(errorValue)}`);
      return blocked("refactor.previewFailed", `Refactor preview failed: ${formatError(errorValue)}`);
    }
    const writes = prepared.filter((write) => hasSourceChanges(write.before, write.after));
    if (writes.length === 0) {
      const noChange = noChangeRenameFailure();
      return blocked(noChange.code, noChange.message);
    }
    if (options.confirm && !await previewPlan(plan, writes)) {
      return blocked("refactor.cancelled", "The reference refactor was cancelled.");
    }
    const lateOpenConflict = this.findOpenConflict(affected, project, allowedTarget);
    if (lateOpenConflict !== undefined) return blocked(lateOpenConflict.code, lateOpenConflict.message);

    try {
      await commitWrites(project, writes, prepared);
    } catch (errorValue) {
      this.output.appendLine(`[refactor] Commit failed: ${formatError(errorValue)}`);
      return blocked("refactor.commitFailed", `Refactor was not applied: ${formatError(errorValue)}`);
    }

    const refreshFailures: {
      readonly phase: "tableEditor" | "documentIndex";
      readonly message: string;
    }[] = [];
    this.references.invalidate();
    if (allowedTarget !== undefined && documentFacetFor(allowedTarget.editor)?.facet.storage === "sources") {
      try {
        const injectedFailure = this.takeCommittedRefreshFailureForTest("tableEditor");
        if (injectedFailure !== undefined) throw new Error(injectedFailure);
        await this.tables.refreshAfterReferenceRefactor(project, allowedTarget.sourcePaths);
      } catch (errorValue) {
        refreshFailures.push({ phase: "tableEditor", message: formatError(errorValue) });
      }
    }
    try {
      const injectedFailure = this.takeCommittedRefreshFailureForTest("documentIndex");
      const refresh = injectedFailure === undefined
        ? await this.documents.refresh()
        : { status: "failed" as const, epoch: -1, message: injectedFailure };
      if (refresh.status !== "applied") {
        refreshFailures.push({
          phase: "documentIndex",
          message: refresh.status === "failed"
            ? refresh.message
            : `Document Index refresh ended with status '${refresh.status}'.`,
        });
      }
    } catch (errorValue) {
      refreshFailures.push({ phase: "documentIndex", message: formatError(errorValue) });
    }

    const summary = `Renamed ${String(plan.oldValue)} -> ${String(plan.newValue)}; ${writes.length} files, ${plan.changes.length} references.`;
    if (refreshFailures.length === 0) {
      this.output.appendLine(`[refactor] ${summary}`);
      return { success: true, fileCount: writes.length, referenceCount: plan.changes.length };
    }
    const failureSummary = refreshFailures
      .map((failure) => `${failure.phase}: ${failure.message}`)
      .join("; ");
    const maintenance = {
      code: "refactor.committedRefreshFailed" as const,
      message: `Refactor committed, but post-commit refresh was incomplete. Do not retry the rename; refresh the affected editor or Document Index. ${failureSummary}`,
      failures: refreshFailures,
    };
    this.output.appendLine(`[refactor] ${summary} ${maintenance.code}: ${failureSummary}`);
    return {
      success: true,
      fileCount: writes.length,
      referenceCount: plan.changes.length,
      maintenance,
    };
  }

  private takeCommittedRefreshFailureForTest(phase: "tableEditor" | "documentIndex"): string | undefined {
    if (this.committedRefreshFailureForTest?.phase !== phase) return undefined;
    const failure = this.committedRefreshFailureForTest;
    this.committedRefreshFailureForTest = undefined;
    return failure.message;
  }

  private async prepareDocument(
    project: ProjectContext,
    indexed: IndexedDocument,
    occurrencePaths: ReadonlySet<string>,
    replacement: string | number,
    oldValue: string | number,
    targetPlan: ReferenceValueRenamePlan | undefined,
  ): Promise<readonly PreparedWrite[]> {
    if (indexed.projectId !== project.definition.projectId) {
      throw new Error("Cross-project reference refactors are not supported.");
    }
    const documentType = project.definition.documentTypes.find((candidate) => candidate.id === indexed.documentTypeId);
    if (documentType === undefined || documentType.editor !== indexed.editor) {
      throw new Error(`Document Type '${indexed.documentTypeId}' is no longer declared.`);
    }
    const host = documentFacetFor(indexed.editor);
    if (host === undefined) throw new Error(`Editor '${indexed.editor}' does not support reference refactors.`);
    const catalog = await loadDocumentTypeCatalogRegistry(project, documentType);
    const sources: DocumentFacetSourceFile[] = [];
    const beforeByPath = new Map<string, Uint8Array>();
    for (const path of indexed.sourcePaths) {
      const uri = sourceUri(project, path);
      ensureDeclaredSource(this.projects, project, indexed, uri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      sources.push({ path, bytes });
      beforeByPath.set(path, bytes);
    }
    const context = facetContext(project, documentType, host, indexed, catalog);
    const parsed = host.facet.storage === "sources"
      ? await host.facet.parseSources!(sources, context)
      : await parseSingleSource(host.facet, sources, context, indexed);
    if (!parsed.success) throw new Error(firstDiagnostic(parsed.diagnostics, `${indexed.editor} source is invalid.`));
    let next = parsed.document;
    if (occurrencePaths.size > 0) {
      assertOccurrenceValues(host.facet.collectReferences(next, context), occurrencePaths, oldValue, indexed.path);
      const replaced = host.facet.replaceReferenceValues(next, context, occurrencePaths, replacement);
      if (!replaced.success) throw new Error(firstDiagnostic(replaced.diagnostics, `${indexed.editor} refactor is invalid.`));
      next = replaced.document;
      assertOccurrenceValues(host.facet.collectReferences(next, context), occurrencePaths, replacement, indexed.path);
    }
    if (targetPlan !== undefined) {
      if (targetPlan.kind === "document") {
        if (host.facet.renameDocumentId === undefined) {
          throw new Error(`Editor '${indexed.editor}' cannot rename document IDs.`);
        }
        const descriptor = host.facet.describe(next, context);
        // `document` 目标始终校验：describe 不报 documentId 的 stale facet 也必须被拒绝，
        // 不能因为字段缺失就跳过校验而把它静默改名。
        assertDocumentTarget(descriptor.documentId, targetPlan, indexed.path);
        const renamed = host.facet.renameDocumentId(next, requireStringReplacement(targetPlan), context);
        if (!renamed.success) {
          throw new Error(firstDiagnostic(renamed.diagnostics, `${indexed.editor} document rename is invalid.`));
        }
        next = renamed.document;
      } else {
        if (host.facet.renameTarget === undefined) {
          throw new Error(`Reference target '${targetPlan.kind}' cannot be stored in a ${indexed.editor} document.`);
        }
        const renamed = host.facet.renameTarget(
          next,
          { kind: targetPlan.kind, ...locationFields(targetPlan.target.location) },
          targetPlan.oldValue,
          targetPlan.newValue,
          context,
        );
        if (!renamed.success) {
          throw new Error(firstDiagnostic(renamed.diagnostics, `${indexed.editor} target rename is invalid.`));
        }
        next = renamed.document;
      }
    }
    const rendered = await host.facet.renderSources(next, sources, context);
    const writes: PreparedWrite[] = [];
    for (const file of rendered) {
      const before = beforeByPath.get(file.path);
      if (before === undefined) throw new Error(`Refactor rendered an undeclared source '${file.path}'.`);
      writes.push({ uri: sourceUri(project, file.path), before, after: file.bytes });
    }
    return writes;
  }
  private findOpenConflict(
    documents: readonly IndexedDocument[],
    project: ProjectContext,
    allowedOpenTableTarget?: IndexedDocument,
  ): RefactorBlocker | undefined {
    const dirtyTextEditorPaths: string[] = [];
    for (const text of vscode.workspace.textDocuments) {
      if (!text.isDirty) {
        continue;
      }
      const match = this.projects.resolveDocument(text.uri);
      if (match?.project.markerUri.toString() === project.markerUri.toString()
        && documentFacetFor(match.documentType.editor) !== undefined) {
        dirtyTextEditorPaths.push(match.relativePath);
      }
    }
    const allowedUris = new Set((allowedOpenTableTarget?.sourcePaths ?? []).map(
      (path) => sourceUri(project, path).toString(),
    ));
    return firstWorkspaceBlocker({
      dirtyTextEditorPaths,
      dirtyTableEditor: this.tables.hasDirtyProject(project),
      openTableSourceUris: this.tables.openProjectSourceUris(project).map((uri) => uri.toString()),
      allowedOpenTableSourceUris: allowedUris,
      affectedDocumentCount: documents.length,
    });
  }

  private findProject(projectId: string): ProjectContext | undefined {
    return this.projects.projects.find((project) => project.definition.projectId === projectId);
  }
}

async function promptReplacement(oldValue: string | number): Promise<string | number | undefined> {
  const input = await vscode.window.showInputBox({
    title: "Rename Reference Target",
    prompt: `Enter a new ${typeof oldValue} value for '${String(oldValue)}'.`,
    value: String(oldValue),
    validateInput(value) {
      if (typeof oldValue === "string") return value.length === 0 ? "Reference values cannot be empty." : undefined;
      const parsed = Number(value);
      return value.trim().length === 0 || !Number.isFinite(parsed) ? "Enter a finite number." : undefined;
    },
  });
  if (input === undefined) return undefined;
  return typeof oldValue === "number" ? Number(input) : input;
}

function assertDocumentTarget(
  currentDocumentId: string | undefined,
  plan: ReferenceValueRenamePlan,
  path: string,
): void {
  if (currentDocumentId === undefined
    || plan.target.location?.documentId !== plan.oldValue
    || currentDocumentId !== plan.oldValue) {
    throw new Error(`The document ID in '${path}' changed after the refactor preview was created.`);
  }
}

function requireStringReplacement(plan: ReferenceValueRenamePlan): string {
  return requireStringValue(plan.newValue);
}

function requireStringValue(value: string | number): string {
  if (typeof value !== "string") throw new Error("Document and Graph element IDs must be strings.");
  return value;
}

/** 某个 Reference kind 是否被已加载模块登记为可改名目标（`document` 走 `renameDocumentId`）。 */
function supportsRenameKind(kind: string): boolean {
  if (kind === "document") {
    return documentFacetEntries().some((entry) => entry.facet.renameDocumentId !== undefined);
  }
  return documentFacetEntries().some((entry) => (
    entry.facet.renameTarget !== undefined
    && (entry.facet.references ?? []).some((facet) => facet.kind === kind)
  ));
}

function locationFields(location: ReferenceLocation | undefined): Readonly<Record<string, JsonValue>> {
  if (location === undefined) return {};
  const fields: [string, JsonValue][] = [];
  for (const [key, value] of Object.entries(location)) {
    if (typeof value === "string") fields.push([key, value]);
  }
  return Object.fromEntries(fields);
}

function parseSingleSource(
  facet: DocumentFacet<unknown, unknown>,
  sources: readonly DocumentFacetSourceFile[],
  context: DocumentFacetContext<unknown>,
  indexed: IndexedDocument,
) {
  const source = sources[0];
  if (source === undefined || indexed.sourcePaths.length !== 1) {
    throw new Error("Text refactor requires exactly one physical source.");
  }
  return facet.parseText!(decodeUtf8(source.bytes, source.path), context);
}

function facetContext(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  host: HostDocumentFacet,
  indexed: IndexedDocument,
  catalog: Awaited<ReturnType<typeof loadDocumentTypeCatalogRegistry>>,
): DocumentFacetContext<unknown> {
  return {
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    path: indexed.sourcePaths[0] ?? indexed.path,
    sourcePaths: indexed.sourcePaths,
    registry: catalog?.ready === true ? catalog.registry : undefined,
    projectDefinition: project.definition as unknown as JsonValue,
    moduleOptions: project.definition.modules.find((entry) => entry.id === host.moduleId)?.options,
  };
}

async function previewPlan(plan: ReferenceValueRenamePlan, writes: readonly PreparedWrite[]): Promise<boolean> {
  const locations = plan.changes.slice(0, 20).map((change) => `• ${change.path}: ${change.occurrencePath}`);
  const remainder = plan.changes.length > locations.length
    ? [`• …and ${plan.changes.length - locations.length} more occurrence(s)`]
    : [];
  const action = await vscode.window.showWarningMessage(
    `Rename ${String(plan.oldValue)} to ${String(plan.newValue)}?`,
    {
      modal: true,
      detail: [
        `Target: ${plan.target.location?.path ?? plan.target.title}`,
        `Impact: ${plan.changes.length} reference occurrence(s), ${writes.length} physical source file(s)`,
        "",
        ...locations,
        ...remainder,
      ].join("\n"),
    },
    "Apply Refactor",
  );
  return action === "Apply Refactor";
}

async function commitWrites(
  project: ProjectContext,
  writes: readonly PreparedWrite[],
  dependencies: readonly PreparedWrite[],
): Promise<void> {
  const ordered = [...writes].sort((left, right) => compareUtf16CodeUnits(left.uri.fsPath, right.uri.fsPath));
  const dependencyByPath = new Map(dependencies.map((dependency) => [dependency.uri.fsPath, dependency]));
  await withProjectTransaction(project.rootUri.fsPath, (transaction) => transaction.commit(
    ordered.map((write) => ({
      path: nodePath.relative(project.rootUri.fsPath, write.uri.fsPath).replaceAll("\\", "/"),
      absolutePath: write.uri.fsPath,
      before: write.before,
      after: write.after,
    })),
    [...dependencyByPath.values()].map((dependency) => ({
      path: nodePath.relative(project.rootUri.fsPath, dependency.uri.fsPath).replaceAll("\\", "/"),
      absolutePath: dependency.uri.fsPath,
      hash: hashBytes(dependency.before),
    })),
  ));
}

function sourceUri(project: ProjectContext, path: string): vscode.Uri {
  return vscode.Uri.joinPath(project.rootUri, ...path.split("/"));
}

function ensureDeclaredSource(
  projects: ProjectRegistry,
  project: ProjectContext,
  indexed: IndexedDocument,
  uri: vscode.Uri,
): void {
  const match = projects.resolveDocument(uri);
  if (match?.project.markerUri.toString() !== project.markerUri.toString()
    || match.documentType.id !== indexed.documentTypeId
    || match.documentType.editor !== indexed.editor) {
    throw new Error(`'${uri.fsPath}' is no longer declared by Document Type '${indexed.documentTypeId}'.`);
  }
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    throw new Error(`'${path}' is not valid UTF-8: ${formatError(errorValue)}`);
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstDiagnostic(
  diagnostics: readonly { readonly path: string; readonly message: string }[],
  fallback: string,
): string {
  const first = diagnostics[0];
  return first === undefined ? fallback : `${first.path}: ${first.message}`;
}

function assertOccurrenceValues(
  occurrences: readonly ReferenceOccurrence[],
  paths: ReadonlySet<string>,
  expectedValue: string | number,
  documentPath: string,
): void {
  for (const path of paths) {
    const matching = occurrences.filter((occurrence) => (
      occurrence.path === path && referenceValuesEqual(occurrence.value, expectedValue)
    ));
    if (matching.length !== 1) {
      throw new Error(`Reference occurrence '${documentPath}: ${path}' changed after indexing.`);
    }
  }
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function blocked(code: string, message: string): WorkspaceReferenceTargetRenameResult {
  return { success: false, code, message };
}
