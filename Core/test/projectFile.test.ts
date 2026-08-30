import assert from "node:assert/strict";
import test from "node:test";
import { findMatchingDocumentTypes, parseProjectFile } from "../index";

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
