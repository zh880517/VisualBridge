import assert from "node:assert/strict";
import test from "node:test";
import type { TableLayoutDefinition } from "@visualbridge/core";
import {
  createEmptyCsvTableSource,
  createEmptyXlsxTableSource,
  parseCsvTable,
  parseXlsxTable,
  type TableTypeDefinition,
} from "../index";

const layout: TableLayoutDefinition = { nameKeyRow: 2, dataStartRow: 3 };
const tableType: TableTypeDefinition = {
  id: "sample.table.skills",
  title: "Skills",
  aliases: [],
  csv: { delimiter: "," },
  sheets: [{
    id: "skills",
    aliases: [],
    title: "Skills",
    name: "Skills",
    nameAliases: [],
    keyColumnId: "id",
    rowDisplayNamePattern: "{id}_{name}",
    partition: {
      namePattern: "Skills_{part}",
      deduplicateByColumnId: "id",
      duplicatePolicy: "error",
    },
    columns: [{
      id: "id",
      title: "ID",
      aliases: [],
      valueType: "number",
      dataTypeId: "int",
      defaultValue: 0,
      editor: { kind: "number", readOnly: false, integer: true, options: [] },
      fields: [],
      nameKey: "id",
      nameKeyAliases: [],
      cellEncoding: { kind: "scalar" },
    }, {
      id: "name",
      title: "Name",
      aliases: [],
      valueType: "string",
      dataTypeId: "string",
      defaultValue: "",
      editor: { kind: "text", readOnly: false, integer: false, options: [] },
      fields: [],
      nameKey: "name",
      nameKeyAliases: [],
      cellEncoding: { kind: "scalar" },
    }],
  }],
};

test("empty CSV source uses configured description, name-key, and data-start rows", () => {
  const created = createEmptyCsvTableSource(tableType, layout, "Skills_Main");
  assert.equal(created.success, true);
  if (!created.success) {
    return;
  }
  const text = new TextDecoder().decode(created.bytes);
  assert.equal(text, "ID,Name\nid,name\n");
  const parsed = parseCsvTable(text, tableType, layout, "Skills_Main");
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.document.sheets[0]?.rows.length, 0);
  }
});

test("empty XLSX source creates a parseable initial partition", async () => {
  const created = await createEmptyXlsxTableSource(tableType, layout);
  assert.equal(created.success, true);
  if (!created.success) {
    return;
  }
  const parsed = await parseXlsxTable(created.bytes, tableType, layout);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.document.sheets[0]?.name, "Skills_Main");
    assert.equal(parsed.document.sheets[0]?.rows.length, 0);
  }
});
