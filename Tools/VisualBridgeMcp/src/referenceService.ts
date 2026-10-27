/**
 * MCP 的 Reference 服务（B4）。
 *
 * Reference Provider 全部来自 facet：宿主持有的 `document` kind + 每个模块 `references[]` 的
 * Provider + Project Provider。索引与引用数据都通过 `McpDocumentService` 装载模块自己的
 * `referenceData`，因此这里没有"哪个 editor 的表/组件/元素"分支。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  compareUtf16CodeUnits,
  createDocumentReferenceProvider,
  documentIndexKey,
  ReferenceService,
  type DocumentDiagnostic,
  type DocumentReferenceDocument,
  type IndexedDocument,
  type JsonValue,
  type ProjectProviderDocumentSnapshot,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  type ReferenceProvider,
  type ReferenceResolution,
  type ReferenceSearchCursor,
} from "@visualbridge/core";
import type { McpDocumentService, SkippedReferenceSource } from "./documentService.js";
import type { ActiveModule, McpModuleRegistry } from "./moduleRegistry.js";
import type { McpProjectProviderService } from "./projectProviderService.js";
import {
  VisualBridgeMcpError,
  resolveExistingProjectPath,
  type ProjectContext,
  type VisualBridgeWorkspace,
} from "./projectWorkspace.js";
import { referenceSemanticSnapshotDependencyKey } from "./referenceSnapshot.js";

export class VisualBridgeReferenceService {
  private documents: McpDocumentService | undefined;

  /**
   * 模块引用数据里被跳过的源（B4 第 2 轮 P2-2）。按 `ReferenceService` 实例挂载，避免把
   * "装载不完整"藏在可变实例字段里跨请求串味。
   */
  private readonly sourceDiagnostics = new WeakMap<ReferenceService, readonly DocumentDiagnostic[]>();

  public constructor(
    private readonly workspace: VisualBridgeWorkspace,
    private readonly modules: McpModuleRegistry,
    private readonly providers?: McpProjectProviderService,
  ) {}

  public setDocumentService(documents: McpDocumentService): void {
    this.documents = documents;
  }

  private requireDocuments(): McpDocumentService {
    if (this.documents === undefined) throw new Error("McpDocumentService has not been attached.");
    return this.documents;
  }

  public async query(options: {
    readonly projectFile?: string;
    readonly action: "search" | "resolve";
    readonly definition: ReferenceDefinition;
    readonly query?: string;
    readonly value?: string | number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<Record<string, unknown>> {
    const project = await this.workspace.resolveProject(options.projectFile);
    const service = await this.createProjectService(project.projectFile, [options.definition.kind]);
    if (options.action === "search") {
      const result = await service.searchPage(
        options.definition,
        options.query ?? "",
        options.limit,
        options.cursor === undefined ? undefined : decodeReferenceSearchCursor(options.cursor),
      );
      if (result.status === "cursor.invalid"
        || result.status === "cursor.queryMismatch"
        || result.status === "cursor.snapshotChanged") {
        throw new VisualBridgeMcpError(result.status, result.message);
      }
      return {
        projectFile: project.projectFile,
        action: options.action,
        definition: options.definition,
        query: options.query ?? "",
        status: result.status,
        ...("message" in result ? { message: result.message } : {}),
        results: result.candidates,
        ...(result.status === "ok" && result.nextCursor !== undefined
          ? { nextCursor: encodeReferenceSearchCursor(result.nextCursor) }
          : {}),
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
    const service = await this.createProjectService(
      projectFile,
      occurrences.map((occurrence) => occurrence.definition.kind),
    );
    return [...this.sourceDiagnosticsOf(service), ...await service.validate(occurrences)];
  }

  public async resolve(
    projectFile: string,
    definition: ReferenceDefinition,
    value: string | number,
  ): Promise<ReferenceResolution> {
    return (await this.createProjectService(projectFile, [definition.kind])).resolve(definition, value);
  }

  public async validateChange(
    projectFile: string,
    before: readonly ReferenceOccurrence[],
    after: readonly ReferenceOccurrence[],
  ): Promise<{
    readonly diagnostics: readonly DocumentDiagnostic[];
    readonly introducedErrors: readonly DocumentDiagnostic[];
  }> {
    const service = await this.createProjectService(
      projectFile,
      [...before, ...after].map((occurrence) => occurrence.definition.kind),
    );
    const sourceDiagnostics = this.sourceDiagnosticsOf(service);
    const baseline = diagnosticCounts(await service.validate(before));
    const diagnostics = [...sourceDiagnostics, ...await service.validate(after)];
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

  public async createProjectService(
    projectFile: string,
    requestedKinds?: readonly string[],
    options: { readonly strictReferenceDataCode?: string } = {},
  ): Promise<ReferenceService> {
    const project = await this.workspace.resolveProject(projectFile);
    const kinds = requestedKinds === undefined ? undefined : new Set(requestedKinds);
    const documents = this.requireDocuments();
    const modules = (await this.modules.modulesFor(project)).active;
    const needsDocumentProvider = kinds === undefined || kinds.has("document");
    const documentSources = needsDocumentProvider
      ? await this.loadDocumentDescriptors(project, documents, modules, options)
      : { descriptors: [], skipped: [] };
    const documentDescriptors: DocumentReferenceDocument[] = [...documentSources.descriptors];
    const moduleReferenceData: Record<string, unknown> = {};
    const skippedDiagnostics: DocumentDiagnostic[] = [
      ...skippedReferenceSourceDiagnostics(documentSources.skipped),
    ];
    const providers: ReferenceProvider[] = [];
    if (needsDocumentProvider) {
      providers.push(createDocumentReferenceProvider(async () => documentDescriptors));
    }
    for (const module of modules) {
      const registered = module.facet.references.filter((entry) => kinds === undefined || kinds.has(entry.kind));
      if (registered.length === 0) continue;
      const loaded = await documents.loadModuleReferenceData(project, module, {
        ...(options.strictReferenceDataCode === undefined
          ? {}
          : { strictErrorCode: options.strictReferenceDataCode }),
      });
      moduleReferenceData[module.id] = loaded.data;
      skippedDiagnostics.push(...skippedReferenceSourceDiagnostics(loaded.skipped));
      registered.forEach((entry) => providers.push(entry.createProvider(async () => loaded.data)));
    }
    providers.push(...await this.providers?.referenceProviders(project) ?? []);
    const sourceDependencyKey = await this.captureSnapshotDependencyKey(project);
    const snapshotDependencyKey = referenceSemanticSnapshotDependencyKey(sourceDependencyKey, {
      project: project.definition,
      modules: moduleReferenceData,
      ...(needsDocumentProvider ? { documents: documentDescriptors } : {}),
    });
    const service = new ReferenceService(providers, snapshotDependencyKey);
    if (skippedDiagnostics.length > 0) {
      this.sourceDiagnostics.set(service, skippedDiagnostics);
    }
    return service;
  }

  private sourceDiagnosticsOf(service: ReferenceService): readonly DocumentDiagnostic[] {
    return this.sourceDiagnostics.get(service) ?? [];
  }

  private async loadDocumentDescriptors(
    project: ProjectContext,
    documents: McpDocumentService,
    modules: readonly ActiveModule[],
    options: { readonly strictReferenceDataCode?: string },
  ): Promise<{
    readonly descriptors: readonly DocumentReferenceDocument[];
    readonly skipped: readonly SkippedReferenceSource[];
  }> {
    const descriptors: DocumentReferenceDocument[] = [];
    const skipped: SkippedReferenceSource[] = [];
    for (const module of modules) {
      const loaded = await documents.loadDeclaredSources(project, module.editor, {
        ...(options.strictReferenceDataCode === undefined
          ? {}
          : { strictErrorCode: options.strictReferenceDataCode }),
      });
      skipped.push(...loaded.skipped);
      for (const entry of loaded.loaded) {
        if (entry.document === undefined) continue;
        const descriptor = module.facet.describe(entry.document, entry.context);
        // `document` Reference kind 只覆盖有文档 ID 的语义文档（Table 文档按路径定位，不参与）。
        if (descriptor.documentId === undefined) continue;
        descriptors.push({
          projectId: project.definition.projectId,
          documentTypeId: entry.documentType.id,
          editor: entry.documentType.editor,
          path: entry.path,
          documentId: descriptor.documentId,
          title: descriptor.title,
        });
      }
    }
    return {
      descriptors: descriptors.sort((left, right) => compareUtf16CodeUnits(
        `${left.documentTypeId}\u0000${left.path}`,
        `${right.documentTypeId}\u0000${right.path}`,
      )),
      skipped,
    };
  }

  private async captureSnapshotDependencyKey(project: ProjectContext): Promise<string> {
    const sourcePaths = await this.workspace.listAuthoringSourcePaths(project);
    const manifest = await Promise.all(sourcePaths.map(async (sourcePath) => {
      const absolutePath = await resolveExistingProjectPath(project, sourcePath);
      return [sourcePath, hashBytes(await readFile(absolutePath))] as const;
    }));
    return createHash("sha256")
      .update("visualbridge-reference-snapshot-v1\0")
      .update(JSON.stringify(manifest))
      .digest("hex");
  }

  /**
   * 建立 Project 文档索引。
   *
   * `strict`（默认）用于 Lifecycle：任何语义或 Reference 错误都会让索引失败。Refactor 用
   * `strict: false`：只要文档能解析就参与索引，与改造前"重命名不因无关文档的语义错误失败"一致。
   * `errorCode` 由调用方给出：两个工具对"源不可用"报不同的错误码，索引本身不猜领域归属。
   */
  public async buildProjectIndex(
    projectFile: string,
    options: { readonly strict?: boolean; readonly errorCode?: string } = {},
  ): Promise<readonly IndexedDocument[]> {
    const strict = options.strict ?? true;
    const errorCode = options.errorCode ?? "refactor.invalidSource";
    const project = await this.workspace.resolveProject(projectFile);
    const references = await this.createProjectService(project.projectFile);
    const documents = this.requireDocuments();
    const declared = await this.workspace.listDeclaredDocuments(project);
    const families = new Set<string>();
    const result: IndexedDocument[] = [];
    for (const source of declared) {
      const loaded = await documents.loadDocument({
        path: source.path,
        editor: source.documentType.editor,
        projectFile: project.projectFile,
        documentTypeId: source.documentType.id,
        includeProviderValidation: false,
        skipReferenceValidation: true,
      });
      if (loaded.document === undefined) {
        throw invalidIndexedSource(errorCode, source.path, loaded.diagnostics);
      }
      if (loaded.module.facet.storage === "sources") {
        // 多源文档在 `listDeclaredDocuments` 里会按物理文件重复出现；按源集合去重。
        const familyKey = `${source.documentType.id}\u0000${loaded.sources.map((entry) => entry.path).join("\u0000")}`;
        if (families.has(familyKey)) continue;
        families.add(familyKey);
      }
      if (strict) assertIndexable(errorCode, source.path, loaded.structuralDiagnostics);
      const referenceDiagnostics = strict ? await references.validate(loaded.occurrences) : [];
      if (strict) assertIndexable(errorCode, source.path, referenceDiagnostics);
      const descriptor = loaded.module.facet.describe(loaded.document, loaded.context);
      result.push({
        projectId: project.definition.projectId,
        documentTypeId: source.documentType.id,
        editor: source.documentType.editor,
        path: loaded.path,
        sourcePaths: loaded.sources.map((entry) => entry.path),
        ...(descriptor.documentId === undefined ? {} : { documentId: descriptor.documentId }),
        title: descriptor.title,
        diagnostics: strict ? [...loaded.structuralDiagnostics, ...referenceDiagnostics] : [],
        references: await resolveOccurrences(references, loaded.occurrences),
      });
    }
    return result.sort((left, right) => compareUtf16CodeUnits(documentIndexKey(left), documentIndexKey(right)));
  }
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

function assertIndexable(
  errorCode: string,
  sourcePath: string,
  diagnostics: readonly DocumentDiagnostic[],
): void {
  const blocking = diagnostics.filter((diagnostic) => (
    diagnostic.severity === "error"
    || diagnostic.code === "reference.providerUnavailable"
    || diagnostic.code === "reference.invalidTarget"
  ));
  if (blocking.length > 0) throw invalidIndexedSource(errorCode, sourcePath, blocking);
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

function invalidIndexedSource(
  errorCode: string,
  sourcePath: string,
  diagnostics: readonly unknown[],
): VisualBridgeMcpError {
  return new VisualBridgeMcpError(
    errorCode,
    `Source '${sourcePath}' is invalid and cannot participate in the projection${blockingDiagnosticSummary(diagnostics)}.`,
    diagnostics,
  );
}

/**
 * 索引失败必须点名**真正缺的那一项**，而不只是"某个源无效"。
 *
 * 典型场景（B4 第 2 轮 P2-5）：Project 未配置 `tableLayout` 时，create 会在投影索引阶段撞上
 * 另一个已声明表的解析失败；只报 `Source 'Tables/Skills.xlsx' is invalid` 会让用户以为是
 * 自己请求的目标文件有问题，而真正缺的是 `tableLayout.nameKeyRow/dataStartRow`。
 */
function blockingDiagnosticSummary(diagnostics: readonly unknown[]): string {
  const entries = diagnostics.filter((entry): entry is Readonly<Record<string, unknown>> => (
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
  ));
  const first = entries.find((entry) => entry.severity === "error") ?? entries[0];
  if (first === undefined) return "";
  const code = typeof first.code === "string" ? first.code : "error";
  const path = typeof first.path === "string" ? ` at ${first.path}` : "";
  const message = typeof first.message === "string" ? ` — ${first.message}` : "";
  return `: ${code}${path}${message}`;
}

/**
 * 被跳过的引用源必须是**可见**的：非 strict 调用方（read/search/validate/apply）会把它们
 * 作为引用快照诊断返回，而不是像 B4 第 1 轮那样静默丢掉（P2-2）。用 warning 是因为"另一个
 * 文件坏了"不应把当前文档判成 invalid；需要强一致的调用方（Refactor）走 strict 直接失败。
 */
function skippedReferenceSourceDiagnostics(
  skipped: readonly SkippedReferenceSource[],
): readonly DocumentDiagnostic[] {
  return skipped.map((source) => ({
    severity: "warning",
    code: "reference.sourceNotIndexed",
    path: source.path,
    message: `Reference source '${source.path}' (${source.documentTypeId}) was not indexed: ${source.message}`,
  }));
}

function encodeReferenceSearchCursor(cursor: ReferenceSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeReferenceSearchCursor(cursor: string): ReferenceSearchCursor {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ReferenceSearchCursor;
  } catch {
    throw new VisualBridgeMcpError("cursor.invalid", "The pagination cursor is invalid.");
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
