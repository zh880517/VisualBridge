import type { VisualBridgeProjectDefinition } from "@visualbridge/core";

/** Table 模块在 Project File 中固定的模块 ID。 */
export const TABLE_MODULE_ID = "visualbridge.table";

/** Table 模块 options 中承载工程级行布局的键。 */
export const TABLE_LAYOUT_OPTION = "tableLayout";

/**
 * Table 模块 `options.tableLayout` 的形状：1-based 的 `nameKeyRow` 与 `dataStartRow`。
 *
 * Project File v2 删除了顶层 `tableLayout`，行布局归 Table 模块所有，因此该类型由 Table
 * 模块拥有，而不是 Core 的工程路由类型。
 */
export interface TableLayoutDefinition {
  readonly nameKeyRow: number;
  readonly dataStartRow: number;
}

/**
 * 从 Project 的 Table 模块 `options.tableLayout` 解析工程级行布局。
 *
 * Project File v2 删除了顶层 `tableLayout`，布局归 Table 模块所有；缺失或形状非法都返回
 * `undefined`，由调用方按各自的错误契约上报（如 `table.layoutNotConfigured`、
 * `compile.tableLayoutMissing`）。行布局的语义校验只在这里做一次，宿主不重复实现。
 */
export function resolveProjectTableLayout(
  project: VisualBridgeProjectDefinition,
): TableLayoutDefinition | undefined {
  const module = project.modules.find((entry) => entry.id === TABLE_MODULE_ID);
  return resolveTableLayoutFromOptions(module?.options);
}

/** 与 `resolveProjectTableLayout` 同一份校验，供只拿到模块 `options` 的调用方（会话控制器）使用。 */
export function resolveTableLayoutFromOptions(options: unknown): TableLayoutDefinition | undefined {
  const value = typeof options === "object" && options !== null && !Array.isArray(options)
    ? (options as Readonly<Record<string, unknown>>)[TABLE_LAYOUT_OPTION]
    : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).some((key) => key !== "nameKeyRow" && key !== "dataStartRow")) {
    return undefined;
  }

  const nameKeyRow = record.nameKeyRow;
  const dataStartRow = record.dataStartRow;
  if (
    typeof nameKeyRow !== "number"
    || !Number.isInteger(nameKeyRow)
    || nameKeyRow < 1
    || typeof dataStartRow !== "number"
    || !Number.isInteger(dataStartRow)
    || dataStartRow <= nameKeyRow
  ) {
    return undefined;
  }

  return { nameKeyRow, dataStartRow };
}
