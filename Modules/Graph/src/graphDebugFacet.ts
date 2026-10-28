/**
 * Graph 模块的调试展示 facet（附录 D.4，F4 接入）。
 *
 * 宿主拥有数据面：这里只收公开契约的 `DebugRecord`，返回一块**由本条记录派生**的渲染增量。
 *
 * 两条刻意约束：
 * 1. **不累积状态**。`DebugFacet` 契约（D.4）没有 reset/实例级事件，而宿主的关键帧回放与
 *    分类级重建会把同一批记录再投一次；只有"每条记录独立派生"才能保证重放结果幂等。
 *    G1 若需要累积视图，必须先补契约里的 reset（见 F4 报告的风险）。
 * 2. **不碰原始字节/宿主内部字段**。`DebugRecord` 只有 `seq`/`sessionId`/`instanceId`/
 *    `category`/`frame`/`method`/`params`/`wireBytes`/`at`。
 */
import type {
  DebugFacet,
  DebugRecord,
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
    const nodeId = stringParam(record, "nodeId");
    const update: Record<string, JsonValue> = {
      kind: "graph.debug",
      category: record.category,
      seq: record.seq,
      instanceId: record.instanceId,
      frame: record.frame,
      method: record.method,
      wireBytes: record.wireBytes,
      ...(nodeId === undefined ? {} : { nodeId }),
    };
    const debugOptions = readDebugOptions(context);
    if (debugOptions !== undefined) {
      update.options = debugOptions;
    }

    return update;
  },
};

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
