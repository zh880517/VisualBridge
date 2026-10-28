/**
 * F2 调试链路的共享小工具：数值归一化、文本比较、默认定时器。
 *
 * 当前引用者只有 `DebugStore` 与 `DebugInstanceManager`（`DebugRouter` / `DebugKeyframeRegistry`
 * 不依赖这里的任何函数）。F1 的 `debugIngress` / `debugMessages` 里**没有**这些函数的副本，
 * 真正的重复在 `debugContractRegistry.ts`（`compareText`）与 `debugQueryTracker.ts`
 * （`defaultSetTimer` / `defaultClearTimer`）；把它们收敛到这一份属于 G2，本任务不动 F1 文件。
 */

/** 正整数归一化（非法值回退；`Infinity` 不是合法正整数）。 */
export function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** 正数归一化；允许 `Infinity`（表示"关闭该阈值"）。 */
export function normalizePositiveNumber(value: number, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return value;
  }

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 绝对位置归一化（非负整数）。 */
export function normalizePosition(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** 字节数归一化（非负整数）。 */
export function normalizeByteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** 确定性文本比较（不依赖 locale，排序结果跨机器一致）。 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 默认定时器：`unref()` 避免测试/宿主因悬挂定时器无法退出。 */
export function defaultSetTimer(callback: () => void, timeoutMs: number): unknown {
  const handle = setTimeout(callback, timeoutMs) as unknown as { unref?: () => void };
  handle.unref?.();
  return handle;
}

export function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
