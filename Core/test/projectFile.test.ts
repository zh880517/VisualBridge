import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectOperations,
  findMatchingDocumentTypes,
  parseProjectFile,
  serializeProjectFile,
  type VisualBridgeProjectDefinition,
} from "../index";
import type * as ProjectFixture from "../../TestData/projectFixture.js";

// dist 布局比源码多一层，因此运行时按编译输出深度解析共享 fixture；类型走源码路径。
const { createTestProject } = require("../../../TestData/projectFixture.js") as typeof ProjectFixture;

test("Project Document Types require Catalog arrays and match custom extensions", () => {
  const valid = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.game.settings",
      editor: "structured",
      include: ["Config/**/*.gamesettings"],
      exclude: [],
      catalogs: ["Catalog/Game.vbstructuredcatalog"],
    }],
  })));
  assert.equal(valid.success, true);
  if (!valid.success) {
    throw new Error("Valid Project fixture failed.");
  }
  assert.deepEqual(
    findMatchingDocumentTypes(
      valid.value,
      "Config/Default.gamesettings",
      (pattern, path) => pattern === "Config/**/*.gamesettings" && path.endsWith(".gamesettings"),
      { editor: "structured" },
    ).map((documentType) => documentType.id),
    ["sample.game.settings"],
  );

  const obsolete = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.game.settings",
      editor: "structured",
      include: ["Config/**/*.gamesettings"],
      catalog: "Catalog/Game.vbstructuredcatalog",
    }],
  })));
  assert.equal(obsolete.success, false);
  assert.ok(obsolete.issues.some((issue) =>
    issue.path === "documentTypes[0].catalog" && issue.message.includes("not supported")));
});

test("Project Provider declarations use built project-relative entries and conflict-free capabilities", () => {
  const valid = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings"],
      exclude: [],
    }],
    providers: [{
      id: "sample.provider",
      entry: "Providers/sample-provider.mjs",
      args: ["--fixture", "sample"],
      capabilities: {
        reference: { kinds: ["sample.item"] },
        validator: { documentTypes: ["sample.settings"] },
      },
    }],
  })));
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.deepEqual(valid.value.providers, [{
      id: "sample.provider",
      entry: "Providers/sample-provider.mjs",
      args: ["--fixture", "sample"],
      capabilities: {
        reference: { kinds: ["sample.item"] },
        validator: { documentTypes: ["sample.settings"] },
      },
    }]);
  }

  const invalid = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings"],
    }],
    providers: [{
      id: "first",
      entry: "../outside.mjs",
      args: "--unsafe",
      capabilities: {
        reference: { kinds: ["document", "sample.duplicate"] },
        validator: { documentTypes: ["missing.type"] },
        operation: true,
      },
      command: "node",
    }, {
      id: "second",
      entry: "Providers/second.ts",
      args: [],
      capabilities: { reference: { kinds: ["sample.duplicate"] } },
    }],
  })));
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.deepEqual(invalid.issues.map((issue) => issue.path), [
      "providers[0].command",
      "providers[0].entry",
      "providers[0].args",
      "providers[0].capabilities.operation",
      "providers[0].capabilities.reference.kinds[0]",
      "providers[0].capabilities.validator.documentTypes[0]",
      "providers[1].entry",
      "providers[1].capabilities.reference.kinds[0]",
    ]);
  }
});

test("Project Operations apply atomically and serialize deterministically", () => {
  const parsed = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings"],
      exclude: [],
      catalogs: ["Catalog/Game.vbstructuredcatalog"],
    }],
  })));
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Project fixture failed.");

  const result = applyProjectOperations(parsed.value, [{
    type: "project.upsertDocumentType",
    index: 1,
    documentType: {
      id: "sample.graph",
      editor: "graph",
      include: ["Graph/**/*.flow"],
      exclude: [],
      catalogs: ["Catalog/Game.vbgraphcatalog"],
    },
  }, {
    type: "project.addModule",
    module: {
      id: "visualbridge.table",
      entry: "Modules/table.vbmodule.js",
      options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
    },
  }]);
  assert.equal(result.success, true);
  if (!result.success) throw new Error("Project Operations failed.");
  assert.equal(result.text, serializeProjectFile(result.document));
  assert.equal(parseProjectFile(result.text).success, true);
  assert.deepEqual(result.document.documentTypes.map((entry) => entry.id), ["sample.settings", "sample.graph"]);
  assert.deepEqual(result.document.modules, [{
    id: "visualbridge.table",
    entry: "Modules/table.vbmodule.js",
    options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
  }]);

  const invalid = applyProjectOperations(result.document, [{
    type: "project.removeDocumentType",
    documentTypeId: "sample.settings",
  }]);
  assert.equal(invalid.success, true);
  if (!invalid.success) throw new Error("Removal should remain structurally valid.");

  const atomicFailure = applyProjectOperations(parsed.value, [{
    type: "project.setDocumentRoots",
    documentRoots: ["../outside"],
  }, {
    type: "project.setProjectId",
    projectId: "changed.project",
  }]);
  assert.equal(atomicFailure.success, false);
  assert.equal(parsed.value.projectId, "sample.project");
});

test("Project parsing rejects unknown fields and duplicate glob patterns", () => {
  const result = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    extra: { unexpected: true },
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings", "Config/**/*.settings"],
      exclude: [],
      catalogs: ["Catalog/Game.vbstructuredcatalog"],
      obsolete: true,
    }],
  })));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.issues.map((issue) => issue.path), [
      "$.unexpected",
      "documentTypes[0].obsolete",
      "documentTypes[0].include[1]",
    ]);
  }
});

test("Project parsing rejects absolute, parent, negated and empty-segment globs", () => {
  const result = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["/Config/**/*.json", "../Config/**/*.json", "!Config/**/*.json", "Config//*.json"],
      exclude: ["C:/outside/*.json"],
      catalogs: [],
    }],
  })));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.issues.map((issue) => issue.path), [
      "documentTypes[0].include[0]",
      "documentTypes[0].include[1]",
      "documentTypes[0].include[2]",
      "documentTypes[0].include[3]",
      "documentTypes[0].exclude[0]",
    ]);
  }
});

test("Project parsing rejects brace, extglob, character-class, question and multi-star segment syntax", () => {
  const result = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: [
        "{..,Config}/**/*.json",
        "@(Config|..)/**/*.json",
        "Config/[.][.]/**/*.json",
        "Config/??/**/*.json",
        "Config/a*b*c.json",
      ],
      exclude: [],
      catalogs: [],
    }],
  })));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.issues.map((issue) => issue.path), [
      "documentTypes[0].include[0]",
      "documentTypes[0].include[1]",
      "documentTypes[0].include[2]",
      "documentTypes[0].include[3]",
      "documentTypes[0].include[4]",
    ]);
  }
});

test("Project Operations reject unknown nested payload fields", () => {
  const parsed = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings"],
      exclude: [],
      catalogs: [],
    }],
  })));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const result = applyProjectOperations(parsed.value, [{
    type: "project.upsertProvider",
    provider: {
      id: "custom",
      entry: "Providers/custom.mjs",
      args: [],
      capabilities: {
        reference: { kinds: ["custom.asset"], ignored: true },
      },
    },
  }]);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.issues.some((issue) => (
      issue.path === "operations[0].provider.capabilities.reference.ignored"
    )));
  }
});

test("Project addProvider never overwrites an existing Provider", () => {
  const parsed = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings"],
      exclude: [],
      catalogs: [],
    }],
    providers: [{
      id: "existing",
      entry: "Providers/existing.mjs",
      args: ["original"],
      capabilities: { reference: { kinds: ["sample.original"] } },
    }],
  })));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyProjectOperations(parsed.value, [{
    type: "project.addProvider",
    provider: {
      id: "existing",
      entry: "Providers/replacement.mjs",
      args: [],
      capabilities: { reference: { kinds: ["sample.replacement"] } },
    },
  }]);
  assert.equal(result.success, false);
  assert.equal(parsed.value.providers[0]?.entry, "Providers/existing.mjs");
  assert.deepEqual(parsed.value.providers[0]?.args, ["original"]);
});

test("Project identity renames update dependent Provider validator bindings in one batch", () => {
  const parsed = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    documentTypes: [{
      id: "sample.old",
      editor: "structured",
      include: ["Config/**/*.settings"],
      exclude: [],
      catalogs: [],
    }],
    providers: [{
      id: "provider.old",
      entry: "Providers/provider.mjs",
      args: [],
      capabilities: { validator: { documentTypes: ["sample.old"] } },
    }],
  })));
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Project fixture failed.");
  const result = applyProjectOperations(parsed.value, [{
    type: "project.renameDocumentType",
    documentTypeId: "sample.old",
    newId: "sample.new",
  }, {
    type: "project.renameProvider",
    providerId: "provider.old",
    newId: "provider.new",
  }]);
  assert.equal(result.success, true);
  if (!result.success) throw new Error("Project rename batch failed.");
  assert.equal(result.document.documentTypes[0]?.id, "sample.new");
  assert.equal(result.document.providers[0]?.id, "provider.new");
  assert.deepEqual(result.document.providers[0]?.capabilities.validator?.documentTypes, ["sample.new"]);
});

test("Project File v2 requires modules and rejects formatVersion 1 with a migration hint", () => {
  const withoutModules = parseProjectFile(JSON.stringify({
    formatVersion: 2,
    projectId: "sample.project",
    documentRoots: ["Config"],
    documentTypes: [],
  }));
  assert.equal(withoutModules.success, false);
  if (!withoutModules.success) {
    assert.deepEqual(withoutModules.issues.map((issue) => issue.path), ["modules"]);
  }

  const versionOne = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
    documentTypes: [],
    tableLayout: { nameKeyRow: 2, dataStartRow: 3 },
  }));
  assert.equal(versionOne.success, false);
  if (!versionOne.success) {
    const versionIssue = versionOne.issues[0];
    assert.equal(versionIssue?.path, "formatVersion");
    assert.equal(versionIssue?.code, "project.formatVersionUnsupported");
    assert.match(versionIssue?.message ?? "", /modules/u);
    assert.match(versionIssue?.message ?? "", /visualbridge\.table/u);
    assert.equal(versionOne.issues.some((issue) => issue.path === "$.tableLayout"), true);
  }

  const versionThree = parseProjectFile(JSON.stringify(createTestProject({ formatVersion: 3 })));
  assert.equal(versionThree.success, false);
  if (!versionThree.success) {
    assert.equal(versionThree.issues[0]?.path, "formatVersion");
    assert.equal(versionThree.issues[0]?.code, "project.formatVersionUnsupported");
  }

  // 顶层 tableLayout 在 v2 是未知键；布局只能写在 visualbridge.table 模块的 options 里。
  const legacyLayout = parseProjectFile(JSON.stringify(createTestProject({
    extra: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
  })));
  assert.equal(legacyLayout.success, false);
  if (!legacyLayout.success) {
    assert.deepEqual(legacyLayout.issues.map((issue) => issue.path), ["$.tableLayout"]);
  }
});

test("Project modules validate ids, entries, options and optional hash shapes", () => {
  const valid = parseProjectFile(JSON.stringify(createTestProject({
    modules: [
      { id: "visualbridge.entity", entry: "Modules/entity.vbmodule.js" },
      {
        id: "visualbridge.table",
        entry: "Modules/table.vbmodule.js",
        options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
        hash: `sha256:${"a".repeat(64)}`,
      },
    ],
  })));
  assert.equal(valid.success, true);
  if (!valid.success) throw new Error("Valid module fixture failed.");
  assert.deepEqual(valid.value.modules, [
    { id: "visualbridge.entity", entry: "Modules/entity.vbmodule.js" },
    {
      id: "visualbridge.table",
      entry: "Modules/table.vbmodule.js",
      options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
      hash: `sha256:${"a".repeat(64)}`,
    },
  ]);

  const invalid = parseProjectFile(JSON.stringify(createTestProject({
    modules: [
      { id: "duplicate", entry: "Modules/one.vbmodule.js" },
      { id: "duplicate", entry: "Modules/two.vbmodule.js", unknown: true },
      { id: "suffix", entry: "Modules/three.js" },
      { id: "parent", entry: "../Modules/outside.vbmodule.js" },
      { id: "options", entry: "Modules/options.vbmodule.js", options: [] },
      { id: "hash", entry: "Modules/hash.vbmodule.js", hash: "sha256:ABC" },
      { id: "drive", entry: "C:/outside.vbmodule.js" },
      { id: "control", entry: "Modules/ba\u0001d.vbmodule.js" },
    ],
  })));
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.deepEqual(invalid.issues.map((issue) => issue.path), [
      "modules[1].unknown",
      "modules[1].id",
      "modules[2].entry",
      "modules[3].entry",
      "modules[4].options",
      "modules[5].hash",
      "modules[6].entry",
      "modules[7].entry",
    ]);
  }
});

test("Project Module Operations add, upsert, move, set options and remove in order", () => {
  const parsed = parseProjectFile(JSON.stringify(createTestProject({ projectId: "sample.project" })));
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Project fixture failed.");

  const graph = { id: "visualbridge.graph", entry: "Modules/graph.vbmodule.js" };
  const table = { id: "visualbridge.table", entry: "Modules/table.vbmodule.js" };
  const added = applyProjectOperations(parsed.value, [
    { type: "project.addModule", module: graph },
    { type: "project.addModule", module: table },
  ]);
  assert.equal(added.success, true);
  if (!added.success) throw new Error("addModule failed.");
  assert.deepEqual(added.document.modules.map((entry) => entry.id), ["visualbridge.graph", "visualbridge.table"]);

  const upserted = applyProjectOperations(added.document, [{
    type: "project.upsertModule",
    module: {
      id: "visualbridge.graph",
      entry: "Modules/graph.vbmodule.js",
      hash: `sha256:${"b".repeat(64)}`,
    },
  }]);
  assert.equal(upserted.success, true);
  if (!upserted.success) throw new Error("upsertModule failed.");
  assert.equal(upserted.document.modules[0]?.hash, `sha256:${"b".repeat(64)}`);
  assert.equal(upserted.document.modules.length, 2);

  const moved = applyProjectOperations(upserted.document, [{
    type: "project.moveModule",
    moduleId: "visualbridge.table",
    toIndex: 0,
  }]);
  assert.equal(moved.success, true);
  if (!moved.success) throw new Error("moveModule failed.");
  assert.deepEqual(moved.document.modules.map((entry) => entry.id), ["visualbridge.table", "visualbridge.graph"]);

  const optionsSet = applyProjectOperations(moved.document, [{
    type: "project.setModuleOptions",
    moduleId: "visualbridge.table",
    options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
  }]);
  assert.equal(optionsSet.success, true);
  if (!optionsSet.success) throw new Error("setModuleOptions failed.");
  assert.deepEqual(optionsSet.document.modules[0]?.options, {
    tableLayout: { nameKeyRow: 2, dataStartRow: 3 },
  });

  const cleared = applyProjectOperations(optionsSet.document, [{
    type: "project.setModuleOptions",
    moduleId: "visualbridge.table",
  }]);
  assert.equal(cleared.success, true);
  if (!cleared.success) throw new Error("clearing module options failed.");
  assert.equal(cleared.document.modules[0]?.options, undefined);

  const removed = applyProjectOperations(cleared.document, [{
    type: "project.removeModule",
    moduleId: "visualbridge.graph",
  }]);
  assert.equal(removed.success, true);
  if (!removed.success) throw new Error("removeModule failed.");
  assert.deepEqual(removed.document.modules.map((entry) => entry.id), ["visualbridge.table"]);
  assert.equal(parseProjectFile(removed.text).success, true);
});

test("Project Module Operations reject duplicates, unknown ids, bad indexes and unknown keys", () => {
  const parsed = parseProjectFile(JSON.stringify(createTestProject({
    projectId: "sample.project",
    modules: [{ id: "visualbridge.table", entry: "Modules/table.vbmodule.js" }],
  })));
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("Project fixture failed.");

  const duplicate = applyProjectOperations(parsed.value, [{
    type: "project.addModule",
    module: { id: "visualbridge.table", entry: "Modules/other.vbmodule.js" },
  }]);
  assert.equal(duplicate.success, false);
  if (!duplicate.success) {
    assert.deepEqual(duplicate.issues.map((issue) => issue.path), ["operations[0].module.id"]);
  }

  const unknownModule = applyProjectOperations(parsed.value, [{
    type: "project.removeModule",
    moduleId: "visualbridge.missing",
  }]);
  assert.equal(unknownModule.success, false);
  if (!unknownModule.success) {
    assert.deepEqual(unknownModule.issues.map((issue) => issue.path), ["operations[0].moduleId"]);
  }

  const badIndex = applyProjectOperations(parsed.value, [{
    type: "project.moveModule",
    moduleId: "visualbridge.table",
    toIndex: 4,
  }]);
  assert.equal(badIndex.success, false);
  if (!badIndex.success) {
    assert.deepEqual(badIndex.issues.map((issue) => issue.path), ["operations[0].toIndex"]);
  }

  const unknownKey = applyProjectOperations(parsed.value, [{
    type: "project.upsertModule",
    module: { id: "visualbridge.table", entry: "Modules/table.vbmodule.js", manual: true },
  }]);
  assert.equal(unknownKey.success, false);
  if (!unknownKey.success) {
    assert.deepEqual(unknownKey.issues.map((issue) => issue.path), ["operations[0].module.manual"]);
  }

  const badOptions = applyProjectOperations(parsed.value, [{
    type: "project.setModuleOptions",
    moduleId: "visualbridge.table",
    options: [1, 2],
  }]);
  assert.equal(badOptions.success, false);
  if (!badOptions.success) {
    assert.deepEqual(badOptions.issues.map((issue) => issue.path), ["operations[0].options"]);
  }

  const removedLayoutOperation = applyProjectOperations(parsed.value, [{
    type: "project.setTableLayout",
    tableLayout: { nameKeyRow: 2, dataStartRow: 3 },
  }]);
  assert.equal(removedLayoutOperation.success, false);
  if (!removedLayoutOperation.success) {
    assert.ok(removedLayoutOperation.issues.some((issue) => (
      issue.path === "operations[0].type" && issue.message.includes("visualbridge.table")
    )));
  }

  // 非法 entry 路径必须由最终严格重解析拒绝：父目录逃逸与盘符前缀。
  for (const entry of ["../outside.vbmodule.js", "C:/outside.vbmodule.js"]) {
    const escaped = applyProjectOperations(parsed.value, [{
      type: "project.addModule",
      module: { id: "visualbridge.escape", entry },
    }]);
    assert.equal(escaped.success, false, `addModule must reject entry '${entry}'.`);
    if (!escaped.success) {
      assert.deepEqual(escaped.issues.map((issue) => issue.path), ["modules[1].entry"]);
    }

    const upsertedEscape = applyProjectOperations(parsed.value, [{
      type: "project.upsertModule",
      module: { id: "visualbridge.escape", entry },
    }]);
    assert.equal(upsertedEscape.success, false, `upsertModule must reject entry '${entry}'.`);
    if (!upsertedEscape.success) {
      assert.deepEqual(upsertedEscape.issues.map((issue) => issue.path), ["modules[1].entry"]);
    }
  }
});

test("serializeProjectFile keeps modules before Document Types and omits absent options", () => {
  const project: VisualBridgeProjectDefinition = createTestProject<VisualBridgeProjectDefinition>({
    projectId: "sample.project",
    modules: [{ id: "visualbridge.graph", entry: "Modules/graph.vbmodule.js", options: { depth: 1 } }],
    providers: [],
  });
  const text = serializeProjectFile(project);
  assert.deepEqual(Object.keys(JSON.parse(text) as Record<string, unknown>), [
    "formatVersion",
    "projectId",
    "documentRoots",
    "modules",
    "documentTypes",
  ]);
  assert.match(text, /"formatVersion": 2/u);
  assert.equal(parseProjectFile(text).success, true);

  const withoutOptions = serializeProjectFile(createTestProject<VisualBridgeProjectDefinition>({
    modules: [{ id: "visualbridge.graph", entry: "Modules/graph.vbmodule.js" }],
    providers: [],
  }));
  assert.equal(withoutOptions.includes("options"), false);
  assert.equal(withoutOptions.includes("providers"), false);
});
