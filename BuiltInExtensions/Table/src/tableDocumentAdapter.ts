import type { CatalogAdapter, SemanticDocumentAdapter } from "@visualbridge/core";
import {
  buildTableCatalogRegistry,
  parseTableCatalog,
  type TableCatalog,
  type TableCatalogRegistry,
  type TableTypeDefinition,
} from "./tableCatalog";
import {
  applyTableOperations,
  replaceTableReferenceValues,
  validateTableDocument,
  type TableDocument,
} from "./tableDocument";
import { collectTableReferences } from "./tableReferences";

export interface TableDocumentAdapterContext {
  readonly tableType: TableTypeDefinition;
}

export const tableDocumentAdapter: SemanticDocumentAdapter<TableDocument, TableDocumentAdapterContext> = {
  editor: "table",
  describe(_document, context) {
    return { title: context.tableType.title };
  },
  validate(document, context) {
    return validateTableDocument(document, context.tableType);
  },
  applyOperations(document, operations, context) {
    return applyTableOperations(document, operations, context.tableType);
  },
  collectReferences(document, context) {
    return collectTableReferences(document, context.tableType);
  },
  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    return replaceTableReferenceValues(document, context.tableType, occurrencePaths, replacement);
  },
};

export const tableCatalogAdapter: CatalogAdapter<TableCatalog, TableCatalogRegistry> = {
  editor: "table",
  parse: parseTableCatalog,
  build: buildTableCatalogRegistry,
};
