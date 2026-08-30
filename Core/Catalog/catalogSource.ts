import { compareUtf16CodeUnits } from "../Ordering/ordinal";

export const CATALOG_SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type CatalogSourceDefinition =
  | {
    readonly status: "unknown";
  }
  | {
    readonly status: "current";
    readonly providerId: string;
    readonly sourceHash: string;
  }
  | {
    readonly status: "stale";
    readonly providerId: string;
    readonly sourceHash: string;
    readonly currentSourceHash: string;
  };

export interface CatalogSourceIssue {
  readonly path: string;
  readonly message: string;
}

export type CatalogSourceParseResult =
  | { readonly success: true; readonly value: CatalogSourceDefinition }
  | { readonly success: false; readonly issues: readonly CatalogSourceIssue[] };

export function createUnknownCatalogSource(): CatalogSourceDefinition {
  return { status: "unknown" };
}

export function parseCatalogSourceDefinition(
  value: unknown,
  path = "source",
): CatalogSourceParseResult {
  if (!isRecord(value)) {
    return failure(path, "Expected a Catalog source object.");
  }
  if (value.status === "unknown") {
    const issues = unknownKeys(value, ["status"], path);
    return issues.length === 0
      ? { success: true, value: { status: "unknown" } }
      : { success: false, issues };
  }
  if (value.status !== "current" && value.status !== "stale") {
    return failure(`${path}.status`, "Expected 'unknown', 'current' or 'stale'.");
  }

  const issues = unknownKeys(
    value,
    value.status === "current"
      ? ["status", "providerId", "sourceHash"]
      : ["status", "providerId", "sourceHash", "currentSourceHash"],
    path,
  );
  const providerId = readIdentifier(value.providerId, `${path}.providerId`, issues);
  const sourceHash = readHash(value.sourceHash, `${path}.sourceHash`, issues);
  if (value.status === "current") {
    return issues.length === 0 && providerId !== undefined && sourceHash !== undefined
      ? { success: true, value: { status: "current", providerId, sourceHash } }
      : { success: false, issues };
  }

  const currentSourceHash = readHash(value.currentSourceHash, `${path}.currentSourceHash`, issues);
  if (sourceHash !== undefined && currentSourceHash !== undefined && sourceHash === currentSourceHash) {
    issues.push({
      path: `${path}.currentSourceHash`,
      message: "A stale Catalog must declare a current source Hash different from its generated source Hash.",
    });
  }
  return issues.length === 0
    && providerId !== undefined
    && sourceHash !== undefined
    && currentSourceHash !== undefined
    ? {
      success: true,
      value: { status: "stale", providerId, sourceHash, currentSourceHash },
    }
    : { success: false, issues };
}

export function serializeCatalogSourceDefinition(source: CatalogSourceDefinition): CatalogSourceDefinition {
  if (source.status === "unknown") {
    return { status: "unknown" };
  }
  if (source.status === "current") {
    return {
      status: "current",
      providerId: source.providerId,
      sourceHash: source.sourceHash,
    };
  }
  return {
    status: "stale",
    providerId: source.providerId,
    sourceHash: source.sourceHash,
    currentSourceHash: source.currentSourceHash,
  };
}

function readIdentifier(
  value: unknown,
  path: string,
  issues: CatalogSourceIssue[],
): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    issues.push({ path, message: "Expected a stable provider identifier." });
    return undefined;
  }
  return value;
}

function readHash(value: unknown, path: string, issues: CatalogSourceIssue[]): string | undefined {
  if (typeof value !== "string" || !CATALOG_SOURCE_HASH_PATTERN.test(value)) {
    issues.push({ path, message: "Expected a lowercase 64-character SHA-256 Hash." });
    return undefined;
  }
  return value;
}

function unknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): CatalogSourceIssue[] {
  const allowedKeys = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .sort(compareUtf16CodeUnits)
    .map((key) => ({ path: `${path}.${key}`, message: `Unknown property '${key}'.` }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(path: string, message: string): CatalogSourceParseResult {
  return { success: false, issues: [{ path, message }] };
}
