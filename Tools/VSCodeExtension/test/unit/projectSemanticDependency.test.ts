import assert from "node:assert/strict";
import test from "node:test";
import type { VisualBridgeProjectDefinition } from "@visualbridge/core";
import { projectSemanticSnapshotDependencyKey } from "../../src/document/projectSemanticDependency";

const emptyProject: VisualBridgeProjectDefinition = {
  formatVersion: 1,
  projectId: "sample.empty",
  documentRoots: [],
  documentTypes: [],
  providers: [],
};

test("empty Project snapshot dependencies include the current Project definition", () => {
  const baseline = projectSemanticSnapshotDependencyKey(emptyProject, []);
  const withProvider = projectSemanticSnapshotDependencyKey({
    ...emptyProject,
    providers: [{
      id: "sample.provider",
      entry: "Providers/sample.mjs",
      args: [],
      capabilities: { reference: { kinds: ["sample.asset"] } },
    }],
  }, []);
  const withDocumentType = projectSemanticSnapshotDependencyKey({
    ...emptyProject,
    documentRoots: ["Config"],
    documentTypes: [{
      id: "sample.config",
      editor: "structured",
      include: ["Config/**/*.sample"],
      exclude: [],
      catalogs: ["Catalog/sample.json"],
    }],
  }, []);

  assert.notEqual(withProvider, baseline);
  assert.notEqual(withDocumentType, baseline);
});

test("Project snapshot document dependencies are order independent and content sensitive", () => {
  const left = { documentTypeId: "sample.a", path: "Config/A.sample", dependencyKey: "a" };
  const right = { documentTypeId: "sample.b", path: "Config/B.sample", dependencyKey: "b" };
  assert.equal(
    projectSemanticSnapshotDependencyKey(emptyProject, [left, right]),
    projectSemanticSnapshotDependencyKey(emptyProject, [right, left]),
  );
  assert.notEqual(
    projectSemanticSnapshotDependencyKey(emptyProject, [left, right]),
    projectSemanticSnapshotDependencyKey(emptyProject, [left, { ...right, dependencyKey: "changed" }]),
  );
});

test("Project snapshot hashes are invariant across Unicode path permutations", () => {
  const documents = ["e\u0301", "é", "😀", "\uE000"].map((path) => ({
    documentTypeId: "sample.unicode",
    path: `Config/${path}.sample`,
    dependencyKey: path,
  }));
  const baseline = projectSemanticSnapshotDependencyKey(emptyProject, documents);

  assert.equal(projectSemanticSnapshotDependencyKey(emptyProject, [...documents].reverse()), baseline);
  assert.equal(
    projectSemanticSnapshotDependencyKey(emptyProject, [documents[2]!, documents[0]!, documents[3]!, documents[1]!]),
    baseline,
  );
});

test("Project snapshot hashes recursively canonicalize Unicode object keys", () => {
  const metadataEntries = [
    ["\uE000", "private-use"],
    ["\uDE00", "low-surrogate"],
    ["😀", "surrogate-pair"],
    ["\uD83D", "high-surrogate"],
    ["é", "composed"],
    ["e\u0301", "decomposed"],
  ] as const;
  const left = {
    ...emptyProject,
    metadata: Object.fromEntries(metadataEntries),
  } as VisualBridgeProjectDefinition;
  const right = Object.fromEntries([
    ["metadata", Object.fromEntries([...metadataEntries].reverse())],
    ...Object.entries(emptyProject).reverse(),
  ]) as unknown as VisualBridgeProjectDefinition;

  assert.equal(
    projectSemanticSnapshotDependencyKey(left, []),
    projectSemanticSnapshotDependencyKey(right, []),
  );
});
