export const GRAPH_REVEAL_MESSAGE_TYPE = "revealGraphElement";
export const GRAPH_REVEAL_RESULT_MESSAGE_TYPE = "graphRevealResult";
export const GRAPH_INTERFACE_INPUT_NODE_ID = "$visualbridge.interface.inputs";
export const GRAPH_INTERFACE_OUTPUT_NODE_ID = "$visualbridge.interface.outputs";

export type GraphRevealElementKind = "graph" | "node" | "interfacePort" | "dynamicPort";

export type GraphRevealTarget =
  | {
      readonly elementKind: "graph";
      readonly elementId: string;
      readonly graphId: string;
    }
  | {
      readonly elementKind: "node";
      readonly elementId: string;
      readonly graphId: string;
      readonly nodeId: string;
    }
  | {
      readonly elementKind: "interfacePort";
      readonly elementId: string;
      readonly graphId: string;
      readonly portId: string;
    }
  | {
      readonly elementKind: "dynamicPort";
      readonly elementId: string;
      readonly graphId: string;
      readonly nodeId: string;
      readonly portId: string;
    };

export interface GraphRevealRequest {
  readonly type: typeof GRAPH_REVEAL_MESSAGE_TYPE;
  readonly requestId: string;
  readonly target: GraphRevealTarget;
}

export interface GraphRevealResult {
  readonly type: typeof GRAPH_REVEAL_RESULT_MESSAGE_TYPE;
  readonly requestId: string;
  readonly found: boolean;
  readonly message?: string;
}

export class GraphRevealMailbox {
  private sequence = 0;
  private ready = false;
  private pending: GraphRevealRequest | undefined;

  public enqueue(target: GraphRevealTarget): GraphRevealRequest {
    this.pending = {
      type: GRAPH_REVEAL_MESSAGE_TYPE,
      requestId: `graph-reveal-${++this.sequence}`,
      target,
    };
    return this.pending;
  }

  public markReady(): void {
    this.ready = true;
  }

  public markUnavailable(): void {
    this.ready = false;
  }

  public get deliverable(): GraphRevealRequest | undefined {
    return this.ready ? this.pending : undefined;
  }

  public acknowledge(requestId: string): boolean {
    if (requestId !== this.pending?.requestId) {
      return false;
    }
    this.pending = undefined;
    return true;
  }
}

export type GraphRevealPlan = GraphRevealTarget & {
  readonly canvasNodeId?: string;
  readonly selectedNodeId?: string;
};

export type GraphRevealPlanResult =
  | { readonly success: true; readonly plan: GraphRevealPlan }
  | { readonly success: false; readonly code: string; readonly message: string };

export interface GraphRevealDocument {
  readonly graphs: readonly GraphRevealGraph[];
}

interface GraphRevealGraph {
  readonly id: string;
  readonly interfacePorts: readonly {
    readonly id: string;
    readonly direction: "input" | "output";
  }[];
  readonly nodes: readonly {
    readonly id: string;
    readonly dynamicPorts: readonly { readonly id: string }[];
  }[];
}

export function readGraphRevealTarget(value: unknown): GraphRevealTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const elementKind = candidate.elementKind;
  const elementId = candidate.elementId;
  const graphId = candidate.graphId;
  const nodeId = candidate.nodeId;
  const portId = candidate.portId;
  if (!isElementKind(elementKind) || !isIdentifier(elementId) || !isIdentifier(graphId)) {
    return undefined;
  }
  if (nodeId !== undefined && !isIdentifier(nodeId)) {
    return undefined;
  }
  if (portId !== undefined && !isIdentifier(portId)) {
    return undefined;
  }
  if (elementKind === "graph") {
    return elementId === graphId && nodeId === undefined && portId === undefined
      ? { elementKind, elementId, graphId }
      : undefined;
  }
  if (elementKind === "node") {
    return nodeId === elementId && portId === undefined
      ? { elementKind, elementId, graphId, nodeId }
      : undefined;
  }
  if (elementKind === "interfacePort") {
    return nodeId === undefined && portId === elementId
      ? { elementKind, elementId, graphId, portId }
      : undefined;
  }
  return nodeId !== undefined && portId === elementId
    ? { elementKind, elementId, graphId, nodeId, portId }
    : undefined;
}

export function planGraphElementReveal(
  document: GraphRevealDocument,
  target: GraphRevealTarget,
): GraphRevealPlanResult {
  const graph = document.graphs.find((candidate) => candidate.id === target.graphId);
  if (graph === undefined) {
    return failure("graph.reveal.missingGraph", `Graph '${target.graphId}' 不存在。`);
  }
  if (target.elementKind === "graph") {
    return { success: true, plan: target };
  }
  if (target.elementKind === "node") {
    if (!graph.nodes.some((node) => node.id === target.nodeId)) {
      return failure("graph.reveal.missingNode", `节点 '${target.nodeId}' 不在 Graph '${graph.id}' 中。`);
    }
    return {
      success: true,
      plan: { ...target, canvasNodeId: target.nodeId, selectedNodeId: target.nodeId },
    };
  }
  if (target.elementKind === "interfacePort") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === target.portId);
    if (port === undefined) {
      return failure("graph.reveal.missingInterfacePort", `接口端口 '${target.portId}' 不在 Graph '${graph.id}' 中。`);
    }
    return {
      success: true,
      plan: {
        ...target,
        canvasNodeId: port.direction === "input"
          ? GRAPH_INTERFACE_INPUT_NODE_ID
          : GRAPH_INTERFACE_OUTPUT_NODE_ID,
      },
    };
  }
  const node = graph.nodes.find((candidate) => candidate.id === target.nodeId);
  if (node === undefined) {
    return failure("graph.reveal.missingNode", `动态端口所属节点 '${target.nodeId}' 不在 Graph '${graph.id}' 中。`);
  }
  if (!node.dynamicPorts.some((port) => port.id === target.portId)) {
    return failure(
      "graph.reveal.missingDynamicPort",
      `动态端口 '${target.portId}' 不在节点 '${node.id}' 中。`,
    );
  }
  return {
    success: true,
    plan: { ...target, canvasNodeId: node.id, selectedNodeId: node.id },
  };
}

function failure(code: string, message: string): GraphRevealPlanResult {
  return { success: false, code, message };
}

function isElementKind(value: unknown): value is GraphRevealElementKind {
  return value === "graph" || value === "node" || value === "interfacePort" || value === "dynamicPort";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
