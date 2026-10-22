import assert from "node:assert/strict";
import test from "node:test";
import type { VisualBridgeProjectDefinition } from "@visualbridge/core";
import {
  clearProviderDraft,
  createDocumentType,
  createProvider,
  initialProjectEditorState,
  move,
  providerDraftIsPersisted,
  reduceProjectHostMessage,
  withReferenceKinds,
  withValidatorTypes,
  withWebviewToken,
  type ProjectEditorState,
  type ProjectStateMessage,
} from "../src/projectEditorLogic";

function emptyProject(overrides: Partial<VisualBridgeProjectDefinition> = {}): VisualBridgeProjectDefinition {
  return {
    formatVersion: 1,
    projectId: "sample",
    documentRoots: ["Config"],
    documentTypes: [],
    providers: [],
    ...overrides,
  };
}

function projectState(project: VisualBridgeProjectDefinition): ProjectStateMessage {
  return {
    type: "projectState",
    documentVersion: 3,
    sourceHash: "hash",
    project,
    isDirty: true,
    issues: [],
  };
}

test("default Document Type skips IDs already present in the project", () => {
  const project = emptyProject({
    documentTypes: [{
      id: "document.type.2",
      editor: "entity",
      include: [],
      exclude: [],
      catalogs: [],
    }],
  });

  assert.deepEqual(createDocumentType(project), {
    id: "document.type.3",
    editor: "structured",
    include: ["Config/**/*.type3"],
    exclude: [],
    catalogs: [],
  });
});

test("default Provider skips IDs already present and declares a reference capability", () => {
  const project = emptyProject({
    providers: [{
      id: "project.provider.1",
      entry: "Providers/existing.mjs",
      args: [],
      capabilities: {},
    }],
  });

  assert.deepEqual(createProvider(project), {
    id: "project.provider.2",
    entry: "Providers/provider-2.mjs",
    args: [],
    capabilities: { reference: { kinds: ["custom.reference.2"] } },
  });
});

test("editing reference kinds and validator types preserve the other capability", () => {
  const provider = {
    id: "project.provider.1",
    entry: "Providers/provider-1.mjs",
    args: [],
    capabilities: {
      reference: { kinds: ["old.kind"] },
      validator: { documentTypes: ["game.settings"] },
    },
  } as const;

  assert.deepEqual(withReferenceKinds(provider, ["game.asset"]), {
    reference: { kinds: ["game.asset"] },
    validator: { documentTypes: ["game.settings"] },
  });
  assert.deepEqual(withReferenceKinds(provider, []), {
    validator: { documentTypes: ["game.settings"] },
  });
  assert.deepEqual(withValidatorTypes(provider, ["game.dialogue"]), {
    reference: { kinds: ["old.kind"] },
    validator: { documentTypes: ["game.dialogue"] },
  });
  assert.deepEqual(withValidatorTypes(provider, []), {
    reference: { kinds: ["old.kind"] },
  });
});

test("string list moves follow drag direction and tolerate out-of-range indexes", () => {
  assert.deepEqual(move(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(move(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(move(["a", "b"], 1, 1), ["a", "b"]);
  assert.deepEqual(move(["a"], 4, 0), ["a"]);
  assert.deepEqual(move([], 0, 0), []);
});

test("projectState resets pending/status and clears a draft once the Provider is persisted", () => {
  const draft = createProvider(emptyProject());
  const current: ProjectEditorState = {
    ...initialProjectEditorState,
    pending: true,
    status: "正在验证并应用…",
    providerDraft: draft,
  };

  const persisted = reduceProjectHostMessage(current, projectState(emptyProject({ providers: [draft] })));

  assert.equal(persisted.state?.documentVersion, 3);
  assert.equal(persisted.invalid, undefined);
  assert.equal(persisted.pending, false);
  assert.equal(persisted.status, "配置有效");
  assert.equal(persisted.providerDraft, undefined);
});

test("projectState keeps an unsaved Provider draft and providerDraftIsPersisted explains why", () => {
  const draft = createProvider(emptyProject());
  const project = emptyProject();

  assert.equal(providerDraftIsPersisted(project, draft), false);
  assert.equal(providerDraftIsPersisted(project, undefined), false);

  const next = reduceProjectHostMessage({ ...initialProjectEditorState, providerDraft: draft }, projectState(project));

  assert.deepEqual(next.providerDraft, draft);
  assert.equal(clearProviderDraft(next).providerDraft, undefined);
});

test("invalid and rejected host messages replace only the fields they own", () => {
  const loaded: ProjectEditorState = {
    state: projectState(emptyProject()),
    pending: true,
    status: "正在验证并应用…",
  };

  const rejected = reduceProjectHostMessage(loaded, { type: "operationRejected", message: "Provider 已存在" });
  assert.deepEqual(rejected.state, loaded.state);
  assert.equal(rejected.pending, false);
  assert.equal(rejected.status, "Provider 已存在");

  const invalid = reduceProjectHostMessage(loaded, {
    type: "projectInvalid",
    documentVersion: 4,
    sourceHash: "broken",
    isDirty: false,
    issues: [{ path: "$.projectId", message: "Missing projectId" }],
  });
  assert.equal(invalid.state, undefined);
  assert.equal(invalid.pending, false);
  assert.equal(invalid.status, "工程文件无效");
  assert.deepEqual(invalid.invalid?.issues, [{ path: "$.projectId", message: "Missing projectId" }]);
});

test("withWebviewToken attaches the token only to plain objects", () => {
  assert.deepEqual(
    withWebviewToken({ type: "ready", instanceId: "i" }, "token-1"),
    { type: "ready", instanceId: "i", webviewToken: "token-1" },
  );
  assert.deepEqual(withWebviewToken({ type: "ready" }, undefined), { type: "ready" });
  assert.deepEqual(withWebviewToken(["ready"], "token-1"), ["ready"]);
  assert.equal(withWebviewToken("ready", "token-1"), "ready");
  assert.equal(withWebviewToken(null, "token-1"), null);
});
