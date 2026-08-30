import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const TEST_DIRECTORY_PREFIX = "visualbridge-vsix-cli-";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(scriptDirectory, "..");
const manifest = JSON.parse(await readFile(path.join(extensionPath, "package.json"), "utf8"));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const expectedIdentity = `${extensionId}@${manifest.version}`;
const requestedVsixPath = process.argv[2] ?? path.join(extensionPath, "artifacts", "visualbridge.vsix");
const vsixPath = path.resolve(process.cwd(), requestedVsixPath);
const codeCommand = process.env.VISUALBRIDGE_VSCODE_CLI ?? "code";
const codeInvocation = await resolveCodeInvocation(codeCommand);
const temporaryPath = await mkdtemp(path.join(tmpdir(), TEST_DIRECTORY_PREFIX));
const userDataPath = path.join(temporaryPath, "user-data");
const extensionsPath = path.join(temporaryPath, "extensions");
const workspacePath = path.join(temporaryPath, "workspace");
const repositoryPath = path.resolve(extensionPath, "..", "..");
const cachePath = path.join(repositoryPath, ".utmp", "vscode-test");

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
  await runPackagedActivation(installedPath);
  console.log(`[vscode-cli] PASS installed, inspected, and activated ${expectedIdentity}`);
} finally {
  await removeIsolatedDirectory(temporaryPath);
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
  const match = launcherText.match(/"%~dp0\.\.\\Code\.exe"\s+"%~dp0\.\.\\([^"\r\n]+\\resources\\app\\out\\cli\.js)"/iu);
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
    "dist/webview/entityEditor.js",
    "dist/webview/entityEditor.css",
    "dist/webview/graphEditor.js",
    "dist/webview/graphEditor.css",
    "dist/webview/projectEditor.js",
    "dist/webview/projectEditor.css",
    "dist/webview/structuredEditor.js",
    "dist/webview/structuredEditor.css",
    "dist/webview/tableEditor.js",
    "dist/webview/tableEditor.css",
    "dist/schemas/visualbridge-catalog-source.schema.json",
  ];
  for (const relativePath of requiredPaths) {
    await access(path.resolve(installedPath, relativePath), constants.R_OK);
  }

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

async function runPackagedActivation(installedPath) {
  await Promise.all([
    cp(path.join(repositoryPath, "TestData"), workspacePath, { recursive: true }),
    mkdir(cachePath, { recursive: true }),
  ]);
  const testVersion = process.env.VISUALBRIDGE_VSCODE_TEST_VERSION ?? "1.105.1";
  console.log(`[vscode-cli] Activating packaged extension with VS Code ${testVersion}`);
  await runTests({
    version: testVersion,
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
