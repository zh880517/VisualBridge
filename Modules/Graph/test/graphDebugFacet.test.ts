import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { DebugRecord, EditorContext } from "@visualbridge/module-sdk";
import {
  GRAPH_DEBUG_CATEGORY,
  GRAPH_DEBUG_EVENT_KIND_ALIASES,
  graphDebugFacet,
  normalizeEventKind,
  normalizeMethodKey,
  validateGraphOptions,
} from "../src/graphDebugFacet";

/** 真实契约产物（Unity 侧生成器输出，跟着仓库走，不依赖 Unity 或 cwd）。 */
const CONTRACT_FILE = ["UnityProject", "Assets", "VisualBridgeGenerated", "Debug", "debug-contracts.json"] as const;

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
    ["NODE-STARTED", "nodeStart"],
    ["NodeOutput", "nodeOutput"],
    ["DataNode", "dataNode"],
    ["EdgeValueChanged", "edgeValueChanged"],
    ["InstanceStarted", "instanceStarted"],
    ["InstanceStopped", "instanceStopped"],
    // 契约里没有 NodeStart：`node_start` 不再被猜成 `nodeStart`（G1c 删除多余别名）。
    ["node_start", "node_start"],
    ["CustomThing", "CustomThing"],
  ];
  for (const [method, kind] of cases) {
    assert.equal(normalizeEventKind(method), kind, method);
  }
});

/**
 * G1c 的守卫：别名表必须**逐一等于**真实契约，不多不少。
 *
 * 读的是 Unity 生成的 `debug-contracts.json`（生成产物随仓库tracked），不是测试里的副本：
 * 契约里改一个方法名、加一个方法、删一个方法，这里都会红。用例本身不启动 Unity。
 */
test("Graph debug alias table mirrors the generated Unity graph contract exactly", () => {
  const methods = contractGraphMethods();
  assert.ok(methods.length > 0, "debug-contracts.json 的 graph 类别至少要有一个方法");
  const keys = Object.keys(GRAPH_DEBUG_EVENT_KIND_ALIASES).sort();
  // 用**生产实现**归一，测试不再自抄一份，避免将来只改生产归一化时两边漂移。
  const expected = methods.map(normalizeMethodKey).sort();
  assert.deepEqual(keys, expected, "别名表的键必须逐一等于 graph 契约的方法名（词形归一后）");
  assert.equal(
    new Set(Object.values(GRAPH_DEBUG_EVENT_KIND_ALIASES)).size,
    keys.length,
    "每个契约方法必须映射到独立的事件种类",
  );
  for (const method of methods) {
    assert.ok(
      Object.values(GRAPH_DEBUG_EVENT_KIND_ALIASES).includes(normalizeEventKind(method)),
      `${method} 必须归一成契约登记的事件种类`,
    );
  }
});


/** 从编译产物目录向上找仓库根：`node --test` 的 cwd 可变，不能靠 cwd 定位。 */
function repositoryRoot(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(directory, ...CONTRACT_FILE))) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  throw new Error(
    `未找到 ${CONTRACT_FILE.join("/")}（从 ${__dirname} 向上）：守卫用例必须在仓库内运行。`,
  );
}

/** 契约里声明了某个载荷参数的 graph 方法名（用于"从契约驱动"的断言，避免手抄清单）。 */
function contractMethodsDeclaring(parameterName: string): string[] {
  const path = join(repositoryRoot(), ...CONTRACT_FILE);
  const contract = JSON.parse(readFileSync(path, "utf8")) as {
    categories?: {
      name?: string;
      interfaces?: { methods?: { name?: string; parameters?: { name?: string; role?: string }[] }[] }[];
    }[];
  };
  const category = contract.categories?.find((entry) => entry.name === "graph");
  assert.ok(category, "debug-contracts.json 里必须有 graph 类别");
  return (category.interfaces ?? []).flatMap((contractInterface) =>
    (contractInterface.methods ?? [])
      .filter((method) => (method.parameters ?? []).some(
        (parameter) => parameter.name === parameterName && parameter.role === "payload"))
      .map((method) => method.name ?? ""),
  );
}

function contractGraphMethods(): string[] {
  const path = join(repositoryRoot(), ...CONTRACT_FILE);
  const contract = JSON.parse(readFileSync(path, "utf8")) as {
    categories?: { name?: string; interfaces?: { methods?: { name?: string }[] }[] }[];
  };
  const category = contract.categories?.find((entry) => entry.name === "graph");
  assert.ok(category, "debug-contracts.json 里必须有 graph 类别");
  return (category.interfaces ?? []).flatMap((contractInterface) =>
    (contractInterface.methods ?? []).map((method) => method.name ?? ""),
  );
}

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

/**
 * `outputIndex = 0` 在线格式里不出现（PushParam 跳过默认值，附录 A.4/B.2），而 0 是最常见的
 * 输出端口。契约里带 outputIndex 的事件有两条：`nodeOutput` 与 `edgeValueChanged`（边由
 * nodeId + outputIndex 标识）——两条都必须把缺失读成 0，否则 `nodeId:0` 的边键整条丢失。
 */
test("Graph debug facet treats a missing outputIndex as the wire default 0 for every port-bearing event", () => {
  const nodeOutput: DebugRecord = {
    ...record,
    method: "NodeOutput",
    params: { nodeId: "node-3" },
  };
  const update = graphDebugFacet.onRecord(nodeOutput, context(undefined));
  assert.equal(update?.eventKind, "nodeOutput");
  assert.equal(update?.nodeId, "node-3");
  assert.equal(update?.outputIndex, 0, "缺失的 outputIndex 必须显式补成 0");

  // 边事件同样如此：丢了 outputIndex 就丢了边的身份（`nodeId:outputIndex`）。
  const edge: DebugRecord = { ...record, method: "EdgeValueChanged", params: { nodeId: "node-3", value: "42" } };
  const edgeUpdate = graphDebugFacet.onRecord(edge, context(undefined));
  assert.equal(edgeUpdate?.eventKind, "edgeValueChanged");
  assert.equal(edgeUpdate?.value, "42");
  assert.equal(edgeUpdate?.outputIndex, 0, "边事件的缺失 outputIndex 也必须补成 0，否则边键 nodeId:0 丢失");

  // 其它事件不做这个补齐：缺失就是缺失，不能凭空造出 outputIndex。
  const nodeStarted: DebugRecord = { ...record, method: "NodeStarted", params: { nodeId: "node-3" } };
  assert.equal(graphDebugFacet.onRecord(nodeStarted, context(undefined))?.outputIndex, undefined);

  // 显式给了非 0 时原样保留。
  const second: DebugRecord = { ...record, method: "NodeOutput", params: { nodeId: "node-3", outputIndex: 2 } };
  assert.equal(graphDebugFacet.onRecord(second, context(undefined))?.outputIndex, 2);
});

/**
 * 表 A 的"防再漏"元断言：**从契约枚举**所有带 `outputIndex` 载荷参数的方法，逐个断言"缺失 ⇒ 0"。
 *
 * 契约里将来加第三个带 `outputIndex` 的方法时，这条断言会自动多枚举一个方法（不需要再手写用例）；
 * 反过来说，如果这条断言永远只枚举到两个方法，那说明它读错了字段名——它自己也会因此失去意义，
 * 所以下面同时断言枚举结果非空且与别名表里的方法名可对齐。
 */
test("Graph debug facet defaults a missing outputIndex for every contract method that declares it", () => {
  const methods = contractMethodsDeclaring("outputIndex");
  assert.ok(methods.length >= 2, `契约里至少应有 NodeOutput 与 EdgeValueChanged 声明 outputIndex，实际枚举到 ${methods.length} 个`);

  for (const methodName of methods) {
    const missing: DebugRecord = { ...record, method: methodName, params: { nodeId: "node-3", value: "42" } };
    const updated = graphDebugFacet.onRecord(missing, context(undefined));
    assert.ok(updated !== undefined, `${methodName} 必须能产生渲染增量`);
    assert.equal(updated.outputIndex, 0, `${methodName}（契约声明了 outputIndex）缺失时必须补成 0`);
  }

  // 反向：契约里没声明 outputIndex 的方法不得凭空补出该字段。
  for (const methodName of contractGraphMethods().filter((name) => !methods.includes(name))) {
    const missing: DebugRecord = { ...record, method: methodName, params: { nodeId: "node-3" } };
    assert.equal(graphDebugFacet.onRecord(missing, context(undefined))?.outputIndex, undefined,
      `${methodName} 未声明 outputIndex，不得补默认值`);
  }
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

/**
 * G1d：`documentId` 只随 `InstanceStarted`/`InstanceStopped` 的载荷出现，facet 原样透传给宿主，
 * 供 `DebugFacetWindowBridge` 把增量投给产生该实例的文档；其余事件不得凭空造出这个字段。
 */
test("Graph debug facet passes the instance documentId through for host-side scoping", () => {
  const started: DebugRecord = {
    ...record,
    method: "InstanceStarted",
    params: { documentTypeId: "logicGraph", documentId: "semantic-sample", graphName: "Sample", debugKey: "g1d" },
  };
  const startedUpdate = graphDebugFacet.onRecord(started, context(undefined));
  assert.equal(startedUpdate?.documentId, "semantic-sample");

  const stopped: DebugRecord = {
    ...record,
    method: "InstanceStopped",
    params: { documentId: "semantic-sample" },
  };
  assert.equal(graphDebugFacet.onRecord(stopped, context(undefined))?.documentId, "semantic-sample");

  // 其它事件没有 documentId：不能补，也不能沿用（facet 不累积状态，归属缓存由宿主负责）。
  assert.equal(graphDebugFacet.onRecord(record, context(undefined))?.documentId, undefined);
  const nonString: DebugRecord = { ...record, method: "InstanceStarted", params: { documentId: 42 } };
  assert.equal(graphDebugFacet.onRecord(nonString, context(undefined))?.documentId, undefined);
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
