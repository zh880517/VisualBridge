/**
 * 把已装载的模块注册面投影成 F4 的 `DebugFacetSource`（D.4）。
 *
 * 只做数据搬运，不执行模块代码；`bundle.registration` 是 ModuleLoader 校验过的原始注册面，
 * 里面保留了 `editors[i].debug.onRecord`（NodeHost 的宿主投影不得吞掉它）。
 */
import type { DebugFacet, JsonObject, ModuleProjectDocumentType } from "@visualbridge/module-sdk";
import type { DebugFacetSource } from "./debugFacetRouter";

/** 只依赖 Project 的定义部分（结构兼容 `ProjectContext`，单测不必构造 vscode.Uri）。 */
export interface DebugFacetProjectLike {
  readonly markerKey?: string;
  readonly definition: {
    readonly projectId: string;
    readonly modules: readonly { readonly id: string; readonly options?: JsonObject }[];
    readonly documentTypes: readonly ModuleProjectDocumentType[];
  };
}

/** 只依赖注册表快照的本模块字段（结构兼容 `HostModuleState`）。 */
export interface DebugFacetModuleLike {
  readonly id: string;
  /** Project File 中 `modules` 的下标。 */
  readonly index: number;
  readonly status: string;
  readonly bundle: {
    readonly registration: {
      readonly editors: readonly {
        readonly editor: string;
        readonly debug?: DebugFacet;
      }[];
    };
  } | undefined;
}

/**
 * `modules` 的声明顺序就是路由的冲突裁决顺序（C.5：第一个认领者生效）。
 *
 * 未装载（untrusted/failed/disabled/stale）的模块不产生 source；它们声明的分类因而没有
 * 主消费者，记录走通用视图，面板据此显示"模块未加载"。
 */
export function collectDebugFacetSources<P extends DebugFacetProjectLike>(
  projects: readonly P[],
  modulesFor: (project: P) => readonly DebugFacetModuleLike[],
  log: (moduleId: string, message: string) => void,
): DebugFacetSource[] {
  const sources: DebugFacetSource[] = [];
  for (const project of projects) {
    for (const module of modulesFor(project)) {
      if (module.status !== "loaded" || module.bundle === undefined) {
        continue;
      }

      const registration = module.bundle.registration;
      for (const [editorIndex, editor] of registration.editors.entries()) {
        if (editor.debug === undefined) {
          continue;
        }

        const documentType = project.definition.documentTypes.find((candidate) => candidate.editor === editor.editor)
          ?? syntheticDocumentType(module.id, editor.editor);
        const moduleDefinition = project.definition.modules[module.index]?.id === module.id
          ? project.definition.modules[module.index]
          : project.definition.modules.find((candidate) => candidate.id === module.id);
        sources.push({
          moduleId: module.id,
          moduleIndex: module.index,
          editor: editor.editor,
          facet: editor.debug,
          path: `modules[${module.index}].editors[${editorIndex}].debug`,
          context: {
            project: {
              projectId: project.definition.projectId,
              moduleId: module.id,
              documentTypes: project.definition.documentTypes,
              options: moduleDefinition?.options,
            },
            // 调试 facet 不是"某个打开文档的会话"：没有选中的 Document Type 时给一个空壳，
            // 让模块仍能用 `context.project.options`（F4 验收 ⑤）而不必猜测是否一定有文档。
            documentType,
            registry: undefined,
            // G1 之前调试窗口不读 Catalog：宿主不把编辑器目录/快照能力带进调试链路。
            catalogs: { get: () => undefined },
            log: (message: string) => log(module.id, message),
          },
        });
      }
    }
  }

  return sources;
}

function syntheticDocumentType(moduleId: string, editor: string): ModuleProjectDocumentType {
  return { id: `${moduleId}:${editor}:debug`, editor, include: [], exclude: [], catalogs: [] };
}
