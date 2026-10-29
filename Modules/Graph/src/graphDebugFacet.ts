/**
 * Graph 模块的调试展示 facet（附录 D.4，F4 接入；G1a 补齐事件映射）。
 *
 * 宿主拥有数据面：这里只收公开契约的 `DebugRecord`，返回一块**由本条记录派生**的渲染增量。
 *
 * 三条刻意约束：
 * 1. **不累积状态**。`DebugFacet` 契约（D.4）没有 reset/实例级事件，而宿主的关键帧回放与
 *    分类级重建会把同一批记录再投一次；只有"每条记录独立派生"才能保证重放结果幂等。
 *    累积时间轴与回放光标在 Webview 侧，不在 facet 里（G1a）。
 * 2. **不碰原始字节/宿主内部字段**。`DebugRecord` 只有 `seq`/`sessionId`/`instanceId`/
 *    `category`/`frame`/`method`/`params`/`wireBytes`/`at`（以及 G1a 追加的 `kind`）。
 * 3. **事件种类从 `method` 归一**。旧 `graphExecution` 的 `kind`（`nodeStart` 等）在统一调试流里
 *    变成契约方法名（`NodeStarted` 等）；这个别名表是"同一执行、两种编码"的唯一定义，
 *    迁移对比测试（`test:vscode:host`）以它为准，G1b 删除旧路径时一并复核。
 */
import type {
  DebugFacet,
  DebugRecord,
  DebugRecordKind,
  DebugRenderUpdate,
  DocumentDiagnostic,
  EditorContext,
  JsonObject,
  JsonValue,
} from "@visualbridge/module-sdk";

/** Graph 认领的调试分类（D.4 的 `categories` 精确匹配）。 */
export const GRAPH_DEBUG_CATEGORY = "graph";

/** Graph 调试窗口的默认建议标题（窗口标题归宿主，这个只是建议）。 */
export const GRAPH_DEBUG_WINDOW_TITLE = "Graph";

/** 渲染增量的判别值（宿主 Debug 面板的既有契约，不随事件种类变化）。 */
export const GRAPH_DEBUG_UPDATE_KIND = "graph.debug";

/**
 * 契约方法名 → 旧 `graphExecution` 事件种类。
 *
 * 只做**词形归一**（大小写、下划线、连字符），不猜语义：例如 `NodeStarted` / `node_start` /
 * `nodeStart` 都映射到 `nodeStart`；没有登记的方法原样作为种类，时间轴照常显示但不会点亮节点
 * （旧路径同样只认这四个种类，见 `GraphDebugPanel` 的 `GRAPH_DEBUG_EXECUTING_KINDS`）。
 */
export const GRAPH_DEBUG_EVENT_KIND_ALIASES: Readonly<Record<string, string>> = {
  instancestarted: "instanceStarted",
  instancestopped: "instanceStopped",
  nodestart: "nodeStart",
  nodestarted: "nodeStart",
  nodeoutput: "nodeOutput",
  datanode: "dataNode",
  edgevaluechanged: "edgeValueChanged",
};

/**
 * `onRecord`：把一条 Graph 调试记录映射成窗口内容。
 *
 * `options.debug` 原样回传：宿主在 `EditorContext.project.options` 里给出模块已验证的 options，
 * 所以改 `modules[].options.debug` 并重载模块后，窗口内容随之变化（F4 验收 ⑤）。
 */
export const graphDebugFacet: DebugFacet = {
  categories: [GRAPH_DEBUG_CATEGORY],
  windowTitle: GRAPH_DEBUG_WINDOW_TITLE,
  onRecord(record: DebugRecord, context: EditorContext<unknown>): DebugRenderUpdate | undefined {
    const recordKind: DebugRecordKind = record.kind ?? "event";
    // 查询结果是"某次查询的应答"，不是一次图执行事件：即使参数里带 nodeId 也不能推进高亮。
    // 两者共用时间轴（C.2），所以保留记录并显式标注种类，由 Webview 决定是否展示。
    const eventKind = recordKind === "queryResult" ? "queryResult" : normalizeEventKind(record.method);
    const nodeId = stringParam(record, "nodeId");
    const outputIndex = integerParam(record, "outputIndex");
    const value = stringOrNumberParam(record, "value");
    const update: Record<string, JsonValue> = {
      kind: GRAPH_DEBUG_UPDATE_KIND,
      category: record.category,
      seq: record.seq,
      sessionId: record.sessionId,
      instanceId: record.instanceId,
      frame: record.frame,
      method: record.method,
      wireBytes: record.wireBytes,
      at: record.at,
      recordKind,
      eventKind,
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(outputIndex === undefined ? {} : { outputIndex }),
      ...(value === undefined ? {} : { value }),
    };
    const debugOptions = readDebugOptions(context);
    if (debugOptions !== undefined) {
      update.options = debugOptions;
    }

    return update;
  },
};

/** 契约方法名归一成旧事件种类；未知方法原样返回（时间轴仍可见）。 */
export function normalizeEventKind(method: string): string {
  const key = method.replace(/[^0-9A-Za-z]/gu, "").toLowerCase();
  return GRAPH_DEBUG_EVENT_KIND_ALIASES[key] ?? method;
}

/**
 * 校验 `modules[].options.debug`（F4 验收 ⑤）。
 *
 * 宿主把返回的诊断定位到 `modules[i].options`（loader 的 `validateModuleOptions`），并把
 * `[code] path: message` 放进消息；`path` 用 JSON Pointer 风格的 `$.debug`。
 */
export function validateGraphOptions(options: JsonObject | undefined): readonly DocumentDiagnostic[] {
  const debug = options?.debug;
  if (debug === undefined) {
    return [];
  }

  if (typeof debug !== "object" || debug === null || Array.isArray(debug)) {
    return [{
      severity: "error",
      code: "graph.options.debugInvalid",
      path: "$.debug",
      message: "options.debug must be a JSON object.",
    }];
  }

  const title = (debug as Readonly<Record<string, JsonValue>>).title;
  if (title !== undefined && typeof title !== "string") {
    return [{
      severity: "error",
      code: "graph.options.debugInvalid",
      path: "$.debug.title",
      message: "options.debug.title must be a string.",
    }];
  }

  return [];
}

function readDebugOptions(context: EditorContext<unknown>): JsonValue | undefined {
  const debug = context.project.options?.debug;
  return debug === undefined ? undefined : debug;
}

function stringParam(record: DebugRecord, name: string): string | undefined {
  const value = record.params[name];
  return typeof value === "string" ? value : undefined;
}

function integerParam(record: DebugRecord, name: string): number | undefined {
  const value = record.params[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** `edgeValueChanged` 的值由引擎字符串化（旧契约上限 4096 字符）；数字也接受并转成字符串。 */
function stringOrNumberParam(record: DebugRecord, name: string): string | undefined {
  const value = record.params[name];
  if (typeof value === "string") {
    return value;
  }

  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
