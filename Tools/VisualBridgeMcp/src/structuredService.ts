import { readFile } from "node:fs/promises";
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  applyStructuredOperations,
  buildStructuredCatalogRegistry,
  collectStructuredReferences,
  parseStructuredCatalog,
  parseStructuredDocument,
  resolveStructuredConfigType,
  serializeStructuredDocument,
  validateStructuredDocument,
  type StructuredCatalog,
  type StructuredCatalogRegistry,
  type StructuredDocument,
} from "@visualbridge/structured";
import { applyAtomicTextFileEdit, hashBytes } from "./atomicTextFile.js";
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

interface LoadedStructuredDocument {
  readonly context: StructuredDocumentContext;
  readonly baseHash: string;
  readonly document: StructuredDocument;
  readonly parseDiagnostics: readonly DocumentDiagnostic[];
  readonly catalog: CatalogContext;
}

export class StructuredService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
  ) {}

  public async queryCatalog(
    projectFile: string | undefined,
    documentTypeId: string | undefined,
    view: "summary" | "configTypes",
  ): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveStructuredDocumentType(projectFile, documentTypeId);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.id, resolved.documentType.catalogs);
    const requiredConfigType = resolveStructuredConfigType(catalog.registry, resolved.documentType.id);
    const base = {
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      catalogPaths: catalog.catalogPaths,
      catalogs: catalog.registry.catalogs,
      requiredConfigTypeId: requiredConfigType?.id,
      diagnostics: catalog.diagnostics,
    };
    return view === "configTypes"
      ? { ...base, configTypes: catalog.registry.configTypes }
      : { ...base, counts: { configTypes: catalog.registry.configTypes.length } };
  }

  public async readDocument(
    structuredPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    const loaded = await this.loadDocument(structuredPath, projectFile, documentTypeId);
    const diagnostics = await this.validateLoaded(loaded);
    return {
      projectFile: loaded.context.project.projectFile,
      documentTypeId: loaded.context.documentType.id,
      path: loaded.context.structuredPath,
      baseHash: loaded.baseHash,
      document: loaded.document,
      configType: resolveStructuredConfigType(loaded.catalog.registry, loaded.context.documentType.id),
      diagnostics,
    };
  }

  public async validateDocument(
    structuredPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    const context = await this.workspace.resolveStructuredDocument(structuredPath, projectFile, documentTypeId);
    const bytes = await readFile(context.absoluteStructuredPath);
    const baseHash = hashBytes(bytes);
    const catalog = await this.loadCatalog(
      context.project,
      context.documentType.id,
      context.documentType.catalogs,
    );
    const parseResult = parseStructuredDocument(decodeUtf8(bytes, context.structuredPath));
    if (!parseResult.success) {
      const diagnostics = [...catalog.diagnostics, ...parseResult.diagnostics];
      return {
        projectFile: context.project.projectFile,
        documentTypeId: context.documentType.id,
        path: context.structuredPath,
        baseHash,
        valid: false,
        diagnostics,
      };
    }
    const loaded: LoadedStructuredDocument = {
      context,
      baseHash,
      document: parseResult.document,
      parseDiagnostics: parseResult.diagnostics,
      catalog,
    };
    const diagnostics = await this.validateLoaded(loaded);
    return {
      projectFile: context.project.projectFile,
      documentTypeId: context.documentType.id,
      path: context.structuredPath,
      baseHash,
      valid: !hasErrors(diagnostics),
      diagnostics,
    };
  }

  public async applyOperations(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly structuredPath: string;
    readonly baseHash: string;
    readonly operations: unknown;
  }): Promise<Record<string, unknown>> {
    const context = await this.workspace.resolveStructuredDocument(
      options.structuredPath,
      options.projectFile,
      options.documentTypeId,
    );
    return applyAtomicTextFileEdit({
      absolutePath: context.absoluteStructuredPath,
      expectedBaseHash: options.baseHash,
      metadata: {
        projectFile: context.project.projectFile,
        documentTypeId: context.documentType.id,
        path: context.structuredPath,
      },
      verificationErrorCode: "structured.atomicWriteVerificationFailed",
      subject: `Structured Config '${context.structuredPath}'`,
    }, async (bytes) => {
      const catalog = await this.loadCatalog(
        context.project,
        context.documentType.id,
        context.documentType.catalogs,
      );
      const parseResult = parseStructuredDocument(decodeUtf8(bytes, context.structuredPath));
      if (!parseResult.success) {
        return { valid: false, diagnostics: [...catalog.diagnostics, ...parseResult.diagnostics] };
      }
      const operationResult = applyStructuredOperations(
        parseResult.document,
        options.operations,
        catalog.registry,
        context.documentType.id,
      );
      if (!operationResult.success) {
        return { valid: false, diagnostics: operationResult.diagnostics };
      }
      const referenceResult = await this.references.validateChange(
        context.project.projectFile,
        collectStructuredReferences(parseResult.document, catalog.registry, context.documentType.id),
        collectStructuredReferences(operationResult.document, catalog.registry, context.documentType.id),
      );
      if (referenceResult.introducedErrors.length > 0) {
        return { valid: false, diagnostics: referenceResult.introducedErrors };
      }
      return {
        valid: true,
        nextBytes: Buffer.from(serializeStructuredDocument(operationResult.document), "utf8"),
        diagnostics: [...operationResult.diagnostics, ...referenceResult.diagnostics],
      };
    });
  }

  private async loadDocument(
    structuredPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<LoadedStructuredDocument> {
    const context = await this.workspace.resolveStructuredDocument(structuredPath, projectFile, documentTypeId);
    const bytes = await readFile(context.absoluteStructuredPath);
    const parseResult = parseStructuredDocument(decodeUtf8(bytes, context.structuredPath));
    if (!parseResult.success) {
      throw new VisualBridgeMcpError(
        "structured.parseFailed",
        `Structured Config '${context.structuredPath}' is structurally invalid.`,
        parseResult.diagnostics,
      );
    }
    return {
      context,
      baseHash: hashBytes(bytes),
      document: parseResult.document,
      parseDiagnostics: parseResult.diagnostics,
      catalog: await this.loadCatalog(
        context.project,
        context.documentType.id,
        context.documentType.catalogs,
      ),
    };
  }

  private async validateLoaded(loaded: LoadedStructuredDocument): Promise<readonly DocumentDiagnostic[]> {
    return [
      ...loaded.catalog.diagnostics,
      ...loaded.parseDiagnostics,
      ...validateStructuredDocument(
        loaded.document,
        loaded.catalog.registry,
        loaded.context.documentType.id,
      ),
      ...await this.references.validate(
        loaded.context.project.projectFile,
        collectStructuredReferences(
          loaded.document,
          loaded.catalog.registry,
          loaded.context.documentType.id,
        ),
      ),
    ];
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
    const catalogs: StructuredCatalog[] = [];
    const sourceIndexes: number[] = [];
    const diagnostics: DocumentDiagnostic[] = [];
    for (const [catalogIndex, catalogPath] of catalogPaths.entries()) {
      const absoluteCatalogPath = await resolveExistingProjectPath(project, catalogPath);
      const parseResult = parseStructuredCatalog(decodeUtf8(await readFile(absoluteCatalogPath), catalogPath));
      diagnostics.push(...parseResult.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `catalogs[${catalogIndex}].${diagnostic.path}`,
      })));
      if (parseResult.success) {
        catalogs.push(parseResult.document);
        sourceIndexes.push(catalogIndex);
      }
    }
    const registryResult = buildStructuredCatalogRegistry(catalogs);
    diagnostics.push(...registryResult.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: diagnostic.path.replace(/^catalogs\[(\d+)\]/, (match, indexText: string) => {
        const sourceIndex = sourceIndexes[Number(indexText)];
        return sourceIndex === undefined ? match : `catalogs[${sourceIndex}]`;
      }),
    })));
    if (!registryResult.success || hasErrors(diagnostics)) {
      throw new VisualBridgeMcpError(
        "structured.catalogInvalid",
        `Structured Catalog Registry for Document Type '${documentTypeId}' is invalid.`,
        diagnostics,
      );
    }
    if (resolveStructuredConfigType(registryResult.document, documentTypeId) === undefined) {
      throw new VisualBridgeMcpError(
        "structured.documentTypeUnbound",
        `Structured Document Type '${documentTypeId}' does not resolve to a Config Type ID or alias.`,
      );
    }
    return {
      project,
      documentTypeId,
      catalogPaths,
      registry: registryResult.document,
      diagnostics,
    };
  }
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
