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
import type { ProjectRegistry } from "../project/projectRegistry";
import { OPTIONAL_EDITOR_VIEW_TYPE } from "../editor/documentEditorProvider";
import { selectDocumentType, selectProject, suggestDefaultTarget } from "./createDocumentSupport";

export async function createGraphDocument(projects: ProjectRegistry): Promise<void> {
  const project = await selectProject(projects.projects, "Graph Document");
  if (project === undefined) {
    return;
  }

  const graphDocumentType = await selectDocumentType(project, GRAPH_EDITOR_ID, "Graph");
  if (graphDocumentType === undefined) {
    return;
  }
  const catalogResult = await loadGraphCatalogRegistry(project, graphDocumentType.catalogs);
  if (!catalogResult.ready && graphDocumentType.catalogs.length > 0) {
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

  const target = await vscode.window.showSaveDialog({
    title: "Create VisualBridge Graph Document",
    defaultUri: suggestDefaultTarget(project, graphDocumentType, "NewGraph", "vbgraph"),
  });
  if (target === undefined) {
    return;
  }
  const match = projects.resolveDocument(target);
  if (
    match === undefined
    || match.project.markerUri.toString() !== project.markerUri.toString()
    || match.documentType.id !== graphDocumentType.id
    || match.documentType.editor !== GRAPH_EDITOR_ID
  ) {
    void vscode.window.showWarningMessage(
      `The selected path is not included by Graph Document Type '${graphDocumentType.id}'.`,
    );
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
  await vscode.commands.executeCommand("vscode.openWith", target, OPTIONAL_EDITOR_VIEW_TYPE);
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
