import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createReferenceValueRenamePlan,
  documentIndexKey,
  referenceValuesEqual,
  type IndexedDocument,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type ReferenceService,
  type ReferenceValueRenamePlan,
} from "@visualbridge/core";
import {
  applyEntityOperations,
  collectEntityReferences,
  parseEntityDocument,
  renameEntityDocumentId,
  replaceEntityReferenceValues,
  serializeEntityDocument,
  type EntityCatalogRegistry,
} from "@visualbridge/entity";
import {
  applyGraphOperations,
  buildGraphCatalogRegistry,
  collectGraphReferences,
  parseGraphCatalog,
  parseGraphDocument,
  renameGraphDocumentId,
  replaceGraphReferenceValues,
  serializeGraphDocument,
  type GraphCatalog,
  type GraphCatalogRegistry,
} from "@visualbridge/graph";
import {
  buildStructuredCatalogRegistry,
  collectStructuredReferences,
  parseStructuredCatalog,
  parseStructuredDocument,
  renameStructuredDocumentId,
  replaceStructuredReferenceValues,
  serializeStructuredDocument,
  type StructuredCatalog,
  type StructuredCatalogRegistry,
} from "@visualbridge/structured";
import { collectTableReferences } from "@visualbridge/table";
import {
  VisualBridgeMcpError,
  VisualBridgeWorkspace,
  resolveExistingProjectPath,
  type DeclaredDocumentContext,
  type ProjectContext,
} from "./projectWorkspace.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";
import type { TableService } from "./tableService.js";
import { hashBytes } from "./atomicTextFile.js";
import { loadMcpEntityRegistry } from "./entityRegistry.js";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "./projectTransaction.js";

interface PreparedWrite {
  readonly path: string;
  readonly absolutePath: string;
  readonly before: Buffer;
  readonly after: Buffer;
}

interface PreparedRefactor {
  readonly project: ProjectContext;
  readonly plan: ReferenceValueRenamePlan;
  readonly writes: readonly PreparedWrite[];
  readonly dependencies: readonly { readonly path: string; readonly baseHash: string }[];
  readonly previewHash: string;
}

export interface ReferenceRefactorRequest {
  readonly projectFile?: string;
  readonly action: "preview" | "apply";
  readonly definition: ReferenceDefinition;
  readonly oldValue: string | number;
  readonly newValue: string | number;
  readonly previewHash?: string;
  readonly baseHashes?: Readonly<Record<string, string>>;
}

export class ReferenceRefactorService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
    private readonly tables: TableService,
  ) {}

  public async execute(request: ReferenceRefactorRequest): Promise<Record<string, unknown>> {
    if (request.action === "preview") {
      return previewResult(await this.prepare(request));
    }
    const project = await this.workspace.resolveProject(request.projectFile);
    try {
      return await withProjectTransaction(project.projectRoot, async (transaction) => {
        let prepared: PreparedRefactor;
        try {
          prepared = await this.prepare(request);
        } catch (errorValue) {
          if (!(errorValue instanceof VisualBridgeMcpError) || !isPreviewInvalidation(errorValue.code)) throw errorValue;
          return {
            status: "conflict",
            reason: "previewInvalidated",
            message: formatError(errorValue),
          };
        }
        const preview = previewResult(prepared);
        if (request.previewHash !== prepared.previewHash) {
          return { ...preview, status: "conflict", reason: "previewHashMismatch" };
        }
        const expected = request.baseHashes ?? {};
        const actual = Object.fromEntries(prepared.writes.map((write) => [write.path, hashBytes(write.before)]));
        if (!sameHashManifest(expected, actual)) {
          return { ...preview, status: "conflict", reason: "baseHashMismatch" };
        }
        const dependencies = await Promise.all(prepared.dependencies.map(async (dependency) => {
          const absolutePath = dependency.path === prepared.project.projectFile
            ? prepared.project.absoluteProjectFile
            : await resolveExistingProjectPath(prepared.project, dependency.path);
          return {
            path: path.relative(prepared.project.projectRoot, absolutePath).replaceAll("\\", "/"),
            absolutePath,
            hash: dependency.baseHash,
          };
        }));
        const committed = await transaction.commit(prepared.writes, dependencies);
        return {
          status: "applied",
          projectFile: prepared.project.projectFile,
          previewHash: prepared.previewHash,
          kind: prepared.plan.kind,
          oldValue: prepared.plan.oldValue,
          newValue: prepared.plan.newValue,
          referencesChanged: prepared.plan.changes.length,
          sources: prepared.writes.map((write) => ({
            path: write.path,
            previousHash: hashBytes(write.before),
            hash: hashBytes(write.after),
          })),
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

  private async prepare(request: ReferenceRefactorRequest): Promise<PreparedRefactor> {
    if (!SUPPORTED_KINDS.has(request.definition.kind)) {
      throw new VisualBridgeMcpError(
        "refactor.unsupportedKind",
        `Reference Provider '${request.definition.kind}' does not expose a rename adapter.`,
      );
    }
    if (typeof request.oldValue !== typeof request.newValue || referenceValuesEqual(request.oldValue, request.newValue)) {
      throw new VisualBridgeMcpError(
        "refactor.invalidValue",
        "A reference rename must preserve value type and use a different value.",
      );
    }
    const project = await this.workspace.resolveProject(request.projectFile);
    const references = await this.references.createProjectService(project.projectFile);
    const resolution = await references.resolve(request.definition, request.oldValue);
    if (resolution.status !== "resolved" || resolution.candidates.length !== 1) {
      throw new VisualBridgeMcpError("refactor.unresolvedTarget", "Only a uniquely resolved reference target can be renamed.", resolution);
    }
    const collision = await references.resolve(request.definition, request.newValue);
    if (collision.status !== "missing") {
      throw new VisualBridgeMcpError(
        "refactor.duplicateTarget",
        `The new value '${String(request.newValue)}' already resolves to ${collision.candidates.length} target(s).`,
      );
    }
    const documents = await this.buildIndex(project, references);
    const selected = {
      occurrence: { definition: request.definition, value: request.oldValue, path: "$refactor" },
      resolution,
    };
    const planned = createReferenceValueRenamePlan(documents, selected, request.newValue);
    if (!planned.success) throw new VisualBridgeMcpError(`refactor.${planned.reason}`, planned.message);
    const location = planned.plan.target.location!;
    const targetDocument = documents.find((document) => (
      document.projectId === location.projectId
      && document.documentTypeId === location.documentTypeId
      && document.sourcePaths.includes(location.path)
    ));
    if (targetDocument === undefined) {
      throw new VisualBridgeMcpError("refactor.targetNotIndexed", "The resolved target is no longer an indexed document.");
    }
    const affected = uniqueDocuments([
      targetDocument,
      ...planned.plan.changes.flatMap((change) => {
        const document = documents.find((candidate) => documentIndexKey(candidate) === documentIndexKey(change));
        return document === undefined ? [] : [document];
      }),
    ]);
    const writes = (await Promise.all(affected.map((document) => this.prepareDocument(
      project,
      document,
      new Set(planned.plan.changes
        .filter((change) => documentIndexKey(change) === documentIndexKey(document))
        .map((change) => change.occurrencePath)),
      planned.plan,
      documentIndexKey(document) === documentIndexKey(targetDocument),
    )))).flat().filter((write) => !write.before.equals(write.after))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (writes.length === 0) throw new VisualBridgeMcpError("refactor.noChanges", "The refactor did not produce source changes.");
    const dependencies = await loadDependencyHashes(project);
    const previewHash = hashStable({
      projectFile: project.projectFile,
      definition: request.definition,
      oldValue: request.oldValue,
      newValue: request.newValue,
      changes: planned.plan.changes,
      dependencies,
      sources: writes.map((write) => ({ path: write.path, baseHash: hashBytes(write.before), nextHash: hashBytes(write.after) })),
    });
    return { project, plan: planned.plan, writes, dependencies, previewHash };
  }

  private async buildIndex(project: ProjectContext, references: ReferenceService): Promise<readonly IndexedDocument[]> {
    const declared = await this.workspace.listDeclaredDocuments(project);
    const documents: IndexedDocument[] = [];
    const graphRegistries = new Map<string, Promise<GraphCatalogRegistry>>();
    const entityRegistries = new Map<string, Promise<EntityCatalogRegistry>>();
    const structuredRegistries = new Map<string, Promise<StructuredCatalogRegistry>>();
    for (const source of declared) {
      if (source.documentType.editor === "table") continue;
      const bytes = await readFile(source.absolutePath);
      const text = decodeUtf8(bytes, source.path);
      let documentId: string;
      let title: string;
      let occurrences: readonly ReferenceOccurrence[];
      if (source.documentType.editor === "graph") {
        const parsed = parseGraphDocument(text);
        if (!parsed.success) throw invalidSource(source.path, parsed.diagnostics);
        const registry = await cachedRegistry(graphRegistries, source.documentType.id, () => loadGraphRegistry(project, source));
        documentId = parsed.document.documentId;
        title = parsed.document.graphs.find((graph) => graph.id === parsed.document.rootGraphId)?.title ?? fileTitle(source.path);
        occurrences = collectGraphReferences(parsed.document, registry);
      } else if (source.documentType.editor === "entity") {
        const parsed = parseEntityDocument(text);
        if (!parsed.success) throw invalidSource(source.path, parsed.diagnostics);
        const registry = await cachedRegistry(entityRegistries, source.documentType.id, () => loadMcpEntityRegistry(project, source.documentType));
        documentId = parsed.document.documentId;
        title = parsed.document.title;
        occurrences = collectEntityReferences(parsed.document, registry);
      } else if (source.documentType.editor === "structured") {
        const parsed = parseStructuredDocument(text);
        if (!parsed.success) throw invalidSource(source.path, parsed.diagnostics);
        const registry = await cachedRegistry(structuredRegistries, source.documentType.id, () => loadStructuredRegistry(project, source));
        documentId = parsed.document.documentId;
        title = fileTitle(source.path);
        occurrences = collectStructuredReferences(parsed.document, registry, source.documentType.id);
      } else {
        continue;
      }
      documents.push({
        projectId: project.definition.projectId,
        documentTypeId: source.documentType.id,
        editor: source.documentType.editor,
        path: source.path,
        sourcePaths: [source.path],
        documentId,
        title,
        diagnostics: [],
        references: await this.resolveOccurrences(references, occurrences),
      });
    }
    for (const table of await this.tables.loadReferenceDocuments(project.projectFile, true)) {
      const sourcePaths = [...new Set([table.path, ...Object.values(table.sheetPaths ?? {})])].sort();
      documents.push({
        projectId: table.projectId,
        documentTypeId: table.documentTypeId,
        editor: "table",
        path: sourcePaths[0] ?? table.path,
        sourcePaths,
        title: table.tableType.title,
        diagnostics: [],
        references: await this.resolveOccurrences(
          references,
          collectTableReferences(table.document, table.tableType),
        ),
      });
    }
    return documents.sort((left, right) => documentIndexKey(left).localeCompare(documentIndexKey(right)));
  }

  private async resolveOccurrences(references: ReferenceService, occurrences: readonly ReferenceOccurrence[]) {
    return Promise.all(occurrences.map(async (occurrence) => ({
      occurrence,
      resolution: await references.resolve(occurrence.definition, occurrence.value),
    })));
  }

  private async prepareDocument(
    project: ProjectContext,
    indexed: IndexedDocument,
    occurrencePaths: ReadonlySet<string>,
    plan: ReferenceValueRenamePlan,
    isTarget: boolean,
  ): Promise<readonly PreparedWrite[]> {
    if (indexed.editor === "table") {
      if (isTarget && plan.kind !== "table.row") throw incompatibleTarget(plan.kind, indexed.editor);
      return this.tables.prepareReferenceRename({
        projectFile: project.projectFile,
        documentTypeId: indexed.documentTypeId,
        tablePath: indexed.path,
        occurrencePaths,
        oldValue: plan.oldValue,
        newValue: plan.newValue,
        ...(isTarget ? { targetLocation: plan.target.location } : {}),
      });
    }
    const declared = (await this.workspace.listDeclaredDocuments(project)).find((source) => (
      source.path === indexed.path && source.documentType.id === indexed.documentTypeId
    ));
    if (declared === undefined) throw new VisualBridgeMcpError("refactor.sourceNotDeclared", `'${indexed.path}' is no longer declared.`);
    const before = await readFile(declared.absolutePath);
    const text = decodeUtf8(before, indexed.path);
    let after: Buffer;
    if (indexed.editor === "graph") {
      const registry = await loadGraphRegistry(project, declared);
      const parsed = parseGraphDocument(text);
      if (!parsed.success) throw invalidSource(indexed.path, parsed.diagnostics);
      let next = parsed.document;
      if (occurrencePaths.size > 0) {
        assertOccurrenceValues(collectGraphReferences(next, registry), occurrencePaths, plan.oldValue, indexed.path);
        const replaced = replaceGraphReferenceValues(next, registry, occurrencePaths, plan.newValue);
        if (!replaced.success) throw invalidSource(indexed.path, replaced.diagnostics);
        next = replaced.document;
      }
      if (isTarget && plan.kind === "document") {
        assertDocumentTarget(next.documentId, plan, indexed.path);
        const renamed = renameGraphDocumentId(next, requireString(plan.newValue), registry);
        if (!renamed.success) throw invalidSource(indexed.path, renamed.diagnostics);
        next = renamed.document;
      } else if (isTarget && plan.kind === "graph.element") {
        const location = plan.target.location!;
        const elementKind = readGraphElementKind(location.elementKind);
        if (location.graphId === undefined || location.elementId !== plan.oldValue || elementKind === undefined) {
          throw new VisualBridgeMcpError("refactor.targetChanged", "The Graph element location is incomplete or changed.");
        }
        const renamed = applyGraphOperations(next, [{
          type: "graph.renameElement",
          graphId: location.graphId,
          elementKind,
          elementId: requireString(plan.oldValue),
          newElementId: requireString(plan.newValue),
          ...(location.nodeId === undefined ? {} : { nodeId: location.nodeId }),
        }], registry);
        if (!renamed.success) throw invalidSource(indexed.path, renamed.diagnostics);
        next = renamed.document;
      } else if (isTarget) {
        throw incompatibleTarget(plan.kind, indexed.editor);
      }
      after = Buffer.from(serializeGraphDocument(next), "utf8");
    } else if (indexed.editor === "entity") {
      const registry = await loadMcpEntityRegistry(project, declared.documentType);
      const parsed = parseEntityDocument(text);
      if (!parsed.success) throw invalidSource(indexed.path, parsed.diagnostics);
      let next = parsed.document;
      if (occurrencePaths.size > 0) {
        assertOccurrenceValues(collectEntityReferences(next, registry), occurrencePaths, plan.oldValue, indexed.path);
        const replaced = replaceEntityReferenceValues(next, registry, occurrencePaths, plan.newValue);
        if (!replaced.success) throw invalidSource(indexed.path, replaced.diagnostics);
        next = replaced.document;
      }
      if (isTarget && plan.kind === "document") {
        assertDocumentTarget(next.documentId, plan, indexed.path);
        const renamed = renameEntityDocumentId(next, requireString(plan.newValue), registry);
        if (!renamed.success) throw invalidSource(indexed.path, renamed.diagnostics);
        next = renamed.document;
      } else if (isTarget && plan.kind === "entity.component") {
        const location = plan.target.location!;
        if (location.documentId !== next.documentId
          || location.elementKind !== "component"
          || location.componentId !== plan.oldValue
          || location.elementId !== plan.oldValue) {
          throw new VisualBridgeMcpError(
            "refactor.targetChanged",
            "The Entity component location is incomplete or changed.",
          );
        }
        const renamed = applyEntityOperations(next, [{
          type: "entity.renameComponent",
          componentId: requireString(plan.oldValue),
          newComponentId: requireString(plan.newValue),
        }], registry);
        if (!renamed.success) throw invalidSource(indexed.path, renamed.diagnostics);
        next = renamed.document;
      } else if (isTarget) {
        throw incompatibleTarget(plan.kind, indexed.editor);
      }
      after = Buffer.from(serializeEntityDocument(next), "utf8");
    } else if (indexed.editor === "structured") {
      const registry = await loadStructuredRegistry(project, declared);
      const parsed = parseStructuredDocument(text);
      if (!parsed.success) throw invalidSource(indexed.path, parsed.diagnostics);
      let next = parsed.document;
      if (occurrencePaths.size > 0) {
        assertOccurrenceValues(
          collectStructuredReferences(next, registry, indexed.documentTypeId),
          occurrencePaths,
          plan.oldValue,
          indexed.path,
        );
        const replaced = replaceStructuredReferenceValues(next, registry, indexed.documentTypeId, occurrencePaths, plan.newValue);
        if (!replaced.success) throw invalidSource(indexed.path, replaced.diagnostics);
        next = replaced.document;
      }
      if (isTarget && plan.kind === "document") {
        assertDocumentTarget(next.documentId, plan, indexed.path);
        const renamed = renameStructuredDocumentId(next, requireString(plan.newValue), registry, indexed.documentTypeId);
        if (!renamed.success) throw invalidSource(indexed.path, renamed.diagnostics);
        next = renamed.document;
      } else if (isTarget) {
        throw incompatibleTarget(plan.kind, indexed.editor);
      }
      after = Buffer.from(serializeStructuredDocument(next), "utf8");
    } else {
      throw new VisualBridgeMcpError("refactor.unsupportedEditor", `Editor '${indexed.editor}' cannot participate in refactors.`);
    }
    return [{ path: indexed.path, absolutePath: declared.absolutePath, before, after }];
  }
}

const SUPPORTED_KINDS = new Set(["document", "entity.component", "graph.element", "table.row"]);
const PREVIEW_INVALIDATION_CODES = new Set([
  "file.invalidUtf8",
  "path.notFound",
  "project.notFound",
  "refactor.catalogUnavailable",
  "refactor.duplicateTarget",
  "refactor.invalidSource",
  "refactor.noChanges",
  "refactor.occurrenceChanged",
  "refactor.targetNotIndexed",
  "refactor.unresolvedTarget",
]);

function isPreviewInvalidation(code: string): boolean {
  return PREVIEW_INVALIDATION_CODES.has(code) || code.startsWith("document.");
}

function previewResult(prepared: PreparedRefactor): Record<string, unknown> {
  return {
    status: "preview",
    projectFile: prepared.project.projectFile,
    previewHash: prepared.previewHash,
    kind: prepared.plan.kind,
    oldValue: prepared.plan.oldValue,
    newValue: prepared.plan.newValue,
    target: prepared.plan.target,
    changes: prepared.plan.changes,
    dependencies: prepared.dependencies,
    sources: prepared.writes.map((write) => ({
      path: write.path,
      baseHash: hashBytes(write.before),
      nextHash: hashBytes(write.after),
    })),
    baseHashes: Object.fromEntries(prepared.writes.map((write) => [write.path, hashBytes(write.before)])),
  };
}

async function loadDependencyHashes(
  project: ProjectContext,
): Promise<readonly { readonly path: string; readonly baseHash: string }[]> {
  const paths = [...new Set(project.definition.documentTypes.flatMap((documentType) => documentType.catalogs))].sort();
  const catalogs = await Promise.all(paths.map(async (catalogPath) => ({
    path: catalogPath,
    baseHash: hashBytes(await readFile(await resolveExistingProjectPath(project, catalogPath))),
  })));
  return [{ path: project.projectFile, baseHash: hashBytes(await readFile(project.absoluteProjectFile)) }, ...catalogs];
}

async function loadGraphRegistry(project: ProjectContext, source: DeclaredDocumentContext): Promise<GraphCatalogRegistry> {
  if (source.documentType.catalogs.length === 0) {
    throw new VisualBridgeMcpError("refactor.catalogUnavailable", `Graph Document Type '${source.documentType.id}' has no Catalogs.`);
  }
  const catalogs: GraphCatalog[] = [];
  for (const catalogPath of source.documentType.catalogs) {
    const parsed = parseGraphCatalog(decodeUtf8(await readFile(await resolveExistingProjectPath(project, catalogPath)), catalogPath));
    if (!parsed.success) throw invalidSource(catalogPath, parsed.diagnostics);
    catalogs.push(parsed.document);
  }
  const built = buildGraphCatalogRegistry(catalogs);
  if (!built.success) throw invalidSource(`${source.documentType.id} Graph Catalog Registry`, built.diagnostics);
  return built.document;
}

async function loadStructuredRegistry(project: ProjectContext, source: DeclaredDocumentContext): Promise<StructuredCatalogRegistry> {
  if (source.documentType.catalogs.length === 0) {
    throw new VisualBridgeMcpError("refactor.catalogUnavailable", `Structured Document Type '${source.documentType.id}' has no Catalogs.`);
  }
  const catalogs: StructuredCatalog[] = [];
  for (const catalogPath of source.documentType.catalogs) {
    const parsed = parseStructuredCatalog(decodeUtf8(await readFile(await resolveExistingProjectPath(project, catalogPath)), catalogPath));
    if (!parsed.success) throw invalidSource(catalogPath, parsed.diagnostics);
    catalogs.push(parsed.document);
  }
  const built = buildStructuredCatalogRegistry(catalogs);
  if (!built.success) throw invalidSource(`${source.documentType.id} Structured Catalog Registry`, built.diagnostics);
  return built.document;
}

async function cachedRegistry<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const loading = load();
  cache.set(key, loading);
  return loading;
}

function uniqueDocuments(documents: readonly IndexedDocument[]): readonly IndexedDocument[] {
  return [...new Map(documents.map((document) => [documentIndexKey(document), document])).values()]
    .sort((left, right) => documentIndexKey(left).localeCompare(documentIndexKey(right)));
}

function assertOccurrenceValues(
  occurrences: readonly ReferenceOccurrence[],
  paths: ReadonlySet<string>,
  expectedValue: string | number,
  documentPath: string,
): void {
  for (const occurrencePath of paths) {
    if (occurrences.filter((occurrence) => (
      occurrence.path === occurrencePath && referenceValuesEqual(occurrence.value, expectedValue)
    )).length !== 1) {
      throw new VisualBridgeMcpError(
        "refactor.occurrenceChanged",
        `Reference occurrence '${documentPath}: ${occurrencePath}' changed after indexing.`,
      );
    }
  }
}

function assertDocumentTarget(currentId: string, plan: ReferenceValueRenamePlan, sourcePath: string): void {
  if (plan.target.location?.documentId !== plan.oldValue || currentId !== plan.oldValue) {
    throw new VisualBridgeMcpError("refactor.targetChanged", `The document ID in '${sourcePath}' changed after indexing.`);
  }
}

function requireString(value: string | number): string {
  if (typeof value !== "string") throw new VisualBridgeMcpError("refactor.invalidValue", "Document, Graph element, and Entity component IDs must be strings.");
  return value;
}

function readGraphElementKind(value: string | undefined): "graph" | "node" | "interfacePort" | "dynamicPort" | undefined {
  return value === "graph" || value === "node" || value === "interfacePort" || value === "dynamicPort" ? value : undefined;
}

function incompatibleTarget(kind: string, editor: string): VisualBridgeMcpError {
  return new VisualBridgeMcpError("refactor.incompatibleTarget", `Reference target '${kind}' cannot be stored in a ${editor} document.`);
}

function invalidSource(sourcePath: string, diagnostics: readonly unknown[]): VisualBridgeMcpError {
  return new VisualBridgeMcpError("refactor.invalidSource", `Source '${sourcePath}' is invalid and cannot participate in a project refactor.`, diagnostics);
}

function decodeUtf8(bytes: Uint8Array, sourcePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    throw new VisualBridgeMcpError("file.invalidUtf8", `File '${sourcePath}' is not valid UTF-8: ${formatError(errorValue)}`);
  }
}

function fileTitle(sourcePath: string): string {
  return path.basename(sourcePath, path.extname(sourcePath));
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}

function sameHashManifest(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
