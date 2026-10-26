import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeTestProject } from "../../../TestData/projectFixture.js";
import {
  isRealDirectoryEntry,
  isRealFileEntry,
  projectFilePathEquals,
  VisualBridgeWorkspace,
} from "../dist/projectWorkspace.js";

const PROJECT_FILE_NAME = "VisualBridge.project.vbjson";

test("project file identity follows platform case rules", () => {
  assert.equal(
    projectFilePathEquals("Sample/VisualBridge.project.vbjson", "sample/visualbridge.PROJECT.vbjson", "win32"),
    true,
  );
  assert.equal(
    projectFilePathEquals("Sample/VisualBridge.project.vbjson", "sample/visualbridge.PROJECT.vbjson", "linux"),
    false,
  );
  assert.equal(projectFilePathEquals("Sample/Project", "Sample/Project", "linux"), true);
});

test("directory entry helpers reject symbolic links regardless of reported file kind", () => {
  const link = {
    isFile: () => true,
    isDirectory: () => true,
    isSymbolicLink: () => true,
  };
  const file = {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  const directory = {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };

  assert.equal(isRealFileEntry(link), false);
  assert.equal(isRealDirectoryEntry(link), false);
  assert.equal(isRealFileEntry(file), true);
  assert.equal(isRealDirectoryEntry(file), false);
  assert.equal(isRealDirectoryEntry(directory), true);
});

test("resolveProject matches an existing project file with different casing on Windows", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const workspace = await VisualBridgeWorkspace.create(workspaceRoot);
    if (process.platform === "win32") {
      const project = await workspace.resolveProject("visualbridge.PROJECT.VBJSON");
      assert.equal(project.projectFile, PROJECT_FILE_NAME);
    } else {
      await assert.rejects(
        workspace.resolveProject("visualbridge.PROJECT.VBJSON"),
        (error) => error.code === "project.notFound",
      );
    }
  });
});

test("authoring and document enumeration both skip symbolic links", async (context) => {
  await withWorkspace(async (workspaceRoot) => {
    const documentsRoot = path.join(workspaceRoot, "Documents");
    const realPath = path.join(documentsRoot, "Real.vbentity");
    await writeFile(realPath, "{}", "utf8");
    const linkPath = path.join(documentsRoot, "Linked.vbentity");
    try {
      await symlink(realPath, linkPath, "file");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error?.code)) {
        throw error;
      }
      context.skip(`symbolic links are unavailable on this platform (${error.code})`);
      return;
    }

    const workspace = await VisualBridgeWorkspace.create(workspaceRoot);
    const project = await workspace.resolveProject();

    assert.deepEqual(await workspace.listAuthoringSourcePaths(project), [
      PROJECT_FILE_NAME,
      "Documents/Real.vbentity",
    ]);
    assert.deepEqual(
      (await workspace.listDeclaredDocuments(project)).map((document) => document.path),
      ["Documents/Real.vbentity"],
    );
  });
});

async function withWorkspace(action) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-mcp-workspace-"));
  try {
    await mkdir(path.join(workspaceRoot, "Documents"));
    await writeTestProject(workspaceRoot, {
      projectId: "sample.workspace",
      documentRoots: ["Documents"],
      documentTypes: [{
        id: "sample.entity",
        editor: "entity",
        include: ["Documents/**/*.vbentity"],
        exclude: [],
        catalogs: [],
      }],
    });
    await action(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
