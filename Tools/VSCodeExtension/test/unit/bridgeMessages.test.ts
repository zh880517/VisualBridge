import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeProtocolError,
  parseBridgeMessage,
  type BridgeResponseMessage,
  type BridgeRevealRequest,
} from "../../src/bridge/bridgeProtocol";

function expectProtocolError(action: () => unknown, code: string, jsonPath: string): void {
  assert.throws(action, (errorValue: unknown) => errorValue instanceof BridgeProtocolError
    && errorValue.code === code
    && errorValue.jsonPath === jsonPath);
}

test("response ok branch rejects an error key instead of silently ignoring it", () => {
  // 附录 A.5：ok 分支不携带 error；schema 的 ok 分支是 additionalProperties:false。
  expectProtocolError(
    () => parseBridgeMessage({
      type: "response",
      requestId: "req-ok-1",
      status: "ok",
      error: "bridge.documentUnresolved",
    }),
    "bridge.unknownProperty",
    "$.error",
  );
  // null 同样算携带该键（schema 的 additionalProperties 不看值）。
  expectProtocolError(
    () => parseBridgeMessage({ type: "response", requestId: "req-ok-2", status: "ok", error: null }),
    "bridge.unknownProperty",
    "$.error",
  );

  const ok = parseBridgeMessage({ type: "response", requestId: "req-ok-3", status: "ok" }) as BridgeResponseMessage;
  assert.deepEqual(ok, { type: "response", requestId: "req-ok-3", status: "ok" });

  const failure = parseBridgeMessage({
    type: "response",
    requestId: "req-error-1",
    status: "error",
    error: "bridge.documentUnresolved",
  }) as BridgeResponseMessage;
  assert.deepEqual(failure, { type: "response", requestId: "req-error-1", status: "error", error: "bridge.documentUnresolved" });
});

test("reveal reference accepts integers only inside the safe integer range", () => {
  // 与 C# 校验器的 MaxSafeInteger 判据一致（附录 A.5：不越安全整数）。
  for (const reference of [0, 101, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    const reveal = parseBridgeMessage({ type: "reveal", requestId: "req-reveal-safe", reference }) as BridgeRevealRequest;
    assert.deepEqual(reveal, { type: "reveal", requestId: "req-reveal-safe", reference });
  }

  for (const reference of [Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1), 1.5, Number.MAX_VALUE]) {
    expectProtocolError(
      () => parseBridgeMessage({ type: "reveal", requestId: "req-reveal-unsafe", reference }),
      "bridge.invalidMessage",
      "$.reference",
    );
  }
});

test("the channel-0 reporting switch messages are part of the parsed union", () => {
  // P1-3：schema 已声明 debugSetEnabled / debugEnabled；宿主解析器必须认它们，
  // 否则共享 fixture 的 AJV 校验与宿主回放各说各话（新消息被"排除在断言之外"地绿）。
  const setFalse = parseBridgeMessage({ type: "debugSetEnabled", enabled: false });
  assert.deepEqual(setFalse, { type: "debugSetEnabled", enabled: false });
  const setTrue = parseBridgeMessage({ type: "debugSetEnabled", enabled: true });
  assert.deepEqual(setTrue, { type: "debugSetEnabled", enabled: true });

  const enabled = parseBridgeMessage({ type: "debugEnabled", enabled: true });
  assert.deepEqual(enabled, { type: "debugEnabled", enabled: true });
  const disabled = parseBridgeMessage({ type: "debugEnabled", enabled: false });
  assert.deepEqual(disabled, { type: "debugEnabled", enabled: false });
});

test("the reporting switch messages enforce enabled as a required boolean and reject extra keys", () => {
  // 与 schema 的 required:["type","enabled"] + additionalProperties:false 同判据（TS 侧严格）。
  expectProtocolError(
    () => parseBridgeMessage({ type: "debugSetEnabled" }),
    "bridge.missingProperty",
    "$.enabled",
  );
  expectProtocolError(
    () => parseBridgeMessage({ type: "debugEnabled", enabled: "true" }),
    "bridge.invalidMessage",
    "$.enabled",
  );
  expectProtocolError(
    () => parseBridgeMessage({ type: "debugSetEnabled", enabled: false, reason: "panel" }),
    "bridge.unknownProperty",
    "$.reason",
  );
  expectProtocolError(
    () => parseBridgeMessage({ type: "debugEnabled", enabled: 1 }),
    "bridge.invalidMessage",
    "$.enabled",
  );
});
