/**
 * 宿主侧模块注册表（B1）。
 *
 * 职责（附录 D.2 / D.6）：
 * - 以 Project 为作用域保存模块状态（`loaded` / `failed` / `untrusted` / `disabled` / `stale`）、
 *   诊断、注册与 `dispose`，状态变化时发事件。
 * - 授权：Workspace Trust 且 Project Root 是本地 `file` scheme 才装载；否则全部 `untrusted`，
 *   **注册源不 activate 任何模块**。`onDidGrantWorkspaceTrust` 之后重新装载，无需重载窗口。
 * - 诊断合并进 Project File 诊断集合，并按 `modules[i]` / `documentTypes[i].editor` 定位。
 *
 * 注册源由 `ModuleRegistrationSource` 注入；B1 用进程内适配层，C2 换成 ModuleLoader 适配器。
 *
 * ── B1 已登记缺口（约束 / 为何现在做不到 / 归属）────────────────────────────────
 * 1) 约束：Restricted Mode 下不执行任何模块代码（含 require 时机）。
 *    现状：注册源与所有模块依赖的运行时路径（编辑器会话、文档语义索引、Catalog 解析、
 *    Catalog 绑定校验、create 系列命令与生命周期命令）在模块不可用时全部跳过；但扩展 bundle 仍静态
 *    import 四个领域包，bundle 加载时的包初始化（init_*）无条件发生，`evaluatedModuleIds`
 *    观测不到它。归属：把领域代码移出宿主 = C1（Modules 工程）+ C2（ModuleLoader）+ B2/B3
 *    （模块驱动会话与语义编排）。
 * 2) 约束：模块 Catalog 能力来自模块（附录 D.3 catalog facet）。
 *    现状：四个领域包已就地导出 `catalog` facet，宿主 `modules/documentFacetRegistry.ts`
 *    只做 editor → facet 映射，Catalog 解析/定义浏览/绑定校验都不再按 editor 分支；但解析仍在
 *    宿主 bundle 内执行，只能按 editor 可用性跳过。归属：C1/C2（facet 由 bundle 登记后彻底
 *    移出宿主）。
 * 3) 约束：`modules[].entry` 必须校验真实路径（D.1）。
 *    现状：B1 **完全不解析 entry**（只保存字符串），因此 `module.notFound` / `module.invalidPath`
 *    / `module.entryAlias` 永不触发。归属：C2。注意：Entity/Graph/Provider/Structured/Table
 *    五个 TestData 工程声明的 `Modules/<domain>.vbmodule.js` **尚不存在**（ModuleLoaderProject
 *    的 14 个 fixture bundle 已存在）；C2 实现 entry 解析前必须先补这五个文件，否则 trusted
 *    宿主工程会集体转为 failed。
 * 4) 约束：声明 hash 与 bundle 字节比对（D.1 `module.hashMismatch`）。
 *    现状：B1 只记录声明值并展示前 12 位，没有 bundle 字节可比。归属：C2。
 * 5) 约束：真实 `onDidGrantWorkspaceTrust` 路径要可验证。
 *    现状：VS Code 没有在测试内真正 grant 的公开 API；测试调用的是 initialize 订阅的同一个
 *    `handleGrantedTrust`，订阅本身只能由代码构造保证。归属：无（测试环境限制，已登记）。
 * 6) 约束：`disabled` / `stale` 状态可观测。
 *    现状：`disabled` 只有 editorConflict / apiVersionMismatch 两条路径且内置 id 与 editor
 *    一一对应，实际不可达；`stale` 只在定义变化→重载的瞬态出现。归属：C2/F4 接入后自然覆盖。
 * 7) 约束：dirty Table 自定义文档在模块失效时不得丢编辑。
 *    现状：TableEditorGate 遇到 dirty 面板不 dispose、只提示一次（不做 backup-on-dispose，
 *    因为宿主无法主动发起 backup；VS Code 的 backup 由编辑器侧驱动）。归属：B1 现状即取舍，
 *    C1/C2 的模块驱动 Table 编辑器需要原生 backup。
 * ────────────────────────────────────────────────────────────────────────────
 */
import * as vscode from "vscode";
import { MODULE_API_VERSION } from "@visualbridge/node-host";
import type { JsonValue, VisualBridgeProjectDefinition } from "@visualbridge/core";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type {
  HostLoadedModule,
  HostModuleBundle,
  HostModuleRegistration,
  ModuleSourceAuthorization,
  ModuleDiagnostic,
  ModuleEdgeDiagnostic,
  ModuleEditorAvailability,
  ModuleManifestView,
  ModuleRegistrationSource,
  ModuleStatus,
} from "./moduleRegistration";
import { moduleUnavailableAuthorization } from "./moduleRegistration";

/** 单个模块在一个 Project 内的状态快照。 */
export interface HostModuleState {
  readonly id: string;
  readonly index: number;
  readonly entry: string;
  readonly status: ModuleStatus;
  readonly declaredHash: string | undefined;
  readonly manifest: ModuleManifestView | undefined;
  readonly registration: HostModuleRegistration | undefined;
  /** 已装载 bundle 的完整注册面（注册面 + 解包后的 webview 资产）；未装载时 undefined。 */
  readonly bundle: HostModuleBundle | undefined;
  readonly diagnostics: readonly ModuleDiagnostic[];
}

/** 测试与诊断用的纯数据快照（不含注册对象）。 */
export interface HostModuleRegistryTestState {
  readonly trusted: boolean;
  /** 注册表调用 `activate` 的次数；Restricted Mode 必须为 0。 */
  readonly activationCount: number;
  /** 注册源真正求值过模块代码的模块 id；Restricted Mode 必须为空。 */
  readonly evaluatedModuleIds: readonly string[];
  readonly projects: readonly {
    readonly projectId: string;
    readonly markerUri: string;
    readonly modules: readonly {
      readonly id: string;
      readonly index: number;
      readonly status: ModuleStatus;
      readonly hash: string | undefined;
      /** 实际装载的 bundle hash（与声明 hash 区分）；重载后用它判断"版本变了"。 */
      readonly loadedHash: string | undefined;
      /** 该模块解包目录；用于断言旧目录在本次会话内仍存在。 */
      readonly webviewDirectory: string | undefined;
      readonly editors: readonly string[];
      readonly diagnostics: readonly ModuleDiagnostic[];
    }[];
  }[];
  /** 重载后给用户的可见提示（"模块已更新，请重新打开该文档"），按出现顺序保留最近 20 条。 */
  readonly reloadNotices: readonly string[];
  /** 注册源释放过的条目数（测试用：解包失败后 loader 必须被真释放）。 */
  readonly disposedModuleEntries: number;
  /** 注册源释放过的 Project marker key（按顺序）；用来断言"这一次失败的那个 Project 也被释放"。 */
  readonly disposedProjectKeys: readonly string[];
}

interface ProjectModuleSet {
  readonly markerKey: string;
  readonly markerUri: vscode.Uri;
  readonly projectId: string;
  readonly definitionKey: string;
  /** 装载这份状态时的授权态；用来发现"读过一次就不再重读"的授权漂移（尤其撤回）。 */
  readonly authorized: boolean;
  readonly modules: readonly HostModuleState[];
  /** editor id → 首个声明它的模块（含 failed/untrusted/disabled）。 */
  readonly editorOwners: ReadonlyMap<string, HostModuleState>;
  readonly documentDiagnostics: readonly ModuleEdgeDiagnostic[];
}

export class HostModuleRegistry implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly byProject = new Map<string, ProjectModuleSet>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly activationFailures = new Set<string>();
  private activationCountValue = 0;
  private trustOverride: boolean | undefined;
  /** 最近的重载可见提示（测试快照与用户提示共用）。 */
  private readonly reloadNotices: string[] = [];
  private disposed = false;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly source: ModuleRegistrationSource,
    private readonly output: vscode.OutputChannel,
    private readonly isWorkspaceTrusted: () => boolean = () => vscode.workspace.isTrusted,
  ) {}

  /** 首次装载必须在注册 Custom Editor 之前完成；之后由 Project/Trust 事件驱动。 */
  public async initialize(): Promise<void> {
    this.disposables.push(
      this.projects.onDidChange(() => {
        void this.syncProjects("projectChanged").catch((errorValue: unknown) => {
          this.output.appendLine(`[modules] Project reload failed: ${formatError(errorValue)}`);
        });
      }),
      // VS Code 只有 `onDidGrantWorkspaceTrust`，没有撤销事件（撤销信任会重启扩展宿主）。
      // 授予走这里；撤回（以及 Project Root 变成远端 scheme）由 `ensureProject` 的授权漂移检测兜住：
      // 注册源在幂等短路**之前**就比较授权态，一旦不同就释放旧 loader、注销 facet 并重走装载。
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.handleGrantedTrust().catch((errorValue: unknown) => {
          this.output.appendLine(`[modules] Trust reload failed: ${formatError(errorValue)}`);
        });
      }),
    );
    await this.syncProjects("initialize");
    // `<hash>` 目录的清理**只在激活时**做一次：装载/重载期间清理会删掉已打开面板正在加载的
    // 旧目录（面板隐藏再显示会重新请求 `<oldhash>/xxx.js`，删早了就是 404/空白）。
    await this.source.cleanStaleWebviews?.().catch((errorValue: unknown) => {
      this.output.appendLine(`[modules] webview asset cleanup failed: ${formatError(errorValue)}`);
    });
  }

  /** 新发现或刚变化的 Project 在打开文档前先完成一次装载。 */
  public async ensureProject(project: ProjectContext): Promise<void> {
    const markerKey = project.markerUri.toString();
    const inFlight = this.pending.get(markerKey);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const existing = this.byProject.get(markerKey);
    if (existing === undefined
      || existing.definitionKey !== moduleDefinitionKey(project.definition)
      // 授权撤回（Trust 失效 / Project Root 变成远端 scheme）没有事件：每次按需装载时重读授权，
      // 一旦和上次记录的授权态不同就强制重载，把旧 loader 与注册面拆掉（编辑器因此回退只读）。
      || existing.authorized !== this.isAuthorized(project)) {
      await this.reloadProject(project, "ensureProject");
    }
  }

  public modulesFor(project: ProjectContext): readonly HostModuleState[] {
    return this.byProject.get(project.markerUri.toString())?.modules ?? [];
  }

  /**
   * 当前授权态：未授予 Workspace Trust 时报 `untrusted`，否则透传注册源（可能是 `skipped`）。
   *
   * 供不按 editor 分支的 UI（文档浏览树）判断"要不要按 Project File 原样列出 Document Type"。
   */
  /** 进程级授权提示（不区分 Project）；Project 级判断一律用 `authorizationFor(project)`。 */
  public get authorization(): ModuleSourceAuthorization {
    if (!this.resolveTrust()) return "untrusted";
    return this.source.authorization;
  }

  /**
   * 某个 Project 的授权态（Project 级判断必须用这个）。
   *
   * Project Root 的 scheme 决定是否允许装载，所以 `vscode-remote`/devcontainer 下即使工作区
   * 已信任也不能用进程级的 `authorization` 判定。
   */
  public authorizationFor(project: ProjectContext): ModuleSourceAuthorization {
    if (!this.resolveTrust()) return "untrusted";
    return this.source.authorizationFor(project);
  }

  /**
   * 当前信任判定（含仅测试用的 override）。
   *
   * 注册源的 `isTrusted` 必须走这里，而不能直接读 `vscode.workspace.isTrusted`：测试用
   * `simulateGrantedTrustForTest` 模拟授权时，宿主与注册源必须看到同一个判定。
   */
  public isTrusted(): boolean {
    return this.resolveTrust();
  }

  /** 已装载模块的 bundle（注册面 + 解包后的 webview 资产）；未装载时 undefined。 */
  public bundleFor(project: ProjectContext, moduleId: string): HostModuleBundle | undefined {
    return this.modulesFor(project).find((module) => module.id === moduleId)?.bundle;
  }

  /**
   * 某个 editor 在当前 Project 内的可用性。
   *
   * 未受信任（或 `VB_SKIP_MODULES=1`）时**不查 manifest**：注册源在那里根本不求值 bundle，
   * 也就没有 manifest 可查（C2 之前靠静态 id→editor 表，那是 D.6 禁止的）。因此这两种情况下
   * 直接返回原因，不需要任何领域清单。
   *
   * 状态未知（尚未装载）返回 `stale`：调用方应先 `ensureProject`，这里保留兜底。
   */
  public editorAvailability(project: ProjectContext, editor: string): ModuleEditorAvailability {
    // 判据与文案都来自注册源/同一纯函数：`VB_SKIP_MODULES=1` 不能落成"需要信任工作区"。
    const authorization = this.authorizationFor(project);
    if (authorization !== "trusted") {
      const unavailable = moduleUnavailableAuthorization(authorization, project.rootUri.scheme);
      return { kind: "unavailable", ...unavailable };
    }

    const set = this.byProject.get(project.markerUri.toString());
    if (set === undefined) {
      return {
        kind: "unavailable",
        reason: "stale",
        message: "模块状态尚未就绪，已回退为只读视图。",
      };
    }

    const owner = set.editorOwners.get(editor);
    if (owner === undefined) {
      return {
        kind: "unavailable",
        reason: "undeclared",
        message: `工程未声明提供编辑器 '${editor}' 的模块，已回退为只读视图。`,
      };
    }

    switch (owner.status) {
      case "loaded":
        return { kind: "available", moduleId: owner.id };
      case "untrusted":
        return {
          kind: "unavailable",
          reason: "untrusted",
          message: "需要信任工作区才能加载模块。",
          moduleId: owner.id,
        };
      case "failed":
        return {
          kind: "unavailable",
          reason: "failed",
          message: `模块 '${owner.id}' 加载失败，已回退为只读视图。`,
          moduleId: owner.id,
        };
      case "disabled":
        return {
          kind: "unavailable",
          reason: "disabled",
          message: `模块 '${owner.id}' 已停用，已回退为只读视图。`,
          moduleId: owner.id,
        };
      case "stale":
        return {
          kind: "unavailable",
          reason: "stale",
          message: `模块 '${owner.id}' 正在重新装载，已回退为只读视图。`,
          moduleId: owner.id,
        };
    }
  }

  public get trusted(): boolean {
    return this.resolveTrust();
  }

  public get testState(): HostModuleRegistryTestState {
    return {
      trusted: this.resolveTrust(),
      activationCount: this.activationCountValue,
      evaluatedModuleIds: [...this.source.evaluatedModuleIds ?? []],
      projects: this.projects.projects.map((project) => {
        const modules = this.modulesFor(project);
        return {
          projectId: project.definition.projectId,
          markerUri: project.markerUri.toString(),
          modules: modules.map((module) => ({
            id: module.id,
            index: module.index,
            status: module.status,
            hash: module.declaredHash,
            loadedHash: module.bundle?.hash,
            webviewDirectory: firstWebviewDirectory(module),
            editors: editorsOf(module),
            diagnostics: module.diagnostics,
          })),
        };
      }),
      reloadNotices: [...this.reloadNotices],
      disposedModuleEntries: this.source.testCounters?.().disposedEntries ?? 0,
      disposedProjectKeys: [...this.source.testCounters?.().disposedProjectKeys ?? []],
    };
  }

  /**
   * 重读已装载模块的字节，把实际 hash 变化的模块标成 `stale`，返回受影响的模块 id。
   *
   * 不求值新 bundle：宿主据此提示用户重载（`reloadAllProjects`），由用户决定何时切换。
   */
  public async refreshStale(): Promise<readonly string[]> {
    if (this.disposed) return [];
    const stale: string[] = [];
    for (const project of this.projects.projects) {
      if (!this.isAuthorized(project)) continue;
      const affected = await this.source.refreshStale?.(project) ?? [];
      if (affected.length === 0) continue;
      stale.push(...affected);
      const set = this.byProject.get(project.markerUri.toString());
      if (set === undefined) continue;
      const byId = new Map(this.source.modules(project).map((module) => [module.id, module]));
      this.byProject.set(project.markerUri.toString(), {
        ...set,
        modules: set.modules.map((module) => {
          const refreshed = byId.get(module.id);
          return refreshed === undefined ? module : { ...module, status: refreshed.status, diagnostics: refreshed.diagnostics };
        }),
      });
    }
    if (stale.length > 0) this.changeEmitter.fire();
    return stale;
  }

  /** 仅测试用：模拟 Workspace Trust 授予，走与 `onDidGrantWorkspaceTrust` 相同的重载路径。 */
  public async setTrustOverrideForTest(value: boolean | undefined): Promise<void> {
    this.trustOverride = value;
    await this.reloadAllProjects("trustOverride", true);
  }

  /** 仅测试用：让某个模块的 `activate` 抛错（验证失败隔离），传 undefined 清除。 */
  public async setActivationFailureForTest(moduleId: string | undefined): Promise<void> {
    this.activationFailures.clear();
    if (moduleId !== undefined) this.activationFailures.add(moduleId);
    await this.reloadAllProjects("activationFailure", true);
  }

  /**
   * 仅测试用：只改 Trust 状态、不主动重载。
   *
   * 用来验证生产路径（`ensureProject` 的默认 `force=false`）真的会在授权漂移时释放旧 loader
   * 并注销 facet——`setTrustOverrideForTest` 会强制 `force=true`，覆盖不到那条短路。
   */
  public setTrustOverrideWithoutReloadForTest(value: boolean | undefined): void {
    this.trustOverride = value;
  }

  /** 仅测试用：按 marker key 释放某个 Project 的模块与 facet（模拟关闭该工程）。 */
  public disposeProjectModulesForTest(markerKey: string): boolean {
    const existed = this.byProject.delete(markerKey);
    this.source.disposeProject(markerKey);
    if (existed) this.changeEmitter.fire();
    return existed;
  }

  /**
   * 仅测试用：授予 Trust 并直接调用 `onDidGrantWorkspaceTrust` 的事件处理器。
   *
   * 只覆盖 Trust 来源（VS Code 没有在测试内真正 grant 的公开 API），重载路径与真实事件
   * 完全相同：`initialize` 订阅的就是 `handleGrantedTrust`。
   */
  public async simulateGrantedTrustForTest(): Promise<void> {
    this.trustOverride = true;
    await this.handleGrantedTrust();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    // 模块注册与 bundle 求值都由注册源持有；这里只负责停止观察。
    this.source.dispose();
    this.byProject.clear();
    this.changeEmitter.dispose();
  }

  private async handleGrantedTrust(): Promise<void> {
    // 真实 Trust 事件与测试覆盖共用同一条重载路径：授予信任后无需重载窗口。
    await this.reloadAllProjects("workspaceTrustGranted", true);
  }

  private async syncProjects(reason: string): Promise<void> {
    if (this.disposed) return;
    const activeProjects = new Map(this.projects.projects.map((project) => [project.markerUri.toString(), project]));

    for (const [markerKey, set] of [...this.byProject]) {
      if (activeProjects.has(markerKey)) continue;
      this.source.disposeProject(markerKey);
      this.byProject.delete(markerKey);
      this.projects.setModuleDiagnostics(set.markerUri, []);
      this.output.appendLine(`[modules] Project '${set.projectId}' closed; module registrations disposed.`);
      this.changeEmitter.fire();
    }

    const reloads: Promise<void>[] = [];
    for (const project of activeProjects.values()) {
      const existing = this.byProject.get(project.markerUri.toString());
      if (existing !== undefined && existing.definitionKey === moduleDefinitionKey(project.definition)) {
        continue;
      }
      reloads.push(this.reloadProject(project, reason));
    }
    await Promise.all(reloads);
  }

  /**
   * 重新装载全部 Project 的模块（模块文件变化、信任授予等宿主级事件）。
   *
   * `force` 必须由"用户确认重载 / Trust 授予"这类路径传 true：注册源在模块定义未变时会
   * 复用旧 loader（`definitionKey` 短路），不强制丢弃就等于什么也没重载——`stale` 仍是
   * `stale`，`editorAvailability` 反而降级。
   */
  public async reloadAllProjects(reason: string, force = false): Promise<void> {
    await Promise.all([...this.projects.projects].map((project) => this.reloadProject(project, reason, force)));
  }

  private reloadProject(project: ProjectContext, reason: string, force = false): Promise<void> {
    const markerKey = project.markerUri.toString();
    const previous = this.pending.get(markerKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.loadProject(project, reason, force));
    this.pending.set(markerKey, current);
    return current.finally(() => {
      if (this.pending.get(markerKey) === current) this.pending.delete(markerKey);
    });
  }

  private async loadProject(project: ProjectContext, reason: string, force = false): Promise<void> {
    if (this.disposed) return;
    const markerKey = project.markerUri.toString();
    const previous = this.byProject.get(markerKey);
    const definitionKey = moduleDefinitionKey(project.definition);

    // 定义变了：先把旧注册标记 stale 并发事件，避免 UI 停在 loaded（P1：状态变化要驱动重建）。
    if (previous !== undefined && previous.definitionKey !== definitionKey
      && previous.modules.some((module) => module.status === "loaded")) {
      this.byProject.set(markerKey, {
        ...previous,
        modules: previous.modules.map((module) => (
          module.status === "loaded" ? { ...module, status: "stale" } : module
        )),
      });
      this.changeEmitter.fire();
    }

    // 未受信任或 VB_SKIP_MODULES=1 时注册源不会求值任何 bundle，这里也不会向它要 manifest。
    // 授权判据由注册源给出（与 `prepare` 内部同一个函数）：Trusted 且本地 file scheme。
    const authorization = this.source.authorizationFor(project);
    let loaderModules: readonly HostLoadedModule[] = [];
    let prepareFailure: string | undefined;
    try {
      loaderModules = await this.prepareModules(project, force);
    } catch (errorValue) {
      // 单个 Project 的装载失败（例如 webview 解包目录不可写）不得打挂 activate：
      // 只让该 Project 的模块落到 failed，其余 Project 与编辑器照常工作。
      prepareFailure = errorValue instanceof Error ? errorValue.message : String(errorValue);
      this.output.appendLine(
        `[modules] Project '${project.definition.projectId}' module preparation failed: ${prepareFailure}`,
      );
      this.source.disposeProject(markerKey);
      loaderModules = [];
    }

    const modules: HostModuleState[] = project.definition.modules.map((declared, index) => {
      const loaded = loaderModules[index];
      if (authorization !== "trusted") {
        const disabled = authorization === "skipped";
        return {
          id: declared.id,
          index,
          entry: declared.entry,
          status: disabled ? "disabled" : "untrusted",
          declaredHash: declared.hash,
          manifest: undefined,
          registration: undefined,
          bundle: undefined,
          diagnostics: [createDiagnostic(
            disabled ? "module.disabled" : "module.untrusted",
            "warning",
            disabled
              ? "VB_SKIP_MODULES=1：本进程跳过模块装载。"
              : project.rootUri.scheme === "file"
                ? "需要信任工作区才能加载模块。"
                : `Project Root 不是本地 file scheme（当前 '${project.rootUri.scheme}'），模块不会装载。`,
            modulePath(index),
          )],
        };
      }
      if (prepareFailure !== undefined) {
        return {
          id: declared.id,
          index,
          entry: declared.entry,
          status: "failed",
          declaredHash: declared.hash,
          manifest: undefined,
          registration: undefined,
          bundle: undefined,
          diagnostics: [createDiagnostic(
            "module.loadFailed",
            "error",
            `模块装载失败：${prepareFailure}。该编辑器回退只读，其余编辑器不受影响。`,
            modulePath(index),
          )],
        };
      }
      if (loaded === undefined) {
        return {
          id: declared.id,
          index,
          entry: declared.entry,
          status: "failed",
          declaredHash: declared.hash,
          manifest: undefined,
          registration: undefined,
          bundle: undefined,
          diagnostics: [createDiagnostic(
            "module.loadFailed",
            "error",
            `Module '${declared.id}' was not processed by the loader.`,
            modulePath(index),
          )],
        };
      }
      if (loaded.status === "loaded" && this.activationFailures.has(loaded.id)) {
        this.activationCountValue += 1;
        this.source.rejectModule?.(markerKey, loaded.id);
        return {
          id: loaded.id,
          index,
          entry: loaded.entry,
          status: "failed",
          declaredHash: loaded.declaredHash,
          manifest: loaded.manifest,
          registration: undefined,
          bundle: undefined,
          diagnostics: [createDiagnostic(
            "module.activateFailed",
            "error",
            `Module '${loaded.id}' failed to activate: Injected module activation failure (test hook).`,
            modulePath(index),
          )],
        };
      }
      if (loaded.status === "loaded") this.activationCountValue += 1;
      return {
        id: loaded.id,
        index,
        entry: loaded.entry,
        status: loaded.status,
        declaredHash: loaded.declaredHash,
        manifest: loaded.manifest,
        registration: loaded.registration,
        bundle: loaded.bundle,
        diagnostics: [...loaded.diagnostics],
      };
    });

    // 同一 editor 由多个模块声明属于配置冲突，loader 已把后面的模块判为 disabled 并给出诊断，
    // 这里的 `editorOwners` 只按状态优先级挑出真正可用的那一个。
    const claimedEditors = new Map<string, string>();
    for (const module of modules) {
      if (module.status !== "loaded" || module.registration === undefined) continue;
      for (const editor of module.registration.editors) claimedEditors.set(editor.editor, module.id);
    }

    // editor 归属按状态优先级：已加载模块优先于 failed/disabled/untrusted 的同名声明，
    // 否则先声明的失败模块会遮蔽后面真正可用的模块。
    const editorOwners = new Map<string, HostModuleState>();
    for (const loadedPass of [true, false]) {
      for (const module of modules) {
        if ((module.status === "loaded") !== loadedPass) continue;
        for (const editor of editorsOf(module)) {
          if (!editorOwners.has(editor)) editorOwners.set(editor, module);
        }
      }
    }

    // 第二段校验（附录 D.1）：documentTypes[].editor 必须由一个已加载模块提供。
    // 只有"根本没有模块声明该 editor"才在这里报；模块存在但 failed/disabled/untrusted
    // 时已由该模块自己的诊断说明，避免同一故障重复计入 Problems。
    // 未受信任时不做这段：那时没有任何 manifest，无法区分"未声明"和"声明了但没装载"。
    const documentDiagnostics: ModuleEdgeDiagnostic[] = [];
    if (authorization === "trusted") {
      for (const [index, documentType] of project.definition.documentTypes.entries()) {
        if (claimedEditors.has(documentType.editor) || editorOwners.has(documentType.editor)) continue;
        documentDiagnostics.push({
          index,
          diagnostic: createDiagnostic(
            "module.notFound",
            "warning",
            `No declared module provides editor '${documentType.editor}'.`,
            documentTypeEditorPath(index),
          ),
        });
      }
    }

    // 旧 loader 的注册由注册源在 `prepare` 里连同 loader 一起释放，这里不再重复 dispose。

    const set: ProjectModuleSet = {
      markerKey,
      markerUri: project.markerUri,
      projectId: project.definition.projectId,
      definitionKey,
      authorized: authorization === "trusted",
      modules,
      editorOwners,
      documentDiagnostics,
    };
    this.byProject.set(markerKey, set);
    await this.publishDiagnostics(set);
    this.notifyReloadedModules(previous, set);

    const summary = modules.map((module) => `${module.id}=${module.status}`).join(", ");
    this.output.appendLine(`[modules] ${project.definition.projectId}: ${summary || "no declared modules"} (${reason}).`);
    this.changeEmitter.fire();
  }

  /**
   * 重载后模块 bundle 版本变了的那些 editor，给用户一条可操作的可见提示。
   *
   * 已打开的面板仍持旧 facet/旧 controller，而宿主不会重建会话（`documentEditorProvider` 对
   * `stale` 只重开只读壳），所以必须明确告诉用户"重新打开文档才会用新版本"。
   * 旧 `<hash>` 目录在本次会话内保留（清理只在激活时做），所以旧面板不会 404。
   */
  private notifyReloadedModules(previous: ProjectModuleSet | undefined, next: ProjectModuleSet): void {
    if (previous === undefined || this.disposed) return;
    const previousHashes = new Map(
      previous.modules.map((module) => [module.id, module.bundle?.hash] as const),
    );
    const reloadedEditors = new Set<string>();
    for (const module of next.modules) {
      const before = previousHashes.get(module.id);
      const after = module.bundle?.hash;
      if (before === undefined || after === undefined || before === after) continue;
      for (const editor of editorsOf(module)) reloadedEditors.add(editor);
    }
    if (reloadedEditors.size === 0) return;
    const message = `模块已更新（${[...reloadedEditors].sort().join(", ")}），请重新打开该文档以使用新版本。`;
    this.reloadNotices.push(message);
    if (this.reloadNotices.length > 20) this.reloadNotices.shift();
    this.output.appendLine(`[modules] ${message}`);
    void vscode.window.showInformationMessage(message);
  }

  private async publishDiagnostics(set: ProjectModuleSet): Promise<void> {
    if (this.disposed) return;
    const project = this.projects.projects.find((candidate) => candidate.markerUri.toString() === set.markerKey);
    if (project === undefined) return;
    const needsText = set.modules.some((module) => module.diagnostics.length > 0)
      || set.documentDiagnostics.length > 0;
    const text = needsText ? await readProjectText(project.markerUri) : undefined;
    const items: vscode.Diagnostic[] = [];

    for (const module of set.modules) {
      for (const diagnostic of module.diagnostics) {
        items.push(createVsCodeDiagnostic(
          locateArrayElement(text, "modules", module.index),
          diagnostic,
        ));
      }
    }
    for (const entry of set.documentDiagnostics) {
      items.push(createVsCodeDiagnostic(
        locateArrayElement(text, "documentTypes", entry.index),
        entry.diagnostic,
      ));
    }
    this.projects.setModuleDiagnostics(project.markerUri, items);
  }

  private async prepareModules(project: ProjectContext, force = false): Promise<readonly HostLoadedModule[]> {
    // 授权判断交给注册源：未受信任时它会释放该 Project 的 loader 并立即返回。
    await this.source.prepare(project, force);
    return this.source.modules(project);
  }

  private isAuthorized(project: ProjectContext): boolean {
    // 与 `prepare` 用的是同一个判据（Trusted 且本地 file scheme），不在这里重写一遍。
    return this.source.authorizationFor(project) === "trusted";
  }

  private resolveTrust(): boolean {
    return this.trustOverride ?? this.isWorkspaceTrusted();
  }
}

function moduleDefinitionKey(definition: VisualBridgeProjectDefinition): string {
  // `documentTypes[].editor` 参与第二段诊断与 editor 归属，改它也会让旧诊断过期，必须进 key。
  return JSON.stringify({
    modules: definition.modules,
    documentTypes: definition.documentTypes.map((documentType) => ({
      id: documentType.id,
      editor: documentType.editor,
    })),
  });
}

function modulePath(index: number): string {
  return `modules[${index}]`;
}

function documentTypeEditorPath(index: number): string {
  return `documentTypes[${index}].editor`;
}

function editorsOf(module: HostModuleState): readonly string[] {
  if (module.registration !== undefined) {
    return module.registration.editors.map((editor) => editor.editor);
  }
  return module.manifest?.editors ?? [];
}

/** 该模块的解包目录（取第一个 webview 资产的 resource root）；无 bundle 时 undefined。 */
function firstWebviewDirectory(module: HostModuleState): string | undefined {
  const webviews = module.bundle?.webviews;
  if (webviews === undefined) return undefined;
  for (const asset of Object.values(webviews)) return asset.resourceRoot.fsPath;
  return undefined;
}

function createDiagnostic(
  code: ModuleDiagnostic["code"],
  severity: ModuleDiagnostic["severity"],
  message: string,
  path: string,
): ModuleDiagnostic {
  return { code, severity, message, path };
}

function createVsCodeDiagnostic(
  location: JsonLocation | undefined,
  diagnostic: ModuleDiagnostic,
): vscode.Diagnostic {
  const range = location === undefined
    ? new vscode.Range(0, 0, 0, 1)
    : new vscode.Range(location.line, location.character, location.endLine, location.endCharacter);
  const item = new vscode.Diagnostic(
    range,
    `${diagnostic.path}: ${diagnostic.message}`,
    diagnostic.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
  );
  item.code = diagnostic.code;
  item.source = "VisualBridge Modules";
  return item;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

interface JsonLocation {
  readonly line: number;
  readonly character: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

async function readProjectText(markerUri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(markerUri));
  } catch {
    return undefined;
  }
}

/** 把 `modules[i]`（或 `documentTypes[i]`）定位到 Project File 里的具体行，供 Problems 跳转。 */
function locateArrayElement(
  text: string | undefined,
  key: string,
  index: number,
): JsonLocation | undefined {
  if (text === undefined) return undefined;
  const valueStart = topLevelPropertyOffset(text, key);
  if (valueStart === undefined || text.charAt(valueStart) !== "[") return undefined;
  let cursor = skipTrivia(text, valueStart + 1);
  for (let current = 0; ; current += 1) {
    if (text.charAt(cursor) === "]" || cursor >= text.length) return undefined;
    const elementStart = cursor;
    const elementEnd = skipValue(text, cursor);
    if (elementEnd <= elementStart) return undefined;
    if (current === index) return toLocation(text, elementStart, elementEnd);
    cursor = skipTrivia(text, elementEnd);
    if (text.charAt(cursor) !== ",") return undefined;
    cursor = skipTrivia(text, cursor + 1);
  }
}

function toLocation(text: string, start: number, end: number): JsonLocation {
  const startPosition = offsetToPosition(text, start);
  const endPosition = offsetToPosition(text, end);
  return {
    line: startPosition.line,
    character: startPosition.character,
    endLine: endPosition.line,
    endCharacter: endPosition.character,
  };
}

function offsetToPosition(text: string, offset: number): { readonly line: number; readonly character: number } {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function skipTrivia(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function skipString(text: string, from: number): number {
  let index = from + 1;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\"") return index + 1;
    index += 1;
  }
  return text.length;
}

function skipValue(text: string, from: number): number {
  const first = text.charAt(from);
  if (first === "\"") return skipString(text, from);
  if (first === "{" || first === "[") {
    let depth = 0;
    let index = from;
    while (index < text.length) {
      const character = text.charAt(index);
      if (character === "\"") {
        index = skipString(text, index);
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return text.length;
  }
  // number / true / false / null：读到分隔符为止。
  let index = from;
  while (index < text.length && !",}] \t\r\n".includes(text.charAt(index))) index += 1;
  return index;
}

function topLevelPropertyOffset(text: string, key: string): number | undefined {
  let cursor = skipTrivia(text, 0);
  if (text.charAt(cursor) !== "{") return undefined;
  cursor = skipTrivia(text, cursor + 1);
  while (cursor < text.length) {
    if (text.charAt(cursor) === "}") return undefined;
    if (text.charAt(cursor) !== "\"") return undefined;
    const keyEnd = skipString(text, cursor);
    let name: string;
    try {
      name = JSON.parse(text.slice(cursor, keyEnd)) as string;
    } catch {
      return undefined;
    }
    cursor = skipTrivia(text, keyEnd);
    if (text.charAt(cursor) !== ":") return undefined;
    const valueStart = skipTrivia(text, cursor + 1);
    if (name === key) return valueStart;
    cursor = skipTrivia(text, skipValue(text, valueStart));
    if (text.charAt(cursor) !== ",") return undefined;
    cursor = skipTrivia(text, cursor + 1);
  }
  return undefined;
}
