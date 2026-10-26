/**
 * C2 删除：进程内模块注册源。
 *
 * 本文件是仓库里唯一按 `modules[].id` 把 `@visualbridge/entity|graph|structured|table`
 * 包装成注册的地方；C2 接入 ModuleLoader 后整文件删除，业务代码不得反向引用它。
 *
 * 授权边界（附录 D.2 / D.6）：
 * - `provides` / `manifest` 只做 id 与 editor 的静态映射，本文件在模块作用域不 import 任何领域包；
 * - 领域包只在 `activate` 内动态 `import()`，而 `activate` 只由注册表在"已授权且模块可装载"
 *   的分支调用。未受信任时注册源不会 activate 任何模块、也不会走模块驱动路径，
 *   `evaluatedModuleIds` 保持为空。
 *
 * 观测口径：`evaluatedModuleIds` 只观测本注册源，**不观测**扩展 bundle 加载时由其它静态 import
 * （documentEditorProvider / 语义索引 / Catalog 解析等）触发的领域包初始化；那部分要在 C2/C1
 * 把领域代码移出宿主 bundle 后才能消除。
 */
import { MODULE_API_VERSION } from "@visualbridge/node-host";
import type {
  HostModuleRegistration,
  ModuleManifestView,
  ModuleRegistrationSource,
} from "./moduleRegistration";

/** 进程内模块的 manifest 版本；C2 换成 bundle 自带版本后删除。 */
const IN_PROCESS_MODULE_VERSION = "0.1.0";

/**
 * 内置模块 id → editor。id 与 editor 的固定对应关系来自附录 D.1：
 * `visualbridge.graph|entity|structured|table` 分别提供 `graph|entity|structured|table`。
 */
const IN_PROCESS_EDITORS: Readonly<Record<string, string>> = {
  "visualbridge.entity": "entity",
  "visualbridge.graph": "graph",
  "visualbridge.structured": "structured",
  "visualbridge.table": "table",
};

/** 已求值领域包的模块 id；跨 Project 去重，仅供测试与诊断读取。 */
const evaluatedModuleIds = new Set<string>();

export function createInProcessModuleSource(): ModuleRegistrationSource {
  return {
    provides: (moduleId) => hasDomain(moduleId),
    manifest: (moduleId) => {
      const editor = editorOf(moduleId);
      if (editor === undefined) return undefined;
      const manifest: ModuleManifestView = {
        id: moduleId,
        version: IN_PROCESS_MODULE_VERSION,
        apiVersion: MODULE_API_VERSION,
        editors: [editor],
      };
      return manifest;
    },
    activate: async (moduleId) => {
      const editor = editorOf(moduleId);
      if (editor === undefined) {
        throw new Error(`No in-process module is registered for '${moduleId}'.`);
      }
      // 只有走到这里才求值领域包：动态 import 保证未受信任时连模块求值都不会发生。
      const domainModule = await importDomainPackage(moduleId);
      const editorId = domainModule[domainEditorIdExport(moduleId)];
      if (editorId !== editor) {
        throw new Error(
          `Domain package for '${moduleId}' exports '${String(editorId)}', expected '${editor}'.`,
        );
      }
      evaluatedModuleIds.add(moduleId);
      const registration: HostModuleRegistration = {
        editors: [{
          editor,
          // Webview 资产仍由宿主的 dist/webview 提供；C1 起改由 bundle 的 webviews 提供。
          webview: editor,
          webviewTitle: `VisualBridge ${editor}`,
        }],
      };
      return registration;
    },
    get evaluatedModuleIds(): readonly string[] {
      return [...evaluatedModuleIds].sort();
    },
  };
}

function hasDomain(moduleId: string): boolean {
  return Object.hasOwn(IN_PROCESS_EDITORS, moduleId);
}

function editorOf(moduleId: string): string | undefined {
  return Object.hasOwn(IN_PROCESS_EDITORS, moduleId) ? IN_PROCESS_EDITORS[moduleId] : undefined;
}

function domainEditorIdExport(moduleId: string): string {
  return `${moduleId.slice("visualbridge.".length).toUpperCase()}_EDITOR_ID`;
}

/** 按 id 动态 import 领域包；C2 删除本函数（改为 ModuleLoader 的求值记录）。 */
async function importDomainPackage(moduleId: string): Promise<Record<string, unknown>> {
  switch (moduleId) {
    case "visualbridge.entity":
      return import("@visualbridge/entity") as unknown as Promise<Record<string, unknown>>;
    case "visualbridge.graph":
      return import("@visualbridge/graph") as unknown as Promise<Record<string, unknown>>;
    case "visualbridge.structured":
      return import("@visualbridge/structured") as unknown as Promise<Record<string, unknown>>;
    case "visualbridge.table":
      return import("@visualbridge/table") as unknown as Promise<Record<string, unknown>>;
    default:
      throw new Error(`No in-process module is registered for '${moduleId}'.`);
  }
}
