import test from "node:test";
import assert from "node:assert/strict";
import { facetRequestError } from "../dist/mcpErrorCodes.js";

/**
 * 这些码同时是 `Protocol/contract-manifest.json` 的 `errors.mcpPublic` 成员；
 * 若从 `mcpErrorCodes.ts` 的字面量构造里消失，`npm run check:protocol` 会先红。
 */
const REGISTERED_CODES = [
  "request.invalidSelector",
  "document.searchKindUnsupported",
  "document.editorUnsupported",
  "catalog.kindUnsupported",
  "table.sheetNotFound",
  "table.sheetDefinitionNotFound",
];

test("facetRequestError preserves every registered public facet code", () => {
  for (const code of REGISTERED_CODES) {
    const error = facetRequestError(code, `message for ${code}`);
    assert.equal(error.code, code);
    assert.equal(error.message, `message for ${code}`);
  }
});

test("facetRequestError reports an unregistered facet code instead of falling back to internal", () => {
  assert.throws(
    () => facetRequestError("table.unknownThing", "the facet invented a code"),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(Object.hasOwn(error, "code"), false, "A module-contract violation must not be published as a public error code.");
      assert.notEqual(error.code, "internal", "Unknown facet codes must not be silently downgraded to internal.");
      assert.match(error.message, /table\.unknownThing/);
      return true;
    },
  );
});
