import { VisualBridgeMcpError } from "./projectWorkspace.js";

/**
 * 调用模块提供的代码（facet 钩子、create、query）。
 *
 * 模块是第三方代码：它抛错是**模块缺陷**，必须报 `module.callFailed` 并带上模块 id 与原始
 * message（附录 D.2）。只有宿主自身的 bug 才落到 `internal`——否则"第三方模块有 bug"会被
 * 误报成"VisualBridge 有 bug"，用户与我们的排查方向都会错。
 *
 * `VisualBridgeMcpError` 原样透传：那已经是宿主或 Core 契约给出的稳定错误码（例如
 * `request.invalidSelector`），再包一层会把它降级成"模块缺陷"。
 */
/** 宿主已给出的稳定错误码原样透传；esbuild 分包后类身份会复制一份，故按契约名判断。 */
function isHostError(errorValue: unknown): errorValue is VisualBridgeMcpError {
  return errorValue instanceof Error
    && errorValue.name === "VisualBridgeMcpError"
    && typeof (errorValue as { readonly code?: unknown }).code === "string";
}

function moduleCallFailed(moduleId: string, operation: string, errorValue: unknown): VisualBridgeMcpError {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return new VisualBridgeMcpError(
    "module.callFailed",
    `Module '${moduleId}' threw while running ${operation}: ${message}`,
    { moduleId, operation, message },
  );
}

/** 同步调用模块代码；抛错即映射为 `module.callFailed`。 */
export function callModuleCode<T>(moduleId: string, operation: string, call: () => T): T {
  try {
    return call();
  } catch (errorValue) {
    if (isHostError(errorValue)) throw errorValue;
    throw moduleCallFailed(moduleId, operation, errorValue);
  }
}

/** 异步调用模块代码（`parseSources` / `renderSources` 允许返回 Promise）。 */
export async function callModuleCodeAsync<T>(
  moduleId: string,
  operation: string,
  call: () => T | Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (errorValue) {
    if (isHostError(errorValue)) throw errorValue;
    throw moduleCallFailed(moduleId, operation, errorValue);
  }
}
