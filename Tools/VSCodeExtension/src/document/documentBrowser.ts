import * as vscode from "vscode";
import type {
  DocumentDiagnostic,
  DocumentTypeDefinition,
  IndexedDocument,
  IndexedDocumentReference,
} from "@visualbridge/core";
import { createDocument } from "../commands/createDocument";
import type { CreateDocumentSelection } from "../commands/createDocumentSupport";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import {
  WorkspaceDocumentIndex,
  type IncomingDocumentReference,
} from "./workspaceDocumentIndex";

export const DOCUMENT_BROWSER_VIEW_ID = "visualbridge.documents";

type DocumentBrowserNode =
  | ProjectNode
  | DocumentTypeNode
  | ProblemsNode
  | DocumentNode
  | DetailGroupNode
  | DiagnosticNode
  | ReferenceNode
  | SourceNode
  | EmptyNode;

interface ProjectNode {
  readonly kind: "project";
  readonly project: ProjectContext;
}

interface DocumentTypeNode {
  readonly kind: "documentType";
  readonly project: ProjectContext;
  readonly documentType: DocumentTypeDefinition;
}

interface ProblemsNode {
  readonly kind: "problems";
  readonly project: ProjectContext;
  readonly documents: readonly IndexedDocument[];
}

interface DocumentNode {
  readonly kind: "document";
  readonly document: IndexedDocument;
  readonly problemContext: boolean;
}

interface DetailGroupNode {
  readonly kind: "detailGroup";
  readonly group: "diagnostics" | "outgoing" | "incoming" | "sources";
  readonly document: IndexedDocument;
  readonly count: number;
}

interface DiagnosticNode {
  readonly kind: "diagnostic";
  readonly document: IndexedDocument;
  readonly diagnostic: DocumentDiagnostic;
}

interface ReferenceNode {
  readonly kind: "reference";
  readonly document: IndexedDocument;
  readonly direction: "outgoing" | "incoming";
  readonly reference: IndexedDocumentReference;
  readonly incoming?: IncomingDocumentReference;
}

interface SourceNode {
  readonly kind: "source";
  readonly document: IndexedDocument;
  readonly path: string;
}

interface EmptyNode {
  readonly kind: "empty";
  readonly label: string;
}

export class DocumentBrowser implements vscode.TreeDataProvider<DocumentBrowserNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<DocumentBrowserNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tree: vscode.TreeView<DocumentBrowserNode>;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly documents: WorkspaceDocumentIndex,
    private readonly references: WorkspaceReferenceService,
  ) {
    this.tree = vscode.window.createTreeView(DOCUMENT_BROWSER_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.changeEmitter,
      this.tree,
      projects.onDidChange(() => this.refreshTree()),
      documents.onDidChange(() => this.refreshTree()),
      vscode.commands.registerCommand("visualbridge.documentBrowser.refresh", async () => {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Window,
          title: "Refreshing VisualBridge documents…",
        }, () => this.documents.refresh());
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.search", async () => {
        await this.search();
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.validateAll", async () => {
        await this.validateAll();
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.open", async (node?: DocumentBrowserNode) => {
        await this.open(node);
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.create", async (node?: DocumentBrowserNode) => {
        await createDocument(this.projects, this.creationSelection(node));
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.revealReference", async (node?: DocumentBrowserNode) => {
        await this.revealReference(node);
      }),
    );
  }

  public getTreeItem(node: DocumentBrowserNode): vscode.TreeItem {
    if (node.kind === "project") {
      const item = new vscode.TreeItem(node.project.definition.projectId, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "visualbridge.project";
      item.iconPath = new vscode.ThemeIcon("project");
      item.description = node.project.rootUri.fsPath;
      item.tooltip = node.project.rootUri.fsPath;
      return item;
    }
    if (node.kind === "documentType") {
      const documents = this.documentsForType(node.project, node.documentType);
      const item = new vscode.TreeItem(node.documentType.id, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "visualbridge.documentType";
      item.iconPath = editorIcon(node.documentType.editor);
      item.description = `${editorTitle(node.documentType.editor)} · ${documents.length}`;
      item.tooltip = new vscode.MarkdownString([
        `**${node.documentType.id}**`,
        "",
        `Editor: ${editorTitle(node.documentType.editor)}`,
        `Include: ${node.documentType.include.join(", ")}`,
      ].join("\n"));
      return item;
    }
    if (node.kind === "problems") {
      const counts = diagnosticCounts(node.documents);
      const item = new vscode.TreeItem("Problems", vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = "visualbridge.problems";
      item.iconPath = counts.errors > 0 ? errorIcon() : warningIcon();
      item.description = `${counts.errors} errors · ${counts.warnings} warnings`;
      return item;
    }
    if (node.kind === "document") {
      const counts = diagnosticCounts([node.document]);
      const hasDetails = counts.errors + counts.warnings + node.document.references.length
        + this.documents.incomingReferences(node.document).length
        + (node.document.sourcePaths.length > 1 ? 1 : 0) > 0;
      const item = new vscode.TreeItem(
        node.document.title,
        hasDetails ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = "visualbridge.document";
      item.iconPath = counts.errors > 0
        ? errorIcon()
        : counts.warnings > 0
          ? warningIcon()
          : editorIcon(node.document.editor);
      item.description = node.document.path;
      item.tooltip = documentTooltip(node.document, counts.errors, counts.warnings);
      item.command = {
        command: "visualbridge.documentBrowser.open",
        title: "Open Document",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "detailGroup") {
      const label = node.group === "diagnostics"
        ? "Problems"
        : node.group === "outgoing"
          ? "References"
          : node.group === "incoming"
            ? "Referenced By"
            : "Sources";
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `visualbridge.${node.group}`;
      item.description = String(node.count);
      item.iconPath = node.group === "diagnostics"
        ? new vscode.ThemeIcon("issues")
        : node.group === "sources"
          ? new vscode.ThemeIcon("files")
          : new vscode.ThemeIcon("references");
      return item;
    }
    if (node.kind === "diagnostic") {
      const item = new vscode.TreeItem(node.diagnostic.message, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "visualbridge.diagnostic";
      item.description = node.diagnostic.path;
      item.iconPath = node.diagnostic.severity === "error" ? errorIcon() : warningIcon();
      item.tooltip = `${node.diagnostic.code}\n${node.diagnostic.path}: ${node.diagnostic.message}`;
      item.command = {
        command: "visualbridge.documentBrowser.open",
        title: "Open Document",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "reference") {
      const occurrence = node.reference.occurrence;
      const resolution = node.reference.resolution;
      const candidate = resolution.candidates[0];
      const sourceTitle = node.incoming?.source.title;
      const item = new vscode.TreeItem(
        node.direction === "incoming"
          ? `${sourceTitle ?? "Document"} · ${occurrence.path}`
          : candidate?.title ?? String(occurrence.value),
        vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = node.direction === "outgoing"
        ? "visualbridge.outgoingReference"
        : "visualbridge.incomingReference";
      item.description = node.direction === "incoming"
        ? String(occurrence.value)
        : `${occurrence.definition.kind} · ${resolution.status}`;
      item.iconPath = referenceIcon(resolution.status);
      item.tooltip = referenceTooltip(node);
      item.command = {
        command: node.direction === "outgoing"
          ? "visualbridge.documentBrowser.revealReference"
          : "visualbridge.documentBrowser.open",
        title: node.direction === "outgoing" ? "Reveal Reference" : "Open Referencing Document",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "source") {
      const item = new vscode.TreeItem(node.path, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "visualbridge.source";
      item.iconPath = new vscode.ThemeIcon("file");
      item.command = {
        command: "visualbridge.documentBrowser.open",
        title: "Open Source",
        arguments: [node],
      };
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "visualbridge.empty";
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }

  public getChildren(node?: DocumentBrowserNode): DocumentBrowserNode[] {
    if (node === undefined) {
      if (this.projects.projects.length === 0) {
        return [];
      }
      return this.projects.projects
        .slice()
        .sort((left, right) => left.definition.projectId.localeCompare(right.definition.projectId))
        .map((project) => ({ kind: "project", project }));
    }
    if (node.kind === "project") {
      const projectDocuments = this.documents.documents.filter(
        (document) => document.projectId === node.project.definition.projectId,
      );
      const problemDocuments = projectDocuments.filter((document) => document.diagnostics.length > 0);
      const types: DocumentTypeNode[] = node.project.definition.documentTypes
        .filter((documentType) => ["graph", "entity", "structured", "table"].includes(documentType.editor))
        .slice()
        .sort((left, right) => `${left.editor}\u0000${left.id}`.localeCompare(`${right.editor}\u0000${right.id}`))
        .map((documentType) => ({ kind: "documentType", project: node.project, documentType }));
      return [
        ...(problemDocuments.length === 0 ? [] : [{ kind: "problems" as const, project: node.project, documents: problemDocuments }]),
        ...types,
      ];
    }
    if (node.kind === "documentType") {
      const documents = this.documentsForType(node.project, node.documentType);
      return documents.length === 0
        ? [{ kind: "empty", label: this.documents.loading ? "Indexing…" : "No documents" }]
        : documents.map((document) => ({ kind: "document", document, problemContext: false }));
    }
    if (node.kind === "problems") {
      return node.documents.map((document) => ({ kind: "document", document, problemContext: true }));
    }
    if (node.kind === "document") {
      const incoming = this.documents.incomingReferences(node.document);
      return [
        ...(node.document.diagnostics.length === 0 ? [] : [{
          kind: "detailGroup" as const,
          group: "diagnostics" as const,
          document: node.document,
          count: node.document.diagnostics.length,
        }]),
        ...(node.document.references.length === 0 ? [] : [{
          kind: "detailGroup" as const,
          group: "outgoing" as const,
          document: node.document,
          count: node.document.references.length,
        }]),
        ...(incoming.length === 0 ? [] : [{
          kind: "detailGroup" as const,
          group: "incoming" as const,
          document: node.document,
          count: incoming.length,
        }]),
        ...(node.document.sourcePaths.length < 2 ? [] : [{
          kind: "detailGroup" as const,
          group: "sources" as const,
          document: node.document,
          count: node.document.sourcePaths.length,
        }]),
      ];
    }
    if (node.kind === "detailGroup") {
      if (node.group === "diagnostics") {
        return node.document.diagnostics.map((diagnostic) => ({ kind: "diagnostic", document: node.document, diagnostic }));
      }
      if (node.group === "outgoing") {
        return node.document.references.map((reference) => ({
          kind: "reference",
          document: node.document,
          direction: "outgoing",
          reference,
        }));
      }
      if (node.group === "incoming") {
        return this.documents.incomingReferences(node.document).map((incoming) => ({
          kind: "reference",
          document: node.document,
          direction: "incoming",
          reference: incoming.reference,
          incoming,
        }));
      }
      return node.document.sourcePaths.map((path) => ({ kind: "source", document: node.document, path }));
    }
    return [];
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private refreshTree(): void {
    const summary = this.documents.summary;
    this.tree.description = this.documents.loading
      ? "Indexing…"
      : `${summary.documentCount} documents · ${summary.errorCount} errors`;
    this.changeEmitter.fire(undefined);
  }

  private documentsForType(
    project: ProjectContext,
    documentType: DocumentTypeDefinition,
  ): readonly IndexedDocument[] {
    return this.documents.documents.filter((document) => (
      document.projectId === project.definition.projectId
      && document.documentTypeId === documentType.id
    ));
  }

  private async search(): Promise<void> {
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { readonly document: IndexedDocument }>();
    quickPick.title = "Search VisualBridge Documents";
    quickPick.placeholder = "Title, stable ID, type, path, diagnostic, or reference";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    const update = (): void => {
      quickPick.items = this.documents.search(quickPick.value).map((document) => {
        const counts = diagnosticCounts([document]);
        return {
          label: document.title,
          description: `${editorTitle(document.editor)} · ${document.documentTypeId}`,
          detail: `${document.projectId} · ${document.path}${counts.errors + counts.warnings === 0
            ? ""
            : ` · ${counts.errors} errors · ${counts.warnings} warnings`}`,
          alwaysShow: true,
          document,
        };
      });
    };
    this.disposables.push(
      quickPick.onDidChangeValue(update),
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        quickPick.hide();
        if (selected !== undefined) {
          void this.open({ kind: "document", document: selected.document, problemContext: false });
        }
      }),
      quickPick.onDidHide(() => quickPick.dispose()),
    );
    update();
    quickPick.show();
  }

  private async validateAll(): Promise<void> {
    const summary = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Validating VisualBridge documents",
      cancellable: false,
    }, () => this.documents.validateAll());
    const message = `${summary.documentCount} documents: ${summary.errorCount} errors, ${summary.warningCount} warnings, ${summary.referenceCount} references.`;
    if (summary.errorCount > 0) {
      const action = await vscode.window.showWarningMessage(message, "Show Problems");
      if (action === "Show Problems") {
        await vscode.commands.executeCommand("workbench.actions.view.problems");
      }
    } else {
      void vscode.window.showInformationMessage(message);
    }
  }

  private async open(node?: DocumentBrowserNode): Promise<void> {
    const document = node?.kind === "document"
      ? node.document
      : node?.kind === "diagnostic"
        ? node.document
        : node?.kind === "reference"
          ? node.incoming?.source ?? node.document
          : node?.kind === "source"
            ? node.document
            : undefined;
    if (document === undefined) {
      return;
    }
    const path = node?.kind === "source" ? node.path : document.path;
    const project = this.projects.projects.find((entry) => entry.definition.projectId === document.projectId);
    if (project === undefined) {
      void vscode.window.showWarningMessage(`VisualBridge Project '${document.projectId}' is no longer available.`);
      return;
    }
    const uri = vscode.Uri.joinPath(project.rootUri, ...path.split("/"));
    await vscode.commands.executeCommand("visualbridge.openDocument", uri);
  }

  private async revealReference(node?: DocumentBrowserNode): Promise<void> {
    if (node?.kind !== "reference" || node.direction !== "outgoing") {
      return;
    }
    const project = this.projects.projects.find(
      (entry) => entry.definition.projectId === node.document.projectId,
    );
    if (project === undefined) {
      return;
    }
    await this.references.reveal(
      project,
      node.reference.occurrence.definition,
      node.reference.occurrence.value,
    );
  }

  private creationSelection(node?: DocumentBrowserNode): CreateDocumentSelection | undefined {
    return node?.kind === "documentType"
      ? { project: node.project, documentType: node.documentType }
      : undefined;
  }
}

function diagnosticCounts(documents: readonly IndexedDocument[]): { readonly errors: number; readonly warnings: number } {
  let errors = 0;
  let warnings = 0;
  documents.forEach((document) => document.diagnostics.forEach((diagnostic) => {
    if (diagnostic.severity === "error") {
      errors += 1;
    } else {
      warnings += 1;
    }
  }));
  return { errors, warnings };
}

function editorTitle(editor: string): string {
  return editor === "graph"
    ? "Graph"
    : editor === "entity"
      ? "Entity"
      : editor === "structured"
        ? "Structured"
        : editor === "table"
          ? "Table"
          : editor;
}

function editorIcon(editor: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(editor === "graph"
    ? "type-hierarchy"
    : editor === "entity"
      ? "symbol-class"
      : editor === "structured"
        ? "symbol-struct"
        : editor === "table"
          ? "table"
          : "file-code");
}

function errorIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
}

function warningIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
}

function referenceIcon(status: IndexedDocumentReference["resolution"]["status"]): vscode.ThemeIcon {
  return status === "resolved"
    ? new vscode.ThemeIcon("link-external")
    : status === "providerUnavailable"
      ? warningIcon()
      : errorIcon();
}

function documentTooltip(document: IndexedDocument, errors: number, warnings: number): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${escapeMarkdown(document.title)}**\n\n`);
  tooltip.appendMarkdown(`Project: \`${escapeMarkdown(document.projectId)}\`  \n`);
  tooltip.appendMarkdown(`Document Type: \`${escapeMarkdown(document.documentTypeId)}\`  \n`);
  if (document.documentId !== undefined) {
    tooltip.appendMarkdown(`Document ID: \`${escapeMarkdown(document.documentId)}\`  \n`);
  }
  tooltip.appendMarkdown(`Path: \`${escapeMarkdown(document.path)}\`  \n`);
  tooltip.appendMarkdown(`Problems: ${errors} errors, ${warnings} warnings  \n`);
  tooltip.appendMarkdown(`References: ${document.references.length}`);
  return tooltip;
}

function referenceTooltip(node: ReferenceNode): string {
  const occurrence = node.reference.occurrence;
  const candidates = node.reference.resolution.candidates;
  return [
    `${occurrence.definition.kind}: ${String(occurrence.value)}`,
    `Path: ${occurrence.path}`,
    `Status: ${node.reference.resolution.status}`,
    ...candidates.map((candidate) => candidate.location?.path ?? candidate.title),
  ].join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}
