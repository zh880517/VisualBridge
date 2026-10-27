import assert from "node:assert/strict";
import test from "node:test";
import { selectCurrentOverrides } from "../../src/reference/openDocumentOverrides";

function entry(
  documentTypeId: string,
  sourcePaths: readonly string[],
  sequence: number,
): { readonly documentTypeId: string; readonly sourcePaths: ReadonlySet<string>; readonly sequence: number; readonly data: string } {
  return { documentTypeId, sourcePaths: new Set(sourcePaths), sequence, data: `${documentTypeId}#${sequence}` };
}

test("selectCurrentOverrides keeps only the newest override for one physical source", () => {
  const selected = selectCurrentOverrides([
    entry("game.table.skills", ["Tables/Skills_A.csv"], 1),
    entry("game.table.skills", ["Tables/Skills_A.csv"], 2),
  ]);
  assert.deepEqual(selected.map((candidate) => candidate.sequence), [2]);
});

test("selectCurrentOverrides folds members of the same multi-source document", () => {
  // 同一 Table 家族的 A/B 两个成员各登记过一份覆盖：交集在 A 上，取最新一份即可。
  const selected = selectCurrentOverrides([
    entry("game.table.skills", ["Tables/Skills_A.csv"], 1),
    entry("game.table.skills", ["Tables/Skills_A.csv", "Tables/Skills_B.csv"], 3),
    entry("game.table.skills", ["Tables/Skills_B.csv"], 2),
  ]);
  assert.deepEqual(selected.map((candidate) => candidate.sequence), [3]);
});

test("selectCurrentOverrides keeps disjoint documents and document types apart", () => {
  const selected = selectCurrentOverrides([
    entry("game.table.skills", ["Tables/Skills_A.csv"], 1),
    entry("game.table.skills", ["Tables/Skills_C.csv"], 2),
    entry("game.table.items", ["Tables/Skills_A.csv"], 3),
  ]);
  assert.deepEqual(selected.map((candidate) => candidate.data), [
    "game.table.items#3",
    "game.table.skills#2",
    "game.table.skills#1",
  ]);
});
