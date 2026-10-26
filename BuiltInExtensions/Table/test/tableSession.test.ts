import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseProjectFile, type JsonValue } from "@visualbridge/core";
import {
  buildTableCatalogRegistry,
  createTableSessionController,
  parseTableCatalog,
  resolveProjectTableLayout,
  resolveTableType,
  tableSourcesStorage,
  type ModuleSessionCatalog,
  type ModuleSessionDocument,
  type ModuleSessionHost,
  type ModuleSessionMessage,
  type TableDocument,
  type TableTypeDefinition,
} from "../index";

const fixtureRoot = path.resolve(__dirname, "../../../..", "TestData", "TableSemanticProject");
const documentTypeId = "game.table.skills";
const sourcePath = "Tables/Skills_A.csv";

interface Fixture {
  readonly tableType: TableTypeDefinition;
  readonly catalog: ModuleSessionCatalog;
  readonly options: ModuleSessionMessage;
  readonly csv: string;
}

async function loadFixture(): Promise<Fixture> {
  const projectResult = parseProjectFile(await readFile(
    path.join(fixtureRoot, "VisualBridge.project.vbjson"),
    "utf8",
  ));
  assert.equal(projectResult.success, true);
  if (!projectResult.success) throw new Error("Fixture project is unavailable.");
  const layout = resolveProjectTableLayout(projectResult.value);
  assert.notEqual(layout, undefined);
  const catalogResult = parseTableCatalog(await readFile(
    path.join(fixtureRoot, "Catalog", "Gameplay.vbtablecatalog"),
    "utf8",
  ));
  assert.equal(catalogResult.success, true);
  if (!catalogResult.success) throw new Error("Fixture catalog is unavailable.");
  const registryResult = buildTableCatalogRegistry([catalogResult.document]);
  assert.equal(registryResult.success, true);
  if (!registryResult.success) throw new Error("Fixture registry is unavailable.");
  const tableType = resolveTableType(registryResult.document, documentTypeId);
  assert.notEqual(tableType, undefined);
  const options = projectResult.value.modules.find((module) => module.id === "visualbridge.table")?.options;
  assert.notEqual(options, undefined);
  return {
    tableType: tableType!,
    catalog: { ready: true, registry: registryResult.document, diagnostics: [] },
    options: options as ModuleSessionMessage,
    csv: await readFile(path.join(fixtureRoot, "Tables", "Skills_A.csv"), "utf8"),
  };
}

function fakeHost(overrides: Partial<ModuleSessionHost> = {}): ModuleSessionHost {
  return {
    loadCatalog: async () => ({ ready: false, registry: {}, diagnostics: [] }),
    validateReferences: async () => [],
    validateReferenceChange: async () => ({ diagnostics: [], introducedErrors: [] }),
    validateProviderDocument: async () => [],
    log: () => undefined,
    ...overrides,
  };
}

function snapshot(
  document: TableDocument,
  fixture: Fixture,
  overrides: Partial<ModuleSessionDocument> = {},
): ModuleSessionDocument {
  return {
    projectId: "visualbridge.table-semantics",
    documentTypeId,
    path: sourcePath,
    text: "",
    revision: 2,
    isDirty: false,
    document: document as unknown as JsonValue,
    savedDocument: document as unknown as JsonValue,
    sources: [{ path: sourcePath, sheetIds: document.sheets.map((sheet) => sheet.id) }],
    catalog: fixture.catalog,
    options: fixture.options,
    ...overrides,
  };
}

function context(fixture: Fixture) {
  return { projectId: "visualbridge.table-semantics", documentTypeId, options: fixture.options, catalog: fixture.catalog };
}

test("Table sources storage parses a CSV partition and records the source to sheet mapping", async () => {
  const fixture = await loadFixture();
  const parsed = await tableSourcesStorage.parse(
    [{ path: sourcePath, bytes: new TextEncoder().encode(fixture.csv) }],
    context(fixture),
  );
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const document = parsed.document as unknown as TableDocument;
  assert.equal(document.format, "csv");
  assert.equal(document.sheets.length, 1);
  assert.deepEqual(parsed.sheetsBySource?.[sourcePath], document.sheets.map((sheet) => sheet.id));
  assert.equal(document.sheets[0]?.rows.length, 2);
});

test("Table sources storage plans only the declared CSV partition family", async () => {
  const fixture = await loadFixture();
  const planned = tableSourcesStorage.planSources(
    { path: sourcePath, bytes: new TextEncoder().encode(fixture.csv) },
    ["Tables/Other.csv", "Tables/Skills_B.csv", "Tables/Skills_A.csv"],
    context(fixture),
  );
  assert.deepEqual(planned, ["Tables/Skills_A.csv", "Tables/Skills_B.csv"]);
});

test("Table sources storage renders a CSV partition back to a parseable source", async () => {
  const fixture = await loadFixture();
  const files = [{ path: sourcePath, bytes: new TextEncoder().encode(fixture.csv) }];
  const parsed = await tableSourcesStorage.parse(files, context(fixture));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const rendered = await tableSourcesStorage.render(parsed.document, files, context(fixture));
  assert.equal(rendered.length, 1);
  const reparsed = await tableSourcesStorage.parse(rendered, context(fixture));
  assert.equal(reparsed.success, true);
  if (!reparsed.success) return;
  assert.deepEqual(reparsed.document, parsed.document);
});

test("Table session state publishes the revision, table type and diagnostics", async () => {
  const fixture = await loadFixture();
  const parsed = await tableSourcesStorage.parse(
    [{ path: sourcePath, bytes: new TextEncoder().encode(fixture.csv) }],
    context(fixture),
  );
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const controller = createTableSessionController();
  const state = await controller.state(
    snapshot(parsed.document as unknown as TableDocument, fixture),
    fakeHost(),
  );
  assert.equal((state as { type?: unknown }).type, "tableState");
  assert.equal((state as { revision?: unknown }).revision, 2);
  assert.equal((state as { isDirty?: unknown }).isDirty, false);
  assert.equal((state as { tableType?: { id?: unknown } }).tableType?.id, fixture.tableType.id);
});

test("Table session apply returns a sources effect with the edited document", async () => {
  const fixture = await loadFixture();
  const parsed = await tableSourcesStorage.parse(
    [{ path: sourcePath, bytes: new TextEncoder().encode(fixture.csv) }],
    context(fixture),
  );
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const document = parsed.document as unknown as TableDocument;
  const sheet = document.sheets[0]!;
  const row = sheet.rows[0]!;
  const controller = createTableSessionController();
  const effects = await controller.handle(
    {
      type: "applyOperations",
      operations: [{ type: "table.setCell", sheetId: sheet.id, rowId: row.id, columnId: "name", value: "Frostbolt" }],
    },
    snapshot(document, fixture),
    fakeHost(),
  );
  const applied = effects.find((effect) => effect.kind === "apply");
  assert.ok(applied?.kind === "apply");
  if (applied?.kind !== "apply" || applied.operations.kind !== "sources") return;
  const edited = applied.operations.document as unknown as TableDocument;
  assert.equal(edited.sheets[0]?.rows[0]?.cells.name, "Frostbolt");
});

test("Table session classifies an existing stable key rename and blocks multi-operation batches", async () => {
  const fixture = await loadFixture();
  const parsed = await tableSourcesStorage.parse(
    [{ path: sourcePath, bytes: new TextEncoder().encode(fixture.csv) }],
    context(fixture),
  );
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const document = parsed.document as unknown as TableDocument;
  const sheet = document.sheets[0]!;
  const row = sheet.rows[0]!;
  const controller = createTableSessionController();
  const plan = controller.planKeyRename(
    snapshot(document, fixture),
    [{ type: "table.setCell", sheetId: sheet.id, rowId: row.id, columnId: "id", value: 999 }],
  );
  assert.equal(plan.kind, "rename");
  if (plan.kind !== "rename") return;
  assert.equal(plan.definition.kind, "table.row");
  assert.equal(plan.location.path, sourcePath);
  assert.equal(plan.oldValue, row.cells.id);
  assert.equal(plan.newValue, 999);

  const blocked = controller.planKeyRename(
    snapshot(document, fixture),
    [
      { type: "table.setCell", sheetId: sheet.id, rowId: row.id, columnId: "id", value: 999 },
      { type: "table.setCell", sheetId: sheet.id, rowId: sheet.rows[1]!.id, columnId: "id", value: 998 },
    ],
  );
  assert.equal(blocked.kind, "blocked");

  const plain = controller.planKeyRename(
    snapshot(document, fixture),
    [{ type: "table.setCell", sheetId: sheet.id, rowId: row.id, columnId: "name", value: "Renamed" }],
  );
  assert.equal(plain.kind, "none");
});
