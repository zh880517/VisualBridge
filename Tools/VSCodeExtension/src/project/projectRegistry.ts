import * as nodePath from "node:path";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import {
  compareUtf16CodeUnits,
  PROJECT_FILE_GLOB,
  type DocumentTypeDefinition,
  type VisualBridgeProjectDefinition,
  findMatchingDocumentTypes,
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

    for (const markerUri of markerUris.sort((left, right) => compareUtf16CodeUnits(left.toString(), right.toString()))) {
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
        const project = nextProjects[nextProjects.length - 1]!;
        const workspaceIssues = await validateProjectWorkspace(project);
        if (workspaceIssues.length > 0) {
          nextDiagnostics.set(markerUri.toString(), {
            uri: markerUri,
            items: workspaceIssues.map((message) => new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              message,
              vscode.DiagnosticSeverity.Error,
            )),
          });
        }
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
      if (relativePath === undefined) {
        continue;
      }

      const documentTypes = findMatchingDocumentTypes(
        project.definition,
        relativePath,
        matches,
      );
      if (documentTypes.length > 1) {
        this.output.appendLine(
          `[projects] '${relativePath}' matches multiple Document Types in '${project.definition.projectId}': ${documentTypes.map((documentType) => documentType.id).join(", ")}.`,
        );
        return undefined;
      }
      const documentType = documentTypes[0];
      if (documentType !== undefined) {
        return { project, documentType, relativePath };
      }
    }

    return undefined;
  }

  public async listAuthoringSourcePaths(project: ProjectContext): Promise<readonly string[]> {
    const paths = new Set<string>([
      nodePath.posix.basename(project.markerUri.path),
      ...project.definition.documentTypes.flatMap((documentType) => documentType.catalogs),
    ]);
    for (const documentType of project.definition.documentTypes) {
      for (const include of documentType.include) {
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(project.rootUri, include));
        for (const uri of uris) {
          const relativePath = getRelativePath(project.rootUri, uri);
          if (relativePath !== undefined
            && documentType.include.some((pattern) => matches(pattern, relativePath))
            && !documentType.exclude.some((pattern) => matches(pattern, relativePath))) {
            paths.add(relativePath);
          }
        }
      }
    }
    return [...paths].sort(compareUtf16CodeUnits);
  }

  public validateDefinition(
    markerUri: vscode.Uri,
    definition: VisualBridgeProjectDefinition,
  ): Promise<readonly string[]> {
    return validateProjectWorkspace({
      markerUri,
      rootUri: markerUri.with({ path: nodePath.posix.dirname(markerUri.path) }),
      definition,
    });
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
  const relativePath = getLexicalRelativePath(rootUri, documentUri);
  if (relativePath === undefined) return undefined;
  if (rootUri.scheme === "file") {
    const canonicalRoot = canonicalizePath(rootUri.fsPath);
    const canonicalDocument = canonicalizePath(documentUri.fsPath);
    if (canonicalRoot === undefined
      || canonicalDocument === undefined
      || !isPathInside(canonicalRoot, canonicalDocument)) {
      return undefined;
    }
  }
  return relativePath;
}

function getLexicalRelativePath(rootUri: vscode.Uri, documentUri: vscode.Uri): string | undefined {
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

function canonicalizePath(candidatePath: string): string | undefined {
  let cursor = nodePath.resolve(candidatePath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return nodePath.resolve(realpathSync.native(cursor), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = nodePath.dirname(cursor);
      if (parent === cursor) return undefined;
      missingSegments.unshift(nodePath.basename(cursor));
      cursor = parent;
    }
  }
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

async function validateProjectWorkspace(project: ProjectContext): Promise<readonly string[]> {
  const issues: string[] = [];
  const includePatterns: Array<{
    readonly documentTypeId: string;
    readonly documentTypeIndex: number;
    readonly pattern: string;
    readonly patternIndex: number;
  }> = [];
  for (const [index, documentType] of project.definition.documentTypes.entries()) {
    for (const [patternIndex, pattern] of documentType.include.entries()) {
      includePatterns.push({
        documentTypeId: documentType.id,
        documentTypeIndex: index,
        pattern,
        patternIndex,
      });
    }
  }
  for (let rightIndex = 0; rightIndex < includePatterns.length; rightIndex += 1) {
    const right = includePatterns[rightIndex]!;
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const left = includePatterns[leftIndex]!;
      if (left.documentTypeId === right.documentTypeId) continue;
      const witness = findGlobOverlapWitness(left.pattern, right.pattern);
      if (witness !== undefined) {
        issues.push(
          left.pattern === right.pattern
            ? `documentTypes[${right.documentTypeIndex}].include[${right.patternIndex}]: Glob '${right.pattern}' overlaps the identical include in Document Type '${left.documentTypeId}'.`
            : `documentTypes[${right.documentTypeIndex}].include[${right.patternIndex}]: Glob '${right.pattern}' overlaps Document Type '${left.documentTypeId}' (for example '${witness}').`,
        );
      }
    }
  }

  const catalogEditors = new Map<string, string>();
  for (const [documentTypeIndex, documentType] of project.definition.documentTypes.entries()) {
    for (const [catalogIndex, catalogPath] of documentType.catalogs.entries()) {
      const previousEditor = catalogEditors.get(catalogPath);
      if (previousEditor !== undefined && previousEditor !== documentType.editor) {
        issues.push(
          `documentTypes[${documentTypeIndex}].catalogs[${catalogIndex}]: Catalog '${catalogPath}' is bound to both '${previousEditor}' and '${documentType.editor}' editors.`,
        );
      } else {
        catalogEditors.set(catalogPath, documentType.editor);
      }
    }
  }

  const candidatePaths = new Set<string>();
  for (const [documentTypeIndex, documentType] of project.definition.documentTypes.entries()) {
    for (const [patternIndex, pattern] of documentType.include.entries()) {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(project.rootUri, pattern));
      for (const uri of uris) {
        const relativePath = getRelativePath(project.rootUri, uri);
        if (relativePath !== undefined) {
          candidatePaths.add(relativePath);
        } else if (getLexicalRelativePath(project.rootUri, uri) !== undefined) {
          issues.push(`documentTypes[${documentTypeIndex}].include[${patternIndex}]: A matched Authoring source resolves outside the Project root.`);
        }
      }
    }
  }
  for (const relativePath of [...candidatePaths].sort(compareUtf16CodeUnits)) {
    const owners = findMatchingDocumentTypes(project.definition, relativePath, matches);
    if (owners.length > 1) {
      issues.push(
        `documentTypes: '${relativePath}' has ambiguous ownership across ${owners.map((owner) => `'${owner.id}'`).join(", ")}.`,
      );
    }
  }

  const declaredPaths = [
      ...project.definition.documentRoots.map((path, index) => ({ path: `documentRoots[${index}]`, value: path })),
      ...project.definition.documentTypes.flatMap((documentType, documentTypeIndex) => documentType.catalogs.map(
        (catalog, catalogIndex) => ({ path: `documentTypes[${documentTypeIndex}].catalogs[${catalogIndex}]`, value: catalog }),
      )),
      ...project.definition.providers.map((provider, providerIndex) => ({
        path: `providers[${providerIndex}].entry`,
        value: provider.entry,
      })),
  ];
  for (const declared of declaredPaths) {
    const uri = vscode.Uri.joinPath(project.rootUri, ...declared.value.split("/"));
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (error) {
      issues.push(`${declared.path}: '${declared.value}' is unavailable: ${formatError(error)}`);
    }
  }

  if (project.rootUri.scheme === "file") {
    const canonicalRoot = await realpath(project.rootUri.fsPath).catch(() => nodePath.resolve(project.rootUri.fsPath));
    for (const declared of declaredPaths) {
      const candidatePath = nodePath.resolve(project.rootUri.fsPath, ...declared.value.split("/"));
      const canonicalCandidate = await realpath(candidatePath).catch(() => candidatePath);
      if (!isPathInside(canonicalRoot, canonicalCandidate)) {
        issues.push(`${declared.path}: '${declared.value}' resolves outside the Project root.`);
      }
    }
  }

  return [...new Set(issues)].sort(compareUtf16CodeUnits);
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = nodePath.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${nodePath.sep}`) && relative !== ".." && !nodePath.isAbsolute(relative));
}

function findGlobOverlapWitness(left: string, right: string): string | undefined {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const queue: Array<{ readonly leftIndex: number; readonly rightIndex: number; readonly path: readonly string[] }> = [{
    leftIndex: 0,
    rightIndex: 0,
    path: [],
  }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const state = queue.shift()!;
    const key = `${state.leftIndex}:${state.rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (state.leftIndex === leftSegments.length && state.rightIndex === rightSegments.length) {
      const candidate = state.path.length === 0 ? "x" : state.path.join("/");
      return matches(left, candidate) && matches(right, candidate) ? candidate : undefined;
    }
    const leftSegment = leftSegments[state.leftIndex];
    const rightSegment = rightSegments[state.rightIndex];
    if (leftSegment === "**") {
      queue.push({ ...state, leftIndex: state.leftIndex + 1 });
      if (rightSegment !== undefined && rightSegment !== "**") {
        queue.push({
          leftIndex: state.leftIndex,
          rightIndex: state.rightIndex + 1,
          path: [...state.path, materializeSegment(rightSegment)],
        });
      }
    }
    if (rightSegment === "**") {
      queue.push({ ...state, rightIndex: state.rightIndex + 1 });
      if (leftSegment !== undefined && leftSegment !== "**") {
        queue.push({
          leftIndex: state.leftIndex + 1,
          rightIndex: state.rightIndex,
          path: [...state.path, materializeSegment(leftSegment)],
        });
      }
    }
    if (leftSegment !== undefined
      && rightSegment !== undefined
      && leftSegment !== "**"
      && rightSegment !== "**") {
      const witness = intersectSegments(leftSegment, rightSegment);
      if (witness !== undefined) {
        queue.push({
          leftIndex: state.leftIndex + 1,
          rightIndex: state.rightIndex + 1,
          path: [...state.path, witness],
        });
      }
    }
  }
  return undefined;
}

function intersectSegments(left: string, right: string): string | undefined {
  const leftParts = splitSegmentPattern(left);
  const rightParts = splitSegmentPattern(right);
  if (leftParts === undefined && rightParts === undefined) return left === right ? left : undefined;
  if (leftParts === undefined) return segmentMatches(right, left) ? left : undefined;
  if (rightParts === undefined) return segmentMatches(left, right) ? right : undefined;
  const normalizedLeftPrefix = normalizeGlobCase(leftParts.prefix);
  const normalizedRightPrefix = normalizeGlobCase(rightParts.prefix);
  const prefix = normalizedLeftPrefix.startsWith(normalizedRightPrefix)
    ? leftParts.prefix
    : normalizedRightPrefix.startsWith(normalizedLeftPrefix)
      ? rightParts.prefix
      : undefined;
  const normalizedLeftSuffix = normalizeGlobCase(leftParts.suffix);
  const normalizedRightSuffix = normalizeGlobCase(rightParts.suffix);
  const suffix = normalizedLeftSuffix.endsWith(normalizedRightSuffix)
    ? leftParts.suffix
    : normalizedRightSuffix.endsWith(normalizedLeftSuffix)
      ? rightParts.suffix
      : undefined;
  if (prefix === undefined || suffix === undefined) return undefined;
  const candidate = `${prefix}x${suffix}`;
  return segmentMatches(left, candidate) && segmentMatches(right, candidate) ? candidate : undefined;
}

function splitSegmentPattern(pattern: string): { readonly prefix: string; readonly suffix: string } | undefined {
  const starIndex = pattern.indexOf("*");
  return starIndex < 0 ? undefined : {
    prefix: pattern.slice(0, starIndex),
    suffix: pattern.slice(starIndex + 1),
  };
}

function materializeSegment(pattern: string): string {
  const parts = splitSegmentPattern(pattern);
  return parts === undefined ? pattern : `${parts.prefix}x${parts.suffix}`;
}

function segmentMatches(pattern: string, candidate: string): boolean {
  return minimatch(candidate, pattern, { dot: true, nocase: process.platform === "win32", nonegate: true });
}

function normalizeGlobCase(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
