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
}

export interface ReferenceResolveRequest {
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly value: string | number;
}

export interface ReferenceProvider {
  readonly kind: string;
  validateTarget?(
    target: Readonly<Record<string, JsonValue>>,
  ): string | undefined | Promise<string | undefined>;
  search(request: ReferenceSearchRequest): Promise<readonly ReferenceCandidate[]>;
  resolve(request: ReferenceResolveRequest): Promise<readonly ReferenceCandidate[]>;
}

export const BUILT_IN_REFERENCE_KINDS = [
  "document",
  "entity.component",
  "graph.element",
  "table.row",
] as const;

export interface ReferenceSearchResult {
  readonly status: "ok" | "invalidTarget" | "providerUnavailable";
  readonly candidates: readonly ReferenceCandidate[];
  readonly message?: string;
}

export interface ReferenceResolution {
  readonly status: "resolved" | "missing" | "ambiguous" | "invalidTarget" | "providerUnavailable";
  readonly candidates: readonly ReferenceCandidate[];
  readonly message?: string;
}

export class ReferenceService {
  private readonly providers = new Map<string, ReferenceProvider>();

  public constructor(providers: readonly ReferenceProvider[] = []) {
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
  ): Promise<readonly ReferenceCandidate[]> {
    return (await this.searchDetailed(definition, query, limit)).candidates;
  }

  public async searchDetailed(
    definition: ReferenceDefinition,
    query = "",
    limit = 50,
  ): Promise<ReferenceSearchResult> {
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
      invalidTarget = await provider.validateTarget?.(definition.target);
    } catch (error) {
      return unavailable(error);
    }
    if (invalidTarget !== undefined) {
      return { status: "invalidTarget", candidates: [], message: invalidTarget };
    }
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    try {
      const candidates = await provider.search({ target: definition.target, query, limit: boundedLimit });
      return {
        status: "ok",
        candidates: stableCandidates(candidates.filter((candidate) => candidate.kind === definition.kind))
          .slice(0, boundedLimit),
      };
    } catch (error) {
      return unavailable(error);
    }
  }

  public async resolve(
    definition: ReferenceDefinition,
    value: string | number,
  ): Promise<ReferenceResolution> {
    const provider = this.providers.get(definition.kind);
    if (provider === undefined) {
      return { status: "providerUnavailable", candidates: [] };
    }
    let invalidTarget: string | undefined;
    try {
      invalidTarget = await provider.validateTarget?.(definition.target);
    } catch (error) {
      return unavailableResolution(error);
    }
    if (invalidTarget !== undefined) {
      return { status: "invalidTarget", candidates: [], message: invalidTarget };
    }
    let candidates: readonly ReferenceCandidate[];
    try {
      candidates = stableCandidates(
        (await provider.resolve({ target: definition.target, value }))
          .filter((candidate) => candidate.kind === definition.kind && referenceValuesEqual(candidate.value, value)),
      );
    } catch (error) {
      return unavailableResolution(error);
    }
    return {
      status: candidates.length === 0 ? "missing" : candidates.length === 1 ? "resolved" : "ambiguous",
      candidates,
    };
  }

  public async validate(occurrences: readonly ReferenceOccurrence[]): Promise<readonly DocumentDiagnostic[]> {
    const diagnostics: DocumentDiagnostic[] = [];
    for (const occurrence of occurrences) {
      const provider = this.providers.get(occurrence.definition.kind);
      let invalidTarget: string | undefined;
      try {
        invalidTarget = await provider?.validateTarget?.(occurrence.definition.target);
      } catch {
        diagnostics.push(warning(
          "reference.providerUnavailable",
          occurrence.path,
          `Reference provider '${occurrence.definition.kind}' is unavailable; the stored value is preserved.`,
        ));
        continue;
      }
      if (invalidTarget !== undefined) {
        diagnostics.push(error("reference.invalidTarget", occurrence.path, invalidTarget));
        continue;
      }
      const resolution = await this.resolve(occurrence.definition, occurrence.value);
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
      }
    }
    return diagnostics;
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

function stableCandidates(candidates: readonly ReferenceCandidate[]): readonly ReferenceCandidate[] {
  return [...candidates].sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
}

function candidateKey(candidate: ReferenceCandidate): string {
  const location = candidate.location;
  return [
    candidate.title,
    typeof candidate.value,
    String(candidate.value),
    location?.projectId ?? "",
    location?.documentTypeId ?? "",
    location?.path ?? "",
    location?.documentId ?? "",
    location?.componentId ?? "",
    location?.elementKind ?? "",
    location?.elementId ?? "",
    location?.graphId ?? "",
    location?.nodeId ?? "",
    location?.portId ?? "",
    location?.sheetId ?? "",
    location?.rowId ?? "",
  ].join("\u0000");
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function warning(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "warning", code, path, message };
}
