import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ReferenceService } from "@visualbridge/core";
import {
  applyGraphOperations,
  buildGraphCatalogRegistry,
  collectGraphReferences,
  collectGraphOwnedIdentities,
  createDefaultPropertyValues,
  createGraphElementReferenceProvider,
  getGraphNodePorts,
  getReplacementCandidates,
  graphDocumentAdapter,
  graphTextDocumentCodec,
  isDataTypeAssignable,
  parseGraphCatalog,
  parseGraphDocument,
  replaceGraphReferenceValues,
  remapGraphOwnedIdentities,
  renameGraphDocumentId,
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

test("Graph semantic adapter composes the established parser, validator, operation and serializer", async () => {
  const fixture = loadFixture();
  const context = { registry: fixture.registry };
  assert.deepEqual(
    graphDocumentAdapter.validate(fixture.document, context),
    validateGraphDocument(fixture.document, fixture.registry),
  );
  const parsed = await graphTextDocumentCodec.parse(serializeGraphDocument(fixture.document), context);
  assert.equal(parsed.success, true);
  assert.equal(
    await graphTextDocumentCodec.render(fixture.document, "", context),
    serializeGraphDocument(fixture.document),
  );
});

test("Graph copy remaps every owned identity and structural endpoint deterministically", () => {
  const { document, registry } = loadFixture();
  const identities = collectGraphOwnedIdentities(document, "sample.graph.logic");
  const remapped = remapGraphOwnedIdentities(
    document,
    "sample.graph.logic",
    identities.map((entry) => ({
      identityKey: entry.identityKey,
      from: entry.value,
      to: `${entry.value}.copy`,
    })),
    registry,
  );
  assert.equal(remapped.success, true, remapped.success ? "" : formatDiagnostics(remapped.diagnostics));
  if (!remapped.success) return;
  assert.equal(remapped.document.documentId, `${document.documentId}.copy`);
  assert.equal(remapped.document.rootGraphId, `${document.rootGraphId}.copy`);
  assert.deepEqual(
    collectGraphOwnedIdentities(remapped.document, "sample.graph.logic").map((entry) => entry.value).sort(),
    identities.map((entry) => `${entry.value}.copy`).sort(),
  );
  assert.equal(
    remapGraphOwnedIdentities(document, "sample.graph.logic", [], registry).success,
    false,
  );
});

test("Graph copy retargets parent edges that use remapped child interface ports", () => {
  const { document, registry } = loadFixture();
  const connected = applyGraphOperations(document, [{
    type: "graph.addEdge",
    graphId: "root",
    edge: {
      id: "copy_subgraph_input",
      kind: "data",
      source: { kind: "node", nodeId: "int_source", portId: "value" },
      target: { kind: "node", nodeId: "subgraph_call", portId: "parameter" },
    },
  }], registry);
  assert.equal(connected.success, true, connected.success ? "" : formatDiagnostics(connected.diagnostics));
  if (!connected.success) return;
  const identities = collectGraphOwnedIdentities(connected.document, "sample.graph.logic");
  assert.equal(new Set(identities.filter((entry) => entry.kind === "edge").map((entry) => entry.collisionScope)).size, 1);
  const remapped = remapGraphOwnedIdentities(
    connected.document,
    "sample.graph.logic",
    identities.map((entry) => ({
      identityKey: entry.identityKey,
      from: entry.value,
      to: `${entry.value}.copy`,
    })),
    registry,
  );
  assert.equal(remapped.success, true, remapped.success ? "" : formatDiagnostics(remapped.diagnostics));
  if (!remapped.success) return;
  const root = remapped.document.graphs.find((graph) => graph.id === "root.copy")!;
  const edge = root.edges.find((candidate) => candidate.id === "copy_subgraph_input.copy")!;
  assert.equal(edge.target.kind === "node" && edge.target.nodeId, "subgraph_call.copy");
  assert.equal(edge.target.portId, "parameter.copy");
});

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

test("graph element references preserve complete graph, node, and port locations", async () => {
  const { document } = loadFixture();
  const provider = createGraphElementReferenceProvider(async () => [{
    projectId: "sample",
    documentTypeId: "sample.graph",
    path: "Graph/SemanticSample.vbgraph",
    document,
  }]);
  const service = new ReferenceService([provider]);
  const dynamicDefinition = {
    kind: "graph.element",
    target: {
      documentTypeId: "sample.graph",
      elementKind: "dynamicPort",
    },
    allowMissing: false,
  } as const;
  const dynamic = await service.resolve(dynamicDefinition, "element_a");
  assert.equal(dynamic.status, "resolved");
  assert.deepEqual(dynamic.candidates[0]?.location, {
    projectId: "sample",
    documentTypeId: "sample.graph",
    path: "Graph/SemanticSample.vbgraph",
    documentId: "semantic-sample",
    elementKind: "dynamicPort",
    elementId: "element_a",
    graphId: "root",
    nodeId: "list_node",
    portId: "element_a",
  });
  const graphResults = await service.search({
    kind: "graph.element",
    target: { documentTypeId: "sample.graph", elementKind: "graph" },
    allowMissing: false,
  }, "child", 10);
  assert.deepEqual(graphResults.map((candidate) => candidate.value), ["child"]);
  const invalidTarget = await service.validate([{
    definition: {
      kind: "graph.element",
      target: { documentTypeId: "sample.graph", elementKind: "node", graphId: "root" },
      allowMissing: false,
    },
    value: "step_a",
    path: "properties.node",
  }]);
  assert.equal(invalidTarget[0]?.code, "reference.invalidTarget");
});

test("Graph document IDs rename without changing contained element identities", () => {
  const { document, registry } = loadFixture();
  const renamed = renameGraphDocumentId(document, "semantic-sample-renamed", registry);
  assert.equal(renamed.success, true);
  assert.equal(renamed.success && renamed.document.documentId, "semantic-sample-renamed");
  assert.equal(renamed.success && renamed.document.rootGraphId, document.rootGraphId);
  assert.equal(renameGraphDocumentId(document, "invalid id", registry).success, false);
});

test("graph.renameElement updates every structural identity and connected endpoint atomically", () => {
  const { document, registry } = loadFixture();
  const connected = applyGraphOperations(document, [{
    type: "graph.addEdge",
    graphId: "child",
    edge: {
      id: "interface_to_sink",
      kind: "data",
      source: { kind: "interface", portId: "parameter" },
      target: { kind: "node", nodeId: "child_int_sink", portId: "value" },
    },
  }, {
    type: "graph.addEdge",
    graphId: "root",
    edge: {
      id: "source_to_child",
      kind: "data",
      source: { kind: "node", nodeId: "int_source", portId: "value" },
      target: { kind: "node", nodeId: "subgraph_call", portId: "parameter" },
    },
  }], registry);
  assert.equal(connected.success, true, connected.success ? "" : formatDiagnostics(connected.diagnostics));
  if (!connected.success) return;
  const renamed = applyGraphOperations(connected.document, [{
    type: "graph.renameElement",
    graphId: "child",
    elementKind: "graph",
    elementId: "child",
    newElementId: "child_renamed",
  }, {
    type: "graph.renameElement",
    graphId: "child_renamed",
    elementKind: "interfacePort",
    elementId: "parameter",
    newElementId: "input_value",
  }, {
    type: "graph.renameElement",
    graphId: "root",
    elementKind: "node",
    elementId: "int_source",
    newElementId: "int_source_renamed",
  }, {
    type: "graph.renameElement",
    graphId: "root",
    elementKind: "dynamicPort",
    nodeId: "list_node",
    elementId: "element_a",
    newElementId: "element_first",
  }], registry);
  assert.equal(renamed.success, true, renamed.success ? "" : formatDiagnostics(renamed.diagnostics));
  if (!renamed.success) return;
  const child = renamed.document.graphs.find((graph) => graph.id === "child_renamed")!;
  const root = renamed.document.graphs.find((graph) => graph.id === "root")!;
  const call = root.nodes.find((node) => node.id === "subgraph_call");
  assert.equal(call?.kind === "subgraph" && call.subgraphId, "child_renamed");
  assert.equal(child.interfacePorts[0]?.id, "input_value");
  assert.equal(child.edges[0]?.source.kind === "interface" && child.edges[0].source.portId, "input_value");
  assert.equal(root.edges.find((edge) => edge.id === "source_to_child")?.target.portId, "input_value");
  const renamedSource = root.edges.find((edge) => edge.id === "data_int_float")?.source;
  assert.equal(renamedSource?.kind === "node" && renamedSource.nodeId, "int_source_renamed");
  const list = root.nodes.find((node) => node.id === "list_node")!;
  assert.ok(list.dynamicPorts.some((port) => port.id === "element_first"));
});

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

  const inserted = applyGraphOperations(document, [
    {
      type: "graph.addDynamicPort",
      graphId: "root",
      nodeId: "list_node",
      port: { id: "whole_inserted", groupId: "list.whole", title: "Inserted", value: 0 },
    },
    {
      type: "graph.reorderDynamicPorts",
      graphId: "root",
      nodeId: "list_node",
      portIds: ["whole_a", "whole_inserted", "whole_b", "element_a", "element_b"],
    },
  ], registry);
  assert.equal(inserted.success, true, inserted.success ? "" : formatDiagnostics(inserted.diagnostics));
  assert.deepEqual(
    inserted.document.graphs.find((graph) => graph.id === "root")!
      .nodes.find((node) => node.id === "list_node")!.dynamicPorts.map((port) => port.id),
    ["whole_a", "whole_inserted", "whole_b", "element_a", "element_b"],
  );
});

test("interface parameters can be atomically inserted and reordered", () => {
  const { document, registry } = loadFixture();
  const result = applyGraphOperations(document, [
    {
      type: "graph.addInterfacePort",
      graphId: "child",
      port: {
        id: "inserted",
        title: "Inserted",
        kind: "data",
        direction: "input",
        dataTypeId: "any",
        dynamic: true,
      },
    },
    {
      type: "graph.reorderInterfacePorts",
      graphId: "child",
      portIds: ["inserted", "parameter"],
    },
  ], registry);
  assert.equal(result.success, true, result.success ? "" : formatDiagnostics(result.diagnostics));
  assert.deepEqual(
    result.document.graphs.find((graph) => graph.id === "child")!.interfacePorts.map((port) => port.id),
    ["inserted", "parameter"],
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

test("Graph properties preserve declarative table-row reference contracts", () => {
  const { catalogs, document } = loadFixture();
  const common = catalogs[0]!;
  const referencedCommon: GraphCatalog = {
    ...common,
    nodeTypes: common.nodeTypes.map((nodeType) => nodeType.id !== "sample.step" ? nodeType : {
      ...nodeType,
      properties: [...nodeType.properties, {
        id: "skillId",
        aliases: [],
        title: "Skill",
        valueType: "number",
        dataTypeId: "int",
        defaultValue: 101,
        fields: [],
        editor: { kind: "reference", readOnly: false, integer: true, options: [] },
        reference: {
          kind: "table.row",
          target: { tableTypeId: "sample.table.skills", sheetId: "skills" },
          allowMissing: false,
        },
      }],
    }),
  };
  const registryResult = buildGraphCatalogRegistry([referencedCommon, ...catalogs.slice(1)]);
  assert.equal(registryResult.success, true, formatDiagnostics(registryResult.diagnostics));
  const referencedDocument: GraphDocument = {
    ...document,
    graphs: document.graphs.map((graph) => graph.id !== "root" ? graph : {
      ...graph,
      nodes: graph.nodes.map((node) => node.id !== "step_a" ? node : {
        ...node,
        properties: { ...node.properties, skillId: 101 },
      }),
    }),
  };
  assert.deepEqual(collectGraphReferences(referencedDocument, registryResult.document)
    .filter((entry) => entry.path.endsWith(".skillId"))
    .map((entry) => ({ value: entry.value, path: entry.path })), [
      { value: 101, path: "graphs[1].nodes[1].properties.skillId" },
      { value: 101, path: "graphs[1].nodes[2].properties.skillId" },
    ]);
  const renamed = replaceGraphReferenceValues(
    referencedDocument,
    registryResult.document,
    new Set(["graphs[1].nodes[1].properties.skillId"]),
    202,
  );
  assert.equal(renamed.success, true, formatDiagnostics(renamed.diagnostics));
  assert.equal(renamed.success && renamed.document.graphs[1]?.nodes[1]?.properties.skillId, 202);
  assert.equal(renamed.success && renamed.document.graphs[1]?.nodes[2]?.properties.skillId, undefined);
  const serialized = serializeGraphCatalog(referencedCommon);
  const reparsed = parseGraphCatalog(serialized);
  assert.equal(reparsed.success, true, formatDiagnostics(reparsed.diagnostics));
  assert.equal(serializeGraphCatalog(reparsed.document), serialized);
});

test("Graph fields reuse the complete shared Form definition recursively", () => {
  const { catalogs, document } = loadFixture();
  const fixtureStep = catalogs[0]!.nodeTypes.find((nodeType) => nodeType.id === "sample.step")!;
  const sharedProperties = fixtureStep.properties.filter((property) => property.id !== "label");
  const complexItem = {
    valueType: "object" as const,
    dataTypeId: "sample.settings",
    defaultValue: { targetId: 101, weights: [1, 2] },
    fields: [{
      id: "targetId",
      aliases: [],
      title: "Target",
      valueType: "number" as const,
      dataTypeId: "int",
      defaultValue: 101,
      fields: [],
      editor: { kind: "reference" as const, readOnly: false, integer: true, options: [] },
      reference: {
        kind: "table.row",
        target: { tableTypeId: "sample.table.skills", sheetId: "skills" },
        allowMissing: false,
      },
    }, {
      id: "weights",
      aliases: [],
      title: "Weights",
      valueType: "array" as const,
      defaultValue: [1, 2],
      fields: [],
      item: { valueType: "number" as const, defaultValue: 0, fields: [] },
    }],
  };
  const common: GraphCatalog = {
    ...catalogs[0]!,
    dataTypes: [...catalogs[0]!.dataTypes, { id: "sample.settings", title: "Settings", accepts: [], acceptsAnySource: false }],
    nodeTypes: catalogs[0]!.nodeTypes.map((nodeType) => nodeType.id !== "sample.step" ? nodeType : {
      ...nodeType,
      dynamicPortGroups: [...nodeType.dynamicPortGroups, {
        id: "complex-items",
        aliases: [],
        title: "Complex Items",
        listPortMode: "element" as const,
        port: { kind: "data" as const, direction: "input" as const, dataTypeId: "sample.settings", maxConnections: 1 },
        item: complexItem,
      }],
    }),
  };
  const logic: GraphCatalog = {
    ...catalogs[1]!,
    graphTypes: catalogs[1]!.graphTypes.map((graphType) => graphType.id !== "sample.root" ? graphType : {
      ...graphType,
      properties: [...graphType.properties, sharedProperties[0]!],
    }),
  };
  const registryResult = buildGraphCatalogRegistry([common, logic, catalogs[2]!]);
  assert.equal(registryResult.success, true, formatDiagnostics(registryResult.diagnostics));

  assert.deepEqual(createDefaultPropertyValues(sharedProperties), {
    tint: "#336699FF",
    mode: "walk",
    settings: { enabled: true, targetId: 101, targets: [102, 103], position: { x: 1, y: 2, z: 3 } },
    payload: { nested: [true, 42, "text"] },
  });
  const withSharedFields: GraphDocument = {
    ...document,
    graphs: document.graphs.map((graph) => graph.id !== "root" ? graph : {
      ...graph,
      properties: { ...graph.properties, tint: "#11223344" },
      nodes: graph.nodes.map((node) => node.id !== "step_a" ? node : {
        ...node,
        properties: { ...node.properties, ...createDefaultPropertyValues(sharedProperties) },
        dynamicPorts: [...node.dynamicPorts, {
          id: "complex-a",
          groupId: "complex-items",
          title: "Complex A",
          value: { targetId: 101, weights: [1, 2] },
        }],
      }),
    }),
  };
  assert.deepEqual(
    validateGraphDocument(withSharedFields, registryResult.document).filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );

  const rootIndex = withSharedFields.graphs.findIndex((graph) => graph.id === "root");
  const root = withSharedFields.graphs[rootIndex]!;
  const stepIndex = root.nodes.findIndex((node) => node.id === "step_a");
  const propertyPath = `graphs[${rootIndex}].nodes[${stepIndex}].properties.settings.targets[1]`;
  const dynamicPath = `graphs[${rootIndex}].nodes[${stepIndex}].dynamicPorts[0].value.targetId`;
  const occurrences = collectGraphReferences(withSharedFields, registryResult.document);
  assert.equal(occurrences.some((occurrence) => occurrence.path === propertyPath && occurrence.value === 103), true);
  assert.equal(occurrences.some((occurrence) => occurrence.path === dynamicPath && occurrence.value === 101), true);
  const replaced = replaceGraphReferenceValues(
    withSharedFields,
    registryResult.document,
    new Set([propertyPath, dynamicPath]),
    202,
  );
  assert.equal(replaced.success, true, formatDiagnostics(replaced.diagnostics));
  const replacedText = replaced.success ? serializeGraphDocument(replaced.document) : "";
  assert.match(replacedText, /"targets": \[\n\s+102,\n\s+202/u);
  assert.match(replacedText, /"targetId": 202/u);

  const invalid: GraphDocument = {
    ...withSharedFields,
    graphs: withSharedFields.graphs.map((graph) => graph.id !== "root" ? graph : {
      ...graph,
      nodes: graph.nodes.map((node) => node.id !== "step_a" ? node : {
        ...node,
        properties: {
          ...node.properties,
          tint: "blue",
          settings: { enabled: true, targetId: 1.5, targets: [102], position: { x: 1, y: "bad", z: 3 } },
        },
      }),
    }),
  };
  const invalidDiagnostics = validateGraphDocument(invalid, registryResult.document);
  assert.ok(invalidDiagnostics.some((diagnostic) => diagnostic.code === "field.invalidColor"));
  assert.ok(invalidDiagnostics.some((diagnostic) => diagnostic.code === "field.invalidInteger"));
  assert.ok(invalidDiagnostics.some((diagnostic) => diagnostic.code === "field.invalidValueType"));

  const serialized = serializeGraphCatalog(common);
  const reparsed = parseGraphCatalog(serialized);
  assert.equal(reparsed.success, true, formatDiagnostics(reparsed.diagnostics));
  assert.equal(serializeGraphCatalog(reparsed.document), serialized);
});

test("Graph Catalog rejects legacy versions and the removed required-property dialect", () => {
  const { catalogs } = loadFixture();
  const catalog = JSON.parse(serializeGraphCatalog(catalogs[0]!)) as Record<string, unknown>;
  catalog.formatVersion = 3;
  const legacy = parseGraphCatalog(JSON.stringify(catalog));
  assert.equal(legacy.success, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "graphCatalog.unsupportedVersion"));

  catalog.formatVersion = 4;
  const nodeTypes = catalog.nodeTypes as Array<{ properties: Array<Record<string, unknown>> }>;
  nodeTypes.find((nodeType) => nodeType.properties.length > 0)!.properties[0]!.required = true;
  const required = parseGraphCatalog(JSON.stringify(catalog));
  assert.equal(required.success, false);
  assert.ok(required.diagnostics.some((diagnostic) => (
    diagnostic.code === "field.unknownDefinitionKey" && diagnostic.message.includes("required")
  )));
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
