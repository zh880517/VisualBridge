import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { minimatch } from "minimatch";
import Ajv2020 from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const core = require("../../../Core/dist/index.js");
const graph = require("../../../BuiltInExtensions/Graph/dist/index.js");
const entity = require("../../../BuiltInExtensions/Entity/dist/index.js");
const structured = require("../../../BuiltInExtensions/StructuredConfig/dist/index.js");
const table = require("../../../BuiltInExtensions/Table/dist/index.js");
const { ProjectProviderHost } = require("../../../Tools/NodeHost/dist/index.js");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sampleRoot = path.join(repositoryRoot, "Samples", "PreUnityAuthoring");
const schemaRoot = path.join(repositoryRoot, "Protocol", "Schema");
const schemaBindings = [
  ["VisualBridge.project.vbjson", "visualbridge-project.schema.json"],
  ["Catalog/Gameplay.vbentitycatalog", "visualbridge-entity-catalog.schema.json"],
  ["Catalog/Gameplay.vbgraphcatalog", "visualbridge-graph-catalog.schema.json"],
  ["Catalog/Gameplay.vbstructuredcatalog", "visualbridge-structured-catalog.schema.json"],
  ["Catalog/Gameplay.vbtablecatalog", "visualbridge-table-catalog.schema.json"],
  ["Config/Game.settingsdata", "visualbridge-structured.schema.json"],
  ["Entities/Hero.character", "visualbridge-entity.schema.json"],
  ["Logic/Opening.encounter", "visualbridge-graph.schema.json"],
];
const schemaCompiler = await createSchemaCompiler();
const authoringSourcePaths = [
  "VisualBridge.project.vbjson",
  "Catalog/Gameplay.vbentitycatalog",
  "Catalog/Gameplay.vbgraphcatalog",
  "Catalog/Gameplay.vbstructuredcatalog",
  "Catalog/Gameplay.vbtablecatalog",
  "Config/Game.settingsdata",
  "Entities/Hero.character",
  "Logic/Opening.encounter",
  "Tables/Skills_A.csv",
];

test("PreUnityAuthoring sample passes official project, catalog, document, and Provider semantics", async (context) => {
  const jsonSources = new Map(await Promise.all(schemaBindings.map(async ([relativePath, schemaFile]) => {
    const text = await read(relativePath);
    assertSchema(relativePath, schemaFile, text);
    return [relativePath, text];
  })));
  const projectText = jsonSources.get("VisualBridge.project.vbjson");
  const projectResult = core.parseProjectFile(projectText);
  assert.equal(projectResult.success, true, formatProjectIssues(projectResult));
  if (!projectResult.success) return;
  const project = projectResult.value;

  const declaredDocuments = [
    ["Logic/Opening.encounter", "graph", "sample.encounter", "Catalog/Gameplay.vbgraphcatalog"],
    ["Entities/Hero.character", "entity", "sample.hero", "Catalog/Gameplay.vbentitycatalog"],
    ["Config/Game.settingsdata", "structured", "sample.settings", "Catalog/Gameplay.vbstructuredcatalog"],
    ["Tables/Skills_A.csv", "table", "sample.skills", "Catalog/Gameplay.vbtablecatalog"],
  ];
  for (const [documentPath, editor, documentTypeId, catalogPath] of declaredDocuments) {
    const matches = core.findMatchingDocumentTypes(project, documentPath, matchesProjectGlob);
    assert.deepEqual(matches.map((match) => [match.editor, match.id]), [[editor, documentTypeId]]);
    assert.deepEqual(matches[0].catalogs, [catalogPath]);
  }

  const graphCatalog = parseOrThrow(
    "Graph Catalog",
    graph.parseGraphCatalog(jsonSources.get("Catalog/Gameplay.vbgraphcatalog")),
  );
  const graphRegistry = buildOrThrow("Graph Catalog Registry", graph.buildGraphCatalogRegistry([graphCatalog]));
  const graphDocument = parseOrThrow("Graph Document", graph.parseGraphDocument(jsonSources.get("Logic/Opening.encounter")));
  assertNoErrors("Graph Document", graph.validateGraphDocument(graphDocument, graphRegistry));
  const rootGraph = graphDocument.graphs.find((candidate) => candidate.id === graphDocument.rootGraphId);
  assert.notEqual(rootGraph, undefined, "Authoring sample must contain its declared root graph.");
  const flowRouterType = graph.resolveNodeType(graphRegistry, "sample.flowRouter");
  assert.notEqual(flowRouterType, undefined, "Authoring sample Catalog must declare the dynamic flow router.");
  const flowOutputGroup = flowRouterType.dynamicPortGroups.find((group) => group.id === "route.outputs");
  assert.notEqual(flowOutputGroup, undefined, "Dynamic flow router must declare its output group.");
  assert.equal(flowOutputGroup.port.kind, "flow");
  assert.equal(flowOutputGroup.port.direction, "output");
  assert.equal(flowOutputGroup.listPortMode, undefined, "Dynamic flow outputs must not be modeled as data-list ports.");
  const flowRouter = rootGraph.nodes.find((node) => node.id === "outcome_router");
  assert.notEqual(flowRouter, undefined, "Root graph must exercise the dynamic flow router.");
  const routedPorts = flowRouter.dynamicPorts.filter((port) => port.groupId === "route.outputs");
  assert.equal(routedPorts.length, 3, "Dynamic flow router must expose three sample flow outputs.");
  const routedPortIds = new Set(routedPorts.map((port) => port.id));
  const routedFlowEdges = rootGraph.edges.filter((edge) => edge.kind === "flow"
    && edge.source.kind === "node"
    && edge.source.nodeId === flowRouter.id
    && routedPortIds.has(edge.source.portId));
  assert.equal(routedFlowEdges.length, 3, "Every sample dynamic flow output must be connected.");
  const subgraphCall = rootGraph.nodes.find((node) => node.id === "victory_call");
  assert.equal(subgraphCall?.kind, "subgraph", "Root graph must visibly exercise a subgraph call node.");
  const childGraph = graphDocument.graphs.find((candidate) => candidate.id === subgraphCall?.subgraphId);
  assert.notEqual(childGraph, undefined, "Subgraph call must resolve to an embedded child graph.");
  assert.notEqual(childGraph.nodes.length, 0, "Embedded child graph must contain test nodes.");
  assert.notEqual(childGraph.edges.length, 0, "Embedded child graph must contain test edges.");
  assert.equal(routedFlowEdges.some((edge) => edge.source.portId === "route_subgraph"
    && edge.target.kind === "node"
    && edge.target.nodeId === subgraphCall.id
    && edge.target.portId === "start"), true, "One dynamic flow output must route into the real subgraph call.");

  const entityCatalog = parseOrThrow(
    "Entity Catalog",
    entity.parseEntityCatalog(jsonSources.get("Catalog/Gameplay.vbentitycatalog")),
  );
  const entityRegistry = buildOrThrow("Entity Catalog Registry", entity.buildEntityCatalogRegistry([entityCatalog]));
  const entityDocument = parseOrThrow("Entity Document", entity.parseEntityDocument(jsonSources.get("Entities/Hero.character")));
  assertNoErrors("Entity Document", entity.validateEntityDocument(entityDocument, entityRegistry));

  const structuredCatalog = parseOrThrow(
    "Structured Catalog",
    structured.parseStructuredCatalog(jsonSources.get("Catalog/Gameplay.vbstructuredcatalog")),
  );
  const structuredRegistry = buildOrThrow(
    "Structured Catalog Registry",
    structured.buildStructuredCatalogRegistry([structuredCatalog]),
  );
  const structuredDocument = parseOrThrow(
    "Structured Document",
    structured.parseStructuredDocument(jsonSources.get("Config/Game.settingsdata")),
  );
  assertNoErrors(
    "Structured Document",
    structured.validateStructuredDocument(structuredDocument, structuredRegistry, "sample.settings"),
  );

  const tableCatalog = parseOrThrow(
    "Table Catalog",
    table.parseTableCatalog(jsonSources.get("Catalog/Gameplay.vbtablecatalog")),
  );
  const tableRegistry = buildOrThrow("Table Catalog Registry", table.buildTableCatalogRegistry([tableCatalog]));
  const tableType = table.resolveTableType(tableRegistry, "sample.skills");
  assert.notEqual(tableType, undefined);
  const tableLayout = table.resolveProjectTableLayout(project);
  assert.notEqual(tableLayout, undefined, "Sample Project must declare the Table module tableLayout option.");
  const tableDocument = parseOrThrow(
    "Table Document",
    table.parseCsvTable(await read("Tables/Skills_A.csv"), tableType, tableLayout, "Skills_A"),
  );
  assertNoErrors("Table Document", table.validateTableDocument(tableDocument, tableType));
  assert.deepEqual(tableDocument.sheets[0].rows.map((row) => row.cells.id), [101, 102]);
  assert.deepEqual(
    tableDocument.sheets[0].rows.map((row) => [row.cells.prerequisiteSkill, row.cells.comboSkills]),
    [[102, [101, 102]], [101, [102, 101]]],
  );
  const tableRowValues = new Set(tableDocument.sheets[0].rows.map((row) => row.cells.id));
  const tableRowDefaults = [
    ...collectReferenceDefaults(graphCatalog.nodeTypes, "table.row"),
    ...collectReferenceDefaults(entityCatalog.entityTypes, "table.row"),
    ...collectReferenceDefaults(entityCatalog.componentTypes, "table.row"),
    ...collectReferenceDefaults(
      tableType.sheets.map((sheet) => ({ id: sheet.id, properties: sheet.columns })),
      "table.row",
    ),
  ];
  assert.notEqual(tableRowDefaults.length, 0, "Authoring sample Catalogs must exercise table.row defaults.");
  tableRowDefaults.forEach(({ path: referencePath, value }) => {
    assert.equal(
      tableRowValues.has(value),
      true,
      `${referencePath} default '${String(value)}' must resolve to a sample.skills row.`,
    );
  });
  const tableRowReferences = [
    ...graph.collectGraphReferences(graphDocument, graphRegistry),
    ...entity.collectEntityReferences(entityDocument, entityRegistry),
    ...table.collectTableReferences(tableDocument, tableType),
  ].filter((occurrence) => occurrence.definition.kind === "table.row");
  assert.notEqual(tableRowReferences.length, 0, "Authoring sample documents must exercise table.row values.");
  tableRowReferences.forEach(({ path: referencePath, value }) => {
    assert.equal(
      tableRowValues.has(value),
      true,
      `${referencePath} value '${String(value)}' must resolve to a sample.skills row.`,
    );
  });

  const providerEntry = path.join(sampleRoot, "Providers", "sample-provider.mjs");
  const host = await ProjectProviderHost.create({
    projectRoot: sampleRoot,
    projectHash: sha256(projectText),
    project,
    allowedEntryPaths: [providerEntry],
    captureSourceManifest: () => Promise.all(authoringSourcePaths.map(async (relativePath) => ({
      path: relativePath,
      hash: sha256(await read(relativePath)),
    }))),
    isDeclaredDocument: (documentTypeId, documentPath) => core.findMatchingDocumentTypes(
      project,
      documentPath,
      matchesProjectGlob,
      { documentTypeId },
    ).length === 1,
  });
  context.after(() => host.dispose());
  assert.equal(host.referenceProviders.length, 1);
  const candidates = await host.referenceProviders[0].search({
    target: { scope: "weapons" },
    query: "sword",
    limit: 10,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.value), ["asset.sword"]);
  const validation = await host.validateDocuments([{
    documentTypeId: "sample.settings",
    path: "Config/Game.settingsdata",
    sourceHash: sha256(await read("Config/Game.settingsdata")),
    content: structuredDocument,
  }]);
  assert.deepEqual(validation.unavailableProviderIds, []);
  assert.deepEqual(validation.diagnostics.map((diagnostic) => diagnostic.code), [
    "sample.provider.reviewDisplayName",
  ]);
});

test("PreUnityAuthoring modules load through ModuleLoader and reproduce the sample semantics", async (context) => {
  // C2：SampleValidation 也必须经 Loader 取模块（不再假定领域包在进程内）。
  // 缺 bundle、hash 不符、注册面不合法都会在这一步失败，因此它同时是"分发产物可用"的门禁。
  const nodeHost = require("../../../Tools/NodeHost/dist/index.js");
  const projectText = await read("VisualBridge.project.vbjson");
  const projectResult = core.parseProjectFile(projectText);
  assert.equal(projectResult.success, true, formatProjectIssues(projectResult));
  if (!projectResult.success) return;
  const project = projectResult.value;

  if (process.env.VB_SKIP_MODULES === "1") {
    // 与宿主同名的开关：CI 不得设置（C2 评审清单 P1），本地排查时可跳过。
    context.diagnostic("VB_SKIP_MODULES=1: skipping bundled module checks for Samples/PreUnityAuthoring.");
    return;
  }

  const loader = await nodeHost.ModuleLoader.create({
    projectRoot: sampleRoot,
    projectId: project.projectId,
    modules: project.modules,
    trusted: true,
  });
  context.after(() => loader.dispose());

  assert.deepEqual(
    loader.result.modules.map((module) => [module.id, module.status]),
    [
      ["visualbridge.graph", "loaded"],
      ["visualbridge.entity", "loaded"],
      ["visualbridge.structured", "loaded"],
      ["visualbridge.table", "loaded"],
    ],
    formatDiagnostics(loader.result.modules.flatMap((module) => module.diagnostics)),
  );

  const facets = new Map();
  for (const module of loader.result.modules) {
    for (const editor of module.registration?.editors ?? []) facets.set(editor.editor, editor);
  }
  assert.deepEqual([...facets.keys()].sort(), ["entity", "graph", "structured", "table"]);

  const declared = [
    ["graph", "Logic/Opening.encounter", "sample.encounter", "Catalog/Gameplay.vbgraphcatalog"],
    ["entity", "Entities/Hero.character", "sample.hero", "Catalog/Gameplay.vbentitycatalog"],
    ["structured", "Config/Game.settingsdata", "sample.settings", "Catalog/Gameplay.vbstructuredcatalog"],
  ];
  for (const [editor, documentPath, documentTypeId, catalogPath] of declared) {
    const registration = facets.get(editor);
    const catalogText = await read(catalogPath);
    const catalog = parseOrThrow(`${editor} catalog`, registration.catalog.parse(catalogText, catalogPath));
    const registry = buildOrThrow(`${editor} catalog registry`, registration.catalog.build([catalog]));
    const parsed = await registration.semantic.parseText(await read(documentPath), {
      projectId: project.projectId,
      documentTypeId,
      path: documentPath,
      sourcePaths: [documentPath],
      registry,
      projectDefinition: project,
      moduleOptions: moduleOptionsOf(project, registration.editor),
    });
    assert.equal(
      parsed.success,
      true,
      `${editor} document: ${formatDiagnostics(parsed.diagnostics ?? [])}`,
    );
    const diagnostics = await registration.semantic.validate(parsed.document, {
      projectId: project.projectId,
      documentTypeId,
      path: documentPath,
      sourcePaths: [documentPath],
      registry,
      projectDefinition: project,
      moduleOptions: moduleOptionsOf(project, registration.editor),
    });
    assertNoErrors(`${editor} document`, diagnostics);
    const references = await registration.semantic.collectReferences(parsed.document, {
      projectId: project.projectId,
      documentTypeId,
      path: documentPath,
      sourcePaths: [documentPath],
      registry,
      projectDefinition: project,
      moduleOptions: moduleOptionsOf(project, registration.editor),
    });
    assert.ok(Array.isArray(references));
  }

  // Table 是多源文档：`parseSources` 是它唯一的入口，`sheetsBySource` 必须回填。
  const table = facets.get("table");
  const tableCatalogText = await read("Catalog/Gameplay.vbtablecatalog");
  const tableCatalog = parseOrThrow(
    "table catalog",
    table.catalog.parse(tableCatalogText, "Catalog/Gameplay.vbtablecatalog"),
  );
  const tableRegistry = buildOrThrow("table catalog registry", table.catalog.build([tableCatalog]));
  const tableParsed = await table.semantic.parseSources(
    [{ path: "Tables/Skills_A.csv", bytes: Buffer.from(await read("Tables/Skills_A.csv"), "utf8") }],
    {
      projectId: project.projectId,
      documentTypeId: "sample.skills",
      path: "Tables/Skills_A.csv",
      sourcePaths: ["Tables/Skills_A.csv"],
      registry: tableRegistry,
      projectDefinition: project,
      moduleOptions: moduleOptionsOf(project, "table"),
    },
  );
  assert.equal(tableParsed.success, true, formatDiagnostics(tableParsed.diagnostics ?? []));
  // 物理分表 id 带 Table 类型前缀（`skills:Skills_A`），宿主据此把引用定位回源文件与分表。
  assert.deepEqual(tableParsed.sheetsBySource, { "Tables/Skills_A.csv": ["skills:Skills_A"] });
  assert.deepEqual(
    tableParsed.document.sheets[0].rows.map((row) => row.cells.id),
    [101, 102],
  );
});

/** 该 editor 所属模块在 Project File 里声明的 `options`（Table 的 `tableLayout` 从这里进 facet）。 */
function moduleOptionsOf(project, editor) {
  const moduleId = project.modules.find((module) => module.id.endsWith(`.${editor}`))?.id;
  return project.modules.find((module) => module.id === moduleId)?.options;
}

async function createSchemaCompiler() {
  const schemas = await Promise.all((await readdir(schemaRoot))
    .filter((name) => name.endsWith(".schema.json"))
    .sort()
    .map(async (name) => [name, JSON.parse(await readFile(path.join(schemaRoot, name), "utf8"))]));
  const compiler = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  compiler.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  compiler.addFormat("date-time", {
    type: "string",
    validate: (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
      && Number.isFinite(Date.parse(value)),
  });
  schemas.forEach(([, schema]) => compiler.addSchema(schema));
  compiler.schemaIds = new Map(schemas.map(([name, schema]) => [name, schema.$id]));
  return compiler;
}

function assertSchema(relativePath, schemaFile, text) {
  const validator = schemaCompiler.getSchema(schemaCompiler.schemaIds.get(schemaFile));
  assert.notEqual(validator, undefined, `${schemaFile} must compile.`);
  const value = JSON.parse(text);
  assert.equal(
    validator(value),
    true,
    `${relativePath} failed ${schemaFile}: ${JSON.stringify(validator.errors)}`,
  );
}

function matchesProjectGlob(pattern, relativePath) {
  return minimatch(relativePath, pattern, { dot: true, nocase: process.platform === "win32" });
}

function parseOrThrow(label, result) {
  assert.equal(result.success, true, `${label}: ${formatDiagnostics(result.diagnostics ?? [])}`);
  if (!result.success) throw new Error(`${label} failed to parse.`);
  assertNoErrors(label, result.diagnostics ?? []);
  return result.document;
}

function buildOrThrow(label, result) {
  return parseOrThrow(label, result);
}

function assertNoErrors(label, diagnostics) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  assert.deepEqual(errors, [], `${label}: ${formatDiagnostics(errors)}`);
}

function formatDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => (
    `${diagnostic.severity} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`
  )).join("\n");
}

function formatProjectIssues(result) {
  return result.success ? "" : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function collectReferenceDefaults(fieldOwners, referenceKind) {
  const results = [];
  const visit = (definition, definitionPath) => {
    if (definition.reference?.kind === referenceKind) {
      results.push({ path: definitionPath, value: definition.defaultValue });
    }
    definition.fields?.forEach((field) => visit(field, `${definitionPath}.fields.${field.id}`));
    if (definition.item !== undefined) visit(definition.item, `${definitionPath}.item`);
  };
  fieldOwners.forEach((owner) => owner.properties.forEach((property) => (
    visit(property, `fieldOwners.${owner.id}.properties.${property.id}`)
  )));
  return results;
}

async function read(relativePath) {
  return readFile(path.join(sampleRoot, ...relativePath.split("/")), "utf8");
}
