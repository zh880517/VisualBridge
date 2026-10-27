import assert from "node:assert/strict";
import test from "node:test";
import type {
  IndexedDocument,
  ReferenceCandidate,
  ReferenceLocation,
  ReferenceResolution,
} from "@visualbridge/core";
import {
  REFACTOR_BLOCKER_PRIORITY,
  collectWorkspaceBlockers,
  findCrossProjectBlocker,
  firstWorkspaceBlocker,
  hasSourceChanges,
  isCrossProjectReferenceRefactor,
  noChangeRenameFailure,
  selectTargetCandidate,
  uniqueIndexedDocuments,
} from "../../src/refactor/workspaceReferenceRefactorPlan";

const TARGET_LOCATION: ReferenceLocation = {
  projectId: "alpha",
  documentTypeId: "logicGraph",
  path: "graphs/main.graph",
  documentId: "main",
  elementKind: "graph",
  elementId: "main",
};

function candidate(
  location: ReferenceLocation | undefined,
  value: string | number = "main",
): ReferenceCandidate {
  return {
    kind: "document",
    target: {},
    value,
    title: "Main",
    ...(location === undefined ? {} : { location }),
  };
}

function resolution(
  status: ReferenceResolution["status"],
  candidates: readonly ReferenceCandidate[],
): ReferenceResolution {
  return { status, candidates };
}

function indexed(
  projectId: string,
  path: string,
  overrides: Partial<IndexedDocument> = {},
): IndexedDocument {
  return {
    projectId,
    documentTypeId: "logicGraph",
    editor: "graph",
    path,
    sourcePaths: [path],
    title: path,
    diagnostics: [],
    references: [],
    ...overrides,
  };
}

test("cross-project reference refactors are refused with an explicit blocker", () => {
  assert.equal(isCrossProjectReferenceRefactor("alpha", "beta"), true);
  assert.equal(isCrossProjectReferenceRefactor("alpha", "alpha"), false);
  assert.equal(isCrossProjectReferenceRefactor("alpha", undefined), false);

  assert.deepEqual(findCrossProjectBlocker("alpha", ["alpha", "beta"]), {
    code: "refactor.crossProject",
    message: "Cross-project reference refactors are not supported.",
    priority: REFACTOR_BLOCKER_PRIORITY.crossProject,
  });
  assert.equal(findCrossProjectBlocker("alpha", ["alpha", "alpha"]), undefined);
  assert.equal(findCrossProjectBlocker("alpha", []), undefined);
});

test("a dirty target editor blocks the refactor with the editor path", () => {
  const blocker = firstWorkspaceBlocker({
    dirtyTextEditorPaths: ["entities/hero.entity"],
    dirtyTableEditor: false,
    openTableSourceUris: [],
    allowedOpenTableSourceUris: new Set<string>(),
    affectedDocumentCount: 2,
  });
  assert.deepEqual(blocker, {
    code: "refactor.workspaceDirty",
    message: "Save or revert 'entities/hero.entity' before running a project refactor.",
    priority: REFACTOR_BLOCKER_PRIORITY.dirtyTextEditor,
  });
});

test("workspace blocker collection is complete and keeps discovery order", () => {
  const input = {
    dirtyTextEditorPaths: ["graphs/z.graph", "graphs/a.graph"],
    dirtyTableEditor: true,
    openTableSourceUris: ["file:///project/tables/hero.csv"],
    allowedOpenTableSourceUris: new Set<string>(),
    affectedDocumentCount: 0,
  } as const;

  const blockers = collectWorkspaceBlockers(input);
  assert.deepEqual(blockers.map((blocker) => blocker.code), [
    "refactor.workspaceDirty",
    "refactor.workspaceDirty",
    "refactor.workspaceDirty",
    "refactor.workspaceDirty",
    "refactor.workspaceDirty",
  ]);
  assert.deepEqual(blockers.map((blocker) => blocker.priority), [10, 10, 20, 30, 40]);
  assert.deepEqual(blockers.map((blocker) => blocker.message), [
    "Save or revert 'graphs/z.graph' before running a project refactor.",
    "Save or revert 'graphs/a.graph' before running a project refactor.",
    "Save or revert every dirty Table editor in this VisualBridge Project before running a project refactor.",
    "Close all Table editors in this VisualBridge Project before running a project refactor.",
    "The refactor no longer has any indexed documents to update.",
  ]);
  assert.deepEqual(collectWorkspaceBlockers(input), blockers);
  assert.deepEqual(firstWorkspaceBlocker(input), blockers[0]);
});

test("an allowed open Table target does not count as a workspace blocker", () => {
  const blocker = firstWorkspaceBlocker({
    dirtyTextEditorPaths: [],
    dirtyTableEditor: false,
    openTableSourceUris: ["file:///project/tables/hero.csv"],
    allowedOpenTableSourceUris: new Set(["file:///project/tables/hero.csv"]),
    affectedDocumentCount: 1,
  });
  assert.equal(blocker, undefined);
});

test("target resolution accepts exactly one candidate at the requested location", () => {
  const target = candidate(TARGET_LOCATION);
  const selected = selectTargetCandidate(
    TARGET_LOCATION,
    resolution("resolved", [target]),
  );
  assert.deepEqual(selected, { ok: true, candidate: target });

  const missing = selectTargetCandidate(
    TARGET_LOCATION,
    resolution("missing", []),
  );
  assert.deepEqual(missing, {
    ok: false,
    blocker: {
      code: "refactor.targetChanged",
      message: "The edited stable identity no longer resolves uniquely to this target.",
      priority: 0,
    },
  });

  const duplicate = selectTargetCandidate(
    TARGET_LOCATION,
    resolution("ambiguous", [target, candidate(TARGET_LOCATION, "other")]),
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.ok ? undefined : duplicate.blocker.code, "refactor.targetChanged");

  const otherLocation = selectTargetCandidate(
    TARGET_LOCATION,
    resolution("resolved", [candidate({ ...TARGET_LOCATION, path: "graphs/other.graph" })]),
  );
  assert.equal(otherLocation.ok, false);
  assert.equal(
    otherLocation.ok ? undefined : otherLocation.blocker.message,
    "The edited stable identity no longer resolves uniquely to this target.",
  );
});

test("a no-op refactor fails with refactor.noChanges and produces no writes", () => {
  assert.deepEqual(noChangeRenameFailure(), {
    code: "refactor.noChanges",
    message: "The rename did not produce any source changes.",
  });
  assert.equal(hasSourceChanges(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), false);
  assert.equal(hasSourceChanges(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), true);
  assert.equal(hasSourceChanges(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), true);
});

test("affected documents are deduplicated and sorted by document identity", () => {
  const documents = uniqueIndexedDocuments([
    indexed("alpha", "graphs/z.graph"),
    indexed("alpha", "graphs/a.graph"),
    indexed("alpha", "graphs/z.graph", { title: "duplicate wins" }),
  ]);
  assert.deepEqual(documents.map((document) => document.path), ["graphs/a.graph", "graphs/z.graph"]);
  assert.equal(documents[1]?.title, "duplicate wins");
});
