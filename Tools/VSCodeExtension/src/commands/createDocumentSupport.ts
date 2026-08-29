import * as vscode from "vscode";
import type { DocumentTypeDefinition } from "@visualbridge/core";
import type { ProjectContext } from "../project/projectRegistry";

export interface CreateDocumentSelection {
  readonly project: ProjectContext;
  readonly documentType: DocumentTypeDefinition;
}

export function validateCreateDocumentSelection(
  selection: CreateDocumentSelection | undefined,
  editorId: string,
): CreateDocumentSelection | undefined {
  return selection?.documentType.editor === editorId ? selection : undefined;
}

export async function selectProject(
  projects: readonly ProjectContext[],
  purpose: string,
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
    { title: "Select a VisualBridge project", placeHolder: `Project for the new ${purpose}` },
  );
  return selected?.project;
}

export async function selectDocumentType(
  project: ProjectContext,
  editorId: string,
  displayName: string,
): Promise<DocumentTypeDefinition | undefined> {
  const candidates = project.definition.documentTypes.filter((documentType) => documentType.editor === editorId);
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(
      `Project '${project.definition.projectId}' does not declare a ${displayName} document type.`,
    );
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const selected = await vscode.window.showQuickPick(
    candidates.map((documentType) => ({
      label: documentType.id,
      description: documentType.include.join(", "),
      detail: documentType.catalogs.length === 0 ? "No Catalogs" : documentType.catalogs.join(", "),
      documentType,
    })),
    { title: `Select ${displayName} Document Type`, placeHolder: "Project-defined subtype and file association" },
  );
  return selected?.documentType;
}

export function suggestDefaultTarget(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  baseName: string,
  fallbackExtension: string,
): vscode.Uri {
  const pattern = documentType.include[0] ?? "";
  const segments = pattern.split("/");
  const filePattern = segments.at(-1) ?? "";
  const extensionMatch = /\.([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(filePattern);
  const extension = extensionMatch?.[1] ?? fallbackExtension;
  const staticDirectorySegments: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (["*", "?", "{", "["].some((marker) => segment.includes(marker))) {
      break;
    }
    staticDirectorySegments.push(segment);
  }
  if (staticDirectorySegments.length === 0) {
    const firstRoot = project.definition.documentRoots[0] ?? ".";
    if (firstRoot !== ".") {
      staticDirectorySegments.push(...firstRoot.split("/"));
    }
  }
  const directory = staticDirectorySegments.length === 0
    ? project.rootUri
    : vscode.Uri.joinPath(project.rootUri, ...staticDirectorySegments);
  return vscode.Uri.joinPath(directory, `${sanitizeFileName(baseName)}.${extension}`);
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").trim().replace(/\s+/g, "");
  return sanitized.length === 0 ? "NewDocument" : sanitized;
}
