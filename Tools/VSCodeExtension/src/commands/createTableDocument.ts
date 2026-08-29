import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  TABLE_EDITOR_ID,
  createEmptyCsvTableSource,
  createEmptyXlsxTableSource,
  resolveTableType,
  type TableTypeDefinition,
} from "@visualbridge/table";
import { loadTableCatalogRegistry } from "../catalog/tableCatalogLoader";
import { TABLE_EDITOR_VIEW_TYPE } from "../editor/tableEditorProvider";
import type { ProjectRegistry } from "../project/projectRegistry";
import {
  selectDocumentType,
  selectProject,
  suggestDefaultTarget,
  validateCreateDocumentSelection,
  type CreateDocumentSelection,
} from "./createDocumentSupport";

export async function createTableDocument(
  projects: ProjectRegistry,
  requestedSelection?: CreateDocumentSelection,
): Promise<void> {
  const selection = validateCreateDocumentSelection(requestedSelection, TABLE_EDITOR_ID);
  const project = selection?.project ?? await selectProject(projects.projects, "Table Document");
  if (project === undefined) {
    return;
  }
  const layout = project.definition.tableLayout;
  if (layout === undefined) {
    void vscode.window.showWarningMessage(
      `Project '${project.definition.projectId}' must configure tableLayout before a Table can be created.`,
    );
    return;
  }
  const documentType = selection?.documentType ?? await selectDocumentType(project, TABLE_EDITOR_ID, "Table");
  if (documentType === undefined) {
    return;
  }
  const catalogResult = await loadTableCatalogRegistry(project, documentType.catalogs);
  if (!catalogResult.ready) {
    const firstError = catalogResult.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    void vscode.window.showWarningMessage(
      `无法创建 Table，Catalog Registry 无效：${firstError?.message ?? "未配置可用 Catalog"}`,
    );
    return;
  }
  const tableType = resolveTableType(catalogResult.registry, documentType.id);
  if (tableType === undefined) {
    void vscode.window.showWarningMessage(
      `Document Type '${documentType.id}' 必须与一个 Table Type ID 或 alias 对应。`,
    );
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: "Create VisualBridge Table",
    defaultUri: suggestDefaultTarget(
      project,
      documentType,
      initialPhysicalName(tableType),
      tableType.csv === undefined ? "xlsx" : "csv",
    ),
  });
  if (target === undefined) {
    return;
  }
  const match = projects.resolveDocument(target);
  if (
    match === undefined
    || match.project.markerUri.toString() !== project.markerUri.toString()
    || match.documentType.id !== documentType.id
    || match.documentType.editor !== TABLE_EDITOR_ID
  ) {
    void vscode.window.showWarningMessage(
      `The selected path is not included by Table Document Type '${documentType.id}'.`,
    );
    return;
  }

  const result = nodePath.extname(target.fsPath).toLocaleLowerCase() === ".xlsx"
    ? await createEmptyXlsxTableSource(tableType, layout)
    : createEmptyCsvTableSource(
        tableType,
        layout,
        nodePath.basename(target.fsPath, nodePath.extname(target.fsPath)),
      );
  if (!result.success) {
    const diagnostic = result.diagnostics[0];
    void vscode.window.showWarningMessage(
      `无法创建 Table：${diagnostic === undefined ? "未知错误" : `${diagnostic.path}: ${diagnostic.message}`}`,
    );
    return;
  }
  await vscode.workspace.fs.writeFile(target, result.bytes);
  await vscode.commands.executeCommand("vscode.openWith", target, TABLE_EDITOR_VIEW_TYPE);
}

function initialPhysicalName(tableType: TableTypeDefinition): string {
  const sheet = tableType.sheets[0];
  if (sheet === undefined) {
    return "NewTable";
  }
  return sheet.partition === undefined
    ? sheet.name
    : sheet.partition.namePattern.replace("{part}", "Main");
}
