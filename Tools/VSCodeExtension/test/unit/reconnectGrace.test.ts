import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RECONNECT_GRACE_MS,
  planReconnectGrace,
} from "../../src/bridge/reconnectGrace";

const ENDPOINT = "1b3121ab-2646-4e0f-a789-e970d4fbca8f";
const SESSION_ID = `${ENDPOINT}#boot-1`;
const NEW_BOOT_ID = "boot-2";
const DISCONNECTED_AT = 1_000_000;

/** 假时钟：14.9 s / 15.1 s 这类边界只用"注入的时刻"表达，绝不真等 15 秒。 */
function decide(resumeSessionId: string | undefined, elapsedMs: number, disconnectedAtMs: number | null = DISCONNECTED_AT): ReturnType<typeof planReconnectGrace> {
  return planReconnectGrace({
    sessionId: SESSION_ID,
    bootId: "boot-1",
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(disconnectedAtMs === null ? {} : { disconnectedAtMs }),
    nowMs: DISCONNECTED_AT + elapsedMs,
    nextBootId: () => NEW_BOOT_ID,
  });
}

test("the reconnect grace defaults to 15 s", () => {
  assert.equal(DEFAULT_RECONNECT_GRACE_MS, 15_000);
});

test("14.9 s after the disconnect still resumes the same session", () => {
  const decision = decide(SESSION_ID, 14_900);

  assert.equal(decision.resumed, true);
  assert.equal(decision.sessionId, SESSION_ID, "A reconnect inside the grace must keep the previous sessionId.");
  assert.equal(decision.bootId, "boot-1");
  assert.equal(decision.rotated, false);
});

test("15 s exactly is still inside the grace (inclusive upper bound)", () => {
  const decision = decide(SESSION_ID, 15_000);

  assert.equal(decision.resumed, true);
  assert.equal(decision.sessionId, SESSION_ID);
});

test("15.1 s after the disconnect starts a new session with a different sessionId", () => {
  const decision = decide(SESSION_ID, 15_100);

  assert.equal(decision.resumed, false);
  assert.notEqual(decision.sessionId, SESSION_ID, "An expired grace must issue a brand new sessionId.");
  assert.equal(decision.sessionId, `${ENDPOINT}#${NEW_BOOT_ID}`);
  assert.equal(decision.bootId, NEW_BOOT_ID);
  assert.equal(decision.rotated, true);
});

test("a mismatched resumeSessionId never rotates the current session", () => {
  const decision = decide(`${ENDPOINT}#unknown-boot`, 14_900);

  assert.equal(decision.resumed, false);
  assert.equal(decision.sessionId, SESSION_ID);
  assert.equal(decision.rotated, false);
});

test("a matching resume without a recorded disconnect keeps the current session", () => {
  // 没有观察到断开（会话仍被认为存活）：保持原有"匹配即续接"，不换发身份。
  const decision = decide(SESSION_ID, 1_000, null);

  assert.equal(decision.resumed, true);
  assert.equal(decision.sessionId, SESSION_ID);
  assert.equal(decision.rotated, false);
});

test("an explicit grace override is honoured", () => {
  assert.equal(decide(SESSION_ID, 1_000).resumed, true);
  const shortGrace = planReconnectGrace({
    sessionId: SESSION_ID,
    bootId: "boot-1",
    resumeSessionId: SESSION_ID,
    disconnectedAtMs: DISCONNECTED_AT,
    nowMs: DISCONNECTED_AT + 1_000,
    graceMs: 500,
    nextBootId: () => NEW_BOOT_ID,
  });
  assert.equal(shortGrace.resumed, false);
  assert.equal(shortGrace.rotated, true);
});
