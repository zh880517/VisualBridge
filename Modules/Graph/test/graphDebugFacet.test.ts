import assert from "node:assert/strict";
import test from "node:test";
import type { DebugRecord, EditorContext } from "@visualbridge/module-sdk";
import {
  GRAPH_DEBUG_CATEGORY,
  graphDebugFacet,
  normalizeEventKind,
  validateGraphOptions,
} from "../src/graphDebugFacet";

const record: DebugRecord = {
  seq: 7,
  sessionId: "window#boot",
  instanceId: "hero",
  category: "graph",
  frame: 3,
  method: "NodeStarted",
  params: { nodeId: "node-3", count: 1 },
  wireBytes: 24,
  at: 1_000,
};

function context(options: EditorContext<unknown>["project"]["options"]): EditorContext<unknown> {
  return {
    project: {
      projectId: "graph-project",
      moduleId: "visualbridge.graph",
      documentTypes: [],
      options,
    },
    documentType: { id: "logicGraph", editor: "graph", include: [], exclude: [], catalogs: [] },
    registry: undefined,
    catalogs: { get: () => undefined },
    log: () => undefined,
  };
}

test("Graph debug facet claims exactly the graph category with a suggested title", () => {
  assert.deepEqual([...graphDebugFacet.categories], [GRAPH_DEBUG_CATEGORY]);
  assert.equal(graphDebugFacet.windowTitle, "Graph");
});

test("Graph debug facet maps a record to a JSON render update without host internals", () => {
  const update = graphDebugFacet.onRecord(record, context(undefined));
  assert.deepEqual(update, {
    kind: "graph.debug",
    category: "graph",
    seq: 7,
    sessionId: "window#boot",
    instanceId: "hero",
    frame: 3,
    method: "NodeStarted",
    wireBytes: 24,
    at: 1_000,
    recordKind: "event",
    eventKind: "nodeStart",
    nodeId: "node-3",
  });
  // 公开契约之外没有任何宿主字段（原始字节/契约状态/args Map 都不在记录里）。
  assert.ok(!JSON.stringify(update).includes("contractState"));
});

test("Graph debug facet maps every legacy graphExecution kind from the contract method name", () => {
  const cases: readonly [string, string][] = [
    ["NodeStarted", "nodeStart"],
    ["node_start", "nodeStart"],
    ["NodeOutput", "nodeOutput"],
    ["DataNode", "dataNode"],
    ["EdgeValueChanged", "edgeValueChanged"],
    ["InstanceStarted", "instanceStarted"],
    ["InstanceStopped", "instanceStopped"],
    ["CustomThing", "CustomThing"],
  ];
  for (const [method, kind] of cases) {
    assert.equal(normalizeEventKind(method), kind, method);
  }
});

test("Graph debug facet carries the edge-value payload used by the timeline", () => {
  const edge: DebugRecord = {
    ...record,
    method: "EdgeValueChanged",
    params: { nodeId: "node-3", outputIndex: 2, value: "42" },
  };
  const update = graphDebugFacet.onRecord(edge, context(undefined));
  assert.equal(update?.eventKind, "edgeValueChanged");
  assert.equal(update?.nodeId, "node-3");
  assert.equal(update?.outputIndex, 2);
  assert.equal(update?.value, "42");
});

test("Graph debug facet distinguishes query results from events (P0-2)", () => {
  const query: DebugRecord = {
    ...record,
    method: "Query",
    kind: "queryResult",
    params: { nodeId: "node-3" },
  };
  const update = graphDebugFacet.onRecord(query, context(undefined));
  assert.equal(update?.recordKind, "queryResult");
  assert.equal(update?.eventKind, "queryResult");
  // 旧宿主/旧录制没有 `kind`：缺省按普通事件处理，不能因此丢事件。
  const legacy = graphDebugFacet.onRecord(record, context(undefined));
  assert.equal(legacy?.recordKind, "event");
});

test("Graph debug facet passes options.debug through to the window content", () => {
  const update = graphDebugFacet.onRecord(record, context({ debug: { title: "Custom" } }));
  assert.deepEqual(update?.options, { title: "Custom" });
});

test("Graph options validation locates options.debug with a JSON pointer", () => {
  assert.deepEqual(validateGraphOptions(undefined), []);
  assert.deepEqual(validateGraphOptions({ debug: { title: "ok" } }), []);

  const notAnObject = validateGraphOptions({ debug: 42 });
  assert.equal(notAnObject.length, 1);
  assert.equal(notAnObject[0]?.severity, "error");
  assert.equal(notAnObject[0]?.code, "graph.options.debugInvalid");
  assert.equal(notAnObject[0]?.path, "$.debug");

  const badTitle = validateGraphOptions({ debug: { title: 42 } });
  assert.equal(badTitle[0]?.path, "$.debug.title");
});
