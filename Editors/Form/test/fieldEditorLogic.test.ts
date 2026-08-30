import assert from "node:assert/strict";
import test from "node:test";
import type { FieldValueDefinition } from "@visualbridge/core";
import {
  acceptReferenceSelection,
  jsonValuesEqual,
  parseJsonDraft,
  parseNumberDraft,
  resolveFieldEditorControl,
  resolveFieldEditorValue,
} from "../src/fieldEditorLogic";
import { WebviewReferenceBridge } from "../src/referenceBridge";

test("explicit null is preserved instead of falling back to the Catalog default", () => {
  assert.equal(resolveFieldEditorValue(null, { fallback: true }), null);
  assert.deepEqual(resolveFieldEditorValue(undefined, { fallback: true }), { fallback: true });
});

test("select and json hints override recursive object and array presentations", () => {
  const objectSelect: FieldValueDefinition = {
    valueType: "object",
    defaultValue: { id: 1 },
    fields: [],
    editor: {
      kind: "select",
      readOnly: false,
      integer: false,
      options: [{ title: "One", value: { id: 1 } }],
    },
  };
  const arrayJson: FieldValueDefinition = {
    valueType: "array",
    defaultValue: [],
    fields: [],
    item: { valueType: "number", defaultValue: 0, fields: [] },
    editor: { kind: "json", readOnly: false, integer: false, options: [] },
  };
  assert.equal(resolveFieldEditorControl(objectSelect, { id: 1 }), "select");
  assert.equal(resolveFieldEditorControl(arrayJson, []), "json");
});

test("structured select values compare independently of object key insertion order", () => {
  assert.equal(jsonValuesEqual({ id: 1, metadata: { z: 2, a: 3 } }, {
    metadata: { a: 3, z: 2 },
    id: 1,
  }), true);
  assert.equal(jsonValuesEqual([1, 2], [2, 1]), false);
});

test("number drafts reject empty and non-finite values", () => {
  assert.equal(parseNumberDraft("", 5), undefined);
  assert.equal(parseNumberDraft("   ", 5), undefined);
  assert.equal(parseNumberDraft("1e400", 5), undefined);
  assert.equal(parseNumberDraft("5", 5), undefined);
  assert.equal(parseNumberDraft("6.5", 5), 6.5);
});

test("reference selection preserves the stored primitive type", () => {
  assert.equal(acceptReferenceSelection(1, "1"), undefined);
  assert.equal(acceptReferenceSelection("1", 1), undefined);
  assert.equal(acceptReferenceSelection(1, 1), undefined);
  assert.equal(acceptReferenceSelection(1, 2), 2);
});

test("reference bridge rejects a Host response with a different primitive type", async () => {
  const messages: unknown[] = [];
  const bridge = new WebviewReferenceBridge({ postMessage: (message) => messages.push(message) });
  const pending = bridge.pick({ kind: "table.row", target: {}, allowMissing: false }, 1);
  const request = messages[0] as { readonly requestId: string };
  assert.equal(bridge.handleMessage({
    type: "referenceSelected",
    requestId: request.requestId,
    value: "1",
  }), true);
  assert.equal(await pending, undefined);
});

test("JSON drafts reject non-finite values and preserve null", () => {
  assert.deepEqual(parseJsonDraft("null"), { success: true, value: null });
  assert.deepEqual(parseJsonDraft('{"value": 1}'), { success: true, value: { value: 1 } });
  assert.deepEqual(parseJsonDraft("1e400"), { success: false });
  assert.deepEqual(parseJsonDraft("{"), { success: false });
});
