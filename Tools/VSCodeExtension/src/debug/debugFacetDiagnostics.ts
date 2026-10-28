/**
 * 模块 `debug` facet 路由的诊断码权威清单（F4 返修 P1）。
 *
 * 形态照抄 `bridge/debugMessages.ts` 的 `DEBUG_QUERY_ERROR_CODES`：const 数组是**唯一真源**，
 * 类型从数组派生，发射点只引用这里。**不并进 `MODULE_ERROR_CODES`**：那张表的语义是
 * "ModuleLoader 会发射的码"，而 loader 永远不发射 facet 独有的码；并进去会让
 * `moduleLoader.test.mjs` 的"每码都有发射点"门禁变红——那条门禁是对的。
 *
 * 清单分两类（键名必须能回答"谁发射"）：
 * - **loader 命名空间**（`module.callFailed` / `module.registrationInvalid` /
 *   `module.editorConflict`）：码值由 `MODULE_ERROR_CODES` 定义，这里按成员名引用
 *   （`loaderCode`），不复制字符串——loader 改名/删除时这里与发射点一起编译失败。
 * - **facet 独有**（`module.renderTooLarge`）：只由本扩展的 facet 路由发射，loader 不发射。
 */

import { MODULE_ERROR_CODES, type ModuleErrorCode } from "@visualbridge/node-host";

/** loader 命名空间里本路由会发射的码的成员名（去掉 `module.` 前缀）。 */
const LOADER_FACET_CODE_NAMES = ["callFailed", "editorConflict", "registrationInvalid"] as const;

type LoaderFacetCodeName = (typeof LOADER_FACET_CODE_NAMES)[number];

/**
 * 按成员名从 loader 的权威表里取码。
 *
 * 值只在 `MODULE_ERROR_CODES` 一处定义：这里不复制字符串，运行时按表查找，类型上收窄成
 * 该成员的字面量（`Extract`）。表里没有该成员时**模块加载期即抛错**，不会留下第二份
 * "看起来对"的码。
 */
function loaderCode<N extends LoaderFacetCodeName>(name: N): Extract<ModuleErrorCode, `module.${N}`> {
  const code = `module.${name}`;
  const found = MODULE_ERROR_CODES.find((candidate) => candidate === code);
  if (found === undefined) {
    throw new Error(`'${code}' is not registered in MODULE_ERROR_CODES (module loader namespace).`);
  }

  return found as Extract<ModuleErrorCode, `module.${N}`>;
}

/**
 * facet 路由可能发射的全部诊断码（`DebugFacetDiagnostic.code` 的取值域）。
 *
 * 顺序：loader 命名空间在前、facet 独有在后；新增码必须同时补发射点与覆盖用例
 * （`test/unit/debugFacetDiagnostics.test.ts` 的"码 → 触发方式"表会因缺项而编译失败）。
 */
export const DEBUG_FACET_ERROR_CODES = [
  loaderCode("callFailed"),
  loaderCode("registrationInvalid"),
  loaderCode("editorConflict"),
  // facet 独有：渲染增量超过 `DEBUG_FACET_CONTENT_MAX_BYTES`，由 batched `onRecord` 检查发射。
  "module.renderTooLarge",
] as const;

export type DebugFacetErrorCode = (typeof DEBUG_FACET_ERROR_CODES)[number];

/** 诊断码是否属于本清单（线上/日志/测试据此校验，不做前缀猜测）。 */
export function isDebugFacetErrorCode(value: string): value is DebugFacetErrorCode {
  return (DEBUG_FACET_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 运行期把码收口到清单。
 *
 * 类型系统已经保证所有内部发射点只能传清单里的字面量；这里防的是 `as DebugFacetErrorCode`
 * 之类的绕过——诊断码是面板/文档/测试共用的契约，未登记码必须当场失败而不是静默进入快照。
 */
export function assertDebugFacetCode(value: string): DebugFacetErrorCode {
  if (!isDebugFacetErrorCode(value)) {
    throw new Error(`Unregistered debug facet diagnostic code: '${value}'.`);
  }

  return value;
}
