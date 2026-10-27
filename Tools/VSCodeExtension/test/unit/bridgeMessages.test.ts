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
