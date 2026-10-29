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
 *    变成契约方法名（`NodeStarted` 等）；别名表是"同一执行、两种编码"的唯一定义，迁移对比测试
 *    （`test:vscode:host`）与契约守卫测试（`graphDebugFacet.test.ts`）都以它为准，G1b 删除旧路径时一并复核。
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
 * 这张表是**真实调试契约的镜像**，不是猜出来的：键集合必须逐一等于
 * `UnityProject/Assets/VisualBridgeGenerated/Debug/debug-contracts.json` 里 `graph` 类别的全部方法名
 * （词形归一后），不多不少。`graphDebugFacet.test.ts` 的守卫用例直接读那份生成产物，
 * 所以契约里加/删/改一个方法就会让用例变红（G1c）。
 *
 * 查表前先做词形归一（大小写、下划线、连字符），于是 `NodeStarted` / `node-started` / `NODE_STARTED`
 * 命中同一个键；但**键本身**只允许是契约里存在的方法。没有命中（契约外的自定义方法）原样作为种类，
 * 时间轴照常显示但不会点亮节点（旧路径的点亮集合见 `GraphDebugPanel` 的 `GRAPH_DEBUG_EXECUTING_KINDS`，
 * 与这里的六个种类不是同一件事）。
 */
export const GRAPH_DEBUG_EVENT_KIND_ALIASES: Readonly<Record<string, string>> = {
  instancestarted: "instanceStarted",
  instancestopped: "instanceStopped",
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
    // `outputIndex = 0` 在线格式里不出现：PushParam 跳过默认值（附录 A.4/B.2），所以最常见的输出端口 0
    // 永远缺失。契约里带 outputIndex 的事件有两条——`nodeOutput` 与 `edgeValueChanged`（边由
    // nodeId + outputIndex 标识），两条都必须在消费侧把缺失读成 0，否则 `nodeId:0` 的边键/端口整条丢失。
    // 其它事件不做补齐（缺失就是缺失，不能凭空造出 outputIndex）。
    const outputIndex = integerParam(record, "outputIndex")
      ?? (eventKind === "nodeOutput" || eventKind === "edgeValueChanged" ? 0 : undefined);
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

/**
 * 词形归一（大小写、下划线、连字符都抹平）：`normalizeEventKind` 与守卫测试**共用这一个实现**，
 * 避免测试自己抄一份之后与生产漂移。
 */
export function normalizeMethodKey(method: string): string {
  return method.replace(/[^0-9A-Za-z]/gu, "").toLowerCase();
}

/** 契约方法名归一成旧事件种类；未知方法原样返回（时间轴仍可见）。 */
export function normalizeEventKind(method: string): string {
  return GRAPH_DEBUG_EVENT_KIND_ALIASES[normalizeMethodKey(method)] ?? method;
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
