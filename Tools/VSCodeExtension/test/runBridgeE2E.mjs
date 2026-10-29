import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
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

/**
 * 上一次 batchmode 运行（`test:runtime-e2e` 结束时 kill 掉自己的 Editor）可能留下崩溃恢复数据：
 * - `Temp/__Backupscenes`：GUI Editor 启动时会弹「Recovering Scene Backups」模态，`-executeMethod`
 *   永远不执行、结果文件不生成 ⇒ 假红（实测就是这样挂住的）；
 * - `Temp/UnityLockfile`：残留锁会让下一次启动以为项目仍被占用。
 *
 * **先判活再删**：`__Backupscenes` 是 Unity 的崩溃恢复备份，开发者正开着本项目 GUI Editor 且有未保存
 * 场景时删掉它可能丢数据。所以先对 `UnityLockfile` 做**独占 open** 探活：
 * - 打开成功 ⇒ 没有进程独占它 ⇒ 是残留，两处都可以清；
 * - `EBUSY`/`EPERM`/`EACCES` ⇒ 有活的 Editor 持有 ⇒ **什么都不删**，直接报错让用户先关掉
 *   （同一项目再加一个 Unity 本来也会被锁挡住，早失败比一会儿在模态里挂住更清楚）。
 * 只清本仓库 `UnityProject/` 下的这两处，别的路径一律不动；绝不强杀进程。
 */
async function findLockfileHolder() {
  const lockfile = path.join(path.resolve(unityProjectPath), "Temp", "UnityLockfile");
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const handle = await open(lockfile, "r+");
      await handle.close();
      return { path: lockfile, held: false };
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT") {
        return { path: lockfile, held: false };
      }

      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        if (attempt < attempts) {
          // 杀毒/索引器可能瞬时占用：重试几次再判定为"活 Editor"。
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        return { path: lockfile, held: true, code };
      }

      throw error;
    }
  }
}

async function clearStaleEditorState() {
  const unityRoot = path.resolve(unityProjectPath);
  const tempDirectory = path.resolve(path.join(unityRoot, "Temp"));
  if (!tempDirectory.startsWith(`${unityRoot}${path.sep}`)) {
    throw new Error(`refusing to clean outside the Unity project: ${tempDirectory}`);
  }

  const sceneBackups = path.join(tempDirectory, "__Backupscenes");
  const lockfile = path.join(tempDirectory, "UnityLockfile");
  const probe = await findLockfileHolder();
  if (probe.held) {
    throw new Error(
      `${probe.path} is held open by a live Unity Editor (${probe.code}). Close that Editor before running `
      + "the bridge E2E: nothing was deleted (Temp/__Backupscenes may hold unsaved-scene recovery data), and the "
      + "run would otherwise hang on the 'Recovering Scene Backups' modal.",
    );
  }

  const cleared = [];
  const failed = [];
  if (await stat(sceneBackups).then(() => true, () => false)) {
    await rm(sceneBackups, { recursive: true, force: true }).then(
      () => cleared.push("__Backupscenes"),
      (error) => failed.push({ target: "__Backupscenes", code: error?.code ?? "UNKNOWN", message: String(error) }),
    );
  }

  if (await stat(lockfile).then(() => true, () => false)) {
    await rm(lockfile, { force: true }).then(
      () => cleared.push("UnityLockfile"),
      (error) => failed.push({ target: "UnityLockfile", code: error?.code ?? "UNKNOWN", message: String(error) }),
    );
  }

  for (const entry of failed) {
    console.log(`[bridge-e2e] could not remove ${entry.target} (${entry.code}): ${entry.message}`);
  }

  if (failed.length > 0) {
    // 备份删不掉 ⇒ 很可能又在模态里挂住；锁文件删不掉则是锁语义问题。都明确失败，不假装清理成功。
    throw new Error(`Could not clear the stale Unity editor state: ${failed.map((entry) => entry.target).join(", ")}.`);
  }

  console.log(cleared.length > 0
    ? `[bridge-e2e] cleared stale editor state: ${cleared.join(", ")}`
    : "[bridge-e2e] nothing to clear (no stale scene backups or lockfile)");
}

await clearStaleEditorState();

/** 给一个 Promise 加超时，并保证超时计时器一定被清掉（`Promise.race` 不会取消落败分支）。 */
async function withTimeout(promise, timeoutMilliseconds, message) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(handle);
  }
}

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
  // 兜底计时器必须清掉：`Promise.race` 不会取消落败的那一支，未清掉的 120s 计时器会让
  // 进程在用例早已结束后继续挂到它触发为止（`test:runtime-e2e` 曾因此从 ~18s 变成 ~200s）。
  const unityCode = await withTimeout(
    unityExit,
    120_000,
    "Unity Editor did not exit after the E2E run.",
  );
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
