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
  SelectionMode,
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
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  compareUtf16CodeUnits,
  createDefaultProperties as createDefaultFieldProperties,
  type FieldDefinition,
  type FieldValueDefinition,
  type JsonValue,
} from "@visualbridge/core";
import { FieldValueEditor, WebviewReferenceBridge } from "@visualbridge/form-editor";
import {
  CommonIcon,
  EditorShell,
  EditorStatusBar,
  EditorToolbar,
  PropertySection,
  SaveState,
  SplitWorkspace,
  ToolbarSpacer,
} from "@visualbridge/editor-ui";
import "@xyflow/react/dist/style.css";
import {
  GRAPH_INTERFACE_INPUT_NODE_ID,
  GRAPH_INTERFACE_OUTPUT_NODE_ID,
  GRAPH_REVEAL_MESSAGE_TYPE,
  GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
  planGraphElementReveal,
  readGraphRevealTarget,
  type GraphRevealPlan,
  type GraphRevealRequest,
  type GraphRevealResult,
} from "../graphReveal";
import { computeGraphAutoLayout, GRAPH_LAYOUT_RANK_SPACING, type GraphLayoutSize } from "./graphLayout";
import "./styles.css";

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
  readonly dynamic?: boolean;
}

interface DynamicPortGroupDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly listPortMode?: "list" | "element";
  readonly port: {
    readonly kind: PortKind;
    readonly direction: PortDirection;
    readonly dataTypeId?: string;
    readonly maxConnections?: number;
  };
  readonly item: FieldValueDefinition;
  readonly maxItems?: number;
}

interface NodeTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
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
  readonly properties: readonly FieldDefinition[];
}

interface DataTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
  readonly id: string;
  readonly title: string;
  readonly color?: string;
  readonly acceptsAnySource?: boolean;
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
  readonly catalogId: string;
  readonly catalogTitle: string;
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly usage: "root" | "subgraph" | "any";
  readonly supportedCatalogIds: readonly string[];
  readonly portConnectionRules: {
    readonly input: "single" | "multiple";
    readonly output: "single" | "multiple";
  };
  readonly allowedNodeSelectors?: readonly NodeSelector[];
  readonly properties: readonly FieldDefinition[];
  readonly nodeConstraints: readonly NodeCountConstraint[];
  readonly initialNodes: readonly InitialNodeDefinition[];
  readonly allowSubgraphs: boolean;
  readonly allowedSubgraphTypeIds?: readonly string[];
}

interface GraphCatalogRegistry {
  readonly catalogs: readonly {
    readonly catalogId: string;
    readonly title: string;
  }[];
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
  | { readonly type: "graph.removeInterfacePort"; readonly graphId: string; readonly portId: string }
  | { readonly type: "graph.reorderInterfacePorts"; readonly graphId: string; readonly portIds: readonly string[] };

interface GraphNodeData extends Record<string, unknown> {
  readonly flavor: "node";
  readonly graphId: string;
  readonly model: GraphNodeModel;
  readonly nodeType?: NodeTypeDefinition;
  readonly ports: readonly PortDefinition[];
  readonly typeTitle: string;
  readonly overriddenPropertyIds: ReadonlySet<string>;
  readonly connectedInputPortIds: ReadonlySet<string>;
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
  readonly graphId: string;
  readonly title: string;
  readonly side: "inputs" | "outputs";
  readonly ports: readonly PortDefinition[];
  readonly interfacePortIds: readonly string[];
  readonly editable: boolean;
  readonly commitOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
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

interface SelectionSnapshot {
  readonly graphId: string;
  readonly selection: Selection | undefined;
}

interface SelectionHistoryEntry {
  before: SelectionSnapshot;
  after: SelectionSnapshot;
}

interface DeleteSelectionPlan {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly retainedNodeIds: readonly string[];
}

type NodePickerState =
  | { readonly mode: "add"; readonly position?: GraphPosition }
  | { readonly mode: "replace"; readonly nodeId: string }
  | {
      readonly mode: "connect";
      readonly fromNodeId: string;
      readonly fromPortId: string;
      readonly fromRole: "source" | "target";
      readonly fromPort: PortDefinition;
      readonly position: GraphPosition;
    };

type GraphContextMenuState =
  | { readonly kind: "node"; readonly x: number; readonly y: number; readonly nodeId: string }
  | { readonly kind: "selection"; readonly x: number; readonly y: number }
  | { readonly kind: "graph"; readonly x: number; readonly y: number; readonly position: GraphPosition };

interface ConnectionNodeOption {
  readonly nodeType: NodeTypeDefinition;
  readonly port: PortDefinition;
}

interface ConnectionCandidateEndpoint {
  readonly canvasNodeId: string;
  readonly portId: string;
  readonly port: PortDefinition;
}

interface ConnectionPlan {
  readonly replacementEdgeIds: readonly string[];
  readonly issue?: string;
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
      readonly catalogRegistry: GraphCatalogRegistry;
      readonly catalogReady: boolean;
      readonly isDirty?: boolean;
      readonly documentChanged?: boolean;
      readonly historyAction?: "undo" | "redo";
      readonly diagnostics: readonly DocumentDiagnostic[];
    }
  | {
      readonly type: "graphInvalid";
      readonly documentVersion: number;
      readonly isDirty?: boolean;
      readonly documentChanged?: boolean;
      readonly historyAction?: "undo" | "redo";
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
  | { readonly type: "referenceSelected"; readonly requestId: string; readonly value: string | number }
  | { readonly type: "referenceCancelled"; readonly requestId: string }
  | { readonly type: "operationCompleted"; readonly documentVersion: number; readonly changed: boolean }
  | { readonly type: "operationRejected"; readonly message: string }
  | { readonly type: "requestReady"; readonly webviewToken: string }
  | { readonly type: "graphExecutionInstances"; readonly requestId: string; readonly executions: readonly GraphDebugExecution[]; readonly runtimeConnected: boolean; readonly runtimeInstanceId?: string }
  | { readonly type: "graphExecutionSubscribed"; readonly requestId: string; readonly ok: boolean; readonly execution?: GraphDebugExecution; readonly error?: string }
  | { readonly type: "graphExecutionUnsubscribed"; readonly requestId: string }
  | { readonly type: "graphExecutionEvents"; readonly events: readonly GraphDebugEvent[]; readonly totalEvents: number; readonly stopped: boolean }
  | { readonly type: "graphExecutionStopped"; readonly executionId: string; readonly totalEvents: number }
  | {
      readonly type: "graphExecutionDebugState";
      readonly requestId: string;
      readonly subscribed: boolean;
      readonly execution?: GraphDebugExecution;
      readonly events: readonly GraphDebugEvent[];
      readonly stopped: boolean;
    }
  | GraphRevealRequest;

/** 执行实例浅描述（§19.5 实例选择器数据）。 */
interface GraphDebugExecution {
  readonly executionId: string;
  readonly documentTypeId: string;
  readonly documentId: string;
  readonly graphName: string;
  readonly debugKey: string;
  readonly state: string;
  readonly currentNodeId: string | null;
  readonly frameIndex: number;
}

/** 会话内留存的执行事件（宿主增量推送累计）。 */
interface GraphDebugEvent {
  readonly index: number;
  readonly frameIndex: number;
  readonly kind: string;
  readonly nodeId?: string;
  readonly outputIndex?: number;
  readonly value?: string;
}

/** 当前执行节点高亮（时间轴光标推导；replay 为回放态）。 */
interface GraphDebugHighlight {
  readonly executingNodeId: string | null;
  readonly replay: boolean;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const rawVscode = acquireVsCodeApi();
const webviewInstanceId = crypto.randomUUID();
let webviewToken: string | undefined;
const vscode: VsCodeApi = {
  postMessage: (message) => rawVscode.postMessage(withWebviewToken(message, webviewToken)),
};
const referenceBridge = new WebviewReferenceBridge(vscode);
const INTERFACE_INPUT_NODE_ID = GRAPH_INTERFACE_INPUT_NODE_ID;
const INTERFACE_OUTPUT_NODE_ID = GRAPH_INTERFACE_OUTPUT_NODE_ID;
const GraphPendingContext = createContext(false);
const GraphNodeTypeVisibilityContext = createContext(true);
const GraphNodeIdVisibilityContext = createContext(false);
const GraphDataTypesContext = createContext<readonly DataTypeDefinition[]>([]);
const GraphRevealContext = createContext<GraphRevealPlan | undefined>(undefined);
const GraphDebugContext = createContext<GraphDebugHighlight | undefined>(undefined);
let graphDebugRequestIdCounter = 0;
const nodeTypes = {
  visualBridgeNode: VisualBridgeNode,
  visualBridgeInterface: VisualBridgeInterfaceNode,
};

function VisualBridgeNode({ data, selected }: NodeProps<GraphFlowNode>): React.JSX.Element {
  const pending = useContext(GraphPendingContext);
  const showNodeTypes = useContext(GraphNodeTypeVisibilityContext);
  const showNodeIds = useContext(GraphNodeIdVisibilityContext);
  const reveal = useContext(GraphRevealContext);
  const debug = useContext(GraphDebugContext);
  if (data.flavor !== "node") {
    return <article className="graph-node">Invalid node</article>;
  }
  const propertyInputPortIds = new Set(
    (data.nodeType?.properties ?? []).flatMap((property) => {
      const port = resolvePropertyInputPort(data.nodeType, property);
      return port === undefined ? [] : [port.id];
    }),
  );
  const dynamicPortIds = new Set([
    ...data.model.dynamicPorts.map((port) => port.id),
    ...(data.nodeType?.dynamicPortGroups ?? []).flatMap((group) =>
      group.listPortMode === "list" ? [group.id, ...group.aliases] : []),
  ]);
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
  const revealed = reveal?.graphId === data.graphId
    && (reveal.elementKind === "node" || reveal.elementKind === "dynamicPort")
    && reveal.nodeId === data.model.id;
  const executing = debug?.executingNodeId !== null && debug?.executingNodeId !== undefined
    && debug.executingNodeId === data.model.id;
  return (
    <article className={`graph-node${selected ? " selected" : ""}${revealed ? " revealed" : ""}${executing ? ` executing${debug?.replay === true ? " executing-replay" : ""}` : ""}${data.model.kind === "subgraph" ? " subgraph" : ""}`}>
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
  property: FieldDefinition,
): PortDefinition | undefined {
  if (nodeType === undefined) {
    return undefined;
  }
  const propertyIds = new Set([property.id, ...property.aliases]);
  return nodeType.ports.find((port) =>
    port.kind === "data"
    && port.direction === "input"
    && [port.id, ...(port.aliases ?? [])].some((portId) => propertyIds.has(portId)),
  );
}

function InlineNodeProperties({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element {
  const definitions = data.nodeType?.properties ?? [];
  const declaredPropertyIds = new Set(definitions.flatMap((definition) => [definition.id, ...definition.aliases]));
  const unknownDefinitions: readonly FieldDefinition[] = Object.entries(data.model.properties)
    .filter(([propertyId]) => !declaredPropertyIds.has(propertyId))
    .map(([propertyId, value]) => ({
      id: propertyId,
      aliases: [],
      title: propertyId,
      description: "该字段未在当前 Catalog Registry 中声明，按现有 JSON 值类型编辑。",
      valueType: typeof value === "string"
        ? "string"
        : typeof value === "number"
          ? "number"
          : typeof value === "boolean"
            ? "boolean"
            : "json",
      defaultValue: cloneJsonValue(value),
      fields: [],
    }));
  return (
    <div className="graph-node-properties nodrag nowheel" onDoubleClick={(event) => event.stopPropagation()}>
      {[...definitions, ...unknownDefinitions].map((definition) => (
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
  readonly definition: FieldDefinition;
  readonly pending: boolean;
}): React.JSX.Element {
  const dataTypes = useContext(GraphDataTypesContext);
  const propertyIds = [definition.id, ...definition.aliases];
  const serializedPropertyIds = propertyIds.filter((propertyId) => Object.hasOwn(data.model.properties, propertyId));
  const serializedPropertyId = serializedPropertyIds[0];
  const value = serializedPropertyId === undefined ? undefined : data.model.properties[serializedPropertyId];
  const overridden = data.overriddenPropertyIds.has(definition.id);
  const inputPort = resolvePropertyInputPort(data.nodeType, definition);
  const dataColorStyle = graphDataTypeStyle(inputPort?.dataTypeId ?? definition.dataTypeId, dataTypes);
  const fieldTitle = definition.title;
  const commit = (nextValue: JsonValue): void => {
    if (serializedPropertyIds.length === 1 && serializedPropertyId === definition.id && jsonValuesEqual(value, nextValue)) {
      return;
    }
    const properties = { ...data.model.properties };
    propertyIds.forEach((propertyId) => delete properties[propertyId]);
    properties[definition.id] = nextValue;
    if (!jsonValuesEqual(properties, data.model.properties)) {
      data.commitNode(data.model.id, data.model.title, properties);
    }
  };
  const wrapEditor = (editor: React.JSX.Element): React.JSX.Element => (
    <div
      className={`graph-node-property-input${dataColorStyle === undefined ? "" : " typed"}${overridden ? " connected" : ""}`}
      style={dataColorStyle}
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
  return wrapEditor(
    <div className="graph-node-property">
      <span title={definition.description}>{fieldTitle}</span>
      <div className="graph-node-property-value">
        <FieldValueEditor
          key={`${data.model.id}:${definition.id}:${JSON.stringify(value)}`}
          definition={definition}
          value={value}
          disabled={pending}
          ariaLabel={definition.title}
          referenceActions={referenceBridge}
          onCommit={commit}
        />
      </div>
    </div>,
  );
}

function InlineDynamicPorts({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element | null {
  const dataTypes = useContext(GraphDataTypesContext);
  const reveal = useContext(GraphRevealContext);
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
        const listConnected = group.listPortMode === "list" && data.connectedInputPortIds.has(group.id);
        const addPort = (index: number): void => {
          const port: GraphDynamicPort = {
            id: newId("port"),
            groupId: group.id,
            title: `${group.title} ${ports.length + 1}`,
            value: cloneJsonValue(group.item.defaultValue),
          };
          const portIds = [...data.model.dynamicPorts.map((candidate) => candidate.id), port.id];
          portIds.splice(portIds.length - 1, 1);
          const nextGroupPort = ports[index];
          const insertionIndex = nextGroupPort === undefined
            ? portIds.length
            : portIds.indexOf(nextGroupPort.id);
          portIds.splice(insertionIndex < 0 ? portIds.length : insertionIndex, 0, port.id);
          setSelectedPortId(port.id);
          data.commitOperations([
            {
              type: "graph.addDynamicPort",
              graphId: data.graphId,
              nodeId: data.model.id,
              port,
            },
            {
              type: "graph.reorderDynamicPorts",
              graphId: data.graphId,
              nodeId: data.model.id,
              portIds,
            },
          ]);
        };
        const selectedPortIndex = ports.findIndex((port) => port.id === selectedPortId);
        const deleteSelectedPort = (): void => {
          const selectedPort = ports[selectedPortIndex];
          if (selectedPort === undefined || !window.confirm("删除这个动态元素？相关连线也会被删除。")) {
            return;
          }
          const nextSelectedPort = ports.length <= 1
            ? undefined
            : ports[Math.min(selectedPortIndex, ports.length - 2)];
          setSelectedPortId(nextSelectedPort?.id);
          data.commitOperations([{
            type: "graph.removeDynamicPort",
            graphId: data.graphId,
            nodeId: data.model.id,
            portId: selectedPort.id,
          }]);
        };
        const groupDragState = dragState !== undefined && ports.some((port) => port.id === dragState.sourcePortId)
          ? dragState
          : undefined;
        return (
          <section key={group.id} className="graph-dynamic-port-group" title={group.description}>
            <header>
              <div
                className={`graph-list-field-port${group.listPortMode === "list" ? " enabled" : ""}`}
                style={group.listPortMode === "list" ? graphDataTypeStyle(group.port.dataTypeId, dataTypes) : undefined}
              >
                <strong>{group.title}</strong>
                {group.listPortMode === "list" && (
                  <Handle
                    id={group.id}
                    type="target"
                    position={Position.Left}
                    className="graph-handle data graph-list-handle"
                    title={`${group.title} · List · ${group.port.dataTypeId ?? "any"}`}
                  />
                )}
              </div>
              {!listConnected && <div className="graph-dynamic-port-group-actions vb-list-actions">
                <button
                  type="button"
                  className="secondary graph-list-add"
                  disabled={pending || !canAdd}
                  aria-label={`${group.listPortMode === undefined ? "添加动态端口" : "添加列表元素"} ${group.title}${selectedPortIndex < 0 ? "" : "，在选中项后"}`}
                  title={selectedPortIndex < 0 ? "添加元素" : "在选中项后添加"}
                  onClick={() => addPort(selectedPortIndex < 0 ? ports.length : selectedPortIndex + 1)}
                >
                  <CommonIcon name="add" />
                </button>
                <button
                  type="button"
                  className="secondary graph-list-delete"
                  disabled={pending || selectedPortIndex < 0}
                  aria-label={`删除 ${group.title} 选中项`}
                  title="删除选中项"
                  onClick={deleteSelectedPort}
                >
                  <CommonIcon name="delete" />
                </button>
              </div>}
            </header>
            {listConnected
              ? <div className="graph-list-connected"><span>{group.title}</span><em>已连接</em></div>
              : ports.map((port, portIndex) => (
              <DynamicPortRow
                key={port.id}
                data={data}
                group={group}
                port={port}
                pending={pending}
                connected={group.listPortMode === "element" && data.connectedInputPortIds.has(port.id)}
                selected={selectedPortId === port.id}
                revealed={reveal?.elementKind === "dynamicPort"
                  && reveal.graphId === data.graphId
                  && reveal.nodeId === data.model.id
                  && reveal.portId === port.id}
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
            {!listConnected && ports.length === 0 && (
              <span className="graph-node-no-properties">{group.listPortMode === undefined ? "暂无端口" : "暂无元素"}</span>
            )}
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
  connected,
  selected,
  revealed,
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
  readonly connected: boolean;
  readonly selected: boolean;
  readonly revealed: boolean;
  readonly onSelect: () => void;
  readonly dragging: boolean;
  readonly dropPosition: "before" | "after" | undefined;
  readonly onDragStart: () => void;
  readonly onDragOver: (position: "before" | "after") => void;
  readonly onDrop: (sourcePortId: string, position: "before" | "after") => void;
  readonly onDragEnd: () => void;
  readonly onKeyboardMove: (offset: -1 | 1) => void;
}): React.JSX.Element {
  const dataTypes = useContext(GraphDataTypesContext);
  const model = data.model;
  const dataColorStyle = graphDataTypeStyle(
    group.listPortMode === "list" ? group.item.dataTypeId : group.port.dataTypeId ?? group.item.dataTypeId,
    dataTypes,
  );
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
      className={`graph-dynamic-port-row${dataColorStyle === undefined ? "" : " typed"}${selected ? " selected" : ""}${revealed ? " revealed" : ""}${dragging ? " dragging" : ""}${dropPosition === undefined ? "" : ` drop-${dropPosition}`}`}
      style={dataColorStyle}
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
      <div className="graph-dynamic-port-row-actions vb-list-actions" role="group" aria-label={`${port.title} 列表项操作`}>
        <button
          type="button"
          className="secondary graph-dynamic-port-drag"
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
        ><CommonIcon name="drag" /></button>
      </div>
      {connected
        ? <div className="graph-list-element-connected"><span>元素</span><em>已连接</em></div>
        : (
          <DynamicPortValueEditor
            group={group}
            port={port}
            pending={pending}
            commit={commit}
          />
        )}
      {group.listPortMode !== "list" && (
        <Handle
          id={port.id}
          type={group.port.direction === "input" ? "target" : "source"}
          position={group.port.direction === "input" ? Position.Left : Position.Right}
          className={`graph-handle ${group.port.kind}`}
          title={`${group.title} · ${group.port.kind}${group.port.dataTypeId === undefined ? "" : ` · ${group.port.dataTypeId}`}`}
        />
      )}
    </article>
  );
}

function DynamicPortValueEditor({
  group,
  port,
  pending,
  commit,
}: {
  readonly group: DynamicPortGroupDefinition;
  readonly port: GraphDynamicPort;
  readonly pending: boolean;
  readonly commit: (value: JsonValue) => void;
}): React.JSX.Element {
  return (
    <FieldValueEditor
      key={`${port.id}:${JSON.stringify(port.value)}`}
      definition={group.item}
      value={port.value}
      disabled={pending}
      ariaLabel={`动态端口值 ${port.id}`}
      referenceActions={referenceBridge}
      onCommit={commit}
    />
  );
}

function VisualBridgeInterfaceNode({ data }: NodeProps<GraphFlowNode>): React.JSX.Element {
  const pending = useContext(GraphPendingContext);
  const reveal = useContext(GraphRevealContext);
  if (data.flavor !== "interface") {
    return <article className="graph-interface-node">Invalid interface</article>;
  }
  const [selectedPortId, setSelectedPortId] = useState<string>();
  const [draggingPortId, setDraggingPortId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ readonly portId: string; readonly position: "before" | "after" }>();
  const dynamicPorts = data.ports.filter((port) => port.kind === "data" && port.dynamic === true);
  useEffect(() => {
    if (selectedPortId !== undefined && !dynamicPorts.some((port) => port.id === selectedPortId)) {
      setSelectedPortId(undefined);
    }
  }, [dynamicPorts, selectedPortId]);
  const addParameter = (afterPortId?: string): void => {
    const index = dynamicPorts.length + 1;
    const port: PortDefinition = {
      id: newId(data.side === "inputs" ? "input" : "output"),
      title: `${data.side === "inputs" ? "输入" : "输出"} ${index}`,
      kind: "data",
      direction: data.side === "inputs" ? "input" : "output",
      dataTypeId: "any",
      dynamic: true,
    };
    const portIds = [...data.interfacePortIds, port.id];
    if (afterPortId !== undefined) {
      portIds.pop();
      const targetIndex = portIds.indexOf(afterPortId);
      portIds.splice(targetIndex < 0 ? portIds.length : targetIndex + 1, 0, port.id);
    }
    setSelectedPortId(port.id);
    data.commitOperations([
      { type: "graph.addInterfacePort", graphId: data.graphId, port },
      { type: "graph.reorderInterfacePorts", graphId: data.graphId, portIds },
    ]);
  };
  const reorder = (sourcePortId: string, targetPortId: string, position: "before" | "after"): void => {
    const reorderedDynamicIds = reorderIds(
      dynamicPorts.map((port) => port.id),
      sourcePortId,
      targetPortId,
      position,
    );
    if (reorderedDynamicIds === undefined) {
      setDraggingPortId(undefined);
      setDropTarget(undefined);
      return;
    }
    const dynamicPortIds = new Set(dynamicPorts.map((port) => port.id));
    let dynamicIndex = 0;
    const portIds = data.interfacePortIds.map((portId) => (
      dynamicPortIds.has(portId) ? reorderedDynamicIds[dynamicIndex++]! : portId
    ));
    setDraggingPortId(undefined);
    setDropTarget(undefined);
    data.commitOperations([{ type: "graph.reorderInterfacePorts", graphId: data.graphId, portIds }]);
  };
  const moveByKeyboard = (portId: string, offset: -1 | 1): void => {
    const index = dynamicPorts.findIndex((port) => port.id === portId);
    const target = dynamicPorts[index + offset];
    if (index >= 0 && target !== undefined) {
      reorder(portId, target.id, offset < 0 ? "before" : "after");
    }
  };
  const fixedPorts = data.ports.filter((port) => port.kind !== "data" || port.dynamic !== true).map((port) => ({
    ...port,
    direction: data.side === "inputs" ? "output" as const : "input" as const,
  }));
  const revealedPortId = reveal?.elementKind === "interfacePort" && reveal.graphId === data.graphId
    ? reveal.portId
    : undefined;
  const selectedPortIndex = dynamicPorts.findIndex((port) => port.id === selectedPortId);
  const deleteSelectedParameter = (): void => {
    const selectedPort = dynamicPorts[selectedPortIndex];
    if (selectedPort === undefined) {
      return;
    }
    const nextSelectedPort = dynamicPorts.length <= 1
      ? undefined
      : dynamicPorts[Math.min(selectedPortIndex, dynamicPorts.length - 2)];
    setSelectedPortId(nextSelectedPort?.id);
    data.commitOperations([{
      type: "graph.removeInterfacePort",
      graphId: data.graphId,
      portId: selectedPort.id,
    }]);
  };
  return (
    <article className={`graph-interface-node ${data.side}${revealedPortId === undefined ? "" : " revealed"}`}>
      <header>
        <span>{data.title}</span>
        {data.editable && (
          <span className="graph-interface-actions vb-list-actions nodrag nowheel">
            <button
              type="button"
              className="secondary graph-list-add"
              disabled={pending}
              aria-label={`添加${data.side === "inputs" ? "输入" : "输出"}参数`}
              title={selectedPortIndex < 0 ? `添加${data.side === "inputs" ? "输入" : "输出"}参数` : "在选中参数后添加"}
              onClick={() => addParameter(selectedPortIndex < 0 ? undefined : selectedPortId)}
            ><CommonIcon name="add" /></button>
            <button
              type="button"
              className="secondary graph-list-delete"
              disabled={pending || selectedPortIndex < 0}
              aria-label={`删除选中的${data.side === "inputs" ? "输入" : "输出"}参数`}
              title="删除选中参数"
              onClick={deleteSelectedParameter}
            ><CommonIcon name="delete" /></button>
          </span>
        )}
      </header>
      <PortColumn
        ports={fixedPorts}
        align={data.side === "inputs" ? "right" : "left"}
        {...(revealedPortId === undefined ? {} : { revealedPortId })}
      />
      {dynamicPorts.length > 0 && (
        <div className="graph-interface-parameter-list nodrag nowheel" role="listbox" aria-label={data.title}>
          {dynamicPorts.map((port) => (
            <InterfaceParameterRow
              key={port.id}
              data={data}
              port={port}
              pending={pending}
              selected={selectedPortId === port.id}
              revealed={revealedPortId === port.id}
              dragging={draggingPortId === port.id}
              dropPosition={dropTarget?.portId === port.id ? dropTarget.position : undefined}
              onSelect={() => setSelectedPortId(port.id)}
              onDragStart={() => setDraggingPortId(port.id)}
              onDragOver={(targetPortId, position) => setDropTarget({ portId: targetPortId, position })}
              onDrop={(targetPortId, position) => reorder(port.id, targetPortId, position)}
              onDragEnd={() => {
                setDraggingPortId(undefined);
                setDropTarget(undefined);
              }}
              onKeyboardMove={(offset) => moveByKeyboard(port.id, offset)}
              editable={data.editable}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function InterfaceParameterRow({
  data,
  port,
  pending,
  selected,
  revealed,
  dragging,
  dropPosition,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onKeyboardMove,
  editable,
}: {
  readonly data: GraphInterfaceData;
  readonly port: PortDefinition;
  readonly pending: boolean;
  readonly selected: boolean;
  readonly revealed: boolean;
  readonly dragging: boolean;
  readonly dropPosition: "before" | "after" | undefined;
  readonly onSelect: () => void;
  readonly onDragStart: () => void;
  readonly onDragOver: (targetPortId: string, position: "before" | "after") => void;
  readonly onDrop: (targetPortId: string, position: "before" | "after") => void;
  readonly onDragEnd: () => void;
  readonly onKeyboardMove: (offset: -1 | 1) => void;
  readonly editable: boolean;
}): React.JSX.Element {
  const dataTypes = useContext(GraphDataTypesContext);
  const [title, setTitle] = useState(port.title);
  useEffect(() => setTitle(port.title), [port.title]);
  const effectiveDirection: PortDirection = data.side === "inputs" ? "output" : "input";
  const typeTitle = port.dataTypeId === "any"
    ? "未连接"
    : dataTypes.find((dataType) => dataType.id === port.dataTypeId)?.title ?? port.dataTypeId ?? "未连接";
  const commitTitle = (): void => {
    const nextTitle = title.trim();
    if (nextTitle.length === 0) {
      setTitle(port.title);
      data.reportStatus({ message: "参数名称不能为空。", error: true });
    } else if (nextTitle !== port.title) {
      data.commitOperations([{
        type: "graph.updateInterfacePort",
        graphId: data.graphId,
        portId: port.id,
        title: nextTitle,
      }]);
    }
  };
  return (
    <div
      className={`graph-interface-parameter${selected ? " selected" : ""}${revealed ? " revealed" : ""}${dragging ? " dragging" : ""}${dropPosition === undefined ? "" : ` drop-${dropPosition}`}`}
      style={graphDataTypeStyle(port.dataTypeId, dataTypes)}
      role="option"
      aria-selected={selected}
      data-interface-port-id={port.id}
      tabIndex={0}
      onClick={onSelect}
    >
      {editable && (
        <div className="graph-interface-parameter-actions vb-list-actions" role="group" aria-label={`${port.title} 列表项操作`}>
          <button
            type="button"
            className="secondary graph-interface-parameter-drag"
            disabled={pending}
            aria-label={`拖动排序 ${port.title}`}
            title="拖动排序；Alt+↑/↓ 也可移动"
            onPointerDown={(event) => {
              if (event.button !== 0 || pending) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              onSelect();
              onDragStart();
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                return;
              }
              const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-interface-port-id]");
              const targetPortId = target?.dataset.interfacePortId;
              if (target !== undefined && target !== null && targetPortId !== undefined) {
                const bounds = target.getBoundingClientRect();
                onDragOver(targetPortId, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
              }
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                return;
              }
              const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-interface-port-id]");
              const targetPortId = target?.dataset.interfacePortId;
              if (target !== undefined && target !== null && targetPortId !== undefined) {
                const bounds = target.getBoundingClientRect();
                onDrop(targetPortId, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
              }
              event.currentTarget.releasePointerCapture(event.pointerId);
              onDragEnd();
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              onDragEnd();
            }}
            onKeyDown={(event) => {
              if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                event.stopPropagation();
                onKeyboardMove(event.key === "ArrowUp" ? -1 : 1);
              }
            }}
          ><CommonIcon name="drag" /></button>
        </div>
      )}
      <input
        value={title}
        disabled={pending}
        aria-label={`${data.side === "inputs" ? "输入" : "输出"}参数名称`}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setTitle(port.title);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="graph-interface-parameter-type">{typeTitle}</span>
      <Handle
        id={port.id}
        type={effectiveDirection === "input" ? "target" : "source"}
        position={effectiveDirection === "input" ? Position.Left : Position.Right}
        className="graph-handle data"
        title={`${port.title} · data · ${typeTitle}`}
      />
    </div>
  );
}

function PortColumn({
  ports,
  align = "left",
  revealedPortId,
}: {
  readonly ports: readonly PortDefinition[];
  readonly align?: "left" | "right";
  readonly revealedPortId?: string;
}): React.JSX.Element {
  const dataTypes = useContext(GraphDataTypesContext);
  return (
    <div className={`graph-port-column ${align}`}>
      {ports.map((port) => (
        <div
          key={`${port.direction}:${port.id}`}
          className={`graph-port ${port.kind}${revealedPortId === port.id ? " revealed" : ""}`}
          style={graphDataTypeStyle(port.dataTypeId, dataTypes)}
          title={port.dataTypeId}
        >
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

function SelectionContextActions({
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
      <button type="button" disabled={duplicateIssue !== undefined} title={duplicateIssue} onClick={onDuplicate}>Duplicate</button>
      <button type="button" disabled={deleteIssue !== undefined} title={deleteIssue} onClick={onDelete}>{deleteLabel}</button>
    </>
  );
}

function GraphEditorApp(): React.JSX.Element {
  const rootMetadata = useMemo(readMetadata, []);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<GraphDocument | undefined>(undefined);
  const catalogRegistryRef = useRef<GraphCatalogRegistry>(emptyCatalogRegistry());
  const catalogReadyRef = useRef(false);
  const activeGraphIdRef = useRef("");
  const documentVersionRef = useRef(0);
  const pendingRef = useRef(false);
  const selectedRef = useRef<Selection | undefined>(undefined);
  const undoSelectionHistoryRef = useRef<SelectionHistoryEntry[]>([]);
  const redoSelectionHistoryRef = useRef<SelectionHistoryEntry[]>([]);
  const pendingSelectionHistoryRef = useRef<SelectionHistoryEntry | undefined>(undefined);
  const lastCompletedOperationVersionRef = useRef<number | undefined>(undefined);
  const clipboardPasteIndexRef = useRef(0);
  const applyingRevealRequestIdRef = useRef<string | undefined>(undefined);
  const currentRevealRequestIdRef = useRef<string | undefined>(undefined);
  const revealTimerRef = useRef<number | undefined>(undefined);
  const handshakeProposalSentRef = useRef(false);
  const autoLayoutFitViewRef = useRef(false);
  const [graphDocument, setGraphDocument] = useState<GraphDocument>();
  const [catalogRegistry, setCatalogRegistry] = useState<GraphCatalogRegistry>(emptyCatalogRegistry());
  const [catalogReady, setCatalogReady] = useState(false);
  const [replacementCandidates, setReplacementCandidates] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [activeGraphId, setActiveGraphIdValue] = useState("");
  const [flowNodes, setFlowNodes] = useState<GraphFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<GraphFlowEdge[]>([]);
  const [flowGraphId, setFlowGraphId] = useState<string>();
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<GraphFlowNode, GraphFlowEdge>>();
  const [selected, setSelected] = useState<Selection>();
  const [pending, setPending] = useState(false);
  const [documentDirty, setDocumentDirty] = useState<boolean>();
  const [invalidDiagnostics, setInvalidDiagnostics] = useState<readonly DocumentDiagnostic[]>([]);
  const [status, setStatus] = useState({ message: "正在加载 Graph Document…", error: false });
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState>();
  const [picker, setPicker] = useState<NodePickerState>();
  const [subgraphPickerOpen, setSubgraphPickerOpen] = useState(false);
  const [subgraphPosition, setSubgraphPosition] = useState<GraphPosition>();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [showNodeTypes, setShowNodeTypes] = useState(true);
  const [showNodeIds, setShowNodeIds] = useState(false);
  const [pendingRevealRequest, setPendingRevealRequest] = useState<GraphRevealRequest>();
  const [activeReveal, setActiveReveal] = useState<{
    readonly request: GraphRevealRequest;
    readonly plan: GraphRevealPlan;
  }>();
  const [revealedElement, setRevealedElement] = useState<GraphRevealPlan>();
  // 执行调试状态（§19.5）：光标仅在回放态有意义，实时态恒等于事件末尾。
  const [debugDrawerOpen, setDebugDrawerOpen] = useState(false);
  const [debugInstances, setDebugInstances] = useState<readonly GraphDebugExecution[]>([]);
  const [debugRuntimeConnected, setDebugRuntimeConnected] = useState(false);
  const [debugRuntimeInstanceId, setDebugRuntimeInstanceId] = useState<string>();
  const [debugExecution, setDebugExecution] = useState<GraphDebugExecution>();
  const [debugEvents, setDebugEvents] = useState<readonly GraphDebugEvent[]>([]);
  const [debugStopped, setDebugStopped] = useState(false);
  const [debugCursor, setDebugCursor] = useState(-1);
  const [debugFollow, setDebugFollow] = useState(true);
  const [debugFlash, setDebugFlash] = useState<{
    readonly keys: ReadonlySet<string>;
    readonly nodeIds: ReadonlySet<string>;
  }>();
  const debugEventsRef = useRef<readonly GraphDebugEvent[]>([]);
  const debugCursorRef = useRef(-1);
  const debugFollowRef = useRef(true);
  const debugFlashTimerRef = useRef<number | undefined>(undefined);

  const activeGraph = useMemo(
    () => graphDocument?.graphs.find((graph) => graph.id === activeGraphId),
    [activeGraphId, graphDocument],
  );

  const updateSelection = useCallback((
    next: Selection | undefined,
    synchronizeFlow = true,
    recordHistory = true,
  ): void => {
    if (recordHistory) {
      const snapshot = createSelectionSnapshot(activeGraphIdRef.current, next);
      const pendingEntry = pendingSelectionHistoryRef.current;
      if (pendingEntry !== undefined) {
        pendingEntry.after = snapshot;
      } else {
        const undoEntry = undoSelectionHistoryRef.current.at(-1);
        const redoEntry = redoSelectionHistoryRef.current.at(-1);
        if (undoEntry !== undefined) {
          undoEntry.after = snapshot;
        }
        if (redoEntry !== undefined) {
          redoEntry.before = snapshot;
        }
      }
    }
    const current = selectedRef.current;
    if (selectionsEqual(current, next)) {
      return;
    }
    selectedRef.current = next;
    setSelected(next);
    if (!synchronizeFlow) {
      return;
    }
    const selectedNodeIds = new Set(next?.nodeIds ?? []);
    const selectedEdgeIds = new Set(next?.edgeIds ?? []);
    setFlowNodes((nodes) => nodes.map((node) => {
      const shouldSelect = node.data.flavor === "node" && selectedNodeIds.has(node.id);
      return node.selected === shouldSelect ? node : { ...node, selected: shouldSelect };
    }));
    setFlowEdges((edges) => edges.map((edge) => {
      const shouldSelect = selectedEdgeIds.has(edge.id);
      return edge.selected === shouldSelect ? edge : { ...edge, selected: shouldSelect };
    }));
  }, []);

  const setActiveGraphId = useCallback((next: string): void => {
    activeGraphIdRef.current = next;
    setActiveGraphIdValue(next);
    updateSelection(undefined);
    setContextMenu(undefined);
  }, [updateSelection]);

  const postDebugAck = useCallback((mode: "follow" | "replay"): void => {
    const events = debugEventsRef.current;
    const cursor = debugFollowRef.current ? events.length - 1 : debugCursorRef.current;
    vscode.postMessage({
      type: "graphDebugAck",
      eventCount: events.length,
      cursor,
      executingNodeId: computeGraphDebugView(events, cursor).executingNodeId,
      mode,
    });
  }, []);

  // 实时态边流光：最近一批 nodeOutput/edgeValueChanged 事件在短窗口内点亮对应边。
  const applyDebugFlash = useCallback((events: readonly GraphDebugEvent[]): void => {
    const keys = new Set<string>();
    const nodeIds = new Set<string>();
    for (const event of events) {
      if ((event.kind === "nodeOutput" || event.kind === "edgeValueChanged") && event.nodeId !== undefined) {
        nodeIds.add(event.nodeId);
        if (event.outputIndex !== undefined) {
          keys.add(`${event.nodeId}:${event.outputIndex}`);
        }
      }
    }
    if (keys.size === 0 && nodeIds.size === 0) {
      return;
    }
    setDebugFlash({ keys, nodeIds });
    if (debugFlashTimerRef.current !== undefined) {
      window.clearTimeout(debugFlashTimerRef.current);
    }
    debugFlashTimerRef.current = window.setTimeout(() => {
      setDebugFlash(undefined);
      debugFlashTimerRef.current = undefined;
    }, 600);
  }, []);

  const requestDebugInstances = useCallback((): void => {
    vscode.postMessage({ type: "requestGraphExecutionInstances", requestId: nextGraphDebugRequestId() });
  }, []);

  const subscribeDebugExecution = useCallback((executionId: string): void => {
    vscode.postMessage({
      type: "subscribeGraphExecution",
      requestId: nextGraphDebugRequestId(),
      executionId,
    });
  }, []);

  const unsubscribeDebugExecution = useCallback((): void => {
    vscode.postMessage({ type: "unsubscribeGraphExecution", requestId: nextGraphDebugRequestId() });
  }, []);

  const enterDebugReplay = useCallback((cursor: number): void => {
    debugFollowRef.current = false;
    debugCursorRef.current = cursor;
    setDebugFollow(false);
    setDebugCursor(cursor);
  }, []);

  const enterDebugFollow = useCallback((): void => {
    debugFollowRef.current = true;
    setDebugFollow(true);
  }, []);

  const postOperations = useCallback((
    operations: readonly GraphOperation[],
    selectionBefore?: SelectionSnapshot,
  ): void => {
    if (documentRef.current === undefined || pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setContextMenu(undefined);
    setPicker(undefined);
    setSubgraphPickerOpen(false);
    setSubgraphPosition(undefined);
    setStatus({ message: "正在应用修改…", error: false });
    const currentSelection = createSelectionSnapshot(activeGraphIdRef.current, selectedRef.current);
    pendingSelectionHistoryRef.current = {
      before: selectionBefore ?? currentSelection,
      after: currentSelection,
    };
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

  const applyAutoLayout = useCallback((): void => {
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    if (currentGraph === undefined || flowInstance === undefined) {
      return;
    }
    // 用 React Flow 渲染后的实测尺寸计算布局，高节点不会再按估算值排版而重叠。
    const sizes = new Map<string, GraphLayoutSize>();
    for (const flowNode of flowInstance.getNodes()) {
      if (flowNode.data.flavor !== "node" || flowNode.measured?.width === undefined || flowNode.measured.height === undefined) {
        continue;
      }
      sizes.set(flowNode.id, { width: flowNode.measured.width, height: flowNode.measured.height });
    }
    // 子图的"输入参数"桩固定在画布左侧（x:-100）且宽度自适应，布局主区需要让出它的实测宽度。
    const inputStub = flowInstance.getNodes().find((node) => node.id === INTERFACE_INPUT_NODE_ID);
    const startX = inputStub !== undefined && inputStub.measured?.width !== undefined
      ? inputStub.position.x + inputStub.measured.width + GRAPH_LAYOUT_RANK_SPACING
      : undefined;
    const layout = computeGraphAutoLayout(currentGraph.nodes, currentGraph.edges, sizes, {
      ...(startX === undefined ? {} : { startX }),
    });
    const operations = currentGraph.nodes.flatMap((node) => {
      const position = layout.get(node.id);
      if (position === undefined || position.x === node.position.x && position.y === node.position.y) {
        return [];
      }
      return [{ type: "graph.moveNode" as const, graphId: currentGraph.id, nodeId: node.id, position }];
    });
    if (operations.length === 0) {
      setStatus({ message: "当前图已处于自动布局位置。", error: false });
      return;
    }
    autoLayoutFitViewRef.current = true;
    postOperations(operations);
    setStatus({ message: "正在自动布局当前图…", error: false });
  }, [flowInstance, postOperations]);

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
      const nodeType = resolveNodeTypeDefinition(catalogRegistryRef.current, node.nodeTypeId);
      return nodeType !== undefined && isNodeTypeRequiredByGraph(graph, nodeType, catalogRegistryRef.current)
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
    if (graph === undefined || pendingRef.current || !catalogReadyRef.current) {
      if (!catalogReadyRef.current) {
        setStatus({ message: "Catalog 尚未就绪，不能创建或复制节点。", error: true });
      }
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
    const selectionBefore = createSelectionSnapshot(activeGraphIdRef.current, selectedRef.current);
    updateSelection({
      nodeIds: nodes.map((node) => node.id).sort(compareUtf16CodeUnits),
      edgeIds: edges.map((edge) => edge.id).sort(compareUtf16CodeUnits),
    }, true, false);
    postOperations([
      ...nodes.map((node) => ({ type: "graph.addNode" as const, graphId: graph.id, node })),
      ...edges.map((edge) => ({ type: "graph.addEdge" as const, graphId: graph.id, edge })),
    ], selectionBefore);
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
      if (message.type === "requestReady") {
        webviewToken = message.webviewToken;
        vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
        // epoch 重置后全量再水化执行调试状态（§19.5 断开语义）。
        vscode.postMessage({ type: "requestGraphExecutionDebugState", requestId: nextGraphDebugRequestId() });
        return;
      }
      if (message.type === "graphExecutionInstances") {
        setDebugInstances(message.executions);
        setDebugRuntimeConnected(message.runtimeConnected);
        setDebugRuntimeInstanceId(message.runtimeInstanceId);
        return;
      }
      if (message.type === "graphExecutionSubscribed") {
        if (message.ok) {
          debugEventsRef.current = [];
          debugCursorRef.current = -1;
          debugFollowRef.current = true;
          setDebugEvents([]);
          setDebugCursor(-1);
          setDebugFollow(true);
          setDebugStopped(false);
          setDebugExecution(message.execution);
        } else {
          setStatus({ message: `执行调试订阅失败：${message.error ?? "未知错误"}`, error: true });
        }
        return;
      }
      if (message.type === "graphExecutionUnsubscribed") {
        debugEventsRef.current = [];
        debugCursorRef.current = -1;
        debugFollowRef.current = true;
        setDebugEvents([]);
        setDebugCursor(-1);
        setDebugFollow(true);
        setDebugStopped(false);
        setDebugExecution(undefined);
        setDebugFlash(undefined);
        return;
      }
      if (message.type === "graphExecutionEvents") {
        debugEventsRef.current = [...debugEventsRef.current, ...message.events];
        setDebugEvents(debugEventsRef.current);
        if (message.stopped) {
          setDebugStopped(true);
        }
        if (debugFollowRef.current) {
          applyDebugFlash(message.events);
        }
        postDebugAck(debugFollowRef.current ? "follow" : "replay");
        return;
      }
      if (message.type === "graphExecutionStopped") {
        // 实例停止：自动停在记录末尾，可从实例列表切换新实例。
        setDebugStopped(true);
        debugFollowRef.current = true;
        setDebugFollow(true);
        postDebugAck("follow");
        return;
      }
      if (message.type === "graphExecutionDebugState") {
        debugEventsRef.current = message.subscribed ? message.events : [];
        debugCursorRef.current = -1;
        debugFollowRef.current = true;
        setDebugEvents(debugEventsRef.current);
        setDebugCursor(-1);
        setDebugFollow(true);
        setDebugStopped(message.stopped);
        setDebugExecution(message.subscribed ? message.execution : undefined);
        postDebugAck("follow");
        return;
      }
      if (referenceBridge.handleMessage(message)) {
        return;
      }
      if (message.type === GRAPH_REVEAL_MESSAGE_TYPE) {
        const target = readGraphRevealTarget(message.target);
        if (typeof message.requestId !== "string" || target === undefined) {
          const result: GraphRevealResult = {
            type: GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
            requestId: typeof message.requestId === "string" ? message.requestId : "invalid",
            found: false,
            message: "Graph 定位请求无效。",
          };
          vscode.postMessage(result);
          return;
        }
        if (currentRevealRequestIdRef.current === message.requestId) {
          return;
        }
        currentRevealRequestIdRef.current = message.requestId;
        if (revealTimerRef.current !== undefined) {
          window.clearTimeout(revealTimerRef.current);
          revealTimerRef.current = undefined;
        }
        applyingRevealRequestIdRef.current = undefined;
        setRevealedElement(undefined);
        setActiveReveal(undefined);
        setPendingRevealRequest({ type: GRAPH_REVEAL_MESSAGE_TYPE, requestId: message.requestId, target });
        return;
      }
      if (message.type === "graphState") {
        if (message.documentChanged === true && message.historyAction === undefined) {
          const ownOperation = pendingSelectionHistoryRef.current !== undefined
            || lastCompletedOperationVersionRef.current === message.documentVersion;
          if (lastCompletedOperationVersionRef.current === message.documentVersion) {
            lastCompletedOperationVersionRef.current = undefined;
          }
          if (!ownOperation) {
            undoSelectionHistoryRef.current = [];
            redoSelectionHistoryRef.current = [];
          }
        }
        const restoredSelection = consumeSelectionHistory(
          message.historyAction,
          undoSelectionHistoryRef.current,
          redoSelectionHistoryRef.current,
        );
        documentRef.current = message.document;
        catalogRegistryRef.current = message.catalogRegistry;
        catalogReadyRef.current = message.catalogReady;
        documentVersionRef.current = message.documentVersion;
        if (pendingSelectionHistoryRef.current === undefined) {
          pendingRef.current = false;
          setPending(false);
        }
        const preferredGraphId = restoredSelection?.graphId ?? activeGraphIdRef.current;
        const currentGraphId = message.document.graphs.some((graph) => graph.id === preferredGraphId)
          ? preferredGraphId
          : message.document.rootGraphId;
        activeGraphIdRef.current = currentGraphId;
        setGraphDocument(message.document);
        setCatalogRegistry(message.catalogRegistry);
        setCatalogReady(message.catalogReady);
        setDocumentDirty(Boolean(message.isDirty));
        setReplacementCandidates({});
        setActiveGraphIdValue(currentGraphId);
        setInvalidDiagnostics([]);
        setContextMenu(undefined);
        if (!message.catalogReady) {
          setPicker(undefined);
          setSubgraphPickerOpen(false);
        }

        const currentGraph = message.document.graphs.find((graph) => graph.id === currentGraphId);
        const requestedSelection = restoredSelection?.selection ?? selectedRef.current;
        const nextSelection = currentGraph === undefined
          ? undefined
          : keepValidSelection(requestedSelection, currentGraph);
        updateSelection(nextSelection, true, false);
        const firstError = message.diagnostics.find((diagnostic) => diagnostic.severity === "error");
        const firstWarning = message.diagnostics.find((diagnostic) => diagnostic.severity === "warning");
        const firstDiagnostic = firstError ?? firstWarning;
        setStatus(firstDiagnostic === undefined
          ? message.catalogReady
            ? { message: "就绪", error: false }
            : { message: "Catalog 尚未就绪，已禁用依赖 Catalog 的编辑操作。", error: true }
          : { message: `${firstDiagnostic.path}: ${firstDiagnostic.message}`, error: firstError !== undefined || !message.catalogReady });
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
      if (message.type === "operationCompleted") {
        const pendingEntry = pendingSelectionHistoryRef.current;
        pendingSelectionHistoryRef.current = undefined;
        pendingRef.current = false;
        setPending(false);
        if (!message.changed) {
          // 布局为 no-op（位置未变化）时不需要 fitView。
          autoLayoutFitViewRef.current = false;
        }
        if (message.changed && pendingEntry !== undefined) {
          undoSelectionHistoryRef.current.push(pendingEntry);
          redoSelectionHistoryRef.current = [];
          lastCompletedOperationVersionRef.current = message.documentVersion;
        }
        return;
      }
      if (message.type === "graphInvalid") {
        if (message.documentChanged === true && message.historyAction === undefined) {
          const ownOperation = pendingSelectionHistoryRef.current !== undefined
            || lastCompletedOperationVersionRef.current === message.documentVersion;
          if (!ownOperation) {
            undoSelectionHistoryRef.current = [];
            redoSelectionHistoryRef.current = [];
          }
        }
        consumeSelectionHistory(
          message.historyAction,
          undoSelectionHistoryRef.current,
          redoSelectionHistoryRef.current,
        );
        documentRef.current = undefined;
        catalogReadyRef.current = false;
        documentVersionRef.current = message.documentVersion;
        pendingRef.current = false;
        autoLayoutFitViewRef.current = false;
        updateSelection(undefined, true, false);
        setGraphDocument(undefined);
        setCatalogReady(false);
        setDocumentDirty(Boolean(message.isDirty));
        setFlowNodes([]);
        setFlowEdges([]);
        setPending(false);
        setInvalidDiagnostics(message.diagnostics);
        setStatus({ message: "Graph Document 解析失败。", error: true });
        return;
      }
      if (message.type === "operationRejected") {
        const rejectedEntry = pendingSelectionHistoryRef.current;
        pendingSelectionHistoryRef.current = undefined;
        if (rejectedEntry !== undefined) {
          activeGraphIdRef.current = rejectedEntry.before.graphId;
          setActiveGraphIdValue(rejectedEntry.before.graphId);
          updateSelection(rejectedEntry.before.selection, true, false);
        }
        pendingRef.current = false;
        setPending(false);
        autoLayoutFitViewRef.current = false;
        setStatus({ message: message.message, error: true });
      }
    };
    window.addEventListener("message", receiveMessage);
    if (!handshakeProposalSentRef.current) {
      handshakeProposalSentRef.current = true;
      webviewToken = undefined;
      vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
    }
    return () => {
      window.removeEventListener("message", receiveMessage);
      if (revealTimerRef.current !== undefined) {
        window.clearTimeout(revealTimerRef.current);
      }
      if (debugFlashTimerRef.current !== undefined) {
        window.clearTimeout(debugFlashTimerRef.current);
      }
      referenceBridge.dispose();
    };
  }, [applyDebugFlash, pasteClipboardPayload, postDebugAck, updateSelection]);

  // 自动布局提交后，等下一次文档状态推送（含新坐标）再缩放到全图。
  useEffect(() => {
    if (graphDocument === undefined || !autoLayoutFitViewRef.current) {
      return;
    }
    autoLayoutFitViewRef.current = false;
    if (flowInstance !== undefined) {
      void flowInstance.fitView({ padding: 0.24, maxZoom: 1, duration: 300 });
    }
  }, [graphDocument, flowInstance]);

  useEffect(() => {
    if (pendingRevealRequest === undefined) {
      return;
    }
    if (graphDocument === undefined) {
      if (invalidDiagnostics.length === 0) {
        return;
      }
      const result: GraphRevealResult = {
        type: GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
        requestId: pendingRevealRequest.requestId,
        found: false,
        message: "Graph Document 当前无效，无法定位引用目标。",
      };
      vscode.postMessage(result);
      currentRevealRequestIdRef.current = undefined;
      setPendingRevealRequest(undefined);
      return;
    }
    const result = planGraphElementReveal(graphDocument, pendingRevealRequest.target);
    if (!result.success) {
      const response: GraphRevealResult = {
        type: GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
        requestId: pendingRevealRequest.requestId,
        found: false,
        message: result.message,
      };
      vscode.postMessage(response);
      currentRevealRequestIdRef.current = undefined;
      setStatus({ message: result.message, error: true });
      setPendingRevealRequest(undefined);
      return;
    }
    activeGraphIdRef.current = result.plan.graphId;
    setActiveGraphIdValue(result.plan.graphId);
    updateSelection(result.plan.selectedNodeId === undefined
      ? undefined
      : { nodeIds: [result.plan.selectedNodeId], edgeIds: [] }, true, false);
    setContextMenu(undefined);
    setPicker(undefined);
    setSubgraphPickerOpen(false);
    setActiveReveal({ request: pendingRevealRequest, plan: result.plan });
    setPendingRevealRequest(undefined);
  }, [graphDocument, invalidDiagnostics.length, pendingRevealRequest, updateSelection]);

  const debugCursorEffective = debugFollow ? debugEvents.length - 1 : debugCursor;
  const debugView = useMemo(
    () => computeGraphDebugView(debugEvents, debugCursorEffective),
    [debugCursorEffective, debugEvents],
  );
  const debugHighlight: GraphDebugHighlight = {
    executingNodeId: debugView.executingNodeId,
    replay: !debugFollow,
  };
  const debugEdgeInfo = useMemo(() => ({
    values: debugView.edgeValues,
    ...(debugFlash === undefined ? {} : { flashKeys: debugFlash.keys, flashNodeIds: debugFlash.nodeIds }),
  }), [debugFlash, debugView.edgeValues]);

  useEffect(() => {
    if (graphDocument === undefined || activeGraph === undefined) {
      setFlowNodes([]);
      setFlowEdges([]);
      setFlowGraphId(undefined);
      return;
    }
    const currentSelection = selectedRef.current;
    setFlowNodes(toFlowNodes(graphDocument, activeGraph, catalogRegistry, currentSelection, commitNode, postOperations, setStatus));
    setFlowEdges(activeGraph.edges.map((edge) => toFlowEdge(edge, currentSelection, graphDocument, activeGraph, catalogRegistry, debugEdgeInfo)));
    setFlowGraphId(activeGraph.id);
  }, [activeGraph, catalogRegistry, commitNode, debugEdgeInfo, graphDocument, postOperations]);

  useEffect(() => {
    if (activeReveal === undefined
      || flowInstance === undefined
      || activeGraphId !== activeReveal.plan.graphId
      || flowGraphId !== activeReveal.plan.graphId) {
      return;
    }
    if (!flowNodes.every((node) => node.data.graphId === activeReveal.plan.graphId)) {
      return;
    }
    if (activeReveal.plan.canvasNodeId !== undefined
      && !flowNodes.some((node) => node.id === activeReveal.plan.canvasNodeId)) {
      return;
    }
    if (applyingRevealRequestIdRef.current === activeReveal.request.requestId) {
      return;
    }
    applyingRevealRequestIdRef.current = activeReveal.request.requestId;
    setRevealedElement(activeReveal.plan);
    const fitOptions = activeReveal.plan.canvasNodeId === undefined
      ? { padding: 0.24, maxZoom: 1, duration: 300 }
      : {
          nodes: [{ id: activeReveal.plan.canvasNodeId }],
          padding: 0.4,
          minZoom: 0.8,
          maxZoom: 1.25,
          duration: 300,
        };
    void flowInstance.fitView(fitOptions).then(() => {
      if (currentRevealRequestIdRef.current !== activeReveal.request.requestId) {
        return;
      }
      const response: GraphRevealResult = {
        type: GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
        requestId: activeReveal.request.requestId,
        found: true,
      };
      vscode.postMessage(response);
      currentRevealRequestIdRef.current = undefined;
      applyingRevealRequestIdRef.current = undefined;
      setStatus({ message: `已定位 ${activeReveal.plan.elementKind} '${activeReveal.plan.elementId}'。`, error: false });
      setActiveReveal(undefined);
      revealTimerRef.current = window.setTimeout(() => {
        setRevealedElement((current) => current?.elementKind === activeReveal.plan.elementKind
          && current.elementId === activeReveal.plan.elementId
          && current.graphId === activeReveal.plan.graphId
          ? undefined
          : current);
        revealTimerRef.current = undefined;
      }, 2400);
    }).catch((error: unknown) => {
      if (currentRevealRequestIdRef.current !== activeReveal.request.requestId) {
        return;
      }
      const message = `无法聚焦 Graph 引用目标：${String(error)}`;
      const response: GraphRevealResult = {
        type: GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
        requestId: activeReveal.request.requestId,
        found: false,
        message,
      };
      vscode.postMessage(response);
      currentRevealRequestIdRef.current = undefined;
      applyingRevealRequestIdRef.current = undefined;
      setStatus({ message, error: true });
      setRevealedElement(undefined);
      setActiveReveal(undefined);
    });
  }, [activeGraphId, activeReveal, flowGraphId, flowInstance, flowNodes]);

  const handleNodesChange = useCallback((changes: NodeChange<GraphFlowNode>[]): void => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<GraphFlowEdge>[]): void => {
    setFlowEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const handleSelectionChange = useCallback((selection: { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] }): void => {
    const nodeIds = selection.nodes
      .filter((candidate) => candidate.data.flavor === "node")
      .map((node) => node.id)
      .sort(compareUtf16CodeUnits);
    const edgeIds = selection.edges.map((edge) => edge.id).sort(compareUtf16CodeUnits);
    updateSelection(nodeIds.length === 0 && edgeIds.length === 0 ? undefined : { nodeIds, edgeIds }, false, true);
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
      || !catalogReadyRef.current
    ) {
      return;
    }
    const registry = catalogRegistryRef.current;
    const sourcePort = findCanvasPort(currentDocument, currentGraph, registry, connection.source, connection.sourceHandle, "source");
    const targetPort = findCanvasPort(currentDocument, currentGraph, registry, connection.target, connection.targetHandle, "target");
    if (sourcePort === undefined || targetPort === undefined) {
      setStatus({ message: "无法解析连接端口。", error: true });
      return;
    }
    const plan = planConnectionCandidate(
      currentGraph,
      registry,
      { canvasNodeId: connection.source, portId: connection.sourceHandle, port: sourcePort },
      { canvasNodeId: connection.target, portId: connection.targetHandle, port: targetPort },
    );
    if (plan.issue !== undefined) {
      setStatus({ message: plan.issue, error: true });
      return;
    }
    postOperations([
      ...plan.replacementEdgeIds.map((edgeId) => ({
        type: "graph.removeEdge" as const,
        graphId: currentGraph.id,
        edgeId,
      })),
      {
        type: "graph.addEdge",
        graphId: currentGraph.id,
        edge: {
          id: newId("edge"),
          kind: sourcePort.kind,
          source: toGraphEndpoint(connection.source, connection.sourceHandle),
          target: toGraphEndpoint(connection.target, connection.targetHandle),
        },
      },
    ]);
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
      || !catalogReadyRef.current
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
      catalogRegistryRef.current,
      fromNodeId,
      fromPortId,
      fromRole,
    );
    if (fromPort === undefined) {
      return;
    }
    const capacityIssue = getConnectionCapacityIssue(
      currentGraph,
      catalogRegistryRef.current,
      { canvasNodeId: fromNodeId, portId: fromPortId, port: fromPort },
      fromRole,
    );
    if (
      capacityIssue !== undefined
      && getEffectiveMaxConnections(currentGraph, catalogRegistryRef.current, fromPort) !== 1
    ) {
      setStatus({ message: capacityIssue, error: true });
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

  const addNodeType = useCallback((nodeTypeId: string, position?: GraphPosition): void => {
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    const nodeType = catalogRegistryRef.current.nodeTypes.find(
      (candidate) => candidate.id === nodeTypeId && candidate.subgraph === undefined,
    );
    if (
      currentGraph === undefined
      || nodeType === undefined
      || !catalogReadyRef.current
      || !isNodeTypeAvailable(currentGraph, nodeType, catalogRegistryRef.current, "atomic")
    ) {
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
        position: position ?? nodePosition(),
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
    if (currentGraph === undefined || !catalogReadyRef.current) {
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
    const sourcePort = connectionPicker.fromRole === "source" ? connectionPicker.fromPort : option.port;
    const targetPort = connectionPicker.fromRole === "source" ? option.port : connectionPicker.fromPort;
    const sourceNodeId = connectionPicker.fromRole === "source" ? connectionPicker.fromNodeId : nodeId;
    const sourcePortId = connectionPicker.fromRole === "source" ? connectionPicker.fromPortId : option.port.id;
    const targetNodeId = connectionPicker.fromRole === "source" ? nodeId : connectionPicker.fromNodeId;
    const targetPortId = connectionPicker.fromRole === "source" ? option.port.id : connectionPicker.fromPortId;
    const plan = planConnectionCandidate(
      currentGraph,
      catalogRegistryRef.current,
      { canvasNodeId: sourceNodeId, portId: sourcePortId, port: sourcePort },
      { canvasNodeId: targetNodeId, portId: targetPortId, port: targetPort },
    );
    if (plan.issue !== undefined) {
      setStatus({ message: plan.issue, error: true });
      return;
    }
    const selectionBefore = createSelectionSnapshot(activeGraphIdRef.current, selectedRef.current);
    updateSelection({ nodeIds: [nodeId], edgeIds: [edgeId] }, true, false);
    postOperations([
      ...plan.replacementEdgeIds.map((replacementEdgeId) => ({
        type: "graph.removeEdge" as const,
        graphId: currentGraph.id,
        edgeId: replacementEdgeId,
      })),
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
    ], selectionBefore);
  }, [postOperations, updateSelection]);

  const addSubgraph = useCallback((graphTypeId?: string, nodeTypeId?: string, position?: GraphPosition): void => {
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    if (currentGraph === undefined || (!catalogReadyRef.current && (graphTypeId !== undefined || nodeTypeId !== undefined))) {
      return;
    }
    const subgraphId = newId("subgraph");
    const index = documentRef.current?.graphs.length ?? 1;
    const registry = catalogRegistryRef.current;
    const graphType = graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(registry, graphTypeId);
    const nodeType = nodeTypeId === undefined
      ? undefined
      : registry.nodeTypes.find((candidate) => candidate.id === nodeTypeId && candidate.subgraph !== undefined);
    const initialNodes: GraphAtomicNode[] = graphType?.initialNodes.flatMap((initialNode, initialIndex) => {
      const initialType = resolveNodeTypeDefinition(registry, initialNode.nodeTypeId);
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
        position: position ?? nodePosition(),
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
    const plan = planDeleteSelection(graph, current, catalogRegistryRef.current);
    const selectedNodes = new Set(plan.nodeIds);
    const operations: GraphOperation[] = [
      ...plan.edgeIds.flatMap((edgeId) => {
        const edge = graph.edges.find((candidate) => candidate.id === edgeId);
        const removedWithNode = edge !== undefined && (
          edge.source.kind === "node" && selectedNodes.has(edge.source.nodeId)
          || edge.target.kind === "node" && selectedNodes.has(edge.target.nodeId)
        );
        return removedWithNode ? [] : [{ type: "graph.removeEdge" as const, graphId, edgeId }];
      }),
      ...plan.nodeIds.map((nodeId) => ({ type: "graph.removeNode" as const, graphId, nodeId })),
    ];
    if (operations.length > 0) {
      const selectionBefore = createSelectionSnapshot(activeGraphIdRef.current, current);
      updateSelection(plan.retainedNodeIds.length === 0
        ? undefined
        : { nodeIds: plan.retainedNodeIds, edgeIds: [] }, true, false);
      postOperations(operations, selectionBefore);
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
    event.stopPropagation();
    const currentSelection = selectedRef.current;
    if (!currentSelection?.nodeIds.includes(node.id)) {
      updateSelection({ nodeIds: [node.id], edgeIds: [] });
    }
    setContextMenu({ kind: "node", x: event.clientX, y: event.clientY, nodeId: node.id });
    if (node.data.model.nodeTypeId !== undefined && catalogReadyRef.current) {
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

  const handleEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: GraphFlowEdge): void => {
    event.preventDefault();
    event.stopPropagation();
    const currentSelection = selectedRef.current;
    if (!currentSelection?.edgeIds.includes(edge.id)) {
      updateSelection({ nodeIds: [], edgeIds: [edge.id] });
    }
    setContextMenu({ kind: "selection", x: event.clientX, y: event.clientY });
  }, [updateSelection]);

  const handleSelectionContextMenu = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ kind: "selection", x: event.clientX, y: event.clientY });
  }, []);

  const handlePaneContextMenu = useCallback((event: MouseEvent | ReactMouseEvent): void => {
    event.preventDefault();
    const fallback = nodePosition();
    const position = flowInstance === undefined
      ? fallback
      : flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    updateSelection(undefined);
    setContextMenu({
      kind: "graph",
      x: event.clientX,
      y: event.clientY,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
    });
  }, [flowInstance, nodePosition, updateSelection]);

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
    const canonicalTypeId = resolveNodeTypeDefinition(catalogRegistryRef.current, node.nodeTypeId)?.id ?? node.nodeTypeId;
    const nodeIds = graph.nodes.flatMap((candidate) => {
      if (candidate.nodeTypeId === undefined) {
        return [];
      }
      const candidateTypeId = resolveNodeTypeDefinition(catalogRegistryRef.current, candidate.nodeTypeId)?.id ?? candidate.nodeTypeId;
      return candidateTypeId === canonicalTypeId ? [candidate.id] : [];
    });
    setContextMenu(undefined);
    updateSelection({ nodeIds, edgeIds: [] });
  }, [updateSelection]);

  const path = graphDocument === undefined ? [] : findGraphPath(graphDocument, activeGraphId);
  const pickerTypes = picker?.mode === "replace"
    ? catalogRegistry.nodeTypes.filter((nodeType) => replacementCandidates[picker.nodeId]?.includes(nodeType.id) ?? false)
    : picker?.mode === "add"
      ? catalogRegistry.nodeTypes.filter((nodeType) => activeGraph !== undefined && isNodeTypeAvailable(activeGraph, nodeType, catalogRegistry, "atomic"))
      : [];
  const connectionOptions = picker?.mode === "connect" && activeGraph !== undefined
    ? getConnectionNodeOptions(activeGraph, catalogRegistry, picker.fromPort, picker.fromRole)
    : [];
  const subgraphOptions = activeGraph === undefined ? [] : getSubgraphOptions(activeGraph, catalogRegistry);
  const availableAtomicNodeTypes = activeGraph === undefined || !catalogReady
    ? []
    : catalogRegistry.nodeTypes.filter((nodeType) => isNodeTypeAvailable(activeGraph, nodeType, catalogRegistry, "atomic"));
  const contextSelectionPayload = contextMenu?.kind === "node" || contextMenu?.kind === "selection"
    ? createClipboardPayload()
    : undefined;
  const copySelectionIssue = pending
    ? "正在应用修改"
    : contextSelectionPayload === undefined
      ? "当前选择中没有可复制的原子节点"
      : undefined;
  const duplicateSelectionIssue = copySelectionIssue ?? (!catalogReady ? "Catalog 尚未就绪" : undefined);
  const deletePlan = activeGraph === undefined || selected === undefined
    ? undefined
    : planDeleteSelection(activeGraph, selected, catalogRegistry);
  const deleteSelectionIssue = pending
    ? "正在应用修改"
    : deletePlan === undefined
      ? "当前没有选择内容"
      : deletePlan.nodeIds.length === 0 && deletePlan.edgeIds.length === 0
        ? "所选节点必须由当前 Graph Type 保留"
        : undefined;
  const deleteSelectionLabel = deletePlan !== undefined && deletePlan.retainedNodeIds.length > 0
    ? `删除可删除项（保留 ${deletePlan.retainedNodeIds.length} 个必需节点）`
    : "删除所选";
  const addNodeIssue = pending
    ? "正在应用修改"
    : !catalogReady
      ? "Catalog 尚未就绪"
      : availableAtomicNodeTypes.length === 0
        ? "当前 Graph Type 没有可用的节点类型"
        : undefined;
  const addSubgraphIssue = pending
    ? "正在应用修改"
    : catalogRegistry.graphTypes.length > 0 && !catalogReady
      ? "Catalog 尚未就绪"
      : catalogRegistry.graphTypes.length > 0 && subgraphOptions.length === 0
        ? "当前 Graph Type 没有可用的子图类型"
        : undefined;
  const pasteIssue = pending ? "正在应用修改" : !catalogReady ? "Catalog 尚未就绪" : undefined;
  const saveState = pending
    ? { kind: "pending", label: "修改中…", title: "正在应用 Graph 修改" }
    : documentDirty === undefined
      ? { kind: "pending", label: "读取状态…", title: "正在读取文档保存状态" }
      : documentDirty
        ? { kind: "dirty", label: "未保存", title: "文档包含尚未保存到磁盘的修改" }
        : { kind: "saved", label: "已保存", title: "文档内容已保存到磁盘" };

  return (
    <GraphDataTypesContext.Provider value={catalogRegistry.dataTypes}>
      <EditorShell className="graph-app" data-vb-property-density="compact" onClick={() => setContextMenu(undefined)}>
      <EditorToolbar className="graph-toolbar">
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
        <button
          type="button"
          className="secondary"
          title="对当前图执行自动布局（按连线方向分层，使用节点实际尺寸重排位置）"
          disabled={pending || graphDocument === undefined || activeGraphId === ""}
          onClick={applyAutoLayout}
        >
          自动布局
        </button>
        <button
          type="button"
          className={`secondary${debugDrawerOpen ? " active" : ""}`}
          title="打开执行调试面板（观察当前图的运行时执行实例）"
          onClick={() => setDebugDrawerOpen((open) => !open)}
        >
          执行调试
        </button>
        <ToolbarSpacer />
        <SaveState
          dirty={saveState.kind === "dirty"}
          pending={saveState.kind === "pending"}
          savedLabel={saveState.label}
          dirtyLabel={saveState.label}
          pendingLabel={saveState.label}
          title={saveState.title}
        />
        <span className="graph-metadata" title={rootMetadata.relativePath}>
          {rootMetadata.projectId} · {rootMetadata.documentType} · {rootMetadata.relativePath}
        </span>
      </EditorToolbar>

      {graphDocument === undefined
        ? invalidDiagnostics.length > 0
          ? <InvalidDocument diagnostics={invalidDiagnostics} />
          : <LoadingDocument />
        : activeGraph === undefined
          ? <InvalidDocument diagnostics={[{ severity: "error", code: "graph.missingActiveGraph", path: "graphs", message: "当前子图不存在。" }]} />
          : (
            <SplitWorkspace className={`graph-content${inspectorCollapsed ? " inspector-collapsed" : ""}`}>
              <div
                ref={canvasRef}
                className={`graph-canvas${revealedElement?.elementKind === "graph" && revealedElement.graphId === activeGraph.id ? " revealed" : ""}`}
              >
                <GraphPendingContext.Provider value={pending}>
                  <GraphNodeTypeVisibilityContext.Provider value={showNodeTypes}>
                    <GraphNodeIdVisibilityContext.Provider value={showNodeIds}>
                      <GraphRevealContext.Provider value={revealedElement}>
                        <GraphDebugContext.Provider value={debugHighlight}>
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
                          onEdgeContextMenu={handleEdgeContextMenu}
                          onSelectionContextMenu={handleSelectionContextMenu}
                          onPaneContextMenu={handlePaneContextMenu}
                          onNodeDoubleClick={(_, node) => openSubgraph(node.id)}
                          onPaneClick={() => setContextMenu(undefined)}
                          onInit={setFlowInstance}
                          nodesDraggable={!pending}
                          nodesConnectable={!pending && catalogReady}
                          elementsSelectable={!pending}
                          selectionOnDrag
                          selectionMode={SelectionMode.Partial}
                          panOnDrag={[1]}
                          panActivationKeyCode={null}
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
                        </GraphDebugContext.Provider>
                      </GraphRevealContext.Provider>
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
                    catalogRegistry={catalogRegistry}
                    catalogReady={catalogReady}
                    pending={pending}
                    postOperations={postOperations}
                    reportStatus={setStatus}
                  />
                )}
              </aside>
              {debugDrawerOpen && (
                <GraphDebugPanel
                  runtimeConnected={debugRuntimeConnected}
                  runtimeInstanceId={debugRuntimeInstanceId}
                  instances={debugInstances}
                  execution={debugExecution}
                  events={debugEvents}
                  stopped={debugStopped}
                  follow={debugFollow}
                  cursor={debugCursorEffective}
                  executingNodeId={debugView.executingNodeId}
                  onRefresh={requestDebugInstances}
                  onSubscribe={subscribeDebugExecution}
                  onUnsubscribe={unsubscribeDebugExecution}
                  onCursorChange={enterDebugReplay}
                  onFollow={enterDebugFollow}
                />
              )}
            </SplitWorkspace>
          )}

      {contextMenu?.kind === "node" && activeGraph !== undefined && (() => {
        const node = activeGraph.nodes.find((candidate) => candidate.id === contextMenu.nodeId);
        const candidates = replacementCandidates[contextMenu.nodeId];
        const selectSameTypeIssue = pending
          ? "正在应用修改"
          : node?.nodeTypeId === undefined
            ? "节点没有可识别的类型"
            : undefined;
        const replaceNodeIssue = pending
          ? "正在应用修改"
          : node?.nodeTypeId === undefined
            ? "节点没有可替换的类型"
            : !catalogReady
              ? "Catalog 尚未就绪"
              : candidates === undefined
                ? "正在检查兼容类型"
                : candidates.length === 0
                  ? "没有兼容的节点类型"
                  : undefined;
        return (
          <div className="graph-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              disabled={selectSameTypeIssue !== undefined}
              title={selectSameTypeIssue}
              onClick={() => node !== undefined && selectSameType(node.id)}
            >
              选择同类型节点
            </button>
            <button
              type="button"
              disabled={replaceNodeIssue !== undefined}
              title={replaceNodeIssue}
              onClick={() => {
                if (node !== undefined) {
                  setContextMenu(undefined);
                  setPicker({ mode: "replace", nodeId: node.id });
                }
              }}
            >
              替换节点类型…
            </button>
            {node?.kind === "subgraph" && <button type="button" onClick={() => openSubgraph(node.id)}>打开子图</button>}
            <div className="graph-context-menu-separator" role="separator" />
            <SelectionContextActions
              copyIssue={copySelectionIssue}
              duplicateIssue={duplicateSelectionIssue}
              deleteIssue={deleteSelectionIssue}
              deleteLabel={deleteSelectionLabel}
              onCopy={() => { setContextMenu(undefined); copySelection(); }}
              onDuplicate={() => { setContextMenu(undefined); duplicateSelection(); }}
              onDelete={() => { setContextMenu(undefined); deleteSelection(); }}
            />
          </div>
        );
      })()}

      {contextMenu?.kind === "selection" && activeGraph !== undefined && (
        <div className="graph-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          <SelectionContextActions
            copyIssue={copySelectionIssue}
            duplicateIssue={duplicateSelectionIssue}
            deleteIssue={deleteSelectionIssue}
            deleteLabel={deleteSelectionLabel}
            onCopy={() => { setContextMenu(undefined); copySelection(); }}
            onDuplicate={() => { setContextMenu(undefined); duplicateSelection(); }}
            onDelete={() => { setContextMenu(undefined); deleteSelection(); }}
          />
        </div>
      )}

      {contextMenu?.kind === "graph" && activeGraph !== undefined && (
        <div className="graph-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            disabled={addNodeIssue !== undefined}
            title={addNodeIssue}
            onClick={() => {
              const position = contextMenu.position;
              setContextMenu(undefined);
              setPicker({ mode: "add", position });
            }}
          >
            添加节点…
          </button>
          <button
            type="button"
            disabled={addSubgraphIssue !== undefined}
            title={addSubgraphIssue}
            onClick={() => {
              const position = contextMenu.position;
              setContextMenu(undefined);
              if (catalogRegistry.graphTypes.length === 0) {
                addSubgraph(undefined, undefined, position);
              } else {
                setSubgraphPosition(position);
                setSubgraphPickerOpen(true);
              }
            }}
          >
            添加子图…
          </button>
          <button
            type="button"
            disabled={pasteIssue !== undefined}
            title={pasteIssue}
            onClick={() => {
              setContextMenu(undefined);
              vscode.postMessage({ type: "readClipboard" });
            }}
          >
            粘贴
          </button>
        </div>
      )}

      {picker !== undefined && picker.mode !== "connect" && (
        <NodeTypePicker
          title={picker.mode === "replace" ? "替换节点类型" : "添加节点"}
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
              addNodeType(nodeTypeId, picker.position);
            }
          }}
        />
      )}

      {picker?.mode === "connect" && (
        <ConnectionNodePicker
          options={connectionOptions}
          onCancel={() => setPicker(undefined)}
          onSelect={(option) => addConnectedNode(picker, option)}
        />
      )}

      {subgraphPickerOpen && (
        <SubgraphTypePicker
          options={subgraphOptions}
          onCancel={() => {
            setSubgraphPickerOpen(false);
            setSubgraphPosition(undefined);
          }}
          onSelect={(graphTypeId, nodeTypeId) => addSubgraph(graphTypeId, nodeTypeId, subgraphPosition)}
        />
      )}

        <EditorStatusBar className="graph-status" error={status.error}><span>{status.message}</span></EditorStatusBar>
      </EditorShell>
    </GraphDataTypesContext.Provider>
  );
}

function withWebviewToken(message: unknown, token: string | undefined): unknown {
  return token === undefined || typeof message !== "object" || message === null || Array.isArray(message)
    ? message
    : { ...message, webviewToken: token };
}

function nextGraphDebugRequestId(): string {
  return `graph-debug-${++graphDebugRequestIdCounter}`;
}

const GRAPH_DEBUG_EXECUTING_KINDS = new Set(["nodeStart", "nodeOutput", "dataNode", "edgeValueChanged"]);

/** 从事件前缀（0..cursor）推导当前执行节点与数据边最近值（§19.5 实时态/回放态共用）。 */
function computeGraphDebugView(
  events: readonly GraphDebugEvent[],
  cursor: number,
): { readonly executingNodeId: string | null; readonly edgeValues: ReadonlyMap<string, string> } {
  const limit = Math.min(cursor, events.length - 1);
  let executingNodeId: string | null = null;
  const edgeValues = new Map<string, string>();
  for (let index = 0; index <= limit; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (GRAPH_DEBUG_EXECUTING_KINDS.has(event.kind) && event.nodeId !== undefined) {
      executingNodeId = event.nodeId;
    }
    if (event.kind === "edgeValueChanged" && event.nodeId !== undefined && event.outputIndex !== undefined) {
      edgeValues.set(`${event.nodeId}:${event.outputIndex}`, event.value ?? "");
    }
  }
  return { executingNodeId, edgeValues };
}

/** 连续同帧切片起点序列（帧级步进单位；到达顺序，不重排）。 */
function graphDebugFrameStarts(events: readonly GraphDebugEvent[]): readonly number[] {
  const starts: number[] = [];
  let index = 0;
  while (index < events.length) {
    starts.push(index);
    const frameIndex = events[index]?.frameIndex;
    index += 1;
    while (index < events.length && events[index]?.frameIndex === frameIndex) {
      index += 1;
    }
  }
  return starts;
}

function graphDebugFramePosition(starts: readonly number[], cursor: number): number {
  let position = -1;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined || start > cursor) {
      break;
    }
    position = index;
  }
  return position;
}

function previousGraphDebugFrameStart(events: readonly GraphDebugEvent[], cursor: number): number | undefined {
  const starts = graphDebugFrameStarts(events);
  const position = graphDebugFramePosition(starts, cursor);
  return position > 0 ? starts[position - 1] : undefined;
}

function nextGraphDebugFrameStart(events: readonly GraphDebugEvent[], cursor: number): number | undefined {
  const starts = graphDebugFrameStarts(events);
  const position = graphDebugFramePosition(starts, cursor);
  return position >= 0 && position + 1 < starts.length ? starts[position + 1] : undefined;
}

function GraphDebugPanel({
  runtimeConnected,
  runtimeInstanceId,
  instances,
  execution,
  events,
  stopped,
  follow,
  cursor,
  executingNodeId,
  onRefresh,
  onSubscribe,
  onUnsubscribe,
  onCursorChange,
  onFollow,
}: {
  readonly runtimeConnected: boolean;
  readonly runtimeInstanceId?: string | undefined;
  readonly instances: readonly GraphDebugExecution[];
  readonly execution?: GraphDebugExecution | undefined;
  readonly events: readonly GraphDebugEvent[];
  readonly stopped: boolean;
  readonly follow: boolean;
  readonly cursor: number;
  readonly executingNodeId: string | null;
  readonly onRefresh: () => void;
  readonly onSubscribe: (executionId: string) => void;
  readonly onUnsubscribe: () => void;
  readonly onCursorChange: (cursor: number) => void;
  readonly onFollow: () => void;
}): React.JSX.Element {
  const lastEvent = cursor >= 0 ? events[cursor] : undefined;
  const maxCursor = Math.max(0, events.length - 1);
  const stepTo = (next: number): void => onCursorChange(Math.max(0, Math.min(maxCursor, next)));
  return (
    <section className="graph-debug-panel" aria-label="执行调试">
      <header className="graph-debug-panel-header">
        <span className="graph-debug-panel-title">执行调试</span>
        <span className={`graph-debug-runtime${runtimeConnected ? " connected" : ""}`}>
          {runtimeConnected ? `运行时：${runtimeInstanceId ?? "已连接"}` : "未发现运行时实例"}
        </span>
        <button type="button" className="secondary" onClick={onRefresh}>刷新</button>
      </header>
      {execution === undefined ? (
        <div className="graph-debug-section">
          <div className="graph-debug-section-title">实例列表</div>
          {instances.length === 0
            ? <div className="graph-debug-empty">当前图暂无执行实例</div>
            : instances.map((instance) => (
              <div key={instance.executionId} className="graph-debug-instance">
                <span className="graph-debug-instance-key" title={instance.executionId}>
                  {instance.debugKey || instance.executionId}
                </span>
                <span className="graph-debug-instance-state">{instance.state}</span>
                <span className="graph-debug-instance-node" title="当前节点">
                  {instance.currentNodeId ?? "—"}
                </span>
                <span className="graph-debug-instance-frame">帧 {instance.frameIndex}</span>
                <button
                  type="button"
                  className="secondary"
                  disabled={instance.state !== "running"}
                  onClick={() => onSubscribe(instance.executionId)}
                >
                  跟踪
                </button>
              </div>
            ))}
        </div>
      ) : (
        <div className="graph-debug-section">
          <div className="graph-debug-section-title">
            跟踪中 · {execution.graphName || execution.executionId}
            {execution.debugKey.length > 0 ? ` · ${execution.debugKey}` : ""}
          </div>
          <div className="graph-debug-stats">
            <span title="当前执行节点">当前节点：{executingNodeId ?? "—"}</span>
            <span title="当前事件帧号">帧 {lastEvent?.frameIndex ?? execution.frameIndex}</span>
            <span title="会话事件数">事件 {events.length}</span>
            {stopped && <span className="graph-debug-stopped">实例已停止</span>}
          </div>
          <button type="button" className="danger full" onClick={onUnsubscribe}>停止调试</button>
          {stopped && (
            <div className="graph-debug-switch">
              <span>实例已停止，可切换新实例：</span>
              <div className="graph-debug-instance-list">
                {instances.map((instance) => (
                  <button
                    key={instance.executionId}
                    type="button"
                    className="secondary"
                    disabled={instance.state !== "running"}
                    onClick={() => onSubscribe(instance.executionId)}
                  >
                    {instance.debugKey || instance.executionId}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {execution !== undefined && events.length > 0 && (
        <div className="graph-debug-section">
          <div className="graph-debug-section-title">
            时间轴 {follow ? "（实时）" : "（回放）"}
          </div>
          <input
            type="range"
            min={0}
            max={maxCursor}
            value={Math.max(0, cursor)}
            aria-label="执行事件时间轴"
            onChange={(event) => onCursorChange(Number(event.target.value))}
          />
          <div className="graph-debug-steps">
            <button
              type="button"
              className="secondary"
              title="上一帧"
              onClick={() => stepTo(previousGraphDebugFrameStart(events, cursor) ?? 0)}
            >
              ⏮上一帧
            </button>
            <button
              type="button"
              className="secondary"
              title="上一事件"
              onClick={() => stepTo(cursor - 1)}
            >
              ◀上一事件
            </button>
            <button
              type="button"
              className="secondary"
              title="下一事件"
              onClick={() => stepTo(cursor + 1)}
            >
              ▶下一事件
            </button>
            <button
              type="button"
              className="secondary"
              title="下一帧"
              onClick={() => stepTo(nextGraphDebugFrameStart(events, cursor) ?? maxCursor)}
            >
              ⏭下一帧
            </button>
            <button
              type="button"
              className="secondary"
              disabled={follow}
              onClick={onFollow}
            >
              回到实时
            </button>
          </div>
          <div className="graph-debug-event">
            {lastEvent === undefined
              ? "暂无事件"
              : `${lastEvent.kind}${lastEvent.nodeId === undefined ? "" : ` · ${lastEvent.nodeId}`} · 帧 ${lastEvent.frameIndex}${lastEvent.value === undefined ? "" : ` · ${lastEvent.value}`}`}
          </div>
        </div>
      )}
    </section>
  );
}

function GraphInspector({
  graph,
  isRoot,
  catalogRegistry,
  catalogReady,
  pending,
  postOperations,
  reportStatus,
}: {
  readonly graph: GraphDefinition;
  readonly isRoot: boolean;
  readonly catalogRegistry: GraphCatalogRegistry;
  readonly catalogReady: boolean;
  readonly pending: boolean;
  readonly postOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(graph.title);
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  const assignableTypes = catalogRegistry.graphTypes.filter((candidate) => candidate.usage === "any" || candidate.usage === (isRoot ? "root" : "subgraph"));
  const [selectedGraphTypeId, setSelectedGraphTypeId] = useState(assignableTypes[0]?.id ?? "");
  useEffect(() => setTitle(graph.title), [graph.title]);
  useEffect(() => {
    setSelectedGraphTypeId((current) => assignableTypes.some((candidate) => candidate.id === current)
      ? current
      : assignableTypes[0]?.id ?? "");
  }, [catalogRegistry, isRoot]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    postOperations([{ type: "graph.updateGraph", graphId: graph.id, title, properties: graph.properties }]);
  };
  const propertyNodeType: NodeTypeDefinition = {
    catalogId: graphType?.catalogId ?? "untyped",
    catalogTitle: graphType?.catalogTitle ?? "Graph",
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
    connectedInputPortIds: new Set(),
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
    const nextType = resolveGraphTypeDefinition(catalogRegistry, selectedGraphTypeId);
    if (nextType === undefined || !catalogReady) {
      return;
    }
    const initialOperations: GraphOperation[] = nextType.initialNodes.flatMap((initialNode, index) => {
      const nodeType = resolveNodeTypeDefinition(catalogRegistry, initialNode.nodeTypeId);
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
    <aside className="graph-inspector" data-vb-property-density="sidebar">
      <h2>Graph Inspector</h2>
      <PropertySection title="标识">
        <ReadonlyField label="Graph ID" value={graph.id} />
        {graphType !== undefined
          ? <ReadonlyField label="Graph Type" value={`${graphType.title} · ${graphType.id}`} />
          : graph.graphTypeId !== undefined
            ? <ReadonlyField label="Graph Type" value={`Unknown · ${graph.graphTypeId}`} />
            : (
              <section className="graph-assign-type">
                <label className="graph-field">
                  <span>Graph Type</span>
                  <select value={selectedGraphTypeId} disabled={!catalogReady} onChange={(event) => setSelectedGraphTypeId(event.target.value)}>
                    {assignableTypes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.catalogTitle} / {candidate.title}</option>)}
                  </select>
                </label>
                <button type="button" disabled={pending || !catalogReady || graph.nodes.length > 0 || selectedGraphTypeId.length === 0} onClick={assignType}>设置 Graph Type</button>
                {!catalogReady && <p className="graph-empty">Catalog 尚未就绪，不能设置 Graph Type。</p>}
                {graph.nodes.length > 0 && <p className="graph-empty">已有节点的旧 Graph 需要后续安全迁移，不能直接设置类型。</p>}
              </section>
            )}
      </PropertySection>
      <PropertySection title="名称">
        <form onSubmit={submit}>
          <InputField label="名称" value={title} onChange={setTitle} />
          <button type="submit" disabled={pending || title === graph.title}>应用名称修改</button>
        </form>
      </PropertySection>
      <PropertySection title="Graph 属性">
        <InlineNodeProperties data={propertyData} pending={pending} />
      </PropertySection>
    </aside>
  );
}

function NodeTypePicker({
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

function ConnectionNodePicker({
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

function SubgraphTypePicker({
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
        <input autoFocus placeholder="搜索 Graph Type 或调用节点类型…" value={query} onChange={(event) => setQuery(event.target.value)} />
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
  catalogRegistry: GraphCatalogRegistry,
  selected: Selection | undefined,
  commitNode: GraphNodeData["commitNode"],
  commitOperations: GraphNodeData["commitOperations"],
  reportStatus: GraphNodeData["reportStatus"],
): GraphFlowNode[] {
  const nodes: GraphFlowNode[] = graph.nodes.map((node) => {
    const nodeType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
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
        connectedInputPortIds: connectedNodeInputPorts(document, graph, node, nodeType),
        commitNode,
        commitOperations,
        reportStatus,
      },
      selected: selected?.nodeIds.includes(node.id) ?? false,
    };
  });
  const inputs = graph.interfacePorts.filter((port) => port.direction === "input");
  const outputs = graph.interfacePorts.filter((port) => port.direction === "output");
  const editableInterfaces = graph.id !== document.rootGraphId;
  const maxX = Math.max(400, ...graph.nodes.map((node) => node.position.x));
  if (inputs.length > 0 || editableInterfaces) {
    nodes.push({
      id: INTERFACE_INPUT_NODE_ID,
      type: "visualBridgeInterface",
      position: { x: -100, y: 40 },
      draggable: false,
      selectable: false,
      data: {
        flavor: "interface",
        graphId: graph.id,
        title: editableInterfaces ? "输入参数" : "Graph Inputs",
        side: "inputs",
        ports: inputs,
        interfacePortIds: graph.interfacePorts.map((port) => port.id),
        editable: editableInterfaces,
        commitOperations,
        reportStatus,
      },
    });
  }
  if (outputs.length > 0 || editableInterfaces) {
    nodes.push({
      id: INTERFACE_OUTPUT_NODE_ID,
      type: "visualBridgeInterface",
      position: { x: maxX + 300, y: 40 },
      draggable: false,
      selectable: false,
      data: {
        flavor: "interface",
        graphId: graph.id,
        title: editableInterfaces ? "输出参数" : "Graph Outputs",
        side: "outputs",
        ports: outputs,
        interfacePortIds: graph.interfacePorts.map((port) => port.id),
        editable: editableInterfaces,
        commitOperations,
        reportStatus,
      },
    });
  }
  return nodes;
}

interface GraphDebugEdgeInfo {
  readonly values: ReadonlyMap<string, string>;
  readonly flashKeys?: ReadonlySet<string>;
  readonly flashNodeIds?: ReadonlySet<string>;
}

function toFlowEdge(
  edge: GraphEdgeModel,
  selected: Selection | undefined,
  document: GraphDocument,
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  debug?: GraphDebugEdgeInfo,
): GraphFlowEdge {
  const sourceCanvasNodeId = edge.source.kind === "node" ? edge.source.nodeId : INTERFACE_INPUT_NODE_ID;
  const sourcePort = findCanvasPort(
    document,
    graph,
    catalogRegistry,
    sourceCanvasNodeId,
    edge.source.portId,
    "source",
  );
  const dataColor = edge.kind === "data"
    ? resolveGraphDataTypeColor(sourcePort?.dataTypeId, catalogRegistry.dataTypes)
    : undefined;
  // 执行调试：数据边最近值标签 + 刚经过边的流光；端口序映射不可靠时退化为按源节点点亮。
  let label: string | undefined;
  let edgeClassName = `graph-edge-${edge.kind}`;
  if (debug !== undefined && edge.source.kind === "node") {
    const sourceNodeId = edge.source.nodeId;
    const node = graph.nodes.find((candidate) => candidate.id === sourceNodeId);
    if (node !== undefined) {
      const nodeType = node.nodeTypeId === undefined
        ? undefined
        : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
      const dataOutputs = portsForNode(document, graph, node, nodeType)
        .filter((port) => port.kind === "data" && port.direction === "output");
      const canonicalPortId = canonicalCanvasPortId(edge.source, graph, catalogRegistry);
      const outputIndex = dataOutputs.findIndex((port) => port.id === canonicalPortId);
      if (outputIndex >= 0) {
        const key = `${sourceNodeId}:${outputIndex}`;
        if (edge.kind === "data") {
          label = debug.values.get(key);
        }
        if (debug.flashKeys?.has(key) === true) {
          edgeClassName += " graph-edge-active";
        }
      }
      if (debug.flashNodeIds?.has(sourceNodeId) === true) {
        edgeClassName += " graph-edge-active";
      }
    }
  }
  return {
    id: edge.id,
    type: "default",
    source: sourceCanvasNodeId,
    sourceHandle: canonicalCanvasPortId(edge.source, graph, catalogRegistry),
    target: edge.target.kind === "node" ? edge.target.nodeId : INTERFACE_OUTPUT_NODE_ID,
    targetHandle: canonicalCanvasPortId(edge.target, graph, catalogRegistry),
    data: { model: edge },
    className: edgeClassName,
    ...(label === undefined ? {} : { label }),
    ...(dataColor === undefined ? {} : { style: { stroke: dataColor } }),
    markerEnd: { type: MarkerType.ArrowClosed, ...(dataColor === undefined ? {} : { color: dataColor }) },
    selected: selected?.edgeIds.includes(edge.id) ?? false,
  };
}

function canonicalCanvasPortId(
  endpoint: GraphEndpoint,
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
): string {
  if (endpoint.kind === "interface") {
    return endpoint.portId;
  }
  const node = graph.nodes.find((candidate) => candidate.id === endpoint.nodeId);
  if (node?.nodeTypeId === undefined) {
    return endpoint.portId;
  }
  const nodeType = resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
  const staticPortId = nodeType?.ports.find(
    (port) => port.id === endpoint.portId || (port.aliases?.includes(endpoint.portId) ?? false),
  )?.id;
  if (staticPortId !== undefined) {
    return staticPortId;
  }
  return nodeType?.dynamicPortGroups?.find((group) =>
    group.listPortMode === "list"
    && (group.id === endpoint.portId || group.aliases.includes(endpoint.portId)),
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
    ...(nodeType.dynamicPortGroups ?? []).flatMap((group) => group.listPortMode === "list"
      ? [{
          id: group.id,
          aliases: group.aliases,
          title: group.title,
          kind: group.port.kind,
          direction: group.port.direction,
          ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
          ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
        }]
      : []),
    ...node.dynamicPorts.flatMap((dynamicPort) => {
      const group = resolveDynamicPortGroupDefinition(nodeType, dynamicPort.groupId);
      return group === undefined || group.listPortMode === "list"
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

function connectedNodeInputPorts(
  document: GraphDocument,
  graph: GraphDefinition,
  node: GraphNodeModel,
  nodeType: NodeTypeDefinition | undefined,
): ReadonlySet<string> {
  const ports = portsForNode(document, graph, node, nodeType);
  const result = new Set<string>();
  graph.edges.forEach((edge) => {
    if (edge.target.kind !== "node" || edge.target.nodeId !== node.id) {
      return;
    }
    const port = ports.find((candidate) =>
      candidate.id === edge.target.portId || (candidate.aliases?.includes(edge.target.portId) ?? false),
    );
    if (port?.direction === "input") {
      result.add(port.id);
    }
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
  catalogRegistry: GraphCatalogRegistry,
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
    return port === undefined ? undefined : { ...port, direction: "input", maxConnections: 1 };
  }
  const node = graph.nodes.find((candidate) => candidate.id === canvasNodeId);
  if (node === undefined) {
    return undefined;
  }
  const nodeType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
  return portsForNode(document, graph, node, nodeType).find(
    (port) => port.id === portId || (port.aliases?.includes(portId) ?? false),
  );
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

function createSelectionSnapshot(graphId: string, selection: Selection | undefined): SelectionSnapshot {
  return {
    graphId,
    selection: selection === undefined
      ? undefined
      : { nodeIds: [...selection.nodeIds], edgeIds: [...selection.edgeIds] },
  };
}

function consumeSelectionHistory(
  action: "undo" | "redo" | undefined,
  undoStack: SelectionHistoryEntry[],
  redoStack: SelectionHistoryEntry[],
): SelectionSnapshot | undefined {
  if (action === "undo") {
    const entry = undoStack.pop();
    if (entry !== undefined) {
      redoStack.push(entry);
      return entry.before;
    }
  }
  if (action === "redo") {
    const entry = redoStack.pop();
    if (entry !== undefined) {
      undoStack.push(entry);
      return entry.after;
    }
  }
  return undefined;
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
  return createDefaultFieldProperties(nodeType.properties);
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
  return createDefaultFieldProperties(graphType.properties);
}

function resolveNodeTypeDefinition(registry: GraphCatalogRegistry, nodeTypeId: string): NodeTypeDefinition | undefined {
  return registry.nodeTypes.find((nodeType) => nodeType.id === nodeTypeId || nodeType.aliases.includes(nodeTypeId));
}

function resolveGraphTypeDefinition(registry: GraphCatalogRegistry, graphTypeId: string): GraphTypeDefinition | undefined {
  return registry.graphTypes.find((graphType) => graphType.id === graphTypeId || graphType.aliases.includes(graphTypeId));
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
  catalogRegistry: GraphCatalogRegistry,
  flavor: "atomic" | "subgraph",
): boolean {
  if ((flavor === "atomic") === (nodeType.subgraph !== undefined)) {
    return false;
  }
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  if (graphType !== undefined && !graphType.supportedCatalogIds.includes(nodeType.catalogId)) {
    return false;
  }
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
      const currentType = node.nodeTypeId === undefined ? undefined : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
      return currentType !== undefined && matchesNodeSelectorDefinition(currentType, constraint.selector);
    }).length;
    return count < constraint.maxInstances;
  }) ?? true;
}

function isNodeTypeRequiredByGraph(
  graph: GraphDefinition,
  nodeType: NodeTypeDefinition,
  catalogRegistry: GraphCatalogRegistry,
): boolean {
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  return graphType?.nodeConstraints.some((constraint) =>
    (constraint.minInstances ?? 0) > 0
    && constraint.maxInstances === 1
    && matchesNodeSelectorDefinition(nodeType, constraint.selector),
  ) ?? false;
}

function planDeleteSelection(
  graph: GraphDefinition,
  selection: Selection,
  catalogRegistry: GraphCatalogRegistry,
): DeleteSelectionPlan {
  const selectedNodeIds = new Set(selection.nodeIds);
  const selectedEdgeIds = new Set(selection.edgeIds);
  const graphType = graph.graphTypeId === undefined
    ? undefined
    : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  const constrainedCounts = (graphType?.nodeConstraints ?? []).flatMap((constraint) => {
    const minimum = constraint.minInstances ?? 0;
    return minimum === 0 ? [] : [{
      constraint,
      minimum,
      remaining: graph.nodes.filter((node) => {
        const nodeType = node.nodeTypeId === undefined
          ? undefined
          : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
        return nodeType !== undefined && matchesNodeSelectorDefinition(nodeType, constraint.selector);
      }).length,
    }];
  });
  const nodeIds: string[] = [];
  const retainedNodeIds: string[] = [];
  for (const node of graph.nodes) {
    if (!selectedNodeIds.has(node.id)) {
      continue;
    }
    const nodeType = node.nodeTypeId === undefined
      ? undefined
      : resolveNodeTypeDefinition(catalogRegistry, node.nodeTypeId);
    const matchingConstraints = nodeType === undefined
      ? []
      : constrainedCounts.filter(({ constraint }) => matchesNodeSelectorDefinition(nodeType, constraint.selector));
    if (matchingConstraints.some(({ minimum, remaining }) => remaining <= minimum)) {
      retainedNodeIds.push(node.id);
      continue;
    }
    nodeIds.push(node.id);
    matchingConstraints.forEach((count) => {
      count.remaining -= 1;
    });
  }
  return {
    nodeIds,
    edgeIds: graph.edges.filter((edge) => selectedEdgeIds.has(edge.id)).map((edge) => edge.id),
    retainedNodeIds,
  };
}

function getConnectionNodeOptions(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  fromPort: PortDefinition,
  fromRole: "source" | "target",
): readonly ConnectionNodeOption[] {
  const requiredDirection: PortDirection = fromRole === "source" ? "input" : "output";
  return catalogRegistry.nodeTypes.flatMap((nodeType) => {
    if (!isNodeTypeAvailable(graph, nodeType, catalogRegistry, "atomic")) {
      return [];
    }
    const creationPorts: readonly PortDefinition[] = [
      ...nodeType.ports,
      ...(nodeType.dynamicPortGroups ?? []).flatMap((group) => group.listPortMode === "list"
        ? [{
            id: group.id,
            aliases: group.aliases,
            title: group.title,
            kind: group.port.kind,
            direction: group.port.direction,
            ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
            ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
          }]
        : []),
    ];
    return creationPorts.flatMap((port) => {
      if (port.direction !== requiredDirection || port.kind !== fromPort.kind) {
        return [];
      }
      const sourcePort = fromRole === "source" ? fromPort : port;
      const targetPort = fromRole === "source" ? port : fromPort;
      return arePortsCompatible(catalogRegistry, sourcePort, targetPort) ? [{ nodeType, port }] : [];
    });
  // Localized title collation is UI-only; the selected IDs remain the semantic payload.
  }).sort((left, right) =>
    left.nodeType.title.localeCompare(right.nodeType.title)
    || left.port.title.localeCompare(right.port.title),
  );
}

function arePortsCompatible(
  catalogRegistry: GraphCatalogRegistry,
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
  const targetDataType = catalogRegistry.dataTypes.find(
    (dataType) => dataType.id === targetPort.dataTypeId,
  );
  return targetDataType?.acceptsAnySource === true
    || targetDataType?.accepts.includes(sourcePort.dataTypeId) === true;
}

function planConnectionCandidate(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  source: ConnectionCandidateEndpoint,
  target: ConnectionCandidateEndpoint,
): ConnectionPlan {
  if (!arePortsCompatible(catalogRegistry, source.port, target.port)) {
    return {
      replacementEdgeIds: [],
      issue: source.port.kind !== target.port.kind
        ? "流程端口和数据端口不能互相连接。"
        : source.port.kind === "data"
          ? `数据类型“${source.port.dataTypeId ?? "any"}”不能连接到“${target.port.dataTypeId ?? "any"}”。`
          : "端口方向不兼容。",
    };
  }
  const sourceEndpoint = toGraphEndpoint(source.canvasNodeId, source.portId);
  const targetEndpoint = toGraphEndpoint(target.canvasNodeId, target.portId);
  if (graph.edges.some((edge) =>
    endpointsEquivalent(edge.source, sourceEndpoint, graph, catalogRegistry)
    && endpointsEquivalent(edge.target, targetEndpoint, graph, catalogRegistry),
  )) {
    return { replacementEdgeIds: [], issue: "这两个端口之间已经存在连接。" };
  }
  const replacementEdgeIds = new Set([
    ...getReplaceableConnectionEdgeIds(graph, catalogRegistry, source, "source"),
    ...getReplaceableConnectionEdgeIds(graph, catalogRegistry, target, "target"),
  ]);
  const issue = getConnectionCapacityIssue(graph, catalogRegistry, source, "source", replacementEdgeIds)
    ?? getConnectionCapacityIssue(graph, catalogRegistry, target, "target", replacementEdgeIds);
  return {
    replacementEdgeIds: [...replacementEdgeIds].sort(compareUtf16CodeUnits),
    ...(issue === undefined ? {} : { issue }),
  };
}

function endpointsEquivalent(
  left: GraphEndpoint,
  right: GraphEndpoint,
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "node" && right.kind === "node" && left.nodeId !== right.nodeId) {
    return false;
  }
  return canonicalCanvasPortId(left, graph, catalogRegistry) === canonicalCanvasPortId(right, graph, catalogRegistry);
}

function getEffectiveMaxConnections(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  port: PortDefinition,
): number | undefined {
  const graphType = graph.graphTypeId === undefined
    ? undefined
    : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  const graphTypeLimit = graphType?.portConnectionRules[port.direction] === "single" ? 1 : undefined;
  if (graphTypeLimit === undefined) {
    return port.maxConnections;
  }
  return port.maxConnections === undefined ? graphTypeLimit : Math.min(graphTypeLimit, port.maxConnections);
}

function getConnectionCapacityIssue(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  endpoint: ConnectionCandidateEndpoint,
  role: "source" | "target",
  ignoredEdgeIds: ReadonlySet<string> = new Set(),
): string | undefined {
  const maxConnections = getEffectiveMaxConnections(graph, catalogRegistry, endpoint.port);
  if (
    maxConnections === undefined
    || countCanvasPortConnections(
      graph,
      catalogRegistry,
      endpoint.canvasNodeId,
      endpoint.portId,
      role,
      ignoredEdgeIds,
    ) < maxConnections
  ) {
    return undefined;
  }
  return `${role === "source" ? "输出" : "输入"}端口“${endpoint.port.title}”已达到最大连接数。`;
}

function getReplaceableConnectionEdgeIds(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  endpoint: ConnectionCandidateEndpoint,
  role: "source" | "target",
): readonly string[] {
  return getEffectiveMaxConnections(graph, catalogRegistry, endpoint.port) === 1
    ? findCanvasPortConnections(graph, catalogRegistry, endpoint.canvasNodeId, endpoint.portId, role).map((edge) => edge.id)
    : [];
}

function countCanvasPortConnections(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  canvasNodeId: string,
  portId: string,
  role: "source" | "target",
  ignoredEdgeIds: ReadonlySet<string> = new Set(),
): number {
  return findCanvasPortConnections(graph, catalogRegistry, canvasNodeId, portId, role, ignoredEdgeIds).length;
}

function findCanvasPortConnections(
  graph: GraphDefinition,
  catalogRegistry: GraphCatalogRegistry,
  canvasNodeId: string,
  portId: string,
  role: "source" | "target",
  ignoredEdgeIds: ReadonlySet<string> = new Set(),
): readonly GraphEdgeModel[] {
  const requestedEndpoint = toGraphEndpoint(canvasNodeId, portId);
  const canonicalPortId = canonicalCanvasPortId(requestedEndpoint, graph, catalogRegistry);
  return graph.edges.filter((edge) => {
    if (ignoredEdgeIds.has(edge.id)) {
      return false;
    }
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
    return canonicalCanvasPortId(endpoint, graph, catalogRegistry) === canonicalPortId;
  });
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
  catalogRegistry: GraphCatalogRegistry,
): readonly SubgraphTypeOption[] {
  const parentType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  if (parentType !== undefined && !parentType.allowSubgraphs) {
    return [];
  }
  const graphTypes = catalogRegistry.graphTypes.filter((graphType) => {
    if (graphType.usage === "root") {
      return false;
    }
    return parentType?.allowedSubgraphTypeIds === undefined
      || parentType.allowedSubgraphTypeIds.some((id) => resolveGraphTypeDefinition(catalogRegistry, id)?.id === graphType.id);
  });
  return catalogRegistry.nodeTypes.flatMap((nodeType) => {
    if (nodeType.subgraph === undefined || !isNodeTypeAvailable(graph, nodeType, catalogRegistry, "subgraph")) {
      return [];
    }
    return graphTypes.flatMap((graphType) => (
      nodeType.subgraph?.graphTypeIds === undefined
      || nodeType.subgraph.graphTypeIds.some((id) => resolveGraphTypeDefinition(catalogRegistry, id)?.id === graphType.id)
        ? [{ graphType, nodeType }]
        : []
    ));
  });
}

function reorderIds(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): readonly string[] | undefined {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) {
    return undefined;
  }
  const result = ids.filter((id) => id !== sourceId);
  const targetIndex = result.indexOf(targetId);
  result.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceId);
  return result;
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
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
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

const DEFAULT_GRAPH_DATA_TYPE_COLORS = [
  "#4DA3FF",
  "#FF8A65",
  "#66BB6A",
  "#AB77E6",
  "#F2C94C",
  "#26C6DA",
  "#EC6F9F",
  "#9CCC65",
  "#FFB74D",
  "#7E8CE0",
  "#26A69A",
  "#B0BEC5",
] as const;

type GraphDataColorStyle = CSSProperties & { readonly "--graph-data-color": string };

function resolveGraphDataTypeColor(
  dataTypeId: string | undefined,
  dataTypes: readonly DataTypeDefinition[],
): string | undefined {
  if (dataTypeId === undefined) {
    return undefined;
  }
  const configuredColor = dataTypes.find((dataType) => dataType.id === dataTypeId)?.color;
  if (configuredColor !== undefined) {
    return configuredColor;
  }
  if (dataTypeId === "any") {
    return "#B8BEC5";
  }
  let hash = 2166136261;
  for (let index = 0; index < dataTypeId.length; index += 1) {
    hash ^= dataTypeId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return DEFAULT_GRAPH_DATA_TYPE_COLORS[(hash >>> 0) % DEFAULT_GRAPH_DATA_TYPE_COLORS.length];
}

function graphDataTypeStyle(
  dataTypeId: string | undefined,
  dataTypes: readonly DataTypeDefinition[],
): GraphDataColorStyle | undefined {
  const color = resolveGraphDataTypeColor(dataTypeId, dataTypes);
  return color === undefined ? undefined : { "--graph-data-color": color };
}

function emptyCatalogRegistry(): GraphCatalogRegistry {
  return { catalogs: [], dataTypes: [], graphTypes: [], nodeTypes: [] };
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
