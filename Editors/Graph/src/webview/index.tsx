import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type PortKind = "flow" | "data";
type PortDirection = "input" | "output";

interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

interface GraphNodeBase {
  readonly id: string;
  readonly title: string;
  readonly position: GraphPosition;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

interface GraphAtomicNode extends GraphNodeBase {
  readonly kind: "node";
  readonly nodeTypeId: string;
  readonly dynamicPorts: readonly GraphDynamicPort[];
}

interface GraphDynamicPort {
  readonly id: string;
  readonly groupId: string;
  readonly title: string;
  readonly value: JsonValue;
}

interface GraphSubgraphNode extends GraphNodeBase {
  readonly kind: "subgraph";
  readonly nodeTypeId?: string;
  readonly subgraphId: string;
  readonly dynamicPorts: readonly GraphDynamicPort[];
}

type GraphNodeModel = GraphAtomicNode | GraphSubgraphNode;

interface GraphNodeEndpoint {
  readonly kind: "node";
  readonly nodeId: string;
  readonly portId: string;
}

interface GraphInterfaceEndpoint {
  readonly kind: "interface";
  readonly portId: string;
}

type GraphEndpoint = GraphNodeEndpoint | GraphInterfaceEndpoint;

interface GraphEdgeModel {
  readonly id: string;
  readonly kind: PortKind;
  readonly source: GraphEndpoint;
  readonly target: GraphEndpoint;
}

interface PortDefinition {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly kind: PortKind;
  readonly direction: PortDirection;
  readonly dataTypeId?: string;
  readonly maxConnections?: number;
}

interface PropertyEditorOption {
  readonly title: string;
  readonly value: JsonValue;
}

interface PropertyEditorDefinition {
  readonly kind: "text" | "multiline" | "number" | "checkbox" | "select" | "json" | "reference";
  readonly readOnly: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly options: readonly PropertyEditorOption[];
}

interface PropertyDefinition {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly valueType: "string" | "number" | "boolean" | "json";
  readonly dataTypeId?: string;
  readonly required: boolean;
  readonly defaultValue?: JsonValue;
  readonly editor?: PropertyEditorDefinition;
}

interface DynamicPortGroupDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly port: {
    readonly kind: PortKind;
    readonly direction: PortDirection;
    readonly dataTypeId?: string;
    readonly maxConnections?: number;
  };
  readonly item: {
    readonly valueType: PropertyDefinition["valueType"];
    readonly dataTypeId?: string;
    readonly defaultValue: JsonValue;
    readonly editor?: PropertyEditorDefinition;
  };
  readonly maxItems?: number;
}

interface NodeTypeDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly icon?: string;
  readonly category: string;
  readonly menuPath?: readonly string[];
  readonly tags?: readonly string[];
  readonly traits?: readonly string[];
  readonly subgraph?: { readonly graphTypeIds?: readonly string[] };
  readonly ports: readonly PortDefinition[];
  readonly dynamicPortGroups?: readonly DynamicPortGroupDefinition[];
  readonly properties: readonly PropertyDefinition[];
}

interface DataTypeDefinition {
  readonly id: string;
  readonly title: string;
  readonly accepts: readonly string[];
}

interface NodeSelector {
  readonly nodeTypeIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly traits?: readonly string[];
}

interface NodeCountConstraint {
  readonly id: string;
  readonly selector: NodeSelector;
  readonly minInstances?: number;
  readonly maxInstances?: number;
}

interface InitialNodeDefinition {
  readonly nodeTypeId: string;
  readonly title?: string;
}

interface GraphTypeDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly usage: "root" | "subgraph" | "any";
  readonly allowedNodeSelectors?: readonly NodeSelector[];
  readonly properties: readonly PropertyDefinition[];
  readonly nodeConstraints: readonly NodeCountConstraint[];
  readonly initialNodes: readonly InitialNodeDefinition[];
  readonly allowSubgraphs: boolean;
  readonly allowedSubgraphTypeIds?: readonly string[];
}

interface GraphCatalog {
  readonly formatVersion: 3;
  readonly catalogId: string;
  readonly title: string;
  readonly dataTypes: readonly DataTypeDefinition[];
  readonly graphTypes: readonly GraphTypeDefinition[];
  readonly nodeTypes: readonly NodeTypeDefinition[];
}

interface GraphDefinition {
  readonly id: string;
  readonly graphTypeId?: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly interfacePorts: readonly PortDefinition[];
  readonly nodes: readonly GraphNodeModel[];
  readonly edges: readonly GraphEdgeModel[];
}

interface GraphDocument {
  readonly formatVersion: 3;
  readonly documentId: string;
  readonly rootGraphId: string;
  readonly graphs: readonly GraphDefinition[];
}

interface DocumentDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type GraphOperation =
  | { readonly type: "graph.addNode"; readonly graphId: string; readonly node: GraphAtomicNode }
  | {
      readonly type: "graph.addSubgraph";
      readonly graphId: string;
      readonly node: GraphSubgraphNode;
      readonly subgraph: GraphDefinition;
    }
  | { readonly type: "graph.removeNode"; readonly graphId: string; readonly nodeId: string }
  | {
      readonly type: "graph.moveNode";
      readonly graphId: string;
      readonly nodeId: string;
      readonly position: GraphPosition;
    }
  | {
      readonly type: "graph.updateNode";
      readonly graphId: string;
      readonly nodeId: string;
      readonly title: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly type: "graph.replaceNodeType";
      readonly graphId: string;
      readonly nodeId: string;
      readonly nodeTypeId: string;
    }
  | { readonly type: "graph.addDynamicPort"; readonly graphId: string; readonly nodeId: string; readonly port: GraphDynamicPort }
  | {
      readonly type: "graph.updateDynamicPort";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portId: string;
      readonly title: string;
      readonly value: JsonValue;
    }
  | { readonly type: "graph.removeDynamicPort"; readonly graphId: string; readonly nodeId: string; readonly portId: string }
  | {
      readonly type: "graph.reorderDynamicPorts";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portIds: readonly string[];
    }
  | { readonly type: "graph.addEdge"; readonly graphId: string; readonly edge: GraphEdgeModel }
  | { readonly type: "graph.removeEdge"; readonly graphId: string; readonly edgeId: string }
  | { readonly type: "graph.assignType"; readonly graphId: string; readonly graphTypeId: string }
  | {
      readonly type: "graph.updateGraph";
      readonly graphId: string;
      readonly title: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }
  | { readonly type: "graph.addInterfacePort"; readonly graphId: string; readonly port: PortDefinition }
  | {
      readonly type: "graph.updateInterfacePort";
      readonly graphId: string;
      readonly portId: string;
      readonly title: string;
    }
  | { readonly type: "graph.removeInterfacePort"; readonly graphId: string; readonly portId: string };

interface GraphNodeData extends Record<string, unknown> {
  readonly flavor: "node";
  readonly graphId: string;
  readonly model: GraphNodeModel;
  readonly nodeType?: NodeTypeDefinition;
  readonly ports: readonly PortDefinition[];
  readonly typeTitle: string;
  readonly overriddenPropertyIds: ReadonlySet<string>;
  readonly commitNode: (
    nodeId: string,
    title: string,
    properties: Readonly<Record<string, JsonValue>>,
  ) => void;
  readonly commitOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
}

interface GraphInterfaceData extends Record<string, unknown> {
  readonly flavor: "interface";
  readonly title: string;
  readonly side: "inputs" | "outputs";
  readonly ports: readonly PortDefinition[];
}

type GraphCanvasNodeData = GraphNodeData | GraphInterfaceData;
type GraphFlowNode = Node<GraphCanvasNodeData, "visualBridgeNode" | "visualBridgeInterface">;

interface GraphEdgeData extends Record<string, unknown> {
  readonly model: GraphEdgeModel;
}

type GraphFlowEdge = Edge<GraphEdgeData, "default">;
interface Selection {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

type NodePickerState =
  | { readonly mode: "add" }
  | { readonly mode: "replace"; readonly nodeId: string }
  | {
      readonly mode: "connect";
      readonly fromNodeId: string;
      readonly fromPortId: string;
      readonly fromRole: "source" | "target";
      readonly fromPort: PortDefinition;
      readonly position: GraphPosition;
    };

interface ConnectionNodeOption {
  readonly nodeType: NodeTypeDefinition;
  readonly port: PortDefinition;
}

interface SubgraphTypeOption {
  readonly graphType: GraphTypeDefinition;
  readonly nodeType: NodeTypeDefinition;
}

interface GraphClipboardPayload {
  readonly format: "visualbridge.graph-clipboard";
  readonly version: 1;
  readonly nodes: readonly GraphAtomicNode[];
  readonly edges: readonly GraphEdgeModel[];
}

type HostMessage =
  | {
      readonly type: "graphState";
      readonly documentVersion: number;
      readonly document: GraphDocument;
      readonly catalog: GraphCatalog;
      readonly diagnostics: readonly DocumentDiagnostic[];
    }
  | {
      readonly type: "graphInvalid";
      readonly documentVersion: number;
      readonly diagnostics: readonly DocumentDiagnostic[];
    }
  | {
      readonly type: "replacementCandidates";
      readonly documentVersion: number;
      readonly graphId: string;
      readonly nodeId: string;
      readonly nodeTypeIds: readonly string[];
    }
  | { readonly type: "clipboardData"; readonly text: string }
  | { readonly type: "operationRejected"; readonly message: string };

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const INTERFACE_INPUT_NODE_ID = "$visualbridge.interface.inputs";
const INTERFACE_OUTPUT_NODE_ID = "$visualbridge.interface.outputs";
const GraphPendingContext = createContext(false);
const GraphNodeTypeVisibilityContext = createContext(true);
const GraphNodeIdVisibilityContext = createContext(false);
const nodeTypes = {
  visualBridgeNode: VisualBridgeNode,
  visualBridgeInterface: VisualBridgeInterfaceNode,
};

function VisualBridgeNode({ data, selected }: NodeProps<GraphFlowNode>): React.JSX.Element {
  const pending = useContext(GraphPendingContext);
  const showNodeTypes = useContext(GraphNodeTypeVisibilityContext);
  const showNodeIds = useContext(GraphNodeIdVisibilityContext);
  if (data.flavor !== "node") {
    return <article className="graph-node">Invalid node</article>;
  }
  const propertyInputPortIds = new Set(
    (data.nodeType?.properties ?? []).flatMap((property) => {
      const port = resolvePropertyInputPort(data.nodeType, property);
      return port === undefined ? [] : [port.id];
    }),
  );
  const dynamicPortIds = new Set(data.model.dynamicPorts.map((port) => port.id));
  const flowInputs = data.ports.filter(
    (port) => port.kind === "flow" && port.direction === "input" && !dynamicPortIds.has(port.id),
  );
  const flowOutputs = data.ports.filter(
    (port) => port.kind === "flow" && port.direction === "output" && !dynamicPortIds.has(port.id),
  );
  const dataInputs = data.ports.filter(
    (port) => port.kind === "data"
      && port.direction === "input"
      && !propertyInputPortIds.has(port.id)
      && !dynamicPortIds.has(port.id),
  );
  const dataOutputs = data.ports.filter(
    (port) => port.kind === "data" && port.direction === "output" && !dynamicPortIds.has(port.id),
  );
  return (
    <article className={`graph-node${selected ? " selected" : ""}${data.model.kind === "subgraph" ? " subgraph" : ""}`}>
      <header className="graph-node-header" title={data.model.title || data.typeTitle}>
        <span className={`graph-node-icon${data.nodeType?.icon === undefined ? " empty" : ""}`} aria-hidden="true">
          {data.nodeType?.icon ?? ""}
        </span>
        <InlineNodeTitle data={data} pending={pending} />
      </header>
      {showNodeTypes && <div className="graph-node-type">{data.typeTitle}</div>}
      {(flowInputs.length > 0 || flowOutputs.length > 0) && (
        <div className="graph-port-columns flow">
          <PortColumn ports={flowInputs} />
          <PortColumn ports={flowOutputs} align="right" />
        </div>
      )}
      <InlineNodeProperties data={data} pending={pending} />
      <InlineDynamicPorts data={data} pending={pending} />
      {(dataInputs.length > 0 || dataOutputs.length > 0) && (
        <div className="graph-port-columns data">
          <PortColumn ports={dataInputs} />
          <PortColumn ports={dataOutputs} align="right" />
        </div>
      )}
      {showNodeIds && <div className="graph-node-id">{data.model.id}</div>}
    </article>
  );
}

function InlineNodeTitle({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element {
  const [title, setTitle] = useState(data.model.title);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setTitle(data.model.title);
    setEditing(false);
  }, [data.model.title]);
  const commit = (): void => {
    if (title !== data.model.title) {
      data.commitNode(data.model.id, title, data.model.properties);
    }
  };
  if (!editing) {
    return (
      <span
        className="graph-node-title-display"
        title="双击编辑节点名称"
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!pending) {
            setEditing(true);
          }
        }}
      >
        {data.model.title}
      </span>
    );
  }
  return (
    <input
      autoFocus
      className="graph-node-title-input nodrag nowheel"
      aria-label="节点标题"
      value={title}
      disabled={pending}
      onChange={(event) => setTitle(event.target.value)}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => {
        commit();
        setEditing(false);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setTitle(data.model.title);
          setEditing(false);
        }
      }}
    />
  );
}

function resolvePropertyInputPort(
  nodeType: NodeTypeDefinition | undefined,
  property: PropertyDefinition,
): PortDefinition | undefined {
  if (nodeType === undefined) {
    return undefined;
  }
  const propertyIds = new Set([property.id, ...(property.aliases ?? [])]);
  return nodeType.ports.find((port) =>
    port.kind === "data"
    && port.direction === "input"
    && [port.id, ...(port.aliases ?? [])].some((portId) => propertyIds.has(portId)),
  );
}

function InlineNodeProperties({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element {
  const definitions = data.nodeType?.properties ?? [];
  return (
    <div className="graph-node-properties nodrag nowheel" onDoubleClick={(event) => event.stopPropagation()}>
      {definitions.map((definition) => (
        <InlineNodeProperty key={definition.id} data={data} definition={definition} pending={pending} />
      ))}
    </div>
  );
}

function InlineNodeProperty({
  data,
  definition,
  pending,
}: {
  readonly data: GraphNodeData;
  readonly definition: PropertyDefinition;
  readonly pending: boolean;
}): React.JSX.Element {
  const propertyIds = [definition.id, ...(definition.aliases ?? [])];
  const serializedPropertyIds = propertyIds.filter((propertyId) => Object.hasOwn(data.model.properties, propertyId));
  const serializedPropertyId = serializedPropertyIds[0];
  const value = serializedPropertyId === undefined ? undefined : data.model.properties[serializedPropertyId];
  const overridden = data.overriddenPropertyIds.has(definition.id);
  const inputPort = resolvePropertyInputPort(data.nodeType, definition);
  const fieldTitle = definition.title;
  const commit = (nextValue: JsonValue | undefined): void => {
    if (
      (nextValue === undefined && serializedPropertyIds.length === 0)
      || (nextValue !== undefined && serializedPropertyIds.length === 1 && jsonValuesEqual(value, nextValue))
    ) {
      return;
    }
    const properties = { ...data.model.properties };
    propertyIds.forEach((propertyId) => delete properties[propertyId]);
    if (nextValue === undefined) {
      // Removing a field clears both its current ID and any historical aliases.
    } else {
      properties[serializedPropertyId ?? definition.id] = nextValue;
    }
    if (!jsonValuesEqual(properties, data.model.properties)) {
      data.commitNode(data.model.id, data.model.title, properties);
    }
  };
  const wrapEditor = (editor: React.JSX.Element): React.JSX.Element => (
    <div
      className={`graph-node-property-input${overridden ? " connected" : ""}`}
      title={overridden ? "输入端口已连接；字面值已保留，断开连接后可继续编辑。" : definition.description}
    >
      {inputPort !== undefined && (
        <Handle
          id={inputPort.id}
          type="target"
          position={Position.Left}
          className="graph-handle data"
          title={`${inputPort.title} · data${inputPort.dataTypeId === undefined ? "" : ` · ${inputPort.dataTypeId}`}`}
        />
      )}
      {overridden
        ? (
          <div className="graph-node-property-connected">
            <span>{fieldTitle}</span>
            <em>已连接</em>
          </div>
        )
        : editor}
    </div>
  );
  if (definition.editor?.kind === "select") {
    const selectedIndex = definition.editor.options.findIndex((option) => jsonValuesEqual(option.value, value));
    const selectedValue = selectedIndex < 0 ? "" : String(selectedIndex);
    return wrapEditor(
      <label className="graph-node-property">
        <span>{fieldTitle}</span>
        <select
          value={selectedValue}
          disabled={pending || definition.editor.readOnly}
          onChange={(event) => {
            const option = definition.editor?.options[Number(event.target.value)];
            if (option !== undefined) {
              commit(cloneJsonValue(option.value));
            }
          }}
        >
          {value === undefined && <option value="">未设置</option>}
          {definition.editor.options.map((option, index) => (
            <option key={`${index}:${JSON.stringify(option.value)}`} value={String(index)}>{option.title}</option>
          ))}
        </select>
      </label>,
    );
  }
  if (definition.valueType === "boolean" || definition.editor?.kind === "checkbox") {
    return wrapEditor(
      <label className="graph-node-property boolean">
        <span>{fieldTitle}</span>
        <input
          type="checkbox"
          checked={value === true}
          disabled={pending || definition.editor?.readOnly}
          onChange={(event) => commit(event.target.checked)}
        />
      </label>,
    );
  }
  return wrapEditor(
    <InlineNodeScalarProperty
      key={`${data.model.id}:${definition.id}:${JSON.stringify(value)}`}
      definition={definition}
      value={value}
      editor={definition.editor}
      pending={pending}
      commit={commit}
      reportStatus={data.reportStatus}
    />,
  );
}

function InlineNodeScalarProperty({
  definition,
  value,
  editor,
  pending,
  commit,
  reportStatus,
}: {
  readonly definition: PropertyDefinition;
  readonly value: JsonValue | undefined;
  readonly editor: PropertyEditorDefinition | undefined;
  readonly pending: boolean;
  readonly commit: (value: JsonValue | undefined) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
}): React.JSX.Element {
  const usesJsonEditor = definition.valueType === "json" || editor?.kind === "json";
  const usesMultilineEditor = editor?.kind === "multiline";
  const initialText = usesJsonEditor
    ? value === undefined ? "" : JSON.stringify(value)
    : value === undefined ? "" : String(value);
  const [text, setText] = useState(initialText);
  const finish = (): void => {
    if (definition.valueType === "number") {
      if (text.trim().length === 0) {
        commit(undefined);
        return;
      }
      const numberValue = Number(text);
      if (!Number.isFinite(numberValue)) {
        reportStatus({ message: `字段“${definition.title}”必须是有效数字。`, error: true });
        setText(initialText);
        return;
      }
      commit(numberValue);
      return;
    }
    if (usesJsonEditor) {
      if (text.trim().length === 0) {
        commit(undefined);
        return;
      }
      try {
        const jsonValue = JSON.parse(text) as unknown;
        if (!isJsonValue(jsonValue)) {
          throw new Error("值不是有效 JSON");
        }
        commit(jsonValue);
      } catch (errorValue) {
        reportStatus({ message: `字段“${definition.title}”无法解析：${String(errorValue)}`, error: true });
        setText(initialText);
      }
      return;
    }
    commit(text);
  };
  const commonProps = {
    value: text,
    readOnly: pending || (editor?.readOnly ?? false),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(event.target.value),
    onBlur: finish,
    onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (event.key === "Enter" && (!usesJsonEditor && !usesMultilineEditor || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        setText(initialText);
      }
    },
  };
  return (
    <label className="graph-node-property" title={definition.description}>
      <span>{definition.title}</span>
      {usesJsonEditor || usesMultilineEditor
        ? <textarea {...commonProps} rows={2} spellCheck={false} />
        : <input
            {...commonProps}
            type={definition.valueType === "number" ? "number" : "text"}
            {...(editor?.min === undefined ? {} : { min: editor.min })}
            {...(editor?.max === undefined ? {} : { max: editor.max })}
          />}
    </label>
  );
}

function InlineDynamicPorts({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element | null {
  const [selectedPortId, setSelectedPortId] = useState<string>();
  const [dragState, setDragState] = useState<{
    readonly sourcePortId: string;
    readonly targetPortId?: string;
    readonly position?: "before" | "after";
  }>();
  useEffect(() => {
    if (selectedPortId !== undefined && !data.model.dynamicPorts.some((port) => port.id === selectedPortId)) {
      setSelectedPortId(undefined);
    }
  }, [data.model.dynamicPorts, selectedPortId]);
  if (data.nodeType === undefined) {
    return null;
  }
  const groups = data.nodeType.dynamicPortGroups ?? [];
  if (groups.length === 0 && data.model.dynamicPorts.length === 0) {
    return null;
  }
  const reorder = (sourcePortId: string, targetPortId: string, position: "before" | "after"): void => {
    if (sourcePortId === targetPortId) {
      return;
    }
    const portIds = data.model.dynamicPorts.map((port) => port.id);
    const sourceIndex = portIds.indexOf(sourcePortId);
    if (sourceIndex < 0) {
      return;
    }
    portIds.splice(sourceIndex, 1);
    const targetIndex = portIds.indexOf(targetPortId);
    if (targetIndex < 0) {
      return;
    }
    portIds.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourcePortId);
    data.commitOperations([{
      type: "graph.reorderDynamicPorts",
      graphId: data.graphId,
      nodeId: data.model.id,
      portIds,
    }]);
  };
  return (
    <div className="graph-dynamic-port-groups nodrag nowheel" onDoubleClick={(event) => event.stopPropagation()}>
      {groups.map((group) => {
        const ports = data.model.dynamicPorts.filter((port) => group.id === port.groupId || group.aliases.includes(port.groupId));
        const canAdd = group.maxItems === undefined || ports.length < group.maxItems;
        const selectedPort = ports.find((port) => port.id === selectedPortId);
        const groupDragState = dragState !== undefined && ports.some((port) => port.id === dragState.sourcePortId)
          ? dragState
          : undefined;
        return (
          <section key={group.id} className="graph-dynamic-port-group" title={group.description}>
            <header>
              <strong>{group.title}</strong>
              <div className="graph-dynamic-port-group-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={pending || !canAdd}
                  aria-label={`添加动态端口 ${group.title}`}
                  title="添加元素"
                  onClick={() => {
                    const port: GraphDynamicPort = {
                      id: newId("port"),
                      groupId: group.id,
                      title: `${group.title} ${ports.length + 1}`,
                      value: cloneJsonValue(group.item.defaultValue),
                    };
                    setSelectedPortId(port.id);
                    data.commitOperations([{
                      type: "graph.addDynamicPort",
                      graphId: data.graphId,
                      nodeId: data.model.id,
                      port,
                    }]);
                  }}
                >
                  +
                </button>
                {selectedPort !== undefined && (
                  <button
                    type="button"
                    className="graph-dynamic-port-delete"
                    disabled={pending}
                    aria-label={`删除动态端口 ${selectedPort.title}`}
                    title="删除选中元素"
                    onClick={() => {
                      if (window.confirm("删除选中的动态元素？相关连线也会被删除。")) {
                        setSelectedPortId(undefined);
                        data.commitOperations([{
                          type: "graph.removeDynamicPort",
                          graphId: data.graphId,
                          nodeId: data.model.id,
                          portId: selectedPort.id,
                        }]);
                      }
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9h5.6l.7-9M6.5 6.5v4M9.5 6.5v4" />
                    </svg>
                  </button>
                )}
              </div>
            </header>
            {ports.map((port, portIndex) => (
              <DynamicPortRow
                key={port.id}
                data={data}
                group={group}
                port={port}
                pending={pending}
                selected={selectedPortId === port.id}
                onSelect={() => setSelectedPortId(port.id)}
                dragging={groupDragState?.sourcePortId === port.id}
                dropPosition={groupDragState?.targetPortId === port.id ? groupDragState.position : undefined}
                onDragStart={() => setDragState({ sourcePortId: port.id })}
                onDragOver={(position) => setDragState((current) => current === undefined
                  ? current
                  : { sourcePortId: current.sourcePortId, targetPortId: port.id, position })}
                onDrop={(sourcePortId, position) => {
                  if (ports.some((candidate) => candidate.id === sourcePortId)) {
                    reorder(sourcePortId, port.id, position);
                  }
                  setDragState(undefined);
                }}
                onDragEnd={() => setDragState(undefined)}
                onKeyboardMove={(offset) => {
                  const target = ports[portIndex + offset];
                  if (target !== undefined) {
                    reorder(port.id, target.id, offset < 0 ? "before" : "after");
                  }
                }}
              />
            ))}
            {ports.length === 0 && <span className="graph-node-no-properties">暂无端口</span>}
          </section>
        );
      })}
    </div>
  );
}

function DynamicPortRow({
  data,
  group,
  port,
  pending,
  selected,
  onSelect,
  dragging,
  dropPosition,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onKeyboardMove,
}: {
  readonly data: GraphNodeData;
  readonly group: DynamicPortGroupDefinition;
  readonly port: GraphDynamicPort;
  readonly pending: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly dragging: boolean;
  readonly dropPosition: "before" | "after" | undefined;
  readonly onDragStart: () => void;
  readonly onDragOver: (position: "before" | "after") => void;
  readonly onDrop: (sourcePortId: string, position: "before" | "after") => void;
  readonly onDragEnd: () => void;
  readonly onKeyboardMove: (offset: -1 | 1) => void;
}): React.JSX.Element {
  const model = data.model;
  const commit = (nextValue: JsonValue): void => {
    if (!jsonValuesEqual(nextValue, port.value)) {
      data.commitOperations([{
        type: "graph.updateDynamicPort",
        graphId: data.graphId,
        nodeId: model.id,
        portId: port.id,
        title: port.title,
        value: nextValue,
      }]);
    }
  };
  return (
    <article
      className={`graph-dynamic-port-row${selected ? " selected" : ""}${dragging ? " dragging" : ""}${dropPosition === undefined ? "" : ` drop-${dropPosition}`}`}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        onDragOver(event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
      }}
      onDrop={(event) => {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onDrop(
          event.dataTransfer.getData("text/plain"),
          event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
        );
      }}
    >
      <button
        type="button"
        className="graph-dynamic-port-drag"
        draggable={!pending}
        disabled={pending}
        aria-label={`拖动排序 ${port.title}`}
        title="拖动排序；Alt+↑/↓ 也可移动"
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", port.id);
          onSelect();
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            event.stopPropagation();
            onKeyboardMove(event.key === "ArrowUp" ? -1 : 1);
          }
        }}
      >
        <svg viewBox="0 0 12 16" aria-hidden="true">
          <circle cx="3" cy="3" r="1" /><circle cx="9" cy="3" r="1" />
          <circle cx="3" cy="8" r="1" /><circle cx="9" cy="8" r="1" />
          <circle cx="3" cy="13" r="1" /><circle cx="9" cy="13" r="1" />
        </svg>
      </button>
      <DynamicPortValueEditor
        group={group}
        port={port}
        pending={pending}
        commit={commit}
        reportStatus={data.reportStatus}
      />
      <Handle
        id={port.id}
        type={group.port.direction === "input" ? "target" : "source"}
        position={group.port.direction === "input" ? Position.Left : Position.Right}
        className={`graph-handle ${group.port.kind}`}
        title={`${group.title} · ${group.port.kind}${group.port.dataTypeId === undefined ? "" : ` · ${group.port.dataTypeId}`}`}
      />
    </article>
  );
}

function DynamicPortValueEditor({
  group,
  port,
  pending,
  commit,
  reportStatus,
}: {
  readonly group: DynamicPortGroupDefinition;
  readonly port: GraphDynamicPort;
  readonly pending: boolean;
  readonly commit: (value: JsonValue) => void;
  readonly reportStatus: GraphNodeData["reportStatus"];
}): React.JSX.Element {
  const definition: PropertyDefinition = {
    id: port.id,
    aliases: [],
    title: "值",
    valueType: group.item.valueType,
    ...(group.item.dataTypeId === undefined ? {} : { dataTypeId: group.item.dataTypeId }),
    required: true,
    defaultValue: group.item.defaultValue,
    ...(group.item.editor === undefined ? {} : { editor: group.item.editor }),
  };
  if (definition.editor?.kind === "select") {
    const selectedIndex = definition.editor.options.findIndex((option) => jsonValuesEqual(option.value, port.value));
    return (
      <select
        aria-label={`动态端口值 ${port.id}`}
        value={selectedIndex < 0 ? "" : String(selectedIndex)}
        disabled={pending || definition.editor.readOnly}
        onChange={(event) => {
          const option = definition.editor?.options[Number(event.target.value)];
          if (option !== undefined) {
            commit(cloneJsonValue(option.value));
          }
        }}
      >
        {selectedIndex < 0 && <option value="">未设置</option>}
        {definition.editor.options.map((option, index) => (
          <option key={`${index}:${JSON.stringify(option.value)}`} value={String(index)}>{option.title}</option>
        ))}
      </select>
    );
  }
  if (definition.valueType === "boolean" || definition.editor?.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={`动态端口值 ${port.id}`}
        checked={port.value === true}
        disabled={pending || definition.editor?.readOnly}
        onChange={(event) => commit(event.target.checked)}
      />
    );
  }
  return (
    <InlineNodeScalarProperty
      key={`${port.id}:${JSON.stringify(port.value)}`}
      definition={definition}
      value={port.value}
      editor={definition.editor}
      pending={pending}
      commit={(value) => commit(value === undefined ? cloneJsonValue(group.item.defaultValue) : value)}
      reportStatus={reportStatus}
    />
  );
}

function VisualBridgeInterfaceNode({ data }: NodeProps<GraphFlowNode>): React.JSX.Element {
  if (data.flavor !== "interface") {
    return <article className="graph-interface-node">Invalid interface</article>;
  }
  const effectivePorts = data.ports.map((port) => ({
    ...port,
    direction: data.side === "inputs" ? "output" as const : "input" as const,
  }));
  return (
    <article className={`graph-interface-node ${data.side}`}>
      <header>{data.title}</header>
      <PortColumn ports={effectivePorts} align={data.side === "inputs" ? "right" : "left"} />
    </article>
  );
}

function PortColumn({
  ports,
  align = "left",
}: {
  readonly ports: readonly PortDefinition[];
  readonly align?: "left" | "right";
}): React.JSX.Element {
  return (
    <div className={`graph-port-column ${align}`}>
      {ports.map((port) => (
        <div key={`${port.direction}:${port.id}`} className={`graph-port ${port.kind}`} title={port.dataTypeId}>
          <Handle
            id={port.id}
            type={port.direction === "input" ? "target" : "source"}
            position={port.direction === "input" ? Position.Left : Position.Right}
            className={`graph-handle ${port.kind}`}
            title={`${port.title} · ${port.kind}${port.dataTypeId === undefined ? "" : ` · ${port.dataTypeId}`}`}
          />
          <span>{port.title}</span>
        </div>
      ))}
    </div>
  );
}

function GraphEditorApp(): React.JSX.Element {
  const rootMetadata = useMemo(readMetadata, []);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<GraphDocument | undefined>(undefined);
  const catalogRef = useRef<GraphCatalog>(emptyCatalog());
  const activeGraphIdRef = useRef("");
  const documentVersionRef = useRef(0);
  const pendingRef = useRef(false);
  const selectedRef = useRef<Selection | undefined>(undefined);
  const clipboardPasteIndexRef = useRef(0);
  const [graphDocument, setGraphDocument] = useState<GraphDocument>();
  const [catalog, setCatalog] = useState<GraphCatalog>(emptyCatalog());
  const [replacementCandidates, setReplacementCandidates] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [activeGraphId, setActiveGraphIdValue] = useState("");
  const [flowNodes, setFlowNodes] = useState<GraphFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<GraphFlowEdge[]>([]);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<GraphFlowNode, GraphFlowEdge>>();
  const [selected, setSelected] = useState<Selection>();
  const [pending, setPending] = useState(false);
  const [invalidDiagnostics, setInvalidDiagnostics] = useState<readonly DocumentDiagnostic[]>([]);
  const [status, setStatus] = useState({ message: "正在加载 Graph Document…", error: false });
  const [contextMenu, setContextMenu] = useState<{ readonly x: number; readonly y: number; readonly nodeId: string }>();
  const [picker, setPicker] = useState<NodePickerState>();
  const [subgraphPickerOpen, setSubgraphPickerOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [showNodeTypes, setShowNodeTypes] = useState(true);
  const [showNodeIds, setShowNodeIds] = useState(false);

  const activeGraph = useMemo(
    () => graphDocument?.graphs.find((graph) => graph.id === activeGraphId),
    [activeGraphId, graphDocument],
  );

  const updateSelection = useCallback((next: Selection | undefined): void => {
    const current = selectedRef.current;
    if (selectionsEqual(current, next)) {
      return;
    }
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const setActiveGraphId = useCallback((next: string): void => {
    activeGraphIdRef.current = next;
    setActiveGraphIdValue(next);
    updateSelection(undefined);
    setContextMenu(undefined);
  }, [updateSelection]);

  const postOperations = useCallback((operations: readonly GraphOperation[]): void => {
    if (documentRef.current === undefined || pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setContextMenu(undefined);
    setPicker(undefined);
    setSubgraphPickerOpen(false);
    setStatus({ message: "正在应用修改…", error: false });
    vscode.postMessage({
      type: "applyOperations",
      documentVersion: documentVersionRef.current,
      operations,
    });
  }, []);

  const commitNode = useCallback((
    nodeId: string,
    title: string,
    properties: Readonly<Record<string, JsonValue>>,
  ): void => {
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === activeGraphIdRef.current);
    if (graph?.nodes.some((candidate) => candidate.id === nodeId)) {
      postOperations([{ type: "graph.updateNode", graphId: graph.id, nodeId, title, properties }]);
    }
  }, [postOperations]);

  const createClipboardPayload = useCallback((): GraphClipboardPayload | undefined => {
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === activeGraphIdRef.current);
    const selection = selectedRef.current;
    if (graph === undefined || selection === undefined) {
      return undefined;
    }
    const selectedIds = new Set(selection.nodeIds);
    const nodes = graph.nodes.flatMap((node) => {
      if (node.kind !== "node" || !selectedIds.has(node.id)) {
        return [];
      }
      const nodeType = resolveNodeTypeDefinition(catalogRef.current, node.nodeTypeId);
      return nodeType !== undefined && isNodeTypeRequiredByGraph(graph, nodeType, catalogRef.current)
        ? []
        : [cloneGraphAtomicNode(node)];
    });
    const copiedIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) =>
      edge.source.kind === "node"
      && copiedIds.has(edge.source.nodeId)
      && edge.target.kind === "node"
      && copiedIds.has(edge.target.nodeId),
    ).map(cloneGraphEdge);
    return nodes.length === 0
      ? undefined
      : { format: "visualbridge.graph-clipboard", version: 1, nodes, edges };
  }, []);

  const pasteClipboardPayload = useCallback((payload: GraphClipboardPayload, requestedOffset?: number): void => {
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === activeGraphIdRef.current);
    if (graph === undefined || pendingRef.current) {
      return;
    }
    const offset = requestedOffset ?? 40 * ++clipboardPasteIndexRef.current;
    const nodeIdMap = new Map(payload.nodes.map((node) => [node.id, newId("node")]));
    const nodes = payload.nodes.map((node) => ({
      ...cloneGraphAtomicNode(node),
      id: nodeIdMap.get(node.id)!,
      position: { x: node.position.x + offset, y: node.position.y + offset },
    }));
    const edges = payload.edges.flatMap((edge) => {
      if (edge.source.kind !== "node" || edge.target.kind !== "node") {
        return [];
      }
      const sourceNodeId = nodeIdMap.get(edge.source.nodeId);
      const targetNodeId = nodeIdMap.get(edge.target.nodeId);
      return sourceNodeId === undefined || targetNodeId === undefined
        ? []
        : [{
            ...cloneGraphEdge(edge),
            id: newId("edge"),
            source: { ...edge.source, nodeId: sourceNodeId },
            target: { ...edge.target, nodeId: targetNodeId },
          }];
    });
    updateSelection({ nodeIds: nodes.map((node) => node.id).sort(), edgeIds: edges.map((edge) => edge.id).sort() });
    postOperations([
      ...nodes.map((node) => ({ type: "graph.addNode" as const, graphId: graph.id, node })),
      ...edges.map((edge) => ({ type: "graph.addEdge" as const, graphId: graph.id, edge })),
    ]);
  }, [postOperations, updateSelection]);

  const copySelection = useCallback((): void => {
    const payload = createClipboardPayload();
    if (payload === undefined) {
      setStatus({ message: "请选择可复制的原子节点；Graph Type 必需节点和子图暂不进入剪贴板。", error: true });
      return;
    }
    const text = JSON.stringify(payload);
    if (text.length > 2_000_000) {
      setStatus({ message: "所选节点超过 Graph 剪贴板 2 MB 限制，请减少选择后重试。", error: true });
      return;
    }
    clipboardPasteIndexRef.current = 0;
    vscode.postMessage({ type: "writeClipboard", text });
    setStatus({ message: `已复制 ${payload.nodes.length} 个节点和 ${payload.edges.length} 条内部连线。`, error: false });
  }, [createClipboardPayload]);

  const duplicateSelection = useCallback((): void => {
    const payload = createClipboardPayload();
    if (payload === undefined) {
      setStatus({ message: "请选择可 Duplicate 的原子节点；Graph Type 必需节点和子图暂不复制。", error: true });
      return;
    }
    pasteClipboardPayload(payload, 40);
  }, [createClipboardPayload, pasteClipboardPayload]);

  useEffect(() => {
    const receiveMessage = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "graphState") {
        documentRef.current = message.document;
        catalogRef.current = message.catalog;
        documentVersionRef.current = message.documentVersion;
        pendingRef.current = false;
        const currentGraphId = message.document.graphs.some((graph) => graph.id === activeGraphIdRef.current)
          ? activeGraphIdRef.current
          : message.document.rootGraphId;
        activeGraphIdRef.current = currentGraphId;
        setGraphDocument(message.document);
        setCatalog(message.catalog);
        setReplacementCandidates({});
        setActiveGraphIdValue(currentGraphId);
        setPending(false);
        setInvalidDiagnostics([]);
        setContextMenu(undefined);

        const currentGraph = message.document.graphs.find((graph) => graph.id === currentGraphId);
        const nextSelection = currentGraph === undefined
          ? undefined
          : keepValidSelection(selectedRef.current, currentGraph);
        updateSelection(nextSelection);
        const firstError = message.diagnostics.find((diagnostic) => diagnostic.severity === "error");
        const firstWarning = message.diagnostics.find((diagnostic) => diagnostic.severity === "warning");
        const firstDiagnostic = firstError ?? firstWarning;
        setStatus(firstDiagnostic === undefined
          ? { message: "就绪", error: false }
          : { message: `${firstDiagnostic.path}: ${firstDiagnostic.message}`, error: firstError !== undefined });
        return;
      }
      if (message.type === "replacementCandidates") {
        if (
          message.documentVersion === documentVersionRef.current
          && message.graphId === activeGraphIdRef.current
        ) {
          setReplacementCandidates((current) => ({ ...current, [message.nodeId]: message.nodeTypeIds }));
        }
        return;
      }
      if (message.type === "clipboardData") {
        const payload = parseGraphClipboardPayload(message.text);
        if (payload === undefined) {
          setStatus({ message: "剪贴板中没有有效的 VisualBridge Graph 节点数据。", error: true });
        } else {
          pasteClipboardPayload(payload);
        }
        return;
      }
      if (message.type === "graphInvalid") {
        documentRef.current = undefined;
        documentVersionRef.current = message.documentVersion;
        pendingRef.current = false;
        updateSelection(undefined);
        setGraphDocument(undefined);
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
  }, [pasteClipboardPayload, updateSelection]);

  useEffect(() => {
    if (graphDocument === undefined || activeGraph === undefined) {
      setFlowNodes([]);
      setFlowEdges([]);
      return;
    }
    setFlowNodes(toFlowNodes(graphDocument, activeGraph, catalog, selected, commitNode, postOperations, setStatus));
    setFlowEdges(activeGraph.edges.map((edge) => toFlowEdge(edge, selected, activeGraph, catalog)));
  }, [activeGraph, catalog, commitNode, graphDocument, postOperations, selected]);

  const handleNodesChange = useCallback((changes: NodeChange<GraphFlowNode>[]): void => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<GraphFlowEdge>[]): void => {
    setFlowEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const handleSelectionChange = useCallback((selection: { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] }): void => {
    const nodeIds = selection.nodes.filter((candidate) => candidate.data.flavor === "node").map((node) => node.id).sort();
    const edgeIds = selection.edges.map((edge) => edge.id).sort();
    updateSelection(nodeIds.length === 0 && edgeIds.length === 0 ? undefined : { nodeIds, edgeIds });
  }, [updateSelection]);

  const handleConnect = useCallback((connection: Connection): void => {
    const currentDocument = documentRef.current;
    const currentGraph = currentDocument?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    if (
      currentDocument === undefined
      || currentGraph === undefined
      || connection.source === null
      || connection.target === null
      || connection.sourceHandle === null
      || connection.targetHandle === null
    ) {
      return;
    }
    const sourcePort = findCanvasPort(currentDocument, currentGraph, catalogRef.current, connection.source, connection.sourceHandle, "source");
    const targetPort = findCanvasPort(currentDocument, currentGraph, catalogRef.current, connection.target, connection.targetHandle, "target");
    if (sourcePort === undefined || targetPort === undefined || sourcePort.kind !== targetPort.kind) {
      setStatus({ message: "流程端口和数据端口不能互相连接。", error: true });
      return;
    }
    postOperations([{
      type: "graph.addEdge",
      graphId: currentGraph.id,
      edge: {
        id: newId("edge"),
        kind: sourcePort.kind,
        source: toGraphEndpoint(connection.source, connection.sourceHandle),
        target: toGraphEndpoint(connection.target, connection.targetHandle),
      },
    }]);
  }, [postOperations]);

  const handleConnectEnd = useCallback((
    event: MouseEvent | TouchEvent,
    connectionState: FinalConnectionState,
  ): void => {
    if (
      connectionState.isValid === true
      || connectionState.toNode !== null
      || connectionState.fromNode === null
      || connectionState.fromHandle === null
      || connectionState.fromHandle.id === undefined
      || connectionState.fromHandle.id === null
      || flowInstance === undefined
      || pendingRef.current
    ) {
      return;
    }
    const currentDocument = documentRef.current;
    const currentGraph = currentDocument?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    if (currentDocument === undefined || currentGraph === undefined) {
      return;
    }
    const fromNodeId = connectionState.fromNode.id;
    const fromPortId = connectionState.fromHandle.id;
    const fromRole = connectionState.fromHandle.type;
    const fromPort = findCanvasPort(
      currentDocument,
      currentGraph,
      catalogRef.current,
      fromNodeId,
      fromPortId,
      fromRole,
    );
    if (fromPort === undefined) {
      return;
    }
    if (
      fromPort.maxConnections !== undefined
      && countCanvasPortConnections(currentGraph, catalogRef.current, fromNodeId, fromPortId, fromRole) >= fromPort.maxConnections
    ) {
      setStatus({ message: `端口“${fromPort.title}”已达到最大连接数。`, error: true });
      return;
    }
    const clientPosition = eventClientPosition(event);
    if (clientPosition === undefined) {
      return;
    }
    const position = flowInstance.screenToFlowPosition(clientPosition);
    setPicker({
      mode: "connect",
      fromNodeId,
      fromPortId,
      fromRole,
      fromPort,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
    });
    setStatus({ message: "请选择要在连线末端创建的兼容节点。", error: false });
  }, [flowInstance]);

  const handleNodeDragStop = useCallback((
    _: MouseEvent | TouchEvent,
    node: GraphFlowNode,
    draggedNodes: GraphFlowNode[],
  ): void => {
    if (node.data.flavor !== "node") {
      return;
    }
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    if (currentGraph === undefined) {
      return;
    }
    const movedNodes = draggedNodes.length === 0 ? [node] : draggedNodes;
    const operations = movedNodes.flatMap((draggedNode) => {
      if (draggedNode.data.flavor !== "node") {
        return [];
      }
      const sourceNode = currentGraph.nodes.find((candidate) => candidate.id === draggedNode.id);
      const position = { x: Math.round(draggedNode.position.x), y: Math.round(draggedNode.position.y) };
      return sourceNode === undefined
        || position.x === sourceNode.position.x && position.y === sourceNode.position.y
        ? []
        : [{ type: "graph.moveNode" as const, graphId: currentGraph.id, nodeId: draggedNode.id, position }];
    });
    if (operations.length > 0) {
      postOperations(operations);
    }
  }, [postOperations]);

  const nodePosition = useCallback((): GraphPosition => {
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    const bounds = canvasRef.current?.getBoundingClientRect();
    const fallback = { x: 80 + (currentGraph?.nodes.length ?? 0) * 24, y: 80 + (currentGraph?.nodes.length ?? 0) * 18 };
    if (flowInstance === undefined || bounds === undefined) {
      return fallback;
    }
    const position = flowInstance.screenToFlowPosition({
      x: bounds.left + bounds.width * 0.42,
      y: bounds.top + bounds.height * 0.42,
    });
    return { x: Math.round(position.x), y: Math.round(position.y) };
  }, [flowInstance]);

  const addNodeType = useCallback((nodeTypeId: string): void => {
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    const nodeType = catalogRef.current.nodeTypes.find(
      (candidate) => candidate.id === nodeTypeId && candidate.subgraph === undefined,
    );
    if (currentGraph === undefined || nodeType === undefined) {
      return;
    }
    postOperations([{
      type: "graph.addNode",
      graphId: currentGraph.id,
      node: {
        kind: "node",
        id: newId("node"),
        nodeTypeId: nodeType.id,
        title: nodeType.title,
        position: nodePosition(),
        properties: createDefaultProperties(nodeType),
        dynamicPorts: [],
      },
    }]);
  }, [nodePosition, postOperations]);

  const addConnectedNode = useCallback((
    connectionPicker: Extract<NodePickerState, { readonly mode: "connect" }>,
    option: ConnectionNodeOption,
  ): void => {
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    if (currentGraph === undefined) {
      return;
    }
    const nodeId = newId("node");
    const edgeId = newId("edge");
    const existingEndpoint = toGraphEndpoint(connectionPicker.fromNodeId, connectionPicker.fromPortId);
    const newEndpoint: GraphNodeEndpoint = { kind: "node", nodeId, portId: option.port.id };
    const edge: GraphEdgeModel = {
      id: edgeId,
      kind: connectionPicker.fromPort.kind,
      source: connectionPicker.fromRole === "source" ? existingEndpoint : newEndpoint,
      target: connectionPicker.fromRole === "source" ? newEndpoint : existingEndpoint,
    };
    updateSelection({ nodeIds: [nodeId], edgeIds: [edgeId] });
    postOperations([
      {
        type: "graph.addNode",
        graphId: currentGraph.id,
        node: {
          kind: "node",
          id: nodeId,
          nodeTypeId: option.nodeType.id,
          title: option.nodeType.title,
          position: connectionPicker.position,
          properties: createDefaultProperties(option.nodeType),
          dynamicPorts: [],
        },
      },
      { type: "graph.addEdge", graphId: currentGraph.id, edge },
    ]);
  }, [postOperations, updateSelection]);

  const addSubgraph = useCallback((graphTypeId?: string, nodeTypeId?: string): void => {
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    if (currentGraph === undefined) {
      return;
    }
    const subgraphId = newId("subgraph");
    const index = documentRef.current?.graphs.length ?? 1;
    const catalog = catalogRef.current;
    const graphType = graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalog, graphTypeId);
    const nodeType = nodeTypeId === undefined
      ? undefined
      : catalog.nodeTypes.find((candidate) => candidate.id === nodeTypeId && candidate.subgraph !== undefined);
    const initialNodes: GraphAtomicNode[] = graphType?.initialNodes.flatMap((initialNode, initialIndex) => {
      const initialType = resolveNodeTypeDefinition(catalog, initialNode.nodeTypeId);
      return initialType === undefined || initialType.subgraph !== undefined
        ? []
        : [{
            kind: "node",
            id: newId("node"),
            nodeTypeId: initialType.id,
            title: initialNode.title ?? initialType.title,
            position: { x: 80 + (initialIndex % 3) * 260, y: 80 + Math.floor(initialIndex / 3) * 180 },
            properties: createDefaultProperties(initialType),
            dynamicPorts: [],
          }];
    }) ?? [];
    postOperations([{
      type: "graph.addSubgraph",
      graphId: currentGraph.id,
      node: {
        kind: "subgraph",
        id: newId("node"),
        ...(nodeType === undefined ? {} : { nodeTypeId: nodeType.id }),
        subgraphId,
        title: nodeType?.title ?? `Subgraph ${index}`,
        position: nodePosition(),
        properties: nodeType === undefined ? {} : createDefaultProperties(nodeType),
        dynamicPorts: [],
      },
      subgraph: {
        id: subgraphId,
        ...(graphType === undefined ? {} : { graphTypeId: graphType.id }),
        title: graphType?.title ?? `Subgraph ${index}`,
        properties: graphType === undefined ? {} : createDefaultGraphProperties(graphType),
        interfacePorts: [
          { id: "flowIn", title: "In", kind: "flow", direction: "input", maxConnections: 1 },
          { id: "flowOut", title: "Out", kind: "flow", direction: "output", maxConnections: 1 },
        ],
        nodes: initialNodes,
        edges: [],
      },
    }]);
  }, [nodePosition, postOperations]);

  const deleteSelection = useCallback((): void => {
    const current = selectedRef.current;
    const graphId = activeGraphIdRef.current;
    if (current === undefined || pendingRef.current || graphId.length === 0) {
      return;
    }
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === graphId);
    if (graph === undefined) {
      return;
    }
    const selectedNodes = new Set(current.nodeIds);
    const operations: GraphOperation[] = [
      ...current.edgeIds.flatMap((edgeId) => {
        const edge = graph.edges.find((candidate) => candidate.id === edgeId);
        const removedWithNode = edge !== undefined && (
          edge.source.kind === "node" && selectedNodes.has(edge.source.nodeId)
          || edge.target.kind === "node" && selectedNodes.has(edge.target.nodeId)
        );
        return removedWithNode ? [] : [{ type: "graph.removeEdge" as const, graphId, edgeId }];
      }),
      ...current.nodeIds.map((nodeId) => ({ type: "graph.removeNode" as const, graphId, nodeId })),
    ];
    if (operations.length > 0) {
      updateSelection(undefined);
      postOperations(operations);
    }
  }, [postOperations, updateSelection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      const editing = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      const command = event.ctrlKey || event.metaKey;
      if (!editing && command && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection();
      }
      if (!editing && command && event.key.toLowerCase() === "v") {
        event.preventDefault();
        vscode.postMessage({ type: "readClipboard" });
      }
      if (!editing && command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelection();
      }
      if (!editing && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelection();
      }
      if (event.key === "Escape") {
        setContextMenu(undefined);
        setPicker(undefined);
        setSubgraphPickerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [copySelection, deleteSelection, duplicateSelection]);

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: GraphFlowNode): void => {
    if (node.data.flavor !== "node") {
      return;
    }
    event.preventDefault();
    updateSelection({ nodeIds: [node.id], edgeIds: [] });
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
    if (node.data.model.nodeTypeId !== undefined) {
      setReplacementCandidates((current) => {
        const next = { ...current };
        delete next[node.id];
        return next;
      });
      vscode.postMessage({
        type: "requestReplacementCandidates",
        documentVersion: documentVersionRef.current,
        graphId: activeGraphIdRef.current,
        nodeId: node.id,
      });
    }
  }, [updateSelection]);

  const openSubgraph = useCallback((nodeId: string): void => {
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === activeGraphIdRef.current);
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.kind === "subgraph") {
      setActiveGraphId(node.subgraphId);
    }
  }, [setActiveGraphId]);

  const selectSameType = useCallback((nodeId: string): void => {
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === activeGraphIdRef.current);
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (graph === undefined || node?.nodeTypeId === undefined) {
      return;
    }
    const canonicalTypeId = resolveNodeTypeDefinition(catalogRef.current, node.nodeTypeId)?.id ?? node.nodeTypeId;
    const nodeIds = graph.nodes.flatMap((candidate) => {
      if (candidate.nodeTypeId === undefined) {
        return [];
      }
      const candidateTypeId = resolveNodeTypeDefinition(catalogRef.current, candidate.nodeTypeId)?.id ?? candidate.nodeTypeId;
      return candidateTypeId === canonicalTypeId ? [candidate.id] : [];
    });
    setContextMenu(undefined);
    updateSelection({ nodeIds, edgeIds: [] });
  }, [updateSelection]);

  const path = graphDocument === undefined ? [] : findGraphPath(graphDocument, activeGraphId);
  const pickerTypes = picker?.mode === "replace"
    ? catalog.nodeTypes.filter((nodeType) => replacementCandidates[picker.nodeId]?.includes(nodeType.id) ?? false)
    : picker?.mode === "add"
      ? catalog.nodeTypes.filter((nodeType) => activeGraph !== undefined && isNodeTypeAvailable(activeGraph, nodeType, catalog, "atomic"))
      : [];
  const connectionOptions = picker?.mode === "connect" && activeGraph !== undefined
    ? getConnectionNodeOptions(activeGraph, catalog, picker.fromPort, picker.fromRole)
    : [];
  const subgraphOptions = activeGraph === undefined ? [] : getSubgraphOptions(activeGraph, catalog);

  return (
    <div className="graph-app" onClick={() => setContextMenu(undefined)}>
      <header className="graph-toolbar">
        <button type="button" onClick={(event) => { event.stopPropagation(); setPicker({ mode: "add" }); }} disabled={activeGraph === undefined || pending || catalog.nodeTypes.length === 0}>
          添加节点
        </button>
        <button
          type="button"
          onClick={() => catalog.graphTypes.length === 0 ? addSubgraph() : setSubgraphPickerOpen(true)}
          disabled={activeGraph === undefined || pending || (catalog.graphTypes.length > 0 && subgraphOptions.length === 0)}
          title={catalog.graphTypes.length > 0 && subgraphOptions.length === 0 ? "当前 Graph Type 没有可用的子图类型" : undefined}
        >
          添加子图
        </button>
        <button type="button" className="secondary" onClick={copySelection} disabled={selected === undefined || pending}>复制</button>
        <button type="button" className="secondary" onClick={() => vscode.postMessage({ type: "readClipboard" })} disabled={pending}>粘贴</button>
        <button type="button" className="secondary" onClick={duplicateSelection} disabled={selected === undefined || pending}>Duplicate</button>
        <button type="button" className="secondary" onClick={deleteSelection} disabled={selected === undefined || pending}>
          删除所选
        </button>
        <nav className="graph-breadcrumb" aria-label="Graph breadcrumb">
          {path.map((item, index) => (
            <span key={item.id}>
              {index > 0 && <i>/</i>}
              <button type="button" className="link" onClick={() => setActiveGraphId(item.id)}>{item.title}</button>
            </span>
          ))}
        </nav>
        <label className="graph-toolbar-option">
          <input
            type="checkbox"
            checked={showNodeTypes}
            onChange={(event) => setShowNodeTypes(event.target.checked)}
          />
          <span>显示节点类型</span>
        </label>
        <label className="graph-toolbar-option">
          <input
            type="checkbox"
            checked={showNodeIds}
            onChange={(event) => setShowNodeIds(event.target.checked)}
          />
          <span>显示节点 ID</span>
        </label>
        <span className="graph-toolbar-spacer" />
        <span className="graph-metadata" title={rootMetadata.relativePath}>
          {rootMetadata.projectId} · {rootMetadata.documentType} · {rootMetadata.relativePath}
        </span>
      </header>

      {graphDocument === undefined
        ? invalidDiagnostics.length > 0
          ? <InvalidDocument diagnostics={invalidDiagnostics} />
          : <LoadingDocument />
        : activeGraph === undefined
          ? <InvalidDocument diagnostics={[{ severity: "error", code: "graph.missingActiveGraph", path: "graphs", message: "当前子图不存在。" }]} />
          : (
            <main className={`graph-content${inspectorCollapsed ? " inspector-collapsed" : ""}`}>
              <div ref={canvasRef} className="graph-canvas">
                <GraphPendingContext.Provider value={pending}>
                  <GraphNodeTypeVisibilityContext.Provider value={showNodeTypes}>
                    <GraphNodeIdVisibilityContext.Provider value={showNodeIds}>
                      <ReactFlow<GraphFlowNode, GraphFlowEdge>
                        nodes={flowNodes}
                        edges={flowEdges}
                        nodeTypes={nodeTypes}
                        onNodesChange={handleNodesChange}
                        onEdgesChange={handleEdgesChange}
                        onSelectionChange={handleSelectionChange}
                        onConnect={handleConnect}
                        onConnectEnd={handleConnectEnd}
                        onNodeDragStop={handleNodeDragStop}
                        onNodeContextMenu={handleNodeContextMenu}
                        onNodeDoubleClick={(_, node) => openSubgraph(node.id)}
                        onPaneClick={() => setContextMenu(undefined)}
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
                      >
                        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
                        <MiniMap pannable zoomable nodeStrokeWidth={3} />
                        <Controls showInteractive={false} />
                      </ReactFlow>
                    </GraphNodeIdVisibilityContext.Provider>
                  </GraphNodeTypeVisibilityContext.Provider>
                </GraphPendingContext.Provider>
              </div>
              <aside className={`graph-inspector-shell${inspectorCollapsed ? " collapsed" : ""}`}>
                <button
                  type="button"
                  className="graph-inspector-toggle secondary"
                  aria-label={inspectorCollapsed ? "展开 Graph Inspector" : "折叠 Graph Inspector"}
                  title={inspectorCollapsed ? "展开 Graph Inspector" : "折叠 Graph Inspector"}
                  onClick={() => setInspectorCollapsed((value) => !value)}
                >
                  {inspectorCollapsed ? "‹" : "›"}
                </button>
                {!inspectorCollapsed && (
                  <GraphInspector
                    key={activeGraph.id}
                    graph={activeGraph}
                    isRoot={activeGraph.id === graphDocument.rootGraphId}
                    catalog={catalog}
                    pending={pending}
                    postOperations={postOperations}
                    reportStatus={setStatus}
                  />
                )}
              </aside>
            </main>
          )}

      {contextMenu !== undefined && activeGraph !== undefined && (() => {
        const node = activeGraph.nodes.find((candidate) => candidate.id === contextMenu.nodeId);
        const candidates = replacementCandidates[contextMenu.nodeId];
        return (
          <div className="graph-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            {node?.nodeTypeId !== undefined && (
              <>
                <button type="button" onClick={() => selectSameType(node.id)}>选择同类型节点</button>
                <button
                  type="button"
                  disabled={candidates === undefined || candidates.length === 0}
                  onClick={() => { setContextMenu(undefined); setPicker({ mode: "replace", nodeId: node.id }); }}
                >
                  替换节点类型{candidates === undefined ? "（检查中…）" : candidates.length === 0 ? "（无兼容类型）" : "…"}
                </button>
              </>
            )}
            {node?.kind === "subgraph" && <button type="button" onClick={() => openSubgraph(node.id)}>打开子图</button>}
          </div>
        );
      })()}

      {picker !== undefined && picker.mode !== "connect" && (
        <NodeTypePicker
          title={picker.mode === "replace" ? "替换节点类型" : "添加节点"}
          catalogTitle={catalog.title}
          nodeTypes={pickerTypes}
          onCancel={() => setPicker(undefined)}
          onSelect={(nodeTypeId) => {
            if (picker.mode === "replace") {
              postOperations([{
                type: "graph.replaceNodeType",
                graphId: activeGraphIdRef.current,
                nodeId: picker.nodeId,
                nodeTypeId,
              }]);
            } else {
              addNodeType(nodeTypeId);
            }
          }}
        />
      )}

      {picker?.mode === "connect" && (
        <ConnectionNodePicker
          catalogTitle={catalog.title}
          options={connectionOptions}
          onCancel={() => setPicker(undefined)}
          onSelect={(option) => addConnectedNode(picker, option)}
        />
      )}

      {subgraphPickerOpen && (
        <SubgraphTypePicker
          catalogTitle={catalog.title}
          options={subgraphOptions}
          onCancel={() => setSubgraphPickerOpen(false)}
          onSelect={(graphTypeId, nodeTypeId) => addSubgraph(graphTypeId, nodeTypeId)}
        />
      )}

      <footer className={`graph-status${status.error ? " error" : ""}`}><span>{status.message}</span></footer>
    </div>
  );
}

function GraphInspector({
  graph,
  isRoot,
  catalog,
  pending,
  postOperations,
  reportStatus,
}: {
  readonly graph: GraphDefinition;
  readonly isRoot: boolean;
  readonly catalog: GraphCatalog;
  readonly pending: boolean;
  readonly postOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(graph.title);
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalog, graph.graphTypeId);
  const assignableTypes = catalog.graphTypes.filter((candidate) => candidate.usage === "any" || candidate.usage === (isRoot ? "root" : "subgraph"));
  const [selectedGraphTypeId, setSelectedGraphTypeId] = useState(assignableTypes[0]?.id ?? "");
  useEffect(() => setTitle(graph.title), [graph.title]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    postOperations([{ type: "graph.updateGraph", graphId: graph.id, title, properties: graph.properties }]);
  };
  const propertyNodeType: NodeTypeDefinition = {
    id: graphType?.id ?? "untyped.graph",
    aliases: [],
    title: graphType?.title ?? "Untyped Graph",
    category: "Graph",
    ports: [],
    properties: graphType?.properties ?? [],
  };
  const propertyData: GraphNodeData = {
    flavor: "node",
    graphId: graph.id,
    model: {
      kind: "node",
      id: graph.id,
      nodeTypeId: propertyNodeType.id,
      title: graph.title,
      position: { x: 0, y: 0 },
      properties: graph.properties,
      dynamicPorts: [],
    },
    nodeType: propertyNodeType,
    ports: [],
    typeTitle: propertyNodeType.title,
    overriddenPropertyIds: new Set(),
    commitNode: (_, nextTitle, properties) => postOperations([{
      type: "graph.updateGraph",
      graphId: graph.id,
      title: nextTitle === graph.title ? title : nextTitle,
      properties,
    }]),
    commitOperations: postOperations,
    reportStatus,
  };
  const assignType = (): void => {
    const nextType = resolveGraphTypeDefinition(catalog, selectedGraphTypeId);
    if (nextType === undefined) {
      return;
    }
    const initialOperations: GraphOperation[] = nextType.initialNodes.flatMap((initialNode, index) => {
      const nodeType = resolveNodeTypeDefinition(catalog, initialNode.nodeTypeId);
      return nodeType === undefined || nodeType.subgraph !== undefined
        ? []
        : [{
            type: "graph.addNode" as const,
            graphId: graph.id,
            node: {
              kind: "node",
              id: newId("node"),
              nodeTypeId: nodeType.id,
              title: initialNode.title ?? nodeType.title,
              position: { x: 80 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 180 },
              properties: createDefaultProperties(nodeType),
              dynamicPorts: [],
            },
          }];
    });
    postOperations([{ type: "graph.assignType", graphId: graph.id, graphTypeId: nextType.id }, ...initialOperations]);
  };
  return (
    <aside className="graph-inspector">
      <h2>Graph Inspector</h2>
      <ReadonlyField label="Graph ID" value={graph.id} />
      {graphType !== undefined
        ? <ReadonlyField label="Graph Type" value={`${graphType.title} · ${graphType.id}`} />
        : graph.graphTypeId !== undefined
          ? <ReadonlyField label="Graph Type" value={`Unknown · ${graph.graphTypeId}`} />
          : (
            <section className="graph-assign-type">
              <label className="graph-field">
                <span>Graph Type</span>
                <select value={selectedGraphTypeId} onChange={(event) => setSelectedGraphTypeId(event.target.value)}>
                  {assignableTypes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
                </select>
              </label>
              <button type="button" disabled={pending || graph.nodes.length > 0 || selectedGraphTypeId.length === 0} onClick={assignType}>设置 Graph Type</button>
              {graph.nodes.length > 0 && <p className="graph-empty">已有节点的旧 Graph 需要后续安全迁移，不能直接设置类型。</p>}
            </section>
          )}
      <form onSubmit={submit}>
        <InputField label="名称" value={title} onChange={setTitle} />
        <button type="submit" disabled={pending || title === graph.title}>应用名称修改</button>
      </form>
      <h3>Graph 属性</h3>
      <InlineNodeProperties data={propertyData} pending={pending} />
    </aside>
  );
}

function NodeTypePicker({
  title,
  catalogTitle,
  nodeTypes: availableNodeTypes,
  onCancel,
  onSelect,
}: {
  readonly title: string;
  readonly catalogTitle: string;
  readonly nodeTypes: readonly NodeTypeDefinition[];
  readonly onCancel: () => void;
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const filtered = availableNodeTypes.filter((nodeType) =>
    [catalogTitle, nodeType.title, nodeType.id, nodeType.category, ...(nodeType.menuPath ?? []), ...(nodeType.tags ?? []), ...(nodeType.traits ?? [])]
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
            ? <NodeTypeMenu catalogTitle={catalogTitle} nodeTypes={filtered} onSelect={onSelect} />
            : filtered.map((nodeType) => <NodeTypeOption key={nodeType.id} catalogTitle={catalogTitle} nodeType={nodeType} onSelect={onSelect} />)}
          {filtered.length === 0 && <p className="graph-empty">没有可用的节点类型。</p>}
        </div>
      </section>
    </div>
  );
}

function ConnectionNodePicker({
  catalogTitle,
  options,
  onCancel,
  onSelect,
}: {
  readonly catalogTitle: string;
  readonly options: readonly ConnectionNodeOption[];
  readonly onCancel: () => void;
  readonly onSelect: (option: ConnectionNodeOption) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = options.filter(({ nodeType, port }) =>
    [catalogTitle, nodeType.title, nodeType.id, nodeType.category, ...(nodeType.menuPath ?? []), port.title, port.id]
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
              key={`${option.nodeType.id}:${option.port.id}`}
              type="button"
              className="graph-node-type-option"
              onClick={() => onSelect(option)}
            >
              <strong>{option.nodeType.title}</strong>
              <span>{getNodeTypeDisplayPath(catalogTitle, option.nodeType)} · {option.port.title}</span>
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
  catalogTitle,
  nodeTypes: menuNodeTypes,
  onSelect,
}: {
  readonly catalogTitle: string;
  readonly nodeTypes: readonly NodeTypeDefinition[];
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  const roots = buildNodeTypeMenu(catalogTitle, menuNodeTypes);
  return <>{roots.map((branch) => <NodeTypeMenuBranchView key={branch.title} catalogTitle={catalogTitle} branch={branch} onSelect={onSelect} />)}</>;
}

interface NodeTypeMenuBranch {
  readonly title: string;
  readonly branches: readonly NodeTypeMenuBranch[];
  readonly nodeTypes: readonly NodeTypeDefinition[];
}

function NodeTypeMenuBranchView({
  catalogTitle,
  branch,
  onSelect,
}: {
  readonly catalogTitle: string;
  readonly branch: NodeTypeMenuBranch;
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  return (
    <details className="graph-node-type-branch" open>
      <summary>{branch.title}</summary>
      <div>
        {branch.branches.map((child) => <NodeTypeMenuBranchView key={child.title} catalogTitle={catalogTitle} branch={child} onSelect={onSelect} />)}
        {branch.nodeTypes.map((nodeType) => <NodeTypeOption key={nodeType.id} catalogTitle={catalogTitle} nodeType={nodeType} onSelect={onSelect} />)}
      </div>
    </details>
  );
}

function NodeTypeOption({
  catalogTitle,
  nodeType,
  onSelect,
}: {
  readonly catalogTitle: string;
  readonly nodeType: NodeTypeDefinition;
  readonly onSelect: (nodeTypeId: string) => void;
}): React.JSX.Element {
  return (
    <button type="button" className="graph-node-type-option" onClick={() => onSelect(nodeType.id)}>
      <strong>{nodeType.title}</strong>
      <span>{getNodeTypeDisplayPath(catalogTitle, nodeType)}</span>
      <code>{nodeType.id}</code>
    </button>
  );
}

function buildNodeTypeMenu(catalogTitle: string, nodeTypes: readonly NodeTypeDefinition[]): readonly NodeTypeMenuBranch[] {
  interface MutableBranch {
    title: string;
    branches: Map<string, MutableBranch>;
    nodeTypes: NodeTypeDefinition[];
  }
  const root: MutableBranch = { title: "root", branches: new Map(), nodeTypes: [] };
  nodeTypes.forEach((nodeType) => {
    const path = [catalogTitle, ...getNodeTypeRelativePath(nodeType)];
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

function getNodeTypeDisplayPath(catalogTitle: string, nodeType: NodeTypeDefinition): string {
  return [catalogTitle, ...getNodeTypeRelativePath(nodeType), nodeType.title].join(" / ");
}

function SubgraphTypePicker({
  catalogTitle,
  options,
  onCancel,
  onSelect,
}: {
  readonly catalogTitle: string;
  readonly options: readonly SubgraphTypeOption[];
  readonly onCancel: () => void;
  readonly onSelect: (graphTypeId: string, nodeTypeId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = options.filter(({ graphType, nodeType }) =>
    [catalogTitle, graphType.title, graphType.id, nodeType.title, nodeType.id, ...(nodeType.menuPath ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
  return (
    <div className="graph-modal-backdrop" onMouseDown={onCancel}>
      <section className="graph-node-picker" role="dialog" aria-modal="true" aria-label="添加类型化子图" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>添加类型化子图</h2><button type="button" className="secondary" onClick={onCancel}>关闭</button></header>
        <input autoFocus placeholder="搜索 Graph Type 或调用节点类型…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="graph-node-type-list">
          {filtered.map(({ graphType, nodeType }) => (
            <button
              key={`${graphType.id}:${nodeType.id}`}
              type="button"
              className="graph-node-type-option"
              onClick={() => onSelect(graphType.id, nodeType.id)}
            >
              <strong>{nodeType.title}</strong>
              <span>{getNodeTypeDisplayPath(catalogTitle, nodeType)} · 创建 {graphType.title}</span>
              <code>{nodeType.id} → {graphType.id}</code>
            </button>
          ))}
          {filtered.length === 0 && <p className="graph-empty">没有兼容的类型化子图。</p>}
        </div>
      </section>
    </div>
  );
}

function ReadonlyField({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return <label className="graph-field"><span>{label}</span><input value={value} readOnly /></label>;
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
  return <label className="graph-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function InvalidDocument({ diagnostics }: { readonly diagnostics: readonly DocumentDiagnostic[] }): React.JSX.Element {
  return (
    <main className="graph-invalid"><section><h2>Graph Document 无效</h2><p>请切换到文本编辑器修复以下问题，然后重新打开。</p><ul>
      {diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${diagnostic.path}:${index}`}>{diagnostic.path}: {diagnostic.message}</li>)}
    </ul></section></main>
  );
}

function LoadingDocument(): React.JSX.Element {
  return <main className="graph-invalid"><section><h2>正在加载 Graph Document…</h2></section></main>;
}

function toFlowNodes(
  document: GraphDocument,
  graph: GraphDefinition,
  catalog: GraphCatalog,
  selected: Selection | undefined,
  commitNode: GraphNodeData["commitNode"],
  commitOperations: GraphNodeData["commitOperations"],
  reportStatus: GraphNodeData["reportStatus"],
): GraphFlowNode[] {
  const nodes: GraphFlowNode[] = graph.nodes.map((node) => {
    const nodeType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalog, node.nodeTypeId);
    return {
      id: node.id,
      type: "visualBridgeNode",
      position: { ...node.position },
      data: {
        flavor: "node",
        graphId: graph.id,
        model: node,
        ...(nodeType === undefined ? {} : { nodeType }),
        ports: portsForNode(document, graph, node, nodeType),
        typeTitle: nodeType?.title ?? (node.kind === "subgraph" ? "Embedded Subgraph" : `Unknown · ${node.nodeTypeId}`),
        overriddenPropertyIds: overriddenNodeProperties(graph, node, nodeType),
        commitNode,
        commitOperations,
        reportStatus,
      },
      selected: selected?.nodeIds.includes(node.id) ?? false,
    };
  });
  const inputs = graph.interfacePorts.filter((port) => port.direction === "input");
  const outputs = graph.interfacePorts.filter((port) => port.direction === "output");
  const maxX = Math.max(400, ...graph.nodes.map((node) => node.position.x));
  if (inputs.length > 0) {
    nodes.push({
      id: INTERFACE_INPUT_NODE_ID,
      type: "visualBridgeInterface",
      position: { x: -300, y: 40 },
      draggable: false,
      selectable: false,
      data: { flavor: "interface", title: "Graph Inputs", side: "inputs", ports: inputs },
    });
  }
  if (outputs.length > 0) {
    nodes.push({
      id: INTERFACE_OUTPUT_NODE_ID,
      type: "visualBridgeInterface",
      position: { x: maxX + 360, y: 40 },
      draggable: false,
      selectable: false,
      data: { flavor: "interface", title: "Graph Outputs", side: "outputs", ports: outputs },
    });
  }
  return nodes;
}

function toFlowEdge(
  edge: GraphEdgeModel,
  selected: Selection | undefined,
  graph: GraphDefinition,
  catalog: GraphCatalog,
): GraphFlowEdge {
  return {
    id: edge.id,
    type: "default",
    source: edge.source.kind === "node" ? edge.source.nodeId : INTERFACE_INPUT_NODE_ID,
    sourceHandle: canonicalCanvasPortId(edge.source, graph, catalog),
    target: edge.target.kind === "node" ? edge.target.nodeId : INTERFACE_OUTPUT_NODE_ID,
    targetHandle: canonicalCanvasPortId(edge.target, graph, catalog),
    data: { model: edge },
    className: `graph-edge-${edge.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed },
    selected: selected?.edgeIds.includes(edge.id) ?? false,
  };
}

function canonicalCanvasPortId(
  endpoint: GraphEndpoint,
  graph: GraphDefinition,
  catalog: GraphCatalog,
): string {
  if (endpoint.kind === "interface") {
    return endpoint.portId;
  }
  const node = graph.nodes.find((candidate) => candidate.id === endpoint.nodeId);
  if (node?.nodeTypeId === undefined) {
    return endpoint.portId;
  }
  const nodeType = resolveNodeTypeDefinition(catalog, node.nodeTypeId);
  return nodeType?.ports.find(
    (port) => port.id === endpoint.portId || (port.aliases?.includes(endpoint.portId) ?? false),
  )?.id ?? endpoint.portId;
}

function portsForNode(
  document: GraphDocument,
  graph: GraphDefinition,
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition | undefined,
): readonly PortDefinition[] {
  if (node.kind === "subgraph") {
    const interfacePorts = document.graphs.find((candidate) => candidate.id === node.subgraphId)?.interfacePorts ?? [];
    if (nodeType !== undefined) {
      return [...typedNodePorts(node, nodeType), ...interfacePorts];
    }
    const interfaceIds = new Set(interfacePorts.map((port) => port.id));
    return [...interfacePorts, ...inferUnknownNodePorts(graph, node.id).filter((port) => !interfaceIds.has(port.id))];
  }
  if (nodeType !== undefined) {
    return typedNodePorts(node, nodeType);
  }
  return inferUnknownNodePorts(graph, node.id);
}

function inferUnknownNodePorts(graph: GraphDefinition, nodeId: string): readonly PortDefinition[] {
  const used = new Map<string, PortDefinition>();
  graph.edges.forEach((edge) => {
    if (edge.source.kind === "node" && edge.source.nodeId === nodeId) {
      used.set(`output:${edge.source.portId}`, { id: edge.source.portId, title: edge.source.portId, kind: edge.kind, direction: "output", ...(edge.kind === "data" ? { dataTypeId: "any" } : {}) });
    }
    if (edge.target.kind === "node" && edge.target.nodeId === nodeId) {
      used.set(`input:${edge.target.portId}`, { id: edge.target.portId, title: edge.target.portId, kind: edge.kind, direction: "input", ...(edge.kind === "data" ? { dataTypeId: "any" } : {}) });
    }
  });
  return [...used.values()];
}

function typedNodePorts(
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition,
): readonly PortDefinition[] {
  return [
    ...nodeType.ports,
    ...node.dynamicPorts.flatMap((dynamicPort) => {
      const group = resolveDynamicPortGroupDefinition(nodeType, dynamicPort.groupId);
      return group === undefined
        ? []
        : [{
            id: dynamicPort.id,
            aliases: [],
            title: dynamicPort.title,
            kind: group.port.kind,
            direction: group.port.direction,
            ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
            ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
          }];
    }),
  ];
}

function overriddenNodeProperties(
  graph: GraphDefinition,
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition | undefined,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (nodeType === undefined) {
    return result;
  }
  graph.edges.forEach((edge) => {
    if (edge.kind !== "data" || edge.target.kind !== "node" || edge.target.nodeId !== node.id) {
      return;
    }
    const port = nodeType.ports.find(
      (candidate) => candidate.id === edge.target.portId || (candidate.aliases?.includes(edge.target.portId) ?? false),
    );
    if (port?.direction !== "input") {
      return;
    }
    const portIds = new Set([port.id, ...(port.aliases ?? [])]);
    nodeType.properties.forEach((property) => {
      if ([property.id, ...(property.aliases ?? [])].some((propertyId) => portIds.has(propertyId))) {
        result.add(property.id);
      }
    });
  });
  return result;
}

function resolveDynamicPortGroupDefinition(
  nodeType: NodeTypeDefinition,
  groupId: string,
): DynamicPortGroupDefinition | undefined {
  return nodeType.dynamicPortGroups?.find(
    (group) => group.id === groupId || group.aliases.includes(groupId),
  );
}

function findCanvasPort(
  document: GraphDocument,
  graph: GraphDefinition,
  catalog: GraphCatalog,
  canvasNodeId: string,
  portId: string,
  role: "source" | "target",
): PortDefinition | undefined {
  if (canvasNodeId === INTERFACE_INPUT_NODE_ID && role === "source") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === portId && candidate.direction === "input");
    return port === undefined ? undefined : { ...port, direction: "output" };
  }
  if (canvasNodeId === INTERFACE_OUTPUT_NODE_ID && role === "target") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === portId && candidate.direction === "output");
    return port === undefined ? undefined : { ...port, direction: "input" };
  }
  const node = graph.nodes.find((candidate) => candidate.id === canvasNodeId);
  if (node === undefined) {
    return undefined;
  }
  const nodeType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalog, node.nodeTypeId);
  return portsForNode(document, graph, node, nodeType).find((port) => port.id === portId);
}

function toGraphEndpoint(canvasNodeId: string, portId: string): GraphEndpoint {
  return canvasNodeId === INTERFACE_INPUT_NODE_ID || canvasNodeId === INTERFACE_OUTPUT_NODE_ID
    ? { kind: "interface", portId }
    : { kind: "node", nodeId: canvasNodeId, portId };
}

function keepValidSelection(selection: Selection | undefined, graph: GraphDefinition): Selection | undefined {
  if (selection === undefined) {
    return undefined;
  }
  const nodeIds = selection.nodeIds.filter((nodeId) => graph.nodes.some((node) => node.id === nodeId));
  const edgeIds = selection.edgeIds.filter((edgeId) => graph.edges.some((edge) => edge.id === edgeId));
  return nodeIds.length === 0 && edgeIds.length === 0 ? undefined : { nodeIds, edgeIds };
}

function selectionsEqual(left: Selection | undefined, right: Selection | undefined): boolean {
  if (left === right) {
    return true;
  }
  return left !== undefined
    && right !== undefined
    && left.nodeIds.length === right.nodeIds.length
    && left.edgeIds.length === right.edgeIds.length
    && left.nodeIds.every((id, index) => id === right.nodeIds[index])
    && left.edgeIds.every((id, index) => id === right.edgeIds[index]);
}

function findGraphPath(document: GraphDocument, targetGraphId: string): readonly GraphDefinition[] {
  const byId = new Map(document.graphs.map((graph) => [graph.id, graph]));
  const visit = (graphId: string, path: readonly GraphDefinition[]): readonly GraphDefinition[] | undefined => {
    const graph = byId.get(graphId);
    if (graph === undefined || path.some((item) => item.id === graphId)) {
      return undefined;
    }
    const nextPath = [...path, graph];
    if (graphId === targetGraphId) {
      return nextPath;
    }
    for (const node of graph.nodes) {
      if (node.kind === "subgraph") {
        const result = visit(node.subgraphId, nextPath);
        if (result !== undefined) {
          return result;
        }
      }
    }
    return undefined;
  };
  return visit(document.rootGraphId, []) ?? [];
}

function createDefaultProperties(nodeType: NodeTypeDefinition): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(nodeType.properties.flatMap((property) =>
    property.defaultValue === undefined ? [] : [[property.id, cloneJsonValue(property.defaultValue)]],
  ));
}

function parseGraphClipboardPayload(text: string): GraphClipboardPayload | undefined {
  if (text.length === 0 || text.length > 2_000_000) {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (
      !isRecordValue(value)
      || value.format !== "visualbridge.graph-clipboard"
      || value.version !== 1
      || !Array.isArray(value.nodes)
      || value.nodes.length === 0
      || !value.nodes.every(isClipboardAtomicNode)
      || !Array.isArray(value.edges)
      || !value.edges.every(isClipboardEdge)
    ) {
      return undefined;
    }
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    if (nodeIds.size !== value.nodes.length || value.edges.some((edge) =>
      !nodeIds.has(edge.source.nodeId) || !nodeIds.has(edge.target.nodeId),
    )) {
      return undefined;
    }
    return {
      format: "visualbridge.graph-clipboard",
      version: 1,
      nodes: value.nodes.map(cloneGraphAtomicNode),
      edges: value.edges.map(cloneGraphEdge),
    };
  } catch {
    return undefined;
  }
}

function isClipboardAtomicNode(value: unknown): value is GraphAtomicNode {
  return isRecordValue(value)
    && value.kind === "node"
    && isIdentifierValue(value.id)
    && isIdentifierValue(value.nodeTypeId)
    && typeof value.title === "string"
    && isRecordValue(value.position)
    && typeof value.position.x === "number"
    && Number.isFinite(value.position.x)
    && typeof value.position.y === "number"
    && Number.isFinite(value.position.y)
    && isJsonObject(value.properties)
    && Array.isArray(value.dynamicPorts)
    && value.dynamicPorts.every((port) =>
      isRecordValue(port)
      && isIdentifierValue(port.id)
      && isIdentifierValue(port.groupId)
      && typeof port.title === "string"
      && isJsonValue(port.value),
    );
}

function isClipboardEdge(value: unknown): value is GraphEdgeModel & {
  readonly source: GraphNodeEndpoint;
  readonly target: GraphNodeEndpoint;
} {
  return isRecordValue(value)
    && isIdentifierValue(value.id)
    && (value.kind === "flow" || value.kind === "data")
    && isClipboardNodeEndpoint(value.source)
    && isClipboardNodeEndpoint(value.target);
}

function isClipboardNodeEndpoint(value: unknown): value is GraphNodeEndpoint {
  return isRecordValue(value)
    && value.kind === "node"
    && isIdentifierValue(value.nodeId)
    && isIdentifierValue(value.portId);
}

function isIdentifierValue(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneGraphAtomicNode(node: GraphAtomicNode): GraphAtomicNode {
  return JSON.parse(JSON.stringify(node)) as GraphAtomicNode;
}

function cloneGraphEdge(edge: GraphEdgeModel): GraphEdgeModel {
  return JSON.parse(JSON.stringify(edge)) as GraphEdgeModel;
}

function createDefaultGraphProperties(graphType: GraphTypeDefinition): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(graphType.properties.flatMap((property) =>
    property.defaultValue === undefined ? [] : [[property.id, cloneJsonValue(property.defaultValue)]],
  ));
}

function resolveNodeTypeDefinition(catalog: GraphCatalog, nodeTypeId: string): NodeTypeDefinition | undefined {
  return catalog.nodeTypes.find((nodeType) => nodeType.id === nodeTypeId || nodeType.aliases.includes(nodeTypeId));
}

function resolveGraphTypeDefinition(catalog: GraphCatalog, graphTypeId: string): GraphTypeDefinition | undefined {
  return catalog.graphTypes.find((graphType) => graphType.id === graphTypeId || graphType.aliases.includes(graphTypeId));
}

function matchesNodeSelectorDefinition(nodeType: NodeTypeDefinition, selector: NodeSelector): boolean {
  const nodeTypeMatch = selector.nodeTypeIds === undefined
    || selector.nodeTypeIds.some((id) => id === nodeType.id || nodeType.aliases.includes(id));
  const tagMatch = selector.tags === undefined
    || selector.tags.some((tag) => nodeType.tags?.includes(tag) ?? false);
  const traitMatch = selector.traits === undefined
    || selector.traits.every((trait) => nodeType.traits?.includes(trait) ?? false);
  return nodeTypeMatch && tagMatch && traitMatch;
}

function isNodeTypeAvailable(
  graph: GraphDefinition,
  nodeType: NodeTypeDefinition,
  catalog: GraphCatalog,
  flavor: "atomic" | "subgraph",
): boolean {
  if ((flavor === "atomic") === (nodeType.subgraph !== undefined)) {
    return false;
  }
  if (nodeType.properties.some((property) => property.required && property.defaultValue === undefined)) {
    return false;
  }
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalog, graph.graphTypeId);
  if (
    graphType?.allowedNodeSelectors !== undefined
    && !graphType.allowedNodeSelectors.some((selector) => matchesNodeSelectorDefinition(nodeType, selector))
  ) {
    return false;
  }
  return graphType?.nodeConstraints.every((constraint) => {
    if (constraint.maxInstances === undefined || !matchesNodeSelectorDefinition(nodeType, constraint.selector)) {
      return true;
    }
    const count = graph.nodes.filter((node) => {
      const currentType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalog, node.nodeTypeId);
      return currentType !== undefined && matchesNodeSelectorDefinition(currentType, constraint.selector);
    }).length;
    return count < constraint.maxInstances;
  }) ?? true;
}

function isNodeTypeRequiredByGraph(
  graph: GraphDefinition,
  nodeType: NodeTypeDefinition,
  catalog: GraphCatalog,
): boolean {
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalog, graph.graphTypeId);
  return graphType?.nodeConstraints.some((constraint) =>
    (constraint.minInstances ?? 0) > 0
    && constraint.maxInstances === 1
    && matchesNodeSelectorDefinition(nodeType, constraint.selector),
  ) ?? false;
}

function getConnectionNodeOptions(
  graph: GraphDefinition,
  catalog: GraphCatalog,
  fromPort: PortDefinition,
  fromRole: "source" | "target",
): readonly ConnectionNodeOption[] {
  const requiredDirection: PortDirection = fromRole === "source" ? "input" : "output";
  return catalog.nodeTypes.flatMap((nodeType) => {
    if (!isNodeTypeAvailable(graph, nodeType, catalog, "atomic")) {
      return [];
    }
    return nodeType.ports.flatMap((port) => {
      if (port.direction !== requiredDirection || port.kind !== fromPort.kind) {
        return [];
      }
      const sourcePort = fromRole === "source" ? fromPort : port;
      const targetPort = fromRole === "source" ? port : fromPort;
      return arePortsCompatible(catalog, sourcePort, targetPort) ? [{ nodeType, port }] : [];
    });
  }).sort((left, right) =>
    left.nodeType.title.localeCompare(right.nodeType.title)
    || left.port.title.localeCompare(right.port.title),
  );
}

function arePortsCompatible(
  catalog: GraphCatalog,
  sourcePort: PortDefinition,
  targetPort: PortDefinition,
): boolean {
  if (sourcePort.kind !== targetPort.kind || sourcePort.direction !== "output" || targetPort.direction !== "input") {
    return false;
  }
  if (sourcePort.kind !== "data" || sourcePort.dataTypeId === undefined || targetPort.dataTypeId === undefined) {
    return true;
  }
  if (
    sourcePort.dataTypeId === targetPort.dataTypeId
    || sourcePort.dataTypeId === "any"
    || targetPort.dataTypeId === "any"
  ) {
    return true;
  }
  return catalog.dataTypes
    .find((dataType) => dataType.id === targetPort.dataTypeId)
    ?.accepts.includes(sourcePort.dataTypeId) ?? false;
}

function countCanvasPortConnections(
  graph: GraphDefinition,
  catalog: GraphCatalog,
  canvasNodeId: string,
  portId: string,
  role: "source" | "target",
): number {
  const requestedEndpoint = toGraphEndpoint(canvasNodeId, portId);
  const canonicalPortId = canonicalCanvasPortId(requestedEndpoint, graph, catalog);
  return graph.edges.filter((edge) => {
    const endpoint = role === "source" ? edge.source : edge.target;
    if (endpoint.kind !== requestedEndpoint.kind) {
      return false;
    }
    if (
      endpoint.kind === "node"
      && requestedEndpoint.kind === "node"
      && endpoint.nodeId !== requestedEndpoint.nodeId
    ) {
      return false;
    }
    return canonicalCanvasPortId(endpoint, graph, catalog) === canonicalPortId;
  }).length;
}

function eventClientPosition(event: MouseEvent | TouchEvent): GraphPosition | undefined {
  if (event instanceof MouseEvent) {
    return { x: event.clientX, y: event.clientY };
  }
  const touch = event.changedTouches.item(0) ?? event.touches.item(0);
  return touch === null ? undefined : { x: touch.clientX, y: touch.clientY };
}

function getSubgraphOptions(
  graph: GraphDefinition,
  catalog: GraphCatalog,
): readonly SubgraphTypeOption[] {
  const parentType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalog, graph.graphTypeId);
  if (parentType !== undefined && !parentType.allowSubgraphs) {
    return [];
  }
  const graphTypes = catalog.graphTypes.filter((graphType) => {
    if (graphType.usage === "root") {
      return false;
    }
    return parentType?.allowedSubgraphTypeIds === undefined
      || parentType.allowedSubgraphTypeIds.some((id) => resolveGraphTypeDefinition(catalog, id)?.id === graphType.id);
  });
  return catalog.nodeTypes.flatMap((nodeType) => {
    if (nodeType.subgraph === undefined || !isNodeTypeAvailable(graph, nodeType, catalog, "subgraph")) {
      return [];
    }
    return graphTypes.flatMap((graphType) => (
      nodeType.subgraph?.graphTypeIds === undefined
      || nodeType.subgraph.graphTypeIds.some((id) => resolveGraphTypeDefinition(catalog, id)?.id === graphType.id)
        ? [{ graphType, nodeType }]
        : []
    ));
  });
}

function newId(prefix: string): string {
  const suffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${suffix}`;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);
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

function emptyCatalog(): GraphCatalog {
  return { formatVersion: 3, catalogId: "empty", title: "empty", dataTypes: [], graphTypes: [], nodeTypes: [] };
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

createRoot(rootElement).render(<ReactFlowProvider><GraphEditorApp /></ReactFlowProvider>);
