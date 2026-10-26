/**
 * 宿主侧模块注册契约（B1）。
 *
 * 这里是 SDK `ModuleRegistration` 在宿主当前阶段消费的子集：B1 只关心 editor 归属、
 * 模块状态与 `dispose`。B2/B3 会在同一个注册对象上补齐会话与语义 facet；C2 把进程内
 * 注册源换成 ModuleLoader 产出的完整注册后，这些类型随之被 SDK 契约取代。
 *
 * 状态机、错误码与授权规则见附录 D.2 / D.6：状态与诊断类型直接复用 NodeHost 的
 * 单一定义，避免宿主侧再抄一份 `module.*` 错误码。
 */
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import type { ModuleDiagnostic, ModuleStatus } from "@visualbridge/node-host";

export type { ModuleDiagnostic, ModuleStatus };

/** 模块 manifest 的宿主视图；字段与附录 D.2 一致。 */
export interface ModuleManifestView {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly sdkVersion?: string;
  readonly editors: readonly string[];
}

/** 单个 editor 的注册视图；`webview` 是模块 bundle 里的 webview key。 */
export interface HostEditorRegistration {
  readonly editor: string;
  readonly webview: string;
  readonly webviewTitle: string;
}

/**
 * 模块注册视图。
 *
 * `dispose` 在模块停用、定义变化与 Project 关闭时调用，必须幂等；
 * `validateOptions` 省略表示模块不校验自身 `modules[i].options`。
 */
export interface HostModuleRegistration {
  readonly editors: readonly HostEditorRegistration[];
  validateOptions?(options: Readonly<Record<string, JsonValue>> | undefined): readonly DocumentDiagnostic[];
  dispose?(): void;
}

/**
 * 注册源：进程内适配层（C2 删除）与后续 ModuleLoader 适配器实现同一接口。
 *
 * `provides` 与 `manifest` 不得执行模块代码：未受信任时宿主仍需要它们把
 * `documentTypes[].editor` 映射到具体模块，从而给出正确的只读原因。
 */
export interface ModuleRegistrationSource {
  /** 该 id 是否由本宿主进程提供。 */
  provides(moduleId: string): boolean;
  /** 不执行模块代码即可得到的 manifest；未知 id 返回 undefined。 */
  manifest(moduleId: string): ModuleManifestView | undefined;
  /** 执行模块代码并返回注册；抛错按 `module.activateFailed` 处理。 */
  activate(moduleId: string): HostModuleRegistration | Promise<HostModuleRegistration>;
  /**
   * 注册源本身已经 `activate` 过的模块 id。
   *
   * 观测范围**只有本接口的 `activate` 调用**（进程内适配层里对应的领域包动态 import）：
   * 它不观测扩展 bundle 加载时由既有静态 import 触发的包初始化。未受信任时这里保持为空，
   * 表示"注册源没有 activate 任何模块、也没有走模块驱动路径"，**不代表** bundle 级 init 未发生
   * （把领域代码真正移出宿主 bundle 属于 C2/C1）。C2 接入 ModuleLoader 后映射到 bundle 求值记录。
   */
  readonly evaluatedModuleIds?: readonly string[];
}

/** 跨模块诊断：定位到 `documentTypes[i].editor` 这类不属于单个模块条目的位置。 */
export interface ModuleEdgeDiagnostic {
  /** `documentTypes` 的数组下标（Project File 中的位置）。 */
  readonly index: number;
  readonly diagnostic: ModuleDiagnostic;
}

/** editor 不可用的原因；只读 Shell 的提示文案由此决定。 */
export type ModuleEditorFallbackReason = "untrusted" | "failed" | "disabled" | "stale" | "undeclared";

/** 某个 editor 在当前 Project 内的可用性。 */
export type ModuleEditorAvailability =
  | { readonly kind: "available"; readonly moduleId: string }
  | {
      readonly kind: "unavailable";
      readonly reason: ModuleEditorFallbackReason;
      /** 中文提示，直接显示在只读 Shell 与 Output 日志里。 */
      readonly message: string;
      readonly moduleId?: string;
    };
