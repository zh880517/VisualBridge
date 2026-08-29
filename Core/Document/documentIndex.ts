import type { DocumentDiagnostic } from "./document";
import type {
  ReferenceOccurrence,
  ReferenceResolution,
} from "../Reference/reference";

export interface IndexedDocumentReference {
  readonly occurrence: ReferenceOccurrence;
  readonly resolution: ReferenceResolution;
}

export interface IndexedDocument {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly editor: string;
  readonly path: string;
  readonly sourcePaths: readonly string[];
  readonly title: string;
  readonly documentId?: string;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly references: readonly IndexedDocumentReference[];
}

export interface DocumentIndexSummary {
  readonly documentCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly referenceCount: number;
}

export function documentIndexKey(document: Pick<IndexedDocument, "projectId" | "documentTypeId" | "path">): string {
  return [document.projectId, document.documentTypeId, document.path].join("\u0000");
}

export function sortIndexedDocuments(documents: readonly IndexedDocument[]): readonly IndexedDocument[] {
  return [...documents].sort((left, right) => documentIndexKey(left).localeCompare(documentIndexKey(right)));
}

export function searchIndexedDocuments(
  documents: readonly IndexedDocument[],
  query: string,
): readonly IndexedDocument[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return sortIndexedDocuments(documents);
  }
  return sortIndexedDocuments(documents.filter((document) => {
    const searchable = [
      document.title,
      document.documentId ?? "",
      document.projectId,
      document.documentTypeId,
      document.editor,
      document.path,
      ...document.sourcePaths,
      ...document.diagnostics.flatMap((diagnostic) => [diagnostic.code, diagnostic.path, diagnostic.message]),
      ...document.references.flatMap((reference) => [
        reference.occurrence.definition.kind,
        reference.occurrence.path,
        String(reference.occurrence.value),
        ...reference.resolution.candidates.flatMap((candidate) => [
          candidate.title,
          candidate.description ?? "",
          candidate.location?.path ?? "",
        ]),
      ]),
    ].join("\n").toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  }));
}

export function summarizeDocumentIndex(documents: readonly IndexedDocument[]): DocumentIndexSummary {
  let errorCount = 0;
  let warningCount = 0;
  let referenceCount = 0;
  documents.forEach((document) => {
    document.diagnostics.forEach((diagnostic) => {
      if (diagnostic.severity === "error") {
        errorCount += 1;
      } else {
        warningCount += 1;
      }
    });
    referenceCount += document.references.length;
  });
  return {
    documentCount: documents.length,
    errorCount,
    warningCount,
    referenceCount,
  };
}
