/**
 * F3 面板模型（`debugPanelState.ts`）的单测。
 *
 * 覆盖的硬要求（任务书 §四条会被评审重点打的点 + §验收标准）：
 * - 按记录 / 按帧步进与边界；
 * - 乱序帧只按到达顺序分组（1,2,1,3 ⇒ [1],[2],[1],[3]，不是 [1,1],[2],[3]）；
 * - 暂停只停 UI 刷新，记录照样进 store，恢复后不丢；
 * - 切换实例各自保留游标与 partial；
 * - 时间轴起点用 `fromPosition`（不是 `requestedPosition`），淘汰后标 partial；
 * - 回放后由面板自己把游标移到末尾（`replay()` 不动游标）；
 * - 大记录量只渲染窗口。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBUG_PANEL_VALUE_PREVIEW_LIMIT,
  DEBUG_PANEL_WINDOW_RECORDS,
  detailOf,
  previewValue,
} from "../../src/debug/debugPanelState";
import {
  createInstance,
  createManager,
  createModel,
  eventEnvelope,
  ingestEvents,
  instanceKeyOf,
  RecordingConsumer,
} from "./debugPanelFixture";
import { DebugRouter } from "../../src/bridge/debugRouter";
import { BridgePayloadKind } from "../../src/bridge/framing";

/** 一帧号一组的摘要（渲染层就是按它画帧边界）。 */
function frameShape(snapshot: { timeline: { groups: readonly { frame: number; count: number }[] } }): string {
  return snapshot.timeline.groups.map((group) => `${group.frame}x${group.count}`).join(",");
}

test("records and frames arrive in arrival order: 1,2,1,3 groups as [1],[2],[1],[3]", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [
    { frame: 1 },
    { frame: 2 },
    { frame: 1 },
    { frame: 3 },
  ]);
  model.selectInstance(instanceKeyOf("graph", "hero"));

  const snapshot = model.snapshot();
  // 关键：**不重排**。先按 frame 排序再分组会得到 [1,1],[2],[3]，那是被静默重排过的结果。
  assert.equal(frameShape(snapshot), "1x1,2x1,1x1,3x1");
  assert.deepEqual(snapshot.timeline.records.map((record) => record.frame), [1, 2, 1, 3]);
  assert.deepEqual(
    snapshot.timeline.records.map((record) => record.frameStart),
    [true, true, true, true],
    "每次帧号变化都是新组的起点",
  );
});

test("consecutive equal frames stay one group and -1 forms its own group", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [
    { frame: -1 },
    { frame: -1 },
    { frame: 4 },
    { frame: 4 },
    { frame: 4 },
    { frame: 2 },
  ]);
  model.selectInstance(instanceKeyOf("graph", "hero"));

  const snapshot = model.snapshot();
  // `-1` 按连续成组（F2 `groupRecordsByFrame` 的语义），但它永远不并进真实帧号。
  assert.equal(frameShape(snapshot), "-1x2,4x3,2x1");
});

test("stepping one record at a time stops exactly at the boundaries", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 1 }, { frame: 2 }]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);

  // 选中即回到实时：游标在末尾。
  assert.equal(store.cursor.position, store.endPosition);
  assert.equal(model.snapshot().timeline.atEnd, true);

  model.step(-1);
  assert.equal(store.cursor.position, store.endPosition - 1);
  assert.equal(model.snapshot().mode, "replay", "手动步进即进入逐步模式");
  model.step(-1);
  model.step(-1);
  model.step(-1);
  assert.equal(store.cursor.position, 0, "最早位置是 0（还没有应用任何记录）");
  const atStart = model.snapshot().timeline;
  assert.equal(atStart.atStart, true);
  assert.equal(atStart.atEnd, false);

  model.step(1);
  model.step(1);
  model.step(1);
  model.step(1);
  assert.equal(store.cursor.position, store.endPosition);
  const atEnd = model.snapshot().timeline;
  assert.equal(atEnd.atEnd, true);
  assert.equal(atEnd.atStart, false);
});

test("stepping one frame at a time moves a whole consecutive frame group", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [
    { frame: 1 },
    { frame: 1 },
    { frame: 1 },
    { frame: 2 },
    { frame: 2 },
    { frame: 1 },
  ]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);
  model.setGranularity("frame");

  model.step(-1);
  assert.equal(store.cursor.position, 5, "回退一帧 = 回到上一组（最后的 1）的起点");
  model.step(-1);
  assert.equal(store.cursor.position, 3, "再回退一帧 = 跳过整组 2x2");
  model.step(-1);
  assert.equal(store.cursor.position, 0, "再回退一帧 = 跳过整组 1x3，到最早位置");
  // 边界：再按一次不动。
  model.step(-1);
  assert.equal(store.cursor.position, 0);

  model.step(1);
  assert.equal(store.cursor.position, 3, "前进一帧 = 整组 1x3");
  model.step(1);
  assert.equal(store.cursor.position, 5);
  model.step(1);
  assert.equal(store.cursor.position, 6, "末尾");
});

test("pause freezes the rendered timeline window while records keep landing in the store", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 1 }]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);
  assert.equal(store.recordCount, 2);
  assert.equal(model.snapshot().timeline.records.length, 2);

  const revisionBeforePause = model.revision;
  assert.equal(model.pause(), true);
  assert.equal(store.paused, true);
  // 暂停这个动作本身必须重绘一次（状态栏与按钮要立刻反映"已暂停"）。
  assert.equal(model.revision, revisionBeforePause + 1, "pause() 本身触发一次重绘");
  const paused = model.snapshot();
  const pausedRevision = model.revision;
  assert.equal(paused.timeline.records.length, 2);
  assert.equal(paused.timeline.cursor, store.endPosition);

  // 暂停期间记录**照常**进 store（这是 P0：把暂停做成冻结入站会丢数据）。
  ingestEvents(manager, [{ frame: 2 }, { frame: 2 }, { frame: 2 }]);
  assert.equal(store.recordCount, 5, "暂停不得阻断入站");
  assert.equal(store.paused, true);

  // 暂停的可见效果：时间轴窗口冻结在暂停那一刻。只断言 revision 是恒真的
  // （revision 只在 touch() 里自增，模型并不订阅 store），必须断言渲染行数与游标。
  const stillPaused = model.snapshot();
  assert.equal(
    stillPaused.timeline.records.length,
    paused.timeline.records.length,
    "暂停期间快照行数不变：新记录只进 store，不进渲染列表",
  );
  assert.equal(stillPaused.timeline.records.length, 2);
  assert.equal(stillPaused.timeline.cursor, paused.timeline.cursor, "暂停期间游标不动");
  assert.equal(stillPaused.timeline.atEnd, false, "已有未渲染的记录 ⇒ 暂停中不再声称在末尾");
  assert.equal(model.revision, pausedRevision, "暂停期间没有新的重绘被触发");

  const revisionBeforeResume = model.revision;
  assert.equal(model.resume(), true);
  assert.equal(store.paused, false);
  // 继续同样要立刻重绘一次。
  assert.equal(model.revision, revisionBeforeResume + 1, "resume() 本身触发一次重绘");
  const after = model.snapshot();
  assert.equal(after.timeline.records.length, 5, "恢复后 5 条记录一条不少（行数增加）");
  assert.ok(after.timeline.records.length > stillPaused.timeline.records.length, "恢复后行数必须增加");
  assert.equal(after.timeline.cursor, store.endPosition, "恢复后游标追平末尾");
  assert.equal(after.timeline.atEnd, true, "暂停前在实时模式，恢复后补到末尾");
  assert.equal(after.paused, false);
});

test("stepping is refused while paused but the records are kept", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 2 }]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);
  model.pause();
  const cursor = store.cursor.position;

  assert.equal(model.step(-1), false);
  assert.equal(store.cursor.position, cursor, "暂停中不步进（按钮同时禁用）");
  assert.equal(store.recordCount, 2);
});

test("each instance keeps its own cursor and partial flag when switching", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero", { slot: 1 });
  createInstance(manager, "entity", "boss", { slot: 2 });
  ingestEvents(manager, [{ instance: "hero", frame: 1 }, { instance: "hero", frame: 2 }, { instance: "hero", frame: 3 }]);
  ingestEvents(manager, [
    { category: "entity", instance: "boss", frame: 5 },
    { category: "entity", instance: "boss", frame: 6 },
  ]);

  const heroKey = instanceKeyOf("graph", "hero");
  const bossKey = instanceKeyOf("entity", "boss");
  model.selectInstance(heroKey);
  model.step(-1);
  model.step(-1);
  const heroCursor = manager.storeFor(heroKey)?.cursor.position;
  assert.equal(heroCursor, 1);

  model.selectInstance(bossKey);
  assert.equal(manager.storeFor(bossKey)?.cursor.position, 2, "新选中的实例在末尾（选中即回实时）");
  model.step(-1);
  assert.equal(manager.storeFor(bossKey)?.cursor.position, 1);

  model.selectInstance(heroKey);
  assert.equal(manager.storeFor(heroKey)?.cursor.position, heroCursor, "切回来游标原样保留");
  // 过滤状态：关键词筛选是面板级状态，切换实例不影响它。
  model.setFilter("boss");
  assert.equal(model.snapshot().instances.length, 1);
  model.selectInstance(heroKey);
  assert.equal(model.snapshot().filter, "boss");
});

test("the keyword filter matches instanceId, resName, category, interface and debugInfo", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero", { resName: "HeroPrefab", debugInfo: "spawned-by-wave" });
  createInstance(manager, "entity", "boss", { resName: "BossPrefab", slot: 2 });
  ingestEvents(manager, [{ instance: "hero", interfaceId: "IGraphDebuger", frame: 1 }]);
  ingestEvents(manager, [{ category: "entity", instance: "boss", interfaceId: "IEntityDebuger", frame: 2 }]);

  const keysFor = (filter: string): string[] => {
    model.setFilter(filter);
    return model.snapshot().instances.map((row) => row.instanceId);
  };

  assert.deepEqual(keysFor("hero"), ["hero"]);
  assert.deepEqual(keysFor("BossPrefab"), ["boss"], "匹配 resName");
  assert.deepEqual(keysFor("entity"), ["boss"], "匹配 category");
  assert.deepEqual(keysFor("IGraphDebuger"), ["hero"], "匹配 interface（来自已到达记录）");
  assert.deepEqual(keysFor("wave"), ["hero"], "匹配 debugInfo");
  assert.deepEqual(keysFor("nothing-matches"), []);
  assert.equal(model.snapshot().totalInstances, 2, "筛选只影响列表，不影响实例总数");
});

test("the timeline starts at fromPosition and reports partial when history was evicted", () => {
  const { model, manager } = createModel({ manager: createManager({ maxRecords: 3 }) });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [
    { frame: 1 },
    { frame: 1 },
    { frame: 1 },
    { frame: 1 },
    { frame: 1 },
  ]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);
  assert.equal(store.earliestPosition, 2, "3 条上限 ⇒ 最旧两条被淘汰");

  const timeline = model.snapshot().timeline;
  // 请求位置 0 落在淘汰区间：`fromPosition` 必须被夹到 2，且 partial 为真。
  assert.equal(timeline.requestedPosition, 0);
  assert.equal(timeline.fromPosition, 2);
  assert.equal(timeline.partial, true);
  assert.equal(timeline.historyMissing, true, "历史未记录");
  assert.equal(timeline.records.length, 3);
  assert.equal(timeline.records[0]?.position, 2, "渲染位置以 fromPosition 为起点");
});

test("a tombstone instance keeps reporting historyMissing on the timeline", () => {
  // 实例数上限压到 1：第二个 Create 把第一个实例挤成墓碑（store 被丢弃、只留墓碑视图）。
  const { model, manager } = createModel({ manager: createManager({ maxInstances: 1 }) });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 2 }]);
  const heroKey = instanceKeyOf("graph", "hero");

  createInstance(manager, "graph", "boss", { slot: 2 });
  assert.equal(manager.storeFor(heroKey), undefined, "被淘汰实例的 store 已经不存在");
  const row = manager.instance(heroKey);
  assert.equal(row?.historyMissing, true, "墓碑视图标历史未记录");

  model.selectInstance(heroKey);
  const timeline = model.snapshot().timeline;
  assert.equal(timeline.selected, false, "墓碑没有 store ⇒ 时间轴无内容");
  assert.equal(timeline.records.length, 0);
  // C.4 的标记不能因为"没有 store"就被 early return 吞掉。
  assert.equal(timeline.historyMissing, true, "墓碑实例的时间轴仍报告 historyMissing");
});

test("replay rebuilds the consumer and the panel then moves the cursor to the end itself", () => {
  const router = new DebugRouter();
  const consumer = new RecordingConsumer("graph");
  router.register(consumer, "graph-facet");
  const { model, manager } = createModel({ manager: createManager({ router }) });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 2 }, { frame: 3 }]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);

  // 退到中间：消费侧状态仍是"全量"（逐步只是面板时间轴）。
  model.step(-1);
  model.step(-1);
  assert.equal(store.cursor.position, 1);
  assert.equal(model.snapshot().mode, "replay");

  const beforeRecords = consumer.records.length;
  model.replayToLive();
  // F2 的 replay 只重建消费者状态，不动游标 ⇒ 面板必须自己补这一步。
  assert.equal(store.cursor.position, store.endPosition, "回放后游标被面板移到末尾");
  assert.equal(model.snapshot().mode, "live");
  assert.ok(consumer.records.length >= beforeRecords, "消费者确实被重新投递过");
  assert.ok(consumer.resets >= 1, "没有可用关键帧时回放以 reset 开始");
});

test("clear empties the store and resets the cursor without leaving a partial flag", () => {
  const router = new DebugRouter();
  const consumer = new RecordingConsumer("graph");
  router.register(consumer, "graph-facet");
  const { model, manager } = createModel({ manager: createManager({ router }) });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 2 }]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);

  assert.equal(model.clear(), true);
  assert.equal(store.recordCount, 0);
  assert.equal(store.cursor.position, 0);
  const timeline = model.snapshot().timeline;
  assert.equal(timeline.records.length, 0);
  assert.equal(timeline.partial, false, "清空不是'历史未记录'");
  assert.equal(model.snapshot().mode, "live");
  // 本用例只有 1 个实例：清空后该分类**已无任何记录**，`clearInstance` 走 `categoryReset` 分支，
  // 所以主消费者被重置（这是"实例级清空"与"分类级重建"边界重合的那一支）。
  // 不要把它当成通例：同分类还有别的实例记录时只标 `categoryStale`，主消费者**不会**被重置
  // （见下一条用例）。
  assert.ok(consumer.resets >= 1);
});

test("clearing one instance does not silently rebuild the whole category (0.1 P1)", () => {
  const router = new DebugRouter();
  const consumer = new RecordingConsumer("graph");
  router.register(consumer, "graph-facet");
  const { model, manager } = createModel({ manager: createManager({ router }) });
  createInstance(manager, "graph", "first");
  createInstance(manager, "graph", "second");
  ingestEvents(manager, [
    { instance: "first", frame: 1 },
    { instance: "first", frame: 2 },
    { instance: "second", frame: 3 },
    { instance: "second", frame: 4 },
  ]);
  const firstKey = instanceKeyOf("graph", "first");
  model.selectInstance(firstKey);

  const result = manager.clearInstance(firstKey);
  assert.equal(result?.categoryStale, true);
  assert.equal(result?.categoryReset, false);
  assert.equal(manager.storeFor(firstKey)?.recordCount, 0);
  assert.equal(manager.isCategoryStale("graph"), true);
  // 关键点：实例级清空**没有**偷偷调用分类级 replay/resetMain。
  assert.equal(consumer.resets, 0, "instance clear must not rebuild the category consumer");
  assert.equal(consumer.records.length, 4, "other instances' records are untouched");

  const replay = manager.replay("graph");
  assert.equal(replay?.applied, 2, "explicit category replay re-delivers only the remaining records");
  // 被清空实例的记录**确实**已从可用窗口消失（store.clear 抬高 maxEvicted），所以分类重建
  // 必须标 partial——这正是"实例级清空"与"分类级重建"边界不同的可见后果。
  assert.equal(replay?.partial, true);
  assert.equal(consumer.resets, 1);
  assert.equal(manager.isCategoryStale("graph"), false);
});

test("clearing the last instance of a category resets its consumer because the category is empty", () => {
  const router = new DebugRouter();
  const consumer = new RecordingConsumer("graph");
  router.register(consumer, "graph-facet");
  const manager = createManager({ router });
  createInstance(manager, "graph", "only");
  ingestEvents(manager, [{ frame: 1 }, { frame: 2 }]);

  const result = manager.clearInstance(instanceKeyOf("graph", "only"));
  assert.equal(result?.categoryReset, true);
  assert.equal(result?.categoryStale, false);
  assert.equal(manager.isCategoryStale("graph"), false);
  assert.equal(consumer.resets, 1);
});

test("a large timeline renders only a bounded window but keeps absolute positions", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  const inputs = [];
  for (let index = 0; index < 900; index += 1) {
    inputs.push({ frame: index, wireBytes: 8 });
  }

  ingestEvents(manager, inputs);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);

  const timeline = model.snapshot().timeline;
  assert.equal(timeline.records.length, DEBUG_PANEL_WINDOW_RECORDS);
  assert.equal(timeline.windowTruncated, true);
  assert.equal(timeline.records[0]?.position, 900 - DEBUG_PANEL_WINDOW_RECORDS);
  assert.equal(timeline.toPosition, 900);
  assert.equal(timeline.cursor, 900);
});

test("the record detail truncates oversized byte[] values instead of leaking them", () => {
  const huge = "A".repeat(4_000);
  const manager = createManager();
  createInstance(manager, "graph", "hero");
  manager.ingest(eventEnvelope({ frame: 3, value: huge, method: "Blob" }));
  const store = manager.storeFor(instanceKeyOf("graph", "hero"));
  const record = store?.records[0];
  assert.ok(record);

  const detail = detailOf(record);
  assert.equal(detail.truncated, true);
  const first = detail.args[0];
  assert.ok(first);
  assert.ok(first.preview.length <= DEBUG_PANEL_VALUE_PREVIEW_LIMIT + 24);
  assert.ok(detail.json.length < 1_000, `raw JSON must not carry the payload (${detail.json.length} chars)`);
  assert.ok(!detail.json.includes(huge));
  assert.equal(detail.namedOnly, true, "契约缺失 ⇒ 只列非默认值");
  assert.equal(detail.args[0]?.name, "nodeId");

  const small = previewValue("ok");
  assert.deepEqual(small, { text: "ok", truncated: false });
});

test("a finished instance keeps its records reachable for the panel", () => {
  const { model, manager } = createModel();
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  manager.ingest({
    type: "debugFinish",
    frame: 1,
    wireBytes: 6,
    payloadKind: BridgePayloadKind.Json,
    category: "graph",
    instance: "hero",
  });

  const snapshot = model.snapshot();
  const row = snapshot.instances.find((entry) => entry.key === key);
  assert.equal(row?.active, false);
  assert.equal(row?.endedReason, "finished");
  assert.equal(snapshot.timeline.records.length, 1, "实例结束后仍能回看已缓存记录");
});

test("refreshing the panel is a read-only window: it never replays and never re-requests from Unity", () => {
  const router = new DebugRouter();
  const consumer = new RecordingConsumer("graph");
  router.register(consumer, "graph-facet");
  const { model, manager } = createModel({ manager: createManager({ router }) });
  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1 }, { frame: 2 }, { frame: 3 }]);
  const key = instanceKeyOf("graph", "hero");
  model.selectInstance(key);
  const store = manager.storeFor(key);
  assert.ok(store);

  // 观测两个副作用：时间轴窗口读取的**起点**、分类重放次数。面板重绘**不应该**触发重放。
  const requests: number[] = [];
  const readWindow = store.recordsFrom.bind(store);
  store.recordsFrom = (position: number) => {
    requests.push(position);
    return readWindow(position);
  };
  let replays = 0;
  const replayCategory = manager.replay.bind(manager);
  manager.replay = (category: string) => {
    replays += 1;
    return replayCategory(category);
  };

  // "关掉再打开"在模型层就是再取几次快照：缓存来自 store，没有网络，也没有重建消费者。
  model.snapshot();
  requests.length = 0;
  model.snapshot();
  const oneRefresh = [...requests];
  requests.length = 0;
  for (let index = 0; index < 3; index += 1) {
    model.snapshot();
  }

  assert.ok(oneRefresh.length > 0);
  assert.deepEqual(requests, Array.from({ length: 3 }, () => oneRefresh).flat(),
    "稳定态下每次重绘的读取序列与第一次完全一致（幂等、不累积、不漂移）");
  assert.equal(replays, 0, "重绘绝不触发 replay（那会重建消费者，不是刷新）");
  assert.equal(consumer.records.length, 3, "消费者的投递次数不受面板刷新影响");
});
