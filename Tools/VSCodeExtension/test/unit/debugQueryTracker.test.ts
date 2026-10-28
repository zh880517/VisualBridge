import assert from "node:assert/strict";
import test from "node:test";
import {
  DebugQueryTracker,
  DEBUG_QUERY_RETIRED_TTL_MS,
  MAX_PENDING_QUERIES,
  MAX_RETIRED_REQUEST_IDS,
  QUERY_TIMEOUT_MS,
  parseRequestSeq,
} from "../../src/bridge/debugQueryTracker";

/**
 * 客户端查询挂起表（附录 A.5/A.6、E6）：`req-<n>` 分配与回收、并发 8、8 s 总超时、
 * 晚到结果丢弃、断连/实例取消。时钟与定时器全部注入，用例不依赖真实等待。
 */

interface ManualClock {
  now(): number;
  advance(ms: number): void;
}

function manualClock(start = 1000): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface ManualTimer {
  setTimer(callback: () => void, timeoutMs: number): unknown;
  clearTimer(handle: unknown): void;
  readonly armed: number;
  fire(handle: unknown): void;
  fireAll(): void;
}

function manualTimer(): ManualTimer {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 1;
  return {
    setTimer(callback: () => void): unknown {
      const handle = nextHandle++;
      handles.set(handle, callback);
      return handle;
    },
    clearTimer(handle: unknown): void {
      handles.delete(handle);
    },
    get armed(): number {
      return handles.size;
    },
    fire(handle: unknown): void {
      const callback = handles.get(handle);
      assert.notEqual(callback, undefined, `timer ${String(handle)} is not armed`);
      handles.delete(handle);
      callback?.();
    },
    fireAll(): void {
      const pending = [...handles.values()];
      handles.clear();
      for (const callback of pending) {
        callback();
      }
    },
  };
}

function trackerOf(options: {
  clock?: ManualClock;
  timer?: ManualTimer;
  initialRequestSeq?: number;
  requestSeqSpace?: number;
  maxPending?: number;
  onTimeout?: (query: { readonly requestId: string }) => void;
  log?: (message: string) => void;
} = {}): DebugQueryTracker {
  const clock = options.clock ?? manualClock();
  const timer = options.timer ?? manualTimer();
  return new DebugQueryTracker({
    now: () => clock.now(),
    setTimer: (callback, timeoutMs) => timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => timer.clearTimer(handle),
    ...(options.initialRequestSeq === undefined ? {} : { initialRequestSeq: options.initialRequestSeq }),
    ...(options.requestSeqSpace === undefined ? {} : { requestSeqSpace: options.requestSeqSpace }),
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    ...(options.onTimeout === undefined ? {} : { onTimeout: options.onTimeout }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}

test("allocates req-<n> ids that map onto the protocol u32 request ids", () => {
  const tracker = trackerOf();
  const first = tracker.createRequest({ instance: "hero", methodId: 10, category: "graph" });
  const second = tracker.createRequest({ instance: "hero", methodId: 10, category: "graph" });

  assert.equal(first?.requestId, "req-1");
  assert.equal(second?.requestId, "req-2");
  assert.equal(parseRequestSeq("req-1"), 1);
  assert.equal(tracker.isPendingRequest(parseRequestSeq(first?.requestId ?? "") ?? 0), true,
    "req-<n> 的 n 就是挂起表的二进制 u32 requestId");
  assert.equal(parseRequestSeq("req-0"), undefined, "0 保留，不作为请求号");
  assert.equal(parseRequestSeq("bis-1"), undefined);
  assert.equal(parseRequestSeq("req-x"), undefined);

  // 请求信封的形状：methodId 必须随请求走（A.5，E6），否则服务端无从分发。
  assert.deepEqual(first, {
    kind: "request",
    requestId: "req-1",
    action: "debugQuery",
    category: "graph",
    instance: "hero",
    methodId: 10,
    args: [],
  });
  assert.equal(tracker.pendingCount, 2);
  assert.equal(tracker.isPendingRequest(1), true);
  assert.equal(tracker.isPendingRequest(3), false);
});

test("caps in-flight queries at eight and rejects the ninth immediately", () => {
  assert.equal(MAX_PENDING_QUERIES, 8);
  const tracker = trackerOf();
  for (let index = 0; index < MAX_PENDING_QUERIES; index++) {
    assert.notEqual(tracker.createRequest({ instance: "hero", methodId: 10 }), undefined);
  }

  assert.equal(tracker.isBusy, true);
  assert.equal(tracker.createRequest({ instance: "hero", methodId: 10 }), undefined, "满员时不得排队，直接失败");
  assert.equal(tracker.metrics.busyRejected, 1);
  assert.equal(tracker.pendingCount, 8);

  // 结算一条后立刻有位置。
  assert.equal(tracker.settle("req-1", "result").status, "settled");
  assert.equal(tracker.isBusy, false);
  const next = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(next?.requestId, "req-9");
});

test("times out after eight seconds, drops the handle and reports late results", () => {
  const clock = manualClock();
  const timer = manualTimer();
  const timedOut: string[] = [];
  const tracker = trackerOf({ clock, timer, onTimeout: (query) => timedOut.push(query.requestId) });

  const request = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(QUERY_TIMEOUT_MS, 8000);
  assert.equal(timer.armed, 1);

  clock.advance(QUERY_TIMEOUT_MS - 1);
  assert.deepEqual(tracker.expireDue(), [], "未到 8 s 不得收敛");
  assert.equal(tracker.pendingCount, 1);

  clock.advance(1);
  assert.deepEqual(tracker.expireDue().map((query) => query.requestId), [request?.requestId]);
  assert.equal(tracker.pendingCount, 0);
  assert.equal(tracker.metrics.timedOut, 1);
  assert.deepEqual(timedOut, [request?.requestId], "超时回调只触发一次");
  assert.equal(timer.armed, 0, "超时后要清掉句柄的定时器");

  // 晚到结果：不再完成任何 Promise，只计入 lateResults（F6 的"入流但不完成"）。
  const late = tracker.settle(request?.requestId ?? "", "result");
  assert.equal(late.status, "late");
  assert.equal(tracker.metrics.lateResults, 1);
  assert.equal(tracker.metrics.results, 0);
  assert.equal(tracker.isPendingRequest(1), false);
  assert.equal(tracker.isKnownRequest(1), true, "已作废的号仍是「已知请求号」，用于识别晚到结果");
});

test("the timer path and the explicit expireDue path converge once", () => {
  const clock = manualClock();
  const timer = manualTimer();
  const tracker = trackerOf({ clock, timer });

  tracker.createRequest({ instance: "hero", methodId: 10 });
  timer.fire(1);
  assert.equal(tracker.metrics.timedOut, 1);

  // 定时器与显式驱动都触发时不得重复计数。
  clock.advance(QUERY_TIMEOUT_MS);
  assert.deepEqual(tracker.expireDue(), []);
  assert.equal(tracker.metrics.timedOut, 1);
});

test("settles one result/error per request and treats every repeat as late", () => {
  const tracker = trackerOf();
  tracker.createRequest({ instance: "hero", methodId: 10 });
  tracker.createRequest({ instance: "hero", methodId: 10 });

  const result = tracker.settle("req-1", "result");
  assert.equal(result.status, "settled");
  assert.equal(result.status === "settled" ? result.outcome : undefined, "result");
  assert.equal(tracker.settle("req-2", "error").status, "settled");
  assert.equal(tracker.metrics.results, 1);
  assert.equal(tracker.metrics.errors, 1);

  assert.equal(tracker.settle("req-1", "result").status, "late");
  assert.equal(tracker.metrics.lateResults, 1);
  assert.equal(tracker.settle("req-99", "result").status, "unknown");
  assert.equal(tracker.pendingCount, 0);
});

test("cancels in-flight queries on disconnect or instance finish", () => {
  const tracker = trackerOf();
  tracker.createRequest({ instance: "hero", methodId: 10 });
  tracker.createRequest({ instance: "hero", methodId: 10 });
  tracker.createRequest({ instance: "boss", methodId: 10 });

  assert.deepEqual(tracker.cancelInstance("hero").map((query) => query.requestId), ["req-1", "req-2"]);
  assert.equal(tracker.pendingCount, 1);
  assert.equal(tracker.isKnownRequest(1), true, "被取消的号仍是已知请求号（晚到结果丢弃）");

  assert.deepEqual(tracker.cancelAll().map((query) => query.requestId), ["req-3"]);
  assert.equal(tracker.pendingCount, 0);
  assert.equal(tracker.metrics.cancelled, 3);
});

test("request ids are not reused after u32 wrap-around", () => {
  const tracker = trackerOf({ initialRequestSeq: 0xffffffff });
  const last = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(last?.requestId, "req-4294967295");
  assert.equal(tracker.isPendingRequest(0xffffffff), true);

  // 回绕：下一个号从 1 重新开始，但绝不能复用仍然挂起的 0xffffffff。
  const wrapped = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(wrapped?.requestId, "req-1");
  assert.equal(tracker.isPendingRequest(0xffffffff), true);
});

test("the retired-id table is a TTL table with a safety cap so long sessions do not leak", () => {
  const logs: string[] = [];
  const tracker = trackerOf({ log: (message) => logs.push(message) });
  for (let index = 0; index < MAX_RETIRED_REQUEST_IDS + 8; index++) {
    const request = tracker.createRequest({ instance: "hero", methodId: 10 });
    assert.notEqual(request, undefined);
    tracker.settle(request?.requestId ?? "", "result");
  }

  // 时钟没前进 ⇒ 全部未过期；超过安全上限后淘汰最旧的号并**记日志**（不静默）。
  assert.equal(tracker.isKnownRequest(1), false);
  assert.equal(tracker.isKnownRequest(MAX_RETIRED_REQUEST_IDS + 8), true);
  assert.ok(
    logs.some((message) => /evicted the oldest unexpired id 1/u.test(message)),
    `安全上限淘汰必须记日志，实际：${JSON.stringify(logs.slice(0, 3))}`,
  );
  const next = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(next?.requestId, `req-${MAX_RETIRED_REQUEST_IDS + 9}`);
});

test("a retired id stays known for the 60 s TTL and is still classified as late", () => {
  const clock = manualClock();
  const timer = manualTimer();
  const tracker = trackerOf({ clock, timer });
  assert.equal(DEBUG_QUERY_RETIRED_TTL_MS, 60_000, "TTL 依据：客户端 8 s + 服务端 2 s/3 s，迟到结果 1–2 s 内到达");

  const request = tracker.createRequest({ instance: "hero", methodId: 10 });
  const requestSeq = parseRequestSeq(request?.requestId ?? "");
  assert.notEqual(requestSeq, undefined);
  clock.advance(QUERY_TIMEOUT_MS);
  assert.equal(tracker.expireDue().length, 1);
  assert.equal(tracker.isKnownRequest(requestSeq!), true);

  // TTL 内的迟到结果：必须识别为 late（丢弃 + 计数），绝不解码成事件的前提。
  clock.advance(DEBUG_QUERY_RETIRED_TTL_MS - 1);
  assert.equal(tracker.isKnownRequest(requestSeq!), true, "TTL 内仍必须识别");
  assert.equal(tracker.settle(request?.requestId ?? "", "result").status, "late");
  assert.equal(tracker.metrics.lateResults, 1);
  assert.equal(tracker.metrics.unknownSettlements, 0);
});

test("after the TTL the stale id stops settling and a newer request is never settled by the old result", () => {
  const clock = manualClock();
  const timer = manualTimer();
  const tracker = trackerOf({ clock, timer });

  const stale = tracker.createRequest({ instance: "hero", methodId: 10 });
  const staleId = stale?.requestId ?? "";
  clock.advance(QUERY_TIMEOUT_MS);
  tracker.expireDue();
  assert.equal(tracker.isKnownRequest(parseRequestSeq(staleId)!), true);

  // 把时间推过 TTL：惰性清理发生在下一次分配/结算/识别时（无后台定时器）。
  clock.advance(DEBUG_QUERY_RETIRED_TTL_MS);
  assert.equal(tracker.isKnownRequest(parseRequestSeq(staleId)!), false, "TTL 到期后不再当作已知请求号");
  assert.equal(tracker.settle(staleId, "result").status, "unknown");
  assert.equal(tracker.metrics.unknownSettlements, 1, "unknown 分支必须计数，不能只写日志");
  assert.equal(tracker.metrics.lateResults, 0);

  // 新请求（生产空间单调分配，必然拿到不同的号）不会被旧结果结算。
  const fresh = tracker.createRequest({ instance: "hero", methodId: 10 });
  const freshId = fresh?.requestId ?? "";
  assert.notEqual(freshId, staleId, "生产空间单调分配，TTL 清理不会让新请求复用旧号");
  assert.equal(tracker.settle(staleId, "result").status, "unknown");
  assert.equal(tracker.isPendingRequest(parseRequestSeq(freshId)!), true, "旧结果不得结算新请求");
  assert.equal(tracker.settle(freshId, "result").status, "settled");
  assert.equal(tracker.metrics.results, 1);
});

test("the default timer is unref'd so a pending query never keeps the process alive", () => {
  // 其他用例都注入假定时器，这里专门走默认 `setTimeout(...).unref()` 路径：
  // `getActiveResourcesInfo()` 只列出**仍在维持事件循环**的句柄，因此未 ref 的 8 s 定时器不会出现在里面。
  const timeouts = (): number => process.getActiveResourcesInfo().filter((item) => item === "Timeout").length;
  const before = timeouts();
  const tracker = new DebugQueryTracker();
  assert.notEqual(tracker.createRequest({ instance: "hero", methodId: 10 }), undefined);
  assert.equal(timeouts(), before, "挂起的 8 s 超时定时器必须 unref：否则扩展宿主要等 8 s 才能退出");
  tracker.cancelAll();
});

test("wrap-around reuses retired ids but never an in-flight id (injected tiny space)", () => {
  // 极小号空间只为在测试里制造回绕：生产是 u32，不可能靠分配次数走到回绕。
  const tracker = trackerOf({ requestSeqSpace: 3, maxPending: 2 });
  const first = tracker.createRequest({ instance: "hero", methodId: 10 });
  const second = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(first?.requestId, "req-1");
  assert.equal(second?.requestId, "req-2");
  tracker.settle("req-1", "result");
  tracker.settle("req-2", "result");

  const third = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(third?.requestId, "req-3");
  const wrapped = tracker.createRequest({ instance: "hero", methodId: 10 });
  // 空间 3：1/2 已作废、3 仍在途；只能回收作废号 1，绝不能抢仍在途的 3。
  assert.equal(wrapped?.requestId, "req-1");
  assert.equal(tracker.isPendingRequest(3), true);
  assert.equal(tracker.isPendingRequest(1), true);
  assert.equal(tracker.pendingCount, 2);
  assert.notEqual(wrapped?.requestId, third?.requestId, "回绕后的号不得与仍在途的号相同");
});

test("an undersized request-id space fails closed instead of stealing a live id", () => {
  const tracker = trackerOf({ requestSeqSpace: 2, maxPending: 3 });
  assert.equal(tracker.createRequest({ instance: "hero", methodId: 10 })?.requestId, "req-1");
  assert.equal(tracker.createRequest({ instance: "hero", methodId: 10 })?.requestId, "req-2");

  // 空间只有 2、两条都在途：宁可抛错（调用方转成发送失败），也不复用 req-1/req-2，
  // 否则晚到结果会被错误地关联到新的查询上（评审 P0 的红线）。
  assert.throws(
    () => tracker.createRequest({ instance: "hero", methodId: 10 }),
    /all 2 id\(s\) are in flight/u,
  );
  assert.equal(tracker.pendingCount, 2);
  assert.equal(tracker.isPendingRequest(1), true);
  assert.equal(tracker.isPendingRequest(2), true);
});
