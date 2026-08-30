import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  DocumentLifecycleService,
  buildCanonicalDocumentLifecycleDependencies,
  buildOwnedStableIdentityCollisionIndex,
  compareUtf16CodeUnits,
  referenceLocationKey,
  remapOwnedStableIdentityCollisionTargets,
  validateCompleteStableIdentityRemap,
  validateOwnedStableIdentityTargetCollisions,
  type DocumentLifecycleBlocker,
  type DocumentLifecycleDeleteTarget,
  type DocumentLifecycleDependency,
  type DocumentLifecycleOperation,
  type DocumentLifecyclePlan,
  type DocumentLifecyclePreview,
  type DocumentLifecycleReferenceImpact,
  type DocumentTypeDefinition,
  type IndexedDocument,
  type OwnedStableIdentity,
  type OwnedStableIdentityCollisionIndex,
  type ReferenceOccurrence,
  type StableIdentityRemap,
} from "@visualbridge/core";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
  type ProjectTransactionMutation,
  type ProjectTransactionPrecondition,
} from "@visualbridge/node-host";
import type { TableEditorProvider } from "../editor/tableEditorProvider";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import type { WorkspaceDocumentIndex } from "./workspaceDocumentIndex";
import {
  createWorkspaceLifecycleDocument,
  loadWorkspaceLifecycleDocument,
  type LifecycleReferenceRetarget,
} from "./workspaceLifecycleDocument";

interface PhysicalMutation {
  readonly sourcePath?: string;
  readonly targetPath?: string;
  readonly before?: Uint8Array;
  readonly after?: Uint8Array;
}

interface BuiltLifecyclePlan {
  readonly preview: DocumentLifecyclePreview;
  readonly mutations: readonly PhysicalMutation[];
  readonly preconditions: readonly ProjectTransactionPrecondition[];
  readonly targetPath?: string;
}

interface DependencySnapshot {
  readonly dependencies: readonly DocumentLifecycleDependency[];
  readonly preconditions: readonly ProjectTransactionPrecondition[];
}

export interface WorkspaceLifecyclePreview {
  readonly project: ProjectContext;
  readonly operation: DocumentLifecycleOperation;
  readonly preview: DocumentLifecyclePreview;
  readonly targetPath?: string;
}

export class WorkspaceDocumentLifecycle {
  private beforeMutateTestHook: (() => Promise<void>) | undefined;
  private committedRefreshFailureForTest: string | undefined;
  private lastApplyIndexStale = false;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly documents: WorkspaceDocumentIndex,
    private readonly references: WorkspaceReferenceService,
    private readonly tableEditors: TableEditorProvider,
    private readonly output: vscode.OutputChannel,
  ) {}

  public setBeforeMutateHookForTest(hook: () => Promise<void>): void {
    this.beforeMutateTestHook = hook;
  }

  public failCommittedRefreshForTest(message: string): void {
    this.committedRefreshFailureForTest = message;
  }

  public getLastApplyStatusForTest(): { readonly indexStale: boolean } {
    return { indexStale: this.lastApplyIndexStale };
  }

  public async previewMove(
    document: IndexedDocument,
    targetUri: vscode.Uri,
  ): Promise<WorkspaceLifecyclePreview> {
    const project = this.requireProject(document.projectId);
    this.assertLocalProject(project);
    this.assertProjectClean(project);
    const operation: DocumentLifecycleOperation = {
      kind: "move",
      source: selector(document),
      target: {
        projectId: document.projectId,
        documentTypeId: document.documentTypeId,
        editor: document.editor,
        path: relativeProjectPath(project, targetUri),
      },
    };
    const built = await this.build(project, operation);
    return { project, operation, preview: built.preview, ...(built.targetPath === undefined ? {} : { targetPath: built.targetPath }) };
  }

  public async previewCreate(
    project: ProjectContext,
    documentType: DocumentTypeDefinition,
    targetUri: vscode.Uri,
    parameters: Readonly<Record<string, import("@visualbridge/core").JsonValue>>,
  ): Promise<WorkspaceLifecyclePreview> {
    this.assertLocalProject(project);
    this.assertProjectClean(project);
    const targetPath = relativeProjectPath(project, targetUri);
    const operation: DocumentLifecycleOperation = {
      kind: "create",
      target: {
        projectId: project.definition.projectId,
        documentTypeId: documentType.id,
        editor: documentType.editor,
        path: targetPath,
      },
      parameters,
    };
    const built = await this.build(project, operation);
    return { project, operation, preview: built.preview, targetPath };
  }

  public async collectOwnedIdentities(document: IndexedDocument): Promise<readonly OwnedStableIdentity[]> {
    const project = this.requireProject(document.projectId);
    this.assertLocalProject(project);
    this.assertProjectClean(project);
    return (await loadWorkspaceLifecycleDocument(project, document)).ownedIdentities;
  }

  public async previewCopy(
    document: IndexedDocument,
    targetUri: vscode.Uri,
    stableIdRemap: readonly StableIdentityRemap[],
  ): Promise<WorkspaceLifecyclePreview> {
    const project = this.requireProject(document.projectId);
    this.assertLocalProject(project);
    this.assertProjectClean(project);
    const operation: DocumentLifecycleOperation = {
      kind: "copy",
      source: selector(document),
      target: { ...selector(document), path: relativeProjectPath(project, targetUri) },
      stableIdRemap,
    };
    const built = await this.build(project, operation);
    return { project, operation, preview: built.preview, ...(built.targetPath === undefined ? {} : { targetPath: built.targetPath }) };
  }

  public async previewDelete(
    document: IndexedDocument,
    target: DocumentLifecycleDeleteTarget = { kind: "document" },
  ): Promise<WorkspaceLifecyclePreview> {
    const project = this.requireProject(document.projectId);
    this.assertLocalProject(project);
    this.assertProjectClean(project);
    const operation: DocumentLifecycleOperation = {
      kind: "delete",
      source: selector(document),
      target,
    };
    const built = await this.build(project, operation);
    return { project, operation, preview: built.preview };
  }

  public async apply(preview: WorkspaceLifecyclePreview): Promise<vscode.Uri | undefined> {
    this.lastApplyIndexStale = false;
    this.assertProjectClean(preview.project);
    this.assertLocalProject(preview.project);
    let targetPath = preview.targetPath;
    await withProjectTransaction(preview.project.rootUri.fsPath, async (transaction) => {
      this.assertProjectClean(preview.project);
      this.references.invalidate();
      const refresh = await this.documents.refresh();
      if (refresh.status !== "applied") {
        throw new WorkspaceLifecycleError(
          "lifecycle.indexUnavailable",
          refresh.status === "failed"
            ? `Document Index refresh failed: ${refresh.message}`
            : "Document Index refresh was superseded before lifecycle apply.",
        );
      }
      const current = await this.build(preview.project, preview.operation);
      const request = {
        action: "apply" as const,
        operation: preview.operation,
        previewHash: preview.preview.previewHash,
        planPayload: preview.preview.planPayload,
        baseHashes: preview.preview.plan.baseHashes,
        dependencies: preview.preview.plan.dependencies,
      };
      const prepared = coreLifecycle(current.preview.plan).prepareApply(request, current.preview);
      if (!prepared.success) {
        if (prepared.status === "blocked") {
          throw new WorkspaceLifecycleError("lifecycle.blocked", formatBlockers(prepared.blockers));
        }
        throw new WorkspaceLifecycleError("lifecycle.conflict", prepared.message);
      }
      const mutations = current.mutations.flatMap((mutation): ProjectTransactionMutation[] => {
        if (mutation.sourcePath !== undefined && mutation.targetPath !== undefined) {
          return [
            physicalMutation(preview.project, mutation.sourcePath, mutation.before, undefined),
            physicalMutation(preview.project, mutation.targetPath, undefined, mutation.after),
          ];
        }
        const path = mutation.sourcePath ?? mutation.targetPath;
        if (path === undefined) return [];
        return [physicalMutation(preview.project, path, mutation.before, mutation.after)];
      });
      const beforeMutate = this.beforeMutateTestHook;
      this.beforeMutateTestHook = undefined;
      if (beforeMutate !== undefined) await beforeMutate();
      this.assertProjectClean(preview.project);
      const transactionResult = await transaction.mutate(mutations, current.preconditions);
      if (transactionResult.maintenance !== undefined) {
        this.output.appendLine(
          `[lifecycle] ${transactionResult.maintenance.code}: ${transactionResult.maintenance.message}`,
        );
      }
      targetPath = current.targetPath;
    }).catch((errorValue: unknown) => {
      if (errorValue instanceof ProjectTransactionConflict) {
        throw new WorkspaceLifecycleError("lifecycle.conflict", errorValue.message);
      }
      if (errorValue instanceof ProjectTransactionFailure) {
        throw new WorkspaceLifecycleError(errorValue.code, errorValue.message);
      }
      throw errorValue;
    });
    this.references.invalidate();
    const indexStaleMessage = await this.refreshCommittedIndex();
    this.lastApplyIndexStale = indexStaleMessage !== undefined;
    if (indexStaleMessage !== undefined) {
      this.output.appendLine(`[lifecycle] indexStale: ${indexStaleMessage}`);
      void vscode.window.showWarningMessage(
        `${indexStaleMessage} The lifecycle transaction is already committed; do not retry it.`,
        "Refresh Documents",
      ).then((selection) => selection === "Refresh Documents"
        ? vscode.commands.executeCommand("visualbridge.documentBrowser.refresh")
        : undefined);
    }
    this.output.appendLine(`[lifecycle] Applied ${preview.operation.kind} in '${preview.project.definition.projectId}'.`);
    return targetPath === undefined
      ? undefined
      : vscode.Uri.joinPath(preview.project.rootUri, ...targetPath.split("/"));
  }

  private async refreshCommittedIndex(): Promise<string | undefined> {
    if (this.committedRefreshFailureForTest !== undefined) {
      const message = this.committedRefreshFailureForTest;
      this.committedRefreshFailureForTest = undefined;
      return `Document Index refresh failed after commit: ${message}`;
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refresh = await this.documents.refresh();
      if (refresh.status === "applied") return undefined;
      if (refresh.status === "failed") {
        return `Document Index refresh failed after commit: ${refresh.message}`;
      }
    }
    return "Document Index refresh was repeatedly superseded after commit; the index is stale.";
  }

  private async build(
    project: ProjectContext,
    operation: DocumentLifecycleOperation,
  ): Promise<BuiltLifecyclePlan> {
    const blockers: DocumentLifecycleBlocker[] = [];
    const sourceDocument = operation.kind === "create"
      ? undefined
      : this.documents.documents.find((document) => sameSelector(document, operation.source));
    if (operation.kind !== "create" && sourceDocument === undefined) {
      blockers.push({ code: "source.notFound", message: `Lifecycle source '${operation.source.path}' is not indexed.` });
    }
    const sourcePaths = sourceDocument?.sourcePaths ?? [];
    const sourceBytes = new Map<string, Uint8Array>();
    for (const path of sourcePaths) {
      const uri = projectUri(project, path);
      try {
        sourceBytes.set(path, await vscode.workspace.fs.readFile(uri));
      } catch {
        blockers.push({ code: "source.notFound", path, message: `Physical source '${path}' no longer exists.` });
      }
    }
    const baseHashes = Object.fromEntries([...sourceBytes].map(([path, bytes]) => [path, hashBytes(bytes)]));
    const dependencySnapshot = await this.dependencies(project);
    let identityCollisions: OwnedStableIdentityCollisionIndex | undefined;
    if (operation.kind === "create" || operation.kind === "copy") {
      try {
        identityCollisions = await this.buildIdentityCollisionIndex(project);
      } catch (errorValue) {
        blockers.push({
          code: "source.invalid",
          message: `Cannot establish the Project owned-identity collision index: ${formatError(errorValue)}`,
        });
      }
    }
    const mutations: PhysicalMutation[] = [];
    let targetPath: string | undefined;
    let semanticMutations: DocumentLifecyclePlan["mutations"] = [];
    let ownedIdentities: readonly OwnedStableIdentity[] = [];
    let referenceImpacts: readonly DocumentLifecycleReferenceImpact[] = [];
    let semantic = sourceDocument === undefined ? undefined : await loadWorkspaceLifecycleDocument(project, sourceDocument)
      .catch((errorValue: unknown) => {
        blockers.push({ code: "source.invalid", message: formatError(errorValue) });
        return undefined;
      });
    const hydrated = semantic === undefined
      ? { identities: [] as readonly OwnedStableIdentity[], blockers: [] as readonly DocumentLifecycleBlocker[] }
      : await this.hydrateOwnedIdentities(project, semantic.ownedIdentities, semantic.addressableIdentityKeys);
    blockers.push(...hydrated.blockers);

    if (operation.kind === "create") {
      targetPath = operation.target.path;
      blockers.push(...await this.targetBlockers(project, operation.target));
      const documentType = project.definition.documentTypes.find((candidate) => candidate.id === operation.target.documentTypeId);
      const created = documentType === undefined ? undefined : await createWorkspaceLifecycleDocument(
        project,
        documentType,
        operation.target.path,
        operation.parameters,
      ).catch((errorValue: unknown) => {
        blockers.push({ code: "source.invalid", message: formatError(errorValue) });
        return undefined;
      });
      ownedIdentities = created?.ownedIdentities ?? [];
      if (created !== undefined) {
        if (identityCollisions !== undefined) {
          blockers.push(...validateOwnedStableIdentityTargetCollisions(identityCollisions, ownedIdentities));
        }
        for (const prepared of created.sources) mutations.push({ targetPath: prepared.path, after: prepared.bytes });
        semanticMutations = mutations.map((mutation) => ({
          kind: "create" as const,
          path: mutation.targetPath!,
          nextHash: hashBytes(mutation.after!),
          targetMustBeAbsent: true as const,
        }));
      }
    } else if (operation.kind === "move" && sourceDocument !== undefined) {
      ownedIdentities = hydrated.identities;
      const targetPaths = mapTargetManifest(sourceDocument, operation.target.path);
      if (targetPaths.length !== sourcePaths.length) {
        blockers.push({ code: "target.typeMismatch", message: "The target manifest does not match the source document." });
      } else {
        for (let index = 0; index < sourcePaths.length; index += 1) {
          const sourcePath = sourcePaths[index]!;
          const destinationPath = targetPaths[index]!;
          blockers.push(...await this.targetBlockers(project, { ...operation.target, path: destinationPath }));
          const bytes = sourceBytes.get(sourcePath);
          if (bytes === undefined) continue;
          mutations.push({ sourcePath, targetPath: destinationPath, before: bytes, after: bytes });
        }
        semanticMutations = mutations.map((mutation) => ({
          kind: "move" as const,
          sourcePath: mutation.sourcePath!,
          targetPath: mutation.targetPath!,
          baseHash: hashBytes(mutation.before!),
          targetMustBeAbsent: true as const,
        }));
        targetPath = targetPaths[sourcePaths.indexOf(sourceDocument.path)] ?? targetPaths[0];
        referenceImpacts = await this.moveReferenceImpacts(project, sourceDocument, ownedIdentities, sourcePaths, targetPaths);
      }
    } else if (operation.kind === "copy" && sourceDocument !== undefined) {
      ownedIdentities = hydrated.identities;
      const targetPaths = mapTargetManifest(sourceDocument, operation.target.path);
      if (targetPaths.length !== sourcePaths.length) {
        blockers.push({ code: "target.typeMismatch", message: "The target manifest does not match the source document." });
      } else {
        for (const destinationPath of targetPaths) {
          blockers.push(...await this.targetBlockers(project, { ...operation.target, path: destinationPath }));
        }
        const remapValidation = validateCompleteStableIdentityRemap(ownedIdentities, operation.stableIdRemap);
        if (!remapValidation.success) {
          blockers.push(...remapValidation.blockers);
        } else if (identityCollisions !== undefined) {
          blockers.push(...validateOwnedStableIdentityTargetCollisions(
            identityCollisions,
            remapOwnedStableIdentityCollisionTargets(ownedIdentities, remapValidation.remap),
          ));
        }
        if (semantic !== undefined) {
          const classification = this.classifyCopyReferences(sourceDocument, ownedIdentities, operation.stableIdRemap);
          blockers.push(...classification.blockers);
          referenceImpacts = classification.impacts;
          if (classification.blockers.length === 0) {
            const transformed = await semantic.remapOwnedIdentities(operation.stableIdRemap, classification.internalRetargets);
            if (!transformed.success) {
              blockers.push(...diagnosticBlockers(transformed.diagnostics));
            } else {
              const targetBySource = new Map(sourcePaths.map((path, index) => [path, targetPaths[index]]));
              for (const source of transformed.sources) {
                const destinationPath = targetBySource.get(source.path);
                if (destinationPath !== undefined) mutations.push({ targetPath: destinationPath, after: source.bytes });
              }
              semanticMutations = mutations.map((mutation) => ({
                kind: "create" as const,
                path: mutation.targetPath!,
                nextHash: hashBytes(mutation.after!),
                targetMustBeAbsent: true as const,
              }));
            }
          }
        }
        targetPath = targetPaths[sourcePaths.indexOf(sourceDocument.path)] ?? targetPaths[0];
      }
    } else if (operation.kind === "delete" && sourceDocument !== undefined) {
      ownedIdentities = hydrated.identities;
      if (operation.target.kind === "document") {
        const deletion = this.deleteAnalysis(sourceDocument, ownedIdentities);
        blockers.push(...deletion.blockers);
        referenceImpacts = deletion.impacts;
        for (const path of sourcePaths) {
          const bytes = sourceBytes.get(path);
          if (bytes !== undefined) mutations.push({ sourcePath: path, before: bytes });
        }
        semanticMutations = mutations.map((mutation) => ({
          kind: "delete" as const,
          path: mutation.sourcePath!,
          baseHash: hashBytes(mutation.before!),
        }));
      } else if (semantic !== undefined) {
        const transformed = await semantic.deleteOwnedTarget(operation.target);
        if (!transformed.success) {
          blockers.push(...diagnosticBlockers(transformed.diagnostics));
        } else {
          const remainingKeys = new Set(transformed.ownedIdentities.map((identity) => identity.identityKey));
          const removed = ownedIdentities.filter((identity) => !remainingKeys.has(identity.identityKey));
          ownedIdentities = removed;
          const deletion = this.deleteAnalysis(sourceDocument, removed);
          blockers.push(...deletion.blockers);
          referenceImpacts = deletion.impacts;
          blockers.push(...unresolvedInternalBlockers(sourceDocument, transformed.references, removed));
          for (const source of transformed.sources) {
            const before = sourceBytes.get(source.path);
            if (before !== undefined) mutations.push({ sourcePath: source.path, before, after: source.bytes });
          }
          semanticMutations = mutations.map((mutation) => ({
            kind: "replace" as const,
            path: mutation.sourcePath!,
            baseHash: hashBytes(mutation.before!),
            nextHash: hashBytes(mutation.after!),
          }));
        }
      }
    }

    const plan: DocumentLifecyclePlan = {
      version: 1,
      operation,
      ownedIdentities,
      stableIdRemap: operation.kind === "copy" ? operation.stableIdRemap : [],
      referenceImpacts,
      blockers,
      dependencies: dependencySnapshot.dependencies,
      baseHashes,
      mutations: semanticMutations,
    };
    const preview = await coreLifecycle(plan).preview(operation);
    return {
      preview,
      mutations,
      preconditions: dependencySnapshot.preconditions,
      ...(targetPath === undefined ? {} : { targetPath }),
    };
  }

  private deleteAnalysis(
    target: IndexedDocument,
    identities: readonly OwnedStableIdentity[],
  ): {
    readonly blockers: readonly DocumentLifecycleBlocker[];
    readonly impacts: readonly DocumentLifecycleReferenceImpact[];
  } {
    const projectDocuments = this.documents.documents.filter((document) => document.projectId === target.projectId);
    const coverageProblem = projectDocuments.flatMap((document) => document.diagnostics).find((diagnostic) => (
      diagnostic.severity === "error"
      || diagnostic.code === "reference.providerUnavailable"
      || diagnostic.code === "reference.invalidTarget"
    ));
    const blockers: DocumentLifecycleBlocker[] = coverageProblem === undefined ? [] : [{
      code: "source.invalid",
      message: `Safe Delete cannot prove complete Reference coverage: ${coverageProblem.path}: ${coverageProblem.message}`,
    }];
    const impacts: DocumentLifecycleReferenceImpact[] = [];
    const closure = new Set(target.sourcePaths);
    const removedByLocation = identitiesByLocation(identities);
    for (const source of projectDocuments) {
      if (source.sourcePaths.some((path) => closure.has(path))) continue;
      for (const reference of source.references) {
        const identity = resolvedIdentity(reference.resolution.candidates, removedByLocation);
        if (identity === undefined) continue;
        const occurrence = lifecycleOccurrence(source, reference.occurrence);
        blockers.push({
          code: "reference.inbound",
          path: reference.occurrence.path,
          identityKey: identity.identityKey,
          occurrence,
          message: `'${source.title}' references '${identity.identityKey}' inside '${target.title}'.`,
        });
        impacts.push({ kind: "externalInbound", occurrence, targetIdentityKey: identity.identityKey });
      }
    }
    return { blockers, impacts };
  }

  private async targetBlockers(
    project: ProjectContext,
    target: { readonly projectId: string; readonly documentTypeId: string; readonly editor: string; readonly path: string },
  ): Promise<readonly DocumentLifecycleBlocker[]> {
    const match = this.projects.resolveDocument(projectUri(project, target.path));
    if (target.projectId !== project.definition.projectId
      || match?.project.markerUri.toString() !== project.markerUri.toString()
      || match.documentType.id !== target.documentTypeId
      || match.documentType.editor !== target.editor) {
      return [{ code: "target.typeMismatch", path: target.path, message: `Target '${target.path}' is not in the same Project Document Type.` }];
    }
    return await exists(projectUri(project, target.path))
      ? [{ code: "target.exists", path: target.path, message: `Target '${target.path}' already exists.` }]
      : [];
  }

  private async buildIdentityCollisionIndex(project: ProjectContext): Promise<OwnedStableIdentityCollisionIndex> {
    const documents = [];
    for (const document of this.documents.documents.filter((candidate) => (
      candidate.projectId === project.definition.projectId
    ))) {
      const lifecycleDocument = await loadWorkspaceLifecycleDocument(project, document);
      documents.push({ document: selector(document), ownedIdentities: lifecycleDocument.ownedIdentities });
    }
    return buildOwnedStableIdentityCollisionIndex(documents);
  }

  private async hydrateOwnedIdentities(
    project: ProjectContext,
    identities: readonly OwnedStableIdentity[],
    addressableIdentityKeys: ReadonlySet<string>,
  ): Promise<{
    readonly identities: readonly OwnedStableIdentity[];
    readonly blockers: readonly DocumentLifecycleBlocker[];
  }> {
    const blockers: DocumentLifecycleBlocker[] = [];
    const hydrated = await Promise.all(identities.map(async (identity): Promise<OwnedStableIdentity> => {
      const definition = identity.reference?.definition;
      if (definition === undefined) return identity;
      if (!addressableIdentityKeys.has(identity.identityKey)) {
        return { ...identity, reference: { definition } };
      }
      const resolution = await this.references.resolve(project, definition, identity.value);
      const location = resolution.status === "resolved" && resolution.candidates.length === 1
        ? resolution.candidates[0]?.location
        : undefined;
      if (location === undefined) {
        blockers.push({
          code: "source.invalid",
          identityKey: identity.identityKey,
          message: `Owned identity '${identity.identityKey}' does not resolve uniquely (${resolution.status}).`,
        });
        return identity;
      }
      return { ...identity, reference: { definition, location } };
    }));
    return { identities: hydrated, blockers };
  }

  private classifyCopyReferences(
    source: IndexedDocument,
    identities: readonly OwnedStableIdentity[],
    remap: readonly StableIdentityRemap[],
  ): {
    readonly blockers: readonly DocumentLifecycleBlocker[];
    readonly impacts: readonly DocumentLifecycleReferenceImpact[];
    readonly internalRetargets: readonly LifecycleReferenceRetarget[];
  } {
    const byLocation = new Map(identities.flatMap((identity) => (
      identity.reference?.location === undefined
        ? []
        : [[referenceLocationKey(identity.reference.location), identity] as const]
    )));
    const remapByKey = new Map(remap.map((entry) => [entry.identityKey, entry]));
    const blockers: DocumentLifecycleBlocker[] = [];
    const impacts: DocumentLifecycleReferenceImpact[] = [];
    const internalRetargets: LifecycleReferenceRetarget[] = [];
    for (const reference of source.references) {
      const occurrence = lifecycleOccurrence(source, reference.occurrence);
      if (reference.resolution.status === "missing" && reference.occurrence.definition.allowMissing) {
        impacts.push({ kind: "outboundPreserved", occurrence });
        continue;
      }
      const location = reference.resolution.candidates.length === 1
        ? reference.resolution.candidates[0]?.location
        : undefined;
      if (reference.resolution.status !== "resolved" || location === undefined) {
        blockers.push({
          code: "reference.unresolvedInternal",
          path: reference.occurrence.path,
          occurrence,
          message: `Copy cannot classify ${reference.resolution.status} reference '${reference.occurrence.path}'.`,
        });
        continue;
      }
      const identity = byLocation.get(referenceLocationKey(location));
      if (identity === undefined) {
        impacts.push({ kind: "outboundPreserved", occurrence, target: location });
        continue;
      }
      const replacement = remapByKey.get(identity.identityKey)?.to;
      if (replacement === undefined) {
        blockers.push({
          code: "identity.remapMissing",
          path: reference.occurrence.path,
          identityKey: identity.identityKey,
          occurrence,
          message: `Copy remap is missing '${identity.identityKey}'.`,
        });
        continue;
      }
      internalRetargets.push({ path: reference.occurrence.path, replacement });
      impacts.push({
        kind: "internalRetarget",
        occurrence,
        targetIdentityKey: identity.identityKey,
        replacement,
      });
    }
    return { blockers, impacts, internalRetargets };
  }

  private async moveReferenceImpacts(
    project: ProjectContext,
    source: IndexedDocument,
    identities: readonly OwnedStableIdentity[],
    sourcePaths: readonly string[],
    targetPaths: readonly string[],
  ): Promise<readonly DocumentLifecycleReferenceImpact[]> {
    const targetBySource = new Map(sourcePaths.map((path, index) => [path, targetPaths[index]]));
    const impacts: DocumentLifecycleReferenceImpact[] = [];
    for (const identity of identities) {
      const definition = identity.reference?.definition;
      if (definition === undefined) continue;
      const resolution = await this.references.resolve(project, definition, identity.value);
      const from = resolution.candidates.map((candidate) => candidate.location).find((location) => (
        location?.projectId === source.projectId
        && location.documentTypeId === source.documentTypeId
        && sourcePaths.includes(location.path)
      ));
      if (from === undefined) continue;
      const movedPath = targetBySource.get(from.path);
      if (movedPath !== undefined) impacts.push({
        kind: "targetLocationChanged",
        identityKey: identity.identityKey,
        from,
        to: { ...from, path: movedPath },
      });
    }
    return impacts;
  }

  private async dependencies(
    project: ProjectContext,
  ): Promise<DependencySnapshot> {
    const projectBytes = await vscode.workspace.fs.readFile(project.markerUri);
    const preconditions = new Map<string, ProjectTransactionPrecondition>();
    const projectPath = relativeProjectPath(project, project.markerUri);
    preconditions.set(projectPath, physicalPrecondition(project, projectPath, hashBytes(projectBytes)));
    const catalogEntries: { path: string; hash: string }[] = [];
    const catalogPaths = [...new Set(project.definition.documentTypes.flatMap((documentType) => documentType.catalogs))].sort(compareUtf16CodeUnits);
    for (const path of catalogPaths) {
      try {
        const hash = hashBytes(await vscode.workspace.fs.readFile(projectUri(project, path)));
        catalogEntries.push({ path, hash });
        preconditions.set(path, physicalPrecondition(project, path, hash));
      } catch {
        catalogEntries.push({ path, hash: "missing" });
        preconditions.set(path, physicalPrecondition(project, path));
      }
    }
    const indexed = this.documents.documents.filter((document) => document.projectId === project.definition.projectId);
    const physicalDocumentHashes = new Map<string, string>();
    for (const path of [...new Set(indexed.flatMap((document) => document.sourcePaths))].sort(compareUtf16CodeUnits)) {
      try {
        const hash = hashBytes(await vscode.workspace.fs.readFile(projectUri(project, path)));
        physicalDocumentHashes.set(path, hash);
        preconditions.set(path, physicalPrecondition(project, path, hash));
      } catch {
        physicalDocumentHashes.set(path, "missing");
        preconditions.set(path, physicalPrecondition(project, path));
      }
    }
    const documents = [...physicalDocumentHashes].map(([path, hash]) => ({ path, hash }));
    const dependencies = await buildCanonicalDocumentLifecycleDependencies({
      projectId: project.definition.projectId,
      project: { path: projectPath, hash: hashBytes(projectBytes) },
      catalogs: catalogEntries,
      documents,
      index: indexed,
    }, hashText);
    return {
      dependencies,
      preconditions: [...preconditions.values()].sort((left, right) => compareUtf16CodeUnits(left.path, right.path)),
    };
  }

  private assertProjectClean(project: ProjectContext): void {
    const metadataUris = new Set([
      project.markerUri.toString(),
      ...project.definition.documentTypes.flatMap((documentType) => documentType.catalogs)
        .map((path) => projectUri(project, path).toString()),
    ]);
    const dirtyText = vscode.workspace.textDocuments.find((document) => {
      if (!document.isDirty) return false;
      return metadataUris.has(document.uri.toString())
        || this.projects.resolveDocument(document.uri)?.project.markerUri.toString() === project.markerUri.toString();
    });
    if (dirtyText !== undefined || this.tableEditors.hasDirtyProject(project)) {
      throw new WorkspaceLifecycleError(
        "lifecycle.workspaceDirty",
        `Save or revert every dirty VisualBridge editor in '${project.definition.projectId}' before preview/apply.`,
      );
    }
  }

  private assertLocalProject(project: ProjectContext): void {
    if (project.rootUri.scheme !== "file") {
      throw new WorkspaceLifecycleError(
        "lifecycle.localFileSystemRequired",
        "Document Lifecycle currently requires a local file Project.",
      );
    }
  }

  private requireProject(projectId: string): ProjectContext {
    const project = this.projects.projects.find((candidate) => candidate.definition.projectId === projectId);
    if (project === undefined) throw new WorkspaceLifecycleError("source.notFound", `Project '${projectId}' is not open.`);
    return project;
  }

}

export class WorkspaceLifecycleError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceLifecycleError";
  }
}

function selector(document: IndexedDocument) {
  return {
    projectId: document.projectId,
    documentTypeId: document.documentTypeId,
    editor: document.editor,
    path: document.path,
  };
}

function sameSelector(document: IndexedDocument, candidate: ReturnType<typeof selector>): boolean {
  return document.projectId === candidate.projectId
    && document.documentTypeId === candidate.documentTypeId
    && document.editor === candidate.editor
    && document.path === candidate.path;
}

function mapTargetManifest(document: IndexedDocument, targetPrimaryPath: string): readonly string[] {
  if (document.sourcePaths.length <= 1) return [targetPrimaryPath];
  const sourcePrimaryName = nodePath.posix.basename(document.path);
  if (nodePath.posix.basename(targetPrimaryPath) !== sourcePrimaryName) return [];
  const targetDirectory = nodePath.posix.dirname(targetPrimaryPath);
  return document.sourcePaths.map((path) => nodePath.posix.join(targetDirectory, nodePath.posix.basename(path)));
}

function physicalMutation(
  project: ProjectContext,
  path: string,
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
): ProjectTransactionMutation {
  return { path, absolutePath: projectUri(project, path).fsPath, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
}

function physicalPrecondition(
  project: ProjectContext,
  path: string,
  hash?: string,
): ProjectTransactionPrecondition {
  return hash === undefined
    ? { path, absolutePath: projectUri(project, path).fsPath, expectedAbsent: true }
    : { path, absolutePath: projectUri(project, path).fsPath, hash };
}

function projectUri(project: ProjectContext, path: string): vscode.Uri {
  return vscode.Uri.joinPath(project.rootUri, ...path.split("/"));
}

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  if (project.rootUri.scheme !== uri.scheme || project.rootUri.authority !== uri.authority) {
    throw new WorkspaceLifecycleError("target.typeMismatch", "Lifecycle target must use the Project filesystem.");
  }
  const path = project.rootUri.scheme === "file"
    ? nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/")
    : nodePath.posix.relative(project.rootUri.path, uri.path);
  if (path.length === 0 || path === ".." || path.startsWith("../") || nodePath.posix.isAbsolute(path)) {
    throw new WorkspaceLifecycleError("target.typeMismatch", "Lifecycle target must stay inside the Project root.");
  }
  return path;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashText(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}

function coreLifecycle(plan: DocumentLifecyclePlan): DocumentLifecycleService {
  return new DocumentLifecycleService(() => plan, hashText);
}

function diagnosticBlockers(
  diagnostics: readonly { readonly path: string; readonly message: string }[],
): readonly DocumentLifecycleBlocker[] {
  return diagnostics.map((diagnostic) => ({
    code: "source.invalid",
    path: diagnostic.path,
    message: diagnostic.message,
  }));
}

function unresolvedInternalBlockers(
  source: IndexedDocument,
  references: readonly ReferenceOccurrence[],
  removed: readonly OwnedStableIdentity[],
): readonly DocumentLifecycleBlocker[] {
  const remainingPaths = new Set(references.map((reference) => reference.path));
  const removedByLocation = identitiesByLocation(removed);
  return source.references.flatMap((reference) => {
    if (!remainingPaths.has(reference.occurrence.path)) return [];
    const identity = resolvedIdentity(reference.resolution.candidates, removedByLocation);
    return identity === undefined ? [] : [{
      code: "reference.unresolvedInternal" as const,
      path: reference.occurrence.path,
      identityKey: identity.identityKey,
      occurrence: lifecycleOccurrence(source, reference.occurrence),
      message: `Deleting '${identity.identityKey}' would leave an internal reference at '${reference.occurrence.path}'.`,
    }];
  });
}

function identitiesByLocation(
  identities: readonly OwnedStableIdentity[],
): ReadonlyMap<string, OwnedStableIdentity> {
  return new Map(identities.flatMap((identity) => (
    identity.reference?.location === undefined
      ? []
      : [[referenceLocationKey(identity.reference.location), identity] as const]
  )));
}

function resolvedIdentity(
  candidates: readonly { readonly location?: Parameters<typeof referenceLocationKey>[0] }[],
  identities: ReadonlyMap<string, OwnedStableIdentity>,
): OwnedStableIdentity | undefined {
  for (const candidate of candidates) {
    if (candidate.location === undefined) continue;
    const identity = identities.get(referenceLocationKey(candidate.location));
    if (identity !== undefined) return identity;
  }
  return undefined;
}

function lifecycleOccurrence(document: IndexedDocument, occurrence: ReferenceOccurrence) {
  return { document: selector(document), ...occurrence };
}

function formatBlockers(blockers: readonly DocumentLifecycleBlocker[]): string {
  return blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("\n");
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
