import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  canonicalJsonStringify,
  compareUtf16CodeUnits,
  type DocumentDiagnostic,
  type DocumentFacetContext,
  type DocumentFacetIncomingReference,
  type DocumentFacetSourceFile,
  type DocumentReferenceDocument,
  type DocumentTypeDefinition,
  type IndexedDocument,
  type JsonValue,
  type ProjectProviderDocumentSnapshot,
  type ReferenceOccurrence,
  type SemanticSnapshotSource,
} from "@visualbridge/core";
import { minimatch } from "minimatch";
import type { CatalogRegistryLoadResult } from "../catalog/catalogRegistryLoader";
import {
  documentFacetFor,
  loadDocumentTypeCatalogRegistry,
  type HostDocumentFacet,
} from "../modules/documentFacetRegistry";
import type { ProjectContext } from "../project/projectRegistry";
import type { WorkspaceProjectSemanticSnapshot, WorkspaceReferenceDataEntry } from "../reference/workspaceReferenceService";
import { projectSemanticSnapshotDependencyKey } from "./projectSemanticDependency";

export interface PreparedWorkspaceDocument {
  readonly projectKey: string;
  readonly dependencyKey: string;
  readonly document: Omit<IndexedDocument, "diagnostics" | "references">;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly occurrences: readonly ReferenceOccurrence[];
  readonly providerSnapshot?: ProjectProviderDocumentSnapshot;
  /** 模块 id → 该模块自己的不透明引用数据（`PreparedWorkspaceDocument` 不再有领域字段）。 */
  readonly referenceData?: Readonly<Record<string, unknown>>;
  /** 宿主内建的 `document` Reference kind 的候选数据。 */
  readonly referenceDocument?: DocumentReferenceDocument;
  /** 反向引用视图的定位信息（模块提供；缺失表示该 editor 没有这种导航）。 */
  readonly incomingReference?: (occurrencePath: string) => DocumentFacetIncomingReference | undefined;
}

interface CapturedText {
  readonly text?: string;
  readonly hash: string;
  readonly error?: unknown;
}

interface CapturedBytes {
  readonly bytes?: Uint8Array;
  readonly hash: string;
  readonly error?: unknown;
}

/**
 * 遍历 Document Type：有 `catalog` + `document` facet 的 editor 才参与语义索引。
 *
 * 宿主不再持有领域列表；文档的解析、校验、引用收集与引用数据全部来自 facet。
 */
export async function planWorkspaceSemanticSources(
  projects: readonly ProjectContext[],
  signal: AbortSignal,
  isEditorAvailable?: (project: ProjectContext, documentType: DocumentTypeDefinition) => boolean,
): Promise<readonly SemanticSnapshotSource<PreparedWorkspaceDocument>[]> {
  const sources: SemanticSnapshotSource<PreparedWorkspaceDocument>[] = [];
  for (const project of projects) {
    throwIfAborted(signal);
    for (const documentType of project.definition.documentTypes) {
      throwIfAborted(signal);
      const host = documentFacetFor(documentType.editor);
      if (host === undefined) continue;
      if (isEditorAvailable !== undefined && !isEditorAvailable(project, documentType)) continue;
      const uris = await findDocumentUris(project, documentType);
      throwIfAborted(signal);
      const catalog = await loadDocumentTypeCatalogRegistry(project, documentType);
      if (catalog === undefined) continue;
      const catalogKey = catalogDependencyKey(project, documentType, catalog);
      if (host.facet.storage === "sources") {
        sources.push(...await planSourceDocuments(project, documentType, host, uris, catalog, catalogKey, signal));
        continue;
      }
      for (const uri of uris) {
        const path = relativeProjectPath(project, uri);
        const captured = await captureText(uri);
        sources.push(source(
          project,
          documentType,
          host,
          path,
          [path],
          catalogKey,
          [captured.hash],
          async (loadSignal) => prepareTextDocument(
            project,
            documentType,
            host,
            path,
            captured,
            catalog,
            catalogKey,
            loadSignal,
          ),
        ));
      }
    }
  }
  return sources;
}

/** 把已 `load` 的结果聚合成每个 Project 的语义快照（模块 id → 引用数据）。 */
export function buildReferenceSnapshots(
  projects: readonly ProjectContext[],
  prepared: readonly PreparedWorkspaceDocument[],
): ReadonlyMap<string, WorkspaceProjectSemanticSnapshot> {
  const result = new Map<string, WorkspaceProjectSemanticSnapshot>();
  for (const project of projects) {
    const projectKey = project.markerUri.toString();
    const projectDocuments = prepared
      .filter((entry) => entry.projectKey === projectKey)
      .sort((left, right) => compareUtf16CodeUnits(
        `${left.document.documentTypeId}\u0000${left.document.path}`,
        `${right.document.documentTypeId}\u0000${right.document.path}`,
      ));
    const referenceData = new Map<string, WorkspaceReferenceDataEntry[]>();
    for (const entry of projectDocuments) {
      for (const [moduleId, data] of Object.entries(entry.referenceData ?? {})) {
        const referenceEntry: WorkspaceReferenceDataEntry = {
          documentTypeId: entry.document.documentTypeId,
          sourcePaths: entry.document.sourcePaths,
          data,
        };
        const values = referenceData.get(moduleId);
        if (values === undefined) referenceData.set(moduleId, [referenceEntry]);
        else values.push(referenceEntry);
      }
    }
    result.set(projectKey, {
      dependencyKey: projectSemanticSnapshotDependencyKey(
        project.definition,
        projectDocuments.map((entry) => ({
          documentTypeId: entry.document.documentTypeId,
          path: entry.document.path,
          dependencyKey: entry.dependencyKey,
        })),
      ),
      documents: projectDocuments.flatMap((entry) => (
        entry.referenceDocument === undefined ? [] : [entry.referenceDocument]
      )),
      referenceData: Object.fromEntries(referenceData),
    });
  }
  return result;
}

/** 没有 Document Index 快照时的按需装载（打开文档早于首次索引刷新时使用）。 */
export async function loadProjectReferenceSnapshots(
  projects: readonly ProjectContext[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, WorkspaceProjectSemanticSnapshot>> {
  const prepared: PreparedWorkspaceDocument[] = [];
  for (const planned of await planWorkspaceSemanticSources(projects, signal)) {
    throwIfAborted(signal);
    prepared.push(await planned.load(signal));
  }
  return buildReferenceSnapshots(projects, prepared);
}

function source(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  host: HostDocumentFacet,
  path: string,
  sourcePaths: readonly string[],
  catalogKey: string,
  sourceHashes: readonly string[],
  load: (signal: AbortSignal) => Promise<PreparedWorkspaceDocument>,
): SemanticSnapshotSource<PreparedWorkspaceDocument> {
  const dependencyKey = hashText(canonicalJsonStringify({
    project: project.definition,
    documentType,
    moduleOptions: moduleOptions(project, host.moduleId) ?? null,
    catalogKey,
    sources: sourcePaths.map((sourcePath, index) => ({ path: sourcePath, hash: sourceHashes[index] })),
  }));
  return {
    key: `${project.markerUri.toString()}\u0000${documentType.id}\u0000${path}`,
    dependencyKey,
    async load(signal) {
      throwIfAborted(signal);
      const value = await load(signal);
      throwIfAborted(signal);
      return { ...value, dependencyKey };
    },
  };
}

async function prepareTextDocument(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  host: HostDocumentFacet,
  path: string,
  captured: CapturedText,
  catalog: CatalogRegistryLoadResult<unknown, unknown>,
  dependencyKey: string,
  signal: AbortSignal,
): Promise<PreparedWorkspaceDocument> {
  if (captured.text === undefined) return unreadable(project, documentType, path, captured.error, dependencyKey);
  const context = facetContext(project, documentType, host, path, [path], catalog);
  throwIfAborted(signal);
  const parsed = await host.facet.parseText!(captured.text, context);
  throwIfAborted(signal);
  if (!parsed.success) {
    return invalid(project, documentType, path, [...catalog.diagnostics, ...parsed.diagnostics], dependencyKey);
  }
  const description = host.facet.describe(parsed.document, context);
  return {
    projectKey: project.markerUri.toString(),
    dependencyKey,
    document: baseDocument(project, documentType, path, [path], description.title, description.documentId),
    diagnostics: [
      ...parsed.diagnostics,
      ...catalog.diagnostics,
      ...(catalog.ready ? host.facet.validate(parsed.document, context) : []),
    ],
    occurrences: catalog.ready ? host.facet.collectReferences(parsed.document, context) : [],
    providerSnapshot: providerSnapshot(documentType.id, path, captured.hash, parsed.document as JsonValue),
    ...(parsed.referenceData === undefined ? {} : { referenceData: { [host.moduleId]: parsed.referenceData } }),
    ...(host.facet.incomingReference === undefined ? {} : {
      incomingReference: (occurrencePath: string) => host.facet.incomingReference!(parsed.document, context, occurrencePath),
    }),
    ...(description.documentId === undefined ? {} : {
      referenceDocument: {
        projectId: project.definition.projectId,
        documentTypeId: documentType.id,
        editor: documentType.editor,
        path,
        documentId: description.documentId,
        title: description.title,
      },
    }),
  };
}

/**
 * 多源文档：宿主只做与领域无关的目录/扩展名候选收集，家族选择与解析交给 `storage: "sources"` facet。
 */
async function planSourceDocuments(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  host: HostDocumentFacet,
  uris: readonly vscode.Uri[],
  catalog: CatalogRegistryLoadResult<unknown, unknown>,
  catalogKey: string,
  signal: AbortSignal,
): Promise<readonly SemanticSnapshotSource<PreparedWorkspaceDocument>[]> {
  const captures = new Map<string, CapturedBytes>();
  const uriByPath = new Map<string, vscode.Uri>();
  for (const uri of uris) {
    throwIfAborted(signal);
    const path = relativeProjectPath(project, uri);
    uriByPath.set(path, uri);
    captures.set(path, await captureBytes(uri));
  }
  const planned: SemanticSnapshotSource<PreparedWorkspaceDocument>[] = [];
  const remaining = new Map([...uriByPath.keys()].map((path) => [path, path]));
  while (remaining.size > 0) {
    const activePath = [...remaining.keys()].sort(compareUtf16CodeUnits)[0]!;
    const activeCapture = captures.get(activePath)!;
    if (activeCapture.bytes === undefined) {
      remaining.delete(activePath);
      planned.push(source(project, documentType, host, activePath, [activePath], catalogKey, [activeCapture.hash], async () => (
        unreadable(project, documentType, activePath, activeCapture.error, catalogKey)
      )));
      continue;
    }
    const context = facetContext(project, documentType, host, activePath, [activePath], catalog);
    const candidatePaths = [...remaining.values()].sort(compareUtf16CodeUnits);
    const familyPaths = host.facet.planSources === undefined
      ? [activePath]
      : [...host.facet.planSources({ path: activePath, bytes: activeCapture.bytes }, candidatePaths, context)];
    const family = (familyPaths.includes(activePath) ? familyPaths : [activePath, ...familyPaths])
      .filter((path) => remaining.has(path))
      .sort(compareUtf16CodeUnits);
    const selected = family.length === 0 ? [activePath] : family;
    selected.forEach((path) => remaining.delete(path));
    const sourcePaths = [...selected].sort(compareUtf16CodeUnits);
    const hashes = sourcePaths.map((path) => captures.get(path)!.hash);
    planned.push(source(
      project,
      documentType,
      host,
      sourcePaths[0]!,
      sourcePaths,
      catalogKey,
      hashes,
      async (loadSignal) => prepareSourceDocument(
        project,
        documentType,
        host,
        sourcePaths,
        captures,
        catalog,
        catalogKey,
        loadSignal,
      ),
    ));
  }
  return planned;
}

async function prepareSourceDocument(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  host: HostDocumentFacet,
  sourcePaths: readonly string[],
  captures: ReadonlyMap<string, CapturedBytes>,
  catalog: CatalogRegistryLoadResult<unknown, unknown>,
  dependencyKey: string,
  signal: AbortSignal,
): Promise<PreparedWorkspaceDocument> {
  const path = sourcePaths[0] ?? "";
  const files: DocumentFacetSourceFile[] = [];
  for (const sourcePath of sourcePaths) {
    const captured = captures.get(sourcePath);
    if (captured?.bytes === undefined) {
      return unreadable(project, documentType, path, captured?.error ?? new Error(`'${sourcePath}' is unreadable.`), dependencyKey);
    }
    files.push({ path: sourcePath, bytes: captured.bytes });
  }
  const context = facetContext(project, documentType, host, path, sourcePaths, catalog);
  throwIfAborted(signal);
  const parsed = await host.facet.parseSources!(files, context);
  throwIfAborted(signal);
  if (!parsed.success) {
    return invalid(project, documentType, path, [...catalog.diagnostics, ...parsed.diagnostics], dependencyKey);
  }
  const description = host.facet.describe(parsed.document, context);
  return {
    projectKey: project.markerUri.toString(),
    dependencyKey,
    document: baseDocument(project, documentType, path, sourcePaths, description.title, description.documentId),
    diagnostics: [
      ...parsed.diagnostics,
      ...catalog.diagnostics,
    ],
    occurrences: catalog.ready ? host.facet.collectReferences(parsed.document, context) : [],
    providerSnapshot: providerSnapshot(documentType.id, path, combinedHash(sourcePaths, captures), parsed.document as JsonValue),
    ...(parsed.referenceData === undefined ? {} : { referenceData: { [host.moduleId]: parsed.referenceData } }),
    ...(description.documentId === undefined ? {} : {
      referenceDocument: {
        projectId: project.definition.projectId,
        documentTypeId: documentType.id,
        editor: documentType.editor,
        path,
        documentId: description.documentId,
        title: description.title,
      },
    }),
  };
}

function facetContext(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  host: HostDocumentFacet,
  path: string,
  sourcePaths: readonly string[],
  catalog: CatalogRegistryLoadResult<unknown, unknown>,
): DocumentFacetContext<unknown> {
  return {
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    path,
    sourcePaths,
    registry: catalog.ready ? catalog.registry : undefined,
    projectDefinition: project.definition as unknown as JsonValue,
    moduleOptions: moduleOptions(project, host.moduleId),
  };
}

function moduleOptions(project: ProjectContext, moduleId: string): JsonValue | undefined {
  return project.definition.modules.find((entry) => entry.id === moduleId)?.options;
}

function invalid(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  diagnostics: readonly DocumentDiagnostic[],
  dependencyKey: string,
): PreparedWorkspaceDocument {
  return {
    projectKey: project.markerUri.toString(),
    dependencyKey,
    document: baseDocument(project, documentType, path, [path], fileTitle(path)),
    diagnostics,
    occurrences: [],
  };
}

function unreadable(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  errorValue: unknown,
  dependencyKey: string,
): PreparedWorkspaceDocument {
  return invalid(project, documentType, path, [{
    severity: "error",
    code: "document.unreadable",
    path: "$",
    message: formatError(errorValue),
  }], dependencyKey);
}

function baseDocument(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  sourcePaths: readonly string[],
  title: string,
  documentId?: string,
): Omit<IndexedDocument, "diagnostics" | "references"> {
  return {
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    editor: documentType.editor,
    path,
    sourcePaths,
    title: title.length === 0 ? fileTitle(path) : title,
    ...(documentId === undefined ? {} : { documentId }),
  };
}

function providerSnapshot(
  documentTypeId: string,
  path: string,
  sourceHash: string,
  content: JsonValue,
): ProjectProviderDocumentSnapshot {
  return { documentTypeId, path, sourceHash, content };
}

function catalogDependencyKey(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  catalog: CatalogRegistryLoadResult<unknown, unknown>,
): string {
  return hashText(canonicalJsonStringify({
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    editor: documentType.editor,
    catalogs: catalog.sources.map((source) => ({ path: source.path, contentHash: source.contentHash ?? null })),
  }));
}

async function findDocumentUris(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
): Promise<readonly vscode.Uri[]> {
  const result = new Map<string, vscode.Uri>();
  for (const include of documentType.include) {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(project.rootUri, include));
    for (const uri of uris) {
      const path = relativeProjectPath(project, uri);
      if (documentType.include.some((pattern) => matches(pattern, path))
        && !documentType.exclude.some((pattern) => matches(pattern, path))) {
        result.set(uri.toString(), uri);
      }
    }
  }
  return [...result.values()].sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
}

async function captureText(uri: vscode.Uri): Promise<CapturedText> {
  try {
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    const text = open?.getText() ?? new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
    return { text, hash: hashText(text) };
  } catch (error) {
    return { hash: hashText(`unreadable:${formatError(error)}`), error };
  }
}

async function captureBytes(uri: vscode.Uri): Promise<CapturedBytes> {
  try {
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    const bytes = open === undefined ? await vscode.workspace.fs.readFile(uri) : new TextEncoder().encode(open.getText());
    return { bytes, hash: hashBytes(bytes) };
  } catch (error) {
    return { hash: hashText(`unreadable:${formatError(error)}`), error };
  }
}

function combinedHash(paths: readonly string[], captures: ReadonlyMap<string, CapturedBytes>): string {
  return hashText(paths
    .map((path) => `${path}\u0000${captures.get(path)?.hash ?? ""}`)
    .sort(compareUtf16CodeUnits)
    .join("\n"));
}

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  return nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

function matches(pattern: string, relativePath: string): boolean {
  return minimatch(relativePath, pattern, { dot: true, nocase: process.platform === "win32" });
}

function fileTitle(path: string): string {
  return nodePath.basename(path, nodePath.extname(path));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Workspace semantic snapshot build was cancelled.", "AbortError");
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? "Unknown error.");
}
