import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createEmptyEntityCatalogRegistry,
  createEntitySessionController,
  entitySessionTextStorage,
  type EntityDocument,
  type ModuleSessionDocument,
  type ModuleSessionHost,
} from "../index";

// 假宿主：断言控制器只经 SessionHost 查询，不 import vscode、不自己读文件。
const fixtureRoot = path.resolve(__dirname, "../../../..", "TestData", "EntitySemanticProject");

function readFixture(...segments: string[]): string {
  return readFileSync(path.join(fixtureRoot, ...segments), "utf8");
}

function fakeHost(overrides: Partial<ModuleSessionHost> = {}): ModuleSessionHost {
  return {
    loadCatalog: async () => ({ ready: false, registry: createEmptyEntityCatalogRegistry(), diagnostics: [] }),
    validateReferences: async () => [],
    validateReferenceChange: async () => ({ diagnostics: [], introducedErrors: [] }),
    validateProviderDocument: async () => [],
    log: () => undefined,
    ...overrides,
  };
}

function snapshot(text: string, overrides: Partial<ModuleSessionDocument> = {}): ModuleSessionDocument {
  return {
    projectId: "visualbridge.entity-semantics",
    documentTypeId: "hero-config",
    path: "Config/Entities/Player.herojson",
    text,
    revision: 7,
    isDirty: false,
    ...overrides,
  };
}

test("Entity session storage round-trips the document text", () => {
  const text = readFixture("Config", "Entities", "Player.herojson");
  const parsed = entitySessionTextStorage.parse(text);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const rendered = entitySessionTextStorage.render(parsed.document);
  const reparsed = entitySessionTextStorage.parse(rendered);
  assert.equal(reparsed.success, true);
  if (!reparsed.success) return;
  assert.deepEqual(reparsed.document, parsed.document);
});

test("Entity session state publishes invalid documents without touching the host", async () => {
  const controller = createEntitySessionController();
  const state = await controller.state(snapshot("{ not json"), fakeHost({
    loadCatalog: async () => {
      throw new Error("invalid documents must not query the catalog");
    },
  }));
  assert.equal((state as { type?: unknown }).type, "entityInvalid");
  const diagnostics = (state as { diagnostics?: readonly { severity: string }[] }).diagnostics;
  assert.ok(Array.isArray(diagnostics) && diagnostics.length > 0);
});

test("Entity session apply returns one text effect and queries the host for validation", async () => {
  const text = readFixture("Config", "Entities", "Player.herojson");
  const controller = createEntitySessionController();
  const queried: string[] = [];
  const host = fakeHost({
    validateProviderDocument: async (input) => {
      queried.push(`provider:${input.path}`);
      return [];
    },
    validateReferences: async () => {
      queried.push("references");
      return [];
    },
  });
  const effects = await controller.handle(
    { type: "applyOperations", operations: [{ type: "entity.setTitle", title: "Session Title" }] },
    snapshot(text),
    host,
  );
  const applied = effects.find((effect) => effect.kind === "apply");
  assert.ok(applied?.kind === "apply");
  if (applied?.kind !== "apply" || applied.operations.kind !== "text") return;
  const parsed = entitySessionTextStorage.parse(applied.operations.text);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal((parsed.document as EntityDocument).title, "Session Title");
  // Catalog 未就绪时只走 Provider 校验（与改造前一致：引用校验依赖 Catalog）。
  assert.deepEqual(queried, ["provider:Config/Entities/Player.herojson"]);
  assert.ok(effects.some((effect) => effect.kind === "post"
    && effect.message.type === "operationCompleted"
    && effect.message.changed === true));
});

test("Entity session rejects catalog-dependent operations while the catalog is unavailable", async () => {
  const text = readFixture("Config", "Entities", "Player.herojson");
  const controller = createEntitySessionController();
  const effects = await controller.handle(
    { type: "applyOperations", operations: [{ type: "entity.addComponent", componentTypeId: "health" }] },
    snapshot(text),
    fakeHost(),
  );
  assert.equal(effects.length, 1);
  const [effect] = effects;
  assert.ok(effect?.kind === "post");
  if (effect?.kind !== "post") return;
  assert.equal(effect.message.type, "operationRejected");
  assert.match(String(effect.message.message), /Entity Catalog 尚未就绪/u);
  assert.ok(Array.isArray(effect.message.diagnostics));
});

test("Entity session refuses new diagnostics introduced by the Provider validator", async () => {
  const text = readFixture("Config", "Entities", "Player.herojson");
  const controller = createEntitySessionController();
  const effects = await controller.handle(
    { type: "applyOperations", operations: [{ type: "entity.setTitle", title: "Rejected" }] },
    snapshot(text),
    fakeHost({
      validateProviderDocument: async () => [{
        severity: "error",
        code: "provider.rejected",
        path: "title",
        message: "The Provider validator rejected the document.",
      }],
    }),
  );
  assert.ok(effects.every((effect) => effect.kind !== "apply"));
  const rejection = effects.find((effect) => effect.kind === "post"
    && effect.message.type === "operationRejected");
  assert.ok(rejection?.kind === "post");
  if (rejection?.kind !== "post") return;
  assert.match(String(rejection.message.message), /title: The Provider validator rejected the document\./u);
});

test("Entity session blocks guarded identity renames before any host work", () => {
  const controller = createEntitySessionController();
  assert.match(
    controller.checkOperations?.([{ type: "entity.renameComponent" }]) ?? "",
    /refactor\.required/u,
  );
  assert.equal(controller.checkOperations?.([{ type: "entity.setTitle" }]), undefined);
});
