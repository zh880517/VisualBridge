import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentDiagnostic } from "@visualbridge/module-sdk";
import type { RegisteredStructuredConfigTypeDefinition } from "../src/structuredCatalog";
import type { StructuredDocument } from "../src/structuredDocument";
import {
  createSetFieldOperation,
  formatDiagnosticSummary,
  initialStructuredEditorState,
  reduceStructuredHostMessage,
  withWebviewToken,
  type StructuredEditorState,
  type StructuredStateMessage,
} from "../src/structuredEditorLogic";

const configType: RegisteredStructuredConfigTypeDefinition = {
  id: "game.settings",
  title: "Game Settings",
  aliases: [],
  catalogId: "settings",
  catalogTitle: "Settings",
  properties: [],
};

const document: StructuredDocument = {
  formatVersion: 1,
  documentId: "sample.settings",
  properties: { difficulty: "normal" },
};

function stateMessage(): StructuredStateMessage {
  return {
    type: "structuredState",
    documentVersion: 7,
    document,
    configType,
    isDirty: true,
    diagnostics: [],
  };
}

function diagnostic(severity: DocumentDiagnostic["severity"], code: string): DocumentDiagnostic {
  return { severity, code, path: "$", message: code };
}

test("field commits produce the exact setField operation sent to the Host", () => {
  assert.deepEqual(createSetFieldOperation("difficulty", "hard"), {
    type: "structured.setField",
    fieldId: "difficulty",
    value: "hard",
  });
  assert.deepEqual(createSetFieldOperation("spawn", { x: 1, y: [2, 3] }), {
    type: "structured.setField",
    fieldId: "spawn",
    value: { x: 1, y: [2, 3] },
  });
});

test("diagnostic summary counts errors and warnings independently", () => {
  assert.equal(formatDiagnosticSummary([]), "无诊断");
  assert.equal(formatDiagnosticSummary([diagnostic("warning", "w1")]), "0 错误 · 1 警告");
  assert.equal(
    formatDiagnosticSummary([
      diagnostic("error", "e1"),
      diagnostic("error", "e2"),
      diagnostic("warning", "w1"),
    ]),
    "2 错误 · 1 警告",
  );
});

test("structuredState replaces invalid state and clears pending", () => {
  const current: StructuredEditorState = {
    invalid: {
      type: "structuredInvalid",
      documentVersion: 2,
      isDirty: false,
      diagnostics: [diagnostic("error", "old")],
    },
    pending: true,
    status: "正在应用修改…",
  };

  const next = reduceStructuredHostMessage(current, stateMessage());

  assert.equal(next.state?.documentVersion, 7);
  assert.equal(next.invalid, undefined);
  assert.equal(next.pending, false);
  assert.equal(next.status, "就绪");
});

test("structuredInvalid drops the loaded document and reports its diagnostics", () => {
  const next = reduceStructuredHostMessage(
    { state: stateMessage(), pending: true, status: "正在应用修改…" },
    {
      type: "structuredInvalid",
      documentVersion: 8,
      isDirty: false,
      diagnostics: [diagnostic("error", "structured.invalidRoot")],
    },
  );

  assert.equal(next.state, undefined);
  assert.equal(next.pending, false);
  assert.equal(next.status, "结构化配置无效");
  assert.deepEqual(next.invalid?.diagnostics.map((entry) => entry.code), ["structured.invalidRoot"]);
});

test("completion with no change is reported while completion with a change keeps the status", () => {
  const current: StructuredEditorState = {
    state: stateMessage(),
    pending: true,
    status: "正在应用修改…",
  };

  const unchanged = reduceStructuredHostMessage(current, { type: "operationCompleted", changed: false });
  assert.equal(unchanged.pending, false);
  assert.equal(unchanged.status, "没有产生文档修改");
  assert.equal(unchanged.state, current.state);

  const changed = reduceStructuredHostMessage(current, { type: "operationCompleted", changed: true });
  assert.equal(changed.pending, false);
  assert.equal(changed.status, "正在应用修改…");

  const rejected = reduceStructuredHostMessage(changed, {
    type: "operationRejected",
    message: "Field value is invalid",
  });
  assert.equal(rejected.pending, false);
  assert.equal(rejected.status, "Field value is invalid");
  assert.equal(rejected.state, current.state);
});

test("initial state and token wrapping follow the Host message contract", () => {
  assert.deepEqual(initialStructuredEditorState, {
    pending: false,
    status: "正在加载结构化配置…",
  });
  assert.deepEqual(
    withWebviewToken({ type: "applyOperations", operations: [] }, "token-2"),
    { type: "applyOperations", operations: [], webviewToken: "token-2" },
  );
  assert.deepEqual(withWebviewToken([null], "token-2"), [null]);
  assert.equal(withWebviewToken("text", "token-2"), "text");
});
