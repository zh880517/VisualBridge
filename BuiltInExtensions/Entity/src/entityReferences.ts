import {
  compareUtf16CodeUnits,
  DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
  normalizeReferenceQuery,
  paginateReferenceCandidates,
  type JsonValue,
  type ReferenceCandidate,
  type ReferenceProvider,
  type ReferenceSearchPageRequest,
} from "@visualbridge/core";
import { resolveEntityComponentType, type EntityCatalogRegistry } from "./entityCatalog";
import { collectEntityReferences, type EntityDocument } from "./entityDocument";
import type { DocumentDiagnostic } from "@visualbridge/core";

export const ENTITY_COMPONENT_REFERENCE_KIND = "entity.component";

export interface EntityReferenceDocument {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly path: string;
  readonly document: EntityDocument;
  readonly registry: EntityCatalogRegistry;
}

interface EntityComponentReferenceTarget {
  readonly documentTypeId: string;
}

export function createEntityComponentReferenceProvider(
  loadDocuments: () => Promise<readonly EntityReferenceDocument[]>,
): ReferenceProvider {
  let documents: Promise<readonly EntityReferenceDocument[]> | undefined;
  const candidates = new Map<string, Promise<readonly ReferenceCandidate[]>>();
  const loadCandidates = (target: EntityComponentReferenceTarget): Promise<readonly ReferenceCandidate[]> => {
    const existing = candidates.get(target.documentTypeId);
    if (existing !== undefined) {
      return existing;
    }
    const loading = (documents ??= loadDocuments()).then((loaded) => collectCandidates(loaded, target));
    candidates.set(target.documentTypeId, loading);
    return loading;
  };
  const searchPage = async (request: ReferenceSearchPageRequest) => {
    const target = readTarget(request.target);
    const terms = normalizeReferenceQuery(request.query).split(" ").filter(Boolean);
    const filtered = target === undefined ? [] : (await loadCandidates(target)).filter((candidate) => {
      const text = `${candidate.title}\n${candidate.description ?? ""}\n${candidate.value}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    return paginateReferenceCandidates({
      kind: ENTITY_COMPONENT_REFERENCE_KIND,
      target: request.target,
      query: request.query,
      limit: request.limit,
      snapshotDependencyKey: request.snapshotDependencyKey,
      candidates: filtered,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
  };
  return {
    kind: ENTITY_COMPONENT_REFERENCE_KIND,
    validateTarget: validateEntityComponentReferenceTarget,
    async search(request) {
      return (await searchPage({
        ...request,
        snapshotDependencyKey: DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
      })).candidates;
    },
    searchPage,
    async resolve(request) {
      const target = readTarget(request.target);
      if (target === undefined || typeof request.value !== "string") return [];
      return (await loadCandidates(target)).filter((candidate) => candidate.value === request.value);
    },
  };
}

export function validateEntityComponentReferenceTarget(
  value: Readonly<Record<string, JsonValue>>,
): string | undefined {
  return readTarget(value) === undefined
    ? "Entity component references require only a stable documentTypeId selector."
    : undefined;
}

/**
 * 组件删除是单文件 Operation；该检查保证删除后同文档内不再残留指向被删组件的引用。
 * 常规 Reference 校验解析目标时读取的是写入前的磁盘字节，无法拦截同文档目标消失，
 * 因此删除路径需要在语义层显式比对前后组件集合。
 */
export function findDanglingComponentReferenceDiagnostics(
  before: EntityDocument,
  after: EntityDocument,
  registry: EntityCatalogRegistry,
): readonly DocumentDiagnostic[] {
  const afterIds = new Set(after.components.map((component) => component.id));
  const removedIds = new Set(before.components
    .map((component) => component.id)
    .filter((id) => !afterIds.has(id)));
  if (removedIds.size === 0) {
    return [];
  }
  const diagnostics: DocumentDiagnostic[] = [];
  for (const occurrence of collectEntityReferences(after, registry)) {
    if (occurrence.definition.kind !== ENTITY_COMPONENT_REFERENCE_KIND
      || typeof occurrence.value !== "string"
      || !removedIds.has(occurrence.value)) {
      continue;
    }
    diagnostics.push({
      severity: "error",
      code: "entity.removedComponentReferenced",
      path: occurrence.path,
      message: `Component '${occurrence.value}' is still referenced by this document and cannot be removed.`,
    });
  }
  return diagnostics;
}

function collectCandidates(
  documents: readonly EntityReferenceDocument[],
  target: EntityComponentReferenceTarget,
): readonly ReferenceCandidate[] {
  const candidates = documents
    .filter((source) => source.documentTypeId === target.documentTypeId)
    .flatMap((source) => source.document.components.map((component): ReferenceCandidate => {
      const componentType = resolveEntityComponentType(source.registry, component.componentTypeId);
      return {
        kind: ENTITY_COMPONENT_REFERENCE_KIND,
        target: { documentTypeId: target.documentTypeId },
        value: component.id,
        title: `${source.document.title} / ${componentType?.title ?? component.componentTypeId}`,
        description: `${componentType?.id ?? component.componentTypeId} / ${source.path}`,
        location: {
          projectId: source.projectId,
          documentTypeId: source.documentTypeId,
          path: source.path,
          documentId: source.document.documentId,
          componentId: component.id,
          elementKind: "component",
          elementId: component.id,
        },
      };
    }));
  return candidates.sort((left, right) => compareUtf16CodeUnits(candidateKey(left), candidateKey(right)));
}

function readTarget(value: Readonly<Record<string, JsonValue>>): EntityComponentReferenceTarget | undefined {
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "documentTypeId")) return undefined;
  return isIdentifier(value.documentTypeId) ? { documentTypeId: value.documentTypeId } : undefined;
}

function isIdentifier(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function candidateKey(candidate: ReferenceCandidate): string {
  return [
    candidate.title,
    String(candidate.value),
    candidate.location?.path ?? "",
    candidate.location?.documentId ?? "",
    candidate.location?.componentId ?? "",
  ].join("\u0000");
}
