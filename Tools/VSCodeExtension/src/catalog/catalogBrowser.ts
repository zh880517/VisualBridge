import * as vscode from "vscode";
import type {
  CatalogSourceDefinition,
  DocumentDiagnostic,
  DocumentTypeDefinition,
  ProjectFileIssue,
} from "@visualbridge/core";
import { compareUtf16CodeUnits } from "@visualbridge/core";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type { HostModuleRegistry } from "../modules/hostModuleRegistry";
import { catalogFacetFor, loadDocumentTypeCatalogRegistry } from "../modules/documentFacetRegistry";
import {
  catalogDiagnosticSourceIndex,
  type CatalogDefinitionEntry,
  type CatalogFacet,
  type CatalogRegistryLoadResult,
  type CatalogWithSource,
} from "./catalogRegistryLoader";

/** Catalog 视图里的一条定义；形状由模块 `catalog` facet 决定，宿主不自带领域列表。 */
export type CatalogDefinitionSnapshot = CatalogDefinitionEntry;

export interface CatalogSourceSnapshot {
  readonly path: string;
  readonly catalogId?: string;
  readonly title?: string;
  readonly contentHash?: string;
  readonly source?: CatalogSourceDefinition;
  readonly definitions: readonly CatalogDefinitionSnapshot[];
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export interface CatalogRegistrySnapshot {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly editor: string;
  readonly ready: boolean;
  readonly definitions: readonly CatalogDefinitionSnapshot[];
  readonly sources: readonly CatalogSourceSnapshot[];
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export class CatalogBrowser implements vscode.TreeDataProvider<CatalogBrowserNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<CatalogBrowserNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private rootsValue: readonly CatalogBrowserNode[] = [];
  private snapshotsValue: readonly CatalogRegistrySnapshot[] = [];
  private refreshPromise: Promise<void> | undefined;
  private refreshRequested = false;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly modules: HostModuleRegistry,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(this.projects.onDidChange(() => void this.refresh()));
  }

  public getTreeItem(element: CatalogBrowserNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: CatalogBrowserNode): Promise<CatalogBrowserNode[]> {
    if (element !== undefined) return [...element.children];
    if (this.rootsValue.length === 0 && this.projects.projects.length > 0) await this.refresh();
    return [...this.rootsValue];
  }

  public async refresh(): Promise<void> {
    if (this.refreshPromise !== undefined) {
      this.refreshRequested = true;
      return this.refreshPromise;
    }
    const promise = this.refreshLoop().finally(() => {
      if (this.refreshPromise === promise) this.refreshPromise = undefined;
    });
    this.refreshPromise = promise;
    return promise;
  }

  private async refreshLoop(): Promise<void> {
    do {
      this.refreshRequested = false;
      await this.refreshOnce();
    } while (this.refreshRequested);
  }

  public async snapshot(): Promise<readonly CatalogRegistrySnapshot[]> {
    await this.refresh();
    return this.snapshotsValue;
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.changeEmitter.dispose();
  }

  private async refreshOnce(): Promise<void> {
    const snapshots: CatalogRegistrySnapshot[] = [];
    for (const project of [...this.projects.projects].sort((left, right) => compareUtf16CodeUnits(
      left.definition.projectId,
      right.definition.projectId,
    ))) {
      for (const documentType of [...project.definition.documentTypes].sort((left, right) => compareUtf16CodeUnits(left.id, right.id))) {
        // 没有已加载的模块就没有该 editor 的 Catalog 解析能力（Restricted Mode 不解析）。
        if (this.modules.editorAvailability(project, documentType.editor).kind !== "available") continue;
        const snapshot = await loadSnapshot(project, documentType);
        if (snapshot !== undefined) snapshots.push(snapshot);
      }
    }
    this.snapshotsValue = snapshots;
    this.rootsValue = createTree(snapshots, this.projects.projects);
    this.publishDiagnostics(snapshots);
    this.output.appendLine(`[catalogs] ${snapshots.length} Registry binding(s) refreshed.`);
    this.changeEmitter.fire(undefined);
  }

  private publishDiagnostics(snapshots: readonly CatalogRegistrySnapshot[]): void {
    const byUri = new Map<string, { readonly uri: vscode.Uri; readonly diagnostics: vscode.Diagnostic[] }>();
    for (const snapshot of snapshots) {
      const project = this.projects.projects.find((entry) => entry.definition.projectId === snapshot.projectId);
      const documentType = project?.definition.documentTypes.find((entry) => entry.id === snapshot.documentTypeId);
      if (project === undefined || documentType === undefined) continue;
      for (const diagnostic of snapshot.diagnostics) {
        const sourceIndex = catalogDiagnosticSourceIndex(diagnostic.path);
        const path = sourceIndex === undefined ? undefined : documentType.catalogs[sourceIndex];
        const uri = path === undefined
          ? project.markerUri
          : vscode.Uri.joinPath(project.rootUri, ...path.split("/"));
        const key = uri.toString();
        const entry = byUri.get(key) ?? { uri, diagnostics: [] };
        const item = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `[${documentType.id}] ${diagnostic.path}: ${diagnostic.message}`,
          severity(diagnostic.severity),
        );
        item.code = diagnostic.code;
        item.source = "VisualBridge Catalog";
        entry.diagnostics.push(item);
        byUri.set(key, entry);
      }
    }
    this.diagnostics.clear();
    for (const entry of byUri.values()) this.diagnostics.set(entry.uri, entry.diagnostics);
  }
}

/**
 * 校验工程里 Catalog 绑定是否可解析。
 *
 * `isEditorAvailable` 必须由调用方按模块注册表提供：模块未加载（Restricted Mode / failed /
 * disabled）时不得解析领域 Catalog——没有模块就没有 Catalog 能力（附录 D.6）。
 */
export async function validateCatalogBindings(
  project: ProjectContext,
  isEditorAvailable?: (project: ProjectContext, documentType: DocumentTypeDefinition) => boolean,
): Promise<readonly ProjectFileIssue[]> {
  const issues: ProjectFileIssue[] = [];
  for (const [documentTypeIndex, documentType] of project.definition.documentTypes.entries()) {
    if (isEditorAvailable !== undefined && !isEditorAvailable(project, documentType)) continue;
    const loaded = await loadSnapshot(project, documentType);
    if (loaded === undefined) continue;
    for (const diagnostic of loaded.diagnostics) {
      if (diagnostic.severity !== "error") continue;
      issues.push({
        path: `documentTypes[${documentTypeIndex}].${diagnostic.path}`,
        message: diagnostic.message,
      });
    }
  }
  return issues;
}

export class CatalogBrowserNode extends vscode.TreeItem {
  public constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children: readonly CatalogBrowserNode[] = [],
    options: {
      readonly description?: string;
      readonly tooltip?: string;
      readonly icon?: string;
      readonly contextValue?: string;
      readonly uri?: vscode.Uri;
    } = {},
  ) {
    super(label, collapsibleState);
    if (options.description !== undefined) this.description = options.description;
    if (options.tooltip !== undefined) this.tooltip = options.tooltip;
    if (options.icon !== undefined) this.iconPath = new vscode.ThemeIcon(options.icon);
    if (options.contextValue !== undefined) this.contextValue = options.contextValue;
    if (options.uri !== undefined) {
      this.resourceUri = options.uri;
      this.command = {
        command: "visualbridge.catalogBrowser.open",
        title: "Open Catalog",
        arguments: [options.uri],
      };
    }
  }
}

/**
 * 按 Document Type 的 editor 找到模块 `catalog` facet，再让 facet 决定解析、定义与绑定校验。
 *
 * 没有 facet（模块未登记的领域）时返回 `undefined`，Catalog 视图直接跳过该 Document Type。
 */
async function loadSnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
): Promise<CatalogRegistrySnapshot | undefined> {
  const facet = catalogFacetFor(documentType.editor);
  const loading = loadDocumentTypeCatalogRegistry(project, documentType);
  if (facet === undefined || loading === undefined) return undefined;
  const result = await loading;
  const base = snapshot(project, documentType, result, facet);
  const issue = result.ready ? facet.bindingIssue?.(result.registry, documentType.id) : undefined;
  return issue === undefined ? base : withBindingError(base, issue.code, issue.message);
}

function withBindingError(
  snapshot: CatalogRegistrySnapshot,
  code: string,
  message: string,
): CatalogRegistrySnapshot {
  return {
    ...snapshot,
    ready: false,
    diagnostics: [...snapshot.diagnostics, {
      severity: "error",
      code,
      path: "binding",
      message,
    }],
  };
}

function snapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  result: CatalogRegistryLoadResult<CatalogWithSource, unknown>,
  facet: CatalogFacet<CatalogWithSource, unknown>,
): CatalogRegistrySnapshot {
  return {
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    editor: documentType.editor,
    ready: result.ready,
    definitions: sortDefinitions(facet.registryDefinitions(result.registry)),
    sources: result.sources.map((source) => ({
      path: source.path,
      definitions: source.catalog === undefined ? [] : sortDefinitions(facet.definitions(source.catalog)),
      ...(source.catalog === undefined ? {} : {
        catalogId: source.catalog.catalogId,
        title: source.catalog.title,
        source: source.catalog.source,
      }),
      ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash }),
      diagnostics: source.diagnostics,
    })),
    diagnostics: result.diagnostics,
  };
}

function createTree(
  snapshots: readonly CatalogRegistrySnapshot[],
  projects: readonly ProjectContext[],
): readonly CatalogBrowserNode[] {
  return [...new Set(snapshots.map((snapshot) => snapshot.projectId))].sort(compareUtf16CodeUnits).map((projectId) => {
    const project = projects.find((entry) => entry.definition.projectId === projectId);
    const registryNodes = snapshots.filter((snapshot) => snapshot.projectId === projectId).map((snapshot) => {
      const sourceNodes = snapshot.sources.map((source) => {
        const uri = project === undefined ? undefined : vscode.Uri.joinPath(project.rootUri, ...source.path.split("/"));
        const metadata = [
          leaf(`Status: ${source.source?.status ?? "invalid"}`, source.source?.status === "stale" ? "warning" : "pulse"),
          ...(source.source !== undefined && source.source.status !== "unknown"
            ? [leaf(`Provider: ${source.source.providerId}`, "plug"), leaf(`Source Hash: ${source.source.sourceHash}`, "fingerprint")]
            : []),
          ...(source.source?.status === "stale" ? [leaf(`Current Source Hash: ${source.source.currentSourceHash}`, "warning")] : []),
          ...(source.contentHash === undefined ? [] : [leaf(`Content Hash: ${source.contentHash}`, "file-binary")]),
          definitionsNode(source.definitions),
          diagnosticsNode(source.diagnostics),
        ];
        return new CatalogBrowserNode(
          source.title ?? source.path,
          vscode.TreeItemCollapsibleState.Collapsed,
          metadata,
          {
            description: source.catalogId ?? "invalid",
            tooltip: source.path,
            icon: source.source?.status === "stale" ? "warning" : "library",
            contextValue: "visualbridge.catalogSource",
            ...(uri === undefined ? {} : { uri }),
          },
        );
      });
      const registryChildren = [
        definitionsNode(snapshot.definitions),
        diagnosticsNode(snapshot.diagnostics),
        ...sourceNodes,
      ];
      return new CatalogBrowserNode(
        snapshot.documentTypeId,
        vscode.TreeItemCollapsibleState.Collapsed,
        registryChildren,
        {
          description: `${snapshot.editor} · ${snapshot.ready ? "ready" : "conflict"}`,
          icon: snapshot.ready ? "server-process" : "error",
          contextValue: "visualbridge.catalogRegistry",
        },
      );
    });
    return new CatalogBrowserNode(projectId, vscode.TreeItemCollapsibleState.Expanded, registryNodes, {
      icon: "root-folder",
      contextValue: "visualbridge.catalogProject",
    });
  });
}

function definitionsNode(definitions: readonly CatalogDefinitionSnapshot[]): CatalogBrowserNode {
  return new CatalogBrowserNode(
    "Types",
    definitions.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    definitions.map((entry) => new CatalogBrowserNode(
      entry.title,
      entry.aliases.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
      entry.aliases.map((alias) => leaf(alias, "symbol-key")),
      { description: `${entry.kind} · ${entry.id}`, icon: "symbol-class" },
    )),
    { description: String(definitions.length), icon: "symbol-namespace" },
  );
}

function diagnosticsNode(diagnostics: readonly DocumentDiagnostic[]): CatalogBrowserNode {
  return new CatalogBrowserNode(
    "Diagnostics",
    diagnostics.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    diagnostics.map((diagnostic) => new CatalogBrowserNode(
      diagnostic.message,
      vscode.TreeItemCollapsibleState.None,
      [],
      { description: diagnostic.path, icon: diagnostic.severity === "error" ? "error" : "warning" },
    )),
    { description: String(diagnostics.length), icon: diagnostics.some((entry) => entry.severity === "error") ? "error" : "warning" },
  );
}

function leaf(label: string, icon: string): CatalogBrowserNode {
  return new CatalogBrowserNode(label, vscode.TreeItemCollapsibleState.None, [], { icon });
}

function sortDefinitions(definitions: readonly CatalogDefinitionSnapshot[]): readonly CatalogDefinitionSnapshot[] {
  return [...definitions].sort((left, right) => compareUtf16CodeUnits(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`));
}

function severity(value: DocumentDiagnostic["severity"]): vscode.DiagnosticSeverity {
  return value === "error"
    ? vscode.DiagnosticSeverity.Error
    : value === "warning"
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
}
