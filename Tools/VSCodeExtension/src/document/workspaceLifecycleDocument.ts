import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  compareUtf16CodeUnits,
  type DocumentDiagnostic,
  type DocumentLifecycleDeleteTarget,
  type DocumentOperationResult,
  type OwnedStableIdentity,
  type ReferenceOccurrence,
  type SemanticDocumentAdapter,
  type StableIdentityValue,
  type StableIdentityRemap,
  type TableLayoutDefinition,
} from "@visualbridge/core";
import {
  createEmptyEntityDocument,
  entityDocumentAdapter,
  entityTextDocumentCodec,
  serializeEntityDocument,
  type EntityDocument,
  type EntityDocumentAdapterContext,
} from "@visualbridge/entity";
import {
  createEmptyGraphDocument,
  graphDocumentAdapter,
  graphTextDocumentCodec,
  serializeGraphDocument,
  type GraphDocument,
  type GraphDocumentAdapterContext,
} from "@visualbridge/graph";
import {
  createEmptyStructuredDocument,
  serializeStructuredDocument,
  structuredDocumentAdapter,
  structuredTextDocumentCodec,
  type StructuredDocument,
  type StructuredDocumentAdapterContext,
} from "@visualbridge/structured";
import {
  createEmptyCsvTableSource,
  createEmptyXlsxTableSource,
  parseCsvTable,
  parseXlsxTable,
  resolveTableType,
  serializeCsvTable,
  serializeXlsxTable,
  tableDocumentAdapter,
  type TableDocument,
  type TableDocumentAdapterContext,
  type TableTypeDefinition,
} from "@visualbridge/table";
import { loadEntityCatalogRegistry } from "../catalog/entityCatalogLoader";
import { loadGraphCatalogRegistry } from "../catalog/graphCatalogLoader";
import { loadStructuredCatalogRegistry } from "../catalog/structuredCatalogLoader";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import type { ProjectContext } from "../project/projectRegistry";
import type { IndexedDocument } from "@visualbridge/core";

export interface LifecycleRenderedSource {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type LifecycleTransformResult =
  | {
      readonly success: true;
      readonly sources: readonly LifecycleRenderedSource[];
      readonly references: readonly ReferenceOccurrence[];
      readonly ownedIdentities: readonly OwnedStableIdentity[];
    }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] };

export interface WorkspaceLifecycleDocument {
  readonly ownedIdentities: readonly OwnedStableIdentity[];
  readonly addressableIdentityKeys: ReadonlySet<string>;
  readonly references: readonly ReferenceOccurrence[];
  remapOwnedIdentities(
    remap: readonly StableIdentityRemap[],
    internalRetargets: readonly LifecycleReferenceRetarget[],
  ): Promise<LifecycleTransformResult>;
  deleteOwnedTarget(
    target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
  ): Promise<LifecycleTransformResult>;
}

export interface LifecycleReferenceRetarget {
  readonly path: string;
  readonly replacement: StableIdentityValue;
}

export interface CreatedWorkspaceLifecycleDocument {
  readonly sources: readonly LifecycleRenderedSource[];
  readonly ownedIdentities: readonly OwnedStableIdentity[];
}

export async function createWorkspaceLifecycleDocument(
  project: ProjectContext,
  documentType: { readonly id: string; readonly editor: string; readonly catalogs: readonly string[] },
  targetPath: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<CreatedWorkspaceLifecycleDocument> {
  if (documentType.editor === "graph") {
    assertParameterKeys(parameters, ["documentId", "rootGraphId", "graphTypeId", "initialNodeIds"]);
    const catalog = await loadGraphCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready && documentType.catalogs.length > 0) throw diagnosticsError("Graph Catalog", catalog.diagnostics);
    const ids = requiredIdentifierArray(parameters.initialNodeIds, "parameters.initialNodeIds");
    let index = 0;
    const document = createEmptyGraphDocument(
      requiredIdentifier(parameters.documentId, "parameters.documentId"),
      requiredIdentifier(parameters.rootGraphId, "parameters.rootGraphId"),
      optionalIdentifier(parameters.graphTypeId, "parameters.graphTypeId"),
      catalog.registry,
      () => {
        const id = ids[index];
        if (id === undefined) throw new Error("Graph create requires an ID for every initial node.");
        index += 1;
        return id;
      },
    );
    if (index !== ids.length) throw new Error("Graph create supplied unused initial node IDs.");
    return {
      sources: [{ path: targetPath, bytes: new TextEncoder().encode(serializeGraphDocument(document)) }],
      ownedIdentities: graphDocumentAdapter.lifecycle!.collectOwnedIdentities(document, documentType.id, { registry: catalog.registry }),
    };
  }
  if (documentType.editor === "entity") {
    assertParameterKeys(parameters, ["documentId", "entityTypeId", "title"]);
    const catalog = await loadEntityCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready) throw diagnosticsError("Entity Catalog", catalog.diagnostics);
    const document = createEmptyEntityDocument(
      requiredIdentifier(parameters.documentId, "parameters.documentId"),
      requiredIdentifier(parameters.entityTypeId, "parameters.entityTypeId"),
      catalog.registry,
      optionalString(parameters.title, "parameters.title") ?? "New Entity",
    );
    return {
      sources: [{ path: targetPath, bytes: new TextEncoder().encode(serializeEntityDocument(document)) }],
      ownedIdentities: entityDocumentAdapter.lifecycle!.collectOwnedIdentities(document, documentType.id, { registry: catalog.registry }),
    };
  }
  if (documentType.editor === "structured") {
    assertParameterKeys(parameters, ["documentId"]);
    const catalog = await loadStructuredCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready) throw diagnosticsError("Structured Catalog", catalog.diagnostics);
    const document = createEmptyStructuredDocument(
      requiredIdentifier(parameters.documentId, "parameters.documentId"),
      documentType.id,
      catalog.registry,
    );
    return {
      sources: [{ path: targetPath, bytes: new TextEncoder().encode(serializeStructuredDocument(document)) }],
      ownedIdentities: structuredDocumentAdapter.lifecycle!.collectOwnedIdentities(document, documentType.id, {
        registry: catalog.registry,
        configTypeId: documentType.id,
      }),
    };
  }
  if (documentType.editor === "table") {
    assertParameterKeys(parameters, ["format", "physicalName"]);
    const layout = project.definition.tableLayout;
    if (layout === undefined) throw new Error("The Project does not configure tableLayout.");
    const catalog = await loadTableCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready) throw diagnosticsError("Table Catalog", catalog.diagnostics);
    const tableType = resolveTableType(catalog.registry, documentType.id);
    if (tableType === undefined) throw new Error(`Document Type '${documentType.id}' does not resolve to a Table Type.`);
    const format = parameters.format;
    if (format !== "csv" && format !== "xlsx") throw new Error("parameters.format must be 'csv' or 'xlsx'.");
    if (format === "xlsx" && parameters.physicalName !== undefined) {
      throw new Error("parameters.physicalName is only valid when parameters.format is 'csv'.");
    }
    const physicalName = optionalString(parameters.physicalName, "parameters.physicalName")
      ?? nodePath.posix.basename(targetPath, nodePath.posix.extname(targetPath));
    const created = format === "xlsx"
      ? await createEmptyXlsxTableSource(tableType, layout)
      : createEmptyCsvTableSource(tableType, layout, physicalName);
    if (!created.success) throw diagnosticsError("Table", created.diagnostics);
    return { sources: [{ path: targetPath, bytes: created.bytes }], ownedIdentities: [] };
  }
  throw new Error(`Editor '${documentType.editor}' does not expose create lifecycle semantics.`);
}

export async function loadWorkspaceLifecycleDocument(
  project: ProjectContext,
  indexed: IndexedDocument,
): Promise<WorkspaceLifecycleDocument> {
  const documentType = project.definition.documentTypes.find((candidate) => candidate.id === indexed.documentTypeId);
  if (documentType === undefined) throw new Error(`Unknown Document Type '${indexed.documentTypeId}'.`);
  if (indexed.editor === "graph") {
    const catalog = await loadGraphCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready && documentType.catalogs.length > 0) throw diagnosticsError("Graph Catalog", catalog.diagnostics);
    return loadTextDocument(
      project,
      indexed,
      graphDocumentAdapter,
      graphTextDocumentCodec.parse.bind(graphTextDocumentCodec),
      graphTextDocumentCodec.render.bind(graphTextDocumentCodec),
      { registry: catalog.registry } satisfies GraphDocumentAdapterContext,
    );
  }
  if (indexed.editor === "entity") {
    const catalog = await loadEntityCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready) throw diagnosticsError("Entity Catalog", catalog.diagnostics);
    return loadTextDocument(
      project,
      indexed,
      entityDocumentAdapter,
      entityTextDocumentCodec.parse.bind(entityTextDocumentCodec),
      entityTextDocumentCodec.render.bind(entityTextDocumentCodec),
      { registry: catalog.registry } satisfies EntityDocumentAdapterContext,
    );
  }
  if (indexed.editor === "structured") {
    const catalog = await loadStructuredCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready) throw diagnosticsError("Structured Catalog", catalog.diagnostics);
    return loadTextDocument(
      project,
      indexed,
      structuredDocumentAdapter,
      structuredTextDocumentCodec.parse.bind(structuredTextDocumentCodec),
      structuredTextDocumentCodec.render.bind(structuredTextDocumentCodec),
      { registry: catalog.registry, configTypeId: documentType.id } satisfies StructuredDocumentAdapterContext,
    );
  }
  if (indexed.editor === "table") {
    const layout = project.definition.tableLayout;
    if (layout === undefined) throw new Error("The Project does not configure tableLayout.");
    const catalog = await loadTableCatalogRegistry(project, documentType.catalogs);
    if (!catalog.ready) throw diagnosticsError("Table Catalog", catalog.diagnostics);
    const tableType = resolveTableType(catalog.registry, documentType.id);
    if (tableType === undefined) throw new Error(`Document Type '${documentType.id}' does not resolve to a Table Type.`);
    return loadTableDocument(project, indexed, tableType, layout);
  }
  throw new Error(`Editor '${indexed.editor}' does not expose a built-in lifecycle adapter.`);
}

async function loadTextDocument<TDocument extends GraphDocument | EntityDocument | StructuredDocument, TContext>(
  project: ProjectContext,
  indexed: IndexedDocument,
  adapter: SemanticDocumentAdapter<TDocument, TContext>,
  parse: (text: string, context: TContext) => DocumentOperationResult<TDocument> | Promise<DocumentOperationResult<TDocument>>,
  render: (document: TDocument, source: string, context: TContext) => string | Promise<string>,
  context: TContext,
): Promise<WorkspaceLifecycleDocument> {
  const path = indexed.sourcePaths[0];
  if (path === undefined || indexed.sourcePaths.length !== 1) throw new Error("Text lifecycle requires exactly one physical source.");
  const bytes = await vscode.workspace.fs.readFile(projectUri(project, path));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = await parse(text, context);
  if (!parsed.success) throw diagnosticsError("Document", parsed.diagnostics);
  return createHandle(adapter, parsed.document, context, indexed.documentTypeId, async (document) => [{
    path,
    bytes: new TextEncoder().encode(await render(document, text, context)),
  }]);
}

async function loadTableDocument(
  project: ProjectContext,
  indexed: IndexedDocument,
  tableType: TableTypeDefinition,
  layout: TableLayoutDefinition,
): Promise<WorkspaceLifecycleDocument> {
  const sources = await Promise.all(indexed.sourcePaths.map(async (path) => ({
    path,
    bytes: await vscode.workspace.fs.readFile(projectUri(project, path)),
  })));
  const first = sources[0];
  if (first === undefined) throw new Error("Table lifecycle source is empty.");
  const context: TableDocumentAdapterContext = { tableType };
  if (sources.length === 1 && isXlsx(first.bytes)) {
    const parsed = await parseXlsxTable(first.bytes, tableType, layout);
    if (!parsed.success) throw diagnosticsError("Table", parsed.diagnostics);
    return createHandle(tableDocumentAdapter, parsed.document, context, indexed.documentTypeId, async (document) => [{
      path: first.path,
      bytes: await serializeXlsxTable(first.bytes, document, tableType, layout),
    }]);
  }
  const sheets: TableDocument["sheets"][number][] = [];
  const csvSources: { readonly path: string; readonly text: string; readonly sheetIds: readonly string[] }[] = [];
  for (const source of sources) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    const physicalName = nodePath.posix.basename(source.path, nodePath.posix.extname(source.path));
    const parsed = parseCsvTable(text, tableType, layout, physicalName);
    if (!parsed.success) throw diagnosticsError(`Table '${source.path}'`, parsed.diagnostics);
    sheets.push(...parsed.document.sheets);
    csvSources.push({ path: source.path, text, sheetIds: parsed.document.sheets.map((sheet) => sheet.id) });
  }
  return createHandle(tableDocumentAdapter, { format: "csv", sheets }, context, indexed.documentTypeId, async (document) => (
    csvSources.map((source) => ({
      path: source.path,
      bytes: new TextEncoder().encode(serializeCsvTable({
        format: "csv",
        sheets: document.sheets.filter((sheet) => source.sheetIds.includes(sheet.id)),
      }, tableType, source.text)),
    }))
  ));
}

function createHandle<TDocument, TContext>(
  adapter: SemanticDocumentAdapter<TDocument, TContext>,
  document: TDocument,
  context: TContext,
  documentTypeId: string,
  render: (document: TDocument) => Promise<readonly LifecycleRenderedSource[]>,
): WorkspaceLifecycleDocument {
  const lifecycle = adapter.lifecycle;
  if (lifecycle === undefined) throw new Error(`Editor '${adapter.editor}' does not expose lifecycle semantics.`);
  const ownedIdentities = lifecycle.collectOwnedIdentities(document, documentTypeId, context);
  const addressableIdentityKeys = lifecycle.collectAddressableIdentityKeys?.(document, documentTypeId, context)
    ?? new Set(ownedIdentities.filter((identity) => identity.reference !== undefined).map((identity) => identity.identityKey));
  const references = adapter.collectReferences(document, context);
  return {
    ownedIdentities,
    addressableIdentityKeys,
    references,
    async remapOwnedIdentities(remap, internalRetargets) {
      const remapped = lifecycle.remapOwnedIdentities(document, documentTypeId, remap, context);
      if (!remapped.success) return remapped;
      const retargeted = retargetInternalReferences(adapter, remapped.document, context, internalRetargets);
      if (!retargeted.success) return retargeted;
      return {
        success: true,
        sources: await render(retargeted.document),
        references: adapter.collectReferences(retargeted.document, context),
        ownedIdentities: lifecycle.collectOwnedIdentities(retargeted.document, documentTypeId, context),
      };
    },
    async deleteOwnedTarget(target) {
      const deleted = lifecycle.deleteOwnedTarget(document, target, context);
      return deleted.success
        ? {
            success: true,
            sources: await render(deleted.document),
            references: adapter.collectReferences(deleted.document, context),
            ownedIdentities: lifecycle.collectOwnedIdentities(deleted.document, documentTypeId, context),
          }
        : deleted;
    },
  };
}

function retargetInternalReferences<TDocument, TContext>(
  adapter: SemanticDocumentAdapter<TDocument, TContext>,
  document: TDocument,
  context: TContext,
  internalRetargets: readonly LifecycleReferenceRetarget[],
): DocumentOperationResult<TDocument> {
  let current: DocumentOperationResult<TDocument> = { success: true, document, diagnostics: [] };
  for (const retarget of internalRetargets) {
    if (!current.success) break;
    current = adapter.replaceReferenceValues(current.document, context, new Set([retarget.path]), retarget.replacement);
  }
  return current;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function diagnosticsError(scope: string, diagnostics: readonly DocumentDiagnostic[]): Error {
  const first = diagnostics.find((diagnostic) => diagnostic.severity === "error") ?? diagnostics[0];
  return new Error(first === undefined ? `${scope} is invalid.` : `${scope}: ${first.path}: ${first.message}`);
}

function projectUri(project: ProjectContext, path: string): vscode.Uri {
  return vscode.Uri.joinPath(project.rootUri, ...path.split("/"));
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function assertParameterKeys(parameters: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unexpected = Object.keys(parameters).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`Unexpected create parameter '${unexpected}'.`);
}

function requiredIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${path} must be a stable identifier.`);
  }
  return value;
}

function optionalIdentifier(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredIdentifier(value, path);
}

function requiredIdentifierArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((entry, index) => requiredIdentifier(entry, `${path}[${index}]`));
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value;
}
