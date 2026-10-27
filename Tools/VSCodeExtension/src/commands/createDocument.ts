import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { JsonValue } from "@visualbridge/core";
import type { WorkspaceDocumentLifecycle } from "../document/workspaceDocumentLifecycle";
import { OPTIONAL_EDITOR_VIEW_TYPE } from "../editor/documentEditorProvider";
import type { ModuleCreatePreparation, ModuleCreateQuestion } from "../editor/moduleEditorFacets";
import { TABLE_EDITOR_VIEW_TYPE } from "../editor/tableEditorProvider";
import { documentFacetFor, loadDocumentTypeCatalogRegistry } from "../modules/documentFacetRegistry";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import {
  createThroughLifecycle,
  suggestDefaultTarget,
  type CreateDocumentSelection,
} from "./createDocumentSupport";

export interface CreateDocumentOptions {
  /** 已解析的目标（Document Browser 等入口直接给出）。 */
  readonly selection?: CreateDocumentSelection;
  /** 只允许该 editor（四个历史命令各自固定一个领域）。 */
  readonly editor?: string;
  /** 模块可用性门禁：模块未加载（未信任 / 失败 / 停用）时不得执行领域代码。 */
  readonly isEditorAvailable?: (project: ProjectContext, editor: string) => boolean;
}

/**
 * 通用新建命令：遍历已加载模块的 `create` facet，宿主只负责 Quick Pick、保存对话框与
 * Lifecycle preview/apply（附录 D.3）。
 *
 * 类型清单与提问全部来自 facet；没有可用的模块 facet 时列表为空并给出提示。
 */
export async function createDocument(
  projects: ProjectRegistry,
  lifecycle: WorkspaceDocumentLifecycle,
  options: CreateDocumentOptions = {},
): Promise<void> {
  const selection = options.selection ?? await selectCreationTarget(projects, options);
  if (selection === undefined) {
    return;
  }
  const entry = documentFacetFor(selection.documentType.editor);
  if (entry === undefined || entry.create === undefined) {
    void vscode.window.showWarningMessage(
      `编辑器 '${selection.documentType.editor}' 未提供 create facet；请确认对应模块已加载。`,
    );
    return;
  }
  if (
    options.isEditorAvailable !== undefined
    && !options.isEditorAvailable(selection.project, selection.documentType.editor)
  ) {
    void vscode.window.showWarningMessage(
      `创建 '${selection.documentType.id}' 需要编辑器模块已加载；请先信任工作区。`,
    );
    return;
  }

  const catalog = await loadDocumentTypeCatalogRegistry(selection.project, selection.documentType);
  const input = {
    projectId: selection.project.definition.projectId,
    projectDefinition: selection.project.definition as unknown as JsonValue,
    documentType: selection.documentType,
    catalog: catalog === undefined
      ? { ready: false, registry: undefined, diagnostics: [] }
      : { ready: catalog.ready, registry: catalog.registry, diagnostics: catalog.diagnostics },
    newStableId: (prefix: string) => `${prefix}_${randomUUID()}`.replaceAll("-", ""),
  };
  const prepared: ModuleCreatePreparation = entry.create.prepare(input);
  if (prepared.kind === "unavailable") {
    void vscode.window.showWarningMessage(prepared.message);
    return;
  }

  const answers = await askQuestions(prepared.questions);
  if (answers === undefined) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: `Create VisualBridge ${titleCase(selection.documentType.editor)} Document`,
    defaultUri: suggestDefaultTarget(
      selection.project,
      selection.documentType,
      prepared.defaultFileName(answers),
      prepared.fallbackExtension,
    ),
  });
  if (target === undefined) {
    return;
  }
  const match = projects.resolveDocument(target);
  if (
    match === undefined
    || match.project.markerUri.toString() !== selection.project.markerUri.toString()
    || match.documentType.id !== selection.documentType.id
  ) {
    void vscode.window.showWarningMessage(
      `The selected path is not included by Document Type '${selection.documentType.id}'.`,
    );
    return;
  }

  const relativePath = nodePath.relative(selection.project.rootUri.fsPath, target.fsPath).replace(/\\/g, "/");
  const parameters = prepared.parameters(answers, { path: relativePath, name: nodePath.parse(target.fsPath).name });
  await createThroughLifecycle(
    lifecycle,
    selection.project,
    selection.documentType,
    target,
    parameters,
    entry.facet.storage === "sources" ? TABLE_EDITOR_VIEW_TYPE : OPTIONAL_EDITOR_VIEW_TYPE,
  );
}

async function selectCreationTarget(
  projects: ProjectRegistry,
  options: CreateDocumentOptions,
): Promise<CreateDocumentSelection | undefined> {
  const candidates = projects.projects.flatMap((project) => project.definition.documentTypes
    .filter((documentType) => documentFacetFor(documentType.editor)?.create !== undefined)
    .filter((documentType) => options.editor === undefined || documentType.editor === options.editor)
    .filter((documentType) => options.isEditorAvailable === undefined
      || options.isEditorAvailable(project, documentType.editor))
    .map((documentType) => ({
      label: documentType.id,
      description: `${titleCase(documentType.editor)} · ${project.definition.projectId}`,
      detail: documentType.include.join(", "),
      selection: { project, documentType },
    })));
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage("No creatable VisualBridge Document Type is available.");
    return undefined;
  }
  return (await vscode.window.showQuickPick(candidates, {
    title: "Create VisualBridge Document",
    placeHolder: "Select a project-defined Document Type",
    matchOnDescription: true,
    matchOnDetail: true,
  }))?.selection;
}

/** 只有一项可选时直接采用（与原 Graph / Entity 的单候选行为一致）。 */
async function askQuestions(
  questions: readonly ModuleCreateQuestion[],
): Promise<Readonly<Record<string, string>> | undefined> {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const only = question.options[0];
    if (only !== undefined && question.options.length === 1) {
      answers[question.id] = only.id;
      continue;
    }
    const selected = await vscode.window.showQuickPick(
      question.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(option.detail === undefined ? {} : { detail: option.detail }),
        id: option.id,
      })),
      { title: question.title, ...(question.placeholder === undefined ? {} : { placeHolder: question.placeholder }) },
    );
    if (selected === undefined) return undefined;
    answers[question.id] = selected.id;
  }
  return answers;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
