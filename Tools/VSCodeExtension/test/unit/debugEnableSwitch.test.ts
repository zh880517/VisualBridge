/**
 * `Debug 上报 [开/关]` 状态机的单测（F3 §评审清单 P0）。
 *
 * 核心断言只有一句：**开关值只由服务端事件（welcome / 广播）决定**。
 * 因此"超时后回到原状态"必须靠"从未被乐观改写"实现，而不是靠"回滚代码对了"。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEBUG_ENABLE_TIMEOUT_MS, DebugEnableSwitch } from "../../src/debug/debugEnableSwitch";
import { FakeTransport, ManualTimer } from "./debugPanelFixture";

test("the initial value comes from welcome and nothing else", () => {
  const transport = new FakeTransport();
  const timer = new ManualTimer();
  const off = new DebugEnableSwitch({ mode: "editor", initialEnabled: false, transport, timeoutMs: 10, setTimer: timer.set, clearTimer: timer.clear });
  assert.equal(off.state.enabled, false);
  assert.equal(off.state.source, "welcome");
  assert.equal(off.state.canToggle, true);

  const on = new DebugEnableSwitch({ mode: "editor", initialEnabled: true, transport, timeoutMs: 10, setTimer: timer.set, clearTimer: timer.clear });
  assert.equal(on.state.enabled, true);
});

test("clicking does not change the switch: it only sends a request and waits", () => {
  const { enable, transport, timer } = setup(true);

  assert.equal(enable.request(false), "sent");
  assert.deepEqual(transport.sent, [false], "请求发出去了");
  // P0：不许本地乐观更新——按钮位置必须还是服务端的 true。
  assert.equal(enable.state.enabled, true);
  assert.equal(enable.state.pending, true);
  assert.equal(enable.state.pendingTarget, false);
  assert.equal(enable.state.canToggle, false, "挂起期间不允许再点");
  assert.equal(timer.pending, 1, "挂起即开始计时");
});

test("a second click while pending is ignored instead of sending again", () => {
  const { enable, transport } = setup(true);
  enable.request(false);
  assert.equal(enable.request(false), "ignored");
  assert.equal(enable.request(true), "ignored");
  assert.deepEqual(transport.sent, [false], "挂起中不重发");
  assert.equal(enable.state.pending, true);
});

test("the broadcast is the only thing that moves the switch", () => {
  const { enable } = setup(true);
  enable.request(false);
  enable.applyBroadcast(false);
  assert.equal(enable.state.enabled, false);
  assert.equal(enable.state.source, "broadcast");
  assert.equal(enable.state.pending, false);
  assert.equal(enable.state.error, undefined);
  assert.equal(enable.state.canToggle, true, "结算后可以再点");
});

test("a timeout rolls the button back to the server value, never to the optimistic one", () => {
  const { enable, timer, transport } = setup(true);
  enable.request(false);
  assert.equal(enable.state.enabled, true);

  timer.fireAll();

  // 这就是 P0 的判据：没有广播 ⇒ 值不变（仍是服务端的 true），只多一条"超时"提示。
  assert.equal(enable.state.enabled, true, "超时后按钮必须回到服务端状态，而不是停在 false");
  assert.equal(enable.state.pending, false);
  assert.equal(enable.state.error, "timeout");
  assert.equal(enable.state.canToggle, true);
  assert.deepEqual(transport.sent, [false]);
  assert.equal(timer.pending, 0, "定时器已清理");

  // 广播迟到：仍然以服务端为准（此时才允许翻转）。
  enable.applyBroadcast(false);
  assert.equal(enable.state.enabled, false);
  assert.equal(enable.state.error, undefined, "广播到达即清掉错误");
});

test("a send failure (no connection) rolls back immediately without waiting", () => {
  const transport = new FakeTransport();
  transport.answer = false;
  const timer = new ManualTimer();
  const enable = new DebugEnableSwitch({
    mode: "editor",
    initialEnabled: true,
    transport,
    timeoutMs: 10,
    setTimer: timer.set,
    clearTimer: timer.clear,
  });

  assert.equal(enable.request(false), "unavailable");
  assert.equal(enable.state.enabled, true);
  assert.equal(enable.state.error, "sendFailed");
  assert.equal(enable.state.pending, false, "没发出去就不该留挂起（否则按钮被锁死）");
  assert.equal(timer.pending, 0);
});

test("player mode greys the switch and sends nothing", () => {
  const { enable, transport, timer } = setup(true, "player");

  assert.equal(enable.state.mode, "player");
  assert.equal(enable.state.canToggle, false);

  assert.equal(enable.request(false), "unavailable");
  assert.deepEqual(transport.sent, [], "Player 模式不发 debugSetEnabled（C.7）");
  assert.equal(enable.state.enabled, true, "值只能来自服务端");
  assert.equal(timer.pending, 0);

  // 广播仍然生效（Player 也会广播），只是用户不能切。
  enable.applyBroadcast(false);
  assert.equal(enable.state.enabled, false);
  assert.equal(enable.state.canToggle, false);
});

test("switching to player cancels a pending request but keeps the last known value", () => {
  const { enable, timer } = setup(true);
  enable.request(false);
  assert.equal(enable.state.pending, true);
  enable.setMode("player");
  assert.equal(enable.state.pending, false);
  assert.equal(enable.state.mode, "player");
  assert.equal(enable.state.enabled, true);
  assert.equal(timer.pending, 0);

  enable.setMode("editor");
  assert.equal(enable.state.canToggle, true);
});

test("welcome re-applies the authoritative value and drops a pending request", () => {
  const { enable, timer } = setup(true);
  enable.request(false);
  enable.applyWelcome(false);
  assert.equal(enable.state.enabled, false);
  assert.equal(enable.state.source, "welcome");
  assert.equal(enable.state.pending, false);
  assert.equal(timer.pending, 0);
});

test("requesting the value that is already active still reaches the server but never enters pending", () => {
  const { enable, transport, timer } = setup(true);
  assert.equal(enable.request(true), "sent");
  assert.deepEqual(transport.sent, [true]);
  assert.equal(enable.state.pending, false);
  assert.equal(timer.pending, 0);
});

test("the default timeout is the production constant", () => {
  const enable = new DebugEnableSwitch({
    mode: "editor",
    initialEnabled: true,
    transport: new FakeTransport(),
    setTimer: new ManualTimer().set,
    clearTimer: new ManualTimer().clear,
  });
  assert.equal(enable.state.timeoutMs, DEBUG_ENABLE_TIMEOUT_MS);
  assert.equal(DEBUG_ENABLE_TIMEOUT_MS, 4_000);
});

test("losing the connection greys the switch and settles a pending request on the spot", () => {
  const { enable, timer, transport } = setup(true);
  enable.request(false);
  assert.equal(enable.state.pending, true);

  enable.setAvailable(false);
  // 广播永远不会来了：当场结算，值保持服务端值。
  assert.equal(enable.state.pending, false);
  assert.equal(enable.state.enabled, true);
  assert.equal(enable.state.error, "sendFailed");
  assert.equal(enable.state.canToggle, false, "没有连接时按钮置灰（C.7 状态栏）");
  assert.equal(timer.pending, 0);

  // 断连期间的显式调用（测试/命令层直接调）也不发消息、不改值。
  const sent = transport.sent.length;
  assert.equal(enable.request(false), "unavailable");
  assert.equal(transport.sent.length, sent);
  assert.equal(enable.state.enabled, true);

  enable.setAvailable(true);
  assert.equal(enable.state.canToggle, true, "重连后恢复可点");
});

test("a send failure because the queue vanished still never flips the switch", () => {
  const transport = new FakeTransport();
  const timer = new ManualTimer();
  const enable = new DebugEnableSwitch({
    mode: "editor",
    initialEnabled: false,
    transport,
    timeoutMs: 10,
    setTimer: timer.set,
    clearTimer: timer.clear,
  });
  transport.answer = false;
  assert.equal(enable.request(true), "unavailable");
  assert.equal(enable.state.enabled, false, "值只能是服务端的 false");
  assert.equal(enable.state.error, "sendFailed");
  assert.equal(enable.state.pending, false);
  assert.equal(timer.pending, 0);
});

function setup(initialEnabled: boolean, mode: "editor" | "player" = "editor"): {
  readonly enable: DebugEnableSwitch;
  readonly transport: FakeTransport;
  readonly timer: ManualTimer;
} {
  const transport = new FakeTransport();
  const timer = new ManualTimer();
  const enable = new DebugEnableSwitch({
    mode,
    initialEnabled,
    transport,
    timeoutMs: 10,
    setTimer: timer.set,
    clearTimer: timer.clear,
  });
  return { enable, transport, timer };
}
