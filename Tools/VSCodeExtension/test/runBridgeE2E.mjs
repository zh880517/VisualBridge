import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const TEST_VERSION = process.env.VISUALBRIDGE_VSCODE_TEST_VERSION ?? "1.105.1";
const UNITY_EDITOR = process.env.VISUALBRIDGE_UNITY_EDITOR ?? "C:\\Program Files\\Unity 6000.3.10f1\\Editor\\Unity.exe";
const DOCUMENT_PATH = "Config/Game.gamesettings";
const REFERENCE_VALUE = "sample.unity.game.settings.default";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(testDirectory, "..");
const repositoryPath = path.resolve(extensionPath, "..", "..");
const unityProjectPath = path.join(repositoryPath, "UnityProject");
const cachePath = path.join(repositoryPath, ".utmp", "vscode-test");

await stat(unityProjectPath);
await stat(UNITY_EDITOR);

const temporaryPath = await mkdtemp(path.join(tmpdir(), "visualbridge-bridge-e2e-"));
const userDataPath = path.join(temporaryPath, "user-data");
const extensionsPath = path.join(temporaryPath, "extensions");
const resultPath = path.join(temporaryPath, "unity-result.txt");
await Promise.all([mkdir(userDataPath, { recursive: true }), mkdir(extensionsPath, { recursive: true }), mkdir(cachePath, { recursive: true })]);

console.log("[bridge-e2e] launching the real Unity Editor");
const unity = spawn(UNITY_EDITOR, [
  "-projectPath",
  unityProjectPath,
  "-executeMethod",
  "VisualBridge.Editor.VisualBridgeBridgeBatch.RunE2E",
], {
  env: {
    ...process.env,
    VISUALBRIDGE_BRIDGE_E2E_RESULT: resultPath,
    VISUALBRIDGE_BRIDGE_E2E_DOCUMENT: DOCUMENT_PATH,
    VISUALBRIDGE_BRIDGE_E2E_REFERENCE: REFERENCE_VALUE,
  },
  stdio: "ignore",
});
const unityExit = new Promise((resolve) => {
  unity.once("exit", (code) => resolve(code));
});

let completed = false;
try {
  console.log(`[bridge-e2e] launching isolated VS Code ${TEST_VERSION} with the Unity project workspace`);
  await runTests({
    version: TEST_VERSION,
    cachePath,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(testDirectory, "bridgeE2ESuite.cjs"),
    extensionTestsEnv: {
      VISUALBRIDGE_TEST_WORKSPACE: unityProjectPath,
      VISUALBRIDGE_BRIDGE_E2E_RESULT: resultPath,
      VISUALBRIDGE_BRIDGE_E2E_DOCUMENT: DOCUMENT_PATH,
    },
    launchArgs: [
      unityProjectPath,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`,
    ],
  });

  const exitTimer = setTimeout(() => {
    if (!completed) unity.kill();
  }, 120_000);
  const unityCode = await Promise.race([
    unityExit,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Unity Editor did not exit after the E2E run.")), 120_000)),
  ]);
  clearTimeout(exitTimer);

  const resultContent = await readFile(resultPath, "utf8").catch(() => "(no result file)");
  console.log(`[bridge-e2e] Unity result: ${resultContent.trim().replaceAll("\n", "; ")}`);
  if (unityCode !== 0) {
    throw new Error(`Unity Editor bridge E2E exited with code ${unityCode}.`);
  }

  completed = true;
  console.log("[bridge-e2e] Unity Editor and VS Code Extension Host completed the open/reveal round trip.");
} finally {
  const resultContent = await readFile(resultPath, "utf8").catch(() => "(no result file)");
  console.log(`[bridge-e2e] Unity result: ${resultContent.trim().replaceAll("\n", "; ")}`);
  if (!completed && unity.exitCode === null) {
    unity.kill();
    await new Promise((resolve) => {
      unity.once("exit", resolve);
      setTimeout(resolve, 10_000);
    });
  }

  await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
}
