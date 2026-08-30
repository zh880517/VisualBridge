import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildCanonicalDocumentLifecycleDependencies,
  buildOwnedStableIdentityCollisionIndex,
  canonicalBaseHashManifest,
  canonicalDependencyManifest,
  canonicalDocumentLifecyclePlanPayload,
  DocumentLifecycleService,
  createDocumentLifecyclePreview,
  normalizeDocumentLifecyclePlan,
  prepareDocumentLifecycleApply,
  remapOwnedStableIdentityCollisionTargets,
  sameBaseHashManifest,
  sameDependencyManifest,
  sameDocumentLifecyclePlan,
  validateCompleteStableIdentityRemap,
  validateOwnedStableIdentityTargetCollisions,
  type DocumentLifecycleApplyRequest,
  type DocumentLifecycleDependency,
  type DocumentLifecycleOperation,
  type DocumentLifecyclePlan,
  type DocumentLifecycleSelector,
  type IndexedDocument,
  type OwnedStableIdentity,
} from "../index";

const source: DocumentLifecycleSelector = {
  projectId: "sample.project",
  documentTypeId: "logicGraph",
  editor: "graph",
  path: "Graph/Source.vbgraph",
};

const target: DocumentLifecycleSelector = {
  ...source,
  path: "Graph/Copy.vbgraph",
};

const ownedIdentities: readonly OwnedStableIdentity[] = [{
  identityKey: "graph/root/node/step",
  kind: "graph.node",
  collisionScope: "sample.project/logicGraph",
  value: "step",
}, {
  identityKey: "document",
  kind: "document",
  collisionScope: "sample.project/logicGraph",
  value: "source.graph",
}];

const dependencies: readonly DocumentLifecycleDependency[] = [{
  kind: "referenceIndex",
  key: "sample.project",
  hash: "reference-hash",
  paths: ["Entity/Hero.herojson", "Graph/Source.vbgraph"],
}, {
  kind: "project",
  key: "VisualBridge.project.vbjson",
  hash: "project-hash",
  paths: ["VisualBridge.project.vbjson"],
}];

test("lifecycle request types keep create, copy, move, delete and preview/apply discriminated", () => {
  const operations: readonly DocumentLifecycleOperation[] = [{
    kind: "create",
    target,
    parameters: { documentId: "new.graph", graphTypeId: "flow" },
  }, {
    kind: "copy",
    source,
    target,
    stableIdRemap: [
      { identityKey: "document", from: "source.graph", to: "copy.graph" },
      { identityKey: "graph/root/node/step", from: "step", to: "copy.step" },
    ],
  }, {
    kind: "move",
    source,
    target,
  }, {
    kind: "delete",
    source,
    target: { kind: "document" },
  }];

  assert.deepEqual(operations.map((operation) => operation.kind), ["create", "copy", "move", "delete"]);
  const previewRequest = { action: "preview", operation: operations[0]! } as const;
  const applyRequest: DocumentLifecycleApplyRequest = {
    action: "apply",
    operation: operations[1]!,
    previewHash: "preview-hash",
    planPayload: "{}",
    baseHashes: {},
    dependencies: [],
  };
  assert.equal(previewRequest.action, "preview");
  assert.equal(applyRequest.action, "apply");
});

test("copy remap requires every owned identity exactly once and preserves value types", () => {
  const valid = validateCompleteStableIdentityRemap(ownedIdentities, [
    { identityKey: "document", from: "source.graph", to: "copy.graph" },
    { identityKey: "graph/root/node/step", from: "step", to: "copy.step" },
  ]);
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.deepEqual(valid.remap.map((entry) => entry.identityKey), ["document", "graph/root/node/step"]);
  }

  const invalid = validateCompleteStableIdentityRemap(ownedIdentities, [
    { identityKey: "document", from: "wrong", to: "wrong" },
    { identityKey: "document", from: "source.graph", to: 2 },
    { identityKey: "unknown", from: "old", to: "new" },
  ]);
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.deepEqual(invalid.blockers.map((blocker) => blocker.code), [
      "identity.duplicateRemapKey",
      "identity.remapMissing",
      "identity.remapUnexpected",
      "identity.sameValue",
      "identity.sourceMismatch",
    ]);
  }

  const collision = validateCompleteStableIdentityRemap(ownedIdentities, [
    { identityKey: "document", from: "source.graph", to: "same" },
    { identityKey: "graph/root/node/step", from: "step", to: "same" },
  ]);
  assert.equal(collision.success, true, "Different identity kinds have independent collision scopes.");
  const sameKindCollision = validateCompleteStableIdentityRemap([
    { ...ownedIdentities[1]!, identityKey: "document/a", value: "a" },
    { ...ownedIdentities[1]!, identityKey: "document/b", value: "b" },
  ], [
    { identityKey: "document/a", from: "a", to: "same" },
    { identityKey: "document/b", from: "b", to: "same" },
  ]);
  assert.equal(sameKindCollision.success, false);
  if (!sameKindCollision.success) {
    assert.deepEqual(sameKindCollision.blockers.map((blocker) => blocker.code), ["identity.targetCollision"]);
  }
});

test("Project collision index covers non-Reference Graph edge and Table dedup identities", () => {
  const edge: OwnedStableIdentity = {
    identityKey: "edge:root:existing",
    kind: "edge",
    collisionScope: "logicGraph:edge",
    value: "existing-edge",
  };
  const dedup: OwnedStableIdentity = {
    identityKey: 'table.dedup:["skills","string","Existing"]',
    kind: "table.dedup",
    collisionScope: "skills:table:sheet:dedup",
    value: "Existing",
  };
  const index = buildOwnedStableIdentityCollisionIndex([{
    document: source,
    ownedIdentities: [edge],
  }, {
    document: { ...source, documentTypeId: "skills", editor: "table", path: "Tables/Skills.csv" },
    ownedIdentities: [dedup],
  }]);
  const targets = remapOwnedStableIdentityCollisionTargets([{
    ...edge,
    identityKey: "edge:root:new",
    value: "source-edge",
  }, {
    ...dedup,
    identityKey: 'table.dedup:["skills","string","New"]',
    value: "New",
  }], [{
    identityKey: "edge:root:new",
    from: "source-edge",
    to: "existing-edge",
  }, {
    identityKey: 'table.dedup:["skills","string","New"]',
    from: "New",
    to: "Existing",
  }]);
  const blockers = validateOwnedStableIdentityTargetCollisions(index, targets);

  assert.deepEqual(blockers.map((blocker) => blocker.identityKey), [
    "edge:root:new",
    'table.dedup:["skills","string","New"]',
  ]);
  assert.ok(blockers.every((blocker) => blocker.code === "identity.targetCollision"));
  assert.deepEqual(validateOwnedStableIdentityTargetCollisions(index, [{
    identityKey: "same-value-different-scope",
    kind: "edge",
    collisionScope: "another:edge",
    value: "existing-edge",
  }]), []);
});

test("lifecycle plans, base hashes and dependencies have stable canonical manifests", () => {
  const first = copyPlan();
  const second: DocumentLifecyclePlan = {
    ...first,
    operation: {
      kind: "copy",
      target: { path: target.path, editor: target.editor, documentTypeId: target.documentTypeId, projectId: target.projectId },
      source: { path: source.path, editor: source.editor, documentTypeId: source.documentTypeId, projectId: source.projectId },
      stableIdRemap: [...first.stableIdRemap].reverse(),
    },
    ownedIdentities: [...first.ownedIdentities].reverse(),
    stableIdRemap: [...first.stableIdRemap].reverse(),
    referenceImpacts: [...first.referenceImpacts].reverse(),
    dependencies: [...first.dependencies].reverse().map((dependency) => ({
      ...dependency,
      paths: [...dependency.paths].reverse(),
    })),
    baseHashes: {
      "Graph/Other.vbgraph": "other-hash",
      "Graph/Source.vbgraph": "source-hash",
    },
    mutations: [...first.mutations].reverse(),
  };

  assert.equal(sameDocumentLifecyclePlan(first, second), true);
  assert.equal(canonicalDocumentLifecyclePlanPayload(first), canonicalDocumentLifecyclePlanPayload(second));
  assert.equal(sameBaseHashManifest(first.baseHashes, second.baseHashes), true);
  assert.equal(canonicalBaseHashManifest(first.baseHashes), canonicalBaseHashManifest(second.baseHashes));
  assert.equal(sameDependencyManifest(first.dependencies, second.dependencies), true);
  assert.equal(canonicalDependencyManifest(first.dependencies), canonicalDependencyManifest(second.dependencies));

  const normalized = normalizeDocumentLifecyclePlan(second);
  assert.deepEqual(normalized.ownedIdentities.map((identity) => identity.identityKey), [
    "document",
    "graph/root/node/step",
  ]);
  assert.deepEqual(Object.keys(normalized.baseHashes), ["Graph/Other.vbgraph", "Graph/Source.vbgraph"]);

  const mismatchedRemap = normalizeDocumentLifecyclePlan({
    ...first,
    stableIdRemap: [{ identityKey: "document", from: "source.graph", to: "other.graph" }],
  });
  assert.ok(mismatchedRemap.blockers.some((blocker) => blocker.code === "identity.remapManifestMismatch"));
});

test("shared dependency builder canonicalizes the same physical and Reference snapshot across Hosts", async () => {
  const indexed: IndexedDocument = {
    projectId: "sample.project",
    documentTypeId: "logicGraph",
    editor: "graph",
    path: "Graph\\Source.vbgraph",
    sourcePaths: ["Graph/Source.vbgraph"],
    title: "Display title is not a dependency",
    documentId: "source.graph",
    diagnostics: [{ severity: "warning", code: "display.only", path: "title", message: "Ignored." }],
    references: [{
      occurrence: {
        definition: { kind: "entity.document", target: { documentTypeId: "hero" }, allowMissing: false },
        value: "hero.player",
        path: "nodes.step.properties.target",
      },
      resolution: {
        status: "resolved",
        candidates: [{
          kind: "entity.document",
          target: { documentTypeId: "hero" },
          value: "hero.player",
          title: "Player",
          location: {
            projectId: "sample.project",
            documentTypeId: "hero",
            path: "Entity\\Player.herojson",
            documentId: "hero.player",
          },
        }],
      },
    }],
  };
  const hashPayload = (payload: string) => createHash("sha256").update(payload).digest("hex");
  const first = await buildCanonicalDocumentLifecycleDependencies({
    projectId: "sample.project",
    project: { path: "VisualBridge.project.vbjson", hash: "project" },
    catalogs: [
      { path: "Catalog\\Entity.json", hash: "entity" },
      { path: "Catalog/Graph.json", hash: "graph" },
    ],
    documents: [
      { path: "Graph\\Source.vbgraph", hash: "source" },
      { path: "Entity/Player.herojson", hash: "player" },
    ],
    index: [indexed],
  }, hashPayload);
  const second = await buildCanonicalDocumentLifecycleDependencies({
    projectId: "sample.project",
    project: { path: "VisualBridge.project.vbjson", hash: "project" },
    catalogs: [
      { path: "Catalog/Graph.json", hash: "graph" },
      { path: "Catalog/Entity.json", hash: "entity" },
    ],
    documents: [
      { path: "Entity\\Player.herojson", hash: "player" },
      { path: "Graph/Source.vbgraph", hash: "source" },
    ],
    index: [{
      ...indexed,
      path: "Graph/Source.vbgraph",
      title: "A different display title",
      diagnostics: [],
      references: indexed.references.map((reference) => ({
        ...reference,
        resolution: {
          ...reference.resolution,
          candidates: reference.resolution.candidates.map((candidate) => ({
            ...candidate,
            title: "Different display title",
            ...(candidate.location === undefined
              ? {}
              : { location: { ...candidate.location, path: "Entity/Player.herojson" } }),
          })),
        },
      })),
    }],
  }, hashPayload);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((dependency) => dependency.kind), [
    "catalog",
    "documentSet",
    "project",
    "referenceIndex",
  ]);
  assert.deepEqual(first.find((dependency) => dependency.kind === "catalog")?.paths, [
    "Catalog/Entity.json",
    "Catalog/Graph.json",
  ]);
  assert.deepEqual(first.find((dependency) => dependency.kind === "documentSet")?.paths, [
    "Entity/Player.herojson",
    "Graph/Source.vbgraph",
  ]);
});

test("lifecycle canonical ordering is a UTF-16 total order independent of reverse Unicode input", () => {
  const ordered = ["Z", "a", "e\u0301", "é", "\uD83D", "😀", "\uDE00", "\uE000"];
  const reversed = [...ordered].reverse();
  const makePlan = (values: readonly string[]): DocumentLifecyclePlan => ({
    version: 1,
    operation: {
      kind: "create",
      target,
      parameters: { documentId: "unicode" },
    },
    ownedIdentities: values.map((value) => ({
      identityKey: value,
      kind: "unicode",
      collisionScope: "unicode",
      value,
    })),
    stableIdRemap: [],
    referenceImpacts: values.map((value) => ({
      kind: "outboundPreserved" as const,
      occurrence: {
        document: source,
        path: value,
        definition: { kind: "unicode", target: {}, allowMissing: true },
        value,
      },
    })),
    blockers: values.map((value) => ({ code: "source.invalid" as const, path: value, message: value })),
    dependencies: values.map((value) => ({ kind: "catalog" as const, key: value, hash: value, paths: [...values] })),
    baseHashes: Object.fromEntries(values.map((value) => [value, value])),
    mutations: values.map((value) => ({
      kind: "create" as const,
      path: value,
      nextHash: value,
      targetMustBeAbsent: true as const,
    })),
  });
  const forward = normalizeDocumentLifecyclePlan(makePlan(ordered));
  const reverse = normalizeDocumentLifecyclePlan(makePlan(reversed));

  assert.deepEqual(forward.ownedIdentities.map((identity) => identity.identityKey), ordered);
  assert.deepEqual(forward.referenceImpacts.map((impact) => (
    impact.kind === "targetLocationChanged" ? impact.from.path : impact.occurrence.path
  )), ordered);
  assert.deepEqual(forward.blockers.map((blocker) => blocker.path), ordered);
  assert.deepEqual(forward.dependencies.map((dependency) => dependency.key), ordered);
  assert.deepEqual(forward.dependencies[0]?.paths, ordered);
  assert.deepEqual(Object.keys(forward.baseHashes), ordered);
  assert.deepEqual(forward.mutations.map((mutation) => mutation.kind === "move" ? mutation.sourcePath : mutation.path), ordered);
  assert.equal(canonicalDocumentLifecyclePlanPayload(forward), canonicalDocumentLifecyclePlanPayload(reverse));
});

test("allowMissing outbound impacts remain canonical without a resolved target location", () => {
  const occurrence = {
    document: source,
    path: "nodes.step.properties.optionalTarget",
    definition: { kind: "sample.optional", target: {}, allowMissing: true },
    value: "missing-target",
  } as const;
  const plan: DocumentLifecyclePlan = {
    ...copyPlan(),
    referenceImpacts: [{ kind: "outboundPreserved", occurrence }],
  };

  const normalized = normalizeDocumentLifecyclePlan(plan);
  assert.deepEqual(normalized.referenceImpacts, [{ kind: "outboundPreserved", occurrence }]);
  assert.equal(canonicalDocumentLifecyclePlanPayload(plan), canonicalDocumentLifecyclePlanPayload(normalized));
});

test("prepare apply reports stable structured conflicts and blockers", () => {
  const preview = createDocumentLifecyclePreview(copyPlan(), "preview-hash");
  const request = applyRequest(preview);
  const ready = prepareDocumentLifecycleApply(request, preview);
  assert.equal(ready.success, true);
  assert.equal(ready.status, "ready");

  const operationConflict = prepareDocumentLifecycleApply({
    ...request,
    operation: {
      kind: "copy",
      source,
      target: { ...target, path: "Graph/OtherCopy.vbgraph" },
      stableIdRemap: preview.plan.stableIdRemap,
    },
  }, preview);
  assertConflict(operationConflict, "operationChanged");

  const baseConflict = prepareDocumentLifecycleApply({
    ...request,
    baseHashes: { ...request.baseHashes, "Graph/Source.vbgraph": "stale" },
  }, preview);
  assertConflict(baseConflict, "baseHashMismatch");

  const dependencyConflict = prepareDocumentLifecycleApply({
    ...request,
    dependencies: request.dependencies.map((dependency, index) => index === 0
      ? { ...dependency, hash: "stale" }
      : dependency),
  }, preview);
  assertConflict(dependencyConflict, "dependencyChanged");

  const changedPlan = copyPlan();
  const changedPreview = createDocumentLifecyclePreview({
    ...changedPlan,
    referenceImpacts: [{
      kind: "targetLocationChanged",
      identityKey: "document",
      from: {
        projectId: source.projectId,
        documentTypeId: source.documentTypeId,
        path: source.path,
        documentId: "source.graph",
      },
      to: {
        projectId: target.projectId,
        documentTypeId: target.documentTypeId,
        path: target.path,
        documentId: "copy.graph",
      },
    }],
  }, "changed-preview-hash");
  const planConflict = prepareDocumentLifecycleApply({
    ...request,
    operation: changedPreview.plan.operation,
    baseHashes: changedPreview.plan.baseHashes,
    dependencies: changedPreview.plan.dependencies,
  }, changedPreview);
  assertConflict(planConflict, "planChanged");

  const previewHashConflict = prepareDocumentLifecycleApply({ ...request, previewHash: "wrong" }, preview);
  assertConflict(previewHashConflict, "previewHashMismatch");

  const blockedPreview = createDocumentLifecyclePreview({
    ...copyPlan(),
    blockers: [{ code: "reference.inbound", message: "Referenced by another document." }],
  }, "blocked-hash");
  const blocked = prepareDocumentLifecycleApply(applyRequest(blockedPreview), blockedPreview);
  assert.equal(blocked.success, false);
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") {
    assert.equal(blocked.blockers[0]?.code, "reference.inbound");
  }
});

test("shared lifecycle service owns canonical preview hashing", async () => {
  const service = new DocumentLifecycleService(
    async () => copyPlan(),
    async (payload) => `hash:${payload.length}`,
  );
  const preview = await service.preview(copyPlan().operation);
  assert.equal(preview.previewHash, `hash:${preview.planPayload.length}`);
  assert.equal(service.prepareApply(applyRequest(preview), preview).success, true);
});

test("unsupported versions and conflicting physical mutations block apply", () => {
  const normalized = normalizeDocumentLifecyclePlan({
    ...copyPlan(),
    version: 2 as 1,
    mutations: [{
      kind: "create",
      path: "Graph/Same.vbgraph",
      nextHash: "first",
      targetMustBeAbsent: true,
    }, {
      kind: "delete",
      path: "Graph/Same.vbgraph",
      baseHash: "second",
    }],
  });
  assert.deepEqual(normalized.blockers.map((blocker) => blocker.code), [
    "mutation.conflict",
    "plan.unsupportedVersion",
  ]);
  const duplicate = normalizeDocumentLifecyclePlan({
    ...copyPlan(),
    mutations: [copyPlan().mutations[0]!, copyPlan().mutations[0]!],
  });
  assert.ok(duplicate.blockers.some((blocker) => blocker.code === "mutation.duplicateTarget"));

  const sameTargetDifferentHashes = [{
    kind: "replace" as const,
    path: "Graph/Same.vbgraph",
    baseHash: "base",
    nextHash: "z",
  }, {
    kind: "replace" as const,
    path: "Graph/Same.vbgraph",
    baseHash: "base",
    nextHash: "a",
  }];
  const forward = { ...copyPlan(), mutations: sameTargetDifferentHashes };
  const reverse = { ...copyPlan(), mutations: [...sameTargetDifferentHashes].reverse() };
  assert.equal(canonicalDocumentLifecyclePlanPayload(forward), canonicalDocumentLifecyclePlanPayload(reverse));
});

function copyPlan(): DocumentLifecyclePlan {
  const operation: DocumentLifecycleOperation = {
    kind: "copy",
    source,
    target,
    stableIdRemap: [
      { identityKey: "graph/root/node/step", from: "step", to: "copy.step" },
      { identityKey: "document", from: "source.graph", to: "copy.graph" },
    ],
  };
  return {
    version: 1,
    operation,
    ownedIdentities,
    stableIdRemap: operation.stableIdRemap,
    referenceImpacts: [],
    blockers: [],
    dependencies,
    baseHashes: {
      "Graph/Source.vbgraph": "source-hash",
      "Graph/Other.vbgraph": "other-hash",
    },
    mutations: [{
      kind: "create",
      path: "Graph/Copy.vbgraph",
      nextHash: "copy-hash",
      targetMustBeAbsent: true,
    }, {
      kind: "replace",
      path: "Graph/Other.vbgraph",
      baseHash: "other-hash",
      nextHash: "next-other-hash",
    }],
  };
}

function applyRequest(preview: ReturnType<typeof createDocumentLifecyclePreview>): DocumentLifecycleApplyRequest {
  return {
    action: "apply",
    operation: preview.plan.operation,
    previewHash: preview.previewHash,
    planPayload: preview.planPayload,
    baseHashes: preview.plan.baseHashes,
    dependencies: preview.plan.dependencies,
  };
}

function assertConflict(
  result: ReturnType<typeof prepareDocumentLifecycleApply>,
  reason: string,
): void {
  assert.equal(result.success, false);
  assert.equal(result.status, "conflict");
  if (result.status === "conflict") {
    assert.equal(result.reason, reason);
  }
}
