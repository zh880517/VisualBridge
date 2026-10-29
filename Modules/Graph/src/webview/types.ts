import type { Edge, Node } from "@xyflow/react";
import type { FieldDefinition, FieldValueDefinition, JsonValue } from "@visualbridge/module-sdk";
import type { GraphRevealRequest } from "../graphReveal";

export type PortKind = "flow" | "data";
export type PortDirection = "input" | "output";

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

export interface GraphNodeBase {
  readonly id: string;
  readonly title: string;
  readonly position: GraphPosition;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface GraphAtomicNode extends GraphNodeBase {
  readonly kind: "node";
  readonly nodeTypeId: string;
  readonly dynamicPorts: readonly GraphDynamicPort[];
}

export interface GraphDynamicPort {
  readonly id: string;
  readonly groupId: string;
  readonly title: string;
  readonly value: JsonValue;
}

export interface GraphSubgraphNode extends GraphNodeBase {
  readonly kind: "subgraph";
  readonly nodeTypeId?: string;
  readonly subgraphId: string;
  readonly dynamicPorts: readonly GraphDynamicPort[];
}

export type GraphNodeModel = GraphAtomicNode | GraphSubgraphNode;

export interface GraphNodeEndpoint {
  readonly kind: "node";
  readonly nodeId: string;
  readonly portId: string;
}

export interface GraphInterfaceEndpoint {
  readonly kind: "interface";
  readonly portId: string;
}

export type GraphEndpoint = GraphNodeEndpoint | GraphInterfaceEndpoint;

export interface GraphEdgeModel {
  readonly id: string;
  readonly kind: PortKind;
  readonly source: GraphEndpoint;
  readonly target: GraphEndpoint;
}

export interface PortDefinition {
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

export interface DynamicPortGroupDefinition {
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

export interface NodeTypeDefinition {
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

export interface DataTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
  readonly id: string;
  readonly title: string;
  readonly color?: string;
  readonly acceptsAnySource?: boolean;
  readonly accepts: readonly string[];
}

export interface NodeSelector {
  readonly nodeTypeIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly traits?: readonly string[];
}

export interface NodeCountConstraint {
  readonly id: string;
  readonly selector: NodeSelector;
  readonly minInstances?: number;
  readonly maxInstances?: number;
}

export interface InitialNodeDefinition {
  readonly nodeTypeId: string;
  readonly title?: string;
}

export interface GraphTypeDefinition {
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

export interface GraphCatalogRegistry {
  readonly catalogs: readonly {
    readonly catalogId: string;
    readonly title: string;
  }[];
  readonly dataTypes: readonly DataTypeDefinition[];
  readonly graphTypes: readonly GraphTypeDefinition[];
  readonly nodeTypes: readonly NodeTypeDefinition[];
}

export interface GraphDefinition {
  readonly id: string;
  readonly graphTypeId?: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly interfacePorts: readonly PortDefinition[];
  readonly nodes: readonly GraphNodeModel[];
  readonly edges: readonly GraphEdgeModel[];
}

export interface GraphDocument {
  readonly formatVersion: 3;
  readonly documentId: string;
  readonly rootGraphId: string;
  readonly graphs: readonly GraphDefinition[];
}

export interface DocumentDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type GraphOperation =
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

export interface GraphNodeData extends Record<string, unknown> {
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

export interface GraphInterfaceData extends Record<string, unknown> {
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

export type GraphCanvasNodeData = GraphNodeData | GraphInterfaceData;
export type GraphFlowNode = Node<GraphCanvasNodeData, "visualBridgeNode" | "visualBridgeInterface">;

export interface GraphEdgeData extends Record<string, unknown> {
  readonly model: GraphEdgeModel;
}

export type GraphFlowEdge = Edge<GraphEdgeData, "default">;
export interface Selection {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface SelectionSnapshot {
  readonly graphId: string;
  readonly selection: Selection | undefined;
}

export interface SelectionHistoryEntry {
  before: SelectionSnapshot;
  after: SelectionSnapshot;
}

export interface DeleteSelectionPlan {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly retainedNodeIds: readonly string[];
}

export type NodePickerState =
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

export type GraphContextMenuState =
  | { readonly kind: "node"; readonly x: number; readonly y: number; readonly nodeId: string }
  | { readonly kind: "selection"; readonly x: number; readonly y: number }
  | { readonly kind: "graph"; readonly x: number; readonly y: number; readonly position: GraphPosition };

export interface ConnectionNodeOption {
  readonly nodeType: NodeTypeDefinition;
  readonly port: PortDefinition;
}

export interface ConnectionCandidateEndpoint {
  readonly canvasNodeId: string;
  readonly portId: string;
  readonly port: PortDefinition;
}

export interface ConnectionPlan {
  readonly replacementEdgeIds: readonly string[];
  readonly issue?: string;
}

export interface SubgraphTypeOption {
  readonly graphType: GraphTypeDefinition;
  readonly nodeType: NodeTypeDefinition;
}

export interface GraphClipboardPayload {
  readonly format: "visualbridge.graph-clipboard";
  readonly version: 1;
  readonly nodes: readonly GraphAtomicNode[];
  readonly edges: readonly GraphEdgeModel[];
}

export type HostMessage =
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
  | {
      readonly type: "debugFacetSnapshot";
      readonly category: string;
      readonly moduleId: string;
      readonly state: "active" | "unavailable";
      readonly truncated: boolean;
      readonly updates: readonly DebugFacetHistoryEntry[];
    }
  | {
      readonly type: "debugFacetUpdate";
      readonly category: string;
      readonly moduleId: string;
      readonly update: GraphDebugFacetRecord;
    }
  | { readonly type: "debugFacetReset"; readonly category: string }
  /**
   * 旧 `graphExecution*` 执行调试路径（5d8d3e7 的消息面，逐字符保留）。
   *
   * G1a 把渲染源切到了 facet 增量（见 `GraphDebugFacetRecord`），但宿主
   * `GraphExecutionDebugController` 仍在推这批消息；Webview 必须继续消费事件并回
   * `graphDebugAck`，否则 `runtime-e2e` 的"执行调试"用例等不到回执。
   * 除事件累计外，其余字段（实例表 / 执行描述 / 停止标志 / 运行时连接）自 G1a 起
   * 没有消费者，Webview 收到后不留副本；G1b 会连同这些类型一起删除。
   */
  | {
      readonly type: "graphExecutionInstances";
      readonly requestId: string;
      readonly executions: readonly GraphDebugExecution[];
      readonly runtimeConnected: boolean;
      readonly runtimeInstanceId?: string;
    }
  | {
      readonly type: "graphExecutionSubscribed";
      readonly requestId: string;
      readonly ok: boolean;
      readonly execution?: GraphDebugExecution;
      readonly error?: string;
    }
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

/**
 * Graph 调试 facet 的渲染增量（G1a）。
 *
 * 字段对应宿主 `DebugFacetHost` 里 `graphDebugFacet.onRecord` 的返回值；Webview 不解析原始调试
 * 帧，只消费这份已归一的数据。`recordKind === "queryResult"` 的记录不进入事件时间轴。
 */
export interface GraphDebugFacetRecord {
  readonly kind: "graph.debug";
  readonly category: string;
  readonly seq: number;
  readonly sessionId?: string;
  readonly instanceId: string;
  readonly frame: number;
  readonly method: string;
  readonly wireBytes?: number;
  readonly at?: number;
  readonly recordKind?: "event" | "queryResult";
  readonly eventKind: string;
  readonly nodeId?: string;
  readonly outputIndex?: number;
  readonly value?: string;
}

/** 一条历史增量（`seq` 是宿主 `DebugRecord.seq`，单调；用于水化去重）。 */
export interface DebugFacetHistoryEntry {
  readonly seq: number;
  readonly update: GraphDebugFacetRecord;
}

/** 一个执行实例的展示模型（由增量按 `instanceId` 聚合；渲染源，不再来自 `graphExecution` 消息）。 */
export interface GraphDebugInstance {
  readonly instanceId: string;
  readonly state: "running" | "stopped";
  readonly currentNodeId: string | null;
  readonly frameIndex: number;
}

/**
 * 旧路径的执行实例描述（5d8d3e7 的 `GraphDebugExecution`，消息面逐字符保留）。
 *
 * 只描述 `graphExecutionInstances` 等旧消息里的实例；Webview **不再保存**它——
 * 渲染用的是 facet 聚合出来的 `GraphDebugInstance`。G1b 随旧消息一起删除。
 */
export interface GraphDebugExecution {
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
export interface GraphDebugEvent {
  readonly index: number;
  readonly frameIndex: number;
  readonly kind: string;
  readonly nodeId?: string;
  readonly outputIndex?: number;
  readonly value?: string;
}

/** 当前执行节点高亮（时间轴光标推导；replay 为回放态）。 */
export interface GraphDebugHighlight {
  readonly executingNodeId: string | null;
  readonly replay: boolean;
}

export interface VsCodeApi {
  postMessage(message: unknown): void;
}
