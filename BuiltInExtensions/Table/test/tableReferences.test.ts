import assert from "node:assert/strict";
import test from "node:test";
import { ReferenceService } from "@visualbridge/core";
import {
  collectTableReferences,
  createTableRowReferenceProvider,
  type TableDocument,
  type TableTypeDefinition,
} from "../index";

const tableType: TableTypeDefinition = {
  id: "game.table.skills",
  title: "Skills",
  aliases: ["legacy.table.skills"],
  sheets: [{
    id: "skills",
    title: "Skills",
    name: "Skills",
    nameAliases: [],
    rowDisplayNamePattern: "{id}_{name}",
    keyColumnId: "id",
    columns: [
      {
        id: "id", title: "ID", aliases: [], nameKey: "Id", nameKeyAliases: [],
        valueType: "number", dataTypeId: "int", defaultValue: 1, fields: [],
        editor: { kind: "number", readOnly: false, integer: true, options: [] },
        cellEncoding: { kind: "scalar" },
      },
      {
        id: "name", title: "Name", aliases: [], nameKey: "Name", nameKeyAliases: [],
        valueType: "string", dataTypeId: "string", defaultValue: "", fields: [],
        editor: { kind: "text", readOnly: false, integer: false, options: [] },
        cellEncoding: { kind: "scalar" },
      },
    ],
  }],
};

const document: TableDocument = {
  format: "csv",
  sheets: [{
    id: "skills-a",
    definitionId: "skills",
    title: "Skills A",
    name: "Skills_A",
    headerRows: [],
    columnIndexes: { id: 0, name: 1 },
    rows: [{ id: "row-1", cells: { id: 1001, name: "Fireball" }, rawCells: [], changedColumnIds: [] }],
  }],
};

test("table row provider searches and resolves stable typed keys with locations", async () => {
  const provider = createTableRowReferenceProvider(async () => [{
    projectId: "sample",
    documentTypeId: "game.table.skills",
    path: "Tables/Skills_A.csv",
    document,
    tableType,
  }]);
  const service = new ReferenceService([provider]);
  const definition = {
    kind: "table.row",
    target: { tableTypeId: "legacy.table.skills", sheetId: "skills" },
    allowMissing: false,
  } as const;
  const results = await service.search(definition, "fire 1001", 20);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.value, 1001);
  assert.equal(results[0]?.location?.rowId, "row-1");
  assert.equal((await service.resolve(definition, 1001)).status, "resolved");
  assert.equal((await service.resolve(definition, "1001")).status, "missing");
});

test("table fields expose nested reference occurrences", () => {
  const referencedType: TableTypeDefinition = {
    ...tableType,
    sheets: [{
      ...tableType.sheets[0]!,
      columns: [{
        ...tableType.sheets[0]!.columns[0]!,
        editor: { kind: "reference", readOnly: false, integer: false, options: [] },
        reference: {
          kind: "table.row",
          target: { tableTypeId: "game.table.skills", sheetId: "skills" },
          allowMissing: false,
        },
      }, tableType.sheets[0]!.columns[1]!],
    }],
  };
  assert.deepEqual(collectTableReferences(document, referencedType), [{
    definition: {
      kind: "table.row",
      target: { tableTypeId: "game.table.skills", sheetId: "skills" },
      allowMissing: false,
    },
    value: 1001,
    path: "sheets.skills-a.rows.row-1.cells.id",
  }]);
});
