import { readFile } from "node:fs/promises";
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  applyGraphOperations,
  collectGraphReferences,
  buildGraphCatalogRegistry,
  parseGraphCatalog,
  parseGraphDocument,
  searchGraphNodeTypes,
  serializeGraphDocument,
  validateGraphDocument,
  type GraphCatalog,
  type GraphCatalogRegistry,
  type GraphDocument,
} from "@visualbridge/graph";
import {
  VisualBridgeMcpError,
  VisualBridgeWorkspace,
  resolveExistingProjectPath,
  type GraphDocumentContext,
  type ProjectContext,
} from "./projectWorkspace.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";
import { applyAtomicTextFileEdit, hashBytes } from "./atomicTextFile.js";

interface CatalogContext {
  readonly project: ProjectContext;
  readonly documentTypeId: string;
  readonly catalogPaths: readonly string[];
  readonly registry: GraphCatalogRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface LoadedGraph {
  readonly context: GraphDocumentContext;
  readonly bytes: Buffer;
  readonly baseHash: string;
  readonly document: GraphDocument;
  readonly parseDiagnostics: readonly DocumentDiagnostic[];
  readonly catalog: CatalogContext;
}

export class GraphService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
  ) {}

  public async queryCatalog(
    projectFile: string | undefined,
    documentTypeId: string | undefined,
    view: "summary" | "dataTypes" | "graphTypes" | "nodeTypes",
  ): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveGraphDocumentType(projectFile, documentTypeId);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.id, resolved.documentType.catalogs);
    const base = {
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      catalogPaths: catalog.catalogPaths,
      catalogs: catalog.registry.catalogs,
      diagnostics: catalog.diagnostics,
    };
    switch (view) {
      case "dataTypes":
        return { ...base, dataTypes: catalog.registry.dataTypes };
      case "graphTypes":
        return { ...base, graphTypes: catalog.registry.graphTypes };
      case "nodeTypes":
        return { ...base, nodeTypes: catalog.registry.nodeTypes };
      default:
        return {
          ...base,
          counts: {
            dataTypes: catalog.registry.dataTypes.length,
            graphTypes: catalog.registry.graphTypes.length,
            nodeTypes: catalog.registry.nodeTypes.length,
          },
        };
    }
  }

  public async readGraph(
    graphPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    const loaded = await this.loadGraph(graphPath, projectFile, documentTypeId);
    const diagnostics = [
      ...loaded.catalog.diagnostics,
      ...loaded.parseDiagnostics,
      ...validateGraphDocument(loaded.document, loaded.catalog.registry),
      ...await this.references.validate(
        loaded.context.project.projectFile,
        collectGraphReferences(loaded.document, loaded.catalog.registry),
      ),
    ];
    return {
      projectFile: loaded.context.project.projectFile,
      documentTypeId: loaded.context.documentType.id,
      path: loaded.context.graphPath,
      baseHash: loaded.baseHash,
      document: loaded.document,
      diagnostics,
    };
  }

  public async validateGraph(
    graphPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    const context = await this.workspace.resolveGraphDocument(graphPath, projectFile, documentTypeId);
    const bytes = await readFile(context.absoluteGraphPath);
    const baseHash = hashBytes(bytes);
    const catalog = await this.loadCatalog(
      context.project,
      context.documentType.id,
      context.documentType.catalogs,
    );
    const parseResult = parseGraphDocument(decodeUtf8(bytes, context.graphPath));
    if (!parseResult.success) {
      const diagnostics = [...catalog.diagnostics, ...parseResult.diagnostics];
      return {
        projectFile: context.project.projectFile,
        documentTypeId: context.documentType.id,
        path: context.graphPath,
        baseHash,
        valid: false,
        diagnostics,
      };
    }
    const diagnostics = [
      ...catalog.diagnostics,
      ...parseResult.diagnostics,
      ...validateGraphDocument(parseResult.document, catalog.registry),
      ...await this.references.validate(
        context.project.projectFile,
        collectGraphReferences(parseResult.document, catalog.registry),
      ),
    ];
    return {
      projectFile: context.project.projectFile,
      documentTypeId: context.documentType.id,
      path: context.graphPath,
      baseHash,
      valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics,
    };
  }

  public async searchNodes(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly query: string;
    readonly graphTypeId?: string;
    readonly includeSubgraphNodeTypes: boolean;
    readonly limit: number;
  }): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveGraphDocumentType(options.projectFile, options.documentTypeId);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.id, resolved.documentType.catalogs);
    const nodeTypes = searchGraphNodeTypes(catalog.registry, {
      query: options.query,
      ...(options.graphTypeId === undefined ? {} : { graphTypeId: options.graphTypeId }),
      includeSubgraphNodeTypes: options.includeSubgraphNodeTypes,
      limit: options.limit,
    });
    return {
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      query: options.query,
      graphTypeId: options.graphTypeId,
      results: nodeTypes.map((nodeType) => ({
        catalogId: nodeType.catalogId,
        catalogTitle: nodeType.catalogTitle,
        id: nodeType.id,
        aliases: nodeType.aliases,
        title: nodeType.title,
        displayPath: [nodeType.catalogTitle, ...nodeType.menuPath, nodeType.title],
        category: nodeType.category,
        tags: nodeType.tags,
        traits: nodeType.traits,
        subgraph: nodeType.subgraph,
        ports: nodeType.ports,
        dynamicPortGroups: nodeType.dynamicPortGroups,
        properties: nodeType.properties,
      })),
    };
  }

  public async applyOperations(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly graphPath: string;
    readonly baseHash: string;
    readonly operations: unknown;
  }): Promise<Record<string, unknown>> {
    const context = await this.workspace.resolveGraphDocument(
      options.graphPath,
      options.projectFile,
      options.documentTypeId,
    );
    return applyAtomicTextFileEdit({
      absolutePath: context.absoluteGraphPath,
      expectedBaseHash: options.baseHash,
      metadata: {
        projectFile: context.project.projectFile,
        documentTypeId: context.documentType.id,
        path: context.graphPath,
      },
      verificationErrorCode: "graph.atomicWriteVerificationFailed",
      subject: `Graph '${context.graphPath}'`,
    }, async (bytes) => {
      const catalog = await this.loadCatalog(
        context.project,
        context.documentType.id,
        context.documentType.catalogs,
      );
      const parseResult = parseGraphDocument(decodeUtf8(bytes, context.graphPath));
      if (!parseResult.success) {
        return { valid: false, diagnostics: [...catalog.diagnostics, ...parseResult.diagnostics] };
      }
      const operationResult = applyGraphOperations(parseResult.document, options.operations, catalog.registry);
      if (!operationResult.success) {
        return { valid: false, diagnostics: operationResult.diagnostics };
      }
      if (operationResult.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return { valid: false, diagnostics: operationResult.diagnostics };
      }
      const referenceResult = await this.references.validateChange(
        context.project.projectFile,
        collectGraphReferences(parseResult.document, catalog.registry),
        collectGraphReferences(operationResult.document, catalog.registry),
      );
      if (referenceResult.introducedErrors.length > 0) {
        return { valid: false, diagnostics: referenceResult.introducedErrors };
      }
      const operationDiagnostics = [...operationResult.diagnostics, ...referenceResult.diagnostics];
      return {
        valid: true,
        nextBytes: Buffer.from(serializeGraphDocument(operationResult.document), "utf8"),
        diagnostics: operationDiagnostics,
      };
    });
  }

  private async loadGraph(
    graphPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<LoadedGraph> {
    const context = await this.workspace.resolveGraphDocument(graphPath, projectFile, documentTypeId);
    const bytes = await readFile(context.absoluteGraphPath);
    const parseResult = parseGraphDocument(decodeUtf8(bytes, context.graphPath));
    if (!parseResult.success) {
      throw new VisualBridgeMcpError(
        "graph.parseFailed",
        `Graph '${context.graphPath}' is structurally invalid.`,
        parseResult.diagnostics,
      );
    }
    return {
      context,
      bytes,
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

  private async loadCatalog(
    project: ProjectContext,
    documentTypeId: string,
    catalogPaths: readonly string[],
  ): Promise<CatalogContext> {
    if (catalogPaths.length === 0) {
      throw new VisualBridgeMcpError(
        "graph.catalogsNotConfigured",
        `Graph Document Type '${documentTypeId}' does not declare any Catalogs.`,
      );
    }
    const catalogs: GraphCatalog[] = [];
    const sourceIndexes: number[] = [];
    const diagnostics: DocumentDiagnostic[] = [];
    for (const [catalogIndex, catalogPath] of catalogPaths.entries()) {
      const absoluteCatalogPath = await resolveExistingProjectPath(project, catalogPath);
      const parseResult = parseGraphCatalog(decodeUtf8(await readFile(absoluteCatalogPath), catalogPath));
      diagnostics.push(...parseResult.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `catalogs[${catalogIndex}].${diagnostic.path}`,
      })));
      if (parseResult.success) {
        catalogs.push(parseResult.document);
        sourceIndexes.push(catalogIndex);
      }
    }
    const registryResult = buildGraphCatalogRegistry(catalogs);
    diagnostics.push(...registryResult.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: diagnostic.path.replace(/^catalogs\[(\d+)\]/, (match, indexText: string) => {
        const sourceIndex = sourceIndexes[Number(indexText)];
        return sourceIndex === undefined ? match : `catalogs[${sourceIndex}]`;
      }),
    })));
    if (!registryResult.success || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new VisualBridgeMcpError(
        "graph.catalogInvalid",
        `Graph Catalog Registry for Document Type '${documentTypeId}' is invalid.`,
        diagnostics,
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
