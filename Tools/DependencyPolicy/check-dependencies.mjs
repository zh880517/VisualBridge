import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const workspaceManifests = new Map();
for (const packagePath of packagePaths) {
  const manifestPath = packagePath === "." ? "package.json" : `${packagePath}/package.json`;
  const manifest = await readJson(manifestPath);
  workspaceManifests.set(packagePath, manifest);
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

// `types` 指向被 gitignore 的路径（例如 `dist/` 声明产物）本身是合法的，但它把
// 「干净 clone 上 `check` / `test` 能否解析到这个包」变成了对一次构建的依赖：
// root 的 `check` 链与 `build` 链必须在**任何消费者被检查之前**构建该包，否则干净
// clone 上会在产物出现之前就解析失败（G0 回归守卫）。只查 `types`（含
// `exports.*.types`），不查 `main` / `bin`：后者本来就是运行期产物，只在构建之后被 require。
const rootScripts = rootManifest.scripts ?? {};
const chainSegments = {
  check: expandScript(rootScripts, "check").split("&&").map((segment) => segment.trim()),
  build: expandScript(rootScripts, "build").split("&&").map((segment) => segment.trim()),
};

// 守卫用 git 判断"是否被跟踪"与"是否被 ignore"；导出的 tarball 里没有 git，这里
// fail-closed 地给一条明确信息，而不是对每个声明各报一条。
const gitWorkTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: repositoryRoot,
  windowsHide: true,
}).status === 0;
if (!gitWorkTree) {
  errors.push(
    "dependency policy needs a git work tree to evaluate gitignore rules "
    + "(git rev-parse --is-inside-work-tree failed); run this gate inside a checkout, "
    + "or skip check:dependencies when consuming an exported tarball.",
  );
}
for (const [packagePath, manifest] of gitWorkTree ? workspaceManifests : []) {
  const manifestPath = packagePath === "." ? "package.json" : `${packagePath}/package.json`;
  let ignoredDeclaration;
  for (const [field, target] of declaredTypePaths(manifest)) {
    if (typeof target !== "string" || target.length === 0) {
      errors.push(`${manifestPath} ${field} must be a non-empty string.`);
      continue;
    }
    const declaredPath = path.posix.normalize(path.posix.join(packagePath, target));
    if (path.posix.isAbsolute(declaredPath) || declaredPath.startsWith("../")) {
      errors.push(`${manifestPath} ${field} '${target}' must stay inside the repository.`);
      continue;
    }
    // 源码已入库 ⇒ 类型声明就在仓库里，与构建顺序无关。只有"未跟踪且被 ignore"
    // 的产物才需要前置构建；先判跟踪是为了不让开发机的全局 gitignore 误伤。
    if (isGitTracked(declaredPath)) continue;
    if (!isGitIgnored(declaredPath)) continue;
    ignoredDeclaration ??= { field, target, declaredPath };
  }
  if (ignoredDeclaration === undefined) continue;
  // 只要求它先于「依赖它的 workspace 被 check/build」：`check` 链里的
  // `check --workspace visualbridge` 与 `build` 链里的 `build --workspace visualbridge`
  // 都会读 module-sdk 的类型；把构建放到链尾等于没有。
  const consumers = [...workspaceManifests.values()]
    .filter((candidate) => candidate.name !== manifest.name && dependsOn(candidate, manifest.name))
    .map((candidate) => candidate.name);
  for (const [chainName, segments] of Object.entries(chainSegments)) {
    const buildIndex = segments.findIndex((segment) => isWorkspaceCommand(segment, "build", manifest.name));
    if (buildIndex < 0) {
      errors.push(
        `${manifestPath} ${ignoredDeclaration.field} '${ignoredDeclaration.target}' resolves to the gitignored `
        + `'${ignoredDeclaration.declaredPath}', so root '${chainName}' must build ${manifest.name} first: `
        + `add 'npm run build --workspace ${manifest.name}' (otherwise a clean clone fails).`,
      );
      continue;
    }
    for (const consumer of consumers) {
      const consumerIndex = segments.findIndex((segment) => (
        isWorkspaceCommand(segment, "check", consumer) || isWorkspaceCommand(segment, "build", consumer)
      ));
      if (consumerIndex < 0 || buildIndex < consumerIndex) continue;
      errors.push(
        `${manifestPath} ${ignoredDeclaration.field} '${ignoredDeclaration.target}' resolves to the gitignored `
        + `'${ignoredDeclaration.declaredPath}', but root '${chainName}' runs '${segments[consumerIndex]}' before `
        + `'npm run build --workspace ${manifest.name}'; move the ${manifest.name} build earlier in the chain.`,
      );
    }
  }
}

// `test:unit` 走的是扩展自己的 `build:host-dependencies`；"干净 clone 上先构建运行期
// 依赖与 module-sdk 类型"这条约束在 extension manifest 里又写了一遍，一并守住。
const extensionManifest = workspaceManifests.get("Tools/VSCodeExtension");
if (extensionManifest !== undefined) {
  const unitScripts = extensionManifest.scripts ?? {};
  const unitScript = unitScripts["test:unit"] ?? "";
  const unitSegments = unitScript.split("&&").map((segment) => segment.trim());
  if (!unitSegments.includes("npm run build:host-dependencies")) {
    errors.push(
      "Tools/VSCodeExtension/package.json test:unit must run 'npm run build:host-dependencies' "
      + "(a clean clone has no host runtime dist).",
    );
  }
  const unitChain = expandScript(unitScripts, "test:unit").split("&&").map((segment) => segment.trim());
  if (!unitChain.some((segment) => isWorkspaceCommand(segment, "build", "@visualbridge/module-sdk"))) {
    errors.push(
      "Tools/VSCodeExtension/package.json test:unit must build @visualbridge/module-sdk "
      + "(its types resolve to the gitignored ModuleSdk/dist).",
    );
  }
}

const editorUi = await readJson("Editors/Ui/package.json");
for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  for (const name of Object.keys(editorUi[section] ?? {})) {
    if (name.startsWith("@visualbridge/")) {
      errors.push(`Editors/Ui/package.json ${section}.${name} violates the host- and domain-independent UI boundary.`);
    }
  }
}
for (const packagePath of [
  "Editors/Form",
  "Editors/Entity",
  "Editors/Graph",
  "Editors/Project",
  "Editors/Structured",
  "Editors/Table",
]) {
  const manifest = await readJson(`${packagePath}/package.json`);
  checkEqual(
    `${packagePath}/package.json dependencies.@visualbridge/editor-ui`,
    manifest.dependencies?.["@visualbridge/editor-ui"],
    "*",
  );
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

function declaredTypePaths(manifest) {
  const declarations = [];
  if (manifest.types !== undefined) {
    declarations.push(["types", manifest.types]);
  }
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.types !== undefined) {
      declarations.push([`exports["${subpath}"].types`, entry.types]);
    }
  }
  return declarations;
}

// 把 `npm run <script>` 段递归展开成实际命令，这样 `check` 里的 `check:sdk`
// 也能被看到（它内部就是 `build --workspace @visualbridge/module-sdk`）。
// 只展开「整段就是 npm run <name>」的写法：带 `--workspace` 的段是叶子命令，
// `build:modules` 的 `--prefix Modules` 因此永远不会被误认成 workspace 构建。
function expandScript(scripts, name, stack = []) {
  const script = scripts?.[name];
  if (typeof script !== "string") return "";
  if (stack.includes(name)) {
    throw new Error(`package.json has a script cycle through '${name}'.`);
  }
  return script
    .split("&&")
    .flatMap((segment) => {
      const trimmed = segment.trim();
      const reference = /^npm run ([A-Za-z0-9:_-]+)$/u.exec(trimmed);
      if (reference === null || typeof scripts[reference[1]] !== "string") return [trimmed];
      return [expandScript(scripts, reference[1], [...stack, name])];
    })
    .join(" && ");
}

function isGitTracked(relativePath) {
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
    cwd: repositoryRoot,
    windowsHide: true,
    stdio: "ignore",
  });
  if (tracked.status === 0) return true;
  if (tracked.status === 1) return false;
  errors.push(`could not evaluate git tracking for '${relativePath}'.`);
  return false;
}

function isGitIgnored(relativePath) {
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", relativePath], {
    cwd: repositoryRoot,
    windowsHide: true,
  });
  if (ignored.status === 0) return true;
  if (ignored.status === 1) return false;
  errors.push(`could not evaluate gitignore rules for '${relativePath}'.`);
  return false;
}

function isWorkspaceCommand(segment, verb, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^npm run ${verb} (?:--workspace(?:=|\\s+)|-w(?:=|\\s+))${escaped}$`, "u").test(segment);
}

function dependsOn(manifest, packageName) {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[section]?.[packageName] !== undefined) return true;
  }
  return false;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}
