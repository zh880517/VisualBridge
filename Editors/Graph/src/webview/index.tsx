import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

interface GraphNodeModel {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly position: GraphPosition;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

interface GraphEndpoint {
  readonly nodeId: string;
  readonly portId: string;
}

interface GraphEdgeModel {
  readonly id: string;
  readonly source: GraphEndpoint;
  readonly target: GraphEndpoint;
}

interface GraphDocument {
  readonly formatVersion: 1;
  readonly documentId: string;
  readonly nodes: readonly GraphNodeModel[];
  readonly edges: readonly GraphEdgeModel[];
}

interface DocumentDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type GraphOperation =
  | { readonly type: "graph.addNode"; readonly node: GraphNodeModel }
  | { readonly type: "graph.removeNode"; readonly nodeId: string }
  | { readonly type: "graph.moveNode"; readonly nodeId: string; readonly position: GraphPosition }
  | {
      readonly type: "graph.updateNode";
      readonly nodeId: string;
      readonly nodeType: string;
      readonly title: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }
  | { readonly type: "graph.addEdge"; readonly edge: GraphEdgeModel }
  | { readonly type: "graph.removeEdge"; readonly edgeId: string };

interface GraphNodeData extends Record<string, unknown> {
  readonly model: GraphNodeModel;
}

interface GraphEdgeData extends Record<string, unknown> {
  readonly model: GraphEdgeModel;
}

type GraphFlowNode = Node<GraphNodeData, "visualBridgeNode">;
type GraphFlowEdge = Edge<GraphEdgeData, "default">;
type Selection = { readonly kind: "node" | "edge"; readonly id: string };

type HostMessage =
  | {
      readonly type: "graphState";
      readonly documentVersion: number;
      readonly document: GraphDocument;
      readonly diagnostics: readonly DocumentDiagnostic[];
    }
  | {
      readonly type: "graphInvalid";
      readonly documentVersion: number;
      readonly diagnostics: readonly DocumentDiagnostic[];
    }
  | { readonly type: "operationRejected"; readonly message: string };

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const nodeTypes = { visualBridgeNode: VisualBridgeNode };

function VisualBridgeNode({ data, selected }: NodeProps<GraphFlowNode>): React.JSX.Element {
  const node = data.model;
  return (
    <article className={`graph-node${selected ? " selected" : ""}`}>
      <Handle
        id="input"
        type="target"
        position={Position.Left}
        className="graph-handle"
        title="输入端口"
      />
      <header className="graph-node-header" title={node.title || node.type}>
        {node.title || node.type}
      </header>
      <div className="graph-node-body">
        <div className="graph-node-type">{node.type}</div>
        <div className="graph-node-id">{node.id}</div>
      </div>
      <Handle
        id="output"
        type="source"
        position={Position.Right}
        className="graph-handle"
        title="输出端口"
      />
    </article>
  );
}

function GraphEditorApp(): React.JSX.Element {
  const rootMetadata = useMemo(readMetadata, []);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphDocument | undefined>(undefined);
  const documentVersionRef = useRef(0);
  const pendingRef = useRef(false);
  const selectedRef = useRef<Selection | undefined>(undefined);
  const [graph, setGraph] = useState<GraphDocument | undefined>(undefined);
  const [documentVersion, setDocumentVersion] = useState(0);
  const [flowNodes, setFlowNodes] = useState<GraphFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<GraphFlowEdge[]>([]);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<GraphFlowNode, GraphFlowEdge>>();
  const [selected, setSelected] = useState<Selection | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [invalidDiagnostics, setInvalidDiagnostics] = useState<readonly DocumentDiagnostic[]>([]);
  const [status, setStatus] = useState({ message: "正在加载 Graph Document…", error: false });

  const updateSelection = useCallback((next: Selection | undefined): void => {
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const postOperations = useCallback((operations: readonly GraphOperation[]): void => {
    if (graphRef.current === undefined || pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setStatus({ message: "正在应用修改…", error: false });
    vscode.postMessage({
      type: "applyOperations",
      documentVersion: documentVersionRef.current,
      operations,
    });
  }, []);

  useEffect(() => {
    const receiveMessage = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "graphState") {
        graphRef.current = message.document;
        documentVersionRef.current = message.documentVersion;
        pendingRef.current = false;
        setGraph(message.document);
        setDocumentVersion(message.documentVersion);
        setPending(false);
        setInvalidDiagnostics([]);

        const nextSelection = keepValidSelection(selectedRef.current, message.document);
        updateSelection(nextSelection);
        setFlowNodes(message.document.nodes.map((node) => toFlowNode(node, nextSelection)));
        setFlowEdges(message.document.edges.map((edge) => toFlowEdge(edge, nextSelection)));

        const firstError = message.diagnostics.find((diagnostic) => diagnostic.severity === "error");
        setStatus(firstError === undefined
          ? { message: "就绪", error: false }
          : { message: `${firstError.path}: ${firstError.message}`, error: true });
        return;
      }
      if (message.type === "graphInvalid") {
        graphRef.current = undefined;
        documentVersionRef.current = message.documentVersion;
        pendingRef.current = false;
        updateSelection(undefined);
        setGraph(undefined);
        setDocumentVersion(message.documentVersion);
        setFlowNodes([]);
        setFlowEdges([]);
        setPending(false);
        setInvalidDiagnostics(message.diagnostics);
        setStatus({ message: "Graph Document 解析失败。", error: true });
        return;
      }
      if (message.type === "operationRejected") {
        pendingRef.current = false;
        setPending(false);
        setStatus({ message: message.message, error: true });
        vscode.postMessage({ type: "ready" });
      }
    };

    window.addEventListener("message", receiveMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", receiveMessage);
  }, [updateSelection]);

  const handleNodesChange = useCallback((changes: NodeChange<GraphFlowNode>[]): void => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<GraphFlowEdge>[]): void => {
    setFlowEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const handleSelectionChange = useCallback((selection: {
    nodes: GraphFlowNode[];
    edges: GraphFlowEdge[];
  }): void => {
    const node = selection.nodes[0];
    if (node !== undefined) {
      updateSelection({ kind: "node", id: node.id });
      return;
    }
    const edge = selection.edges[0];
    updateSelection(edge === undefined ? undefined : { kind: "edge", id: edge.id });
  }, [updateSelection]);

  const handleConnect = useCallback((connection: Connection): void => {
    if (connection.source === null || connection.target === null) {
      return;
    }
    postOperations([{
      type: "graph.addEdge",
      edge: {
        id: newId("edge"),
        source: { nodeId: connection.source, portId: connection.sourceHandle ?? "output" },
        target: { nodeId: connection.target, portId: connection.targetHandle ?? "input" },
      },
    }]);
  }, [postOperations]);

  const handleNodeDragStop = useCallback((_: MouseEvent | TouchEvent, node: GraphFlowNode): void => {
    const sourceNode = graphRef.current?.nodes.find((candidate) => candidate.id === node.id);
    if (sourceNode === undefined) {
      return;
    }
    const position = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
    if (position.x !== sourceNode.position.x || position.y !== sourceNode.position.y) {
      postOperations([{ type: "graph.moveNode", nodeId: node.id, position }]);
    }
  }, [postOperations]);

  const addNode = useCallback((): void => {
    const currentGraph = graphRef.current;
    if (currentGraph === undefined) {
      return;
    }
    const bounds = canvasRef.current?.getBoundingClientRect();
    const fallback = { x: 80 + currentGraph.nodes.length * 24, y: 80 + currentGraph.nodes.length * 18 };
    const rawPosition = flowInstance === undefined || bounds === undefined
      ? fallback
      : flowInstance.screenToFlowPosition({
          x: bounds.left + bounds.width * 0.42,
          y: bounds.top + bounds.height * 0.42,
        });
    const index = currentGraph.nodes.length + 1;
    postOperations([{
      type: "graph.addNode",
      node: {
        id: newId("node"),
        type: "Node",
        title: `Node ${index}`,
        position: { x: Math.round(rawPosition.x), y: Math.round(rawPosition.y) },
        properties: {},
      },
    }]);
  }, [flowInstance, postOperations]);

  const deleteSelection = useCallback((): void => {
    const current = selectedRef.current;
    if (current === undefined || pendingRef.current) {
      return;
    }
    updateSelection(undefined);
    postOperations([current.kind === "node"
      ? { type: "graph.removeNode", nodeId: current.id }
      : { type: "graph.removeEdge", edgeId: current.id }]);
  }, [postOperations, updateSelection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      const editing = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable);
      if (!editing && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelection]);

  return (
    <div className="graph-app">
      <header className="graph-toolbar">
        <button type="button" onClick={addNode} disabled={graph === undefined || pending}>添加节点</button>
        <button
          type="button"
          className="secondary"
          onClick={deleteSelection}
          disabled={selected === undefined || pending}
        >
          删除所选
        </button>
        <span className="graph-hint">从输出端口拖到输入端口以创建连线</span>
        <span className="graph-toolbar-spacer" />
        <span className="graph-metadata" title={rootMetadata.relativePath}>
          {rootMetadata.projectId} · {rootMetadata.documentType} · {rootMetadata.relativePath}
        </span>
      </header>

      {graph === undefined
        ? invalidDiagnostics.length > 0
          ? <InvalidDocument diagnostics={invalidDiagnostics} />
          : <LoadingDocument />
        : (
          <main className="graph-content">
            <div ref={canvasRef} className="graph-canvas">
              <ReactFlow<GraphFlowNode, GraphFlowEdge>
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onSelectionChange={handleSelectionChange}
                onConnect={handleConnect}
                onNodeDragStop={handleNodeDragStop}
                onInit={setFlowInstance}
                nodesDraggable={!pending}
                nodesConnectable={!pending}
                elementsSelectable={!pending}
                deleteKeyCode={null}
                connectionRadius={24}
                snapToGrid
                snapGrid={[10, 10]}
                fitView
                fitViewOptions={{ maxZoom: 1, padding: 0.24 }}
                minZoom={0.2}
                maxZoom={2}
                defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
            <Inspector
              key={`${selected?.kind ?? "none"}:${selected?.id ?? "none"}:${documentVersion}`}
              graph={graph}
              selected={selected}
              pending={pending}
              postOperations={postOperations}
              reportStatus={setStatus}
            />
          </main>
        )}

      <footer className={`graph-status${status.error ? " error" : ""}`}>
        <span>{status.message}</span>
      </footer>
    </div>
  );
}

interface InspectorProps {
  readonly graph: GraphDocument;
  readonly selected: Selection | undefined;
  readonly pending: boolean;
  readonly postOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
}

function Inspector({
  graph,
  selected,
  pending,
  postOperations,
  reportStatus,
}: InspectorProps): React.JSX.Element {
  const node = selected?.kind === "node"
    ? graph.nodes.find((candidate) => candidate.id === selected.id)
    : undefined;
  const edge = selected?.kind === "edge"
    ? graph.edges.find((candidate) => candidate.id === selected.id)
    : undefined;
  const [title, setTitle] = useState(node?.title ?? "");
  const [nodeType, setNodeType] = useState(node?.type ?? "");
  const [propertiesText, setPropertiesText] = useState(
    node === undefined ? "{}" : JSON.stringify(node.properties, undefined, 2),
  );

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (node === undefined) {
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeType)) {
      reportStatus({ message: "节点类型必须是有效标识符。", error: true });
      return;
    }
    let properties: unknown;
    try {
      properties = JSON.parse(propertiesText);
    } catch (error) {
      reportStatus({ message: `属性 JSON 无法解析：${String(error)}`, error: true });
      return;
    }
    if (!isJsonObject(properties)) {
      reportStatus({ message: "节点属性必须是 JSON 对象。", error: true });
      return;
    }
    postOperations([{
      type: "graph.updateNode",
      nodeId: node.id,
      nodeType,
      title,
      properties,
    }]);
  };

  return (
    <aside className="graph-inspector">
      <h2>Inspector</h2>
      {node !== undefined && (
        <form onSubmit={submit}>
          <ReadonlyField label="ID" value={node.id} />
          <InputField label="标题" value={title} onChange={setTitle} />
          <InputField label="类型" value={nodeType} onChange={setNodeType} />
          <label className="graph-field">
            <span>属性（JSON）</span>
            <textarea
              value={propertiesText}
              onChange={(event) => setPropertiesText(event.target.value)}
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={pending}>应用修改</button>
        </form>
      )}
      {edge !== undefined && (
        <div>
          <ReadonlyField label="ID" value={edge.id} />
          <ReadonlyField label="来源" value={`${edge.source.nodeId} / ${edge.source.portId}`} />
          <ReadonlyField label="目标" value={`${edge.target.nodeId} / ${edge.target.portId}`} />
        </div>
      )}
      {node === undefined && edge === undefined && (
        <p className="graph-empty">选择一个节点或连线以查看和编辑。</p>
      )}
    </aside>
  );
}

function ReadonlyField({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <label className="graph-field">
      <span>{label}</span>
      <input value={value} readOnly />
    </label>
  );
}

function InputField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="graph-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function InvalidDocument({ diagnostics }: { readonly diagnostics: readonly DocumentDiagnostic[] }): React.JSX.Element {
  return (
    <main className="graph-invalid">
      <section>
        <h2>Graph Document 无效</h2>
        <p>请切换到文本编辑器修复以下问题，然后重新打开。</p>
        <ul>
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}:${diagnostic.path}:${index}`}>
              {diagnostic.path}: {diagnostic.message}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function LoadingDocument(): React.JSX.Element {
  return (
    <main className="graph-invalid">
      <section>
        <h2>正在加载 Graph Document…</h2>
      </section>
    </main>
  );
}

function toFlowNode(node: GraphNodeModel, selected: Selection | undefined): GraphFlowNode {
  return {
    id: node.id,
    type: "visualBridgeNode",
    position: { ...node.position },
    data: { model: node },
    selected: selected?.kind === "node" && selected.id === node.id,
  };
}

function toFlowEdge(edge: GraphEdgeModel, selected: Selection | undefined): GraphFlowEdge {
  return {
    id: edge.id,
    type: "default",
    source: edge.source.nodeId,
    sourceHandle: edge.source.portId,
    target: edge.target.nodeId,
    targetHandle: edge.target.portId,
    data: { model: edge },
    selected: selected?.kind === "edge" && selected.id === edge.id,
  };
}

function keepValidSelection(selection: Selection | undefined, graph: GraphDocument): Selection | undefined {
  if (selection?.kind === "node" && graph.nodes.some((node) => node.id === selection.id)) {
    return selection;
  }
  if (selection?.kind === "edge" && graph.edges.some((edge) => edge.id === selection.id)) {
    return selection;
  }
  return undefined;
}

function newId(prefix: string): string {
  const suffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}

function readMetadata(): { projectId: string; documentType: string; relativePath: string } {
  const root = document.getElementById("root");
  if (root === null) {
    throw new Error("VisualBridge Graph root element was not found.");
  }
  return {
    projectId: root.dataset.projectId ?? "",
    documentType: root.dataset.documentType ?? "",
    relativePath: root.dataset.relativePath ?? "",
  };
}

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("VisualBridge Graph root element was not found.");
}

createRoot(rootElement).render(
  <ReactFlowProvider>
    <GraphEditorApp />
  </ReactFlowProvider>,
);
