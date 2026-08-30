import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function removeIsolatedDirectory(directoryPath, expectedPrefix) {
  if (typeof expectedPrefix !== "string" || expectedPrefix.length === 0
    || expectedPrefix.includes("/") || expectedPrefix.includes("\\")) {
    throw new TypeError("Temporary-directory cleanup requires a non-empty basename prefix.");
  }
  const canonicalTemporaryRoot = await realpath(tmpdir());
  let canonicalDirectory;
  try {
    canonicalDirectory = await realpath(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const relativeDirectory = path.relative(canonicalTemporaryRoot, canonicalDirectory);
  if (relativeDirectory.length === 0
    || relativeDirectory === ".."
    || relativeDirectory.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeDirectory)
    || !path.basename(canonicalDirectory).startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove non-test directory '${canonicalDirectory}'.`);
  }

  await rm(canonicalDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}
