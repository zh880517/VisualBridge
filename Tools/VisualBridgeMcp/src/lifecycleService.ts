import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DocumentLifecycleService as CoreDocumentLifecycleService,
  buildCanonicalDocumentLifecycleDependencies,
  buildOwnedStableIdentityCollisionIndex,
  compareUtf16CodeUnits,
  prepareDocumentLifecycleApply,
  referenceLocationKey,
  referenceValuesEqual,
  remapOwnedStableIdentityCollisionTargets,
  validateCompleteStableIdentityRemap,
  validateOwnedStableIdentityTargetCollisions,
  type DocumentLifecycleApplyRequest,
  type DocumentLifecycleBlocker,
  type DocumentLifecycleDependency,
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
import {
  collectEntityReferences,
  createEmptyEntityDocument,
  parseEntityDocument,
  replaceEntityReferenceValues,
  serializeEntityDocument,
  validateEntityDocument,
  type EntityCatalogRegistry,
  type EntityDocument,
  entityDocumentAdapter,
} from "@visualbridge/entity";
import {
  collectGraphReferences,
  createEmptyGraphDocument,
  parseGraphDocument,
  replaceGraphReferenceValues,
  serializeGraphDocument,
  validateGraphDocument,
  type GraphCatalogRegistry,
  type GraphDocument,
  graphDocumentAdapter,
} from "@visualbridge/graph";
import {
  collectStructuredReferences,
  createEmptyStructuredDocument,
  parseStructuredDocument,
  replaceStructuredReferenceValues,
  serializeStructuredDocument,
  validateStructuredDocument,
  type StructuredCatalogRegistry,
  type StructuredDocument,
  structuredDocumentAdapter,
} from "@visualbridge/structured";
import {
  collectAddressableTableIdentityKeys,
  collectTableReferences,
  replaceTableReferenceValues,
  resolveEffectiveTableRows,
  resolveTableColumn,
  resolveTableSheet,
  tableDedupIdentityKey,
  tableRowIdentityKey,
  type TableDocument,
  type TableTypeDefinition,
  tableDocumentAdapter,
} from "@visualbridge/table";
import { hashBytes } from "./atomicTextFile.js";
import { loadMcpEntityRegistry } from "./entityRegistry.js";
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
import {
  loadMcpGraphRegistry,
  loadMcpStructuredRegistry,
  type VisualBridgeReferenceService,
} from "./referenceService.js";
import {
  type LoadedTable,
  type PreparedTableLifecycleSource,
  type TableService,
} from "./tableService.js";

export type DocumentLifecycleHostRequest = DocumentLifecycleRequest & {
  readonly projectFile?: string;
};

type TextSnapshot = GraphSnapshot | EntitySnapshot | StructuredSnapshot;

interface SnapshotBase {
  readonly selector: DocumentLifecycleSelector;
  readonly context: DeclaredDocumentContext;
  readonly sourcePaths: readonly SourceBytes[];
  readonly occurrences: readonly ReferenceOccurrence[];
  readonly ownedIdentities: readonly PlannedOwnedStableIdentity[];
}

type PlannedOwnedStableIdentity = Omit<OwnedStableIdentity, "reference"> & {
  readonly reference?: {
    readonly definition: ReferenceDefinition;
    readonly location?: ReferenceLocation;
  };
};

interface GraphSnapshot extends SnapshotBase {
  readonly editor: "graph";
  readonly document: GraphDocument;
  readonly registry: GraphCatalogRegistry;
}

interface EntitySnapshot extends SnapshotBase {
  readonly editor: "entity";
  readonly document: EntityDocument;
  readonly registry: EntityCatalogRegistry;
}

interface StructuredSnapshot extends SnapshotBase {
  readonly editor: "structured";
  readonly document: StructuredDocument;
  readonly registry: StructuredCatalogRegistry;
}

interface TableSnapshot extends SnapshotBase {
  readonly editor: "table";
  readonly document: TableDocument;
  readonly tableType: TableTypeDefinition;
  readonly loaded: LoadedTable;
}

type LifecycleSnapshot = TextSnapshot | TableSnapshot;

interface SourceBytes {
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
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
  readonly nextDocument?: GraphDocument | EntityDocument | TableDocument;
}

export class DocumentLifecycleService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
    private readonly tables: TableService,
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
        const readiness = prepareDocumentLifecycleApply(request, prepared.preview);
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
    const indexed = await this.references.buildProjectIndex(project.projectFile);
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
    let sources: readonly PreparedTableLifecycleSource[];
    let owned: readonly OwnedStableIdentity[] = [];
    if (context.documentType.editor === "graph") {
      assertParameterKeys(operation.parameters, ["documentId", "rootGraphId", "graphTypeId", "initialNodeIds"]);
      const registry = await loadMcpGraphRegistry(project, context);
      const documentId = requiredIdentifier(operation.parameters.documentId, "parameters.documentId");
      const rootGraphId = requiredIdentifier(operation.parameters.rootGraphId, "parameters.rootGraphId");
      const graphTypeId = optionalIdentifier(operation.parameters.graphTypeId, "parameters.graphTypeId");
      const initialNodeIds = identifierArray(operation.parameters.initialNodeIds, "parameters.initialNodeIds");
      let nodeIndex = 0;
      const document = createEmptyGraphDocument(
        documentId,
        rootGraphId,
        graphTypeId,
        registry,
        () => {
          const id = initialNodeIds[nodeIndex];
          if (id === undefined) throw new VisualBridgeMcpError("lifecycle.invalidCreate", "Graph create requires an ID for every initial node.");
          nodeIndex += 1;
          return id;
        },
      );
      if (nodeIndex !== initialNodeIds.length) {
        throw new VisualBridgeMcpError("lifecycle.invalidCreate", "Graph create supplied unused initial node IDs.");
      }
      assertNoErrors("Graph", validateGraphDocument(document, registry));
      owned = graphDocumentAdapter.lifecycle!.collectOwnedIdentities(document, context.documentType.id, { registry });
      sources = [createdTextSource(context, serializeGraphDocument(document))];
    } else if (context.documentType.editor === "entity") {
      assertParameterKeys(operation.parameters, ["documentId", "entityTypeId", "title"]);
      const registry = await loadMcpEntityRegistry(project, context.documentType);
      const document = createEmptyEntityDocument(
        requiredIdentifier(operation.parameters.documentId, "parameters.documentId"),
        requiredIdentifier(operation.parameters.entityTypeId, "parameters.entityTypeId"),
        registry,
        optionalString(operation.parameters.title, "parameters.title") ?? "New Entity",
      );
      assertNoErrors("Entity", validateEntityDocument(document, registry));
      owned = entityDocumentAdapter.lifecycle!.collectOwnedIdentities(document, context.documentType.id, { registry });
      sources = [createdTextSource(context, serializeEntityDocument(document))];
    } else if (context.documentType.editor === "structured") {
      assertParameterKeys(operation.parameters, ["documentId"]);
      const registry = await loadMcpStructuredRegistry(project, context);
      const document = createEmptyStructuredDocument(
        requiredIdentifier(operation.parameters.documentId, "parameters.documentId"),
        context.documentType.id,
        registry,
      );
      assertNoErrors("Structured", validateStructuredDocument(document, registry, context.documentType.id));
      owned = structuredDocumentAdapter.lifecycle!.collectOwnedIdentities(document, context.documentType.id, {
        registry,
        configTypeId: context.documentType.id,
      });
      sources = [createdTextSource(context, serializeStructuredDocument(document))];
    } else if (context.documentType.editor === "table") {
      assertParameterKeys(operation.parameters, ["format", "physicalName"]);
      const format = requiredTableFormat(operation.parameters.format, "parameters.format");
      const physicalName = optionalString(operation.parameters.physicalName, "parameters.physicalName");
      sources = await this.tables.createLifecycleDocument(context, {
        format,
        ...(physicalName === undefined ? {} : { physicalName }),
      });
    } else {
      throw unsupportedEditor(context.documentType.editor);
    }
    const blockers: DocumentLifecycleBlocker[] = target.blocker === undefined ? [] : [target.blocker];
    blockers.push(...validateOwnedStableIdentityTargetCollisions(identityCollisions, owned));
    return {
      ownedIdentities: owned,
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
    const targets = await this.resolveMappedTargets(project, operation.source, operation.target, source.sourcePaths);
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
    const remapped = await remapSnapshot(source, operation.stableIdRemap, internal);
    const rendered = await this.renderSnapshot(source, remapped.document);
    const targetSources = rendered.map((entry): PreparedTableLifecycleSource => ({
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
    const targets = await this.resolveMappedTargets(project, operation.source, operation.target, source.sourcePaths);
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
    const mutations: HostMutation[] = source.sourcePaths.map((entry) => {
      const targetPath = targets.pathMap.get(entry.path)!;
      const targetAbsolutePath = targets.absolutePathMap.get(entry.path)!;
      return {
        path: entry.path,
        absolutePath: entry.absolutePath,
        before: entry.bytes,
        core: {
          kind: "move",
          sourcePath: entry.path,
          targetPath,
          baseHash: hashBytes(entry.bytes),
          targetMustBeAbsent: true,
        },
      };
    });
    mutations.push(...source.sourcePaths.map((entry): HostMutation => ({
      path: targets.pathMap.get(entry.path)!,
      absolutePath: targets.absolutePathMap.get(entry.path)!,
      after: entry.bytes,
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
    const deletion = prepareDeleteClosure(source, operation.target);
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
            && document.sourcePaths.some((sourcePath) => source.sourcePaths.some((entry) => entry.path === sourcePath))
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
      mutations = source.sourcePaths.map((entry) => ({
        path: entry.path,
        absolutePath: entry.absolutePath,
        before: entry.bytes,
        core: { kind: "delete", path: entry.path, baseHash: hashBytes(entry.bytes) },
      }));
    } else {
      if (deletion.nextDocument === undefined) {
        throw new VisualBridgeMcpError("lifecycle.invalidDeleteTarget", "Delete target did not produce a document change.");
      }
      mutations = (await this.renderSnapshot(source, deletion.nextDocument)).map(replaceHostMutation);
    }
    return {
      ownedIdentities: deletion.ownedIdentities,
      stableIdRemap: [],
      impacts,
      blockers,
      mutations,
    };
  }

  private async loadSnapshot(
    project: ProjectContext,
    selector: DocumentLifecycleSelector,
    references: Awaited<ReturnType<VisualBridgeReferenceService["createProjectService"]>>,
  ): Promise<LifecycleSnapshot> {
    const context = await this.workspace.resolveDocument(
      selector.path,
      selector.editor,
      project.projectFile,
      selector.documentTypeId,
    );
    assertSelectorMatches(selector, context);
    if (selector.editor === "table") {
      const loaded = await this.tables.loadLifecycleDocument(selector.path, project.projectFile, selector.documentTypeId);
      assertNoErrors("Table", loaded.diagnostics);
      const raw = tableDocumentAdapter.lifecycle!.collectOwnedIdentities(
        loaded.document,
        selector.documentTypeId,
        { tableType: loaded.catalog.tableType },
      );
      const addressableIdentityKeys = collectAddressableTableIdentityKeys(
        loaded.document,
        loaded.catalog.tableType,
      );
      return {
        editor: "table",
        selector,
        context,
        sourcePaths: loaded.sources.map((source) => ({
          path: source.path,
          absolutePath: source.absolutePath,
          bytes: source.bytes,
        })),
        document: loaded.document,
        tableType: loaded.catalog.tableType,
        loaded,
        occurrences: collectTableReferences(loaded.document, loaded.catalog.tableType),
        ownedIdentities: await hydrateOwnedIdentities(raw, references, addressableIdentityKeys),
      };
    }
    const bytes = await readFile(context.absolutePath);
    const text = decodeUtf8(bytes, context.path);
    if (selector.editor === "graph") {
      const registry = await loadMcpGraphRegistry(project, context);
      const parsed = parseGraphDocument(text);
      if (!parsed.success) throw invalidSource(context.path, parsed.diagnostics);
      assertNoErrors("Graph", validateGraphDocument(parsed.document, registry));
      return {
        editor: "graph",
        selector,
        context,
        sourcePaths: [{ path: context.path, absolutePath: context.absolutePath, bytes }],
        document: parsed.document,
        registry,
        occurrences: collectGraphReferences(parsed.document, registry),
        ownedIdentities: await hydrateOwnedIdentities(
          graphDocumentAdapter.lifecycle!.collectOwnedIdentities(
            parsed.document,
            selector.documentTypeId,
            { registry },
          ),
          references,
        ),
      };
    }
    if (selector.editor === "entity") {
      const registry = await loadMcpEntityRegistry(project, context.documentType);
      const parsed = parseEntityDocument(text);
      if (!parsed.success) throw invalidSource(context.path, parsed.diagnostics);
      assertNoErrors("Entity", validateEntityDocument(parsed.document, registry));
      return {
        editor: "entity",
        selector,
        context,
        sourcePaths: [{ path: context.path, absolutePath: context.absolutePath, bytes }],
        document: parsed.document,
        registry,
        occurrences: collectEntityReferences(parsed.document, registry),
        ownedIdentities: await hydrateOwnedIdentities(
          entityDocumentAdapter.lifecycle!.collectOwnedIdentities(
            parsed.document,
            selector.documentTypeId,
            { registry },
          ),
          references,
        ),
      };
    }
    if (selector.editor === "structured") {
      const registry = await loadMcpStructuredRegistry(project, context);
      const parsed = parseStructuredDocument(text);
      if (!parsed.success) throw invalidSource(context.path, parsed.diagnostics);
      assertNoErrors("Structured", validateStructuredDocument(parsed.document, registry, selector.documentTypeId));
      return {
        editor: "structured",
        selector,
        context,
        sourcePaths: [{ path: context.path, absolutePath: context.absolutePath, bytes }],
        document: parsed.document,
        registry,
        occurrences: collectStructuredReferences(parsed.document, registry, selector.documentTypeId),
        ownedIdentities: await hydrateOwnedIdentities(
          structuredDocumentAdapter.lifecycle!.collectOwnedIdentities(
            parsed.document,
            selector.documentTypeId,
            { registry, configTypeId: selector.documentTypeId },
          ),
          references,
        ),
      };
    }
    throw unsupportedEditor(selector.editor);
  }

  private async renderSnapshot(
    source: LifecycleSnapshot,
    document: GraphDocument | EntityDocument | StructuredDocument | TableDocument,
  ): Promise<readonly PreparedTableLifecycleSource[]> {
    switch (source.editor) {
      case "graph":
        return [{
          path: source.context.path,
          absolutePath: source.context.absolutePath,
          before: source.sourcePaths[0]!.bytes,
          after: Buffer.from(serializeGraphDocument(document as GraphDocument), "utf8"),
        }];
      case "entity":
        return [{
          path: source.context.path,
          absolutePath: source.context.absolutePath,
          before: source.sourcePaths[0]!.bytes,
          after: Buffer.from(serializeEntityDocument(document as EntityDocument), "utf8"),
        }];
      case "structured":
        return [{
          path: source.context.path,
          absolutePath: source.context.absolutePath,
          before: source.sourcePaths[0]!.bytes,
          after: Buffer.from(serializeStructuredDocument(document as StructuredDocument), "utf8"),
        }];
      case "table":
        return this.tables.renderLifecycleDocument(source.loaded, document as TableDocument);
    }
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
    sources: readonly SourceBytes[],
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
    for (const source of sources) {
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

async function remapSnapshot(
  source: LifecycleSnapshot,
  remap: readonly StableIdentityRemap[],
  internal: ReadonlyMap<string, StableIdentityRemap>,
): Promise<{ readonly document: GraphDocument | EntityDocument | StructuredDocument | TableDocument }> {
  let document: GraphDocument | EntityDocument | StructuredDocument | TableDocument;
  if (source.editor === "graph") {
    const result = graphDocumentAdapter.lifecycle!.remapOwnedIdentities(
      source.document,
      source.selector.documentTypeId,
      remap,
      { registry: source.registry },
    );
    if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
    document = result.document;
    for (const [occurrencePath, entry] of internal) {
      const replaced = replaceGraphReferenceValues(document, source.registry, new Set([occurrencePath]), entry.to);
      if (!replaced.success) throw invalidSource(source.selector.path, replaced.diagnostics);
      document = replaced.document;
    }
  } else if (source.editor === "entity") {
    const result = entityDocumentAdapter.lifecycle!.remapOwnedIdentities(
      source.document,
      source.selector.documentTypeId,
      remap,
      { registry: source.registry },
    );
    if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
    let entityDocument = result.document;
    for (const [occurrencePath, entry] of internal) {
      const replaced = replaceEntityReferenceValues(entityDocument, source.registry, new Set([occurrencePath]), entry.to);
      if (!replaced.success) throw invalidSource(source.selector.path, replaced.diagnostics);
      entityDocument = replaced.document;
    }
    document = entityDocument;
  } else if (source.editor === "structured") {
    const result = structuredDocumentAdapter.lifecycle!.remapOwnedIdentities(
      source.document,
      source.selector.documentTypeId,
      remap,
      { registry: source.registry, configTypeId: source.selector.documentTypeId },
    );
    if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
    document = result.document;
    for (const [occurrencePath, entry] of internal) {
      const replaced = replaceStructuredReferenceValues(
        document,
        source.registry,
        source.selector.documentTypeId,
        new Set([occurrencePath]),
        entry.to,
      );
      if (!replaced.success) throw invalidSource(source.selector.path, replaced.diagnostics);
      document = replaced.document;
    }
  } else {
    const result = tableDocumentAdapter.lifecycle!.remapOwnedIdentities(
      source.document,
      source.selector.documentTypeId,
      remap,
      { tableType: source.tableType },
    );
    if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
    document = result.document;
    for (const [occurrencePath, entry] of internal) {
      const replaced = replaceTableReferenceValues(document, source.tableType, new Set([occurrencePath]), entry.to);
      if (!replaced.success) throw invalidSource(source.selector.path, replaced.diagnostics);
      document = replaced.document;
    }
  }
  return { document };
}

function prepareDeleteClosure(
  source: LifecycleSnapshot,
  target: Extract<DocumentLifecycleOperation, { readonly kind: "delete" }>["target"],
): DeletePreparation {
  if (target.kind === "document") {
    return {
      ownedIdentities: source.ownedIdentities,
      internalOccurrencePaths: new Set(source.occurrences.map((occurrence) => occurrence.path)),
    };
  }
  if (target.kind === "entity.component") {
    if (source.editor !== "entity") throw incompatibleDeleteTarget(target.kind, source.editor);
    const componentIndex = source.document.components.findIndex((component) => component.id === target.componentId);
    if (componentIndex < 0) throw missingDeleteTarget(target.componentId);
    const result = entityDocumentAdapter.lifecycle!.deleteOwnedTarget(
      source.document,
      target,
      { registry: source.registry },
    );
    if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
    return {
      ownedIdentities: source.ownedIdentities.filter((identity) => identity.identityKey === `component:${target.componentId}`),
      internalOccurrencePaths: new Set(source.occurrences
        .filter((occurrence) => occurrence.path.startsWith(`components[${componentIndex}].`))
        .map((occurrence) => occurrence.path)),
      nextDocument: result.document,
    };
  }
  if (target.kind === "table.row") {
    if (source.editor !== "table") throw incompatibleDeleteTarget(target.kind, source.editor);
    const sheet = source.document.sheets.find((candidate) => candidate.id === target.sheetId);
    const row = sheet?.rows.find((candidate) => candidate.id === target.rowId);
    const definition = sheet === undefined ? undefined : resolveTableSheet(source.tableType, sheet.definitionId);
    if (sheet === undefined || row === undefined || definition === undefined) throw missingDeleteTarget(target.rowId);
    const keys = new Set<string>();
    const keyColumn = definition.keyColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.keyColumnId);
    if (keyColumn !== undefined) {
      const value = row.cells[keyColumn.id];
      if (typeof value === "string" || typeof value === "number") keys.add(tableRowIdentityKey(definition.id, value));
    }
    const dedupColumn = definition.partition?.deduplicateByColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.partition.deduplicateByColumnId);
    if (dedupColumn !== undefined && dedupColumn.id !== keyColumn?.id) {
      const value = row.cells[dedupColumn.id];
      if (typeof value === "string" || typeof value === "number") keys.add(tableDedupIdentityKey(definition.id, value));
    }
    const result = tableDocumentAdapter.lifecycle!.deleteOwnedTarget(
      source.document,
      target,
      { tableType: source.tableType },
    );
    if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
    const remainingIdentityKeys = new Set(tableDocumentAdapter.lifecycle!.collectOwnedIdentities(
      result.document,
      source.selector.documentTypeId,
      { tableType: source.tableType },
    ).map((identity) => identity.identityKey));
    const prefix = `sheets.${target.sheetId}.rows.${target.rowId}.`;
    return {
      ownedIdentities: source.ownedIdentities.filter((identity) => (
        keys.has(identity.identityKey) && !remainingIdentityKeys.has(identity.identityKey)
      )),
      internalOccurrencePaths: new Set(source.occurrences
        .filter((occurrence) => occurrence.path.startsWith(prefix))
        .map((occurrence) => occurrence.path)),
      nextDocument: result.document,
    };
  }
  if (source.editor !== "graph") throw incompatibleDeleteTarget(target.kind, source.editor);
  const graphIndex = source.document.graphs.findIndex((graph) => graph.id === target.graphId);
  const graph = source.document.graphs[graphIndex];
  if (graph === undefined) throw missingDeleteTarget(target.graphId);
  let ownerGraphId: string;
  let nodeId: string;
  const closureGraphIds = new Set<string>();
  const closureNodeKeys = new Set<string>();
  const internalPrefixes: string[] = [];
  if (target.elementKind === "graph") {
    if (target.elementId !== target.graphId) throw missingDeleteTarget(target.elementId);
    if (target.graphId === source.document.rootGraphId) {
      throw new VisualBridgeMcpError("lifecycle.rootGraphDeleteForbidden", "The root Graph cannot be deleted as an element.");
    }
    const owner = findGraphOwner(source.document, target.graphId);
    if (owner === undefined) throw missingDeleteTarget(target.graphId);
    ownerGraphId = owner.graphId;
    nodeId = owner.nodeId;
    collectGraphClosure(source.document, target.graphId, closureGraphIds, closureNodeKeys);
    closureNodeKeys.add(`${ownerGraphId}\u0000${nodeId}`);
  } else if (target.elementKind === "node") {
    const node = graph.nodes.find((candidate) => candidate.id === target.elementId);
    if (node === undefined) throw missingDeleteTarget(target.elementId);
    ownerGraphId = graph.id;
    nodeId = node.id;
    closureNodeKeys.add(`${graph.id}\u0000${node.id}`);
    if (node.kind === "subgraph") collectGraphClosure(source.document, node.subgraphId, closureGraphIds, closureNodeKeys);
  } else if (target.elementKind === "interfacePort") {
    if (!graph.interfacePorts.some((port) => port.id === target.elementId)) throw missingDeleteTarget(target.elementId);
  } else if ("nodeId" in target) {
    const node = graph.nodes.find((candidate) => candidate.id === target.nodeId);
    if (node === undefined || !node.dynamicPorts.some((port) => port.id === target.elementId)) throw missingDeleteTarget(target.elementId);
  } else {
    throw new VisualBridgeMcpError("lifecycle.invalidDeleteTarget", "Unknown Graph element delete target.");
  }
  const result = graphDocumentAdapter.lifecycle!.deleteOwnedTarget(
    source.document,
    target,
    { registry: source.registry },
  );
  if (!result.success) throw invalidSource(source.selector.path, result.diagnostics);
  source.document.graphs.forEach((candidate, candidateIndex) => {
    if (closureGraphIds.has(candidate.id)) internalPrefixes.push(`graphs[${candidateIndex}].`);
    candidate.nodes.forEach((node, nodeIndex) => {
      if (closureNodeKeys.has(`${candidate.id}\u0000${node.id}`)) {
        internalPrefixes.push(`graphs[${candidateIndex}].nodes[${nodeIndex}].`);
      }
    });
  });
  if (target.elementKind === "dynamicPort") {
    const nodeIndex = graph.nodes.findIndex((node) => node.id === target.nodeId);
    const portIndex = graph.nodes[nodeIndex]!.dynamicPorts.findIndex((port) => port.id === target.elementId);
    internalPrefixes.push(`graphs[${graphIndex}].nodes[${nodeIndex}].dynamicPorts[${portIndex}].`);
  }
  const ownedKeys = new Set<string>();
  if (target.elementKind === "interfacePort") {
    ownedKeys.add(`interfacePort:${target.graphId}:${target.elementId}`);
    graph.edges.filter((edge) => endpointUsesInterfacePort(edge.source, target.elementId)
      || endpointUsesInterfacePort(edge.target, target.elementId))
      .forEach((edge) => ownedKeys.add(`edge:${graph.id}:${edge.id}`));
  }
  if (target.elementKind === "dynamicPort") {
    ownedKeys.add(`dynamicPort:${target.graphId}:${target.nodeId}:${target.elementId}`);
    graph.edges.filter((edge) => endpointUsesNodePort(edge.source, target.nodeId, target.elementId)
      || endpointUsesNodePort(edge.target, target.nodeId, target.elementId))
      .forEach((edge) => ownedKeys.add(`edge:${graph.id}:${edge.id}`));
  }
  for (const graphId of closureGraphIds) {
    ownedKeys.add(`graph:${graphId}`);
    const ownedGraph = source.document.graphs.find((candidate) => candidate.id === graphId)!;
    ownedGraph.interfacePorts.forEach((port) => ownedKeys.add(`interfacePort:${graphId}:${port.id}`));
    ownedGraph.edges.forEach((edge) => ownedKeys.add(`edge:${graphId}:${edge.id}`));
    ownedGraph.nodes.forEach((node) => {
      ownedKeys.add(`node:${graphId}:${node.id}`);
      node.dynamicPorts.forEach((port) => ownedKeys.add(`dynamicPort:${graphId}:${node.id}:${port.id}`));
    });
  }
  for (const key of closureNodeKeys) {
    const [graphId, deletedNodeId] = key.split("\u0000");
    ownedKeys.add(`node:${graphId}:${deletedNodeId}`);
    const deletedNode = source.document.graphs.find((candidate) => candidate.id === graphId)?.nodes
      .find((candidate) => candidate.id === deletedNodeId);
    deletedNode?.dynamicPorts.forEach((port) => ownedKeys.add(`dynamicPort:${graphId}:${deletedNodeId}:${port.id}`));
    source.document.graphs.find((candidate) => candidate.id === graphId)?.edges
      .filter((edge) => endpointUsesNode(edge.source, deletedNodeId!) || endpointUsesNode(edge.target, deletedNodeId!))
      .forEach((edge) => ownedKeys.add(`edge:${graphId}:${edge.id}`));
  }
  return {
    ownedIdentities: source.ownedIdentities.filter((identity) => ownedKeys.has(identity.identityKey)),
    internalOccurrencePaths: new Set(source.occurrences
      .filter((occurrence) => internalPrefixes.some((prefix) => occurrence.path.startsWith(prefix)))
      .map((occurrence) => occurrence.path)),
    nextDocument: result.document,
  };
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
  const projectHash = hashBytes(await readFile(project.absoluteProjectFile));
  const catalogPaths = [...new Set(project.definition.documentTypes.flatMap((documentType) => documentType.catalogs))].sort(compareUtf16CodeUnits);
  const catalogManifest = await Promise.all(catalogPaths.map(async (catalogPath) => ({
    path: catalogPath,
    hash: hashBytes(await readFile(await resolveExistingProjectPath(project, catalogPath))),
  })));
  const documentPaths = [...new Set(indexed.flatMap((document) => document.sourcePaths))].sort(compareUtf16CodeUnits);
  const documentManifest = await Promise.all(documentPaths.map(async (documentPath) => ({
    path: documentPath,
    hash: hashBytes(await readFile(await resolveExistingProjectPath(project, documentPath))),
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
    && document.path === operation.source.path
  ));
  if (source === undefined) {
    throw new VisualBridgeMcpError(
      "lifecycle.invalidSource",
      `Lifecycle source '${operation.source.path}' is absent from the Project document index.`,
    );
  }
  const hashes = await Promise.all([...new Set(source.sourcePaths)].sort(compareUtf16CodeUnits).map(async (sourcePath) => [
    sourcePath,
    hashBytes(await readFile(await resolveExistingProjectPath(project, sourcePath))),
  ] as const));
  return Object.fromEntries(hashes);
}

async function buildDependencyPreconditions(
  project: ProjectContext,
  dependencies: readonly DocumentLifecycleDependency[],
): Promise<readonly ProjectTransactionPrecondition[]> {
  const paths = [...new Set(dependencies.flatMap((dependency) => dependency.paths))].sort(compareUtf16CodeUnits);
  return Promise.all(paths.map(async (sourcePath) => {
    const absolutePath = sourcePath === path.relative(project.projectRoot, project.absoluteProjectFile).replaceAll("\\", "/")
      ? project.absoluteProjectFile
      : await resolveExistingProjectPath(project, sourcePath);
    return { path: sourcePath, absolutePath, hash: hashBytes(await readFile(absolutePath)) };
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

function createHostMutation(source: PreparedTableLifecycleSource): HostMutation {
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

function replaceHostMutation(source: PreparedTableLifecycleSource): HostMutation {
  if (source.before === undefined) throw new Error("Replace source is missing baseline bytes.");
  return createHostMutation(source);
}

function createdTextSource(context: DeclaredDocumentContext, text: string): PreparedTableLifecycleSource {
  return { path: context.path, absolutePath: context.absolutePath, after: Buffer.from(text, "utf8") };
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

function assertParameterKeys(parameters: Readonly<Record<string, JsonValue>>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(parameters).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new VisualBridgeMcpError("lifecycle.invalidParameters", `Unexpected create parameter '${unexpected.sort(compareUtf16CodeUnits)[0]}'.`);
  }
}

function requiredIdentifier(value: JsonValue | undefined, label: string): string {
  const result = optionalIdentifier(value, label);
  if (result === undefined) throw new VisualBridgeMcpError("lifecycle.invalidParameters", `${label} is required.`);
  return result;
}

function optionalIdentifier(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new VisualBridgeMcpError("lifecycle.invalidParameters", `${label} must be a stable identifier.`);
  }
  return value;
}

function identifierArray(value: JsonValue | undefined, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new VisualBridgeMcpError("lifecycle.invalidParameters", `${label} must be an array.`);
  return value.map((entry, index) => requiredIdentifier(entry, `${label}[${index}]`));
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new VisualBridgeMcpError("lifecycle.invalidParameters", `${label} must be a string.`);
  return value;
}

function requiredTableFormat(value: JsonValue | undefined, label: string): "csv" | "xlsx" {
  if (value !== "csv" && value !== "xlsx") {
    throw new VisualBridgeMcpError("lifecycle.invalidParameters", `${label} must be 'csv' or 'xlsx'.`);
  }
  return value;
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

function unsupportedEditor(editor: string): VisualBridgeMcpError {
  return new VisualBridgeMcpError("lifecycle.unsupportedEditor", `Editor '${editor}' has no Lifecycle Adapter.`);
}

function incompatibleDeleteTarget(kind: string, editor: string): VisualBridgeMcpError {
  return new VisualBridgeMcpError("lifecycle.invalidDeleteTarget", `Delete target '${kind}' is incompatible with '${editor}'.`);
}

function missingDeleteTarget(id: string): VisualBridgeMcpError {
  return new VisualBridgeMcpError("lifecycle.deleteTargetNotFound", `Delete target '${id}' does not exist.`);
}

function findGraphOwner(document: GraphDocument, graphId: string): { readonly graphId: string; readonly nodeId: string } | undefined {
  for (const graph of document.graphs) {
    const node = graph.nodes.find((candidate) => candidate.kind === "subgraph" && candidate.subgraphId === graphId);
    if (node !== undefined) return { graphId: graph.id, nodeId: node.id };
  }
  return undefined;
}

function collectGraphClosure(
  document: GraphDocument,
  graphId: string,
  graphs: Set<string>,
  nodes: Set<string>,
): void {
  if (graphs.has(graphId)) return;
  graphs.add(graphId);
  const graph = document.graphs.find((candidate) => candidate.id === graphId);
  graph?.nodes.forEach((node) => {
    nodes.add(`${graphId}\u0000${node.id}`);
    if (node.kind === "subgraph") collectGraphClosure(document, node.subgraphId, graphs, nodes);
  });
}

function endpointUsesNode(endpoint: { readonly kind: string; readonly nodeId?: string }, nodeId: string): boolean {
  return endpoint.kind === "node" && endpoint.nodeId === nodeId;
}

function endpointUsesInterfacePort(
  endpoint: { readonly kind: string; readonly portId: string },
  portId: string,
): boolean {
  return endpoint.kind === "interface" && endpoint.portId === portId;
}

function endpointUsesNodePort(
  endpoint: { readonly kind: string; readonly nodeId?: string; readonly portId: string },
  nodeId: string,
  portId: string,
): boolean {
  return endpoint.kind === "node" && endpoint.nodeId === nodeId && endpoint.portId === portId;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}

function decodeUtf8(bytes: Uint8Array, sourcePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    throw new VisualBridgeMcpError("file.invalidUtf8", `File '${sourcePath}' is not valid UTF-8: ${formatError(errorValue)}`);
  }
}

function isPreviewInvalidation(code: string): boolean {
  return code.startsWith("document.")
    || code.startsWith("path.")
    || code.startsWith("project.")
    || code.startsWith("lifecycle.")
    || code.startsWith("table.")
    || code === "file.invalidUtf8";
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
