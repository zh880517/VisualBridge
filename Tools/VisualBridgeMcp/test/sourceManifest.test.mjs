import assert from "node:assert/strict";
import test from "node:test";
import { hashSourceManifest } from "../dist/sourceManifest.js";

test("source manifest hashes use UTF-16 ordinal order independent of caller order", () => {
  const sources = [
    { path: "Table/é.csv", hash: "1".repeat(64) },
    { path: "Table/e\u0301.csv", hash: "2".repeat(64) },
    { path: "Table/😀.csv", hash: "3".repeat(64) },
    { path: "Table/\uE000.csv", hash: "4".repeat(64) },
  ];

  const forward = hashSourceManifest(sources);
  assert.equal(hashSourceManifest([...sources].reverse()), forward);
  assert.equal(hashSourceManifest([sources[2], sources[0], sources[3], sources[1]]), forward);
  assert.match(forward, /^[0-9a-f]{64}$/u);
});

test("single-source manifests preserve the physical source hash", () => {
  const physicalHash = "a".repeat(64);
  assert.equal(hashSourceManifest([{ path: "Table/😀.xlsx", hash: physicalHash }]), physicalHash);
});
