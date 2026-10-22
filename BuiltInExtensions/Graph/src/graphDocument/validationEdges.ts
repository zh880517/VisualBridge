// Edge, endpoint and connection cardinality validation.
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  isDataTypeAssignable,
  resolveGraphType,
  resolveNodeType,
  type GraphCatalogRegistry,
  type GraphPortDirection,
} from "../graphCatalog";
import { error, warning } from "./diagnostics";
import { endpointKey } from "./mutable";
import { resolveAtomicNodePort, resolveTypedNodePort } from "./ports";
import type {
  GraphDefinition,
  GraphEdge,
  GraphEndpoint,
  GraphNode,
  GraphResolvedPort,
  GraphSubgraphNode,
} from "./types";


export function validateSemanticEdge(
  graph: GraphDefinition,
  edge: GraphEdge,
  path: string,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  const source = resolveEndpoint(graph, edge.source, nodeById, graphById, catalog);
  const target = resolveEndpoint(graph, edge.target, nodeById, graphById, catalog);
  if (source.issue !== undefined) {
    diagnostics.push(source.unknownNodeType
      ? warning("graph.unresolvedSourcePort", `${path}.source`, source.issue)
      : error("graph.invalidSourcePort", `${path}.source`, source.issue));
  }
  if (source.usedAlias) {
    diagnostics.push(warning("graph.portAlias", `${path}.source.portId`, `Port '${edge.source.portId}' is an alias of '${source.port?.id}'.`));
  }
  if (target.issue !== undefined) {
    diagnostics.push(target.unknownNodeType
      ? warning("graph.unresolvedTargetPort", `${path}.target`, target.issue)
      : error("graph.invalidTargetPort", `${path}.target`, target.issue));
  }
  if (target.usedAlias) {
    diagnostics.push(warning("graph.portAlias", `${path}.target.portId`, `Port '${edge.target.portId}' is an alias of '${target.port?.id}'.`));
  }
  if (source.port === undefined || target.port === undefined) {
    return;
  }
  if (source.port.direction !== "output") {
    diagnostics.push(error("graph.invalidSourceDirection", `${path}.source`, "An edge source must be an output port."));
  }
  if (target.port.direction !== "input") {
    diagnostics.push(error("graph.invalidTargetDirection", `${path}.target`, "An edge target must be an input port."));
  }
  if (source.port.kind !== edge.kind || target.port.kind !== edge.kind) {
    diagnostics.push(error("graph.edgeKindMismatch", path, `Edge kind '${edge.kind}' does not match both ports.`));
  }
  if (
    edge.kind === "data"
    && source.port.dataTypeId !== undefined
    && target.port.dataTypeId !== undefined
    && catalog !== undefined
    && !isDataTypeAssignable(catalog, source.port.dataTypeId, target.port.dataTypeId)
  ) {
    diagnostics.push(error(
      "graph.dataTypeMismatch",
      path,
      `Data type '${source.port.dataTypeId}' cannot connect to '${target.port.dataTypeId}'.`,
    ));
  }
}

export function validateCardinality(
  graph: GraphDefinition,
  graphIndex: number,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  const counts = new Map<string, { readonly count: number; readonly endpoint: GraphEndpoint; readonly role: EndpointRole }>();
  graph.edges.forEach((edge) => {
    ([{ endpoint: edge.source, role: "source" }, { endpoint: edge.target, role: "target" }] as const).forEach(({ endpoint, role }) => {
      const resolved = resolveEndpoint(graph, endpoint, nodeById, graphById, catalog);
      const key = `${role}|${endpointKey(endpoint, resolved.port?.id)}`;
      const current = counts.get(key);
      counts.set(key, { endpoint, role, count: (current?.count ?? 0) + 1 });
    });
  });
  counts.forEach(({ count, endpoint, role }) => {
    const resolved = resolveEndpoint(graph, endpoint, nodeById, graphById, catalog);
    const maxConnections = resolved.port === undefined
      ? undefined
      : getEffectiveMaxConnections(graph, resolved.port, catalog);
    if (maxConnections !== undefined && count > maxConnections) {
      diagnostics.push(error(
        "graph.tooManyConnections",
        `graphs[${graphIndex}].edges`,
        `${endpointKey(endpoint)} has ${count} connections but allows ${maxConnections}.`,
      ));
    }
  });
}

export function getEffectiveMaxConnections(
  graph: GraphDefinition,
  port: GraphResolvedPort,
  catalog: GraphCatalogRegistry | undefined,
): number | undefined {
  const graphType = graph.graphTypeId === undefined || catalog === undefined
    ? undefined
    : resolveGraphType(catalog, graph.graphTypeId);
  const graphTypeLimit = graphType?.portConnectionRules[port.direction] === "single" ? 1 : undefined;
  if (graphTypeLimit === undefined) {
    return port.maxConnections;
  }
  return port.maxConnections === undefined ? graphTypeLimit : Math.min(graphTypeLimit, port.maxConnections);
}

export function validateSemanticDuplicateConnections(
  graph: GraphDefinition,
  graphIndex: number,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog: GraphCatalogRegistry | undefined,
  diagnostics: DocumentDiagnostic[],
): void {
  const connections = new Set<string>();
  graph.edges.forEach((edge, edgeIndex) => {
    const source = resolveEndpoint(graph, edge.source, nodeById, graphById, catalog);
    const target = resolveEndpoint(graph, edge.target, nodeById, graphById, catalog);
    const key = `${edge.kind}|${endpointKey(edge.source, source.port?.id)}|${endpointKey(edge.target, target.port?.id)}`;
    if (connections.has(key)) {
      diagnostics.push(error(
        "graph.duplicateSemanticConnection",
        `graphs[${graphIndex}].edges[${edgeIndex}]`,
        "Connections using canonical and aliased port IDs cannot target the same endpoints twice.",
      ));
    }
    connections.add(key);
  });
}

type EndpointRole = "source" | "target";

export function resolveEndpoint(
  graph: GraphDefinition,
  endpoint: GraphEndpoint,
  nodeById: ReadonlyMap<string, GraphNode>,
  graphById: ReadonlyMap<string, GraphDefinition>,
  catalog?: GraphCatalogRegistry,
): { readonly port?: GraphResolvedPort; readonly issue?: string; readonly unknownNodeType?: boolean; readonly usedAlias?: boolean } {
  if (endpoint.kind === "interface") {
    const port = graph.interfacePorts.find((candidate) => candidate.id === endpoint.portId);
    if (port === undefined) {
      return { issue: `Interface port '${endpoint.portId}' does not exist.` };
    }
    const effectiveDirection: GraphPortDirection = port.direction === "input" ? "output" : "input";
    return {
      port: {
        ...port,
        direction: effectiveDirection,
        ...(effectiveDirection === "input" ? { maxConnections: 1 } : {}),
      },
    };
  }
  const node = nodeById.get(endpoint.nodeId);
  if (node === undefined) {
    return { issue: `Node '${endpoint.nodeId}' does not exist.` };
  }
  if (node.kind === "subgraph") {
    const subgraph = graphById.get(node.subgraphId);
    const nodeType = catalog === undefined || node.nodeTypeId === undefined
      ? undefined
      : resolveNodeType(catalog, node.nodeTypeId);
    const typedPort = nodeType === undefined ? undefined : resolveTypedNodePort(node as GraphSubgraphNode & { readonly nodeTypeId: string }, nodeType, endpoint.portId);
    const port = typedPort ?? subgraph?.interfacePorts.find((candidate) => candidate.id === endpoint.portId);
    return port === undefined
      ? {
          issue: node.nodeTypeId !== undefined && nodeType === undefined
            ? `Subgraph node type '${node.nodeTypeId}' is unknown; port '${endpoint.portId}' cannot be verified.`
            : `Subgraph port '${endpoint.portId}' does not exist.`,
          ...(node.nodeTypeId !== undefined && nodeType === undefined ? { unknownNodeType: true } : {}),
        }
      : { port, usedAlias: port.id !== endpoint.portId };
  }
  if (catalog === undefined) {
    return { issue: `Catalog is unavailable for node type '${node.nodeTypeId}'.`, unknownNodeType: true };
  }
  const nodeType = resolveNodeType(catalog, node.nodeTypeId);
  if (nodeType === undefined) {
    return { issue: `Node type '${node.nodeTypeId}' is unknown; port '${endpoint.portId}' cannot be verified.`, unknownNodeType: true };
  }
  const port = resolveAtomicNodePort(node, nodeType, endpoint.portId);
  return port === undefined
    ? { issue: `Port '${endpoint.portId}' does not exist on '${nodeType.id}'.` }
    : { port, usedAlias: port.id !== endpoint.portId };
}
