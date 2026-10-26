import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { VisualBridgeProjectDefinition } from "@visualbridge/core";
import type * as ProjectFixture from "../../../TestData/projectFixture.js";
import {
  clearModuleDraft,
  clearProviderDraft,
  createDocumentType,
  createModule,
  createProvider,
  initialProjectEditorState,
  moduleDraftIsPersisted,
  moduleDraftResetKey,
  moduleHashShort,
  moduleOptionsText,
  moduleStatusLabel,
  move,
  parseModuleOptions,
  providerDraftIsPersisted,
  reduceProjectHostMessage,
  withReferenceKinds,
  withValidatorTypes,
  withWebviewToken,
  type ProjectEditorState,
  type ProjectModuleRuntime,
  type ProjectStateMessage,
} from "../src/projectEditorLogic";

// .test-dist 比源码深一层，运行时按编译输出定位仓库根的共享 fixture；类型走源码路径。
const { createTestProject } = require(path.resolve(
  __dirname,
  "../../../..",
  "TestData",
  "projectFixture.js",
)) as typeof ProjectFixture;

function emptyProject(overrides: Partial<VisualBridgeProjectDefinition> = {}): VisualBridgeProjectDefinition {
  return {
    ...createTestProject<VisualBridgeProjectDefinition>({
      projectId: "sample",
      documentRoots: ["Config"],
      providers: [],
    }),
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

test("default Module skips IDs already present and uses the bundle entry suffix", () => {
  const project = emptyProject({
    modules: [{ id: "project.module.2", entry: "Modules/custom.vbmodule.js" }],
  });

  assert.deepEqual(createModule(project), {
    id: "project.module.3",
    entry: "Modules/module-3.vbmodule.js",
  });
});

test("Module options text round-trips as a JSON object only", () => {
  assert.equal(moduleOptionsText({ id: "visualbridge.table", entry: "Modules/table.vbmodule.js" }), "{}");
  assert.equal(
    moduleOptionsText({
      id: "visualbridge.table",
      entry: "Modules/table.vbmodule.js",
      options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
    }),
    '{\n  "tableLayout": {\n    "nameKeyRow": 2,\n    "dataStartRow": 3\n  }\n}',
  );
  assert.deepEqual(parseModuleOptions('{"nested":{"value":[1,true,null]}}'), {
    nested: { value: [1, true, null] },
  });
  assert.equal(parseModuleOptions("[]"), undefined);
  assert.equal(parseModuleOptions("42"), undefined);
  assert.equal(parseModuleOptions("{"), undefined);
});

test("Module runtime status labels and hash prefix feed the Modules section", () => {  assert.equal(moduleStatusLabel("loaded"), "已加载");
  assert.equal(moduleStatusLabel("failed"), "加载失败");
  assert.equal(moduleStatusLabel("untrusted"), "未授权（需要信任工作区）");
  assert.equal(moduleStatusLabel("disabled"), "已停用");
  assert.equal(moduleStatusLabel("stale"), "待重新装载");
  assert.equal(moduleStatusLabel(undefined), "状态未知");

  assert.equal(moduleHashShort(undefined), "");
  assert.equal(moduleHashShort(""), "");
  assert.equal(moduleHashShort(`sha256:${"0123456789ab".repeat(5)}cdef`), "0123456789ab");
  assert.equal(moduleHashShort("abcdef"), "abcdef");
});

test("Module draft reset key only tracks persisted entry and options", () => {
  const base = { id: "visualbridge.table", entry: "Modules/table.vbmodule.js" };
  const withOptions = { ...base, options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } } };

  assert.equal(moduleDraftResetKey(base), moduleDraftResetKey({ ...base }));
  assert.notEqual(moduleDraftResetKey(base), moduleDraftResetKey(withOptions));
  assert.equal(moduleDraftResetKey(withOptions), moduleDraftResetKey({
    ...withOptions,
    options: { tableLayout: { dataStartRow: 3, nameKeyRow: 2 } },
  }));
  assert.notEqual(
    moduleDraftResetKey(base),
    moduleDraftResetKey({ ...base, entry: "Modules/renamed.vbmodule.js" }),
  );
});

test("projectState carries module runtime snapshots without touching drafts", () => {
  const runtime: ProjectModuleRuntime = {
    id: "visualbridge.table",
    index: 0,
    status: "untrusted",
    hashShort: "",
    editors: ["table"],
    diagnostics: [{ code: "module.untrusted", severity: "warning", message: "需要信任工作区才能加载模块。", path: "modules[0]" }],
  };
  const message: ProjectStateMessage = {
    ...projectState(emptyProject()),
    modules: [runtime],
  };

  const next = reduceProjectHostMessage(initialProjectEditorState, message);
  assert.deepEqual(next.state?.modules, [runtime]);
  assert.equal(next.status, "配置有效");
});

test("Module drafts survive projectState until the module is persisted", () => {
  const draft = createModule(emptyProject());
  const project = emptyProject({ modules: [draft] });

  assert.equal(moduleDraftIsPersisted(project, draft), true);
  assert.equal(moduleDraftIsPersisted(emptyProject(), draft), false);

  const kept = reduceProjectHostMessage(
    { ...initialProjectEditorState, moduleDraft: draft },
    projectState(emptyProject()),
  );
  assert.deepEqual(kept.moduleDraft, draft);
  assert.equal(clearModuleDraft(kept).moduleDraft, undefined);
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
