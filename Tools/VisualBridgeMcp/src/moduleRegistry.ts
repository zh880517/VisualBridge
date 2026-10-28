/**
 * MCP 宿主侧的模块登记（附录 D.1/D.3）。
 *
 * C2 起装载与求值只有一个实现：`@visualbridge/node-host` 的 `ModuleLoader`。
 * 本文件不再 import 任何领域包，因此 MCP 进程里也没有 `@visualbridge/entity|graph|structured|table`
 * 的静态代码；模块 facet 全部来自 `.vbmodule.js` 的 `activate(host)`。
 *
 * 保留的宿主专属前置校验（`verifyModuleEntry`）：MCP 的模块 entry 必须落在
 * `VISUALBRIDGE_WORKSPACE` 内（拒绝 junction/symlink 逃逸）。这项边界检查 loader 不做，
 * 因此先按它过滤，只把通过校验的模块交给 loader 求值 —— 未通过校验的模块代码永不执行。
 */
import type {
  CatalogFacet,
  CatalogWithSource,
  DocumentDiagnostic,
  DocumentFacet,
  DocumentFacetSourceFile,
  JsonValue,
  McpFacet,
  OwnedStableIdentity,
  ProjectModuleDefinition,
} from "@visualbridge/core";
import { ModuleLoader } from "@visualbridge/node-host";
import type { ModuleRegistration } from "@visualbridge/module-sdk";
import {
  readModulesEnabled,
  verifyModuleEntry,
  type ModuleEntryReport,
  type ModuleStatus,
} from "./moduleAuthorization.js";
import { VisualBridgeMcpError, type ProjectContext } from "./projectWorkspace.js";

/**
 * 模块 `create` facet 的 MCP 侧结构（附录 D.3 `create`）。
 *
 * MCP 只需要"产出初始源文件字节 + 稳定身份"，不需要 Quick Pick；形状与 SDK 的
 * `CreateFacet.createDocument` 一致，因此直接沿用注册面里的那个对象。
 */
export interface McpCreateFacetInput {
  readonly projectId: string;
  readonly projectDefinition: JsonValue;
  readonly documentType: {
    readonly id: string;
    readonly editor: string;
    readonly catalogs: readonly string[];
  };
  readonly catalog: {
    readonly ready: boolean;
    readonly registry: unknown;
    readonly diagnostics: readonly DocumentDiagnostic[];
  };
  readonly newStableId: (prefix: string) => string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly targetPath: string;
}

export interface McpCreateFacet {
  createDocument(input: McpCreateFacetInput): Promise<
    | {
        readonly success: true;
        readonly sources: readonly DocumentFacetSourceFile[];
        readonly ownedIdentities: readonly OwnedStableIdentity[];
      }
    | { readonly success: false; readonly message: string }
  >;
}

/** 一个 editor 的可用注册面（来自已装载模块的 `EditorRegistration`）。 */
export interface McpEditorRegistration {
  readonly editor: string;
  readonly facet: DocumentFacet<unknown, unknown>;
  readonly catalog: CatalogFacet<never, unknown>;
  readonly mcp: McpFacet<unknown, unknown>;
  readonly create: McpCreateFacet | undefined;
  readonly operationSchema: JsonValue | undefined;
}

/** 一个已装载模块的注册信息；`version` 来自模块 manifest。 */
export interface McpModuleRegistration {
  readonly id: string;
  readonly version: string;
  readonly editor: string;
  readonly editors: readonly McpEditorRegistration[];
  readonly facet: DocumentFacet<unknown, unknown>;
  readonly catalog: CatalogFacet<never, unknown>;
  readonly mcp: McpFacet<unknown, unknown>;
  /** 模块可以不提供 `create` facet（只读 editor）；`null` 消费者必须显式处理。 */
  readonly create: McpCreateFacet | undefined;
  readonly operationSchema: JsonValue | undefined;
}

/** 一个 Project 生效的模块（登记 + Project File 声明的 options）。 */
export interface ActiveModule extends McpModuleRegistration {
  readonly options: JsonValue | undefined;
}

/** 一个 Project 的模块装载结果；`reports` 与 Project File 的 `modules[]` 顺序一致。 */
export interface ProjectModuleSet {
  readonly enabled: boolean;
  readonly reports: readonly ModuleEntryReport[];
  readonly active: readonly ActiveModule[];
}

interface LoadedProject {
  readonly definitionKey: string;
  readonly set: ProjectModuleSet;
  readonly registrations: readonly McpModuleRegistration[];
  readonly loader: ModuleLoader<ModuleRegistration> | undefined;
}

export class McpModuleRegistry {
  private readonly loaded = new Map<string, Promise<LoadedProject>>();
  private readonly latest = new Map<string, LoadedProject>();
  private readonly diagnosticsChannel: (message: string) => void;

  public constructor(
    public readonly enabled: boolean,
    private readonly workspaceRoot: string,
    diagnostics: (message: string) => void = () => undefined,
  ) {
    this.diagnosticsChannel = diagnostics;
  }

  public static fromEnvironment(
    environment: NodeJS.ProcessEnv,
    workspaceRoot: string,
    diagnostics?: (message: string) => void,
  ): McpModuleRegistry {
    return new McpModuleRegistry(readModulesEnabled(environment), workspaceRoot, diagnostics);
  }

  /** 已装载过的模块注册面（按 id 去重，供 `visualbridge_project` 报 `operationSchema`）。 */
  public registrations(): readonly McpModuleRegistration[] {
    const byId = new Map<string, McpModuleRegistration>();
    for (const project of this.latest.values()) {
      for (const registration of project.registrations) byId.set(registration.id, registration);
    }
    return [...byId.values()];
  }

  /** 装载一个 Project 声明的全部模块；未启用模块平台时只产出 `disabled` 报告。 */
  public async modulesFor(project: ProjectContext): Promise<ProjectModuleSet> {
    const definitionKey = JSON.stringify(project.definition.modules);
    const key = project.projectFile;
    const cached = await this.loaded.get(key);
    if (cached !== undefined && cached.definitionKey === definitionKey) return cached.set;
    if (!this.enabled) return this.disabledSet(project);

    const loading = this.loadProject(project, definitionKey);
    this.loaded.set(key, loading);
    try {
      const result = await loading;
      this.latest.set(key, result);
      return result.set;
    } catch (errorValue) {
      this.loaded.delete(key);
      throw errorValue;
    }
  }

  /**
   * 取该 Project 下某个 editor 的生效模块；不可用时抛出 `document.editorUnsupported`。
   *
   * 失败原因放在 `details.reason`，与 `visualbridge_project` 的模块状态一一对应。
   */
  public async requireModule(project: ProjectContext, editor: string): Promise<ActiveModule> {
    const modules = await this.modulesFor(project);
    if (!modules.enabled) {
      throw editorUnsupported(editor, "modulesDisabled", [], modules);
    }
    const active = modules.active.find((entry) => entry.editor === editor);
    if (active !== undefined) return active;
    // 未装载的模块没有 manifest，反查不到它声明了哪些 editor（C2 不再持有静态 editor 表）。
    // 因此只要还有不可用的模块，就把"该 editor 不可用"归因到这些模块的状态上；
    // 全部模块都装载成功时才判定为"没有模块声明这个 editor"。
    if (modules.reports.some((entry) => entry.status !== "loaded")) {
      throw editorUnsupported(
        editor,
        unusableReason(modules.reports),
        modules.active.map((entry) => entry.editor),
        modules,
      );
    }
    throw editorUnsupported(editor, "moduleNotDeclared", modules.active.map((entry) => entry.editor), modules);
  }

  /** 释放所有 Project 的 loader（MCP 进程退出时调用）。 */
  public dispose(): void {
    for (const project of this.latest.values()) project.loader?.dispose();
    this.latest.clear();
    this.loaded.clear();
  }

  private disabledSet(project: ProjectContext): ProjectModuleSet {
    return {
      enabled: false,
      reports: project.definition.modules.map((entry) => ({
        id: entry.id,
        entry: entry.entry,
        status: "disabled" as const,
        editors: [],
        diagnostics: [],
      })),
      active: [],
    };
  }

  private async loadProject(project: ProjectContext, definitionKey: string): Promise<LoadedProject> {
    /** 报告按 Project File 的 `modules[]` 顺序输出（MCP 工具的输出顺序被测试与文档固定）。 */
    const reports = new Map<string, ModuleEntryReport>();
    const evaluable: ProjectModuleDefinition[] = [];
    const verificationDiagnostics = new Map<string, readonly DocumentDiagnostic[]>();
    for (const declared of project.definition.modules) {
      const verification = await verifyModuleEntry(project, declared, this.workspaceRoot);
      verificationDiagnostics.set(declared.id, verification.diagnostics);
      if (verification.status === "loaded") {
        evaluable.push(declared);
        continue;
      }
      reports.set(declared.id, {
        id: declared.id,
        entry: declared.entry,
        status: verification.status,
        editors: [],
        diagnostics: verification.diagnostics,
      });
    }

    if (evaluable.length === 0) {
      return {
        definitionKey,
        set: { enabled: true, reports: ordered(project, reports), active: [] },
        registrations: [],
        loader: undefined,
      };
    }

    const loader = await ModuleLoader.create<ModuleRegistration>({
      projectRoot: project.projectRoot,
      projectId: project.definition.projectId,
      modules: evaluable,
      // 信任来自 `VISUALBRIDGE_MODULES_ENABLED`：未启用时上面已提前返回，不会求值任何 bundle。
      trusted: true,
      log: (entry) => {
        this.diagnosticsChannel(
          `[modules] ${entry.timestamp} ${entry.event}`
          + `${entry.moduleId === undefined ? "" : ` ${entry.moduleId}`}`
          + `${entry.message === undefined ? "" : `: ${entry.message}`}`,
        );
      },
    });

    const active: ActiveModule[] = [];
    const registrations: McpModuleRegistration[] = [];
    for (const declared of evaluable) {
      const module = loader.result.modules.find((candidate) => candidate.id === declared.id);
      if (module === undefined) {
        reports.set(declared.id, {
          id: declared.id,
          entry: declared.entry,
          status: "failed",
          editors: [],
          diagnostics: [{
            severity: "error",
            code: "module.loadFailed",
            path: `modules.${declared.id}`,
            message: `Module '${declared.id}' was not processed by the loader.`,
          }],
        });
        continue;
      }
      const editors = editorRegistrations(module.registration);
      const diagnostics = [
        ...verificationDiagnostics.get(declared.id) ?? [],
        ...module.diagnostics,
      ];
      reports.set(declared.id, {
        id: declared.id,
        entry: declared.entry,
        status: module.status,
        ...(module.manifest === undefined ? {} : { version: module.manifest.version }),
        ...(module.hash === undefined ? {} : { sha256: module.hash.replace(/^sha256:/u, "") }),
        editors: editors.map((editor) => editor.editor),
        diagnostics,
      });
      if (module.status !== "loaded" || editors.length === 0) continue;
      const registration: McpModuleRegistration = {
        id: declared.id,
        version: module.manifest?.version ?? "0.0.0",
        editor: editors[0]!.editor,
        editors,
        facet: editors[0]!.facet,
        catalog: editors[0]!.catalog,
        mcp: editors[0]!.mcp,
        create: editors[0]!.create,
        operationSchema: editors[0]!.operationSchema,
      };
      registrations.push(registration);
      active.push({ ...registration, options: declared.options as JsonValue | undefined });
    }
    return {
      definitionKey,
      set: { enabled: true, reports: ordered(project, reports), active },
      registrations,
      loader,
    };
  }
}

/** 按 Project File 的声明顺序输出报告：`modules[]` 缺失项直接跳过（装载器不会凭空产生）。 */
function ordered(
  project: ProjectContext,
  reports: ReadonlyMap<string, ModuleEntryReport>,
): readonly ModuleEntryReport[] {
  const result: ModuleEntryReport[] = [];
  for (const declared of project.definition.modules) {
    const report = reports.get(declared.id);
    if (report !== undefined) result.push(report);
  }
  return result;
}

function editorRegistrations(
  registration: ModuleRegistration | undefined,
): readonly McpEditorRegistration[] {
  if (registration === undefined) return [];
  const editors: McpEditorRegistration[] = [];
  for (const editor of registration.editors) {
    // MCP 的每个工具都要 Catalog + Query facet；缺任一个的 editor 在这里就不登记，
    // 免得上层拿到半个注册面后在中途抛 TypeError。
    if (editor.catalog === undefined || editor.mcp === undefined) continue;
    editors.push({
      editor: editor.editor,
      facet: editor.semantic as unknown as DocumentFacet<unknown, unknown>,
      catalog: editor.catalog as unknown as CatalogFacet<never, unknown>,
      mcp: editor.mcp as unknown as McpFacet<unknown, unknown>,
      create: editor.create as unknown as McpCreateFacet | undefined,
      operationSchema: editor.operationSchema as JsonValue | undefined,
    });
  }
  return editors;
}

function unusableReason(
  reports: readonly ModuleEntryReport[],
): "moduleUntrusted" | "moduleFailed" | "moduleDisabled" {
  if (reports.some((entry) => entry.status === "untrusted")) return "moduleUntrusted";
  if (reports.some((entry) => entry.status === "failed" || entry.status === "stale")) return "moduleFailed";
  return "moduleDisabled";
}

function editorUnsupported(
  editor: string,
  reason: "modulesDisabled" | "moduleNotDeclared" | "moduleFailed" | "moduleUntrusted" | "moduleDisabled",
  supportedEditors: readonly string[],
  modules: ProjectModuleSet,
): VisualBridgeMcpError {
  return new VisualBridgeMcpError(
    "document.editorUnsupported",
    reason === "modulesDisabled"
      ? `Module platform is disabled; set VISUALBRIDGE_MODULES_ENABLED=1 to use editor '${editor}'.`
      : `Editor '${editor}' is not available in this Project (${reason}).`,
    {
      editor,
      reason,
      supportedEditors,
      modules: modules.reports.map((entry) => ({ id: entry.id, status: entry.status })),
    },
  );
}

export type { ModuleEntryReport, ModuleStatus };
