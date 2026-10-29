import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { minimatch } from "minimatch";
import Ajv2020 from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const core = require("../../../Core/dist/index.js");
const nodeHost = require("../../../Tools/NodeHost/dist/index.js");
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

// 领域语义只经分发产物取得：bundle 只导出 `manifest` / `activate` / `webviews`，
// 具体能力全部挂在 `activate()` 返回的 facet 上（附录 D.2/D.3）。
let loadedSampleModules;
after(() => loadedSampleModules?.loader.dispose());

test("PreUnityAuthoring sample passes official project, catalog, document, and Provider semantics", async () => {
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

  const { facets } = await sampleModules();
  const graph = facets.get("graph");
  const graphCatalog = parseOrThrow(
    "Graph Catalog",
    graph.catalog.parse(jsonSources.get("Catalog/Gameplay.vbgraphcatalog"), "Catalog/Gameplay.vbgraphcatalog"),
  );
  const graphRegistry = buildOrThrow(
    "Graph Catalog Registry",
    graph.catalog.build([graphCatalog]),
  );
  const graphDocument = parseOrThrow(
    "Graph Document",
    await graph.semantic.parseText(
      jsonSources.get("Logic/Opening.encounter"),
      facetContext(project, "graph", "sample.encounter", "Logic/Opening.encounter", graphRegistry),
    ),
  );
  assertNoErrors(
    "Graph Document",
    await graph.semantic.validate(
      graphDocument,
      facetContext(project, "graph", "sample.encounter", "Logic/Opening.encounter", graphRegistry),
    ),
  );
  const rootGraph = graphDocument.graphs.find((candidate) => candidate.id === graphDocument.rootGraphId);
  assert.notEqual(rootGraph, undefined, "Authoring sample must contain its declared root graph.");
  const flowRouterType = resolveDefinitionById(graphRegistry.nodeTypes, "sample.flowRouter");
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

  const entity = facets.get("entity");
  const entityCatalog = parseOrThrow(
    "Entity Catalog",
    entity.catalog.parse(jsonSources.get("Catalog/Gameplay.vbentitycatalog"), "Catalog/Gameplay.vbentitycatalog"),
  );
  const entityRegistry = buildOrThrow(
    "Entity Catalog Registry",
    entity.catalog.build([entityCatalog]),
  );
  const entityDocument = parseOrThrow(
    "Entity Document",
    await entity.semantic.parseText(
      jsonSources.get("Entities/Hero.character"),
      facetContext(project, "entity", "sample.hero", "Entities/Hero.character", entityRegistry),
    ),
  );
  assertNoErrors(
    "Entity Document",
    await entity.semantic.validate(
      entityDocument,
      facetContext(project, "entity", "sample.hero", "Entities/Hero.character", entityRegistry),
    ),
  );

  const structured = facets.get("structured");
  const structuredCatalog = parseOrThrow(
    "Structured Catalog",
    structured.catalog.parse(
      jsonSources.get("Catalog/Gameplay.vbstructuredcatalog"),
      "Catalog/Gameplay.vbstructuredcatalog",
    ),
  );
  const structuredRegistry = buildOrThrow(
    "Structured Catalog Registry",
    structured.catalog.build([structuredCatalog]),
  );
  const structuredDocument = parseOrThrow(
    "Structured Document",
    await structured.semantic.parseText(
      jsonSources.get("Config/Game.settingsdata"),
      facetContext(project, "structured", "sample.settings", "Config/Game.settingsdata", structuredRegistry),
    ),
  );
  assertNoErrors(
    "Structured Document",
    await structured.semantic.validate(
      structuredDocument,
      facetContext(project, "structured", "sample.settings", "Config/Game.settingsdata", structuredRegistry),
    ),
  );

  const table = facets.get("table");
  const tableCatalog = parseOrThrow(
    "Table Catalog",
    table.catalog.parse(jsonSources.get("Catalog/Gameplay.vbtablecatalog"), "Catalog/Gameplay.vbtablecatalog"),
  );
  const tableRegistry = buildOrThrow(
    "Table Catalog Registry",
    table.catalog.build([tableCatalog]),
  );
  // Catalog 的 Document Type 绑定由模块自己判定（表域走生产用的 `resolveTableType`）。
  assert.equal(
    table.catalog.bindingIssue(tableRegistry, "sample.skills"),
    undefined,
    "Sample Table Document Type must bind to a Table Type.",
  );
  const tableType = resolveDefinitionById(tableRegistry.tableTypes, "sample.skills");
  assert.notEqual(tableType, undefined);
  // Project File v2 把行布局交给 Table 模块的 `options.tableLayout`；值必须被真实消费，
  // 否则下面按 dataStartRow 断言的 101/102 行不会成立。
  assert.deepEqual(
    moduleOptionsOf(project, "table"),
    { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
    "Sample Project must declare the Table module tableLayout option.",
  );
  const tableDocument = parseOrThrow(
    "Table Document",
    await table.semantic.parseSources(
      [{ path: "Tables/Skills_A.csv", bytes: Buffer.from(await read("Tables/Skills_A.csv"), "utf8") }],
      facetContext(project, "table", "sample.skills", "Tables/Skills_A.csv", tableRegistry),
    ),
  );
  assertNoErrors(
    "Table Document",
    await table.semantic.validate(
      tableDocument,
      facetContext(project, "table", "sample.skills", "Tables/Skills_A.csv", tableRegistry),
    ),
  );
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
    ...await graph.semantic.collectReferences(
      graphDocument,
      facetContext(project, "graph", "sample.encounter", "Logic/Opening.encounter", graphRegistry),
    ),
    ...await entity.semantic.collectReferences(
      entityDocument,
      facetContext(project, "entity", "sample.hero", "Entities/Hero.character", entityRegistry),
    ),
    ...await table.semantic.collectReferences(
      tableDocument,
      facetContext(project, "table", "sample.skills", "Tables/Skills_A.csv", tableRegistry),
    ),
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
  const host = await nodeHost.ProjectProviderHost.create({
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
  try {
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
  } finally {
    host.dispose();
  }
});

test("PreUnityAuthoring modules load through ModuleLoader and reproduce the sample semantics", async () => {
  // C2 / G2a2：这里断言的是**分发形态**本身——工程声明的 `.vbmodule.js` 必须能被
  // `ModuleLoader` 求值、注册面必须满足宿主契约、每个 editor 必须各有 catalog 与 semantic facet。
  const { loader, facets } = await sampleModules();

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
  assert.deepEqual(
    loader.result.modules.map((module) => [module.manifest.id, module.manifest.editors]),
    [
      ["visualbridge.graph", ["graph"]],
      ["visualbridge.entity", ["entity"]],
      ["visualbridge.structured", ["structured"]],
      ["visualbridge.table", ["table"]],
    ],
  );
  assert.deepEqual([...facets.keys()].sort(), ["entity", "graph", "structured", "table"]);
  for (const [editor, registration] of facets) {
    assert.equal(typeof registration.catalog.parse, "function", `${editor} catalog facet must parse.`);
    assert.equal(typeof registration.catalog.build, "function", `${editor} catalog facet must build.`);
    assert.equal(typeof registration.semantic.validate, "function", `${editor} semantic facet must validate.`);
    assert.equal(typeof registration.semantic.collectReferences, "function", `${editor} semantic facet must collect references.`);
    assert.equal(
      registration.semantic.editor,
      editor,
      `${editor} semantic facet must declare its editor id.`,
    );
    assert.equal(
      registration.semantic.storage,
      editor === "table" ? "sources" : "text",
      `${editor} must declare its storage shape.`,
    );
  }

  // Table 是多源文档：`parseSources` 是它唯一的解析入口，`sheetsBySource` 必须回填。
  const table = facets.get("table");
  const projectResult = core.parseProjectFile(await read("VisualBridge.project.vbjson"));
  assert.equal(projectResult.success, true, formatProjectIssues(projectResult));
  const project = projectResult.value;
  const tableCatalog = parseOrThrow(
    "table catalog",
    table.catalog.parse(await read("Catalog/Gameplay.vbtablecatalog"), "Catalog/Gameplay.vbtablecatalog"),
  );
  const tableRegistry = buildOrThrow("table catalog registry", table.catalog.build([tableCatalog]));
  const tableParsed = await table.semantic.parseSources(
    [{ path: "Tables/Skills_A.csv", bytes: Buffer.from(await read("Tables/Skills_A.csv"), "utf8") }],
    facetContext(project, "table", "sample.skills", "Tables/Skills_A.csv", tableRegistry),
  );
  assert.equal(tableParsed.success, true, formatDiagnostics(tableParsed.diagnostics ?? []));
  // 物理分表 id 带 Table 类型前缀（`skills:Skills_A`），宿主据此把引用定位回源文件与分表。
  assert.deepEqual(tableParsed.sheetsBySource, { "Tables/Skills_A.csv": ["skills:Skills_A"] });
  assert.deepEqual(
    tableParsed.document.sheets[0].rows.map((row) => row.cells.id),
    [101, 102],
  );
});

/** 装载样例工程的四个模块（只装载一次：facet 与文档语义都从这一份实例取）。 */
async function sampleModules() {
  if (loadedSampleModules !== undefined) return loadedSampleModules;
  const projectResult = core.parseProjectFile(await read("VisualBridge.project.vbjson"));
  assert.equal(projectResult.success, true, formatProjectIssues(projectResult));
  if (!projectResult.success) throw new Error("Sample Project failed to parse.");
  const project = projectResult.value;
  const loader = await nodeHost.ModuleLoader.create({
    projectRoot: sampleRoot,
    projectId: project.projectId,
    modules: project.modules,
    trusted: true,
  });
  const facets = new Map();
  for (const module of loader.result.modules) {
    for (const editor of module.registration?.editors ?? []) facets.set(editor.editor, editor);
  }
  loadedSampleModules = { project, loader, facets };
  return loadedSampleModules;
}

/** facet 的只读上下文（`DocumentFacetContext`）：Project、Document Type 与模块 options 都来自工程本身。 */
function facetContext(project, editor, documentTypeId, relativePath, registry) {
  return {
    projectId: project.projectId,
    documentTypeId,
    path: relativePath,
    sourcePaths: [relativePath],
    registry,
    projectDefinition: project,
    moduleOptions: moduleOptionsOf(project, editor),
  };
}

/** 该 editor 所属模块在 Project File 里声明的 `options`（Table 的 `tableLayout` 从这里进 facet）。 */
function moduleOptionsOf(project, editor) {
  const moduleId = project.modules.find((module) => module.id.endsWith(`.${editor}`))?.id;
  return project.modules.find((module) => module.id === moduleId)?.options;
}

/**
 * 按 `id` 或 `aliases` 在 registry 定义表里取定义。
 *
 * bundle 只导出 `manifest` / `activate` / `webviews`，模块内的 `resolveNodeType` /
 * `resolveTableType` 不是分发面；这两个函数本来就只是"id 或别名"查找，这里保持同一判据。
 * 解析是否真的走生产实现由各域的 `validate()` / `bindingIssue()` 覆盖。
 */
function resolveDefinitionById(definitions, id) {
  return definitions.find((definition) => definition.id === id || definition.aliases.includes(id));
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
