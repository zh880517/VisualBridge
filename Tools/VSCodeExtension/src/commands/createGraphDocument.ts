import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  GRAPH_EDITOR_ID,
  createEmptyGraphDocument,
  parseGraphCatalog,
  serializeGraphDocument,
  type GraphCatalog,
  type GraphTypeDefinition,
} from "@visualbridge/graph";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import { DEFAULT_EDITOR_VIEW_TYPE } from "../editor/documentEditorProvider";

export async function createGraphDocument(projects: ProjectRegistry): Promise<void> {
  const project = await selectProject(projects.projects);
  if (project === undefined) {
    return;
  }

  const graphDocumentType = project.definition.documentTypes.find(
    (documentType) => documentType.editor === GRAPH_EDITOR_ID,
  );
  if (graphDocumentType === undefined) {
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

  const catalog = await loadCatalog(project, graphDocumentType.catalog);
  if (catalog.graphTypes.length > 0 && catalog.graphTypes.every((graphType) => graphType.usage === "subgraph")) {
    void vscode.window.showWarningMessage("Graph Catalog 没有可用作根图的 Graph Type。");
    return;
  }
  const selectedGraphType = await selectRootGraphType(catalog);
  if (catalog.graphTypes.some((graphType) => graphType.usage !== "subgraph") && selectedGraphType === undefined) {
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

  const text = serializeGraphDocument(createEmptyGraphDocument(
    `graph_${randomUUID()}`,
    `root_${randomUUID()}`,
    selectedGraphType?.id,
    catalog,
    () => `node_${randomUUID()}`,
  ));
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  await vscode.commands.executeCommand("vscode.openWith", target, DEFAULT_EDITOR_VIEW_TYPE);
}

async function loadCatalog(
  project: ProjectContext,
  catalogPath: string | undefined,
): Promise<GraphCatalog> {
  if (catalogPath === undefined) {
    return { formatVersion: 2, catalogId: "unconfigured", dataTypes: [], graphTypes: [], nodeTypes: [] };
  }
  try {
    const uri = vscode.Uri.joinPath(project.rootUri, ...catalogPath.split("/"));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
    const result = parseGraphCatalog(text);
    if (result.success) {
      return result.document;
    }
    void vscode.window.showWarningMessage(`Graph Catalog 无效，将创建未指定类型的 Graph：${result.diagnostics[0]?.message ?? "未知错误"}`);
  } catch (errorValue) {
    void vscode.window.showWarningMessage(`无法读取 Graph Catalog，将创建未指定类型的 Graph：${String(errorValue)}`);
  }
  return { formatVersion: 2, catalogId: "invalid", dataTypes: [], graphTypes: [], nodeTypes: [] };
}

async function selectRootGraphType(catalog: GraphCatalog): Promise<GraphTypeDefinition | undefined> {
  const candidates = catalog.graphTypes.filter((graphType) => graphType.usage !== "subgraph");
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const items: (vscode.QuickPickItem & { readonly graphType: GraphTypeDefinition })[] = candidates.map((graphType) => ({
    label: graphType.title,
    description: graphType.id,
    ...(graphType.description === undefined ? {} : { detail: graphType.description }),
    graphType,
  }));
  const selected = await vscode.window.showQuickPick(
    items,
    { title: "Select Root Graph Type", placeHolder: "Graph Type for the new document" },
  );
  return selected?.graphType;
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
