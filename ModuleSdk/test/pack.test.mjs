import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { compareBytes, packPackage, sha256 } from "../scripts/pack-lib.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packs deterministic gzip bytes with a stable, sorted file list", async () => {
  const first = await packPackage();
  const second = await packPackage();
  assert.equal(sha256(first.bytes), sha256(second.bytes));
  assert.equal(first.bytes.equals(second.bytes), true);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(first.files, [...first.files].sort());
  for (const expected of [
    "package.json",
    "README.md",
    "src/index.ts",
    "dist/index.js",
    "dist/core/index.d.ts",
    "dist/core/index.js",
    "tsconfig/module.json",
  ]) {
    assert.equal(first.files.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(first.bytes[0], 0x1f);
  assert.equal(first.bytes[1], 0x8b);

  const tarBytes = gunzipSync(first.bytes);
  assert.equal(tarBytes.includes(Buffer.from("package/package.json")), true);
  assert.equal(tarBytes.includes(Buffer.from("package/dist/core/index.d.ts")), true);
  assert.equal(tarBytes.includes(Buffer.from("package/dist/core/index.js")), true);
});

// 模块运行时面必须随包分发：`Modules/` 是独立工程，解析不到 `@visualbridge/core`，
// 所以 dist/index.js 只能经包内相对路径拿 Core 的纯函数实现。
test("ships the Core runtime surface without workspace references", async () => {
  const packed = await packPackage();
  assert.equal(
    packed.files.some((file) => file.startsWith("dist/") && file.endsWith(".js.map")),
    false,
    "发布包不得带 source map",
  );
  const emitted = packed.files.filter((file) => file.startsWith("dist/") && /\.(?:d\.ts|js)$/u.test(file));
  assert.ok(emitted.length > 0);
  for (const file of emitted) {
    const text = await readFile(path.join(sdkRoot, ...file.split("/")), "utf8");
    assert.equal(/["']@visualbridge\//u.test(text), false, `${file} still references a workspace package`);
  }
  const index = await readFile(path.join(sdkRoot, "dist", "index.js"), "utf8");
  assert.match(index, /require\("\.\/core\/index"\)/u);
  for (const runtimeExport of [
    "canonicalJsonStringify",
    "cloneJsonValue",
    "compareUtf16CodeUnits",
    "createDefaultProperties",
    "createUnknownCatalogSource",
    "findMatchingDocumentTypes",
    "parseCatalogSourceDefinition",
    "parseFieldDefinitions",
    "parseProjectFile",
    "ReferenceService",
    "referenceValuesEqual",
    "validateFieldValue",
  ]) {
    assert.equal(index.includes(runtimeExport), true, `dist/index.js does not re-export '${runtimeExport}'`);
  }
  assert.match(await readFile(path.join(sdkRoot, "dist", "index.d.ts"), "utf8"), /compareUtf16CodeUnits/u);
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
