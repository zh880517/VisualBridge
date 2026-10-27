// Public Graph document validation entry point.
import type { DocumentDiagnostic } from "@visualbridge/module-sdk";
import type { GraphCatalogRegistry } from "../graphCatalog";
import { error } from "./diagnostics";
import type { GraphDefinition, GraphDocument, GraphNode, GraphSubgraphNode } from "./types";
import { validateCardinality, validateSemanticDuplicateConnections, validateSemanticEdge } from "./validationEdges";
import {
  validateAtomicNode,
  validateGraphType,
  validateNodeAllowed,
  validateNodeConstraints,
  validateStructure,
  validateSubgraphNode,
} from "./validationStructure";


export function validateGraphDocument(
  document: GraphDocument,
  catalog?: GraphCatalogRegistry,
): readonly DocumentDiagnostic[] {
  const diagnostics = validateStructure(document);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return diagnostics;
  }

  const graphById = new Map(document.graphs.map((graph) => [graph.id, graph]));
  const ownerByGraphId = new Map<string, { readonly graph: GraphDefinition; readonly node: GraphSubgraphNode }>();
  document.graphs.forEach((graph) => graph.nodes.forEach((node) => {
    if (node.kind === "subgraph") {
      ownerByGraphId.set(node.subgraphId, { graph, node });
    }
  }));
  document.graphs.forEach((graph, graphIndex) => {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const graphPath = `graphs[${graphIndex}]`;
    const graphType = validateGraphType(graph, graphPath, document, ownerByGraphId, catalog, diagnostics);
    if (catalog !== undefined) {
      const dataTypeIds = new Set(["any", ...catalog.dataTypes.map((dataType) => dataType.id)]);
      graph.interfacePorts.forEach((port, portIndex) => {
        if (port.dataTypeId !== undefined && !dataTypeIds.has(port.dataTypeId)) {
          diagnostics.push(error(
            "graph.unknownInterfaceDataType",
            `graphs[${graphIndex}].interfacePorts[${portIndex}].dataTypeId`,
            `Data type '${port.dataTypeId}' is not declared by the Graph Catalog.`,
          ));
        }
      });
    }
    graph.interfacePorts.forEach((port, portIndex) => {
      if (port.dynamic === true && graph.id === document.rootGraphId) {
        diagnostics.push(error(
          "graph.rootDynamicInterfacePort",
          `graphs[${graphIndex}].interfacePorts[${portIndex}].dynamic`,
          "Dynamic data parameters are only supported by embedded subgraphs.",
        ));
      }
      if (port.dynamic === true && port.dataTypeId === "any") {
        const connectedInside = graph.edges.some((edge) =>
          edge.kind === "data"
          && (edge.source.kind === "interface" && edge.source.portId === port.id
            || edge.target.kind === "interface" && edge.target.portId === port.id),
        );
        const owner = ownerByGraphId.get(graph.id);
        const connectedOutside = owner !== undefined && owner.graph.edges.some((edge) =>
          edge.kind === "data"
          && (edge.source.kind === "node" && edge.source.nodeId === owner.node.id && edge.source.portId === port.id
            || edge.target.kind === "node" && edge.target.nodeId === owner.node.id && edge.target.portId === port.id),
        );
        if (connectedInside || connectedOutside) {
          diagnostics.push(error(
            "graph.unresolvedDynamicInterfaceType",
            `graphs[${graphIndex}].interfacePorts[${portIndex}].dataTypeId`,
            "A connected dynamic interface port must resolve to a concrete data type.",
          ));
        }
      }
    });
    graph.nodes.forEach((node, nodeIndex) => {
      if (node.kind === "node") {
        validateAtomicNode(node, `graphs[${graphIndex}].nodes[${nodeIndex}]`, catalog, diagnostics);
      } else {
        validateSubgraphNode(node, `${graphPath}.nodes[${nodeIndex}]`, graphById, catalog, diagnostics);
      }
      validateNodeAllowed(node, `${graphPath}.nodes[${nodeIndex}]`, graphType, catalog, diagnostics);
    });
    validateNodeConstraints(graph, graphPath, graphType, catalog, diagnostics);
    graph.edges.forEach((edge, edgeIndex) => {
      validateSemanticEdge(
        graph,
        edge,
        `graphs[${graphIndex}].edges[${edgeIndex}]`,
        nodeById,
        graphById,
        catalog,
        diagnostics,
      );
    });
    validateSemanticDuplicateConnections(graph, graphIndex, nodeById, graphById, catalog, diagnostics);
    validateCardinality(graph, graphIndex, nodeById, graphById, catalog, diagnostics);
  });
  return diagnostics;
}
