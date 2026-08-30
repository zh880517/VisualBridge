import * as vscode from "vscode";
import type {
  CatalogSourceDefinition,
  DocumentDiagnostic,
  DocumentTypeDefinition,
  ProjectFileIssue,
} from "@visualbridge/core";
import { compareUtf16CodeUnits } from "@visualbridge/core";
import type { EntityCatalog, EntityCatalogRegistry } from "@visualbridge/entity";
import type { GraphCatalog, GraphCatalogRegistry } from "@visualbridge/graph";
import {
  resolveStructuredConfigType,
  type StructuredCatalog,
  type StructuredCatalogRegistry,
} from "@visualbridge/structured";
import { resolveTableType, type TableCatalog, type TableCatalogRegistry } from "@visualbridge/table";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import { catalogDiagnosticSourceIndex, type CatalogRegistryLoadResult } from "./catalogRegistryLoader";
import { loadEntityCatalogRegistry } from "./entityCatalogLoader";
import { loadGraphCatalogRegistry } from "./graphCatalogLoader";
import { loadStructuredCatalogRegistry } from "./structuredCatalogLoader";
import { loadTableCatalogRegistry } from "./tableCatalogLoader";

export interface CatalogDefinitionSnapshot {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
}

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

export async function validateCatalogBindings(project: ProjectContext): Promise<readonly ProjectFileIssue[]> {
  const issues: ProjectFileIssue[] = [];
  for (const [documentTypeIndex, documentType] of project.definition.documentTypes.entries()) {
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

async function loadSnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
): Promise<CatalogRegistrySnapshot | undefined> {
  switch (documentType.editor) {
    case "graph":
      return graphSnapshot(project, documentType, await loadGraphCatalogRegistry(project, documentType.catalogs));
    case "entity":
      return entitySnapshot(project, documentType, await loadEntityCatalogRegistry(project, documentType.catalogs));
    case "structured":
      return loadStructuredSnapshot(project, documentType);
    case "table":
      return loadTableSnapshot(project, documentType);
    default:
      return undefined;
  }
}

async function loadStructuredSnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
): Promise<CatalogRegistrySnapshot> {
  const result = await loadStructuredCatalogRegistry(project, documentType.catalogs);
  const base = structuredSnapshot(project, documentType, result);
  return result.ready && resolveStructuredConfigType(result.registry, documentType.id) === undefined
    ? withBindingError(
      base,
      "projectCatalog.structuredTypeMissing",
      `Structured Document Type '${documentType.id}' does not resolve to a Config Type ID or alias in its Catalog Registry.`,
    )
    : base;
}

async function loadTableSnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
): Promise<CatalogRegistrySnapshot> {
  const result = await loadTableCatalogRegistry(project, documentType.catalogs);
  const base = tableSnapshot(project, documentType, result);
  return result.ready && resolveTableType(result.registry, documentType.id) === undefined
    ? withBindingError(
      base,
      "projectCatalog.tableTypeMissing",
      `Table Document Type '${documentType.id}' does not resolve to a Table Type ID or alias in its Catalog Registry.`,
    )
    : base;
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

function graphSnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  result: CatalogRegistryLoadResult<GraphCatalog, GraphCatalogRegistry>,
): CatalogRegistrySnapshot {
  return snapshot(project, documentType, result,
    (catalog) => [
      ...catalog.dataTypes.map((entry) => definition("dataType", entry)),
      ...catalog.graphTypes.map((entry) => definition("graphType", entry)),
      ...catalog.nodeTypes.map((entry) => definition("nodeType", entry)),
    ],
    [
      ...result.registry.dataTypes.map((entry) => definition("dataType", entry)),
      ...result.registry.graphTypes.map((entry) => definition("graphType", entry)),
      ...result.registry.nodeTypes.map((entry) => definition("nodeType", entry)),
    ]);
}

function entitySnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  result: CatalogRegistryLoadResult<EntityCatalog, EntityCatalogRegistry>,
): CatalogRegistrySnapshot {
  return snapshot(project, documentType, result,
    (catalog) => [
      ...catalog.componentGroups.map((entry) => definition("componentGroup", entry)),
      ...catalog.entityTypes.map((entry) => definition("entityType", entry)),
      ...catalog.componentTypes.map((entry) => definition("componentType", entry)),
    ],
    [
      ...result.registry.componentGroups.map((entry) => definition("componentGroup", entry)),
      ...result.registry.entityTypes.map((entry) => definition("entityType", entry)),
      ...result.registry.componentTypes.map((entry) => definition("componentType", entry)),
    ]);
}

function structuredSnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  result: CatalogRegistryLoadResult<StructuredCatalog, StructuredCatalogRegistry>,
): CatalogRegistrySnapshot {
  return snapshot(
    project,
    documentType,
    result,
    (catalog) => catalog.configTypes.map((entry) => definition("configType", entry)),
    result.registry.configTypes.map((entry) => definition("configType", entry)),
  );
}

function tableSnapshot(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  result: CatalogRegistryLoadResult<TableCatalog, TableCatalogRegistry>,
): CatalogRegistrySnapshot {
  return snapshot(
    project,
    documentType,
    result,
    (catalog) => catalog.tableTypes.map((entry) => definition("tableType", entry)),
    result.registry.tableTypes.map((entry) => definition("tableType", entry)),
  );
}

function snapshot<TCatalog extends { readonly catalogId: string; readonly title: string; readonly source: CatalogSourceDefinition }, TRegistry>(
  project: ProjectContext,
  documentType: DocumentTypeDefinition,
  result: CatalogRegistryLoadResult<TCatalog, TRegistry>,
  definitions: (catalog: TCatalog) => readonly CatalogDefinitionSnapshot[],
  registryDefinitions: readonly CatalogDefinitionSnapshot[],
): CatalogRegistrySnapshot {
  return {
    projectId: project.definition.projectId,
    documentTypeId: documentType.id,
    editor: documentType.editor,
    ready: result.ready,
    definitions: sortDefinitions(registryDefinitions),
    sources: result.sources.map((source) => ({
      path: source.path,
      definitions: source.catalog === undefined ? [] : sortDefinitions(definitions(source.catalog)),
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

function definition(
  kind: string,
  entry: { readonly id: string; readonly title: string; readonly aliases?: readonly string[] },
): CatalogDefinitionSnapshot {
  return { kind, id: entry.id, title: entry.title, aliases: [...entry.aliases ?? []].sort(compareUtf16CodeUnits) };
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
