import type { DocumentTypeDefinition, VisualBridgeProjectDefinition } from "./projectFile";

export interface ProjectDocumentMatchOptions {
  readonly editor?: string;
  readonly documentTypeId?: string;
}

export type ProjectGlobMatcher = (pattern: string, relativePath: string) => boolean;

export function findMatchingDocumentTypes(
  project: VisualBridgeProjectDefinition,
  relativePath: string,
  matchesGlob: ProjectGlobMatcher,
  options: ProjectDocumentMatchOptions = {},
): readonly DocumentTypeDefinition[] {
  if (!isInDocumentRoots(relativePath, project.documentRoots)) {
    return [];
  }
  return project.documentTypes.filter((documentType) =>
    (options.editor === undefined || documentType.editor === options.editor)
    && (options.documentTypeId === undefined || documentType.id === options.documentTypeId)
    && documentType.include.some((pattern) => matchesGlob(pattern, relativePath))
    && !documentType.exclude.some((pattern) => matchesGlob(pattern, relativePath)),
  );
}

export function isInDocumentRoots(
  relativePath: string,
  documentRoots: readonly string[],
): boolean {
  return documentRoots.some(
    (root) => root === "." || relativePath === root || relativePath.startsWith(`${root}/`),
  );
}
