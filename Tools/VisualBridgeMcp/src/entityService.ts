import { readFile } from "node:fs/promises";
import { buildCatalogBundle, type DocumentDiagnostic, type JsonValue } from "@visualbridge/core";
import {
  entityCatalogAdapter,
  entityDocumentAdapter,
  entityTextDocumentCodec,
  searchEntityComponentTypes,
  type EntityCatalogRegistry,
  type EntityDocument,
} from "@visualbridge/entity";
import { applyAtomicTextFileEdit, hashBytes } from "./atomicTextFile.js";
import type { DocumentCatalogRequest, DocumentRequest } from "./documentAdapterRegistry.js";
import { pageItems } from "./pagination.js";
import {
  VisualBridgeMcpError,
  VisualBridgeWorkspace,
  resolveExistingProjectPath,
  type DeclaredDocumentContext,
  type ProjectContext,
} from "./projectWorkspace.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";

interface CatalogContext {
  readonly project: ProjectContext;
  readonly documentTypeId: string;
  readonly catalogPaths: readonly string[];
  readonly registry: EntityCatalogRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface LoadedEntity {
  readonly context: DeclaredDocumentContext;
  readonly baseHash: string;
  readonly document?: EntityDocument;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly catalog: CatalogContext;
}

export class EntityService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
  ) {}

  public async queryCatalog(request: DocumentCatalogRequest): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveDocumentType("entity", request.projectFile, request.documentTypeId);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.id, resolved.documentType.catalogs);
    const base = {
      projectId: resolved.project.definition.projectId,
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      editor: resolved.documentType.editor,
      catalogPaths: catalog.catalogPaths,
      catalogs: catalog.registry.catalogs,
      diagnostics: catalog.diagnostics,
    };
    const kind = request.kind ?? "summary";
    if (request.action === "read") {
      switch (kind) {
        case "summary":
          return {
            ...base,
            counts: {
              componentGroups: catalog.registry.componentGroups.length,
              entityTypes: catalog.registry.entityTypes.length,
              componentTypes: catalog.registry.componentTypes.length,
            },
          };
        case "componentGroups":
          return { ...base, definitions: catalog.registry.componentGroups };
        case "entityTypes":
          return { ...base, definitions: catalog.registry.entityTypes };
        case "componentTypes":
          return { ...base, definitions: catalog.registry.componentTypes };
        default:
          throw new VisualBridgeMcpError("catalog.kindUnsupported", `Entity Catalog kind '${kind}' is not supported.`);
      }
    }
    const definitions = this.searchCatalog(catalog.registry, kind, request.query, request.selector);
    const page = pageItems(definitions, request.cursor, request.limit, catalogCursorScope(request, "entity", kind));
    return { ...base, kind, query: request.query, results: page.items, nextCursor: page.nextCursor };
  }

  public async executeDocument(request: DocumentRequest): Promise<Record<string, unknown>> {
    switch (request.action) {
      case "read":
        return this.readDocument(request.path, request.projectFile, request.documentTypeId);
      case "validate":
        return this.validateDocument(request.path, request.projectFile, request.documentTypeId);
      case "search":
        return this.searchDocument(request);
      case "apply":
        if (request.baseHash === undefined || request.operations === undefined) {
          throw new VisualBridgeMcpError("document.invalidApply", "Apply requires baseHash and operations.");
        }
        return this.applyOperations({
          ...(request.projectFile === undefined ? {} : { projectFile: request.projectFile }),
          ...(request.documentTypeId === undefined ? {} : { documentTypeId: request.documentTypeId }),
          path: request.path,
          baseHash: request.baseHash,
          operations: request.operations,
        });
    }
  }

  private async readDocument(
    documentPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    const loaded = await this.loadDocument(documentPath, projectFile, documentTypeId);
    return {
      ...documentIdentity(loaded),
      valid: !hasErrors(loaded.diagnostics),
      ...(loaded.document === undefined ? {} : { document: loaded.document }),
      diagnostics: loaded.diagnostics,
    };
  }

  private async validateDocument(
    documentPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    const loaded = await this.loadDocument(documentPath, projectFile, documentTypeId);
    return {
      ...documentIdentity(loaded),
      valid: !hasErrors(loaded.diagnostics),
      diagnostics: loaded.diagnostics,
    };
  }

  private async searchDocument(request: DocumentRequest): Promise<Record<string, unknown>> {
    const loaded = await this.loadDocument(request.path, request.projectFile, request.documentTypeId);
    if (loaded.document === undefined) {
      const page = pageItems([], request.cursor, request.limit, documentCursorScope(request, "entity"));
      return {
        ...documentIdentity(loaded),
        valid: false,
        query: request.query,
        results: page.items,
        diagnostics: loaded.diagnostics,
      };
    }
    const query = request.query.trim().toLocaleLowerCase();
    const results = entitySearchEntries(loaded.document).filter((entry) =>
      query.length === 0 || entry.searchText.includes(query));
    const page = pageItems(
      results.map(({ searchText: _searchText, ...entry }) => entry),
      request.cursor,
      request.limit,
      documentCursorScope(request, "entity"),
    );
    return {
      ...documentIdentity(loaded),
      valid: !hasErrors(loaded.diagnostics),
      query: request.query,
      results: page.items,
      nextCursor: page.nextCursor,
      diagnostics: loaded.diagnostics,
    };
  }

  private async applyOperations(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly path: string;
    readonly baseHash: string;
    readonly operations: unknown;
  }): Promise<Record<string, unknown>> {
    const context = await this.workspace.resolveDeclaredDocument(
      options.path,
      "entity",
      options.projectFile,
      options.documentTypeId,
    );
    return applyAtomicTextFileEdit({
      projectRoot: context.project.projectRoot,
      absolutePath: context.absolutePath,
      resolveAbsolutePath: () => resolveExistingProjectPath(context.project, context.path),
      expectedBaseHash: options.baseHash,
      metadata: documentTarget(context),
      verificationErrorCode: "entity.atomicWriteVerificationFailed",
      subject: `Entity '${context.path}'`,
    }, async (bytes) => {
      const catalog = await this.loadCatalog(context.project, context.documentType.id, context.documentType.catalogs);
      const semanticContext = { registry: catalog.registry };
      const parseResult = await entityTextDocumentCodec.parse(decodeUtf8(bytes, context.path), semanticContext);
      if (!parseResult.success) {
        return { valid: false, diagnostics: [...catalog.diagnostics, ...parseResult.diagnostics] };
      }
      const lifecycleGuard = entityLifecycleGuard(options.operations);
      if (lifecycleGuard.length > 0) {
        return { valid: false, diagnostics: lifecycleGuard };
      }
      const operationResult = entityDocumentAdapter.applyOperations(parseResult.document, options.operations, semanticContext);
      if (!operationResult.success) {
        return { valid: false, diagnostics: operationResult.diagnostics };
      }
      const referenceResult = await this.references.validateChange(
        context.project.projectFile,
        entityDocumentAdapter.collectReferences(parseResult.document, semanticContext),
        entityDocumentAdapter.collectReferences(operationResult.document, semanticContext),
      );
      if (referenceResult.introducedErrors.length > 0) {
        return { valid: false, diagnostics: referenceResult.introducedErrors };
      }
      const nextBytes = Buffer.from(
        await entityTextDocumentCodec.render(operationResult.document, "", semanticContext),
        "utf8",
      );
      const providerDiagnostics = await this.references.validateProviderDocument(context.project.projectFile, {
        documentTypeId: context.documentType.id,
        path: context.path,
        sourceHash: hashBytes(nextBytes),
        content: operationResult.document as unknown as JsonValue,
      });
      if (providerDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return { valid: false, diagnostics: providerDiagnostics };
      }
      return {
        valid: true,
        nextBytes,
        diagnostics: [...operationResult.diagnostics, ...referenceResult.diagnostics, ...providerDiagnostics],
      };
    });
  }

  private async loadDocument(
    documentPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<LoadedEntity> {
    const context = await this.workspace.resolveDocument(documentPath, "entity", projectFile, documentTypeId);
    const bytes = await readFile(context.absolutePath);
    const catalog = await this.loadCatalog(context.project, context.documentType.id, context.documentType.catalogs);
    const semanticContext = { registry: catalog.registry };
    const parseResult = await entityTextDocumentCodec.parse(decodeUtf8(bytes, context.path), semanticContext);
    if (!parseResult.success) {
      return {
        context,
        baseHash: hashBytes(bytes),
        diagnostics: [...catalog.diagnostics, ...parseResult.diagnostics],
        catalog,
      };
    }
    const baseHash = hashBytes(bytes);
    const diagnostics = [
      ...catalog.diagnostics,
      ...parseResult.diagnostics,
      ...entityDocumentAdapter.validate(parseResult.document, semanticContext),
      ...await this.references.validate(
        context.project.projectFile,
        entityDocumentAdapter.collectReferences(parseResult.document, semanticContext),
      ),
      ...await this.references.validateProviderDocument(context.project.projectFile, {
        documentTypeId: context.documentType.id,
        path: context.path,
        sourceHash: baseHash,
        content: parseResult.document as unknown as JsonValue,
      }),
    ];
    return { context, baseHash, document: parseResult.document, diagnostics, catalog };
  }

  private async loadCatalog(
    project: ProjectContext,
    documentTypeId: string,
    catalogPaths: readonly string[],
  ): Promise<CatalogContext> {
    if (catalogPaths.length === 0) {
      throw new VisualBridgeMcpError(
        "entity.catalogsNotConfigured",
        `Entity Document Type '${documentTypeId}' does not declare any Catalogs.`,
      );
    }
    const sources = await Promise.all(catalogPaths.map(async (catalogPath) => ({
      path: catalogPath,
      text: decodeUtf8(await readFile(await resolveExistingProjectPath(project, catalogPath)), catalogPath),
    })));
    const bundle = buildCatalogBundle(sources, entityCatalogAdapter);
    if (bundle.registry === undefined) {
      throw new VisualBridgeMcpError(
        "entity.catalogInvalid",
        `Entity Catalog Registry for Document Type '${documentTypeId}' is invalid.`,
        bundle.diagnostics,
      );
    }
    return {
      project,
      documentTypeId,
      catalogPaths: bundle.paths,
      registry: bundle.registry,
      diagnostics: bundle.diagnostics,
    };
  }

  private searchCatalog(
    registry: EntityCatalogRegistry,
    kind: string,
    query: string,
    selector: Readonly<Record<string, unknown>>,
  ): readonly unknown[] {
    if (kind === "componentTypes") {
      const entityTypeId = optionalString(selector.entityTypeId, "selector.entityTypeId");
      return searchEntityComponentTypes(registry, {
        query,
        ...(entityTypeId === undefined ? {} : { entityTypeId }),
        limit: Math.max(1, registry.componentTypes.length),
      });
    }
    const source = kind === "entityTypes"
      ? registry.entityTypes
      : kind === "componentGroups"
        ? registry.componentGroups
        : undefined;
    if (source === undefined) {
      throw new VisualBridgeMcpError("catalog.kindUnsupported", `Entity Catalog kind '${kind}' is not searchable.`);
    }
    const terms = queryTerms(query);
    return source
      .filter((definition) => terms.every((term) => JSON.stringify(definition).toLocaleLowerCase().includes(term)))
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }
}

function entityLifecycleGuard(value: unknown): readonly DocumentDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const type = typeof entry === "object" && entry !== null
      ? (entry as { readonly type?: unknown }).type
      : undefined;
    if (type !== "entity.renameComponent" && type !== "entity.removeComponent") return [];
    return [{
      severity: "error" as const,
      code: "lifecycle.required",
      path: `operations[${index}].type`,
      message: type === "entity.renameComponent"
        ? "Stable Component IDs must be changed through visualbridge_refactor_reference."
        : "Referenced Components must be removed through visualbridge_document_lifecycle safe delete.",
    }];
  });
}

function catalogCursorScope(request: DocumentCatalogRequest, editor: string, kind: string): unknown {
  return {
    tool: "visualbridge_catalog",
    action: request.action,
    projectFile: request.projectFile,
    documentTypeId: request.documentTypeId,
    editor,
    kind,
    query: request.query,
    selector: request.selector,
  };
}

function documentCursorScope(request: DocumentRequest, editor: string): unknown {
  return {
    tool: "visualbridge_document",
    action: request.action,
    projectFile: request.projectFile,
    documentTypeId: request.documentTypeId,
    editor,
    path: request.path,
    query: request.query,
    selector: request.selector,
  };
}

function documentIdentity(loaded: LoadedEntity): Record<string, unknown> {
  return {
    ...documentTarget(loaded.context),
    baseHash: loaded.baseHash,
    sources: [{ path: loaded.context.path, hash: loaded.baseHash }],
  };
}

function documentTarget(context: DeclaredDocumentContext): Record<string, unknown> {
  return {
    projectId: context.project.definition.projectId,
    projectFile: context.project.projectFile,
    documentTypeId: context.documentType.id,
    editor: context.documentType.editor,
    path: context.path,
  };
}

function entitySearchEntries(document: EntityDocument): readonly (Record<string, unknown> & { searchText: string })[] {
  const entries: (Record<string, unknown> & { searchText: string })[] = [{
    kind: "entity",
    id: document.documentId,
    entityTypeId: document.entityTypeId,
    title: document.title,
    path: "$",
    searchText: `${document.documentId} ${document.entityTypeId} ${document.title}`.toLocaleLowerCase(),
  }];
  collectValueEntries(document.properties, "properties", undefined, entries);
  document.components.forEach((component, index) => {
    entries.push({
      kind: "component",
      id: component.id,
      componentId: component.id,
      componentTypeId: component.componentTypeId,
      enabled: component.enabled,
      path: `components[${index}]`,
      searchText: `${component.id} ${component.componentTypeId}`.toLocaleLowerCase(),
    });
    collectValueEntries(component.properties, `components[${index}].properties`, component.id, entries);
  });
  return entries;
}

function collectValueEntries(
  value: unknown,
  path: string,
  componentId: string | undefined,
  entries: (Record<string, unknown> & { searchText: string })[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectValueEntries(entry, `${path}[${index}]`, componentId, entries));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).forEach(([key, entry]) =>
      collectValueEntries(entry, `${path}.${key}`, componentId, entries));
    return;
  }
  const text = String(value);
  entries.push({
    kind: "field",
    path,
    ...(componentId === undefined ? {} : { componentId }),
    value,
    searchText: `${path} ${text}`.toLocaleLowerCase(),
  });
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new VisualBridgeMcpError("request.invalidSelector", `${path} must be a string.`);
  }
  return value;
}

function queryTerms(query: string): readonly string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 0);
}

function decodeUtf8(bytes: Uint8Array, displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    throw new VisualBridgeMcpError(
      "file.invalidUtf8",
      `File '${displayPath}' is not valid UTF-8: ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`,
    );
  }
}

function hasErrors(diagnostics: readonly DocumentDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
