import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "@visualbridge/module-sdk";
import type {
  DebugFacetRenderEvent,
  DebugFacetResetEvent,
} from "../../src/debug/debugFacetRouter";
import {
  DEBUG_FACET_ACK_MESSAGE,
  DEBUG_FACET_RESET_MESSAGE,
  DEBUG_FACET_RESYNC_MESSAGE,
  DEBUG_FACET_SNAPSHOT_MESSAGE,
  DEBUG_FACET_UPDATE_MESSAGE,
  DebugFacetWindowBridge,
  matchesDebugFacetDocument,
  type DebugFacetWindowMessage,
  type DebugFacetWindowTarget,
} from "../../src/debug/debugFacetWindowBridge";

interface FakeFacets {
  readonly onDidRender: (listener: (event: DebugFacetRenderEvent) => void) => () => void;
  readonly onDidReset: (listener: (event: DebugFacetResetEvent) => void) => () => void;
  readonly windowSource: (category: string) => { readonly moduleId: string; readonly editor: string } | undefined;
  emitRender(event: DebugFacetRenderEvent): void;
  emitReset(event: DebugFacetResetEvent): void;
}

function fakeFacets(): FakeFacets {
  const renderListeners = new Set<(event: DebugFacetRenderEvent) => void>();
  const resetListeners = new Set<(event: DebugFacetResetEvent) => void>();
  return {
    onDidRender: (listener) => {
      renderListeners.add(listener);
      return () => renderListeners.delete(listener);
    },
    onDidReset: (listener) => {
      resetListeners.add(listener);
      return () => resetListeners.delete(listener);
    },
    windowSource: (category) => category === "graph"
      ? { moduleId: "visualbridge.graph", editor: "graph" }
      : undefined,
    emitRender: (event) => {
      for (const listener of renderListeners) listener(event);
    },
    emitReset: (event) => {
      for (const listener of resetListeners) listener(event);
    },
  };
}

function update(seq: number, extra: JsonObject = {}): JsonObject {
  return { kind: "graph.debug", category: "graph", sessionId: "s1", seq, ...extra };
}

/** 测试用的单个 Graph 文档目标（G1d：投递按 editor + documentId）。 */
const graphTarget: DebugFacetWindowTarget = { editor: "graph" };

test("bridge forwards one update message per render, in order, and hydrates a late webview", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const targets: DebugFacetWindowTarget[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (target, message) => {
      assert.equal(target.editor, "graph");
      targets.push(target);
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(2) });

  assert.deepEqual(posted.map((message) => message.type), [DEBUG_FACET_UPDATE_MESSAGE, DEBUG_FACET_UPDATE_MESSAGE]);
  // 记录里没有 documentId：目标不带归属，宿主按 editor 面投递（身份未知的降级路径）。
  assert.deepEqual(targets.map((target) => target.documentId), [undefined, undefined]);
  const second = posted[1];
  assert.equal(second?.type, DEBUG_FACET_UPDATE_MESSAGE);
  if (second?.type !== DEBUG_FACET_UPDATE_MESSAGE) {
    throw new Error("expected a debugFacetUpdate message");
  }
  assert.equal((second.update as { readonly seq?: unknown }).seq, 2);

  const snapshot = bridge.snapshotMessages(graphTarget);
  assert.equal(snapshot.length, 1);
  const message = snapshot[0] as Extract<DebugFacetWindowMessage, { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }>;
  assert.equal(message.type, DEBUG_FACET_SNAPSHOT_MESSAGE);
  assert.equal(message.state, "active");
  assert.deepEqual(message.updates.map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(bridge.snapshotMessages({ editor: "entity" }), []);
  assert.deepEqual(bridge.knownCategories(), [{ category: "graph", editor: "graph" }]);
});

test("bridge deduplicates replayed sequences and marks truncation", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    historyLimit: 2,
    broadcast: (_target, message) => {
      posted.push(message);
      return 1;
    },
  });

  for (const seq of [1, 2, 3, 2, 3]) {
    facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(seq) });
  }

  assert.equal(posted.length, 3, "重复的 seq 不得重复转发");
  const snapshot = bridge.snapshotMessages(graphTarget)[0] as Extract<
    DebugFacetWindowMessage,
    { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
  >;
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.updates.map((entry) => entry.seq), [2, 3]);
});

test("bridge asks the host to re-hydrate after a category rebuild and keeps the retained history", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  let resyncs = 0;
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_target, message) => {
      posted.push(message);
      return 1;
    },
    onSnapshotNeeded: () => {
      resyncs += 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  facets.emitReset({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", reason: "reload" });

  // 重置本身只发 reset；快照由宿主按**目标文档**逐会话投递（G1d），桥不再广播一份公共快照。
  assert.deepEqual(posted.map((message) => message.type), [
    DEBUG_FACET_UPDATE_MESSAGE,
    DEBUG_FACET_RESET_MESSAGE,
  ]);
  assert.equal(resyncs, 1, "分类重建后必须让宿主重新水化，否则 Webview 会停在空时间轴");
  const snapshot = bridge.snapshotMessages(graphTarget)[0] as Extract<
    DebugFacetWindowMessage,
    { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
  >;
  assert.deepEqual(snapshot.updates.map((entry) => entry.seq), [1], "桥自己的历史必须保留，供重新水化");
});

test("bridge resets local history when the debug session changes", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_target, message) => {
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(9, { sessionId: "s1" }),
  });
  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(1, { sessionId: "s2" }),
  });

  assert.deepEqual(posted.map((message) => message.type), [
    DEBUG_FACET_UPDATE_MESSAGE,
    DEBUG_FACET_RESET_MESSAGE,
    DEBUG_FACET_UPDATE_MESSAGE,
  ]);
  const snapshot = bridge.snapshotMessages(graphTarget)[0] as Extract<
    DebugFacetWindowMessage,
    { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
  >;
  assert.deepEqual(snapshot.updates.map((entry) => entry.seq), [1]);
});

test("bridge records webview acks and answers a resync with a snapshot", () => {
  const facets = fakeFacets();
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: () => 1,
  });
  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });

  const ack = bridge.handleWebviewMessage(graphTarget, {
    type: DEBUG_FACET_ACK_MESSAGE,
    category: "graph",
    state: "replay",
    eventCount: 1,
    cursor: 0,
    executingNodeId: "node-1",
    instanceId: "exec-1",
  });
  assert.deepEqual(ack, { handled: true, replies: [] });
  assert.deepEqual(bridge.lastAck(graphTarget), {
    category: "graph",
    state: "replay",
    eventCount: 1,
    cursor: 0,
    executingNodeId: "node-1",
    instanceId: "exec-1",
  });

  const resync = bridge.handleWebviewMessage(graphTarget, { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" });
  assert.equal(resync.handled, true);
  assert.equal(resync.replies.length, 1);
  assert.equal(resync.replies[0]?.type, DEBUG_FACET_SNAPSHOT_MESSAGE);

  assert.deepEqual(bridge.handleWebviewMessage(graphTarget, { type: "unrelated" }), { handled: false, replies: [] });
});

test("bridge never hydrates an editor that does not own the category", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_target, message) => {
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });

  assert.deepEqual(bridge.snapshotMessages({ editor: "other" }), []);
  assert.deepEqual(
    bridge.handleWebviewMessage({ editor: "other" }, { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" }),
    { handled: true, replies: [] },
  );
  assert.equal(bridge.snapshotMessages(graphTarget).length, 1);
  assert.equal(posted.length, 1);
});

test("bridge clears the retained timeline when the debug session is invalidated", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_target, message) => {
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  facets.emitReset({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", reason: "session" });

  assert.deepEqual(posted.map((message) => message.type), [DEBUG_FACET_UPDATE_MESSAGE, DEBUG_FACET_RESET_MESSAGE]);
  assert.deepEqual(bridge.snapshotMessages(graphTarget), [], "会话作废后不得再用旧历史回填");
  assert.deepEqual(
    bridge.handleWebviewMessage(graphTarget, { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" }),
    { handled: true, replies: [] },
  );
});

test("bridge drops render updates without a numeric seq and reports it", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const logs: string[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_target, message) => {
      posted.push(message);
      return 1;
    },
    log: (message) => logs.push(message),
  });

  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: { kind: "graph.debug", category: "graph", sessionId: "s1", seq: "1" },
  });

  assert.deepEqual(posted, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /without a numeric seq/u);
});

test("bridge ignores malformed acks and stops all work after dispose", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_target, message) => {
      posted.push(message);
      return 1;
    },
  });

  assert.deepEqual(
    bridge.handleWebviewMessage(graphTarget, { type: DEBUG_FACET_ACK_MESSAGE, category: "graph", eventCount: "1" }),
    { handled: true, replies: [] },
  );
  assert.equal(bridge.lastAck(graphTarget), undefined);

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  bridge.dispose();
  bridge.dispose();
  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(2) });

  assert.equal(posted.length, 1, "dispose 后不得再转发");
  assert.deepEqual(bridge.handleWebviewMessage(graphTarget, { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" }), {
    handled: false,
    replies: [],
  });
});

/**
 * G1d 的作用域用例：增量/快照/resync 三处必须用**同一个**文档匹配规则。
 *
 * 通过"广播目标里带不带 documentId"断言增量侧，"按目标取快照"断言快照/resync 侧；
 * 若把作用域改回按 editor 广播（或只改广播不改快照），这条用例会红。
 */
test("bridge scopes updates, snapshots and resync to the document that produced the instance", () => {
  const facets = fakeFacets();
  const targets: DebugFacetWindowTarget[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (target, message) => {
      targets.push({ ...target });
      assert.equal(message.type, DEBUG_FACET_UPDATE_MESSAGE);
      return 1;
    },
  });

  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(1, { instanceId: "exec-a", documentId: "doc-a" }),
  });
  // 后续事件不带 documentId：桥必须按 instanceId 记住归属（`InstanceStarted` 只发一次）。
  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(2, { instanceId: "exec-a" }),
  });
  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(3, { instanceId: "exec-b", documentId: "doc-b" }),
  });
  // 身份未知（例如从中途开始的录制）：不带归属，按 editor 面投递。
  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(4, { instanceId: "exec-unknown" }),
  });

  assert.deepEqual(
    targets.map((target) => target.documentId),
    ["doc-a", "doc-a", "doc-b", undefined],
    "增量必须按实例所属文档投递（非 agent 广播）",
  );

  const seqs = (target: DebugFacetWindowTarget): readonly number[] => {
    const snapshot = bridge.snapshotMessages(target)[0] as Extract<
      DebugFacetWindowMessage,
      { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
    >;
    return snapshot.updates.map((entry) => entry.seq);
  };

  // 快照与增量同一规则：文档自己的 + 身份未知的；别的文档的增量不得出现。
  assert.deepEqual(seqs({ editor: "graph", documentId: "doc-a" }), [1, 2, 4]);
  assert.deepEqual(seqs({ editor: "graph", documentId: "doc-b" }), [3, 4]);
  assert.deepEqual(seqs({ editor: "graph", documentId: "doc-c" }), [4]);
  // 目标身份未知（宿主解析不出自己的 documentId）：全部投递，不静默丢数据。
  assert.deepEqual(seqs({ editor: "graph" }), [1, 2, 3, 4]);
  assert.deepEqual(bridge.snapshotMessages({ editor: "entity", documentId: "doc-a" }), []);

  // resync 与快照必须一致：B 只应拿到 B + 未知，C 只应拿到未知。
  const resyncB = bridge.handleWebviewMessage(
    { editor: "graph", documentId: "doc-b" },
    { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" },
  );
  assert.equal(resyncB.replies.length, 1);
  const replyB = resyncB.replies[0] as Extract<
    DebugFacetWindowMessage,
    { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
  >;
  assert.deepEqual(replyB.updates.map((entry) => entry.seq), [3, 4]);

  const resyncC = bridge.handleWebviewMessage(
    { editor: "graph", documentId: "doc-c" },
    { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" },
  );
  const replyC = resyncC.replies[0] as Extract<
    DebugFacetWindowMessage,
    { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
  >;
  assert.deepEqual(replyC.updates.map((entry) => entry.seq), [4]);
});

/** 新会话的 `instanceId` 可能被复用到另一个文档：实例→文档缓存必须随会话一起丢弃。 */
test("bridge forgets cached instance documents when the debug session changes", () => {
  const facets = fakeFacets();
  const targets: (string | undefined)[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (target, message) => {
      // 会话切换会先广播一条重置（按 editor 面，不带归属）；这里只看增量目标。
      if (message.type === DEBUG_FACET_UPDATE_MESSAGE) {
        targets.push(target.documentId);
      }
      return 1;
    },
  });

  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(1, { sessionId: "s1", instanceId: "exec-a", documentId: "doc-a" }),
  });
  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(1, { sessionId: "s2", instanceId: "exec-a" }),
  });

  assert.deepEqual(targets, ["doc-a", undefined], "新会话里同一 instanceId 不能沿用旧文档归属");
});

/** 共享匹配规则的真值表：桥与宿主都 import 它（G1d 评审 P2.1，不允许再出现两份拷贝）。 */
test("facet document matching treats an unknown identity as a match", () => {
  assert.equal(matchesDebugFacetDocument(undefined, undefined), true);
  assert.equal(matchesDebugFacetDocument(undefined, "doc-a"), true);
  assert.equal(matchesDebugFacetDocument("doc-a", undefined), true);
  assert.equal(matchesDebugFacetDocument("doc-a", "doc-a"), true);
  assert.equal(matchesDebugFacetDocument("doc-a", "doc-b"), false);
});

/**
 * G1d 评审补充 1：快照按 `update.instanceId` 反查缓存做**追溯归属**。
 *
 * 记录先以无归属进入历史，随后同实例的 `InstanceStopped` 带来 documentId；快照里那条旧记录
 * 必须只出现在归属文档中（不要求改协议）。实时增量已发出，无法追溯——这条用例只锁快照/resync。
 */
test("bridge attributes earlier unscoped history entries once the instance document is learned", () => {
  const facets = fakeFacets();
  const bridge = new DebugFacetWindowBridge({
    facets,
    // 实时投递不参与本用例（已经发出、无法追溯），这里只需要它可调用。
    broadcast: () => 1,
  });

  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(1, { instanceId: "exec-late" }),
  });
  // 同实例后来才带来归属（真实契约里 `InstanceStopped` 也带 documentId）。
  facets.emitRender({
    category: "graph",
    moduleId: "visualbridge.graph",
    editor: "graph",
    update: update(2, { instanceId: "exec-late", documentId: "doc-a" }),
  });

  const seqs = (documentId?: string): readonly number[] => {
    const target: DebugFacetWindowTarget = {
      editor: "graph",
      ...(documentId === undefined ? {} : { documentId }),
    };
    const snapshot = bridge.snapshotMessages(target)[0] as Extract<
      DebugFacetWindowMessage,
      { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
    >;
    return snapshot.updates.map((entry) => entry.seq);
  };

  assert.deepEqual(seqs("doc-a"), [1, 2], "学到归属后，早先的无归属条目必须追溯进归属文档");
  assert.deepEqual(seqs("doc-b"), [], "别人的快照不得再包含该实例的任何一条（包括追溯前的）");
  assert.deepEqual(seqs(undefined), [1, 2], "目标身份未知时仍投全部（不丢数据）");

  // resync 与快照共用同一条追溯规则。
  const resync = bridge.handleWebviewMessage(
    { editor: "graph", documentId: "doc-b" },
    { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" },
  );
  const reply = resync.replies[0] as Extract<
    DebugFacetWindowMessage,
    { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
  >;
  assert.deepEqual(reply.updates, []);
});
