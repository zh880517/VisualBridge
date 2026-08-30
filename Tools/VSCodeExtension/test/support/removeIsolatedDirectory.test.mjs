import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeIsolatedDirectory } from "./removeIsolatedDirectory.mjs";

const TEST_DIRECTORY_PREFIX = "visualbridge-safe-cleanup-";

test("removes only a prefixed temporary directory through an ancestor alias", async (context) => {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const canonicalParent = await mkdtemp(path.join(canonicalTemporaryRoot, "visualbridge-cleanup-parent-"));
  const targetDirectory = await mkdtemp(path.join(canonicalParent, TEST_DIRECTORY_PREFIX));
  const aliasContainer = await createAliasContainer(context, canonicalTemporaryRoot);
  if (aliasContainer === undefined) {
    await rm(canonicalParent, { recursive: true, force: true });
    return;
  }
  const aliasParent = path.join(aliasContainer, "temporary-root-alias");
  try {
    await symlink(canonicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error?.code)) throw error;
    context.skip(`directory aliases are unavailable on this platform (${error.code})`);
    await rm(aliasContainer, { recursive: true, force: true });
    await rm(canonicalParent, { recursive: true, force: true });
    return;
  }

  try {
    const declaredTarget = path.join(aliasParent, path.basename(targetDirectory));
    await removeIsolatedDirectory(declaredTarget, TEST_DIRECTORY_PREFIX);
    await assert.rejects(lstat(targetDirectory), { code: "ENOENT" });
  } finally {
    await unlink(aliasParent).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await rm(aliasContainer, { recursive: true, force: true });
    await rm(canonicalParent, { recursive: true, force: true });
  }
});

test("preserves temporary directories outside the trusted root or without the required prefix", async (context) => {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const unprefixed = await mkdtemp(path.join(canonicalTemporaryRoot, "visualbridge-cleanup-unprefixed-"));
  const outsideRoot = await createAliasContainer(context, canonicalTemporaryRoot);
  if (outsideRoot === undefined) {
    await rm(unprefixed, { recursive: true, force: true });
    return;
  }
  const outsideTarget = path.join(outsideRoot, `${TEST_DIRECTORY_PREFIX}outside`);
  await mkdir(outsideTarget);

  try {
    await assert.rejects(
      removeIsolatedDirectory(unprefixed, TEST_DIRECTORY_PREFIX),
      /Refusing to remove non-test directory/u,
    );
    await assert.rejects(
      removeIsolatedDirectory(outsideTarget, TEST_DIRECTORY_PREFIX),
      /Refusing to remove non-test directory/u,
    );
    assert.equal((await lstat(unprefixed)).isDirectory(), true);
    assert.equal((await lstat(outsideTarget)).isDirectory(), true);
  } finally {
    await rm(unprefixed, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

async function createAliasContainer(context, canonicalTemporaryRoot) {
  try {
    return await mkdtemp(path.join(path.dirname(canonicalTemporaryRoot), "visualbridge-cleanup-alias-"));
  } catch (error) {
    if (!["EPERM", "EACCES", "EROFS"].includes(error?.code)) throw error;
    context.skip(`a temporary-directory sibling is unavailable on this platform (${error.code})`);
    return undefined;
  }
}
