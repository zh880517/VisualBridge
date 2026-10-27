import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  BridgeChannel,
  BridgeFrameDecoder,
  BridgePayloadKind,
  MAX_MESSAGE_BYTES,
  crc16CcittFalse,
  encodeFrame,
} from "../../src/bridge/framing";
import {
  DebugIngress,
  type DebugEnvelope,
  type DebugEventEnvelope,
} from "../../src/bridge/debugIngress";
import { DebugContractRegistry, type DebugContractSnapshot } from "../../src/bridge/debugContractRegistry";

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

const CREATE_JSON = JSON.stringify({
  type: "debugCreate",
  category: "graph",
  instance: "hero",
  instanceSlot: 1,
  resName: "R",
  debugInfo: "",
});

/** `NodeStarted`：tag 1 int 5、tag 3 enum(Sample.Graph.Mode, short) 1。 */
const EVENT_JSON = JSON.stringify({
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

/** 同一记录的二进制形态：`000a 0001` methodId/slot + 参数区（A.4）。 */
const EVENT_BINARY = Buffer.from("000a0001" + "00010200000005" + "0003070001", "hex");
/** Query(12) 的二进制 result：`u32 requestId=7` + result（tag 0 bool true，A.4/A.5）。 */
const RESULT_BINARY = Buffer.from("000c0001" + "00000007" + "0000" + "01" + "01", "hex");
const CREATE_BINARY = Buffer.from("00010001" + "00000800056772617068" + "00010800046865726f", "hex");

const FRAME_JSON = JSON.stringify({ type: "debugFrame", frame: 7 });

/**
 * F1 单测没有查询挂起表：显式声明"本数据源无挂起请求"才解二进制事件帧。
 * 缺省（不给该选项、也不给 `isPendingRequest`）必须走 `ambiguousEnvelope`（A.4）。
 */
const NO_PENDING = { assumeNoPendingRequests: true } as const;

function jsonFrame(text: string): Buffer {
  return encodeFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(text, "utf8"));
}

function binaryFrame(payload: Buffer): Buffer {
  return encodeFrame(BridgeChannel.Debug, BridgePayloadKind.Binary, payload);
}

/** 只取 `debug` 事件包络（各用例共用的收窄断言）。 */
function debugEvent(envelopes: readonly DebugEnvelope[]): DebugEventEnvelope {
  const envelope = envelopes.find((entry) => entry.type === "debug");
  assert.ok(envelope !== undefined && envelope.type === "debug", `expected a debug envelope, received ${JSON.stringify(envelopes)}`);
  return envelope;
}

test("JSON and binary payloads normalize to the same envelope shape", async () => {
  const contracts = await primaryContracts();

  const jsonIngress = new DebugIngress({ contracts });
  jsonIngress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Json, payload: Buffer.from(CREATE_JSON) });
  const jsonEnvelope = debugEvent(jsonIngress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(EVENT_JSON, "utf8"),
  }));

  const binaryIngress = new DebugIngress({ contracts, ...NO_PENDING });
  binaryIngress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: CREATE_BINARY });
  const binaryEnvelope = debugEvent(binaryIngress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload: EVENT_BINARY,
  }));

  // 同构：字段集合、记录身份、参数表完全一致；只有"从哪来"的字段不同。
  assert.deepEqual(Object.keys(jsonEnvelope).sort(), Object.keys(binaryEnvelope).sort());
  assert.equal(jsonEnvelope.type, "debug");
  assert.equal(jsonEnvelope.category, "graph");
  assert.equal(jsonEnvelope.instance, "hero");
  assert.equal(jsonEnvelope.frame, -1);
  assert.equal(jsonEnvelope.contractState, "matched");
  assert.deepEqual(jsonEnvelope.args, binaryEnvelope.args, "二进制参数名由契约按 tag 补齐（A.4）");

  // JSON 自带 iface/method 与名字；二进制只有号段，命中契约后从声明补齐，与 JSON 同构（P2-3）。
  assert.equal(jsonEnvelope.interfaceId, "IGraphDebuger");
  assert.equal(jsonEnvelope.method, "NodeStarted");
  assert.equal(jsonEnvelope.methodId, 0);
  assert.equal(jsonEnvelope.instanceSlot, 0);
  assert.equal(binaryEnvelope.interfaceId, jsonEnvelope.interfaceId);
  assert.equal(binaryEnvelope.method, jsonEnvelope.method);
  assert.equal(binaryEnvelope.methodId, 10);
  assert.equal(binaryEnvelope.instanceSlot, 1);

  // wireBytes 只算载荷字节（C.4 记账单位）。
  assert.equal(jsonEnvelope.wireBytes, Buffer.byteLength(EVENT_JSON));
  assert.equal(binaryEnvelope.wireBytes, EVENT_BINARY.length);
  assert.equal(jsonEnvelope.payloadKind, BridgePayloadKind.Json);
  assert.equal(binaryEnvelope.payloadKind, BridgePayloadKind.Binary);
});

test("the file source and the network source produce identical envelopes", async () => {
  const contracts = await primaryContracts();
  const stream = Buffer.concat([
    jsonFrame(CREATE_JSON),
    jsonFrame(FRAME_JSON),
    jsonFrame(EVENT_JSON),
    binaryFrame(EVENT_BINARY),
  ]);

  // 文件源：录制文件里就是原样线上帧（C.6），按字节交给入口。
  const fileIngress = new DebugIngress({ contracts, ...NO_PENDING });
  const fileEnvelopes = fileIngress.acceptRecordedBytes(stream);

  // 网络源：连接层已切帧，逐帧交给入口。
  const decoder = new BridgeFrameDecoder();
  const networkIngress = new DebugIngress({ contracts, ...NO_PENDING });
  const networkEnvelopes = decoder.push(stream).flatMap((frame) => networkIngress.acceptFrame(frame));

  assert.deepEqual(fileEnvelopes, networkEnvelopes);
  assert.deepEqual(
    fileEnvelopes.map((envelope) => envelope.type),
    ["debugCreate", "debugFrame", "debug", "debug"],
  );
  assert.deepEqual(fileIngress.counters, networkIngress.counters);
  assert.equal(fileEnvelopes[1]?.frame, 7);
  assert.equal(fileEnvelopes[2]?.frame, 7, "后续记录沿用最近一个 debugFrame");
});

test("a corrupted frame header counts once and stops only the current recording block", async () => {
  const contracts = await primaryContracts();
  const good = jsonFrame(CREATE_JSON);
  const corrupted = Buffer.from(jsonFrame(EVENT_JSON));
  // 改长度字段但不重算 CRC：帧头 CRC 失败，长度字段不可信（A.1 不重同步）。
  corrupted[3] = (corrupted[3]! + 1) & 0xff;

  const ingress = new DebugIngress({ contracts, ...NO_PENDING });
  const envelopes = ingress.acceptRecordedBytes(Buffer.concat([good, corrupted]));

  assert.deepEqual(envelopes.map((envelope) => envelope.type), ["debugCreate"]);
  assert.equal(ingress.counters.crcFailures, 1);
  assert.equal(ingress.recordedStopped, true, "当前 block 停止解析，等 block 边界恢复");
  // 不再重同步：本 block 之后的字节一律不再产出包络。
  assert.deepEqual(ingress.acceptRecordedBytes(jsonFrame(EVENT_JSON)), []);
  assert.equal(ingress.counters.crcFailures, 1, "失败只计一次");
  assert.equal(ingress.slotRegistry.resolve(1)?.instance, "hero", "坏帧不改变已建立的槽位");
});

test("a corrupted frame does not abort the whole playback: the next block still decodes", async () => {
  const contracts = await primaryContracts();
  const corrupted = Buffer.from(jsonFrame(EVENT_JSON));
  corrupted[3] = (corrupted[3]! + 1) & 0xff;

  const ingress = new DebugIngress({ contracts, ...NO_PENDING });
  const firstBlock = ingress.acceptRecordedBytes(Buffer.concat([jsonFrame(CREATE_JSON), corrupted]));
  assert.deepEqual(firstBlock.map((envelope) => envelope.type), ["debugCreate"]);
  assert.equal(ingress.recordedStopped, true);

  // F5 在 block 边界恢复：只清残留字节与停止标志，槽位/当前帧/计数全部继承。
  ingress.resumeRecordedStream();
  assert.equal(ingress.recordedStopped, false);
  assert.equal(ingress.slotRegistry.resolve(1)?.instance, "hero", "恢复不得清掉槽位（reset 才是全清）");

  const secondBlock = ingress.acceptRecordedBytes(Buffer.concat([jsonFrame(FRAME_JSON), jsonFrame(EVENT_JSON)]));
  assert.deepEqual(secondBlock.map((envelope) => envelope.type), ["debugFrame", "debug"], "坏帧之后的 block 仍能解出事件");
  assert.equal(secondBlock[1]?.frame, 7, "当前帧跨 block 延续");
  assert.equal(ingress.counters.crcFailures, 1, "CRC 失败只计数一次");
  assert.equal(ingress.counters.envelopes, 3);
});

test("an oversized recorded frame is skipped and the following frame still decodes", () => {
  const oversizedHeader = Buffer.alloc(6);
  oversizedHeader.writeUInt32BE((((BridgeChannel.Debug << 31) | (BridgePayloadKind.Json << 29) | (MAX_MESSAGE_BYTES + 1)) >>> 0), 0);
  oversizedHeader.writeUInt16BE(crc16CcittFalse(oversizedHeader.subarray(0, 4)), 4);
  // 帧头 CRC 通过 ⇒ 长度字段可信：整帧丢弃后继续解下一帧，与网络源的"只计数"一致。
  const oversizedFrame = Buffer.concat([oversizedHeader, Buffer.alloc(MAX_MESSAGE_BYTES + 1)]);

  const ingress = new DebugIngress();
  const envelopes = ingress.acceptRecordedBytes(Buffer.concat([oversizedFrame, jsonFrame(CREATE_JSON)]));
  assert.deepEqual(envelopes.map((envelope) => envelope.type), ["debugCreate"]);
  assert.equal(ingress.counters.oversizeFrames, 1);
  assert.equal(ingress.recordedStopped, false, "CRC 通过的超限帧不该终止整个回看");
  assert.equal(ingress.counters.frames, 2);
  assert.equal(
    ingress.counters.wireBytes,
    MAX_MESSAGE_BYTES + 1 + Buffer.byteLength(CREATE_JSON),
    "超限帧与网络源一样计入 wireBytes",
  );
});

test("a trailing partial frame is counted when the recorded stream finishes", () => {
  const ingress = new DebugIngress();
  assert.deepEqual(ingress.acceptRecordedBytes(Buffer.from([0x00, 0x01, 0x02])), []);
  assert.equal(ingress.counters.truncatedFrames, 0, "流还没结束，残帧不下结论");

  assert.equal(ingress.finishRecordedStream(), true);
  assert.equal(ingress.counters.truncatedFrames, 1);
  assert.equal(ingress.finishRecordedStream(), false, "残帧只计一次");
  assert.equal(ingress.counters.truncatedFrames, 1);
});

test("a complete header with a truncated payload also counts as one trailing frame", () => {
  const ingress = new DebugIngress();
  const partial = jsonFrame(CREATE_JSON).subarray(0, 12);
  assert.deepEqual(ingress.acceptRecordedBytes(partial), []);
  assert.equal(ingress.finishRecordedStream(), true);
  assert.equal(ingress.counters.truncatedFrames, 1);
});

test("oversized payloads, illegal channels and control frames are only counted", () => {
  const ingress = new DebugIngress();

  assert.deepEqual(ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.alloc(MAX_MESSAGE_BYTES + 1),
  }), []);
  assert.equal(ingress.counters.oversizeFrames, 1);

  assert.deepEqual(ingress.acceptFrame({ channel: 2, payloadKind: BridgePayloadKind.Json, payload: Buffer.from("{}") }), []);
  assert.equal(ingress.counters.invalidFrames, 1);

  assert.deepEqual(ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: 3 as BridgePayloadKind,
    payload: Buffer.from("{}"),
  }), []);
  assert.equal(ingress.counters.invalidFrames, 2);

  // 通道 0 属于编辑器/控制面（A.2）：计数但不进调试数据面。
  const envelopes = ingress.acceptFrame({
    channel: BridgeChannel.Control,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify({ type: "response", requestId: "req-1", status: "ok" })),
  });
  assert.deepEqual(envelopes, []);
  assert.equal(ingress.counters.controlFrames, 1);
  assert.equal(ingress.counters.envelopes, 0);
});

test("unknown slots and reserved method ids are counted without throwing", () => {
  const ingress = new DebugIngress();
  // Create 未到：二进制无法反查实例与分类（A.4）。
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: EVENT_BINARY });
  assert.equal(ingress.counters.unknownSlots, 1);

  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: CREATE_BINARY });
  // 3–9 是预留系统号段，不属于任何分类方法。
  const reserved = Buffer.from("00050001" + "00010200000005", "hex");
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: reserved });
  assert.equal(ingress.counters.unknownMethods, 1);
  assert.equal(ingress.counters.envelopes, 1, "只有 Create 落成包络");
});

test("a method missing from the conventional contract is dropped and counted separately", async () => {
  const contracts = await primaryContracts();
  const ingress = new DebugIngress({ contracts, ...NO_PENDING });
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: CREATE_BINARY });

  // 槽位与方法号都合法，但 (graph, 99) 不在 debug-contracts.json 里：A.4 丢弃，
  // A.5 归消费端识别（不计入服务端 dropped）。
  const envelopesBefore = ingress.counters.envelopes;
  const unknownMethod = Buffer.from("00630001" + "00010200000005", "hex");
  assert.deepEqual(ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload: unknownMethod,
  }), []);
  assert.equal(ingress.counters.unknownContractMethods, 1);
  assert.equal(ingress.counters.envelopes, envelopesBefore, "丢弃的帧不落成包络");

  // JSON 侧不做这种丢弃：指纹不一致时就该按 JSON 继续展示（A.3/C.2）。
  const unknownJson = debugEvent(ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify({
      type: "debug",
      category: "graph",
      instance: "hero",
      iface: "IGraphDebuger",
      method: "Removed",
    })),
  }));
  assert.equal(unknownJson.contractState, "unknown-interface");
  assert.equal(ingress.counters.unknownContractMethods, 1);
});

test("without any contract every record still flows through the generic view", async () => {
  const ingress = new DebugIngress();
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Json, payload: Buffer.from(CREATE_JSON) });
  const envelope = debugEvent(ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(EVENT_JSON, "utf8"),
  }));
  assert.equal(envelope.contractState, "unknown-interface");
  assert.equal(ingress.counters.unknownContractMethods, 0, "没有契约就谈不上契约级未知方法");
});

test("debugFrame advances the current frame and Finish retires the slot", async () => {
  const contracts = await primaryContracts();
  const ingress = new DebugIngress({ contracts });
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Json, payload: Buffer.from(CREATE_JSON) });
  assert.equal(ingress.slotRegistry.resolve(1)?.instance, "hero");

  const frameEnvelope = ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(FRAME_JSON),
  })[0];
  assert.deepEqual(frameEnvelope, {
    type: "debugFrame",
    frame: 7,
    wireBytes: Buffer.byteLength(FRAME_JSON),
    payloadKind: BridgePayloadKind.Json,
  });
  assert.equal(ingress.frame, 7);

  ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify({ type: "debugFinish", instance: "hero" })),
  });
  assert.equal(ingress.slotRegistry.resolve(1), undefined);

  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: EVENT_BINARY });
  assert.equal(ingress.counters.unknownSlots, 1, "Finish 之后二进制帧不再解析（A.4/A.9）");
});

test("reset clears slots, the current frame and every counter", () => {
  const ingress = new DebugIngress();
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Json, payload: Buffer.from(CREATE_JSON) });
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Json, payload: Buffer.from(FRAME_JSON) });
  assert.equal(ingress.counters.envelopes, 2);
  assert.equal(ingress.frame, 7);

  ingress.reset();

  assert.equal(ingress.frame, -1);
  assert.equal(ingress.slotRegistry.size, 0);
  assert.equal(ingress.counters.envelopes, 0);
  assert.equal(ingress.counters.frames, 0);
  assert.equal(ingress.counters.wireBytes, 0);
  assert.equal(ingress.recordedStopped, false);
});

test("a binary debugResult without a pending-request table is counted as ambiguous, not silently dropped", async () => {
  const contracts = await primaryContracts();
  // 默认构造：没有 isPendingRequest，也没有 assumeNoPendingRequests。
  const ingress = new DebugIngress({ contracts });
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: CREATE_BINARY });

  const envelopes = ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload: RESULT_BINARY,
  });
  assert.deepEqual(envelopes, [], "缺挂起表时不得把 u32 requestId 当参数区静默解析（A.4）");
  assert.equal(ingress.counters.ambiguousMessages, 1, "E4 的 ambiguousEnvelope 保护必须真的被走到");
  assert.equal(ingress.counters.unknownMethods, 0, "不得退化成 unknownMethod（那会把 result 帧误当 Create 分支）");
  assert.equal(ingress.counters.envelopes, 1, "只有 Create 落成包络");
});

test("a binary debugResult decodes with an injected pending-request table", async () => {
  const contracts = await primaryContracts();
  const ingress = new DebugIngress({ contracts, isPendingRequest: (requestId) => requestId === 7 });
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: CREATE_BINARY });

  const envelopes = ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload: RESULT_BINARY,
  });
  assert.deepEqual(envelopes, [{
    type: "debugResult",
    frame: -1,
    wireBytes: RESULT_BINARY.length,
    payloadKind: BridgePayloadKind.Binary,
    category: "graph",
    instance: "hero",
    interfaceId: "IGraphQuery",
    method: "Query",
    methodId: 12,
    instanceSlot: 1,
    requestId: "req-7",
    args: [{ tag: 0, name: "matched", type: "bool", value: true }],
    contractState: "matched",
  }]);
  assert.equal(ingress.counters.ambiguousMessages, 0);
  assert.equal(ingress.counters.unknownMethods, 0);
});

test("a late binary debugResult still normalizes when the request id is known", async () => {
  const contracts = await primaryContracts();
  // 超时后请求已不在挂起表里，但仍是「已知请求号」：晚到结果必须解成 debugResult，
  // 不能退化成 debug（垃圾参数）或 unknownMethod（丢掉一条可按 requestId 关联的结果）。
  const ingress = new DebugIngress({
    contracts,
    isPendingRequest: () => false,
    isKnownRequest: (requestId) => requestId === 7,
  });
  ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind: BridgePayloadKind.Binary, payload: CREATE_BINARY });

  const envelopes = ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload: RESULT_BINARY,
  });
  assert.equal(envelopes.length, 1);
  const [lateResult] = envelopes;
  assert.ok(lateResult !== undefined);
  assert.equal(lateResult.type, "debugResult");
  if (lateResult.type !== "debugResult") return;
  assert.equal(lateResult.requestId, "req-7");
  assert.deepEqual(lateResult.args, [{ tag: 0, name: "matched", type: "bool", value: true }]);
  assert.equal(ingress.counters.ambiguousMessages, 0);
  assert.equal(ingress.counters.unknownMethods, 0);
});

test("a JSON request envelope carries its methodId and names args from the contract", async () => {
  const contracts = await primaryContracts();
  const ingress = new DebugIngress({ contracts });
  const envelopes = ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify({
      type: "request",
      requestId: "req-12",
      action: "debugQuery",
      category: "graph",
      instance: "hero",
      iface: "IGraphDebuger",
      method: "Query",
      methodId: 12,
      args: [{ tag: 0, type: "bool", value: true }],
    }), "utf8"),
  });

  assert.equal(envelopes.length, 1);
  const [envelope] = envelopes;
  assert.ok(envelope !== undefined);
  assert.equal(envelope.type, "request");
  if (envelope.type !== "request") return;
  assert.equal(envelope.methodId, 12);
  assert.equal(envelope.requestId, "req-12");
  assert.deepEqual(envelope.args, [{ tag: 0, name: "matched", type: "bool", value: true }]);
  assert.equal(ingress.counters.invalidRequests, 0);
});

test("a JSON request envelope without methodId is counted as an invalid request", () => {
  const ingress = new DebugIngress();
  const envelopes = ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(JSON.stringify({
      type: "request",
      requestId: "req-12",
      action: "debugQuery",
      category: "graph",
      instance: "hero",
    }), "utf8"),
  });

  assert.deepEqual(envelopes, []);
  assert.equal(ingress.counters.invalidRequests, 1);
  assert.equal(ingress.counters.malformedMessages, 0);
});

test("a JSON debugCreate missing its required category is rejected instead of binding slot 0", () => {
  const ingress = new DebugIngress();
  const incomplete = JSON.stringify({
    type: "debugCreate",
    instance: "hero",
    instanceSlot: 1,
    resName: "R",
    debugInfo: "",
  });

  assert.deepEqual(ingress.acceptFrame({
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(incomplete, "utf8"),
  }), []);
  assert.equal(ingress.counters.malformedMessages, 1, "A.5 必填字段缺失要计数");
  assert.equal(ingress.counters.envelopes, 0);
  assert.equal(ingress.slotRegistry.resolve(1), undefined, "不得注册 category 为空的槽位");
  assert.equal(ingress.slotRegistry.size, 0);
});
