import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { removeIsolatedDirectory } from "./support/removeIsolatedDirectory.mjs";

const TEST_DIRECTORY_PREFIX = "visualbridge-vscode-host-";
const TEST_VERSION = process.env.VISUALBRIDGE_VSCODE_TEST_VERSION ?? "1.105.1";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(testDirectory, "..");
const extensionManifest = JSON.parse(await readFile(path.join(extensionPath, "package.json"), "utf8"));
const repositoryPath = path.resolve(extensionPath, "..", "..");
const sourceWorkspacePath = path.join(repositoryPath, "TestData");
const cachePath = path.join(repositoryPath, ".utmp", "vscode-test");
const temporaryPath = await mkdtemp(path.join(tmpdir(), TEST_DIRECTORY_PREFIX));
const workspacePath = path.join(temporaryPath, "workspace");
const providerStatePath = path.join(temporaryPath, "provider-state");
const userDataPath = path.join(temporaryPath, "user-data");
const extensionsPath = path.join(temporaryPath, "extensions");

let completed = false;
try {
  await Promise.all([
    cp(sourceWorkspacePath, workspacePath, { recursive: true }),
    mkdir(userDataPath, { recursive: true }),
    mkdir(extensionsPath, { recursive: true }),
    mkdir(cachePath, { recursive: true }),
    mkdir(providerStatePath, { recursive: true }),
  ]);
  const providerProjectPath = path.join(
    workspacePath,
    "ProviderSemanticProject",
    "VisualBridge.project.vbjson",
  );
  const providerProject = JSON.parse(await readFile(providerProjectPath, "utf8"));
  providerProject.providers[0].args.push("--state-dir", providerStatePath);
  await writeFile(providerProjectPath, `${JSON.stringify(providerProject, undefined, 2)}\n`, "utf8");

  console.log(`[vscode-host] VS Code ${TEST_VERSION}`);
  console.log(`[vscode-host] Isolated workspace: ${workspacePath}`);
  await runTests({
    version: TEST_VERSION,
    cachePath,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(testDirectory, "suite", "index.cjs"),
    extensionTestsEnv: {
      VISUALBRIDGE_TEST_EXTENSION_VERSION: extensionManifest.version,
      VISUALBRIDGE_TEST_WORKSPACE: workspacePath,
      VISUALBRIDGE_PROVIDER_TEST_STATE_DIR: providerStatePath,
    },
    launchArgs: [
      workspacePath,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`,
    ],
  });
  completed = true;
} finally {
  if (completed || process.env.VISUALBRIDGE_CLEAN_FAILED_TEST === "1") {
    await removeIsolatedDirectory(temporaryPath, TEST_DIRECTORY_PREFIX);
  } else {
    console.error(`[vscode-host] Preserved failed run at ${temporaryPath}`);
  }
}
