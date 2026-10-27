// Deterministic Graph document serialization.
import { compareUtf16CodeUnits } from "@visualbridge/module-sdk";
import { sortJsonObject, sortJsonValue } from "./json";
import {
  GRAPH_DOCUMENT_FORMAT_VERSION,
  type GraphDocument,
  type GraphEndpoint,
} from "./types";


export function serializeGraphDocument(document: GraphDocument): string {
  const normalized: GraphDocument = {
    formatVersion: GRAPH_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    rootGraphId: document.rootGraphId,
    graphs: [...document.graphs]
      .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
      .map((graph) => ({
        id: graph.id,
        ...(graph.graphTypeId === undefined ? {} : { graphTypeId: graph.graphTypeId }),
        title: graph.title,
        properties: sortJsonObject(graph.properties),
        interfacePorts: graph.interfacePorts.map((port) => ({
          id: port.id,
          title: port.title,
          kind: port.kind,
          direction: port.direction,
          ...(port.dataTypeId === undefined ? {} : { dataTypeId: port.dataTypeId }),
          ...(port.maxConnections === undefined ? {} : { maxConnections: port.maxConnections }),
          ...(port.dynamic === true ? { dynamic: true } : {}),
        })),
        nodes: [...graph.nodes]
          .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
          .map((node) => node.kind === "node"
            ? {
                kind: node.kind,
                id: node.id,
                nodeTypeId: node.nodeTypeId,
                title: node.title,
                position: { ...node.position },
                properties: sortJsonObject(node.properties),
                dynamicPorts: node.dynamicPorts.map((port) => ({
                  id: port.id,
                  groupId: port.groupId,
                  title: port.title,
                  value: sortJsonValue(port.value),
                })),
              }
            : {
                kind: node.kind,
                id: node.id,
                ...(node.nodeTypeId === undefined ? {} : { nodeTypeId: node.nodeTypeId }),
                subgraphId: node.subgraphId,
                title: node.title,
                position: { ...node.position },
                properties: sortJsonObject(node.properties),
                dynamicPorts: node.dynamicPorts.map((port) => ({
                  id: port.id,
                  groupId: port.groupId,
                  title: port.title,
                  value: sortJsonValue(port.value),
                })),
              }),
        edges: [...graph.edges]
          .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
          .map((edge) => ({
            id: edge.id,
            kind: edge.kind,
            source: serializeEndpoint(edge.source),
            target: serializeEndpoint(edge.target),
          })),
      })),
  };
  return `${JSON.stringify(normalized, undefined, 2)}\n`;
}

export function serializeEndpoint(endpoint: GraphEndpoint): GraphEndpoint {
  return endpoint.kind === "node"
    ? { kind: endpoint.kind, nodeId: endpoint.nodeId, portId: endpoint.portId }
    : { kind: endpoint.kind, portId: endpoint.portId };
}
