import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  type DocumentDiagnostic,
  type DocumentReferenceDocument,
  type DocumentTypeDefinition,
  type IndexedDocument,
  type JsonValue,
  type ProjectProviderDocumentSnapshot,
  type ReferenceOccurrence,
  type SemanticSnapshotSource,
} from "@visualbridge/core";
import {
  collectEntityReferences,
  parseEntityDocument,
  validateEntityDocument,
  type EntityReferenceDocument,
} from "@visualbridge/entity";
import {
  collectGraphReferences,
  parseGraphDocument,
  validateGraphDocument,
  type GraphReferenceDocument,
} from "@visualbridge/graph";
import {
  collectStructuredReferences,
  parseStructuredDocument,
  resolveStructuredConfigType,
  validateStructuredDocument,
} from "@visualbridge/structured";
import {
  collectTableReferences,
  matchTableSheetDefinitions,
  parseCsvTable,
  parseXlsxTable,
  resolveTableType,
  validateTableDocument,
  type TableDocument,
  type TableReferenceDocument,
  type TableSheet,
  type TableTypeDefinition,
} from "@visualbridge/table";
import { minimatch } from "minimatch";
import { loadEntityCatalogRegistry } from "../catalog/entityCatalogLoader";
import { loadGraphCatalogRegistry } from "../catalog/graphCatalogLoader";
import { loadStructuredCatalogRegistry } from "../catalog/structuredCatalogLoader";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import type { CatalogRegistryLoadResult } from "../catalog/catalogRegistryLoader";
import type { ProjectContext } from "../project/projectRegistry";
import type { WorkspaceProjectSemanticSnapshot } from "../reference/workspaceReferenceService";
import { projectSemanticSnapshotDependencyKey } from "./projectSemanticDependency";

const SUPPORTED_EDITORS = new Set(["graph", "entity", "structured", "table"]);

export interface PreparedWorkspaceDocument {
  readonly projectKey: string;
  readonly dependencyKey: string;
  readonly document: Omit<IndexedDocument, "diagnostics" | "references">;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly occurrences: readonly ReferenceOccurrence[];
  readonly providerSnapshot?: ProjectProviderDocumentSnapshot;
  readonly referenceDocument?: DocumentReferenceDocument;
  readonly entityReferenceDocument?: EntityReferenceDocument;
  readonly graphReferenceDocument?: GraphReferenceDocument;
  readonly tableReferenceDocument?: TableReferenceDocument;
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

export async function planWorkspaceSemanticSources(
  projects: readonly ProjectContext[],
  signal: AbortSignal,
): Promise<readonly SemanticSnapshotSource<PreparedWorkspaceDocument>[]> {
  const sources: SemanticSnapshotSource<PreparedWorkspaceDocument>[] = [];
  for (const project of projects) {
    throwIfAborted(signal);
    for (const documentType of project.definition.documentTypes.filter((entry) => SUPPORTED_EDITORS.has(entry.editor))) {
      throwIfAborted(signal);
      const uris = await findDocumentUris(project, documentType);
      throwIfAborted(signal);
      if (documentType.editor === "graph") {
        const catalog = await loadGraphCatalogRegistry(project, documentType.catalogs);
        const catalogKey = catalogDependencyKey(project, documentType, catalog);
        for (const uri of uris) {
          const path = relativeProjectPath(project, uri);
          const captured = await captureText(uri);
          sources.push(source(project, documentType, path, [path], catalogKey, [captured.hash], async () => (
            prepareGraph(project, documentType, path, captured, catalog, catalogKey)
          )));
        }
      } else if (documentType.editor === "entity") {
        const catalog = await loadEntityCatalogRegistry(project, documentType.catalogs);
        const catalogKey = catalogDependencyKey(project, documentType, catalog);
        for (const uri of uris) {
          const path = relativeProjectPath(project, uri);
          const captured = await captureText(uri);
          sources.push(source(project, documentType, path, [path], catalogKey, [captured.hash], async () => (
            prepareEntity(project, documentType, path, captured, catalog, catalogKey)
          )));
        }
      } else if (documentType.editor === "structured") {
        const catalog = await loadStructuredCatalogRegistry(project, documentType.catalogs);
        const catalogKey = catalogDependencyKey(project, documentType, catalog);
        for (const uri of uris) {
          const path = relativeProjectPath(project, uri);
          const captured = await captureText(uri);
          sources.push(source(project, documentType, path, [path], catalogKey, [captured.hash], async () => (
            prepareStructured(project, documentType, path, captured, catalog, catalogKey)
          )));
        }
      } else {
        const catalog = await loadTableCatalogRegistry(project, documentType.catalogs);
        const catalogKey = catalogDependencyKey(project, documentType, catalog);
        sources.push(...await planTableSources(project, documentType, uris, catalog, catalogKey, signal));
      }
    }
  }
  return sources;
}

export function buildReferenceSnapshots(
  projects: readonly ProjectContext[],
  prepared: readonly PreparedWorkspaceDocument[],
): ReadonlyMap<string, WorkspaceProjectSemanticSnapshot> {
  const result = new Map<string, WorkspaceProjectSemanticSnapshot>();
  for (const project of projects) {
    const projectKey = project.markerUri.toString();
    const projectDocuments = prepared.filter((entry) => entry.projectKey === projectKey);
    const sort = <T extends { readonly documentTypeId: string; readonly path: string }>(values: readonly T[]): readonly T[] => (
      [...values].sort((left, right) => compareOrdinal(
        `${left.documentTypeId}\u0000${left.path}`,
        `${right.documentTypeId}\u0000${right.path}`,
      ))
    );
    result.set(project.markerUri.toString(), {
      dependencyKey: projectSemanticSnapshotDependencyKey(
        project.definition,
        projectDocuments.map((entry) => ({
          documentTypeId: entry.document.documentTypeId,
          path: entry.document.path,
          dependencyKey: entry.dependencyKey,
        })),
      ),
      documents: sort(projectDocuments.flatMap((entry) => entry.referenceDocument === undefined ? [] : [entry.referenceDocument])),
      entities: sort(projectDocuments.flatMap((entry) => entry.entityReferenceDocument === undefined ? [] : [entry.entityReferenceDocument])),
      graphs: sort(projectDocuments.flatMap((entry) => entry.graphReferenceDocument === undefined ? [] : [entry.graphReferenceDocument])),
      tables: sort(projectDocuments.flatMap((entry) => entry.tableReferenceDocument === undefined ? [] : [entry.tableReferenceDocument])),
    });
  }
  return result;
}

function source(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  sourcePaths: readonly string[],
  catalogKey: string,
  sourceHashes: readonly string[],
  load: (signal: AbortSignal) => Promise<PreparedWorkspaceDocument>,
): SemanticSnapshotSource<PreparedWorkspaceDocument> {
  const dependencyKey = hashText(JSON.stringify({
    project: project.definition,
    documentType,
    tableLayout: documentType.editor === "table" ? project.definition.tableLayout : undefined,
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

async function prepareGraph(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  captured: CapturedText,
  catalog: Awaited<ReturnType<typeof loadGraphCatalogRegistry>>,
  dependencyKey: string,
): Promise<PreparedWorkspaceDocument> {
  if (captured.text === undefined) return unreadable(project, documentType, path, captured.error, dependencyKey);
  const parsed = parseGraphDocument(captured.text);
  if (!parsed.success) return invalid(project, documentType, path, [...catalog.diagnostics, ...parsed.diagnostics], dependencyKey);
  const root = parsed.document.graphs.find((graph) => graph.id === parsed.document.rootGraphId);
  return {
    projectKey: project.markerUri.toString(),
    dependencyKey,
    document: baseDocument(project, documentType, path, [path], root?.title ?? fileTitle(path), parsed.document.documentId),
    diagnostics: [
      ...parsed.diagnostics,
      ...catalog.diagnostics,
      ...(catalog.ready ? validateGraphDocument(parsed.document, catalog.registry) : []),
    ],
    occurrences: catalog.ready ? collectGraphReferences(parsed.document, catalog.registry) : [],
    providerSnapshot: providerSnapshot(documentType.id, path, captured.hash, parsed.document as unknown as JsonValue),
    referenceDocument: {
      projectId: project.definition.projectId,
      documentTypeId: documentType.id,
      editor: documentType.editor,
      path,
      documentId: parsed.document.documentId,
      title: root?.title ?? fileTitle(path),
    },
    graphReferenceDocument: {
      projectId: project.definition.projectId,
      documentTypeId: documentType.id,
      path,
      document: parsed.document,
    },
  };
}

async function prepareEntity(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  captured: CapturedText,
  catalog: Awaited<ReturnType<typeof loadEntityCatalogRegistry>>,
  dependencyKey: string,
): Promise<PreparedWorkspaceDocument> {
  if (captured.text === undefined) return unreadable(project, documentType, path, captured.error, dependencyKey);
  const parsed = parseEntityDocument(captured.text);
  if (!parsed.success) return invalid(project, documentType, path, [...catalog.diagnostics, ...parsed.diagnostics], dependencyKey);
  return {
    projectKey: project.markerUri.toString(),
    dependencyKey,
    document: baseDocument(project, documentType, path, [path], parsed.document.title, parsed.document.documentId),
    diagnostics: [
      ...parsed.diagnostics,
      ...catalog.diagnostics,
      ...(catalog.ready ? validateEntityDocument(parsed.document, catalog.registry) : []),
    ],
    occurrences: catalog.ready ? collectEntityReferences(parsed.document, catalog.registry) : [],
    providerSnapshot: providerSnapshot(documentType.id, path, captured.hash, parsed.document as unknown as JsonValue),
    referenceDocument: {
      projectId: project.definition.projectId,
      documentTypeId: documentType.id,
      editor: documentType.editor,
      path,
      documentId: parsed.document.documentId,
      title: parsed.document.title,
    },
    ...(catalog.ready ? {
      entityReferenceDocument: {
        projectId: project.definition.projectId,
        documentTypeId: documentType.id,
        path,
        document: parsed.document,
        registry: catalog.registry,
      },
    } : {}),
  };
}

async function prepareStructured(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  captured: CapturedText,
  catalog: Awaited<ReturnType<typeof loadStructuredCatalogRegistry>>,
  dependencyKey: string,
): Promise<PreparedWorkspaceDocument> {
  if (captured.text === undefined) return unreadable(project, documentType, path, captured.error, dependencyKey);
  const parsed = parseStructuredDocument(captured.text);
  if (!parsed.success) return invalid(project, documentType, path, [...catalog.diagnostics, ...parsed.diagnostics], dependencyKey);
  const configType = catalog.ready ? resolveStructuredConfigType(catalog.registry, documentType.id) : undefined;
  const title = configType?.title ?? fileTitle(path);
  return {
    projectKey: project.markerUri.toString(),
    dependencyKey,
    document: baseDocument(project, documentType, path, [path], title, parsed.document.documentId),
    diagnostics: [
      ...parsed.diagnostics,
      ...catalog.diagnostics,
      ...(catalog.ready ? validateStructuredDocument(parsed.document, catalog.registry, documentType.id) : []),
    ],
    occurrences: catalog.ready ? collectStructuredReferences(parsed.document, catalog.registry, documentType.id) : [],
    providerSnapshot: providerSnapshot(documentType.id, path, captured.hash, parsed.document as unknown as JsonValue),
    referenceDocument: {
      projectId: project.definition.projectId,
      documentTypeId: documentType.id,
      editor: documentType.editor,
      path,
      documentId: parsed.document.documentId,
      title,
    },
  };
}

async function planTableSources(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  uris: readonly vscode.Uri[],
  catalog: Awaited<ReturnType<typeof loadTableCatalogRegistry>>,
  catalogKey: string,
  signal: AbortSignal,
): Promise<readonly SemanticSnapshotSource<PreparedWorkspaceDocument>[]> {
  const layout = project.definition.tableLayout;
  const tableType = catalog.ready ? resolveTableType(catalog.registry, documentType.id) : undefined;
  const captures = new Map<string, CapturedBytes>();
  for (const uri of uris) {
    throwIfAborted(signal);
    captures.set(uri.toString(), await captureBytes(uri));
  }
  if (layout === undefined || tableType === undefined) {
    const diagnostics = tableUnavailableDiagnostics(documentType, catalog, layout === undefined, tableType === undefined);
    return uris.map((uri) => {
      const path = relativeProjectPath(project, uri);
      const captured = captures.get(uri.toString())!;
      return source(project, documentType, path, [path], catalogKey, [captured.hash], async () => (
        captured.bytes === undefined
          ? unreadable(project, documentType, path, captured.error, catalogKey)
          : invalid(project, documentType, path, diagnostics, catalogKey)
      ));
    });
  }
  const result: SemanticSnapshotSource<PreparedWorkspaceDocument>[] = [];
  const remaining = new Map(uris.map((uri) => [uri.toString(), uri]));
  while (remaining.size > 0) {
    const active = [...remaining.values()].sort((left, right) => compareOrdinal(left.path, right.path))[0]!;
    const activeCapture = captures.get(active.toString())!;
    if (activeCapture.bytes === undefined || isXlsx(activeCapture.bytes)) {
      remaining.delete(active.toString());
      const path = relativeProjectPath(project, active);
      result.push(source(project, documentType, path, [path], catalogKey, [activeCapture.hash], async (loadSignal) => (
        prepareXlsx(project, documentType, path, activeCapture, tableType, layout, catalog.diagnostics, catalogKey, loadSignal)
      )));
      continue;
    }
    const family = selectCsvFamily(active, [...remaining.values()], tableType);
    family.forEach((uri) => remaining.delete(uri.toString()));
    const sourcePaths = family.map((uri) => relativeProjectPath(project, uri)).sort(compareOrdinal);
    const familyCaptures = family.map((uri) => ({ uri, captured: captures.get(uri.toString())! }));
    result.push(source(
      project,
      documentType,
      sourcePaths[0] ?? "",
      sourcePaths,
      catalogKey,
      familyCaptures.map((entry) => entry.captured.hash),
      async (loadSignal) => prepareCsv(
        project,
        documentType,
        familyCaptures,
        tableType,
        layout,
        catalog.diagnostics,
        catalogKey,
        loadSignal,
      ),
    ));
  }
  return result;
}

async function prepareXlsx(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  captured: CapturedBytes,
  tableType: TableTypeDefinition,
  layout: NonNullable<ProjectContext["definition"]["tableLayout"]>,
  catalogDiagnostics: readonly DocumentDiagnostic[],
  dependencyKey: string,
  signal: AbortSignal,
): Promise<PreparedWorkspaceDocument> {
  if (captured.bytes === undefined) return unreadable(project, documentType, path, captured.error, dependencyKey);
  const parsed = await parseXlsxTable(captured.bytes, tableType, layout);
  throwIfAborted(signal);
  if (!parsed.success) return invalid(project, documentType, path, [...catalogDiagnostics, ...parsed.diagnostics], dependencyKey);
  return prepareTable(
    project,
    documentType,
    path,
    [path],
    captured.hash,
    parsed.document,
    tableType,
    [...catalogDiagnostics, ...parsed.diagnostics],
    Object.fromEntries(parsed.document.sheets.map((sheet) => [sheet.id, path])),
    dependencyKey,
  );
}

async function prepareCsv(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  entries: readonly { readonly uri: vscode.Uri; readonly captured: CapturedBytes }[],
  tableType: TableTypeDefinition,
  layout: NonNullable<ProjectContext["definition"]["tableLayout"]>,
  catalogDiagnostics: readonly DocumentDiagnostic[],
  dependencyKey: string,
  signal: AbortSignal,
): Promise<PreparedWorkspaceDocument> {
  const diagnostics: DocumentDiagnostic[] = [...catalogDiagnostics];
  const sheets: TableSheet[] = [];
  const sourcePaths: string[] = [];
  const sheetPaths: Record<string, string> = {};
  for (const { uri, captured } of entries) {
    throwIfAborted(signal);
    const path = relativeProjectPath(project, uri);
    sourcePaths.push(path);
    const physicalName = nodePath.basename(uri.fsPath, nodePath.extname(uri.fsPath));
    if (captured.bytes === undefined) {
      diagnostics.push({ severity: "error", code: "document.unreadable", path: physicalName, message: formatError(captured.error) });
      continue;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes);
      const parsed = parseCsvTable(text, tableType, layout, physicalName);
      if (!parsed.success) {
        diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, path: `${physicalName}.${diagnostic.path}` })));
      } else {
        sheets.push(...parsed.document.sheets);
        parsed.document.sheets.forEach((sheet) => { sheetPaths[sheet.id] = path; });
        diagnostics.push(...parsed.diagnostics);
      }
    } catch (errorValue) {
      diagnostics.push({ severity: "error", code: "document.unreadable", path: physicalName, message: formatError(errorValue) });
    }
  }
  sourcePaths.sort(compareOrdinal);
  const document: TableDocument = { format: "csv", sheets };
  return prepareTable(
    project,
    documentType,
    sourcePaths[0] ?? "",
    sourcePaths,
    hashText(entries.map((entry) => `${relativeProjectPath(project, entry.uri)}\u0000${entry.captured.hash}`).sort(compareOrdinal).join("\n")),
    document,
    tableType,
    diagnostics,
    sheetPaths,
    dependencyKey,
  );
}

function prepareTable(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  path: string,
  sourcePaths: readonly string[],
  sourceHash: string,
  document: TableDocument,
  tableType: TableTypeDefinition,
  diagnostics: readonly DocumentDiagnostic[],
  sheetPaths: Readonly<Record<string, string>>,
  dependencyKey: string,
): PreparedWorkspaceDocument {
  return {
    projectKey: project.markerUri.toString(),
    dependencyKey,
    document: baseDocument(project, documentType, path, sourcePaths, tableType.title),
    diagnostics: [...diagnostics, ...validateTableDocument(document, tableType)],
    occurrences: collectTableReferences(document, tableType),
    providerSnapshot: providerSnapshot(documentType.id, path, sourceHash, document as unknown as JsonValue),
    tableReferenceDocument: {
      projectId: project.definition.projectId,
      documentTypeId: documentType.id,
      path,
      document,
      tableType,
      sheetPaths,
    },
  };
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
    title,
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

function catalogDependencyKey<TCatalog, TRegistry>(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  catalog: CatalogRegistryLoadResult<TCatalog, TRegistry>,
): string {
  return hashText(JSON.stringify({
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    editor: documentType.editor,
    catalogs: catalog.sources.map((source) => ({ path: source.path, contentHash: source.contentHash ?? null })),
  }));
}

function tableUnavailableDiagnostics<TCatalog, TRegistry>(
  documentType: DocumentTypeDefinition,
  catalog: CatalogRegistryLoadResult<TCatalog, TRegistry>,
  layoutMissing: boolean,
  typeMissing: boolean,
): readonly DocumentDiagnostic[] {
  return [
    ...catalog.diagnostics,
    ...(layoutMissing ? [{
      severity: "error" as const,
      code: "table.layoutNotConfigured",
      path: "tableLayout",
      message: "The project does not configure tableLayout.",
    }] : []),
    ...(catalog.ready && typeMissing ? [{
      severity: "error" as const,
      code: "table.unknownTableType",
      path: "documentType.id",
      message: `Document Type '${documentType.id}' does not resolve to a Table Type.`,
    }] : []),
  ];
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
  return [...result.values()].sort((left, right) => compareOrdinal(left.path, right.path));
}

function selectCsvFamily(
  active: vscode.Uri,
  candidates: readonly vscode.Uri[],
  tableType: TableTypeDefinition,
): readonly vscode.Uri[] {
  if (!tableType.sheets.some((sheet) => sheet.partition !== undefined)) return [active];
  const activeDirectory = nodePath.dirname(active.fsPath).toLocaleLowerCase();
  const activeExtension = nodePath.extname(active.fsPath).toLocaleLowerCase();
  const physicalName = nodePath.basename(active.fsPath, nodePath.extname(active.fsPath));
  if (!matchTableSheetDefinitions(tableType, physicalName).some((sheet) => sheet.partition !== undefined)) return [active];
  return candidates.filter((candidate) => {
    if (nodePath.dirname(candidate.fsPath).toLocaleLowerCase() !== activeDirectory
      || nodePath.extname(candidate.fsPath).toLocaleLowerCase() !== activeExtension) return false;
    const name = nodePath.basename(candidate.fsPath, nodePath.extname(candidate.fsPath));
    return matchTableSheetDefinitions(tableType, name).some((sheet) => sheet.partition !== undefined);
  }).sort((left, right) => compareOrdinal(left.path, right.path));
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

function relativeProjectPath(project: ProjectContext, uri: vscode.Uri): string {
  return nodePath.relative(project.rootUri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

function matches(pattern: string, relativePath: string): boolean {
  return minimatch(relativePath, pattern, { dot: true, nocase: process.platform === "win32" });
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
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

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Workspace semantic snapshot build was cancelled.", "AbortError");
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value ?? "Unknown error.");
}
