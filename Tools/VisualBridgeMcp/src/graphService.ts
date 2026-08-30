import { readFile } from "node:fs/promises";
import { buildCatalogBundle, type DocumentDiagnostic, type JsonValue } from "@visualbridge/core";
import {
  graphCatalogAdapter,
  graphDocumentAdapter,
  graphTextDocumentCodec,
  searchGraphNodeTypes,
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
import type { DocumentCatalogRequest, DocumentRequest } from "./documentAdapterRegistry.js";
import { pageItems } from "./pagination.js";

interface CatalogContext {
  readonly project: ProjectContext;
  readonly documentTypeId: string;
  readonly catalogPaths: readonly string[];
  readonly registry: GraphCatalogRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export class GraphService {
  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly references: VisualBridgeReferenceService,
  ) {}

  public async queryCatalog(request: DocumentCatalogRequest): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveDocumentType("graph", request.projectFile, request.documentTypeId);
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
              dataTypes: catalog.registry.dataTypes.length,
              graphTypes: catalog.registry.graphTypes.length,
              nodeTypes: catalog.registry.nodeTypes.length,
            },
          };
        case "dataTypes":
          return { ...base, definitions: catalog.registry.dataTypes };
        case "graphTypes":
          return { ...base, definitions: catalog.registry.graphTypes };
        case "nodeTypes":
          return { ...base, definitions: catalog.registry.nodeTypes };
        default:
          throw new VisualBridgeMcpError("catalog.kindUnsupported", `Graph Catalog kind '${kind}' is not supported.`);
      }
    }
    const query = request.query.trim().toLocaleLowerCase();
    let definitions: readonly unknown[];
    if (kind === "nodeTypes") {
      const graphTypeId = optionalString(request.selector.graphTypeId, "selector.graphTypeId");
      const includeSubgraphNodeTypes = optionalBoolean(
        request.selector.includeSubgraphNodeTypes,
        "selector.includeSubgraphNodeTypes",
      ) ?? true;
      definitions = searchGraphNodeTypes(catalog.registry, {
        query: request.query,
        ...(graphTypeId === undefined ? {} : { graphTypeId }),
        includeSubgraphNodeTypes,
        limit: Math.max(1, catalog.registry.nodeTypes.length),
      });
    } else {
      const source = kind === "dataTypes"
        ? catalog.registry.dataTypes
        : kind === "graphTypes"
          ? catalog.registry.graphTypes
          : undefined;
      if (source === undefined) {
        throw new VisualBridgeMcpError("catalog.kindUnsupported", `Graph Catalog kind '${kind}' is not searchable.`);
      }
      definitions = source
        .filter((definition) => query.length === 0 || JSON.stringify(definition).toLocaleLowerCase().includes(query))
        .sort((left, right) => left.id.localeCompare(right.id));
    }
    const page = pageItems(definitions, request.cursor, request.limit, catalogCursorScope(request, "graph", kind));
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
        graphPath: request.path,
        baseHash: request.baseHash,
        operations: request.operations,
      });
    }
    const loaded = await this.loadDocument(request.path, request.projectFile, request.documentTypeId);
    if (request.action === "validate") {
      return { ...graphIdentity(loaded), valid: loaded.valid, diagnostics: loaded.diagnostics };
    }
    if (request.action === "read") {
      return {
        ...graphIdentity(loaded),
        valid: loaded.valid,
        ...(loaded.document === undefined ? {} : { document: loaded.document }),
        diagnostics: loaded.diagnostics,
      };
    }
    const query = request.query.trim().toLocaleLowerCase();
    const kind = optionalString(request.selector.kind, "selector.kind") ?? "all";
    if (!GRAPH_SEARCH_KINDS.has(kind)) {
      throw new VisualBridgeMcpError(
        "document.searchKindUnsupported",
        `Graph Document search kind '${kind}' is not supported.`,
      );
    }
    const entries = loaded.document === undefined ? [] : graphSearchEntries(loaded.document)
      .filter((entry) => kind === "all" || entry.kind === kind)
      .filter((entry) => query.length === 0 || entry.searchText.includes(query));
    const page = pageItems(
      entries.map(({ searchText: _searchText, ...entry }) => entry),
      request.cursor,
      request.limit,
      documentCursorScope(request, "graph"),
    );
    return {
      ...graphIdentity(loaded),
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
    readonly graphPath: string;
    readonly baseHash: string;
    readonly operations: unknown;
  }): Promise<Record<string, unknown>> {
    const context = await this.workspace.resolveDeclaredDocument(
      options.graphPath,
      "graph",
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
      verificationErrorCode: "graph.atomicWriteVerificationFailed",
      subject: `Graph '${context.path}'`,
    }, async (bytes) => {
      const catalog = await this.loadCatalog(
        context.project,
        context.documentType.id,
        context.documentType.catalogs,
      );
      const semanticContext = { registry: catalog.registry };
      const parseResult = await graphTextDocumentCodec.parse(decodeUtf8(bytes, context.path), semanticContext);
      if (!parseResult.success) {
        return { valid: false, diagnostics: [...catalog.diagnostics, ...parseResult.diagnostics] };
      }
      const lifecycleGuard = graphLifecycleGuard(options.operations);
      if (lifecycleGuard.length > 0) {
        return { valid: false, diagnostics: lifecycleGuard };
      }
      const operationResult = graphDocumentAdapter.applyOperations(parseResult.document, options.operations, semanticContext);
      if (!operationResult.success) {
        return { valid: false, diagnostics: operationResult.diagnostics };
      }
      if (operationResult.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return { valid: false, diagnostics: operationResult.diagnostics };
      }
      const referenceResult = await this.references.validateChange(
        context.project.projectFile,
        graphDocumentAdapter.collectReferences(parseResult.document, semanticContext),
        graphDocumentAdapter.collectReferences(operationResult.document, semanticContext),
      );
      if (referenceResult.introducedErrors.length > 0) {
        return { valid: false, diagnostics: referenceResult.introducedErrors };
      }
      const nextBytes = Buffer.from(
        await graphTextDocumentCodec.render(operationResult.document, "", semanticContext),
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
      const operationDiagnostics = [
        ...operationResult.diagnostics,
        ...referenceResult.diagnostics,
        ...providerDiagnostics,
      ];
      return {
        valid: true,
        nextBytes,
        diagnostics: operationDiagnostics,
      };
    });
  }

  private async loadDocument(
    graphPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<{
    readonly context: GraphDocumentContext;
    readonly baseHash: string;
    readonly document?: GraphDocument;
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly valid: boolean;
  }> {
    const context = await this.workspace.resolveGraphDocument(graphPath, projectFile, documentTypeId);
    const bytes = await readFile(context.absoluteGraphPath);
    const baseHash = hashBytes(bytes);
    const catalog = await this.loadCatalog(context.project, context.documentType.id, context.documentType.catalogs);
    const semanticContext = { registry: catalog.registry };
    const parsed = await graphTextDocumentCodec.parse(decodeUtf8(bytes, context.graphPath), semanticContext);
    if (!parsed.success) {
      const diagnostics = [...catalog.diagnostics, ...parsed.diagnostics];
      return { context, baseHash, diagnostics, valid: false };
    }
    const diagnostics = [
      ...catalog.diagnostics,
      ...parsed.diagnostics,
      ...graphDocumentAdapter.validate(parsed.document, semanticContext),
      ...await this.references.validate(
        context.project.projectFile,
        graphDocumentAdapter.collectReferences(parsed.document, semanticContext),
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
      diagnostics,
      valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
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
    const sources = await Promise.all(catalogPaths.map(async (catalogPath) => ({
      path: catalogPath,
      text: decodeUtf8(await readFile(await resolveExistingProjectPath(project, catalogPath)), catalogPath),
    })));
    const bundle = buildCatalogBundle(sources, graphCatalogAdapter);
    if (bundle.registry === undefined) {
      throw new VisualBridgeMcpError(
        "graph.catalogInvalid",
        `Graph Catalog Registry for Document Type '${documentTypeId}' is invalid.`,
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
}

function graphLifecycleGuard(value: unknown): readonly DocumentDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const protectedTypes = new Set([
    "graph.renameElement",
    "graph.removeNode",
    "graph.removeDynamicPort",
    "graph.removeInterfacePort",
  ]);
  return value.flatMap((entry, index) => (
    typeof entry === "object"
      && entry !== null
      && protectedTypes.has((entry as { readonly type?: unknown }).type as string)
      ? [{
          severity: "error" as const,
          code: "lifecycle.required",
          path: `operations[${index}].type`,
          message: (entry as { readonly type: string }).type === "graph.renameElement"
            ? "Stable Graph element IDs must be changed through visualbridge_refactor_reference."
            : "Referenced Graph elements must be removed through visualbridge_document_lifecycle safe delete.",
        }]
      : []
  ));
}

const GRAPH_SEARCH_KINDS = new Set(["all", "graph", "node", "port", "edge", "field"]);

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

function graphIdentity(loaded: {
  readonly context: GraphDocumentContext;
  readonly baseHash: string;
}): Record<string, unknown> {
  return {
    projectId: loaded.context.project.definition.projectId,
    projectFile: loaded.context.project.projectFile,
    documentTypeId: loaded.context.documentType.id,
    editor: loaded.context.documentType.editor,
    path: loaded.context.graphPath,
    baseHash: loaded.baseHash,
    sources: [{ path: loaded.context.graphPath, hash: loaded.baseHash }],
  };
}

function graphSearchEntries(document: GraphDocument): readonly (Record<string, unknown> & {
  readonly kind: string;
  readonly searchText: string;
})[] {
  const entries: (Record<string, unknown> & { kind: string; searchText: string })[] = [];
  document.graphs.forEach((graph, graphIndex) => {
    const graphPath = `graphs[${graphIndex}]`;
    entries.push({
      kind: "graph",
      graphId: graph.id,
      graphTypeId: graph.graphTypeId,
      title: graph.title,
      path: graphPath,
      searchText: `${graph.id} ${graph.graphTypeId ?? ""} ${graph.title}`.toLocaleLowerCase(),
    });
    collectSearchValues(graph.properties, `${graphPath}.properties`, { graphId: graph.id }, entries);
    graph.interfacePorts.forEach((port, portIndex) => entries.push({
      kind: "port",
      graphId: graph.id,
      portId: port.id,
      title: port.title,
      path: `${graphPath}.interfacePorts[${portIndex}]`,
      searchText: `${port.id} ${port.title} ${port.kind} ${port.direction} ${port.dataTypeId ?? ""}`.toLocaleLowerCase(),
    }));
    graph.nodes.forEach((node, nodeIndex) => {
      const nodePath = `${graphPath}.nodes[${nodeIndex}]`;
      entries.push({
        kind: "node",
        graphId: graph.id,
        nodeId: node.id,
        nodeTypeId: node.nodeTypeId,
        title: node.title,
        path: nodePath,
        searchText: `${node.id} ${node.nodeTypeId ?? ""} ${node.title}`.toLocaleLowerCase(),
      });
      collectSearchValues(node.properties, `${nodePath}.properties`, { graphId: graph.id, nodeId: node.id }, entries);
      node.dynamicPorts.forEach((port, portIndex) => entries.push({
        kind: "port",
        graphId: graph.id,
        nodeId: node.id,
        portId: port.id,
        title: port.title,
        path: `${nodePath}.dynamicPorts[${portIndex}]`,
        searchText: `${port.id} ${port.groupId} ${port.title}`.toLocaleLowerCase(),
      }));
    });
    graph.edges.forEach((edge, edgeIndex) => entries.push({
      kind: "edge",
      graphId: graph.id,
      edgeId: edge.id,
      edgeKind: edge.kind,
      path: `${graphPath}.edges[${edgeIndex}]`,
      searchText: JSON.stringify(edge).toLocaleLowerCase(),
    }));
  });
  return entries;
}

function collectSearchValues(
  value: unknown,
  path: string,
  location: Readonly<Record<string, unknown>>,
  entries: (Record<string, unknown> & { kind: string; searchText: string })[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSearchValues(entry, `${path}[${index}]`, location, entries));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).forEach(([key, entry]) =>
      collectSearchValues(entry, `${path}.${key}`, location, entries));
    return;
  }
  entries.push({
    kind: "field",
    ...location,
    path,
    value,
    searchText: `${path} ${String(value)}`.toLocaleLowerCase(),
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

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new VisualBridgeMcpError("request.invalidSelector", `${path} must be a boolean.`);
  }
  return value;
}
