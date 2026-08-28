import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  GRAPH_EDITOR_ID,
  createEmptyGraphDocument,
  serializeGraphDocument,
  type GraphCatalogRegistry,
  type RegisteredGraphTypeDefinition,
} from "@visualbridge/graph";
import { loadGraphCatalogRegistry } from "../catalog/graphCatalogLoader";
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

  const catalogResult = await loadGraphCatalogRegistry(project, match.documentType.catalogs);
  if (!catalogResult.ready && match.documentType.catalogs.length > 0) {
    const firstError = catalogResult.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    void vscode.window.showWarningMessage(
      `无法创建 Graph，Catalog Registry 无效：${firstError?.message ?? "未知错误"}`,
    );
    return;
  }
  const catalogRegistry = catalogResult.registry;
  if (
    catalogRegistry.graphTypes.length > 0
    && catalogRegistry.graphTypes.every((graphType) => graphType.usage === "subgraph")
  ) {
    void vscode.window.showWarningMessage("Graph Catalog Registry 没有可用作根图的 Graph Type。");
    return;
  }
  const selectedGraphType = await selectRootGraphType(catalogRegistry);
  if (
    catalogRegistry.graphTypes.some((graphType) => graphType.usage !== "subgraph")
    && selectedGraphType === undefined
  ) {
    return;
  }

  const text = serializeGraphDocument(createEmptyGraphDocument(
    `graph_${randomUUID()}`,
    `root_${randomUUID()}`,
    selectedGraphType?.id,
    catalogRegistry,
    () => `node_${randomUUID()}`,
  ));
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  await vscode.commands.executeCommand("vscode.openWith", target, DEFAULT_EDITOR_VIEW_TYPE);
}

async function selectRootGraphType(
  catalogRegistry: GraphCatalogRegistry,
): Promise<RegisteredGraphTypeDefinition | undefined> {
  const candidates = catalogRegistry.graphTypes.filter((graphType) => graphType.usage !== "subgraph");
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const items: (vscode.QuickPickItem & { readonly graphType: RegisteredGraphTypeDefinition })[] = candidates.map((graphType) => ({
    label: graphType.title,
    description: `${graphType.catalogTitle} · ${graphType.id}`,
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
