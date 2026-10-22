import {
  compareUtf16CodeUnits,
  documentIndexKey,
  referenceLocationKey,
  referenceValuesEqual,
  type IndexedDocument,
  type ReferenceCandidate,
  type ReferenceDefinition,
  type ReferenceLocation,
  type ReferenceResolution,
} from "@visualbridge/core";

export interface WorkspaceReferenceTargetRenameRequest {
  readonly projectId: string;
  readonly definition: ReferenceDefinition;
  readonly location: ReferenceLocation;
  readonly oldValue: string | number;
  readonly newValue: string | number;
  readonly confirm: boolean;
}

export type WorkspaceReferenceTargetRenameResult =
  | {
      readonly success: true;
      readonly fileCount: number;
      readonly referenceCount: number;
      readonly maintenance?: {
        readonly code: "refactor.committedRefreshFailed";
        readonly message: string;
        readonly failures: readonly {
          readonly phase: "tableEditor" | "documentIndex";
          readonly message: string;
        }[];
      };
    }
  | {
      readonly success: false;
      readonly code: string;
      readonly message: string;
    };

export interface RefactorBlocker {
  readonly code: string;
  readonly message: string;
  /** Lower values are reported first. Kept explicit so ordering is stable across runs. */
  readonly priority: number;
}

/** Stable ordering for concurrent workspace blockers (mirrors the historical check order). */
export const REFACTOR_BLOCKER_PRIORITY = {
  dirtyTextEditor: 10,
  dirtyTableEditor: 20,
  openTableEditor: 30,
  noDocuments: 40,
  crossProject: 50,
} as const;

export type TargetCandidateSelection =
  | { readonly ok: true; readonly candidate: ReferenceCandidate }
  | { readonly ok: false; readonly blocker: RefactorBlocker };

/**
 * Select the unique resolved candidate that still points at the requested location.
 * This is the pure part of `WorkspaceReferenceRefactor.renameTarget` target validation.
 */
export function selectTargetCandidate(
  location: ReferenceLocation,
  resolution: ReferenceResolution,
): TargetCandidateSelection {
  const locationKey = referenceLocationKey(location);
  const candidate = resolution.candidates.find((entry) => (
    entry.location !== undefined && referenceLocationKey(entry.location) === locationKey
  ));
  if (resolution.status !== "resolved" || resolution.candidates.length !== 1 || candidate?.location === undefined) {
    return {
      ok: false,
      blocker: {
        code: "refactor.targetChanged",
        message: "The edited stable identity no longer resolves uniquely to this target.",
        priority: 0,
      },
    };
  }
  return { ok: true, candidate };
}

export function isCrossProjectReferenceRefactor(
  projectId: string,
  targetProjectId: string | undefined,
): boolean {
  return targetProjectId !== undefined && targetProjectId !== projectId;
}

/** Returns a blocker when any affected document belongs to another Project. */
export function findCrossProjectBlocker(
  projectId: string,
  affectedProjectIds: readonly string[],
): RefactorBlocker | undefined {
  if (!affectedProjectIds.some((id) => id !== projectId)) return undefined;
  return {
    code: "refactor.crossProject",
    message: "Cross-project reference refactors are not supported.",
    priority: REFACTOR_BLOCKER_PRIORITY.crossProject,
  };
}

export interface WorkspaceBlockerInput {
  /** Relative paths of dirty text editors inside the target Project, in discovery order. */
  readonly dirtyTextEditorPaths: readonly string[];
  readonly dirtyTableEditor: boolean;
  /** URIs of Table editor sources currently open in the target Project. */
  readonly openTableSourceUris: readonly string[];
  /** Table source URIs the refactor is allowed to keep open (the edited Table target). */
  readonly allowedOpenTableSourceUris: ReadonlySet<string>;
  readonly affectedDocumentCount: number;
}

/**
 * Collect every blocker that prevents a Project refactor, ordered deterministically.
 * The first entry matches the blocker the historical short-circuit checks would return.
 */
export function collectWorkspaceBlockers(input: WorkspaceBlockerInput): readonly RefactorBlocker[] {
  const blockers: RefactorBlocker[] = input.dirtyTextEditorPaths.map((path) => ({
    code: "refactor.workspaceDirty",
    message: `Save or revert '${path}' before running a project refactor.`,
    priority: REFACTOR_BLOCKER_PRIORITY.dirtyTextEditor,
  }));
  if (input.dirtyTableEditor) {
    blockers.push({
      code: "refactor.workspaceDirty",
      message: "Save or revert every dirty Table editor in this VisualBridge Project before running a project refactor.",
      priority: REFACTOR_BLOCKER_PRIORITY.dirtyTableEditor,
    });
  }
  if (input.openTableSourceUris.some((uri) => !input.allowedOpenTableSourceUris.has(uri))) {
    blockers.push({
      code: "refactor.workspaceDirty",
      message: "Close all Table editors in this VisualBridge Project before running a project refactor.",
      priority: REFACTOR_BLOCKER_PRIORITY.openTableEditor,
    });
  }
  if (input.affectedDocumentCount === 0) {
    blockers.push({
      code: "refactor.workspaceDirty",
      message: "The refactor no longer has any indexed documents to update.",
      priority: REFACTOR_BLOCKER_PRIORITY.noDocuments,
    });
  }
  // Stable sort by priority only: equal-priority blockers keep discovery order,
  // matching the historical short-circuit checks (first dirty editor wins).
  return blockers.sort((left, right) => left.priority - right.priority);
}

export function firstWorkspaceBlocker(input: WorkspaceBlockerInput): RefactorBlocker | undefined {
  return collectWorkspaceBlockers(input)[0];
}

const SUPPORTED_RENAME_KINDS: ReadonlySet<string> = new Set([
  "document",
  "entity.component",
  "graph.element",
  "table.row",
]);

export function isSupportedRenameKind(kind: string): boolean {
  return SUPPORTED_RENAME_KINDS.has(kind);
}

export function unsupportedRenameKindMessage(kind: string): string {
  return `Reference Provider '${kind}' does not expose a rename adapter.`;
}

/** Only Table rows expose a stable-key editable target in the Table editor. */
export function isTableRowTargetKind(kind: string): boolean {
  return kind === "table.row";
}

export interface TableKeyRenameInput {
  readonly keyColumnId: string | undefined;
  /** Raw cell value; non string/number values fail the stale-key comparison, as before. */
  readonly currentValue: unknown;
  readonly oldValue: string | number;
  readonly newValue: string | number;
  readonly duplicateExists: boolean;
}

export type TableKeyRenameCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Pure validation of a Table stable-key rename against the parsed target row. */
export function checkTableKeyRename(input: TableKeyRenameInput): TableKeyRenameCheck {
  if (input.keyColumnId === undefined) {
    return {
      ok: false,
      code: "refactor.tableTargetUnavailable",
      message: "The target Table row or key column no longer exists.",
    };
  }
  if (!referenceValuesEqual(input.currentValue as string | number, input.oldValue)) {
    return {
      ok: false,
      code: "refactor.tableKeyChanged",
      message: "The target Table key changed after the refactor preview was created.",
    };
  }
  if (input.duplicateExists) {
    return {
      ok: false,
      code: "refactor.tableKeyDuplicate",
      message: `Table key '${String(input.newValue)}' already exists in a physical row.`,
    };
  }
  return { ok: true };
}
/** Failure returned when the refactor produces no physical source changes. */
export function noChangeRenameFailure(): Pick<RefactorBlocker, "code" | "message"> {
  return {
    code: "refactor.noChanges",
    message: "The rename did not produce any source changes.",
  };
}

export function hasSourceChanges(before: Uint8Array, after: Uint8Array): boolean {
  if (before.length !== after.length) return true;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) return true;
  }
  return false;
}

/** Deduplicate by document identity and sort deterministically. */
export function uniqueIndexedDocuments(
  documents: readonly IndexedDocument[],
): readonly IndexedDocument[] {
  return [...new Map(documents.map((document) => [documentIndexKey(document), document])).values()]
    .sort((left, right) => compareUtf16CodeUnits(documentIndexKey(left), documentIndexKey(right)));
}
