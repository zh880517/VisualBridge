import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseProjectFile } from "@visualbridge/core";
import ExcelJS = require("exceljs");
import {
  applyTableOperations,
  buildTableCatalogRegistry,
  parseCsvTable,
  parseTableCatalog,
  parseXlsxTable,
  resolveTableType,
  resolveEffectiveTableRows,
  serializeCsvTable,
  serializeXlsxTable,
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

test("Table Catalog uses stable aliases and explicit C# cell encodings", async () => {
  const { tableType } = await loadFixture();
  assert.equal(tableType.id, "game.table.skills");
  assert.equal(tableType.source?.typeName, "Game.SkillConfig");
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
