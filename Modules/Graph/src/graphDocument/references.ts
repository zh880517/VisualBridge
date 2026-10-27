// Graph reference collection, replacement and dangling-element checks.
import {
  collectFieldReferences,
  collectFieldValueReferences,
  replaceFieldReferenceValues,
  replaceFieldValueReferences,
} from "@visualbridge/module-sdk";
import type { DocumentDiagnostic, DocumentOperationResult, ReferenceOccurrence } from "@visualbridge/module-sdk";
import {
  resolveDynamicPortGroup,
  resolveGraphType,
  resolveNodeType,
  type GraphCatalogRegistry,
} from "../graphCatalog";
import { GRAPH_ELEMENT_REFERENCE_KIND } from "../graphReferences";
import { applyGraphOperations } from "./operations";
import type { GraphDocument, GraphOperation, JsonValue } from "./types";


export function collectGraphReferences(
  document: GraphDocument,
  catalog: GraphCatalogRegistry,
): readonly ReferenceOccurrence[] {
  return document.graphs.flatMap((graph, graphIndex) => {
    const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphType(catalog, graph.graphTypeId);
    const occurrences: ReferenceOccurrence[] = graphType === undefined
      ? []
      : [...collectFieldReferences(graph.properties, graphType.properties, `graphs[${graphIndex}].properties`)];
    graph.nodes.forEach((node, nodeIndex) => {
      if (node.nodeTypeId === undefined) {
        return;
      }
      const nodeType = resolveNodeType(catalog, node.nodeTypeId);
      if (nodeType === undefined) {
        return;
      }
      occurrences.push(...collectFieldReferences(
        node.properties,
        nodeType.properties,
        `graphs[${graphIndex}].nodes[${nodeIndex}].properties`,
      ));
      node.dynamicPorts.forEach((port, portIndex) => {
        const group = resolveDynamicPortGroup(nodeType, port.groupId);
        if (group !== undefined) {
          occurrences.push(...collectFieldValueReferences(
            port.value,
            group.item,
            `graphs[${graphIndex}].nodes[${nodeIndex}].dynamicPorts[${portIndex}].value`,
          ));
        }
      });
    });
    return occurrences;
  });
}

/**
 * 元素删除是单文件 Operation；该检查保证删除后同文档内不再残留指向被删元素的引用。
 * 常规 Reference 校验解析目标时读取写入前的磁盘字节，无法拦截同文档目标消失，
 * 因此删除路径需要在语义层显式比对前后元素集合。
 */
export function findDanglingGraphElementReferenceDiagnostics(
  before: GraphDocument,
  after: GraphDocument,
  catalog: GraphCatalogRegistry,
): readonly DocumentDiagnostic[] {
  const afterElementIds = collectGraphElementIds(after);
  const removedIds = new Set(
    [...collectGraphElementIds(before)].filter((id) => !afterElementIds.has(id)),
  );
  if (removedIds.size === 0) {
    return [];
  }
  const diagnostics: DocumentDiagnostic[] = [];
  for (const occurrence of collectGraphReferences(after, catalog)) {
    if (occurrence.definition.kind !== GRAPH_ELEMENT_REFERENCE_KIND
      || typeof occurrence.value !== "string"
      || !removedIds.has(occurrence.value)) {
      continue;
    }
    diagnostics.push({
      severity: "error",
      code: "graph.removedElementReferenced",
      path: occurrence.path,
      message: `Graph element '${occurrence.value}' is still referenced by this document and cannot be removed.`,
    });
  }
  return diagnostics;
}

export function collectGraphElementIds(document: GraphDocument): Set<string> {
  const ids = new Set<string>();
  for (const graph of document.graphs) {
    ids.add(graph.id);
    for (const port of graph.interfacePorts) {
      ids.add(port.id);
    }
    for (const node of graph.nodes) {
      ids.add(node.id);
      for (const port of node.dynamicPorts) {
        ids.add(port.id);
      }
    }
  }
  return ids;
}

export function replaceGraphReferenceValues(
  document: GraphDocument,
  catalog: GraphCatalogRegistry,
  occurrencePaths: ReadonlySet<string>,
  replacement: string | number,
): DocumentOperationResult<GraphDocument> {
  const operations: GraphOperation[] = [];
  document.graphs.forEach((graph, graphIndex) => {
    const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphType(catalog, graph.graphTypeId);
    if (graphType !== undefined) {
      const replacementResult = replaceFieldReferenceValues(
        graph.properties,
        graphType.properties,
        `graphs[${graphIndex}].properties`,
        (occurrence) => occurrencePaths.has(occurrence.path),
        replacement,
      );
      if (replacementResult.changedPaths.length > 0) {
        operations.push({
          type: "graph.updateGraph",
          graphId: graph.id,
          title: graph.title,
          properties: replacementResult.properties as Readonly<Record<string, JsonValue>>,
        });
      }
    }
    graph.nodes.forEach((node, nodeIndex) => {
      if (node.nodeTypeId === undefined) {
        return;
      }
      const nodeType = resolveNodeType(catalog, node.nodeTypeId);
      if (nodeType === undefined) {
        return;
      }
      const replacementResult = replaceFieldReferenceValues(
        node.properties,
        nodeType.properties,
        `graphs[${graphIndex}].nodes[${nodeIndex}].properties`,
        (occurrence) => occurrencePaths.has(occurrence.path),
        replacement,
      );
      if (replacementResult.changedPaths.length > 0) {
        operations.push({
          type: "graph.updateNode",
          graphId: graph.id,
          nodeId: node.id,
          title: node.title,
          properties: replacementResult.properties as Readonly<Record<string, JsonValue>>,
        });
      }
      node.dynamicPorts.forEach((port, portIndex) => {
        const path = `graphs[${graphIndex}].nodes[${nodeIndex}].dynamicPorts[${portIndex}].value`;
        const group = resolveDynamicPortGroup(nodeType, port.groupId);
        if (group === undefined) {
          return;
        }
        const dynamicReplacement = replaceFieldValueReferences(
          port.value,
          group.item,
          path,
          (occurrence) => occurrencePaths.has(occurrence.path),
          replacement,
        );
        if (dynamicReplacement.changed) {
          operations.push({
            type: "graph.updateDynamicPort",
            graphId: graph.id,
            nodeId: node.id,
            portId: port.id,
            title: port.title,
            value: dynamicReplacement.value as JsonValue,
          });
        }
      });
    });
  });
  return applyGraphOperations(document, operations, catalog);
}
