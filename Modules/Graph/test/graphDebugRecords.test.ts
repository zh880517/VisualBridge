import assert from "node:assert/strict";
import test from "node:test";
import {
  graphDebugEvents,
  graphDebugInstances,
  mergeGraphDebugRecords,
  selectGraphDebugInstance,
  type GraphDebugRecordView,
} from "../src/debug/graphDebugRecords.js";

function record(seq: number, extra: Partial<GraphDebugRecordView> = {}): GraphDebugRecordView {
  return {
    seq,
    sessionId: "s1",
    instanceId: "exec-1",
    frame: 0,
    eventKind: "nodeStart",
    ...extra,
  };
}

test("graph debug records merge by seq, replace sessions, and drop query results", () => {
  const merged = mergeGraphDebugRecords(
    [record(2, { nodeId: "a" }), record(1)],
    [
      { seq: 3, update: record(2, { nodeId: "b" }) },
      { seq: 4, update: record(4, { recordKind: "queryResult", nodeId: "query-only" }) },
      { seq: 0, update: record(Number.NaN) },
    ],
  );
  assert.deepEqual(merged.map((entry) => entry.seq), [1, 2]);
  assert.equal(merged[1]?.nodeId, "b");

  const replaced = mergeGraphDebugRecords([record(9, { sessionId: "old" })], [
    { seq: 1, update: record(1, { sessionId: "new" }) },
  ]);
  assert.deepEqual(replaced.map((entry) => `${entry.sessionId}:${entry.seq}`), ["new:1"]);
});

test("query results never create or advance a debug instance", () => {
  const instances = graphDebugInstances([
    record(1, { instanceId: "exec-1", frame: 1, nodeId: "step_a" }),
    record(2, { instanceId: "exec-1", frame: 9, nodeId: "query-only", recordKind: "queryResult" }),
    record(3, { instanceId: "query-only-instance", nodeId: "ghost", recordKind: "queryResult" }),
  ]);
  assert.deepEqual(instances, [
    { instanceId: "exec-1", state: "running", currentNodeId: "step_a", frameIndex: 1 },
  ]);
});

test("query results never enter the event timeline", () => {
  const events = graphDebugEvents([
    record(1, { eventKind: "nodeStart", nodeId: "step_a" }),
    record(2, { eventKind: "queryResult", recordKind: "queryResult", nodeId: "step_a" }),
    record(3, { eventKind: "nodeOutput", nodeId: "step_a", outputIndex: 0 }),
  ], "exec-1");
  assert.deepEqual(events.map((event) => `${event.frameIndex}:${event.kind}`), ["0:nodeStart", "0:nodeOutput"]);
  assert.deepEqual(graphDebugEvents([], "exec-1"), []);
});

test("debug instance selection is sticky until the selected instance disappears", () => {
  const a = { instanceId: "exec-a" };
  const b = { instanceId: "exec-b" };

  assert.equal(selectGraphDebugInstance([a], "exec-a"), "exec-a");
  assert.equal(selectGraphDebugInstance([a, b], "exec-a"), "exec-a", "新实例不能抢走当前选择");
  assert.equal(selectGraphDebugInstance([b], "exec-a"), "exec-b", "当前实例消失后才回最新");
  assert.equal(selectGraphDebugInstance([a, b], undefined), "exec-b");
  assert.equal(selectGraphDebugInstance([a, b], "exec-a", "exec-b"), "exec-b", "显式跟踪优先");
  assert.equal(selectGraphDebugInstance([a], undefined, "exec-missing"), "exec-missing");
  assert.equal(selectGraphDebugInstance([], undefined), undefined);
});
