import assert from "node:assert/strict";
import test from "node:test";
import {
  IncrementalSemanticSnapshotStore,
  type SemanticSnapshotSource,
} from "../index";

test("incremental semantic snapshots reuse only unchanged dependency keys", async () => {
  const calls = new Map<string, number>();
  const store = new IncrementalSemanticSnapshotStore<string>();
  const source = (key: string, dependencyKey: string): SemanticSnapshotSource<string> => ({
    key,
    dependencyKey,
    async load() {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return `${key}:${dependencyKey}`;
    },
  });

  const first = await store.rebuild([source("b", "1"), source("a", "1")]);
  assert.equal(first.status, "applied");
  assert.deepEqual(store.snapshot.values, ["a:1", "b:1"]);
  const second = await store.rebuild([source("a", "1"), source("b", "2")]);
  assert.equal(second.status, "applied");
  assert.deepEqual(store.snapshot.values, ["a:1", "b:2"]);
  assert.deepEqual(Object.fromEntries(calls), { a: 1, b: 2 });
  if (second.status === "applied") {
    assert.deepEqual({ loaded: second.snapshot.loaded, reused: second.snapshot.reused }, { loaded: 1, reused: 1 });
  }
});

test("a newer semantic build aborts and supersedes a stale result", async () => {
  const store = new IncrementalSemanticSnapshotStore<string>();
  let release: (() => void) | undefined;
  const slow: SemanticSnapshotSource<string> = {
    key: "a",
    dependencyKey: "slow",
    load: (signal) => new Promise<string>((resolve, reject) => {
      release = () => resolve("stale");
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }),
  };
  const stalePromise = store.rebuild([slow]);
  await new Promise((resolve) => setImmediate(resolve));
  const current = await store.rebuild([{
    key: "a",
    dependencyKey: "current",
    async load() { return "current"; },
  }]);
  release?.();
  const stale = await stalePromise;
  assert.equal(stale.status, "superseded");
  assert.equal(current.status, "applied");
  assert.deepEqual(store.snapshot.values, ["current"]);
});

test("cancelled semantic builds do not replace the last complete snapshot", async () => {
  const store = new IncrementalSemanticSnapshotStore<string>();
  await store.rebuild([{ key: "a", dependencyKey: "1", async load() { return "stable"; } }]);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await store.rebuild(
    [{ key: "a", dependencyKey: "2", async load() { return "new"; } }],
    { signal: controller.signal },
  );
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(store.snapshot.values, ["stable"]);
});

test("duplicate semantic source identities are rejected deterministically", async () => {
  const store = new IncrementalSemanticSnapshotStore<string>();
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() { added += 1; },
    removeEventListener() { removed += 1; },
  } as unknown as AbortSignal;
  await assert.rejects(() => store.rebuild([
    { key: "same", dependencyKey: "1", async load() { return "a"; } },
    { key: "same", dependencyKey: "2", async load() { return "b"; } },
  ], { signal }), /duplicated/);
  assert.equal(added, 1);
  assert.equal(removed, 1);

  const recovered = await store.rebuild([
    { key: "next", dependencyKey: "1", async load() { return "recovered"; } },
  ]);
  assert.equal(recovered.status, "applied");
  assert.deepEqual(store.snapshot.values, ["recovered"]);
});

test("synchronous source failures clean up cancellation listeners and preserve the snapshot", async () => {
  const store = new IncrementalSemanticSnapshotStore<string>();
  await store.rebuild([{ key: "stable", dependencyKey: "1", async load() { return "stable"; } }]);
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() { added += 1; },
    removeEventListener() { removed += 1; },
  } as unknown as AbortSignal;

  await assert.rejects(() => store.rebuild([{
    key: "broken",
    dependencyKey: "1",
    load() { throw new Error("synchronous failure"); },
  }], { signal }), /synchronous failure/);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.deepEqual(store.snapshot.values, ["stable"]);
});
