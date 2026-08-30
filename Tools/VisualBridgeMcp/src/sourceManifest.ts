import { createHash } from "node:crypto";
import { compareUtf16CodeUnits } from "@visualbridge/core";

export interface HashedSourceManifestEntry {
  readonly path: string;
  readonly hash: string;
}

/** Hashes a physical source set without relying on discovery or caller order. */
export function hashSourceManifest(sources: readonly HashedSourceManifestEntry[]): string {
  if (sources.length === 1) return sources[0]!.hash;

  const ordered = [...sources].sort((left, right) =>
    compareUtf16CodeUnits(left.path, right.path) || compareUtf16CodeUnits(left.hash, right.hash));
  const hash = createHash("sha256");
  for (const source of ordered) {
    hash.update(source.path);
    hash.update("\0");
    hash.update(source.hash);
    hash.update("\0");
  }
  return hash.digest("hex");
}
