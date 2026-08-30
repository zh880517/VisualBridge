import type { DocumentDiagnostic } from "../Document/document";
import type { JsonValue } from "../Form/field";

export interface ReferenceDefinition {
  readonly kind: string;
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly allowMissing: boolean;
}

export interface ReferenceOccurrence {
  readonly definition: ReferenceDefinition;
  readonly value: string | number;
  readonly path: string;
}

export interface ReferenceLocation {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly path: string;
  readonly documentId?: string;
  readonly componentId?: string;
  readonly elementKind?: string;
  readonly elementId?: string;
  readonly graphId?: string;
  readonly nodeId?: string;
  readonly portId?: string;
  readonly sheetId?: string;
  readonly rowId?: string;
}

export interface ReferenceCandidate {
  readonly kind: string;
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly value: string | number;
  readonly title: string;
  readonly description?: string;
  readonly location?: ReferenceLocation;
}

export interface ReferenceSearchRequest {
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export const REFERENCE_SEARCH_CURSOR_VERSION = 2;
export const DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY = "reference.snapshot.unspecified";
export const REFERENCE_PROVIDER_CONTINUATION_MAX_LENGTH = 16_384;

export interface ReferenceSearchCursorPosition {
  readonly title: string;
  readonly valueType: "number" | "string";
  readonly value: string | number;
  readonly candidateKey: string;
}

export interface ReferenceProviderContinuation {
  readonly providerId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly entryHash: string;
  readonly cursor: string;
  readonly snapshotHash: string;
}

export interface ReferenceSearchCursor {
  readonly version: typeof REFERENCE_SEARCH_CURSOR_VERSION;
  readonly kind: string;
  readonly canonicalTarget: string;
  readonly query: string;
  readonly snapshotDependencyKey: string;
  readonly after: ReferenceSearchCursorPosition;
  readonly providerContinuation?: ReferenceProviderContinuation;
}

export interface ReferenceSearchPageRequest extends ReferenceSearchRequest {
  readonly snapshotDependencyKey: string;
  readonly cursor?: ReferenceSearchCursor;
}

export interface ReferenceResolveRequest {
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly value: string | number;
  readonly signal?: AbortSignal;
}

export interface ReferenceProvider {
  readonly kind: string;
  validateTarget?(
    target: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): string | undefined | Promise<string | undefined>;
  search(request: ReferenceSearchRequest): Promise<readonly ReferenceCandidate[]>;
  searchPage?(request: ReferenceSearchPageRequest): Promise<ReferenceSearchPage>;
  resolve(request: ReferenceResolveRequest): Promise<readonly ReferenceCandidate[]>;
}

export const BUILT_IN_REFERENCE_KINDS = [
  "document",
  "entity.component",
  "graph.element",
  "table.row",
] as const;

export type ReferenceSearchPage =
  | {
      readonly status: "ok";
      readonly candidates: readonly ReferenceCandidate[];
      readonly nextCursor?: ReferenceSearchCursor;
    }
  | {
      readonly status: "invalidTarget" | "providerUnavailable" | "cursor.invalid" | "cursor.queryMismatch" | "cursor.snapshotChanged";
      readonly candidates: readonly [];
      readonly message: string;
    };

export type ReferenceSearchResult = ReferenceSearchPage;

export interface ReferenceResolution {
  readonly status: "resolved" | "missing" | "ambiguous" | "invalidTarget" | "providerUnavailable";
  readonly candidates: readonly ReferenceCandidate[];
  readonly message?: string;
}

export interface AnalyzedReferenceOccurrence {
  readonly occurrence: ReferenceOccurrence;
  readonly resolution: ReferenceResolution;
}

export interface ReferenceAnalysisResult {
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly references: readonly AnalyzedReferenceOccurrence[];
}

export class ReferenceService {
  private readonly providers = new Map<string, ReferenceProvider>();

  public constructor(
    providers: readonly ReferenceProvider[] = [],
    private readonly snapshotDependencyKey = DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
  ) {
    providers.forEach((provider) => this.register(provider));
  }

  public register(provider: ReferenceProvider): void {
    if (this.providers.has(provider.kind)) {
      throw new Error(`Reference provider '${provider.kind}' is already registered.`);
    }
    this.providers.set(provider.kind, provider);
  }

  public async search(
    definition: ReferenceDefinition,
    query = "",
    limit = 50,
    signal?: AbortSignal,
  ): Promise<readonly ReferenceCandidate[]> {
    return (await this.searchPage(definition, query, limit, undefined, signal)).candidates;
  }

  public async searchDetailed(
    definition: ReferenceDefinition,
    query = "",
    limit = 50,
    signal?: AbortSignal,
  ): Promise<ReferenceSearchResult> {
    return this.searchPage(definition, query, limit, undefined, signal);
  }

  public async searchPage(
    definition: ReferenceDefinition,
    query = "",
    limit = 50,
    cursor?: ReferenceSearchCursor,
    signal?: AbortSignal,
  ): Promise<ReferenceSearchPage> {
    throwIfAborted(signal);
    const normalizedQuery = normalizeReferenceQuery(query);
    const cursorIssue = validateReferenceSearchCursor(
      cursor,
      definition.kind,
      definition.target,
      normalizedQuery,
      this.snapshotDependencyKey,
    );
    if (cursorIssue !== undefined) return cursorIssue;
    const provider = this.providers.get(definition.kind);
    if (provider === undefined) {
      return {
        status: "providerUnavailable",
        candidates: [],
        message: `Reference provider '${definition.kind}' is unavailable.`,
      };
    }
    let invalidTarget: string | undefined;
    try {
      invalidTarget = await provider.validateTarget?.(definition.target, signal);
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      return unavailable(error);
    }
    if (invalidTarget !== undefined) {
      return { status: "invalidTarget", candidates: [], message: invalidTarget };
    }
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    try {
      if (provider.searchPage !== undefined) {
        const page = await provider.searchPage({
          target: definition.target,
          query: normalizedQuery,
          limit: boundedLimit,
          snapshotDependencyKey: this.snapshotDependencyKey,
          ...(cursor === undefined ? {} : { cursor }),
          ...(signal === undefined ? {} : { signal }),
        });
        throwIfAborted(signal);
        return validateProviderPage(
          page,
          definition.kind,
          definition.target,
          normalizedQuery,
          this.snapshotDependencyKey,
          cursor,
          boundedLimit,
        );
      }
      const candidates = await provider.search({
        target: definition.target,
        query: normalizedQuery,
        limit: 200,
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);
      return paginateReferenceCandidates({
        kind: definition.kind,
        target: definition.target,
        query: normalizedQuery,
        limit: boundedLimit,
        snapshotDependencyKey: this.snapshotDependencyKey,
        candidates,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      throwIfAborted(signal);
      return unavailable(error);
    }
  }

  public async resolve(
    definition: ReferenceDefinition,
    value: string | number,
    signal?: AbortSignal,
  ): Promise<ReferenceResolution> {
    throwIfAborted(signal);
    const provider = this.providers.get(definition.kind);
    if (provider === undefined) {
      return { status: "providerUnavailable", candidates: [] };
    }
    let invalidTarget: string | undefined;
    try {
      invalidTarget = await provider.validateTarget?.(definition.target, signal);
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      return unavailableResolution(error);
    }
    if (invalidTarget !== undefined) {
      return { status: "invalidTarget", candidates: [], message: invalidTarget };
    }
    let candidates: readonly ReferenceCandidate[];
    try {
      candidates = stableCandidates(
        (await provider.resolve({
          target: definition.target,
          value,
          ...(signal === undefined ? {} : { signal }),
        }))
          .filter((candidate) => candidate.kind === definition.kind && referenceValuesEqual(candidate.value, value)),
      );
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      return unavailableResolution(error);
    }
    return {
      status: candidates.length === 0 ? "missing" : candidates.length === 1 ? "resolved" : "ambiguous",
      candidates,
    };
  }

  public async analyzeOccurrences(
    occurrences: readonly ReferenceOccurrence[],
    signal?: AbortSignal,
  ): Promise<ReferenceAnalysisResult> {
    const diagnostics: DocumentDiagnostic[] = [];
    const references: AnalyzedReferenceOccurrence[] = [];
    for (const occurrence of occurrences) {
      throwIfAborted(signal);
      const resolution = await this.resolve(occurrence.definition, occurrence.value, signal);
      references.push({ occurrence, resolution });
      if (resolution.status === "providerUnavailable") {
        diagnostics.push(warning(
          "reference.providerUnavailable",
          occurrence.path,
          `Reference provider '${occurrence.definition.kind}' is unavailable; the stored value is preserved.`,
        ));
      } else if (resolution.status === "missing" && !occurrence.definition.allowMissing) {
        diagnostics.push(error(
          "reference.missingTarget",
          occurrence.path,
          `Reference '${String(occurrence.value)}' does not resolve for kind '${occurrence.definition.kind}'.`,
        ));
      } else if (resolution.status === "ambiguous") {
        diagnostics.push(error(
          "reference.ambiguousTarget",
          occurrence.path,
          `Reference '${String(occurrence.value)}' resolves to ${resolution.candidates.length} targets.`,
        ));
      } else if (resolution.status === "invalidTarget") {
        diagnostics.push(error(
          "reference.invalidTarget",
          occurrence.path,
          resolution.message ?? `Reference target for kind '${occurrence.definition.kind}' is invalid.`,
        ));
      }
    }
    throwIfAborted(signal);
    return { diagnostics, references };
  }

  public async validate(
    occurrences: readonly ReferenceOccurrence[],
    signal?: AbortSignal,
  ): Promise<readonly DocumentDiagnostic[]> {
    return (await this.analyzeOccurrences(occurrences, signal)).diagnostics;
  }
}

function unavailable(error: unknown): ReferenceSearchResult {
  return {
    status: "providerUnavailable",
    candidates: [],
    message: error instanceof Error ? error.message : "Reference provider is unavailable.",
  };
}

function unavailableResolution(error: unknown): ReferenceResolution {
  return {
    status: "providerUnavailable",
    candidates: [],
    message: error instanceof Error ? error.message : "Reference provider is unavailable.",
  };
}

export function referenceValuesEqual(left: string | number, right: string | number): boolean {
  return typeof left === typeof right && left === right;
}

export function paginateReferenceCandidates(options: {
  readonly kind: string;
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly query: string;
  readonly limit: number;
  readonly snapshotDependencyKey: string;
  readonly candidates: readonly ReferenceCandidate[];
  readonly cursor?: ReferenceSearchCursor;
}): ReferenceSearchPage {
  const query = normalizeReferenceQuery(options.query);
  const cursorIssue = validateReferenceSearchCursor(
    options.cursor,
    options.kind,
    options.target,
    query,
    options.snapshotDependencyKey,
  );
  if (cursorIssue !== undefined) return cursorIssue;
  const candidates = stableCandidates(options.candidates.filter((candidate) => candidate.kind === options.kind));
  let start = 0;
  if (options.cursor !== undefined) {
    const index = candidates.findIndex((candidate) => cursorPositionMatches(options.cursor!.after, candidate));
    if (index < 0) {
      return cursorInvalid("Reference cursor position is absent from the current snapshot.");
    }
    start = index + 1;
  }
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit)));
  const pageCandidates = candidates.slice(start, start + limit);
  const last = pageCandidates.at(-1);
  const hasMore = start + pageCandidates.length < candidates.length;
  return {
    status: "ok",
    candidates: pageCandidates,
    ...(hasMore && last !== undefined
      ? { nextCursor: createReferenceSearchCursor(
          options.kind,
          options.target,
          query,
          options.snapshotDependencyKey,
          last,
        ) }
      : {}),
  };
}

export function normalizeReferenceQuery(query: string): string {
  return query.normalize("NFC").trim().toLowerCase().split(/\s+/u).filter(Boolean).join(" ");
}

export function canonicalReferenceTarget(target: Readonly<Record<string, JsonValue>>): string {
  return canonicalJson(target);
}

function stableCandidates(candidates: readonly ReferenceCandidate[]): readonly ReferenceCandidate[] {
  const byKey = new Map<string, ReferenceCandidate>();
  for (const candidate of candidates) byKey.set(candidateKey(candidate), candidate);
  return [...byKey.values()].sort(compareCandidates);
}

function candidateKey(candidate: ReferenceCandidate): string {
  return canonicalJson(candidate as unknown as JsonValue);
}

function compareCandidates(left: ReferenceCandidate, right: ReferenceCandidate): number {
  return compareOrdinal(left.title, right.title)
    || valueTypeRank(left.value) - valueTypeRank(right.value)
    || compareReferenceValues(left.value, right.value)
    || compareOrdinal(candidateKey(left), candidateKey(right));
}

function compareReferenceValues(left: string | number, right: string | number): number {
  if (typeof left !== typeof right) return valueTypeRank(left) - valueTypeRank(right);
  if (typeof left === "number" && typeof right === "number") return left - right;
  return compareOrdinal(String(left), String(right));
}

function valueTypeRank(value: string | number): number {
  return typeof value === "number" ? 0 : 1;
}

export function createReferenceSearchCursor(
  kind: string,
  target: Readonly<Record<string, JsonValue>>,
  query: string,
  snapshotDependencyKey: string,
  candidate: ReferenceCandidate,
  providerContinuation?: ReferenceProviderContinuation,
): ReferenceSearchCursor {
  return {
    version: REFERENCE_SEARCH_CURSOR_VERSION,
    kind,
    canonicalTarget: canonicalReferenceTarget(target),
    query,
    snapshotDependencyKey,
    after: {
      title: candidate.title,
      valueType: typeof candidate.value === "number" ? "number" : "string",
      value: candidate.value,
      candidateKey: candidateKey(candidate),
    },
    ...(providerContinuation === undefined ? {} : { providerContinuation }),
  };
}

function validateReferenceSearchCursor(
  cursor: ReferenceSearchCursor | undefined,
  kind: string,
  target: Readonly<Record<string, JsonValue>>,
  query: string,
  snapshotDependencyKey: string,
): Exclude<ReferenceSearchPage, { readonly status: "ok" }> | undefined {
  if (cursor === undefined) return undefined;
  if (!isReferenceSearchCursorShape(cursor)) {
    return cursorInvalid("Reference cursor version, shape, or value type is invalid.");
  }
  if (cursor.kind !== kind
    || cursor.canonicalTarget !== canonicalReferenceTarget(target)
    || cursor.query !== query) {
    return {
      status: "cursor.queryMismatch",
      candidates: [],
      message: "Reference cursor does not belong to the requested kind, target, or query.",
    };
  }
  if (cursor.snapshotDependencyKey !== snapshotDependencyKey) {
    return {
      status: "cursor.snapshotChanged",
      candidates: [],
      message: "Reference snapshot changed after the cursor was issued; restart the search from the first page.",
    };
  }
  return undefined;
}

function isReferenceSearchCursorShape(cursor: unknown): cursor is ReferenceSearchCursor {
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return false;
  const value = cursor as Partial<ReferenceSearchCursor>;
  if (!hasOnlyKeys(value, [
    "version", "kind", "canonicalTarget", "query", "snapshotDependencyKey", "after", "providerContinuation",
  ])) return false;
  if (value.version !== REFERENCE_SEARCH_CURSOR_VERSION
    || typeof value.kind !== "string"
    || typeof value.canonicalTarget !== "string"
    || typeof value.query !== "string"
    || typeof value.snapshotDependencyKey !== "string"
    || typeof value.after !== "object"
    || value.after === null
    || Array.isArray(value.after)) return false;
  const after = value.after as Partial<ReferenceSearchCursorPosition>;
  if (!hasOnlyKeys(after, ["title", "valueType", "value", "candidateKey"])
    || typeof after.title !== "string"
    || typeof after.candidateKey !== "string"
    || (after.valueType !== "number" && after.valueType !== "string")
    || typeof after.value !== after.valueType
    || (after.valueType === "number" && !Number.isFinite(after.value))) return false;
  if (value.providerContinuation === undefined) return true;
  if (typeof value.providerContinuation !== "object" || value.providerContinuation === null
    || Array.isArray(value.providerContinuation)) return false;
  const continuation = value.providerContinuation as Partial<ReferenceProviderContinuation>;
  return hasOnlyKeys(continuation, ["providerId", "instanceId", "generation", "entryHash", "cursor", "snapshotHash"])
    && typeof continuation.providerId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(continuation.providerId)
    && typeof continuation.instanceId === "string"
    && continuation.instanceId.length > 0
    && continuation.instanceId.length <= 128
    && typeof continuation.generation === "number"
    && Number.isSafeInteger(continuation.generation)
    && continuation.generation >= 0
    && typeof continuation.cursor === "string"
    && continuation.cursor.length > 0
    && continuation.cursor.length <= REFERENCE_PROVIDER_CONTINUATION_MAX_LENGTH
    && typeof continuation.entryHash === "string"
    && /^[a-f0-9]{64}$/.test(continuation.entryHash)
    && typeof continuation.snapshotHash === "string"
    && /^[a-f0-9]{64}$/.test(continuation.snapshotHash);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateProviderPage(
  page: ReferenceSearchPage,
  kind: string,
  target: Readonly<Record<string, JsonValue>>,
  query: string,
  snapshotDependencyKey: string,
  cursor: ReferenceSearchCursor | undefined,
  limit: number,
): ReferenceSearchPage {
  if (page.status !== "ok") return page;
  if (page.candidates.length > limit) {
    return { status: "providerUnavailable", candidates: [], message: "Reference Provider returned more candidates than requested." };
  }
  const expected = paginateReferenceCandidates({
    kind,
    target,
    query,
    limit,
    snapshotDependencyKey,
    candidates: page.candidates,
  });
  if (expected.status !== "ok"
    || expected.candidates.length !== page.candidates.length
    || expected.candidates.some((candidate, index) => candidateKey(candidate) !== candidateKey(page.candidates[index]!))) {
    return { status: "providerUnavailable", candidates: [], message: "Reference Provider page is not deterministically ordered." };
  }
  if (page.nextCursor !== undefined) {
    const issue = validateReferenceSearchCursor(page.nextCursor, kind, target, query, snapshotDependencyKey);
    const last = page.candidates.at(-1);
    if (issue !== undefined || last === undefined || !cursorPositionMatches(page.nextCursor.after, last)) {
      return { status: "providerUnavailable", candidates: [], message: "Reference Provider returned an invalid next cursor." };
    }
  }
  if (cursor !== undefined && page.candidates.some((candidate) => cursorPositionMatches(cursor.after, candidate))) {
    return { status: "providerUnavailable", candidates: [], message: "Reference Provider repeated the cursor boundary candidate." };
  }
  if (cursor !== undefined && page.candidates.some((candidate) => compareCandidateToCursor(candidate, cursor.after) <= 0)) {
    return {
      status: "providerUnavailable",
      candidates: [],
      message: "Reference Provider page is not strictly ordered after the cursor boundary.",
    };
  }
  return page;
}

function compareCandidateToCursor(candidate: ReferenceCandidate, cursor: ReferenceSearchCursorPosition): number {
  return compareOrdinal(candidate.title, cursor.title)
    || valueTypeRank(candidate.value) - (cursor.valueType === "number" ? 0 : 1)
    || compareReferenceValues(candidate.value, cursor.value)
    || compareOrdinal(candidateKey(candidate), cursor.candidateKey);
}

function cursorPositionMatches(position: ReferenceSearchCursorPosition, candidate: ReferenceCandidate): boolean {
  return position.valueType === typeof candidate.value
    && referenceValuesEqual(position.value, candidate.value)
    && position.candidateKey === candidateKey(candidate);
}

function cursorInvalid(message: string): Exclude<ReferenceSearchPage, { readonly status: "ok" }> {
  return { status: "cursor.invalid", candidates: [], message };
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(record).sort(compareOrdinal).map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function warning(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "warning", code, path, message };
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
