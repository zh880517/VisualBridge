import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { withProjectTransaction } from "@visualbridge/node-host";
import {
  createReferenceValueRenamePlan,
  documentIndexKey,
  referenceLocationKey,
  referenceValuesEqual,
  type IndexedDocument,
  type IndexedDocumentReference,
  type ReferenceDefinition,
  type ReferenceLocation,
  type ReferenceOccurrence,
  type ReferenceValueRenamePlan,
} from "@visualbridge/core";
import {
  applyEntityOperations,
  collectEntityReferences,
  parseEntityDocument,
  renameEntityDocumentId,
  replaceEntityReferenceValues,
  serializeEntityDocument,
} from "@visualbridge/entity";
import {
  applyGraphOperations,
  collectGraphReferences,
  parseGraphDocument,
  renameGraphDocumentId,
  replaceGraphReferenceValues,
  serializeGraphDocument,
} from "@visualbridge/graph";
import {
  collectStructuredReferences,
  parseStructuredDocument,
  renameStructuredDocumentId,
  replaceStructuredReferenceValues,
  serializeStructuredDocument,
} from "@visualbridge/structured";
import {
  applyTableOperations,
  collectTableReferences,
  parseCsvTable,
  parseXlsxTable,
  replaceTableReferenceValues,
  resolveTableSheet,
  resolveTableType,
  serializeCsvTable,
  serializeXlsxTable,
  type TableDocument,
  type TableSheet,
} from "@visualbridge/table";
import { loadEntityCatalogRegistry } from "../catalog/entityCatalogLoader";
import { loadGraphCatalogRegistry } from "../catalog/graphCatalogLoader";
import { loadStructuredCatalogRegistry } from "../catalog/structuredCatalogLoader";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import type { WorkspaceDocumentIndex } from "../document/workspaceDocumentIndex";
import type { TableEditorProvider } from "../editor/tableEditorProvider";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";

interface PreparedWrite {
  readonly uri: vscode.Uri;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
}

interface TableSourceSnapshot {
  readonly uri: vscode.Uri;
  readonly bytes: Uint8Array;
  readonly sheetIds: readonly string[];
}

export interface WorkspaceReferenceTargetRenameRequest {
  readonly projectId: string;
  readonly definition: ReferenceDefinition;
  readonly location: ReferenceLocation;
  readonly oldValue: string | number;
  readonly newValue: string | number;
  readonly confirm: boolean;
}

export type WorkspaceReferenceTargetRenameResult =
  | {
      readonly success: true;
      readonly fileCount: number;
      readonly referenceCount: number;
      readonly maintenance?: {
        readonly code: "refactor.committedRefreshFailed";
        readonly message: string;
        readonly failures: readonly {
          readonly phase: "tableEditor" | "documentIndex";
          readonly message: string;
        }[];
      };
    }
  | {
      readonly success: false;
      readonly code: string;
      readonly message: string;
    };

const SUPPORTED_RENAME_KINDS = new Set(["document", "entity.component", "graph.element", "table.row"]);

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
    if (target.location.projectId !== project.definition.projectId) {
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
    if (!SUPPORTED_RENAME_KINDS.has(planned.plan.kind)) {
      void vscode.window.showWarningMessage(
        `Reference Provider '${planned.plan.kind}' does not expose a rename adapter.`,
      );
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
    const locationKey = referenceLocationKey(request.location);
    const target = resolution.candidates.find((candidate) => (
      candidate.location !== undefined && referenceLocationKey(candidate.location) === locationKey
    ));
    if (resolution.status !== "resolved" || resolution.candidates.length !== 1 || target?.location === undefined) {
      return blocked("refactor.targetChanged", "The edited stable identity no longer resolves uniquely to this target.");
    }
    const planned = createReferenceValueRenamePlan(this.documents.documents, {
      occurrence: {
        definition: request.definition,
        value: request.oldValue,
        path: "$target",
      },
      resolution: { status: "resolved", candidates: [target] },
    }, request.newValue);
    if (!planned.success) return blocked(`refactor.${planned.reason}`, planned.message);
    if (planned.plan.kind !== "table.row") {
      return blocked("refactor.unsupportedTarget", "Table key editing can only rename a table.row target.");
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
    const affected = uniqueDocuments([
      targetDocument,
      ...plan.changes.flatMap((change) => {
        const document = this.documents.documents.find((candidate) => documentIndexKey(candidate) === documentIndexKey(change));
        return document === undefined ? [] : [document];
      }),
    ]);
    if (affected.some((document) => document.projectId !== project.definition.projectId)) {
      return blocked("refactor.crossProject", "Cross-project reference refactors are not supported.");
    }
    const allowedTarget = options.allowOpenTableTarget ? targetDocument : undefined;
    const openConflict = this.findOpenConflict(affected, project, allowedTarget);
    if (openConflict !== undefined) return blocked("refactor.workspaceDirty", openConflict);

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
    const writes = prepared.filter((write) => !bytesEqual(write.before, write.after));
    if (writes.length === 0) return blocked("refactor.noChanges", "The rename did not produce any source changes.");
    if (options.confirm && !await previewPlan(plan, writes)) {
      return blocked("refactor.cancelled", "The reference refactor was cancelled.");
    }
    const lateOpenConflict = this.findOpenConflict(affected, project, allowedTarget);
    if (lateOpenConflict !== undefined) return blocked("refactor.workspaceDirty", lateOpenConflict);

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
    if (allowedTarget?.editor === "table") {
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
    if (indexed.editor === "table") {
      return this.prepareTable(project, indexed, occurrencePaths, replacement, oldValue, targetPlan);
    }
    const uri = sourceUri(project, indexed.path);
    ensureDeclaredSource(this.projects, project, indexed, uri);
    const before = await vscode.workspace.fs.readFile(uri);
    const text = decodeUtf8(before, indexed.path);
    if (indexed.editor === "graph") {
      const catalog = await loadGraphCatalogRegistry(project, documentType.catalogs);
      if (!catalog.ready) throw new Error(firstDiagnostic(catalog.diagnostics, "Graph Catalog is unavailable."));
      const parsed = parseGraphDocument(text);
      if (!parsed.success) throw new Error(firstDiagnostic(parsed.diagnostics, "Graph source is invalid."));
      let next = parsed.document;
      if (occurrencePaths.size > 0) {
        assertOccurrenceValues(collectGraphReferences(next, catalog.registry), occurrencePaths, oldValue, indexed.path);
        const replaced = replaceGraphReferenceValues(next, catalog.registry, occurrencePaths, replacement);
        if (!replaced.success) throw new Error(firstDiagnostic(replaced.diagnostics, "Graph refactor is invalid."));
        next = replaced.document;
        assertOccurrenceValues(collectGraphReferences(next, catalog.registry), occurrencePaths, replacement, indexed.path);
      }
      if (targetPlan?.kind === "document") {
        assertDocumentTarget(next.documentId, targetPlan, indexed.path);
        const renamed = renameGraphDocumentId(next, requireStringReplacement(targetPlan), catalog.registry);
        if (!renamed.success) throw new Error(firstDiagnostic(renamed.diagnostics, "Graph document rename is invalid."));
        next = renamed.document;
      } else if (targetPlan?.kind === "graph.element") {
        const location = targetPlan.target.location!;
        const elementKind = readGraphElementKind(location.elementKind);
        if (location.elementId !== targetPlan.oldValue || location.graphId === undefined || elementKind === undefined) {
          throw new Error("The Graph element target location is incomplete or changed.");
        }
        const renamed = applyGraphOperations(next, [{
          type: "graph.renameElement",
          graphId: location.graphId,
          elementKind,
          elementId: requireStringValue(targetPlan.oldValue),
          newElementId: requireStringReplacement(targetPlan),
          ...(location.nodeId === undefined ? {} : { nodeId: location.nodeId }),
        }], catalog.registry);
        if (!renamed.success) throw new Error(firstDiagnostic(renamed.diagnostics, "Graph element rename is invalid."));
        next = renamed.document;
      } else if (targetPlan !== undefined) {
        throw new Error(`Reference target '${targetPlan.kind}' cannot be stored in a Graph document.`);
      }
      return [{ uri, before, after: encodeUtf8(serializeGraphDocument(next)) }];
    }
    if (indexed.editor === "entity") {
      const catalog = await loadEntityCatalogRegistry(project, documentType.catalogs);
      if (!catalog.ready) throw new Error(firstDiagnostic(catalog.diagnostics, "Entity Catalog is unavailable."));
      const parsed = parseEntityDocument(text);
      if (!parsed.success) throw new Error(firstDiagnostic(parsed.diagnostics, "Entity source is invalid."));
      let next = parsed.document;
      if (occurrencePaths.size > 0) {
        assertOccurrenceValues(collectEntityReferences(next, catalog.registry), occurrencePaths, oldValue, indexed.path);
        const replaced = replaceEntityReferenceValues(next, catalog.registry, occurrencePaths, replacement);
        if (!replaced.success) throw new Error(firstDiagnostic(replaced.diagnostics, "Entity refactor is invalid."));
        next = replaced.document;
        assertOccurrenceValues(collectEntityReferences(next, catalog.registry), occurrencePaths, replacement, indexed.path);
      }
      if (targetPlan?.kind === "document") {
        assertDocumentTarget(next.documentId, targetPlan, indexed.path);
        const renamed = renameEntityDocumentId(next, requireStringReplacement(targetPlan), catalog.registry);
        if (!renamed.success) throw new Error(firstDiagnostic(renamed.diagnostics, "Entity document rename is invalid."));
        next = renamed.document;
      } else if (targetPlan?.kind === "entity.component") {
        const location = targetPlan.target.location!;
        if (location.documentId !== next.documentId
          || location.elementKind !== "component"
          || location.componentId !== targetPlan.oldValue
          || location.elementId !== targetPlan.oldValue) {
          throw new Error("The Entity component target location is incomplete or changed.");
        }
        const renamed = applyEntityOperations(next, [{
          type: "entity.renameComponent",
          componentId: requireStringValue(targetPlan.oldValue),
          newComponentId: requireStringReplacement(targetPlan),
        }], catalog.registry);
        if (!renamed.success) throw new Error(firstDiagnostic(renamed.diagnostics, "Entity component rename is invalid."));
        next = renamed.document;
      } else if (targetPlan !== undefined) {
        throw new Error(`Reference target '${targetPlan.kind}' cannot be stored in an Entity document.`);
      }
      return [{ uri, before, after: encodeUtf8(serializeEntityDocument(next)) }];
    }
    if (indexed.editor === "structured") {
      const catalog = await loadStructuredCatalogRegistry(project, documentType.catalogs);
      if (!catalog.ready) throw new Error(firstDiagnostic(catalog.diagnostics, "Structured Catalog is unavailable."));
      const parsed = parseStructuredDocument(text);
      if (!parsed.success) throw new Error(firstDiagnostic(parsed.diagnostics, "Structured source is invalid."));
      let next = parsed.document;
      if (occurrencePaths.size > 0) {
        assertOccurrenceValues(
          collectStructuredReferences(next, catalog.registry, documentType.id),
          occurrencePaths,
          oldValue,
          indexed.path,
        );
        const replaced = replaceStructuredReferenceValues(
          next,
          catalog.registry,
          documentType.id,
          occurrencePaths,
          replacement,
        );
        if (!replaced.success) throw new Error(firstDiagnostic(replaced.diagnostics, "Structured refactor is invalid."));
        next = replaced.document;
        assertOccurrenceValues(
          collectStructuredReferences(next, catalog.registry, documentType.id),
          occurrencePaths,
          replacement,
          indexed.path,
        );
      }
      if (targetPlan?.kind === "document") {
        assertDocumentTarget(next.documentId, targetPlan, indexed.path);
        const renamed = renameStructuredDocumentId(next, requireStringReplacement(targetPlan), catalog.registry, documentType.id);
        if (!renamed.success) throw new Error(firstDiagnostic(renamed.diagnostics, "Structured document rename is invalid."));
        next = renamed.document;
      } else if (targetPlan !== undefined) {
        throw new Error(`Reference target '${targetPlan.kind}' cannot be stored in a Structured document.`);
      }
      return [{ uri, before, after: encodeUtf8(serializeStructuredDocument(next)) }];
    }
    throw new Error(`Editor '${indexed.editor}' does not support reference refactors.`);
  }

  private async prepareTable(
    project: ProjectContext,
    indexed: IndexedDocument,
    occurrencePaths: ReadonlySet<string>,
    replacement: string | number,
    oldValue: string | number,
    targetPlan: ReferenceValueRenamePlan | undefined,
  ): Promise<readonly PreparedWrite[]> {
    if (targetPlan !== undefined && targetPlan.kind !== "table.row") {
      throw new Error(`Reference target '${targetPlan.kind}' cannot be stored in a Table document.`);
    }
    const documentType = project.definition.documentTypes.find((candidate) => candidate.id === indexed.documentTypeId)!;
    const layout = project.definition.tableLayout;
    if (layout === undefined) throw new Error("The project does not configure tableLayout.");
    const catalog = await loadTableCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready) throw new Error(firstDiagnostic(catalog.diagnostics, "Table Catalog is unavailable."));
    const tableType = resolveTableType(catalog.registry, documentType.id);
    if (tableType === undefined) throw new Error(`Table Type '${documentType.id}' is unavailable.`);
    const sources = await Promise.all(indexed.sourcePaths.map(async (path) => {
      const uri = sourceUri(project, path);
      ensureDeclaredSource(this.projects, project, indexed, uri);
      return { uri, bytes: await vscode.workspace.fs.readFile(uri), sheetIds: [] as readonly string[] };
    }));
    const xlsx = sources.length === 1 && isXlsx(sources[0]!.bytes);
    let document: TableDocument;
    let snapshots: readonly TableSourceSnapshot[];
    if (xlsx) {
      const parsed = await parseXlsxTable(sources[0]!.bytes, tableType, layout);
      if (!parsed.success) throw new Error(firstDiagnostic(parsed.diagnostics, "XLSX source is invalid."));
      document = parsed.document;
      snapshots = [{ ...sources[0]!, sheetIds: parsed.document.sheets.map((sheet) => sheet.id) }];
    } else {
      const sheets: TableSheet[] = [];
      const loaded: TableSourceSnapshot[] = [];
      for (const source of sources) {
        const physicalName = nodePath.basename(source.uri.fsPath, nodePath.extname(source.uri.fsPath));
        const parsed = parseCsvTable(decodeUtf8(source.bytes, source.uri.fsPath), tableType, layout, physicalName);
        if (!parsed.success) throw new Error(firstDiagnostic(parsed.diagnostics, `CSV '${physicalName}' is invalid.`));
        sheets.push(...parsed.document.sheets);
        loaded.push({ ...source, sheetIds: parsed.document.sheets.map((sheet) => sheet.id) });
      }
      document = { format: "csv", sheets };
      snapshots = loaded;
    }

    let next = document;
    if (occurrencePaths.size > 0) {
      assertOccurrenceValues(collectTableReferences(next, tableType), occurrencePaths, oldValue, indexed.path);
      const replaced = replaceTableReferenceValues(next, tableType, occurrencePaths, replacement);
      if (!replaced.success) throw new Error(firstDiagnostic(replaced.diagnostics, "Table reference refactor is invalid."));
      next = replaced.document;
      assertOccurrenceValues(collectTableReferences(next, tableType), occurrencePaths, replacement, indexed.path);
    }
    if (targetPlan !== undefined) {
      const location = targetPlan.target.location!;
      const sheet = next.sheets.find((candidate) => candidate.id === location.sheetId);
      const row = sheet?.rows.find((candidate) => candidate.id === location.rowId);
      const definition = sheet === undefined ? undefined : resolveTableSheet(tableType, sheet.definitionId);
      const keyColumnId = definition?.keyColumnId;
      if (sheet === undefined || row === undefined || keyColumnId === undefined) {
        throw new Error("The target Table row or key column no longer exists.");
      }
      if (!referenceValuesEqual(row.cells[keyColumnId] as string | number, targetPlan.oldValue)) {
        throw new Error("The target Table key changed after the refactor preview was created.");
      }
      const duplicate = next.sheets.some((candidateSheet) => (
        candidateSheet.definitionId === sheet.definitionId
        && candidateSheet.rows.some((candidateRow) => (
          (candidateSheet.id !== sheet.id || candidateRow.id !== row.id)
          && (typeof candidateRow.cells[keyColumnId] === "string" || typeof candidateRow.cells[keyColumnId] === "number")
          && referenceValuesEqual(candidateRow.cells[keyColumnId] as string | number, targetPlan.newValue)
        ))
      ));
      if (duplicate) throw new Error(`Table key '${String(targetPlan.newValue)}' already exists in a physical row.`);
      const changed = applyTableOperations(next, [{
        type: "table.setCell",
        sheetId: sheet.id,
        rowId: row.id,
        columnId: keyColumnId,
        value: targetPlan.newValue,
      }], tableType);
      if (!changed.success) throw new Error(firstDiagnostic(changed.diagnostics, "Table key rename is invalid."));
      next = changed.document;
    }

    if (xlsx) {
      const source = snapshots[0]!;
      return [{
        uri: source.uri,
        before: source.bytes,
        after: await serializeXlsxTable(source.bytes, next, tableType, layout),
      }];
    }
    return snapshots.map((source) => {
      const originalText = decodeUtf8(source.bytes, source.uri.fsPath);
      return {
        uri: source.uri,
        before: source.bytes,
        after: encodeUtf8(serializeCsvTable({
          format: "csv",
          sheets: next.sheets.filter((sheet) => source.sheetIds.includes(sheet.id)),
        }, tableType, originalText)),
      };
    });
  }

  private findOpenConflict(
    documents: readonly IndexedDocument[],
    project: ProjectContext,
    allowedOpenTableTarget?: IndexedDocument,
  ): string | undefined {
    for (const text of vscode.workspace.textDocuments) {
      if (!text.isDirty) {
        continue;
      }
      const match = this.projects.resolveDocument(text.uri);
      if (match?.project.markerUri.toString() === project.markerUri.toString()
        && ["graph", "entity", "structured", "table"].includes(match.documentType.editor)) {
        return `Save or revert '${match.relativePath}' before running a project refactor.`;
      }
    }
    if (this.tables.hasDirtyProject(project)) {
      return "Save or revert every dirty Table editor in this VisualBridge Project before running a project refactor.";
    }
    const allowedUris = new Set((allowedOpenTableTarget?.sourcePaths ?? []).map(
      (path) => sourceUri(project, path).toString(),
    ));
    if (this.tables.openProjectSourceUris(project).some((uri) => !allowedUris.has(uri.toString()))) {
      return "Close all Table editors in this VisualBridge Project before running a project refactor.";
    }
    if (documents.length === 0) {
      return "The refactor no longer has any indexed documents to update.";
    }
    return undefined;
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
  currentDocumentId: string,
  plan: ReferenceValueRenamePlan,
  path: string,
): void {
  if (plan.target.location?.documentId !== plan.oldValue || currentDocumentId !== plan.oldValue) {
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

function readGraphElementKind(
  value: string | undefined,
): "graph" | "node" | "interfacePort" | "dynamicPort" | undefined {
  return value === "graph" || value === "node" || value === "interfacePort" || value === "dynamicPort"
    ? value
    : undefined;
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
  const ordered = [...writes].sort((left, right) => left.uri.fsPath.localeCompare(right.uri.fsPath));
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

function uniqueDocuments(documents: readonly IndexedDocument[]): readonly IndexedDocument[] {
  return [...new Map(documents.map((document) => [documentIndexKey(document), document])).values()]
    .sort((left, right) => documentIndexKey(left).localeCompare(documentIndexKey(right)));
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

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
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
