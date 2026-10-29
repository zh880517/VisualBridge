import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  BridgeChannel,
  BridgePayloadKind,
} from "../../src/bridge/framing";
import {
  DebugIngress,
  type DebugEnvelope,
  type DebugEventEnvelope,
  type DebugResultEnvelope,
  type DebugResponseEnvelope,
} from "../../src/bridge/debugIngress";
import { DebugContractRegistry, type DebugContractSnapshot } from "../../src/bridge/debugContractRegistry";
import { DebugInstanceManager, debugInstanceKey, type DebugInstanceView } from "../../src/bridge/debugInstanceManager";
import {
  DebugQueryClient,
  DebugQueryError,
  DEBUG_QUERY_ERROR_MESSAGES,
  debugQueryAvailability,
  debugQueryOwnsInstance,
  debugQueryUnresolvedError,
  resolveDebugQueryClient,
  type DebugQueryConnection,
  type DebugQueryNotice,
} from "../../src/bridge/debugQueryClient";
import {
  DEBUG_QUERY_ERROR_CODES,
  type DebugArg,
} from "../../src/bridge/debugMessages";
import { MAX_PENDING_QUERIES, QUERY_TIMEOUT_MS } from "../../src/bridge/debugQueryTracker";
import { groupRecordsByFrame } from "../../src/bridge/debugStore";

/** `.test-dist` 比源码深一层：按编译输出深度解析仓库根，复用 TestData 的共享 fixture。 */
const repositoryRoot = path.resolve(__dirname, "../../../../..");
const unityProject = path.join(repositoryRoot, "TestData", "DebugContracts", "UnityProject");

async function primaryContracts(): Promise<DebugContractSnapshot> {
  const set = await new DebugContractRegistry().load({ projectRoots: [unityProject] });
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  return snapshot;
}

/**
 * F6 查询客户端：并发 8、8 s 超时、晚到结果丢弃（验收 :43）+ 计数、7 个错误码、
 * 断连/切实例/实例结束三种取消文案、查询结果按发起帧进时间轴（P1）、
 * 线上二进制 `debugResult` 经挂起表变成 `queryResult` 记录。
 *
 * 时钟与定时器全部注入，用例不依赖真实等待。
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
  readonly scheduledDelays: readonly number[];
  fireAll(): void;
}

function manualTimer(): ManualTimer {
  const handles = new Map<unknown, () => void>();
  const delays: number[] = [];
  let nextHandle = 1;
  return {
    setTimer(callback: () => void, timeoutMs: number): unknown {
      delays.push(timeoutMs);
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
    get scheduledDelays(): readonly number[] {
      return delays;
    },
    fireAll(): void {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
  };
}

function resultEnvelope(
  requestId: string,
  options: { readonly frame?: number; readonly args?: readonly DebugArg[]; readonly wireBytes?: number } = {},
): DebugResultEnvelope {
  return {
    type: "debugResult",
    frame: options.frame ?? 7,
    wireBytes: options.wireBytes ?? 16,
    payloadKind: BridgePayloadKind.Json,
    category: "graph",
    instance: "hero",
    interfaceId: "IGraphDebuger",
    method: "NodeStarted",
    methodId: 10,
    instanceSlot: 1,
    requestId,
    args: options.args ?? [{ tag: 1, name: "nodeId", type: "int", value: 5 }],
    contractState: "unknown-interface",
  };
}

function responseEnvelope(requestId: string, code: string | undefined, detail?: string): DebugResponseEnvelope {
  return {
    type: "response",
    frame: 7,
    wireBytes: 32,
    payloadKind: BridgePayloadKind.Json,
    requestId,
    ok: false,
    code,
    detail,
  };
}

interface Harness {
  readonly client: DebugQueryClient;
  readonly sent: { requestId: string; methodId: number; instance: string; args: readonly DebugArg[] }[];
  readonly timer: ManualTimer;
  readonly clock: ManualClock;
  readonly appended: { requestId: string; frame: number }[];
}

function createHarness(overrides: {
  readonly appendResult?: (envelope: DebugResultEnvelope) => void;
  readonly maxPending?: number;
  readonly timeoutMs?: number;
  readonly sendResult?: boolean;
} = {}): Harness {
  const clock = manualClock();
  const timer = manualTimer();
  const sent: Harness["sent"] = [];
  const appended: { requestId: string; frame: number }[] = [];
  const client = new DebugQueryClient({
    now: () => clock.now(),
    setTimer: (callback, timeoutMs) => timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => timer.clearTimer(handle),
    resolveInstance: (instanceKey) => {
      const separator = instanceKey.indexOf("\u0000");
      return {
        category: separator >= 0 ? instanceKey.slice(0, separator) : "graph",
        instanceId: separator >= 0 ? instanceKey.slice(separator + 1) : instanceKey,
        active: true,
      };
    },
    resolveMethod: () => ({ methodId: 10 }),
    send: (request) => {
      sent.push({
        requestId: request.requestId,
        methodId: request.methodId,
        instance: request.instance,
        args: request.args,
      });
      return overrides.sendResult ?? true;
    },
    appendResult: (envelope, target) => {
      appended.push({ requestId: target.requestId, frame: target.frame });
      overrides.appendResult?.(envelope);
      return undefined;
    },
    ...(overrides.maxPending === undefined ? {} : { maxPending: overrides.maxPending }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  });
  return { client, sent, timer, clock, appended };
}

async function rejectionOf(promise: Promise<unknown>): Promise<DebugQueryError> {
  try {
    await promise;
  } catch (errorValue) {
    assert.ok(errorValue instanceof DebugQueryError, `expected DebugQueryError, got ${String(errorValue)}`);
    return errorValue;
  }

  assert.fail("expected the query promise to reject");
}

const INSTANCE = debugInstanceKey("graph", "hero");

test("the authoritative manifest exposes exactly seven query error codes and each maps to readable text", () => {
  assert.equal(DEBUG_QUERY_ERROR_CODES.length, 7);
  assert.deepEqual([...DEBUG_QUERY_ERROR_CODES].sort(), [
    "runtime.debugNotEnabled",
    "runtime.instanceNotFound",
    "runtime.invalidArgument",
    "runtime.queryBusy",
    "runtime.queryRejected",
    "runtime.queryTimeout",
    "runtime.queryUnregistered",
  ]);
  const messages = DEBUG_QUERY_ERROR_CODES.map((code) => DEBUG_QUERY_ERROR_MESSAGES[code]);
  assert.equal(new Set(messages).size, messages.length, "每条错误码的文案都不同");
  for (const message of messages) {
    assert.ok(message.length > 0);
  }
});

test("maps every authoritative query error code received in a server response onto its readable message", async () => {
  // provenance：7 个码**都**可能出现在服务端的 `response` 里（queryBusy 与 queryTimeout 是双来源），
  // 这里验证的是"服务端应答里的码"这条路，`generatedBy` 随之记 server。
  const harness = createHarness();
  for (const code of DEBUG_QUERY_ERROR_CODES) {
    const query = harness.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
    query.catch(() => undefined);
    const request = harness.sent[harness.sent.length - 1];
    assert.notEqual(request, undefined);
    assert.equal(harness.client.handleEnvelope(responseEnvelope(request!.requestId, code, "detail")), "settled");
    const error = await rejectionOf(query);
    assert.equal(error.code, code);
    assert.equal(error.message, DEBUG_QUERY_ERROR_MESSAGES[code]);
    assert.equal(error.generatedBy, "server", `${code} 出现在服务端 response 里就记 server（与码的归属无关）`);
    assert.equal(error.detail, "detail");
  }

  assert.equal(harness.client.pendingCount, 0);
});

test("a client timeout uses runtime.queryTimeout and is marked client-generated", async () => {
  const harness = createHarness();
  const query = harness.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  query.catch(() => undefined);
  assert.deepEqual(harness.timer.scheduledDelays, [QUERY_TIMEOUT_MS], "8 s 总超时（C.1）");

  harness.timer.fireAll();
  const error = await rejectionOf(query);
  assert.equal(error.code, "runtime.queryTimeout");
  assert.equal(error.message, DEBUG_QUERY_ERROR_MESSAGES["runtime.queryTimeout"]);
  assert.equal(error.generatedBy, "client");
  assert.equal(harness.client.pendingCount, 0);
  assert.equal(harness.client.metrics.timedOut, 1);
});

test("caps in-flight queries at eight and rejects the ninth immediately without sending", async () => {
  const harness = createHarness();
  const promises: Promise<unknown>[] = [];
  for (let index = 0; index < MAX_PENDING_QUERIES; index += 1) {
    const promise = harness.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
    promise.catch(() => undefined);
    promises.push(promise);
  }

  assert.equal(harness.sent.length, 8);
  assert.equal(harness.client.pendingCount, 8);
  assert.equal(harness.client.isBusy, true);

  const ninth = harness.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  ninth.catch(() => undefined);
  const error = await rejectionOf(ninth);
  assert.equal(error.code, "runtime.queryBusy");
  assert.equal(error.generatedBy, "client");
  assert.equal(harness.sent.length, 8, "上限时立即失败，不发请求、不排队");
  assert.equal(harness.client.pendingCount, 8);
  assert.equal(harness.client.metrics.busyRejected, 1);

  harness.client.cancelAll("dispose");
  await Promise.allSettled(promises);
});

test("a late result after the timeout is dropped, counted and never inserted (acceptance :43)", async () => {
  const harness = createHarness();
  const query = harness.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  query.catch(() => undefined);
  const requestId = harness.sent[0]?.requestId;
  assert.notEqual(requestId, undefined);

  harness.timer.fireAll();
  await rejectionOf(query);
  assert.equal(harness.client.pendingCount, 0);
  assert.equal(harness.timer.armed, 0, "超时后定时器句柄已清理");

  // 晚到结果：丢弃、不插时间轴，但必须可观测（计数 + 提示），不是静默。
  assert.equal(harness.client.handleEnvelope(resultEnvelope(requestId!)), "late");
  assert.equal(harness.appended.length, 0, "晚到结果不得插入时间轴");
  assert.equal(harness.client.metrics.lateResults, 1);
  assert.equal(harness.client.lastNotice?.kind, "warning");
  assert.match(harness.client.lastNotice?.message ?? "", /晚到/u);
});

test("P0: result and timeout racing in one tick settle exactly once and leave no timer behind", async () => {
  // 结果先到：Promise resolve，定时器被清掉；随后即使超时回调被强行触发也不会再 reject。
  const first = createHarness();
  let settlements = 0;
  const firstQuery = first.client.query(INSTANCE, "IGraphDebuger", "NodeStarted").finally(() => {
    settlements += 1;
  });
  firstQuery.catch(() => undefined);
  const firstRequest = first.sent[0]?.requestId;
  assert.equal(first.client.handleEnvelope(resultEnvelope(firstRequest!)), "settled");
  assert.equal(first.timer.armed, 0, "结算必须同时清掉超时句柄（否则 pending 泄漏 8 s）");
  await firstQuery;
  first.timer.fireAll();
  assert.equal(first.client.handleEnvelope(resultEnvelope(firstRequest!)), "late");
  assert.equal(first.appended.length, 1, "同一条结果只插入一次");
  assert.equal(settlements, 1, "Promise 只结算一次（不得既 resolve 又 reject）");
  assert.equal(first.client.pendingCount, 0);

  // 超时先到：Promise reject；同 tick 到达的结果按 late 丢弃，不插入。
  const second = createHarness();
  let secondSettlements = 0;
  const secondQuery = second.client.query(INSTANCE, "IGraphDebuger", "NodeStarted").finally(() => {
    secondSettlements += 1;
  });
  secondQuery.catch(() => undefined);
  const secondRequest = second.sent[0]?.requestId;
  second.timer.fireAll();
  await rejectionOf(secondQuery);
  assert.equal(second.client.handleEnvelope(resultEnvelope(secondRequest!)), "late");
  assert.equal(second.appended.length, 0);
  assert.equal(secondSettlements, 1);
  assert.equal(second.client.metrics.timedOut, 1);
  assert.equal(second.client.metrics.lateResults, 1);
});

test("disconnect, user cancellation and instance finish produce distinct readable prompts", async () => {
  const disconnected = createHarness();
  const d1 = disconnected.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  const d2 = disconnected.client.query(debugInstanceKey("graph", "boss"), "IGraphDebuger", "NodeStarted");
  d1.catch(() => undefined);
  d2.catch(() => undefined);
  disconnected.client.cancelAll("disconnect");
  const disconnectError = await rejectionOf(d1);
  await rejectionOf(d2);
  assert.equal(disconnectError.code, "local.disconnected");
  assert.match(disconnectError.message, /连接已断开/u);
  assert.equal(disconnected.client.pendingCount, 0);
  assert.equal(disconnected.timer.armed, 0);

  const switched = createHarness();
  const u1 = switched.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  u1.catch(() => undefined);
  switched.client.cancelInstance("hero", "user");
  const userError = await rejectionOf(u1);
  assert.equal(userError.code, "local.cancelled");
  assert.match(userError.message, /切换实例/u);
  assert.notEqual(userError.message, disconnectError.message);

  const finished = createHarness();
  const f1 = finished.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  f1.catch(() => undefined);
  const cancelled = finished.client.handleInstanceFinished("hero");
  assert.equal(cancelled.length, 1);
  const finishError = await rejectionOf(f1);
  assert.equal(finishError.code, "local.instanceFinished");
  assert.match(finishError.message, /实例已结束/u);
  assert.equal(finished.sent.length, 1, "实例结束后不重试（不会再次发送）");
});

test("local precondition and send failures never leave a pending entry or a timer behind", async () => {
  // 方法号缺失：连 request 都不发。
  const missingMethod = createHarness();
  const noMethod = new DebugQueryClient({
    now: () => missingMethod.clock.now(),
    setTimer: (callback, timeoutMs) => missingMethod.timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => missingMethod.timer.clearTimer(handle),
    resolveInstance: () => ({ category: "graph", instanceId: "hero", active: true }),
    send: () => true,
  });
  const unknown = noMethod.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  unknown.catch(() => undefined);
  const unknownError = await rejectionOf(unknown);
  assert.equal(unknownError.code, "local.unknownMethod");
  assert.equal(noMethod.pendingCount, 0);
  assert.equal(missingMethod.timer.armed, 0);

  // 发送失败：清挂起、清定时器，并允许下一条立即重试（不把本地失败拖成 8 s 忙）。
  const harness = createHarness({ sendResult: false });
  const failed = harness.client.query(INSTANCE, "IGraphDebuger", "NodeStarted");
  failed.catch(() => undefined);
  const sendError = await rejectionOf(failed);
  assert.equal(sendError.code, "local.sendFailed");
  assert.equal(harness.client.pendingCount, 0);
  assert.equal(harness.timer.armed, 0);
  assert.equal(harness.client.metrics.cancelled, 1);
});

test("P1: a result that arrives after the frame moved on keeps its issue frame and does not advance the frame boundary", async () => {
  const clock = manualClock();
  const manager = new DebugInstanceManager({ now: () => clock.now() });
  manager.create({ category: "graph", instanceId: "hero", instanceSlot: 1, resName: "R", debugInfo: "" });

  // 真的推进帧：7 → 8 → 9，每帧都有一条真实事件（不是只改 envelope.frame）。
  manager.ingest({ type: "debugFrame", frame: 7, wireBytes: 4, payloadKind: BridgePayloadKind.Json });
  manager.ingest(eventEnvelope(7));

  const timer = manualTimer();
  const sent: string[] = [];
  const client = new DebugQueryClient({
    now: () => clock.now(),
    setTimer: (callback, timeoutMs) => timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => timer.clearTimer(handle),
    resolveInstance: () => ({ category: "graph", instanceId: "hero", active: true }),
    resolveMethod: () => ({ methodId: 10 }),
    send: (request) => {
      sent.push(request.requestId);
      return true;
    },
    appendResult: (envelope, target) => manager.appendQueryResult(envelope, undefined, target.frame),
  });

  // 在帧 7 发起查询。
  assert.equal(manager.currentFrame, 7);
  const query = client.query(INSTANCE, "IGraphDebuger", "NodeStarted", [], { frame: manager.currentFrame });
  query.catch(() => undefined);

  // 结果到达前帧继续前进到 9（每一帧都有真实事件）。
  manager.ingest({ type: "debugFrame", frame: 8, wireBytes: 4, payloadKind: BridgePayloadKind.Json });
  manager.ingest(eventEnvelope(8));
  manager.ingest({ type: "debugFrame", frame: 9, wireBytes: 4, payloadKind: BridgePayloadKind.Json });
  manager.ingest(eventEnvelope(9));
  assert.equal(manager.currentFrame, 9);

  // 结果包络自己也带 frame=9（到达时的帧），但记录必须写发起帧 7。
  assert.equal(client.handleEnvelope(resultEnvelope(sent[0]!, { frame: 9 })), "settled");
  await query;

  const store = manager.storeFor(INSTANCE);
  assert.notEqual(store, undefined);
  const records = store!.records;
  assert.deepEqual(records.map((record) => record.frame), [7, 8, 9, 7], "记录帧：发起帧 7 在末尾，追加顺序不重排");
  assert.equal(records[records.length - 1]?.kind, "queryResult");
  assert.equal(records[records.length - 1]?.frame, 7, "结果记录用发起帧，不用到达帧");

  // 跨帧：不新增**帧号**边界（currentFrame 仍是 9，结果没有推帧），也不插回帧 7 的老组；
  // 它按追加顺序落到尾部，形成尾部 [7] 组。这就是"与同帧数据一起应用"在跨帧场景下的准确含义。
  assert.equal(manager.currentFrame, 9, "结果到达不得推进帧边界");
  const groups = groupRecordsByFrame(records);
  assert.deepEqual(
    groups.map((group) => group.map((record) => record.frame)),
    [[7], [8], [9], [7]],
    "四组：[7,8,9,7]；帧号回退/重复不重排（与 F3 一致）",
  );
  assert.deepEqual(groups[groups.length - 1]?.map((record) => record.kind), ["queryResult"], "7 号组在最后");
});

test("P1: a result arriving in the same frame shares its frame group (same-frame case only)", async () => {
  const clock = manualClock();
  const manager = new DebugInstanceManager({ now: () => clock.now() });
  manager.create({ category: "graph", instanceId: "hero", instanceSlot: 1, resName: "R", debugInfo: "" });
  manager.ingest({ type: "debugFrame", frame: 7, wireBytes: 4, payloadKind: BridgePayloadKind.Json });
  manager.ingest(eventEnvelope(7));
  assert.equal(manager.currentFrame, 7);

  const timer = manualTimer();
  const sent: string[] = [];
  const client = new DebugQueryClient({
    now: () => clock.now(),
    setTimer: (callback, timeoutMs) => timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => timer.clearTimer(handle),
    resolveInstance: () => ({ category: "graph", instanceId: "hero", active: true }),
    resolveMethod: () => ({ methodId: 10 }),
    send: (request) => {
      sent.push(request.requestId);
      return true;
    },
    appendResult: (envelope, target) => manager.appendQueryResult(envelope, undefined, target.frame),
  });

  const query = client.query(INSTANCE, "IGraphDebuger", "NodeStarted", [], { frame: manager.currentFrame });
  query.catch(() => undefined);
  assert.equal(client.handleEnvelope(resultEnvelope(sent[0]!, { frame: 7 })), "settled");
  await query;

  const store = manager.storeFor(INSTANCE);
  assert.notEqual(store, undefined);
  assert.deepEqual(store!.records.map((record) => record.kind), ["event", "queryResult"]);
  assert.deepEqual(store!.records.map((record) => record.frame), [7, 7]);
  assert.equal(groupRecordsByFrame(store!.records).length, 1, "同帧的事件与查询结果是一个帧组");

  store!.applyCursor(0);
  store!.step("frame", 1);
  assert.equal(store!.cursor.position, 2, "按帧步进一次跨过同帧的事件与查询结果");
});

test("live binary debugResult is attributed through the tracker and becomes a queryResult record", async () => {
  const contracts = await primaryContracts();
  const clock = manualClock();
  const manager = new DebugInstanceManager({ now: () => clock.now() });
  const timer = manualTimer();
  const sent: { requestId: string }[] = [];
  const client = new DebugQueryClient({
    now: () => clock.now(),
    setTimer: (callback, timeoutMs) => timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => timer.clearTimer(handle),
    resolveInstance: () => ({ category: "graph", instanceId: "hero", active: true }),
    resolveMethod: () => ({ methodId: 10 }),
    send: (request) => {
      sent.push({ requestId: request.requestId });
      return true;
    },
    appendResult: (envelope, target) => manager.appendQueryResult(envelope, contracts, target.frame),
  });
  const liveIngress = new DebugIngress({
    contracts,
    isPendingRequest: (requestSeq) => client.tracker.isPendingRequest(requestSeq),
    isKnownRequest: (requestSeq) => client.tracker.isKnownRequest(requestSeq),
  });

  for (const envelope of liveIngress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify({
      type: "debugCreate",
      category: "graph",
      instance: "hero",
      instanceSlot: 1,
      resName: "R",
      debugInfo: "",
    })),
  })) {
    manager.ingest(envelope, contracts);
  }

  for (const envelope of liveIngress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify({ type: "debugFrame", frame: 7 })),
  })) {
    manager.ingest(envelope, contracts);
  }

  const query = client.query(INSTANCE, "IGraphDebuger", "NodeStarted", [], { frame: 7 });
  query.catch(() => undefined);
  assert.equal(sent.length, 1);

  // 二进制 `debugResult`：u16 methodId + u16 slot + u32 requestId(1) + 参数区 tag1 int 5。
  const payload = Buffer.from("000a0001" + "00000001" + "00010200000005", "hex");
  const envelopes = liveIngress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload,
  });
  assert.equal(envelopes.length, 1);
  const result = envelopes[0];
  assert.equal(result?.type, "debugResult");
  if (result?.type !== "debugResult") {
    assert.fail("expected a debugResult envelope");
  }

  assert.equal(result.requestId, sent[0]!.requestId);
  assert.equal(result.interfaceId, "IGraphDebuger");
  assert.equal(result.method, "NodeStarted");
  assert.equal(client.handleEnvelope(result), "settled");
  await query;

  const store = manager.storeFor(INSTANCE);
  assert.notEqual(store, undefined);
  assert.equal(store!.recordCount, 1);
  assert.equal(store!.records[0]?.kind, "queryResult");
  assert.equal(store!.records[0]?.frame, 7);
  assert.equal(store!.records[0]?.method, "NodeStarted");
  assert.equal(store!.records[0]?.args.get(1)?.value, 5);
  assert.equal(client.metrics.results, 1);
  assert.equal(liveIngress.counters.ambiguousMessages, 0, "有挂起表时不得退化成 ambiguousEnvelope");
});

test("regression P2-1: an old timed-out id is never squeezed out by later settlements (late, not a garbage event)", async () => {
  const contracts = await primaryContracts();
  const clock = manualClock();
  const manager = new DebugInstanceManager({ now: () => clock.now() });
  const timer = manualTimer();
  const notices: DebugQueryNotice[] = [];
  const sent: string[] = [];
  const client = new DebugQueryClient({
    now: () => clock.now(),
    setTimer: (callback, timeoutMs) => timer.setTimer(callback, timeoutMs),
    clearTimer: (handle) => timer.clearTimer(handle),
    // 首个请求号 0x00010203：字节 00 01 02 03 在"把 requestId 当参数区解"时正好是
    // tag=1 / type=int / value 高字节 0x03 ⇒ 会解出一条垃圾 int 参数（评审观察到的形态）。
    initialRequestSeq: 0x00010203,
    resolveInstance: (instanceKey) => {
      const separator = instanceKey.indexOf("\u0000");
      return {
        category: separator >= 0 ? instanceKey.slice(0, separator) : "graph",
        instanceId: separator >= 0 ? instanceKey.slice(separator + 1) : instanceKey,
        active: true,
      };
    },
    resolveMethod: () => ({ methodId: 10 }),
    send: (request) => {
      sent.push(request.requestId);
      return true;
    },
    appendResult: (envelope, target) => manager.appendQueryResult(envelope, contracts, target.frame),
    onNotice: (notice) => notices.push(notice),
  });
  const ingress = new DebugIngress({
    contracts,
    isPendingRequest: (requestSeq) => client.tracker.isPendingRequest(requestSeq),
    isKnownRequest: (requestSeq) => client.tracker.isKnownRequest(requestSeq),
  });

  for (const envelope of jsonFrames(ingress, {
    type: "debugCreate",
    category: "graph",
    instance: "hero",
    instanceSlot: 1,
    resName: "R",
    debugInfo: "",
  })) {
    manager.ingest(envelope, contracts);
  }

  for (const envelope of jsonFrames(ingress, { type: "debugFrame", frame: 7 })) {
    manager.ingest(envelope, contracts);
  }

  const stale = client.query(INSTANCE, "IGraphDebuger", "NodeStarted", [], { frame: 7 });
  stale.catch(() => undefined);
  const staleId = sent[0];
  assert.equal(staleId, "req-66051");
  timer.fireAll();
  await rejectionOf(stale);
  assert.equal(client.metrics.timedOut, 1);

  // 再结算 64 条：旧的"作废表上限 64 条"实现会把 staleId 挤出识别表。
  for (let index = 0; index < 64; index += 1) {
    const query = client.query(INSTANCE, "IGraphDebuger", "NodeStarted", [], { frame: 7 });
    query.catch(() => undefined);
    const requestId = sent[sent.length - 1];
    assert.notEqual(requestId, undefined);
    assert.equal(client.handleEnvelope(resultEnvelope(requestId!, { frame: 7 })), "settled");
    await query;
  }

  const store = manager.storeFor(INSTANCE);
  assert.notEqual(store, undefined);
  const before = store!.recordCount;
  assert.equal(before, 64, "64 条结算结果各插入一条 queryResult 记录");

  // 迟到的二进制 debugResult：methodId=10、slot=1、requestId=0x00010203（req-66051）、参数 tag1 int 0x00010101。
  const payload = Buffer.from("000a0001" + "00010203" + "00010200010101", "hex");
  const decoded = ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload,
  });
  const decodedSummary = decoded
    .map((envelope) => envelope.type === "debug" || envelope.type === "debugResult"
      ? `${envelope.type}(method=${envelope.method ?? "-"}, args=${JSON.stringify(envelope.args)})`
      : envelope.type)
    .join(",");

  assert.equal(decoded.length, 1);
  for (const envelope of decoded) {
    if (envelope.type === "debugResult") {
      assert.equal(client.handleEnvelope(envelope), "late");
    } else if (envelope.type === "debug") {
      // 修复前走的就是这条路：垃圾参数被当成真实事件写进时间轴。
      manager.ingest(envelope, contracts);
    }
  }

  const inserted = store!.records.slice(before).map((record) => ({
    kind: record.kind,
    method: record.method,
    args: [...record.args.entries()],
  }));
  assert.deepEqual(
    inserted,
    [],
    `迟到结果不得插入时间轴，实际插入 ${JSON.stringify(inserted)}；解码=${decodedSummary}`,
  );
  assert.equal(
    client.tracker.isKnownRequest(0x00010203),
    true,
    "TTL 表不得被 64 条结算挤出：否则迟到结果会被解成垃圾事件",
  );
  assert.equal(client.metrics.lateResults, 1, `迟到结果必须计入 lateResults；解码=${decodedSummary}`);
  assert.equal(
    notices.some((notice) => notice.kind === "warning" && /晚到/u.test(notice.message)),
    true,
    `迟到结果必须给 warning，实际：${JSON.stringify(notices)}`,
  );
});

test("P2-3: a query is routed to the connection that owns the instance (two live connections)", async () => {
  const contracts = await primaryContracts();
  const clock = manualClock();

  const manager = new DebugInstanceManager({ now: () => clock.now() });
  const ingressOne = new DebugIngress({ contracts });
  const ingressTwo = new DebugIngress({ contracts });
  const feedCreate = (ingress: DebugIngress, category: string, instance: string): void => {
    for (const envelope of jsonFrames(ingress, {
      type: "debugCreate",
      category,
      instance,
      instanceSlot: 1,
      resName: "R",
      debugInfo: "",
    })) {
      manager.ingest(envelope, contracts);
    }
  };
  feedCreate(ingressOne, "graph", "hero");
  feedCreate(ingressTwo, "entity", "boss");

  const sentOne: string[] = [];
  const sentTwo: string[] = [];
  const resolveInstance = (instanceKey: string) => {
    const separator = instanceKey.indexOf("\u0000");
    return {
      category: separator >= 0 ? instanceKey.slice(0, separator) : "",
      instanceId: separator >= 0 ? instanceKey.slice(separator + 1) : instanceKey,
      active: true,
    };
  };
  const clientOf = (sent: string[]): DebugQueryClient => new DebugQueryClient({
    now: () => clock.now(),
    resolveInstance,
    resolveMethod: () => ({ methodId: 10 }),
    send: (request) => {
      sent.push(request.requestId);
      return true;
    },
  });
  const clientOne = clientOf(sentOne);
  const clientTwo = clientOf(sentTwo);

  const connections: readonly DebugQueryConnection[] = [
    { client: clientOne, owns: (instance) => debugQueryOwnsInstance(ingressOne.slotRegistry, instance) },
    { client: clientTwo, owns: (instance) => debugQueryOwnsInstance(ingressTwo.slotRegistry, instance) },
  ];

  const viewA = manager.instance(debugInstanceKey("graph", "hero"));
  const viewB = manager.instance(debugInstanceKey("entity", "boss"));
  assert.notEqual(viewA, undefined);
  assert.notEqual(viewB, undefined);

  const routeA = resolveDebugQueryClient(viewA, connections);
  assert.equal(routeA.status, "ready", "实例 A 必须唯一归属连接 1");
  assert.equal(routeA.status === "ready" ? routeA.client : undefined, clientOne);

  const keyA = debugInstanceKey("graph", "hero");
  const queryA = (routeA.status === "ready" ? routeA.client : clientTwo).query(
    keyA,
    "IGraphDebuger",
    "NodeStarted",
    [],
    { frame: 7 },
  );
  queryA.catch(() => undefined);
  assert.deepEqual(sentOne, ["req-1"], "帧必须从连接 1 发出");
  assert.deepEqual(sentTwo, [], "绝不能从连接 2 发出");

  const routeB = resolveDebugQueryClient(viewB, connections);
  assert.equal(routeB.status === "ready" ? routeB.client : undefined, clientTwo, "实例 B 属于连接 2");
  const keyB = debugInstanceKey("entity", "boss");
  const b1 = clientTwo.query(keyB, "IEntityDebuger", "Spawned", [], { frame: 7 });
  const b2 = clientTwo.query(keyB, "IEntityDebuger", "Spawned", [], { frame: 7 });
  b1.catch(() => undefined);
  b2.catch(() => undefined);

  // 状态按实例所属连接算：A 的口径只有连接 1 的那 1 条在途，不混入连接 2 的 2 条。
  const stateA = debugQueryAvailability(routeA.status === "ready" ? routeA.client : undefined);
  const stateB = debugQueryAvailability(routeB.status === "ready" ? routeB.client : undefined);
  assert.equal(stateA.available, true);
  assert.equal(stateA.pending, 1, "实例 A 的 available/pending 只反映连接 1");
  assert.equal(stateB.available, true);
  assert.equal(stateB.pending, 2, "实例 B 的 available/pending 只反映连接 2");
  assert.notEqual(stateA.pending, stateB.pending + 1, "不得把两条连接的在途混算");

  // 两条连接都持同一实例（两个 Unity 工程同 id）：不猜，抛给调用方明确报错。
  const ingressTwoDuplicate = new DebugIngress({ contracts });
  feedCreate(ingressTwoDuplicate, "graph", "hero");
  const duplicateConnection: DebugQueryConnection = {
    client: clientTwo,
    owns: (instance) => debugQueryOwnsInstance(ingressTwoDuplicate.slotRegistry, instance),
  };
  const ambiguous = resolveDebugQueryClient(viewA, [connections[0]!, duplicateConnection]);
  assert.equal(ambiguous.status, "ambiguous", "多个归属不得任选一个");
  assert.equal(debugQueryAvailability(undefined).available, false, "无法归属时该实例不可查询");

  // 实例 A 的原连接已断、只剩连接 2：不得回退到唯一存活连接（否则又把查询发错连接）。
  const orphaned = resolveDebugQueryClient(viewA, [connections[1]!]);
  assert.equal(orphaned.status, "noOwner", "没有存活连接持有该实例时不猜");

  for (const client of [clientOne, clientTwo]) {
    client.cancelAll("dispose");
  }

  await Promise.allSettled([queryA, b1, b2]);
});

test("E10: noOwner and ambiguous surfacing distinct local codes and texts", () => {
  // 单连接、实例无主（原连接已断）与"多条连接互相歧义"是两回事：旧文案把两者都说成"多连接同时在线"，
  // 排障会被带偏（实测单连接也报这句）。这里锁住两种原因各自的码与文案，且两者必须不同。
  const noOwner = debugQueryUnresolvedError("noOwner");
  const ambiguous = debugQueryUnresolvedError("ambiguous");
  assert.equal(noOwner.code, "local.noOwner");
  assert.equal(ambiguous.code, "local.noConnection");
  assert.notEqual(noOwner.message, ambiguous.message, "两种原因不能共用一句文案");
  assert.match(noOwner.message, /没有任何存活的调试连接持有/u);
  assert.doesNotMatch(noOwner.message, /多条/u, "实例无主不能提示'多连接'");
  assert.match(ambiguous.message, /多条调试连接同时在线/u);
});

function jsonFrames(ingress: DebugIngress, value: unknown): readonly DebugEnvelope[] {
  return ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify(value)),
  });
}

function eventEnvelope(frame: number): DebugEventEnvelope {
  return {
    type: "debug",
    frame,
    wireBytes: 12,
    payloadKind: BridgePayloadKind.Binary,
    category: "graph",
    instance: "hero",
    interfaceId: "IGraphDebuger",
    method: "NodeStarted",
    methodId: 10,
    instanceSlot: 1,
    args: [{ tag: 1, name: "nodeId", type: "int", value: 5 }],
    contractState: "unknown-interface",
  };
}
