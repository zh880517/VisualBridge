import assert from "node:assert/strict";
import test from "node:test";
import type { DebugFacetReplayView, DebugFacetSnapshot } from "../../src/debug/debugFacetRouter";
import {
  createReplayFacetEndpoint,
  type ReplayFacetHost,
} from "../../src/debug/replayFacetEndpoint";

const SNAPSHOT: DebugFacetSnapshot = {
  windows: [],
  pending: 0,
  batches: 0,
  failures: 0,
  batchLimit: 100,
  lateRecords: 0,
  generic: { records: 0, dropped: 0 },
};

const REPLAY_VIEW: DebugFacetReplayView = { fromKeyframe: false, keyframeId: undefined, applied: 1, partial: false };

interface Recorder {
  readonly calls: string[];
  readonly host: ReplayFacetHost;
  readonly bridge: { dispose(): void };
  readonly attach: (bridge: { dispose(): void }) => void;
  readonly detach: (bridge: { dispose(): void }) => void;
}

function recorder(): Recorder {
  const calls: string[] = [];
  return {
    calls,
    host: {
      snapshot: () => SNAPSHOT,
      replayCategory: () => REPLAY_VIEW,
      dispose: () => {
        calls.push("host.dispose");
      },
    },
    bridge: {
      dispose: () => {
        calls.push("bridge.dispose");
      },
    },
    attach: () => {
      calls.push("attach");
    },
    detach: () => {
      calls.push("detach");
    },
  };
}

test("replay facet endpoint wires attach before rebuild and releases in detach → bridge → host order", () => {
  const scope = recorder();
  const endpoint = createReplayFacetEndpoint({
    host: scope.host,
    bridge: scope.bridge,
    attach: scope.attach,
    detach: scope.detach,
    rebuild: () => {
      scope.calls.push("rebuild");
    },
  });

  assert.deepEqual(scope.calls, ["attach", "rebuild"], "先挂桥（清窗口）再 rebuild（回放增量）");
  assert.equal(endpoint.snapshot(), SNAPSHOT);
  assert.deepEqual(endpoint.replayCategory("graph"), REPLAY_VIEW);
  assert.equal(endpoint.degraded, undefined, "正常端点没有降级标记");

  endpoint.dispose();
  assert.deepEqual(scope.calls, ["attach", "rebuild", "detach", "bridge.dispose", "host.dispose"]);
});

/**
 * 评审补充 2：`rebuild` 抛错时不能把回看桥留在"活动桥"位置上。
 *
 * 失败路径必须：detach（回退在线桥）→ 释放桥 → 释放 host，错误写日志，
 * 并返回一个**降级端点**（没有模块窗口、拒绝按分类重建）而不是 throw——
 * 否则控制器拿不到返回值，回看桥会永久占位（回看不可用 + 在线增量永远被压制）。
 */
test("a replay facet endpoint that fails to rebuild falls back to the live bridge and degrades", () => {
  const scope = recorder();
  const logs: string[] = [];
  const endpoint = createReplayFacetEndpoint({
    host: scope.host,
    bridge: scope.bridge,
    attach: scope.attach,
    detach: scope.detach,
    rebuild: () => {
      scope.calls.push("rebuild");
      throw new Error("rebuild exploded");
    },
    log: (message) => logs.push(message),
  });

  assert.deepEqual(scope.calls, ["attach", "rebuild", "detach", "bridge.dispose", "host.dispose"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /failed to start/u);
  assert.match(logs[0] ?? "", /rebuild exploded/u);

  // 降级端点：面板仍可读（通用视图来自回看 manager），但没有模块 facet 窗口/重建入口。
  const snapshot = endpoint.snapshot();
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.failures, 0);
  assert.equal(endpoint.replayCategory("graph"), undefined);
  // 控制器据此给用户一行可见提示（不能让用户只从 OutputChannel 才知道图区域为什么是空的）。
  assert.deepEqual(endpoint.degraded, { reason: "rebuild exploded" });

  // 降级端点被 dispose 时不再触碰已经释放的桥/host。
  endpoint.dispose();
  assert.deepEqual(scope.calls, ["attach", "rebuild", "detach", "bridge.dispose", "host.dispose"]);
});
