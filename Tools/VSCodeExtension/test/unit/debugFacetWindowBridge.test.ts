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
  type DebugFacetWindowMessage,
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

test("bridge forwards one update message per render, in order, and hydrates a late webview", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (editor, message) => {
      assert.equal(editor, "graph");
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(2) });

  assert.deepEqual(posted.map((message) => message.type), [DEBUG_FACET_UPDATE_MESSAGE, DEBUG_FACET_UPDATE_MESSAGE]);
  const second = posted[1];
  assert.equal(second?.type, DEBUG_FACET_UPDATE_MESSAGE);
  if (second?.type !== DEBUG_FACET_UPDATE_MESSAGE) {
    throw new Error("expected a debugFacetUpdate message");
  }
  assert.equal((second.update as { readonly seq?: unknown }).seq, 2);

  const snapshot = bridge.snapshotMessages("graph");
  assert.equal(snapshot.length, 1);
  const message = snapshot[0] as Extract<DebugFacetWindowMessage, { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }>;
  assert.equal(message.type, DEBUG_FACET_SNAPSHOT_MESSAGE);
  assert.equal(message.state, "active");
  assert.deepEqual(message.updates.map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(bridge.snapshotMessages("entity"), []);
});

test("bridge deduplicates replayed sequences and marks truncation", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    historyLimit: 2,
    broadcast: (_editor, message) => {
      posted.push(message);
      return 1;
    },
  });

  for (const seq of [1, 2, 3, 2, 3]) {
    facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(seq) });
  }

  assert.equal(posted.length, 3, "重复的 seq 不得重复转发");
  const snapshot = bridge.snapshotMessages("graph")[0] as Extract<
    DebugFacetWindowMessage,
    { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }
  >;
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.updates.map((entry) => entry.seq), [2, 3]);
});

test("bridge reset re-sends the retained history so a keyframe replay cannot shrink the timeline", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_editor, message) => {
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  facets.emitReset({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", reason: "reload" });

  assert.deepEqual(posted.map((message) => message.type), [
    DEBUG_FACET_UPDATE_MESSAGE,
    DEBUG_FACET_RESET_MESSAGE,
    DEBUG_FACET_SNAPSHOT_MESSAGE,
  ]);
  const snapshot = posted[2] as Extract<DebugFacetWindowMessage, { type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE }>;
  assert.deepEqual(snapshot.updates.map((entry) => entry.seq), [1]);
});

test("bridge resets local history when the debug session changes", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_editor, message) => {
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
  const snapshot = bridge.snapshotMessages("graph")[0] as Extract<
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

  const ack = bridge.handleWebviewMessage("graph", {
    type: DEBUG_FACET_ACK_MESSAGE,
    category: "graph",
    state: "replay",
    eventCount: 1,
    cursor: 0,
    executingNodeId: "node-1",
    instanceId: "exec-1",
  });
  assert.deepEqual(ack, { handled: true, replies: [] });
  assert.deepEqual(bridge.lastAck("graph"), {
    category: "graph",
    state: "replay",
    eventCount: 1,
    cursor: 0,
    executingNodeId: "node-1",
    instanceId: "exec-1",
  });

  const resync = bridge.handleWebviewMessage("graph", { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" });
  assert.equal(resync.handled, true);
  assert.equal(resync.replies.length, 1);
  assert.equal(resync.replies[0]?.type, DEBUG_FACET_SNAPSHOT_MESSAGE);

  assert.deepEqual(bridge.handleWebviewMessage("graph", { type: "unrelated" }), { handled: false, replies: [] });
});

test("bridge never hydrates an editor that does not own the category", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_editor, message) => {
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });

  assert.deepEqual(bridge.snapshotMessages("other"), []);
  assert.deepEqual(
    bridge.handleWebviewMessage("other", { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" }),
    { handled: true, replies: [] },
  );
  assert.equal(bridge.snapshotMessages("graph").length, 1);
  assert.equal(posted.length, 1);
});

test("bridge clears the retained timeline when the debug session is invalidated", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_editor, message) => {
      posted.push(message);
      return 1;
    },
  });

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  facets.emitReset({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", reason: "session" });

  assert.deepEqual(posted.map((message) => message.type), [DEBUG_FACET_UPDATE_MESSAGE, DEBUG_FACET_RESET_MESSAGE]);
  assert.deepEqual(bridge.snapshotMessages("graph"), [], "会话作废后不得再用旧历史回填");
  assert.deepEqual(
    bridge.handleWebviewMessage("graph", { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" }),
    { handled: true, replies: [] },
  );
});

test("bridge drops render updates without a numeric seq and reports it", () => {
  const facets = fakeFacets();
  const posted: DebugFacetWindowMessage[] = [];
  const logs: string[] = [];
  const bridge = new DebugFacetWindowBridge({
    facets,
    broadcast: (_editor, message) => {
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
    broadcast: (_editor, message) => {
      posted.push(message);
      return 1;
    },
  });

  assert.deepEqual(
    bridge.handleWebviewMessage("graph", { type: DEBUG_FACET_ACK_MESSAGE, category: "graph", eventCount: "1" }),
    { handled: true, replies: [] },
  );
  assert.equal(bridge.lastAck("graph"), undefined);

  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(1) });
  bridge.dispose();
  bridge.dispose();
  facets.emitRender({ category: "graph", moduleId: "visualbridge.graph", editor: "graph", update: update(2) });

  assert.equal(posted.length, 1, "dispose 后不得再转发");
  assert.deepEqual(bridge.handleWebviewMessage("graph", { type: DEBUG_FACET_RESYNC_MESSAGE, category: "graph" }), {
    handled: false,
    replies: [],
  });
});
