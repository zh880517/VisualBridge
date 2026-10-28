/**
 * 宿主侧模块注册契约（C2：由 ModuleLoader 支撑）。
 *
 * 这里只保留宿主真正需要的视图：editor 归属、模块状态、诊断与 `dispose`。真正的模块装载、
 * entry/hash 校验、注册面校验与冲突裁决全部在 `@visualbridge/node-host` 的 `ModuleLoader` 里，
 * 宿主不再自己实现一遍状态机（B1 的临时形态在 C2 删除）。
 *
 * 授权边界（附录 D.2 / D.6）：
 * - 未受信任时注册源**不求值任何模块**，也不提供 manifest：`authorization` 让注册表在问
 *   `manifest()` 之前就知道"现在不能装载"，因此不需要任何静态 id→editor 表。
 * - `VB_SKIP_MODULES=1` 走 `skipped`：工作区是受信任的，但本进程刻意跳过模块装载（排查用）。
 */
import * as vscode from "vscode";
import type { ModuleDiagnostic, ModuleStatus } from "@visualbridge/node-host";
import type { ModuleRegistration } from "@visualbridge/module-sdk";
import type { ProjectContext } from "../project/projectRegistry";

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
 * `validateOptions` 省略表示模块不校验自身 `modules[i].options`（loader 已调用过一次）。
 */
export interface HostModuleRegistration {
  readonly editors: readonly HostEditorRegistration[];
  dispose?(): void;
}

/** 一个已解包的 webview 资产（bundle 文本落盘后的位置）。 */
export interface HostModuleWebviewAsset {
  readonly script: vscode.Uri;
  readonly style: vscode.Uri;
  /** 该 bundle 的解包目录；`localResourceRoots` 需要包含它。 */
  readonly resourceRoot: vscode.Uri;
}

/**
 * 已装载 bundle 的完整注册面（SDK `ModuleRegistration` 原样 + 解包后的 webview 资产）。
 *
 * 宿主侧 `moduleEditorFacets` 只读这里，不再 import 任何领域包。
 */
export interface HostModuleBundle {
  readonly moduleId: string;
  /** 实际字节的 `sha256:<hex>`（解包目录名就是它的十六进制部分）。 */
  readonly hash: string;
  readonly registration: ModuleRegistration;
  readonly webviews: Readonly<Record<string, HostModuleWebviewAsset>>;
}

/** 一个模块在某个 Project 内的装载结果视图（loader `LoadedModule` 的宿主投影）。 */
export interface HostLoadedModule {
  readonly id: string;
  readonly entry: string;
  readonly status: ModuleStatus;
  readonly diagnostics: readonly ModuleDiagnostic[];
  readonly manifest: ModuleManifestView | undefined;
  readonly registration: HostModuleRegistration | undefined;
  /** 已装载 bundle 的完整注册面；未装载时 undefined。 */
  readonly bundle: HostModuleBundle | undefined;
  /** 实际字节的 `sha256:<hex>`；读取失败时 undefined。 */
  readonly hash: string | undefined;
  readonly declaredHash: string | undefined;
}

/**
 * 注册源的授权态。
 *
 * `untrusted`：Workspace Trust 未授予（或 Project Root 不是本地 `file`）；
 * `skipped`：受信任但宿主跳过装载（`VB_SKIP_MODULES=1`）；
 * `trusted`：正常装载。
 */
export type ModuleSourceAuthorization = "trusted" | "untrusted" | "skipped";

/**
 * 注册源：由 `ModuleLoader` 适配器实现。
 *
 * 所有方法都必须**不执行模块代码**，除非已经 `prepare` 过该 Project 且授权为 `trusted`。
 * `prepare` 是唯一会求值 bundle 的入口，注册表在进入模块装载循环前只调用它一次。
 */
/** 授权判据的输入事实（附录 D.6）。 */
export interface ModuleAuthorizationFacts {
  readonly trusted: boolean;
  /** Project Root 的 URI scheme；只有本地 `file` 才允许装载。 */
  readonly rootScheme: string;
  readonly skipModules: boolean;
}

/**
 * 唯一的授权判据（附录 D.6）：`VB_SKIP_MODULES=1` 一律 `skipped`；否则要求 Workspace Trust
 * **且** Project Root 是本地 `file` scheme。
 *
 * 宿主与注册源都必须调用这里。两处各写一份就会出现 Remote-SSH/devcontainer 下的越权：宿主按
 * 未授权丢弃模块，注册源却已把 bundle 求值、解包 webview 并把 facet 登记进全局表。
 */
export function resolveModuleAuthorization(facts: ModuleAuthorizationFacts): ModuleSourceAuthorization {
  if (facts.skipModules) return "skipped";
  return facts.trusted && facts.rootScheme === "file" ? "trusted" : "untrusted";
}

/**
 * 未授权时给用户的原因与文案（纯函数，便于单测两条分支互不串台）。
 *
 * `skipped` 必须排在 `untrusted` 判定之前：`VB_SKIP_MODULES=1` 时授权必然不是 trusted，
 * 若先判 untrusted，用户会看到"需要信任工作区"——那是误导（工作区已经信任了）。
 */
export function moduleUnavailableAuthorization(
  authorization: ModuleSourceAuthorization,
  rootScheme: string,
): { readonly reason: "disabled" | "untrusted"; readonly message: string } {
  if (authorization === "skipped") {
    return {
      reason: "disabled",
      message: "模块装载已被 VB_SKIP_MODULES=1 关闭，已回退为只读视图。",
    };
  }
  if (rootScheme !== "file") {
    return {
      reason: "untrusted",
      message: `Project Root 不是本地 file scheme（当前 '${rootScheme}'），模块不会装载，已回退为只读视图。`,
    };
  }
  return { reason: "untrusted", message: "需要信任工作区才能加载模块。" };
}

export interface ModuleRegistrationSource {
  /** 进程级提示：把 scheme 当成 `file`，只能用于"本进程是否装载模块"的粗提示。 */
  readonly authorization: ModuleSourceAuthorization;
  /** 该 Project 的授权态；与 `prepare` 内部用的是同一个判据函数。 */
  authorizationFor(project: ProjectContext): ModuleSourceAuthorization;
  /**
   * 为某个 Project 建立/刷新 loader 结果；幂等，未授权时立即返回且不求值任何 bundle。
   *
   * `force` 为 true 时丢弃旧 loader（模块定义变化或 Trust 授予后重载）。
   */
  prepare(project: ProjectContext, force?: boolean): Promise<void>;
  /** 该 Project 的装载结果；未 `prepare` 或未授权时为空数组。 */
  modules(project: ProjectContext): readonly HostLoadedModule[];
  /**
   * 重读已装载模块的字节；返回因此变成 `stale` 的模块 id（空数组表示没有变化）。
   *
   * 只标状态、不求值：由宿主决定是否提示并 `prepare(project, true)` 重载。
   */
  refreshStale?(project: ProjectContext): Promise<readonly string[]>;
  /** 宿主判定某个模块不可用（例如注入的激活失败）时撤销它已登记的 facet。
   *
   * 模块装载失败后不得继续贡献 referenceData（否则语义快照会保留失败模块的引用数据）。
   */
  rejectModule?(projectKey: string, moduleId: string): void;
  /** 释放某个 Project（marker key）的 loader 与模块注册。 */
  disposeProject(projectKey: string): void;
  /**
   * 激活时清理无人引用的 `<hash>` 目录。
   *
   * 只在激活路径调用：装载/重载期间清理会删掉已打开面板正在加载的旧目录（隐藏再显示即 404），
   * 所以清理收回到激活那一刻，旧目录在本次会话内保留。
   */
  cleanStaleWebviews?(): Promise<void>;
  /** 释放全部 loader。 */
  dispose(): void;
  /** 仅测试用：宿主据此断言 loader 确实被释放（而不只是条目被删）。 */
  testCounters?(): {
    readonly disposedEntries: number;
    readonly disposedProjectKeys: readonly string[];
  };
  /**
   * 注册源本身已经求值过的模块 id。
   *
   * 观测范围**只有本接口的装载**：未授权时保持为空，表示"注册源没有求值任何 bundle"。
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
