import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  type DocumentDiagnostic,
  type DocumentFacet,
  type DocumentFacetContext,
  type DocumentFacetSourceFile,
  type DocumentLifecycleDeleteTarget,
  type DocumentOperationResult,
  type DocumentTypeDefinition,
  type IndexedDocument,
  type JsonValue,
  type OwnedStableIdentity,
  type ReferenceOccurrence,
  type StableIdentityRemap,
  type StableIdentityValue,
} from "@visualbridge/core";
import {
  documentFacetFor,
  loadDocumentTypeCatalogRegistry,
  type HostDocumentFacet,
} from "../modules/documentFacetRegistry";
import type { ProjectContext } from "../project/projectRegistry";

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

/**
 * 新建文档：只把 parameters 交给模块的 `create` facet，字节与 ownedIdentities 都由模块产出。
 *
 * 宿主仍负责 Project / Document Type / Catalog 的解析与 preview/apply（`workspaceDocumentLifecycle`）。
 */
export async function createWorkspaceLifecycleDocument(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  targetPath: string,
  parameters: Readonly<Record<string, JsonValue>>,
): Promise<CreatedWorkspaceLifecycleDocument> {
  const host = documentFacetFor(documentType.editor);
  if (host === undefined || host.create === undefined) {
    throw new Error(`Editor '${documentType.editor}' does not expose create lifecycle semantics.`);
  }
  const catalog = await loadDocumentTypeCatalogRegistry(project, documentType);
  const created = await host.create.createDocument({
    ...facetInput(project, documentType, catalog),
    parameters,
    targetPath,
  });
  if (!created.success) throw new Error(created.message);
  return { sources: created.sources, ownedIdentities: created.ownedIdentities };
}

/** 读取现有文档并交给模块 facet 解析；渲染同样回到 facet，宿主不再有按 editor 的分支。 */
export async function loadWorkspaceLifecycleDocument(
  project: ProjectContext,
  indexed: IndexedDocument,
): Promise<WorkspaceLifecycleDocument> {
  const host = documentFacetFor(indexed.editor);
  if (host === undefined) {
    throw new Error(`Editor '${indexed.editor}' does not expose a built-in lifecycle adapter.`);
  }
  const documentType = project.definition.documentTypes.find((candidate) => candidate.id === indexed.documentTypeId);
  if (documentType === undefined) throw new Error(`Unknown Document Type '${indexed.documentTypeId}'.`);
  const catalog = await loadDocumentTypeCatalogRegistry(project, documentType);
  const context = facetContext(project, documentType, host, indexed, catalog);
  const sources = await readSources(project, indexed);
  const parsed = host.facet.storage === "sources"
    ? await host.facet.parseSources!(sources, context)
    : await parseText(host.facet, sources, indexed, context);
  if (!parsed.success) throw diagnosticsError("Document", parsed.diagnostics);
  return createHandle(host.facet, parsed.document, context, indexed.documentTypeId, async (document) => (
    host.facet.renderSources(document, sources, context)
  ));
}

async function parseText(
  facet: DocumentFacet<unknown, unknown>,
  sources: readonly DocumentFacetSourceFile[],
  indexed: IndexedDocument,
  context: DocumentFacetContext<unknown>,
) {
  const source = sources[0];
  if (source === undefined || indexed.sourcePaths.length !== 1) {
    throw new Error("Text lifecycle requires exactly one physical source.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
  return facet.parseText!(text, context);
}

function createHandle(
  facet: DocumentFacet<unknown, unknown>,
  document: unknown,
  context: DocumentFacetContext<unknown>,
  documentTypeId: string,
  render: (document: unknown) => Promise<readonly DocumentFacetSourceFile[]>,
): WorkspaceLifecycleDocument {
  const ownedIdentities = facet.collectOwnedIdentities(document, context);
  const addressableIdentityKeys = facet.collectAddressableIdentityKeys?.(document, context)
    ?? new Set(ownedIdentities.filter((identity) => identity.reference !== undefined).map((identity) => identity.identityKey));
  const references = facet.collectReferences(document, context);
  return {
    ownedIdentities,
    addressableIdentityKeys,
    references,
    async remapOwnedIdentities(remap, internalRetargets) {
      const remapped = facet.remapOwnedIdentities(document, context, remap);
      if (!remapped.success) return remapped;
      const retargeted = retargetInternalReferences(facet, remapped.document, context, internalRetargets);
      if (!retargeted.success) return retargeted;
      return {
        success: true,
        sources: await render(retargeted.document),
        references: facet.collectReferences(retargeted.document, context),
        ownedIdentities: facet.collectOwnedIdentities(retargeted.document, context),
      };
    },
    async deleteOwnedTarget(target) {
      const deleted = facet.deleteOwnedTarget(document, target, context);
      return deleted.success
        ? {
            success: true,
            sources: await render(deleted.document),
            references: facet.collectReferences(deleted.document, context),
            ownedIdentities: facet.collectOwnedIdentities(deleted.document, context),
          }
        : deleted;
    },
  };
}

function retargetInternalReferences(
  facet: DocumentFacet<unknown, unknown>,
  document: unknown,
  context: DocumentFacetContext<unknown>,
  internalRetargets: readonly LifecycleReferenceRetarget[],
): DocumentOperationResult<unknown> {
  let current: DocumentOperationResult<unknown> = { success: true, document, diagnostics: [] };
  for (const retarget of internalRetargets) {
    if (!current.success) break;
    current = facet.replaceReferenceValues(current.document, context, new Set([retarget.path]), retarget.replacement);
  }
  return current;
}

async function readSources(
  project: ProjectContext,
  indexed: IndexedDocument,
): Promise<readonly DocumentFacetSourceFile[]> {
  const sources: DocumentFacetSourceFile[] = [];
  for (const path of indexed.sourcePaths) {
    sources.push({ path, bytes: await vscode.workspace.fs.readFile(projectUri(project, path)) });
  }
  if (sources.length === 0) throw new Error("Document lifecycle has no physical source.");
  return sources;
}

function facetInput(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  catalog: Awaited<ReturnType<typeof loadDocumentTypeCatalogRegistry>>,
) {
  return {
    projectId: project.definition.projectId,
    projectDefinition: project.definition as unknown as JsonValue,
    documentType,
    catalog: catalog === undefined
      ? { ready: false, registry: undefined, diagnostics: [] }
      : { ready: catalog.ready, registry: catalog.registry, diagnostics: catalog.diagnostics },
    newStableId: (prefix: string) => `${prefix}_${randomUUID()}`.replaceAll("-", ""),
  };
}

function facetContext(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  host: HostDocumentFacet,
  indexed: IndexedDocument,
  catalog: Awaited<ReturnType<typeof loadDocumentTypeCatalogRegistry>>,
): DocumentFacetContext<unknown> {
  const moduleOptions = project.definition.modules.find((entry) => entry.id === host.moduleId)?.options;
  return {
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    path: indexed.sourcePaths[0] ?? indexed.path,
    sourcePaths: indexed.sourcePaths,
    registry: catalog?.ready === true ? catalog.registry : undefined,
    projectDefinition: project.definition as unknown as JsonValue,
    moduleOptions,
  };
}

function diagnosticsError(scope: string, diagnostics: readonly DocumentDiagnostic[]): Error {
  const first = diagnostics.find((diagnostic) => diagnostic.severity === "error") ?? diagnostics[0];
  return new Error(first === undefined ? `${scope} is invalid.` : `${scope}: ${first.path}: ${first.message}`);
}

function projectUri(project: ProjectContext, path: string): vscode.Uri {
  return vscode.Uri.joinPath(project.rootUri, ...path.split("/"));
}
