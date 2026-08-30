import { readFile } from "node:fs/promises";
import { buildCatalogBundle, compareUtf16CodeUnits, type DocumentDiagnostic, type JsonValue } from "@visualbridge/core";
import {
  resolveStructuredConfigType,
  structuredCatalogAdapter,
  structuredDocumentAdapter,
  structuredTextDocumentCodec,
  type StructuredCatalogRegistry,
  type StructuredDocument,
} from "@visualbridge/structured";
import { applyAtomicTextFileEdit, hashBytes } from "./atomicTextFile.js";
import type { DocumentCatalogRequest, DocumentRequest } from "./documentAdapterRegistry.js";
import { pageItems } from "./pagination.js";
import {
  VisualBridgeMcpError,
  VisualBridgeWorkspace,
  resolveExistingProjectPath,
  type ProjectContext,
  type StructuredDocumentContext,
} from "./projectWorkspace.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";

interface CatalogContext {
  readonly project: ProjectContext;
  readonly documentTypeId: string;
  readonly catalogPaths: readonly string[];
  readonly registry: StructuredCatalogRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export class StructuredService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
  ) {}

  public async queryCatalog(request: DocumentCatalogRequest): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveDocumentType("structured", request.projectFile, request.documentTypeId);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.id, resolved.documentType.catalogs);
    const requiredConfigType = resolveStructuredConfigType(catalog.registry, resolved.documentType.id);
    const base = {
      projectId: resolved.project.definition.projectId,
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      editor: resolved.documentType.editor,
      catalogPaths: catalog.catalogPaths,
      catalogs: catalog.registry.catalogs,
      requiredConfigTypeId: requiredConfigType?.id,
      diagnostics: catalog.diagnostics,
    };
    const kind = request.kind ?? "summary";
    if (request.action === "read") {
      if (kind === "summary") {
        return { ...base, counts: { configTypes: catalog.registry.configTypes.length } };
      }
      if (kind === "configTypes") {
        return { ...base, definitions: catalog.registry.configTypes };
      }
      throw new VisualBridgeMcpError("catalog.kindUnsupported", `Structured Catalog kind '${kind}' is not supported.`);
    }
    if (kind !== "configTypes") {
      throw new VisualBridgeMcpError("catalog.kindUnsupported", `Structured Catalog kind '${kind}' is not searchable.`);
    }
    const query = request.query.trim().toLowerCase();
    const definitions = catalog.registry.configTypes
      .filter((definition) => query.length === 0 || JSON.stringify(definition).toLowerCase().includes(query))
      .sort((left, right) => compareUtf16CodeUnits(left.title, right.title) || compareUtf16CodeUnits(left.id, right.id));
    const page = pageItems(definitions, request.cursor, request.limit, catalogCursorScope(request, kind));
    return { ...base, kind, query: request.query, results: page.items, nextCursor: page.nextCursor };
  }

  public async executeDocument(request: DocumentRequest): Promise<Record<string, unknown>> {
    if (request.action === "apply") {
      if (request.baseHash === undefined || request.operations === undefined) {
        throw new VisualBridgeMcpError("document.invalidApply", "Apply requires baseHash and operations.");
      }
      return this.applyOperations({
        ...(request.projectFile === undefined ? {} : { projectFile: request.projectFile }),
        ...(request.documentTypeId === undefined ? {} : { documentTypeId: request.documentTypeId }),
        structuredPath: request.path,
        baseHash: request.baseHash,
        operations: request.operations,
      });
    }
    const loaded = await this.loadDocument(request.path, request.projectFile, request.documentTypeId);
    if (request.action === "validate") {
      return { ...structuredIdentity(loaded), valid: loaded.valid, diagnostics: loaded.diagnostics };
    }
    if (request.action === "read") {
      return {
        ...structuredIdentity(loaded),
        valid: loaded.valid,
        ...(loaded.document === undefined ? {} : {
          document: loaded.document,
          configType: loaded.configType,
        }),
        diagnostics: loaded.diagnostics,
      };
    }
    const query = request.query.trim().toLowerCase();
    const entries: (Record<string, unknown> & { searchText: string })[] = [];
    if (loaded.document !== undefined) {
      collectStructuredSearchValues(loaded.document.properties, "properties", entries);
    }
    const filtered = entries.filter((entry) => query.length === 0 || entry.searchText.includes(query));
    const page = pageItems(
      filtered.map(({ searchText: _searchText, ...entry }) => entry),
      request.cursor,
      request.limit,
      documentCursorScope(request),
    );
    return {
      ...structuredIdentity(loaded),
      valid: loaded.valid,
      query: request.query,
      results: page.items,
      nextCursor: page.nextCursor,
      diagnostics: loaded.diagnostics,
    };
  }

  public async applyOperations(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly structuredPath: string;
    readonly baseHash: string;
    readonly operations: unknown;
  }): Promise<Record<string, unknown>> {
    const context = await this.workspace.resolveDeclaredDocument(
      options.structuredPath,
      "structured",
      options.projectFile,
      options.documentTypeId,
    );
    return applyAtomicTextFileEdit({
      projectRoot: context.project.projectRoot,
      absolutePath: context.absolutePath,
      resolveAbsolutePath: () => resolveExistingProjectPath(context.project, context.path),
      expectedBaseHash: options.baseHash,
      metadata: {
        projectId: context.project.definition.projectId,
        projectFile: context.project.projectFile,
        documentTypeId: context.documentType.id,
        editor: context.documentType.editor,
        path: context.path,
      },
      verificationErrorCode: "structured.atomicWriteVerificationFailed",
      subject: `Structured Config '${context.path}'`,
    }, async (bytes) => {
      const catalog = await this.loadCatalog(
        context.project,
        context.documentType.id,
        context.documentType.catalogs,
      );
      const semanticContext = { registry: catalog.registry, configTypeId: context.documentType.id };
      const parseResult = await structuredTextDocumentCodec.parse(
        decodeUtf8(bytes, context.path),
        semanticContext,
      );
      if (!parseResult.success) {
        return { valid: false, diagnostics: [...catalog.diagnostics, ...parseResult.diagnostics] };
      }
      const operationResult = structuredDocumentAdapter.applyOperations(
        parseResult.document,
        options.operations,
        semanticContext,
      );
      if (!operationResult.success) {
        return { valid: false, diagnostics: operationResult.diagnostics };
      }
      const referenceResult = await this.references.validateChange(
        context.project.projectFile,
        structuredDocumentAdapter.collectReferences(parseResult.document, semanticContext),
        structuredDocumentAdapter.collectReferences(operationResult.document, semanticContext),
      );
      if (referenceResult.introducedErrors.length > 0) {
        return { valid: false, diagnostics: referenceResult.introducedErrors };
      }
      const nextBytes = Buffer.from(
        await structuredTextDocumentCodec.render(operationResult.document, "", semanticContext),
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
    structuredPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<{
    readonly context: StructuredDocumentContext;
    readonly baseHash: string;
    readonly document?: StructuredDocument;
    readonly configType?: unknown;
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly valid: boolean;
  }> {
    const context = await this.workspace.resolveStructuredDocument(structuredPath, projectFile, documentTypeId);
    const bytes = await readFile(context.absoluteStructuredPath);
    const baseHash = hashBytes(bytes);
    const catalog = await this.loadCatalog(context.project, context.documentType.id, context.documentType.catalogs);
    const semanticContext = { registry: catalog.registry, configTypeId: context.documentType.id };
    const parsed = await structuredTextDocumentCodec.parse(decodeUtf8(bytes, context.structuredPath), semanticContext);
    if (!parsed.success) {
      const diagnostics = [...catalog.diagnostics, ...parsed.diagnostics];
      return { context, baseHash, diagnostics, valid: false };
    }
    const diagnostics = [
      ...catalog.diagnostics,
      ...parsed.diagnostics,
      ...structuredDocumentAdapter.validate(parsed.document, semanticContext),
      ...await this.references.validate(
        context.project.projectFile,
        structuredDocumentAdapter.collectReferences(parsed.document, semanticContext),
      ),
      ...await this.references.validateProviderDocument(context.project.projectFile, {
        documentTypeId: context.documentType.id,
        path: context.path,
        sourceHash: baseHash,
        content: parsed.document as unknown as JsonValue,
      }),
    ];
    return {
      context,
      baseHash,
      document: parsed.document,
      configType: resolveStructuredConfigType(catalog.registry, context.documentType.id),
      diagnostics,
      valid: !hasErrors(diagnostics),
    };
  }

  private async loadCatalog(
    project: ProjectContext,
    documentTypeId: string,
    catalogPaths: readonly string[],
  ): Promise<CatalogContext> {
    if (catalogPaths.length === 0) {
      throw new VisualBridgeMcpError(
        "structured.catalogsNotConfigured",
        `Structured Document Type '${documentTypeId}' does not declare any Catalogs.`,
      );
    }
    const sources = await Promise.all(catalogPaths.map(async (catalogPath) => ({
      path: catalogPath,
      text: decodeUtf8(await readFile(await resolveExistingProjectPath(project, catalogPath)), catalogPath),
    })));
    const bundle = buildCatalogBundle(sources, structuredCatalogAdapter);
    if (bundle.registry === undefined) {
      throw new VisualBridgeMcpError(
        "structured.catalogInvalid",
        `Structured Catalog Registry for Document Type '${documentTypeId}' is invalid.`,
        bundle.diagnostics,
      );
    }
    if (resolveStructuredConfigType(bundle.registry, documentTypeId) === undefined) {
      throw new VisualBridgeMcpError(
        "structured.documentTypeUnbound",
        `Structured Document Type '${documentTypeId}' does not resolve to a Config Type ID or alias.`,
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
}

function catalogCursorScope(request: DocumentCatalogRequest, kind: string): unknown {
  return {
    tool: "visualbridge_catalog",
    action: request.action,
    projectFile: request.projectFile,
    documentTypeId: request.documentTypeId,
    editor: "structured",
    kind,
    query: request.query,
    selector: request.selector,
  };
}

function documentCursorScope(request: DocumentRequest): unknown {
  return {
    tool: "visualbridge_document",
    action: request.action,
    projectFile: request.projectFile,
    documentTypeId: request.documentTypeId,
    editor: "structured",
    path: request.path,
    query: request.query,
    selector: request.selector,
  };
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

function structuredIdentity(loaded: {
  readonly context: StructuredDocumentContext;
  readonly baseHash: string;
}): Record<string, unknown> {
  return {
    projectId: loaded.context.project.definition.projectId,
    projectFile: loaded.context.project.projectFile,
    documentTypeId: loaded.context.documentType.id,
    editor: loaded.context.documentType.editor,
    path: loaded.context.structuredPath,
    baseHash: loaded.baseHash,
    sources: [{ path: loaded.context.structuredPath, hash: loaded.baseHash }],
  };
}

function collectStructuredSearchValues(
  value: unknown,
  path: string,
  entries: (Record<string, unknown> & { searchText: string })[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStructuredSearchValues(entry, `${path}[${index}]`, entries));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value).sort(([left], [right]) => compareUtf16CodeUnits(left, right)).forEach(([key, entry]) =>
      collectStructuredSearchValues(entry, `${path}.${key}`, entries));
    return;
  }
  entries.push({
    kind: "field",
    path,
    value,
    searchText: `${path} ${String(value)}`.toLowerCase(),
  });
}
