import assert from "node:assert/strict";
import test from "node:test";
import {
  isProviderValidationResultCacheable,
  ProviderValidationCache,
  providerValidationCacheKey,
} from "../../src/provider/providerValidationCache";

const snapshot = {
  documentTypeId: "sample.entity",
  path: "Config/Player.herojson",
  sourceHash: "1".repeat(64),
  content: { formatVersion: 1 },
} as const;

test("provider validation cache keys include project dependency and source hashes", () => {
  const first = providerValidationCacheKey("project-a", "host-1", "dependency-1", snapshot);
  assert.equal(first, providerValidationCacheKey("project-a", "host-1", "dependency-1", { ...snapshot, content: { changed: true } }));
  assert.notEqual(first, providerValidationCacheKey("project-a", "host-2", "dependency-1", snapshot));
  assert.notEqual(first, providerValidationCacheKey("project-a", "host-1", "dependency-2", snapshot));
  assert.notEqual(first, providerValidationCacheKey("project-a", "host-1", "dependency-1", { ...snapshot, sourceHash: "2".repeat(64) }));
});

test("provider validation cache invalidates one project and freezes results", () => {
  const cache = new ProviderValidationCache();
  const firstKey = providerValidationCacheKey("project-a", "host-1", "dependency-1", snapshot);
  const secondKey = providerValidationCacheKey("project-b", "host-1", "dependency-1", snapshot);
  const stored = cache.set(firstKey, [{ severity: "warning", code: "sample", path: "$", message: "warning" }]);
  cache.set(secondKey, []);
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored[0]));
  cache.invalidateProject("project-a");
  assert.equal(cache.get(firstKey), undefined);
  assert.deepEqual(cache.get(secondKey), []);
});

test("provider validation service cache hits invoke one successful RPC", async () => {
  const cache = new ProviderValidationCache();
  const key = providerValidationCacheKey("project-a", "host-1", "dependency-1", snapshot);
  let rpcCount = 0;
  const validate = async () => {
    rpcCount += 1;
    return {
      diagnostics: [{ severity: "warning", code: "sample", path: "$", message: "warning" }] as const,
      cacheable: true,
    };
  };
  const first = await cache.getOrValidate("project-a", key, undefined, validate);
  const second = await cache.getOrValidate("project-a", key, undefined, validate);
  assert.equal(rpcCount, 1);
  assert.equal(second, first);
});

test("a first RPC stores under its post-start Host generation", async () => {
  const cache = new ProviderValidationCache();
  const stoppedKey = providerValidationCacheKey("project-a", "host-1:stopped:0", "dependency-1", snapshot);
  const readyKey = providerValidationCacheKey("project-a", "host-1:ready:1", "dependency-1", snapshot);
  let rpcCount = 0;
  await cache.getOrValidate("project-a", stoppedKey, undefined, async () => {
    rpcCount += 1;
    return { diagnostics: [], cacheable: true, cacheKey: readyKey };
  });
  await cache.getOrValidate("project-a", readyKey, undefined, async () => {
    rpcCount += 1;
    return { diagnostics: [], cacheable: true };
  });
  assert.equal(rpcCount, 1);
  assert.equal(cache.get(stoppedKey), undefined);
  assert.deepEqual(cache.get(readyKey), []);
});

test("source, dependency and Provider host generation changes miss the service cache", async () => {
  const cache = new ProviderValidationCache();
  let rpcCount = 0;
  const validate = async () => ({ diagnostics: [], cacheable: true });
  const keys = [
    providerValidationCacheKey("project-a", "host-1", "dependency-1", snapshot),
    providerValidationCacheKey("project-a", "host-1", "dependency-1", { ...snapshot, sourceHash: "2".repeat(64) }),
    providerValidationCacheKey("project-a", "host-1", "dependency-2", snapshot),
    providerValidationCacheKey("project-a", "host-2", "dependency-1", snapshot),
  ];
  for (const key of keys) {
    await cache.getOrValidate("project-a", key, undefined, async (signal) => {
      assert.equal(signal, undefined);
      rpcCount += 1;
      return validate();
    });
  }
  await cache.getOrValidate("project-a", keys.at(-1)!, undefined, async () => {
    rpcCount += 1;
    return validate();
  });
  assert.equal(rpcCount, keys.length);
});

test("AbortSignal reaches validation and cancellation never enters the cache", async () => {
  const cache = new ProviderValidationCache();
  const key = providerValidationCacheKey("project-a", "host-1", "dependency-1", snapshot);
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const validation = cache.getOrValidate("project-a", key, controller.signal, async (signal) => {
    receivedSignal = signal;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => {
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true }));
  });
  controller.abort();
  await assert.rejects(validation, (error) => error instanceof Error && error.name === "AbortError");
  assert.equal(receivedSignal, controller.signal);
  assert.equal(cache.get(key), undefined);
});

test("unavailable and externalModification outcomes never enter the cache", async () => {
  assert.equal(isProviderValidationResultCacheable({ unavailableProviderIds: ["sample.provider"] }), false);
  assert.equal(isProviderValidationResultCacheable({ unavailableProviderIds: [], externalModification: {} }), false);
  assert.equal(isProviderValidationResultCacheable({ unavailableProviderIds: [] }), true);
  for (const outcome of ["unavailable", "externalModification"] as const) {
    const cache = new ProviderValidationCache();
    const key = providerValidationCacheKey("project-a", "host-1", "dependency-1", snapshot);
    let rpcCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const diagnostics = await cache.getOrValidate("project-a", key, undefined, async () => {
        rpcCount += 1;
        return {
          diagnostics: [{ severity: "error", code: `provider.${outcome}`, path: "$", message: outcome }],
          cacheable: false,
        };
      });
      assert.equal(diagnostics[0]?.code, `provider.${outcome}`);
    }
    assert.equal(rpcCount, 2);
    assert.equal(cache.get(key), undefined);
  }
});

test("an in-flight result cannot refill the cache after invalidation", async () => {
  const cache = new ProviderValidationCache();
  const key = providerValidationCacheKey("project-a", "host-1", "dependency-1", snapshot);
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let rpcCount = 0;
  const stale = cache.getOrValidate("project-a", key, undefined, async () => {
    rpcCount += 1;
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    return { diagnostics: [{ severity: "warning", code: "stale", path: "$", message: "stale" }], cacheable: true };
  });
  await didStart;
  cache.invalidateProject("project-a");
  release();
  assert.equal((await stale)[0]?.code, "stale");
  assert.equal(cache.get(key), undefined);

  const current = await cache.getOrValidate("project-a", key, undefined, async () => {
    rpcCount += 1;
    return { diagnostics: [{ severity: "warning", code: "current", path: "$", message: "current" }], cacheable: true };
  });
  assert.equal(current[0]?.code, "current");
  assert.equal(cache.get(key)?.[0]?.code, "current");
  assert.equal(rpcCount, 2);
});
