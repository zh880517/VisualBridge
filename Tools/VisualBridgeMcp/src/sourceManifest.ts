import { createHash } from "node:crypto";
import { compareUtf16CodeUnits } from "@visualbridge/core";

export interface HashedSourceManifestEntry {
  readonly path: string;
  readonly hash: string;
}

/** Hashes a physical source set without relying on discovery or caller order. */
export function hashSourceManifest(sources: readonly HashedSourceManifestEntry[]): string {
  if (sources.length === 1) return sources[0]!.hash;

  return hashManifest(sources);
}

/**
 * 始终哈希清单本身（即使只有一项）。
 *
 * Catalog 的 `catalogHash` 用它：单个 Catalog 文件的内容变化必须改变 snapshot Hash，
 * 而不是退回文件 Hash 让"路径与 Hash 相同"的语义失真。
 */
export function hashPathManifest(entries: readonly HashedSourceManifestEntry[]): string {
  return hashManifest(entries);
}

function hashManifest(entries: readonly HashedSourceManifestEntry[]): string {
  const ordered = [...entries].sort((left, right) =>
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
