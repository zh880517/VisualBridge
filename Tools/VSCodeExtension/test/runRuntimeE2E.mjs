import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const TEST_VERSION = process.env.VISUALBRIDGE_VSCODE_TEST_VERSION ?? "1.105.1";
const UNITY_EDITOR = process.env.VISUALBRIDGE_UNITY_EDITOR ?? "C:\\Program Files\\Unity 6000.3.10f1\\Editor\\Unity.exe";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(testDirectory, "..");
const repositoryPath = path.resolve(extensionPath, "..", "..");
const unityProjectPath = path.join(repositoryPath, "UnityProject");
const cachePath = path.join(repositoryPath, ".utmp", "vscode-test");

await stat(unityProjectPath);
await stat(UNITY_EDITOR);

const temporaryPath = await mkdtemp(path.join(tmpdir(), "visualbridge-runtime-e2e-"));
const userDataPath = path.join(temporaryPath, "user-data");
const extensionsPath = path.join(temporaryPath, "extensions");
const quitPath = path.join(temporaryPath, "quit.txt");
await Promise.all([mkdir(userDataPath, { recursive: true }), mkdir(extensionsPath, { recursive: true }), mkdir(cachePath, { recursive: true })]);

console.log("[runtime-e2e] launching the real Unity Editor in hosted play mode");
const unityLogPath = path.join(temporaryPath, "unity.log");
const unity = spawn(UNITY_EDITOR, [
  "-batchmode",
  "-nographics",
  "-projectPath",
  unityProjectPath,
  "-executeMethod",
  "VisualBridge.Editor.VisualBridgeRuntimeBridgeBatch.RunHostedPlayMode",
  "-logFile",
  unityLogPath,
], {
  env: {
    ...process.env,
    VISUALBRIDGE_RUNTIME_E2E_QUIT: quitPath,
  },
  stdio: "ignore",
});
const unityExit = new Promise((resolve) => {
  unity.once("exit", (code) => resolve(code));
});

let completed = false;
try {
  console.log(`[runtime-e2e] launching isolated VS Code ${TEST_VERSION} with the Unity project workspace`);
  await runTests({
    version: TEST_VERSION,
    cachePath,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(testDirectory, "runtimeE2ESuite.cjs"),
    extensionTestsEnv: {
      VISUALBRIDGE_REPOSITORY_ROOT: repositoryPath,
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

  console.log("[runtime-e2e] VS Code suite finished; signalling the Unity Editor to stop");
  await writeFile(quitPath, "quit\nn", "utf8");
  const unityCode = await Promise.race([
    unityExit,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Unity Editor did not exit after the runtime E2E run. Unity log tail: ${readFileSyncTail(unityLogPath)}`)), 180_000)),
  ]);

  if (unityCode !== 0) {
    throw new Error(`Unity Editor hosted play mode exited with code ${unityCode}.`);
  }

  completed = true;
  console.log("[runtime-e2e] Unity Editor Play mode and VS Code Extension Host completed the snapshot and event round trips.");
} finally {
  if (!completed && unity.exitCode === null) {
    await writeFile(quitPath, "quit\nn", "utf8").catch(() => undefined);
    unity.kill();
    await new Promise((resolve) => {
      unity.once("exit", resolve);
      setTimeout(resolve, 10_000);
    });
  }

  await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
}

function readFileSyncTail(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const tail = content.length > 2000 ? content.slice(-2000) : content;
    return tail.split(/\r?\n/).join(" | ");
  } catch {
    return "(no unity log)";
  }
}
