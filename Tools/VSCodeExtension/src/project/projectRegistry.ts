import * as nodePath from "node:path";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import {
  PROJECT_FILE_GLOB,
  type DocumentTypeDefinition,
  type VisualBridgeProjectDefinition,
  parseProjectFile,
} from "@visualbridge/core";

export interface ProjectContext {
  readonly markerUri: vscode.Uri;
  readonly rootUri: vscode.Uri;
  readonly definition: VisualBridgeProjectDefinition;
}

export interface DocumentMatch {
  readonly project: ProjectContext;
  readonly documentType: DocumentTypeDefinition;
  readonly relativePath: string;
}

export class ProjectRegistry implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private projectsValue: readonly ProjectContext[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshVersion = 0;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
  ) {}

  public get projects(): readonly ProjectContext[] {
    return this.projectsValue;
  }

  public async initialize(): Promise<void> {
    const watcher = vscode.workspace.createFileSystemWatcher(PROJECT_FILE_GLOB);
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh()),
    );

    await this.refresh();
  }

  public async refresh(): Promise<void> {
    const refreshVersion = ++this.refreshVersion;
    const markerUris = await vscode.workspace.findFiles(
      PROJECT_FILE_GLOB,
      "**/{.git,node_modules}/**",
    );
    const nextProjects: ProjectContext[] = [];
    const nextDiagnostics = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();

    for (const markerUri of markerUris.sort((left, right) => left.toString().localeCompare(right.toString()))) {
      try {
        const bytes = await vscode.workspace.fs.readFile(markerUri);
        const result = parseProjectFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!result.success) {
          nextDiagnostics.set(markerUri.toString(), {
            uri: markerUri,
            items: result.issues.map(
              (issue) => new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 1),
                `${issue.path}: ${issue.message}`,
                vscode.DiagnosticSeverity.Error,
              ),
            ),
          });
          continue;
        }

        nextProjects.push({
          markerUri,
          rootUri: markerUri.with({ path: nodePath.posix.dirname(markerUri.path) }),
          definition: result.value,
        });
      } catch (error) {
        nextDiagnostics.set(markerUri.toString(), {
          uri: markerUri,
          items: [
            new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              `Unable to read project file: ${formatError(error)}`,
              vscode.DiagnosticSeverity.Error,
            ),
          ],
        });
      }
    }

    const projectIdGroups = new Map<string, ProjectContext[]>();
    for (const project of nextProjects) {
      const group = projectIdGroups.get(project.definition.projectId) ?? [];
      group.push(project);
      projectIdGroups.set(project.definition.projectId, group);
    }
    const duplicateMarkers = new Set<string>();
    for (const [projectId, projects] of projectIdGroups) {
      if (projects.length < 2) {
        continue;
      }

      for (const project of projects) {
        duplicateMarkers.add(project.markerUri.toString());
        nextDiagnostics.set(project.markerUri.toString(), {
          uri: project.markerUri,
          items: [
            new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              `Duplicate projectId '${projectId}' in the current workspace.`,
              vscode.DiagnosticSeverity.Error,
            ),
          ],
        });
      }
    }

    if (refreshVersion !== this.refreshVersion) {
      return;
    }

    this.diagnostics.clear();
    for (const diagnostic of nextDiagnostics.values()) {
      this.diagnostics.set(diagnostic.uri, diagnostic.items);
    }

    this.projectsValue = nextProjects
      .filter((project) => !duplicateMarkers.has(project.markerUri.toString()))
      .sort((left, right) => right.rootUri.path.length - left.rootUri.path.length);

    await vscode.commands.executeCommand(
      "setContext",
      "visualbridge.hasProjects",
      this.projectsValue.length > 0,
    );
    this.output.appendLine(
      `[projects] ${this.projectsValue.length} valid project(s), ${nextDiagnostics.size} invalid marker(s).`,
    );
    this.changeEmitter.fire();
  }

  public resolveDocument(uri: vscode.Uri): DocumentMatch | undefined {
    for (const project of this.projectsValue) {
      const relativePath = getRelativePath(project.rootUri, uri);
      if (relativePath === undefined || !isInDocumentRoots(relativePath, project.definition.documentRoots)) {
        continue;
      }

      for (const documentType of project.definition.documentTypes) {
        const matchesInclude = documentType.include.some((pattern) => matches(pattern, relativePath));
        const matchesExclude = documentType.exclude.some((pattern) => matches(pattern, relativePath));
        if (matchesInclude && !matchesExclude) {
          return { project, documentType, relativePath };
        }
      }
    }

    return undefined;
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch((error: unknown) => {
        this.output.appendLine(`[projects] Refresh failed: ${formatError(error)}`);
      });
    }, 100);
  }
}

function getRelativePath(rootUri: vscode.Uri, documentUri: vscode.Uri): string | undefined {
  if (rootUri.scheme !== documentUri.scheme || rootUri.authority !== documentUri.authority) {
    return undefined;
  }

  const relativePath = rootUri.scheme === "file"
    ? nodePath.relative(rootUri.fsPath, documentUri.fsPath)
    : nodePath.posix.relative(rootUri.path, documentUri.path);

  const normalizedPath = relativePath.replaceAll("\\", "/");
  if (
    normalizedPath === ""
    || normalizedPath === ".."
    || normalizedPath.startsWith("../")
    || nodePath.posix.isAbsolute(normalizedPath)
  ) {
    return undefined;
  }

  return normalizedPath;
}

function isInDocumentRoots(relativePath: string, documentRoots: readonly string[]): boolean {
  return documentRoots.some(
    (root) => root === "." || relativePath === root || relativePath.startsWith(`${root}/`),
  );
}

function matches(pattern: string, relativePath: string): boolean {
  return minimatch(relativePath, pattern, {
    dot: true,
    nocase: process.platform === "win32",
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
