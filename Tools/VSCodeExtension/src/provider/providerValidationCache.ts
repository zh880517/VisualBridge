import type { DocumentDiagnostic, ProjectProviderDocumentSnapshot } from "@visualbridge/core";

export class ProviderValidationCache {
  private readonly values = new Map<string, readonly DocumentDiagnostic[]>();
  private revision = 0;

  public get(key: string): readonly DocumentDiagnostic[] | undefined {
    return this.values.get(key);
  }

  public set(key: string, diagnostics: readonly DocumentDiagnostic[]): readonly DocumentDiagnostic[] {
    const frozen = freezeDiagnostics(diagnostics);
    this.values.set(key, frozen);
    return frozen;
  }

  public async getOrValidate(
    projectKey: string,
    key: string,
    signal: AbortSignal | undefined,
    validate: (signal: AbortSignal | undefined) => Promise<{
      readonly diagnostics: readonly DocumentDiagnostic[];
      readonly cacheable: boolean;
      readonly cacheKey?: string;
    }>,
  ): Promise<readonly DocumentDiagnostic[]> {
    throwIfAborted(signal);
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;
    const startedRevision = this.revision;
    try {
      const result = await validate(signal);
      throwIfAborted(signal);
      if (!result.cacheable) {
        this.invalidateProject(projectKey);
        return freezeDiagnostics(result.diagnostics);
      }
      const frozen = freezeDiagnostics(result.diagnostics);
      if (this.revision === startedRevision) this.values.set(result.cacheKey ?? key, frozen);
      return frozen;
    } catch (errorValue) {
      this.invalidateProject(projectKey);
      throw errorValue;
    }
  }

  public invalidateProject(projectKey: string): void {
    this.revision += 1;
    const prefix = `${projectKey}\u0000`;
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }

  public clear(): void {
    this.revision += 1;
    this.values.clear();
  }
}

export function providerValidationCacheKey(
  projectKey: string,
  providerGenerationKey: string,
  projectDependencyKey: string,
  snapshot: ProjectProviderDocumentSnapshot,
): string {
  return [
    projectKey,
    providerGenerationKey,
    projectDependencyKey,
    snapshot.documentTypeId,
    snapshot.path,
    snapshot.sourceHash,
  ].join("\u0000");
}

export function isProviderValidationResultCacheable(result: {
  readonly unavailableProviderIds: readonly string[];
  readonly externalModification?: unknown;
}): boolean {
  return result.unavailableProviderIds.length === 0 && result.externalModification === undefined;
}

function freezeDiagnostics(diagnostics: readonly DocumentDiagnostic[]): readonly DocumentDiagnostic[] {
  return Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException("Provider validation was cancelled.", "AbortError");
}
