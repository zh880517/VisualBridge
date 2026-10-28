import assert from "node:assert/strict";
import test from "node:test";
import { DebugRouter, GenericDebugConsumer, type DebugConsumer } from "../../src/bridge/debugRouter";
import type { DebugRecord } from "../../src/bridge/debugStore";

function record(instanceId: string, category: string, method: string, tag = 1, value: unknown = 1): DebugRecord {
  return {
    kind: "event",
    id: 1,
    category,
    interfaceId: "IGraphDebuger",
    instanceId,
    method,
    args: new Map([[tag, { tag, type: "int", value }]]),
    named: new Map(),
    frame: -1,
    wireBytes: 10,
    receivedAt: 0,
    arrivalSeq: 1,
    contractState: "matched",
  };
}

/** 记录调用顺序的假消费者。 */
class SpyConsumer implements DebugConsumer {
  public readonly categories: readonly string[];
  public readonly seen: string[] = [];
  public throwOnConsume = false;
  public acceptsResult = true;
  public throwOnAccepts = false;
  public resets = 0;

  public constructor(categories: readonly string[]) {
    this.categories = categories;
  }

  public accepts(): boolean {
    if (this.throwOnAccepts) {
      throw new Error("accepts boom");
    }

    return this.acceptsResult;
  }

  public consume(entry: DebugRecord): void {
    if (this.throwOnConsume) {
      throw new Error("consume boom");
    }

    this.seen.push(`${entry.category}:${entry.method}`);
  }

  public reset(): void {
    this.resets += 1;
    this.seen.length = 0;
  }
}

test("every record reaches the generic observer and exactly one main consumer", () => {
  const router = new DebugRouter();
  const graph = new SpyConsumer(["graph"]);
  router.register(graph, "graph");

  router.dispatch(record("hero", "graph", "NodeStarted"));

  assert.deepEqual(graph.seen, ["graph:NodeStarted"], "the claiming consumer is the single main consumer");
  assert.deepEqual(router.observer.records.map((entry) => entry.method), ["NodeStarted"]);
  assert.equal(router.observer.total, 1);
  assert.deepEqual(router.stats, {
    records: 1,
    mainDeliveries: 1,
    observerDeliveries: 1,
    errors: 0,
    fallbackCategories: [],
  });
});

test("with no claim the generic consumer doubles as the main consumer and is delivered once", () => {
  const router = new DebugRouter();
  router.dispatch(record("hero", "graph", "NodeStarted"));

  assert.equal(router.observer.total, 1, "a single delivery, not two");
  assert.equal(router.stats.mainDeliveries, 1);
  assert.equal(router.stats.observerDeliveries, 1);
});

test("two consumers claiming one category keep the first and the second stays unclaimed", () => {
  const router = new DebugRouter();
  const first = new SpyConsumer(["graph"]);
  const second = new SpyConsumer(["graph"]);
  router.register(first, "first");
  router.register(second, "second");

  assert.equal(router.ownerFor("graph"), first);
  router.dispatch(record("hero", "graph", "NodeStarted"));
  assert.deepEqual(first.seen, ["graph:NodeStarted"]);
  assert.deepEqual(second.seen, []);
  assert.equal(router.observer.total, 1, "the observer still receives the record");
});

test("a throwing consumer is isolated, its category falls back, and other categories keep flowing", () => {
  const router = new DebugRouter();
  const broken = new SpyConsumer(["graph"]);
  broken.throwOnConsume = true;
  const healthy = new SpyConsumer(["entity"]);
  router.register(broken, "broken");
  router.register(healthy, "healthy");

  assert.doesNotThrow(() => router.dispatch(record("hero", "graph", "NodeStarted")));
  assert.equal(router.observer.total, 1, "the observer still received the record");
  assert.deepEqual(router.stats.fallbackCategories, ["graph"]);
  assert.equal(router.stats.errors, 1);

  // 同一分类的后续记录不再喂给抛错的 facet（回退通用视图），也不会再次抛错。
  assert.doesNotThrow(() => router.dispatch(record("hero", "graph", "Ticked")));
  assert.equal(router.observer.total, 2);
  assert.equal(router.stats.errors, 1, "the failed category is not retried");
  assert.equal(router.stats.mainDeliveries, 2);

  // 其他分类不受影响。
  router.dispatch(record("npc", "entity", "Spawned"));
  assert.deepEqual(healthy.seen, ["entity:Spawned"]);
  assert.equal(router.observer.total, 3);
});

test("the observer keeps working when the main consumer throws", () => {
  const router = new DebugRouter();
  const broken = new SpyConsumer(["graph"]);
  broken.throwOnConsume = true;
  router.register(broken, "broken");

  router.dispatch(record("hero", "graph", "NodeStarted"));
  assert.equal(router.observer.records.length, 1);
  assert.equal(router.observer.lastRecord?.method, "NodeStarted");
});

test("accepts() can veto the claim: the generic consumer takes over that record", () => {
  const router = new DebugRouter();
  const selective = new SpyConsumer(["graph"]);
  selective.acceptsResult = false;
  router.register(selective, "selective");

  router.dispatch(record("hero", "graph", "NodeStarted"));
  assert.deepEqual(selective.seen, []);
  assert.equal(router.observer.total, 1);
  assert.equal(router.stats.mainDeliveries, 1);
});

test("a throwing accepts() falls back instead of failing the dispatch", () => {
  const router = new DebugRouter();
  const broken = new SpyConsumer(["graph"]);
  broken.throwOnAccepts = true;
  router.register(broken, "broken");

  assert.doesNotThrow(() => router.dispatch(record("hero", "graph", "NodeStarted")));
  assert.equal(router.observer.total, 1);
  assert.deepEqual(router.stats.fallbackCategories, ["graph"]);
  assert.equal(router.stats.errors, 1);
});

test("the generic observer keeps a bounded window while counting every record", () => {
  const observer = new GenericDebugConsumer({ maxRecords: 2 });
  const router = new DebugRouter({ observer });
  for (let index = 0; index < 4; index += 1) {
    router.dispatch(record("hero", "graph", `Node${index}`));
  }

  assert.equal(observer.total, 4);
  assert.equal(observer.dropped, 2);
  assert.deepEqual(observer.records.map((entry) => entry.method), ["Node2", "Node3"]);
  assert.deepEqual(observer.recordsForInstance("hero").map((entry) => entry.method), ["Node2", "Node3"]);
  assert.deepEqual(observer.recordsForCategory("graph").map((entry) => entry.method), ["Node2", "Node3"]);
  assert.deepEqual(observer.recordsForCategory("entity"), []);
});

test("unregistering a consumer stops the main delivery immediately", () => {
  const router = new DebugRouter();
  const graph = new SpyConsumer(["graph"]);
  const unregister = router.register(graph, "graph");
  router.dispatch(record("hero", "graph", "NodeStarted"));
  assert.deepEqual(graph.seen, ["graph:NodeStarted"]);

  unregister();
  assert.equal(router.ownerFor("graph"), undefined);
  router.dispatch(record("hero", "graph", "Ticked"));
  assert.deepEqual(graph.seen, ["graph:NodeStarted"]);
  assert.equal(router.observer.total, 2, "the generic consumer takes over after unregister");
});

test("unregistering the first claimer lets the next registered claimer take over", () => {
  const router = new DebugRouter();
  const first = new SpyConsumer(["graph"]);
  const second = new SpyConsumer(["graph"]);
  const unregister = router.register(first, "first");
  router.register(second, "second");

  router.dispatch(record("hero", "graph", "NodeStarted"));
  assert.deepEqual(first.seen, ["graph:NodeStarted"]);
  assert.deepEqual(second.seen, [], "the first registration still owns the category");

  unregister();
  assert.equal(router.ownerFor("graph"), second, "ownership is re-decided on unregister");
  router.dispatch(record("hero", "graph", "Ticked"));
  assert.deepEqual(second.seen, ["graph:Ticked"]);
  assert.equal(router.observer.total, 2, "the generic observer saw both records");
});

test("reset clears the consumers and the routing statistics", () => {
  const router = new DebugRouter();
  const graph = new SpyConsumer(["graph"]);
  router.register(graph, "graph");
  router.dispatch(record("hero", "graph", "NodeStarted"));

  router.reset();
  assert.equal(graph.resets, 1);
  assert.deepEqual(graph.seen, []);
  assert.equal(router.observer.total, 0);
  assert.equal(router.stats.records, 0);
});

test("a replay delivery only feeds the main consumer, never the generic observer", () => {
  const router = new DebugRouter();
  const graph = new SpyConsumer(["graph"]);
  router.register(graph, "graph");

  router.replayToMain(record("hero", "graph", "NodeStarted"));
  assert.deepEqual(graph.seen, ["graph:NodeStarted"]);
  assert.equal(router.observer.total, 0, "the generic view must not be duplicated by a replay");
  assert.equal(router.stats.mainDeliveries, 1);
});
