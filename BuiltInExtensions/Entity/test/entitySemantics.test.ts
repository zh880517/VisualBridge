import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ReferenceService, findMatchingDocumentTypes, parseProjectFile } from "@visualbridge/core";
import {
  applyEntityOperations,
  buildEntityCatalogRegistry,
  collectEntityReferences,
  collectEntityOwnedIdentities,
  createEntityComponentReferenceProvider,
  entityDocumentAdapter,
  entityTextDocumentCodec,
  parseEntityCatalog,
  parseEntityDocument,
  renameEntityDocumentId,
  remapEntityOwnedIdentities,
  resolveEntityComponentType,
  resolveEntityType,
  replaceEntityReferenceValues,
  searchEntityComponentTypes,
  serializeEntityCatalog,
  serializeEntityDocument,
  validateEntityDocument,
  type EntityCatalog,
  type EntityCatalogRegistry,
  type EntityDocument,
} from "../index";

const projectRoot = path.resolve(__dirname, "../../../..", "TestData", "EntitySemanticProject");

interface Fixture {
  readonly catalogs: readonly EntityCatalog[];
  readonly registry: EntityCatalogRegistry;
  readonly document: EntityDocument;
}

function loadFixture(): Fixture {
  const catalogs = ["Common", "Gameplay"].map((name) => {
    const result = parseEntityCatalog(readFixture("Catalog", `${name}.vbentitycatalog`));
    assert.equal(result.success, true, formatDiagnostics(result.diagnostics));
    return result.document;
  });
  const registryResult = buildEntityCatalogRegistry(catalogs);
  assert.equal(registryResult.success, true, formatDiagnostics(registryResult.diagnostics));
  const documentResult = parseEntityDocument(readFixture("Config", "Entities", "Player.herojson"));
  assert.equal(documentResult.success, true, formatDiagnostics(documentResult.diagnostics));
  return { catalogs, registry: registryResult.document, document: documentResult.document };
}

test("Entity semantic adapter composes the established document semantics", async () => {
  const fixture = loadFixture();
  const context = { registry: fixture.registry };
  assert.deepEqual(
    entityDocumentAdapter.validate(fixture.document, context),
    validateEntityDocument(fixture.document, fixture.registry),
  );
  const parsed = await entityTextDocumentCodec.parse(serializeEntityDocument(fixture.document), context);
  assert.equal(parsed.success, true);
  assert.equal(
    await entityTextDocumentCodec.render(fixture.document, "", context),
    serializeEntityDocument(fixture.document),
  );
});

function readFixture(...segments: string[]): string {
  return readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function formatDiagnostics(diagnostics: readonly { readonly code: string; readonly message: string }[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n");
}

test("Entity document IDs rename through validated document semantics", () => {
  const { document, registry } = loadFixture();
  const renamed = renameEntityDocumentId(document, "sample.entity.player.renamed", registry);
  assert.equal(renamed.success, true);
  assert.equal(renamed.success && renamed.document.documentId, "sample.entity.player.renamed");
  assert.equal(renameEntityDocumentId(document, "invalid id", registry).success, false);
});

test("Entity copy requires and applies a complete Document and Component remap", () => {
  const { document, registry } = loadFixture();
  const identities = collectEntityOwnedIdentities(document, "sample.entity.player");
  const result = remapEntityOwnedIdentities(
    document,
    "sample.entity.player",
    identities.map((entry) => ({
      identityKey: entry.identityKey,
      from: entry.value,
      to: `${entry.value}.copy`,
    })),
    registry,
  );
  assert.equal(result.success, true);
  assert.deepEqual(
    result.success ? result.document.components.map((component) => component.id) : [],
    document.components.map((component) => `${component.id}.copy`),
  );
  assert.equal(remapEntityOwnedIdentities(document, "sample.entity.player", [], registry).success, false);
});

test("Entity Catalog Registry resolves stable IDs, aliases, and cross-Catalog groups", () => {
  const { catalogs, registry } = loadFixture();
  assert.equal(resolveEntityType(registry, "legacy.entity.player")?.id, "sample.entity.player");
  assert.equal(resolveEntityComponentType(registry, "legacy.component.health")?.id, "sample.component.health");
  assert.equal(resolveEntityComponentType(registry, "sample.component.health")?.catalogId, "sample.entity.gameplay");

  const conflictingCatalog: EntityCatalog = {
    ...catalogs[1]!,
    catalogId: "sample.entity.conflict",
    componentTypes: [{
      ...catalogs[1]!.componentTypes[0]!,
      id: "sample.component.conflict",
      aliases: ["legacy.component.health"],
    }],
  };
  const conflict = buildEntityCatalogRegistry([catalogs[0]!, catalogs[1]!, conflictingCatalog]);
  assert.equal(conflict.success, false);
  assert.ok(conflict.diagnostics.some((diagnostic) => diagnostic.code === "entityCatalog.registryIdentityConflict"));
});

test("Entity Type group restrictions drive shared Component search", () => {
  const { registry } = loadFixture();
  assert.deepEqual(
    searchEntityComponentTypes(registry, { entityTypeId: "sample.entity.player", query: "component", limit: 20 })
      .map((componentType) => componentType.id),
    ["sample.component.attack", "sample.component.health", "sample.component.move"],
  );
  assert.deepEqual(
    searchEntityComponentTypes(registry, { entityTypeId: "sample.entity.player", query: "Visual" }),
    [],
  );
  assert.deepEqual(
    searchEntityComponentTypes(registry, { entityTypeId: "legacy.entity.player", query: "legacy.component.health" })
      .map((componentType) => componentType.id),
    ["sample.component.health"],
  );
});

test("shared fields validate numeric, color, list, and custom object structures", () => {
  const { document, registry } = loadFixture();
  assert.deepEqual(validateEntityDocument(document, registry).filter((diagnostic) => diagnostic.severity === "error"), []);
  const references = collectEntityReferences(document, registry);
  assert.deepEqual(references.filter((reference) => reference.path === "properties.primarySkillId"), [{
    definition: {
      kind: "table.row",
      target: {
        documentTypeId: "sample.table.skills",
        sheetId: "skills",
        tableTypeId: "sample.table.skills",
      },
      allowMissing: false,
    },
    value: 101,
    path: "properties.primarySkillId",
  }]);
  assert.deepEqual(references.filter((reference) => reference.path === "properties.primaryComponentId"), [{
    definition: {
      kind: "entity.component",
      target: { documentTypeId: "hero-config" },
      allowMissing: false,
    },
    value: "health",
    path: "properties.primaryComponentId",
  }]);
  const renamed = replaceEntityReferenceValues(
    document,
    registry,
    new Set(["properties.primarySkillId"]),
    202,
  );
  assert.equal(renamed.success, true, formatDiagnostics(renamed.diagnostics));
  assert.equal(renamed.success && renamed.document.properties.primarySkillId, 202);

  const invalidLevel = applyEntityOperations(document, [{
    type: "entity.setProperty",
    propertyId: "level",
    value: 1.5,
  }], registry);
  assert.equal(invalidLevel.success, false);
  assert.ok(invalidLevel.diagnostics.some((diagnostic) => diagnostic.code === "field.invalidInteger"));

  const invalidColor = applyEntityOperations(document, [{
    type: "entity.setProperty",
    propertyId: "tint",
    value: "blue",
  }], registry);
  assert.equal(invalidColor.success, false);
  assert.ok(invalidColor.diagnostics.some((diagnostic) => diagnostic.code === "field.invalidColor"));

  const invalidStruct = applyEntityOperations(document, [{
    type: "entity.setComponentProperty",
    componentId: "move",
    propertyId: "direction",
    value: { x: 0, y: "bad", z: 1 },
  }], registry);
  assert.equal(invalidStruct.success, false);
  assert.ok(invalidStruct.diagnostics.some((diagnostic) => diagnostic.code === "field.invalidValueType"));
});

test("Entity Operations add, edit, enable, move, duplicate, and remove Components atomically", () => {
  const { document, registry } = loadFixture();
  const result = applyEntityOperations(document, [
    { type: "entity.addComponent", componentId: "attack", componentTypeId: "sample.component.attack", index: 1 },
    { type: "entity.setComponentProperty", componentId: "attack", propertyId: "damageStages", value: [12, 24, 48] },
    { type: "entity.setComponentEnabled", componentId: "move", enabled: true },
    { type: "entity.moveComponent", componentId: "move", index: 0 },
    { type: "entity.duplicateComponent", componentId: "health", newComponentId: "health_copy" },
    { type: "entity.removeComponent", componentId: "health" },
  ], registry);
  assert.equal(result.success, true, result.success ? "" : formatDiagnostics(result.diagnostics));
  assert.deepEqual(result.document.components.map((component) => component.id), ["move", "health_copy", "attack"]);
  assert.equal(result.document.components[0]?.enabled, true);
  assert.deepEqual(result.document.components[2]?.properties.damageStages, [12, 24, 48]);
  assert.equal(result.document.components[1]?.properties.maxHealth, 250);
});

test("Entity Operations rename stable Component instance IDs atomically", () => {
  const { document, registry } = loadFixture();
  const renamed = applyEntityOperations(document, [{
    type: "entity.renameComponent",
    componentId: "health",
    newComponentId: "health_primary",
  }], registry);
  assert.equal(renamed.success, true, formatDiagnostics(renamed.diagnostics));
  assert.deepEqual(renamed.success && renamed.document.components.map((component) => component.id), [
    "health_primary",
    "move",
  ]);
  assert.equal(applyEntityOperations(document, [{
    type: "entity.renameComponent",
    componentId: "health",
    newComponentId: "move",
  }], registry).success, false);
  assert.equal(document.components[0]?.id, "health");
});

test("entity.component references resolve stable instance IDs with complete owner locations", async () => {
  const { document, registry } = loadFixture();
  const definition = {
    kind: "entity.component",
    target: { documentTypeId: "hero-config" },
    allowMissing: false,
  } as const;
  const source = {
    projectId: "visualbridge.entity-semantics",
    documentTypeId: "hero-config",
    path: "Config/Entities/Player.herojson",
    document,
    registry,
  };
  const service = new ReferenceService([createEntityComponentReferenceProvider(async () => [source])]);
  const searched = await service.search(definition, "sample player health", 20);
  assert.deepEqual(searched.map((candidate) => candidate.value), ["health"]);
  const resolved = await service.resolve(definition, "health");
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.candidates[0]?.location, {
    projectId: "visualbridge.entity-semantics",
    documentTypeId: "hero-config",
    path: "Config/Entities/Player.herojson",
    documentId: "sample.player",
    componentId: "health",
    elementKind: "component",
    elementId: "health",
  });
  assert.equal((await service.resolve(definition, 1)).status, "missing");

  const ambiguous = new ReferenceService([createEntityComponentReferenceProvider(async () => [
    source,
    { ...source, path: "Config/Entities/Clone.herojson", document: { ...document, documentId: "sample.clone" } },
  ])]);
  assert.equal((await ambiguous.resolve(definition, "health")).status, "ambiguous");
  assert.deepEqual(await service.search({ ...definition, target: { documentTypeId: "hero-config", documentId: "sample.player" } }, "", 20), []);
});

test("disallowed Component types and failed batches never mutate the baseline", () => {
  const { document, registry } = loadFixture();
  const originalText = serializeEntityDocument(document);
  const disallowed = applyEntityOperations(document, [{
    type: "entity.addComponent",
    componentId: "visual",
    componentTypeId: "sample.component.visual",
  }], registry);
  assert.equal(disallowed.success, false);
  assert.equal(serializeEntityDocument(document), originalText);

  const failedBatch = applyEntityOperations(document, [
    { type: "entity.setTitle", title: "Changed" },
    { type: "entity.removeComponent", componentId: "missing" },
  ], registry);
  assert.equal(failedBatch.success, false);
  assert.equal(serializeEntityDocument(document), originalText);
});

test("Entity Document and Catalog serialization is deterministic while Component order stays authored", () => {
  const { catalogs, document } = loadFixture();
  const text = serializeEntityDocument({
    ...document,
    properties: { tint: "#4D88FFFF", level: 8, displayName: "Knight", spawn: document.properties.spawn! },
  });
  const reparsed = parseEntityDocument(text);
  assert.equal(reparsed.success, true, formatDiagnostics(reparsed.diagnostics));
  assert.equal(serializeEntityDocument(reparsed.document), text);
  assert.ok(text.indexOf('"id": "health"') < text.indexOf('"id": "move"'));
  assert.ok(text.indexOf('"displayName"') < text.indexOf('"level"'));

  const catalogText = serializeEntityCatalog(catalogs[0]!);
  const reparsedCatalog = parseEntityCatalog(catalogText);
  assert.equal(reparsedCatalog.success, true, formatDiagnostics(reparsedCatalog.diagnostics));
  assert.equal(serializeEntityCatalog(reparsedCatalog.document), catalogText);
});

test("Project matching is defined by editor category and arbitrary include patterns, not a fixed extension", () => {
  const projectResult = parseProjectFile(readFixture("VisualBridge.project.vbjson"));
  assert.equal(projectResult.success, true);
  assert.equal(projectResult.value.documentTypes[0]?.editor, "entity");
  assert.deepEqual(projectResult.value.documentTypes[0]?.include, ["Config/Entities/**/*.herojson"]);
  const matches = (pattern: string, relativePath: string): boolean =>
    pattern === "Config/Entities/**/*.herojson" && relativePath === "Config/Entities/Player.herojson";
  assert.deepEqual(
    findMatchingDocumentTypes(projectResult.value, "Config/Entities/Player.herojson", matches, { editor: "entity" })
      .map((documentType) => documentType.id),
    ["hero-config"],
  );
  assert.deepEqual(
    findMatchingDocumentTypes(projectResult.value, "Config/Entities/Player.vbentity", matches, { editor: "entity" }),
    [],
  );
});

test("the fixed Entity sample remains valid", () => {
  const { document, registry } = loadFixture();
  assert.deepEqual(validateEntityDocument(document, registry).filter((diagnostic) => diagnostic.severity === "error"), []);
});
