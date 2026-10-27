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
  HostModuleRegistration,
  ModuleDiagnostic,
  ModuleEdgeDiagnostic,
  ModuleEditorAvailability,
  ModuleManifestView,
  ModuleRegistrationSource,
  ModuleStatus,
} from "./moduleRegistration";

/** 单个模块在一个 Project 内的状态快照。 */
export interface HostModuleState {
  readonly id: string;
  readonly index: number;
  readonly entry: string;
  readonly status: ModuleStatus;
  readonly declaredHash: string | undefined;
  readonly manifest: ModuleManifestView | undefined;
  readonly registration: HostModuleRegistration | undefined;
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
      readonly editors: readonly string[];
      readonly diagnostics: readonly ModuleDiagnostic[];
    }[];
  }[];
}

interface ProjectModuleSet {
  readonly markerKey: string;
  readonly markerUri: vscode.Uri;
  readonly projectId: string;
  readonly definitionKey: string;
  readonly modules: readonly HostModuleState[];
  /** editor id → 首个声明它的模块（含 failed/untrusted/disabled）。 */
  readonly editorOwners: ReadonlyMap<string, HostModuleState>;
  readonly documentDiagnostics: readonly ModuleEdgeDiagnostic[];
}

interface ModuleDraft {
  readonly id: string;
  readonly index: number;
  readonly entry: string;
  status: ModuleStatus;
  readonly declaredHash: string | undefined;
  manifest: ModuleManifestView | undefined;
  registration: HostModuleRegistration | undefined;
  readonly diagnostics: ModuleDiagnostic[];
}

export class HostModuleRegistry implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly byProject = new Map<string, ProjectModuleSet>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly activationFailures = new Set<string>();
  private activationCountValue = 0;
  private trustOverride: boolean | undefined;
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
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.handleGrantedTrust().catch((errorValue: unknown) => {
          this.output.appendLine(`[modules] Trust reload failed: ${formatError(errorValue)}`);
        });
      }),
    );
    await this.syncProjects("initialize");
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
    if (existing === undefined || existing.definitionKey !== moduleDefinitionKey(project.definition)) {
      await this.reloadProject(project, "ensureProject");
    }
  }

  public modulesFor(project: ProjectContext): readonly HostModuleState[] {
    return this.byProject.get(project.markerUri.toString())?.modules ?? [];
  }

  /**
   * 某个 editor 在当前 Project 内的可用性。
   *
   * 状态未知（尚未装载）返回 `stale`：调用方应先 `ensureProject`，这里保留兜底。
   */
  public editorAvailability(project: ProjectContext, editor: string): ModuleEditorAvailability {
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
            editors: editorsOf(module),
            diagnostics: module.diagnostics,
          })),
        };
      }),
    };
  }

  /** 仅测试用：模拟 Workspace Trust 授予，走与 `onDidGrantWorkspaceTrust` 相同的重载路径。 */
  public async setTrustOverrideForTest(value: boolean | undefined): Promise<void> {
    this.trustOverride = value;
    await this.reloadAllProjects("trustOverride");
  }

  /** 仅测试用：让某个模块的 `activate` 抛错（验证失败隔离），传 undefined 清除。 */
  public async setActivationFailureForTest(moduleId: string | undefined): Promise<void> {
    this.activationFailures.clear();
    if (moduleId !== undefined) this.activationFailures.add(moduleId);
    await this.reloadAllProjects("activationFailure");
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
    for (const set of this.byProject.values()) {
      for (const module of set.modules) disposeRegistration(module.registration);
    }
    this.byProject.clear();
    this.changeEmitter.dispose();
  }

  private async handleGrantedTrust(): Promise<void> {
    // 真实 Trust 事件与测试覆盖共用同一条重载路径：授予信任后无需重载窗口。
    await this.reloadAllProjects("workspaceTrustGranted");
  }

  private async syncProjects(reason: string): Promise<void> {
    if (this.disposed) return;
    const activeProjects = new Map(this.projects.projects.map((project) => [project.markerUri.toString(), project]));

    for (const [markerKey, set] of [...this.byProject]) {
      if (activeProjects.has(markerKey)) continue;
      for (const module of set.modules) disposeRegistration(module.registration);
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

  private async reloadAllProjects(reason: string): Promise<void> {
    await Promise.all([...this.projects.projects].map((project) => this.reloadProject(project, reason)));
  }

  private reloadProject(project: ProjectContext, reason: string): Promise<void> {
    const markerKey = project.markerUri.toString();
    const previous = this.pending.get(markerKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.loadProject(project, reason));
    this.pending.set(markerKey, current);
    return current.finally(() => {
      if (this.pending.get(markerKey) === current) this.pending.delete(markerKey);
    });
  }

  private async loadProject(project: ProjectContext, reason: string): Promise<void> {
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

    const authorized = this.isAuthorized(project);
    const drafts: ModuleDraft[] = project.definition.modules.map((module, index) => ({
      id: module.id,
      index,
      entry: module.entry,
      status: "failed",
      declaredHash: module.hash,
      manifest: undefined,
      registration: undefined,
      diagnostics: [],
    }));

    for (const draft of drafts) {
      const module = project.definition.modules[draft.index]!;
      if (!authorized) {
        draft.status = "untrusted";
        draft.manifest = this.source.manifest(module.id);
        draft.diagnostics.push(createDiagnostic(
          "module.untrusted",
          "warning",
          "需要信任工作区才能加载模块。",
          modulePath(draft.index),
        ));
        continue;
      }

      const manifest = this.source.manifest(module.id);
      if (!this.source.provides(module.id) || manifest === undefined) {
        draft.status = "failed";
        draft.diagnostics.push(createDiagnostic(
          "module.loadFailed",
          "error",
          `No in-process module registration is available for '${module.id}'.`,
          modulePath(draft.index),
        ));
        continue;
      }
      draft.manifest = manifest;

      if (manifest.id !== module.id) {
        draft.status = "failed";
        draft.diagnostics.push(createDiagnostic(
          "module.idMismatch",
          "error",
          `Module manifest id '${manifest.id}' does not match '${module.id}'.`,
          modulePath(draft.index),
        ));
        continue;
      }
      if (manifest.apiVersion !== MODULE_API_VERSION) {
        draft.status = "disabled";
        draft.diagnostics.push(createDiagnostic(
          "module.apiVersionMismatch",
          "error",
          `Module apiVersion ${manifest.apiVersion} is not supported (expected ${MODULE_API_VERSION}).`,
          modulePath(draft.index),
        ));
        continue;
      }

      this.activationCountValue += 1;
      try {
        if (this.activationFailures.has(module.id)) {
          throw new Error("Injected module activation failure (test hook).");
        }
        // 授权通过后才执行模块代码。
        draft.registration = await this.source.activate(module.id);
      } catch (errorValue) {
        draft.status = "failed";
        draft.diagnostics.push(createDiagnostic(
          "module.activateFailed",
          "error",
          `Module '${module.id}' failed to activate: ${formatError(errorValue)}`,
          modulePath(draft.index),
        ));
        continue;
      }

      const invalid = validateRegistration(draft.registration);
      if (invalid !== undefined) {
        draft.status = "failed";
        draft.diagnostics.push(createDiagnostic(
          "module.registrationInvalid",
          "error",
          `Module '${module.id}' returned an invalid registration: ${invalid}`,
          modulePath(draft.index),
        ));
        disposeRegistration(draft.registration);
        draft.registration = undefined;
        continue;
      }

      const optionsIssues = await validateOptions(draft.registration, module.options);
      if (optionsIssues !== undefined) {
        draft.status = "failed";
        draft.diagnostics.push(createDiagnostic(
          "module.optionsInvalid",
          "error",
          `Module '${module.id}' rejected modules[${draft.index}].options: ${optionsIssues}`,
          `${modulePath(draft.index)}.options`,
        ));
        disposeRegistration(draft.registration);
        draft.registration = undefined;
        continue;
      }

      draft.status = "loaded";
    }

    // 同一 editor 被多个已加载模块声明：按 modules 顺序保留第一个，其余停用（附录 D.1）。
    const claimedEditors = new Map<string, string>();
    for (const draft of drafts) {
      if (draft.status !== "loaded" || draft.registration === undefined) continue;
      const conflict = draft.registration.editors.find((editor) => claimedEditors.has(editor.editor));
      if (conflict !== undefined) {
        draft.status = "disabled";
        draft.diagnostics.push(createDiagnostic(
          "module.editorConflict",
          "error",
          `Editor '${conflict.editor}' is already provided by module '${claimedEditors.get(conflict.editor)}'.`,
          modulePath(draft.index),
        ));
        disposeRegistration(draft.registration);
        draft.registration = undefined;
        continue;
      }
      for (const editor of draft.registration.editors) claimedEditors.set(editor.editor, draft.id);
    }

    const modules: HostModuleState[] = drafts.map((draft) => ({
      id: draft.id,
      index: draft.index,
      entry: draft.entry,
      status: draft.status,
      declaredHash: draft.declaredHash,
      manifest: draft.manifest,
      registration: draft.registration,
      diagnostics: draft.diagnostics,
    }));

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
    const documentDiagnostics: ModuleEdgeDiagnostic[] = [];
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

    // 新注册已就绪，替换旧注册前先释放旧模块。
    if (previous !== undefined) {
      for (const module of previous.modules) disposeRegistration(module.registration);
    }

    const set: ProjectModuleSet = {
      markerKey,
      markerUri: project.markerUri,
      projectId: project.definition.projectId,
      definitionKey,
      modules,
      editorOwners,
      documentDiagnostics,
    };
    this.byProject.set(markerKey, set);
    await this.publishDiagnostics(set);

    const summary = modules.map((module) => `${module.id}=${module.status}`).join(", ");
    this.output.appendLine(`[modules] ${project.definition.projectId}: ${summary || "no declared modules"} (${reason}).`);
    this.changeEmitter.fire();
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

  private isAuthorized(project: ProjectContext): boolean {
    return this.resolveTrust() && project.rootUri.scheme === "file";
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

function validateRegistration(registration: HostModuleRegistration): string | undefined {
  if (typeof registration !== "object" || registration === null) return "registration must be an object.";
  if (!Array.isArray(registration.editors) || registration.editors.length === 0) {
    return "registration.editors must be a non-empty array.";
  }
  const seen = new Set<string>();
  for (const editor of registration.editors) {
    if (typeof editor !== "object" || editor === null || typeof editor.editor !== "string" || editor.editor.length === 0) {
      return "every editor registration needs a non-empty editor id.";
    }
    if (seen.has(editor.editor)) return `editor '${editor.editor}' is registered twice.`;
    seen.add(editor.editor);
  }
  return undefined;
}

async function validateOptions(
  registration: HostModuleRegistration,
  options: Readonly<Record<string, JsonValue>> | undefined,
): Promise<string | undefined> {
  if (typeof registration.validateOptions !== "function") return undefined;
  try {
    const issues = registration.validateOptions(options);
    return issues.length === 0 ? undefined : issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  } catch (errorValue) {
    return formatError(errorValue);
  }
}

function disposeRegistration(registration: HostModuleRegistration | undefined): void {
  if (registration === undefined || typeof registration.dispose !== "function") return;
  try {
    registration.dispose();
  } catch {
    // dispose 失败不应阻断注册表替换；宿主只在 Output 里看到状态。
  }
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
