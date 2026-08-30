import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const rootManifest = await readJson("package.json");
const lock = await readJson("package-lock.json");
const versions = rootManifest.config?.visualbridgeVersions;
const errors = [];

assert.equal(typeof versions, "object", "package.json must declare config.visualbridgeVersions.");
checkEqual("root engines.node", rootManifest.engines?.node, versions.node);
checkEqual("root packageManager", rootManifest.packageManager, `npm@${versions.npm}`);
checkEqual(".nvmrc", (await readFile(path.join(repositoryRoot, ".nvmrc"), "utf8")).trim(), versions.node);
checkEqual("package-lock lockfileVersion", lock.lockfileVersion, 3);
checkExactOverrides(rootManifest.overrides, "package.json overrides");
checkOverrideLock(rootManifest.overrides);

const packagePaths = [".", ...rootManifest.workspaces];
for (const packagePath of packagePaths) {
  const manifestPath = packagePath === "." ? "package.json" : `${packagePath}/package.json`;
  const manifest = await readJson(manifestPath);
  checkEqual(`${manifestPath} private`, manifest.private, true);
  checkEqual(`${manifestPath} license`, manifest.license, "UNLICENSED");
  if (manifest.engines?.node !== undefined) {
    checkEqual(`${manifestPath} engines.node`, manifest.engines.node, versions.node);
  }
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith("@visualbridge/")) {
        checkEqual(`${manifestPath} ${section}.${name}`, version, "*");
      } else if (!isExactVersion(version)) {
        errors.push(`${manifestPath} ${section}.${name} must use an exact npm version, found '${version}'.`);
      }
    }
  }

  const lockKey = packagePath === "." ? "" : packagePath.replaceAll("\\", "/");
  const lockedPackage = lock.packages?.[lockKey];
  if (lockedPackage === undefined) {
    errors.push(`package-lock.json is missing workspace entry '${lockKey}'.`);
    continue;
  }
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      checkEqual(`package-lock ${lockKey || "root"} ${section}.${name}`, lockedPackage[section]?.[name], version);
    }
  }
}

const extension = await readJson("Tools/VSCodeExtension/package.json");
checkEqual("VS Code test-electron", extension.devDependencies?.["@vscode/test-electron"], versions.vscodeTestElectron);
checkEqual("VS Code types", extension.devDependencies?.["@types/vscode"], versions.vscodeTypes);
checkEqual("VS Code engine", extension.engines?.vscode, `^${versions.vscodeTest}`);
checkEqual("VSIX virtual workspaces", extension.capabilities?.virtualWorkspaces?.supported, false);
for (const runner of [
  "Tools/VSCodeExtension/test/runTest.mjs",
  "Tools/VSCodeExtension/test/runRestrictedTest.mjs",
]) {
  const source = await readFile(path.join(repositoryRoot, runner), "utf8");
  if (!source.includes(`?? "${versions.vscodeTest}"`)) {
    errors.push(`${runner} does not default to the fixed VS Code test version '${versions.vscodeTest}'.`);
  }
}

if (errors.length > 0) {
  throw new Error(`Dependency policy failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}
console.log(
  `[dependency-policy] Node ${versions.node}, npm ${versions.npm}, VS Code ${versions.vscodeTest}; ${packagePaths.length} private UNLICENSED packages use exact external dependency versions.`,
);

function isExactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function checkEqual(label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} expected '${String(expected)}', found '${String(actual)}'.`);
  }
}

function checkExactOverrides(value, label) {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  for (const [name, override] of Object.entries(value)) {
    if (typeof override === "string") {
      if (!isExactVersion(override)) {
        errors.push(`${label}.${name} must use an exact npm version, found '${override}'.`);
      }
      continue;
    }
    checkExactOverrides(override, `${label}.${name}`);
  }
}

function checkOverrideLock(value) {
  for (const [name, override] of Object.entries(value ?? {})) {
    if (typeof override !== "string") continue;
    const matches = Object.entries(lock.packages ?? {}).filter(([packagePath]) => (
      packagePath === `node_modules/${name}` || packagePath.endsWith(`/node_modules/${name}`)
    ));
    if (matches.length === 0) {
      errors.push(`package-lock.json does not resolve overridden package '${name}'.`);
      continue;
    }
    for (const [packagePath, lockedPackage] of matches) {
      checkEqual(`package-lock override ${packagePath}`, lockedPackage.version, override);
    }
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}
