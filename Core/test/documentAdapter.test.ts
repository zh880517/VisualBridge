import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalogBundle,
  type CatalogAdapter,
} from "../Document/documentAdapter";

interface Catalog {
  readonly id: string;
}

const adapter: CatalogAdapter<Catalog, readonly Catalog[]> = {
  editor: "sample",
  parse(text) {
    return text.startsWith("invalid")
      ? { success: false, diagnostics: [{ severity: "error", code: "sample.invalid", path: "id", message: text }] }
      : { success: true, document: { id: text }, diagnostics: [] };
  },
  build(catalogs) {
    return catalogs.some((catalog) => catalog.id === "duplicate")
      ? {
          success: false,
          diagnostics: [{ severity: "error", code: "sample.duplicate", path: "catalogs[0].id", message: "duplicate" }],
        }
      : { success: true, document: catalogs, diagnostics: [] };
  },
};

test("Catalog bundle maps parser and registry diagnostics to physical source indexes", () => {
  const bundle = buildCatalogBundle([
    { path: "a.json", text: "invalid first" },
    { path: "b.json", text: "duplicate" },
  ], adapter);

  assert.equal(bundle.registry, undefined);
  assert.deepEqual(bundle.paths, ["a.json", "b.json"]);
  assert.deepEqual(bundle.diagnostics.map((diagnostic) => diagnostic.path), [
    "catalogs[0].id",
    "catalogs[1].id",
  ]);
});

test("Catalog bundle returns a registry only when every error is absent", () => {
  const bundle = buildCatalogBundle([
    { path: "a.json", text: "first" },
    { path: "b.json", text: "second" },
  ], adapter);

  assert.deepEqual(bundle.registry, [{ id: "first" }, { id: "second" }]);
  assert.deepEqual(bundle.diagnostics, []);
});
