import type { JsonValue } from "../Form/field";
import { compareUtf16CodeUnits } from "../Ordering/ordinal";
import {
  DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
  normalizeReferenceQuery,
  paginateReferenceCandidates,
  type ReferenceCandidate,
  type ReferenceProvider,
  type ReferenceSearchPageRequest,
} from "./reference";

export const DOCUMENT_REFERENCE_KIND = "document";

export interface DocumentReferenceDocument {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly editor: string;
  readonly path: string;
  readonly documentId: string;
  readonly title: string;
}

interface DocumentReferenceTarget {
  readonly documentTypeId: string;
}

export function createDocumentReferenceProvider(
  loadDocuments: () => Promise<readonly DocumentReferenceDocument[]>,
): ReferenceProvider {
  let documents: Promise<readonly DocumentReferenceDocument[]> | undefined;
  const candidates = async (target: DocumentReferenceTarget): Promise<readonly ReferenceCandidate[]> => (
    (await (documents ??= loadDocuments()))
      .filter((document) => document.documentTypeId === target.documentTypeId)
      .map((document): ReferenceCandidate => ({
        kind: DOCUMENT_REFERENCE_KIND,
        target: { documentTypeId: document.documentTypeId },
        value: document.documentId,
        title: document.title,
        description: `${document.editor} / ${document.documentTypeId}`,
        location: {
          projectId: document.projectId,
          documentTypeId: document.documentTypeId,
          path: document.path,
          documentId: document.documentId,
        },
      }))
      .sort((left, right) => compareUtf16CodeUnits(candidateKey(left), candidateKey(right)))
  );
  const searchPage = async (request: ReferenceSearchPageRequest) => {
    const target = readTarget(request.target);
    if (target === undefined) {
      return paginateReferenceCandidates({
        kind: DOCUMENT_REFERENCE_KIND,
        target: request.target,
        query: request.query,
        limit: request.limit,
        snapshotDependencyKey: request.snapshotDependencyKey,
        candidates: [],
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
    }
    const terms = normalizeReferenceQuery(request.query).split(" ").filter(Boolean);
    const filtered = (await candidates(target)).filter((candidate) => {
      const text = `${candidate.title}\n${candidate.description ?? ""}\n${candidate.value}\n${candidate.location?.path ?? ""}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    return paginateReferenceCandidates({
      kind: DOCUMENT_REFERENCE_KIND,
      target: request.target,
      query: request.query,
      limit: request.limit,
      snapshotDependencyKey: request.snapshotDependencyKey,
      candidates: filtered,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
  };
  return {
    kind: DOCUMENT_REFERENCE_KIND,
    validateTarget: validateDocumentReferenceTarget,
    async search(request) {
      const page = await searchPage({
        ...request,
        snapshotDependencyKey: DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
      });
      return page.candidates;
    },
    searchPage,
    async resolve(request) {
      const target = readTarget(request.target);
      if (target === undefined || typeof request.value !== "string") return [];
      return (await candidates(target)).filter((candidate) => candidate.value === request.value);
    },
  };
}

export function validateDocumentReferenceTarget(
  value: Readonly<Record<string, JsonValue>>,
): string | undefined {
  return readTarget(value) === undefined
    ? "Document references require only a stable string 'documentTypeId' selector."
    : undefined;
}

function readTarget(value: Readonly<Record<string, JsonValue>>): DocumentReferenceTarget | undefined {
  if (Object.keys(value).some((key) => key !== "documentTypeId") || !isIdentifier(value.documentTypeId)) {
    return undefined;
  }
  return { documentTypeId: value.documentTypeId };
}

function isIdentifier(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function candidateKey(candidate: ReferenceCandidate): string {
  return [candidate.title, String(candidate.value), candidate.location?.path ?? ""].join("\u0000");
}
