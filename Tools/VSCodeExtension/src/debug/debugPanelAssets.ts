/**
 * 独立 Debug 面板的 Webview 资源（附录 C.7）。
 *
 * **为什么脚本是字符串**：面板是宿主内建 UI（不是模块），而宿主能托管 Webview 资产的通道只有两条
 * ——`dist/webview/`（C2 之后只允许 Project Settings 的产物，`test:cli` 会断言目录内容恰好是
 * `projectEditor.js|css`）与 `<globalStorage>/modules/<sha256>/`（`src/modules/webviewAssets.ts`）。
 * 为了让"面板资源发布走同一份解包/寻址机制"（任务书硬约束），这里把脚本与样式作为**文本**交给
 * {@link publishDebugPanelAssets}，由 `unpackModuleWebviews` 按内容哈希落到全局存储目录，
 * 宿主再用 `asWebviewUri` 取地址。内容哈希意味着同一份字节只落一份，改脚本即换目录。
 *
 * 脚本保持**纯渲染**：所有判断都在 `debugPanelState.ts`（宿主、可单测）。这里只做三件事——
 * 按快照重绘、把点击转发给宿主、按快照里的 `canToggle` 置灰按钮。
 */

import { createHash } from "node:crypto";
import { unpackModuleWebviews, type UnpackedModuleWebview } from "../modules/webviewAssets";

/** 打包后的 Webview key（解包目录里的 `debugPanel.js|css`）。 */
export const DEBUG_PANEL_WEBVIEW_KEY = "debugPanel";
/** 内容哈希的模块标识（只用于解包目录的 `moduleId` 字段，不参与路径）。 */
export const DEBUG_PANEL_MODULE_ID = "visualbridge.debugPanel";

/** 面板脚本：渲染快照 + 转发点击。语法由单测用 `new Function` / `vm` 校验（见 test/unit）。 */
export const DEBUG_PANEL_SCRIPT = String.raw`(function () {
  "use strict";

  var hostApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var post = function (message) {
    if (hostApi) {
      hostApi.postMessage(message);
      return;
    }
    if (typeof window !== "undefined" && typeof window.__visualBridgeDebugPost === "function") {
      window.__visualBridgeDebugPost(message);
    }
  };
  var documentRef = typeof document === "undefined" ? undefined : document;
  var shell = null;
  var state = null;

  function el(tag, className, text) {
    var node = documentRef.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function button(id, label, onClick, title) {
    var node = el("button", "vb-debug-button", label);
    node.id = id;
    node.setAttribute("type", "button");
    if (title) { node.title = title; }
    node.addEventListener("click", onClick);
    return node;
  }

  function command(message) {
    post(Object.freeze({ type: "command", command: message }));
  }

  function buildShell() {
    var root = documentRef.getElementById("root");
    if (!root) { return; }
    var toolbar = el("div", "vb-debug-toolbar");
    var enable = button("enable", "", function () {
      if (!state || !state.enable.canToggle) { return; }
      post({ type: "command", command: "enable", value: !state.enable.enabled });
    }, "向 Unity 发送 debugSetEnabled，并等服务端广播回写状态");
    var pause = button("pause", "", function () { command("togglePause"); });
    var clear = button("clear", "清空", function () { command("clear"); }, "清空当前实例的已缓存记录");
    var record = button("record", "录制", function () { command("toggleRecording"); }, "会话录制（F5）");
    var replayExit = button("replay-exit", "返回实时", function () { command("closeRecording"); }, "退出回看，切回在线数据源");
    replayExit.hidden = true;
    var byRecord = button("granularity-record", "按记录", function () {
      post({ type: "command", command: "granularity", value: "record" });
    }, "步进粒度：一次一条记录");
    var byFrame = button("granularity-frame", "按帧", function () {
      post({ type: "command", command: "granularity", value: "frame" });
    }, "步进粒度：一次一整帧（连续同帧号）");
    var previous = button("previous", "上一步", function () {
      post({ type: "command", command: "step", direction: -1 });
    });
    var next = button("next", "下一步", function () {
      post({ type: "command", command: "step", direction: 1 });
    });
    var live = button("live", "回到实时", function () { command("live"); });
    var filter = el("input", "vb-debug-filter");
    filter.id = "filter";
    filter.setAttribute("type", "search");
    filter.setAttribute("placeholder", "筛选实例：instanceId / resName / category / interface / debugInfo");
    filter.addEventListener("input", function () {
      post({ type: "command", command: "filter", value: filter.value });
    });
    [enable, pause, clear, record, replayExit, byRecord, byFrame, previous, next, live, filter].forEach(function (node) {
      toolbar.appendChild(node);
    });

    var status = el("div", "vb-debug-status");
    status.id = "status";
    var windows = el("div", "vb-debug-windows");
    windows.id = "windows";
    var body = el("div", "vb-debug-body");
    var instances = el("ul", "vb-debug-instances");
    instances.id = "instances";
    var timeline = el("div", "vb-debug-timeline");
    timeline.id = "timeline";
    var detail = el("div", "vb-debug-detail");
    detail.id = "detail";
    body.appendChild(instances);
    body.appendChild(timeline);
    body.appendChild(detail);
    root.replaceChildren(toolbar, status, windows, body);
    shell = { toolbar: toolbar, enable: enable, pause: pause, clear: clear, record: record, replayExit: replayExit, byRecord: byRecord, byFrame: byFrame, previous: previous, next: next, live: live, filter: filter, status: status, windows: windows, instances: instances, timeline: timeline, detail: detail };
  }

  function renderEnable() {
    var enable = shell.enable;
    var state_ = state.enable;
    enable.textContent = "Debug 上报 [" + (state_.enabled ? "开" : "关") + "]";
    // Player 模式 / 挂起中 / 无连接：置灰（C.7：Player 模式开关置灰且不发请求）。
    enable.disabled = !state_.canToggle || state_.mode === "player";
    if (state_.pending) {
      enable.textContent += " …";
    } else if (state_.error === "timeout") {
      enable.title = "Unity 没有回应 debugEnabled 广播，已回滚到服务端状态（" + (state_.enabled ? "开" : "关") + "）";
    } else if (state_.error === "sendFailed") {
      enable.title = "没有可用的调试连接，请求没有发出";
    } else {
      enable.title = "向 Unity 发送 debugSetEnabled，并等服务端广播回写状态";
    }
    enable.setAttribute("aria-pressed", state_.enabled ? "true" : "false");
  }

  function renderStatus() {
    var status = state.connection;
    var text = state.replay ? "回看中" : (status.state === "connected" ? "已连接" : "未连接");
    text += " · endpoint=" + (status.endpointId || "-");
    text += " · target=" + (status.target || "-");
    text += " · 帧 " + state.connection.frame;
    if (state.replay) {
      // 录制文件尾的标注（C.6）：sizeLimit 必须让人看得出来，而不是当普通断开。
      text += " · " + (state.replay.records === undefined ? "未正常收尾" : state.replay.records + " 条记录");
      if (state.replay.endedReason === "sizeLimit") {
        text += " · 达到文件上限（sizeLimit）";
      } else if (state.replay.endedReason === undefined) {
        text += " · 无文件尾（可能截断）";
      }
      if (state.replay.unattributableBinaryFrames > 0) {
        text += " · 无法归属的二进制帧 " + state.replay.unattributableBinaryFrames;
      }
    }
    if (state.query && state.query.available) {
      text += " · 查询在途 " + state.query.pending + "/" + state.query.limit;
      if (state.query.busy) {
        text += "（已满，按钮禁用）";
      }
    }
    if (state.status.records > 0) {
      text += " · " + state.status.records + " 条 / " + state.status.bytes + " B";
    }
    if (state.paused) {
      text += " · 已暂停（记录继续进 store）";
    }
    if (state.mode === "replay") {
      text += " · 逐步";
    }
    if (state.timeline.historyMissing) {
      text += " · 历史未记录";
    }
    var facets = state.facets || { windows: [], failures: 0, pending: 0, generic: { records: 0 } };
    if (facets.windows.length > 0) {
      text += " · 类型窗口 " + facets.windows.length;
    }
    if (facets.pending > 0) {
      text += " · 待投 " + facets.pending;
    }
    if (facets.failures > 0) {
      text += " · 模块失败 " + facets.failures;
    }
    if (facets.generic && facets.generic.records > 0) {
      text += " · 通用 " + facets.generic.records;
    }
    if (state.delivery && state.delivery.webviewFailures > 0) {
      text += " · Webview 失败 " + state.delivery.webviewFailures;
    }
    shell.status.textContent = text;
  }

  function renderWindows() {
    var facets = state.facets || { windows: [] };
    var nodes = (facets.windows || []).map(function (windowState, index) {
      var section = el("section", "vb-debug-window vb-debug-window-" + windowState.state);
      var header = el("div", "vb-debug-window-head");
      header.appendChild(el("span", "vb-debug-window-title", windowState.title));
      if (windowState.moduleTitle) {
        header.appendChild(el("span", "vb-debug-window-module-title", " · " + windowState.moduleTitle));
      }
      var badge = windowState.state === "active"
        ? "模块消费"
        : windowState.state === "fallback" ? "已回退通用视图" : "通用视图";
      header.appendChild(el("span", "vb-debug-window-badge", badge));
      // 按钮可用性、元信息与提示文案共用这一个判据：不允许"按钮禁用、提示却让用户去点"（F4 P1 a）。
      var rebuildable = windowState.rebuildable === true;
      var replay = button("vb-debug-window-replay-" + index, "按分类重建", function () {
        post({ type: "command", command: "replayCategory", value: windowState.category });
      }, rebuildable
        ? "按分类重建主消费者（partial 会如实显示）"
        : "该分类没有可重建的模块消费者：重载模块（或重新授权）后会自动恢复");
      replay.disabled = !rebuildable;
      header.appendChild(replay);
      section.appendChild(header);

      var meta = [];
      if (windowState.moduleId) { meta.push(windowState.moduleId); }
      if (windowState.editor) { meta.push(windowState.editor); }
      meta.push(windowState.records + " 条 / " + windowState.batches + " 批");
      if (windowState.pending > 0) { meta.push("待投 " + windowState.pending); }
      if (windowState.stale) {
        meta.push(rebuildable ? "实例清空后未重建" : "实例清空后未重建 · 需重载模块");
      }
      section.appendChild(el("div", "vb-debug-window-meta", meta.join(" · ")));

      if (windowState.message) {
        section.appendChild(el("div", "vb-debug-warning", windowState.message));
      }
      if (windowState.stale) {
        // 不可重建时给的是用户真能执行的下一步，而不是一个点不动的按钮。
        section.appendChild(el("div", rebuildable ? "vb-debug-hint" : "vb-debug-warning",
          rebuildable
            ? "同分类还有其它实例的记录：模块视图仍是清空前的状态，点“按分类重建”才会重建。"
            : "模块未加载或已回退通用视图，没有可重建的模块消费者：重载模块（或重新授权）后会自动恢复重建。"));
      }
      if (windowState.replay) {
        section.appendChild(el("div", windowState.replay.partial ? "vb-debug-warning" : "vb-debug-hint",
          "上次重建：应用 " + windowState.replay.applied + " 条"
          + (windowState.replay.fromKeyframe ? "（关键帧）" : "（从头）")
          + (windowState.replay.partial ? " · 历史缺失（partial）" : "")));
      }
      (windowState.diagnostics || []).forEach(function (diagnostic) {
        section.appendChild(el("div", "vb-debug-warning", diagnostic.code + " @ " + diagnostic.path + "：" + diagnostic.message));
      });
      if (windowState.content !== undefined) {
        var text;
        try {
          text = JSON.stringify(windowState.content, undefined, 2);
        } catch (error) {
          text = String(windowState.content);
        }
        section.appendChild(el("pre", "vb-debug-json vb-debug-facet-content", text));
      } else if (windowState.state === "active") {
        section.appendChild(el("div", "vb-debug-empty", "模块尚未返回渲染增量"));
      }
      return section;
    });
    if (nodes.length === 0) {
      nodes = [el("div", "vb-debug-empty", "暂无模块调试窗口（记录仍会进通用窗口）")];
    }
    shell.windows.replaceChildren.apply(shell.windows, nodes);
  }

  function renderToolbar() {
    shell.pause.textContent = state.paused ? "继续" : "暂停";
    // 录制由 F5 提供：未接入时置灰并说明，不伪造"正在录制"。
    shell.record.textContent = state.recording.active ? "停止录制" : "录制";
    shell.record.disabled = !state.recording.available;
    shell.record.title = state.recording.available
      ? "会话录制（F5）"
      : state.replay
        ? "回看模式下不可录制（先返回实时）"
        : "录制由 F5（会话录制）提供，尚未接入";
    shell.record.setAttribute("aria-pressed", state.recording.active ? "true" : "false");
    // 回看：多出"返回实时"按钮；标题带上文件与文件尾统计（截断的录制没有 records）。
    shell.replayExit.hidden = !state.replay;
    shell.replayExit.disabled = !state.replay;
    if (state.replay) {
      var replayInfo = state.replay.records === undefined
        ? "（录制未正常收尾）"
        : "（" + state.replay.records + " 条记录" + (state.replay.endedReason === "sizeLimit" ? "，达到文件上限" : "") + "）";
      shell.replayExit.title = "回看 " + state.replay.filePath + replayInfo + "；点击退出回看";
    }
    shell.pause.setAttribute("aria-pressed", state.paused ? "true" : "false");
    shell.byRecord.setAttribute("aria-pressed", state.granularity === "record" ? "true" : "false");
    shell.byFrame.setAttribute("aria-pressed", state.granularity === "frame" ? "true" : "false");
    var timeline = state.timeline;
    shell.previous.disabled = state.paused || !timeline.selected || timeline.atStart;
    shell.next.disabled = state.paused || !timeline.selected || timeline.atEnd;
    shell.live.disabled = !timeline.selected || state.mode === "live";
    if (shell.filter.value !== state.filter) {
      shell.filter.value = state.filter;
    }
  }

  function renderInstances() {
    var nodes = state.instances.map(function (row, index) {
      var item = el("li", row.selected ? "vb-debug-instance vb-debug-instance-selected" : "vb-debug-instance");
      var label = el("button", "vb-debug-instance-label", row.instanceId + " · " + row.category);
      label.id = "vb-debug-instance-" + index;
      label.setAttribute("type", "button");
      label.addEventListener("click", function () {
        post({ type: "command", command: "select", key: row.key });
      });
      item.appendChild(label);
      // E9：来源标注（显示层）。两个 Unity 进程可能同名，靠这条区分 Editor 腿与 Runtime 腿。
      var origin = row.origin === "runtime" ? "Runtime 桥" : row.origin === "editor" ? "Editor 桥" : "来源未标注";
      item.appendChild(el("span", "vb-debug-instance-origin", origin));
      if (row.originConflict) {
        item.appendChild(el("span", "vb-debug-instance-warning", "两条腿出现同名实例（保留首条记录）"));
      }
      var meta = [row.resName, row.interfaces.join(","), row.recordCount + " 条", "帧 " + row.frame];
      item.appendChild(el("span", "vb-debug-instance-meta", meta.filter(function (part) { return part && part.length > 0; }).join(" · ")));
      if (!row.active) {
        item.appendChild(el("span", "vb-debug-instance-ended", "已结束" + (row.endedReason ? " (" + row.endedReason + ")" : "")));
      }
      if (row.descriptorMissing) {
        item.appendChild(el("span", "vb-debug-instance-warning", "缺少 Create 描述"));
      }
      if (row.historyMissing) {
        item.appendChild(el("span", "vb-debug-instance-warning", "历史未记录"));
      }
      return item;
    });
    if (nodes.length === 0) {
      nodes = [el("li", "vb-debug-empty", state.totalInstances === 0 ? "没有调试实例（Unity 尚未上报 Create）" : "没有匹配筛选条件的实例")];
    }
    shell.instances.replaceChildren.apply(shell.instances, nodes);
  }

  function renderTimeline() {
    var timeline = state.timeline;
    if (!timeline.selected) {
      shell.timeline.replaceChildren(el("div", "vb-debug-empty", "未选择实例"));
      return;
    }
    var nodes = [];
    if (timeline.historyMissing) {
      nodes.push(el("div", "vb-debug-warning", "历史未记录：起点已夹到最早可用位置（请求 " + timeline.requestedPosition + "，实际 " + timeline.fromPosition + "）"));
    }
    if (state.replay && state.replay.unattributableBinaryFrames > 0) {
      // 冲突三的裁决：录制只含单向帧（没有 request），二进制 debug/debugResult 在字节上无法区分。
      // 不假装归属、也不静默丢弃：把计数明确告诉用户，这是回看的已知限制。
      nodes.push(el(
        "div",
        "vb-debug-warning",
        "该录制含 " + state.replay.unattributableBinaryFrames + " 条无法归属的二进制帧：录制只含 Unity→VS Code 的单向帧（request 不在文件里），"
          + "无法判定它是 debug 还是 debugResult，已计数并跳过。"
      ));
    }
    if (timeline.windowTruncated) {
      nodes.push(el("div", "vb-debug-hint", "仅显示最近 " + state.timeline.records.length + " 条（窗口起点 " + timeline.fromPosition + "）"));
    }
    nodes.push(el("div", "vb-debug-cursor", "游标 " + timeline.cursor + " / " + timeline.toPosition + (timeline.atEnd ? "（末尾）" : "")));
    timeline.records.forEach(function (record) {
      var row = el("div", record.current ? "vb-debug-record vb-debug-record-current" : "vb-debug-record");
      if (record.frameStart) {
        row.className += " vb-debug-record-frame-start";
      }
      row.setAttribute("data-position", String(record.position));
      var head = (record.kind === "queryResult" ? "[查询结果] " : "")
        + "#" + record.id + " · 帧 " + record.frame + " · "
        + (record.interfaceId || "未知接口") + "." + (record.method || "未知方法");
      row.appendChild(el("span", "vb-debug-record-head", head));
      row.appendChild(el("span", "vb-debug-record-meta", record.wireBytes + " B · " + record.instanceId));
      nodes.push(row);
    });
    if (nodes.length === 0) {
      nodes.push(el("div", "vb-debug-empty", "暂无记录"));
    }
    shell.timeline.replaceChildren.apply(shell.timeline, nodes);
  }

  function renderDetail() {
    var detail = state.timeline.detail;
    if (!detail) {
      shell.detail.replaceChildren(el("div", "vb-debug-empty", "没有可显示的记录"));
      return;
    }
    var nodes = [];
    nodes.push(el("div", "vb-debug-detail-head", (detail.kind === "queryResult" ? "查询结果 · " : "") + detail.category + " / " + (detail.interfaceId || "未知接口") + "." + (detail.method || "未知方法") + " · 帧 " + detail.frame + " · " + detail.contractState));
    if (detail.namedOnly) {
      nodes.push(el("div", "vb-debug-hint", "契约缺失：仅列出非默认值，参数名显示为 arg#tag"));
    }
    var table = el("table", "vb-debug-args");
    var headRow = el("tr", "vb-debug-args-head");
    ["tag", "名称", "类型", "值"].forEach(function (name) { headRow.appendChild(el("th", "", name)); });
    table.appendChild(headRow);
    detail.args.forEach(function (arg) {
      var row = el("tr", "vb-debug-arg");
      row.appendChild(el("td", "", String(arg.tag)));
      row.appendChild(el("td", "", arg.name || ""));
      row.appendChild(el("td", "", arg.type || ""));
      row.appendChild(el("td", "", arg.preview));
      table.appendChild(row);
    });
    if (detail.args.length === 0) {
      table.appendChild(el("tr", "vb-debug-arg-empty")).appendChild(el("td", "", "无参数（全部为默认值）"));
    }
    nodes.push(table);
    nodes.push(el("pre", "vb-debug-json", detail.json));
    if (detail.truncated) {
      nodes.push(el("div", "vb-debug-hint", "原始 JSON 中的超长值（如 byte[]）已截断"));
    }
    if (state.query) {
      // 查询入口（F6）：用当前记录所属实例与接口/方法发起一次无参查询。
      var query = state.query;
      var queryBox = el("div", "vb-debug-query");
      var queryButton = button("query", "查询此方法", function () {
        if (!state || !state.selectedKey || !state.query || !state.query.available || state.query.busy) { return; }
        post({
          type: "command",
          command: "query",
          key: state.selectedKey,
          interfaceId: detail.interfaceId,
          method: detail.method
        });
      }, "向该实例发起一次无参查询，结果作为查询记录插入时间轴");
      queryButton.disabled = !query.available || query.busy || !detail.method || !detail.interfaceId;
      queryBox.appendChild(queryButton);
      if (!query.available) {
        queryBox.appendChild(el("span", "vb-debug-hint", "没有可用连接：查询不可用"));
      } else {
        queryBox.appendChild(el("span", "vb-debug-hint", "在途 " + query.pending + "/" + query.limit));
        if (query.busy) {
          queryBox.appendChild(el("span", "vb-debug-warning", "已达并发上限（8）：请等待在途查询结束，不会排队"));
        }
      }
      if (query.notice) {
        queryBox.appendChild(el(
          "div",
          query.notice.kind === "error" ? "vb-debug-warning" : "vb-debug-hint",
          query.notice.message
        ));
      }
      nodes.push(queryBox);
    }
    shell.detail.replaceChildren.apply(shell.detail, nodes);
  }

  function render(next) {
    state = next;
    if (!shell) {
      buildShell();
    }
    if (!shell) {
      return;
    }
    renderEnable();
    renderStatus();
    renderToolbar();
    renderWindows();
    renderInstances();
    renderTimeline();
    renderDetail();
  }

  function handleMessage(event) {
    var message = event && event.data ? event.data : {};
    if (message.type === "state" && message.state) {
      render(message.state);
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", handleMessage);
    post({ type: "ready" });
  }

  // 单测入口：宿主测试与单元测试都通过它驱动同一份渲染代码。
  if (typeof globalThis !== "undefined") {
    globalThis.__visualBridgeDebugPanel = { render: render, handleMessage: handleMessage };
  }
})();
`;

/** 面板样式：一律用 VS Code 主题变量（`style-src` 由宿主 CSP 放行）。 */
export const DEBUG_PANEL_STYLE = String.raw`:root {
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
}
body { margin: 0; padding: 0; }
.vb-debug-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  align-items: center;
}
.vb-debug-button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid transparent;
  padding: 2px 8px;
  cursor: pointer;
}
.vb-debug-button[aria-pressed="true"] {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.vb-debug-button:disabled,
.vb-debug-filter:disabled {
  opacity: 0.5;
  cursor: default;
}
.vb-debug-filter {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 2px 6px;
  min-width: 220px;
}
.vb-debug-status {
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  opacity: 0.9;
}
.vb-debug-windows {
  max-height: 32vh;
  overflow: auto;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: 4px;
}
.vb-debug-window { border: 1px solid var(--vscode-panel-border); margin: 4px 0; padding: 4px; }
.vb-debug-window-fallback { border-color: var(--vscode-editorWarning-foreground); }
.vb-debug-window-head { display: flex; align-items: center; gap: 6px; }
.vb-debug-window-title { font-weight: 600; }
.vb-debug-window-module-title { opacity: 0.8; }
.vb-debug-window-badge { border: 1px solid var(--vscode-panel-border); padding: 0 4px; font-size: 0.9em; }
.vb-debug-window-meta { opacity: 0.8; }
.vb-debug-facet-content { max-height: 16vh; overflow: auto; }
.vb-debug-body { display: flex; align-items: stretch; min-height: 0; }
.vb-debug-instances {
  list-style: none;
  margin: 0;
  padding: 4px;
  width: 32%;
  min-width: 220px;
  overflow: auto;
  border-right: 1px solid var(--vscode-panel-border);
}
.vb-debug-instance { padding: 4px; border-bottom: 1px solid var(--vscode-panel-border); }
.vb-debug-instance-selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.vb-debug-instance-label { background: none; border: none; color: inherit; cursor: pointer; padding: 0; font-weight: 600; }
.vb-debug-instance-meta { display: block; opacity: 0.8; }
.vb-debug-instance-origin { display: block; font-size: 0.9em; opacity: 0.75; }
.vb-debug-instance-warning { display: block; color: var(--vscode-editorWarning-foreground); }
.vb-debug-instance-ended { display: block; opacity: 0.7; }
.vb-debug-timeline { width: 34%; overflow: auto; padding: 4px; border-right: 1px solid var(--vscode-panel-border); }
.vb-debug-detail { width: 34%; overflow: auto; padding: 4px; }
.vb-debug-record { padding: 2px 4px; border-left: 2px solid transparent; }
.vb-debug-record-frame-start { border-top: 1px solid var(--vscode-panel-border); }
.vb-debug-record-current { border-left-color: var(--vscode-focusBorder); background: var(--vscode-editor-findMatchHighlightBackground); }
.vb-debug-record-head { display: block; }
.vb-debug-record-meta { display: block; opacity: 0.7; }
.vb-debug-warning { color: var(--vscode-editorWarning-foreground); padding: 4px; }
.vb-debug-hint, .vb-debug-empty, .vb-debug-cursor { opacity: 0.8; padding: 4px; }
.vb-debug-args { border-collapse: collapse; width: 100%; }
.vb-debug-args th, .vb-debug-args td { text-align: left; padding: 2px 4px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
.vb-debug-args td { word-break: break-all; }
.vb-debug-json { white-space: pre-wrap; word-break: break-all; background: var(--vscode-textCodeBlock-background); padding: 6px; }
.vb-debug-query { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0; border-top: 1px solid var(--vscode-panel-border); }
.vb-debug-query .vb-debug-warning, .vb-debug-query .vb-debug-hint { width: 100%; }
`;

/** 脚本 + 样式的内容哈希（同一份字节只解包一份；改脚本即换目录）。 */
export function debugPanelAssetHash(): string {
  const hash = createHash("sha256");
  hash.update(DEBUG_PANEL_SCRIPT, "utf8");
  hash.update("\u0000", "utf8");
  hash.update(DEBUG_PANEL_STYLE, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * 把面板资源发布到 `<globalStorage>/modules/<sha256>/debugPanel.js|css`。
 *
 * 复用 `unpackModuleWebviews`（内容哈希目录 + 内容相同不重写 + 绝对路径），不另写一份解包/寻址。
 */
export async function publishDebugPanelAssets(modulesRoot: string): Promise<UnpackedModuleWebview> {
  const [unpacked] = await unpackModuleWebviews(modulesRoot, [{
    moduleId: DEBUG_PANEL_MODULE_ID,
    hash: debugPanelAssetHash(),
    webviews: {
      [DEBUG_PANEL_WEBVIEW_KEY]: { script: DEBUG_PANEL_SCRIPT, style: DEBUG_PANEL_STYLE },
    },
  }]);
  if (unpacked === undefined) {
    throw new Error("Debug panel assets were not unpacked.");
  }

  return unpacked;
}
