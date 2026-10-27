/**
 * MCP 唯一的文档服务（B4）。
 *
 * 负责一个文档的全部宿主职责：源文件发现与读取、Catalog 装载、facet 解析/校验/渲染、
 * Reference 校验、分页、Project Transaction 写入与 `baseHash` 冲突语义。领域差异全部由模块
 * 的 `catalog` / `document` / `mcp` / `create` facet 提供，本文件没有 editor 分支。
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  buildCatalogBundle,
  compareUtf16CodeUnits,
  type CatalogFacet,
  type DocumentDiagnostic,
  type DocumentFacet,
  type DocumentFacetContext,
  type DocumentFacetParseResult,
  type DocumentFacetSourceFile,
  type JsonValue,
  type McpQueryResult,
  type ReferenceOccurrence,
} from "@visualbridge/core";
import type { DocumentCatalogRequest, DocumentRequest } from "./documentRequests.js";
import { facetRequestError } from "./mcpErrorCodes.js";
import { hashPathManifest, hashSourceManifest } from "./sourceManifest.js";
import type { ActiveModule, McpModuleRegistry } from "./moduleRegistry.js";
import { pageItems } from "./pagination.js";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "./projectTransaction.js";
import {
  VisualBridgeMcpError,
  resolveExistingProjectPath,
  type DeclaredDocumentContext,
  type ProjectContext,
  type VisualBridgeWorkspace,
} from "./projectWorkspace.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";

export interface SkippedReferenceSource {
  readonly path: string;
  readonly documentTypeId: string;
  readonly reason: "loadFailed" | "parseFailed";
  /** 失败原因摘要（装载异常消息或第一条解析诊断）。 */
  readonly message: string;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export interface LoadedCatalog {
  readonly registry: unknown | undefined;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly paths: readonly string[];
  readonly catalogHash: string;
}

export interface LoadedSourceFile extends DocumentFacetSourceFile {
  readonly absolutePath: string;
  readonly hash: string;
  readonly sheetIds: readonly string[];
}

export interface LoadedDocument {
  readonly project: ProjectContext;
  readonly documentType: DeclaredDocumentContext["documentType"];
  readonly path: string;
  readonly module: ActiveModule;
  readonly catalog: LoadedCatalog;
  readonly sources: readonly LoadedSourceFile[];
  readonly context: DocumentFacetContext<unknown>;
  readonly baseHash: string;
  readonly parsed: DocumentFacetParseResult<unknown>;
  readonly document?: unknown;
  readonly sheetsBySource?: Readonly<Record<string, readonly string[]>>;
  readonly occurrences: readonly ReferenceOccurrence[];
  /** Catalog + 解析 + 语义校验（不含 Reference 与 Provider），供 Lifecycle 判定"源本身可用"。 */
  readonly structuralDiagnostics: readonly DocumentDiagnostic[];
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly valid: boolean;
}

interface LoadDocumentOptions {
  readonly path: string;
  readonly editor?: string;
  readonly projectFile?: string;
  readonly documentTypeId?: string;
  /** 索引/引用数据装载跳过 Reference 与 Provider 校验，避免"装载 → 建索引 → 再装载"递归。 */
  readonly skipReferenceValidation?: boolean;
  /** 工具请求默认带 Provider 校验；只有索引/引用数据装载显式传 `false`。 */
  readonly includeProviderValidation?: boolean;
}

export class McpDocumentService {
  private references: VisualBridgeReferenceService | undefined;

  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly modules: McpModuleRegistry,
  ) {}

  public setReferenceService(references: VisualBridgeReferenceService): void {
    this.references = references;
  }

  // ── Catalog ────────────────────────────────────────────────────────────────

  public async queryCatalog(request: DocumentCatalogRequest): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveDocumentType(undefined, request.projectFile, request.documentTypeId);
    const module = await this.modules.requireModule(resolved.project, resolved.documentType.editor);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.editor, resolved.documentType, module);
    const kind = request.kind ?? "summary";
    const result = module.mcp.queryCatalog(catalog.registry, {
      action: request.action,
      documentTypeId: resolved.documentType.id,
      kind,
      query: request.query,
      selector: toJsonSelector(request.selector),
    });
    const base = {
      projectId: resolved.project.definition.projectId,
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      editor: resolved.documentType.editor,
      catalogPaths: catalog.paths,
      ...catalogFields(catalog),
    };
    switch (result.kind) {
      case "counts":
        return { ...base, ...result.fields, counts: result.counts };
      case "definitions":
        return { ...base, ...result.fields, definitions: result.definitions };
      case "results": {
        const page = pageItems(
          result.results,
          request.cursor,
          request.limit,
          catalogCursorScope(request, resolved.documentType.editor, kind),
          { catalogHash: catalog.catalogHash },
        );
        return {
          ...base,
          ...result.fields,
          kind,
          query: request.query,
          results: page.items,
          nextCursor: page.nextCursor,
        };
      }
      case "unsupported":
        throw new VisualBridgeMcpError("catalog.kindUnsupported", result.message, {
          editor: resolved.documentType.editor,
          documentTypeId: resolved.documentType.id,
          kind,
        });
      case "invalidRequest":
        throw facetRequestError(result.code, result.message);
      case "read":
        throw new VisualBridgeMcpError("internal", "Catalog facet returned an unexpected read result.");
    }
  }

  // ── Document ───────────────────────────────────────────────────────────────

  public async executeDocument(request: DocumentRequest): Promise<Record<string, unknown>> {
    if (request.action === "apply") {
      if (request.baseHash === undefined || request.operations === undefined) {
        throw new VisualBridgeMcpError("document.invalidApply", "Apply requires baseHash and operations.");
      }
      return this.applyOperations(request.path, request.baseHash, request.operations, request);
    }
    const loaded = await this.loadDocument({
      path: request.path,
      ...(request.projectFile === undefined ? {} : { projectFile: request.projectFile }),
      ...(request.documentTypeId === undefined ? {} : { documentTypeId: request.documentTypeId }),
    });
    if (request.action === "validate") {
      return { ...documentIdentity(loaded), valid: loaded.valid, diagnostics: loaded.diagnostics };
    }
    if (request.action === "read") {
      return this.readDocument(loaded, request);
    }
    return this.searchDocument(loaded, request);
  }

  private readDocument(loaded: LoadedDocument, request: DocumentRequest): Record<string, unknown> {
    if (loaded.document === undefined) {
      return { ...documentIdentity(loaded), valid: false, diagnostics: loaded.diagnostics };
    }
    const result = loaded.module.mcp.queryDocument("read", loaded.document, {
      query: request.query,
      selector: toJsonSelector(request.selector),
    }, loaded.context);
    const read = requireDocumentQueryResult(result, "read");
    const page = read.page === undefined
      ? undefined
      : pageItems(
        read.page.items,
        request.cursor,
        request.limit,
        documentCursorScope(request, loaded.documentType.editor),
        documentCursorSnapshot(loaded),
      );
    return {
      ...documentIdentity(loaded),
      valid: loaded.valid,
      document: loaded.document,
      ...read.fields,
      ...(page === undefined || read.page === undefined
        ? {}
        : { page: { ...read.page.fields, rows: page.items, nextCursor: page.nextCursor } }),
      diagnostics: loaded.diagnostics,
    };
  }

  private searchDocument(loaded: LoadedDocument, request: DocumentRequest): Record<string, unknown> {
    const result = loaded.document === undefined
      ? { kind: "results" as const, results: [] }
      : loaded.module.mcp.queryDocument("search", loaded.document, {
        query: request.query,
        selector: toJsonSelector(request.selector),
      }, loaded.context);
    const search = requireDocumentQueryResult(result, "results");
    const page = pageItems(
      search.results,
      request.cursor,
      request.limit,
      documentCursorScope(request, loaded.documentType.editor),
      documentCursorSnapshot(loaded),
    );
    return {
      ...documentIdentity(loaded),
      valid: loaded.valid,
      query: request.query,
      ...search.fields,
      results: page.items,
      nextCursor: page.nextCursor,
      diagnostics: loaded.diagnostics,
    };
  }

  private async applyOperations(
    documentPath: string,
    baseHash: string,
    operations: unknown,
    request: DocumentRequest,
  ): Promise<Record<string, unknown>> {
    const declared = await this.workspace.resolveDeclaredDocument(
      documentPath,
      undefined,
      request.projectFile,
      request.documentTypeId,
    );
    const module = await this.modules.requireModule(declared.project, declared.documentType.editor);
    const project = declared.project;
    try {
      return await withProjectTransaction(project.projectRoot, async (transaction) => {
        const loaded = await this.loadDocument({
          path: documentPath,
          ...(request.projectFile === undefined ? {} : { projectFile: request.projectFile }),
          ...(request.documentTypeId === undefined ? {} : { documentTypeId: request.documentTypeId }),
        });
        if (loaded.baseHash !== baseHash) {
          return {
            status: "conflict",
            reason: "baseHashMismatch",
            ...documentTargetMetadata(loaded),
            expectedBaseHash: baseHash,
            actualHash: loaded.baseHash,
            sources: sourceEntries(loaded),
          };
        }
        const change = await this.planChange(loaded, operations);
        if (change.status !== "valid") return change.result;
        const changed = change.sources.filter((entry) => !entry.after.equals(entry.before));
        if (changed.length === 0) {
          return {
            status: "unchanged",
            ...documentTargetMetadata(loaded),
            baseHash: loaded.baseHash,
            hash: loaded.baseHash,
            diagnostics: change.diagnostics,
          };
        }
        const committed = await transaction.commit(changed.map((entry) => ({
          path: entry.path,
          absolutePath: entry.absolutePath,
          before: entry.before,
          after: entry.after,
        })));
        return {
          status: "applied",
          ...documentTargetMetadata(loaded),
          baseHash: loaded.baseHash,
          hash: change.nextHash,
          sources: change.nextSources,
          diagnostics: change.diagnostics,
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
        throw new VisualBridgeMcpError(
          errorValue.code === "transaction.verificationFailed"
            ? "document.atomicWriteVerificationFailed"
            : errorValue.code,
          errorValue.message,
          errorValue.details,
        );
      }
      throw errorValue;
    }
  }

  /**
   * 应用 Operations 的全过程：解析 → 预检 → 应用 → 语义不变量 → Reference 变更 → 渲染 →
   * Provider 校验。返回渲染后的源或可直接作为 Tool 结果的失败响应。
   */
  public async planChange(
    loaded: LoadedDocument,
    operations: unknown,
  ): Promise<
    | {
        readonly status: "valid";
        readonly sources: readonly RenderedSource[];
        readonly nextSources: readonly Record<string, unknown>[];
        readonly nextHash: string;
        readonly diagnostics: readonly DocumentDiagnostic[];
      }
    | { readonly status: "invalid"; readonly result: Record<string, unknown> }
  > {
    if (loaded.document === undefined || !loaded.parsed.success) {
      return invalidResult(loaded, loaded.diagnostics);
    }
    const facet = loaded.module.facet;
    const guard = facet.guardOperations?.(loaded.document, operations, loaded.context) ?? [];
    if (guard.length > 0) return invalidResult(loaded, guard);
    const applied = facet.applyOperations(loaded.document, operations, loaded.context);
    if (!applied.success) return invalidResult(loaded, applied.diagnostics);
    if (applied.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return invalidResult(loaded, applied.diagnostics);
    }
    const transition = facet.validateTransition?.(loaded.document, applied.document, loaded.context) ?? [];
    if (transition.length > 0) return invalidResult(loaded, transition);
    const referenceResult = this.references === undefined
      ? { diagnostics: [], introducedErrors: [] }
      : await this.references.validateChange(
        loaded.project.projectFile,
        loaded.occurrences,
        facet.collectReferences(applied.document, loaded.context),
      );
    if (referenceResult.introducedErrors.length > 0) {
      return invalidResult(loaded, referenceResult.introducedErrors);
    }
    return this.renderAndValidate(loaded, applied.document, [
      ...applied.diagnostics,
      ...referenceResult.diagnostics,
    ]);
  }

  /** 只渲染，不跑 Provider 校验（Lifecycle/Refactor 沿用改造前的写盘前检查范围）。 */
  public async renderDocument(
    loaded: LoadedDocument,
    document: unknown,
  ): Promise<readonly RenderedSource[]> {
    const files = await loaded.module.facet.renderSources(document, sourceFiles(loaded.sources), loaded.context);
    const byPath = new Map(files.map((file) => [file.path, file.bytes]));
    return loaded.sources.map((source) => {
      const bytes = byPath.get(source.path);
      if (bytes === undefined) throw new VisualBridgeMcpError("internal", `Facet did not render source '${source.path}'.`);
      return {
        path: source.path,
        absolutePath: source.absolutePath,
        before: Buffer.from(source.bytes),
        after: Buffer.from(bytes),
      };
    });
  }

  /** 渲染 + Provider 校验；Lifecycle/Refactor 复用同一条写盘前检查。 */
  public async renderAndValidate(
    loaded: LoadedDocument,
    document: unknown,
    diagnostics: readonly DocumentDiagnostic[],
  ): Promise<
    | {
        readonly status: "valid";
        readonly sources: readonly RenderedSource[];
        readonly nextSources: readonly Record<string, unknown>[];
        readonly nextHash: string;
        readonly diagnostics: readonly DocumentDiagnostic[];
      }
    | { readonly status: "invalid"; readonly result: Record<string, unknown> }
  > {
    const rendered = await this.renderDocument(loaded, document);
    const nextManifest = rendered.map((entry) => ({ path: entry.path, hash: hashBytes(entry.after) }));
    const nextHash = hashSourceManifest(nextManifest);
    const providerDiagnostics = this.references === undefined
      ? []
      : await this.references.validateProviderDocument(loaded.project.projectFile, {
        documentTypeId: loaded.documentType.id,
        path: loaded.path,
        sourceHash: nextHash,
        content: document as JsonValue,
      });
    if (providerDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return invalidResult(loaded, providerDiagnostics);
    }
    const nextSheets = loaded.sheetsBySource;
    return {
      status: "valid",
      sources: rendered,
      nextSources: nextMetricSources(rendered, nextSheets),
      nextHash,
      diagnostics: [...diagnostics, ...providerDiagnostics],
    };
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  public async loadDocument(options: LoadDocumentOptions): Promise<LoadedDocument> {
    const declared = await this.workspace.resolveDeclaredDocument(
      options.path,
      options.editor,
      options.projectFile,
      options.documentTypeId,
    );
    const module = await this.modules.requireModule(declared.project, declared.documentType.editor);
    const catalog = await this.loadCatalog(declared.project, declared.documentType.editor, declared.documentType, module);
    const context = facetContext(declared, module, catalog.registry);
    const { sources } = await this.loadSources(declared, module, context);
    const baseHash = hashSourceManifest(sources.map((source) => ({ path: source.path, hash: source.hash })));
    const parsed = module.facet.storage === "sources"
      ? await module.facet.parseSources!(sourceFiles(sources), context)
      : await module.facet.parseText!(
        decodeUtf8(sources[0]!.bytes, declared.path),
        context,
      );
    const document = parsed.success ? parsed.document : undefined;
    const parsedSheets = parsed.success ? parsed.sheetsBySource : undefined;
    const withSheets: readonly LoadedSourceFile[] = parsedSheets === undefined
      ? sources
      : sources.map((source) => ({ ...source, sheetIds: parsedSheets[source.path] ?? [] }));
    const semantic = document === undefined || module.facet.storage === "sources"
      ? []
      : module.facet.validate(document, context);
    // sources 的 parse 已包含语义校验（Table 的现状），text 的 parse 只做结构解析。
    const occurrences = document === undefined ? [] : module.facet.collectReferences(document, context);
    const referenceDiagnostics = this.references === undefined || options.skipReferenceValidation === true
      ? []
      : await this.references.validate(declared.project.projectFile, occurrences);
    // 工具请求（read/search/validate/apply 的底稿）保留 Provider 校验；索引/引用数据装载显式关闭。
    const providerDiagnostics = options.includeProviderValidation === false
      ? []
      : document === undefined
        ? []
        : await this.references?.validateProviderDocument(declared.project.projectFile, {
          documentTypeId: declared.documentType.id,
          path: declared.path,
          sourceHash: baseHash,
          content: document as JsonValue,
        }) ?? [];
    const diagnostics = [
      ...catalog.diagnostics,
      ...parsed.diagnostics,
      ...semantic,
      ...referenceDiagnostics,
      ...providerDiagnostics,
    ];
    return {
      project: declared.project,
      documentType: declared.documentType,
      path: declared.path,
      module,
      catalog,
      sources: withSheets,
      context,
      baseHash,
      parsed,
      ...(document === undefined ? {} : { document }),
      ...(parsedSheets === undefined ? {} : { sheetsBySource: parsedSheets }),
      occurrences,
      structuralDiagnostics: [...catalog.diagnostics, ...parsed.diagnostics, ...semantic],
      diagnostics,
      valid: !hasErrors(diagnostics),
    };
  }

  /**
   * 装载一个模块在某 Project 内声明的全部文档。
   *
   * 装载失败与解析失败**不静默跳过**：`strictErrorCode` 存在时直接按该公开码失败（Refactor
   * 依赖完整的引用数据，否则改名会漏掉坏源里的引用）；否则记入 `skipped`，由调用方转成
   * 可见的引用快照诊断。
   */
  public async loadDeclaredSources(
    project: ProjectContext,
    editor: string,
    options: { readonly strictErrorCode?: string } = {},
  ): Promise<{ readonly loaded: readonly LoadedDocument[]; readonly skipped: readonly SkippedReferenceSource[] }> {
    const declared = await this.workspace.listDeclaredDocuments(project, editor);
    const loaded: LoadedDocument[] = [];
    const skipped: SkippedReferenceSource[] = [];
    for (const source of declared) {
      let document: LoadedDocument;
      try {
        document = await this.loadDocument({
          path: source.path,
          editor,
          projectFile: project.projectFile,
          documentTypeId: source.documentType.id,
          includeProviderValidation: false,
          skipReferenceValidation: true,
        });
      } catch (errorValue) {
        if (options.strictErrorCode !== undefined) {
          throw new VisualBridgeMcpError(
            options.strictErrorCode,
            `Reference source '${source.path}' cannot be loaded: ${formatError(errorValue)}`,
            { path: source.path, documentTypeId: source.documentType.id },
          );
        }
        skipped.push({
          path: source.path,
          documentTypeId: source.documentType.id,
          reason: "loadFailed",
          message: formatError(errorValue),
          diagnostics: [],
        });
        continue;
      }
      if (!document.parsed.success) {
        if (options.strictErrorCode !== undefined) {
          throw new VisualBridgeMcpError(
            options.strictErrorCode,
            `Reference source '${source.path}' is invalid and cannot participate in the reference index.`,
            document.parsed.diagnostics,
          );
        }
        skipped.push({
          path: source.path,
          documentTypeId: source.documentType.id,
          reason: "parseFailed",
          message: summaryOfDiagnostics(document.parsed.diagnostics),
          diagnostics: document.parsed.diagnostics,
        });
        continue;
      }
      loaded.push(document);
    }
    return { loaded, skipped };
  }

  /** 一个模块在某 Project 内的全部可解析文档的 `referenceData`。 */
  public async loadModuleReferenceData(
    project: ProjectContext,
    module: ActiveModule,
    options: { readonly strictErrorCode?: string } = {},
  ): Promise<{ readonly data: readonly unknown[]; readonly skipped: readonly SkippedReferenceSource[] }> {
    const { loaded, skipped } = await this.loadDeclaredSources(project, module.editor, options);
    return {
      data: loaded.flatMap((entry) => (
        entry.parsed.success && entry.parsed.referenceData !== undefined ? [entry.parsed.referenceData] : []
      )),
      skipped,
    };
  }

  public async loadCatalog(
    project: ProjectContext,
    editor: string,
    documentType: DeclaredDocumentContext["documentType"],
    module: ActiveModule,
  ): Promise<LoadedCatalog> {
    if (documentType.catalogs.length === 0) {
      throw new VisualBridgeMcpError(
        "catalog.notConfigured",
        `${editor} Document Type '${documentType.id}' does not declare any Catalogs.`,
        {
          editor,
          documentTypeId: documentType.id,
          catalogPaths: [],
          hint: "Declare the Document Type's Catalog files in the Project File.",
        },
      );
    }
    const catalogs: { path: string; text: string; hash: string }[] = [];
    for (const catalogPath of documentType.catalogs) {
      const bytes = await readFile(await resolveExistingProjectPath(project, catalogPath));
      catalogs.push({
        path: catalogPath,
        text: decodeUtf8(bytes, catalogPath),
        hash: hashBytes(bytes),
      });
    }
    const bundle = buildCatalogBundle(
      catalogs.map((entry) => ({ path: entry.path, text: entry.text })),
      module.catalog as unknown as CatalogFacet<never, unknown>,
    );
    if (bundle.registry === undefined) {
      throw new VisualBridgeMcpError(
        "catalog.invalid",
        `${editor} Catalog Registry for Document Type '${documentType.id}' is invalid.`,
        {
          editor,
          documentTypeId: documentType.id,
          catalogPaths: [...documentType.catalogs],
          diagnostics: bundle.diagnostics,
        },
      );
    }
    const issue = module.catalog.bindingIssue?.(bundle.registry, documentType.id);
    if (issue !== undefined) {
      throw new VisualBridgeMcpError("catalog.documentTypeUnbound", issue.message, {
        code: issue.code,
        documentTypeId: documentType.id,
        editor,
      });
    }
    return {
      registry: bundle.registry,
      diagnostics: bundle.diagnostics,
      paths: bundle.paths,
      catalogHash: hashPathManifest(catalogs.map((entry) => ({ path: entry.path, hash: entry.hash }))),
    };
  }

  private async loadSources(
    declared: DeclaredDocumentContext,
    module: ActiveModule,
    context: DocumentFacetContext<unknown>,
  ): Promise<{ sources: readonly LoadedSourceFile[]; sheetsBySource?: Readonly<Record<string, readonly string[]>> }> {
    const activeBytes = await readFile(declared.absolutePath);
    if (module.facet.storage === "text") {
      return {
        sources: [{
          path: declared.path,
          absolutePath: declared.absolutePath,
          bytes: activeBytes,
          hash: hashBytes(activeBytes),
          sheetIds: [],
        }],
      };
    }
    const candidates = await this.candidateSiblingPaths(declared);
    const planned = module.facet.planSources!(
      { path: declared.path, bytes: activeBytes },
      candidates,
      context,
    );
    const sources: LoadedSourceFile[] = [];
    for (const sourcePath of planned) {
      const absolutePath = sourcePath === declared.path
        ? declared.absolutePath
        : await this.verifySibling(declared, sourcePath);
      if (absolutePath === undefined) continue;
      const bytes = await readFile(absolutePath);
      sources.push({ path: sourcePath, absolutePath, bytes, hash: hashBytes(bytes), sheetIds: [] });
    }
    if (!sources.some((source) => source.path === declared.path)) {
      sources.push({
        path: declared.path,
        absolutePath: declared.absolutePath,
        bytes: activeBytes,
        hash: hashBytes(activeBytes),
        sheetIds: [],
      });
    }
    return { sources: sources.sort((left, right) => compareUtf16CodeUnits(left.path, right.path)) };
  }

  private async candidateSiblingPaths(declared: DeclaredDocumentContext): Promise<readonly string[]> {
    const directory = path.posix.dirname(declared.path);
    const extension = path.extname(declared.path).toLowerCase();
    const entries = await readdir(path.dirname(declared.absolutePath), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === extension)
      .map((entry) => (directory === "." ? entry.name : `${directory}/${entry.name}`))
      .sort(compareUtf16CodeUnits);
  }

  /** 同族源必须仍是同一个 Document Type 声明的文件；否则视为不属于该文档。 */
  private async verifySibling(
    declared: DeclaredDocumentContext,
    sourcePath: string,
  ): Promise<string | undefined> {
    try {
      const sibling = await this.workspace.resolveDeclaredDocument(
        sourcePath,
        declared.documentType.editor,
        declared.project.projectFile,
        declared.documentType.id,
      );
      return sibling.absolutePath;
    } catch (errorValue) {
      if (errorValue instanceof VisualBridgeMcpError
        && ["document.notDeclared", "path.notFound"].includes(errorValue.code)) {
        return undefined;
      }
      throw errorValue;
    }
  }
}

export interface RenderedSource {
  readonly path: string;
  readonly absolutePath: string;
  readonly before: Buffer;
  readonly after: Buffer;
}

export function sourceFiles(sources: readonly DocumentFacetSourceFile[]): readonly DocumentFacetSourceFile[] {
  return sources.map((source) => ({ path: source.path, bytes: source.bytes }));
}

export function documentIdentity(loaded: LoadedDocument): Record<string, unknown> {
  return {
    projectId: loaded.project.definition.projectId,
    projectFile: loaded.project.projectFile,
    documentTypeId: loaded.documentType.id,
    editor: loaded.documentType.editor,
    path: loaded.path,
    baseHash: loaded.baseHash,
    sources: sourceEntries(loaded),
  };
}

export function sourceEntries(loaded: {
  readonly sources: readonly LoadedSourceFile[];
}): readonly Record<string, unknown>[] {
  return loaded.sources.map((source) => ({
    path: source.path,
    hash: source.hash,
    ...(loaded.sources.some((entry) => entry.sheetIds.length > 0) ? { sheetIds: source.sheetIds } : {}),
  }));
}

export function documentTargetMetadata(loaded: LoadedDocument): Record<string, unknown> {
  return {
    projectId: loaded.project.definition.projectId,
    projectFile: loaded.project.projectFile,
    documentTypeId: loaded.documentType.id,
    editor: loaded.documentType.editor,
    path: loaded.path,
  };
}

function facetContext(
  declared: DeclaredDocumentContext,
  module: ActiveModule,
  registry: unknown | undefined,
): DocumentFacetContext<unknown> {
  return {
    projectId: declared.project.definition.projectId,
    documentTypeId: declared.documentType.id,
    path: declared.path,
    sourcePaths: [declared.path],
    registry,
    projectDefinition: declared.project.definition as unknown as JsonValue,
    moduleOptions: module.options,
  };
}

function catalogFields(catalog: LoadedCatalog): Record<string, unknown> {
  return {
    catalogs: (catalog.registry as { readonly catalogs?: readonly unknown[] } | undefined)?.catalogs ?? [],
    diagnostics: catalog.diagnostics,
  };
}

function documentCursorSnapshot(loaded: LoadedDocument): unknown {
  return loaded.module.facet.storage === "sources"
    ? { sourceHash: loaded.baseHash, catalogHash: loaded.catalog.catalogHash }
    : undefined;
}

function catalogCursorScope(request: DocumentCatalogRequest, editor: string, kind: string): unknown {
  return {
    tool: "visualbridge_catalog",
    action: request.action,
    projectFile: request.projectFile,
    documentTypeId: request.documentTypeId,
    editor,
    kind,
    query: normalizeScopeQuery(request.query),
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
    query: normalizeScopeQuery(request.query),
    selector: request.selector,
  };
}

function normalizeScopeQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function nextMetricSources(
  rendered: readonly RenderedSource[],
  sheetsBySource: Readonly<Record<string, readonly string[]>> | undefined,
): readonly Record<string, unknown>[] {
  return rendered.map((entry) => ({
    path: entry.path,
    hash: hashBytes(entry.after),
    ...(sheetsBySource === undefined ? {} : { sheetIds: sheetsBySource[entry.path] ?? [] }),
  }));
}

function invalidResult(
  loaded: LoadedDocument,
  diagnostics: readonly DocumentDiagnostic[],
): { readonly status: "invalid"; readonly result: Record<string, unknown> } {
  return {
    status: "invalid",
    result: {
      status: "invalid",
      ...documentTargetMetadata(loaded),
      baseHash: loaded.baseHash,
      sources: sourceEntries(loaded),
      diagnostics,
    },
  };
}

function unexpectedQueryResult(kind: string): VisualBridgeMcpError {
  return new VisualBridgeMcpError("internal", `Document facet returned an unexpected '${kind}' result.`);
}

/**
 * 收窄 `mcp` facet 的查询结果。
 *
 * facet 用 `invalidRequest` 表达"请求本身不成立"（`code` 是公开错误码，见 `facetRequestError`）、
 * 用 `unsupported` 表达"该 search kind 不受此领域支持"。两者都必须原样转成公开错误；只有
 * `read`/`results` 之外的**成功形态**才是 facet 违反契约，按 `internal` 上报。
 */
function requireDocumentQueryResult<TKind extends "read" | "results">(
  result: McpQueryResult,
  expected: TKind,
): Extract<McpQueryResult, { readonly kind: TKind }> {
  if (result.kind === "invalidRequest") throw facetRequestError(result.code, result.message);
  if (result.kind === "unsupported") {
    throw new VisualBridgeMcpError("document.searchKindUnsupported", result.message);
  }
  if (result.kind !== expected) throw unexpectedQueryResult(result.kind);
  return result as Extract<McpQueryResult, { readonly kind: TKind }>;
}

function toJsonSelector(selector: Readonly<Record<string, unknown>>): Readonly<Record<string, JsonValue>> {
  return selector as Readonly<Record<string, JsonValue>>;
}

function hasErrors(diagnostics: readonly DocumentDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

/** 引用快照诊断只需要一条可读摘要：真正的诊断数组仍在被跳过源的类型里保留。 */
function summaryOfDiagnostics(diagnostics: readonly DocumentDiagnostic[]): string {
  const first = diagnostics.find((diagnostic) => diagnostic.severity === "error") ?? diagnostics[0];
  if (first === undefined) return "the source produced no diagnostics";
  const suffix = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
  return `${first.code} at ${first.path}: ${first.message}${suffix}`;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
