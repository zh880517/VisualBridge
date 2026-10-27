import { MarkerType } from "@xyflow/react";
import { INTERFACE_INPUT_NODE_ID, INTERFACE_OUTPUT_NODE_ID } from "./runtime";
import {
  canonicalCanvasPortId,
  connectedNodeInputPorts,
  findCanvasPort,
  overriddenNodeProperties,
  portsForNode,
  resolveNodeTypeDefinition,
} from "./model/graphCatalog";
import { resolveGraphDataTypeColor } from "./model/graphUtils";
import type {
  GraphCatalogRegistry,
  GraphDefinition,
  GraphDocument,
  GraphEdgeModel,
  GraphFlowEdge,
  GraphFlowNode,
  GraphNodeData,
  Selection,
} from "./types";

export function toFlowNodes(
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
        typeTitle: nodeType?.title ?? (node.kind === "subgraph" ? "内嵌子图" : `未知 · ${node.nodeTypeId}`),
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
        title: editableInterfaces ? "输入参数" : "图输入",
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
        title: editableInterfaces ? "输出参数" : "图输出",
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

export interface GraphDebugEdgeInfo {
  readonly values: ReadonlyMap<string, string>;
  readonly flashKeys?: ReadonlySet<string>;
  readonly flashNodeIds?: ReadonlySet<string>;
}

export function toFlowEdge(
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
