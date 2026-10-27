import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyModuleEntry } from "../dist/moduleAuthorization.js";

/**
 * 模块 entry 校验是唯一把"工程声明"与"磁盘字节"钉在一起的地方，因此这里逐个钉住
 * 附录 D.2 的路径/Hash 错误码：
 * - `module.invalidPath`：词法路径越出 `VISUALBRIDGE_WORKSPACE`；
 * - `module.entryAlias`：真实路径经 junction/symlink 别名越出工作区；
 * - `module.notFound`：工程声明的 entry 不存在；
 * - `module.loadFailed`：存在但不可读（例如 entry 是目录）；
 * - `module.hashMismatch`：`hash` 与 bundle 字节不符。
 */

const MODULE_ID = "visualbridge.graph";
const ENTRY = "Modules/graph.vbmodule.js";
const BUNDLE = Buffer.from("module.exports = { manifest: { id: 'visualbridge.graph' } };\n", "utf8");

test("reports the bundle sha256 and no diagnostics for a readable entry", async () => {
  await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
    await writeEntry(projectRoot, BUNDLE);
    const verification = await verifyModuleEntry(context(projectRoot), declaration(), workspaceRoot);
    assert.equal(verification.status, "loaded");
    assert.equal(verification.sha256, sha256(BUNDLE));
    assert.deepEqual(verification.diagnostics, []);
  });
});

test("accepts a declared hash that matches the bundle bytes", async () => {
  await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
    await writeEntry(projectRoot, BUNDLE);
    // Project File 的 hash 形态是 `sha256:<hex>`（附录 D.1）；比较必须按同一形态，
    // 否则"声明值完全正确"也会被误判成 hashMismatch。
    const verification = await verifyModuleEntry(
      context(projectRoot),
      declaration({ hash: `sha256:${sha256(BUNDLE)}` }),
      workspaceRoot,
    );
    assert.equal(verification.status, "loaded");
    assert.equal(verification.sha256, sha256(BUNDLE));
    assert.deepEqual(verification.diagnostics, []);
  });
});

test("rejects a declared hash that does not match the bundle bytes", async () => {
  await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
    await writeEntry(projectRoot, BUNDLE);
    const declaredHash = `sha256:${"0".repeat(64)}`;
    const verification = await verifyModuleEntry(
      context(projectRoot),
      declaration({ hash: declaredHash }),
      workspaceRoot,
    );
    assert.equal(verification.status, "failed");
    assert.equal(Object.hasOwn(verification, "sha256"), false);
    assert.deepEqual(verification.diagnostics.map((entry) => [entry.code, entry.path]), [
      ["module.hashMismatch", `modules.${MODULE_ID}.hash`],
    ]);
    // 诊断消息必须点名被拒的模块，避免多模块工程里指不清是谁。
    assert.match(verification.diagnostics[0].message, new RegExp(MODULE_ID, "u"));
  });
});

test("reports module.invalidPath when the lexical entry leaves the workspace", async () => {
  await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
    // 工程目录在工作区之外：词法路径就已经越界，与 junction 无关。
    const outsideProject = await mkdtemp(path.join(tmpdir(), "visualbridge-mcp-unit-outside-"));
    try {
      await writeEntry(outsideProject, BUNDLE);
      const verification = await verifyModuleEntry(context(outsideProject), declaration(), workspaceRoot);
      assert.equal(verification.status, "untrusted");
      assert.deepEqual(verification.diagnostics.map((entry) => [entry.code, entry.path]), [
        ["module.invalidPath", `modules.${MODULE_ID}.entry`],
      ]);
    } finally {
      await rm(outsideProject, { recursive: true, force: true });
    }
  });
});

test("reports module.entryAlias when a directory alias leaves the workspace", async (t) => {
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-mcp-unit-alias-"));
  try {
    await writeFile(path.join(outsideRoot, "graph.vbmodule.js"), BUNDLE);
    await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
      const modulesDirectory = path.join(projectRoot, "Modules");
      if (!await createDirectoryAlias(modulesDirectory, outsideRoot, t)) return;
      const verification = await verifyModuleEntry(context(projectRoot), declaration(), workspaceRoot);
      assert.equal(verification.status, "untrusted");
      assert.deepEqual(verification.diagnostics.map((entry) => [entry.code, entry.path]), [
        ["module.entryAlias", `modules.${MODULE_ID}.entryRealPath`],
      ]);
    });
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("reports module.loadFailed when the entry exists but is not a file", async () => {
  await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
    await mkdir(path.join(projectRoot, "Modules", "graph.vbmodule.js"), { recursive: true });
    const verification = await verifyModuleEntry(context(projectRoot), declaration(), workspaceRoot);
    assert.equal(verification.status, "failed");
    assert.deepEqual(verification.diagnostics.map((entry) => [entry.code, entry.path]), [
      ["module.loadFailed", `modules.${MODULE_ID}.entry`],
    ]);
  });
});

test("reports module.notFound when the declared entry does not exist", async () => {
  await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
    // C1 已产出并分发 bundle，声明了 entry 却没有文件就是失败：
    // 继续报 `loaded` 会让"工程声明了不存在的模块"静默通过（附录 D.2 的 `module.notFound`）。
    const verification = await verifyModuleEntry(context(projectRoot), declaration(), workspaceRoot);
    assert.equal(verification.status, "failed");
    assert.equal(Object.hasOwn(verification, "sha256"), false);
    assert.deepEqual(verification.diagnostics.map((entry) => [entry.code, entry.path]), [
      ["module.notFound", `modules.${MODULE_ID}.entry`],
    ]);
    assert.match(verification.diagnostics[0].message, new RegExp(MODULE_ID, "u"));
  });
});

test("compares against the real workspace root when the workspace itself is an alias", async (t) => {
  await withWorkspace(async ({ workspaceRoot, projectRoot }) => {
    await writeEntry(projectRoot, BUNDLE);
    // 工作区根是 junction（托管测试与用户软链目录的常见形态）：把别名根当
    // `VISUALBRIDGE_WORKSPACE` 传给注册表时，工程内的 entry 不能被误判成逃逸。
    const aliasParent = await mkdtemp(path.join(tmpdir(), "visualbridge-mcp-unit-root-alias-"));
    const aliasRoot = path.join(aliasParent, "workspace");
    try {
      if (!await createDirectoryAlias(aliasRoot, workspaceRoot, t)) return;
      assert.notEqual(await realpath(aliasRoot), aliasRoot);
      const verification = await verifyModuleEntry(context(projectRoot), declaration(), aliasRoot);
      assert.equal(verification.status, "loaded");
      assert.equal(verification.sha256, sha256(BUNDLE));
      assert.deepEqual(verification.diagnostics, []);
    } finally {
      await rm(aliasParent, { recursive: true, force: true });
    }
  });
});

async function withWorkspace(action) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-mcp-unit-"));
  const projectRoot = path.join(workspaceRoot, "GraphSemanticProject");
  try {
    await mkdir(projectRoot, { recursive: true });
    await action({ workspaceRoot, projectRoot });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function context(projectRoot) {
  return {
    projectFile: "GraphSemanticProject/VisualBridge.project.vbjson",
    absoluteProjectFile: path.join(projectRoot, "VisualBridge.project.vbjson"),
    projectRoot,
    definition: {
      formatVersion: 2,
      projectId: "ModuleAuthorizationUnit",
      documentRoots: [],
      modules: [declaration()],
      documentTypes: [],
      providers: [],
    },
  };
}

function declaration(overrides = {}) {
  return { id: MODULE_ID, entry: ENTRY, ...overrides };
}

async function writeEntry(projectRoot, bytes) {
  await mkdir(path.join(projectRoot, "Modules"), { recursive: true });
  await writeFile(path.join(projectRoot, ...ENTRY.split("/")), bytes);
}

/** 目录别名在部分平台/权限下不可用；不可用时跳过该用例而不是把平台缺陷当产品缺陷。 */
async function createDirectoryAlias(linkPath, targetPath, t) {
  try {
    await symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (errorValue) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(errorValue?.code)) throw errorValue;
    t.skip(`directory aliases are unavailable on this platform (${errorValue.code})`);
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
