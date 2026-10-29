/**
 * 面板 Webview 资源与脚本的单测。
 *
 * 三层证据：
 * 1. 资源发布走 `webviewAssets` 的内容哈希机制（目录名 = 脚本+样式的 sha256）；
 * 2. 脚本语法可编译（
ew Function`）——字符串里的语法错误在真机上只会表现成"面板空白"；
 * 3. 用最小 DOM 桩真正执行一遍渲染：Player 模式开关置灰且点击**不发**任何消息（C.7）。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  DEBUG_PANEL_SCRIPT,
  DEBUG_PANEL_STYLE,
  debugPanelAssetHash,
  publishDebugPanelAssets,
} from "../../src/debug/debugPanelAssets";
import type { DebugPanelSnapshot } from "../../src/debug/debugPanelState";
import { EDITOR_CONNECTION } from "./debugPanelFixture";

test("the panel script is syntactically valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(DEBUG_PANEL_SCRIPT));
  assert.ok(DEBUG_PANEL_SCRIPT.length > 1_000);
  assert.ok(DEBUG_PANEL_STYLE.includes("--vscode-"));
});

test("assets are published into a content addressed directory and reused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vb-debug-panel-"));
  try {
    const unpacked = await publishDebugPanelAssets(root);
    const hash = debugPanelAssetHash();
    assert.equal(unpacked.hash, hash.slice("sha256:".length));
    assert.equal(path.dirname(unpacked.directory), root);
    assert.equal(path.basename(unpacked.directory), unpacked.hash);
    assert.match(unpacked.hash, /^[0-9a-f]{64}$/u);

    const webview = unpacked.webviews["debugPanel"];
    assert.ok(webview);
    const script = await readFile(webview.script, "utf8");
    const style = await readFile(webview.style, "utf8");
    assert.equal(script, DEBUG_PANEL_SCRIPT);
    assert.equal(style, DEBUG_PANEL_STYLE);

    // 再发布一次：同一份字节 ⇒ 同一目录（面板重开不会堆目录）。
    const again = await publishDebugPanelAssets(root);
    assert.equal(again.directory, unpacked.directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the hash is content addressed: different bytes get a different directory", async () => {
  // 哈希输入是脚本 + 样式；在这里独立复算一遍，证明"改脚本即换目录"不是空话。
  const { createHash } = await import("node:crypto");
  const recomputed = `sha256:${createHash("sha256").update(`${DEBUG_PANEL_SCRIPT}\u0000${DEBUG_PANEL_STYLE}`, "utf8").digest("hex")}`;
  assert.equal(debugPanelAssetHash(), recomputed);

  const changed = `sha256:${createHash("sha256").update(`${DEBUG_PANEL_SCRIPT}\u0000${DEBUG_PANEL_STYLE}x`, "utf8").digest("hex")}`;
  assert.notEqual(debugPanelAssetHash(), changed);
});

test("player mode renders the switch greyed out and a click posts nothing", () => {
  const webview = mountPanel();
  webview.render(snapshot({ mode: "player", canToggle: false, enabled: true }));

  const enable = webview.byId("enable");
  assert.equal(enable.disabled, true, "Player 模式下开关置灰（C.7）");
  assert.match(enable.textContent, /Debug 上报 \[开\]/u);

  webview.click("enable");
  assert.deepEqual(webview.posted.filter((message) => message.type === "command"), [], "Player 模式点击不得发 debugSetEnabled");
});

test("the query button forwards the selected instance/interface/method and respects busy", () => {
  const webview = mountPanel();
  webview.render(snapshot({
    query: {
      available: true,
      pending: 1,
      limit: 8,
      busy: false,
      notice: { kind: "warning", message: "晚到结果已丢弃（不回插时间轴）" },
    },
  }));
  const query = webview.byId("query");
  assert.equal(query.disabled, false, "有连接、未满时按钮可点");
  webview.click("query");
  assert.deepEqual(
    webview.posted.filter((message) => message.type === "command"),
    [{
      type: "command",
      command: "query",
      key: "graph\u0000hero",
      interfaceId: "IGraphDebuger",
      method: "NodeStarted",
    }],
    "点击只发一次查询意图，参数来自当前记录的实例/接口/方法",
  );
  assert.match(flatten(webview.byId("root")), /晚到结果已丢弃/u, "服务端的最近提示必须显示出来");

  webview.render(snapshot({
    query: { available: true, pending: 8, limit: 8, busy: true, notice: undefined },
  }));
  assert.equal(webview.byId("query").disabled, true, "达到并发上限时置灰（不排队）");
  webview.click("query");
  assert.equal(webview.posted.filter((message) => message.type === "command").length, 1, "置灰后点击不得再发");
});

test("query results are labelled distinctly in the timeline", () => {
  const webview = mountPanel();
  const state = snapshot({});
  const records = state.timeline.records.map((record, index) => (
    index === 0 ? { ...record, kind: "queryResult" } : record
  ));
  webview.render({ ...state, timeline: { ...state.timeline, records } });
  assert.match(flatten(webview.byId("root")), /\[查询结果\]/u);
});

test("replay exposes unattributable binary frames instead of pretending they never existed", () => {
  const webview = mountPanel();
  webview.render(snapshot({
    panelMode: "replay",
    replay: {
      filePath: "C:/recordings/session-1.vbdrec",
      records: 12,
      droppedRecords: 0,
      endedReason: "stopped",
      unattributableBinaryFrames: 3,
    },
  }));
  assert.match(
    flatten(webview.byId("root")),
    /该录制含 3 条无法归属的二进制帧/u,
    "冲突三的已知限制必须显式提示（录制只含单向帧，无法区分 debug/debugResult）",
  );
});

test("editor mode sends exactly one enable request per click and never flips locally", () => {
  const webview = mountPanel();
  webview.render(snapshot({ mode: "editor", canToggle: true, enabled: true }));
  const enable = webview.byId("enable");
  assert.equal(enable.disabled, false);

  webview.click("enable");
  const commands = webview.posted.filter((message) => message.type === "command");
  assert.deepEqual(commands, [{ type: "command", command: "enable", value: false }]);

  // 挂起中：置灰，再点也不发（宿主不做乐观更新，UI 也不许假装成功）。
  webview.render(snapshot({ mode: "editor", canToggle: false, enabled: true, pending: true }));
  assert.equal(webview.byId("enable").disabled, true);
  webview.click("enable");
  assert.equal(webview.posted.filter((message) => message.type === "command").length, 1);
});

test("the toolbar forwards stepping, granularity, filter and clear intents", () => {
  const webview = mountPanel();
  // 逐步模式：此时"回到实时"才可点（实时模式下它本来就禁用）。
  webview.render(snapshot({ panelMode: "replay", atStart: false, atEnd: false }));
  webview.click("previous");
  webview.click("next");
  webview.click("granularity-frame");
  webview.click("clear");
  webview.click("live");
  const input = webview.byId("filter");
  input.value = "boss";
  webview.fire("filter", "input");

  const commands = webview.posted.filter((message) => message.type === "command").map((message) => message.command);
  assert.deepEqual(commands, ["step", "step", "granularity", "clear", "live", "filter"]);
  assert.deepEqual(webview.posted.filter((message) => message.type === "command")[0], { type: "command", command: "step", direction: -1 });
  assert.deepEqual(webview.posted.filter((message) => message.type === "command")[2], { type: "command", command: "granularity", value: "frame" });
  assert.deepEqual(webview.posted.filter((message) => message.type === "command")[5], { type: "command", command: "filter", value: "boss" });
});

test("step buttons are disabled at the boundaries and while paused", () => {
  const webview = mountPanel();
  webview.render(snapshot({ atStart: true, atEnd: false }));
  assert.equal(webview.byId("previous").disabled, true, "到达最早位置时上一步禁用");
  assert.equal(webview.byId("next").disabled, false);

  webview.render(snapshot({ atStart: false, atEnd: true }));
  assert.equal(webview.byId("previous").disabled, false);
  assert.equal(webview.byId("next").disabled, true, "到达末尾时下一步禁用");

  webview.render(snapshot({ paused: true }));
  assert.equal(webview.byId("previous").disabled, true);
  assert.equal(webview.byId("next").disabled, true);
  assert.equal(webview.byId("pause").textContent, "继续");
});

test("the record button is honest: disabled until F5 wires it, then a plain toggle intent", () => {
  const webview = mountPanel();
  webview.render(snapshot({}));
  const record = webview.byId("record");
  assert.equal(record.disabled, true, "F5 未接入时录制按钮置灰");
  assert.match(record.title, /F5/u);
  webview.click("record");
  assert.deepEqual(webview.posted.filter((message) => message.type === "command"), [], "置灰按钮不发任何请求");

  webview.render(snapshot({ recordingAvailable: true, recordingActive: true }));
  assert.equal(webview.byId("record").disabled, false);
  assert.equal(webview.byId("record").textContent, "停止录制");
  webview.click("record");
  assert.deepEqual(
    webview.posted.filter((message) => message.type === "command"),
    [{ type: "command", command: "toggleRecording" }],
    "接入后只转发一次切换意图（录制状态由 F5 回报）",
  );
});

test("the return-to-live button is hidden in live mode and posts closeRecording while replaying", () => {
  const webview = mountPanel();
  webview.render(snapshot({}));
  assert.equal(webview.byId("replay-exit").hidden, true, "实时模式下不显示返回实时");
  assert.equal(webview.byId("replay-exit").disabled, true);
  webview.click("replay-exit");
  assert.deepEqual(webview.posted.filter((message) => message.type === "command"), [], "隐藏按钮不发请求");

  webview.render(snapshot({
    replay: { filePath: "C:/recordings/session-1.vbdrec", records: 12, droppedRecords: 1, endedReason: "sizeLimit" },
  }));
  const exit = webview.byId("replay-exit");
  assert.equal(exit.hidden, false, "回看时必须显示返回实时");
  assert.equal(exit.disabled, false);
  assert.match(exit.title, /session-1\.vbdrec/u);
  webview.click("replay-exit");
  assert.deepEqual(
    webview.posted.filter((message) => message.type === "command"),
    [{ type: "command", command: "closeRecording" }],
    "返回实时只转发一次 closeRecording 意图",
  );
});

test("facet windows show the host-owned title, the module content and the unloaded fallback", () => {
  const webview = mountPanel();
  webview.render(snapshot({
    facetWindows: [
      {
        category: "graph",
        state: "active",
        title: "调试分类 · graph",
        moduleTitle: "Graph",
        moduleId: "visualbridge.graph",
        editor: "graph",
        path: "modules[0].editors[0].debug",
        message: undefined,
        toolbar: ["replayCategory"],
        records: 2,
        batches: 1,
        pending: 0,
        content: { kind: "graph.debug", nodes: [1, 2] },
        updatedAt: 1_000,
        stale: false,
        rebuildable: true,
        diagnostics: [],
        replay: { fromKeyframe: false, keyframeId: undefined, applied: 2, partial: false },
      },
      {
        category: "table",
        state: "unavailable",
        title: "调试分类 · table",
        moduleTitle: undefined,
        moduleId: undefined,
        editor: undefined,
        path: undefined,
        message: "模块未加载，该分类回退到通用视图。",
        toolbar: ["replayCategory"],
        records: 0,
        batches: 0,
        pending: 0,
        content: undefined,
        updatedAt: undefined,
        stale: false,
        rebuildable: false,
        diagnostics: [],
        replay: undefined,
      },
    ],
  }));

  const text = flatten(webview.byId("windows"));
  assert.match(text, /Graph/u);
  assert.match(text, /graph\.debug/u);
  assert.match(text, /模块未加载/u);
  assert.match(text, /通用视图/u);
  assert.match(text, /上次重建：应用 2 条/u);

  webview.click("vb-debug-window-replay-0");
  assert.deepEqual(
    webview.posted.filter((message) => message.type === "command"),
    [{ type: "command", command: "replayCategory", value: "graph" }],
  );
  assert.equal(webview.byId("vb-debug-window-replay-1").disabled, true, "没有模块的窗口没有可重建的消费者");
});

test("a stale window whose module is unavailable never asks for a disabled rebuild (P1 a)", () => {
  const webview = mountPanel();
  webview.render(snapshot({
    facetWindows: [{
      category: "graph",
      state: "unavailable",
      title: "调试分类 · graph",
      moduleTitle: undefined,
      moduleId: undefined,
      editor: undefined,
      path: undefined,
      message: "模块未加载，该分类回退到通用视图。",
      toolbar: ["replayCategory"],
      records: 0,
      batches: 0,
      pending: 0,
      content: undefined,
      updatedAt: undefined,
      stale: true,
      rebuildable: false,
      diagnostics: [],
      replay: undefined,
    }],
  }));

  const replay = webview.byId("vb-debug-window-replay-0");
  assert.equal(replay.disabled, true, "没有可重建的模块消费者 ⇒ 按钮禁用");
  // 提示文案与按钮必须由同一个判据驱动：不能一边禁用按钮，一边让用户去点它。
  const hintText = textWithoutButtons(webview.byId("windows"));
  assert.doesNotMatch(hintText, /点按分类重建|点“按分类重建”/u);
  // 但状态不能就此沉默：必须给出用户能执行的下一步。
  assert.match(hintText, /重载模块/u);
  assert.match(flatten(webview.byId("windows")), /需重载模块/u);
});

test("the detail pane lists the parameter table and the truncated raw JSON", () => {
  const webview = mountPanel();
  webview.render(snapshot({}));
  const detail = webview.byId("detail");
  const text = flatten(detail);
  assert.match(text, /IGraphDebuger\.NodeStarted/u);
  assert.match(text, /nodeId/u);
  assert.match(text, /AAA…\(共 4000 字符\)/u);
  assert.match(text, /契约缺失：仅列出非默认值/u);
  assert.match(text, /byte\[\]/u);
  assert.match(text, /已截断/u);
});

test("instances render a selectable row and history warnings", () => {
  const webview = mountPanel();
  webview.render(snapshot({ historyMissing: true }));
  const list = webview.byId("instances");
  assert.match(flatten(list), /hero · graph/u);
  assert.match(flatten(list), /历史未记录/u);

  webview.click("vb-debug-instance-0");
  assert.deepEqual(
    webview.posted.filter((message) => message.type === "command"),
    [{ type: "command", command: "select", key: "graph\u0000hero" }],
  );
});

// ==== 最小 DOM 桩 + 脚本执行 ====

interface FakeNode {
  tag: string;
  className: string;
  id: string;
  textContent: string;
  title: string;
  disabled: boolean;
  hidden: boolean;
  value: string;
  readonly children: FakeNode[];
  readonly attributes: Map<string, string>;
  readonly listeners: Map<string, (() => void)[]>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeNode): FakeNode;
  replaceChildren(...nodes: FakeNode[]): void;
  addEventListener(type: string, handler: () => void): void;
}

function createNode(tag: string): FakeNode {
  const listeners = new Map<string, (() => void)[]>();
  const node: FakeNode = {
    tag,
    className: "",
    id: "",
    textContent: "",
    title: "",
    disabled: false,
    hidden: false,
    value: "",
    children: [],
    attributes: new Map<string, string>(),
    listeners,
    setAttribute(name, value) {
      node.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return node.attributes.get(name) ?? null;
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      node.children.length = 0;
      node.children.push(...nodes);
    },
    addEventListener(type, handler) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(handler);
      listeners.set(type, bucket);
    },
  };
  return node;
}

interface PanelHarness {
  readonly posted: Record<string, unknown>[];
  render(state: DebugPanelSnapshot): void;
  byId(id: string): FakeNode;
  click(id: string): void;
  fire(id: string, event: string): void;
}

function mountPanel(): PanelHarness {
  const root = createNode("div");
  root.id = "root";
  const posted: Record<string, unknown>[] = [];
  // vm 里造的对象原型来自另一个 realm，deepStrictEqual 会因原型不同判不等；落库前拍平成普通对象。
  const record = (message: Record<string, unknown>): void => {
    posted.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
  };
  const byId = new Map<string, FakeNode>([["root", root]]);
  const documentRef = {
    activeElement: undefined as FakeNode | undefined,
    getElementById: (id: string): FakeNode | undefined => byId.get(id),
    createElement: (tag: string): FakeNode => {
      const node = createNode(tag);
      // 脚本里通过 `node.id = ...` 赋值；这里用 defineProperty 把 id 写进索引，模拟浏览器的取节点。
      Object.defineProperty(node, "id", {
        configurable: true,
        get: () => node.attributes.get("id") ?? "",
        set: (value: string) => {
          node.attributes.set("id", value);
          byId.set(value, node);
        },
      });
      return node;
    },
  };
  const windowRef = {
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      if (type === "message") {
        (windowRef as unknown as { onMessage?: (event: unknown) => void }).onMessage = handler;
      }
    },
    __visualBridgeDebugPost: (message: Record<string, unknown>): void => {
      record(message);
    },
  };
  const sandbox: Record<string, unknown> = {
    document: documentRef,
    window: windowRef,
    acquireVsCodeApi: () => ({
      postMessage: (message: Record<string, unknown>) => record(message),
    }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(DEBUG_PANEL_SCRIPT, sandbox, { filename: "debugPanel.js" });
  const panel = (sandbox as { __visualBridgeDebugPanel?: { render: (state: DebugPanelSnapshot) => void } }).__visualBridgeDebugPanel;
  assert.ok(panel, "脚本必须暴露 __visualBridgeDebugPanel 供渲染驱动");
  assert.deepEqual(posted, [{ type: "ready" }], "脚本挂载后先回报 ready");

  const requireNode = (id: string): FakeNode => {
    const node = byId.get(id);
    assert.ok(node, `missing node #${id}`);
    return node;
  };

  return {
    posted,
    render: (state) => panel.render(state),
    byId: requireNode,
    click: (id) => {
      // 与浏览器一致：disabled 的按钮不派发 click（否则"置灰"用例会被假 DOM 放水）。
      const node = requireNode(id);
      if (node.disabled) {
        return;
      }

      for (const handler of node.listeners.get("click") ?? []) {
        handler();
      }
    },
    fire: (id, event) => {
      for (const handler of requireNode(id).listeners.get(event) ?? []) {
        handler();
      }
    },
  };
}

function flatten(node: FakeNode): string {
  return `${node.textContent}${node.children.map((child) => flatten(child)).join("")}`;
}

/** 除按钮之外的全部文本：按钮自己的"按分类重建"标签不算提示文案。 */
function textWithoutButtons(node: FakeNode): string {
  if (node.tag === "button") {
    return "";
  }

  return `${node.textContent}${node.children.map((child) => textWithoutButtons(child)).join("")}`;
}

/** 一个够用的快照（默认编辑器模式、有选中实例、几条记录）。 */
function snapshot(overrides: {
  readonly mode?: "editor" | "player";
  readonly panelMode?: "live" | "replay";
  readonly canToggle?: boolean;
  readonly enabled?: boolean;
  readonly pending?: boolean;
  readonly paused?: boolean;
  readonly atStart?: boolean;
  readonly atEnd?: boolean;
  readonly historyMissing?: boolean;
  readonly recordingAvailable?: boolean;
  readonly recordingActive?: boolean;
  readonly replay?: DebugPanelSnapshot["replay"];
  readonly query?: DebugPanelSnapshot["query"];
  readonly facetWindows?: DebugPanelSnapshot["facets"]["windows"];
  readonly connection?: DebugPanelSnapshot["connection"];
}): DebugPanelSnapshot {
  const historyMissing = overrides.historyMissing ?? false;
  return {
    revision: 1,
    paused: overrides.paused ?? false,
    granularity: "record",
    mode: overrides.panelMode ?? "live",
    filter: "",
    selectedKey: "graph\u0000hero",
    enable: {
      mode: overrides.mode ?? "editor",
      enabled: overrides.enabled ?? true,
      source: "welcome",
      pending: overrides.pending ?? false,
      pendingTarget: overrides.pending === true ? false : undefined,
      error: undefined,
      canToggle: overrides.canToggle ?? true,
      timeoutMs: 4_000,
    },
    connection: overrides.connection ?? EDITOR_CONNECTION,
    instances: [{
      key: "graph\u0000hero",
      category: "graph",
      instanceId: "hero",
      resName: "HeroPrefab",
      debugInfo: "",
      interfaces: ["IGraphDebuger"],
      recordCount: 3,
      bytes: 72,
      frame: 7,
      active: true,
      endedReason: undefined,
      descriptorMissing: false,
      historyMissing,
      selected: true,
      origin: "editor",
      originConflict: false,
    }],
    totalInstances: 1,
    recording: {
      available: overrides.recordingAvailable ?? false,
      active: overrides.recordingActive ?? false,
    },
    ...(overrides.replay === undefined ? {} : { replay: overrides.replay }),
    ...(overrides.query === undefined ? {} : { query: overrides.query }),
    timeline: {
      selected: true,
      requestedPosition: 0,
      fromPosition: historyMissing ? 2 : 0,
      toPosition: 3,
      cursor: 3,
      earliestPosition: 0,
      partial: historyMissing,
      historyMissing,
      windowStart: historyMissing ? 2 : 0,
      windowTruncated: false,
      atStart: overrides.atStart ?? false,
      atEnd: overrides.atEnd ?? true,
      groups: [{ frame: 7, count: 3, position: 0 }],
      records: [
        {
          position: 0,
          id: 1,
          frame: 7,
          method: "NodeStarted",
          interfaceId: "IGraphDebuger",
          instanceId: "hero",
          kind: "event",
          wireBytes: 24,
          receivedAt: 1_000,
          frameStart: true,
          current: false,
        },
        {
          position: 1,
          id: 2,
          frame: 7,
          method: "NodeFinished",
          interfaceId: "IGraphDebuger",
          instanceId: "hero",
          kind: "event",
          wireBytes: 24,
          receivedAt: 1_000,
          frameStart: false,
          current: false,
        },
      ],
      detail: {
        id: 1,
        kind: "event",
        category: "graph",
        instanceId: "hero",
        interfaceId: "IGraphDebuger",
        method: "NodeStarted",
        frame: 7,
        wireBytes: 24,
        receivedAt: 1_000,
        contractState: "unknown-interface",
        args: [{ tag: 1, name: "nodeId", type: "string", preview: "AAA…(共 4000 字符)" }],
        namedOnly: true,
        json: "[{\"tag\":1,\"name\":\"nodeId\"}]",
        truncated: true,
      },
    },
    facets: {
      windows: overrides.facetWindows ?? [],
      pending: 0,
      batches: 0,
      failures: 0,
      batchLimit: 100,
      lateRecords: 0,
      generic: { records: 3, dropped: 0 },
    },
    delivery: { webviewFailures: 0 },
    status: { records: 3, bytes: 72, keyframes: 0, frame: 7 },
  };
}

test("the status bar names the real frame source and offers a retry when disconnected (E10)", () => {
  const webview = mountPanel();

  // 只有 Runtime 腿在线：状态栏必须显示"已连接 · 来源 Runtime"，不能是"未连接"。
  webview.render(snapshot({
    connection: {
      ...EDITOR_CONNECTION,
      sources: { editor: false, runtime: true },
      canRequestEnable: false,
      endpointId: "editor-99",
      target: "127.0.0.1:28301",
      connectType: "editor-player",
    },
  }));
  const connected = webview.byId("status").textContent;
  assert.match(connected, /^已连接/u);
  assert.match(connected, /来源 Runtime/u);
  assert.equal(webview.byId("retry-connection").hidden, true, "已连接时不该出现重试按钮");

  // 只有 Runtime 腿时上报开关必然置灰：悬停提示必须说明它只对 Editor 桥生效（E10）。
  webview.render(snapshot({
    canToggle: false,
    connection: {
      ...EDITOR_CONNECTION,
      sources: { editor: false, runtime: true },
      canRequestEnable: false,
      endpointId: "editor-99",
      target: "127.0.0.1:28301",
      connectType: "editor-player",
    },
  }));
  const greyedEnable = webview.byId("enable");
  assert.equal(greyedEnable.disabled, true, "只剩 Runtime 腿时上报开关置灰");
  assert.match(greyedEnable.title, /只对 Editor 桥生效/u,
    "置灰原因必须说明上报开关只对 Editor 桥生效，而不是「向 Unity 发送 debugSetEnabled」");
  assert.doesNotMatch(greyedEnable.title, /^向 Unity 发送 debugSetEnabled/u);

  // 两条腿都在：来源写 Editor+Runtime。
  webview.render(snapshot({
    connection: { ...EDITOR_CONNECTION, sources: { editor: true, runtime: true } },
  }));
  assert.match(webview.byId("status").textContent, /来源 Editor\+Runtime/u);

  // 都没连上：显示原因 + 重试按钮，点一下发出 retryConnection（不弹任何模态框）。
  webview.render(snapshot({
    connection: {
      state: "disconnected",
      sources: { editor: false, runtime: false },
      canRequestEnable: false,
      detail: "未找到 Runtime 端点：Unity 未进入 Play 或 Player 未启动（已探测 127.0.0.1:28300-28349）",
      endpointId: undefined,
      target: undefined,
      connectType: undefined,
      frame: -1,
    },
  }));
  const disconnected = webview.byId("status").textContent;
  assert.match(disconnected, /^未连接/u);
  assert.match(disconnected, /来源 无/u);
  assert.match(disconnected, /未找到 Runtime 端点/u, "未连接时必须把失败原因显示出来");

  const retry = webview.byId("retry-connection");
  assert.equal(retry.hidden, false, "未连接时提供重试入口");
  assert.equal(retry.disabled, false);
  assert.match(retry.title, /未找到 Runtime 端点/u, "悬停提示复用失败原因");

  webview.click("retry-connection");
  assert.deepEqual(webview.posted.at(-1), { type: "command", command: "retryConnection" });
});
