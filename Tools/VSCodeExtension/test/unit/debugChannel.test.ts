import assert from "node:assert/strict";
import test from "node:test";
import { DebugChannelSession, type DebugChannel } from "../../src/bridge/debugChannel";
import { DebugInstanceManager } from "../../src/bridge/debugInstanceManager";
import { resolveDebugQueryClient } from "../../src/bridge/debugQueryClient";
import { DebugRecordingHost } from "../../src/bridge/debugRecordingHost";
import { DEBUG_RECORD_BLOCK_FOOTER } from "../../src/bridge/debugRecordingFormat";
import { BridgePayloadKind } from "../../src/bridge/framing";

/** ch1 JSON 载荷（与线上编码器同一形状）。 */
function jsonPayload(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

const CREATE_EDITOR = jsonPayload({
  type: "debugCreate",
  category: "graph",
  instance: "editor-owned",
  instanceSlot: 1,
  resName: "EditorProbe",
  debugInfo: "",
});

const CREATE_RUNTIME = jsonPayload({
  type: "debugCreate",
  category: "graph",
  instance: "runtime-owned",
  instanceSlot: 1,
  resName: "RuntimeProbe",
  debugInfo: "",
});

const EVENT_RUNTIME = jsonPayload({
  type: "debug",
  category: "graph",
  instance: "runtime-owned",
  iface: "IGraphDebuger",
  method: "NodeStarted",
  frame: 3,
  args: [{ tag: 1, name: "nodeId", type: "string", value: "n-1" }],
});

function fakeChannel(origin: "editor" | "runtime", id: string): {
  readonly channel: DebugChannel;
  readonly sent: Buffer[];
  readonly setOpen: (open: boolean) => void;
} {
  const sent: Buffer[] = [];
  let open = true;
  return {
    channel: {
      origin,
      id,
      isOpen: () => open,
      sendDebugPayload: (payload) => {
        if (!open) {
          return false;
        }

        sent.push(Buffer.from(payload));
        return true;
      },
    },
    sent,
    setOpen: (value: boolean) => {
      open = value;
    },
  };
}

test("routes a query to the leg that owns the instance (E9 cross-leg)", async () => {
  const manager = new DebugInstanceManager({ now: () => 1_000, log: () => undefined });
  const editorChannel = fakeChannel("editor", "editor-1");
  const runtimeChannel = fakeChannel("runtime", "runtime-1");
  const editor = new DebugChannelSession({ channel: editorChannel.channel, manager, log: () => undefined });
  const runtime = new DebugChannelSession({ channel: runtimeChannel.channel, manager, log: () => undefined });

  editor.acceptFrame(BridgePayloadKind.Json, CREATE_EDITOR);
  runtime.acceptFrame(BridgePayloadKind.Json, CREATE_RUNTIME);
  // 帧号由 `debugFrame` 推进（与线上一致）；事件的 `frame` 字段只是记录值。
  runtime.acceptFrame(BridgePayloadKind.Json, jsonPayload({ type: "debugFrame", frame: 7 }));
  runtime.acceptFrame(BridgePayloadKind.Json, EVENT_RUNTIME);

  const runtimeView = manager.instance("graph\u0000runtime-owned");
  const editorView = manager.instance("graph\u0000editor-owned");
  assert.ok(runtimeView !== undefined && editorView !== undefined);
  assert.equal(runtimeView.origin, "runtime");
  assert.equal(editorView.origin, "editor");
  assert.equal(runtimeView.recordCount, 1, "the event frame must land on the runtime instance");

  const connections = [editor.connection, runtime.connection];
  const runtimeRoute = resolveDebugQueryClient(runtimeView, connections);
  const editorRoute = resolveDebugQueryClient(editorView, connections);
  assert.equal(runtimeRoute.status, "ready");
  assert.equal(editorRoute.status, "ready");
  if (runtimeRoute.status !== "ready" || editorRoute.status !== "ready") {
    return;
  }

  assert.equal(runtimeRoute.client, runtime.queries, "the runtime-owned instance must resolve to the runtime leg");
  assert.equal(editorRoute.client, editor.queries, "the editor-owned instance must resolve to the editor leg");

  const pending = runtime.query("graph\u0000runtime-owned", "IGraphDebuger", "Query", [], { methodId: 12 });
  assert.equal(runtimeChannel.sent.length, 1, "exactly one request goes out on the owning leg");
  assert.equal(editorChannel.sent.length, 0, "the other leg must not receive the request");
  const request = JSON.parse(runtimeChannel.sent[0]!.toString("utf8")) as {
    readonly type: string;
    readonly requestId: string;
    readonly instance: string;
    readonly methodId: number;
  };
  assert.equal(request.type, "request");
  assert.equal(request.instance, "runtime-owned");
  assert.equal(request.methodId, 12);

  // 结果沿**同一条腿**的帧路径回来（requestId 是 req-<n>，与 C# 编码器一致）。
  runtime.acceptFrame(BridgePayloadKind.Json, jsonPayload({
    type: "debugResult",
    category: "graph",
    instance: "runtime-owned",
    iface: "IGraphDebuger",
    method: "Query",
    frame: 3,
    requestId: request.requestId,
    args: [{ tag: 1, name: "value", type: "string", value: "ok" }],
  }));
  const result = await pending;
  assert.equal(result.record?.kind, "queryResult");
  assert.equal(result.record?.args.get(1)?.value, "ok");
  // 结果记录落在发起查询时那条腿的当前帧上（7），不是另一条腿/全局帧。
  assert.equal(result.target.frame, 7);
  assert.equal(manager.instance("graph\u0000runtime-owned")?.recordCount, 2);
});

test("same identity on both legs is kept as the first instance and never routed by guess (E9)", () => {
  const manager = new DebugInstanceManager({ now: () => 2_000, log: () => undefined });
  const editor = new DebugChannelSession({ channel: fakeChannel("editor", "editor-2").channel, manager, log: () => undefined });
  const runtime = new DebugChannelSession({ channel: fakeChannel("runtime", "runtime-2").channel, manager, log: () => undefined });
  const create = (resName: string): Buffer => jsonPayload({
    type: "debugCreate",
    category: "graph",
    instance: "shared",
    instanceSlot: 2,
    resName,
    debugInfo: "",
  });

  editor.acceptFrame(BridgePayloadKind.Json, create("EditorProbe"));
  runtime.acceptFrame(BridgePayloadKind.Json, create("RuntimeProbe"));

  const view = manager.instance("graph\u0000shared");
  assert.ok(view !== undefined);
  assert.equal(view.origin, "editor", "the first Create keeps the instance and its origin");
  assert.equal(view.resName, "EditorProbe");
  assert.equal(view.originConflict, true, "the second leg is reported as an origin conflict");
  assert.ok(manager.counters.originConflicts >= 1);

  // **跨腿记录合并**（F8-§8-1）：实例只有一条 store，同名实例的记录按 (category, instanceId)
  // 合并进同一条时间轴，`origin` 不会因为后一条腿的记录而改写。
  const event = (index: number): Buffer => jsonPayload({
    type: "debug",
    category: "graph",
    instance: "shared",
    iface: "IGraphDebuger",
    method: "NodeStarted",
    frame: index,
    args: [{ tag: 0, type: "int", value: index }],
  });
  editor.acceptFrame(BridgePayloadKind.Json, event(4));
  runtime.acceptFrame(BridgePayloadKind.Json, event(5));
  const merged = manager.instance("graph\u0000shared");
  assert.equal(manager.instances.length, 1, "两条腿的同名实例仍然只有一个实例记录");
  assert.equal(merged?.recordCount, 2, "两条腿的记录合并进同一条时间轴（不是各一条）");
  assert.equal(merged?.origin, "editor", "记录级来源不逐条保留：origin 保持首条（真实行为的文档化）");
  assert.equal(merged?.originConflict, true, "合并的事实由 originConflict 显式暴露");

  const route = resolveDebugQueryClient(view, [editor.connection, runtime.connection]);
  assert.equal(route.status, "ambiguous", "two legs owning the same identity must not be silently routed");
});

test("records frames that flow through the runtime-leg session tap (E9)", async () => {
  const manager = new DebugInstanceManager({ now: () => 3_000, log: () => undefined });
  const host = new DebugRecordingHost({ now: () => 3_000, log: () => undefined });
  const runtimeSource = "runtime-session-1";
  const editorSource = "editor-session-1";
  host.registerSource({
    id: runtimeSource,
    origin: "runtime",
    connectType: "editor-player",
    sessionId: "session-1",
    endpointId: "runtime-endpoint",
    bootId: "boot-1",
    contractHash: "",
    contracts: undefined,
    isOpen: () => true,
  });
  host.registerSource({
    id: editorSource,
    origin: "editor",
    connectType: "editor",
    sessionId: "editor-session",
    endpointId: "editor-endpoint",
    bootId: "editor-boot",
    contractHash: "",
    contracts: undefined,
    // 本用例只验证 Runtime 腿的录制 tap：Editor 腿此刻**不可录**（连接不可用），
    // 于是"Editor 腿优先"（F8-§8-2）不会改变这里选中的源。
    isOpen: () => false,
  });

  const runtimeChannel = fakeChannel("runtime", "runtime-1");
  const runtimeSession = new DebugChannelSession({
    channel: runtimeChannel.channel,
    manager,
    log: () => undefined,
    recorder: { recordFrame: (channel, payloadKind, payload) => host.noteFrame(runtimeSource, channel, payloadKind, payload) },
  });
  const editorChannel = fakeChannel("editor", "editor-1");
  const editorSession = new DebugChannelSession({
    channel: editorChannel.channel,
    manager,
    log: () => undefined,
    recorder: { recordFrame: (channel, payloadKind, payload) => host.noteFrame(editorSource, channel, payloadKind, payload) },
  });

  const chunks: Buffer[] = [];
  const header = await host.start({
    filePath: "memory://runtime-channel.vbdrec",
    openSink: async () => ({
      write: async (bytes) => {
        chunks.push(Buffer.from(bytes));
      },
      sync: async () => undefined,
      close: async () => undefined,
    }),
  });
  assert.equal(header.connectType, "editor-player");
  assert.equal(host.state.origin, "runtime", "the only open source is the runtime leg");

  runtimeSession.acceptFrame(BridgePayloadKind.Json, CREATE_RUNTIME);
  runtimeSession.acceptFrame(BridgePayloadKind.Json, EVENT_RUNTIME);
  // 另一条腿的帧不得进当前录制（P1-B：一条录制只绑一个源）。
  editorSession.acceptFrame(BridgePayloadKind.Json, CREATE_EDITOR);

  const footer = await host.stop("disconnect");
  assert.equal(footer?.records, 2, "only the runtime-leg frames are recorded");
  assert.equal(header.connectType, "editor-player");
  assert.ok(Buffer.concat(chunks).length > 0, "the .vbdrec sink received bytes");
  assert.equal(host.state.records, 2);
  assert.equal(host.state.origin, "runtime");
});

test("picks the Editor leg when both legs are open and never relabels its origin (F8-§8-2)", async () => {
  const manager = new DebugInstanceManager({ now: () => 4_000, log: () => undefined });
  const host = new DebugRecordingHost({ now: () => 4_000, log: () => undefined });
  const register = (id: string, origin: "editor" | "runtime", connectType: "editor" | "editor-player"): void => {
    host.registerSource({
      id,
      origin,
      connectType,
      sessionId: `${id}-session`,
      endpointId: `${id}-endpoint`,
      bootId: `${id}-boot`,
      contractHash: "",
      contracts: undefined,
      isOpen: () => true,
    });
  };
  // 先注册 Runtime 腿：旧实现按 Map 插入顺序取第一个，会录到 Runtime 腿（与注释相反）。
  register("runtime-1", "runtime", "editor-player");
  register("editor-1", "editor", "editor");

  const chunks: Buffer[] = [];
  const header = await host.start({
    filePath: "memory://both-legs.vbdrec",
    openSink: async () => ({
      write: async (bytes) => {
        chunks.push(Buffer.from(bytes));
      },
      sync: async () => undefined,
      close: async () => undefined,
    }),
  });
  assert.equal(header.connectType, "editor", "Editor 腿优先（它录得到 ch0 + ch1）");
  assert.equal(host.state.origin, "editor");
  assert.equal(host.state.active, true);

  // 断连自动收尾也必须保住来源：旧实现先清 activeSourceId 再 stop()，lastRecording.origin 变 undefined。
  host.unregisterSource("editor-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.state.active, false);
  assert.equal(host.state.origin, "editor", "自动收尾后的最近一次录制仍标注来源腿");
  assert.ok(Buffer.concat(chunks).length > 0);
  assert.ok(host.state.records >= 0);
});

test("a footer write failure still publishes the failed recording state (F8-§7-a)", async () => {
  const host = new DebugRecordingHost({ now: () => 5_000, log: () => undefined });
  host.registerSource({
    id: "editor-failing-1",
    origin: "editor",
    connectType: "editor",
    sessionId: "session-failing",
    endpointId: "editor-endpoint",
    bootId: "editor-boot",
    contractHash: "",
    contracts: undefined,
    isOpen: () => true,
  });

  await host.start({
    filePath: "memory://footer-fails.vbdrec",
    openSink: async () => ({
      write: async (bytes) => {
        if (bytes.readUInt8(0) === DEBUG_RECORD_BLOCK_FOOTER) {
          throw new Error("footer write failed");
        }
      },
      sync: async () => undefined,
      close: async () => undefined,
    }),
  });

  // 旧实现只在成功路径写 lastRecording：收尾失败 ⇒ 状态停留在"录制中且没有失败信息"，
  // 面板既不会报错、也不会解锁按钮（Watch 到永远）。
  await assert.rejects(host.stop("sizeLimit"), /footer write failed/u);
  const state = host.state;
  assert.equal(state.active, false, "收尾失败也必须退出 active");
  assert.equal(state.finalized, true, "sink 已 close：结果可判定");
  assert.equal(state.deliverable, false, "footer 没写成 ⇒ 不可交付");
  assert.match(state.failure ?? "", /footer write failed/u, "失败原因必须透出，面板/监视器才能报错");
  assert.equal(state.origin, "editor", "失败路径也要保留来源腿");
});
