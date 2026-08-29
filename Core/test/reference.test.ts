import assert from "node:assert/strict";
import test from "node:test";
import {
  ReferenceService,
  collectFieldReferences,
  createDocumentReferenceProvider,
  createReferenceValueRenamePlan,
  parseFieldDefinitions,
  replaceFieldReferenceValues,
  type DocumentDiagnostic,
  type ReferenceCandidate,
  type ReferenceProvider,
} from "../index";

test("document reference provider uses Document Type identity and stable document IDs", async () => {
  const provider = createDocumentReferenceProvider(async () => [{
    projectId: "sample",
    documentTypeId: "game.entity.hero",
    editor: "entity",
    path: "Entities/Player.herojson",
    documentId: "hero.player",
    title: "Player",
  }, {
    projectId: "sample",
    documentTypeId: "game.entity.enemy",
    editor: "entity",
    path: "Entities/Enemy.enemyjson",
    documentId: "hero.player",
    title: "Enemy",
  }]);
  const service = new ReferenceService([provider]);
  const definition = {
    kind: "document",
    target: { documentTypeId: "game.entity.hero" },
    allowMissing: false,
  } as const;

  const searched = await service.search(definition, "player", 10);
  assert.equal(searched.length, 1);
  assert.equal(searched[0]?.value, "hero.player");
  assert.equal(searched[0]?.location?.path, "Entities/Player.herojson");
  assert.equal((await service.resolve(definition, "hero.player")).status, "resolved");
  assert.equal((await service.resolve(definition, 1)).status, "missing");

  const invalid = await service.validate([{
    definition: { kind: "document", target: {}, allowMissing: false },
    value: "hero.player",
    path: "properties.hero",
  }]);
  assert.equal(invalid[0]?.code, "reference.invalidTarget");
});

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

test("field reference replacement follows nested definitions and materializes defaults", () => {
  const diagnostics: DocumentDiagnostic[] = [];
  const definitions = parseFieldDefinitions([{
    id: "settings",
    title: "Settings",
    aliases: [],
    valueType: "object",
    defaultValue: { skills: [1001, 1002] },
    fields: [{
      id: "skills",
      title: "Skills",
      aliases: [],
      valueType: "array",
      defaultValue: [],
      item: {
        valueType: "number",
        defaultValue: 0,
        editor: { kind: "reference" },
        reference: { kind: "table.row", target: { tableTypeId: "skills", sheetId: "skills" } },
      },
    }],
  }], "fields", diagnostics);
  assert.deepEqual(diagnostics, []);
  const replaced = replaceFieldReferenceValues({}, definitions, "properties", (occurrence) => (
    occurrence.path === "properties.settings.skills[1]"
  ), 2002);
  assert.deepEqual(replaced, {
    properties: { settings: { skills: [1001, 2002] } },
    changedPaths: ["properties.settings.skills[1]"],
  });
});

test("reference rename plan follows one resolved target and sorts impacted occurrences", () => {
  const definition = {
    kind: "table.row",
    target: { tableTypeId: "skills", sheetId: "skills" },
    allowMissing: false,
  } as const;
  const selected = {
    occurrence: { definition, value: 1001, path: "properties.skillId" },
    resolution: { status: "resolved" as const, candidates: [candidate(1001, "Fireball", "Tables/Skills.csv", "skills:key-1001")] },
  };
  const result = createReferenceValueRenamePlan([{
    projectId: "sample",
    documentTypeId: "entity.hero",
    editor: "entity",
    path: "Entities/Hero.vbentity",
    sourcePaths: ["Entities/Hero.vbentity"],
    title: "Hero",
    diagnostics: [],
    references: [selected],
  }, {
    projectId: "sample",
    documentTypeId: "structured.settings",
    editor: "structured",
    path: "Config/Settings.vbconfig",
    sourcePaths: ["Config/Settings.vbconfig"],
    title: "Settings",
    diagnostics: [],
    references: [{
      occurrence: { definition, value: 1001, path: "properties.defaultSkill" },
      resolution: selected.resolution,
    }],
  }], selected, 2001);
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.plan.changes.map((change) => change.path), [
      "Entities/Hero.vbentity",
      "Config/Settings.vbconfig",
    ]);
  }
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
