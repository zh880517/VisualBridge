import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  compareUtf16CodeUnits,
  type VisualBridgeProjectDefinition,
} from "@visualbridge/core";

export interface ProjectSemanticDocumentDependency {
  readonly documentTypeId: string;
  readonly path: string;
  readonly dependencyKey: string;
}

export function projectSemanticSnapshotDependencyKey(
  project: VisualBridgeProjectDefinition,
  documents: readonly ProjectSemanticDocumentDependency[],
): string {
  const orderedDocuments = [...documents].sort((left, right) => compareUtf16CodeUnits(
    `${left.documentTypeId}\u0000${left.path}\u0000${left.dependencyKey}`,
    `${right.documentTypeId}\u0000${right.path}\u0000${right.dependencyKey}`,
  ));
  return createHash("sha256").update(canonicalJsonStringify({ project, documents: orderedDocuments }), "utf8").digest("hex");
}
