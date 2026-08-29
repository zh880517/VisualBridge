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
  readonly elementId?: string;
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
  validateTarget?(target: Readonly<Record<string, JsonValue>>): string | undefined;
  search(request: ReferenceSearchRequest): Promise<readonly ReferenceCandidate[]>;
  resolve(request: ReferenceResolveRequest): Promise<readonly ReferenceCandidate[]>;
}

export interface ReferenceResolution {
  readonly status: "resolved" | "missing" | "ambiguous" | "providerUnavailable";
  readonly candidates: readonly ReferenceCandidate[];
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
    const provider = this.providers.get(definition.kind);
    if (provider === undefined) {
      return [];
    }
    if (provider.validateTarget?.(definition.target) !== undefined) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const candidates = await provider.search({ target: definition.target, query, limit: boundedLimit });
    return stableCandidates(candidates.filter((candidate) => candidate.kind === definition.kind)).slice(0, boundedLimit);
  }

  public async resolve(
    definition: ReferenceDefinition,
    value: string | number,
  ): Promise<ReferenceResolution> {
    const provider = this.providers.get(definition.kind);
    if (provider === undefined) {
      return { status: "providerUnavailable", candidates: [] };
    }
    if (provider.validateTarget?.(definition.target) !== undefined) {
      return { status: "missing", candidates: [] };
    }
    const candidates = stableCandidates(
      (await provider.resolve({ target: definition.target, value }))
        .filter((candidate) => candidate.kind === definition.kind && referenceValuesEqual(candidate.value, value)),
    );
    return {
      status: candidates.length === 0 ? "missing" : candidates.length === 1 ? "resolved" : "ambiguous",
      candidates,
    };
  }

  public async validate(occurrences: readonly ReferenceOccurrence[]): Promise<readonly DocumentDiagnostic[]> {
    const diagnostics: DocumentDiagnostic[] = [];
    for (const occurrence of occurrences) {
      const provider = this.providers.get(occurrence.definition.kind);
      const invalidTarget = provider?.validateTarget?.(occurrence.definition.target);
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
