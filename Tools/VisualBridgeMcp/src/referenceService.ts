import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createDocumentReferenceProvider,
  documentIndexKey,
  ReferenceService,
  type DocumentReferenceDocument,
  type DocumentDiagnostic,
  type JsonValue,
  type IndexedDocument,
  type ProjectProviderDocumentSnapshot,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type ReferenceResolution,
} from "@visualbridge/core";
import {
  createEntityComponentReferenceProvider,
  collectEntityReferences,
  parseEntityDocument,
  validateEntityDocument,
  type EntityReferenceDocument,
  type EntityCatalogRegistry,
} from "@visualbridge/entity";
import {
  buildGraphCatalogRegistry,
  collectGraphReferences,
  createGraphElementReferenceProvider,
  parseGraphCatalog,
  parseGraphDocument,
  validateGraphDocument,
  type GraphCatalog,
  type GraphCatalogRegistry,
  type GraphReferenceDocument,
} from "@visualbridge/graph";
import {
  buildStructuredCatalogRegistry,
  collectStructuredReferences,
  parseStructuredCatalog,
  parseStructuredDocument,
  validateStructuredDocument,
  type StructuredCatalog,
  type StructuredCatalogRegistry,
} from "@visualbridge/structured";
import { collectTableReferences, createTableRowReferenceProvider } from "@visualbridge/table";
import {
  VisualBridgeMcpError,
  resolveExistingProjectPath,
  type DeclaredDocumentContext,
  type ProjectContext,
  type VisualBridgeWorkspace,
} from "./projectWorkspace.js";
import type { TableService } from "./tableService.js";
import { loadMcpEntityRegistry } from "./entityRegistry.js";
import type { McpProjectProviderService } from "./projectProviderService.js";

export class VisualBridgeReferenceService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly tables: TableService,
    private readonly providers?: McpProjectProviderService,
  ) {}

  public async query(options: {
    readonly projectFile?: string;
    readonly action: "search" | "resolve";
    readonly definition: ReferenceDefinition;
    readonly query?: string;
    readonly value?: string | number;
    readonly limit: number;
  }): Promise<Record<string, unknown>> {
    const project = await this.workspace.resolveProject(options.projectFile);
    const service = await this.createProjectService(project.projectFile);
    if (options.action === "search") {
      const result = await service.searchDetailed(options.definition, options.query ?? "", options.limit);
      return {
        projectFile: project.projectFile,
        action: options.action,
        definition: options.definition,
        query: options.query ?? "",
        status: result.status,
        ...(result.message === undefined ? {} : { message: result.message }),
        results: result.candidates,
      };
    }
    if (options.value === undefined) {
      throw new Error("Reference resolve requires value.");
    }
    const resolution = await service.resolve(options.definition, options.value);
    return {
      projectFile: project.projectFile,
      action: options.action,
      definition: options.definition,
      value: options.value,
      ...resolution,
    };
  }

  public async validate(
    projectFile: string,
    occurrences: readonly ReferenceOccurrence[],
  ): Promise<readonly DocumentDiagnostic[]> {
    return this.createProjectService(projectFile).then((service) => service.validate(occurrences));
  }

  public async resolve(
    projectFile: string,
    definition: ReferenceDefinition,
    value: string | number,
  ): Promise<ReferenceResolution> {
    return (await this.createProjectService(projectFile)).resolve(definition, value);
  }

  public async validateChange(
    projectFile: string,
    before: readonly ReferenceOccurrence[],
    after: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly introducedErrors: readonly DocumentDiagnostic[];
  }> {
    const service = await this.createProjectService(projectFile);
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
    projectFile: string,
    snapshot: ProjectProviderDocumentSnapshot,
  ): Promise<readonly DocumentDiagnostic[]> {
    if (this.providers === undefined) return [];
    const project = await this.workspace.resolveProject(projectFile);
    const result = await this.providers.validateDocuments(project, [snapshot]);
    if (result.externalModification !== undefined) {
      throw new VisualBridgeMcpError(
        "provider.externalModification",
        result.externalModification.message,
        { changedPaths: result.externalModification.changedPaths },
      );
    }
    return result.diagnostics.map(({ documentTypeId: _documentTypeId, documentPath: _documentPath, ...diagnostic }) => (
      diagnostic
    ));
  }

  public async createProjectService(projectFile: string): Promise<ReferenceService> {
    const project = await this.workspace.resolveProject(projectFile);
    let semanticDocuments: Promise<{
      readonly documents: readonly DocumentReferenceDocument[];
      readonly entities: readonly EntityReferenceDocument[];
      readonly graphs: readonly GraphReferenceDocument[];
    }> | undefined;
    const loadSemanticDocuments = () => (semanticDocuments ??= this.loadSemanticDocuments(project.projectFile));
    return new ReferenceService([
      createDocumentReferenceProvider(() => loadSemanticDocuments().then((loaded) => loaded.documents)),
      createEntityComponentReferenceProvider(() => loadSemanticDocuments().then((loaded) => loaded.entities)),
      createGraphElementReferenceProvider(() => loadSemanticDocuments().then((loaded) => loaded.graphs)),
      createTableRowReferenceProvider(() => this.tables.loadReferenceDocuments(project.projectFile)),
      ...await this.providers?.referenceProviders(project) ?? [],
    ]);
  }

  public async buildProjectIndex(projectFile: string): Promise<readonly IndexedDocument[]> {
    const project = await this.workspace.resolveProject(projectFile);
    const references = await this.createProjectService(project.projectFile);
    const declared = await this.workspace.listDeclaredDocuments(project);
    const documents: IndexedDocument[] = [];
    const graphRegistries = new Map<string, Promise<GraphCatalogRegistry>>();
    const entityRegistries = new Map<string, Promise<EntityCatalogRegistry>>();
    const structuredRegistries = new Map<string, Promise<StructuredCatalogRegistry>>();
    for (const source of declared) {
      if (source.documentType.editor === "table") continue;
      const text = decodeUtf8(await readFile(source.absolutePath), source.path);
      let documentId: string;
      let title: string;
      let occurrences: readonly ReferenceOccurrence[];
      let semanticDiagnostics: readonly DocumentDiagnostic[];
      if (source.documentType.editor === "graph") {
        const parsed = parseGraphDocument(text);
        if (!parsed.success) throw invalidIndexedSource(source.path, parsed.diagnostics);
        const registry = await cachedRegistry(
          graphRegistries,
          source.documentType.id,
          () => loadMcpGraphRegistry(project, source),
        );
        documentId = parsed.document.documentId;
        title = parsed.document.graphs.find((graph) => graph.id === parsed.document.rootGraphId)?.title
          ?? fileTitle(source.path);
        semanticDiagnostics = validateGraphDocument(parsed.document, registry);
        occurrences = collectGraphReferences(parsed.document, registry);
      } else if (source.documentType.editor === "entity") {
        const parsed = parseEntityDocument(text);
        if (!parsed.success) throw invalidIndexedSource(source.path, parsed.diagnostics);
        const registry = await cachedRegistry(
          entityRegistries,
          source.documentType.id,
          () => loadMcpEntityRegistry(project, source.documentType),
        );
        documentId = parsed.document.documentId;
        title = parsed.document.title;
        semanticDiagnostics = validateEntityDocument(parsed.document, registry);
        occurrences = collectEntityReferences(parsed.document, registry);
      } else if (source.documentType.editor === "structured") {
        const parsed = parseStructuredDocument(text);
        if (!parsed.success) throw invalidIndexedSource(source.path, parsed.diagnostics);
        const registry = await cachedRegistry(
          structuredRegistries,
          source.documentType.id,
          () => loadMcpStructuredRegistry(project, source),
        );
        documentId = parsed.document.documentId;
        title = fileTitle(source.path);
        semanticDiagnostics = validateStructuredDocument(parsed.document, registry, source.documentType.id);
        occurrences = collectStructuredReferences(parsed.document, registry, source.documentType.id);
      } else {
        continue;
      }
      assertIndexable(source.path, semanticDiagnostics);
      const referenceDiagnostics = await references.validate(occurrences);
      assertIndexable(source.path, referenceDiagnostics);
      documents.push({
        projectId: project.definition.projectId,
        documentTypeId: source.documentType.id,
        editor: source.documentType.editor,
        path: source.path,
        sourcePaths: [source.path],
        documentId,
        title,
        diagnostics: [...semanticDiagnostics, ...referenceDiagnostics],
        references: await resolveOccurrences(references, occurrences),
      });
    }
    for (const table of await this.tables.loadReferenceDocuments(project.projectFile, true)) {
      const sourcePaths = [...new Set([table.path, ...Object.values(table.sheetPaths ?? {})])].sort();
      const occurrences = collectTableReferences(table.document, table.tableType);
      const referenceDiagnostics = await references.validate(occurrences);
      assertIndexable(sourcePaths[0] ?? table.path, referenceDiagnostics);
      documents.push({
        projectId: table.projectId,
        documentTypeId: table.documentTypeId,
        editor: "table",
        path: sourcePaths[0] ?? table.path,
        sourcePaths,
        title: table.tableType.title,
        diagnostics: referenceDiagnostics,
        references: await resolveOccurrences(
          references,
          occurrences,
        ),
      });
    }
    return documents.sort((left, right) => documentIndexKey(left).localeCompare(documentIndexKey(right)));
  }

  private async loadSemanticDocuments(projectFile: string): Promise<{
    readonly documents: readonly DocumentReferenceDocument[];
    readonly entities: readonly EntityReferenceDocument[];
    readonly graphs: readonly GraphReferenceDocument[];
  }> {
    const project = await this.workspace.resolveProject(projectFile);
    const declared = await this.workspace.listDeclaredDocuments(project);
    const documents: DocumentReferenceDocument[] = [];
    const entities: EntityReferenceDocument[] = [];
    const graphs: GraphReferenceDocument[] = [];
    const entityRegistries = new Map<string, ReturnType<typeof loadMcpEntityRegistry>>();
    for (const source of declared) {
      if (source.documentType.editor !== "graph"
        && source.documentType.editor !== "entity"
        && source.documentType.editor !== "structured") continue;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(source.absolutePath));
      if (source.documentType.editor === "graph") {
        const parsed = parseGraphDocument(text);
        if (!parsed.success) continue;
        const title = parsed.document.graphs.find((graph) => graph.id === parsed.document.rootGraphId)?.title
          ?? path.basename(source.path, path.extname(source.path));
        documents.push(documentReference(project.definition.projectId, source.documentType.id, source.documentType.editor, source.path, parsed.document.documentId, title));
        graphs.push({
          projectId: project.definition.projectId,
          documentTypeId: source.documentType.id,
          path: source.path,
          document: parsed.document,
        });
      } else if (source.documentType.editor === "entity") {
        const parsed = parseEntityDocument(text);
        if (parsed.success) {
          documents.push(documentReference(project.definition.projectId, source.documentType.id, source.documentType.editor, source.path, parsed.document.documentId, parsed.document.title));
          let registry = entityRegistries.get(source.documentType.id);
          if (registry === undefined) {
            registry = loadMcpEntityRegistry(project, source.documentType);
            entityRegistries.set(source.documentType.id, registry);
          }
          entities.push({
            projectId: project.definition.projectId,
            documentTypeId: source.documentType.id,
            path: source.path,
            document: parsed.document,
            registry: await registry,
          });
        }
      } else {
        const parsed = parseStructuredDocument(text);
        if (parsed.success) {
          documents.push(documentReference(
            project.definition.projectId,
            source.documentType.id,
            source.documentType.editor,
            source.path,
            parsed.document.documentId,
            path.basename(source.path, path.extname(source.path)),
          ));
        }
      }
    }
    documents.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
    entities.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
    graphs.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
    return { documents, entities, graphs };
  }
}

function documentReference(
  projectId: string,
  documentTypeId: string,
  editor: string,
  sourcePath: string,
  documentId: string,
  title: string,
): DocumentReferenceDocument {
  return { projectId, documentTypeId, editor, path: sourcePath, documentId, title };
}

export function referenceDefinition(
  kind: string,
  target: Readonly<Record<string, JsonValue>>,
  allowMissing: boolean,
): ReferenceDefinition {
  return { kind, target, allowMissing };
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

function assertIndexable(sourcePath: string, diagnostics: readonly DocumentDiagnostic[]): void {
  const blocking = diagnostics.filter((diagnostic) => (
    diagnostic.severity === "error"
    || diagnostic.code === "reference.providerUnavailable"
    || diagnostic.code === "reference.invalidTarget"
  ));
  if (blocking.length > 0) throw invalidIndexedSource(sourcePath, blocking);
}

async function resolveOccurrences(
  references: ReferenceService,
  occurrences: readonly ReferenceOccurrence[],
) {
  return Promise.all(occurrences.map(async (occurrence) => ({
    occurrence,
    resolution: await references.resolve(occurrence.definition, occurrence.value),
  })));
}

export async function loadMcpGraphRegistry(
  project: ProjectContext,
  source: DeclaredDocumentContext,
): Promise<GraphCatalogRegistry> {
  if (source.documentType.catalogs.length === 0) {
    throw new VisualBridgeMcpError(
      "lifecycle.catalogUnavailable",
      `Graph Document Type '${source.documentType.id}' has no Catalogs.`,
    );
  }
  const catalogs: GraphCatalog[] = [];
  for (const catalogPath of source.documentType.catalogs) {
    const parsed = parseGraphCatalog(decodeUtf8(
      await readFile(await resolveExistingProjectPath(project, catalogPath)),
      catalogPath,
    ));
    if (!parsed.success) throw invalidIndexedSource(catalogPath, parsed.diagnostics);
    catalogs.push(parsed.document);
  }
  const built = buildGraphCatalogRegistry(catalogs);
  if (!built.success) throw invalidIndexedSource(`${source.documentType.id} Graph Catalog Registry`, built.diagnostics);
  return built.document;
}

export async function loadMcpStructuredRegistry(
  project: ProjectContext,
  source: DeclaredDocumentContext,
): Promise<StructuredCatalogRegistry> {
  if (source.documentType.catalogs.length === 0) {
    throw new VisualBridgeMcpError(
      "lifecycle.catalogUnavailable",
      `Structured Document Type '${source.documentType.id}' has no Catalogs.`,
    );
  }
  const catalogs: StructuredCatalog[] = [];
  for (const catalogPath of source.documentType.catalogs) {
    const parsed = parseStructuredCatalog(decodeUtf8(
      await readFile(await resolveExistingProjectPath(project, catalogPath)),
      catalogPath,
    ));
    if (!parsed.success) throw invalidIndexedSource(catalogPath, parsed.diagnostics);
    catalogs.push(parsed.document);
  }
  const built = buildStructuredCatalogRegistry(catalogs);
  if (!built.success) {
    throw invalidIndexedSource(`${source.documentType.id} Structured Catalog Registry`, built.diagnostics);
  }
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

function invalidIndexedSource(sourcePath: string, diagnostics: readonly unknown[]): VisualBridgeMcpError {
  return new VisualBridgeMcpError(
    "lifecycle.invalidSource",
    `Source '${sourcePath}' is invalid and cannot participate in Document Lifecycle.`,
    diagnostics,
  );
}

function fileTitle(sourcePath: string): string {
  return path.basename(sourcePath, path.extname(sourcePath));
}

function decodeUtf8(bytes: Uint8Array, sourcePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    throw new VisualBridgeMcpError(
      "file.invalidUtf8",
      `File '${sourcePath}' is not valid UTF-8: ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`,
    );
  }
}
