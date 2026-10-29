import assert from "node:assert/strict";
import test from "node:test";
import { DebugPanelQueryNotices } from "../../src/debug/debugPanelQueryNotices";

/**
 * 面板查询提示状态机（F8-§5）：并发查询的提示按 `requestId` 各自记账，
 * 完成时只清自己那条；服务端最近提示一旦更新就压过更旧的本地提示。
 */

test("two concurrent queries keep their own notice and clear it in completion order", () => {
  const notices = new DebugPanelQueryNotices();
  const first = notices.begin("正在查询 IGraphQuery.Query…", 1000);
  notices.bind(first, "req-7");
  const second = notices.begin("正在查询 IGraphQuery.Ping…", 1001);
  notices.bind(second, "req-8");
  assert.equal(notices.pendingCount, 2, "两条在途查询各有一条提示（旧实现是一个槽位）");

  // 后发先完成：只撤第二条，第一条的"正在查询"必须还在（旧实现会把两条一起清掉）。
  notices.complete(second);
  assert.equal(notices.pendingCount, 1);
  assert.equal(notices.select(undefined, 0)?.message, "正在查询 IGraphQuery.Query…");

  // 先发后完成：最后一条也撤掉。
  notices.complete(first);
  assert.equal(notices.pendingCount, 0);
  assert.equal(notices.select(undefined, 0), undefined);
});

test("a completion by request id clears only the notice bound to that request", () => {
  const notices = new DebugPanelQueryNotices();
  const first = notices.begin("正在查询 A…", 1000);
  notices.bind(first, "req-1");
  const second = notices.begin("正在查询 B…", 1000);
  notices.bind(second, "req-2");

  notices.completeRequest("req-1");
  assert.deepEqual(notices.pendingNotices.map((entry) => entry.requestId), ["req-2"]);
  notices.completeRequest("req-404");
  assert.equal(notices.pendingCount, 1, "未知请求号是幂等的，不得误清别的提示");
});

test("a newer server notice wins over a stale local notice (no indefinite suppression)", () => {
  const notices = new DebugPanelQueryNotices();
  notices.begin("正在查询 IGraphQuery.Query…", 1000);

  // 在途期间服务端给了新提示（超时/失败）：它的时间戳更晚 ⇒ 必须显示服务端那条。
  assert.equal(
    notices.select({ kind: "error", message: "查询 req-7 失败：实例已结束。" }, 1200)?.message,
    "查询 req-7 失败：实例已结束。",
  );

  // 本地又产生更新的提示（例如用户点了下一条查询）⇒ 本地重新压过旧的服务端提示。
  notices.record({ kind: "error", message: "没有可用的调试连接：查询没有发出。" }, 1300);
  assert.equal(
    notices.select({ kind: "error", message: "查询 req-7 失败：实例已结束。" }, 1200)?.message,
    "没有可用的调试连接：查询没有发出。",
  );

  // 服务端再来一条更新的提示 ⇒ 又轮到服务端。
  assert.equal(
    notices.select({ kind: "info", message: "查询 req-8 已返回。" }, 1400)?.message,
    "查询 req-8 已返回。",
  );
});

test("reset drops every notice from the previous connection", () => {
  const notices = new DebugPanelQueryNotices();
  const token = notices.begin("正在查询 A…", 1000);
  notices.bind(token, "req-1");
  notices.record({ kind: "warning", message: "旧连接的结果" }, 1100);

  notices.reset();
  assert.equal(notices.pendingCount, 0);
  assert.equal(notices.newest, undefined);
  assert.equal(notices.select({ kind: "info", message: "新连接的提示" }, 2000)?.message, "新连接的提示");
});
