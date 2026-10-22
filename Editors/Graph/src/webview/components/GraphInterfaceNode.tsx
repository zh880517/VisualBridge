import { useContext, useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CommonIcon } from "@visualbridge/editor-ui";
import {
  GraphDataTypesContext,
  GraphPendingContext,
  GraphRevealContext,
} from "../runtime";
import { graphDataTypeStyle, newId, reorderIds } from "../model/graphUtils";
import type {
  GraphFlowNode,
  GraphInterfaceData,
  PortDefinition,
  PortDirection,
} from "../types";
import { PortColumn } from "./GraphNodes";

export function VisualBridgeInterfaceNode({ data }: NodeProps<GraphFlowNode>): React.JSX.Element {
  const pending = useContext(GraphPendingContext);
  const reveal = useContext(GraphRevealContext);
  if (data.flavor !== "interface") {
    return <article className="graph-interface-node">无效接口</article>;
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
