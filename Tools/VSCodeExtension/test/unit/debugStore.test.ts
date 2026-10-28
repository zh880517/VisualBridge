import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBUG_KEYFRAME_INTERVAL_BYTES,
  DEBUG_KEYFRAME_INTERVAL_RECORDS,
  DEBUG_MAX_BYTES_PER_INSTANCE,
  DEBUG_MAX_RECORDS_PER_INSTANCE,
  DebugStore,
  groupRecordsByFrame,
  type DebugRecordInput,
  type DebugStoreLimits,
  type DebugStoreNotification,
} from "../../src/bridge/debugStore";

const MEGABYTE = 1024 * 1024;

/** 合成一条记录：容量记账只看 `wireBytes`，因此不需要真的分配载荷字节。 */
function input(
  wireBytes: number,
  options: { readonly frame?: number; readonly tag?: number; readonly receivedAt?: number } = {},
): DebugRecordInput {
  const tag = options.tag ?? 1;
  return {
    kind: "event",
    category: "graph",
    interfaceId: "IGraphDebuger",
    instanceId: "hero",
    method: "NodeStarted",
    args: new Map([[tag, { tag, type: "int", value: tag }]]),
    named: new Map(),
    frame: options.frame ?? -1,
    wireBytes,
    receivedAt: options.receivedAt ?? 0,
    contractState: "unknown-interface",
  };
}

/** `arrivalSeq` 由 store 在写入瞬间分配（外部不能自带，评审 P2-7）；这里按调用顺序递增。 */
function sequence(start = 1): () => number {
  let next = start;
  return () => {
    const value = next;
    next += 1;
    return value;
  };
}

function newStore(limits: Partial<DebugStoreLimits> = {}, nextArrivalSeq: () => number = sequence()): DebugStore {
  return new DebugStore({ instanceId: "hero", category: "graph", limits, nextArrivalSeq });
}

test("capacity constants are the ones fixed by appendix C.4", () => {
  assert.equal(DEBUG_MAX_BYTES_PER_INSTANCE, 32 * MEGABYTE);
  assert.equal(DEBUG_MAX_RECORDS_PER_INSTANCE, 20_000);
  assert.equal(DEBUG_KEYFRAME_INTERVAL_BYTES, MEGABYTE);
  assert.equal(DEBUG_KEYFRAME_INTERVAL_RECORDS, 2_000);
});

test("a 33rd megabyte evicts the oldest record and the byte count stays exact", () => {
  const store = newStore();
  for (let index = 0; index < 33; index += 1) {
    assert.ok(store.append(input(MEGABYTE)), `append #${index} should be accepted`);
  }

  // 33 MB 写入、32 MB 保留 ⇒ 只淘汰最旧一条；计数必须是精确值，不是"差不多"。
  assert.equal(store.recordCount, 32);
  assert.equal(store.bytes, 32 * MEGABYTE);
  assert.equal(store.earliestPosition, 1);
  assert.equal(store.records[0]?.id, 2, "the oldest record (#1) is the one dropped");
  assert.equal(store.records[31]?.id, 33);

  // 记账只按 wireBytes：再进 100 字节要再挤掉 1 MB，字节数 = 32 MB - 1 MB + 100。
  assert.ok(store.append(input(100)));
  assert.equal(store.bytes, 32 * MEGABYTE - MEGABYTE + 100);
  assert.equal(store.records[0]?.id, 3);
  assert.equal(store.recordCount, 32);
});

test("the 20000-record cap evicts the oldest record and keeps the count exact", () => {
  const store = newStore();
  for (let index = 0; index < 20_001; index += 1) {
    assert.ok(store.append(input(1)));
  }

  assert.equal(store.recordCount, 20_000);
  assert.equal(store.bytes, 20_000);
  assert.equal(store.earliestPosition, 1);
  assert.equal(store.records[0]?.id, 2);
});

test("a record larger than the whole instance budget is rejected instead of blowing the budget", () => {
  const store = newStore({ maxBytes: 100 });
  assert.equal(store.append(input(101)), undefined);
  assert.equal(store.oversizeDrops, 1);
  assert.equal(store.bytes, 0);
  assert.equal(store.append(input(100))?.id, 1, "ids do not advance for rejected records");
});

test("eviction removes the oldest records in arrival order and stops at the byte budget", () => {
  const store = newStore({ maxBytes: 100 });
  for (let index = 0; index < 5; index += 1) {
    store.append(input(10));
  }

  for (let index = 0; index < 8; index += 1) {
    store.append(input(10));
  }

  assert.equal(store.recordCount, 10);
  assert.equal(store.bytes, 100);
  assert.equal(store.earliestPosition, 3);
  assert.deepEqual(store.records.map((record) => record.id), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test("a cursor inside the evicted range is clamped to the earliest record and marked partial", () => {
  const store = newStore({ maxBytes: 100 });
  for (let index = 0; index < 5; index += 1) {
    store.append(input(10));
  }

  assert.deepEqual(store.applyCursor(1), { position: 1, partial: false });
  for (let index = 0; index < 8; index += 1) {
    store.append(input(10));
  }

  // 3 条被淘汰 ⇒ 最早可用位置是 3；游标原本在 1，必须夹到 3 并标 partial，而不是重置成 0。
  assert.equal(store.earliestPosition, 3);
  assert.deepEqual(store.cursor, { position: 3, partial: true });
  assert.deepEqual(store.step("record", 1), { position: 4, partial: true }, "stepping still works after the clamp");
  assert.deepEqual(store.step("record", -1), { position: 3, partial: true });
  assert.deepEqual(store.step("record", -1), { position: 3, partial: true }, "backwards clamp keeps the earliest record");
  assert.deepEqual(store.applyCursor(0), { position: 3, partial: true });
  assert.deepEqual(store.applyCursor(store.endPosition + 5), { position: 13, partial: true });
});

test("recordsFrom reports where it had to clamp instead of silently starting later", () => {
  const store = newStore({ maxBytes: 50 });
  for (let index = 0; index < 8; index += 1) {
    store.append(input(10));
  }

  assert.equal(store.earliestPosition, 3);
  const clamped = store.recordsFrom(0);
  assert.deepEqual(clamped.records.map((record) => record.id), [4, 5, 6, 7, 8]);
  assert.equal(clamped.requestedPosition, 0);
  assert.equal(clamped.fromPosition, 3, "the caller must be able to see that its request was clamped");
  assert.equal(clamped.partial, true);

  const aligned = store.recordsFrom(3);
  assert.equal(aligned.fromPosition, 3);
  assert.equal(aligned.partial, false, "a request inside the available range is complete");
  assert.deepEqual(aligned.records.map((record) => record.id), [4, 5, 6, 7, 8]);

  const tail = store.recordsFrom(6);
  assert.deepEqual(tail.records.map((record) => record.id), [7, 8]);
  assert.equal(tail.toPosition, store.endPosition);

  const past = store.recordsFrom(store.endPosition);
  assert.deepEqual(past.records, []);
  assert.equal(past.partial, false, "beyond the end is empty but not partial");
});

test("recordsFrom never reports a slice that starts after it ends", () => {
  const store = newStore();
  store.append(input(10));
  store.append(input(10));

  const past = store.recordsFrom(99);
  assert.deepEqual(past.records, [], "nothing lies beyond the end");
  assert.equal(past.requestedPosition, 99);
  assert.equal(past.fromPosition, store.endPosition, "the start is clamped to the end instead of the request");
  assert.equal(past.toPosition, store.endPosition);
  assert.ok(past.fromPosition <= past.toPosition, "a caller slicing [from, to) never gets a negative range");
  assert.equal(past.partial, false);
});

test("frame stepping groups contiguous equal frame numbers and never reorders them", () => {
  const store = newStore();
  const frames = [1, 1, 2, 2, 2, -1, -1, 1];
  for (const frame of frames) {
    store.append(input(10, { frame }));
  }

  assert.deepEqual(groupRecordsByFrame(store.records).map((group) => group.length), [2, 3, 2, 1]);
  assert.deepEqual(
    groupRecordsByFrame(store.records).map((group) => group[0]?.frame),
    [1, 2, -1, 1],
    "a repeated frame number that is not contiguous is a second group (C.7)",
  );

  store.applyCursor(0);
  assert.equal(store.step("frame", 1).position, 2);
  assert.equal(store.step("frame", 1).position, 5);
  assert.equal(store.step("frame", 1).position, 7);
  assert.equal(store.step("frame", 1).position, 8);
  assert.equal(store.step("frame", 1).position, 8, "the end clamps instead of throwing");

  assert.equal(store.step("frame", -1).position, 7);
  assert.equal(store.step("frame", -1).position, 5);
  assert.equal(store.step("frame", -1).position, 2);
  assert.equal(store.step("frame", -1).position, 0);
  assert.equal(store.step("frame", -1).position, 0);
});

test("record stepping moves exactly one record", () => {
  const store = newStore();
  for (let index = 0; index < 3; index += 1) {
    store.append(input(10));
  }

  assert.equal(store.step("record", 1).position, 1);
  assert.equal(store.step("record", 1).position, 2);
  assert.equal(store.step("record", 1).position, 3);
  assert.equal(store.step("record", 1).position, 3);
});

test("the keyframe trigger fires on the record threshold and resets after each capture", () => {
  const store = newStore({ keyframeIntervalRecords: 3, keyframeIntervalBytes: Number.POSITIVE_INFINITY });
  assert.equal(store.takeKeyframeTrigger(), false);

  store.append(input(10));
  assert.equal(store.takeKeyframeTrigger(), false);
  store.append(input(10));
  assert.equal(store.takeKeyframeTrigger(), false);
  store.append(input(10));
  assert.equal(store.takeKeyframeTrigger(), true, "the 3rd record reaches the 3-record threshold");
  assert.equal(store.takeKeyframeTrigger(), false, "the trigger is one-shot");
  assert.equal(store.endPosition, 3, "the trigger fires after the record has been appended");

  store.append(input(10));
  store.append(input(10));
  assert.equal(store.takeKeyframeTrigger(), false, "the counter restarted at the capture");
  store.append(input(10));
  assert.equal(store.takeKeyframeTrigger(), true, "another 3 records reach the threshold again");
});

test("the keyframe trigger also fires on the 1 MB byte threshold", () => {
  const store = newStore({ keyframeIntervalBytes: MEGABYTE, keyframeIntervalRecords: Number.POSITIVE_INFINITY });
  store.append(input(MEGABYTE - 1));
  assert.equal(store.takeKeyframeTrigger(), false);
  store.append(input(1));
  assert.equal(store.takeKeyframeTrigger(), true);
});

test("changing the filter key rewinds the cursor to the earliest record and marks it partial", () => {
  const store = newStore();
  for (let index = 0; index < 4; index += 1) {
    store.append(input(10));
  }

  store.applyCursor(4);
  assert.deepEqual(store.cursor, { position: 4, partial: false });

  assert.equal(store.setFilterKey("mode=slow"), true);
  assert.deepEqual(store.cursor, { position: 0, partial: true }, "the replay restarts from the earliest available record");
  assert.equal(store.setFilterKey("mode=slow"), false, "the same filter key is a no-op");
  // 关键帧本身按分类存放，失效由 DebugInstanceManager 执行（见 debugKeyframe.test.ts）。
});

test("maxEvictedArrivalSeq follows per-instance eviction, global eviction and clear", () => {
  // 分配器由测试控制：seq 1/2/3 与三条记录一一对应（store 自己不能收外部 seq，评审 P2-7）。
  const store = newStore({ maxBytes: 20 }, sequence(1));
  store.append(input(10));
  store.append(input(10));
  assert.equal(store.maxEvictedArrivalSeq, 0);

  store.append(input(10));
  assert.equal(store.maxEvictedArrivalSeq, 1, "the oldest record (seq 1) was evicted");

  store.evictOldest();
  assert.equal(store.maxEvictedArrivalSeq, 2, "global eviction also raises the floor");

  assert.equal(store.clear(), 10);
  assert.equal(store.maxEvictedArrivalSeq, 3, "clear() takes every remaining record out of the replay window");
});

test("append allocates the global arrival sequence itself, in write order", () => {
  const shared = sequence(100);
  const first = newStore({}, shared);
  const second = newStore({}, shared);

  const a = first.append(input(10));
  const b = second.append(input(10));
  const c = first.append(input(10));

  assert.deepEqual([a?.arrivalSeq, b?.arrivalSeq, c?.arrivalSeq], [100, 101, 102]);
  assert.deepEqual(first.records.map((record) => record.arrivalSeq), [100, 102], "per store it is still monotonic");
});

test("clear frees the budget, resets the cursor and keeps record ids monotonic", () => {
  const store = newStore();
  for (let index = 0; index < 5; index += 1) {
    store.append(input(10));
  }

  assert.equal(store.clear(), 50);
  assert.equal(store.recordCount, 0);
  assert.equal(store.bytes, 0);
  assert.equal(store.earliestPosition, 0);
  assert.deepEqual(store.cursor, { position: 0, partial: false });
  assert.equal(store.append(input(10))?.id, 6, "ids stay monotonic so consumers never see a reused id");
});

test("batch notifications coalesce appends and are flushed immediately by stepping", () => {
  const store = newStore({ notifyThrottleMs: 10_000 });
  const notifications: DebugStoreNotification[] = [];
  store.subscribe((notification) => notifications.push(notification));

  for (let index = 0; index < 3; index += 1) {
    store.append(input(10));
  }

  assert.equal(notifications.length, 0, "the batch window holds notifications back");
  store.flush();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.appended.length, 3);
  assert.deepEqual(notifications[0]?.changes, ["append"]);

  // 步进不得被节流压住，否则界面会"丢帧"（F2 §评审清单 P1）。
  store.applyCursor(1);
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications[1]?.cursor, { position: 1, partial: false });
  assert.ok(notifications[1]?.changes.includes("cursor"));
});

test("pause stops publishing but keeps storing, and resume delivers everything", () => {
  const store = newStore({ notifyThrottleMs: 10_000 });
  const notifications: DebugStoreNotification[] = [];
  store.subscribe((notification) => notifications.push(notification));

  store.pause();
  for (let index = 0; index < 3; index += 1) {
    store.append(input(10));
  }

  store.flush();
  assert.equal(notifications.length, 0, "paused means no UI refresh, not no storage");
  assert.equal(store.recordCount, 3, "records still land in the store while paused");

  store.resume();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.appended.length, 3, "resume flushes the whole backlog (no lost data)");
});

test("evicted records are reported in the notification batch", () => {
  const store = newStore({ maxBytes: 20, notifyThrottleMs: 10_000 });
  const notifications: DebugStoreNotification[] = [];
  store.subscribe((notification) => notifications.push(notification));

  store.append(input(10));
  store.append(input(10));
  store.flush();
  store.append(input(10));
  store.flush();

  assert.equal(notifications[1]?.evicted.length, 1);
  assert.equal(notifications[1]?.evicted[0]?.id, 1);
  assert.ok(notifications[1]?.changes.includes("evict"));
});

test("a throwing store listener does not stop the others", () => {
  const store = newStore();
  const seen: number[] = [];
  store.subscribe(() => {
    throw new Error("listener boom");
  });
  store.subscribe((notification) => seen.push(notification.appended.length));

  assert.ok(store.append(input(10)));
  store.flush();
  assert.deepEqual(seen, [1]);
});
