import type {
  CatalogAdapter,
  DocumentCodec,
  SemanticDocumentAdapter,
} from "@visualbridge/core";
import {
  buildEntityCatalogRegistry,
  parseEntityCatalog,
  type EntityCatalog,
  type EntityCatalogRegistry,
} from "./entityCatalog";
import {
  applyEntityOperations,
  collectEntityReferences,
  parseEntityDocument,
  renameEntityDocumentId,
  replaceEntityReferenceValues,
  serializeEntityDocument,
  validateEntityDocument,
  type EntityDocument,
} from "./entityDocument";

export interface EntityDocumentAdapterContext {
  readonly registry: EntityCatalogRegistry;
}

export const entityDocumentAdapter: SemanticDocumentAdapter<EntityDocument, EntityDocumentAdapterContext> = {
  editor: "entity",
  describe(document) {
    return { documentId: document.documentId, title: document.title };
  },
  validate(document, context) {
    return validateEntityDocument(document, context.registry);
  },
  applyOperations(document, operations, context) {
    return applyEntityOperations(document, operations, context.registry);
  },
  collectReferences(document, context) {
    return collectEntityReferences(document, context.registry);
  },
  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    return replaceEntityReferenceValues(document, context.registry, occurrencePaths, replacement);
  },
  renameDocumentId(document, documentId, context) {
    return renameEntityDocumentId(document, documentId, context.registry);
  },
};

export const entityTextDocumentCodec: DocumentCodec<EntityDocument, string, EntityDocumentAdapterContext> = {
  parse(text) {
    return parseEntityDocument(text);
  },
  render(document) {
    return serializeEntityDocument(document);
  },
};

export const entityCatalogAdapter: CatalogAdapter<EntityCatalog, EntityCatalogRegistry> = {
  editor: "entity",
  parse: parseEntityCatalog,
  build: buildEntityCatalogRegistry,
};
