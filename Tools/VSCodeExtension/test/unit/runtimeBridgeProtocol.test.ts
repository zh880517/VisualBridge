import assert from "node:assert/strict";
import test from "node:test";
import { BridgeProtocolError } from "../../src/bridge/bridgeProtocol";
import {
  RuntimeBridgeProtocolError,
  parseRuntimeBridgeDiscoveryRecord,
  parseRuntimeBridgeMessage,
  translateDelegatedHandshakeError,
} from "../../src/bridge/runtimeBridgeProtocol";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

function helloValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hello",
    protocolVersion: 4,
    role: "vscode",
    clientEndpointId: "1b3121ab-2646-4e0f-a789-e970d4fbca8f",
    token: TOKEN,
    contractHash: "",
    payloads: ["json"],
    ...overrides,
  };
}

test("delegated handshake errors are translated into the runtime error vocabulary", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["bridge.missingProperty", "runtime.missingProperty"],
    ["bridge.unknownProperty", "runtime.unknownProperty"],
    ["bridge.invalidToken", "runtime.invalidToken"],
    ["bridge.invalidMessage", "runtime.invalidMessage"],
    ["bridge.protocolVersionMismatch", "runtime.protocolVersionMismatch"],
    ["bridge.unknownMessageType", "runtime.unknownMessageType"],
    // A.6 握手码按 Runtime 腿的对外承诺归并（见 DELEGATED_HANDSHAKE_CODE_MAP）。
    ["runtime.unsupportedProtocolVersion", "runtime.protocolVersionMismatch"],
    ["runtime.unsupportedPayload", "runtime.invalidMessage"],
    ["runtime.roleMismatch", "runtime.roleMismatch"],
    ["runtime.contractHashMismatch", "runtime.contractHashMismatch"],
  ];
  for (const [source, expected] of cases) {
    const translated = translateDelegatedHandshakeError(new BridgeProtocolError(source, "$.field", "detail"));
    assert.ok(translated instanceof RuntimeBridgeProtocolError, `${source} 必须转译成 RuntimeBridgeProtocolError`);
    assert.equal(translated.code, expected, `${source} 的转译码`);
    assert.equal(translated.jsonPath, "$.field");
    assert.match(translated.message, /detail$/u);
  }
});

test("codes outside the runtime error vocabulary fall back to runtime.internalError", () => {
  // `bridge.capabilityMissing` 是 Editor 腿的请求级码，Runtime 腿不承诺它。
  const translated = translateDelegatedHandshakeError(new BridgeProtocolError("bridge.capabilityMissing", "$", "nope"));
  assert.ok(translated instanceof RuntimeBridgeProtocolError);
  assert.equal(translated.code, "runtime.internalError");
});

test("non-protocol failures stay untranslated so the host maps them to runtime.internalError", () => {
  assert.equal(translateDelegatedHandshakeError(new Error("boom")), undefined);
  const already = new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "carried");
  assert.equal(translateDelegatedHandshakeError(already), already);
});

test("a hello without a role surfaces as runtime.missingProperty instead of an internal error", () => {
  const hello = helloValue();
  delete hello.role;
  assert.throws(
    () => parseRuntimeBridgeMessage(hello),
    (errorValue: unknown) => errorValue instanceof RuntimeBridgeProtocolError
      && errorValue.code === "runtime.missingProperty",
  );
});

test("a welcome with an empty payload list surfaces as runtime.invalidMessage", () => {
  assert.throws(
    () => parseRuntimeBridgeMessage({
      type: "welcome",
      protocolVersion: 4,
      endpointId: "player-1",
      sessionId: "player-1#b00t0000e5",
      resumed: false,
      connectType: "player",
      generation: 2,
      bootId: "b00t0000e5",
      contractHash: "",
      payloads: [],
      debugEnabled: false,
      startedAt: "2026-08-31T12:00:00.000Z",
    }),
    (errorValue: unknown) => errorValue instanceof RuntimeBridgeProtocolError
      && errorValue.code === "runtime.invalidMessage",
  );
});

// 反向守卫：显式保留被删除的能力值/事件名，用于断言它们必须被拒绝。
// 零命中验收对本文件做精确路径豁免（命中清单入 G1b 报告）；禁止用转义/拼接隐藏守卫。
const REMOVED_CAPABILITY = "graphExecution";

function discoveryValue(capabilities: readonly string[]): Record<string, unknown> {
  return {
    formatVersion: 1,
    protocolVersion: 4,
    coreVersion: 1,
    instanceId: "editor-44936",
    kind: "editor-play",
    capabilities,
    tcpPort: 4594,
    token: TOKEN,
    pid: 44936,
    generation: 1,
    startedAt: "2026-08-31T12:00:00.000Z",
  };
}

test("the removed graph execution capability and event are rejected instead of silently accepted", () => {
  assert.throws(
    () => parseRuntimeBridgeDiscoveryRecord(discoveryValue([REMOVED_CAPABILITY])),
    (errorValue: unknown) => errorValue instanceof RuntimeBridgeProtocolError
      && errorValue.code === "runtime.invalidMessage",
  );
  // 事件载荷必须是**非空的合法批次**：空数组会在旧分支的 minItems 早退路径上被拒，
  // 那样的通过理由不是"该事件被移除"。jsonPath 钉死拒绝发生在 $.event 上。
  assert.throws(
    () => parseRuntimeBridgeMessage({
      type: "event",
      event: REMOVED_CAPABILITY,
      executionEvents: [{ executionId: "exec-1", frameIndex: 0, kind: "instanceStarted" }],
    }),
    (errorValue: unknown) => errorValue instanceof RuntimeBridgeProtocolError
      && errorValue.code === "runtime.invalidMessage"
      && errorValue.jsonPath === "$.event",
  );
});
