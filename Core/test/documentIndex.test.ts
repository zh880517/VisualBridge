import assert from "node:assert/strict";
import test from "node:test";
import {
  searchIndexedDocuments,
  sortIndexedDocuments,
  summarizeDocumentIndex,
  type IndexedDocument,
} from "../index";

const documents: IndexedDocument[] = [
  {
    projectId: "sample.project",
    documentTypeId: "sample.table.skills",
    editor: "table",
    path: "Tables/Skills_A.csv",
    sourcePaths: ["Tables/Skills_A.csv", "Tables/Skills_B.csv"],
    title: "Skills",
    diagnostics: [],
    references: [],
  },
  {
    projectId: "sample.project",
    documentTypeId: "sample.entity.hero",
    editor: "entity",
    path: "Config/Hero.herojson",
    sourcePaths: ["Config/Hero.herojson"],
    title: "Player",
    documentId: "hero.player",
    diagnostics: [{
      severity: "error",
      code: "reference.missingTarget",
      path: "properties.skillId",
      message: "Skill 404 is missing.",
    }, {
      severity: "warning",
      code: "entity.unknownComponentType",
      path: "components[0]",
      message: "Unknown component.",
    }],
    references: [{
      occurrence: {
        definition: {
          kind: "table.row",
          target: { tableTypeId: "sample.table.skills", sheetId: "skills" },
          allowMissing: false,
        },
        value: 404,
        path: "properties.skillId",
      },
      resolution: { status: "missing", candidates: [] },
    }],
  },
];

test("document index sorting and search are stable across semantic fields", () => {
  assert.deepEqual(sortIndexedDocuments(documents).map((document) => document.editor), ["entity", "table"]);
  assert.deepEqual(searchIndexedDocuments(documents, "player skill 404").map((document) => document.documentId), ["hero.player"]);
  assert.deepEqual(searchIndexedDocuments(documents, "skills_b").map((document) => document.editor), ["table"]);
  assert.deepEqual(searchIndexedDocuments(documents, "missingtarget").map((document) => document.editor), ["entity"]);
  assert.deepEqual(searchIndexedDocuments(documents, "").map((document) => document.editor), ["entity", "table"]);
});

test("document index summary counts documents, diagnostics, and references", () => {
  assert.deepEqual(summarizeDocumentIndex(documents), {
    documentCount: 2,
    errorCount: 1,
    warningCount: 1,
    referenceCount: 1,
  });
});
