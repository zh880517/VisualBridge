import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { compareBytes, packPackage, sha256 } from "../scripts/pack-lib.mjs";

test("packs deterministic gzip bytes with a stable, sorted file list", async () => {
  const first = await packPackage();
  const second = await packPackage();
  assert.equal(sha256(first.bytes), sha256(second.bytes));
  assert.equal(first.bytes.equals(second.bytes), true);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(first.files, [...first.files].sort());
  for (const expected of ["package.json", "README.md", "src/index.ts", "dist/index.js", "tsconfig/module.json"]) {
    assert.equal(first.files.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(first.bytes[0], 0x1f);
  assert.equal(first.bytes[1], 0x8b);

  const tarBytes = gunzipSync(first.bytes);
  assert.equal(tarBytes.includes(Buffer.from("package/package.json")), true);
  assert.equal(tarBytes.includes(Buffer.from("package/dist/core/index.d.ts")), true);
});

test("detects a single-byte baseline drift", async () => {
  const packed = await packPackage();
  const mutated = Buffer.from(packed.bytes);
  mutated[Math.floor(mutated.length / 2)] ^= 0x01;
  assert.equal(mutated.byteLength, packed.bytes.byteLength);
  assert.equal(compareBytes(packed.bytes, packed.bytes).matches, true);
  assert.equal(compareBytes(packed.bytes, mutated).matches, false);
  assert.notEqual(compareBytes(packed.bytes, mutated).actualHash, compareBytes(packed.bytes, mutated).baselineHash);
});
