/**
 * MCP 的 Document Lifecycle 宿主编排（B4）。
 *
 * 快照装载、稳定身份、改名与删除目标都来自模块 facet；本文件只保留与语义无关的编排：
 * Project 索引、身份冲突索引、依赖清单、Project Transaction 与 preview/apply 幂等。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DocumentLifecycleService as CoreDocumentLifecycleService,
  buildCanonicalDocumentLifecycleDependencies,
  buildOwnedStableIdentityCollisionIndex,
  compareUtf16CodeUnits,
  prepareDocumentLifecycleApply,
  referenceLocationKey,
  remapOwnedStableIdentityCollisionTargets,
  validateCompleteStableIdentityRemap,
  validateOwnedStableIdentityTargetCollisions,
  type DocumentLifecycleApplyRequest,
  type DocumentLifecycleBlocker,
  type DocumentLifecycleDependency,
  type DocumentLifecycleDeleteTarget,
  type DocumentLifecycleOperation,
  type DocumentLifecyclePlan,
  type DocumentLifecyclePreview,
  type DocumentLifecycleReferenceImpact,
  type DocumentLifecycleReferenceOccurrence,
  type DocumentLifecycleRequest,
  type DocumentLifecycleSelector,
  type IndexedDocument,
  type JsonValue,
  type OwnedStableIdentity,
  type OwnedStableIdentityCollisionIndex,
  type ReferenceDefinition,
  type ReferenceLocation,
  type ReferenceOccurrence,
  type StableIdentityRemap,
} from "@visualbridge/core";
import type { LoadedDocument, LoadedSourceFile, RenderedSource } from "./documentService.js";
import { McpDocumentService } from "./documentService.js";
import type { McpModuleRegistry } from "./moduleRegistry.js";
import {
  VisualBridgeMcpError,
  resolveAbsentProjectPath,
  resolveExistingProjectPath,
  type DeclaredDocumentContext,
  type ProjectContext,
  type VisualBridgeWorkspace,
} from "./projectWorkspace.js";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
  type ProjectTransactionMutation,
  type ProjectTransactionPrecondition,
} from "./projectTransaction.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";

export type DocumentLifecycleHostRequest = DocumentLifecycleRequest & {
  readonly projectFile?: string;
};

type PlannedOwnedStableIdentity = Omit<OwnedStableIdentity, "reference"> & {
  readonly reference?: {
    readonly definition: ReferenceDefinition;
    readonly location?: ReferenceLocation;
  };
};

interface LifecycleSnapshot {
  readonly selector: DocumentLifecycleSelector;
  readonly loaded: LoadedDocument;
  readonly occurrences: readonly ReferenceOccurrence[];
  readonly ownedIdentities: readonly PlannedOwnedStableIdentity[];
}

interface HostMutation extends ProjectTransactionMutation {
  readonly core?: DocumentLifecyclePlan["mutations"][number];
}

interface PreparedLifecycle {
  readonly project: ProjectContext;
  readonly preview: DocumentLifecyclePreview;
  readonly hostMutations: readonly HostMutation[];
  readonly preconditions: readonly ProjectTransactionPrecondition[];
}

interface DeletePreparation {
  readonly ownedIdentities: readonly PlannedOwnedStableIdentity[];
  readonly internalOccurrencePaths: ReadonlySet<string>;
  readonly nextDocument?: unknown;
}

export class DocumentLifecycleService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
    private readonly documents: McpDocumentService,
    private readonly modules: McpModuleRegistry,
  ) {}

  public async execute(input: unknown): Promise<Record<string, unknown>> {
    const request = input as DocumentLifecycleHostRequest;
    if (request.action === "preview") {
      return previewResult(await this.prepare(request));
    }
    const project = await this.workspace.resolveProject(request.projectFile);
    try {
      return await withProjectTransaction(project.projectRoot, async (transaction) => {
        let prepared: PreparedLifecycle;
        try {
          prepared = await this.prepare(request);
        } catch (errorValue) {
          if (!(errorValue instanceof VisualBridgeMcpError) || !isPreviewInvalidation(errorValue.code)) {
            throw errorValue;
          }
          return {
            status: "conflict",
            reason: "previewInvalidated",
            message: formatError(errorValue),
          };
        }
        const readiness = prepareDocumentLifecycleApply(
          request as DocumentLifecycleApplyRequest,
          prepared.preview,
        );
        if (!readiness.success) {
          return readiness.status === "blocked"
            ? { ...previewResult(prepared), status: "blocked", blockers: readiness.blockers }
            : { ...previewResult(prepared), status: "conflict", reason: readiness.reason, message: readiness.message };
        }
        const committed = await transaction.mutate(prepared.hostMutations, prepared.preconditions);
        return {
          status: "applied",
          projectFile: prepared.project.projectFile,
          previewHash: prepared.preview.previewHash,
          operation: prepared.preview.plan.operation,
          mutations: committed.mutations,
          ...(committed.maintenance === undefined ? {} : { maintenance: committed.maintenance }),
        };
      });
    } catch (errorValue) {
      if (errorValue instanceof ProjectTransactionConflict) {
        return {
          status: "conflict",
          reason: errorValue.reason,
          message: errorValue.message,
          details: errorValue.details,
        };
      }
      if (errorValue instanceof ProjectTransactionFailure) {
        throw new VisualBridgeMcpError(errorValue.code, errorValue.message, errorValue.details);
      }
      throw errorValue;
    }
  }

  private async prepare(request: DocumentLifecycleHostRequest): Promise<PreparedLifecycle> {
    const project = await this.workspace.resolveProject(request.projectFile);
    validateOperationProject(request.operation, project);
    const indexed = await this.references.buildProjectIndex(project.projectFile, {
      errorCode: "lifecycle.invalidSource",
    });
    const referenceService = await this.references.createProjectService(project.projectFile);
    const dependencies = await buildDependencies(project, indexed);
    const preconditions = await buildDependencyPreconditions(project, dependencies);
    const identityCollisions = request.operation.kind === "create" || request.operation.kind === "copy"
      ? await this.buildIdentityCollisionIndex(project, indexed, referenceService)
      : undefined;
    let prepared: {
      readonly ownedIdentities: readonly OwnedStableIdentity[];
      readonly stableIdRemap: readonly StableIdentityRemap[];
      readonly impacts: readonly DocumentLifecycleReferenceImpact[];
      readonly blockers: readonly DocumentLifecycleBlocker[];
      readonly mutations: readonly HostMutation[];
    };
    switch (request.operation.kind) {
      case "create":
        prepared = await this.prepareCreate(project, request.operation, identityCollisions!);
        break;
      case "copy":
        prepared = await this.prepareCopy(project, request.operation, referenceService, identityCollisions!);
        break;
      case "move":
        prepared = await this.prepareMove(project, request.operation, referenceService);
        break;
      case "delete":
        prepared = await this.prepareDelete(project, request.operation, indexed, referenceService);
        break;
    }
    const baseHashes = await buildSourceBaseHashes(project, indexed, request.operation);
    const plan: DocumentLifecyclePlan = {
      version: 1,
      operation: request.operation,
      ownedIdentities: prepared.ownedIdentities,
      stableIdRemap: prepared.stableIdRemap,
      referenceImpacts: prepared.impacts,
      blockers: prepared.blockers,
      dependencies,
      baseHashes,
      mutations: prepared.mutations.flatMap((mutation) => mutation.core === undefined ? [] : [mutation.core]),
    };
    const coreService = new CoreDocumentLifecycleService(async () => plan, hashStable);
    const preview = await coreService.preview(request.operation);
    return {
      project,
      preview,
      hostMutations: prepared.blockers.length === 0 ? prepared.mutations : [],
      preconditions: [
        ...preconditions,
        ...prepared.mutations.flatMap((mutation): ProjectTransactionPrecondition[] => (
          mutation.before === undefined
            ? [{ path: mutation.path, absolutePath: mutation.absolutePath, expectedAbsent: true }]
            : []
        )),
      ],
    };
  }

  private async prepareCreate(
    project: ProjectContext,
    operation: Extract<DocumentLifecycleOperation, { readonly kind: "create" }>,
    identityCollisions: OwnedStableIdentityCollisionIndex,
  ) {
    const target = await this.resolveTarget(project, operation.target);
    const context = target.context;
    const module = await this.modules.requireModule(project, context.documentType.editor);
    const catalog = await this.documents.loadCatalog(
      project,
      context.documentType.editor,
      context.documentType,
      module,
    );
    const createFacet = module.create;
    if (createFacet === undefined) {
      // 只读 editor 不提供 `create` facet：给出可读的 MCP 错误，而不是 TypeError。
      throw new VisualBridgeMcpError(
        "lifecycle.invalidCreate",
        `Editor '${context.documentType.editor}' does not support document creation (module '${module.id}' has no create facet).`,
      );
    }
    const created = await createFacet.createDocument({
      projectId: project.definition.projectId,
      projectDefinition: project.definition as unknown as JsonValue,
      documentType: context.documentType,
      catalog: {
        ready: catalog.registry !== undefined,
        registry: catalog.registry,
        diagnostics: catalog.diagnostics,
      },
      newStableId: defaultStableId,
      parameters: operation.parameters,
      targetPath: context.path,
    });
    if (!created.success) {
      throw new VisualBridgeMcpError("lifecycle.invalidCreate", created.message);
    }
    const sources: readonly PreparedLifecycleSource[] = created.sources.map((file) => ({
      path: file.path,
      absolutePath: path.isAbsolute(file.path)
        ? file.path
        : path.resolve(project.projectRoot, ...file.path.split("/")),
      after: Buffer.from(file.bytes),
    }));
    const blockers: DocumentLifecycleBlocker[] = target.blocker === undefined ? [] : [target.blocker];
    blockers.push(...validateOwnedStableIdentityTargetCollisions(identityCollisions, created.ownedIdentities));
    return {
      ownedIdentities: created.ownedIdentities,
      stableIdRemap: [],
      impacts: [],
      blockers,
      mutations: sources.map(createHostMutation),
    };
  }

  private async prepareCopy(
    project: ProjectContext,
    operation: Extract<DocumentLifecycleOperation, { readonly kind: "copy" }>,
    references: Awaited<ReturnType<VisualBridgeReferenceService["createProjectService"]>>,
    identityCollisions: OwnedStableIdentityCollisionIndex,
  ) {
    const source = await this.loadSnapshot(project, operation.source, references);
    const targets = await this.resolveMappedTargets(project, operation.source, operation.target, source.loaded.sources);
    const remapValidation = validateCompleteStableIdentityRemap(source.ownedIdentities, operation.stableIdRemap);
    if (!remapValidation.success) {
      return emptyPreparation(
        [...targets.blockers, ...remapValidation.blockers],
        source.ownedIdentities,
        operation.stableIdRemap,
      );
    }
    const blockers: DocumentLifecycleBlocker[] = [...targets.blockers];
    blockers.push(...validateOwnedStableIdentityTargetCollisions(
      identityCollisions,
      remapOwnedStableIdentityCollisionTargets(source.ownedIdentities, remapValidation.remap),
    ));
    const byLocation = new Map(source.ownedIdentities.flatMap((identity) => (
      identity.reference?.location === undefined
        ? []
        : [[referenceLocationKey(identity.reference.location), identity] as const]
    )));
    const internal = new Map<string, StableIdentityRemap>();
    const impacts: DocumentLifecycleReferenceImpact[] = [];
    let classificationBlocked = false;
    for (const occurrence of source.occurrences) {
      const resolution = await references.resolve(occurrence.definition, occurrence.value);
      if (resolution.status === "missing" && occurrence.definition.allowMissing) {
        impacts.push({
          kind: "outboundPreserved",
          occurrence: lifecycleOccurrence(source.selector, occurrence),
        });
        continue;
      }
      if (resolution.status !== "resolved" || resolution.candidates.length !== 1
        || resolution.candidates[0]?.location === undefined) {
        classificationBlocked = true;
        blockers.push({
          code: "reference.unresolvedInternal",
          path: occurrence.path,
          message: `Copy cannot classify ${resolution.status} reference '${occurrence.path}'.`,
          occurrence: lifecycleOccurrence(source.selector, occurrence),
        });
        continue;
      }
      const targetIdentity = byLocation.get(referenceLocationKey(resolution.candidates[0].location));
      if (targetIdentity === undefined) {
        impacts.push({
          kind: "outboundPreserved",
          occurrence: lifecycleOccurrence(source.selector, occurrence),
          target: resolution.candidates[0].location,
        });
        continue;
      }
      const remap = remapValidation.remap.find((entry) => entry.identityKey === targetIdentity.identityKey)!;
      internal.set(occurrence.path, remap);
      impacts.push({
        kind: "internalRetarget",
        occurrence: lifecycleOccurrence(source.selector, occurrence),
        targetIdentityKey: targetIdentity.identityKey,
        replacement: remap.to,
      });
    }
    if (classificationBlocked) {
      return emptyPreparation(blockers, source.ownedIdentities, operation.stableIdRemap, impacts);
    }
    const remapped = await this.remapSnapshot(source, operation.stableIdRemap, internal);
    const rendered = await this.documents.renderDocument(source.loaded, remapped);
    const targetSources = rendered.map((entry): PreparedLifecycleSource => ({
      after: entry.after,
      path: targets.pathMap.get(entry.path)!,
      absolutePath: targets.absolutePathMap.get(entry.path)!,
    }));
    return {
      ownedIdentities: source.ownedIdentities,
      stableIdRemap: operation.stableIdRemap,
      impacts,
      blockers,
      mutations: targetSources.map(createHostMutation),
    };
  }

  private async prepareMove(
    project: ProjectContext,
    operation: Extract<DocumentLifecycleOperation, { readonly kind: "move" }>,
    references: Awaited<ReturnType<VisualBridgeReferenceService["createProjectService"]>>,
  ) {
    const source = await this.loadSnapshot(project, operation.source, references);
    const targets = await this.resolveMappedTargets(project, operation.source, operation.target, source.loaded.sources);
    const impacts = source.ownedIdentities.flatMap((identity): DocumentLifecycleReferenceImpact[] => {
      if (identity.reference?.location === undefined) return [];
      const targetPath = targets.pathMap.get(identity.reference.location.path);
      return targetPath === undefined ? [] : [{
        kind: "targetLocationChanged",
        identityKey: identity.identityKey,
        from: identity.reference.location,
        to: { ...identity.reference.location, path: targetPath },
      }];
    });
    const mutations: HostMutation[] = source.loaded.sources.map((entry) => {
      const targetPath = targets.pathMap.get(entry.path)!;
      return {
        path: entry.path,
        absolutePath: entry.absolutePath,
        before: Buffer.from(entry.bytes),
        core: {
          kind: "move",
          sourcePath: entry.path,
          targetPath,
          baseHash: hashBytes(entry.bytes),
          targetMustBeAbsent: true,
        },
      };
    });
    mutations.push(...source.loaded.sources.map((entry): HostMutation => ({
      path: targets.pathMap.get(entry.path)!,
      absolutePath: targets.absolutePathMap.get(entry.path)!,
      after: Buffer.from(entry.bytes),
    })));
    return {
      ownedIdentities: source.ownedIdentities,
      stableIdRemap: [],
      impacts,
      blockers: targets.blockers,
      mutations,
    };
  }

  private async prepareDelete(
    project: ProjectContext,
    operation: Extract<DocumentLifecycleOperation, { readonly kind: "delete" }>,
    indexed: readonly IndexedDocument[],
    references: Awaited<ReturnType<VisualBridgeReferenceService["createProjectService"]>>,
  ) {
    const source = await this.loadSnapshot(project, operation.source, references);
    const deletion = this.prepareDeleteClosure(source, operation.target);
    const closureLocations = new Map(deletion.ownedIdentities.flatMap((identity) => (
      identity.reference?.location === undefined
        ? []
        : [[referenceLocationKey(identity.reference.location), identity] as const]
    )));
    const blockers: DocumentLifecycleBlocker[] = [];
    const impacts: DocumentLifecycleReferenceImpact[] = [];
    for (const document of indexed) {
      for (const reference of document.references) {
        for (const candidate of reference.resolution.candidates) {
          if (candidate.location === undefined) continue;
          const targetIdentity = closureLocations.get(referenceLocationKey(candidate.location));
          if (targetIdentity === undefined) continue;
          const internal = document.documentTypeId === source.selector.documentTypeId
            && document.sourcePaths.some((sourcePath) => source.loaded.sources.some((entry) => entry.path === sourcePath))
            && deletion.internalOccurrencePaths.has(reference.occurrence.path);
          if (internal) continue;
          const occurrence = lifecycleOccurrence({
            projectId: document.projectId,
            documentTypeId: document.documentTypeId,
            editor: document.editor,
            path: document.path,
          }, reference.occurrence);
          impacts.push({ kind: "externalInbound", occurrence, targetIdentityKey: targetIdentity.identityKey });
          blockers.push({
            code: "reference.inbound",
            identityKey: targetIdentity.identityKey,
            occurrence,
            message: `Delete target is referenced by '${document.path}: ${reference.occurrence.path}'.`,
          });
        }
      }
    }
    let mutations: HostMutation[];
    if (operation.target.kind === "document") {
      mutations = source.loaded.sources.map((entry) => ({
        path: entry.path,
        absolutePath: entry.absolutePath,
        before: Buffer.from(entry.bytes),
        core: { kind: "delete", path: entry.path, baseHash: hashBytes(entry.bytes) },
      }));
    } else {
      if (deletion.nextDocument === undefined) {
        throw new VisualBridgeMcpError("lifecycle.invalidDeleteTarget", "Delete target did not produce a document change.");
      }
      const rendered = await this.documents.renderDocument(source.loaded, deletion.nextDocument);
      mutations = rendered.map(replaceHostMutation);
    }
    return {
      ownedIdentities: deletion.ownedIdentities,
      stableIdRemap: [],
      impacts,
      blockers,
      mutations,
    };
  }

  private prepareDeleteClosure(source: LifecycleSnapshot, target: DocumentLifecycleDeleteTarget): DeletePreparation {
    if (target.kind === "document") {
      return {
        ownedIdentities: source.ownedIdentities,
        internalOccurrencePaths: new Set(source.occurrences.map((occurrence) => occurrence.path)),
      };
    }
    const facet = source.loaded.module.facet;
    const result = facet.deleteOwnedTarget!(source.loaded.document, target, source.loaded.context);
    if (!result.success) {
      throw new VisualBridgeMcpError(
        "lifecycle.invalidDeleteTarget",
        `Delete target '${target.kind}' cannot be applied to '${source.selector.path}'.`,
        result.diagnostics,
      );
    }
    const remainingKeys = new Set(
      facet.collectOwnedIdentities(result.document, source.loaded.context).map((identity) => identity.identityKey),
    );
    const remainingOccurrencePaths = new Set(
      facet.collectReferences(result.document, source.loaded.context).map((occurrence) => occurrence.path),
    );
    return {
      ownedIdentities: source.ownedIdentities.filter((identity) => !remainingKeys.has(identity.identityKey)),
      // 删除自身会一并移除的同文档引用：不能在 inbound 扫描里被当成"外部引用"。
      internalOccurrencePaths: new Set(source.occurrences
        .filter((occurrence) => !remainingOccurrencePaths.has(occurrence.path))
        .map((occurrence) => occurrence.path)),
      nextDocument: result.document,
    };
  }

  private async loadSnapshot(
    project: ProjectContext,
    selector: DocumentLifecycleSelector,
    references: Awaited<ReturnType<VisualBridgeReferenceService["createProjectService"]>>,
  ): Promise<LifecycleSnapshot> {
    const loaded = await this.documents.loadDocument({
      path: selector.path,
      editor: selector.editor,
      projectFile: project.projectFile,
      documentTypeId: selector.documentTypeId,
      includeProviderValidation: false,
      skipReferenceValidation: true,
    });
    if (loaded.path !== selector.path
      || loaded.documentType.id !== selector.documentTypeId
      || loaded.documentType.editor !== selector.editor) {
      throw new VisualBridgeMcpError("lifecycle.selectorMismatch", "Lifecycle selector no longer matches Project Registry declaration.");
    }
    if (!loaded.parsed.success || loaded.document === undefined) {
      throw invalidSource(selector.path, loaded.parsed.diagnostics);
    }
    assertNoErrors(loaded.documentType.editor, loaded.structuralDiagnostics);
    const facet = loaded.module.facet;
    const raw = facet.collectOwnedIdentities(loaded.document, loaded.context);
    const addressable = facet.collectAddressableIdentityKeys?.(loaded.document, loaded.context);
    return {
      selector,
      loaded,
      occurrences: loaded.occurrences,
      ownedIdentities: await hydrateOwnedIdentities(raw, references, addressable),
    };
  }

  private async remapSnapshot(
    source: LifecycleSnapshot,
    remap: readonly StableIdentityRemap[],
    internal: ReadonlyMap<string, StableIdentityRemap>,
  ): Promise<unknown> {
    const facet = source.loaded.module.facet;
    const result = facet.remapOwnedIdentities(source.loaded.document, source.loaded.context, remap);
    if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
    let document = result.document;
    for (const [occurrencePath, entry] of internal) {
      const replaced = facet.replaceReferenceValues(document, source.loaded.context, new Set([occurrencePath]), entry.to);
      if (!replaced.success) throw invalidSource(source.selector.path, replaced.diagnostics);
      document = replaced.document;
    }
    return document;
  }

  private async buildIdentityCollisionIndex(
    project: ProjectContext,
    indexed: readonly IndexedDocument[],
    references: Awaited<ReturnType<VisualBridgeReferenceService["createProjectService"]>>,
  ): Promise<OwnedStableIdentityCollisionIndex> {
    const documents = [];
    for (const document of indexed) {
      const selector: DocumentLifecycleSelector = {
        projectId: document.projectId,
        documentTypeId: document.documentTypeId,
        editor: document.editor,
        path: document.path,
      };
      const snapshot = await this.loadSnapshot(project, selector, references);
      documents.push({ document: selector, ownedIdentities: snapshot.ownedIdentities });
    }
    return buildOwnedStableIdentityCollisionIndex(documents);
  }

  private async resolveTarget(project: ProjectContext, selector: DocumentLifecycleSelector): Promise<{
    readonly context: DeclaredDocumentContext;
    readonly blocker?: DocumentLifecycleBlocker;
  }> {
    const context = await this.workspace.resolveDeclaredDocument(
      selector.path,
      selector.editor,
      project.projectFile,
      selector.documentTypeId,
    );
    assertSelectorMatches(selector, context);
    try {
      const absolutePath = await resolveAbsentProjectPath(project, context.path);
      return { context: { ...context, absolutePath } };
    } catch (errorValue) {
      if (errorValue instanceof VisualBridgeMcpError && errorValue.code === "target.exists") {
        return {
          context,
          blocker: { code: "target.exists", path: context.path, message: errorValue.message },
        };
      }
      throw errorValue;
    }
  }

  private async resolveMappedTargets(
    project: ProjectContext,
    sourceSelector: DocumentLifecycleSelector,
    targetSelector: DocumentLifecycleSelector,
    sources: readonly LoadedSourceFile[],
  ): Promise<{
    readonly pathMap: ReadonlyMap<string, string>;
    readonly absolutePathMap: ReadonlyMap<string, string>;
    readonly blockers: readonly DocumentLifecycleBlocker[];
  }> {
    const isFamily = sources.length > 1;
    if (isFamily && path.posix.basename(sourceSelector.path) !== path.posix.basename(targetSelector.path)) {
      throw new VisualBridgeMcpError(
        "lifecycle.csvFamilyRenameUnsupported",
        "CSV family copy/move V1 only changes directory and preserves every carrier basename.",
      );
    }
    const targetDirectory = path.posix.dirname(targetSelector.path);
    const pathMap = new Map<string, string>();
    const absolutePathMap = new Map<string, string>();
    const blockers: DocumentLifecycleBlocker[] = [];
    for (const source of [...sources].sort((left, right) => compareUtf16CodeUnits(left.path, right.path))) {
      const targetPath = isFamily
        ? targetDirectory === "."
          ? path.posix.basename(source.path)
          : `${targetDirectory}/${path.posix.basename(source.path)}`
        : targetSelector.path;
      const selector = { ...targetSelector, path: targetPath };
      const resolved = await this.resolveTarget(project, selector);
      pathMap.set(source.path, targetPath);
      absolutePathMap.set(source.path, resolved.context.absolutePath);
      if (resolved.blocker !== undefined) blockers.push(resolved.blocker);
    }
    return { pathMap, absolutePathMap, blockers };
  }
}

interface PreparedLifecycleSource {
  readonly path: string;
  readonly absolutePath: string;
  readonly before?: Buffer;
  readonly after: Buffer;
}

async function hydrateOwnedIdentities(
  raw: readonly OwnedStableIdentity[],
  references: Awaited<ReturnType<VisualBridgeReferenceService["createProjectService"]>>,
  addressableIdentityKeys?: ReadonlySet<string>,
): Promise<readonly PlannedOwnedStableIdentity[]> {
  return Promise.all(raw.map(async (identity) => {
    if (identity.reference === undefined) {
      const { reference: _reference, ...withoutReference } = identity;
      return withoutReference;
    }
    const definition = identity.reference.definition;
    if (addressableIdentityKeys !== undefined && !addressableIdentityKeys.has(identity.identityKey)) {
      return { ...identity, reference: { definition } };
    }
    const resolution = await references.resolve(definition, identity.value);
    if (resolution.status !== "resolved" || resolution.candidates.length !== 1
      || resolution.candidates[0]?.location === undefined) {
      throw new VisualBridgeMcpError(
        "lifecycle.invalidSource",
        `Owned identity '${identity.identityKey}' does not resolve uniquely.`,
        resolution,
      );
    }
    return { ...identity, reference: { definition, location: resolution.candidates[0].location } };
  }));
}

async function buildDependencies(
  project: ProjectContext,
  indexed: readonly IndexedDocument[],
): Promise<readonly DocumentLifecycleDependency[]> {
  const projectPath = path.relative(project.projectRoot, project.absoluteProjectFile).replaceAll("\\", "/");
  const projectHash = hashBytes(await readFileAbsolute(project.absoluteProjectFile));
  const catalogPaths = [...new Set(project.definition.documentTypes.flatMap((documentType) => documentType.catalogs))].sort(compareUtf16CodeUnits);
  const catalogManifest = await Promise.all(catalogPaths.map(async (catalogPath) => ({
    path: catalogPath,
    hash: hashBytes(await readFileAbsolute(await resolveExistingProjectPath(project, catalogPath))),
  })));
  const documentPaths = [...new Set(indexed.flatMap((document) => document.sourcePaths))].sort(compareUtf16CodeUnits);
  const documentManifest = await Promise.all(documentPaths.map(async (documentPath) => ({
    path: documentPath,
    hash: hashBytes(await readFileAbsolute(await resolveExistingProjectPath(project, documentPath))),
  })));
  return buildCanonicalDocumentLifecycleDependencies({
    projectId: project.definition.projectId,
    project: { path: projectPath, hash: projectHash },
    catalogs: catalogManifest,
    documents: documentManifest,
    index: indexed,
  }, hashStable);
}

async function buildSourceBaseHashes(
  project: ProjectContext,
  indexed: readonly IndexedDocument[],
  operation: DocumentLifecycleOperation,
): Promise<Readonly<Record<string, string>>> {
  if (operation.kind === "create") return {};
  const source = indexed.find((document) => (
    document.projectId === operation.source.projectId
    && document.documentTypeId === operation.source.documentTypeId
    && document.editor === operation.source.editor
    && (document.path === operation.source.path || document.sourcePaths.includes(operation.source.path))
  ));
  if (source === undefined) {
    throw new VisualBridgeMcpError(
      "lifecycle.invalidSource",
      `Lifecycle source '${operation.source.path}' is absent from the Project document index.`,
    );
  }
  const hashes = await Promise.all([...new Set(source.sourcePaths)].sort(compareUtf16CodeUnits).map(async (sourcePath) => [
    sourcePath,
    hashBytes(await readFileAbsolute(await resolveExistingProjectPath(project, sourcePath))),
  ] as const));
  return Object.fromEntries(hashes);
}

async function buildDependencyPreconditions(
  project: ProjectContext,
  dependencies: readonly DocumentLifecycleDependency[],
): Promise<readonly ProjectTransactionPrecondition[]> {
  const projectPath = path.relative(project.projectRoot, project.absoluteProjectFile).replaceAll("\\", "/");
  const paths = [...new Set(dependencies.flatMap((dependency) => dependency.paths))].sort(compareUtf16CodeUnits);
  return Promise.all(paths.map(async (sourcePath) => {
    const absolutePath = sourcePath === projectPath
      ? project.absoluteProjectFile
      : await resolveExistingProjectPath(project, sourcePath);
    return { path: sourcePath, absolutePath, hash: hashBytes(await readFileAbsolute(absolutePath)) };
  }));
}

function validateOperationProject(operation: DocumentLifecycleOperation, project: ProjectContext): void {
  const selectors = operation.kind === "create"
    ? [operation.target]
    : operation.kind === "delete"
      ? [operation.source]
      : [operation.source, operation.target];
  for (const selector of selectors) {
    if (selector.projectId !== project.definition.projectId) {
      throw new VisualBridgeMcpError("lifecycle.projectMismatch", "Lifecycle selector projectId does not match projectFile.");
    }
  }
  if (selectors.length === 2 && (
    selectors[0]!.documentTypeId !== selectors[1]!.documentTypeId
    || selectors[0]!.editor !== selectors[1]!.editor
  )) {
    throw new VisualBridgeMcpError("lifecycle.typeMismatch", "Lifecycle V1 requires the same Document Type and editor.");
  }
}

function assertSelectorMatches(selector: DocumentLifecycleSelector, context: DeclaredDocumentContext): void {
  if (context.project.definition.projectId !== selector.projectId
    || context.documentType.id !== selector.documentTypeId
    || context.documentType.editor !== selector.editor
    || context.path !== selector.path) {
    throw new VisualBridgeMcpError("lifecycle.selectorMismatch", "Lifecycle selector no longer matches Project Registry declaration.");
  }
}

function createHostMutation(source: PreparedLifecycleSource): HostMutation {
  return {
    path: source.path,
    absolutePath: source.absolutePath,
    ...(source.before === undefined ? {} : { before: source.before }),
    after: source.after,
    core: source.before === undefined
      ? { kind: "create", path: source.path, nextHash: hashBytes(source.after), targetMustBeAbsent: true }
      : { kind: "replace", path: source.path, baseHash: hashBytes(source.before), nextHash: hashBytes(source.after) },
  };
}

function replaceHostMutation(source: RenderedSource): HostMutation {
  return createHostMutation({
    path: source.path,
    absolutePath: source.absolutePath,
    before: source.before,
    after: source.after,
  });
}

function emptyPreparation(
  blockers: readonly DocumentLifecycleBlocker[],
  ownedIdentities: readonly OwnedStableIdentity[] = [],
  stableIdRemap: readonly StableIdentityRemap[] = [],
  impacts: readonly DocumentLifecycleReferenceImpact[] = [],
) {
  return { ownedIdentities, stableIdRemap, impacts, blockers, mutations: [] as readonly HostMutation[] };
}

function lifecycleOccurrence(
  selector: DocumentLifecycleSelector,
  occurrence: ReferenceOccurrence,
): DocumentLifecycleReferenceOccurrence {
  return { document: selector, path: occurrence.path, definition: occurrence.definition, value: occurrence.value };
}

function previewResult(prepared: PreparedLifecycle): Record<string, unknown> {
  return {
    status: "preview",
    projectFile: prepared.project.projectFile,
    previewHash: prepared.preview.previewHash,
    planPayload: prepared.preview.planPayload,
    plan: prepared.preview.plan,
    baseHashes: prepared.preview.plan.baseHashes,
    dependencies: prepared.preview.plan.dependencies,
  };
}

function assertNoErrors(subject: string, diagnostics: readonly { readonly severity: string }[]): void {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new VisualBridgeMcpError("lifecycle.invalidSource", `${subject} semantic validation failed.`, diagnostics);
  }
}

function invalidSource(sourcePath: string, diagnostics: readonly unknown[]): VisualBridgeMcpError {
  return new VisualBridgeMcpError(
    "lifecycle.invalidSource",
    `Source '${sourcePath}' is invalid and cannot participate in Document Lifecycle.`,
    diagnostics,
  );
}

/** MCP 的 create 参数由 facet 校验；这里只在 CreateFacet 需要时提供稳定 ID 生成器。 */
function defaultStableId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function isPreviewInvalidation(code: string): boolean {
  return code.startsWith("document.")
    || code.startsWith("path.")
    || code.startsWith("project.")
    || code.startsWith("lifecycle.")
    || code.startsWith("catalog.")
    || code === "file.invalidUtf8";
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

async function readFileAbsolute(absolutePath: string): Promise<Buffer> {
  return readFile(absolutePath);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}
