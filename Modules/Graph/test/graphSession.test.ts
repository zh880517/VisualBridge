import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildGraphCatalogRegistry,
  createGraphSessionController,
  graphSessionTextStorage,
  parseGraphCatalog,
  type GraphCatalog,
  type GraphCatalogRegistry,
  type ModuleSessionCatalog,
  type ModuleSessionDocument,
  type ModuleSessionHost,
} from "../index";

const projectRoot = path.resolve(__dirname, "../../../..", "TestData", "GraphSemanticProject");

function readFixture(...segments: string[]): string {
  return readFileSync(path.join(projectRoot, ...segments), "utf8");
}

interface Fixture {
  readonly registry: GraphCatalogRegistry;
  readonly catalog: ModuleSessionCatalog;
  readonly text: string;
}

function loadFixture(): Fixture {
  const catalogs: GraphCatalog[] = ["Common", "Logic", "Blocked"].map((name) => {
    const result = parseGraphCatalog(readFixture("Catalog", `${name}.vbgraphcatalog`));
    assert.equal(result.success, true);
    if (!result.success) throw new Error("Graph catalog fixture is unavailable.");
    return result.document;
  });
  const registryResult = buildGraphCatalogRegistry(catalogs);
  assert.equal(registryResult.success, true);
  if (!registryResult.success) throw new Error("Graph registry fixture is unavailable.");
  return {
    registry: registryResult.document,
    catalog: { ready: true, registry: registryResult.document, diagnostics: [] },
    text: readFixture("Graph", "SemanticSample.vbgraph"),
  };
}

function fakeHost(fixture: Fixture, overrides: Partial<ModuleSessionHost> = {}): ModuleSessionHost {
  return {
    loadCatalog: async () => fixture.catalog,
    validateReferences: async () => [],
    validateReferenceChange: async () => ({ diagnostics: [], introducedErrors: [] }),
    validateProviderDocument: async () => [],
    log: () => undefined,
    ...overrides,
  };
}

function snapshot(text: string, overrides: Partial<ModuleSessionDocument> = {}): ModuleSessionDocument {
  return {
    projectId: "GraphSemanticProject",
    documentTypeId: "logicGraph",
    path: "Graph/SemanticSample.vbgraph",
    text,
    revision: 3,
    isDirty: false,
    ...overrides,
  };
}

test("Graph session storage round-trips the document text", () => {
  const fixture = loadFixture();
  const parsed = graphSessionTextStorage.parse(fixture.text);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  // Graph 序列化会规范化属性顺序，比对"渲染→解析→渲染"的文本稳定性而不是对象深等。
  const first = graphSessionTextStorage.render(parsed.document);
  const reparsed = graphSessionTextStorage.parse(first);
  assert.equal(reparsed.success, true);
  if (!reparsed.success) return;
  assert.equal(graphSessionTextStorage.render(reparsed.document), first);
});

test("Graph session state publishes the parsed document and catalog readiness", async () => {
  const fixture = loadFixture();
  const controller = createGraphSessionController();
  const state = await controller.state(snapshot(fixture.text), fakeHost(fixture));
  assert.equal((state as { type?: unknown }).type, "graphState");
  assert.equal((state as { catalogReady?: unknown }).catalogReady, true);
  assert.equal((state as { documentVersion?: unknown }).documentVersion, 3);
});

test("Graph session apply returns one text effect for a valid operation", async () => {
  const fixture = loadFixture();
  const controller = createGraphSessionController();
  const effects = await controller.handle(
    {
      type: "applyOperations",
      operations: [{
        type: "graph.updateGraph",
        graphId: "root",
        title: "Controller Title",
        properties: { priority: 1 },
      }],
    },
    snapshot(fixture.text),
    fakeHost(fixture),
  );
  const applied = effects.find((effect) => effect.kind === "apply");
  assert.ok(applied?.kind === "apply");
  if (applied?.kind !== "apply" || applied.operations.kind !== "text") return;
  const parsed = graphSessionTextStorage.parse(applied.operations.text);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const root = (parsed.document as { graphs: readonly { id: string; title: string }[] }).graphs
    .find((graph) => graph.id === "root");
  assert.equal(root?.title, "Controller Title");
});

test("Graph session answers replacement candidates and refreshes on a stale revision", async () => {
  const fixture = loadFixture();
  const controller = createGraphSessionController();
  const candidates = await controller.handle(
    { type: "requestReplacementCandidates", documentVersion: 3, graphId: "root", nodeId: "step_b" },
    snapshot(fixture.text),
    fakeHost(fixture),
  );
  const reply = candidates.find((effect) => effect.kind === "post");
  assert.ok(reply?.kind === "post");
  if (reply?.kind !== "post") return;
  assert.equal(reply.message.type, "replacementCandidates");
  assert.ok(Array.isArray(reply.message.nodeTypeIds));

  const stale = await controller.handle(
    { type: "requestReplacementCandidates", documentVersion: 2, graphId: "root", nodeId: "step_b" },
    snapshot(fixture.text),
    fakeHost(fixture),
  );
  const state = stale.find((effect) => effect.kind === "post");
  assert.ok(state?.kind === "post");
  if (state?.kind !== "post") return;
  assert.equal(state.message.type, "graphState");
});

test("Graph session refuses new reference errors and guarded identity renames", async () => {
  const fixture = loadFixture();
  const controller = createGraphSessionController();
  const effects = await controller.handle(
    {
      type: "applyOperations",
      operations: [{
        type: "graph.updateGraph",
        graphId: "root",
        title: "Blocked",
        properties: { priority: 1 },
      }],
    },
    snapshot(fixture.text),
    fakeHost(fixture, {
      validateReferenceChange: async () => ({
        diagnostics: [{ severity: "error", code: "reference.dangling", path: "graphs[0]", message: "Dangling." }],
        introducedErrors: [{ severity: "error", code: "reference.dangling", path: "graphs[0]", message: "Dangling." }],
      }),
    }),
  );
  assert.ok(effects.every((effect) => effect.kind !== "apply"));
  assert.match(
    controller.checkOperations?.([{ type: "graph.renameElement" }]) ?? "",
    /refactor\.required/u,
  );
});
