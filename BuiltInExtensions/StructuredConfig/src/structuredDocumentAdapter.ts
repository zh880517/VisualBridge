import type {
  CatalogAdapter,
  DocumentCodec,
  SemanticDocumentAdapter,
} from "@visualbridge/core";
import {
  buildStructuredCatalogRegistry,
  parseStructuredCatalog,
  resolveStructuredConfigType,
  type StructuredCatalog,
  type StructuredCatalogRegistry,
} from "./structuredCatalog";
import {
  applyStructuredOperations,
  collectStructuredReferences,
  parseStructuredDocument,
  renameStructuredDocumentId,
  replaceStructuredReferenceValues,
  serializeStructuredDocument,
  validateStructuredDocument,
  type StructuredDocument,
} from "./structuredDocument";

export interface StructuredDocumentAdapterContext {
  readonly registry: StructuredCatalogRegistry;
  readonly configTypeId: string;
}

export const structuredDocumentAdapter:
SemanticDocumentAdapter<StructuredDocument, StructuredDocumentAdapterContext> = {
  editor: "structured",
  describe(document, context) {
    const configType = resolveStructuredConfigType(context.registry, context.configTypeId);
    return { documentId: document.documentId, title: configType?.title ?? document.documentId };
  },
  validate(document, context) {
    return validateStructuredDocument(document, context.registry, context.configTypeId);
  },
  applyOperations(document, operations, context) {
    return applyStructuredOperations(document, operations, context.registry, context.configTypeId);
  },
  collectReferences(document, context) {
    return collectStructuredReferences(document, context.registry, context.configTypeId);
  },
  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    return replaceStructuredReferenceValues(
      document,
      context.registry,
      context.configTypeId,
      occurrencePaths,
      replacement,
    );
  },
  renameDocumentId(document, documentId, context) {
    return renameStructuredDocumentId(document, documentId, context.registry, context.configTypeId);
  },
};

export const structuredTextDocumentCodec:
DocumentCodec<StructuredDocument, string, StructuredDocumentAdapterContext> = {
  parse(text) {
    return parseStructuredDocument(text);
  },
  render(document) {
    return serializeStructuredDocument(document);
  },
};

export const structuredCatalogAdapter: CatalogAdapter<StructuredCatalog, StructuredCatalogRegistry> = {
  editor: "structured",
  parse: parseStructuredCatalog,
  build: buildStructuredCatalogRegistry,
};
