import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
  DocumentDiagnostic,
  DocumentLifecyclePlan,
  DocumentTypeDefinition,
  IndexedDocument,
  StableIdentityRemap,
} from "@visualbridge/core";
import { compareUtf16CodeUnits } from "@visualbridge/core";
import { createDocument } from "../commands/createDocument";
import type { CreateDocumentSelection } from "../commands/createDocumentSupport";
import type { ProjectContext, ProjectRegistry } from "../project/projectRegistry";
import {
  REVEAL_REFERENCE_COMMAND,
  type WorkspaceReferenceService,
} from "../reference/workspaceReferenceService";
import type { WorkspaceReferenceRefactor } from "../refactor/workspaceReferenceRefactor";
import {
  WorkspaceDocumentLifecycle,
  WorkspaceLifecycleError,
} from "./workspaceDocumentLifecycle";
import {
  WorkspaceDocumentIndex,
} from "./workspaceDocumentIndex";
import {
  copiedDiagnosticText,
  DocumentDetailsView,
  type DocumentDetailsGroup,
  type DocumentDetailsNode,
  localizeDocumentDiagnostic,
} from "./documentDetailsView";

export const DOCUMENT_BROWSER_VIEW_ID = "visualbridge.documents";

type DocumentBrowserNode =
  | ProjectNode
  | DocumentTypeNode
  | DocumentNode
  | EmptyNode;

type DocumentBrowserActionNode = DocumentBrowserNode | DocumentDetailsNode;

interface ProjectNode {
  readonly kind: "project";
  readonly project: ProjectContext;
}

interface DocumentTypeNode {
  readonly kind: "documentType";
  readonly project: ProjectContext;
  readonly documentType: DocumentTypeDefinition;
}

interface DocumentNode {
  readonly kind: "document";
  readonly document: IndexedDocument;
}

interface EmptyNode {
  readonly kind: "empty";
  readonly label: string;
}

export class DocumentBrowser implements vscode.TreeDataProvider<DocumentBrowserNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<DocumentBrowserNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tree: vscode.TreeView<DocumentBrowserNode>;
  private readonly details: DocumentDetailsView;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly projects: ProjectRegistry,
    private readonly documents: WorkspaceDocumentIndex,
    private readonly references: WorkspaceReferenceService,
    private readonly refactors: WorkspaceReferenceRefactor,
    private readonly lifecycle: WorkspaceDocumentLifecycle,
  ) {
    this.tree = vscode.window.createTreeView(DOCUMENT_BROWSER_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.details = new DocumentDetailsView(documents);
    this.disposables.push(
      this.changeEmitter,
      this.tree,
      this.details,
      this.tree.onDidChangeSelection((event) => {
        const selected = event.selection[0];
        this.details.select(selected?.kind === "document" ? selected.document : undefined);
      }),
      projects.onDidChange(() => this.refreshTree()),
      documents.onDidChange(() => this.refreshTree()),
      vscode.commands.registerCommand("visualbridge.documentBrowser.refresh", async () => {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Window,
          title: "正在刷新 VisualBridge 文档…",
        }, () => this.documents.refresh());
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.search", async () => {
        await this.search();
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.validateAll", async () => {
        await this.validateAll();
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.open", async (node?: DocumentBrowserActionNode) => {
        await this.open(node);
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.create", async (node?: DocumentBrowserNode) => {
        await createDocument(this.projects, this.lifecycle, this.creationSelection(node));
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.copy", async (node?: DocumentBrowserNode) => {
        await this.copyDocument(node);
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.renamePath", async (node?: DocumentBrowserNode) => {
        await this.moveDocument(node, "Rename Path");
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.move", async (node?: DocumentBrowserNode) => {
        await this.moveDocument(node, "Move Document");
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.safeDelete", async (node?: DocumentBrowserNode) => {
        await this.safeDelete(node);
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.showProblems", async (node?: DocumentBrowserNode) => {
        await this.showDetails(node, "diagnostics");
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.showReferences", async (node?: DocumentBrowserNode) => {
        await this.showDetails(node, "references");
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.copyProblem", async (node?: DocumentDetailsNode) => {
        await this.copyProblem(node);
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.revealReference", async (node?: DocumentBrowserActionNode) => {
        await this.revealReference(node);
      }),
      vscode.commands.registerCommand("visualbridge.documentBrowser.renameReferenceTarget", async (node?: DocumentBrowserActionNode) => {
        await this.renameReferenceTarget(node);
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
    if (node.kind === "document") {
      const counts = diagnosticCounts([node.document]);
      const problemCount = counts.errors + counts.warnings;
      const referenceCount = node.document.references.length + this.documents.incomingReferences(node.document).length;
      const item = new vscode.TreeItem(
        `${escapeCodiconText(node.document.title)}  $(issues) ${problemCount}  $(references) ${referenceCount}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = "visualbridge.document";
      item.iconPath = editorIcon(node.document.editor);
      item.description = node.document.path;
      item.tooltip = documentTooltip(node.document, counts.errors, counts.warnings, referenceCount);
      item.command = {
        command: "visualbridge.documentBrowser.open",
        title: "打开文档",
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
        .sort((left, right) => compareUtf16CodeUnits(left.definition.projectId, right.definition.projectId))
        .map((project) => ({ kind: "project", project }));
    }
    if (node.kind === "project") {
      const types: DocumentTypeNode[] = node.project.definition.documentTypes
        .filter((documentType) => ["graph", "entity", "structured", "table"].includes(documentType.editor))
        .slice()
        .sort((left, right) => compareUtf16CodeUnits(`${left.editor}\u0000${left.id}`, `${right.editor}\u0000${right.id}`))
        .map((documentType) => ({ kind: "documentType", project: node.project, documentType }));
      return types;
    }
    if (node.kind === "documentType") {
      const documents = this.documentsForType(node.project, node.documentType);
      return documents.length === 0
        ? [{ kind: "empty", label: this.documents.loading ? "Indexing…" : "No documents" }]
        : documents.map((document) => ({ kind: "document", document }));
    }
    return [];
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  public incomingReferenceTestSnapshot(): readonly {
    readonly projectId: string;
    readonly targetPath: string;
    readonly sourcePath: string;
    readonly occurrencePath: string;
    readonly label: string;
    readonly description?: string;
    readonly command?: string;
    readonly graphTitle?: string;
    readonly nodeTitle?: string;
  }[] {
    return this.details.incomingReferenceTestSnapshot();
  }

  public documentDetailsTestSnapshot(selector: {
    readonly projectId: string;
    readonly path: string;
  }): {
    readonly row: {
      readonly label: string;
      readonly description?: string;
      readonly collapsibleState: vscode.TreeItemCollapsibleState;
    };
    readonly details: ReturnType<DocumentDetailsView["snapshot"]>;
  } {
    const document = this.findDocument(selector);
    const row = this.getTreeItem({ kind: "document", document });
    return {
      row: {
        label: treeItemLabel(row.label),
        ...(typeof row.description === "string" ? { description: row.description } : {}),
        collapsibleState: row.collapsibleState ?? vscode.TreeItemCollapsibleState.None,
      },
      details: this.details.snapshot(document),
    };
  }

  public async showDocumentDetailsForTest(
    selector: { readonly projectId: string; readonly path: string },
    group: DocumentDetailsGroup,
  ): Promise<ReturnType<DocumentDetailsView["testState"]>> {
    await this.details.show(this.findDocument(selector), group);
    return this.details.testState();
  }

  public localizeDiagnosticForTest(diagnostic: DocumentDiagnostic): string {
    return localizeDocumentDiagnostic(diagnostic);
  }

  public async revealIncomingReferenceForTest(selector: {
    readonly projectId: string;
    readonly targetPath: string;
    readonly sourcePath: string;
    readonly occurrencePath: string;
  }): Promise<void> {
    const document = this.documents.documents.find((candidate) => (
      candidate.projectId === selector.projectId && candidate.path === selector.targetPath
    ));
    const incoming = document === undefined
      ? undefined
      : this.documents.incomingReferences(document).find((candidate) => (
          candidate.source.path === selector.sourcePath
          && candidate.reference.occurrence.path === selector.occurrencePath
        ));
    if (document === undefined || incoming === undefined) {
      throw new Error("Incoming reference test target is not indexed.");
    }
    await this.revealReference({
      kind: "reference",
      document,
      direction: "incoming",
      reference: incoming.reference,
      incoming,
    });
  }

  private refreshTree(): void {
    const summary = this.documents.summary;
    this.tree.description = this.documents.loading
      ? "Indexing…"
      : `${summary.documentCount} 个文档 · ${summary.errorCount} 个错误`;
    this.details.refresh(this.documents.documents);
    this.changeEmitter.fire(undefined);
  }

  private findDocument(selector: { readonly projectId: string; readonly path: string }): IndexedDocument {
    const document = this.documents.documents.find((candidate) => (
      candidate.projectId === selector.projectId && candidate.path === selector.path
    ));
    if (document === undefined) throw new Error("Document Browser test target is not indexed.");
    return document;
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
            : ` · ${counts.errors} 个错误 · ${counts.warnings} 个警告`}`,
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
          void this.open({ kind: "document", document: selected.document });
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
      title: "正在校验 VisualBridge 文档",
      cancellable: false,
    }, () => this.documents.validateAll());
    const message = `已校验 ${summary.documentCount} 个文档：${summary.errorCount} 个错误、${summary.warningCount} 个警告、${summary.referenceCount} 个引用。`;
    if (summary.errorCount > 0) {
      const action = await vscode.window.showWarningMessage(message, "查看 Problems");
      if (action === "查看 Problems") {
        const firstProblem = this.documents.documents.find((document) => document.diagnostics.length > 0);
        if (firstProblem !== undefined) await this.details.show(firstProblem, "diagnostics");
      }
    } else {
      void vscode.window.showInformationMessage(message);
    }
  }

  private async open(node?: DocumentBrowserActionNode): Promise<void> {
    const document = node?.kind === "document"
      ? node.document
      : node?.kind === "diagnostic"
        ? node.document
        : node?.kind === "reference"
          ? node.incoming?.source ?? node.document
          : undefined;
    if (document === undefined) {
      return;
    }
    const path = document.path;
    const project = this.projects.projects.find((entry) => entry.definition.projectId === document.projectId);
    if (project === undefined) {
      void vscode.window.showWarningMessage(`VisualBridge Project '${document.projectId}' is no longer available.`);
      return;
    }
    const uri = vscode.Uri.joinPath(project.rootUri, ...path.split("/"));
    await vscode.commands.executeCommand("visualbridge.openDocument", uri);
  }

  private async revealReference(node?: DocumentBrowserActionNode): Promise<void> {
    if (node?.kind !== "reference") {
      return;
    }
    if (node.direction === "incoming") {
      if (node.incoming?.navigation === undefined) {
        await this.open(node);
        return;
      }
      await vscode.commands.executeCommand(REVEAL_REFERENCE_COMMAND, node.incoming.navigation.location);
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

  private async renameReferenceTarget(node?: DocumentBrowserActionNode): Promise<void> {
    if (node?.kind !== "reference") {
      return;
    }
    const source = node.direction === "incoming" ? node.incoming?.source : node.document;
    if (source === undefined) {
      return;
    }
    await this.refactors.rename(source, node.reference);
  }

  private async showDetails(node: DocumentBrowserNode | undefined, group: DocumentDetailsGroup): Promise<void> {
    if (node?.kind !== "document") return;
    await this.details.show(node.document, group);
  }

  private async copyProblem(node: DocumentDetailsNode | undefined): Promise<void> {
    if (node?.kind !== "diagnostic") return;
    await vscode.env.clipboard.writeText(copiedDiagnosticText(node));
    void vscode.window.showInformationMessage("已复制问题详情。");
  }

  private async moveDocument(node: DocumentBrowserNode | undefined, title: string): Promise<void> {
    if (node?.kind !== "document") return;
    const project = this.projects.projects.find((entry) => entry.definition.projectId === node.document.projectId);
    if (project === undefined) return;
    const current = vscode.Uri.joinPath(project.rootUri, ...node.document.path.split("/"));
    const target = await vscode.window.showSaveDialog({
      title: `${title} — stable IDs and references remain unchanged`,
      defaultUri: current,
      saveLabel: title,
    });
    if (target === undefined || target.toString() === current.toString()) return;
    try {
      const preview = await this.lifecycle.previewMove(node.document, target);
      if (this.showPreviewBlockers(preview.preview.plan.blockers)) return;
      const physicalCount = preview.preview.plan.mutations.length;
      const confirmed = await vscode.window.showInformationMessage(
        `${title} changes only ${physicalCount} physical path${physicalCount === 1 ? "" : "s"}; stable IDs and reference values are unchanged.`,
        { modal: true, detail: lifecyclePlanDetail(preview.preview.plan) },
        title,
      );
      if (confirmed !== title) return;
      const opened = await this.lifecycle.apply(preview);
      if (opened !== undefined) await vscode.commands.executeCommand("visualbridge.openDocument", opened);
    } catch (errorValue) {
      this.showLifecycleError(errorValue);
    }
  }

  private async copyDocument(node: DocumentBrowserNode | undefined): Promise<void> {
    if (node?.kind !== "document") return;
    const project = this.projects.projects.find((entry) => entry.definition.projectId === node.document.projectId);
    if (project === undefined) return;
    const current = vscode.Uri.joinPath(project.rootUri, ...node.document.path.split("/"));
    try {
      const target = await vscode.window.showSaveDialog({
        title: "Copy Document — every stable identity will be remapped",
        defaultUri: current,
        saveLabel: "Copy Document",
      });
      if (target === undefined || target.toString() === current.toString()) return;
      const identities = await this.lifecycle.collectOwnedIdentities(node.document);
      const stableIdRemap = node.document.editor === "table"
        ? await promptTableRemap(identities)
        : identities.map((identity): StableIdentityRemap => ({
            identityKey: identity.identityKey,
            from: identity.value,
            to: `${identity.kind.replace(/[^A-Za-z0-9._-]/g, "_")}_${randomUUID()}`,
          }));
      if (stableIdRemap === undefined) return;
      const preview = await this.lifecycle.previewCopy(node.document, target, stableIdRemap);
      if (this.showPreviewBlockers(preview.preview.plan.blockers)) return;
      const confirmed = await vscode.window.showInformationMessage(
        `Copy '${node.document.title}' with ${stableIdRemap.length} explicit stable-ID remap${stableIdRemap.length === 1 ? "" : "s"} and ${preview.preview.plan.mutations.length} new physical source${preview.preview.plan.mutations.length === 1 ? "" : "s"}.`,
        { modal: true, detail: lifecyclePlanDetail(preview.preview.plan) },
        "Copy Document",
      );
      if (confirmed !== "Copy Document") return;
      const opened = await this.lifecycle.apply(preview);
      if (opened !== undefined) await vscode.commands.executeCommand("visualbridge.openDocument", opened);
    } catch (errorValue) {
      this.showLifecycleError(errorValue);
    }
  }

  private async safeDelete(node: DocumentBrowserNode | undefined): Promise<void> {
    if (node?.kind !== "document") return;
    try {
      const preview = await this.lifecycle.previewDelete(node.document);
      if (this.showPreviewBlockers(preview.preview.plan.blockers)) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Safe Delete '${node.document.title}' removes ${preview.preview.plan.mutations.length} physical source${preview.preview.plan.mutations.length === 1 ? "" : "s"}. It will not cascade external references.`,
        { modal: true, detail: lifecyclePlanDetail(preview.preview.plan) },
        "Safe Delete",
      );
      if (confirmed !== "Safe Delete") return;
      await this.lifecycle.apply(preview);
    } catch (errorValue) {
      this.showLifecycleError(errorValue);
    }
  }

  private showLifecycleError(errorValue: unknown): void {
    const error = errorValue instanceof WorkspaceLifecycleError
      ? `${errorValue.code}: ${errorValue.message}`
      : errorValue instanceof Error ? errorValue.message : String(errorValue);
    void vscode.window.showWarningMessage(error);
  }

  private showPreviewBlockers(blockers: readonly { readonly code: string; readonly message: string }[]): boolean {
    if (blockers.length === 0) return false;
    void vscode.window.showWarningMessage(blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("\n"));
    return true;
  }

  private creationSelection(node?: DocumentBrowserNode): CreateDocumentSelection | undefined {
    return node?.kind === "documentType"
      ? { project: node.project, documentType: node.documentType }
      : undefined;
  }
}

function lifecyclePlanDetail(plan: DocumentLifecyclePlan): string {
  return [
    "This is the canonical operation that will be revalidated under the Project lock:",
    "",
    JSON.stringify({
      operation: plan.operation,
      ownedIdentities: plan.ownedIdentities,
      stableIdRemap: plan.stableIdRemap,
      referenceImpacts: plan.referenceImpacts,
      baseHashes: plan.baseHashes,
      dependencies: plan.dependencies,
      mutations: plan.mutations,
    }, undefined, 2),
  ].join("\n");
}

async function promptTableRemap(
  identities: readonly { readonly identityKey: string; readonly kind: string; readonly value: string | number }[],
): Promise<readonly StableIdentityRemap[] | undefined> {
  const remap: StableIdentityRemap[] = [];
  for (const identity of identities) {
    const input = await vscode.window.showInputBox({
      title: `Copy Table — remap ${identity.kind}`,
      prompt: `${identity.identityKey}: enter a new ${typeof identity.value} key (current: ${String(identity.value)})`,
      validateInput(value) {
        if (value.length === 0) return "A new business key is required; VisualBridge will not guess it.";
        if (typeof identity.value === "number" && !Number.isFinite(Number(value))) return "Enter a finite number.";
        if ((typeof identity.value === "string" ? value : Number(value)) === identity.value) return "The new key must be different.";
        return undefined;
      },
    });
    if (input === undefined) return undefined;
    remap.push({
      identityKey: identity.identityKey,
      from: identity.value,
      to: typeof identity.value === "number" ? Number(input) : input,
    });
  }
  return remap;
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

function documentTooltip(
  document: IndexedDocument,
  errors: number,
  warnings: number,
  references: number,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${escapeMarkdown(document.title)}**\n\n`);
  tooltip.appendMarkdown(`工程：\`${escapeMarkdown(document.projectId)}\`  \n`);
  tooltip.appendMarkdown(`文档类型：\`${escapeMarkdown(document.documentTypeId)}\`  \n`);
  if (document.documentId !== undefined) {
    tooltip.appendMarkdown(`文档 ID：\`${escapeMarkdown(document.documentId)}\`  \n`);
  }
  tooltip.appendMarkdown(`路径：\`${escapeMarkdown(document.path)}\`  \n`);
  tooltip.appendMarkdown(`Problems：${errors} 个错误、${warnings} 个警告  \n`);
  tooltip.appendMarkdown(`References：${references}  \n\n`);
  tooltip.appendMarkdown("选择文件可在下方详情视图查看；点击文件后的图标可直接展开对应分组。");
  return tooltip;
}

function treeItemLabel(label: string | vscode.TreeItemLabel | undefined): string {
  return typeof label === "string" ? label : label?.label ?? "";
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}

function escapeCodiconText(value: string): string {
  return value.replace(/\$\(/g, "$\u200B(");
}
