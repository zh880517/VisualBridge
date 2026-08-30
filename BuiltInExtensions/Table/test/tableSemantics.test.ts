import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseProjectFile } from "@visualbridge/core";
import ExcelJS = require("exceljs");
import {
  applyTableOperations,
  buildTableRowSearchText,
  buildTableCatalogRegistry,
  collectAddressableTableIdentityKeys,
  collectTableOwnedIdentities,
  formatTableRowDisplayName,
  matchesTableRowSearch,
  normalizeTableSearchQuery,
  parseCsvTable,
  parseTableCatalog,
  parseXlsxTable,
  resolveTableType,
  remapTableOwnedIdentities,
  resolveEffectiveTableRows,
  serializeCsvTable,
  serializeXlsxTable,
  tableDocumentAdapter,
  validateTableDocument,
  type TableTypeDefinition,
} from "../index";

const fixtureRoot = path.resolve(__dirname, "../../../../TestData/TableSemanticProject");

async function loadFixture(): Promise<{
  readonly tableType: TableTypeDefinition;
  readonly layout: { readonly nameKeyRow: number; readonly dataStartRow: number };
  readonly csv: string;
}> {
  const projectResult = parseProjectFile(await readFile(path.join(fixtureRoot, "VisualBridge.project.vbjson"), "utf8"));
  assert.equal(projectResult.success, true);
  if (!projectResult.success || projectResult.value.tableLayout === undefined) {
    throw new Error("Fixture project table layout is unavailable.");
  }
  const catalogResult = parseTableCatalog(await readFile(
    path.join(fixtureRoot, "Catalog", "Gameplay.vbtablecatalog"),
    "utf8",
  ));
  assert.equal(catalogResult.success, true);
  if (!catalogResult.success) {
    throw new Error("Fixture catalog is unavailable.");
  }
  const registryResult = buildTableCatalogRegistry([catalogResult.document]);
  assert.equal(registryResult.success, true);
  if (!registryResult.success) {
    throw new Error("Fixture registry is unavailable.");
  }
  const tableType = resolveTableType(registryResult.document, "legacy.table.skills");
  assert.notEqual(tableType, undefined);
  return {
    tableType: tableType!,
    layout: projectResult.value.tableLayout,
    csv: await readFile(path.join(fixtureRoot, "Tables", "Skills_A.csv"), "utf8"),
  };
}

test("Table semantic adapter retains the multi-source document operation contract", async () => {
  const { tableType, layout, csv } = await loadFixture();
  const parsed = parseCsvTable(csv, tableType, layout, "Skills_A");
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("CSV fixture failed.");
  const context = { tableType };
  assert.deepEqual(
    tableDocumentAdapter.validate(parsed.document, context),
    validateTableDocument(parsed.document, tableType),
  );
  const unchanged = tableDocumentAdapter.applyOperations(parsed.document, [{
    type: "table.setCell",
    sheetId: parsed.document.sheets[0]!.id,
    rowId: parsed.document.sheets[0]!.rows[0]!.id,
    columnId: "name",
    value: parsed.document.sheets[0]!.rows[0]!.cells.name,
  }], context);
  assert.equal(unchanged.success, true);
});

test("Table copy requires an explicit type-preserving remap for every row key", async () => {
  const { tableType, layout, csv } = await loadFixture();
  const parsed = parseCsvTable(csv, tableType, layout, "Skills_A");
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const identities = collectTableOwnedIdentities(parsed.document, tableType, "game.table.skills");
  const result = remapTableOwnedIdentities(
    parsed.document,
    tableType,
    "game.table.skills",
    identities.map((entry, index) => ({
      identityKey: entry.identityKey,
      from: entry.value,
      to: typeof entry.value === "number" ? entry.value + 10_000 + index : `${entry.value}.copy`,
    })),
  );
  assert.equal(result.success, true);
  assert.equal(remapTableOwnedIdentities(parsed.document, tableType, "game.table.skills", []).success, false);

  const distinctDedupType: TableTypeDefinition = {
    ...tableType,
    sheets: tableType.sheets.map((sheet) => ({
      ...sheet,
      ...(sheet.partition === undefined ? {} : {
        partition: { ...sheet.partition, deduplicateByColumnId: "name" },
      }),
    })),
  };
  const dedupIdentities = collectTableOwnedIdentities(
    parsed.document,
    distinctDedupType,
    "game.table.skills",
  );
  assert.ok(dedupIdentities.some((entry) => entry.kind === "table.dedup" && entry.value === "Fireball"));
});

test("Table copy resolves key and deduplicate aliases to one canonical column", async () => {
  const { tableType, layout, csv } = await loadFixture();
  const parsed = parseCsvTable(csv, tableType, layout, "Skills_A");
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const aliasType: TableTypeDefinition = {
    ...tableType,
    sheets: tableType.sheets.map((sheet) => ({
      ...sheet,
      keyColumnId: "skillId",
      ...(sheet.partition === undefined ? {} : {
        partition: { ...sheet.partition, deduplicateByColumnId: "skillId" },
      }),
    })),
  };
  const identities = collectTableOwnedIdentities(parsed.document, aliasType, "game.table.skills");
  assert.equal(identities.length, parsed.document.sheets[0]!.rows.length);
  assert.ok(identities.every((entry) => entry.kind === "table.row"));
  const remapped = remapTableOwnedIdentities(
    parsed.document,
    aliasType,
    "game.table.skills",
    identities.map((entry) => ({ identityKey: entry.identityKey, from: entry.value, to: Number(entry.value) + 1_000 })),
  );
  assert.equal(remapped.success, true, remapped.success ? "" : remapped.diagnostics.map((entry) => entry.message).join("\n"));
  if (!remapped.success) return;
  assert.deepEqual(remapped.document.sheets[0]!.rows.map((row) => row.cells.id), [1101, 1102]);
});

test("Table partition copy remaps every physical row while effective policy selects the visible duplicate", async () => {
  const { tableType, layout, csv } = await loadFixture();
  const first = parseCsvTable(csv, tableType, layout, "Skills_A");
  const second = parseCsvTable(
    await readFile(path.join(fixtureRoot, "Tables", "Skills_B.csv"), "utf8"),
    tableType,
    layout,
    "Skills_B",
  );
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  if (!first.success || !second.success) return;
  const secondSheet = second.document.sheets[0]!;
  const partitioned = {
    format: "csv" as const,
    sheets: [
      ...first.document.sheets,
      {
        ...secondSheet,
        rows: secondSheet.rows.map((row, index) => index === 0
          ? { ...row, cells: { ...row.cells, id: 201 } }
          : row),
      },
    ],
  };

  for (const duplicatePolicy of ["keepFirst", "keepLast"] as const) {
    const policyType: TableTypeDefinition = {
      ...tableType,
      sheets: tableType.sheets.map((sheet) => ({
        ...sheet,
        ...(sheet.partition === undefined ? {} : {
          partition: { ...sheet.partition, deduplicateByColumnId: "name", duplicatePolicy },
        }),
      })),
    };
    const identities = collectTableOwnedIdentities(partitioned, policyType, "game.table.skills");
    const addressable = collectAddressableTableIdentityKeys(partitioned, policyType);
    assert.deepEqual(
      identities.filter((entry) => entry.kind === "table.row").map((entry) => entry.value).sort((a, b) => Number(a) - Number(b)),
      [101, 102, 201, 202],
    );
    assert.deepEqual(
      identities.filter((entry) => entry.kind === "table.dedup").map((entry) => entry.value).sort(),
      ["Blink", "Fireball", "Fireball Override"],
    );
    assert.deepEqual(
      identities.filter((entry) => entry.kind === "table.row" && addressable.has(entry.identityKey))
        .map((entry) => entry.value).sort((a, b) => Number(a) - Number(b)),
      duplicatePolicy === "keepFirst" ? [101, 102, 201] : [101, 201, 202],
    );
    const remapped = remapTableOwnedIdentities(
      partitioned,
      policyType,
      "game.table.skills",
      identities.map((entry) => ({
        identityKey: entry.identityKey,
        from: entry.value,
        to: typeof entry.value === "number" ? entry.value + 1_000 : `${entry.value}.copy`,
      })),
    );
    assert.equal(remapped.success, true, remapped.success ? "" : remapped.diagnostics.map((entry) => entry.message).join("\n"));
    if (!remapped.success) continue;
    assert.deepEqual(
      remapped.document.sheets.flatMap((sheet) => sheet.rows.map((row) => row.cells.id)).sort((a, b) => Number(a) - Number(b)),
      [1101, 1102, 1201, 1202],
    );
    const effective = resolveEffectiveTableRows(remapped.document, policyType, "skills");
    assert.deepEqual(
      effective.rows.map((entry) => entry.row.cells.id),
      duplicatePolicy === "keepFirst" ? [1101, 1102, 1201] : [1101, 1201, 1202],
    );
  }
});

test("Table Catalog uses stable aliases and explicit C# cell encodings", async () => {
  const { tableType } = await loadFixture();
  assert.equal(tableType.id, "game.table.skills");
  assert.equal(tableType.source?.typeName, "Game.SkillConfig");
  assert.equal(tableType.sheets[0]?.rowDisplayNamePattern, "{id}_{name}");
  assert.deepEqual(tableType.sheets[0]?.partition, {
    namePattern: "Skills_{part}",
    deduplicateByColumnId: "id",
    duplicatePolicy: "keepFirst",
  });
  assert.deepEqual(tableType.sheets[0]?.columns.find((column) => column.id === "rewards")?.cellEncoding, {
    kind: "delimited",
    separator: ";",
    item: { kind: "delimited", separator: "|" },
  });
});

test("row display-name patterns use stable Column IDs", async () => {
  const catalogPath = path.join(fixtureRoot, "Catalog", "Gameplay.vbtablecatalog");
  const payload = JSON.parse(await readFile(catalogPath, "utf8")) as {
    tableTypes: Array<{ sheets: Array<{ rowDisplayNamePattern: string }> }>;
  };
  payload.tableTypes[0]!.sheets[0]!.rowDisplayNamePattern = "{Id}_{MissingName}";
  const result = parseTableCatalog(JSON.stringify(payload));
  assert.equal(result.success, false);
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "tableCatalog.unknownRowDisplayNameColumn").length,
    2,
  );
});

test("Table row search uses catalog encodings without erasing cell value types", async () => {
  const { tableType, layout, csv } = await loadFixture();
  const parsed = parseCsvTable(csv, tableType, layout, "Skills_A");
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const definition = tableType.sheets[0]!;
  const sourceRow = parsed.document.sheets[0]!.rows[0]!;
  const row = {
    ...sourceRow,
    cells: { ...sourceRow.cells, id: 101, name: "101" },
  };
  const searchText = buildTableRowSearchText(row, definition);

  assert.equal(typeof row.cells.id, "number");
  assert.equal(typeof row.cells.name, "string");
  assert.ok(searchText.includes("101_101"));
  assert.ok(searchText.includes("1001|2;1002|1"));
  assert.equal(matchesTableRowSearch(row, definition, "101 1001|2"), true);
  assert.deepEqual(normalizeTableSearchQuery("  FIREBALL   101  "), ["fireball", "101"]);
  assert.deepEqual(normalizeTableSearchQuery("  CAFE\u0301   ITEM  "), ["café", "item"]);
});

test("Sheet aliases are stable identifiers and cannot collide with canonical IDs", async () => {
  const catalogPath = path.join(fixtureRoot, "Catalog", "Gameplay.vbtablecatalog");
  const payload = JSON.parse(await readFile(catalogPath, "utf8")) as {
    tableTypes: Array<{ sheets: Array<{ id: string; aliases: string[] }> }>;
  };
  const sheet = payload.tableTypes[0]!.sheets[0]!;
  sheet.aliases = [sheet.id];
  const result = parseTableCatalog(JSON.stringify(payload));
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "tableCatalog.duplicateSheetIdentity"));
});

test("CSV maps columns from the configured name-key row instead of position", async () => {
  const { tableType, layout, csv } = await loadFixture();
  const result = parseCsvTable(csv, tableType, layout, "Skills_A");
  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }
  const first = result.document.sheets[0]?.rows[0];
  assert.deepEqual(first?.cells.rewards, [
    { itemId: 1001, count: 2 },
    { itemId: 1002, count: 1 },
  ]);
  assert.equal(first?.cells.id, 101);
  assert.equal(formatTableRowDisplayName(first!.cells, tableType.sheets[0]!), "101_Fireball");
  assert.deepEqual(result.document.sheets[0]?.headerRows[0], ["技能名", "技能编号", "标签", "奖励", "颜色"]);
  assert.deepEqual(validateTableDocument(result.document, tableType), []);
});

test("Table operations are atomic and serialization preserves header layout", async () => {
  const { tableType, layout, csv } = await loadFixture();
  const parsed = parseCsvTable(csv, tableType, layout, "Skills_A");
  assert.equal(parsed.success, true, JSON.stringify(parsed.diagnostics));
  if (!parsed.success) {
    return;
  }
  const sheet = parsed.document.sheets[0]!;
  const first = sheet.rows[0]!;
  const rejected = applyTableOperations(parsed.document, [{
    type: "table.setCell",
    sheetId: sheet.id,
    rowId: first.id,
    columnId: "id",
    value: 1.5,
  }], tableType);
  assert.equal(rejected.success, false);
  assert.equal(parsed.document.sheets[0]?.rows[0]?.cells.id, 101);

  const applied = applyTableOperations(parsed.document, [{
    type: "table.setCell",
    sheetId: sheet.id,
    rowId: first.id,
    columnId: "tags",
    value: ["magic", "burst"],
  }], tableType);
  assert.equal(applied.success, true);
  if (!applied.success) {
    return;
  }
  const serialized = serializeCsvTable(applied.document, tableType, csv);
  const lines = serialized.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], "技能名\t技能编号\t标签\t奖励\t颜色");
  assert.equal(lines[1], "Name\tId\tTags\tRewards\tTint");
  assert.equal(lines[2], "Fireball\t101\tmagic;burst\t1001|2;1002|1\t#FF6633FF");

  const structural = applyTableOperations(parsed.document, [
    {
      type: "table.insertRow",
      sheetId: sheet.id,
      rowId: "inserted",
      index: 1,
      cells: { id: 202, name: "Inserted" },
    },
    {
      type: "table.moveRow",
      sheetId: sheet.id,
      rowId: first.id,
      index: 1,
    },
  ], tableType);
  assert.equal(structural.success, true, structural.success ? "" : JSON.stringify(structural.diagnostics));
  assert.deepEqual(
    structural.document.sheets[0]?.rows.map((row) => row.id),
    ["inserted", ...sheet.rows.map((row) => row.id)],
  );
});

test("partition validation applies the exported duplicate policy across worksheets", async () => {
  const { tableType, layout } = await loadFixture();
  const workbook = createWorkbook(true);
  const bytes = Uint8Array.from(Buffer.from(await workbook.xlsx.writeBuffer()));
  const parsed = await parseXlsxTable(bytes, tableType, layout);
  assert.equal(parsed.success, true, JSON.stringify(parsed.diagnostics));
  if (!parsed.success) {
    return;
  }
  const diagnostics = validateTableDocument(parsed.document, tableType);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.code === "table.partitionDuplicateResolved"), true);
  const effective = resolveEffectiveTableRows(parsed.document, tableType, "skills");
  assert.equal(effective.rows.length, 1);
  assert.equal(effective.rows[0]?.sheetName, "Skills_A");
  const keepLastType: TableTypeDefinition = {
    ...tableType,
    sheets: tableType.sheets.map((sheet) => sheet.partition === undefined ? sheet : {
      ...sheet,
      partition: { ...sheet.partition, duplicatePolicy: "keepLast" },
    }),
  };
  const effectiveLast = resolveEffectiveTableRows(parsed.document, keepLastType, "skills");
  assert.equal(effectiveLast.rows.length, 1);
  assert.equal(effectiveLast.rows[0]?.sheetName, "Skills_B");
});

test("XLSX patches typed cells while preserving unrelated sheets and styles", async () => {
  const { tableType, layout } = await loadFixture();
  const workbook = createWorkbook(false);
  const original = Uint8Array.from(Buffer.from(await workbook.xlsx.writeBuffer()));
  const parsed = await parseXlsxTable(original, tableType, layout);
  assert.equal(parsed.success, true, JSON.stringify(parsed.diagnostics));
  if (!parsed.success) {
    return;
  }
  const sheet = parsed.document.sheets.find((candidate) => candidate.name === "Skills_A")!;
  const row = sheet.rows[0]!;
  const applied = applyTableOperations(parsed.document, [{
    type: "table.setCell",
    sheetId: sheet.id,
    rowId: row.id,
    columnId: "id",
    value: 111,
  }], tableType);
  assert.equal(applied.success, true);
  if (!applied.success) {
    return;
  }
  const output = await serializeXlsxTable(original, applied.document, tableType, layout);
  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
  assert.equal(saved.getWorksheet("Skills_A")?.getCell("B3").value, 111);
  assert.equal(saved.getWorksheet("Skills_A")?.getCell("B3").fill.type, "pattern");
  assert.equal(saved.getWorksheet("Overview")?.getCell("A1").value, "Keep me");
});

function createWorkbook(withDuplicate: boolean): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const overview = workbook.addWorksheet("Overview");
  overview.getCell("A1").value = "Keep me";
  addSkillSheet(workbook, "Skills_A", ["Fireball", 101, "magic;damage", "1001|2", "#FF6633FF"]);
  addSkillSheet(workbook, "Skills_B", ["Ice", withDuplicate ? 101 : 201, "magic;slow", "1002|1", "#66AAFFFF"]);
  return workbook;
}

function addSkillSheet(workbook: ExcelJS.Workbook, name: string, row: readonly unknown[]): void {
  const worksheet = workbook.addWorksheet(name);
  worksheet.addRow(["技能名", "技能编号", "标签", "奖励", "颜色"]);
  worksheet.addRow(["Name", "Id", "Tags", "Rewards", "Tint"]);
  worksheet.addRow(row as ExcelJS.CellValue[]);
  worksheet.getCell("B3").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF224466" },
  };
}
