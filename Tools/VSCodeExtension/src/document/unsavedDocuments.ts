import * as vscode from "vscode";
import { ProjectRegistry } from "../project/projectRegistry";
import type { TableEditorProvider } from "../editor/tableEditorProvider";

/** 一个未保存的 VisualBridge 编辑单元（文本文档、项目元数据/Catalog 或 Table 自定义编辑器）。 */
interface UnsavedEntry {
  readonly uri: vscode.Uri;
  readonly kind: "document" | "metadata" | "table";
  readonly label: string;
  readonly description: string;
}

export function collectUnsavedVisualBridgeDocuments(
  projects: ProjectRegistry,
  tableEditorProvider: TableEditorProvider,
): readonly UnsavedEntry[] {
  // 与 Workspace 生命周期闸门（assertProjectClean）同一判定范围：
  // 已解析的语义文档 + Project 标记与 Catalog 元数据 + Table 自定义编辑器。
  const metadataUris = new Set<string>();
  for (const project of projects.projects) {
    metadataUris.add(project.markerUri.toString());
    for (const documentType of project.definition.documentTypes) {
      for (const catalogPath of documentType.catalogs) {
        metadataUris.add(vscode.Uri.joinPath(project.rootUri, ...catalogPath.split("/")).toString());
      }
    }
  }
  const entries: UnsavedEntry[] = [];
  const seen = new Set<string>();
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty) {
      continue;
    }
    const uri = document.uri.toString();
    if (seen.has(uri)) {
      continue;
    }
    const match = projects.resolveDocument(document.uri);
    if (match !== undefined) {
      seen.add(uri);
      entries.push({
        uri: document.uri,
        kind: "document",
        label: vscode.workspace.asRelativePath(document.uri),
        description: `${match.project.definition.projectId} · ${match.documentType.id}`,
      });
    } else if (metadataUris.has(uri)) {
      seen.add(uri);
      entries.push({
        uri: document.uri,
        kind: "metadata",
        label: vscode.workspace.asRelativePath(document.uri),
        description: "Project 元数据 / Catalog",
      });
    }
  }
  for (const tableDocument of tableEditorProvider.listDirtyDocuments()) {
    const uri = tableDocument.uri.toString();
    if (!seen.has(uri)) {
      seen.add(uri);
      entries.push({
        uri: tableDocument.uri,
        kind: "table",
        label: vscode.workspace.asRelativePath(tableDocument.uri),
        description: `${tableDocument.match.project.definition.projectId} · ${tableDocument.match.documentType.id}`,
      });
    }
  }
  return entries.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
}

export async function saveAllUnsavedDocuments(
  projects: ProjectRegistry,
  tableEditorProvider: TableEditorProvider,
): Promise<number> {
  const entries = collectUnsavedVisualBridgeDocuments(projects, tableEditorProvider);
  let saved = 0;
  for (const entry of entries) {
    if (entry.kind === "table") {
      const document = tableEditorProvider.listDirtyDocuments()
        .find((candidate) => candidate.uri.toString() === entry.uri.toString());
      if (document !== undefined) {
        await tableEditorProvider.saveCustomDocument(document);
        saved += 1;
      }
      continue;
    }
    const textDocument = await vscode.workspace.openTextDocument(entry.uri);
    if (textDocument.isDirty && await textDocument.save()) {
      saved += 1;
    }
  }
  return saved;
}

export async function discardAllUnsavedDocuments(
  projects: ProjectRegistry,
  tableEditorProvider: TableEditorProvider,
): Promise<number> {
  const entries = collectUnsavedVisualBridgeDocuments(projects, tableEditorProvider);
  let reverted = 0;
  for (const entry of entries) {
    if (entry.kind === "table") {
      const document = tableEditorProvider.listDirtyDocuments()
        .find((candidate) => candidate.uri.toString() === entry.uri.toString());
      if (document !== undefined) {
        await tableEditorProvider.revertCustomDocument(document);
        reverted += 1;
      }
      continue;
    }
    // workbench.action.files.revert 接受 URI 参数，走 VS Code 原生还原，
    // 才能真正清除文档的未保存标记（直接 applyEdit 同内容不会清 dirty）。
    await vscode.commands.executeCommand("workbench.action.files.revert", entry.uri);
    reverted += 1;
  }
  return reverted;
}

type UnsavedTreeItem = vscode.TreeItem & { readonly entry?: UnsavedEntry };

/** 常驻侧栏的"未保存的 VisualBridge 文档"树视图。 */
export class UnsavedDocumentsTree implements vscode.TreeDataProvider<UnsavedTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void | UnsavedTreeItem>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;
  private view: vscode.TreeView<UnsavedTreeItem> | undefined;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly tableEditorProvider: TableEditorProvider,
  ) {}

  /** 绑定视图实例，用于在标题中实时显示未保存数量。 */
  public attachView(view: vscode.TreeView<UnsavedTreeItem>): void {
    this.view = view;
  }

  public refresh(): void {
    this.updateTitle();
    this.changeEmitter.fire();
  }

  public getTreeItem(element: UnsavedTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): UnsavedTreeItem[] {
    const entries = collectUnsavedVisualBridgeDocuments(this.projects, this.tableEditorProvider);
    if (entries.length === 0) {
      return [{
        label: "没有未保存的 VisualBridge 文档",
        iconPath: new vscode.ThemeIcon("check"),
        collapsibleState: vscode.TreeItemCollapsibleState.None,
      }];
    }
    return entries.map((entry) => ({
      label: entry.label,
      description: entry.description,
      entry,
      iconPath: new vscode.ThemeIcon(entry.kind === "table" ? "table" : "file"),
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      command: {
        command: "vscode.open",
        title: "打开文档",
        arguments: [entry.uri],
      },
    }));
  }

  private updateTitle(): void {
    if (this.view === undefined) {
      return;
    }
    const count = collectUnsavedVisualBridgeDocuments(this.projects, this.tableEditorProvider).length;
    this.view.title = count > 0 ? `Unsaved Documents (${count})` : "Unsaved Documents";
  }
}
