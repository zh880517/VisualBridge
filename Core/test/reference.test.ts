import assert from "node:assert/strict";
import test from "node:test";
import {
  ReferenceService,
  collectFieldReferences,
  parseFieldDefinitions,
  type DocumentDiagnostic,
  type ReferenceCandidate,
  type ReferenceProvider,
} from "../index";

test("field reference definitions collect nested occurrences and reject incomplete contracts", () => {
  const diagnostics: DocumentDiagnostic[] = [];
  const definitions = parseFieldDefinitions([{
    id: "skillIds",
    title: "Skills",
    aliases: [],
    valueType: "array",
    defaultValue: [],
    item: {
      valueType: "number",
      dataTypeId: "int",
      defaultValue: 1001,
      editor: { kind: "reference" },
      reference: {
        kind: "table.row",
        target: { tableTypeId: "game.table.skills", sheetId: "skills" },
      },
    },
  }], "fields", diagnostics);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(collectFieldReferences({ skillIds: [1001, 1002] }, definitions, "properties"), [
    {
      definition: {
        kind: "table.row",
        target: { sheetId: "skills", tableTypeId: "game.table.skills" },
        allowMissing: false,
      },
      value: 1001,
      path: "properties.skillIds[0]",
    },
    {
      definition: {
        kind: "table.row",
        target: { sheetId: "skills", tableTypeId: "game.table.skills" },
        allowMissing: false,
      },
      value: 1002,
      path: "properties.skillIds[1]",
    },
  ]);

  const invalidDiagnostics: DocumentDiagnostic[] = [];
  parseFieldDefinitions([{
    id: "skillId",
    title: "Skill",
    aliases: [],
    valueType: "number",
    defaultValue: 1001,
    editor: { kind: "reference" },
  }], "fields", invalidDiagnostics);
  assert.ok(invalidDiagnostics.some((diagnostic) => diagnostic.code === "field.missingReferenceDefinition"));
});

test("reference service searches deterministically and validates resolved, missing, and ambiguous values", async () => {
  const candidates: ReferenceCandidate[] = [
    candidate(1002, "Ice Nova", "Tables/Skills_B.csv", "row-b"),
    candidate(1001, "Fireball", "Tables/Skills_A.csv", "row-a"),
  ];
  const provider: ReferenceProvider = {
    kind: "table.row",
    async search(request) {
      return candidates.filter((entry) => entry.title.toLocaleLowerCase().includes(request.query.toLocaleLowerCase()));
    },
    async resolve(request) {
      return candidates.filter((entry) => entry.value === request.value);
    },
  };
  const service = new ReferenceService([provider]);
  const definition = {
    kind: "table.row",
    target: { tableTypeId: "game.table.skills", sheetId: "skills" },
    allowMissing: false,
  } as const;

  assert.deepEqual((await service.search(definition)).map((entry) => entry.value), [1001, 1002]);
  assert.equal((await service.resolve(definition, 1001)).status, "resolved");
  assert.deepEqual(await service.validate([
    { definition, value: 1001, path: "properties.skillId" },
    { definition, value: 9999, path: "properties.missingSkillId" },
  ]), [{
    severity: "error",
    code: "reference.missingTarget",
    path: "properties.missingSkillId",
    message: "Reference '9999' does not resolve for kind 'table.row'.",
  }]);

  candidates.push(candidate(1001, "Duplicate Fireball", "Tables/Skills_C.csv", "row-c"));
  const ambiguous = await service.resolve(definition, 1001);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
});

function candidate(value: number, title: string, path: string, rowId: string): ReferenceCandidate {
  return {
    kind: "table.row",
    target: { tableTypeId: "game.table.skills", sheetId: "skills" },
    value,
    title,
    location: {
      projectId: "sample",
      documentTypeId: "game.table.skills",
      path,
      sheetId: "skills",
      rowId,
    },
  };
}
