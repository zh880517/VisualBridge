import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  STRUCTURED_EDITOR_ID,
  resolveStructuredConfigType,
} from "@visualbridge/structured";
import { loadStructuredCatalogRegistry } from "../catalog/structuredCatalogLoader";
import type { ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceDocumentLifecycle } from "../document/workspaceDocumentLifecycle";
import { OPTIONAL_EDITOR_VIEW_TYPE } from "../editor/documentEditorProvider";
import {
  selectDocumentType,
  createThroughLifecycle,
  selectProject,
  suggestDefaultTarget,
  validateCreateDocumentSelection,
  type CreateDocumentSelection,
} from "./createDocumentSupport";

export async function createStructuredDocument(
  projects: ProjectRegistry,
  lifecycle: WorkspaceDocumentLifecycle,
  requestedSelection?: CreateDocumentSelection,
): Promise<void> {
  const selection = validateCreateDocumentSelection(requestedSelection, STRUCTURED_EDITOR_ID);
  const project = selection?.project ?? await selectProject(projects.projects, "Structured Config");
  if (project === undefined) {
    return;
  }
  const documentType = selection?.documentType ?? await selectDocumentType(project, STRUCTURED_EDITOR_ID, "Structured Config");
  if (documentType === undefined) {
    return;
  }
  const catalogResult = await loadStructuredCatalogRegistry(project, documentType.catalogs);
  if (!catalogResult.ready) {
    const firstError = catalogResult.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    void vscode.window.showWarningMessage(
      `无法创建 Structured Config，Catalog Registry 无效：${firstError?.message ?? "未配置可用 Catalog"}`,
    );
    return;
  }
  const configType = resolveStructuredConfigType(catalogResult.registry, documentType.id);
  if (configType === undefined) {
    void vscode.window.showWarningMessage(
      `Document Type '${documentType.id}' 必须与一个 Structured Config Type ID 或 alias 对应。`,
    );
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: "Create VisualBridge Structured Config",
    defaultUri: suggestDefaultTarget(project, documentType, `New${configType.title}`, "vbconfig"),
  });
  if (target === undefined) {
    return;
  }
  const match = projects.resolveDocument(target);
  if (
    match === undefined
    || match.project.markerUri.toString() !== project.markerUri.toString()
    || match.documentType.id !== documentType.id
    || match.documentType.editor !== STRUCTURED_EDITOR_ID
  ) {
    void vscode.window.showWarningMessage(
      `The selected path is not included by Structured Document Type '${documentType.id}'.`,
    );
    return;
  }
  await createThroughLifecycle(
    lifecycle,
    project,
    documentType,
    target,
    { documentId: `config_${randomUUID()}` },
    OPTIONAL_EDITOR_VIEW_TYPE,
  );
}
