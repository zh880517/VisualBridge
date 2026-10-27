import type { DocumentDiagnostic, DocumentOperationResult, DocumentParseResult } from "./document";
import type {
  DocumentLifecycleDeleteTarget,
  OwnedStableIdentity,
  StableIdentityRemap,
} from "./documentLifecycle";
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
  readonly lifecycle?: SemanticDocumentLifecycleAdapter<TDocument, TContext>;
}

export interface SemanticDocumentLifecycleAdapter<TDocument, TContext> {
  collectOwnedIdentities(
    document: TDocument,
    documentTypeId: string,
    context: TContext,
  ): readonly OwnedStableIdentity[];
  /** Identity keys whose reference definition resolves to a unique logical target. */
  collectAddressableIdentityKeys?(
    document: TDocument,
    documentTypeId: string,
    context: TContext,
  ): ReadonlySet<string>;
  remapOwnedIdentities(
    document: TDocument,
    documentTypeId: string,
    remap: readonly StableIdentityRemap[],
    context: TContext,
  ): DocumentOperationResult<TDocument>;
  deleteOwnedTarget(
    document: TDocument,
    target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
    context: TContext,
  ): DocumentOperationResult<TDocument>;
  /**
   * 把一个可寻址目标自身改名（Graph 元素 / Entity 组件 / Table 行键）。
   *
   * 引用的批量改写仍由宿主编排（`replaceReferenceValues`），本方法只改目标所在的文档。
   */
  renameOwnedTarget?(
    document: TDocument,
    target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
    previous: string | number,
    replacement: string | number,
    context: TContext,
  ): DocumentOperationResult<TDocument>;
}

export interface DocumentCodec<TDocument, TSource, TContext> {
  parse(source: TSource, context: TContext): DocumentParseResult<TDocument> | Promise<DocumentParseResult<TDocument>>;
  render(document: TDocument, source: TSource, context: TContext): TSource | Promise<TSource>;
}

export interface CatalogAdapter<TCatalog, TRegistry> {
  readonly editor: string;
  parse(text: string, sourcePath: string): DocumentParseResult<TCatalog>;
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
    const parsed = adapter.parse(source.text, source.path);
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
