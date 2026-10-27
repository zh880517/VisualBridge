import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { compareUtf16CodeUnits } from "@visualbridge/module-sdk";
import {
  GRAPH_REVEAL_MESSAGE_TYPE,
  GRAPH_REVEAL_RESULT_MESSAGE_TYPE,
  planGraphElementReveal,
  type GraphRevealPlan,
  type GraphRevealRequest,
  type GraphRevealResult,
} from "../graphReveal";
import {
  emptyCatalogRegistry,
  eventClientPosition,
  findCanvasPort,
  getConnectionCapacityIssue,
  getEffectiveMaxConnections,
  planConnectionCandidate,
  resolveNodeTypeDefinition,
  toGraphEndpoint,
} from "./model/graphCatalog";
import {
  createSelectionSnapshot,
  keepValidSelection,
  newId,
  selectionsEqual,
} from "./model/graphUtils";
import { vscode } from "./runtime";
import { toFlowEdge, toFlowNodes } from "./graphCanvas";
import { computeGraphDebugView } from "./debug/GraphDebugPanel";
import { GraphEditorView } from "./components/GraphEditorView";
import { useGraphDebug } from "./hooks/useGraphDebug";
import { useGraphDocumentCommands } from "./hooks/useGraphDocumentCommands";
import { useGraphHostBridge } from "./hooks/useGraphHostBridge";
import type { GraphDebugEdgeInfo } from "./graphCanvas";
import type {
  DocumentDiagnostic,
  GraphCatalogRegistry,
  GraphContextMenuState,
  GraphDocument,
  GraphFlowEdge,
  GraphFlowNode,
  GraphPosition,
  NodePickerState,
  Selection,
  SelectionHistoryEntry,
} from "./types";

export function GraphEditorApp(): React.JSX.Element {
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
  const [status, setStatus] = useState({ message: "正在加载图文档…", error: false });
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
  const debug = useGraphDebug();
  const {
    debugDrawerOpen,
    setDebugDrawerOpen,
    debugInstances,
    debugRuntimeConnected,
    debugRuntimeInstanceId,
    debugExecution,
    debugEvents,
    debugStopped,
    debugCursor,
    debugFollow,
    debugFlash,
    requestDebugInstances,
    subscribeDebugExecution,
    unsubscribeDebugExecution,
    enterDebugReplay,
    enterDebugFollow,
  } = debug;

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

  const {
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
  } = useGraphDocumentCommands({
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
  });

  useGraphHostBridge({
    debug,
    updateSelection,
    pasteClipboardPayload,
    documentRef,
    catalogRegistryRef,
    catalogReadyRef,
    activeGraphIdRef,
    pendingRef,
    selectedRef,
    documentVersionRef,
    undoSelectionHistoryRef,
    redoSelectionHistoryRef,
    pendingSelectionHistoryRef,
    lastCompletedOperationVersionRef,
    applyingRevealRequestIdRef,
    currentRevealRequestIdRef,
    revealTimerRef,
    handshakeProposalSentRef,
    autoLayoutFitViewRef,
    setGraphDocument,
    setCatalogRegistry,
    setCatalogReady,
    setDocumentDirty,
    setReplacementCandidates,
    setActiveGraphIdValue,
    setInvalidDiagnostics,
    setStatus,
    setContextMenu,
    setPicker,
    setSubgraphPickerOpen,
    setPending,
    setFlowNodes,
    setFlowEdges,
    setPendingRevealRequest,
    setActiveReveal,
    setRevealedElement,
  });

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
        message: "图文档当前无效，无法定位引用目标。",
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
  const debugHighlight = {
    executingNodeId: debugView.executingNodeId,
    replay: !debugFollow,
  };
  const debugEdgeInfo: GraphDebugEdgeInfo = useMemo(() => ({
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
      const message = `无法聚焦图引用目标：${String(error)}`;
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

  return (
    <GraphEditorView
      graphDocument={graphDocument}
      activeGraph={activeGraph}
      activeGraphId={activeGraphId}
      catalogRegistry={catalogRegistry}
      catalogReady={catalogReady}
      pending={pending}
      selected={selected}
      contextMenu={contextMenu}
      replacementCandidates={replacementCandidates}
      picker={picker}
      subgraphPickerOpen={subgraphPickerOpen}
      subgraphPosition={subgraphPosition}
      inspectorCollapsed={inspectorCollapsed}
      showNodeTypes={showNodeTypes}
      showNodeIds={showNodeIds}
      revealedElement={revealedElement}
      flowNodes={flowNodes}
      flowEdges={flowEdges}
      debugDrawerOpen={debugDrawerOpen}
      debugRuntimeConnected={debugRuntimeConnected}
      debugRuntimeInstanceId={debugRuntimeInstanceId}
      debugInstances={debugInstances}
      debugExecution={debugExecution}
      debugEvents={debugEvents}
      debugStopped={debugStopped}
      debugFollow={debugFollow}
      debugCursor={debugCursorEffective}
      debugExecutingNodeId={debugView.executingNodeId}
      debugHighlight={debugHighlight}
      invalidDiagnostics={invalidDiagnostics}
      documentDirty={documentDirty}
      status={status}
      rootMetadata={rootMetadata}
      canvasRef={canvasRef}
      setActiveGraphId={setActiveGraphId}
      setContextMenu={setContextMenu}
      setPicker={setPicker}
      setSubgraphPickerOpen={setSubgraphPickerOpen}
      setSubgraphPosition={setSubgraphPosition}
      setInspectorCollapsed={setInspectorCollapsed}
      setShowNodeTypes={setShowNodeTypes}
      setShowNodeIds={setShowNodeIds}
      setDebugDrawerOpen={setDebugDrawerOpen}
      setFlowInstance={setFlowInstance}
      handleNodesChange={handleNodesChange}
      handleEdgesChange={handleEdgesChange}
      handleSelectionChange={handleSelectionChange}
      handleConnect={handleConnect}
      handleConnectEnd={handleConnectEnd}
      handleNodeDragStop={handleNodeDragStop}
      handleNodeContextMenu={handleNodeContextMenu}
      handleEdgeContextMenu={handleEdgeContextMenu}
      handleSelectionContextMenu={handleSelectionContextMenu}
      handlePaneContextMenu={handlePaneContextMenu}
      openSubgraph={openSubgraph}
      selectSameType={selectSameType}
      applyAutoLayout={applyAutoLayout}
      createClipboardPayload={createClipboardPayload}
      copySelection={copySelection}
      duplicateSelection={duplicateSelection}
      deleteSelection={deleteSelection}
      addNodeType={addNodeType}
      addConnectedNode={addConnectedNode}
      addSubgraph={addSubgraph}
      postOperations={postOperations}
      reportStatus={setStatus}
      requestDebugInstances={requestDebugInstances}
      subscribeDebugExecution={subscribeDebugExecution}
      unsubscribeDebugExecution={unsubscribeDebugExecution}
      enterDebugReplay={enterDebugReplay}
      enterDebugFollow={enterDebugFollow}
    />
  );
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
