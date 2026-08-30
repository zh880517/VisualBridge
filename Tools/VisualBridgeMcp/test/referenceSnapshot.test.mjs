import assert from "node:assert/strict";
import test from "node:test";
import { referenceSemanticSnapshotDependencyKey } from "../dist/referenceSnapshot.js";

test("Reference snapshot keys bind exact captured semantics even when physical hashes return to an earlier value", () => {
  const sourceDependencyKey = "a".repeat(64);
  const first = referenceSemanticSnapshotDependencyKey(sourceDependencyKey, {
    project: { projectId: "sample" },
    tables: [{ rows: [{ cells: { id: 1, name: "Alpha" } }] }],
  });
  const changedDuringCapture = referenceSemanticSnapshotDependencyKey(sourceDependencyKey, {
    tables: [{ rows: [{ cells: { name: "Beta", id: 1 } }] }],
    project: { projectId: "sample" },
  });
  const reorderedOnly = referenceSemanticSnapshotDependencyKey(sourceDependencyKey, {
    tables: [{ rows: [{ cells: { name: "Alpha", id: 1 } }] }],
    project: { projectId: "sample" },
  });

  assert.notEqual(changedDuringCapture, first);
  assert.equal(reorderedOnly, first);
  assert.match(first, /^[a-f0-9]{64}$/u);
});

test("Reference snapshot keys preserve strict number and string value types", () => {
  const sourceDependencyKey = "b".repeat(64);
  const numeric = referenceSemanticSnapshotDependencyKey(sourceDependencyKey, {
    project: {},
    documents: [{ value: 1 }],
  });
  const textual = referenceSemanticSnapshotDependencyKey(sourceDependencyKey, {
    project: {},
    documents: [{ value: "1" }],
  });

  assert.notEqual(numeric, textual);
});
