import { useState } from "react";
import type {
  ConnectionNodeOption,
  DocumentDiagnostic,
  NodeTypeDefinition,
  SubgraphTypeOption,
} from "../types";

export function SelectionContextActions({
  copyIssue,
  duplicateIssue,
  deleteIssue,
  deleteLabel,
  onCopy,
  onDuplicate,
  onDelete,
}: {
  readonly copyIssue: string | undefined;
  readonly duplicateIssue: string | undefined;
  readonly deleteIssue: string | undefined;
  readonly deleteLabel: string;
  readonly onCopy: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}): React.JSX.Element {
  return (
    <>
      <button type="button" disabled={copyIssue !== undefined} title={copyIssue} onClick={onCopy}>复制</button>
      <button type="button" disabled={duplicateIssue !== undefined} title={duplicateIssue} onClick={onDuplicate}>克隆</button>
      <button type="button" disabled={deleteIssue !== undefined} title={deleteIssue} onClick={onDelete}>{deleteLabel}</button>
    </>
  );
}

export function NodeTypePicker({
  title,
  nodeTypes: availableNodeTypes,
  onCancel,
  onSelect,
}: {
  readonly title: string;
  readonly nodeTypes: readonly NodeTypeDefinition[];
  readonly onCancel: () => void;
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const filtered = availableNodeTypes.filter((nodeType) =>
    [nodeType.catalogTitle, nodeType.catalogId, nodeType.title, nodeType.id, nodeType.category, ...(nodeType.menuPath ?? []), ...(nodeType.tags ?? []), ...(nodeType.traits ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="graph-modal-backdrop" onMouseDown={onCancel}>
      <section className="graph-node-picker" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" className="secondary" onClick={onCancel}>关闭</button></header>
        <input autoFocus placeholder="搜索节点类型…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="graph-node-type-list">
          {query.trim().length === 0
            ? <NodeTypeMenu nodeTypes={filtered} onSelect={onSelect} />
            : filtered.map((nodeType) => <NodeTypeOption key={`${nodeType.catalogId}:${nodeType.id}`} nodeType={nodeType} onSelect={onSelect} />)}
          {filtered.length === 0 && <p className="graph-empty">没有可用的节点类型。</p>}
        </div>
      </section>
    </div>
  );
}

export function ConnectionNodePicker({
  options,
  onCancel,
  onSelect,
}: {
  readonly options: readonly ConnectionNodeOption[];
  readonly onCancel: () => void;
  readonly onSelect: (option: ConnectionNodeOption) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = options.filter(({ nodeType, port }) =>
    [nodeType.catalogTitle, nodeType.catalogId, nodeType.title, nodeType.id, nodeType.category, ...(nodeType.menuPath ?? []), port.title, port.id]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
  return (
    <div className="graph-modal-backdrop" onMouseDown={onCancel}>
      <section className="graph-node-picker" role="dialog" aria-modal="true" aria-label="连接并创建节点" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>连接并创建节点</h2><button type="button" className="secondary" onClick={onCancel}>关闭</button></header>
        <input autoFocus placeholder="搜索兼容的节点或端口…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="graph-node-type-list">
          {filtered.map((option) => (
            <button
              key={`${option.nodeType.catalogId}:${option.nodeType.id}:${option.port.id}`}
              type="button"
              className="graph-node-type-option"
              onClick={() => onSelect(option)}
            >
              <strong>{option.nodeType.title}</strong>
              <span>{getNodeTypeDisplayPath(option.nodeType)} · {option.port.title}</span>
              <code>{option.nodeType.id} · {option.port.id}</code>
            </button>
          ))}
          {filtered.length === 0 && <p className="graph-empty">没有兼容且可添加的节点端口。</p>}
        </div>
      </section>
    </div>
  );
}

function NodeTypeMenu({
  nodeTypes: menuNodeTypes,
  onSelect,
}: {
  readonly nodeTypes: readonly NodeTypeDefinition[];
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  const roots = buildNodeTypeMenu(menuNodeTypes);
  return <>{roots.map((branch) => <NodeTypeMenuBranchView key={branch.title} branch={branch} onSelect={onSelect} />)}</>;
}

interface NodeTypeMenuBranch {
  readonly title: string;
  readonly branches: readonly NodeTypeMenuBranch[];
  readonly nodeTypes: readonly NodeTypeDefinition[];
}

function NodeTypeMenuBranchView({
  branch,
  onSelect,
}: {
  readonly branch: NodeTypeMenuBranch;
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  return (
    <details className="graph-node-type-branch" open>
      <summary>{branch.title}</summary>
      <div>
        {branch.branches.map((child) => <NodeTypeMenuBranchView key={child.title} branch={child} onSelect={onSelect} />)}
        {branch.nodeTypes.map((nodeType) => <NodeTypeOption key={`${nodeType.catalogId}:${nodeType.id}`} nodeType={nodeType} onSelect={onSelect} />)}
      </div>
    </details>
  );
}

function NodeTypeOption({
  nodeType,
  onSelect,
}: {
  readonly nodeType: NodeTypeDefinition;
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  return (
    <button type="button" className="graph-node-type-option" onClick={() => onSelect(nodeType.id)}>
      <strong>{nodeType.title}</strong>
      <span>{getNodeTypeDisplayPath(nodeType)}</span>
      <code>{nodeType.id}</code>
    </button>
  );
}

function buildNodeTypeMenu(nodeTypes: readonly NodeTypeDefinition[]): readonly NodeTypeMenuBranch[] {
  interface MutableBranch {
    title: string;
    branches: Map<string, MutableBranch>;
    nodeTypes: NodeTypeDefinition[];
  }
  const root: MutableBranch = { title: "root", branches: new Map(), nodeTypes: [] };
  nodeTypes.forEach((nodeType) => {
    const path = [nodeType.catalogTitle, ...getNodeTypeRelativePath(nodeType)];
    let current = root;
    path.forEach((segment) => {
      let branch = current.branches.get(segment);
      if (branch === undefined) {
        branch = { title: segment, branches: new Map(), nodeTypes: [] };
        current.branches.set(segment, branch);
      }
      current = branch;
    });
    current.nodeTypes.push(nodeType);
  });
  // Localized title collation is UI-only; protocol data, hashes, and cursors never consume this order.
  const freeze = (branch: MutableBranch): NodeTypeMenuBranch => ({
    title: branch.title,
    branches: [...branch.branches.values()].sort((left, right) => left.title.localeCompare(right.title)).map(freeze),
    nodeTypes: [...branch.nodeTypes].sort((left, right) => left.title.localeCompare(right.title)),
  });
  return [...root.branches.values()].sort((left, right) => left.title.localeCompare(right.title)).map(freeze);
}

function getNodeTypeRelativePath(nodeType: NodeTypeDefinition): readonly string[] {
  return nodeType.menuPath?.length ? nodeType.menuPath : [nodeType.category || "Other"];
}

function getNodeTypeDisplayPath(nodeType: NodeTypeDefinition): string {
  return [nodeType.catalogTitle, ...getNodeTypeRelativePath(nodeType), nodeType.title].join(" / ");
}

export function SubgraphTypePicker({
  options,
  onCancel,
  onSelect,
}: {
  readonly options: readonly SubgraphTypeOption[];
  readonly onCancel: () => void;
  readonly onSelect: (graphTypeId: string, nodeTypeId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = options.filter(({ graphType, nodeType }) =>
    [nodeType.catalogTitle, nodeType.catalogId, graphType.catalogTitle, graphType.catalogId, graphType.title, graphType.id, nodeType.title, nodeType.id, ...(nodeType.menuPath ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
  return (
    <div className="graph-modal-backdrop" onMouseDown={onCancel}>
      <section className="graph-node-picker" role="dialog" aria-modal="true" aria-label="添加类型化子图" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>添加类型化子图</h2><button type="button" className="secondary" onClick={onCancel}>关闭</button></header>
        <input autoFocus placeholder="搜索图类型或调用节点类型…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="graph-node-type-list">
          {filtered.map(({ graphType, nodeType }) => (
            <button
              key={`${graphType.catalogId}:${graphType.id}:${nodeType.catalogId}:${nodeType.id}`}
              type="button"
              className="graph-node-type-option"
              onClick={() => onSelect(graphType.id, nodeType.id)}
            >
              <strong>{nodeType.title}</strong>
              <span>{getNodeTypeDisplayPath(nodeType)} · 创建 {graphType.catalogTitle} / {graphType.title}</span>
              <code>{nodeType.id} → {graphType.id}</code>
            </button>
          ))}
          {filtered.length === 0 && <p className="graph-empty">没有兼容的类型化子图。</p>}
        </div>
      </section>
    </div>
  );
}

export function ReadonlyField({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return <label className="graph-field"><span>{label}</span><input value={value} readOnly /></label>;
}

export function InputField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return <label className="graph-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function InvalidDocument({ diagnostics }: { readonly diagnostics: readonly DocumentDiagnostic[] }): React.JSX.Element {
  return (
    <main className="graph-invalid"><section><h2>图文档无效</h2><p>请切换到文本编辑器修复以下问题，然后重新打开。</p><ul>
      {diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${diagnostic.path}:${index}`}>{diagnostic.path}: {diagnostic.message}</li>)}
    </ul></section></main>
  );
}

export function LoadingDocument(): React.JSX.Element {
  return <main className="graph-invalid"><section><h2>正在加载图文档…</h2></section></main>;
}
