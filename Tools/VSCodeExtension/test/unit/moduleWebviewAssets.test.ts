import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanModuleWebviewDirectories,
  moduleHashHex,
  staleModuleHashDirectories,
  unpackModuleWebviews,
  type ModuleWebviewAssetSource,
} from "../../src/modules/webviewAssets";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function source(moduleId: string, hash: string, key: string): ModuleWebviewAssetSource {
  return {
    moduleId,
    hash,
    webviews: { [key]: { script: `console.log(${JSON.stringify(moduleId)});`, style: `.${key}{}` } },
  };
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "vb-webview-assets-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("unpacks each webview key into <sha256>/<key>.js and <key>.css", async () => {
  await withRoot(async (root) => {
    const unpacked = await unpackModuleWebviews(root, [source("visualbridge.graph", HASH_A, "graph")]);
    assert.equal(unpacked.length, 1);
    assert.equal(unpacked[0]!.hash, "a".repeat(64));
    assert.equal(unpacked[0]!.directory, path.join(root, "a".repeat(64)));
    const scriptPath = path.join(root, "a".repeat(64), "graph.js");
    const stylePath = path.join(root, "a".repeat(64), "graph.css");
    assert.deepEqual(unpacked[0]!.webviews, { graph: { script: scriptPath, style: stylePath } });
    assert.equal(await readFile(scriptPath, "utf8"), 'console.log("visualbridge.graph");');
    assert.equal(await readFile(stylePath, "utf8"), ".graph{}");
  });
});

test("re-unpacking identical bytes leaves the files untouched", async () => {
  await withRoot(async (root) => {
    await unpackModuleWebviews(root, [source("visualbridge.graph", HASH_A, "graph")]);
    const scriptPath = path.join(root, "a".repeat(64), "graph.js");
    const before = await stat(scriptPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await unpackModuleWebviews(root, [source("visualbridge.graph", HASH_A, "graph")]);
    const after = await stat(scriptPath);
    assert.equal(after.mtimeMs, before.mtimeMs, "unchanged content must not be rewritten");
  });
});

/**
 * P0 回归：hash 是**内容** hash，两个 Project 引用同一份 bundle 时共用一个目录。
 * 清理集必须是"磁盘上有 − 所有已装载 Project 的引用集"，不能按"当前 Project 之外全删"。
 */
test("keeps every hash directory referenced by any loaded project", async () => {
  await withRoot(async (root) => {
    // Project A 引用 A；Project B 引用 B；C 是上次会话留下的孤儿。
    await unpackModuleWebviews(root, [
      source("visualbridge.graph", HASH_A, "graph"),
      source("visualbridge.entity", HASH_B, "entity"),
      source("visualbridge.table", HASH_C, "table"),
    ]);
    const referenced = new Set([moduleHashHex(HASH_A), moduleHashHex(HASH_B)]);
    const removed = await cleanModuleWebviewDirectories(root, referenced);
    assert.deepEqual(removed, [path.join(root, "c".repeat(64))]);
    assert.deepEqual(
      (await readdir(root)).sort(),
      [".refs", "a".repeat(64), "b".repeat(64)],
      "both referenced directories must survive",
    );
    // 再跑一次（幂等）不会删掉仍在引用的目录。
    assert.deepEqual(await cleanModuleWebviewDirectories(root, referenced), []);
    assert.deepEqual((await readdir(root)).sort(), [".refs", "a".repeat(64), "b".repeat(64)]);
  });
});

test("a hash shared by two projects survives even after only one of them reloads", async () => {
  await withRoot(async (root) => {
    await unpackModuleWebviews(root, [source("visualbridge.graph", HASH_A, "graph")]);
    // 两个 Project 都引用 A：任一 Project 重新装载后，引用集仍含 A。
    const projectA = new Set([moduleHashHex(HASH_A)]);
    const projectB = new Set([moduleHashHex(HASH_A)]);
    const union = new Set([...projectA, ...projectB]);
    assert.deepEqual(await staleModuleHashDirectories(root, union), []);
    assert.equal((await readdir(root)).length, 1);
  });
});

test("leaves non-hash entries and missing roots alone", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "keep-me"), { recursive: true });
    await writeFile(path.join(root, "notes.txt"), "x");
    await unpackModuleWebviews(root, [source("visualbridge.graph", HASH_C, "graph")]);
    const removed = await cleanModuleWebviewDirectories(root, []);
    assert.deepEqual(removed, [path.join(root, "c".repeat(64))]);
    // `.refs` 是本窗口的引用登记（跨窗口清理用），同样不能被当成 hash 目录清掉。
    assert.deepEqual((await readdir(root)).sort(), [".refs", "keep-me", "notes.txt"]);

    const missing = path.join(root, "does-not-exist");
    assert.deepEqual(await staleModuleHashDirectories(missing, []), []);
    assert.deepEqual(await cleanModuleWebviewDirectories(missing, []), []);
  });
});

test("a hash directory referenced by another window survives the cleanup", async () => {
  await withRoot(async (root) => {
    await unpackModuleWebviews(root, [
      source("visualbridge.graph", HASH_A, "graph"),
      source("visualbridge.table", HASH_B, "table"),
    ]);
    // 另一个扩展宿主窗口（不同 pid）登记了自己正在用 HASH_B。
    const otherWindow = path.join(root, ".refs", "999999.json");
    await mkdir(path.dirname(otherWindow), { recursive: true });
    await writeFile(
      otherWindow,
      JSON.stringify({ pid: 999999, updatedAt: Date.now(), hashes: ["b".repeat(64)] }),
      "utf8",
    );

    const removed = await cleanModuleWebviewDirectories(root, []);
    assert.deepEqual(removed, [path.join(root, "a".repeat(64))], "只有本窗口与其它窗口都不引用的目录才可删");
    assert.deepEqual((await readdir(root)).sort(), [".refs", "b".repeat(64)]);

    // 僵尸窗口的引用文件过期后不再保护目录。
    await writeFile(
      otherWindow,
      JSON.stringify({ pid: 999999, updatedAt: Date.now() - 60 * 60 * 1000, hashes: ["b".repeat(64)] }),
      "utf8",
    );
    const expired = await cleanModuleWebviewDirectories(root, []);
    assert.deepEqual(expired, [path.join(root, "b".repeat(64))]);
    assert.deepEqual((await readdir(path.join(root, ".refs"))).sort(), [`${process.pid}.json`]);
  });
});

test("rejects bundle hashes that are not sha256:<64 lowercase hex>", async () => {
  assert.equal(moduleHashHex(HASH_A), "a".repeat(64));
  for (const bad of ["a".repeat(64), `sha256:${"A".repeat(64)}`, "sha256:short", "", "sha512:" + "a".repeat(64)]) {
    assert.throws(() => moduleHashHex(bad), /not 'sha256:<64 lowercase hex>'/u, bad);
  }
  await withRoot(async (root) => {
    await assert.rejects(
      () => unpackModuleWebviews(root, [{ moduleId: "m", hash: "nope", webviews: {} }]),
      /not 'sha256:<64 lowercase hex>'/u,
    );
  });
});
