import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import { compareUtf16CodeUnits, type JsonValue } from "@visualbridge/module-sdk";
import { INTERFACE_INPUT_NODE_ID, vscode } from "../runtime";
import {
  computeGraphAutoLayout,
  GRAPH_LAYOUT_RANK_SPACING,
  type GraphLayoutSize,
} from "../graphLayout";
import {
  createDefaultGraphProperties,
  createDefaultProperties,
  isNodeTypeAvailable,
  isNodeTypeRequiredByGraph,
  planConnectionCandidate,
  planDeleteSelection,
  resolveGraphTypeDefinition,
  resolveNodeTypeDefinition,
  toGraphEndpoint,
} from "../model/graphCatalog";
import {
  cloneGraphAtomicNode,
  cloneGraphEdge,
  createSelectionSnapshot,
  newId,
} from "../model/graphUtils";
import type {
  ConnectionNodeOption,
  GraphAtomicNode,
  GraphCatalogRegistry,
  GraphClipboardPayload,
  GraphContextMenuState,
  GraphDocument,
  GraphEdgeModel,
  GraphFlowEdge,
  GraphFlowNode,
  GraphNodeEndpoint,
  GraphOperation,
  GraphPosition,
  NodePickerState,
  Selection,
  SelectionHistoryEntry,
  SelectionSnapshot,
} from "../types";

export interface GraphDocumentCommandsOptions {
  readonly documentRef: RefObject<GraphDocument | undefined>;
  readonly catalogRegistryRef: RefObject<GraphCatalogRegistry>;
  readonly catalogReadyRef: RefObject<boolean>;
  readonly activeGraphIdRef: RefObject<string>;
  readonly pendingRef: RefObject<boolean>;
  readonly selectedRef: RefObject<Selection | undefined>;
  readonly clipboardPasteIndexRef: RefObject<number>;
  readonly autoLayoutFitViewRef: RefObject<boolean>;
  readonly documentVersionRef: RefObject<number>;
  readonly pendingSelectionHistoryRef: RefObject<SelectionHistoryEntry | undefined>;
  readonly setPending: Dispatch<SetStateAction<boolean>>;
  readonly setContextMenu: Dispatch<SetStateAction<GraphContextMenuState | undefined>>;
  readonly setPicker: Dispatch<SetStateAction<NodePickerState | undefined>>;
  readonly setSubgraphPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setSubgraphPosition: Dispatch<SetStateAction<GraphPosition | undefined>>;
  readonly setStatus: Dispatch<SetStateAction<{ message: string; error: boolean }>>;
  readonly updateSelection: (
    next: Selection | undefined,
    synchronizeFlow?: boolean,
    recordHistory?: boolean,
  ) => void;
  readonly flowInstance: ReactFlowInstance<GraphFlowNode, GraphFlowEdge> | undefined;
  readonly nodePosition: () => GraphPosition;
}

export interface GraphDocumentCommands {
  readonly postOperations: (
    operations: readonly GraphOperation[],
    selectionBefore?: SelectionSnapshotInput,
  ) => void;
  readonly commitNode: (
    nodeId: string,
    title: string,
    properties: Readonly<Record<string, JsonValue>>,
  ) => void;
  readonly applyAutoLayout: () => void;
  readonly createClipboardPayload: () => GraphClipboardPayload | undefined;
  readonly pasteClipboardPayload: (payload: GraphClipboardPayload, requestedOffset?: number) => void;
  readonly copySelection: () => void;
  readonly duplicateSelection: () => void;
  readonly addNodeType: (nodeTypeId: string, position?: GraphPosition) => void;
  readonly addConnectedNode: (
    connectionPicker: Extract<NodePickerState, { readonly mode: "connect" }>,
    option: ConnectionNodeOption,
  ) => void;
  readonly addSubgraph: (graphTypeId?: string, nodeTypeId?: string, position?: GraphPosition) => void;
  readonly deleteSelection: () => void;
}

type SelectionSnapshotInput = SelectionSnapshot;

export function useGraphDocumentCommands({
  documentRef,
  catalogRegistryRef,
  catalogReadyRef,
  activeGraphIdRef,
  pendingRef,
  selectedRef,
  clipboardPasteIndexRef,
  autoLayoutFitViewRef,
  documentVersionRef,
  pendingSelectionHistoryRef,
  setPending,
  setContextMenu,
  setPicker,
  setSubgraphPickerOpen,
  setSubgraphPosition,
  setStatus,
  updateSelection,
  flowInstance,
  nodePosition,
}: GraphDocumentCommandsOptions): GraphDocumentCommands {
  const postOperations = useCallback((
    operations: readonly GraphOperation[],
    selectionBefore?: SelectionSnapshotInput,
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
  }, [
    activeGraphIdRef,
    documentRef,
    documentVersionRef,
    pendingRef,
    pendingSelectionHistoryRef,
    selectedRef,
    setContextMenu,
    setPending,
    setPicker,
    setStatus,
    setSubgraphPickerOpen,
    setSubgraphPosition,
  ]);

  const commitNode = useCallback((
    nodeId: string,
    title: string,
    properties: Readonly<Record<string, JsonValue>>,
  ): void => {
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === activeGraphIdRef.current);
    if (graph?.nodes.some((candidate) => candidate.id === nodeId)) {
      postOperations([{ type: "graph.updateNode", graphId: graph.id, nodeId, title, properties }]);
    }
  }, [activeGraphIdRef, documentRef, postOperations]);

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
  }, [
    activeGraphIdRef,
    autoLayoutFitViewRef,
    documentRef,
    flowInstance,
    postOperations,
    setStatus,
  ]);

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
  }, [activeGraphIdRef, catalogRegistryRef, documentRef, selectedRef]);

  const pasteClipboardPayload = useCallback((payload: GraphClipboardPayload, requestedOffset?: number): void => {
    const graph = documentRef.current?.graphs.find((candidate) => candidate.id === activeGraphIdRef.current);
    if (graph === undefined || pendingRef.current || !catalogReadyRef.current) {
      if (!catalogReadyRef.current) {
        setStatus({ message: "目录尚未就绪，不能创建或复制节点。", error: true });
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
  }, [
    activeGraphIdRef,
    catalogReadyRef,
    clipboardPasteIndexRef,
    documentRef,
    pendingRef,
    postOperations,
    selectedRef,
    setStatus,
    updateSelection,
  ]);

  const copySelection = useCallback((): void => {
    const payload = createClipboardPayload();
    if (payload === undefined) {
      setStatus({ message: "请选择可复制的原子节点；图类型必需节点和子图暂不进入剪贴板。", error: true });
      return;
    }
    const text = JSON.stringify(payload);
    if (text.length > 2_000_000) {
      setStatus({ message: "所选节点超过图剪贴板 2 MB 限制，请减少选择后重试。", error: true });
      return;
    }
    clipboardPasteIndexRef.current = 0;
    vscode.postMessage({ type: "writeClipboard", text });
    setStatus({ message: `已复制 ${payload.nodes.length} 个节点和 ${payload.edges.length} 条内部连线。`, error: false });
  }, [clipboardPasteIndexRef, createClipboardPayload, setStatus]);

  const duplicateSelection = useCallback((): void => {
    const payload = createClipboardPayload();
    if (payload === undefined) {
      setStatus({ message: "请选择可克隆的原子节点；图类型必需节点和子图暂不复制。", error: true });
      return;
    }
    pasteClipboardPayload(payload, 40);
  }, [createClipboardPayload, pasteClipboardPayload, setStatus]);

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
  }, [
    activeGraphIdRef,
    catalogReadyRef,
    catalogRegistryRef,
    documentRef,
    nodePosition,
    postOperations,
  ]);

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
  }, [
    activeGraphIdRef,
    catalogReadyRef,
    catalogRegistryRef,
    documentRef,
    postOperations,
    selectedRef,
    setStatus,
    updateSelection,
  ]);

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
        title: nodeType?.title ?? `子图 ${index}`,
        position: position ?? nodePosition(),
        properties: nodeType === undefined ? {} : createDefaultProperties(nodeType),
        dynamicPorts: [],
      },
      subgraph: {
        id: subgraphId,
        ...(graphType === undefined ? {} : { graphTypeId: graphType.id }),
        title: graphType?.title ?? `子图 ${index}`,
        properties: graphType === undefined ? {} : createDefaultGraphProperties(graphType),
        interfacePorts: [
          { id: "flowIn", title: "In", kind: "flow", direction: "input", maxConnections: 1 },
          { id: "flowOut", title: "Out", kind: "flow", direction: "output", maxConnections: 1 },
        ],
        nodes: initialNodes,
        edges: [],
      },
    }]);
  }, [
    activeGraphIdRef,
    catalogReadyRef,
    catalogRegistryRef,
    documentRef,
    nodePosition,
    postOperations,
  ]);

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
  }, [
    activeGraphIdRef,
    catalogRegistryRef,
    documentRef,
    pendingRef,
    postOperations,
    selectedRef,
    updateSelection,
  ]);

  return {
    postOperations,
    commitNode,
    applyAutoLayout,
    createClipboardPayload,
    pasteClipboardPayload,
    copySelection,
    duplicateSelection,
    addNodeType,
    addConnectedNode,
    addSubgraph,
    deleteSelection,
  };
}
