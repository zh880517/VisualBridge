import { readdir, readFile, realpath } from "node:fs/promises";
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

const skippedDirectoryNames = new Set([".codegraph", ".git", "Library", "node_modules"]);

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

export interface GraphDocumentContext {
  readonly project: ProjectContext;
  readonly documentType: DocumentTypeDefinition;
  readonly graphPath: string;
  readonly absoluteGraphPath: string;
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

  public async resolveGraphDocument(
    graphPath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<GraphDocumentContext> {
    const project = await this.resolveProject(projectFile);
    const normalizedGraphPath = normalizeRelativePath(graphPath, "path");
    const candidates = findMatchingDocumentTypes(
      project.definition,
      normalizedGraphPath,
      matches,
      {
        editor: "graph",
        ...(documentTypeId === undefined ? {} : { documentTypeId }),
      },
    );
    if (candidates.length !== 1) {
      throw new VisualBridgeMcpError(
        candidates.length === 0 ? "graph.notDeclared" : "graph.ambiguousDocumentType",
        candidates.length === 0
          ? `Graph '${normalizedGraphPath}' is not declared by the selected VisualBridge Project.`
          : `Graph '${normalizedGraphPath}' matches multiple Graph Document Types; provide documentTypeId.`,
      );
    }
    return {
      project,
      documentType: candidates[0]!,
      graphPath: normalizedGraphPath,
      absoluteGraphPath: await resolveExistingProjectPath(project, normalizedGraphPath),
    };
  }

  public async resolveGraphDocumentType(
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<{ readonly project: ProjectContext; readonly documentType: DocumentTypeDefinition }> {
    const project = await this.resolveProject(projectFile);
    const candidates = project.definition.documentTypes.filter((documentType) =>
      documentType.editor === "graph" && (documentTypeId === undefined || documentType.id === documentTypeId),
    );
    if (candidates.length !== 1) {
      throw new VisualBridgeMcpError(
        candidates.length === 0 ? "graph.documentTypeNotFound" : "graph.ambiguousDocumentType",
        candidates.length === 0
          ? "The selected project does not declare the requested Graph Document Type."
          : "The selected project declares multiple Graph Document Types; provide documentTypeId.",
      );
    }
    return { project, documentType: candidates[0]! };
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

function normalizeRelativePath(value: string, label: string): string {
  if (
    value.length === 0
    || value.includes("\\")
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
