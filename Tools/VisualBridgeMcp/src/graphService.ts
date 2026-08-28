import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  applyGraphOperations,
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
  public constructor(private readonly workspace: VisualBridgeWorkspace) {}

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
    const lockPath = path.join(
      path.dirname(context.absoluteGraphPath),
      `.${path.basename(context.absoluteGraphPath)}.visualbridge.lock`,
    );
    let lockHandle;
    try {
      lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
      await lockHandle.sync();
    } catch (errorValue) {
      if (isNodeError(errorValue, "EEXIST")) {
        const bytes = await readFile(context.absoluteGraphPath);
        return conflictResult(context, options.baseHash, hashBytes(bytes), "writeInProgress");
      }
      if (lockHandle !== undefined) {
        await lockHandle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
      throw errorValue;
    }

    let temporaryPath: string | undefined;
    try {
      const bytes = await readFile(context.absoluteGraphPath);
      const actualHash = hashBytes(bytes);
      if (actualHash !== options.baseHash) {
        return conflictResult(context, options.baseHash, actualHash, "baseHashMismatch");
      }

      const catalog = await this.loadCatalog(
        context.project,
        context.documentType.id,
        context.documentType.catalogs,
      );
      const parseResult = parseGraphDocument(decodeUtf8(bytes, context.graphPath));
      if (!parseResult.success) {
        return invalidResult(context, actualHash, [...catalog.diagnostics, ...parseResult.diagnostics]);
      }
      const operationResult = applyGraphOperations(parseResult.document, options.operations, catalog.registry);
      if (!operationResult.success) {
        return invalidResult(context, actualHash, operationResult.diagnostics);
      }
      if (operationResult.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return invalidResult(context, actualHash, operationResult.diagnostics);
      }
      const nextText = serializeGraphDocument(operationResult.document);
      const nextBytes = Buffer.from(nextText, "utf8");
      const nextHash = hashBytes(nextBytes);
      if (nextHash === actualHash && nextBytes.equals(bytes)) {
        return {
          status: "unchanged",
          projectFile: context.project.projectFile,
          path: context.graphPath,
          baseHash: actualHash,
          hash: actualHash,
          diagnostics: operationResult.diagnostics,
        };
      }

      temporaryPath = path.join(
        path.dirname(context.absoluteGraphPath),
        `.${path.basename(context.absoluteGraphPath)}.visualbridge-${randomUUID()}.tmp`,
      );
      const targetStat = await stat(context.absoluteGraphPath);
      const temporaryHandle = await open(temporaryPath, "wx", targetStat.mode);
      try {
        await temporaryHandle.writeFile(nextBytes);
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }

      const beforeReplaceHash = hashBytes(await readFile(context.absoluteGraphPath));
      if (beforeReplaceHash !== actualHash) {
        return conflictResult(context, options.baseHash, beforeReplaceHash, "changedBeforeReplace");
      }
      await rename(temporaryPath, context.absoluteGraphPath);
      temporaryPath = undefined;
      const persistedHash = hashBytes(await readFile(context.absoluteGraphPath));
      if (persistedHash !== nextHash) {
        throw new VisualBridgeMcpError(
          "graph.atomicWriteVerificationFailed",
          `Graph '${context.graphPath}' did not match the serialized transaction after atomic replacement.`,
        );
      }
      return {
        status: "applied",
        projectFile: context.project.projectFile,
        documentTypeId: context.documentType.id,
        path: context.graphPath,
        baseHash: actualHash,
        hash: nextHash,
        diagnostics: operationResult.diagnostics,
      };
    } finally {
      if (temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      if (lockHandle !== undefined) {
        await lockHandle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    }
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

function conflictResult(
  context: GraphDocumentContext,
  expectedBaseHash: string,
  actualHash: string,
  reason: string,
): Record<string, unknown> {
  return {
    status: "conflict",
    reason,
    projectFile: context.project.projectFile,
    documentTypeId: context.documentType.id,
    path: context.graphPath,
    expectedBaseHash,
    actualHash,
  };
}

function invalidResult(
  context: GraphDocumentContext,
  baseHash: string,
  diagnostics: readonly DocumentDiagnostic[],
): Record<string, unknown> {
  return {
    status: "invalid",
    projectFile: context.project.projectFile,
    documentTypeId: context.documentType.id,
    path: context.graphPath,
    baseHash,
    diagnostics,
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

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeError(errorValue: unknown, code: string): boolean {
  return errorValue instanceof Error && "code" in errorValue && errorValue.code === code;
}
