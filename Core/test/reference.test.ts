import assert from "node:assert/strict";
import test from "node:test";
import {
  ReferenceService,
  collectFieldReferences,
  createDocumentReferenceProvider,
  createReferenceSearchCursor,
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

test("reference service awaits target validation and keeps invalid or unavailable states distinct", async () => {
  const invalidProvider: ReferenceProvider = {
    kind: "sample.item",
    async validateTarget() {
      await Promise.resolve();
      return "Expected target.category.";
    },
    async search() {
      throw new Error("search must not run for an invalid target");
    },
    async resolve() {
      throw new Error("resolve must not run for an invalid target");
    },
  };
  const invalidService = new ReferenceService([invalidProvider]);
  const definition = { kind: "sample.item", target: {}, allowMissing: false } as const;
  assert.deepEqual(await invalidService.searchDetailed(definition), {
    status: "invalidTarget",
    candidates: [],
    message: "Expected target.category.",
  });
  assert.deepEqual(await invalidService.resolve(definition, "item-1"), {
    status: "invalidTarget",
    candidates: [],
    message: "Expected target.category.",
  });

  const unavailableService = new ReferenceService([{
    kind: "sample.offline",
    async search() {
      throw new Error("Provider process exited.");
    },
    async resolve() {
      throw new Error("Provider process exited.");
    },
  }]);
  const unavailable = { kind: "sample.offline", target: {}, allowMissing: false } as const;
  assert.equal((await unavailableService.searchDetailed(unavailable)).status, "providerUnavailable");
  assert.equal((await unavailableService.resolve(unavailable, "item-1")).status, "providerUnavailable");
  assert.equal((await unavailableService.validate([{
    definition: unavailable,
    value: "item-1",
    path: "properties.item",
  }]))[0]?.code, "reference.providerUnavailable");
});

test("reference analysis resolves each occurrence once and validate delegates to the same pass", async () => {
  let resolveCount = 0;
  let validateTargetCount = 0;
  const provider: ReferenceProvider = {
    kind: "sample.item",
    validateTarget() {
      validateTargetCount += 1;
      return undefined;
    },
    async search() {
      return [];
    },
    async resolve(request) {
      resolveCount += 1;
      return request.value === "present"
        ? [{ kind: "sample.item", target: request.target, value: request.value, title: "Present" }]
        : [];
    },
  };
  const service = new ReferenceService([provider]);
  const definition = { kind: "sample.item", target: { scope: "items" }, allowMissing: false } as const;
  const occurrences = [
    { definition, value: "present", path: "properties.primary" },
    { definition, value: "missing", path: "properties.secondary" },
  ] as const;

  const analysis = await service.analyzeOccurrences(occurrences);
  assert.equal(resolveCount, occurrences.length);
  assert.equal(validateTargetCount, occurrences.length);
  assert.deepEqual(analysis.references.map((reference) => reference.resolution.status), ["resolved", "missing"]);
  assert.deepEqual(analysis.diagnostics.map((diagnostic) => diagnostic.code), ["reference.missingTarget"]);

  resolveCount = 0;
  validateTargetCount = 0;
  assert.deepEqual(
    (await service.validate(occurrences)).map((diagnostic) => diagnostic.code),
    ["reference.missingTarget"],
  );
  assert.equal(resolveCount, occurrences.length);
  assert.equal(validateTargetCount, occurrences.length);
});

test("reference analysis propagates cancellation and never publishes a partial result", async () => {
  let releaseSecond!: (candidates: readonly ReferenceCandidate[]) => void;
  let secondStarted!: () => void;
  const secondStart = new Promise<void>((resolve) => { secondStarted = resolve; });
  let receivedSignal: AbortSignal | undefined;
  const provider: ReferenceProvider = {
    kind: "sample.item",
    async search() {
      return [];
    },
    async resolve(request) {
      receivedSignal = request.signal;
      if (request.value === "first") {
        return [{ kind: "sample.item", target: request.target, value: request.value, title: "First" }];
      }
      secondStarted();
      return new Promise((resolve) => { releaseSecond = resolve; });
    },
  };
  const service = new ReferenceService([provider]);
  const definition = { kind: "sample.item", target: {}, allowMissing: false } as const;
  const controller = new AbortController();
  let published = false;
  const analysis = service.analyzeOccurrences([
    { definition, value: "first", path: "properties.first" },
    { definition, value: "second", path: "properties.second" },
  ], controller.signal).then((result) => {
    published = true;
    return result;
  });

  await secondStart;
  controller.abort();
  releaseSecond([]);
  await assert.rejects(analysis, (error) => error instanceof Error && error.name === "AbortError");
  assert.equal(receivedSignal, controller.signal);
  assert.equal(published, false);
});

test("reference cursor pages have no gaps, preserve value types, and reject changed snapshots", async () => {
  let searchCount = 0;
  const mixedCandidates: ReferenceCandidate[] = [
    mixedCandidate("2"),
    mixedCandidate(3),
    mixedCandidate("1"),
    mixedCandidate(1),
    mixedCandidate("3"),
    mixedCandidate(2),
  ];
  const provider: ReferenceProvider = {
    kind: "sample.mixed",
    async search(request) {
      searchCount += 1;
      assert.equal(request.query, "item");
      return mixedCandidates;
    },
    async resolve() {
      return [];
    },
  };
  const firstDefinition = {
    kind: "sample.mixed",
    target: { scope: "items", category: "all" },
    allowMissing: false,
  } as const;
  const reorderedDefinition = {
    ...firstDefinition,
    target: { category: "all", scope: "items" },
  } as const;
  const service = new ReferenceService([provider], "snapshot-a");
  const seen: ReferenceCandidate[] = [];
  let cursor;
  do {
    const page = await service.searchPage(
      seen.length === 0 ? firstDefinition : reorderedDefinition,
      seen.length === 0 ? "  ITEM  " : "item",
      2,
      cursor,
    );
    assert.equal(page.status, "ok");
    if (page.status !== "ok") break;
    seen.push(...page.candidates);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  assert.deepEqual(seen.map((candidate) => `${typeof candidate.value}:${String(candidate.value)}`), [
    "number:1",
    "number:2",
    "number:3",
    "string:1",
    "string:2",
    "string:3",
  ]);
  assert.equal(new Set(seen.map((candidate) => `${typeof candidate.value}:${String(candidate.value)}`)).size, 6);
  assert.equal(searchCount, 3);

  const firstPage = await service.searchPage(firstDefinition, "item", 2);
  assert.equal(firstPage.status, "ok");
  if (firstPage.status !== "ok" || firstPage.nextCursor === undefined) return;
  const searchCountBeforeRejection = searchCount;
  const changed = await new ReferenceService([provider], "snapshot-b").searchPage(
    firstDefinition,
    "item",
    2,
    firstPage.nextCursor,
  );
  assert.equal(changed.status, "cursor.snapshotChanged");
  assert.equal(changed.candidates.length, 0);
  assert.equal(searchCount, searchCountBeforeRejection);

  for (const [definition, query] of [
    [{ ...firstDefinition, kind: "sample.other" }, "item"],
    [{ ...firstDefinition, target: { scope: "other", category: "all" } }, "item"],
    [firstDefinition, "other query"],
  ] as const) {
    const mismatch = await service.searchPage(definition, query, 2, firstPage.nextCursor);
    assert.equal(mismatch.status, "cursor.queryMismatch");
    assert.equal(mismatch.candidates.length, 0);
  }
  assert.equal(searchCount, searchCountBeforeRejection);

  const wrongValueType = await service.searchPage(firstDefinition, "item", 2, {
    ...firstPage.nextCursor,
    after: {
      ...firstPage.nextCursor.after,
      valueType: "string",
    },
  });
  assert.equal(wrongValueType.status, "cursor.invalid");
  assert.equal(searchCount, searchCountBeforeRejection);
});

test("provider pages must advance strictly beyond the previous stable-order boundary", async () => {
  const target = { scope: "items" } as const;
  const first = { kind: "sample.paged", target, value: "b", title: "Beta" } as const;
  const earlier = { kind: "sample.paged", target, value: "a", title: "Alpha" } as const;
  const provider: ReferenceProvider = {
    kind: "sample.paged",
    async search() { return []; },
    async searchPage(request) {
      if (request.cursor === undefined) {
        return {
          status: "ok",
          candidates: [first],
          nextCursor: createReferenceSearchCursor(
            "sample.paged",
            target,
            request.query,
            request.snapshotDependencyKey,
            first,
            {
              providerId: "sample.provider",
              instanceId: "instance-a",
              generation: 1,
              entryHash: "b".repeat(64),
              cursor: "opaque-page-2",
              snapshotHash: "a".repeat(64),
            },
          ),
        };
      }
      return { status: "ok", candidates: [earlier] };
    },
    async resolve() { return []; },
  };
  const service = new ReferenceService([provider], "snapshot-a");
  const definition = { kind: "sample.paged", target, allowMissing: false } as const;
  const firstPage = await service.searchPage(definition, "", 1);
  assert.equal(firstPage.status, "ok");
  if (firstPage.status !== "ok" || firstPage.nextCursor === undefined) return;
  assert.deepEqual(firstPage.nextCursor.providerContinuation, {
    providerId: "sample.provider",
    instanceId: "instance-a",
    generation: 1,
    entryHash: "b".repeat(64),
    cursor: "opaque-page-2",
    snapshotHash: "a".repeat(64),
  });
  const secondPage = await service.searchPage(definition, "", 1, firstPage.nextCursor);
  assert.equal(secondPage.status, "providerUnavailable");
  assert.match(secondPage.message, /strictly ordered after/u);

  const damagedContinuation = await service.searchPage(definition, "", 1, {
    ...firstPage.nextCursor,
    providerContinuation: { ...firstPage.nextCursor.providerContinuation!, generation: -1 },
  });
  assert.equal(damagedContinuation.status, "cursor.invalid");
});

test("provider pages reject duplicate candidates before exposing a continuation", async () => {
  const target = { scope: "items" } as const;
  const duplicate = { kind: "sample.paged", target, value: "a", title: "Alpha" } as const;
  const provider: ReferenceProvider = {
    kind: "sample.paged",
    async search() { return []; },
    async searchPage() {
      return { status: "ok", candidates: [duplicate, duplicate] };
    },
    async resolve() { return []; },
  };
  const page = await new ReferenceService([provider], "snapshot-a").searchPage(
    { kind: "sample.paged", target, allowMissing: false },
    "",
    2,
  );

  assert.equal(page.status, "providerUnavailable");
  assert.match(page.message, /deterministically ordered/u);
  assert.deepEqual(page.candidates, []);
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

function mixedCandidate(value: string | number): ReferenceCandidate {
  return {
    kind: "sample.mixed",
    target: { category: "all", scope: "items" },
    value,
    title: "Item",
    description: `${typeof value} ${String(value)}`,
  };
}
