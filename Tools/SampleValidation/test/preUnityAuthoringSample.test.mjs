import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { minimatch } from "minimatch";

const require = createRequire(import.meta.url);
const core = require("../../../Core/dist/index.js");
const graph = require("../../../BuiltInExtensions/Graph/dist/index.js");
const entity = require("../../../BuiltInExtensions/Entity/dist/index.js");
const structured = require("../../../BuiltInExtensions/StructuredConfig/dist/index.js");
const table = require("../../../BuiltInExtensions/Table/dist/index.js");
const { ProjectProviderHost } = require("../../../Tools/NodeHost/dist/index.js");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sampleRoot = path.join(repositoryRoot, "Samples", "PreUnityAuthoring");
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
  const projectText = await read("VisualBridge.project.vbjson");
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
    graph.parseGraphCatalog(await read("Catalog/Gameplay.vbgraphcatalog")),
  );
  const graphRegistry = buildOrThrow("Graph Catalog Registry", graph.buildGraphCatalogRegistry([graphCatalog]));
  const graphDocument = parseOrThrow("Graph Document", graph.parseGraphDocument(await read("Logic/Opening.encounter")));
  assertNoErrors("Graph Document", graph.validateGraphDocument(graphDocument, graphRegistry));

  const entityCatalog = parseOrThrow(
    "Entity Catalog",
    entity.parseEntityCatalog(await read("Catalog/Gameplay.vbentitycatalog")),
  );
  const entityRegistry = buildOrThrow("Entity Catalog Registry", entity.buildEntityCatalogRegistry([entityCatalog]));
  const entityDocument = parseOrThrow("Entity Document", entity.parseEntityDocument(await read("Entities/Hero.character")));
  assertNoErrors("Entity Document", entity.validateEntityDocument(entityDocument, entityRegistry));

  const structuredCatalog = parseOrThrow(
    "Structured Catalog",
    structured.parseStructuredCatalog(await read("Catalog/Gameplay.vbstructuredcatalog")),
  );
  const structuredRegistry = buildOrThrow(
    "Structured Catalog Registry",
    structured.buildStructuredCatalogRegistry([structuredCatalog]),
  );
  const structuredDocument = parseOrThrow(
    "Structured Document",
    structured.parseStructuredDocument(await read("Config/Game.settingsdata")),
  );
  assertNoErrors(
    "Structured Document",
    structured.validateStructuredDocument(structuredDocument, structuredRegistry, "sample.settings"),
  );

  const tableCatalog = parseOrThrow(
    "Table Catalog",
    table.parseTableCatalog(await read("Catalog/Gameplay.vbtablecatalog")),
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
