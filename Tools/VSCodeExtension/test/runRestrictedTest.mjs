import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { configureProviderFixture } from "../../NodeHost/test/providerFixture.mjs";

const TEST_DIRECTORY_PREFIX = "visualbridge-vscode-restricted-";
const TEST_VERSION = process.env.VISUALBRIDGE_VSCODE_TEST_VERSION ?? "1.105.1";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(testDirectory, "..");
const extensionManifest = JSON.parse(await readFile(path.join(extensionPath, "package.json"), "utf8"));
const repositoryPath = path.resolve(extensionPath, "..", "..");
const sourceWorkspacePath = path.join(repositoryPath, "TestData", "ProviderSemanticProject");
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
    mkdir(providerStatePath, { recursive: true }),
    mkdir(path.join(userDataPath, "User"), { recursive: true }),
    mkdir(extensionsPath, { recursive: true }),
    mkdir(cachePath, { recursive: true }),
  ]);
  await writeFile(path.join(userDataPath, "User", "settings.json"), `${JSON.stringify({
    "security.workspace.trust.enabled": true,
    "security.workspace.trust.startupPrompt": "never",
  }, undefined, 2)}\n`, "utf8");
  await configureProviderFixture(workspacePath, {
    mode: "healthy",
    stateDirectory: providerStatePath,
    passPathsInArguments: true,
  });

  const executablePath = await downloadAndUnzipVSCode({
    version: TEST_VERSION,
    cachePath,
    extensionDevelopmentPath: extensionPath,
  });
  console.log(`[vscode-restricted] VS Code ${TEST_VERSION}`);
  console.log(`[vscode-restricted] Isolated workspace: ${workspacePath}`);
  await runRestrictedTests(executablePath, {
    workspacePath,
    providerStatePath,
    userDataPath,
    extensionsPath,
  });
  completed = true;
} finally {
  if (completed || process.env.VISUALBRIDGE_CLEAN_FAILED_TEST === "1") {
    await removeIsolatedDirectory(temporaryPath);
  } else {
    console.error(`[vscode-restricted] Preserved failed run at ${temporaryPath}`);
  }
}

async function runRestrictedTests(executablePath, paths) {
  const args = [
    paths.workspacePath,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--no-cached-data",
    "--disable-extensions",
    `--extensionDevelopmentPath=${extensionPath}`,
    `--extensionTestsPath=${path.join(testDirectory, "suite", "restrictedMode.cjs")}`,
    `--user-data-dir=${paths.userDataPath}`,
    `--extensions-dir=${paths.extensionsPath}`,
  ];
  const environment = {
    ...process.env,
    VISUALBRIDGE_TEST_EXTENSION_VERSION: extensionManifest.version,
    VISUALBRIDGE_TEST_WORKSPACE: paths.workspacePath,
    VISUALBRIDGE_PROVIDER_TEST_STATE_DIR: paths.providerStatePath,
  };
  await new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd: extensionPath,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Restricted VS Code test exited with ${code ?? signal}.`));
      }
    });
  });
}

async function removeIsolatedDirectory(directoryPath) {
  const resolvedTemporaryRoot = await realpath(tmpdir());
  const resolvedDirectory = path.resolve(directoryPath);
  if (!resolvedDirectory.startsWith(`${resolvedTemporaryRoot}${path.sep}`)
    || !path.basename(resolvedDirectory).startsWith(TEST_DIRECTORY_PREFIX)) {
    throw new Error(`Refusing to remove non-test directory '${resolvedDirectory}'.`);
  }
  await rm(resolvedDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}
