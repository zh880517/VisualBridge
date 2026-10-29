/**
 * E10 生产连接触发器（`RuntimePanelConnection`）的单测。
 *
 * 这里不是测"测试命令"：`RuntimePanelConnection` 是面板/图页面打开时真正调用的生产代码，
 * 它只借用宿主注入的那一个 `RuntimeBridgeService`（假对象在测试里替代它）。
 *
 * 覆盖的硬要求：
 * - 优先用发现记录（带 token）连接，不盲目跑端口段探测；
 * - 没有发现记录时退回附录 A.8 的端口段探测（并发 8 / 单口 300 ms）；
 * - 连接失败不抛异常，只落成可读原因，且可以再次 `ensureConnected` 重试；
 * - 单飞：面板与图页面同时打开只发起一次尝试；
 * - `connected` 以共享服务实例的真实状态为准（DAP 已连上时不重复连接）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeBridgeProtocolError } from "../../src/bridge/runtimeBridgeProtocol";
import type { RuntimeBridgeConnectionState, RuntimeBridgeInstance, RuntimeBridgeProbeOptions } from "../../src/bridge/runtimeBridgeService";
import { RuntimePanelConnection, type RuntimePanelBridge } from "../../src/debug/runtimePanelConnection";

function instance(overrides: Partial<RuntimeBridgeInstance> = {}): RuntimeBridgeInstance {
  return {
    recordPath: "C:/temp/record.json",
    instanceId: "editor-1",
    kind: "editor-play",
    tcpPort: 28301,
    token: "a".repeat(48),
    pid: 1234,
    generation: 3,
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface FakeBridge extends RuntimePanelBridge {
  readonly enumerateCalls: number;
  readonly connectCalls: readonly RuntimeBridgeInstance[];
  readonly probeCalls: readonly RuntimeBridgeProbeOptions[];
  setConnected(connected: boolean): void;
  setInstances(instances: readonly RuntimeBridgeInstance[]): void;
  setConnectError(error: Error | undefined): void;
  setProbeError(error: Error | undefined): void;
}

function fakeBridge(options: {
  readonly instances?: readonly RuntimeBridgeInstance[];
  readonly probeError?: Error;
  readonly connectError?: Error;
  readonly connectGate?: Promise<void>;
} = {}): FakeBridge {
  let instances = [...(options.instances ?? [])];
  let probeError = options.probeError;
  let connectError = options.connectError;
  let connected = false;
  let endpointId: string | undefined;
  let tcpPort: number | undefined;
  let kind: string | undefined;
  const connectCalls: RuntimeBridgeInstance[] = [];
  const probeCalls: RuntimeBridgeProbeOptions[] = [];
  let enumerateCalls = 0;

  const welcome = (id: string, connectType: string): ReturnType<RuntimePanelBridge["connect"]> => Promise.resolve({
    type: "welcome",
    protocolVersion: 4,
    endpointId: id,
    sessionId: `${id}#boot`,
    resumed: false,
    connectType,
    generation: 1,
    bootId: "boot",
    contractHash: "",
    payloads: ["json"],
    debugEnabled: true,
    startedAt: "2026-01-01T00:00:00Z",
  } as unknown as Awaited<ReturnType<RuntimePanelBridge["connect"]>>);

  const bridge: FakeBridge = {
    get state(): RuntimeBridgeConnectionState {
      return connected
        ? {
          connected: true,
          instanceId: endpointId ?? "unknown",
          kind: kind ?? "editor-player",
          tcpPort: tcpPort ?? 0,
          generation: 1,
          debugFrames: 2,
          debugEnvelopes: 3,
        }
        : { connected: false };
    },
    async enumerateInstances() {
      enumerateCalls += 1;
      return [...instances];
    },
    async connect(target) {
      connectCalls.push(target);
      if (options.connectGate !== undefined) await options.connectGate;
      if (connectError !== undefined) throw connectError;
      connected = true;
      endpointId = target.instanceId;
      tcpPort = target.tcpPort;
      kind = target.kind === "player" ? "player" : "editor-player";
      return welcome(target.instanceId, kind);
    },
    async probeAndConnect(probeOptions) {
      probeCalls.push(probeOptions);
      if (probeError !== undefined) throw probeError;
      connected = true;
      endpointId = "player-9";
      tcpPort = 28310;
      kind = "player";
      return welcome("player-9", "player");
    },
    get enumerateCalls() {
      return enumerateCalls;
    },
    connectCalls,
    probeCalls,
    setConnected(value) {
      connected = value;
    },
    setInstances(value) {
      instances = [...value];
    },
    setConnectError(error) {
      connectError = error;
    },
    setProbeError(error) {
      probeError = error;
    },
  };
  return bridge;
}

function noEndpoint(): RuntimeBridgeProtocolError {
  return new RuntimeBridgeProtocolError("runtime.noEndpoint", "$", "no endpoint");
}

test("connects to the live editor-play instance from discovery without probing ports", async () => {
  const service = fakeBridge({
    instances: [
      instance({ instanceId: "editor-1", kind: "editor-play", startedAt: "2026-01-01T00:00:00Z" }),
      instance({ instanceId: "editor-0", kind: "editor-play", startedAt: "2025-12-31T00:00:00Z" }),
      instance({ instanceId: "player-1", kind: "player", staleReason: "runtime.deadPid" }),
    ],
  });
  const connection = new RuntimePanelConnection({ service: () => service });

  const status = await connection.ensureConnected("debugPanel.open");
  assert.equal(status.state, "connected");
  assert.equal(status.endpointId, "editor-1");
  assert.equal(status.connectType, "editor-player");
  assert.equal(status.target, "127.0.0.1:28301");
  assert.equal(service.connectCalls.length, 1);
  assert.equal(service.connectCalls[0]?.instanceId, "editor-1");
  assert.equal(service.probeCalls.length, 0, "有发现记录时不该再探测端口段");
  assert.equal(connection.status.state, "connected");
});

test("falls back to the appendix A.8 port-range probe when no record exists", async () => {
  const service = fakeBridge();
  const connection = new RuntimePanelConnection({ service: () => service });

  const status = await connection.ensureConnected("graph.editor.open");
  assert.equal(status.state, "connected");
  assert.equal(service.connectCalls.length, 0);
  assert.equal(service.probeCalls.length, 1);
  const probe = service.probeCalls[0];
  assert.equal(probe?.host, "127.0.0.1");
  assert.equal(probe?.portRangeStart, 28300);
  assert.equal(probe?.portRangeEnd, 28349);
  assert.equal(probe?.timeoutMs, 300);
  assert.equal(probe?.concurrency, 8);
  assert.equal(probe?.token, "", "无记录时只能按 Player 的无认证规则探测");
});

test("connection failure becomes a readable status instead of a thrown error, and can be retried", async () => {
  const service = fakeBridge({ probeError: noEndpoint() });
  const logs: string[] = [];
  const connection = new RuntimePanelConnection({
    service: () => service,
    log: (message) => logs.push(message),
  });

  const failed = await connection.ensureConnected("debugPanel.open");
  assert.equal(failed.state, "failed", "失败必须落成状态，而不是抛出");
  assert.match(failed.detail ?? "", /未找到 Runtime 端点/u);
  assert.match(failed.detail ?? "", /28300-28349/u);
  assert.equal(connection.status.state, "failed");
  assert.ok(logs.some((line) => line.includes("connection failed")), "失败要留下可观测日志");

  // 重试：第二次 ensure 重新探测，成功后状态切回 connected。
  service.setProbeError(undefined);
  const retried = await connection.ensureConnected("debugPanel.retry");
  assert.equal(retried.state, "connected");
  assert.equal(service.probeCalls.length, 2);
});

test("concurrent ensure calls share a single connection attempt", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = fakeBridge({
    instances: [instance({ instanceId: "editor-7" })],
    connectGate: gate,
  });
  const connection = new RuntimePanelConnection({ service: () => service });

  const first = connection.ensureConnected("debugPanel.open");
  const second = connection.ensureConnected("graph.editor.open");
  assert.equal(second, first, "在途请求必须复用同一个 Promise");
  assert.deepEqual(connection.status.state, "connecting");
  release?.();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.state, "connected");
  assert.equal(right.state, "connected");
  assert.equal(service.connectCalls.length, 1, "单飞：只发起一次连接");
});

test("an existing shared connection (DAP attach) is reused instead of connecting again", async () => {
  const service = fakeBridge({ instances: [instance({ instanceId: "editor-dap" })] });
  service.setConnected(true);
  const connection = new RuntimePanelConnection({ service: () => service });

  const status = await connection.ensureConnected("debugPanel.open");
  assert.equal(status.state, "connected");
  assert.equal(service.connectCalls.length, 0);
  assert.equal(service.enumerateCalls, 0);
});

test("stale records with a live pid are still tried before probing", async () => {
  const service = fakeBridge({
    instances: [instance({ instanceId: "editor-frozen", staleReason: "runtime.staleRecord" })],
  });
  const connection = new RuntimePanelConnection({ service: () => service });

  const status = await connection.ensureConnected("graph.editor.open");
  assert.equal(status.state, "connected");
  assert.equal(service.connectCalls[0]?.instanceId, "editor-frozen");
  assert.equal(service.probeCalls.length, 0);
});
