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
