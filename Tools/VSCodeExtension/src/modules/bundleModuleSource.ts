/**
 * 由 ModuleLoader 支撑的注册源（C2 取代 `inProcessModuleSource.ts`）。
 *
 * 职责：
 * - 按 Project 建一个 `ModuleLoader`（`Tools/NodeHost` 里唯一一份装载实现：entry 解析、字节读取、
 *   hash 校验、bundle 求值、注册面校验、editor/reference/debug 冲突裁决、`options` 校验）。
 * - 未受信任（或 `VB_SKIP_MODULES=1`）时**不求值任何 bundle**：loader 根本不创建，宿主只看到
 *   `authorization`，因此不需要任何静态 id→editor 表。
 * - 把 bundle 里的 webview 文本解包到 `<globalStorage>/modules/<sha256>/`，并清理无人引用的
 *   旧目录（引用集 = **所有**已装载 Project 的并集，见 `webviewAssets.ts`）。
 * - 把每个已装载模块的 `semantic`/`catalog`/`create` facet 登记到 `documentFacetRegistry`，
 *   供不按 editor 分支的宿主代码（语义索引、Catalog、创建、引用重构）使用。
 */
import type * as vscode from "vscode";
import { ModuleLoader, type LoadedModule } from "@visualbridge/node-host";
import type { ModuleRegistration } from "@visualbridge/module-sdk";
import type { DocumentFacet } from "@visualbridge/core";
import type { CatalogFacet, CatalogWithSource } from "../catalog/catalogRegistryLoader";
import type { ModuleCreateFacet } from "../editor/moduleEditorFacets";
import type { ProjectContext } from "../project/projectRegistry";
import { registerDocumentFacets, unregisterDocumentFacets, type HostDocumentFacet } from "./documentFacetRegistry";
import {
  resolveModuleAuthorization,
  type HostLoadedModule,
  type HostModuleBundle,
  type HostModuleRegistration,
  type HostModuleWebviewAsset,
  type ModuleRegistrationSource,
  type ModuleSourceAuthorization,
} from "./moduleRegistration";
import { cleanModuleWebviewDirectories, unpackModuleWebviews } from "./webviewAssets";

/** `VB_SKIP_MODULES=1`：受信任时也跳过模块装载，用于隔离排查（附录 D.6）。 */
export const SKIP_MODULES_ENV = "VB_SKIP_MODULES";

export interface BundleModuleSourceOptions {
  /** `<globalStorage>/modules` 的落盘位置。 */
  readonly modulesRoot: vscode.Uri;
  readonly output: vscode.OutputChannel;
  /** Workspace Trust；每次 `prepare` 都重新读，授予信任后无需重载窗口。 */
  readonly isTrusted: () => boolean;
  /** `vscode.Uri.file` 的替身；单元测试不加载 vscode 运行时。 */
  readonly toUri?: (path: string) => vscode.Uri;
  readonly env?: NodeJS.ProcessEnv;
}

interface ProjectEntry {
  readonly definitionKey: string;
  /** 建立该条目时的授权态；与当前授权不同就必须重走装载/释放（撤回授权的唯一兜底）。 */
  readonly authorization: ModuleSourceAuthorization;
  readonly loader: ModuleLoader<ModuleRegistration>;
  modules: readonly HostLoadedModule[];
  readonly hashes: readonly string[];
  /** 宿主判定不可用的模块（注入失败等）；重新登记 facet 时排除。 */
  readonly rejected: Set<string>;
}

export function createBundleModuleSource(options: BundleModuleSourceOptions): ModuleRegistrationSource {
  const entries = new Map<string, ProjectEntry>();
  /** 仅测试用：`disposeEntry` 次数。 */
  let disposedEntriesValue = 0;
  const disposedProjectKeysValue: string[] = [];
  const env = options.env ?? process.env;
  const skipModules = env[SKIP_MODULES_ENV] === "1";
  const toUri = options.toUri ?? defaultToUri;
  /** 与宿主共用的 D.6 判据（Trusted 且本地 file scheme）。 */
  const authorizationFor = (project: ProjectContext): ModuleSourceAuthorization => resolveModuleAuthorization({
    trusted: options.isTrusted(),
    rootScheme: project.rootUri.scheme,
    skipModules,
  });
  /**
   * `prepare` 串行化。
   *
   * Project 的装载是并发的（`syncProjects` 一次性重载多个 Project），而每个 Project 收尾都会做
   * "删除无人引用的 hash 目录"。若两个 prepare 交错，后者的清理可能删掉前者刚写好的目录
   * （随后打开文档时 `graph.css: ENOENT`）。串行化后清理只在没有任何解包在飞行时发生。
   */
  let prepareQueue: Promise<unknown> = Promise.resolve();

  const source: ModuleRegistrationSource = {
    get authorization(): ModuleSourceAuthorization {
      // **只用于进程级提示**（例如设置面板的开关状态），不能拿来做 Project 级判断：
      // 真实 scheme 依赖具体 Project，Project 级分支必须调 `authorizationFor(project)`。
      return resolveModuleAuthorization({ trusted: options.isTrusted(), rootScheme: "file", skipModules });
    },
    authorizationFor,
    cleanStaleWebviews: cleanStaleAssets,
    async prepare(project, force = false) {
      // 注意：必须把 `prepareOnce` 包成 thunk 入队。直接 `const run = prepareOnce(...)`
      // 会在调用处立刻开始解包，等于没排队。
      const queued = prepareQueue.then(
        () => prepareOnce(project, force),
        () => prepareOnce(project, force),
      );
      prepareQueue = queued.then(() => undefined, () => undefined);
      await queued;
    },
    modules(project) {
      return entries.get(project.markerUri.toString())?.modules ?? [];
    },
    refreshStale: async (project) => {
      const entry = entries.get(project.markerUri.toString());
      if (entry === undefined) return [];
      const result = await entry.loader.refreshStale();
      const stale: string[] = [];
      for (const module of result.modules) {
        if (module.status !== "stale") continue;
        stale.push(module.id);
      }
      if (stale.length === 0) return [];
      // 只更新状态与诊断：bundle 仍留在原解包目录，直到用户确认重载。
      entry.modules = entry.modules.map((module) => {
        const refreshed = result.modules.find((candidate) => candidate.id === module.id);
        return refreshed === undefined || refreshed.status !== "stale"
          ? module
          : { ...module, status: "stale", diagnostics: [...refreshed.diagnostics] };
      });
      return stale;
    },
    rejectModule(projectKey, moduleId) {
      const entry = entries.get(projectKey);
      if (entry === undefined) return;
      entry.rejected.add(moduleId);
      registerDocumentFacets(projectKey, documentFacets(entry.modules, entry.rejected));
    },
    disposeProject(projectKey) {
      const entry = entries.get(projectKey);
      if (entry === undefined) return;
      entries.delete(projectKey);
      disposeEntry(projectKey, entry);
    },
    dispose() {
      for (const [key, entry] of [...entries]) {
        entries.delete(key);
        disposeEntry(key, entry);
      }
    },
    get evaluatedModuleIds(): readonly string[] {
      const ids = new Set<string>();
      for (const entry of entries.values()) {
        for (const module of entry.modules) {
          if (module.status === "loaded") ids.add(module.id);
        }
      }
      return [...ids].sort();
    },
    /** 仅测试用：`disposeEntry` 的调用次数与命中的 Project（证明 loader 与模块注册真的被释放）。 */
    testCounters: () => ({
      disposedEntries: disposedEntriesValue,
      disposedProjectKeys: [...disposedProjectKeysValue],
    }),
  };
  return source;

  function defaultToUri(path: string): vscode.Uri {
    // 延迟 require vscode：单元测试直接 import 本模块时不需要 vscode 运行时。
    const runtime = require("vscode") as typeof import("vscode");
    return runtime.Uri.file(path);
  }

  async function prepareOnce(project: ProjectContext, force: boolean): Promise<void> {
    const key = project.markerUri.toString();
    const definitionKey = JSON.stringify(project.definition.modules);
    // 授权判据必须**先于**幂等短路：生产路径 `ensureProject` 用 `force=false`，
    // 若先按 definitionKey 短路，会话中撤回信任（或 Project Root 变成远端 scheme）时
    // 既不释放旧 loader 也不注销 facet，注册源会一直报 loaded。
    const authorization = authorizationFor(project);
    const previous = entries.get(key);
    if (!force
      && previous !== undefined
      && previous.definitionKey === definitionKey
      && previous.authorization === authorization) {
      return;
    }
    if (previous !== undefined) {
      entries.delete(key);
      disposeEntry(key, previous);
    }
    // 未授权（含 Remote-SSH / devcontainer 的非 file scheme、以及会话中撤回信任）时连 loader 都不创建：
    // 否则 bundle 会被越权求值、webview 被解包、facet 被登记进全局表。
    // 条目必须彻底删除：留着一个已 dispose 的条目会让 `modules()` / `evaluatedModuleIds` 继续报 `loaded`。
    if (authorization !== "trusted") return;

    const loader = await ModuleLoader.create<ModuleRegistration>({
      projectRoot: project.rootUri.fsPath,
      projectId: project.definition.projectId,
      modules: project.definition.modules,
      trusted: true,
      log: (entry) => {
        const suffix = entry.details === undefined ? "" : ` ${JSON.stringify(entry.details)}`;
        options.output.appendLine(
          `[modules] ${entry.timestamp} ${entry.event}${entry.moduleId === undefined ? "" : ` ${entry.moduleId}`}`
          + `${entry.message === undefined ? "" : `: ${entry.message}`}${suffix}`,
        );
      },
    });
    // 登记**只在解包成功后**发生；失败路径的唯一回收点是下面的 catch。
    //
    // 不要改成"先 entries.set(pending) 再解包，靠宿主 catch 里的 `disposeProject(markerKey)`
    // 回收"：那样 `prepareOnce` 的 catch 与宿主重复负责，去掉任何一边都不会泄漏，
    // 于是"失败后 loader 已被释放"这条断言无法证伪。这里让 catch 成为唯一回收点，
    // 失败时 loader 除局部变量外没有任何引用，删掉 catch 的回收就是真泄漏（用例会红）。
    const pending: ProjectEntry = {
      definitionKey,
      authorization,
      loader,
      modules: [],
      hashes: [],
      rejected: new Set<string>(),
    };
    try {
      entries.set(key, await buildEntry(project, loader));
    } catch (errorValue) {
      disposeEntry(key, pending);
      throw errorValue;
    }
    // 清理**不在这里**：装载/重载期间删旧 `<hash>` 目录会让已打开面板（隐藏再显示）加载失败。
    // 清理只在激活路径 `cleanStaleWebviews()` 做一次。
  }

  function disposeEntry(key: string, entry: ProjectEntry): void {
    unregisterDocumentFacets(key);
    disposedEntriesValue += 1;
    disposedProjectKeysValue.push(key);
    try {
      entry.loader.dispose();
    } catch (errorValue) {
      options.output.appendLine(`[modules] dispose failed: ${String(errorValue)}`);
    }
  }

  async function buildEntry(project: ProjectContext, loader: ModuleLoader<ModuleRegistration>): Promise<ProjectEntry> {
    const loaded = loader.result.modules;
    const modulesRoot = options.modulesRoot.fsPath;
    const unpacked = await unpackModuleWebviews(
      modulesRoot,
      loaded
        .filter((module) => module.status === "loaded" && module.hash !== undefined)
        .map((module) => ({ moduleId: module.id, hash: module.hash!, webviews: module.webviews })),
    );
    const bundles = new Map<string, HostModuleBundle>();
    for (const item of unpacked) {
      const module = loaded.find((candidate) => candidate.id === item.moduleId);
      if (module?.registration === undefined) continue;
      const directory = toUri(item.directory);
      const webviews: Record<string, HostModuleWebviewAsset> = {};
      for (const [key, asset] of Object.entries(item.webviews)) {
        webviews[key] = {
          script: toUri(asset.script),
          style: toUri(asset.style),
          resourceRoot: directory,
        };
      }
      bundles.set(item.moduleId, {
        moduleId: item.moduleId,
        hash: module.hash!,
        registration: module.registration,
        webviews,
      });
    }

    const modules: HostLoadedModule[] = loaded.map((module) => ({
      id: module.id,
      entry: module.entry,
      status: module.status,
      diagnostics: module.diagnostics,
      manifest: module.manifest === undefined ? undefined : {
        id: module.manifest.id,
        version: module.manifest.version,
        apiVersion: module.manifest.apiVersion,
        ...(module.manifest.sdkVersion === undefined ? {} : { sdkVersion: module.manifest.sdkVersion }),
        editors: module.manifest.editors,
      },
      registration: registrationView(module),
      bundle: bundles.get(module.id),
      hash: module.hash,
      declaredHash: module.declaredHash,
    }));

    registerDocumentFacets(project.markerUri.toString(), documentFacets(modules, new Set<string>()));
    return {
      definitionKey: JSON.stringify(project.definition.modules),
      // 走到这里必然已通过授权判据，与 `prepareOnce` 算出的那一次一致。
      authorization: "trusted",
      loader,
      modules,
      hashes: unpacked.map((item) => item.hash),
      rejected: new Set<string>(),
    };
  }

  async function cleanStaleAssets(): Promise<void> {
    const referenced = new Set<string>();
    for (const entry of entries.values()) {
      for (const hash of entry.hashes) referenced.add(hash);
    }
    try {
      await cleanModuleWebviewDirectories(options.modulesRoot.fsPath, referenced);
    } catch (errorValue) {
      options.output.appendLine(`[modules] webview asset cleanup failed: ${String(errorValue)}`);
    }
  }
}

/** 注册表只需要 editor 归属与 `dispose`；`bundle` 里的完整注册面给 `moduleEditorFacets` 用。 */
function registrationView(module: LoadedModule<ModuleRegistration>): HostModuleRegistration | undefined {
  if (module.registration === undefined) return undefined;
  const registration = module.registration;
  return {
    editors: registration.editors.map((editor) => ({
      editor: editor.editor,
      webview: editor.webview,
      webviewTitle: editor.webviewTitle,
    })),
    dispose: () => registration.dispose?.(),
  };
}

function documentFacets(
  modules: readonly HostLoadedModule[],
  rejected: ReadonlySet<string>,
): readonly HostDocumentFacet[] {
  const entries: HostDocumentFacet[] = [];
  for (const module of modules) {
    if (rejected.has(module.id)) continue;
    const bundle = module.bundle;
    if (bundle === undefined) continue;
    for (const editor of bundle.registration.editors) {
      entries.push({
        moduleId: module.id,
        hash: bundle.hash,
        facet: editor.semantic as DocumentFacet<unknown, unknown>,
        ...(editor.catalog === undefined
          ? {}
          : { catalog: editor.catalog as CatalogFacet<CatalogWithSource, unknown> }),
        ...(editor.create === undefined
          ? {}
          : { create: editor.create as ModuleCreateFacet }),
      });
    }
  }
  return entries;
}
