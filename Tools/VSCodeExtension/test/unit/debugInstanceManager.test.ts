import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { BridgeChannel, BridgePayloadKind } from "../../src/bridge/framing";
import {
  DebugIngress,
  type DebugCreateEnvelope,
  type DebugEventEnvelope,
  type DebugFinishEnvelope,
  type DebugFrameEnvelope,
  type DebugResultEnvelope,
} from "../../src/bridge/debugIngress";
import { DebugContractRegistry, type DebugContractSnapshot } from "../../src/bridge/debugContractRegistry";
import {
  DEBUG_MAX_BYTES_GLOBAL,
  DEBUG_MAX_INSTANCES,
  DebugInstanceManager,
  debugInstanceKey,
} from "../../src/bridge/debugInstanceManager";
import { DebugRouter, type DebugConsumer } from "../../src/bridge/debugRouter";
import { DebugStore, type DebugRecord, type DebugRecordInput } from "../../src/bridge/debugStore";

const MEGABYTE = 1024 * 1024;

// .test-dist 比源码深一层：按编译输出深度解析仓库根，复用 TestData 的共享 fixture。
const repositoryRoot = path.resolve(__dirname, "../../../../..");
const unityProject = path.join(repositoryRoot, "TestData", "DebugContracts", "UnityProject");

/** `graph` 分类的契约（NodeStarted id 10 / Ticked id 11 / Query id 12）。 */
async function primaryContracts(): Promise<DebugContractSnapshot> {
  const set = await new DebugContractRegistry().load({ projectRoots: [unityProject] });
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  return snapshot;
}

function createEnvelope(
  instance: string,
  options: { readonly category?: string; readonly slot?: number; readonly resName?: string; readonly debugInfo?: string; readonly wireBytes?: number } = {},
): DebugCreateEnvelope {
  return {
    type: "debugCreate",
    frame: -1,
    wireBytes: options.wireBytes ?? 12,
    payloadKind: BridgePayloadKind.Json,
    category: options.category ?? "graph",
    instance,
    instanceSlot: options.slot ?? 1,
    resName: options.resName ?? "R",
    debugInfo: options.debugInfo ?? "",
  };
}

function eventEnvelope(
  instance: string,
  nodeId: number,
  options: {
    readonly category?: string;
    readonly frame?: number;
    readonly wireBytes?: number;
    readonly slot?: number;
    readonly instanceOverride?: string;
  } = {},
): DebugEventEnvelope {
  return {
    type: "debug",
    frame: options.frame ?? -1,
    wireBytes: options.wireBytes ?? 100,
    payloadKind: BridgePayloadKind.Json,
    category: options.category ?? "graph",
    instance: options.instanceOverride ?? instance,
    interfaceId: "IGraphDebuger",
    method: "NodeStarted",
    methodId: 0,
    instanceSlot: options.slot ?? 0,
    args: [{ tag: 1, type: "int", value: nodeId }],
    contractState: "unknown-interface",
  };
}

function finishEnvelope(instance: string, options: { readonly category?: string } = {}): DebugFinishEnvelope {
  return {
    type: "debugFinish",
    frame: -1,
    wireBytes: 8,
    payloadKind: BridgePayloadKind.Json,
    category: options.category ?? "graph",
    instance,
  };
}

function frameEnvelope(frame: number, wireBytes = 0): DebugFrameEnvelope {
  return { type: "debugFrame", frame, wireBytes, payloadKind: BridgePayloadKind.Json };
}

function recordLabel(record: DebugRecord): string {
  return `${record.method}#${String(record.args.get(1)?.value)}`;
}

/** 有状态假消费者：状态 = 已消费记录的有序列表，用于断言"关键帧 + 增量 == 全量重放"。 */
class RecordingConsumer implements DebugConsumer {
  public readonly categories: readonly string[];
  public consumed: string[] = [];
  public resets = 0;
  public throwOnConsume = false;
  public throwOnAccepts = false;
  public throwOnCapture = false;

  public constructor(categories: readonly string[]) {
    this.categories = categories;
  }

  public accepts(): boolean {
    if (this.throwOnAccepts) {
      throw new Error("accepts boom");
    }

    return true;
  }

  public consume(record: DebugRecord): void {
    if (this.throwOnConsume) {
      throw new Error("consumer boom");
    }

    this.consumed.push(recordLabel(record));
  }

  public reset(): void {
    this.resets += 1;
    this.consumed = [];
  }

  public captureState(): unknown {
    if (this.throwOnCapture) {
      throw new Error("capture boom");
    }

    return [...this.consumed];
  }

  public restoreState(state: unknown): boolean {
    this.consumed = [...(state as string[])];
    return true;
  }
}

/** 该分类当前所有可用记录，按**全局到达序**排列（全量重放的参照顺序）。 */
function allRecords(manager: DebugInstanceManager, category: string): readonly DebugRecord[] {
  const keys = new Set<string>();
  for (const view of manager.instances) {
    if (view.category === category) {
      keys.add(view.key);
    }
  }

  const records: DebugRecord[] = [];
  for (const key of keys) {
    const store = manager.storeFor(key);
    if (store !== undefined) {
      records.push(...store.records);
    }
  }

  return records.sort((left, right) => left.arrivalSeq - right.arrivalSeq);
}

/** 假定时器：记录每次排期的延迟，用来断言"补偿重试不是 0 延迟自旋"。 */
function fakeTimers(): {
  readonly delays: number[];
  readonly setTimer: (callback: () => void, timeoutMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
} {
  const delays: number[] = [];
  return {
    delays,
    setTimer: (_callback: () => void, timeoutMs: number): unknown => {
      delays.push(timeoutMs);
      return delays.length;
    },
    clearTimer: (_handle: unknown): void => undefined,
  };
}

test("a record is in the store before it is routed (fixed downstream order)", () => {
  const manager = new DebugInstanceManager();
  const key = debugInstanceKey("graph", "hero");
  const seen: Array<{ readonly inStore: boolean; readonly totalBytes: number }> = [];
  manager.router.register({
    categories: ["graph"],
    accepts: () => true,
    consume: (record) => {
      const store = manager.storeFor(key);
      seen.push({
        inStore: store !== undefined && store.records.some((candidate) => candidate.id === record.id),
        totalBytes: manager.totalBytes,
      });
    },
  });

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));

  // 若先路由后入 store，inStore 会是 false、totalBytes 会是 0。
  assert.deepEqual(seen, [{ inStore: true, totalBytes: 100 }]);
});

test("records are normalized with the contract-complete named table while args keeps only what arrived", async () => {
  const contracts = await primaryContracts();
  const ingress = new DebugIngress({ contracts });
  const manager = new DebugInstanceManager();
  const createJson = JSON.stringify({
    type: "debugCreate",
    category: "graph",
    instance: "hero",
    instanceSlot: 1,
    resName: "R",
    debugInfo: "",
  });
  const eventJson = JSON.stringify({
    type: "debug",
    category: "graph",
    instance: "hero",
    iface: "IGraphDebuger",
    method: "NodeStarted",
    args: [
      { tag: 1, name: "nodeId", type: "int", value: 5 },
      { tag: 3, name: "mode", type: "enum", value: 1 },
    ],
  });

  const ingest = (payload: string): readonly DebugRecord[] => {
    const records: DebugRecord[] = [];
    for (const envelope of ingress.acceptFrame({
      channel: BridgeChannel.Debug,
      payloadKind: BridgePayloadKind.Json,
      payload: Buffer.from(payload, "utf8"),
    })) {
      records.push(...manager.ingest(envelope, contracts));
    }

    return records;
  };

  ingest(createJson);
  const [record] = ingest(eventJson);
  assert.ok(record !== undefined);

  assert.equal(record.category, "graph");
  assert.equal(record.instanceId, "hero");
  assert.equal(record.interfaceId, "IGraphDebuger");
  assert.equal(record.method, "NodeStarted");
  assert.equal(record.contractState, "matched");
  // 记账单位只能是载荷字节（payloadLength），绝不能算上 6 字节帧头。
  assert.equal(record.wireBytes, Buffer.byteLength(eventJson, "utf8"));

  // args 只含线上实际到达的非默认参数（label 没到）。
  assert.deepEqual([...record.args.keys()], [1, 3]);
  // named 是按契约补齐默认值后的完整表：label 缺省为 string 默认值 ""。
  assert.deepEqual([...record.named.keys()], ["nodeId", "label", "mode"]);
  assert.equal(record.named.get("nodeId")?.value, 5);
  assert.equal(record.named.get("mode")?.value, 1);
  assert.deepEqual(record.named.get("label"), { tag: 2, name: "label", type: "string", value: "" });
});

test("a category-less Finish suppresses later records of any category", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });

  // 二进制 Finish 不带分类（debugIngress 的 category 缺省分支）。
  assert.equal(manager.finish(undefined, "ghost"), false);
  manager.ingest(eventEnvelope("ghost", 1, { category: "graph" }));
  manager.ingest(eventEnvelope("ghost", 2, { category: "entity" }));
  assert.equal(manager.counters.droppedAfterFinish, 2, "both categories are suppressed by the id-only Finish");
  assert.equal(manager.counters.pendingRecords, 0, "nothing was staged, so no placeholder can appear later");
  assert.equal(manager.instances.length, 0);

  // Create 仍是显式重建。
  manager.ingest(createEnvelope("ghost", { category: "entity" }));
  manager.ingest(eventEnvelope("ghost", 3, { category: "entity" }));
  assert.equal(manager.instances.length, 1);
  assert.equal(manager.storeFor(debugInstanceKey("entity", "ghost"))?.recordCount, 1);
});

test("a consumer that throws from accepts/consume never makes ingest throw", () => {
  const consumer = new RecordingConsumer(["graph"]);
  consumer.throwOnConsume = true;
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({ router });

  manager.ingest(createEnvelope("hero"));
  // 投递被 router 隔离：ingest 不抛，记录照常入 store（评审 8⑥① 的"写入-投递之间不可达"）。
  const records = manager.ingest(eventEnvelope("hero", 1));
  assert.equal(records.length, 1);
  assert.equal(manager.storeFor(debugInstanceKey("graph", "hero"))?.recordCount, 1);
  assert.equal(router.stats.errors, 1);
  assert.equal(router.stats.fallbackCategories[0], "graph");

  consumer.throwOnAccepts = true;
  consumer.throwOnConsume = false;
  const afterAccepts = manager.ingest(eventEnvelope("hero", 2));
  assert.equal(afterAccepts.length, 1, "accepts() throwing is isolated too");
  assert.equal(manager.storeFor(debugInstanceKey("graph", "hero"))?.recordCount, 2);
});

test("a throwing captureState skips the keyframe instead of breaking the record path", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 1, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  consumer.throwOnCapture = true;
  manager.ingest(createEnvelope("hero"));
  const records = manager.ingest(eventEnvelope("hero", 1));
  assert.equal(records.length, 1, "the record still lands even though the snapshot failed");
  assert.equal(manager.storeFor(debugInstanceKey("graph", "hero"))?.recordCount, 1);
  assert.equal(manager.keyframes.count("graph"), 0, "no unusable keyframe is stored (it would just eat the 64 slots)");
  assert.equal(router.stats.errors, 1);

  consumer.throwOnCapture = false;
  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.keyframes.count("graph"), 1, "capture works again as soon as the consumer recovers");
});

test("a failed staged replay keeps the remaining records instead of dropping the batch", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });
  const key = debugInstanceKey("graph", "ghost");

  // 记录先于 Create：两条进暂存。
  manager.ingest(eventEnvelope("ghost", 1));
  manager.ingest(eventEnvelope("ghost", 2));
  assert.equal(manager.counters.pendingRecords, 2);

  // 故障注入：补投时 store 写入抛错（真实代码里 appendRecord 不可抛，见 8⑥①；这里只验证"别丢批次"）。
  const { append } = DebugStore.prototype;
  let failures = 1;
  DebugStore.prototype.append = function patched(this: DebugStore, input: DebugRecordInput) {
    if (failures > 0) {
      failures -= 1;
      throw new Error("append boom");
    }

    return append.call(this, input);
  };
  try {
    assert.doesNotThrow(() => manager.ingest(createEnvelope("ghost")), "a failed replay must not escape ingest");
    assert.equal(manager.counters.pendingRecords, 2, "the unapplied records stay staged (the bucket is not dropped up front)");
    assert.equal(manager.storeFor(key)?.recordCount, 0);
  } finally {
    DebugStore.prototype.append = append;
  }

  // 重试：暂存定时器到期后补投到**已存在的**实例（绝不重复建实例）。
  manager.expirePending(clock + 2_000);
  assert.equal(manager.counters.pendingRecords, 0);
  assert.equal(manager.instances.length, 1);
  assert.equal(manager.storeFor(key)?.recordCount, 2);
});

test("a failing staged replay backs off instead of spinning on a zero-delay timer", () => {
  let clock = 0;
  const timers = fakeTimers();
  const manager = new DebugInstanceManager({
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    limits: { pendingTimeoutMs: 1_000 },
  });
  const key = debugInstanceKey("graph", "ghost");

  manager.ingest(eventEnvelope("ghost", 1));
  assert.deepEqual(timers.delays, [1_000], "the first attempt is due at firstAt + pendingTimeoutMs");

  const { append } = DebugStore.prototype;
  DebugStore.prototype.append = function patched(this: DebugStore) {
    throw new Error("append boom");
  };
  try {
    manager.ingest(createEnvelope("ghost"));
  } finally {
    DebugStore.prototype.append = append;
  }

  assert.equal(manager.counters.pendingRecords, 1);
  assert.equal(timers.delays[timers.delays.length - 1], 1_000, "the retry is rescheduled one full timeout later, never at 0");

  // 退避点之前不得重试（0 延迟会让这条立刻重跑并自旋）。
  clock = 600;
  manager.expirePending();
  assert.equal(manager.counters.pendingRecords, 1);
  assert.equal(manager.instances.length, 1);

  clock = 1_001;
  manager.expirePending();
  assert.equal(manager.counters.pendingRecords, 0);
  assert.equal(manager.storeFor(key)?.recordCount, 1);
});

test("a staged replay that throws after the write keeps the record without duplicating it", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });
  const key = debugInstanceKey("graph", "ghost");

  manager.ingest(eventEnvelope("ghost", 1));
  manager.ingest(eventEnvelope("ghost", 2));

  // 写后抛：记录已经进 store 才抛错（与"写前抛"是两条分支）。
  const { append } = DebugStore.prototype;
  let failures = 1;
  DebugStore.prototype.append = function patched(this: DebugStore, input: DebugRecordInput) {
    const record = append.call(this, input);
    if (failures > 0) {
      failures -= 1;
      throw new Error("post-write boom");
    }

    return record;
  };
  try {
    assert.doesNotThrow(() => manager.ingest(createEnvelope("ghost")));
    assert.equal(manager.storeFor(key)?.recordCount, 1, "the written record stays");
    assert.equal(manager.counters.pendingRecords, 1, "only the record that was not applied stays staged");
  } finally {
    DebugStore.prototype.append = append;
  }

  manager.expirePending(clock + 2_000);
  assert.equal(manager.counters.pendingRecords, 0);
  assert.deepEqual(
    manager.storeFor(key)?.records.map((record) => record.args.get(1)?.value),
    [1, 2],
    "the applied record is not replayed again (no duplicate, order preserved)",
  );
});

test("the 32 MB per-instance cap and the 128 MB global cap are enforced with exact accounting", () => {
  assert.equal(DEBUG_MAX_BYTES_GLOBAL, 128 * MEGABYTE);

  const single = new DebugInstanceManager();
  single.ingest(createEnvelope("hero"));
  for (let index = 0; index < 33; index += 1) {
    single.ingest(eventEnvelope("hero", index, { wireBytes: MEGABYTE }));
  }

  const singleStore = single.storeFor(debugInstanceKey("graph", "hero"));
  assert.ok(singleStore !== undefined);
  assert.equal(singleStore.recordCount, 32);
  assert.equal(singleStore.bytes, 32 * MEGABYTE);
  assert.equal(singleStore.earliestPosition, 1);
  assert.equal(single.totalBytes, 32 * MEGABYTE);

  // 5 个实例 × 26 MB = 130 MB：全局 128 MB 硬上限必须再淘汰 2 条，且计数精确。
  const global = new DebugInstanceManager();
  for (let index = 0; index < 5; index += 1) {
    global.ingest(createEnvelope(`hero${index}`, { slot: index + 1 }));
  }

  for (let round = 0; round < 26; round += 1) {
    for (let index = 0; index < 5; index += 1) {
      global.ingest(eventEnvelope(`hero${index}`, round, { wireBytes: MEGABYTE }));
    }
  }

  assert.equal(global.totalRecords, 128);
  assert.equal(global.totalBytes, 128 * MEGABYTE);
  assert.equal(global.counters.globalEvictions, 2);

  // 具体淘汰了哪两条：全局到达序最旧的两条（hero0 与 hero1 的第 1 条）。
  const perInstance = [0, 1, 2, 3, 4].map((index) => global.storeFor(debugInstanceKey("graph", `hero${index}`)));
  assert.ok(perInstance.every((store) => store !== undefined));
  assert.equal(perInstance[0]?.recordCount, 25, "hero0 lost its oldest record");
  assert.equal(perInstance[1]?.recordCount, 25, "hero1 lost its oldest record");
  assert.equal(perInstance[2]?.recordCount, 26);
  assert.equal(perInstance[0]?.oldest()?.arrivalSeq, 6, "the evicted records are the two globally oldest (seq 1 and 2)");
  assert.equal(perInstance[1]?.oldest()?.arrivalSeq, 7);
  assert.equal(perInstance[2]?.oldest()?.arrivalSeq, 3);

  let summed = 0;
  for (let index = 0; index < 5; index += 1) {
    const store = global.storeFor(debugInstanceKey("graph", `hero${index}`));
    assert.ok(store !== undefined);
    summed += store.bytes;
  }

  assert.equal(summed, global.totalBytes, "the global counter is exactly the sum of the per-instance counters");
});

test("a keyframe plus increments reproduces the full replay state", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  let clock = 0;
  const manager = new DebugInstanceManager({
    router,
    now: () => clock,
    limits: { keyframeIntervalRecords: 3, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });
  const category = "graph";

  manager.ingest(createEnvelope("hero"));
  for (let nodeId = 1; nodeId <= 5; nodeId += 1) {
    clock += 1;
    manager.ingest(eventEnvelope("hero", nodeId));
  }

  assert.deepEqual(consumer.consumed, [
    "NodeStarted#1",
    "NodeStarted#2",
    "NodeStarted#3",
    "NodeStarted#4",
    "NodeStarted#5",
  ]);
  assert.equal(manager.keyframes.count(category), 1);
  const keyframe = manager.keyframes.list(category)[0];
  assert.ok(keyframe !== undefined);
  // P1：关键帧必须在"记录应用之后"捕获，因此 seq 是 3、状态含前三条。
  assert.equal(keyframe.arrivalSeq, 3);
  assert.deepEqual(keyframe.state, ["NodeStarted#1", "NodeStarted#2", "NodeStarted#3"]);

  // 全量重放的参照状态：从 store 里按到达序吃一遍。
  const fromScratch = new RecordingConsumer(["graph"]);
  for (const record of allRecords(manager, category)) {
    fromScratch.consume(record);
  }

  const replay = manager.replay(category);
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, true);
  assert.equal(replay.keyframeId, keyframe.id);
  assert.equal(replay.fromArrivalSeq, 3);
  assert.equal(replay.applied, 2, "only the increment after the keyframe is replayed");
  assert.deepEqual(consumer.consumed, fromScratch.consumed);
  assert.equal(replay.partial, false);
});

test("a category keyframe plus increments equals the full replay even when two instances interleave", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  let clock = 0;
  const manager = new DebugInstanceManager({
    router,
    now: () => clock,
    limits: { keyframeIntervalRecords: 3, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });
  const category = "graph";

  manager.ingest(createEnvelope("a", { slot: 1 }));
  manager.ingest(createEnvelope("b", { slot: 2 }));
  // 交错到达：A1 B1 A2 A3 —— 关键帧由 A 的第 3 条触发，快照是**分类**状态（含 B1）。
  const before: ReadonlyArray<readonly [string, number]> = [
    ["a", 1],
    ["b", 1],
    ["a", 2],
    ["a", 3],
  ];
  for (const [instance, nodeId] of before) {
    clock += 1;
    manager.ingest(eventEnvelope(instance, nodeId));
  }

  const keyframe = manager.keyframes.list(category).at(-1);
  assert.ok(keyframe !== undefined);
  assert.equal(keyframe.arrivalSeq, 4, "the keyframe is captured after A3, the 4th record of the category");
  assert.deepEqual(keyframe.state, ["NodeStarted#1", "NodeStarted#1", "NodeStarted#2", "NodeStarted#3"]);

  // 关键帧之后来的是**另一个实例**的记录：按实例补增量会漏掉它，按分类补才不会。
  clock += 1;
  manager.ingest(eventEnvelope("b", 2));

  const expected = allRecords(manager, category).map(recordLabel);
  assert.deepEqual(expected, ["NodeStarted#1", "NodeStarted#1", "NodeStarted#2", "NodeStarted#3", "NodeStarted#2"]);

  const replay = manager.replay(category);
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, true);
  assert.equal(replay.applied, 1);
  assert.equal(replay.partial, false);
  assert.deepEqual(
    consumer.consumed,
    expected,
    "keyframe + increments must equal a full category replay, B2 included",
  );
});

test("a record staged before Create is not lost when another instance captured a keyframe in between", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  let clock = 0;
  const manager = new DebugInstanceManager({
    router,
    now: () => clock,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });
  const category = "graph";

  manager.ingest(createEnvelope("a", { slot: 1 }));
  // B 的记录**先到**且还没有 Create ⇒ 暂存（不分配 store 位置）。
  clock += 1;
  manager.ingest(eventEnvelope("b", 1));
  assert.equal(manager.counters.pendingRecords, 1);

  // 同一分类的 A 随后到达两条、触发关键帧：此刻 B1 还没被应用，快照里不该有它。
  clock += 1;
  manager.ingest(eventEnvelope("a", 1));
  clock += 1;
  manager.ingest(eventEnvelope("a", 2));

  // B 的 Create 迟到 ⇒ 补投 B1（它在关键帧**之后**才被应用）。
  clock += 1;
  manager.ingest(createEnvelope("b", { slot: 2 }));
  assert.equal(manager.counters.pendingRecords, 0);
  assert.equal(manager.storeFor(debugInstanceKey("graph", "b"))?.recordCount, 1);

  const expected = allRecords(manager, category).map(recordLabel);
  assert.deepEqual(expected, ["NodeStarted#1", "NodeStarted#2", "NodeStarted#1"]);

  const replay = manager.replay(category);
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, true);
  assert.equal(replay.partial, false);
  assert.deepEqual(
    consumer.consumed,
    expected,
    "the staged record was applied after the keyframe and must be in the increment",
  );
});

test("without a keyframe the replay resets the main consumer and replays from the earliest record", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  let clock = 0;
  const manager = new DebugInstanceManager({
    router,
    now: () => clock,
    limits: { keyframeIntervalRecords: 100 },
  });

  manager.ingest(createEnvelope("hero"));
  for (let nodeId = 1; nodeId <= 3; nodeId += 1) {
    clock += 1;
    manager.ingest(eventEnvelope("hero", nodeId));
  }

  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false);
  assert.equal(replay.fromArrivalSeq, 0);
  assert.equal(replay.applied, 3);
  assert.equal(replay.partial, false, "nothing was evicted, so a from-scratch replay is complete");
  assert.equal(consumer.resets, 1, "the main consumer is rebuilt from scratch");
  assert.deepEqual(consumer.consumed, ["NodeStarted#1", "NodeStarted#2", "NodeStarted#3"]);
});

test("a category without a registered consumer is not replayed (the generic view is never rewound)", () => {
  const manager = new DebugInstanceManager();

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));
  assert.equal(manager.replay("graph"), undefined);
  assert.equal(manager.router.observer.total, 1, "the generic view still holds the record");
});

test("changing the filter key invalidates every keyframe and replays from the start with partial", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  let clock = 0;
  const manager = new DebugInstanceManager({
    router,
    now: () => clock,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });
  const key = debugInstanceKey("graph", "hero");

  manager.ingest(createEnvelope("hero"));
  for (let nodeId = 1; nodeId <= 4; nodeId += 1) {
    clock += 1;
    manager.ingest(eventEnvelope("hero", nodeId));
  }

  assert.equal(manager.keyframes.count("graph"), 2);

  manager.setFilterKey("node=odd");

  const view = manager.instance(key);
  assert.ok(view !== undefined);
  assert.equal(view.keyframeCount, 0, "keyframes are bound to a filter key (C.4)");
  assert.equal(view.cursor.partial, true);
  assert.equal(manager.keyframes.size, 0);

  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false);
  assert.equal(replay.applied, 4);
  assert.equal(replay.partial, true, "a replay after a filter change is marked partial");
  assert.deepEqual(consumer.consumed, ["NodeStarted#1", "NodeStarted#2", "NodeStarted#3", "NodeStarted#4"]);
});

test("a resumed reconnect ends the old instances so a repeated Create starts a second record (C.3)", () => {
  let clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });

  manager.ingest(createEnvelope("hero", { resName: "HeroActor" }));
  manager.ingest(eventEnvelope("hero", 1));

  clock += 5_000;
  assert.equal(manager.reconnect(), 1);

  const old = manager.instances[0];
  assert.ok(old !== undefined);
  assert.equal(old.endedReason, "reconnect");
  assert.ok(old.endedAt !== undefined);
  assert.equal(old.active, false);
  assert.equal(old.recordCount, 1, "the old record keeps its content");

  // 运行时重连后重新 Create 同一个 ID：必须新建第二条实例记录，不能被当成重复 Create。
  manager.ingest(createEnvelope("hero", { resName: "HeroActor" }));
  assert.equal(manager.instances.length, 2);
  assert.equal(manager.counters.duplicateCreates, 0);

  const [first, second] = manager.instances;
  assert.equal(first?.endedReason, "reconnect");
  assert.equal(second?.active, true);

  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.instances[1]?.recordCount, 1, "new records land in the new instance record");
  assert.equal(manager.instances[0]?.recordCount, 1, "the old instance record is untouched");
});

test("an unmatched Finish suppresses later records instead of letting them build a placeholder", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });

  assert.equal(manager.finish("graph", "ghost"), false);
  manager.ingest(eventEnvelope("ghost", 1));
  assert.equal(manager.counters.droppedAfterFinish, 1);
  assert.equal(manager.counters.pendingRecords, 0, "it never enters the pending buffer");
  assert.equal(manager.instances.length, 0);

  // Create 是显式重建，仍可开工（C.3 的复用同名 id）。
  manager.ingest(createEnvelope("ghost"));
  manager.ingest(eventEnvelope("ghost", 2));
  assert.equal(manager.instances.length, 1);
  assert.equal(manager.storeFor(debugInstanceKey("graph", "ghost"))?.recordCount, 1);
});

test("retiring a whole instance raises the category floor, so its keyframe becomes unusable (P2-3)", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("a", { slot: 1 }));
  manager.ingest(eventEnvelope("a", 1));
  manager.ingest(eventEnvelope("a", 2));
  manager.ingest(eventEnvelope("a", 3));
  assert.deepEqual(manager.keyframes.list("graph").map((keyframe) => keyframe.arrivalSeq), [2]);

  // 32 个新实例把最久没动的 "a" 挤出去（整实例淘汰，`a` 的记录并未被逐条淘汰）。
  for (let index = 0; index < DEBUG_MAX_INSTANCES; index += 1) {
    manager.ingest(createEnvelope(`n${index}`, { slot: index + 2 }));
  }

  assert.equal(manager.storeFor(debugInstanceKey("graph", "a")), undefined, "'a' is retired (tombstone only)");
  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false, "the retired instance took records up to seq 3, past the keyframe at seq 2");
  assert.equal(replay.partial, true, "a from-scratch replay with evicted records must be marked partial");
  assert.equal(consumer.resets, 1);
});

test("retired floors and live-store floors combine when deciding a keyframe (P2-3)", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  let clock = 0;
  const manager = new DebugInstanceManager({
    router,
    now: () => clock,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("keep", { slot: 1 }));
  manager.ingest(createEnvelope("gone", { slot: 2 }));
  clock = 2;
  manager.ingest(eventEnvelope("keep", 1));
  clock = 2.5;
  manager.ingest(eventEnvelope("keep", 2));
  clock = 3;
  manager.ingest(eventEnvelope("gone", 1));
  clock = 4;
  manager.ingest(eventEnvelope("keep", 3));
  assert.deepEqual(manager.keyframes.list("graph").map((keyframe) => keyframe.arrivalSeq), [2]);

  // "gone" 最后活跃在 t=3，比 "keep"（t=4）旧：灌满实例表后它先被挤出，而 "keep" 活着。
  for (let index = 0; index < DEBUG_MAX_INSTANCES - 1; index += 1) {
    clock = 10 + index;
    manager.ingest(createEnvelope(`n${index}`, { slot: index + 3 }));
  }

  assert.equal(manager.storeFor(debugInstanceKey("graph", "gone")), undefined, "'gone' is retired");
  assert.ok(manager.storeFor(debugInstanceKey("graph", "keep")) !== undefined, "'keep' survives");
  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(
    replay.fromKeyframe,
    false,
    "the retired instance's seq 3 is above the keyframe at seq 2: the category floor must come from retiredMaxSeq too",
  );
  assert.equal(replay.partial, true);
});

test("clearing an instance's records also invalidates its keyframes (P2-3)", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));
  manager.ingest(eventEnvelope("hero", 2));
  manager.ingest(eventEnvelope("hero", 3));
  assert.deepEqual(manager.keyframes.list("graph").map((keyframe) => keyframe.arrivalSeq), [2]);

  const store = manager.storeFor(debugInstanceKey("graph", "hero"));
  assert.ok(store !== undefined);
  assert.equal(store.clear(), 300);
  assert.equal(store.maxEvictedArrivalSeq, 3, "clear() takes the cleared records out of the replay window");

  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false, "the keyframe at seq 2 sits below the floor of 3");
  assert.equal(replay.partial, true);
  assert.equal(replay.applied, 0);
  assert.equal(consumer.resets, 1);
});

test("changing the main consumer invalidates that category's keyframes (P2-5)", () => {
  const first = new RecordingConsumer(["graph"]);
  const second = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  const unregisterFirst = router.register(first, "first");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));
  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.keyframes.count("graph"), 1);
  assert.equal(manager.keyframes.list("graph")[0]?.consumerToken, router.ownerToken("graph"));

  // 注册一个不改变归属的消费者：不该白扔关键帧。
  router.register(second, "second");
  assert.equal(router.ownerFor("graph"), first);
  assert.equal(manager.keyframes.count("graph"), 1, "a registration that does not take ownership must not invalidate");

  // 第一个注销、第二个接位 ⇒ 旧快照属于旧消费者，必须作废。
  unregisterFirst();
  assert.equal(router.ownerFor("graph"), second);
  assert.equal(manager.keyframes.count("graph"), 0, "the snapshot belongs to the previous consumer and must be dropped");

  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false);
  assert.equal(replay.partial, false, "dropping a keyframe is not data loss: the full replay is complete here");
  assert.equal(second.resets, 1);
  assert.deepEqual(second.consumed, ["NodeStarted#1", "NodeStarted#2"], "the new consumer is rebuilt from scratch");
  assert.deepEqual(first.consumed, ["NodeStarted#1", "NodeStarted#2"], "the previous consumer is not touched by the replay");

  // 第二道防线：即使有一条属于旧消费者的关键帧还留在表里（例如表被外部塞过），replay 也必须拒绝它。
  const staleSeq = manager.storeFor(debugInstanceKey("graph", "hero"))?.endPosition ?? 0;
  manager.keyframes.capture({
    category: "graph",
    consumerToken: 1,
    consumerLabel: "first",
    filterKey: "",
    instanceKey: debugInstanceKey("graph", "hero"),
    instanceId: "hero",
    position: staleSeq,
    arrivalSeq: 0,
    bytes: 0,
    state: ["stale"],
  });
  const guarded = manager.replay("graph");
  assert.ok(guarded !== undefined);
  assert.equal(guarded.fromKeyframe, false, "a snapshot stamped with the previous consumer token is never restored");
  assert.deepEqual(second.consumed, ["NodeStarted#1", "NodeStarted#2"], "the stale snapshot was not restored into the new facet");
});

test("a keyframe captured after an owner change is never a half state (P1)", () => {
  const first = new RecordingConsumer(["graph"]);
  const second = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  const unregisterFirst = router.register(first, "first");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));
  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.keyframes.count("graph"), 1, "the first consumer's snapshot is complete");

  // 换主：`DebugRouter.register` 不补投历史 ⇒ second 的状态从空开始（缺 1、2）。
  unregisterFirst();
  router.register(second, "second");
  assert.equal(manager.keyframes.count("graph"), 0);

  // 换主后跨过阈值：旧实现会在这里把 second 的"半截状态"连同新 token 入表。
  manager.ingest(eventEnvelope("hero", 3));
  manager.ingest(eventEnvelope("hero", 4));
  assert.equal(manager.keyframes.count("graph"), 0, "a half state must never be stored as a baseline");

  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false);
  assert.equal(replay.partial, false, "no records were evicted: dropping the snapshot is not data loss");
  assert.deepEqual(
    second.consumed,
    allRecords(manager, "graph").map(recordLabel),
    "the new consumer ends up with the full-replay terminal state, including the pre-takeover records",
  );
  assert.deepEqual(second.consumed, ["NodeStarted#1", "NodeStarted#2", "NodeStarted#3", "NodeStarted#4"]);

  // 全量重建之后闸门打开：再跨阈值可以捕获，且此时确实是完整状态。
  manager.ingest(eventEnvelope("hero", 5));
  manager.ingest(eventEnvelope("hero", 6));
  assert.equal(manager.keyframes.count("graph"), 1, "after a successful full replay the gate reopens");
  const afterReopen = manager.replay("graph");
  assert.ok(afterReopen !== undefined);
  assert.equal(afterReopen.fromKeyframe, true);
  assert.deepEqual(second.consumed, allRecords(manager, "graph").map(recordLabel), "keyframe + increments == full replay");
});

test("changing the filter key closes the keyframe gate until a full replay (P1)", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));
  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.keyframes.count("graph"), 1);

  manager.setFilterKey("mode=slow");
  assert.equal(manager.keyframes.count("graph"), 0, "keyframes belong to the old filter key");
  manager.ingest(eventEnvelope("hero", 3));
  manager.ingest(eventEnvelope("hero", 4));
  assert.equal(manager.keyframes.count("graph"), 0, "the state was built under the old filter: no baseline yet");

  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false);
  assert.equal(replay.partial, true, "a changed filter key keeps the sticky partial flag (C.4)");
  assert.deepEqual(consumer.consumed, allRecords(manager, "graph").map(recordLabel));

  manager.ingest(eventEnvelope("hero", 5));
  manager.ingest(eventEnvelope("hero", 6));
  assert.equal(manager.keyframes.count("graph"), 1, "a successful full replay reopens the gate");
});

test("an instance retired for the floor also closes the gate until a full replay (P1)", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 2, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("a", { slot: 1 }));
  manager.ingest(eventEnvelope("a", 1));
  manager.ingest(eventEnvelope("a", 2));
  assert.equal(manager.keyframes.count("graph"), 1);

  for (let index = 0; index < DEBUG_MAX_INSTANCES; index += 1) {
    manager.ingest(createEnvelope(`n${index}`, { slot: index + 2 }));
  }

  assert.equal(manager.storeFor(debugInstanceKey("graph", "a")), undefined, "'a' is retired");
  assert.equal(manager.keyframes.count("graph"), 0, "the floor moved, so the captured snapshot is no longer the baseline");

  manager.ingest(eventEnvelope("n0", 1));
  manager.ingest(eventEnvelope("n0", 2));
  assert.equal(manager.keyframes.count("graph"), 0, "records past the floor do not reopen the gate by themselves");

  const replay = manager.replay("graph");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false);
  assert.equal(replay.partial, true);

  manager.ingest(eventEnvelope("n0", 3));
  manager.ingest(eventEnvelope("n0", 4));
  assert.equal(manager.keyframes.count("graph"), 1, "a successful full replay after the eviction reopens the gate");
});

test("a category reset by an instance clear keeps capturing keyframes (P2-7)", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({
    router,
    limits: { keyframeIntervalRecords: 1, keyframeIntervalBytes: Number.POSITIVE_INFINITY },
  });

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));
  assert.equal(manager.keyframes.count("graph"), 1);

  // 只有这一个实例：清空后该分类已无任何记录 ⇒ `categoryReset` 分支（resetMain + rebuilt = true）。
  const cleared = manager.clearInstance(debugInstanceKey("graph", "hero"));
  assert.equal(cleared?.categoryReset, true);
  assert.equal(manager.keyframes.count("graph"), 0);

  manager.ingest(eventEnvelope("hero", 2));
  // 这次下界抬高正是上面那次"已重置过的清空"造成的，必须被它吸收；否则 `rebuilt = true` 是一次性
  // 死代码，该分类本次会话再也捕不到关键帧（旧实现：这里会是 0）。
  assert.equal(manager.keyframes.count("graph"), 1, "the reset state is the new baseline; the gate must stay open");
});

test("a Create in one category does not lift an id-level Finish for other categories", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });
  assert.equal(manager.finish(undefined, "ghost"), false);

  // 另一个分类的显式 Create 只解禁它自己（评审 P2-a①）。
  manager.ingest(createEnvelope("ghost", { category: "entity" }));
  manager.ingest(eventEnvelope("ghost", 1, { category: "entity" }));
  assert.equal(manager.storeFor(debugInstanceKey("entity", "ghost"))?.recordCount, 1, "the re-created category works again");

  manager.ingest(eventEnvelope("ghost", 2, { category: "graph" }));
  assert.equal(manager.counters.droppedAfterFinish, 1, "another category with the same id stays suppressed");
  assert.equal(manager.counters.pendingRecords, 0, "it does not fall back into the pending buffer");
  assert.equal(manager.storeFor(debugInstanceKey("graph", "ghost")), undefined, "no placeholder is created for it");
});

test("a category-less Finish that empties a pending bucket also suppresses the same id elsewhere", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });
  manager.ingest(eventEnvelope("ghost", 1));
  assert.equal(manager.counters.pendingRecords, 1);

  assert.equal(manager.finish(undefined, "ghost"), true, "it hits the pending bucket");
  assert.equal(manager.counters.pendingRecords, 0);

  // 暂存桶只知道 graph，但 id 级抑制必须覆盖其它分类（评审 P2-a②）。
  manager.ingest(eventEnvelope("ghost", 2, { category: "entity" }));
  assert.equal(manager.counters.droppedAfterFinish, 1, "the same id is suppressed in every category");
  assert.equal(manager.counters.pendingRecords, 0);
  assert.equal(manager.instances.length, 0);
});

test("a floor raised in another category by global eviction closes that category's gate (P1 residual)", () => {
  let clock = 0;
  const graph = new RecordingConsumer(["graph"]);
  const entity = new RecordingConsumer(["entity"]);
  const router = new DebugRouter();
  router.register(entity, "entity");
  router.register(graph, "graph");
  const manager = new DebugInstanceManager({
    router,
    now: () => clock,
    limits: {
      keyframeIntervalRecords: 2,
      keyframeIntervalBytes: Number.POSITIVE_INFINITY,
      keyframeMaxPerCategory: 8,
      maxBytesGlobal: 250,
      maxBytesPerInstance: 1_000,
    },
  });
  const entityStore = (): ReturnType<typeof manager.storeFor> => manager.storeFor(debugInstanceKey("entity", "b"));

  // B（entity）两条记录 ⇒ 一份**完整**基线（状态 [b1, b2]）。
  manager.ingest(createEnvelope("b", { category: "entity", slot: 1 }));
  clock += 1;
  manager.ingest(eventEnvelope("b", 1, { category: "entity" }));
  clock += 1;
  manager.ingest(eventEnvelope("b", 2, { category: "entity" }));
  assert.equal(manager.keyframes.count("entity"), 1);

  // A（graph）的两次 append 撑破全局预算，先淘汰最旧的记录——它们是 B 的，不是 A 的。
  manager.ingest(createEnvelope("a", { category: "graph", slot: 2 }));
  clock += 1;
  manager.ingest(eventEnvelope("a", 1, { category: "graph" }));
  clock += 1;
  manager.ingest(eventEnvelope("a", 2, { category: "graph" }));
  assert.equal(entityStore()?.recordCount, 0, "the graph appends evicted both entity records");
  assert.equal(
    manager.keyframes.count("entity"),
    0,
    "the category whose floor moved loses its baseline even though it did not append itself",
  );

  // B 再跨阈值：它的 `floorBefore` 早在自己 append 之前就是新值，单看"我这个分类前后各比一次"看不出抬高。
  clock += 1;
  manager.ingest(eventEnvelope("b", 3, { category: "entity" }));
  clock += 1;
  manager.ingest(eventEnvelope("b", 4, { category: "entity" }));
  assert.equal(manager.keyframes.count("entity"), 0, "a state that still holds evicted records is never stored as a baseline");

  const replay = manager.replay("entity");
  assert.ok(replay !== undefined);
  assert.equal(replay.fromKeyframe, false, "there is no usable baseline left for this category");
  assert.deepEqual(
    entity.consumed,
    ["NodeStarted#3", "NodeStarted#4"],
    "the terminal state equals a full replay of the available window, not a superset of it",
  );
});

test("named fills the declared result and the enum default by wire type (C.2)", async () => {
  const contracts = await primaryContracts();
  const ingress = new DebugIngress({ contracts });
  const manager = new DebugInstanceManager();
  const createJson = JSON.stringify({
    type: "debugCreate",
    category: "graph",
    instance: "hero",
    instanceSlot: 1,
    resName: "R",
    debugInfo: "",
  });

  const ingestJson = (payload: string): readonly DebugRecord[] => {
    const records: DebugRecord[] = [];
    for (const envelope of ingress.acceptFrame({
      channel: BridgeChannel.Debug,
      payloadKind: BridgePayloadKind.Json,
      payload: Buffer.from(payload, "utf8"),
    })) {
      records.push(...manager.ingest(envelope, contracts));
    }

    return records;
  };

  ingestJson(createJson);
  // 只带 nodeId：label / mode 都是缺省参数，必须出现在 named 里但**不在** args 里。
  const [event] = ingestJson(JSON.stringify({
    type: "debug",
    category: "graph",
    instance: "hero",
    iface: "IGraphDebuger",
    method: "NodeStarted",
    args: [{ tag: 1, name: "nodeId", type: "int", value: 7 }],
  }));
  assert.ok(event !== undefined);
  assert.deepEqual([...event.named.keys()], ["nodeId", "label", "mode"]);
  assert.deepEqual([...event.args.keys()], [1], "args keeps only the parameters that actually arrived");
  assert.equal(event.named.get("mode")?.type, "enum");
  assert.equal(event.named.get("mode")?.value, 0, "an enum's default is 0 (B.2)");
  assert.equal(event.named.get("label")?.value, "");

  // 查询结果（tag 0）按契约里的 result.name 进 named；缺省时同样补类型默认值。
  const resultEnvelope: DebugResultEnvelope = {
    type: "debugResult",
    frame: -1,
    wireBytes: 20,
    payloadKind: BridgePayloadKind.Json,
    category: "graph",
    instance: "hero",
    interfaceId: "IGraphQuery",
    method: "Query",
    methodId: 12,
    instanceSlot: 0,
    requestId: "req-1",
    args: [{ tag: 0, type: "bool", value: true }],
    contractState: "matched",
  };
  const [answered] = manager.ingest(resultEnvelope, contracts);
  assert.ok(answered !== undefined);
  assert.equal(answered.named.get("matched")?.value, true);
  assert.equal(answered.named.get("matched")?.type, "bool");
  assert.equal(answered.args.get(0)?.value, true);

  const [unanswered] = manager.ingest({ ...resultEnvelope, requestId: "req-2", wireBytes: 12, args: [] }, contracts);
  assert.ok(unanswered !== undefined);
  assert.deepEqual(unanswered.named.get("matched"), { tag: 0, name: "matched", type: "bool", value: false });
  assert.equal(unanswered.args.size, 0);
});

test("the 33rd instance evicts by last-active time; its data frames are suppressed but Finish still applies", () => {
  assert.equal(DEBUG_MAX_INSTANCES, 32);
  let clock = 1_000;
  const manager = new DebugInstanceManager({ now: () => clock });
  for (let index = 0; index < 32; index += 1) {
    clock += 10;
    manager.ingest(createEnvelope(`hero${index}`, { slot: index + 1 }));
    clock += 1;
    manager.ingest(eventEnvelope(`hero${index}`, index));
  }

  const evictedKey = debugInstanceKey("graph", "hero0");
  clock += 10;
  manager.ingest(createEnvelope("hero32", { slot: 33 }));

  // 32 个保留实例 + 1 个"历史未记录"墓碑；被淘汰的是最后活跃时间最早的 hero0。
  assert.equal(manager.instances.length, 33);
  const evicted = manager.instance(evictedKey);
  assert.ok(evicted !== undefined);
  assert.equal(evicted.historyMissing, true);
  assert.equal(evicted.recordCount, 0);
  assert.equal(manager.storeFor(evictedKey), undefined);
  assert.equal(manager.instance(debugInstanceKey("graph", "hero32"))?.active, true);

  // 数据帧被抑制，且不得重建实例。
  clock += 1;
  manager.ingest(eventEnvelope("hero0", 99));
  assert.equal(manager.counters.droppedSuppressed, 1);
  assert.equal(manager.instances.length, 33);
  assert.equal(manager.instance(evictedKey)?.historyMissing, true);

  // Frame 永不抑制（C.4）。
  manager.ingest(frameEnvelope(77));
  assert.equal(manager.currentFrame, 77);

  // Finish 照常生效。
  clock += 1;
  assert.equal(manager.finish("graph", "hero0"), true);
  const finished = manager.instance(evictedKey);
  assert.ok(finished !== undefined);
  assert.equal(finished.endedReason, "finished");
  assert.ok(finished.endedAt !== undefined);
});

test("instance eviction uses last-active time, not creation order", () => {
  let clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock, limits: { maxInstances: 3 } });
  for (const instance of ["a", "b", "c"]) {
    clock += 10;
    manager.ingest(createEnvelope(instance, { slot: 1 }));
    clock += 1;
    manager.ingest(eventEnvelope(instance, 1));
  }

  // 再活跃一次 a：最后活跃顺序变成 b(最旧) < c < a，淘汰的必须是 b 而不是创建最早的 a。
  clock += 10;
  manager.ingest(eventEnvelope("a", 2));

  clock += 10;
  manager.ingest(createEnvelope("d", { slot: 2 }));

  assert.equal(manager.instance(debugInstanceKey("graph", "a"))?.historyMissing, false);
  assert.equal(manager.instance(debugInstanceKey("graph", "b"))?.historyMissing, true);
  assert.equal(manager.instance(debugInstanceKey("graph", "c"))?.historyMissing, false);
});

test("the selected instance is protected from instance-count eviction", () => {
  let clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock, limits: { maxInstances: 4 } });
  for (const instance of ["a", "b", "c", "d"]) {
    clock += 10;
    manager.ingest(createEnvelope(instance, { slot: 1 }));
    clock += 1;
    manager.ingest(eventEnvelope(instance, 1));
  }

  // 再活跃 c、d，最久没动的是 a；选中 a 后，淘汰必须落到 b。
  clock += 10;
  manager.ingest(eventEnvelope("c", 2));
  clock += 10;
  manager.ingest(eventEnvelope("d", 2));
  manager.select(debugInstanceKey("graph", "a"));

  clock += 10;
  manager.ingest(createEnvelope("e", { slot: 2 }));

  assert.equal(manager.instance(debugInstanceKey("graph", "a"))?.historyMissing, false, "the selected instance is protected");
  assert.equal(manager.instance(debugInstanceKey("graph", "b"))?.historyMissing, true);
  assert.equal(manager.instance(debugInstanceKey("graph", "e"))?.active, true);
});

test("records that arrive before Create are buffered, then a timed-out placeholder takes them", () => {
  let clock = 1_000;
  const manager = new DebugInstanceManager({ now: () => clock, limits: { pendingTimeoutMs: 500 } });
  const key = debugInstanceKey("graph", "hero");

  manager.ingest(eventEnvelope("hero", 1));
  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.instances.length, 0);
  assert.equal(manager.counters.pendingRecords, 2);

  clock += 400;
  manager.expirePending();
  assert.equal(manager.instances.length, 0, "still inside the 1 s window");

  clock += 200;
  manager.expirePending();
  const [placeholder] = manager.instances;
  assert.ok(placeholder !== undefined);
  assert.equal(placeholder.descriptorMissing, true);
  assert.equal(placeholder.recordCount, 2);
  assert.equal(manager.counters.placeholders, 1);
  assert.equal(manager.counters.pendingTimeouts, 1);

  // 迟到的 Create 补齐描述，而不是新建一条实例记录。
  manager.ingest(createEnvelope("hero", { slot: 3, resName: "HeroActor", debugInfo: "info" }));
  assert.equal(manager.instances.length, 1);
  const [upgraded] = manager.instances;
  assert.ok(upgraded !== undefined);
  assert.equal(upgraded.descriptorMissing, false);
  assert.equal(upgraded.resName, "HeroActor");
  assert.equal(upgraded.debugInfo, "info");
  assert.equal(upgraded.instanceSlot, 3);

  manager.ingest(eventEnvelope("hero", 3));
  assert.equal(manager.storeFor(key)?.recordCount, 3);
});

test("the pending buffer holds at most 64 records and then materializes a placeholder", () => {
  let clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });
  for (let nodeId = 0; nodeId < 65; nodeId += 1) {
    clock += 1;
    manager.ingest(eventEnvelope("hero", nodeId));
  }

  const [placeholder] = manager.instances;
  assert.ok(placeholder !== undefined);
  assert.equal(placeholder.descriptorMissing, true);
  assert.equal(placeholder.recordCount, 65);
  assert.equal(manager.counters.pendingRecords, 0);
});

test("the pending timer materializes a placeholder without another incoming envelope", async () => {
  const manager = new DebugInstanceManager({ limits: { pendingTimeoutMs: 10 } });
  manager.ingest(eventEnvelope("hero", 1));
  assert.equal(manager.instances.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 60));
  const [placeholder] = manager.instances;
  assert.ok(placeholder !== undefined);
  assert.equal(placeholder.descriptorMissing, true);
});

test("a record after Finish is dropped and never rebuilds the instance", () => {
  const clock = 5_000;
  const manager = new DebugInstanceManager({ now: () => clock });
  const key = debugInstanceKey("graph", "hero");

  manager.ingest(createEnvelope("hero"));
  manager.ingest(eventEnvelope("hero", 1));
  assert.equal(manager.finish("graph", "hero"), true);

  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.counters.droppedAfterFinish, 1);
  assert.equal(manager.instances.length, 1, "no placeholder / new instance may be created");
  assert.equal(manager.storeFor(key)?.recordCount, 1);
  assert.equal(manager.counters.pendingRecords, 0);
});

test("Finish before Create discards the pending records and suppresses later ones", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });

  manager.ingest(eventEnvelope("hero", 1));
  assert.equal(manager.counters.pendingRecords, 1);
  assert.equal(manager.finish("graph", "hero"), true);
  assert.equal(manager.counters.pendingRecords, 0);

  manager.ingest(eventEnvelope("hero", 2));
  assert.equal(manager.counters.droppedAfterFinish, 1);
  assert.equal(manager.instances.length, 0);
});

test("a Create after Finish starts a new instance record and keeps the old one", () => {
  const clock = 0;
  const manager = new DebugInstanceManager({ now: () => clock });
  const key = debugInstanceKey("graph", "hero");

  manager.ingest(createEnvelope("hero", { resName: "First" }));
  manager.ingest(eventEnvelope("hero", 1));
  manager.ingest(finishEnvelope("hero"));
  manager.ingest(createEnvelope("hero", { resName: "Second" }));

  const views = manager.instances;
  assert.equal(views.length, 2, "the finished instance keeps its record (C.3)");
  assert.equal(views[0]?.resName, "First");
  assert.ok(views[0]?.endedAt !== undefined);
  assert.equal(views[1]?.resName, "Second");
  assert.equal(views[1]?.active, true);

  manager.ingest(eventEnvelope("hero", 7));
  // storeFor 指向活动实例：新记录进新实例，旧实例的记录保持 1 条。
  assert.equal(manager.storeFor(key)?.recordCount, 1);
  assert.equal(views[0]?.recordCount, 1);
});

test("a duplicate Create keeps the first descriptor and only warns", () => {
  const manager = new DebugInstanceManager();
  manager.ingest(createEnvelope("hero", { resName: "First" }));
  manager.ingest(createEnvelope("hero", { resName: "Second" }));

  assert.equal(manager.instances.length, 1);
  assert.equal(manager.instances[0]?.resName, "First");
  assert.equal(manager.counters.duplicateCreates, 1);
});

test("Finish without a category resolves the instance by id", () => {
  const manager = new DebugInstanceManager();
  manager.ingest(createEnvelope("hero"));
  manager.ingest({ ...finishEnvelope("hero"), category: undefined });

  const [view] = manager.instances;
  assert.ok(view !== undefined);
  assert.ok(view.endedAt !== undefined);
});

test("reset clears instances, tombstones, pending records and consumer state", () => {
  const consumer = new RecordingConsumer(["graph"]);
  const router = new DebugRouter();
  router.register(consumer, "graph");
  const manager = new DebugInstanceManager({ router, limits: { maxInstances: 2 } });

  for (const instance of ["a", "b", "c"]) {
    manager.ingest(createEnvelope(instance));
    manager.ingest(eventEnvelope(instance, 1));
  }

  assert.equal(manager.instances.length, 3);
  assert.ok(manager.totalBytes > 0);

  manager.reset();
  assert.equal(manager.instances.length, 0);
  assert.equal(manager.totalBytes, 0);
  assert.equal(manager.counters.suppressed, 0);
  assert.equal(manager.currentFrame, -1);
  assert.deepEqual(consumer.consumed, []);
  assert.equal(router.stats.records, 0);
});

test("a frame envelope updates the current frame even before any instance exists", () => {
  const manager = new DebugInstanceManager();
  manager.ingest(frameEnvelope(9));
  assert.equal(manager.currentFrame, 9);
});
