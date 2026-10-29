import assert from "node:assert/strict";
import test from "node:test";
import type {
  DebugFacet,
  DebugRecord as PublicDebugRecord,
  EditorContext,
  JsonObject,
} from "@visualbridge/module-sdk";
import { DebugRouter } from "../../src/bridge/debugRouter";
import { debugInstanceKey, type DebugCategoryReplayResult } from "../../src/bridge/debugInstanceManager";
import { BridgePayloadKind } from "../../src/bridge/framing";
import type { DebugFacetSource } from "../../src/debug/debugFacetRouter";
import {
  DEBUG_FACET_BATCH_LIMIT,
  DebugFacetHost,
  toPublicRecord,
} from "../../src/debug/debugFacetRouter";
import {
  ManualTimer,
  RecordingConsumer,
  createInstance,
  createManager,
  ingestEvents,
} from "./debugPanelFixture";

function context(options: JsonObject | undefined = undefined): EditorContext<unknown> {
  return {
    project: {
      projectId: "p",
      moduleId: "m",
      documentTypes: [],
      options,
    },
    documentType: { id: "logicGraph", editor: "graph", include: [], exclude: [], catalogs: [] },
    registry: undefined,
    catalogs: { get: () => undefined },
    log: () => undefined,
  };
}

interface RecordedFacet {
  readonly facet: DebugFacet;
  readonly seen: PublicDebugRecord[];
  readonly contexts: EditorContext<unknown>[];
}

function recordingFacet(category: string, options: JsonObject | undefined = undefined): RecordedFacet {
  return recordingMultiFacet([category]);
}

/** 一个 facet 同时认领多个分类（P2-2：这些分类共享同一个 consumer 状态）。 */
function recordingMultiFacet(categories: readonly string[]): RecordedFacet {
  const seen: PublicDebugRecord[] = [];
  const contexts: EditorContext<unknown>[] = [];
  return {
    seen,
    contexts,
    facet: {
      categories: [...categories],
      windowTitle: `${categories[0] ?? ""} title`,
      onRecord(record, received) {
        seen.push(record);
        contexts.push(received);
        return { count: seen.length, seq: record.seq };
      },
    },
  };
}

function source(
  moduleId: string,
  moduleIndex: number,
  editor: string,
  recorded: RecordedFacet,
  options: JsonObject | undefined = undefined,
  editorIndex = 0,
): DebugFacetSource {
  return {
    moduleId,
    moduleIndex,
    editor,
    facet: recorded.facet,
    context: context(options),
    path: `modules[${moduleIndex}].editors[${editorIndex}].debug`,
  };
}

function hostFor(router: DebugRouter, options: {
  readonly replay?: (category: string) => DebugCategoryReplayResult | undefined;
  readonly knownCategories?: () => readonly string[];
  readonly stale?: (category: string) => boolean;
  readonly hasReplayableRecords?: (category: string) => boolean;
  readonly batchLimit?: number;
  readonly historyLimit?: number;
  readonly onBatch?: (category: string, size: number) => void;
} = {}): DebugFacetHost {
  return new DebugFacetHost({
    router,
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.knownCategories === undefined ? {} : { knownCategories: options.knownCategories }),
    ...(options.stale === undefined ? {} : { isCategoryStale: options.stale }),
    ...(options.hasReplayableRecords === undefined ? {} : { hasReplayableRecords: options.hasReplayableRecords }),
    ...(options.batchLimit === undefined ? {} : { batchLimit: options.batchLimit }),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    ...(options.onBatch === undefined ? {} : { onBatch: options.onBatch }),
    sessionId: () => "window#boot",
  });
}

test("facet and GenericDebugConsumer both receive the same batch (B)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  const host = hostFor(router, { knownCategories: () => manager.instances.map((instance) => instance.category) });
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [
    { frame: 1, instance: "hero", value: "n1" },
    { frame: 1, instance: "hero", value: "n2" },
    { frame: 2, instance: "hero", value: "n3" },
  ]);
  host.flushForTest();

  const snapshot = host.snapshot();
  assert.equal(graph.seen.length, 3);
  assert.deepEqual(router.observer.records.map((record) => record.id), manager.storeFor(debugInstanceKey("graph", "hero"))?.recordsFrom(0).records.map((record) => record.id));
  assert.equal(snapshot.generic.records, 3);
  assert.equal(snapshot.windows[0]?.records, 3);
  assert.equal(snapshot.windows[0]?.state, "active");
  assert.deepEqual(snapshot.windows[0]?.content, { count: 3, seq: graph.seen[2]?.seq });
});

test("public DebugRecord is the D.4 shape: no raw bytes or host internals", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 4, instance: "hero", value: "node-4" }]);
  const internal = manager.storeFor(debugInstanceKey("graph", "hero"))?.recordsFrom(0).records[0];
  assert.ok(internal !== undefined);

  const publicRecord = toPublicRecord(internal, "window#boot");
  assert.deepEqual(Object.keys(publicRecord).sort(), [
    "at",
    "category",
    "frame",
    "instanceId",
    "kind",
    "method",
    "params",
    "seq",
    "sessionId",
    "wireBytes",
  ]);
  assert.equal(publicRecord.kind, "event", "普通调试事件必须带 kind=event（P0-2）");
  assert.equal(publicRecord.seq, internal.arrivalSeq);
  assert.equal(publicRecord.sessionId, "window#boot");
  assert.equal(publicRecord.params.nodeId, "node-4");
  assert.ok(!("args" in publicRecord));
  assert.ok(!("contractState" in publicRecord));
  assert.ok(!("arrivalSeq" in publicRecord));
});

test("public DebugRecord kind distinguishes queryResult from events (P0-2)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 4, instance: "hero", value: "node-4" }]);
  const result = manager.appendQueryResult({
    type: "debugResult",
    frame: 4,
    wireBytes: 12,
    payloadKind: BridgePayloadKind.Json,
    category: "graph",
    instance: "hero",
    interfaceId: "IGraphQuery",
    method: "Query",
    methodId: 12,
    instanceSlot: 1,
    requestId: "42",
    args: [{ tag: 1, name: "outputIndex", type: "int", value: 0 }],
    contractState: "unknown-interface",
  }, undefined, 4);
  assert.ok(result !== undefined);

  const eventRecord = toPublicRecord(
    manager.storeFor(debugInstanceKey("graph", "hero"))!.recordsFrom(0).records[0]!,
    "window#boot",
  );
  const resultRecord = toPublicRecord(result, "window#boot");
  assert.equal(eventRecord.kind, "event");
  assert.equal(resultRecord.kind, "queryResult");
  assert.notEqual(eventRecord.kind, resultRecord.kind);
  assert.equal(resultRecord.method, "Query");
});

test("facet render updates are emitted per record, in order, and retained for hydration (G1a)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  const host = hostFor(router);
  const rendered: number[] = [];
  const resets: string[] = [];
  host.onDidRender((event) => {
    assert.equal(event.category, "graph");
    assert.equal(event.moduleId, "m");
    assert.equal(event.editor, "graph");
    rendered.push((event.update as { readonly seq: number }).seq);
  });
  host.onDidReset((event) => resets.push(event.category));
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [
    { frame: 1, instance: "hero", value: "n1" },
    { frame: 2, instance: "hero", value: "n2" },
  ]);
  host.flushForTest();

  assert.deepEqual(rendered, graph.seen.map((record) => record.seq));
  assert.deepEqual(host.updatesFor("graph").map((entry) => entry.seq), rendered);
  assert.equal(host.isHistoryTruncated("graph"), false);
  assert.deepEqual(host.windowSource("graph"), { moduleId: "m", editor: "graph" });

  // 重建 = 分类级重置：先通知 Webview 丢累积，再清空历史（重放由 replay 负责）。
  host.rebuild([source("m", 0, "graph", graph)]);
  assert.deepEqual(resets, ["graph"]);
  assert.deepEqual(host.updatesFor("graph"), []);
});

test("facet reset distinguishes module reload from session invalidation", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const host = hostFor(router);
  const reasons: string[] = [];
  host.onDidReset((event) => reasons.push(`${event.category}:${event.reason}`));
  host.rebuild([source("m", 0, "graph", recordingFacet("graph"))]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero", value: "n1" }]);
  host.flushForTest();
  assert.equal(host.updatesFor("graph").length, 1);

  host.rebuild([source("m", 0, "graph", recordingFacet("graph"))]);
  assert.deepEqual(reasons, ["graph:reload"]);

  ingestEvents(manager, [{ frame: 2, instance: "hero", value: "n2" }]);
  host.flushForTest();
  assert.equal(host.updatesFor("graph").length, 1);

  manager.reset();
  assert.deepEqual(reasons, ["graph:reload", "graph:session"]);
  assert.deepEqual(host.updatesFor("graph"), [], "会话作废必须清掉 facet 侧历史");
});

test("facet history is bounded and marks truncation (G1a)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const host = hostFor(router, { historyLimit: 2 });
  host.rebuild([source("m", 0, "graph", recordingFacet("graph"))]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [
    { frame: 1, instance: "hero", value: "n1" },
    { frame: 2, instance: "hero", value: "n2" },
    { frame: 3, instance: "hero", value: "n3" },
  ]);
  host.flushForTest();

  const history = host.updatesFor("graph");
  assert.equal(history.length, 2);
  assert.equal(host.isHistoryTruncated("graph"), true);
  assert.deepEqual(history.map((entry) => (entry.update as { readonly seq: number }).seq), [2, 3]);
});

test("two modules claiming one category: first in modules order wins, second is disabled with a located diagnostic", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const first = recordingFacet("graph");
  const second = recordingFacet("graph");
  const host = hostFor(router);
  host.rebuild([source("first", 0, "graph", first), source("second", 1, "graph", second)]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero" }]);
  host.flushForTest();

  assert.equal(first.seen.length, 1);
  assert.equal(second.seen.length, 0);
  const window = host.snapshot().windows[0];
  assert.equal(window?.moduleId, "first");
  assert.equal(window?.state, "active");
  const conflict = window?.diagnostics.find((diagnostic) => diagnostic.code === "module.editorConflict");
  assert.ok(conflict !== undefined);
  assert.equal(conflict.path, "modules[1].editors[0].debug.categories[0]");
  assert.match(conflict.message, /already provided/);
});

test("onRecord throw: category falls back to generic, other categories unaffected, no record lost", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  const table = recordingFacet("table");
  const host = hostFor(router, { knownCategories: () => ["graph", "table"] });
  host.rebuild([source("m", 0, "graph", graph), source("m", 0, "table", table)]);
  host.setFaultInjectionForTest("graph");

  createInstance(manager, "graph", "hero");
  createInstance(manager, "table", "grid");
  ingestEvents(manager, [
    { category: "graph", instance: "hero", frame: 1 },
    { category: "graph", instance: "hero", frame: 2 },
    { category: "table", instance: "grid", frame: 1 },
    { category: "table", instance: "grid", frame: 2 },
  ]);
  host.flushForTest();

  const snapshot = host.snapshot();
  const graphWindow = snapshot.windows.find((window) => window.category === "graph");
  const tableWindow = snapshot.windows.find((window) => window.category === "table");
  assert.equal(graph.seen.length, 0);
  assert.equal(graphWindow?.state, "fallback");
  assert.equal(graphWindow?.diagnostics[0]?.code, "module.callFailed");
  assert.equal(graphWindow?.diagnostics[0]?.path, "modules[0].editors[0].debug");
  assert.deepEqual(router.stats.fallbackCategories, ["graph"]);

  // 另一个分类完全不受影响。
  assert.equal(table.seen.length, 2);
  assert.equal(tableWindow?.state, "active");
  // 记录没有丢：通用观察者拿到全部 4 条。
  assert.equal(snapshot.generic.records, 4);
  assert.equal(snapshot.failures, 1);
});

test("after rebuild/dispose the old facet is never called and the category goes generic immediately (A)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  const host = hostFor(router, {
    knownCategories: () => manager.instances.map((instance) => instance.category),
  });
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero" }]);
  host.flushForTest();
  assert.equal(graph.seen.length, 1);

  // 模拟模块卸载/Trust 撤回：先把旧 facet 注销，再继续灌记录。
  host.rebuild([]);
  ingestEvents(manager, [{ frame: 2, instance: "hero" }, { frame: 3, instance: "hero" }]);
  host.flushForTest();

  assert.equal(graph.seen.length, 1, "destroyed facet must not receive records");
  assert.equal(host.snapshot().lateRecords, 0, "no late delivery to a disposed consumer");
  assert.equal(router.observer.total, 3);
  const window = host.snapshot().windows.find((candidate) => candidate.category === "graph");
  assert.equal(window?.state, "unavailable");
  assert.match(window?.message ?? "", /模块未加载/);
});

test("batch cap: at most DEBUG_FACET_BATCH_LIMIT records per batch, no drops beyond the cap (C)", () => {
  assert.equal(DEBUG_FACET_BATCH_LIMIT, 100);
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  const sizes: number[] = [];
  const timer = new ManualTimer();
  const host = new DebugFacetHost({
    router,
    batchLimit: DEBUG_FACET_BATCH_LIMIT,
    knownCategories: () => ["graph"],
    onBatch: (_category, size) => sizes.push(size),
    setTimer: timer.set,
    clearTimer: timer.clear,
    log: () => undefined,
  });
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "hero");
  const inputs = Array.from({ length: 250 }, (_unused, index) => ({ frame: index, instance: "hero" }));
  ingestEvents(manager, inputs);
  assert.equal(timer.pending, 1, "consume() only queues; the first batch waits for the timer");
  host.flushForTest();

  assert.deepEqual(sizes, [100, 100, 50]);
  assert.equal(graph.seen.length, 250);
  const snapshot = host.snapshot();
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.windows[0]?.batches, 3);
  assert.equal(snapshot.generic.records, 250);
  assert.equal(graph.seen.length, router.observer.total);
});

test("a render update that is not a JSON object is a located contract failure", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const broken: DebugFacet = {
    categories: ["graph"],
    onRecord: () => (() => undefined) as unknown as JsonObject,
  };
  const host = hostFor(router, {
    knownCategories: () => ["graph"],
    replay: (category) => manager.replay(category),
  });
  host.rebuild([{ moduleId: "m", moduleIndex: 0, editor: "graph", facet: broken, context: context(), path: "modules[0].editors[0].debug" }]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero" }]);
  host.flushForTest();

  const window = host.snapshot().windows[0];
  assert.equal(window?.state, "fallback");
  assert.equal(window?.diagnostics[0]?.code, "module.registrationInvalid");
  assert.equal(window?.diagnostics[0]?.path, "modules[0].editors[0].debug");
  assert.deepEqual(router.stats.fallbackCategories, ["graph"]);
  // P2-2：回退状态下"按分类重建"没有可重建的消费者（`hasOwner` 为假）⇒ 不可重建且确实 no-op，
  // 面板据此禁用按钮并提示"重载模块后自动恢复"，而不是让用户点一个点了没反应的东西。
  assert.equal(window?.rebuildable, false);
  assert.equal(host.replayCategory("graph"), undefined);
});

test("the production timer chain, not flushNow, delivers 250 records in bounded ticks (P2-3)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  const sizes: number[] = [];
  const timer = new ManualTimer();
  const host = new DebugFacetHost({
    router,
    batchLimit: DEBUG_FACET_BATCH_LIMIT,
    knownCategories: () => ["graph"],
    onBatch: (_category, size) => sizes.push(size),
    setTimer: timer.set,
    clearTimer: timer.clear,
    log: () => undefined,
  });
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, Array.from({ length: 250 }, (_unused, index) => ({ frame: index, instance: "hero" })));
  assert.equal(timer.pending, 1, "consume() 只入队，第一批由 setTimeout 链驱动（不经过 flushNow）");

  timer.fireAll();
  assert.deepEqual(sizes, [100], "第一个 tick 恰好投 100 条，其余留到下一批");
  assert.equal(timer.pending, 1, "队列还有记录 ⇒ 必须重新排期下一批（删掉重排这条链就断在这里）");

  timer.fireAll();
  assert.deepEqual(sizes, [100, 100], "第二个 tick 同样 100 条");
  assert.equal(timer.pending, 1);

  timer.fireAll();
  assert.deepEqual(sizes, [100, 100, 50], "最后一个 tick 投剩下的 50 条");
  assert.equal(timer.pending, 0, "投完不再排期（不能空转）");

  const store = manager.storeFor(debugInstanceKey("graph", "hero"));
  assert.deepEqual(
    graph.seen.map((record) => record.seq),
    store?.recordsFrom(0).records.map((record) => record.arrivalSeq),
    "分批不得改变投递顺序",
  );
  const snapshot = host.snapshot();
  assert.equal(snapshot.pending, 0, "所有批次排空后 pending 归零");
  assert.equal(snapshot.windows[0]?.batches, 3);
  assert.equal(graph.seen.length, 250);
});

test("a stale category leaves no stuck module view once its last records are gone (P1 b)", () => {
  const router = new DebugRouter();
  // 实例上限压到 2：清空一个实例后再建两个，就能把同分类剩下的那个实例挤成墓碑。
  const manager = createManager({ router, maxInstances: 2 });
  const graph = recordingFacet("graph");
  const host = hostFor(router, {
    knownCategories: () => manager.instances.map((instance) => instance.category),
    stale: (category) => manager.isCategoryStale(category),
  });
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "a");
  ingestEvents(manager, [{ instance: "a", frame: 1 }, { instance: "a", frame: 2 }]);
  createInstance(manager, "graph", "b");
  ingestEvents(manager, [{ instance: "b", frame: 3 }, { instance: "b", frame: 4 }]);
  host.flushForTest();
  assert.equal(graph.seen.length, 4);

  const cleared = manager.clearInstance(debugInstanceKey("graph", "a"));
  assert.equal(cleared?.categoryStale, true);
  assert.equal(manager.isCategoryStale("graph"), true);

  // 同分类剩下的实例 b 被实例数上限淘汰：该分类已没有任何可见记录。
  createInstance(manager, "graph", "c");
  createInstance(manager, "graph", "d");
  assert.equal(manager.storeFor(debugInstanceKey("graph", "b")), undefined, "b 已被淘汰");

  assert.equal(
    manager.isCategoryStale("graph"),
    false,
    "分类已无记录 ⇒ stale 必须终止（否则一直挂到下一次真会话）",
  );
  const window = host.snapshot().windows.find((candidate) => candidate.category === "graph");
  assert.equal(window?.state, "active");
  assert.equal(window?.stale, false, "UI 不能继续显示'实例清空后未重建'");
  assert.equal(window?.content, undefined, "模块视图不能停在清空前的状态");
  assert.equal(window?.records, 0);
});

test("a stale category with no module is not rebuildable but recovers on reload (P1 a, host side)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  let replays = 0;
  const host = hostFor(router, {
    knownCategories: () => manager.instances.map((instance) => instance.category),
    stale: (category) => manager.isCategoryStale(category),
    replay: (category) => {
      replays += 1;
      return manager.replay(category);
    },
  });
  host.rebuild([source("m", 0, "graph", graph)]);
  createInstance(manager, "graph", "a");
  ingestEvents(manager, [{ instance: "a", frame: 1 }]);
  createInstance(manager, "graph", "b");
  ingestEvents(manager, [{ instance: "b", frame: 2 }]);
  host.flushForTest();
  assert.equal(graph.seen.length, 2);
  manager.clearInstance(debugInstanceKey("graph", "a"));
  assert.equal(manager.isCategoryStale("graph"), true);

  // 模块被卸载/停用：分类回退通用视图，陈旧状态仍在，但**没有任何可重建的消费者**。
  host.rebuild([]);
  const gone = host.snapshot().windows.find((window) => window.category === "graph");
  assert.equal(gone?.state, "unavailable");
  assert.equal(gone?.stale, true);
  assert.equal(gone?.rebuildable, false, "按钮必须由 rebuildable 判据禁用");
  assert.equal(host.replayCategory("graph"), undefined, "no-op 不能假装重建成功");

  // 模块重新加载：rebuild() 为新 facet 重放该分类已有记录，陈旧标记随之结束。
  host.rebuild([source("m", 0, "graph", graph)]);
  host.flushForTest();
  const back = host.snapshot().windows.find((window) => window.category === "graph");
  assert.equal(back?.state, "active");
  assert.equal(back?.stale, false);
  assert.equal(back?.rebuildable, true);
  assert.ok(replays >= 1);
  assert.equal(graph.seen.length, 3, "重放把剩余的那条记录补投给新消费者");
});

test("a module cannot mutate the host record or the generic view (P2-5)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const received: PublicDebugRecord[] = [];
  const mutating: DebugFacet = {
    categories: ["graph"],
    onRecord(record) {
      received.push(record);
      const nodeId = record.params.nodeId as { readonly nested: { x: number } };
      // 模块改自己收到的记录：不许影响 store 与通用视图。
      nodeId.nested.x = 999;
      return { ok: true };
    },
  };
  const host = hostFor(router, { knownCategories: () => ["graph"] });
  host.rebuild([{
    moduleId: "m",
    moduleIndex: 0,
    editor: "graph",
    facet: mutating,
    context: context(),
    path: "modules[0].editors[0].debug",
  }]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, value: { nested: { x: 1 } } }]);
  host.flushForTest();

  const hostRecord = manager.storeFor(debugInstanceKey("graph", "hero"))?.recordsFrom(0).records[0];
  assert.ok(hostRecord);
  assert.deepEqual(
    [...hostRecord.args.values()][0]?.value,
    { nested: { x: 1 } },
    "模块修改参数必须只落在自己的副本上，store 不能被污染",
  );
  const observed = router.observer.lastRecord;
  assert.ok(observed);
  assert.deepEqual([...observed.args.values()][0]?.value, { nested: { x: 1 } }, "通用视图不能被污染");
  assert.equal(received.length, 1);
});

test("an oversized render update is a located failure instead of bloating every snapshot (P2-6)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const huge: DebugFacet = {
    categories: ["graph"],
    onRecord: () => ({ blob: "x".repeat(200_000) }),
  };
  const host = hostFor(router, { knownCategories: () => ["graph"] });
  host.rebuild([{
    moduleId: "m",
    moduleIndex: 0,
    editor: "graph",
    facet: huge,
    context: context(),
    path: "modules[0].editors[0].debug",
  }]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero" }, { frame: 2, instance: "hero" }]);
  host.flushForTest();

  const snapshot = host.snapshot();
  const window = snapshot.windows[0];
  assert.equal(window?.state, "fallback", "超限的渲染增量不能进 snapshot");
  assert.equal(window?.content, undefined);
  assert.equal(window?.diagnostics[0]?.code, "module.renderTooLarge");
  assert.match(window?.diagnostics[0]?.message ?? "", /above the 65536 byte output limit/u);
  assert.equal(window?.diagnostics[0]?.path, "modules[0].editors[0].debug");
  assert.equal(snapshot.generic.records, 2, "记录不丢，改投通用视图");
});

test("one facet object mounted on two editors is reported as a conflict, not silently dropped (P2-8)", () => {
  const router = new DebugRouter();
  const graph = recordingFacet("graph");
  const host = hostFor(router);
  // 同一模块把**同一个 facet 对象**挂在两个 editor 上：判据 facet !== facet 恒 false，旧实现失明。
  host.rebuild([
    source("m", 0, "editor-a", graph, undefined, 0),
    source("m", 0, "editor-b", graph, undefined, 1),
  ]);

  const window = host.snapshot().windows[0];
  const conflict = window?.diagnostics.find((diagnostic) => diagnostic.code === "module.editorConflict");
  assert.ok(conflict, "第二处必须报 module.editorConflict，不能静默丢弃");
  assert.equal(conflict.path, "modules[0].editors[1].debug.categories[0]");
  assert.match(conflict.message, /editor-a/u);

  const manager = createManager({ router });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero" }]);
  host.flushForTest();
  assert.equal(graph.seen.length, 1, "同一分类仍然只投给一个消费者");
});

test("a non-positive batchLimit is normalized instead of spinning the flush loop (P2-3)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const graph = recordingFacet("graph");
  const sizes: number[] = [];
  const timer = new ManualTimer();
  const host = new DebugFacetHost({
    router,
    batchLimit: 0,
    knownCategories: () => ["graph"],
    onBatch: (_category, size) => sizes.push(size),
    setTimer: timer.set,
    clearTimer: timer.clear,
    log: () => undefined,
  });
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 2 }, { frame: 3 }]);
  // `0` 等于"永不投递"：`flushNow` 的 while 拿不到非空批次会自旋。归一成每批至少 1 条。
  assert.equal(host.snapshot().batchLimit, 1);

  host.flushForTest();
  assert.deepEqual(sizes, [1, 1, 1], "归一后每批 1 条，flushNow 能正常终止");
  assert.equal(graph.seen.length, 3);
  assert.equal(host.snapshot().pending, 0);
  assert.equal(timer.pending, 0);
});

test("a category with only tombstones is not rebuildable (P2-1)", () => {
  const router = new DebugRouter();
  // 实例上限 1：建 table 实例会把 graph 的实例挤成墓碑，graph 不再有任何 store。
  const manager = createManager({ router, maxInstances: 1 });
  const graph = recordingFacet("graph");
  const host = hostFor(router, {
    knownCategories: () => manager.instances.map((instance) => instance.category),
    replay: (category) => manager.replay(category),
    hasReplayableRecords: (category) => manager.hasReplayableCategoryRecords(category),
  });
  host.rebuild([source("m", 0, "graph", graph)]);

  createInstance(manager, "graph", "a");
  ingestEvents(manager, [{ instance: "a", frame: 1 }]);
  host.flushForTest();
  const live = host.snapshot().windows.find((window) => window.category === "graph");
  assert.equal(live?.state, "active");
  assert.equal(live?.rebuildable, true, "有可见记录时可重建");
  assert.ok(host.replayCategory("graph") !== undefined, "与按钮状态一致：确实能重建");

  createInstance(manager, "table", "grid");
  assert.equal(manager.storeFor(debugInstanceKey("graph", "a")), undefined, "graph 实例已被淘汰");
  assert.equal(manager.hasVisibleCategoryRecords("graph"), false);

  const window = host.snapshot().windows.find((candidate) => candidate.category === "graph");
  assert.equal(window?.state, "active", "消费者仍在，窗口仍显示模块消费");
  assert.equal(window?.rebuildable, false, "只剩墓碑 ⇒ 按钮必须禁用（否则点了没反应）");
  assert.equal(host.replayCategory("graph"), undefined, "按钮状态与 replay 的实际结果一致");
});

test("settling a stale sibling category must not swallow the record that triggered it (P2-2)", () => {
  const router = new DebugRouter();
  // 全局上限 30 B：一条 24 B 记录进来就会淘汰最旧的一条，用来制造"兄弟分类的最后一条记录
  // 在**本次 append** 中被淘汰"——旧位置（dispatch 之后结算）可被触发的路径。
  const manager = createManager({ router, maxBytesGlobal: 30, keyframeIntervalRecords: 1 });
  // 同一个 facet 认领两个分类：它们共享同一个 consumer（reset() 会一起清掉）。
  const shared = recordingMultiFacet(["graph", "table"]);
  const host = hostFor(router, {
    knownCategories: () => manager.instances.map((instance) => instance.category),
    stale: (category) => manager.isCategoryStale(category),
  });
  host.rebuild([source("m", 0, "graph", shared)]);

  createInstance(manager, "graph", "a");
  ingestEvents(manager, [{ instance: "a", frame: 1 }]);
  createInstance(manager, "graph", "b");
  ingestEvents(manager, [{ instance: "b", frame: 2 }]);
  // b 的记录留下、a 的被全局上限淘汰；清空 a 后 graph 变 stale（b 还有可见记录）。
  manager.clearInstance(debugInstanceKey("graph", "a"));
  assert.equal(manager.isCategoryStale("graph"), true);
  host.flushForTest();

  createInstance(manager, "table", "grid");
  // 这条 append 会因全局上限淘汰 graph 的最后一条记录 ⇒ graph 结算。结算若发生在 dispatch
  // 之后（旧位置），会 reset 共享 consumer，把刚入队的 table 记录清掉。
  ingestEvents(manager, [{ category: "table", instance: "grid", frame: 3 }]);
  host.flushForTest();

  assert.equal(manager.keyframes.count("table"), 0, "pending 未被清空 ⇒ 不能在空状态上捕获关键帧");
  assert.equal(
    shared.seen.filter((record) => record.category === "table").length,
    1,
    "当前分类的记录不能被兄弟分类的结算吃掉",
  );
});

test("a render failure clears the content rendered before it (P2-4)", () => {
  const router = new DebugRouter();
  const manager = createManager({ router });
  let calls = 0;
  const facet: DebugFacet = {
    categories: ["graph"],
    onRecord() {
      calls += 1;
      // 第一条成功、第二条超限：验证失败前已经写进窗口的 content 会被清掉。
      return calls === 1 ? { ok: true, call: calls } : { blob: "x".repeat(200_000) };
    },
  };
  const host = hostFor(router, { knownCategories: () => ["graph"] });
  host.rebuild([{
    moduleId: "m",
    moduleIndex: 0,
    editor: "graph",
    facet,
    context: context(),
    path: "modules[0].editors[0].debug",
  }]);

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero" }, { frame: 2, instance: "hero" }]);
  host.flushForTest();

  const window = host.snapshot().windows[0];
  assert.equal(window?.state, "fallback");
  assert.equal(window?.diagnostics[0]?.code, "module.renderTooLarge");
  assert.equal(window?.content, undefined, "回退通用视图后不能再显示失败前的模块内容");
});

test("explicit category replay surfaces partial instead of swallowing it", () => {
  const router = new DebugRouter();
  const graph = recordingFacet("graph");
  const result: DebugCategoryReplayResult = {
    category: "graph",
    fromKeyframe: false,
    keyframeId: undefined,
    fromArrivalSeq: 0,
    toArrivalSeq: 4,
    applied: 4,
    partial: true,
  };
  const host = hostFor(router, { replay: () => result, knownCategories: () => ["graph"] });
  host.rebuild([source("m", 0, "graph", graph)]);

  assert.deepEqual(host.replayCategory("graph"), {
    fromKeyframe: false,
    keyframeId: undefined,
    applied: 4,
    partial: true,
  });
  assert.equal(host.snapshot().windows[0]?.replay?.partial, true);
});
