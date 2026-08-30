import assert from "node:assert/strict";
import test from "node:test";
import {
  createUnknownCatalogSource,
  parseCatalogSourceDefinition,
  serializeCatalogSourceDefinition,
} from "../index";

test("Catalog source states distinguish unknown, current and stale snapshots", () => {
  assert.deepEqual(createUnknownCatalogSource(), { status: "unknown" });
  assert.deepEqual(parseCatalogSourceDefinition({ status: "unknown" }), {
    success: true,
    value: { status: "unknown" },
  });
  const current = parseCatalogSourceDefinition({
    status: "current",
    providerId: "unity",
    sourceHash: "1".repeat(64),
  });
  assert.equal(current.success, true);
  if (current.success) {
    assert.deepEqual(serializeCatalogSourceDefinition(current.value), {
      status: "current",
      providerId: "unity",
      sourceHash: "1".repeat(64),
    });
  }
  const stale = parseCatalogSourceDefinition({
    status: "stale",
    providerId: "unity",
    sourceHash: "1".repeat(64),
    currentSourceHash: "2".repeat(64),
  });
  assert.equal(stale.success, true);
});

test("Catalog source states reject ambiguous or malformed Hash metadata", () => {
  const sameHash = parseCatalogSourceDefinition({
    status: "stale",
    providerId: "unity",
    sourceHash: "1".repeat(64),
    currentSourceHash: "1".repeat(64),
  });
  assert.equal(sameHash.success, false);
  if (!sameHash.success) {
    assert.deepEqual(sameHash.issues.map((issue) => issue.path), ["source.currentSourceHash"]);
  }
  const unknownWithHash = parseCatalogSourceDefinition({ status: "unknown", sourceHash: "1".repeat(64) });
  assert.equal(unknownWithHash.success, false);
});
