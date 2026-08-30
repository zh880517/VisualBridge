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
  const tableDocument = parseOrThrow(
    "Table Document",
    table.parseCsvTable(await read("Tables/Skills_A.csv"), tableType, project.tableLayout, "Skills_A"),
  );
  assertNoErrors("Table Document", table.validateTableDocument(tableDocument, tableType));
  assert.deepEqual(tableDocument.sheets[0].rows.map((row) => row.cells.id), [101, 102]);

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

async function read(relativePath) {
  return readFile(path.join(sampleRoot, ...relativePath.split("/")), "utf8");
}
