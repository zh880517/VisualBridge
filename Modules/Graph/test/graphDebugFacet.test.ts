import assert from "node:assert/strict";
import test from "node:test";
import type { DebugRecord, EditorContext } from "@visualbridge/module-sdk";
import {
  GRAPH_DEBUG_CATEGORY,
  graphDebugFacet,
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
    instanceId: "hero",
    frame: 3,
    method: "NodeStarted",
    wireBytes: 24,
    nodeId: "node-3",
  });
  // 公开契约之外没有任何宿主字段（原始字节/契约状态/args Map 都不在记录里）。
  assert.ok(!JSON.stringify(update).includes("contractState"));
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
