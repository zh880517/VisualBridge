import { createHash } from "node:crypto";
import { compareUtf16CodeUnits } from "@visualbridge/core";

export interface ReferenceSemanticSnapshot {
  readonly project: unknown;
  readonly documents?: unknown;
  readonly entities?: unknown;
  readonly graphs?: unknown;
  readonly tables?: unknown;
}

export function referenceSemanticSnapshotDependencyKey(
  sourceDependencyKey: string,
  snapshot: ReferenceSemanticSnapshot,
): string {
  return createHash("sha256")
    .update("visualbridge-reference-semantic-snapshot-v2\0")
    .update(sourceDependencyKey)
    .update("\0")
    .update(canonicalJson(snapshot))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Reference semantic snapshots contain only finite JSON numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareUtf16CodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Reference semantic snapshots must be JSON-compatible values.");
}
