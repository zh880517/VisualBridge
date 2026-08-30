import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonStringify } from "../index";

test("canonical JSON recursively orders object keys by UTF-16 code units", () => {
  const unicodeEntries = [
    ["\uE000", "private-use"],
    ["\uDE00", "low-surrogate"],
    ["😀", "surrogate-pair"],
    ["\uD83D", "high-surrogate"],
    ["é", "composed"],
    ["e\u0301", "decomposed"],
  ] as const;
  const left = {
    unicode: Object.fromEntries(unicodeEntries),
    nested: { z: 2, a: { y: 4, b: 3 } },
  };
  const right = {
    nested: { a: { b: 3, y: 4 }, z: 2 },
    unicode: Object.fromEntries([...unicodeEntries].reverse()),
  };

  const serialized = canonicalJsonStringify(left);
  assert.equal(canonicalJsonStringify(right), serialized);
  assert.deepEqual(Object.keys((JSON.parse(serialized) as { unicode: object }).unicode), [
    "e\u0301",
    "é",
    "\uD83D",
    "😀",
    "\uDE00",
    "\uE000",
  ]);
});

test("canonical JSON preserves JSON primitive encoding and omits undefined object properties", () => {
  assert.equal(
    canonicalJsonStringify({ text: "line\n\uD83D", omitted: undefined, negativeZero: -0, array: [true, null] }),
    "{\"array\":[true,null],\"negativeZero\":0,\"text\":\"line\\n\\ud83d\"}",
  );
});

test("canonical JSON rejects values outside the JSON data model", () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol("value"), () => undefined]) {
    assert.throws(() => canonicalJsonStringify(value), TypeError);
  }
  assert.throws(() => canonicalJsonStringify([undefined]), TypeError);
  assert.throws(() => canonicalJsonStringify(new Array(1)), TypeError);
  assert.throws(() => canonicalJsonStringify(new Date(0)), TypeError);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJsonStringify(cyclic), /cycle/);
});
