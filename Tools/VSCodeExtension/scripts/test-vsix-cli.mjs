import { access, cp, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";
import { removeIsolatedDirectory } from "../test/support/removeIsolatedDirectory.mjs";
import { verifyHostBundle, WEBVIEW_ONLY_MARKERS } from "./verify-host-bundle.mjs";

const TEST_DIRECTORY_PREFIX = "visualbridge-vsix-cli-";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(scriptDirectory, "..");
const manifest = JSON.parse(await readFile(path.join(extensionPath, "package.json"), "utf8"));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const expectedIdentity = `${extensionId}@${manifest.version}`;
const requestedVsixPath = process.argv[2] ?? path.join(extensionPath, "artifacts", "visualbridge.vsix");
const vsixPath = path.resolve(process.cwd(), requestedVsixPath);
const repositoryPath = path.resolve(extensionPath, "..", "..");
const cachePath = path.join(repositoryPath, ".utmp", "vscode-test");
const testVersion = process.env.VISUALBRIDGE_VSCODE_TEST_VERSION ?? "1.105.1";
const vscodeExecutablePath = await downloadAndUnzipVSCode({
  version: testVersion,
  cachePath,
  extensionDevelopmentPath: extensionPath,
});
const codeCommand = process.env.VISUALBRIDGE_VSCODE_CLI
  ?? resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
const codeInvocation = await resolveCodeInvocation(codeCommand);
const temporaryPath = await mkdtemp(path.join(tmpdir(), TEST_DIRECTORY_PREFIX));
const userDataPath = path.join(temporaryPath, "user-data");
const extensionsPath = path.join(temporaryPath, "extensions");
const workspacePath = path.join(temporaryPath, "workspace");

try {
  await access(vsixPath, constants.R_OK);
  runCode(["--version"]);
  runCode([
    "--user-data-dir", userDataPath,
    "--extensions-dir", extensionsPath,
    "--install-extension", vsixPath,
    "--force",
  ]);

  const installed = runCode([
    "--user-data-dir", userDataPath,
    "--extensions-dir", extensionsPath,
    "--list-extensions",
    "--show-versions",
  ]).stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!installed.includes(expectedIdentity)) {
    throw new Error(`Expected '${expectedIdentity}' in installed extensions, received: ${installed.join(", ")}`);
  }

  const installedPath = await verifyInstalledFiles(extensionsPath, manifest);
  await runPackagedActivation(installedPath, vscodeExecutablePath);
  console.log(`[vscode-cli] PASS installed, inspected, and activated ${expectedIdentity}`);
} finally {
  await removeIsolatedDirectory(temporaryPath, TEST_DIRECTORY_PREFIX);
}

function runCode(args) {
  console.log(`[vscode-cli] ${codeCommand} ${args.join(" ")}`);
  const result = spawnSync(codeInvocation.executable, [...codeInvocation.prefixArgs, ...args], {
    encoding: "utf8",
    env: codeInvocation.environment,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout.trim().length > 0) process.stdout.write(stdout);
  if (stderr.trim().length > 0) process.stderr.write(stderr);
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`VS Code CLI exited with code ${result.status ?? "unknown"}.`);
  }
  return { stdout, stderr };
}

async function resolveCodeInvocation(command) {
  if (process.platform !== "win32") {
    return { executable: command, prefixArgs: [], environment: process.env };
  }

  const commandPath = path.isAbsolute(command) ? command : resolveWindowsCommand(command);
  if (path.extname(commandPath).toLocaleLowerCase("en-US") !== ".cmd") {
    throw new Error(
      `Windows VS Code CLI '${commandPath}' must be the installed code.cmd launcher. `
      + "Set VISUALBRIDGE_VSCODE_CLI to its absolute path.",
    );
  }

  const launcherText = await readFile(commandPath, "utf8");
  const match = launcherText.match(/"%~dp0\.\.\\Code\.exe"\s+"%~dp0\.\.\\([^"\r\n]*resources\\app\\out\\cli\.js)"/iu);
  if (match === null) {
    throw new Error(`Cannot resolve Code.exe and cli.js from '${commandPath}'.`);
  }

  const installationPath = path.resolve(path.dirname(commandPath), "..");
  const executable = path.join(installationPath, "Code.exe");
  const cliPath = path.resolve(installationPath, match[1]);
  await Promise.all([access(executable, constants.X_OK), access(cliPath, constants.R_OK)]);
  return {
    executable,
    prefixArgs: [cliPath],
    environment: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VSCODE_DEV: "",
    },
  };
}

function resolveWindowsCommand(command) {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Cannot find VS Code CLI '${command}' on PATH.`);
  }
  const candidates = (result.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return candidates.find((candidate) => path.extname(candidate).toLocaleLowerCase("en-US") === ".cmd")
    ?? candidates[0]
    ?? command;
}

async function verifyInstalledFiles(extensionsDirectory, expectedManifest) {
  const entries = await readdir(extensionsDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateManifestPath = path.join(extensionsDirectory, entry.name, "package.json");
    try {
      const candidate = JSON.parse(await readFile(candidateManifestPath, "utf8"));
      if (candidate.publisher === expectedManifest.publisher
        && candidate.name === expectedManifest.name
        && candidate.version === expectedManifest.version) {
        candidates.push(path.join(extensionsDirectory, entry.name));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (candidates.length !== 1) {
    throw new Error(`Expected one installed directory for '${expectedIdentity}', found ${candidates.length}.`);
  }

  const installedPath = candidates[0];
  const schemaPaths = (expectedManifest.contributes?.jsonValidation ?? []).map(({ url }) => {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("Every contributes.jsonValidation entry must declare a packaged URL.");
    }
    return url.replace(/^\.\//u, "");
  });
  const requiredPaths = [
    expectedManifest.main,
    expectedManifest.icon,
    ...schemaPaths,
    // C2：宿主只托管 Project Settings 的 Webview；四个领域编辑器的脚本/样式随模块 bundle 分发。
    "dist/webview/projectEditor.js",
    "dist/webview/projectEditor.css",
    "dist/schemas/visualbridge-catalog-source.schema.json",
  ];
  for (const relativePath of requiredPaths) {
    await access(path.resolve(installedPath, relativePath), constants.R_OK);
  }
  await verifyHostBundleCarriesNoDomainCode(installedPath, expectedManifest);

  const packagedPaths = await listPackagedPaths(installedPath);
  const forbiddenRoots = new Set([".test-dist", "artifacts", "node_modules", "scripts", "src", "test"]);
  const forbiddenFiles = new Set([
    ".gitignore",
    ".vscodeignore",
    "assets/visualbridge-icon-source.png",
    "tsconfig.json",
    "tsconfig.test.json",
  ]);
  const leakedPaths = packagedPaths.filter((relativePath) => {
    const normalized = relativePath.replaceAll("\\", "/");
    return normalized.endsWith(".map")
      || forbiddenRoots.has(normalized.split("/")[0])
      || forbiddenFiles.has(normalized);
  });
  if (leakedPaths.length > 0) {
    throw new Error(`Unexpected packaged paths: ${leakedPaths.join(", ")}`);
  }
  return installedPath;
}

/**
 * C2 断言：打包后的宿主 bundle 里没有领域源码，`dist/webview` 里也没有领域 Webview 产物。
 *
 * 结构判据来自 `verify-host-bundle.mjs`（esbuild metafile 输入图 + 四域标记），它比纯字符串标记
 * 可证伪：把领域代码重新 import 回宿主入口时，metafile 会列出 `Modules/`、
 * `Editors/` 的输入，四域标记也会从 0 变成非 0（实测 28/109/20/41）。
 * 重型依赖标记作为第二层，只能证明 Webview 依赖没进宿主。
 */
async function verifyHostBundleCarriesNoDomainCode(installedPath, expectedManifest) {
  const bundlePath = path.resolve(installedPath, expectedManifest.main);
  const structure = await verifyHostBundle({ bundlePath });
  if (!structure.ok) {
    throw new Error(`Packaged host bundle still carries domain code:\n${structure.failures.join("\n")}`);
  }
  console.log(`[vscode-cli] Host bundle structure: ${structure.inputs} inputs, ${structure.bundleBytes} bytes, no domain code.`);

  const bundleText = await readFile(bundlePath, "utf8");
  const present = [...WEBVIEW_ONLY_MARKERS].filter((marker) => bundleText.includes(marker));
  if (present.length > 0) {
    throw new Error(`Packaged host bundle still contains domain code: ${present.join(", ")}`);
  }

  const webviewDirectory = path.resolve(installedPath, "dist", "webview");
  const webviewEntries = (await readdir(webviewDirectory)).sort();
  const expected = ["projectEditor.css", "projectEditor.js"];
  if (webviewEntries.length !== expected.length || webviewEntries.some((entry, index) => entry !== expected[index])) {
    throw new Error(
      `Packaged 'dist/webview' must contain only ${expected.join(", ")}; found ${webviewEntries.join(", ")}.`,
    );
  }
}

async function runPackagedActivation(installedPath, executablePath) {
  await Promise.all([
    cp(path.join(repositoryPath, "TestData"), workspacePath, { recursive: true }),
    mkdir(cachePath, { recursive: true }),
  ]);
  console.log(`[vscode-cli] Activating packaged extension with VS Code ${testVersion}`);
  await runTests({
    vscodeExecutablePath: executablePath,
    cachePath,
    extensionDevelopmentPath: path.join(extensionPath, "test", "vsix-runner"),
    extensionTestsPath: path.join(extensionPath, "test", "suite", "packagedActivation.cjs"),
    extensionTestsEnv: {
      VISUALBRIDGE_PACKAGED_EXTENSION_ROOT: installedPath,
      VISUALBRIDGE_TEST_WORKSPACE: workspacePath,
      VISUALBRIDGE_TEST_EXTENSION_VERSION: manifest.version,
    },
    launchArgs: [
      workspacePath,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`,
    ],
  });
}

async function listPackagedPaths(rootPath, relativeDirectory = "") {
  const directoryPath = path.join(rootPath, relativeDirectory);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    result.push(relativePath);
    if (entry.isDirectory()) {
      result.push(...await listPackagedPaths(rootPath, relativePath));
    }
  }
  return result.sort();
}
