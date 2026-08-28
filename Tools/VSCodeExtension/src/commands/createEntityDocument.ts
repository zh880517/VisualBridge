import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  ENTITY_EDITOR_ID,
  createEmptyEntityDocument,
  serializeEntityDocument,
  type EntityCatalogRegistry,
  type RegisteredEntityTypeDefinition,
} from "@visualbridge/entity";
import { loadEntityCatalogRegistry } from "../catalog/entityCatalogLoader";
import type { ProjectRegistry } from "../project/projectRegistry";
import { OPTIONAL_EDITOR_VIEW_TYPE } from "../editor/documentEditorProvider";
import { selectDocumentType, selectProject, suggestDefaultTarget } from "./createDocumentSupport";

export async function createEntityDocument(projects: ProjectRegistry): Promise<void> {
  const project = await selectProject(projects.projects, "Entity Document");
  if (project === undefined) {
    return;
  }
  const documentType = await selectDocumentType(project, ENTITY_EDITOR_ID, "Entity");
  if (documentType === undefined) {
    return;
  }
  const catalogResult = await loadEntityCatalogRegistry(project, documentType.catalogs);
  if (!catalogResult.ready) {
    const firstError = catalogResult.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    void vscode.window.showWarningMessage(
      `无法创建 Entity，Catalog Registry 无效：${firstError?.message ?? "未配置可用 Catalog"}`,
    );
    return;
  }
  const entityType = await selectEntityType(catalogResult.registry);
  if (entityType === undefined) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: "Create VisualBridge Entity Document",
    defaultUri: suggestDefaultTarget(project, documentType, `New${entityType.title}`, "vbentity"),
  });
  if (target === undefined) {
    return;
  }
  const match = projects.resolveDocument(target);
  if (
    match === undefined
    || match.project.markerUri.toString() !== project.markerUri.toString()
    || match.documentType.id !== documentType.id
    || match.documentType.editor !== ENTITY_EDITOR_ID
  ) {
    void vscode.window.showWarningMessage(
      `The selected path is not included by Entity Document Type '${documentType.id}'.`,
    );
    return;
  }
  const text = serializeEntityDocument(createEmptyEntityDocument(
    `entity_${randomUUID()}`,
    entityType.id,
    catalogResult.registry,
    entityType.title,
  ));
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  await vscode.commands.executeCommand("vscode.openWith", target, OPTIONAL_EDITOR_VIEW_TYPE);
}

async function selectEntityType(
  registry: EntityCatalogRegistry,
): Promise<RegisteredEntityTypeDefinition | undefined> {
  if (registry.entityTypes.length === 0) {
    void vscode.window.showWarningMessage("Entity Catalog Registry 没有 Entity Type。");
    return undefined;
  }
  if (registry.entityTypes.length === 1) {
    return registry.entityTypes[0];
  }
  const selected = await vscode.window.showQuickPick(
    registry.entityTypes.map((entityType) => ({
      label: entityType.title,
      description: `${entityType.catalogTitle} · ${entityType.id}`,
      ...(entityType.description === undefined ? {} : { detail: entityType.description }),
      entityType,
    })),
    { title: "Select Entity Type", placeHolder: "Runtime structure for the new Entity Document" },
  );
  return selected?.entityType;
}
