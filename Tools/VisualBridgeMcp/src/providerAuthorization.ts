import path from "node:path";

export const PROVIDER_ENABLED_ENV = "VISUALBRIDGE_PROVIDER_ENABLED";
export const PROVIDER_ALLOWLIST_ENV = "VISUALBRIDGE_PROVIDER_ALLOWLIST";

export interface ProjectProviderAuthorization {
  readonly enabled: boolean;
  readonly allowedEntryPaths: readonly string[];
}

export class ProjectProviderAuthorizationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectProviderAuthorizationError";
  }
}

export function readProjectProviderAuthorization(
  environment: Readonly<Record<string, string | undefined>>,
): ProjectProviderAuthorization {
  const enabledValue = environment[PROVIDER_ENABLED_ENV];
  if (enabledValue === undefined || enabledValue === "0") {
    return { enabled: false, allowedEntryPaths: [] };
  }
  if (enabledValue !== "1") {
    throw new ProjectProviderAuthorizationError(
      `${PROVIDER_ENABLED_ENV} must be '1' to enable Project Providers or '0' to disable them.`,
    );
  }

  const encodedAllowlist = environment[PROVIDER_ALLOWLIST_ENV];
  if (encodedAllowlist === undefined) {
    throw new ProjectProviderAuthorizationError(
      `${PROVIDER_ALLOWLIST_ENV} is required when Project Providers are enabled.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedAllowlist);
  } catch (errorValue) {
    throw new ProjectProviderAuthorizationError(
      `${PROVIDER_ALLOWLIST_ENV} must be a JSON array: ${formatError(errorValue)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ProjectProviderAuthorizationError(
      `${PROVIDER_ALLOWLIST_ENV} must be a non-empty JSON array of normalized absolute paths.`,
    );
  }

  const allowedEntryPaths: string[] = [];
  const seen = new Set<string>();
  parsed.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
      throw new ProjectProviderAuthorizationError(
        `${PROVIDER_ALLOWLIST_ENV}[${index}] must be a normalized absolute path.`,
      );
    }
    const normalized = path.normalize(value);
    if (normalized !== value || path.resolve(value) !== value) {
      throw new ProjectProviderAuthorizationError(
        `${PROVIDER_ALLOWLIST_ENV}[${index}] must not contain relative or redundant path segments.`,
      );
    }
    const identity = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(identity)) {
      throw new ProjectProviderAuthorizationError(
        `${PROVIDER_ALLOWLIST_ENV}[${index}] duplicates another allowed entry path.`,
      );
    }
    seen.add(identity);
    allowedEntryPaths.push(normalized);
  });
  return { enabled: true, allowedEntryPaths };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
