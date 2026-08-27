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
  readonly formatVersion: 2;
  readonly catalogId: string;
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
type Selection = { readonly kind: "node" | "edge"; readonly id: string };

interface SubgraphTypeOption {
  readonly graphType: GraphTypeDefinition;
  readonly nodeType: NodeTypeDefinition;
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
  | { readonly type: "operationRejected"; readonly message: string };

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const INTERFACE_INPUT_NODE_ID = "$visualbridge.interface.inputs";
const INTERFACE_OUTPUT_NODE_ID = "$visualbridge.interface.outputs";
const GraphPendingContext = createContext(false);
const nodeTypes = {
  visualBridgeNode: VisualBridgeNode,
  visualBridgeInterface: VisualBridgeInterfaceNode,
};

function VisualBridgeNode({ data, selected }: NodeProps<GraphFlowNode>): React.JSX.Element {
  const pending = useContext(GraphPendingContext);
  if (data.flavor !== "node") {
    return <article className="graph-node">Invalid node</article>;
  }
  const inputs = data.ports.filter((port) => port.direction === "input");
  const outputs = data.ports.filter((port) => port.direction === "output");
  return (
    <article className={`graph-node${selected ? " selected" : ""}${data.model.kind === "subgraph" ? " subgraph" : ""}`}>
      <header className="graph-node-header" title={data.model.title || data.typeTitle}>
        <InlineNodeTitle data={data} pending={pending} />
      </header>
      <div className="graph-node-type">{data.typeTitle}</div>
      <InlineNodeProperties data={data} pending={pending} />
      <InlineDynamicPorts data={data} pending={pending} />
      <div className="graph-port-columns">
        <PortColumn ports={inputs} />
        <PortColumn ports={outputs} align="right" />
      </div>
      <div className="graph-node-id">{data.model.id}</div>
    </article>
  );
}

function InlineNodeTitle({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element {
  const [title, setTitle] = useState(data.model.title);
  useEffect(() => setTitle(data.model.title), [data.model.title]);
  const commit = (): void => {
    if (title !== data.model.title) {
      data.commitNode(data.model.id, title, data.model.properties);
    }
  };
  return (
    <input
      className="graph-node-title-input nodrag nowheel"
      aria-label="节点标题"
      value={title}
      disabled={pending}
      onChange={(event) => setTitle(event.target.value)}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setTitle(data.model.title);
        }
      }}
    />
  );
}

function InlineNodeProperties({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element {
  const definitions = data.nodeType?.properties ?? [];
  return (
    <div className="graph-node-properties nodrag nowheel" onDoubleClick={(event) => event.stopPropagation()}>
      {definitions.map((definition) => (
        <InlineNodeProperty key={definition.id} data={data} definition={definition} pending={pending} />
      ))}
      {definitions.length === 0 && Object.keys(data.model.properties).length === 0 && (
        <span className="graph-node-no-properties">无字段</span>
      )}
      <InlineNodePropertiesJson data={data} pending={pending} />
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
  if (definition.editor?.kind === "select") {
    const selectedIndex = definition.editor.options.findIndex((option) => jsonValuesEqual(option.value, value));
    const selectedValue = selectedIndex < 0 ? "" : String(selectedIndex);
    return (
      <label className="graph-node-property" title={definition.description}>
        <span>{definition.title}{definition.required ? " *" : ""}</span>
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
      </label>
    );
  }
  if (definition.valueType === "boolean" || definition.editor?.kind === "checkbox") {
    return (
      <label className="graph-node-property boolean" title={definition.description}>
        <span>{definition.title}{definition.required ? " *" : ""}</span>
        <input
          type="checkbox"
          checked={value === true}
          disabled={pending || definition.editor?.readOnly}
          onChange={(event) => commit(event.target.checked)}
        />
      </label>
    );
  }
  return (
    <InlineNodeScalarProperty
      key={`${data.model.id}:${definition.id}:${JSON.stringify(value)}`}
      definition={definition}
      value={value}
      editor={definition.editor}
      pending={pending}
      commit={commit}
      reportStatus={data.reportStatus}
    />
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
      <span>{definition.title}{definition.required ? " *" : ""}</span>
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

function InlineNodePropertiesJson({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element {
  const [text, setText] = useState(JSON.stringify(data.model.properties, undefined, 2));
  useEffect(() => setText(JSON.stringify(data.model.properties, undefined, 2)), [data.model.properties]);
  const commit = (): void => {
    try {
      const properties = JSON.parse(text) as unknown;
      if (!isJsonObject(properties)) {
        throw new Error("必须是 JSON 对象");
      }
      if (!jsonValuesEqual(properties, data.model.properties)) {
        data.commitNode(data.model.id, data.model.title, properties);
      }
    } catch (errorValue) {
      data.reportStatus({ message: `节点属性无法解析：${String(errorValue)}`, error: true });
      setText(JSON.stringify(data.model.properties, undefined, 2));
    }
  };
  return (
    <details className="graph-node-properties-json">
      <summary>全部属性 JSON</summary>
      <textarea
        aria-label="全部节点属性 JSON"
        value={text}
        disabled={pending}
        rows={4}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            setText(JSON.stringify(data.model.properties, undefined, 2));
          }
        }}
      />
    </details>
  );
}

function InlineDynamicPorts({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element | null {
  if (data.nodeType === undefined) {
    return null;
  }
  const groups = data.nodeType.dynamicPortGroups ?? [];
  if (groups.length === 0 && data.model.dynamicPorts.length === 0) {
    return null;
  }
  return (
    <div className="graph-dynamic-port-groups nodrag nowheel" onDoubleClick={(event) => event.stopPropagation()}>
      {groups.map((group) => {
        const ports = data.model.dynamicPorts.filter((port) => group.id === port.groupId || group.aliases.includes(port.groupId));
        const canAdd = group.maxItems === undefined || ports.length < group.maxItems;
        return (
          <section key={group.id} className="graph-dynamic-port-group" title={group.description}>
            <header>
              <strong>{group.title}</strong>
              <button
                type="button"
                className="secondary"
                disabled={pending || !canAdd}
                aria-label={`添加动态端口 ${group.title}`}
                onClick={() => data.commitOperations([{
                  type: "graph.addDynamicPort",
                  graphId: data.graphId,
                  nodeId: data.model.id,
                  port: {
                    id: newId("port"),
                    groupId: group.id,
                    title: `${group.title} ${ports.length + 1}`,
                    value: cloneJsonValue(group.item.defaultValue),
                  },
                }])}
              >
                +
              </button>
            </header>
            {ports.map((port) => (
              <DynamicPortRow
                key={port.id}
                data={data}
                group={group}
                port={port}
                pending={pending}
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
}: {
  readonly data: GraphNodeData;
  readonly group: DynamicPortGroupDefinition;
  readonly port: GraphDynamicPort;
  readonly pending: boolean;
}): React.JSX.Element {
  const model = data.model;
  const [title, setTitle] = useState(port.title);
  useEffect(() => setTitle(port.title), [port.title]);
  const groupPorts = model.dynamicPorts.filter(
    (candidate) => group.id === candidate.groupId || group.aliases.includes(candidate.groupId),
  );
  const groupIndex = groupPorts.findIndex((candidate) => candidate.id === port.id);
  const move = (offset: -1 | 1): void => {
    const other = groupPorts[groupIndex + offset];
    if (other === undefined) {
      return;
    }
    const portIds = model.dynamicPorts.map((candidate) => candidate.id);
    const leftIndex = portIds.indexOf(port.id);
    const rightIndex = portIds.indexOf(other.id);
    [portIds[leftIndex], portIds[rightIndex]] = [portIds[rightIndex]!, portIds[leftIndex]!];
    data.commitOperations([{
      type: "graph.reorderDynamicPorts",
      graphId: data.graphId,
      nodeId: model.id,
      portIds,
    }]);
  };
  const commit = (nextTitle: string, nextValue: JsonValue): void => {
    if (nextTitle !== port.title || !jsonValuesEqual(nextValue, port.value)) {
      data.commitOperations([{
        type: "graph.updateDynamicPort",
        graphId: data.graphId,
        nodeId: model.id,
        portId: port.id,
        title: nextTitle,
        value: nextValue,
      }]);
    }
  };
  return (
    <article className="graph-dynamic-port-row">
      <input
        aria-label={`动态端口名称 ${port.id}`}
        value={title}
        disabled={pending}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => commit(title, port.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setTitle(port.title);
          }
        }}
      />
      <DynamicPortValueEditor
        group={group}
        port={port}
        pending={pending}
        commit={(value) => commit(port.title, value)}
        reportStatus={data.reportStatus}
      />
      <div className="graph-dynamic-port-actions">
        <button type="button" className="secondary" disabled={pending || groupIndex <= 0} aria-label={`上移 ${port.title}`} onClick={() => move(-1)}>↑</button>
        <button type="button" className="secondary" disabled={pending || groupIndex >= groupPorts.length - 1} aria-label={`下移 ${port.title}`} onClick={() => move(1)}>↓</button>
        <button
          type="button"
          className="danger"
          disabled={pending}
          aria-label={`删除动态端口 ${port.title}`}
          onClick={() => {
            if (window.confirm(`删除动态端口 '${port.title}'？相关连线也会被删除。`)) {
              data.commitOperations([{
                type: "graph.removeDynamicPort",
                graphId: data.graphId,
                nodeId: model.id,
                portId: port.id,
              }]);
            }
          }}
        >
          −
        </button>
      </div>
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
      {ports.length === 0 && <span className="graph-no-ports">—</span>}
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
  const [picker, setPicker] = useState<{ readonly mode: "add" } | { readonly mode: "replace"; readonly nodeId: string }>();
  const [subgraphPickerOpen, setSubgraphPickerOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);

  const activeGraph = useMemo(
    () => graphDocument?.graphs.find((graph) => graph.id === activeGraphId),
    [activeGraphId, graphDocument],
  );

  const updateSelection = useCallback((next: Selection | undefined): void => {
    const current = selectedRef.current;
    if (current?.kind === next?.kind && current?.id === next?.id) {
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
  }, [updateSelection]);

  useEffect(() => {
    if (graphDocument === undefined || activeGraph === undefined) {
      setFlowNodes([]);
      setFlowEdges([]);
      return;
    }
    setFlowNodes(toFlowNodes(graphDocument, activeGraph, catalog, selectedRef.current, commitNode, postOperations, setStatus));
    setFlowEdges(activeGraph.edges.map((edge) => toFlowEdge(edge, selectedRef.current, activeGraph, catalog)));
  }, [activeGraph, catalog, commitNode, graphDocument, postOperations]);

  const handleNodesChange = useCallback((changes: NodeChange<GraphFlowNode>[]): void => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<GraphFlowEdge>[]): void => {
    setFlowEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const handleSelectionChange = useCallback((selection: { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] }): void => {
    const node = selection.nodes.find((candidate) => candidate.data.flavor === "node");
    if (node !== undefined) {
      updateSelection({ kind: "node", id: node.id });
      return;
    }
    const edge = selection.edges[0];
    updateSelection(edge === undefined ? undefined : { kind: "edge", id: edge.id });
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

  const handleNodeDragStop = useCallback((_: MouseEvent | TouchEvent, node: GraphFlowNode): void => {
    if (node.data.flavor !== "node") {
      return;
    }
    const currentGraph = documentRef.current?.graphs.find((graph) => graph.id === activeGraphIdRef.current);
    const sourceNode = currentGraph?.nodes.find((candidate) => candidate.id === node.id);
    if (currentGraph === undefined || sourceNode === undefined) {
      return;
    }
    const position = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
    if (position.x !== sourceNode.position.x || position.y !== sourceNode.position.y) {
      postOperations([{ type: "graph.moveNode", graphId: currentGraph.id, nodeId: node.id, position }]);
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
    updateSelection(undefined);
    postOperations([current.kind === "node"
      ? { type: "graph.removeNode", graphId, nodeId: current.id }
      : { type: "graph.removeEdge", graphId, edgeId: current.id }]);
  }, [postOperations, updateSelection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      const editing = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
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
  }, [deleteSelection]);

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: GraphFlowNode): void => {
    if (node.data.flavor !== "node") {
      return;
    }
    event.preventDefault();
    updateSelection({ kind: "node", id: node.id });
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

  const path = graphDocument === undefined ? [] : findGraphPath(graphDocument, activeGraphId);
  const pickerTypes = picker?.mode === "replace"
    ? catalog.nodeTypes.filter((nodeType) => replacementCandidates[picker.nodeId]?.includes(nodeType.id) ?? false)
    : catalog.nodeTypes.filter((nodeType) => activeGraph !== undefined && isNodeTypeAvailable(activeGraph, nodeType, catalog, "atomic"));
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
                <ReactFlow<GraphFlowNode, GraphFlowEdge>
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={handleNodesChange}
                  onEdgesChange={handleEdgesChange}
                  onSelectionChange={handleSelectionChange}
                  onConnect={handleConnect}
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
                  <Controls showInteractive={false} />
                </ReactFlow>
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
              <button
                type="button"
                disabled={candidates === undefined || candidates.length === 0}
                onClick={() => { setContextMenu(undefined); setPicker({ mode: "replace", nodeId: node.id }); }}
              >
                替换节点类型{candidates === undefined ? "（检查中…）" : candidates.length === 0 ? "（无兼容类型）" : "…"}
              </button>
            )}
            {node?.kind === "subgraph" && <button type="button" onClick={() => openSubgraph(node.id)}>打开子图</button>}
          </div>
        );
      })()}

      {picker !== undefined && (
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
              addNodeType(nodeTypeId);
            }
          }}
        />
      )}

      {subgraphPickerOpen && (
        <SubgraphTypePicker
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
      <h3>公开接口</h3>
      <div className="graph-interface-list">
        {graph.interfacePorts.map((port) => (
          <InterfacePortRow key={port.id} graphId={graph.id} port={port} pending={pending} postOperations={postOperations} />
        ))}
        {graph.interfacePorts.length === 0 && <p className="graph-empty">当前 Graph 没有公开接口。</p>}
      </div>
      <AddInterfacePortForm
        graphId={graph.id}
        catalog={catalog}
        pending={pending}
        postOperations={postOperations}
        reportStatus={reportStatus}
      />
    </aside>
  );
}

function InterfacePortRow({
  graphId,
  port,
  pending,
  postOperations,
}: {
  readonly graphId: string;
  readonly port: PortDefinition;
  readonly pending: boolean;
  readonly postOperations: (operations: readonly GraphOperation[]) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(port.title);
  return (
    <section className="graph-interface-row">
      <code>{port.id}</code>
      <span>{port.kind} · {port.direction}{port.dataTypeId === undefined ? "" : ` · ${port.dataTypeId}`}</span>
      <input value={title} onChange={(event) => setTitle(event.target.value)} />
      <div>
        <button
          type="button"
          className="secondary"
          disabled={pending || title === port.title}
          onClick={() => postOperations([{ type: "graph.updateInterfacePort", graphId, portId: port.id, title }])}
        >
          重命名
        </button>
        <button
          type="button"
          className="danger"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`删除接口 '${port.title}'？相关连线也会被删除。`)) {
              postOperations([{ type: "graph.removeInterfacePort", graphId, portId: port.id }]);
            }
          }}
        >
          删除
        </button>
      </div>
    </section>
  );
}

function AddInterfacePortForm({
  graphId,
  catalog,
  pending,
  postOperations,
  reportStatus,
}: {
  readonly graphId: string;
  readonly catalog: GraphCatalog;
  readonly pending: boolean;
  readonly postOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
}): React.JSX.Element {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<PortKind>("flow");
  const [direction, setDirection] = useState<PortDirection>("input");
  const [dataTypeId, setDataTypeId] = useState(catalog.dataTypes[0]?.id ?? "any");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      reportStatus({ message: "接口 ID 必须是稳定的有效标识符。", error: true });
      return;
    }
    postOperations([{
      type: "graph.addInterfacePort",
      graphId,
      port: {
        id,
        title: title || id,
        kind,
        direction,
        ...(kind === "data" ? { dataTypeId } : {}),
        maxConnections: 1,
      },
    }]);
  };
  return (
    <form className="graph-add-interface" onSubmit={submit}>
      <h3>添加接口</h3>
      <InputField label="稳定 ID" value={id} onChange={setId} />
      <InputField label="显示名称" value={title} onChange={setTitle} />
      <label className="graph-field">
        <span>连接类型</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as PortKind)}>
          <option value="flow">流程</option>
          <option value="data">数据</option>
        </select>
      </label>
      <label className="graph-field">
        <span>方向</span>
        <select value={direction} onChange={(event) => setDirection(event.target.value as PortDirection)}>
          <option value="input">输入</option>
          <option value="output">输出</option>
        </select>
      </label>
      {kind === "data" && (
        <label className="graph-field">
          <span>数据类型</span>
          <select value={dataTypeId} onChange={(event) => setDataTypeId(event.target.value)}>
            <option value="any">any</option>
            {catalog.dataTypes.map((dataType) => <option key={dataType.id} value={dataType.id}>{dataType.title}</option>)}
          </select>
        </label>
      )}
      <button type="submit" disabled={pending}>添加接口</button>
    </form>
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
    [nodeType.title, nodeType.id, nodeType.category, ...(nodeType.menuPath ?? []), ...(nodeType.tags ?? []), ...(nodeType.traits ?? [])]
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
          {filtered.map((nodeType) => (
            <button key={nodeType.id} type="button" className="graph-node-type-option" onClick={() => onSelect(nodeType.id)}>
              <strong>{nodeType.title}</strong>
              <span>{nodeType.menuPath?.join(" / ") || nodeType.category}</span>
              <code>{nodeType.id}</code>
            </button>
          ))}
          {filtered.length === 0 && <p className="graph-empty">没有可用的节点类型。</p>}
        </div>
      </section>
    </div>
  );
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
    [graphType.title, graphType.id, nodeType.title, nodeType.id, ...(nodeType.menuPath ?? [])]
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
              <span>创建 {graphType.title}</span>
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
        commitNode,
        commitOperations,
        reportStatus,
      },
      selected: selected?.kind === "node" && selected.id === node.id,
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
    selected: selected?.kind === "edge" && selected.id === edge.id,
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
  if (selection?.kind === "node" && graph.nodes.some((node) => node.id === selection.id)) {
    return selection;
  }
  if (selection?.kind === "edge" && graph.edges.some((edge) => edge.id === selection.id)) {
    return selection;
  }
  return undefined;
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
  return { formatVersion: 2, catalogId: "empty", dataTypes: [], graphTypes: [], nodeTypes: [] };
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
