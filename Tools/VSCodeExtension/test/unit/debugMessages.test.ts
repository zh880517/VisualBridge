import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBUG_QUERY_ERROR_CODES,
  DebugSlotRegistry,
  decodeDebugEnvelope,
  encodeDebugFrame,
  encodeDebugRequest,
  isDebugQueryErrorCode,
  type DebugCreateMessage,
  type DebugDecodeContext,
  type DebugDroppedMessage,
  type DebugEventMessage,
  type DebugFinishMessage,
  type DebugFrameMessage,
  type DebugRequestMessage,
  type DebugResponseMessage,
  type DebugResultMessage,
} from "../../src/bridge/debugMessages";
import { DebugQueryTracker } from "../../src/bridge/debugQueryTracker";
import { BridgePayloadKind } from "../../src/bridge/framing";

// 与 C# 侧 `Tests/Editor/VisualBridgeDebugTransportTests.cs` 共用同一组 fixture（同一批字符串与十六进制）。
const CREATE_JSON =
  '{"type":"debugCreate","category":"graph","instance":"hero","instanceSlot":1,"resName":"R","debugInfo":""}';
const CREATE_BINARY = "00010001" + "00000800056772617068" + "0001080004" + "6865726f" + "0002080001" + "52";
const FINISH_JSON = '{"type":"debugFinish","category":"graph","instance":"hero"}';
const FINISH_BINARY = "00020001" + "0000080004" + "6865726f";
const FRAME_JSON = '{"type":"debugFrame","frame":7}';
const EVENT_JSON =
  '{"type":"debug","category":"graph","instance":"hero","iface":"IGraphDebuger","method":"NodeStart",' +
  '"args":[{"tag":1,"name":"hp","type":"int","value":5}]}';
const EVENT_BINARY = "000a0001" + "0001" + "02" + "00000005";
const RESULT_JSON =
  '{"type":"debugResult","category":"graph","instance":"hero","iface":"IGraphDebuger","method":"NodeStart",' +
  '"requestId":"req-12","args":[{"tag":1,"name":"hp","type":"int","value":5}]}';
const RESULT_BINARY = "000a0001" + "0000000c" + "0001" + "02" + "00000005";
const DROPPED_JSON =
  '{"type":"dropped","filteredByServer":1,"unknownMethod":1,"unknownSlot":1,"invalidRequest":1,' +
  '"encodeFailed":0,"oversize":0,"queueOverflow":5}';
const RESPONSE_JSON =
  '{"type":"response","requestId":"req-12","ok":false,"code":"runtime.queryBusy","detail":"queue full"}';
const REQUEST_JSON =
  '{"type":"request","requestId":"req-12","action":"debugQuery","category":"graph","instance":"hero",' +
  '"iface":"IGraphDebuger","method":"Query","methodId":10,"args":[{"tag":1,"name":"hp","type":"int","value":5},' +
  '{"tag":2,"name":"mode","type":"enum","value":"Fast"},{"tag":3,"name":"blob","type":"byte[]","value":"AQID"}]}';

function bufferOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

function bytesOf(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function context(overrides: Partial<DebugDecodeContext> = {}): DebugDecodeContext {
  const registry = new DebugSlotRegistry();
  registry.register("hero", "graph", 1);
  return {
    resolveSlot: (instanceSlot) => registry.resolve(instanceSlot),
    // 二进制路径必需：二进制信封没有 debug/debugResult 标志位（A.4）。
    isPendingRequest: () => false,
    ...overrides,
  };
}

test("decodes debugCreate and registers the slot", () => {
  const result = decodeDebugEnvelope(BridgePayloadKind.Json, bufferOf(CREATE_JSON), context());
  assert.equal(result.ok, true);
  const message = (result as { ok: true; message: DebugCreateMessage }).message;
  assert.deepEqual(message, {
    kind: "debugCreate",
    category: "graph",
    instance: "hero",
    instanceSlot: 1,
    resName: "R",
    debugInfo: "",
  });

  const registry = new DebugSlotRegistry();
  registry.register(message.instance, message.category, message.instanceSlot);
  assert.deepEqual(registry.resolve(1), { instance: "hero", category: "graph" });
  registry.finish("hero");
  assert.equal(registry.resolve(1), undefined);
});

test("decodes binary Create/Finish through the fixed tag table", () => {
  const create = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(CREATE_BINARY), context());
  assert.equal(create.ok, true);
  assert.deepEqual((create as { ok: true; message: DebugCreateMessage }).message, {
    kind: "debugCreate",
    category: "graph",
    instance: "hero",
    instanceSlot: 1,
    resName: "R",
    debugInfo: "",
  });

  const finish = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(FINISH_BINARY), context());
  assert.equal(finish.ok, true);
  assert.deepEqual((finish as { ok: true; message: DebugFinishMessage }).message, {
    kind: "debugFinish",
    category: undefined,
    instance: "hero",
  });
});

test("decodes debug/debugResult both payload kinds", () => {
  const jsonEvent = decodeDebugEnvelope(BridgePayloadKind.Json, bufferOf(EVENT_JSON), context());
  assert.equal(jsonEvent.ok, true);
  const eventMessage = (jsonEvent as { ok: true; message: DebugEventMessage }).message;
  assert.equal(eventMessage.kind, "debug");
  assert.deepEqual(eventMessage.args, [{ tag: 1, name: "hp", type: "int", value: 5 }]);

  const binaryEvent = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(EVENT_BINARY), context());
  assert.equal(binaryEvent.ok, true);
  const binaryMessage = (binaryEvent as { ok: true; message: DebugEventMessage }).message;
  assert.equal(binaryMessage.kind, "debug");
  assert.equal(binaryMessage.category, "graph");
  assert.equal(binaryMessage.instance, "hero");
  assert.equal(binaryMessage.methodId, 10);
  assert.deepEqual(binaryMessage.args, [{ tag: 1, type: "int", value: 5 }]);

  const jsonResult = decodeDebugEnvelope(BridgePayloadKind.Json, bufferOf(RESULT_JSON), context());
  assert.equal(jsonResult.ok, true);
  assert.equal((jsonResult as { ok: true; message: DebugResultMessage }).message.requestId, "req-12");

  // 二进制信封靠「请求号是否在挂起表」区分 debugResult 与 debug（A.4 不额外带标志位）。
  const binaryResult = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(RESULT_BINARY), context({
    isPendingRequest: (requestId) => requestId === 12,
  }));
  assert.equal(binaryResult.ok, true);
  const resultMessage = (binaryResult as { ok: true; message: DebugResultMessage }).message;
  assert.equal(resultMessage.kind, "debugResult");
  assert.equal(resultMessage.requestId, "req-12");
  assert.deepEqual(resultMessage.args, [{ tag: 1, type: "int", value: 5 }]);
});

test("debugFrame encodes to the shared fixture", () => {
  assert.equal(encodeDebugFrame(7).toString("utf8"), FRAME_JSON);
  const decoded = decodeDebugEnvelope(BridgePayloadKind.Json, encodeDebugFrame(7), context());
  assert.equal(decoded.ok, true);
  assert.equal((decoded as { ok: true; message: DebugFrameMessage }).message.frame, 7);
});

test("request encodes to the shared fixture and round-trips", () => {
  const request: DebugRequestMessage = {
    kind: "request",
    requestId: "req-12",
    action: "debugQuery",
    category: "graph",
    instance: "hero",
    iface: "IGraphDebuger",
    method: "Query",
    // E6：JSON 信封带方法号（与二进制载荷头同一语义），服务端的分发与参数声明表只认它。
    methodId: 10,
    args: [
      { tag: 1, name: "hp", type: "int", value: 5 },
      { tag: 2, name: "mode", type: "enum", value: "Fast" },
      { tag: 3, name: "blob", type: "byte[]", value: "AQID" },
    ],
  };

  const encoded = encodeDebugRequest(request);
  const text = encoded.toString("utf8");
  assert.equal(text, REQUEST_JSON);
  // 键序是协议的一部分（两侧 fixture 逐字节比对），methodId 必须在 args 之前、method 之后。
  assert.equal(
    text.indexOf('"methodId":10'),
    text.indexOf('"method":"Query",') + '"method":"Query",'.length,
  );
  assert.equal(
    encodeDebugRequest({ ...request, args: [] }).toString("utf8"),
    '{"type":"request","requestId":"req-12","action":"debugQuery","category":"graph","instance":"hero",' +
      '"iface":"IGraphDebuger","method":"Query","methodId":10}',
  );

  const decoded = decodeDebugEnvelope(BridgePayloadKind.Json, encoded, context());
  assert.equal(decoded.ok, true);
  assert.deepEqual((decoded as { ok: true; message: DebugRequestMessage }).message, request);
});

test("the query tracker and a hand-built message encode to the same request bytes", () => {
  // 两条生产路径（挂起表分配 requestId，或调用方直接构造信封消息）都必须落到
  // `encodeDebugRequest` 这一个序列化入口：任何一处另写对象字面量都会在这里被字节比对抓住。
  const tracker = new DebugQueryTracker({ initialRequestSeq: 12 });
  const message = tracker.createRequest({
    category: "graph",
    instance: "hero",
    iface: "IGraphDebuger",
    method: "Query",
    methodId: 10,
    args: [
      { tag: 1, name: "hp", type: "int", value: 5 },
      { tag: 2, name: "mode", type: "enum", value: "Fast" },
      { tag: 3, name: "blob", type: "byte[]", value: "AQID" },
    ],
  });
  assert.ok(message !== undefined);
  assert.equal(encodeDebugRequest(message).toString("utf8"), REQUEST_JSON);
  assert.equal(encodeDebugRequest({ ...message, args: [] }).toString("utf8"),
    '{"type":"request","requestId":"req-12","action":"debugQuery","category":"graph","instance":"hero",' +
      '"iface":"IGraphDebuger","method":"Query","methodId":10}');
});

test("a request without a valid category methodId is an invalid request envelope", () => {
  for (const payload of [
    '{"type":"request","requestId":"req-1","action":"debugQuery","instance":"hero"}',
    '{"type":"request","requestId":"req-1","action":"debugQuery","instance":"hero","methodId":"10"}',
    '{"type":"request","requestId":"req-1","action":"debugQuery","instance":"hero","methodId":10.5}',
    '{"type":"request","requestId":"req-1","action":"debugQuery","instance":"hero","methodId":0}',
    '{"type":"request","requestId":"req-1","action":"debugQuery","instance":"hero","methodId":1}',
    '{"type":"request","requestId":"req-1","action":"debugQuery","instance":"hero","methodId":9}',
    '{"type":"request","requestId":"req-1","action":"debugQuery","instance":"hero","methodId":65536}',
    '{"type":"request","requestId":"req-1","action":"getSnapshot","instance":"hero","methodId":10}',
  ]) {
    const decoded = decodeDebugEnvelope(BridgePayloadKind.Json, bufferOf(payload), context());
    assert.equal(decoded.ok, false);
    assert.equal((decoded as { ok: false; reason: string }).reason, "invalidRequest");
  }
});

test("dropped and response decode with all fields", () => {
  const dropped = decodeDebugEnvelope(BridgePayloadKind.Json, bufferOf(DROPPED_JSON), context());
  assert.equal(dropped.ok, true);
  assert.deepEqual((dropped as { ok: true; message: DebugDroppedMessage }).message, {
    kind: "dropped",
    filteredByServer: 1,
    unknownMethod: 1,
    unknownSlot: 1,
    invalidRequest: 1,
    encodeFailed: 0,
    oversize: 0,
    queueOverflow: 5,
  });

  const response = decodeDebugEnvelope(BridgePayloadKind.Json, bufferOf(RESPONSE_JSON), context());
  assert.equal(response.ok, true);
  assert.deepEqual((response as { ok: true; message: DebugResponseMessage }).message, {
    kind: "response",
    requestId: "req-12",
    ok: false,
    code: "runtime.queryBusy",
    detail: "queue full",
  });
});

test("unknown slots and unknown methods are reported instead of throwing", () => {
  const unknownSlot = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(EVENT_BINARY), {
    resolveSlot: () => undefined,
  });
  assert.equal(unknownSlot.ok, false);
  assert.equal((unknownSlot as { ok: false; reason: string }).reason, "unknownSlot");

  const reserved = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf("00050001"), context());
  assert.equal(reserved.ok, false);
  assert.equal((reserved as { ok: false; reason: string }).reason, "unknownMethod");

  // 枚举宽度只能来自契约（A.4）：拿不到契约时整条消息按未知方法丢弃。
  const enumPayload = bytesOf("000a0001" + "0007" + "07" + "00000002");
  const withoutContract = decodeDebugEnvelope(BridgePayloadKind.Binary, enumPayload, context());
  assert.equal(withoutContract.ok, false);
  assert.equal((withoutContract as { ok: false; reason: string }).reason, "unknownMethod");

  const withContract = decodeDebugEnvelope(BridgePayloadKind.Binary, enumPayload, context({
    resolveEnumWidth: () => 4,
  }));
  assert.equal(withContract.ok, true);
  assert.deepEqual((withContract as { ok: true; message: DebugEventMessage }).message.args, [
    { tag: 7, type: "enum", value: 2 },
  ]);
});

test("malformed payloads are rejected with a reason", () => {
  for (const payload of [
    bufferOf("{"),
    bufferOf('{"type":"unknown"}'),
    bufferOf('{"type":"debugFrame"}'),
    bufferOf('{"type":"debugResult","args":[]}'),
  ]) {
    const result = decodeDebugEnvelope(BridgePayloadKind.Json, payload, context());
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; reason: string }).reason, "malformed");
  }

  const truncated = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf("000a"), context());
  assert.equal(truncated.ok, false);
  assert.equal((truncated as { ok: false; reason: string }).reason, "malformed");

  const truncatedParameter = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf("000a0001" + "0001" + "02"), context());
  assert.equal(truncatedParameter.ok, false);
  assert.equal((truncatedParameter as { ok: false; reason: string }).reason, "malformed");
});

test("slot registry keeps at most one binding per slot and clears on reconnect", () => {
  const registry = new DebugSlotRegistry();
  registry.register("hero", "graph", 1);
  registry.register("boss", "graph", 1);
  assert.deepEqual(registry.resolve(1), { instance: "boss", category: "graph" });
  assert.equal(registry.size, 1);

  registry.register("hero", "graph", 2);
  registry.finish(undefined, 2);
  assert.equal(registry.resolve(2), undefined);
  assert.equal(registry.size, 1);

  registry.clear();
  assert.equal(registry.size, 0);
});

test("binary payloads without a pending-request table fail explicitly", () => {
  // A.4 的信封不带 debug/debugResult 标志位：没有挂起表就不能把 u32 当请求号或参数解析。
  const result = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(EVENT_BINARY), {
    resolveSlot: () => ({ instance: "hero", category: "graph" }),
  });
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; reason: string }).reason, "ambiguousEnvelope");
});

test("a late binary debugResult still decodes as a result when the request id is known", () => {
  // 只查挂起表时，超时请求（已移出挂起表）的晚到结果会被当成 debug：要么解出垃圾参数，
  // 要么按 unknownMethod 丢掉一条本可按 requestId 关联的结果（A.5）。
  const pendingOnly = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(RESULT_BINARY), context({
    isPendingRequest: () => false,
  }));
  assert.equal(pendingOnly.ok, false);
  assert.equal((pendingOnly as { ok: false; reason: string }).reason, "unknownMethod");

  const lateResult = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(RESULT_BINARY), context({
    isPendingRequest: () => false,
    isKnownRequest: (requestId) => requestId === 12,
  }));
  assert.equal(lateResult.ok, true);
  const message = (lateResult as { ok: true; message: DebugResultMessage }).message;
  assert.equal(message.kind, "debugResult");
  assert.equal(message.requestId, "req-12", "晚到结果仍按 u32 requestId 关联（JSON 侧同一形态 req-<n>）");
  assert.deepEqual(message.args, [{ tag: 1, type: "int", value: 5 }]);

  // 已知请求号只影响"是不是结果"，不影响 debug 事件的判定。
  const event = decodeDebugEnvelope(BridgePayloadKind.Binary, bytesOf(EVENT_BINARY), context({
    isKnownRequest: (requestId) => requestId === 12,
  }));
  assert.equal(event.ok, true);
  assert.equal((event as { ok: true; message: DebugEventMessage }).message.kind, "debug");
});

test("the query error-code registry covers the A.6 channel-1 codes", () => {
  assert.deepEqual([...DEBUG_QUERY_ERROR_CODES], [
    "runtime.debugNotEnabled",
    "runtime.instanceNotFound",
    "runtime.invalidArgument",
    "runtime.queryBusy",
    "runtime.queryRejected",
    "runtime.queryTimeout",
    "runtime.queryUnregistered",
  ]);
  assert.equal(isDebugQueryErrorCode("runtime.queryRejected"), true);
  assert.equal(isDebugQueryErrorCode("runtime.debugNotEnabled"), true,
    "关闭期拒绝的码必须可映射，否则宿主只能等超时");
  assert.equal(isDebugQueryErrorCode("runtime.unknownThing"), false);
  assert.equal(isDebugQueryErrorCode(undefined), false);
});
