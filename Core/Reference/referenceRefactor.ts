import { documentIndexKey, type IndexedDocument, type IndexedDocumentReference } from "../Document/documentIndex";
import {
  referenceValuesEqual,
  type ReferenceCandidate,
  type ReferenceLocation,
} from "./reference";

export interface ReferenceValueRenameChange {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly editor: string;
  readonly path: string;
  readonly sourcePaths: readonly string[];
  readonly occurrencePath: string;
}

export interface ReferenceValueRenamePlan {
  readonly kind: string;
  readonly oldValue: string | number;
  readonly newValue: string | number;
  readonly target: ReferenceCandidate;
  readonly changes: readonly ReferenceValueRenameChange[];
}

export type ReferenceValueRenamePlanResult =
  | { readonly success: true; readonly plan: ReferenceValueRenamePlan }
  | {
      readonly success: false;
      readonly reason: "unresolvedTarget" | "missingTargetLocation" | "sameValue" | "valueTypeMismatch";
      readonly message: string;
    };

export function createReferenceValueRenamePlan(
  documents: readonly IndexedDocument[],
  selected: IndexedDocumentReference,
  newValue: string | number,
): ReferenceValueRenamePlanResult {
  if (selected.resolution.status !== "resolved" || selected.resolution.candidates.length !== 1) {
    return failure("unresolvedTarget", "Only a uniquely resolved reference target can be renamed.");
  }
  const target = selected.resolution.candidates[0]!;
  if (target.location === undefined) {
    return failure("missingTargetLocation", "The resolved reference target has no editable location.");
  }
  const oldValue = selected.occurrence.value;
  if (typeof oldValue !== typeof newValue) {
    return failure("valueTypeMismatch", "A reference value rename must preserve its string or number type.");
  }
  if (referenceValuesEqual(oldValue, newValue)) {
    return failure("sameValue", "The new reference value is identical to the current value.");
  }

  const targetKey = referenceLocationKey(target.location);
  const changes = documents.flatMap((document) => document.references.flatMap((reference) => (
    referenceValuesEqual(reference.occurrence.value, oldValue)
      && reference.resolution.status === "resolved"
      && reference.resolution.candidates.length === 1
      && reference.resolution.candidates[0]?.location !== undefined
      && referenceLocationKey(reference.resolution.candidates[0].location) === targetKey
      ? [{
          projectId: document.projectId,
          documentTypeId: document.documentTypeId,
          editor: document.editor,
          path: document.path,
          sourcePaths: document.sourcePaths,
          occurrencePath: reference.occurrence.path,
        }]
      : []
  ))).sort((left, right) => [
    documentIndexKey(left),
    left.occurrencePath,
  ].join("\u0000").localeCompare([
    documentIndexKey(right),
    right.occurrencePath,
  ].join("\u0000")));

  return {
    success: true,
    plan: {
      kind: selected.occurrence.definition.kind,
      oldValue,
      newValue,
      target,
      changes,
    },
  };
}

export function referenceLocationKey(location: ReferenceLocation): string {
  return [
    location.projectId,
    location.documentTypeId,
    location.path,
    location.documentId ?? "",
    location.componentId ?? "",
    location.elementKind ?? "",
    location.elementId ?? "",
    location.graphId ?? "",
    location.nodeId ?? "",
    location.portId ?? "",
    location.sheetId ?? "",
    location.rowId ?? "",
  ].join("\u0000");
}

function failure(
  reason: Exclude<ReferenceValueRenamePlanResult, { readonly success: true }>["reason"],
  message: string,
): ReferenceValueRenamePlanResult {
  return { success: false, reason, message };
}
