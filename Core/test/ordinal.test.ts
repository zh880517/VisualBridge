import assert from "node:assert/strict";
import test from "node:test";
import { compareUtf16CodeUnits } from "../index";

test("UTF-16 ordinal comparison is explicit for normalized forms and surrogate sequences", () => {
  const expected = [
    "a",
    "e\u0301",
    "é",
    "\uD83D",
    "😀",
    "\uDE00",
    "\uE000",
  ];

  assert.deepEqual([...expected].reverse().sort(compareUtf16CodeUnits), expected);
  assert.equal(compareUtf16CodeUnits("e\u0301", "é"), -1);
  assert.equal(compareUtf16CodeUnits("\uD83D", "😀"), -1);
  assert.equal(compareUtf16CodeUnits("😀", "\uDE00"), -1);
  assert.equal(compareUtf16CodeUnits("é", "é"), 0);
});
