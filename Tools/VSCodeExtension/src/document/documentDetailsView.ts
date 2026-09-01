import * as vscode from "vscode";
import type {
  DocumentDiagnostic,
  IndexedDocument,
  IndexedDocumentReference,
} from "@visualbridge/core";
import type { IncomingDocumentReference } from "./workspaceDocumentIndex";
import { WorkspaceDocumentIndex } from "./workspaceDocumentIndex";

export const DOCUMENT_DETAILS_VIEW_ID = "visualbridge.documentDetails";

export type DocumentDetailsGroup = "diagnostics" | "references";

export type DocumentDetailsNode =
  | DocumentDetailsGroupNode
  | DocumentDiagnosticNode
  | DocumentReferenceNode
  | DocumentDetailsEmptyNode;

export interface DocumentDetailsGroupNode {
  readonly kind: "detailGroup";
  readonly group: DocumentDetailsGroup;
  readonly document: IndexedDocument;
  readonly count: number;
}

export interface DocumentDiagnosticNode {
  readonly kind: "diagnostic";
  readonly document: IndexedDocument;
  readonly diagnostic: DocumentDiagnostic;
}

export interface DocumentReferenceNode {
  readonly kind: "reference";
  readonly document: IndexedDocument;
  readonly direction: "outgoing" | "incoming";
  readonly reference: IndexedDocumentReference;
  readonly incoming?: IncomingDocumentReference;
}

interface DocumentDetailsEmptyNode {
  readonly kind: "empty";
  readonly label: string;
}

interface DocumentDetailsState {
  readonly document: IndexedDocument;
  readonly diagnostics: readonly DocumentDiagnosticNode[];
  readonly references: readonly DocumentReferenceNode[];
  readonly groups: Readonly<Record<DocumentDetailsGroup, DocumentDetailsGroupNode>>;
  readonly parents: ReadonlyMap<DocumentDetailsNode, DocumentDetailsGroupNode>;
}

export class DocumentDetailsView implements vscode.TreeDataProvider<DocumentDetailsNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<DocumentDetailsNode | undefined>();
  private readonly tree: vscode.TreeView<DocumentDetailsNode>;
  private state: DocumentDetailsState | undefined;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly documents: WorkspaceDocumentIndex) {
    this.tree = vscode.window.createTreeView(DOCUMENT_DETAILS_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.tree.description = "请选择文件";
  }

  public getTreeItem(node: DocumentDetailsNode): vscode.TreeItem {
    if (node.kind === "detailGroup") {
      const item = new vscode.TreeItem(
        node.group === "diagnostics" ? "Problems" : "References",
        node.count === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = `visualbridge.${node.group}`;
      item.description = String(node.count);
      item.iconPath = new vscode.ThemeIcon(node.group === "diagnostics" ? "issues" : "references");
      return item;
    }
    if (node.kind === "diagnostic") {
      const message = localizeDocumentDiagnostic(node.diagnostic);
      const severity = node.diagnostic.severity === "error" ? "错误" : "警告";
      const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "visualbridge.diagnostic";
      item.description = `${node.diagnostic.path} · ${node.diagnostic.code}`;
      item.iconPath = node.diagnostic.severity === "error" ? errorIcon() : warningIcon();
      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`**${severity}：${escapeMarkdown(message)}**\n\n`);
      tooltip.appendMarkdown(`文件：\`${escapeMarkdown(node.document.path)}\`  \n`);
      tooltip.appendMarkdown(`位置：\`${escapeMarkdown(node.diagnostic.path)}\`  \n`);
      tooltip.appendMarkdown(`代码：\`${escapeMarkdown(node.diagnostic.code)}\`\n\n`);
      tooltip.appendMarkdown("右键此项可复制完整问题信息。");
      item.tooltip = tooltip;
      item.command = {
        command: "visualbridge.documentBrowser.open",
        title: "打开文档",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "reference") {
      const occurrence = node.reference.occurrence;
      const resolution = node.reference.resolution;
      const candidate = resolution.candidates[0];
      const sourceTitle = node.incoming?.source.title;
      const navigation = node.direction === "incoming" ? node.incoming?.navigation : undefined;
      const incomingLabel = navigation === undefined
        ? `${sourceTitle ?? "文档"} · ${occurrence.path}`
        : navigation.nodeTitle === undefined
          ? navigation.graphTitle
          : `${navigation.graphTitle} · ${navigation.nodeTitle}`;
      const item = new vscode.TreeItem(
        node.direction === "incoming"
          ? incomingLabel
          : candidate?.title ?? String(occurrence.value),
        vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = node.direction === "outgoing"
        ? "visualbridge.outgoingReference"
        : "visualbridge.incomingReference";
      item.description = node.direction === "incoming"
        ? [navigation?.fieldPath, String(occurrence.value)].filter((part) => part !== undefined).join(" · ")
        : `${occurrence.definition.kind} · ${referenceStatusTitle(resolution.status)}`;
      item.iconPath = referenceIcon(resolution.status);
      item.tooltip = referenceTooltip(node);
      item.command = {
        command: node.direction === "outgoing" || navigation !== undefined
          ? "visualbridge.documentBrowser.revealReference"
          : "visualbridge.documentBrowser.open",
        title: node.direction === "outgoing" || navigation !== undefined
          ? "定位引用"
          : "打开引用来源文档",
        arguments: [node],
      };
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "visualbridge.empty";
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }

  public getChildren(node?: DocumentDetailsNode): DocumentDetailsNode[] {
    if (node === undefined) {
      return this.state === undefined
        ? [{ kind: "empty", label: "请在 Documents 中选择一个文件" }]
        : [this.state.groups.diagnostics, this.state.groups.references];
    }
    if (node.kind !== "detailGroup" || this.state === undefined) {
      return [];
    }
    return node.group === "diagnostics" ? [...this.state.diagnostics] : [...this.state.references];
  }

  public getParent(node: DocumentDetailsNode): DocumentDetailsGroupNode | undefined {
    return this.state?.parents.get(node);
  }

  public select(document: IndexedDocument | undefined): void {
    if (document === undefined) {
      if (this.state === undefined) return;
      this.state = undefined;
      this.tree.description = "请选择文件";
      this.changeEmitter.fire(undefined);
      return;
    }
    if (this.state?.document === document) return;
    this.state = createDetailsState(document, this.documents.incomingReferences(document));
    this.tree.description = `${document.title} · ${document.path}`;
    this.changeEmitter.fire(undefined);
  }

  public refresh(indexedDocuments: readonly IndexedDocument[]): void {
    const selected = this.state?.document;
    if (selected === undefined) return;
    const replacement = indexedDocuments.find((document) => sameDocument(document, selected));
    if (replacement === undefined) {
      this.select(undefined);
      return;
    }
    this.state = createDetailsState(replacement, this.documents.incomingReferences(replacement));
    this.tree.description = `${replacement.title} · ${replacement.path}`;
    this.changeEmitter.fire(undefined);
  }

  public async show(document: IndexedDocument, group: DocumentDetailsGroup): Promise<void> {
    this.select(document);
    await vscode.commands.executeCommand(`${DOCUMENT_DETAILS_VIEW_ID}.focus`);
    const target = this.state?.groups[group];
    if (target !== undefined) {
      await this.tree.reveal(target, {
        expand: target.count > 0,
        focus: true,
        select: true,
      });
    }
  }

  public snapshot(document: IndexedDocument): {
    readonly selectedDocument: string;
    readonly groups: readonly {
      readonly label: string;
      readonly count: number;
      readonly items: readonly {
        readonly kind: "diagnostic" | "reference";
        readonly label: string;
        readonly description?: string;
        readonly contextValue?: string;
      }[];
    }[];
  } {
    this.select(document);
    const state = this.state;
    if (state === undefined) throw new Error("Document details state was not created.");
    return {
      selectedDocument: state.document.path,
      groups: ([state.groups.diagnostics, state.groups.references] as const).map((group) => ({
        label: treeItemLabel(this.getTreeItem(group).label),
        count: group.count,
        items: this.getChildren(group).flatMap((item) => {
          if (item.kind !== "diagnostic" && item.kind !== "reference") return [];
          const treeItem = this.getTreeItem(item);
          return [{
            kind: item.kind,
            label: treeItemLabel(treeItem.label),
            ...(typeof treeItem.description === "string" ? { description: treeItem.description } : {}),
            ...(treeItem.contextValue === undefined ? {} : { contextValue: treeItem.contextValue }),
          }];
        }),
      })),
    };
  }

  public testState(): {
    readonly visible: boolean;
    readonly selectedDocument?: string;
    readonly selectedGroup?: DocumentDetailsGroup;
  } {
    const selection = this.tree.selection[0];
    return {
      visible: this.tree.visible,
      ...(this.state === undefined ? {} : { selectedDocument: this.state.document.path }),
      ...(selection?.kind === "detailGroup" ? { selectedGroup: selection.group } : {}),
    };
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
    return this.documents.documents.flatMap((document) => this.documents.incomingReferences(document).map((incoming) => {
      const node: DocumentReferenceNode = {
        kind: "reference",
        document,
        direction: "incoming",
        reference: incoming.reference,
        incoming,
      };
      const item = this.getTreeItem(node);
      return {
        projectId: document.projectId,
        targetPath: document.path,
        sourcePath: incoming.source.path,
        occurrencePath: incoming.reference.occurrence.path,
        label: treeItemLabel(item.label),
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(item.command === undefined ? {} : { command: item.command.command }),
        ...(incoming.navigation?.graphTitle === undefined ? {} : { graphTitle: incoming.navigation.graphTitle }),
        ...(incoming.navigation?.nodeTitle === undefined ? {} : { nodeTitle: incoming.navigation.nodeTitle }),
      };
    }));
  }

  public dispose(): void {
    this.changeEmitter.dispose();
    this.tree.dispose();
  }
}

export function localizeDocumentDiagnostic(diagnostic: DocumentDiagnostic): string {
  const quoted = [...diagnostic.message.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  if (diagnostic.code === "reference.missingTarget") {
    return `引用值“${quoted[0] ?? "未知"}”无法解析为“${quoted[1] ?? "未知"}”类型。`;
  }
  if (diagnostic.code === "reference.ambiguousTarget") {
    const count = diagnostic.message.match(/resolves to (\d+) targets/)?.[1] ?? "多个";
    return `引用值“${quoted[0] ?? "未知"}”解析到 ${count} 个目标，无法确定唯一目标。`;
  }
  if (diagnostic.code === "reference.invalidTarget") {
    return `引用目标配置无效${quoted[0] === undefined ? "" : `：“${quoted[0]}”`}。`;
  }
  if (diagnostic.code === "reference.providerUnavailable") {
    return `“${quoted[0] ?? "未知"}”引用提供器当前不可用，已保留原始值。`;
  }
  if (diagnostic.code === "document.unreadable") {
    return "无法读取文档源文件，请检查文件是否存在、编码是否正确以及是否被其他程序占用。";
  }

  const scope = diagnosticScopeTitle(diagnostic.code);
  const reason = diagnosticReasonTitle(diagnostic.code);
  const related = quoted.length === 0
    ? ""
    : ` 相关值：${quoted.map((value) => `“${value}”`).join("、")}。`;
  return `${scope}${reason}（${diagnostic.code}）。${related}`.trim();
}

export function copiedDiagnosticText(node: DocumentDiagnosticNode): string {
  return [
    `级别：${node.diagnostic.severity === "error" ? "错误" : "警告"}`,
    `问题：${localizeDocumentDiagnostic(node.diagnostic)}`,
    `文件：${node.document.path}`,
    `位置：${node.diagnostic.path}`,
    `代码：${node.diagnostic.code}`,
  ].join("\n");
}

function createDetailsState(
  document: IndexedDocument,
  incoming: readonly IncomingDocumentReference[],
): DocumentDetailsState {
  const diagnostics = document.diagnostics.map((diagnostic): DocumentDiagnosticNode => ({
    kind: "diagnostic",
    document,
    diagnostic,
  }));
  const references: DocumentReferenceNode[] = [
    ...document.references.map((reference): DocumentReferenceNode => ({
      kind: "reference",
      document,
      direction: "outgoing",
      reference,
    })),
    ...incoming.map((incomingReference): DocumentReferenceNode => ({
      kind: "reference",
      document,
      direction: "incoming",
      reference: incomingReference.reference,
      incoming: incomingReference,
    })),
  ];
  const groups: Readonly<Record<DocumentDetailsGroup, DocumentDetailsGroupNode>> = {
    diagnostics: { kind: "detailGroup", group: "diagnostics", document, count: diagnostics.length },
    references: { kind: "detailGroup", group: "references", document, count: references.length },
  };
  const parents = new Map<DocumentDetailsNode, DocumentDetailsGroupNode>();
  diagnostics.forEach((node) => parents.set(node, groups.diagnostics));
  references.forEach((node) => parents.set(node, groups.references));
  return { document, diagnostics, references, groups, parents };
}

function sameDocument(left: IndexedDocument, right: IndexedDocument): boolean {
  return left.projectId === right.projectId
    && left.documentTypeId === right.documentTypeId
    && left.path === right.path;
}

function diagnosticScopeTitle(code: string): string {
  const prefix = code.split(".", 1)[0];
  return prefix === "graph"
    ? "Graph 文档"
    : prefix === "entity"
      ? "Entity 文档"
      : prefix === "table"
        ? "Table 文档"
        : prefix === "structured"
          ? "Structured 文档"
          : prefix === "field"
            ? "字段"
            : prefix === "catalog"
              ? "Catalog"
              : prefix === "provider"
                ? "Project Provider"
                : "文档";
}

function diagnosticReasonTitle(code: string): string {
  const suffix = code.slice(code.indexOf(".") + 1).toLowerCase();
  return suffix.includes("duplicate") || suffix.includes("conflict")
    ? "中存在重复或冲突内容"
    : suffix.includes("missing")
      ? "缺少必需内容"
      : suffix.includes("unknown")
        ? "包含未知内容"
        : suffix.includes("unavailable")
          ? "依赖当前不可用"
          : suffix.includes("alias")
            ? "使用了兼容别名"
            : suffix.includes("stale")
              ? "来源已过期"
              : "校验未通过";
}

function referenceStatusTitle(status: IndexedDocumentReference["resolution"]["status"]): string {
  return status === "resolved"
    ? "已解析"
    : status === "missing"
      ? "目标缺失"
      : status === "ambiguous"
        ? "目标不唯一"
        : status === "invalidTarget"
          ? "目标无效"
          : "提供器不可用";
}

function referenceTooltip(node: DocumentReferenceNode): string {
  const occurrence = node.reference.occurrence;
  const candidates = node.reference.resolution.candidates;
  const navigation = node.incoming?.navigation;
  return [
    `引用类型：${occurrence.definition.kind}`,
    `引用值：${String(occurrence.value)}`,
    ...(navigation === undefined ? [] : [
      `Graph：${navigation.graphTitle}`,
      ...(navigation.nodeTitle === undefined ? [] : [`节点：${navigation.nodeTitle}`]),
      ...(navigation.fieldPath === undefined ? [] : [`字段：${navigation.fieldPath}`]),
    ]),
    `位置：${occurrence.path}`,
    `状态：${referenceStatusTitle(node.reference.resolution.status)}`,
    ...candidates.map((candidate) => `目标：${candidate.location?.path ?? candidate.title}`),
  ].join("\n");
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

function treeItemLabel(label: string | vscode.TreeItemLabel | undefined): string {
  return typeof label === "string" ? label : label?.label ?? "";
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}
