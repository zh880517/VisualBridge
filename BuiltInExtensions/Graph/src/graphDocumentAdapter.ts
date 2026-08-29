import type {
  CatalogAdapter,
  DocumentCodec,
  SemanticDocumentAdapter,
} from "@visualbridge/core";
import {
  buildGraphCatalogRegistry,
  parseGraphCatalog,
  type GraphCatalog,
  type GraphCatalogRegistry,
} from "./graphCatalog";
import {
  applyGraphOperations,
  collectGraphReferences,
  parseGraphDocument,
  renameGraphDocumentId,
  replaceGraphReferenceValues,
  serializeGraphDocument,
  validateGraphDocument,
  type GraphDocument,
} from "./graphDocument";
import {
  collectGraphOwnedIdentities,
  deleteGraphOwnedTarget,
  remapGraphOwnedIdentities,
} from "./graphLifecycle";

export interface GraphDocumentAdapterContext {
  readonly registry: GraphCatalogRegistry;
}

export const graphDocumentAdapter: SemanticDocumentAdapter<GraphDocument, GraphDocumentAdapterContext> = {
  editor: "graph",
  describe(document) {
    const root = document.graphs.find((graph) => graph.id === document.rootGraphId);
    return { documentId: document.documentId, title: root?.title ?? document.documentId };
  },
  validate(document, context) {
    return validateGraphDocument(document, context.registry);
  },
  applyOperations(document, operations, context) {
    return applyGraphOperations(document, operations, context.registry);
  },
  collectReferences(document, context) {
    return collectGraphReferences(document, context.registry);
  },
  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    return replaceGraphReferenceValues(document, context.registry, occurrencePaths, replacement);
  },
  renameDocumentId(document, documentId, context) {
    return renameGraphDocumentId(document, documentId, context.registry);
  },
  lifecycle: {
    collectOwnedIdentities(document, documentTypeId) {
      return collectGraphOwnedIdentities(document, documentTypeId);
    },
    remapOwnedIdentities(document, documentTypeId, remap, context) {
      return remapGraphOwnedIdentities(document, documentTypeId, remap, context.registry);
    },
    deleteOwnedTarget(document, target, context) {
      return deleteGraphOwnedTarget(document, target, context.registry);
    },
  },
};

export const graphTextDocumentCodec: DocumentCodec<GraphDocument, string, GraphDocumentAdapterContext> = {
  parse(text) {
    return parseGraphDocument(text);
  },
  render(document) {
    return serializeGraphDocument(document);
  },
};

export const graphCatalogAdapter: CatalogAdapter<GraphCatalog, GraphCatalogRegistry> = {
  editor: "graph",
  parse: parseGraphCatalog,
  build: buildGraphCatalogRegistry,
};
