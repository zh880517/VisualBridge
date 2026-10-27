import type {
  CatalogSourceDefinition,
  FieldDefinition,
  FieldValueDefinition,
} from "@visualbridge/module-sdk";

export const GRAPH_CATALOG_FORMAT_VERSION = 4;

export type GraphPortKind = "flow" | "data";
export type GraphPortDirection = "input" | "output";
export type GraphPortConnectionMode = "single" | "multiple";
export type GraphListPortMode = "list" | "element";

export interface GraphDataTypeDefinition {
  readonly id: string;
  readonly title: string;
  readonly color?: string;
  readonly acceptsAnySource?: boolean;
  readonly accepts: readonly string[];
}

export interface GraphPortDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly kind: GraphPortKind;
  readonly direction: GraphPortDirection;
  readonly dataTypeId?: string;
  readonly maxConnections?: number;
}

export interface GraphDynamicPortGroupDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly listPortMode?: GraphListPortMode;
  readonly port: {
    readonly kind: GraphPortKind;
    readonly direction: GraphPortDirection;
    readonly dataTypeId?: string;
    readonly maxConnections?: number;
  };
  readonly item: FieldValueDefinition;
  readonly maxItems?: number;
}

export interface GraphNodeSourceDefinition {
  readonly providerId: string;
  readonly assemblyName?: string;
  readonly typeName: string;
  readonly wrapperTypeName?: string;
}

export interface GraphNodeSelector {
  readonly nodeTypeIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly traits?: readonly string[];
}

export interface GraphNodeCountConstraint {
  readonly id: string;
  readonly selector: GraphNodeSelector;
  readonly minInstances?: number;
  readonly maxInstances?: number;
}

export interface GraphInitialNodeDefinition {
  readonly nodeTypeId: string;
  readonly title?: string;
}

export interface GraphTypeDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly usage: "root" | "subgraph" | "any";
  readonly source?: GraphNodeSourceDefinition;
  readonly supportedCatalogIds: readonly string[];
  readonly portConnectionRules: {
    readonly input: GraphPortConnectionMode;
    readonly output: GraphPortConnectionMode;
  };
  readonly allowedNodeSelectors?: readonly GraphNodeSelector[];
  readonly properties: readonly FieldDefinition[];
  readonly nodeConstraints: readonly GraphNodeCountConstraint[];
  readonly initialNodes: readonly GraphInitialNodeDefinition[];
  readonly allowSubgraphs: boolean;
  readonly allowedSubgraphTypeIds?: readonly string[];
}

export interface GraphSubgraphNodeDefinition {
  readonly graphTypeIds?: readonly string[];
}

export interface GraphNodeTypeDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly icon?: string;
  readonly category: string;
  readonly menuPath: readonly string[];
  readonly tags: readonly string[];
  readonly traits: readonly string[];
  readonly source?: GraphNodeSourceDefinition;
  readonly subgraph?: GraphSubgraphNodeDefinition;
  readonly ports: readonly GraphPortDefinition[];
  readonly dynamicPortGroups: readonly GraphDynamicPortGroupDefinition[];
  readonly properties: readonly FieldDefinition[];
}

export interface GraphCatalog {
  readonly formatVersion: typeof GRAPH_CATALOG_FORMAT_VERSION;
  readonly catalogId: string;
  readonly title: string;
  readonly source: CatalogSourceDefinition;
  readonly dataTypes: readonly GraphDataTypeDefinition[];
  readonly graphTypes: readonly GraphTypeDefinition[];
  readonly nodeTypes: readonly GraphNodeTypeDefinition[];
}

export interface GraphCatalogIdentity {
  readonly catalogId: string;
  readonly title: string;
}

export interface RegisteredGraphDataTypeDefinition extends GraphDataTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface RegisteredGraphTypeDefinition extends GraphTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface RegisteredGraphNodeTypeDefinition extends GraphNodeTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface GraphCatalogRegistry {
  readonly catalogs: readonly GraphCatalogIdentity[];
  readonly dataTypes: readonly RegisteredGraphDataTypeDefinition[];
  readonly graphTypes: readonly RegisteredGraphTypeDefinition[];
  readonly nodeTypes: readonly RegisteredGraphNodeTypeDefinition[];
}

export interface GraphNodeSearchOptions {
  readonly query?: string;
  readonly graphTypeId?: string;
  readonly includeSubgraphNodeTypes?: boolean;
  readonly limit?: number;
}

export type GraphCatalogLookup = GraphCatalog | GraphCatalogRegistry;
