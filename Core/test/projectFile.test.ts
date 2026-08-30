import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectOperations,
  findMatchingDocumentTypes,
  parseProjectFile,
  serializeProjectFile,
} from "../index";

test("Project Document Types require Catalog arrays and match custom extensions", () => {
  const valid = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
    documentTypes: [{
      id: "sample.game.settings",
      editor: "structured",
      include: ["Config/**/*.gamesettings"],
      exclude: [],
      catalogs: ["Catalog/Game.vbstructuredcatalog"],
    }],
  }));
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

  const obsolete = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
    documentTypes: [{
      id: "sample.game.settings",
      editor: "structured",
      include: ["Config/**/*.gamesettings"],
      catalog: "Catalog/Game.vbstructuredcatalog",
    }],
  }));
  assert.equal(obsolete.success, false);
  assert.ok(obsolete.issues.some((issue) =>
    issue.path === "documentTypes[0].catalog" && issue.message.includes("not supported")));
});

test("Project Provider declarations use built project-relative entries and conflict-free capabilities", () => {
  const valid = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
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
  }));
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

  const invalid = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
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
  }));
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
  const parsed = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings"],
      exclude: [],
      catalogs: ["Catalog/Game.vbstructuredcatalog"],
    }],
  }));
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
    type: "project.setTableLayout",
    tableLayout: { nameKeyRow: 2, dataStartRow: 3 },
  }]);
  assert.equal(result.success, true);
  if (!result.success) throw new Error("Project Operations failed.");
  assert.equal(result.text, serializeProjectFile(result.document));
  assert.equal(parseProjectFile(result.text).success, true);
  assert.deepEqual(result.document.documentTypes.map((entry) => entry.id), ["sample.settings", "sample.graph"]);

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
  const result = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
    unexpected: true,
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings", "Config/**/*.settings"],
      exclude: [],
      catalogs: ["Catalog/Game.vbstructuredcatalog"],
      obsolete: true,
    }],
  }));
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
  const result = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["/Config/**/*.json", "../Config/**/*.json", "!Config/**/*.json", "Config//*.json"],
      exclude: ["C:/outside/*.json"],
      catalogs: [],
    }],
  }));
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
  const result = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
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
  }));
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
  const parsed = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
    documentTypes: [{
      id: "sample.settings",
      editor: "structured",
      include: ["Config/**/*.settings"],
      exclude: [],
      catalogs: [],
    }],
  }));
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
  const parsed = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
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
  }));
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
  const parsed = parseProjectFile(JSON.stringify({
    formatVersion: 1,
    projectId: "sample.project",
    documentRoots: ["Config"],
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
  }));
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
