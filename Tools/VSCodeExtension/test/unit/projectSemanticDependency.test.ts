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
