import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  applyGraphOperations,
  buildGraphCatalogRegistry,
  getGraphNodePorts,
  getReplacementCandidates,
  isDataTypeAssignable,
  parseGraphCatalog,
  parseGraphDocument,
  resolveGraphType,
  resolveNodeType,
  searchGraphNodeTypes,
  serializeGraphCatalog,
  serializeGraphDocument,
  validateGraphDocument,
  type GraphAtomicNode,
  type GraphCatalog,
  type GraphCatalogRegistry,
  type GraphDocument,
  type GraphEdge,
} from "../index";

const projectRoot = path.resolve(__dirname, "../../../..", "TestData", "GraphSemanticProject");

interface Fixture {
  readonly catalogs: readonly GraphCatalog[];
  readonly registry: GraphCatalogRegistry;
  readonly document: GraphDocument;
}

function loadFixture(): Fixture {
  const catalogs = ["Common", "Logic", "Blocked"].map((name) => {
    const result = parseGraphCatalog(readFixture("Catalog", `${name}.vbgraphcatalog`));
    assert.equal(result.success, true, formatDiagnostics(result.diagnostics));
    return result.document;
  });
  const registryResult = buildGraphCatalogRegistry(catalogs);
  assert.equal(registryResult.success, true, formatDiagnostics(registryResult.diagnostics));
  const documentResult = parseGraphDocument(readFixture("Graph", "SemanticSample.vbgraph"));
  assert.equal(documentResult.success, true, formatDiagnostics(documentResult.diagnostics));
  return { catalogs, registry: registryResult.document, document: documentResult.document };
}

function readFixture(...segments: string[]): string {
  return readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function formatDiagnostics(diagnostics: readonly { readonly code: string; readonly message: string }[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n");
}

function makeNode(id: string, nodeTypeId: string): GraphAtomicNode {
  return {
    kind: "node",
    id,
    nodeTypeId,
    title: id,
    position: { x: 100, y: 100 },
    properties: {},
    dynamicPorts: [],
  };
}

function makeEdge(
  id: string,
  kind: "flow" | "data",
  sourceNodeId: string,
  sourcePortId: string,
  targetNodeId: string,
  targetPortId: string,
): GraphEdge {
  return {
    id,
    kind,
    source: { kind: "node", nodeId: sourceNodeId, portId: sourcePortId },
    target: { kind: "node", nodeId: targetNodeId, portId: targetPortId },
  };
}

test("Catalog Registry resolves stable IDs and aliases without load-order ambiguity", () => {
  const { catalogs, registry } = loadFixture();
  assert.equal(resolveNodeType(registry, "legacy.step")?.id, "sample.step");
  assert.equal(resolveGraphType(registry, "legacy.root")?.id, "sample.root");
  assert.equal(registry.nodeTypes.find((nodeType) => nodeType.id === "sample.step")?.catalogId, "sample.common");

  const conflictingCatalog: GraphCatalog = {
    ...catalogs[2]!,
    catalogId: "sample.conflict",
    nodeTypes: [{
      ...catalogs[2]!.nodeTypes[0]!,
      id: "sample.conflictingNode",
      aliases: ["legacy.step"],
    }],
  };
  const conflict = buildGraphCatalogRegistry([catalogs[0]!, catalogs[1]!, conflictingCatalog]);
  assert.equal(conflict.success, false);
  assert.ok(conflict.diagnostics.some((diagnostic) => diagnostic.code === "graphCatalogRegistry.duplicateNodeTypeAlias"));
});

test("Catalog and Graph Type restrictions reject unsupported and filtered node types", () => {
  const { document, registry } = loadFixture();
  const blocked = applyGraphOperations(document, [{
    type: "graph.addNode",
    graphId: "root",
    node: makeNode("blocked", "sample.blockedNode"),
  }], registry);
  assert.equal(blocked.success, false);
  assert.ok(blocked.diagnostics.some((diagnostic) => diagnostic.code === "graph.nodeTypeNotAllowed"));

  const hidden = applyGraphOperations(document, [{
    type: "graph.addNode",
    graphId: "root",
    node: makeNode("hidden", "sample.hidden"),
  }], registry);
  assert.equal(hidden.success, false);
  assert.ok(hidden.diagnostics.some((diagnostic) => diagnostic.code === "graph.nodeTypeNotAllowed"));
});

test("flow and data connections enforce kind, direction, and directional cardinality while allowing cycles", () => {
  const { document, registry } = loadFixture();
  const occupiedInput = applyGraphOperations(document, [{
    type: "graph.addEdge",
    graphId: "root",
    edge: makeEdge("occupied", "flow", "step_b", "flow.out", "step_a", "flow.in"),
  }], registry);
  assert.equal(occupiedInput.success, false);
  assert.ok(occupiedInput.diagnostics.some((diagnostic) => diagnostic.code === "graph.tooManyConnections"));

  const cycle = applyGraphOperations(document, [
    { type: "graph.removeEdge", graphId: "root", edgeId: "flow_entry_step_a" },
    {
      type: "graph.addEdge",
      graphId: "root",
      edge: makeEdge("cycle", "flow", "step_b", "flow.out", "step_a", "flow.in"),
    },
  ], registry);
  assert.equal(cycle.success, true, cycle.success ? "" : formatDiagnostics(cycle.diagnostics));

  const wrongDirection = applyGraphOperations(document, [{
    type: "graph.addEdge",
    graphId: "root",
    edge: makeEdge("wrong_direction", "flow", "step_a", "flow.in", "step_b", "flow.out"),
  }], registry);
  assert.equal(wrongDirection.success, false);
  assert.ok(wrongDirection.diagnostics.some((diagnostic) => diagnostic.code === "graph.invalidNewConnection"));

  const wrongKind = applyGraphOperations(document, [{
    type: "graph.addEdge",
    graphId: "root",
    edge: makeEdge("wrong_kind", "flow", "int_source", "value", "int_sink", "value"),
  }], registry);
  assert.equal(wrongKind.success, false);
  assert.ok(wrongKind.diagnostics.some((diagnostic) => diagnostic.code === "graph.invalidNewConnection"));
});

test("data compatibility preserves int, float, any, and stringFromAny directionality", () => {
  const { document, registry } = loadFixture();
  assert.equal(isDataTypeAssignable(registry, "int", "float"), true);
  assert.equal(isDataTypeAssignable(registry, "float", "int"), false);
  assert.equal(isDataTypeAssignable(registry, "int", "stringFromAny"), true);
  assert.equal(isDataTypeAssignable(registry, "stringFromAny", "int"), false);
  assert.equal(isDataTypeAssignable(registry, "any", "int"), true);

  const narrowing = applyGraphOperations(document, [{
    type: "graph.addEdge",
    graphId: "root",
    edge: makeEdge("narrowing", "data", "float_source", "value", "int_sink", "value"),
  }], registry);
  assert.equal(narrowing.success, false);
  assert.ok(narrowing.diagnostics.some((diagnostic) => diagnostic.code === "graph.invalidNewConnection"));

  const strictString = applyGraphOperations(document, [
    { type: "graph.addNode", graphId: "root", node: { ...makeNode("strict_string_2", "sample.stringSink"), properties: { value: "" } } },
    {
      type: "graph.addEdge",
      graphId: "root",
      edge: makeEdge("int_to_string", "data", "int_source", "value", "strict_string_2", "value"),
    },
  ], registry);
  assert.equal(strictString.success, false);
  assert.ok(strictString.diagnostics.some((diagnostic) => diagnostic.code === "graph.invalidNewConnection"));
});

test("List dynamic groups expose stable whole-list and element ports across reorder", () => {
  const { document, registry } = loadFixture();
  const root = document.graphs.find((graph) => graph.id === "root")!;
  const listNode = root.nodes.find((node) => node.id === "list_node")!;
  const portIds = getGraphNodePorts(document, listNode, registry).map((port) => port.id);
  assert.ok(portIds.includes("list.whole"));
  assert.ok(portIds.includes("element_a"));
  assert.ok(portIds.includes("element_b"));
  assert.ok(!portIds.includes("whole_a"));

  const reordered = applyGraphOperations(document, [
    {
      type: "graph.reorderDynamicPorts",
      graphId: "root",
      nodeId: "list_node",
      portIds: ["whole_b", "whole_a", "element_b", "element_a"],
    },
    {
      type: "graph.addEdge",
      graphId: "root",
      edge: makeEdge("element_connection", "data", "int_source", "value", "list_node", "element_a"),
    },
  ], registry);
  assert.equal(reordered.success, true, reordered.success ? "" : formatDiagnostics(reordered.diagnostics));
  const nextRoot = reordered.document.graphs.find((graph) => graph.id === "root")!;
  assert.deepEqual(
    nextRoot.nodes.find((node) => node.id === "list_node")!.dynamicPorts.map((port) => port.id),
    ["whole_b", "whole_a", "element_b", "element_a"],
  );
  assert.equal(nextRoot.edges.find((edge) => edge.id === "element_connection")?.target.kind, "node");
  assert.equal(
    nextRoot.edges.find((edge) => edge.id === "element_connection")?.target.kind === "node"
      ? nextRoot.edges.find((edge) => edge.id === "element_connection")?.target.portId
      : undefined,
    "element_a",
  );
});

test("dynamic subgraph interface types lock on either side and unlock only after all connections are removed", () => {
  const { document, registry } = loadFixture();
  const lockedInside = applyGraphOperations(document, [{
    type: "graph.addEdge",
    graphId: "child",
    edge: {
      id: "child_parameter",
      kind: "data",
      source: { kind: "interface", portId: "parameter" },
      target: { kind: "node", nodeId: "child_int_sink", portId: "value" },
    },
  }], registry);
  assert.equal(lockedInside.success, true, lockedInside.success ? "" : formatDiagnostics(lockedInside.diagnostics));
  assert.equal(lockedInside.document.graphs.find((graph) => graph.id === "child")?.interfacePorts[0]?.dataTypeId, "int");

  const wrongOutside = applyGraphOperations(lockedInside.document, [{
    type: "graph.addEdge",
    graphId: "root",
    edge: makeEdge("float_parameter", "data", "float_source", "value", "subgraph_call", "parameter"),
  }], registry);
  assert.equal(wrongOutside.success, false);

  const connectedOutside = applyGraphOperations(lockedInside.document, [{
    type: "graph.addEdge",
    graphId: "root",
    edge: makeEdge("int_parameter", "data", "int_source", "value", "subgraph_call", "parameter"),
  }], registry);
  assert.equal(connectedOutside.success, true, connectedOutside.success ? "" : formatDiagnostics(connectedOutside.diagnostics));

  const removedInside = applyGraphOperations(connectedOutside.document, [
    { type: "graph.removeEdge", graphId: "child", edgeId: "child_parameter" },
  ], registry);
  assert.equal(removedInside.success, true);
  assert.equal(removedInside.document.graphs.find((graph) => graph.id === "child")?.interfacePorts[0]?.dataTypeId, "int");

  const removedAll = applyGraphOperations(removedInside.document, [
    { type: "graph.removeEdge", graphId: "root", edgeId: "int_parameter" },
  ], registry);
  assert.equal(removedAll.success, true);
  assert.equal(removedAll.document.graphs.find((graph) => graph.id === "child")?.interfacePorts[0]?.dataTypeId, "any");
});

test("safe node replacement is lossless and excludes incompatible candidates", () => {
  const { document, registry } = loadFixture();
  const candidateIds = getReplacementCandidates(document, "root", "step_a", registry).map((candidate) => candidate.id);
  assert.ok(candidateIds.includes("sample.step.safe"));
  assert.ok(!candidateIds.includes("sample.step.unsafe"));

  const replaced = applyGraphOperations(document, [{
    type: "graph.replaceNodeType",
    graphId: "root",
    nodeId: "step_a",
    nodeTypeId: "sample.step.safe",
  }], registry);
  assert.equal(replaced.success, true, replaced.success ? "" : formatDiagnostics(replaced.diagnostics));
  const node = replaced.document.graphs.find((graph) => graph.id === "root")?.nodes.find((candidate) => candidate.id === "step_a");
  assert.equal(node?.nodeTypeId, "sample.step.safe");
  assert.deepEqual(node?.properties, { label: "A" });
  assert.equal(replaced.document.graphs.find((graph) => graph.id === "root")?.edges.length, 5);
});

test("GraphOperation batches are atomic when a later operation fails", () => {
  const { document, registry } = loadFixture();
  const originalText = serializeGraphDocument(document);
  const result = applyGraphOperations(document, [
    { type: "graph.moveNode", graphId: "root", nodeId: "step_a", position: { x: 999, y: 999 } },
    { type: "graph.removeEdge", graphId: "root", edgeId: "missing" },
  ], registry);
  assert.equal(result.success, false);
  assert.equal(serializeGraphDocument(document), originalText);
});

test("Graph and Catalog serialization is deterministic while interface and dynamic order stay explicit", () => {
  const { catalogs, document } = loadFixture();
  const shuffled = JSON.parse(JSON.stringify(document)) as GraphDocument;
  const mutableGraphs = shuffled.graphs as unknown as Array<GraphDocument["graphs"][number]>;
  mutableGraphs.reverse();
  for (const graph of mutableGraphs) {
    (graph.nodes as unknown as Array<typeof graph.nodes[number]>).reverse();
    (graph.edges as unknown as Array<typeof graph.edges[number]>).reverse();
  }
  const text = serializeGraphDocument(shuffled);
  const reparsed = parseGraphDocument(text);
  assert.equal(reparsed.success, true, formatDiagnostics(reparsed.diagnostics));
  assert.equal(serializeGraphDocument(reparsed.document), text);
  assert.ok(text.indexOf('"id": "child"') < text.indexOf('"id": "root"'));
  assert.ok(text.indexOf('"id": "whole_a"') < text.indexOf('"id": "whole_b"'));

  const catalogText = serializeGraphCatalog(catalogs[0]!);
  const reparsedCatalog = parseGraphCatalog(catalogText);
  assert.equal(reparsedCatalog.success, true, formatDiagnostics(reparsedCatalog.diagnostics));
  assert.equal(serializeGraphCatalog(reparsedCatalog.document), catalogText);
});

test("node search uses shared Registry metadata, aliases, Graph Type filters, and stable ordering", () => {
  const { registry } = loadFixture();
  const aliasResults = searchGraphNodeTypes(registry, { query: "legacy.step", graphTypeId: "legacy.root" });
  assert.deepEqual(aliasResults.map((nodeType) => nodeType.id), ["sample.step"]);

  const hiddenResults = searchGraphNodeTypes(registry, { query: "Hidden", graphTypeId: "sample.root" });
  assert.deepEqual(hiddenResults, []);
  const blockedResults = searchGraphNodeTypes(registry, { query: "Blocked", graphTypeId: "sample.root" });
  assert.deepEqual(blockedResults, []);

  const sourceResults = searchGraphNodeTypes(registry, {
    query: "data source",
    graphTypeId: "sample.root",
    includeSubgraphNodeTypes: false,
    limit: 2,
  });
  assert.equal(sourceResults.length, 2);
  assert.deepEqual([...sourceResults].map((nodeType) => nodeType.id), [...sourceResults].map((nodeType) => nodeType.id).sort());
});

test("the fixed semantic sample remains valid", () => {
  const { document, registry } = loadFixture();
  const errors = validateGraphDocument(document, registry).filter((diagnostic) => diagnostic.severity === "error");
  assert.deepEqual(errors, []);
});
