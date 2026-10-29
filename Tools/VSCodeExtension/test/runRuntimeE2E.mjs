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
// 显式开启 trace 时把 Unity 日志放到运行前面创建的目录（临时目录在 finally 里会被删，失败现场需要它）。
const traceDirectory = process.env.VISUALBRIDGE_DEBUG_TRACE === "1"
  ? await mkdtemp(path.join(tmpdir(), "visualbridge-unity-trace-"))
  : temporaryPath;
const unityLogPath = path.join(traceDirectory, "unity.log");
const controlPath = path.join(temporaryPath, "e2e-control.txt");
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
    // E2E 的指令通道（当前只支持 `create <instanceId>`）：测试进程写文件，Unity 侧在 Play 模式下执行
    // 并把结果追加到 `<control>.result`。E10 用它验证"临时连接关闭后会话仍可写"。
    VISUALBRIDGE_RUNTIME_E2E_CONTROL: controlPath,
    // 让 Play 模式 server 按 Player 的端口段规则监听（附录 A.8），
    // 从而让 VS Code 侧的端口段探测（并发 8 / 300 ms）成为真实链路而不是单测桩。
    VISUALBRIDGE_RUNTIME_E2E_PORT_RANGE: process.env.VISUALBRIDGE_RUNTIME_E2E_PORT_RANGE ?? "28300-28349",
  },
  stdio: "ignore",
});
const unityExit = new Promise((resolve) => {
  unity.once("exit", (code) => resolve(code));
});
// 会话诊断（显式开启时才有日志）：把 Unity 侧的 `[debug-session]` / `[graph-debug]` 行实时转出来，
// 用例失败时能直接看到"谁重开了调试会话"，不必事后翻临时目录（目录随进程结束被删）。
if (process.env.VISUALBRIDGE_DEBUG_TRACE === "1") {
  const traceTail = () => {
    try {
      const content = readFileSync(unityLogPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (line.includes("[debug-session]") || line.includes("[graph-debug]")) {
          console.log(`[unity-trace] ${line}`);
        }
      }
    } catch {
      // Unity 日志可能已被清理：忽略。
    }
  };
  // 两条退出路径都打印一次（用例失败也会走到这里），保证失败现场不缺诊断。
  process.on("exit", traceTail);
}

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
      VISUALBRIDGE_RUNTIME_E2E_CONTROL: controlPath,
      // 用例读 Unity 自己的日志做因果正控（stacked / session kept），只读、不参与运行控制。
      VISUALBRIDGE_RUNTIME_E2E_LOG: unityLogPath,
      // 排障：把 IDE 侧的运行日志（含面板连接触发 tag / 调用栈）原样带出来；只在显式开 trace 时生效。
      ...(process.env.VISUALBRIDGE_DEBUG_TRACE === "1" ? { VISUALBRIDGE_TEST_LOG: "1" } : {}),
      // 单用例过滤（取证用）：透传给运行时套件，空/未设置时跑全部。
      ...(process.env.VISUALBRIDGE_RUNTIME_E2E_ONLY === undefined
        ? {}
        : { VISUALBRIDGE_RUNTIME_E2E_ONLY: process.env.VISUALBRIDGE_RUNTIME_E2E_ONLY }),
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
  const unityCode = await withTimeout(
    unityExit,
    180_000,
    () => `Unity Editor did not exit after the runtime E2E run. Unity log tail: ${readFileSyncTail(unityLogPath)}`,
  );

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

  // 显式开启 trace 时把 Unity 日志原样留在临时目录并打印路径（默认仍删除，不污染产品 diff）。
  if (process.env.VISUALBRIDGE_DEBUG_TRACE === "1") {
    console.log(`[runtime-e2e] unity log kept at ${unityLogPath}`);
  } else {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 给一个 Promise 加超时，并保证计时器一定被清掉：`Promise.race` 不会取消落败的那一支，
 * 未清掉的 180s 兜底计时器会让进程在用例结束后继续挂到它触发为止（实测 18s 的用例变成 ~200s）。
 */
async function withTimeout(promise, timeoutMilliseconds, message) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => {
      reject(new Error(typeof message === "function" ? message() : message));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(handle);
  }
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
