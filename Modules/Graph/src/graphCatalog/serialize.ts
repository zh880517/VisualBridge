import {
  compareUtf16CodeUnits,
  serializeCatalogSourceDefinition,
  serializeFieldDefinition,
  serializeFieldValueDefinition,
} from "@visualbridge/module-sdk";
import type { GraphCatalog, GraphNodeSelector, GraphNodeSourceDefinition } from "./types";
import { GRAPH_CATALOG_FORMAT_VERSION } from "./types";

export function serializeGraphCatalog(catalog: GraphCatalog): string {
  const normalized = {
    formatVersion: GRAPH_CATALOG_FORMAT_VERSION,
    catalogId: catalog.catalogId,
    title: catalog.title,
    source: serializeCatalogSourceDefinition(catalog.source),
    dataTypes: [...catalog.dataTypes]
      .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
      .map((dataType) => ({
        id: dataType.id,
        title: dataType.title,
        ...(dataType.color === undefined ? {} : { color: dataType.color }),
        ...(dataType.acceptsAnySource ? { acceptsAnySource: true } : {}),
        accepts: [...dataType.accepts].sort(compareUtf16CodeUnits),
      })),
    graphTypes: [...catalog.graphTypes]
      .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
      .map((graphType) => ({
        id: graphType.id,
        aliases: [...graphType.aliases].sort(compareUtf16CodeUnits),
        title: graphType.title,
        ...(graphType.description === undefined ? {} : { description: graphType.description }),
        usage: graphType.usage,
        ...(graphType.source === undefined ? {} : { source: serializeNodeSource(graphType.source) }),
        supportedCatalogIds: [...graphType.supportedCatalogIds].sort(compareUtf16CodeUnits),
        portConnectionRules: {
          input: graphType.portConnectionRules.input,
          output: graphType.portConnectionRules.output,
        },
        ...(graphType.allowedNodeSelectors === undefined ? {} : {
          allowedNodeSelectors: graphType.allowedNodeSelectors.map(serializeNodeSelector),
        }),
        properties: graphType.properties.map(serializeFieldDefinition),
        nodeConstraints: graphType.nodeConstraints.map((constraint) => ({
          id: constraint.id,
          selector: serializeNodeSelector(constraint.selector),
          ...(constraint.minInstances === undefined ? {} : { minInstances: constraint.minInstances }),
          ...(constraint.maxInstances === undefined ? {} : { maxInstances: constraint.maxInstances }),
        })),
        initialNodes: graphType.initialNodes.map((node) => ({
          nodeTypeId: node.nodeTypeId,
          ...(node.title === undefined ? {} : { title: node.title }),
        })),
        allowSubgraphs: graphType.allowSubgraphs,
        ...(graphType.allowedSubgraphTypeIds === undefined ? {} : {
          allowedSubgraphTypeIds: [...graphType.allowedSubgraphTypeIds].sort(compareUtf16CodeUnits),
        }),
      })),
    nodeTypes: [...catalog.nodeTypes]
      .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
      .map((nodeType) => ({
        id: nodeType.id,
        aliases: [...nodeType.aliases].sort(compareUtf16CodeUnits),
        title: nodeType.title,
        ...(nodeType.icon === undefined ? {} : { icon: nodeType.icon }),
        category: nodeType.category,
        menuPath: [...nodeType.menuPath],
        tags: [...nodeType.tags].sort(compareUtf16CodeUnits),
        traits: [...nodeType.traits].sort(compareUtf16CodeUnits),
        ...(nodeType.source === undefined ? {} : { source: serializeNodeSource(nodeType.source) }),
        ...(nodeType.subgraph === undefined ? {} : {
          subgraph: nodeType.subgraph.graphTypeIds === undefined
            ? {}
            : { graphTypeIds: [...nodeType.subgraph.graphTypeIds].sort(compareUtf16CodeUnits) },
        }),
        ports: nodeType.ports.map((port) => ({
            id: port.id,
            aliases: [...port.aliases].sort(compareUtf16CodeUnits),
            title: port.title,
            ...(port.description === undefined ? {} : { description: port.description }),
            kind: port.kind,
            direction: port.direction,
            ...(port.dataTypeId === undefined ? {} : { dataTypeId: port.dataTypeId }),
            ...(port.maxConnections === undefined ? {} : { maxConnections: port.maxConnections }),
          })),
        dynamicPortGroups: nodeType.dynamicPortGroups.map((group) => ({
            id: group.id,
            aliases: [...group.aliases].sort(compareUtf16CodeUnits),
            title: group.title,
            ...(group.description === undefined ? {} : { description: group.description }),
            ...(group.listPortMode === undefined ? {} : { listPortMode: group.listPortMode }),
            port: {
              kind: group.port.kind,
              direction: group.port.direction,
              ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
              ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
            },
            item: serializeFieldValueDefinition(group.item),
            ...(group.maxItems === undefined ? {} : { maxItems: group.maxItems }),
          })),
        properties: nodeType.properties.map(serializeFieldDefinition),
      })),
  };
  return `${JSON.stringify(normalized, undefined, 2)}\n`;
}

function serializeNodeSource(source: GraphNodeSourceDefinition): GraphNodeSourceDefinition {
  return {
    providerId: source.providerId,
    ...(source.assemblyName === undefined ? {} : { assemblyName: source.assemblyName }),
    typeName: source.typeName,
    ...(source.wrapperTypeName === undefined ? {} : { wrapperTypeName: source.wrapperTypeName }),
  };
}

function serializeNodeSelector(selector: GraphNodeSelector): GraphNodeSelector {
  return {
    ...(selector.nodeTypeIds === undefined ? {} : { nodeTypeIds: [...selector.nodeTypeIds].sort(compareUtf16CodeUnits) }),
    ...(selector.tags === undefined ? {} : { tags: [...selector.tags].sort(compareUtf16CodeUnits) }),
    ...(selector.traits === undefined ? {} : { traits: [...selector.traits].sort(compareUtf16CodeUnits) }),
  };
}
