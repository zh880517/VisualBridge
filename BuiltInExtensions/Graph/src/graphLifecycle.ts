import type {
  DocumentDiagnostic,
  DocumentLifecycleDeleteTarget,
  DocumentOperationResult,
  JsonValue,
  OwnedStableIdentity,
  StableIdentityRemap,
} from "@visualbridge/core";
import type { GraphCatalogRegistry } from "./graphCatalog";
import {
  applyGraphOperations,
  validateGraphDocument,
  type GraphDocument,
  type GraphEndpoint,
  type GraphNode,
} from "./graphDocument";

export type GraphOwnedIdentityKind =
  | "document"
  | "graph"
  | "node"
  | "interfacePort"
  | "dynamicPort"
  | "edge";

export interface GraphOwnedIdentity extends OwnedStableIdentity {
  readonly identityKey: string;
  readonly kind: GraphOwnedIdentityKind;
  readonly collisionScope: string;
  readonly value: string;
}

export type GraphStableIdentityRemap = StableIdentityRemap;

export function collectGraphOwnedIdentities(
  document: GraphDocument,
  documentTypeId: string,
): readonly GraphOwnedIdentity[] {
  return [
    identity("document", "document", documentTypeId, document.documentId, "document", { documentTypeId }),
    ...document.graphs.flatMap((graph) => [
      identity(graphKey(graph.id), "graph", `${documentTypeId}:graph`, graph.id, "graph.element", {
        documentTypeId,
        elementKind: "graph",
      }),
      ...graph.nodes.flatMap((node) => [
        identity(nodeKey(graph.id, node.id), "node", `${documentTypeId}:node`, node.id, "graph.element", {
          documentTypeId,
          elementKind: "node",
        }),
        ...node.dynamicPorts.map((port) => identity(
          dynamicPortKey(graph.id, node.id, port.id),
          "dynamicPort",
          `${documentTypeId}:dynamicPort`,
          port.id,
          "graph.element",
          { documentTypeId, elementKind: "dynamicPort" },
        )),
      ]),
      ...graph.interfacePorts.map((port) => identity(
        interfacePortKey(graph.id, port.id),
        "interfacePort",
        `${documentTypeId}:interfacePort`,
        port.id,
        "graph.element",
        { documentTypeId, elementKind: "interfacePort" },
      )),
      ...graph.edges.map((edge) => identity(edgeKey(graph.id, edge.id), "edge", `${documentTypeId}:edge`, edge.id)),
    ]),
  ];
}

export function remapGraphOwnedIdentities(
  document: GraphDocument,
  documentTypeId: string,
  remaps: readonly GraphStableIdentityRemap[],
  registry: GraphCatalogRegistry,
): DocumentOperationResult<GraphDocument> {
  const identities = collectGraphOwnedIdentities(document, documentTypeId);
  const parsed = requireCompleteRemap(identities, remaps);
  if (!parsed.success) return parsed;
  const byKey = parsed.byKey;
  const graphIds = new Map(document.graphs.map((graph) => [graph.id, to(byKey, graphKey(graph.id))]));
  const graphs = document.graphs.map((graph) => {
    const nodeIds = new Map(graph.nodes.map((node) => [node.id, to(byKey, nodeKey(graph.id, node.id))]));
    const remapEndpoint = (endpoint: GraphEndpoint): GraphEndpoint => {
      if (endpoint.kind === "interface") {
        return { kind: "interface", portId: to(byKey, interfacePortKey(graph.id, endpoint.portId), endpoint.portId) };
      }
      const node = graph.nodes.find((candidate) => candidate.id === endpoint.nodeId);
      const dynamic = node?.dynamicPorts.some((port) => port.id === endpoint.portId) === true;
      return {
        kind: "node",
        nodeId: nodeIds.get(endpoint.nodeId) ?? endpoint.nodeId,
        portId: dynamic && node !== undefined
          ? to(byKey, dynamicPortKey(graph.id, node.id, endpoint.portId))
          : node?.kind === "subgraph"
            ? to(byKey, interfacePortKey(node.subgraphId, endpoint.portId), endpoint.portId)
            : endpoint.portId,
      };
    };
    const nodes: GraphNode[] = graph.nodes.map((node) => ({
      ...node,
      id: to(byKey, nodeKey(graph.id, node.id)),
      ...(node.kind === "subgraph" ? { subgraphId: graphIds.get(node.subgraphId) ?? node.subgraphId } : {}),
      dynamicPorts: node.dynamicPorts.map((port) => ({
        ...port,
        id: to(byKey, dynamicPortKey(graph.id, node.id, port.id)),
      })),
    }));
    return {
      ...graph,
      id: to(byKey, graphKey(graph.id)),
      nodes,
      interfacePorts: graph.interfacePorts.map((port) => ({
        ...port,
        id: to(byKey, interfacePortKey(graph.id, port.id)),
      })),
      edges: graph.edges.map((edge) => ({
        ...edge,
        id: to(byKey, edgeKey(graph.id, edge.id)),
        source: remapEndpoint(edge.source),
        target: remapEndpoint(edge.target),
      })),
    };
  });
  const next: GraphDocument = {
    ...document,
    documentId: to(byKey, "document"),
    rootGraphId: graphIds.get(document.rootGraphId) ?? document.rootGraphId,
    graphs,
  };
  const diagnostics = validateGraphDocument(next, registry);
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? { success: false, diagnostics }
    : { success: true, document: next, diagnostics };
}

export function deleteGraphOwnedTarget(
  document: GraphDocument,
  target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>,
  registry: GraphCatalogRegistry,
): DocumentOperationResult<GraphDocument> {
  if (target.kind !== "graph.element") {
    return { success: false, diagnostics: [error("target", `Graph lifecycle cannot delete '${target.kind}'.`)] };
  }
  if (target.elementKind === "node") {
    return applyGraphOperations(document, [{
      type: "graph.removeNode",
      graphId: target.graphId,
      nodeId: target.elementId,
    }], registry);
  }
  if (target.elementKind === "interfacePort") {
    return applyGraphOperations(document, [{
      type: "graph.removeInterfacePort",
      graphId: target.graphId,
      portId: target.elementId,
    }], registry);
  }
  if (target.elementKind === "dynamicPort") {
    return applyGraphOperations(document, [{
      type: "graph.removeDynamicPort",
      graphId: target.graphId,
      nodeId: target.nodeId,
      portId: target.elementId,
    }], registry);
  }
  if (target.elementId === document.rootGraphId) {
    return { success: false, diagnostics: [error("target.elementId", "The root graph cannot be deleted.")] };
  }
  const owner = document.graphs.flatMap((graph) => graph.nodes.map((node) => ({ graph, node })))
    .find(({ node }) => node.kind === "subgraph" && node.subgraphId === target.elementId);
  if (owner === undefined) {
    return { success: false, diagnostics: [error("target.elementId", `Graph '${target.elementId}' has no owning subgraph node.`)] };
  }
  return applyGraphOperations(document, [{
    type: "graph.removeNode",
    graphId: owner.graph.id,
    nodeId: owner.node.id,
  }], registry);
}

function requireCompleteRemap(
  identities: readonly GraphOwnedIdentity[],
  remaps: readonly GraphStableIdentityRemap[],
): { readonly success: true; readonly byKey: ReadonlyMap<string, GraphStableIdentityRemap> }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] } {
  const diagnostics: DocumentDiagnostic[] = [];
  const byKey = new Map<string, GraphStableIdentityRemap>();
  remaps.forEach((remap, index) => {
    if (byKey.has(remap.identityKey)) {
      diagnostics.push(error(`stableIdRemap[${index}].identityKey`, "Duplicate identity remap key."));
    } else {
      byKey.set(remap.identityKey, remap);
    }
  });
  const expected = new Map(identities.map((entry) => [entry.identityKey, entry]));
  identities.forEach((entry) => {
    const remap = byKey.get(entry.identityKey);
    if (remap === undefined) {
      diagnostics.push(error("stableIdRemap", `Missing remap for '${entry.identityKey}'.`));
    } else if (remap.from !== entry.value) {
      diagnostics.push(error("stableIdRemap", `Remap '${entry.identityKey}' does not match the owned identity.`));
    } else if (typeof remap.to !== "string" || !isStableIdentifier(remap.to) || remap.to === remap.from) {
      diagnostics.push(error("stableIdRemap", `Remap '${entry.identityKey}' requires a different stable string ID.`));
    }
  });
  for (const key of byKey.keys()) {
    if (!expected.has(key)) diagnostics.push(error("stableIdRemap", `Unexpected remap '${key}'.`));
  }
  const targets = new Set<string>();
  remaps.forEach((remap) => {
    const owned = expected.get(remap.identityKey);
    const scope = `${owned?.kind ?? "unknown"}\u0000${owned?.collisionScope ?? "unknown"}\u0000${remap.to}`;
    if (targets.has(scope)) diagnostics.push(error("stableIdRemap", `Duplicate identity target '${remap.to}'.`));
    targets.add(scope);
  });
  return diagnostics.length > 0 ? { success: false, diagnostics } : { success: true, byKey };
}

function identity(
  identityKey: string,
  kind: GraphOwnedIdentityKind,
  collisionScope: string,
  value: string,
  referenceKind?: "document" | "graph.element",
  referenceTarget?: Readonly<Record<string, JsonValue>>,
): GraphOwnedIdentity {
  return {
    identityKey,
    kind,
    collisionScope,
    value,
    ...(referenceKind === undefined || referenceTarget === undefined ? {} : {
      reference: {
        definition: { kind: referenceKind, target: referenceTarget, allowMissing: false },
      },
    }),
  };
}

function graphKey(graphId: string): string { return `graph:${graphId}`; }
function nodeKey(graphId: string, nodeId: string): string { return `node:${graphId}:${nodeId}`; }
function interfacePortKey(graphId: string, portId: string): string { return `interfacePort:${graphId}:${portId}`; }
function dynamicPortKey(graphId: string, nodeId: string, portId: string): string {
  return `dynamicPort:${graphId}:${nodeId}:${portId}`;
}
function edgeKey(graphId: string, edgeId: string): string { return `edge:${graphId}:${edgeId}`; }

function to(
  byKey: ReadonlyMap<string, GraphStableIdentityRemap>,
  key: string,
  fallback?: string,
): string {
  const value = byKey.get(key)?.to;
  return typeof value === "string" ? value : fallback ?? key;
}

function isStableIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function error(path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code: "lifecycle.invalidStableIdRemap", path, message };
}
