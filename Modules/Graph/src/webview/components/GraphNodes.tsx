import { useContext, useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { type FieldDefinition, type JsonValue } from "@visualbridge/module-sdk";
import { FieldValueEditor } from "../../../../Shared/Form/index";
import { CommonIcon } from "../../../../Shared/Ui/index";
import {
  GraphDataTypesContext,
  GraphDebugContext,
  GraphNodeIdVisibilityContext,
  GraphNodeTypeVisibilityContext,
  GraphPendingContext,
  GraphRevealContext,
  referenceBridge,
} from "../runtime";
import {
  cloneJsonValue,
  graphDataTypeStyle,
  jsonValuesEqual,
  newId,
} from "../model/graphUtils";
import type {
  DynamicPortGroupDefinition,
  GraphDynamicPort,
  GraphFlowNode,
  GraphNodeData,
  PortDefinition,
} from "../types";

export function VisualBridgeNode({ data, selected }: NodeProps<GraphFlowNode>): React.JSX.Element {
  const pending = useContext(GraphPendingContext);
  const showNodeTypes = useContext(GraphNodeTypeVisibilityContext);
  const showNodeIds = useContext(GraphNodeIdVisibilityContext);
  const reveal = useContext(GraphRevealContext);
  const debug = useContext(GraphDebugContext);
  if (data.flavor !== "node") {
    return <article className="graph-node">无效节点</article>;
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
  nodeType: GraphNodeData["nodeType"],
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

export function InlineNodeProperties({ data, pending }: { readonly data: GraphNodeData; readonly pending: boolean }): React.JSX.Element {
  const definitions = data.nodeType?.properties ?? [];
  const declaredPropertyIds = new Set(definitions.flatMap((definition) => [definition.id, ...definition.aliases]));
  const unknownDefinitions: readonly FieldDefinition[] = Object.entries(data.model.properties)
    .filter(([propertyId]) => !declaredPropertyIds.has(propertyId))
    .map(([propertyId, value]) => ({
      id: propertyId,
      aliases: [],
      title: propertyId,
      description: "该字段未在当前目录注册表中声明，按现有 JSON 值类型编辑。",
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

export function PortColumn({
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
