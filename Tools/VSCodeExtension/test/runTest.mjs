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
// E10：面板 Runtime 腿的发现目录必须是本次运行独有的空目录，否则宿主机上开着的 Play 模式
// 会让「没有端点」的用例真连上（`extension.ts` 在 activate 时读一次这个变量）。
const runtimeDiscoveryPath = path.join(temporaryPath, "runtime-discovery");
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
    mkdir(runtimeDiscoveryPath, { recursive: true }),
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
      VISUALBRIDGE_TEST_RUNTIME_DIR: runtimeDiscoveryPath,
      // TEST-NET-1（RFC 5737 文档地址）：本机永远不可达，端口段探测每次都会吃满 300 ms 超时，
      // 于是「open 不等待探测」可以靠因果断言（返回时仍是 connecting）而不是靠墙钟阈值来证明。
      VISUALBRIDGE_TEST_RUNTIME_PROBE_HOST: "192.0.2.1",
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
