// Default Graph document and Graph definition construction.
import type { FieldDefinition } from "@visualbridge/core";
import { createDefaultProperties } from "@visualbridge/core";
import {
  resolveGraphType,
  resolveNodeType,
  type GraphCatalogRegistry,
} from "../graphCatalog";
import {
  GRAPH_DOCUMENT_FORMAT_VERSION,
  type GraphDefinition,
  type GraphDocument,
  type JsonValue,
} from "./types";


export function createEmptyGraphDocument(
  documentId: string,
  rootGraphId: string,
  graphTypeId?: string,
  catalog?: GraphCatalogRegistry,
  createNodeId?: () => string,
): GraphDocument {
  const graph = createGraphDefinition(rootGraphId, "Root", graphTypeId, catalog, createNodeId);
  return {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId,
    rootGraphId,
    graphs: [graph],
  };
}

export function createGraphDefinition(
  graphId: string,
  title: string,
  graphTypeId?: string,
  catalog?: GraphCatalogRegistry,
  createNodeId?: () => string,
): GraphDefinition {
  const resolvedCatalog = catalog ?? EMPTY_CATALOG;
  const graphType = graphTypeId === undefined || catalog === undefined
    ? undefined
    : resolveGraphType(resolvedCatalog, graphTypeId);
  const properties = createDefaultPropertyValues(graphType?.properties ?? []);
  const nodes = graphType === undefined || createNodeId === undefined
    ? []
    : graphType.initialNodes.flatMap((initialNode, index) => {
        const nodeType = resolveNodeType(resolvedCatalog, initialNode.nodeTypeId);
        return nodeType === undefined || nodeType.subgraph !== undefined
          ? []
          : [{
              kind: "node" as const,
              id: createNodeId(),
              nodeTypeId: nodeType.id,
              title: initialNode.title ?? nodeType.title,
              position: { x: 80 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 180 },
              properties: createDefaultPropertyValues(nodeType.properties),
              dynamicPorts: [],
            }];
      });
  return {
    id: graphId,
    ...(graphType === undefined ? {} : { graphTypeId: graphType.id }),
    title,
    properties,
    interfacePorts: [],
    nodes,
    edges: [],
  };
}

export function createDefaultPropertyValues(
  definitions: readonly FieldDefinition[],
): Readonly<Record<string, JsonValue>> {
  return createDefaultProperties(definitions) as Readonly<Record<string, JsonValue>>;
}

export const EMPTY_CATALOG: GraphCatalogRegistry = {
  catalogs: [],
  dataTypes: [],
  graphTypes: [],
  nodeTypes: [],
};
