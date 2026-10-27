/**
 * MCP 宿主侧的模块登记（附录 D.1/D.3 的进程内形态）。
 *
 * C1 会把登记迁到 `Modules/` 的 bundle 与 `EditorRegistration`；在这一步之前，四个内置包各自
 * 导出 `catalog` / `document` / `create` / `mcp` facet 与 `operationSchema`，宿主只认这里的结构。
 * 本文件是 MCP 唯一知道"哪个 editor 来自哪个模块"的地方。
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
  VisualBridgeProjectDefinition,
} from "@visualbridge/core";
import {
  entityCatalogFacet,
  entityCreateFacet,
  entityDocumentFacet,
  entityMcpFacet,
  entityOperationSchema,
} from "@visualbridge/entity";
import {
  graphCatalogFacet,
  graphCreateFacet,
  graphDocumentFacet,
  graphMcpFacet,
  graphOperationSchema,
} from "@visualbridge/graph";
import {
  structuredCatalogFacet,
  structuredCreateFacet,
  structuredDocumentFacet,
  structuredMcpFacet,
  structuredOperationSchema,
} from "@visualbridge/structured";
import {
  tableCatalogFacet,
  tableCreateFacet,
  tableDocumentFacet,
  tableMcpFacet,
  tableOperationSchema,
} from "@visualbridge/table";
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
 * 形状与 VS Code 宿主的 `ModuleCreateFacet.createDocument` 一致；C1 统一改用 Module SDK 的
 * 同名类型后本类型应删除。MCP 只需要"产出初始源文件字节 + 稳定身份"，不需要 Quick Pick。
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

/** 一个内置模块的静态登记；`version` 来自模块包自身版本。 */
export interface McpModuleRegistration {
  readonly id: string;
  readonly version: string;
  readonly editor: string;
  readonly facet: DocumentFacet<unknown, unknown>;
  readonly catalog: CatalogFacet<never, unknown>;
  readonly mcp: McpFacet<unknown, unknown>;
  readonly create: McpCreateFacet;
  readonly operationSchema: JsonValue;
}

export const BUILT_IN_MODULE_REGISTRATIONS: readonly McpModuleRegistration[] = [
  registration("visualbridge.entity", entityDocumentFacet, entityCatalogFacet, entityMcpFacet, entityCreateFacet, entityOperationSchema),
  registration("visualbridge.graph", graphDocumentFacet, graphCatalogFacet, graphMcpFacet, graphCreateFacet, graphOperationSchema),
  registration(
    "visualbridge.structured",
    structuredDocumentFacet,
    structuredCatalogFacet,
    structuredMcpFacet,
    structuredCreateFacet,
    structuredOperationSchema,
  ),
  registration("visualbridge.table", tableDocumentFacet, tableCatalogFacet, tableMcpFacet, tableCreateFacet, tableOperationSchema),
];

function registration<TDocument, TRegistry, TCatalog extends CatalogWithSource>(
  id: string,
  facet: DocumentFacet<TDocument, TRegistry>,
  catalog: CatalogFacet<TCatalog, TRegistry>,
  mcp: McpFacet<TDocument, TRegistry>,
  create: McpCreateFacet,
  operationSchema: JsonValue,
): McpModuleRegistration {
  return {
    id,
    version: "0.1.0",
    editor: facet.editor,
    // facet 边界：登记表以 `unknown` 存领域泛型，模块实现负责收窄（与 B3 的 VS Code 登记一致）。
    facet: facet as unknown as DocumentFacet<unknown, unknown>,
    catalog: catalog as unknown as CatalogFacet<never, unknown>,
    mcp: mcp as unknown as McpFacet<unknown, unknown>,
    create,
    operationSchema,
  };
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

export class McpModuleRegistry {
  private readonly byId: ReadonlyMap<string, McpModuleRegistration>;
  private readonly byEditor: ReadonlyMap<string, McpModuleRegistration>;

  public constructor(
    public readonly enabled: boolean,
    private readonly workspaceRoot: string,
    registrations: readonly McpModuleRegistration[] = BUILT_IN_MODULE_REGISTRATIONS,
  ) {
    this.byId = new Map(registrations.map((entry) => [entry.id, entry]));
    this.byEditor = new Map(registrations.map((entry) => [entry.editor, entry]));
  }

  public static fromEnvironment(environment: NodeJS.ProcessEnv, workspaceRoot: string): McpModuleRegistry {
    return new McpModuleRegistry(readModulesEnabled(environment), workspaceRoot);
  }

  public registrations(): readonly McpModuleRegistration[] {
    return [...this.byId.values()];
  }

  public registrationForEditor(editor: string): McpModuleRegistration | undefined {
    return this.byEditor.get(editor);
  }

  /** 装载一个 Project 声明的全部模块；未启用模块平台时只产出 `disabled` 报告。 */
  public async modulesFor(project: ProjectContext): Promise<ProjectModuleSet> {
    if (!this.enabled) {
      return {
        enabled: false,
        reports: project.definition.modules.map((entry) => ({
          id: entry.id,
          entry: entry.entry,
          status: "disabled" as const,
          editors: editorsOf(this.byId.get(entry.id)),
          diagnostics: [],
        })),
        active: [],
      };
    }
    const reports: ModuleEntryReport[] = [];
    const active: ActiveModule[] = [];
    for (const declared of project.definition.modules) {
      const registration = this.byId.get(declared.id);
      if (registration === undefined) {
        reports.push({
          id: declared.id,
          entry: declared.entry,
          status: "failed",
          editors: [],
          diagnostics: [{
            severity: "error",
            code: "module.loadFailed",
            path: `modules.${declared.id}`,
            message: `Module '${declared.id}' is not provided by this host.`,
          }],
        });
        continue;
      }
      const verification = await verifyModuleEntry(project, declared, this.workspaceRoot);
      if (verification.status !== "loaded") {
        reports.push({
          id: declared.id,
          entry: declared.entry,
          status: verification.status,
          version: registration.version,
          editors: [registration.editor],
          diagnostics: verification.diagnostics,
        });
        continue;
      }
      reports.push({
        id: declared.id,
        entry: declared.entry,
        status: "loaded",
        version: registration.version,
        ...(verification.sha256 === undefined ? {} : { sha256: verification.sha256 }),
        editors: [registration.editor],
        diagnostics: verification.diagnostics,
      });
      active.push({ ...registration, options: declared.options });
    }
    return { enabled: true, reports, active };
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
    const declared = findDeclaredModule(project.definition, editor, this.byId);
    if (declared === undefined) {
      throw editorUnsupported(editor, "moduleNotDeclared", [...this.byEditor.keys()].sort(), modules);
    }
    const report = modules.reports.find((entry) => entry.id === declared.id);
    const reason = report?.status === "untrusted"
      ? "moduleUntrusted"
      : report?.status === "failed"
        ? "moduleFailed"
        : "moduleDisabled";
    throw editorUnsupported(editor, reason, modules.active.map((entry) => entry.editor), modules);
  }
}

function findDeclaredModule(
  definition: VisualBridgeProjectDefinition,
  editor: string,
  byId: ReadonlyMap<string, McpModuleRegistration>,
): ProjectModuleDefinition | undefined {
  for (const declared of definition.modules) {
    if (byId.get(declared.id)?.editor === editor) return declared;
  }
  return undefined;
}

function editorsOf(registration: McpModuleRegistration | undefined): readonly string[] {
  return registration === undefined ? [] : [registration.editor];
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
