import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { GRAPH_EDITOR_ID, serializeGraphDocument } from "@visualbridge/graph";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import { DEFAULT_EDITOR_VIEW_TYPE } from "../editor/documentEditorProvider";

export async function createGraphDocument(projects: ProjectRegistry): Promise<void> {
  const project = await selectProject(projects.projects);
  if (project === undefined) {
    return;
  }

  const graphType = project.definition.documentTypes.find(
    (documentType) => documentType.editor === GRAPH_EDITOR_ID,
  );
  if (graphType === undefined) {
    void vscode.window.showWarningMessage(
      `Project '${project.definition.projectId}' does not declare a Graph document type.`,
    );
    return;
  }

  const firstRoot = project.definition.documentRoots[0] ?? ".";
  const defaultDirectory = firstRoot === "."
    ? project.rootUri
    : vscode.Uri.joinPath(project.rootUri, ...firstRoot.split("/"));
  const target = await vscode.window.showSaveDialog({
    title: "Create VisualBridge Graph Document",
    defaultUri: vscode.Uri.joinPath(defaultDirectory, "NewGraph.vbgraph"),
    filters: { "VisualBridge Graph": ["vbgraph"] },
  });
  if (target === undefined) {
    return;
  }

  const match = projects.resolveDocument(target);
  if (
    match === undefined
    || match.project.markerUri.toString() !== project.markerUri.toString()
    || match.documentType.editor !== GRAPH_EDITOR_ID
  ) {
    void vscode.window.showWarningMessage(
      "The selected path is not included by this project's Graph document type.",
    );
    return;
  }

  const text = serializeGraphDocument({
    formatVersion: 1,
    documentId: `graph_${randomUUID()}`,
    nodes: [],
    edges: [],
  });
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  await vscode.commands.executeCommand("vscode.openWith", target, DEFAULT_EDITOR_VIEW_TYPE);
}

async function selectProject(
  projects: readonly ProjectContext[],
): Promise<ProjectContext | undefined> {
  if (projects.length === 0) {
    void vscode.window.showWarningMessage("No valid VisualBridge project is available.");
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0];
  }

  const selected = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.definition.projectId,
      description: project.rootUri.fsPath,
      project,
    })),
    { title: "Select a VisualBridge project", placeHolder: "Project for the new Graph Document" },
  );
  return selected?.project;
}
