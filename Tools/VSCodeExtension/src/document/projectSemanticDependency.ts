import { createHash } from "node:crypto";
import type { VisualBridgeProjectDefinition } from "@visualbridge/core";

export interface ProjectSemanticDocumentDependency {
  readonly documentTypeId: string;
  readonly path: string;
  readonly dependencyKey: string;
}

export function projectSemanticSnapshotDependencyKey(
  project: VisualBridgeProjectDefinition,
  documents: readonly ProjectSemanticDocumentDependency[],
): string {
  const orderedDocuments = [...documents].sort((left, right) => compareOrdinal(
    `${left.documentTypeId}\u0000${left.path}\u0000${left.dependencyKey}`,
    `${right.documentTypeId}\u0000${right.path}\u0000${right.dependencyKey}`,
  ));
  return createHash("sha256").update(JSON.stringify({ project, documents: orderedDocuments }), "utf8").digest("hex");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
