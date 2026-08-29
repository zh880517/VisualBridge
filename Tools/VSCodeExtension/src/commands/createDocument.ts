import * as vscode from "vscode";
import { ENTITY_EDITOR_ID } from "@visualbridge/entity";
import { GRAPH_EDITOR_ID } from "@visualbridge/graph";
import { STRUCTURED_EDITOR_ID } from "@visualbridge/structured";
import { TABLE_EDITOR_ID } from "@visualbridge/table";
import type { ProjectRegistry } from "../project/projectRegistry";
import { createEntityDocument } from "./createEntityDocument";
import { createGraphDocument } from "./createGraphDocument";
import { createStructuredDocument } from "./createStructuredDocument";
import { createTableDocument } from "./createTableDocument";
import type { CreateDocumentSelection } from "./createDocumentSupport";
import type { WorkspaceDocumentLifecycle } from "../document/workspaceDocumentLifecycle";

const SUPPORTED_EDITORS = new Set([
  GRAPH_EDITOR_ID,
  ENTITY_EDITOR_ID,
  STRUCTURED_EDITOR_ID,
  TABLE_EDITOR_ID,
]);

export async function createDocument(
  projects: ProjectRegistry,
  lifecycle: WorkspaceDocumentLifecycle,
  requestedSelection?: CreateDocumentSelection,
): Promise<void> {
  const selection = requestedSelection ?? await selectCreationTarget(projects);
  if (selection === undefined) {
    return;
  }
  if (selection.documentType.editor === GRAPH_EDITOR_ID) {
    await createGraphDocument(projects, lifecycle, selection);
  } else if (selection.documentType.editor === ENTITY_EDITOR_ID) {
    await createEntityDocument(projects, lifecycle, selection);
  } else if (selection.documentType.editor === STRUCTURED_EDITOR_ID) {
    await createStructuredDocument(projects, lifecycle, selection);
  } else if (selection.documentType.editor === TABLE_EDITOR_ID) {
    await createTableDocument(projects, lifecycle, selection);
  }
}

async function selectCreationTarget(projects: ProjectRegistry): Promise<CreateDocumentSelection | undefined> {
  const candidates = projects.projects.flatMap((project) => project.definition.documentTypes
    .filter((documentType) => SUPPORTED_EDITORS.has(documentType.editor))
    .map((documentType) => ({
      label: documentType.id,
      description: `${editorTitle(documentType.editor)} · ${project.definition.projectId}`,
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

function editorTitle(editor: string): string {
  return editor === GRAPH_EDITOR_ID
    ? "Graph"
    : editor === ENTITY_EDITOR_ID
      ? "Entity"
      : editor === STRUCTURED_EDITOR_ID
        ? "Structured"
        : editor === TABLE_EDITOR_ID
          ? "Table"
          : editor;
}
