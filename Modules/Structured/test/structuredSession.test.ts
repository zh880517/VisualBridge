import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createEmptyStructuredCatalogRegistry,
  createStructuredSessionController,
  structuredSessionTextStorage,
  type ModuleSessionDocument,
  type ModuleSessionHost,
} from "../index";

const projectRoot = path.resolve(__dirname, "../../../..", "TestData", "StructuredSemanticProject");

function readFixture(...segments: string[]): string {
  return readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function fakeHost(overrides: Partial<ModuleSessionHost> = {}): ModuleSessionHost {
  return {
    loadCatalog: async () => ({ ready: false, registry: createEmptyStructuredCatalogRegistry(), diagnostics: [] }),
    validateReferences: async () => [],
    validateReferenceChange: async () => ({ diagnostics: [], introducedErrors: [] }),
    validateProviderDocument: async () => [],
    log: () => undefined,
    ...overrides,
  };
}

function snapshot(text: string, overrides: Partial<ModuleSessionDocument> = {}): ModuleSessionDocument {
  return {
    projectId: "StructuredSemanticProject",
    documentTypeId: "game.settings",
    path: "Config/Game.gamesettings",
    text,
    revision: 11,
    isDirty: false,
    ...overrides,
  };
}

test("Structured session storage round-trips the document text", () => {
  const text = readFixture("Config", "Game.gamesettings");
  const parsed = structuredSessionTextStorage.parse(text);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const reparsed = structuredSessionTextStorage.parse(structuredSessionTextStorage.render(parsed.document));
  assert.equal(reparsed.success, true);
  if (!reparsed.success) return;
  assert.deepEqual(reparsed.document, parsed.document);
});

test("Structured session reports an invalid state while its Catalog is unavailable", async () => {
  const text = readFixture("Config", "Game.gamesettings");
  const controller = createStructuredSessionController();
  const state = await controller.state(snapshot(text), fakeHost({
    loadCatalog: async () => ({
      ready: false,
      registry: {},
      diagnostics: [{ severity: "error", code: "structured.catalogUnavailable", path: "catalogs[0]", message: "Missing." }],
    }),
  }));
  assert.equal((state as { type?: unknown }).type, "structuredInvalid");
  const diagnostics = (state as { diagnostics?: readonly { code: string }[] }).diagnostics ?? [];
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "structured.catalogUnavailable"));
});

test("Structured session rejects every operation while the Catalog is unavailable", async () => {
  const text = readFixture("Config", "Game.gamesettings");
  const controller = createStructuredSessionController();
  const effects = await controller.handle(
    { type: "applyOperations", operations: [{ type: "structured.setField", fieldId: "maxPlayers", value: 8 }] },
    snapshot(text),
    fakeHost(),
  );
  assert.equal(effects.length, 1);
  const [effect] = effects;
  assert.ok(effect?.kind === "post");
  if (effect?.kind !== "post") return;
  assert.equal(effect.message.type, "operationRejected");
  assert.match(String(effect.message.message), /Structured Catalog 尚未就绪/u);
});

test("Structured session invalidates the document when the Document Type has no Config Type", async () => {
  const text = readFixture("Config", "Game.gamesettings");
  const controller = createStructuredSessionController();
  const state = await controller.state(snapshot(text), fakeHost({
    loadCatalog: async () => ({ ready: true, registry: createEmptyStructuredCatalogRegistry(), diagnostics: [] }),
  }));
  assert.equal((state as { type?: unknown }).type, "structuredInvalid");
  assert.equal((state as { isDirty?: unknown }).isDirty, false);
});
