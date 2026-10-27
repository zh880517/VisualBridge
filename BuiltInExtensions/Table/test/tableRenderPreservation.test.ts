/**
 * P1-2 回归：引用改名 / 行键改名只重写命中的列，未命中的列与单元格必须按原始文本写回。
 *
 * 夹具故意含非规范单元格（`true`、`1.50`、`007`，以及另一行整行非规范）：`decodeTableCell`
 * 会把它们解析成 `1`、`1.5`、`7`，`encodeTableCell` 再写回时就变成规范形态。因此只要
 * `render` 退化成"整族文件逐格重编码"（旧实现无条件 `markAllCellsChanged`），下面的逐字节
 * 断言立刻变红；这是 `workspaceReferenceRefactor` / `workspaceLifecycleDocument` 共用的写回口。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseProjectFile, type JsonValue } from "@visualbridge/core";
import {
  buildTableCatalogRegistry,
  collectTableReferences,
  parseTableCatalog,
  resolveProjectTableLayout,
  resolveTableType,
  tableDocumentFacet,
  type TableCatalogRegistry,
  type TableColumnDefinition,
  type TableDocument,
  type TableSheetDefinition,
  type TableTypeDefinition,
} from "../index";

const fixtureRoot = path.resolve(__dirname, "../../../..", "TestData", "TableSemanticProject");
const documentTypeId = "game.table.skills";
const sourcePath = "Tables/Skills_A.csv";

/** 表格原文（TAB 分隔、列顺序与夹具 Catalog 一致，末尾追加三列非规范单元格）。 */
const TAB = "\t";
const originalText = [
  ["技能名", "技能编号", "标签", "奖励", "颜色", "启用", "分数", "别名"].join(TAB),
  ["Name", "Id", "Tags", "Rewards", "Tint", "Enabled", "Score", "Alias"].join(TAB),
  ["Fireball", "007", "magic", "1001|2", "#FF6633FF", "true", "1.50", "1"].join(TAB),
  ["Blink", "010", "movement", "2001|1", "#66AAFFFF", "false", "007", "2"].join(TAB),
  "",
].join("\n");

interface Fixture {
  readonly tableType: TableTypeDefinition;
  readonly registry: TableCatalogRegistry;
  readonly projectDefinition: JsonValue;
  readonly moduleOptions: JsonValue;
}

/**
 * 在真实夹具 Table Type 上追加三列：布尔（`true` → `1`）、无语义约束的小数（`1.50` → `1.5`）
 * 与带 `table.row` 引用定义的数值列（引用改名只命中它）。
 */
async function loadFixture(): Promise<Fixture> {
  const projectResult = parseProjectFile(await readFile(
    path.join(fixtureRoot, "VisualBridge.project.vbjson"),
    "utf8",
  ));
  assert.equal(projectResult.success, true);
  if (!projectResult.success) throw new Error("Fixture project is unavailable.");
  const layout = resolveProjectTableLayout(projectResult.value);
  if (layout === undefined) throw new Error("Fixture table layout is unavailable.");
  const catalogResult = parseTableCatalog(await readFile(
    path.join(fixtureRoot, "Catalog", "Gameplay.vbtablecatalog"),
    "utf8",
  ));
  assert.equal(catalogResult.success, true);
  if (!catalogResult.success) throw new Error("Fixture catalog is unavailable.");
  const registryResult = buildTableCatalogRegistry([catalogResult.document]);
  assert.equal(registryResult.success, true);
  if (!registryResult.success) throw new Error("Fixture registry is unavailable.");
  const base = resolveTableType(registryResult.document, documentTypeId);
  assert.notEqual(base, undefined);
  if (base === undefined) throw new Error("Fixture Table Type is unavailable.");

  const enabled: TableColumnDefinition = {
    id: "enabled",
    title: "Enabled",
    aliases: [],
    nameKey: "Enabled",
    nameKeyAliases: [],
    valueType: "boolean",
    dataTypeId: "bool",
    defaultValue: false,
    fields: [],
    editor: { kind: "checkbox", readOnly: false, integer: false, options: [] },
    cellEncoding: { kind: "scalar" },
  };
  const score: TableColumnDefinition = {
    id: "score",
    title: "Score",
    aliases: [],
    nameKey: "Score",
    nameKeyAliases: [],
    valueType: "number",
    dataTypeId: "float",
    defaultValue: 0,
    fields: [],
    editor: { kind: "number", readOnly: false, integer: false, options: [] },
    cellEncoding: { kind: "scalar" },
  };
  const alias: TableColumnDefinition = {
    id: "alias",
    title: "Alias",
    aliases: [],
    nameKey: "Alias",
    nameKeyAliases: [],
    valueType: "number",
    dataTypeId: "int",
    defaultValue: 0,
    fields: [],
    editor: { kind: "reference", readOnly: false, integer: true, options: [] },
    reference: {
      kind: "table.row",
      target: { tableTypeId: "game.table.skills", sheetId: "skills" },
      allowMissing: false,
    },
    cellEncoding: { kind: "scalar" },
  };
  const sheet = base.sheets[0]!;
  const sheetWithExtraColumns: TableSheetDefinition = {
    ...sheet,
    columns: [...sheet.columns, enabled, score, alias],
  };
  const tableType: TableTypeDefinition = { ...base, sheets: [sheetWithExtraColumns] };
  const registry: TableCatalogRegistry = {
    catalogs: [{ catalogId: "test.render.preservation", title: "Render Preservation" }],
    tableTypes: [{ ...tableType, catalogId: "test.render.preservation", catalogTitle: "Render Preservation" }],
  };
  return {
    tableType,
    registry,
    projectDefinition: projectResult.value as unknown as JsonValue,
    moduleOptions: {
      tableLayout: { nameKeyRow: layout.nameKeyRow, dataStartRow: layout.dataStartRow },
    } as unknown as JsonValue,
  };
}

function context(fixture: Fixture) {
  return {
    projectId: "visualbridge.table-semantics",
    documentTypeId,
    path: sourcePath,
    sourcePaths: [sourcePath],
    registry: fixture.registry,
    projectDefinition: fixture.projectDefinition,
    moduleOptions: fixture.moduleOptions,
  };
}

async function parseFixture(fixture: Fixture): Promise<TableDocument> {
  const sources = [{ path: sourcePath, bytes: new TextEncoder().encode(originalText) }];
  const parsed = await tableDocumentFacet.parseSources!(sources, context(fixture));
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Fixture Table source failed to parse.");
  return parsed.document;
}

/** 逐单元格比较：除 `changed` 命中的坐标外，其余单元格文本必须与原文逐字节相同。 */
function assertOnlyCellChanged(
  before: string,
  after: string,
  changed: { readonly row: number; readonly column: number },
): void {
  const beforeRows = before.split("\n");
  const afterRows = after.split("\n");
  assert.equal(afterRows.length, beforeRows.length, "渲染不得增删行");
  beforeRows.forEach((beforeRow, row) => {
    const beforeCells = beforeRow.split(TAB);
    const afterCells = afterRows[row]!.split(TAB);
    assert.equal(afterCells.length, beforeCells.length, `第 ${row + 1} 行的列数不得变化`);
    beforeCells.forEach((beforeCell, column) => {
      if (row === changed.row && column === changed.column) return;
      assert.equal(
        afterCells[column],
        beforeCell,
        `第 ${row + 1} 行第 ${column + 1} 列（未命中）必须保留原始文本`,
      );
    });
  });
}

test("Table render preserves raw cells outside the renamed key column", async () => {
  const fixture = await loadFixture();
  const document = await parseFixture(fixture);
  const sheet = document.sheets[0]!;
  const row = sheet.rows[0]!;
  assert.equal(row.cells.id, 7);
  assert.equal(row.cells.enabled, true);
  assert.equal(row.cells.score, 1.5);
  assert.equal(row.cells.alias, 1);

  const renamed = tableDocumentFacet.renameTarget!(
    document,
    { kind: "table.row", sheetId: sheet.id, rowId: row.id },
    row.cells.id as number,
    42,
    context(fixture),
  );
  assert.equal(renamed.success, true);
  if (!renamed.success) return;
  assert.equal(renamed.document.sheets[0]!.rows[0]!.cells.id, 42);

  const rendered = await tableDocumentFacet.renderSources(
    renamed.document,
    [{ path: sourcePath, bytes: new TextEncoder().encode(originalText) }],
    context(fixture),
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(rendered[0]!.bytes);
  const idColumnIndex = 1;
  assertOnlyCellChanged(originalText, text, { row: 2, column: idColumnIndex });
  assert.equal(text.split("\n")[2]!.split(TAB)[idColumnIndex], "42");
});

test("Table render preserves raw cells outside the renamed reference column", async () => {
  const fixture = await loadFixture();
  const document = await parseFixture(fixture);
  const sheet = document.sheets[0]!;
  const row = sheet.rows[0]!;
  const occurrence = collectTableReferences(document, fixture.tableType)
    .find((candidate) => candidate.path.includes(`.${row.id}.cells.`) && candidate.path.endsWith(".alias"));
  assert.notEqual(occurrence, undefined);
  if (occurrence === undefined) return;

  const replaced = tableDocumentFacet.replaceReferenceValues(
    document,
    context(fixture),
    new Set([occurrence.path]),
    3,
  );
  assert.equal(replaced.success, true);
  if (!replaced.success) return;

  const rendered = await tableDocumentFacet.renderSources(
    replaced.document,
    [{ path: sourcePath, bytes: new TextEncoder().encode(originalText) }],
    context(fixture),
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(rendered[0]!.bytes);
  assertOnlyCellChanged(originalText, text, { row: 2, column: 7 });
  assert.equal(text.split("\n")[2]!.split(TAB)[7], "3");
});
