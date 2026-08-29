import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import {
  PROJECT_FILE_NAME,
  findMatchingDocumentTypes,
  parseProjectFile,
  type DocumentTypeDefinition,
  type ProjectFileIssue,
  type VisualBridgeProjectDefinition,
} from "@visualbridge/core";

const skippedDirectoryNames = new Set([
  ".codegraph",
  ".git",
  ".visualbridge-transaction-recovery",
  "Library",
  "node_modules",
]);

export interface WorkspaceIssue {
  readonly projectFile: string;
  readonly issues: readonly ProjectFileIssue[];
}

export interface ProjectContext {
  readonly projectFile: string;
  readonly absoluteProjectFile: string;
  readonly projectRoot: string;
  readonly definition: VisualBridgeProjectDefinition;
}

export interface ProjectDiscoveryResult {
  readonly workspaceRoot: string;
  readonly projects: readonly ProjectContext[];
  readonly issues: readonly WorkspaceIssue[];
}

export interface DeclaredDocumentContext {
  readonly project: ProjectContext;
  readonly documentType: DocumentTypeDefinition;
  readonly path: string;
  readonly absolutePath: string;
}

export interface GraphDocumentContext extends DeclaredDocumentContext {
  readonly graphPath: string;
  readonly absoluteGraphPath: string;
}

export interface TableDocumentContext extends DeclaredDocumentContext {
  readonly tablePath: string;
  readonly absoluteTablePath: string;
}

export interface StructuredDocumentContext extends DeclaredDocumentContext {
  readonly structuredPath: string;
  readonly absoluteStructuredPath: string;
}

export class VisualBridgeMcpError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "VisualBridgeMcpError";
  }
}

export class VisualBridgeWorkspace {
  private constructor(public readonly root: string) {}

  public static async create(root: string): Promise<VisualBridgeWorkspace> {
    return new VisualBridgeWorkspace(await realpath(path.resolve(root)));
  }

  public async discoverProjects(): Promise<ProjectDiscoveryResult> {
    const markerPaths: string[] = [];
    await collectProjectFiles(this.root, markerPaths);
    markerPaths.sort((left, right) => left.localeCompare(right));

    const projects: ProjectContext[] = [];
    const issues: WorkspaceIssue[] = [];
    for (const absoluteProjectFile of markerPaths) {
      const projectFile = toWorkspacePath(this.root, absoluteProjectFile);
      try {
        const result = parseProjectFile(decodeUtf8(
          await readFile(absoluteProjectFile),
          projectFile,
        ));
        if (!result.success) {
          issues.push({ projectFile, issues: result.issues });
          continue;
        }
        projects.push({
          projectFile,
          absoluteProjectFile,
          projectRoot: path.dirname(absoluteProjectFile),
          definition: result.value,
        });
      } catch (errorValue) {
        issues.push({
          projectFile,
          issues: [{ path: "$", message: `Unable to read project file: ${formatError(errorValue)}` }],
        });
      }
    }

    const projectIds = new Map<string, ProjectContext[]>();
    for (const project of projects) {
      const group = projectIds.get(project.definition.projectId) ?? [];
      group.push(project);
      projectIds.set(project.definition.projectId, group);
    }
    const duplicateProjectFiles = new Set<string>();
    for (const [projectId, group] of projectIds) {
      if (group.length < 2) {
        continue;
      }
      for (const project of group) {
        duplicateProjectFiles.add(project.projectFile);
        issues.push({
          projectFile: project.projectFile,
          issues: [{ path: "projectId", message: `Duplicate projectId '${projectId}' in the MCP workspace.` }],
        });
      }
    }

    return {
      workspaceRoot: this.root,
      projects: projects.filter((project) => !duplicateProjectFiles.has(project.projectFile)),
      issues,
    };
  }

  public async resolveProject(projectFile?: string): Promise<ProjectContext> {
    const discovery = await this.discoverProjects();
    if (projectFile === undefined) {
      if (discovery.projects.length === 1) {
        return discovery.projects[0]!;
      }
      throw new VisualBridgeMcpError(
        discovery.projects.length === 0 ? "project.notFound" : "project.ambiguous",
        discovery.projects.length === 0
          ? "No valid VisualBridge Project was discovered in the MCP workspace."
          : "Multiple VisualBridge Projects were discovered; provide projectFile.",
        discovery,
      );
    }

    const normalizedProjectFile = normalizeRelativePath(projectFile, "projectFile");
    const project = discovery.projects.find((candidate) => candidate.projectFile === normalizedProjectFile);
    if (project === undefined) {
      throw new VisualBridgeMcpError(
        "project.notFound",
        `VisualBridge Project '${normalizedProjectFile}' was not found or is invalid.`,
        discovery.issues,
      );
    }
    return project;
  }

  public async resolveDocument(
    documentPath: string,
    editor: string | undefined,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<DeclaredDocumentContext> {
    const declared = await this.resolveDeclaredDocument(documentPath, editor, projectFile, documentTypeId);
    return {
      ...declared,
      absolutePath: await resolveExistingProjectPath(declared.project, declared.path),
    };
  }

  public async resolveDeclaredDocument(
    documentPath: string,
    editor: string | undefined,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<DeclaredDocumentContext> {
    const project = await this.resolveProject(projectFile);
    const normalizedPath = normalizeRelativePath(documentPath, "path");
    const candidates = findMatchingDocumentTypes(
      project.definition,
      normalizedPath,
      matches,
      {
        ...(editor === undefined ? {} : { editor }),
        ...(documentTypeId === undefined ? {} : { documentTypeId }),
      },
    );
    if (candidates.length !== 1) {
      const subject = editor === undefined ? "Document" : `${editor} Document`;
      throw new VisualBridgeMcpError(
        candidates.length === 0 ? "document.notDeclared" : "document.ambiguousDocumentType",
        candidates.length === 0
          ? `${subject} '${normalizedPath}' is not declared by the selected VisualBridge Project.`
          : `${subject} '${normalizedPath}' matches multiple Document Types; provide documentTypeId.`,
      );
    }
    const absolutePath = path.resolve(project.projectRoot, ...normalizedPath.split("/"));
    ensureInside(project.projectRoot, absolutePath, normalizedPath);
    return {
      project,
      documentType: candidates[0]!,
      path: normalizedPath,
      absolutePath,
    };
  }

  public async resolveDocumentType(
    editor: string | undefined,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<{ readonly project: ProjectContext; readonly documentType: DocumentTypeDefinition }> {
    const project = await this.resolveProject(projectFile);
    const candidates = project.definition.documentTypes.filter((documentType) =>
      (editor === undefined || documentType.editor === editor)
      && (documentTypeId === undefined || documentType.id === documentTypeId),
    );
    if (candidates.length !== 1) {
      throw new VisualBridgeMcpError(
        candidates.length === 0 ? "document.documentTypeNotFound" : "document.ambiguousDocumentType",
        candidates.length === 0
          ? "The selected project does not declare the requested Document Type."
          : "The selected project declares multiple matching Document Types; provide documentTypeId or editor.",
      );
    }
    return { project, documentType: candidates[0]! };
  }

  public async resolveGraphDocument(
    graphPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<GraphDocumentContext> {
    const context = await this.resolveDocument(graphPath, "graph", projectFile, documentTypeId);
    return { ...context, graphPath: context.path, absoluteGraphPath: context.absolutePath };
  }

  public async resolveTableDocument(
    tablePath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<TableDocumentContext> {
    const context = await this.resolveDocument(tablePath, "table", projectFile, documentTypeId);
    return { ...context, tablePath: context.path, absoluteTablePath: context.absolutePath };
  }

  public async resolveStructuredDocument(
    structuredPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<StructuredDocumentContext> {
    const context = await this.resolveDocument(structuredPath, "structured", projectFile, documentTypeId);
    return { ...context, structuredPath: context.path, absoluteStructuredPath: context.absolutePath };
  }

  public async listDeclaredDocuments(
    project: ProjectContext,
    editor?: string,
  ): Promise<readonly DeclaredDocumentContext[]> {
    const paths: string[] = [];
    for (const root of project.definition.documentRoots) {
      const absoluteRoot = path.resolve(project.projectRoot, ...root.split("/"));
      ensureInside(project.projectRoot, absoluteRoot, root);
      await collectDocumentFiles(project.projectRoot, absoluteRoot, paths);
    }
    const uniquePaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
    const result: DeclaredDocumentContext[] = [];
    for (const absolutePath of uniquePaths) {
      const relativePath = path.relative(project.projectRoot, absolutePath).replaceAll("\\", "/");
      const candidates = findMatchingDocumentTypes(
        project.definition,
        relativePath,
        matches,
        editor === undefined ? {} : { editor },
      );
      if (candidates.length === 1) {
        result.push({ project, documentType: candidates[0]!, path: relativePath, absolutePath });
      }
    }
    return result;
  }
}

export async function resolveExistingProjectPath(project: ProjectContext, relativePath: string): Promise<string> {
  const normalizedPath = normalizeRelativePath(relativePath, "path");
  const candidate = path.resolve(project.projectRoot, ...normalizedPath.split("/"));
  ensureInside(project.projectRoot, candidate, normalizedPath);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (errorValue) {
    throw new VisualBridgeMcpError(
      "path.notFound",
      `Project path '${normalizedPath}' is unavailable: ${formatError(errorValue)}`,
    );
  }
  ensureInside(project.projectRoot, resolved, normalizedPath);
  return resolved;
}

export async function resolveAbsentProjectPath(project: ProjectContext, relativePath: string): Promise<string> {
  const normalizedPath = normalizeRelativePath(relativePath, "path");
  const candidate = path.resolve(project.projectRoot, ...normalizedPath.split("/"));
  ensureInside(project.projectRoot, candidate, normalizedPath);
  try {
    await stat(candidate);
    throw new VisualBridgeMcpError("target.exists", `Project path '${normalizedPath}' already exists.`);
  } catch (errorValue) {
    if (errorValue instanceof VisualBridgeMcpError) throw errorValue;
    if (!isNodeError(errorValue, "ENOENT")) throw errorValue;
  }
  let resolvedParent: string;
  try {
    resolvedParent = await realpath(path.dirname(candidate));
  } catch (errorValue) {
    throw new VisualBridgeMcpError(
      "path.parentNotFound",
      `Parent directory for project path '${normalizedPath}' is unavailable: ${formatError(errorValue)}`,
    );
  }
  ensureInside(project.projectRoot, resolvedParent, normalizedPath);
  return path.join(resolvedParent, path.basename(candidate));
}

async function collectProjectFiles(directory: string, result: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === PROJECT_FILE_NAME) {
      result.push(entryPath);
    } else if (entry.isDirectory() && !skippedDirectoryNames.has(entry.name)) {
      await collectProjectFiles(entryPath, result);
    }
  }
}

async function collectDocumentFiles(projectRoot: string, directory: string, result: string[]): Promise<void> {
  let resolvedDirectory: string;
  try {
    resolvedDirectory = await realpath(directory);
  } catch {
    return;
  }
  const relativeDirectory = path.relative(projectRoot, resolvedDirectory);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
    return;
  }
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(resolvedDirectory, entry.name);
    if (entry.isFile() && !isVisualBridgeTransactionArtifact(entry.name)) {
      result.push(entryPath);
    } else if (entry.isDirectory() && !skippedDirectoryNames.has(entry.name)) {
      await collectDocumentFiles(projectRoot, entryPath, result);
    }
  }
}

function isVisualBridgeTransactionArtifact(fileName: string): boolean {
  return fileName === ".visualbridge-transaction.lock"
    || fileName === ".visualbridge-transaction.json"
    || fileName.startsWith(".visualbridge-transaction.lock.")
    || fileName.startsWith(".visualbridge-transaction.json.")
    || (fileName.includes(".visualbridge-") && (fileName.endsWith(".tmp") || fileName.endsWith(".rollback")));
}

function normalizeRelativePath(value: string, label: string): string {
  if (
    value.length === 0
    || value.includes("\\")
    || value.includes(":")
    || value.startsWith("/")
    || path.isAbsolute(value)
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new VisualBridgeMcpError(
      "path.invalid",
      `${label} must be a normalized workspace-relative path using '/' separators.`,
    );
  }
  return value;
}

function ensureInside(root: string, candidate: string, relativePath: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new VisualBridgeMcpError("path.outsideProject", `Path '${relativePath}' leaves the project root.`);
  }
}

function matches(pattern: string, relativePath: string): boolean {
  return minimatch(relativePath, pattern, { dot: true, nocase: process.platform === "win32" });
}

function toWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function decodeUtf8(bytes: Uint8Array, displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    throw new Error(`File '${displayPath}' is not valid UTF-8: ${formatError(errorValue)}`);
  }
}

function isNodeError(errorValue: unknown, code: string): errorValue is NodeJS.ErrnoException {
  return errorValue instanceof Error && "code" in errorValue && errorValue.code === code;
}
