import assert from "node:assert/strict";
import test from "node:test";
import {
  DebugQueryTracker,
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
  onTimeout?: (query: { readonly requestId: string }) => void;
} = {}): DebugQueryTracker {
  const clock = options.clock ?? manualClock();
  const timer = options.timer ?? manualTimer();
  return new DebugQueryTracker({
    now: () => clock.now(),
    setTimer: (callback, timeoutMs) => timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => timer.clearTimer(handle),
    ...(options.initialRequestSeq === undefined ? {} : { initialRequestSeq: options.initialRequestSeq }),
    ...(options.onTimeout === undefined ? {} : { onTimeout: options.onTimeout }),
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

test("the retired-id table is bounded so long sessions do not leak", () => {
  const tracker = trackerOf();
  for (let index = 0; index < MAX_RETIRED_REQUEST_IDS + 8; index++) {
    const request = tracker.createRequest({ instance: "hero", methodId: 10 });
    assert.notEqual(request, undefined);
    tracker.settle(request?.requestId ?? "", "result");
  }

  // 最老的号已被淘汰：不再算「已知请求号」，但也不会被重新分配（序号单调）。
  assert.equal(tracker.isKnownRequest(1), false);
  assert.equal(tracker.isKnownRequest(MAX_RETIRED_REQUEST_IDS + 8), true);
  const next = tracker.createRequest({ instance: "hero", methodId: 10 });
  assert.equal(next?.requestId, `req-${MAX_RETIRED_REQUEST_IDS + 9}`);
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
