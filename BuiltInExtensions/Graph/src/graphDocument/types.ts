// Graph document type and constant definitions.
import type { GraphPortDirection, GraphPortKind } from "../graphCatalog";


export const GRAPH_DOCUMENT_FORMAT_VERSION = 3;
export const GRAPH_EDITOR_ID = "graph";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

interface GraphNodeBase {
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

export type GraphNode = GraphAtomicNode | GraphSubgraphNode;
export type GraphTypedNode = GraphAtomicNode | (GraphSubgraphNode & { readonly nodeTypeId: string });

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

export interface GraphEdge {
  readonly id: string;
  readonly kind: GraphPortKind;
  readonly source: GraphEndpoint;
  readonly target: GraphEndpoint;
}

export interface GraphInterfacePort {
  readonly id: string;
  readonly title: string;
  readonly kind: GraphPortKind;
  readonly direction: GraphPortDirection;
  readonly dataTypeId?: string;
  readonly maxConnections?: number;
  readonly dynamic?: boolean;
}

export interface GraphDefinition {
  readonly id: string;
  readonly graphTypeId?: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly interfacePorts: readonly GraphInterfacePort[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphDocument {
  readonly formatVersion: typeof GRAPH_DOCUMENT_FORMAT_VERSION;
  readonly documentId: string;
  readonly rootGraphId: string;
  readonly graphs: readonly GraphDefinition[];
}

export type GraphOperation =
  | {
      readonly type: "graph.renameElement";
      readonly graphId: string;
      readonly elementKind: "graph" | "node" | "interfacePort" | "dynamicPort";
      readonly elementId: string;
      readonly newElementId: string;
      readonly nodeId?: string;
    }
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
  | {
      readonly type: "graph.addDynamicPort";
      readonly graphId: string;
      readonly nodeId: string;
      readonly port: GraphDynamicPort;
    }
  | {
      readonly type: "graph.updateDynamicPort";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portId: string;
      readonly title: string;
      readonly value: JsonValue;
    }
  | {
      readonly type: "graph.removeDynamicPort";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portId: string;
    }
  | {
      readonly type: "graph.reorderDynamicPorts";
      readonly graphId: string;
      readonly nodeId: string;
      readonly portIds: readonly string[];
    }
  | { readonly type: "graph.addEdge"; readonly graphId: string; readonly edge: GraphEdge }
  | { readonly type: "graph.removeEdge"; readonly graphId: string; readonly edgeId: string }
  | {
      readonly type: "graph.assignType";
      readonly graphId: string;
      readonly graphTypeId: string;
    }
  | {
      readonly type: "graph.updateGraph";
      readonly graphId: string;
      readonly title: string;
      readonly properties: Readonly<Record<string, JsonValue>>;
    }
  | { readonly type: "graph.addInterfacePort"; readonly graphId: string; readonly port: GraphInterfacePort }
  | {
      readonly type: "graph.updateInterfacePort";
      readonly graphId: string;
      readonly portId: string;
      readonly title: string;
    }
  | { readonly type: "graph.removeInterfacePort"; readonly graphId: string; readonly portId: string }
  | { readonly type: "graph.reorderInterfacePorts"; readonly graphId: string; readonly portIds: readonly string[] };

export interface GraphResolvedPort {
  readonly id: string;
  readonly title: string;
  readonly kind: GraphPortKind;
  readonly direction: GraphPortDirection;
  readonly dataTypeId?: string;
  readonly maxConnections?: number;
}

export interface MutableGraphNodeBase {
  id: string;
  title: string;
  position: GraphPosition;
  properties: Record<string, JsonValue>;
}

export interface MutableGraphAtomicNode extends MutableGraphNodeBase {
  kind: "node";
  nodeTypeId: string;
  dynamicPorts: MutableGraphDynamicPort[];
}

export interface MutableGraphDynamicPort {
  id: string;
  groupId: string;
  title: string;
  value: JsonValue;
}

export interface MutableGraphSubgraphNode extends MutableGraphNodeBase {
  kind: "subgraph";
  nodeTypeId?: string;
  subgraphId: string;
  dynamicPorts: MutableGraphDynamicPort[];
}

export type MutableGraphNode = MutableGraphAtomicNode | MutableGraphSubgraphNode;

export interface MutableGraphDefinition {
  id: string;
  graphTypeId?: string;
  title: string;
  properties: Record<string, JsonValue>;
  interfacePorts: MutableGraphInterfacePort[];
  nodes: MutableGraphNode[];
  edges: GraphEdge[];
}

export interface MutableGraphInterfacePort {
  id: string;
  title: string;
  kind: GraphPortKind;
  direction: GraphPortDirection;
  dataTypeId?: string;
  maxConnections?: number;
  dynamic?: boolean;
}

export interface MutableGraphDocument {
  formatVersion: typeof GRAPH_DOCUMENT_FORMAT_VERSION;
  documentId: string;
  rootGraphId: string;
  graphs: MutableGraphDefinition[];
}
