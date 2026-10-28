import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MODULE_API_VERSION,
  MODULE_ERROR_CODES,
  ModuleLoader,
  ModuleLoaderError,
} from "../dist/index.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "..", "..", "..");
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, "TestData", "ModuleLoaderProject");
const SDK_BUILD_PATH = path.join(REPOSITORY_ROOT, "ModuleSdk", "dist", "build", "index.js");
const CORE_BUILD_PATH = path.join(REPOSITORY_ROOT, "Core", "dist", "index.js");
const SDK_SOURCE_PATH = path.join(REPOSITORY_ROOT, "ModuleSdk", "src", "index.ts");

test("keeps MODULE_API_VERSION aligned with the module SDK", async () => {
  const source = await readFile(SDK_SOURCE_PATH, "utf8");
  const match = /export const MODULE_API_VERSION = (\d+);/u.exec(source);
  assert.ok(match, "ModuleSdk must declare MODULE_API_VERSION.");
  assert.equal(Number(match[1]), MODULE_API_VERSION);
});

test("loads the committed fixture bundle and reports every status", async () => {
  const { loader } = await createFixtureLoader();
  const result = loader.result;
  const statuses = new Map(result.modules.map((module) => [module.id, module.status]));
  const codes = new Map(result.modules.map((module) => [
    module.id,
    module.diagnostics.map((diagnostic) => diagnostic.code),
  ]));

  assert.equal(statuses.get("visualbridge.fixture.good"), "loaded");
  assert.equal(statuses.get("visualbridge.fixture.builtin"), "loaded");
  assert.equal(statuses.get("visualbridge.fixture.conflict"), "disabled");
  assert.equal(statuses.get("visualbridge.fixture.reference-conflict"), "disabled");
  assert.equal(statuses.get("visualbridge.fixture.debug-conflict"), "disabled");
  assert.equal(statuses.get("visualbridge.fixture.hash"), "disabled");
  assert.equal(statuses.get("visualbridge.fixture.require"), "failed");
  assert.equal(statuses.get("visualbridge.fixture.activate"), "failed");
  assert.equal(statuses.get("visualbridge.fixture.api"), "disabled");
  assert.equal(statuses.get("visualbridge.fixture.id"), "failed");
  assert.equal(statuses.get("visualbridge.fixture.manifest"), "failed");
  assert.equal(statuses.get("visualbridge.fixture.registration"), "failed");
  assert.equal(statuses.get("visualbridge.fixture.options"), "failed");
  assert.equal(statuses.get("visualbridge.fixture.call"), "failed");

  assert.deepEqual(codes.get("visualbridge.fixture.good"), []);
  assert.deepEqual(codes.get("visualbridge.fixture.builtin"), []);
  assert.deepEqual(codes.get("visualbridge.fixture.conflict"), ["module.editorConflict"]);
  assert.deepEqual(codes.get("visualbridge.fixture.reference-conflict"), ["module.referenceKindConflict"]);
  assert.deepEqual(codes.get("visualbridge.fixture.debug-conflict"), ["module.editorConflict"]);
  const debugConflict = result.modules.find((module) => module.id === "visualbridge.fixture.debug-conflict");
  assert.ok(debugConflict);
  // 冲突诊断必须能定位到具体 categories 下标，而不是只说"有冲突"（F4 验收 ③）。
  const debugConflictDiagnostic = debugConflict.diagnostics[0];
  assert.match(debugConflictDiagnostic.path, /^modules\[\d+\]\.editors\[0\]\.debug\.categories\[0\]$/u);
  assert.equal(debugConflictDiagnostic.message, "Debug category 'fixture.debug' is already provided by module 'visualbridge.fixture.good'.");
  assert.deepEqual(codes.get("visualbridge.fixture.hash"), ["module.hashMismatch"]);
  assert.deepEqual(codes.get("visualbridge.fixture.require"), ["module.loadFailed"]);
  assert.deepEqual(codes.get("visualbridge.fixture.activate"), ["module.activateFailed"]);
  assert.deepEqual(codes.get("visualbridge.fixture.api"), ["module.apiVersionMismatch"]);
  assert.deepEqual(codes.get("visualbridge.fixture.id"), ["module.idMismatch"]);
  assert.deepEqual(codes.get("visualbridge.fixture.manifest"), ["module.manifestInvalid"]);
  assert.deepEqual(new Set(codes.get("visualbridge.fixture.registration")), new Set(["module.registrationInvalid"]));
  assert.deepEqual(codes.get("visualbridge.fixture.options"), ["module.optionsInvalid"]);
  assert.deepEqual(codes.get("visualbridge.fixture.call"), ["module.callFailed"]);

  assert.deepEqual([...result.editors.keys()], ["fixture", "fixture-builtin"]);
  assert.deepEqual([...result.referenceKinds.keys()], ["fixture.asset"]);
  assert.deepEqual([...result.debugCategories.keys()], ["fixture.debug"]);
  const good = result.modules.find((module) => module.id === "visualbridge.fixture.good");
  assert.ok(good);
  assert.match(good.hash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(good.declaredHash, undefined);
  assert.equal(good.manifest?.id, "visualbridge.fixture.good");
  assert.deepEqual(good.registration.editors.map((editor) => editor.editor), ["fixture"]);
  // F4：注册面必须保留 debug facet 的回调，否则宿主只能看到 categories 却无法调用模块。
  const debugFacet = good.registration.editors[0].debug;
  assert.deepEqual([...debugFacet.categories], ["fixture.debug"]);
  assert.equal(typeof debugFacet.onRecord, "function");
  assert.match(good.webviews.fixture.script, /function/u);
  assert.equal(good.webviews.fixture.style, ":root { --vb-fixture: 1; }");
});

test("a stateful debug facet keeps its own `this` after registration normalization (P2-4)", async () => {
  const { loader } = await createFixtureLoader();
  const good = loader.result.modules.find((module) => module.id === "visualbridge.fixture.good");
  assert.ok(good);
  const facet = good.registration.editors[0].debug;
  assert.ok(facet);
  // D.4 把 onRecord 定义成方法：`this` 必须是模块导出的那个 facet，而不是装载器的投影对象。
  // 未 bind 时 state 会静默落在投影副本上，模块自己永远读不到（F4 P2-4）。
  assert.deepEqual(facet.onRecord({ category: "fixture.debug" }, {}), { calls: 1, self: true });
  assert.deepEqual(facet.onRecord({ category: "fixture.debug" }, {}), { calls: 2, self: true });
});

test("rejects invalid, missing and aliased module entries", async (t) => {
  const { loader } = await createFixtureLoader();
  const invalidEntries = [
    "",
    "Modules/good.vbmodule.js/",
    "Modules//good.vbmodule.js",
    "Modules/./good.vbmodule.js",
    "Modules/../Modules/good.vbmodule.js",
    "../Modules/good.vbmodule.js",
    "/Modules/good.vbmodule.js",
    "C:Modules/good.vbmodule.js",
    "C:/Modules/good.vbmodule.js",
    "Modules\\good.vbmodule.js",
    "Modules/good.js",
    "Modules/good.VBMODULE.JS",
    ".vbmodule.js",
    "Modules/good\u0000.vbmodule.js",
    "Modules/good\u0007.vbmodule.js",
  ];
  for (const entry of invalidEntries) {
    const result = await loader.reload([{ id: "visualbridge.fixture.good", entry }]);
    assert.equal(result.modules[0].status, "failed", `entry '${entry}' should fail`);
    assert.deepEqual(
      result.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
      ["module.invalidPath"],
      `entry '${entry}' should report module.invalidPath`,
    );
  }

  const missing = await loader.reload([{
    id: "visualbridge.fixture.good",
    entry: "Modules/missing.vbmodule.js",
  }]);
  assert.deepEqual(missing.modules[0].diagnostics.map((diagnostic) => diagnostic.code), ["module.notFound"]);

  await assert.rejects(
    () => ModuleLoader.create({
      projectRoot: path.join(FIXTURE_ROOT, "missing-project"),
      projectId: "visualbridge.missing",
      modules: [],
      trusted: true,
    }),
    (errorValue) => errorValue instanceof ModuleLoaderError && errorValue.code === "module.notFound",
  );

  const temporaryProject = await copyFixtureProject(t);
  await symlink(
    path.join(temporaryProject, "Modules"),
    path.join(temporaryProject, "LinkedModules"),
    "junction",
  );
  const aliasLoader = await ModuleLoader.create({
    projectRoot: temporaryProject,
    projectId: "visualbridge.alias",
    modules: [{ id: "visualbridge.fixture.good", entry: "LinkedModules/good.vbmodule.js" }],
    trusted: true,
  });
  assert.deepEqual(
    aliasLoader.result.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
    ["module.entryAlias"],
  );

  if (process.platform === "win32") {
    const caseAlias = await aliasLoader.reload([{
      id: "visualbridge.fixture.good",
      entry: "modules/good.vbmodule.js",
    }]);
    assert.deepEqual(
      caseAlias.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
      ["module.entryAlias"],
    );
  }
});

test("honours trust, disabled modules, hash declarations and stale detection", async (t) => {
  const project = await readFixtureProject();
  const goodDefinition = project.modules.find((module) => module.id === "visualbridge.fixture.good");
  assert.ok(goodDefinition);

  const untrusted = await ModuleLoader.create({
    projectRoot: FIXTURE_ROOT,
    projectId: project.projectId,
    modules: [goodDefinition],
    trusted: false,
  });
  assert.equal(untrusted.result.modules[0].status, "untrusted");
  assert.deepEqual(
    untrusted.result.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
    ["module.untrusted"],
  );

  const disabled = await ModuleLoader.create({
    projectRoot: FIXTURE_ROOT,
    projectId: project.projectId,
    modules: [goodDefinition],
    trusted: true,
    disabledModuleIds: ["visualbridge.fixture.good"],
  });
  assert.equal(disabled.result.modules[0].status, "disabled");
  assert.deepEqual(
    disabled.result.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
    ["module.disabled"],
  );

  const { loader } = await createFixtureLoader({ modules: [goodDefinition] });
  const loaded = loader.result.modules[0];
  assert.equal(loaded.status, "loaded");
  const matchingHash = await loader.reload([{ ...goodDefinition, hash: loaded.hash }]);
  assert.equal(matchingHash.modules[0].status, "loaded");
  const mismatchedHash = await loader.reload([{
    ...goodDefinition,
    hash: `sha256:${"0".repeat(64)}`,
  }]);
  assert.deepEqual(
    mismatchedHash.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
    ["module.hashMismatch"],
  );
  assert.equal(mismatchedHash.modules[0].status, "disabled");

  const temporaryProject = await copyFixtureProject(t);
  const staleLoader = await ModuleLoader.create({
    projectRoot: temporaryProject,
    projectId: project.projectId,
    modules: [goodDefinition],
    trusted: true,
  });
  assert.equal((await staleLoader.refreshStale()).modules[0].status, "loaded");
  const entryPath = path.join(temporaryProject, "Modules", "good.vbmodule.js");
  await writeFile(entryPath, `${await readFile(entryPath, "utf8")}\n`);
  const stale = await staleLoader.refreshStale();
  assert.equal(stale.modules[0].status, "stale");
});

test("reports sdkVersion mismatch as a warning without disabling the module", async () => {
  const project = await readFixtureProject();
  const goodDefinition = project.modules.find((module) => module.id === "visualbridge.fixture.good");
  assert.ok(goodDefinition);
  const { loader } = await createFixtureLoader({
    modules: [goodDefinition],
    sdkVersion: "9.9.9",
  });
  const module = loader.result.modules[0];
  assert.equal(module.status, "loaded");
  const mismatch = module.diagnostics.find((diagnostic) => diagnostic.code === "module.sdkVersionMismatch");
  assert.ok(mismatch);
  assert.equal(mismatch.severity, "warning");
  assert.match(mismatch.message, /9\.9\.9/u);
});

test("does not allow expectedApiVersion to relax the MODULE_API_VERSION gate", async () => {
  const project = await readFixtureProject();
  const apiDefinition = project.modules.find((module) => module.id === "visualbridge.fixture.api");
  assert.ok(apiDefinition);
  // JS 仍可传额外属性；装载器不得读取它来放宽门禁。
  const loader = await ModuleLoader.create({
    projectRoot: FIXTURE_ROOT,
    projectId: project.projectId,
    modules: [apiDefinition],
    trusted: true,
    expectedApiVersion: 999,
  });
  assert.equal(loader.result.modules[0].status, "disabled");
  assert.deepEqual(
    loader.result.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
    ["module.apiVersionMismatch"],
  );
});

test("disposes module registrations on Project close and definition changes", async () => {
  const { loader, hostLogs } = await createFixtureLoader();
  assert.ok(hostLogs.some((entry) => entry.message === "fixture.good.activate"));
  loader.dispose();
  assert.equal(hostLogs.filter((entry) => entry.message === "fixture.good.dispose").length, 1);
  loader.dispose();
  assert.equal(hostLogs.filter((entry) => entry.message === "fixture.good.dispose").length, 1);

  const project = await readFixtureProject();
  const goodDefinition = project.modules.find((module) => module.id === "visualbridge.fixture.good");
  assert.ok(goodDefinition);
  const reloaded = await createFixtureLoader({ modules: [goodDefinition] });
  await reloaded.loader.reload([]);
  assert.equal(reloaded.hostLogs.filter((entry) => entry.message === "fixture.good.dispose").length, 1);
  assert.equal(reloaded.loader.result.modules.length, 0);
});

test("blocks relative requires and does not expose require.resolve", async (t) => {
  const temporaryProject = await mkdtemp(path.join(os.tmpdir(), "visualbridge-module-require-"));
  t.after(() => rm(temporaryProject, { recursive: true, force: true }));
  await mkdir(path.join(temporaryProject, "Modules"), { recursive: true });
  await writeFile(path.join(temporaryProject, "Modules", "sibling.js"), "module.exports = {};\n", "utf8");
  await writeFile(path.join(temporaryProject, "Modules", "relative.vbmodule.js"), [
    'const sibling = require("./sibling.js");',
    "module.exports = {",
    '  manifest: { id: "visualbridge.fixture.relative", version: "0.1.0", apiVersion: 1, editors: ["fixture"] },',
    "  activate() { return { editors: [] }; },",
    "  webviews: {},",
    "  sibling,",
    "};",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(temporaryProject, "Modules", "resolve.vbmodule.js"), [
    'const resolved = require.resolve("node:fs");',
    "module.exports = {",
    '  manifest: { id: "visualbridge.fixture.resolve", version: "0.1.0", apiVersion: 1, editors: ["fixture"] },',
    "  activate() { return { editors: [] }; },",
    "  webviews: {},",
    "  resolved,",
    "};",
    "",
  ].join("\n"), "utf8");

  const loader = await ModuleLoader.create({
    projectRoot: temporaryProject,
    projectId: "visualbridge.require",
    modules: [
      { id: "visualbridge.fixture.relative", entry: "Modules/relative.vbmodule.js" },
      { id: "visualbridge.fixture.resolve", entry: "Modules/resolve.vbmodule.js" },
    ],
    trusted: true,
  });
  assert.deepEqual(
    loader.result.modules[0].diagnostics.map((diagnostic) => diagnostic.code),
    ["module.loadFailed"],
  );
  assert.deepEqual(
    loader.result.modules[1].diagnostics.map((diagnostic) => diagnostic.code),
    ["module.loadFailed"],
  );
});

test("covers the complete module.* error code set", async (t) => {
  assert.equal(MODULE_ERROR_CODES.length, 16);
  const covered = new Set();
  const { loader } = await createFixtureLoader();
  for (const diagnostic of loader.result.diagnostics) covered.add(diagnostic.code);

  const project = await readFixtureProject();
  const goodDefinition = project.modules.find((module) => module.id === "visualbridge.fixture.good");
  assert.ok(goodDefinition);
  await loader.reload([{ id: goodDefinition.id, entry: "../outside.vbmodule.js" }]);
  for (const diagnostic of loader.result.diagnostics) covered.add(diagnostic.code);
  await loader.reload([{ id: goodDefinition.id, entry: "Modules/missing.vbmodule.js" }]);
  for (const diagnostic of loader.result.diagnostics) covered.add(diagnostic.code);

  const temporaryProject = await copyFixtureProject(t);
  await symlink(
    path.join(temporaryProject, "Modules"),
    path.join(temporaryProject, "LinkedModules"),
    "junction",
  );
  const aliasLoader = await ModuleLoader.create({
    projectRoot: temporaryProject,
    projectId: "visualbridge.alias",
    modules: [{ id: goodDefinition.id, entry: "LinkedModules/good.vbmodule.js" }],
    trusted: true,
  });
  for (const diagnostic of aliasLoader.result.diagnostics) covered.add(diagnostic.code);

  const untrusted = await ModuleLoader.create({
    projectRoot: FIXTURE_ROOT,
    projectId: project.projectId,
    modules: [goodDefinition],
    trusted: false,
  });
  for (const diagnostic of untrusted.result.diagnostics) covered.add(diagnostic.code);
  const disabled = await ModuleLoader.create({
    projectRoot: FIXTURE_ROOT,
    projectId: project.projectId,
    modules: [goodDefinition],
    trusted: true,
    disabledModuleIds: [goodDefinition.id],
  });
  for (const diagnostic of disabled.result.diagnostics) covered.add(diagnostic.code);

  assert.deepEqual([...covered].sort(), [...MODULE_ERROR_CODES].sort());
});

test("buildModule output is evaluable by ModuleLoader", async (t) => {
  const buildPath = ensureSdkBuild();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "visualbridge-module-build-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await writeFile(path.join(temporaryDirectory, "webview.ts"), [
    'import "./webview.css";',
    'const root = document.getElementById("root");',
    'if (root) root.textContent = \'require("lodash") in a webview string\';',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(temporaryDirectory, "webview.css"), [
    ":root { --integration-test: 1; }",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(temporaryDirectory, "module.ts"), [
    'import { sep } from "node:fs";',
    "",
    "export const manifest = {",
    '  id: "visualbridge.integration",',
    '  version: "0.1.0",',
    "  apiVersion: 1,",
    '  sdkVersion: "0.1.0",',
    '  editors: ["sample"],',
    "};",
    "",
    "export function activate(host: { log: (level: string, message: string) => void }) {",
    '  host.log("info", `separator=${sep}`);',
    "  return {",
    "    editors: [{",
    '      editor: "sample",',
    "      storage: {",
    '        kind: "text",',
    "        codec: {",
    "          parse(text: string) { return { success: true, document: { text }, diagnostics: [] }; },",
    "          render(document: { text: string }) { return document.text; },",
    "        },",
    "      },",
    "      semantic: {",
    '        editor: "sample",',
    '        describe() { return { title: "Sample" }; },',
    "        validate() { return []; },",
    "        applyOperations(document: unknown) { return { success: true, document, diagnostics: [] }; },",
    "        collectReferences() { return []; },",
    "        replaceReferenceValues(document: unknown) { return { success: true, document, diagnostics: [] }; },",
    "      },",
    "      session: {",
    "        createController() {",
    "          return { state() { return {}; }, async handle() { return []; } };",
    "        },",
    "      },",
    '      webview: "sample",',
    '      webviewTitle: "Sample",',
    "    }],",
    "  };",
    "}",
    "",
  ].join("\n"), "utf8");

  const sdk = await import(pathToFileURL(buildPath).href);
  const built = await sdk.buildModule({
    entry: "module.ts",
    outfile: "dist/sample.vbmodule.js",
    webviews: { sample: "webview.ts" },
    workingDirectory: temporaryDirectory,
  });
  assert.equal(built.manifest.id, "visualbridge.integration");
  assert.deepEqual(built.manifest.editors, ["sample"]);
  assert.match(built.hash, /^sha256:[0-9a-f]{64}$/u);
  const bytes = await readFile(built.outfile);
  assert.equal(built.hash, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  assert.equal(existsSync(`${built.outfile}.map`), false);
  assert.match(built.webviews.sample.style, /--integration-test/u);
  assert.match(built.webviews.sample.script, /require\("lodash"\) in a webview string/u);

  const loader = await ModuleLoader.create({
    projectRoot: temporaryDirectory,
    projectId: "visualbridge.integration",
    modules: [{ id: "visualbridge.integration", entry: "dist/sample.vbmodule.js" }],
    trusted: true,
    createHost: () => ({ log: () => undefined }),
  });
  assert.equal(loader.result.modules[0].status, "loaded");
  assert.deepEqual([...loader.result.editors.keys()], ["sample"]);
  assert.match(loader.result.modules[0].webviews.sample.script, /in a webview string/u);
});

async function createFixtureLoader(overrides = {}) {
  const project = await readFixtureProject();
  const hostLogs = [];
  const loaderLogs = [];
  const loader = await ModuleLoader.create({
    projectRoot: FIXTURE_ROOT,
    projectId: project.projectId,
    modules: project.modules,
    trusted: true,
    log: (entry) => loaderLogs.push(entry),
    createHost: () => ({
      log: (level, message, details) => hostLogs.push({ level, message, details }),
    }),
    ...overrides,
  });
  return { loader, project, hostLogs, loaderLogs };
}

async function readFixtureProject() {
  return JSON.parse(await readFile(path.join(FIXTURE_ROOT, "VisualBridge.project.vbjson"), "utf8"));
}

async function copyFixtureProject(t) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "visualbridge-module-project-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(FIXTURE_ROOT, temporaryDirectory, { recursive: true });
  return temporaryDirectory;
}

function ensureSdkBuild() {
  if (!existsSync(CORE_BUILD_PATH)) {
    buildWorkspace("@visualbridge/core");
  }
  if (!existsSync(SDK_BUILD_PATH)) {
    buildWorkspace("@visualbridge/module-sdk");
  }
  assert.equal(existsSync(SDK_BUILD_PATH), true, "ModuleSdk build output is missing.");
  return SDK_BUILD_PATH;
}

function buildWorkspace(workspace) {
  const npmExecPath = process.env.npm_execpath;
  const result = npmExecPath === undefined
    ? spawnSync(`npm run build --workspace ${workspace}`, {
        cwd: REPOSITORY_ROOT,
        shell: true,
        stdio: "inherit",
      })
    : spawnSync(process.execPath, [npmExecPath, "run", "build", "--workspace", workspace], {
        cwd: REPOSITORY_ROOT,
        stdio: "inherit",
      });
  assert.equal(result.status, 0, `Failed to build ${workspace} for the ModuleSdk integration test.`);
}
