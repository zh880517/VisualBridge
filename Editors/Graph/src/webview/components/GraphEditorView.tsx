import type {
  Connection,
  EdgeChange,
  FinalConnectionState,
  NodeChange,
  ReactFlowInstance,
} from "@xyflow/react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
} from "@xyflow/react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SetStateAction,
} from "react";
import {
  EditorShell,
  EditorStatusBar,
  EditorToolbar,
  SaveState,
  SplitWorkspace,
  ToolbarSpacer,
} from "@visualbridge/editor-ui";
import type { GraphRevealPlan } from "../../graphReveal";
import {
  GraphDataTypesContext,
  GraphNodeIdVisibilityContext,
  GraphNodeTypeVisibilityContext,
  GraphPendingContext,
  GraphRevealContext,
  GraphDebugContext,
  vscode,
} from "../runtime";
import {
  getConnectionNodeOptions,
  getSubgraphOptions,
  isNodeTypeAvailable,
  planDeleteSelection,
} from "../model/graphCatalog";
import { findGraphPath } from "../model/graphUtils";
import type {
  ConnectionNodeOption,
  GraphCatalogRegistry,
  GraphClipboardPayload,
  GraphContextMenuState,
  DocumentDiagnostic,
  GraphDebugEvent,
  GraphDebugExecution,
  GraphDebugHighlight,
  GraphDefinition,
  GraphDocument,
  GraphFlowEdge,
  GraphFlowNode,
  GraphOperation,
  GraphPosition,
  NodePickerState,
  Selection,
} from "../types";
import { GraphDebugPanel } from "../debug/GraphDebugPanel";
import { GraphInspector } from "./GraphInspector";
import { VisualBridgeInterfaceNode } from "./GraphInterfaceNode";
import { VisualBridgeNode } from "./GraphNodes";
import {
  ConnectionNodePicker,
  InvalidDocument,
  LoadingDocument,
  NodeTypePicker,
  SelectionContextActions,
  SubgraphTypePicker,
} from "./GraphPickers";

const nodeTypes = {
  visualBridgeNode: VisualBridgeNode,
  visualBridgeInterface: VisualBridgeInterfaceNode,
};

export interface GraphEditorViewProps {
  readonly graphDocument: GraphDocument | undefined;
  readonly activeGraph: GraphDefinition | undefined;
  readonly activeGraphId: string;
  readonly catalogRegistry: GraphCatalogRegistry;
  readonly catalogReady: boolean;
  readonly pending: boolean;
  readonly selected: Selection | undefined;
  readonly contextMenu: GraphContextMenuState | undefined;
  readonly replacementCandidates: Readonly<Record<string, readonly string[]>>;
  readonly picker: NodePickerState | undefined;
  readonly subgraphPickerOpen: boolean;
  readonly subgraphPosition: GraphPosition | undefined;
  readonly inspectorCollapsed: boolean;
  readonly showNodeTypes: boolean;
  readonly showNodeIds: boolean;
  readonly revealedElement: GraphRevealPlan | undefined;
  readonly flowNodes: GraphFlowNode[];
  readonly flowEdges: GraphFlowEdge[];
  readonly debugDrawerOpen: boolean;
  readonly debugRuntimeConnected: boolean;
  readonly debugRuntimeInstanceId: string | undefined;
  readonly debugInstances: readonly GraphDebugExecution[];
  readonly debugExecution: GraphDebugExecution | undefined;
  readonly debugEvents: readonly GraphDebugEvent[];
  readonly debugStopped: boolean;
  readonly debugFollow: boolean;
  readonly debugCursor: number;
  readonly debugExecutingNodeId: string | null;
  readonly debugHighlight: GraphDebugHighlight;
  readonly invalidDiagnostics: readonly DocumentDiagnostic[];
  readonly documentDirty: boolean | undefined;
  readonly status: { message: string; error: boolean };
  readonly rootMetadata: { projectId: string; documentType: string; relativePath: string };
  readonly canvasRef: RefObject<HTMLDivElement | null>;
  readonly setActiveGraphId: (graphId: string) => void;
  readonly setContextMenu: Dispatch<SetStateAction<GraphContextMenuState | undefined>>;
  readonly setPicker: Dispatch<SetStateAction<NodePickerState | undefined>>;
  readonly setSubgraphPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setSubgraphPosition: Dispatch<SetStateAction<GraphPosition | undefined>>;
  readonly setInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
  readonly setShowNodeTypes: Dispatch<SetStateAction<boolean>>;
  readonly setShowNodeIds: Dispatch<SetStateAction<boolean>>;
  readonly setDebugDrawerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setFlowInstance: Dispatch<SetStateAction<ReactFlowInstance<GraphFlowNode, GraphFlowEdge> | undefined>>;
  readonly handleNodesChange: (changes: NodeChange<GraphFlowNode>[]) => void;
  readonly handleEdgesChange: (changes: EdgeChange<GraphFlowEdge>[]) => void;
  readonly handleSelectionChange: (selection: { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] }) => void;
  readonly handleConnect: (connection: Connection) => void;
  readonly handleConnectEnd: (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => void;
  readonly handleNodeDragStop: (
    event: MouseEvent | TouchEvent,
    node: GraphFlowNode,
    draggedNodes: GraphFlowNode[],
  ) => void;
  readonly handleNodeContextMenu: (event: ReactMouseEvent, node: GraphFlowNode) => void;
  readonly handleEdgeContextMenu: (event: ReactMouseEvent, edge: GraphFlowEdge) => void;
  readonly handleSelectionContextMenu: (event: ReactMouseEvent) => void;
  readonly handlePaneContextMenu: (event: MouseEvent | ReactMouseEvent) => void;
  readonly openSubgraph: (nodeId: string) => void;
  readonly selectSameType: (nodeId: string) => void;
  readonly applyAutoLayout: () => void;
  readonly createClipboardPayload: () => GraphClipboardPayload | undefined;
  readonly copySelection: () => void;
  readonly duplicateSelection: () => void;
  readonly deleteSelection: () => void;
  readonly addNodeType: (nodeTypeId: string, position?: GraphPosition) => void;
  readonly addConnectedNode: (
    connectionPicker: Extract<NodePickerState, { readonly mode: "connect" }>,
    option: ConnectionNodeOption,
  ) => void;
  readonly addSubgraph: (graphTypeId?: string, nodeTypeId?: string, position?: GraphPosition) => void;
  readonly postOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
  readonly requestDebugInstances: () => void;
  readonly subscribeDebugExecution: (executionId: string) => void;
  readonly unsubscribeDebugExecution: () => void;
  readonly enterDebugReplay: (cursor: number) => void;
  readonly enterDebugFollow: () => void;
}

export function GraphEditorView({
  graphDocument,
  activeGraph,
  activeGraphId,
  catalogRegistry,
  catalogReady,
  pending,
  selected,
  contextMenu,
  replacementCandidates,
  picker,
  subgraphPickerOpen,
  subgraphPosition,
  inspectorCollapsed,
  showNodeTypes,
  showNodeIds,
  revealedElement,
  flowNodes,
  flowEdges,
  debugDrawerOpen,
  debugRuntimeConnected,
  debugRuntimeInstanceId,
  debugInstances,
  debugExecution,
  debugEvents,
  debugStopped,
  debugFollow,
  debugCursor,
  debugExecutingNodeId,
  debugHighlight,
  invalidDiagnostics,
  documentDirty,
  status,
  rootMetadata,
  canvasRef,
  setActiveGraphId,
  setContextMenu,
  setPicker,
  setSubgraphPickerOpen,
  setSubgraphPosition,
  setInspectorCollapsed,
  setShowNodeTypes,
  setShowNodeIds,
  setDebugDrawerOpen,
  setFlowInstance,
  handleNodesChange,
  handleEdgesChange,
  handleSelectionChange,
  handleConnect,
  handleConnectEnd,
  handleNodeDragStop,
  handleNodeContextMenu,
  handleEdgeContextMenu,
  handleSelectionContextMenu,
  handlePaneContextMenu,
  openSubgraph,
  selectSameType,
  applyAutoLayout,
  createClipboardPayload,
  copySelection,
  duplicateSelection,
  deleteSelection,
  addNodeType,
  addConnectedNode,
  addSubgraph,
  postOperations,
  reportStatus,
  requestDebugInstances,
  subscribeDebugExecution,
  unsubscribeDebugExecution,
  enterDebugReplay,
  enterDebugFollow,
}: GraphEditorViewProps): React.JSX.Element {
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
  const duplicateSelectionIssue = copySelectionIssue ?? (!catalogReady ? "目录尚未就绪" : undefined);
  const deletePlan = activeGraph === undefined || selected === undefined
    ? undefined
    : planDeleteSelection(activeGraph, selected, catalogRegistry);
  const deleteSelectionIssue = pending
    ? "正在应用修改"
    : deletePlan === undefined
      ? "当前没有选择内容"
      : deletePlan.nodeIds.length === 0 && deletePlan.edgeIds.length === 0
        ? "所选节点必须由当前图类型保留"
        : undefined;
  const deleteSelectionLabel = deletePlan !== undefined && deletePlan.retainedNodeIds.length > 0
    ? `删除可删除项（保留 ${deletePlan.retainedNodeIds.length} 个必需节点）`
    : "删除所选";
  const addNodeIssue = pending
    ? "正在应用修改"
    : !catalogReady
      ? "目录尚未就绪"
      : availableAtomicNodeTypes.length === 0
        ? "当前图类型没有可用的节点类型"
        : undefined;
  const addSubgraphIssue = pending
    ? "正在应用修改"
    : catalogRegistry.graphTypes.length > 0 && !catalogReady
      ? "目录尚未就绪"
      : catalogRegistry.graphTypes.length > 0 && subgraphOptions.length === 0
        ? "当前图类型没有可用的子图类型"
        : undefined;
  const pasteIssue = pending ? "正在应用修改" : !catalogReady ? "目录尚未就绪" : undefined;
  const saveState = pending
    ? { kind: "pending", label: "修改中…", title: "正在应用图修改" }
    : documentDirty === undefined
      ? { kind: "pending", label: "读取状态…", title: "正在读取文档保存状态" }
      : documentDirty
        ? { kind: "dirty", label: "未保存", title: "文档包含尚未保存到磁盘的修改" }
        : { kind: "saved", label: "已保存", title: "文档内容已保存到磁盘" };

  return (
    <GraphDataTypesContext.Provider value={catalogRegistry.dataTypes}>
      <EditorShell className="graph-app" data-vb-property-density="compact" onClick={() => setContextMenu(undefined)}>
      <EditorToolbar className="graph-toolbar">
        <nav className="graph-breadcrumb" aria-label="图导航面包屑">
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
                  aria-label={inspectorCollapsed ? "展开图检查器" : "折叠图检查器"}
                  title={inspectorCollapsed ? "展开图检查器" : "折叠图检查器"}
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
                    reportStatus={reportStatus}
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
                  cursor={debugCursor}
                  executingNodeId={debugExecutingNodeId}
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
              ? "目录尚未就绪"
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
                graphId: activeGraphId,
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
