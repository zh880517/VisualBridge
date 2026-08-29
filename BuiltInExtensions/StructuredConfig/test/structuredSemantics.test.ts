import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  applyStructuredOperations,
  buildStructuredCatalogRegistry,
  collectStructuredReferences,
  createEmptyStructuredDocument,
  parseStructuredCatalog,
  parseStructuredDocument,
  resolveStructuredConfigType,
  replaceStructuredReferenceValues,
  serializeStructuredCatalog,
  serializeStructuredDocument,
  validateStructuredDocument,
  type StructuredCatalog,
} from "../index";

const fixtureRoot = path.resolve(__dirname, "../../../../TestData/StructuredSemanticProject");
const catalogText = readFileSync(path.join(fixtureRoot, "Catalog/Game.vbstructuredcatalog"), "utf8");
const documentText = readFileSync(path.join(fixtureRoot, "Config/Game.gamesettings"), "utf8");
const documentTypeId = "sample.game.settings";

function load() {
  const parsedCatalog = parseStructuredCatalog(catalogText);
  assert.equal(parsedCatalog.success, true);
  if (!parsedCatalog.success) throw new Error("Catalog fixture failed.");
  const registry = buildStructuredCatalogRegistry([parsedCatalog.document]);
  assert.equal(registry.success, true);
  if (!registry.success) throw new Error("Registry fixture failed.");
  const parsedDocument = parseStructuredDocument(documentText);
  assert.equal(parsedDocument.success, true);
  if (!parsedDocument.success) throw new Error("Document fixture failed.");
  return { catalog: parsedCatalog.document, registry: registry.document, document: parsedDocument.document };
}

test("Structured Catalog Registry resolves canonical IDs and aliases without load-order ambiguity", () => {
  const { catalog, registry } = load();
  assert.equal(resolveStructuredConfigType(registry, "sample.game.settings")?.title, "Game Settings");
  assert.equal(resolveStructuredConfigType(registry, "legacy.game.settings")?.id, "sample.game.settings");
  const conflicting: StructuredCatalog = {
    ...catalog,
    catalogId: "sample.conflict",
    configTypes: [{ ...catalog.configTypes[0]!, id: "other.settings", aliases: ["legacy.game.settings"] }],
  };
  const result = buildStructuredCatalogRegistry([conflicting, catalog]);
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "structuredCatalog.registryIdentityConflict"));
});

test("Structured fields validate full runtime-shaped values and collect cross-document references", () => {
  const { registry, document } = load();
  assert.deepEqual(validateStructuredDocument(document, registry, documentTypeId), []);
  assert.deepEqual(collectStructuredReferences(document, registry, documentTypeId), [{
    definition: {
      kind: "table.row",
      target: { sheetId: "skills", tableTypeId: "sample.table.skills" },
      allowMissing: false,
    },
    value: 101,
    path: "properties.primarySkillId",
  }]);
  const renamed = replaceStructuredReferenceValues(
    document,
    registry,
    documentTypeId,
    new Set(["properties.primarySkillId"]),
    202,
  );
  assert.equal(renamed.success, true);
  assert.equal(renamed.success && renamed.document.properties.primarySkillId, 202);
  const missing = { ...document, properties: { ...document.properties } };
  delete (missing.properties as Record<string, unknown>).maxPlayers;
  assert.ok(validateStructuredDocument(missing, registry, documentTypeId).some(
    (diagnostic) => diagnostic.code === "structured.missingProperty",
  ));
});

test("Structured V1 rejects a redundant document-level Config Type identity", () => {
  const obsolete = JSON.parse(documentText) as Record<string, unknown>;
  obsolete.configTypeId = documentTypeId;
  const result = parseStructuredDocument(JSON.stringify(obsolete));
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === "structured.unknownProperty" && diagnostic.path === "$.configTypeId"));
});

test("Structured Operation batches are focused, canonical, atomic, and deterministic", () => {
  const { catalog, registry, document } = load();
  const changed = applyStructuredOperations(document, [
    { type: "structured.setField", fieldId: "maxPlayers", value: 8 },
    { type: "structured.setField", fieldId: "accent", value: "#112233FF" },
  ], registry, documentTypeId);
  assert.equal(changed.success, true);
  if (!changed.success) throw new Error("Valid operation failed.");
  assert.equal(changed.document.properties.maxPlayers, 8);
  assert.equal(changed.document.properties.accent, "#112233FF");

  const failed = applyStructuredOperations(document, [
    { type: "structured.setField", fieldId: "maxPlayers", value: 8 },
    { type: "structured.setField", fieldId: "accent", value: "invalid" },
  ], registry, documentTypeId);
  assert.equal(failed.success, false);
  assert.equal(document.properties.maxPlayers, 5);

  const alias = applyStructuredOperations(document, [
    { type: "structured.setField", fieldId: "playerLimit", value: 8 },
  ], registry, documentTypeId);
  assert.equal(alias.success, false);
  assert.ok(alias.diagnostics.some((diagnostic) => diagnostic.code === "structured.nonCanonicalFieldId"));

  const missingProperties = { ...document.properties } as Record<string, typeof document.properties[string]>;
  delete missingProperties.maxPlayers;
  const repairable = applyStructuredOperations(
    { ...document, properties: missingProperties },
    [{ type: "structured.setField", fieldId: "accent", value: "#AABBCCFF" }],
    registry,
    documentTypeId,
  );
  assert.equal(repairable.success, true);
  assert.ok(repairable.diagnostics.some((diagnostic) => diagnostic.code === "structured.missingProperty"));

  assert.equal(serializeStructuredDocument(document), documentText.replaceAll("\r\n", "\n"));
  const serializedCatalog = serializeStructuredCatalog(catalog);
  const roundTrip = parseStructuredCatalog(serializedCatalog);
  assert.equal(roundTrip.success, true);
  assert.equal(roundTrip.success && serializeStructuredCatalog(roundTrip.document), serializedCatalog);
});

test("new Structured Documents materialize every Catalog default", () => {
  const { registry } = load();
  const document = createEmptyStructuredDocument("new.settings", "legacy.game.settings", registry);
  assert.deepEqual(Object.keys(document.properties).sort(), [
    "accent",
    "checkpoints",
    "maxPlayers",
    "primarySkillId",
    "spawn",
  ]);
});
