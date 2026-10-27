/**
 * Structured 模块的宿主语义面（附录 D.3 的 `storage` / `semantic`）。
 *
 * Structured 文档没有自己的 Reference kind，因此 `references` 为空；它只消费
 * `document`（宿主内建）与其它模块登记的 kind。
 */
import type {
  DocumentDiagnostic,
  DocumentFacet,
  DocumentFacetContext,
  DocumentFacetSourceFile,
  DocumentOperationResult,
} from "@visualbridge/module-sdk";
import {
  createEmptyStructuredCatalogRegistry,
  resolveStructuredConfigType,
  STRUCTURED_EDITOR_ID,
  type StructuredCatalogRegistry,
} from "./structuredCatalog";
import {
  parseStructuredDocument,
  serializeStructuredDocument,
  type StructuredDocument,
} from "./structuredDocument";
import { structuredDocumentAdapter } from "./structuredDocumentAdapter";
import { collectStructuredOwnedIdentities } from "./structuredLifecycle";

type StructuredTarget = Exclude<import("@visualbridge/module-sdk").DocumentLifecycleDeleteTarget, { readonly kind: "document" }>;

export const structuredDocumentFacet: DocumentFacet<StructuredDocument, StructuredCatalogRegistry> = {
  editor: STRUCTURED_EDITOR_ID,
  storage: "text",
  references: [],

  parseText(text) {
    return parseStructuredDocument(text);
  },

  async renderSources(document, sources) {
    const source = onlySource(sources, "Structured");
    return [{ path: source.path, bytes: new TextEncoder().encode(serializeStructuredDocument(document)) }];
  },

  describe(document, context) {
    // 与改造前一致：标题优先取 Catalog 里的 Config Type，未命中才退回文件名。
    const configType = context.registry === undefined
      ? undefined
      : resolveStructuredConfigType(context.registry, context.documentTypeId);
    return { documentId: document.documentId, title: configType?.title ?? fileTitle(context.path) };
  },

  validate(document, context) {
    return context.registry === undefined
      ? []
      : structuredDocumentAdapter.validate(document, adapterContext(context));
  },

  collectReferences(document, context) {
    return context.registry === undefined
      ? []
      : structuredDocumentAdapter.collectReferences(document, adapterContext(context));
  },

  applyOperations(document, operations, context) {
    return structuredDocumentAdapter.applyOperations(document, operations, adapterContext(context));
  },

  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    return structuredDocumentAdapter.replaceReferenceValues(
      document,
      adapterContext(context),
      occurrencePaths,
      replacement,
    );
  },

  renameDocumentId(document, documentId, context) {
    return structuredDocumentAdapter.renameDocumentId!(document, documentId, adapterContext(context));
  },

  renameTarget(_document, target, _previous, _replacement, _context) {
    return targetKindFailure(target.kind);
  },

  collectOwnedIdentities(document, context) {
    return collectStructuredOwnedIdentities(document, context.documentTypeId);
  },

  remapOwnedIdentities(document, context, remap) {
    return structuredDocumentAdapter.lifecycle!.remapOwnedIdentities(
      document,
      context.documentTypeId,
      remap,
      adapterContext(context),
    );
  },

  deleteOwnedTarget(document, target: StructuredTarget, context) {
    return structuredDocumentAdapter.lifecycle!.deleteOwnedTarget(document, target, adapterContext(context));
  },
};

function adapterContext(
  context: DocumentFacetContext<StructuredCatalogRegistry>,
): { readonly registry: StructuredCatalogRegistry; readonly configTypeId: string } {
  return {
    registry: context.registry ?? createEmptyStructuredCatalogRegistry(),
    configTypeId: context.documentTypeId,
  };
}

function onlySource(sources: readonly DocumentFacetSourceFile[], scope: string): DocumentFacetSourceFile {
  const source = sources[0];
  if (source === undefined) throw new Error(`${scope} document has no source file.`);
  return source;
}

/** 文档标题的兜底：Project 内路径的物理文件名（不含扩展名）。 */
function fileTitle(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(separator + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function targetKindFailure(kind: string): DocumentOperationResult<never> {
  const diagnostic: DocumentDiagnostic = {
    severity: "error",
    code: "structured.targetKind",
    path: "target.kind",
    message: `Structured cannot rename '${kind}' targets.`,
  };
  return { success: false, diagnostics: [diagnostic] };
}
