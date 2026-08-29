import type { DocumentDiagnostic, DocumentOperationResult, DocumentParseResult } from "./document";
import type { ReferenceOccurrence } from "../Reference/reference";

export interface DocumentDescriptor {
  readonly documentId?: string;
  readonly title: string;
}

export interface SemanticDocumentAdapter<TDocument, TContext> {
  readonly editor: string;
  describe(document: TDocument, context: TContext): DocumentDescriptor;
  validate(document: TDocument, context: TContext): readonly DocumentDiagnostic[];
  applyOperations(document: TDocument, operations: unknown, context: TContext): DocumentOperationResult<TDocument>;
  collectReferences(document: TDocument, context: TContext): readonly ReferenceOccurrence[];
  replaceReferenceValues(
    document: TDocument,
    context: TContext,
    occurrencePaths: ReadonlySet<string>,
    replacement: string | number,
  ): DocumentOperationResult<TDocument>;
  readonly renameDocumentId?: (
    document: TDocument,
    documentId: string,
    context: TContext,
  ) => DocumentOperationResult<TDocument>;
}

export interface DocumentCodec<TDocument, TSource, TContext> {
  parse(source: TSource, context: TContext): DocumentParseResult<TDocument> | Promise<DocumentParseResult<TDocument>>;
  render(document: TDocument, source: TSource, context: TContext): TSource | Promise<TSource>;
}

export interface CatalogAdapter<TCatalog, TRegistry> {
  readonly editor: string;
  parse(text: string): DocumentParseResult<TCatalog>;
  build(catalogs: readonly TCatalog[]): DocumentParseResult<TRegistry>;
}

export interface CatalogTextSource {
  readonly path: string;
  readonly text: string;
}

export interface CatalogBundle<TRegistry> {
  readonly paths: readonly string[];
  readonly registry?: TRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export function buildCatalogBundle<TCatalog, TRegistry>(
  sources: readonly CatalogTextSource[],
  adapter: CatalogAdapter<TCatalog, TRegistry>,
): CatalogBundle<TRegistry> {
  const catalogs: TCatalog[] = [];
  const sourceIndexes: number[] = [];
  const diagnostics: DocumentDiagnostic[] = [];
  sources.forEach((source, sourceIndex) => {
    const parsed = adapter.parse(source.text);
    diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: `catalogs[${sourceIndex}].${diagnostic.path}`,
    })));
    if (parsed.success) {
      catalogs.push(parsed.document);
      sourceIndexes.push(sourceIndex);
    }
  });
  const built = adapter.build(catalogs);
  diagnostics.push(...built.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: diagnostic.path.replace(/^catalogs\[(\d+)\]/, (match, indexText: string) => {
      const sourceIndex = sourceIndexes[Number(indexText)];
      return sourceIndex === undefined ? match : `catalogs[${sourceIndex}]`;
    }),
  })));
  return {
    paths: sources.map((source) => source.path),
    ...(built.success && !diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? { registry: built.document }
      : {}),
    diagnostics,
  };
}
