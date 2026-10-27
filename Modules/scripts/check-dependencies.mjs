#!/usr/bin/env node
/**
 * Modules/ 的依赖策略（与根 `Tools/DependencyPolicy` 同一条底线，但边界更窄）。
 *
 * 模块工作区的存在意义是"把 Modules/ 整个拷出仓库仍然能用"，因此这里比根宽松的地方只有一处：
 * 允许依赖 `file:../Sdk/visualbridge-module-sdk-<version>.tgz`。除此之外：
 *
 * - 依赖里**不得**出现 6 个 workspace 之外的 `@visualbridge/*`（那是仓库内部包，拷走就断）；
 * - 版本必须精确（`save-exact`），只允许 workspace 内部用 `*`；
 * - 一律 `private: true` + `UNLICENSED`，避免误发布。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulesRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspace = JSON.parse(await readFile(path.join(modulesRoot, "package.json"), "utf8"));
// `Shared/Ui` 与 `Shared/Form` 比 Modules/ 根深一层，因此允许任意层数的 `../`；
// 真正约束是"规范化后必须正好指向 Modules/Sdk/ 下那一个 tgz"（见 `sdkTarballProblem`）。
const SDK_PATH = /^file:((?:\.\.\/)+Sdk\/visualbridge-module-sdk-(\d+\.\d+\.\d+)\.tgz)$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packages = [];
const missing = [];
for (const directory of [".", ...workspace.workspaces]) {
  const file = path.join(modulesRoot, directory, "package.json");
  try {
    packages.push({ directory, record: JSON.parse(await readFile(file, "utf8")) });
  } catch (errorValue) {
    if (directory !== "." && errorValue.code === "ENOENT") {
      missing.push(directory);
      continue;
    }
    throw errorValue;
  }
}
const workspaceNames = new Set(packages
  .filter((entry) => entry.directory !== ".")
  .map((entry) => entry.record.name));

const problems = [];
for (const { directory, record } of packages) {
  const label = record.name ?? directory;
  if (record.private !== true) problems.push(`${label}: must be private`);
  if (record.license !== "UNLICENSED") problems.push(`${label}: license must be UNLICENSED`);
  if (directory !== "." && record.version === undefined) problems.push(`${label}: must declare version`);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(record[field] ?? {})) {
      if (name === "@visualbridge/module-sdk") {
        const match = SDK_PATH.exec(range);
        if (match === null) {
          problems.push(`${label}: ${field}.@visualbridge/module-sdk must be a relative file: path to Sdk/visualbridge-module-sdk-<x.y.z>.tgz, found '${range}'`);
        } else if (match[2] !== workspace.version) {
          problems.push(`${label}: SDK tgz range '${range}' must match workspace version ${workspace.version}`);
        } else if (path.resolve(modulesRoot, directory, match[1]) !== path.join(modulesRoot, "Sdk", `visualbridge-module-sdk-${workspace.version}.tgz`)) {
          problems.push(`${label}: SDK tgz range '${range}' must resolve to Modules/Sdk/visualbridge-module-sdk-${workspace.version}.tgz`);
        }
        continue;
      }
      if (name.startsWith("@visualbridge/")) {
        if (!workspaceNames.has(name)) {
          problems.push(`${label}: ${field}.${name} is a repository-internal package and cannot be used inside Modules/`);
        } else if (range !== "*") {
          problems.push(`${label}: workspace dependency ${name} must use '*'`);
        }
        continue;
      }
      if (!EXACT_VERSION.test(range)) {
        problems.push(`${label}: ${field}.${name} must use an exact version, found '${range}'`);
      }
    }
  }
}

// ── 声明完整性：`src/**`、`test/**` 与包入口里的外部包必须都在 package.json 里声明 ──────
//
// junction（`Modules/node_modules` → 根 `node_modules`）会让**漏声明**的依赖照样解析成功，
// 于是 tsc/esbuild 绿而 lockfile 一装就断。所以判据不看"能否解析"，看"是否声明"：
// 扫描下列文件里的 import/require，外部包名必须出现在 dependencies 或 devDependencies。
//
// 扫描面必须覆盖"真实会被构建/执行的代码"，否则漏声明仍能藏身（`src/**` 是 bundle 的输入，
// `test/**` 是 `npm test` 的输入，根 `index.ts` 这类入口不在 `src/` 下）：
//   - `src/**` 与 `test/**`
//   - `package.json` 的 `main` / `types` 指向的入口文件
//
// 正则必须能认出**副作用 import**（`import "pkg"`，Graph webview 用它固定样式层叠顺序）：
// 只匹配 `from "..."/import(...)/require(...)` 会静默漏掉这一类，漏声明照样能藏。
// `import` / `from` 与引号之间允许零空白（`import"pkg"`、`from"pkg"` 也是合法写法）；
// 动态 `import(...)` 仍由前面的分支（允许括号前空白）认领。
const IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)["']([^"']+)["']/gu;
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/u;
const SCAN_DIRECTORIES = ["src", "test"];
const ENTRY_FIELDS = ["main", "types"];
const warnings = [];
for (const { directory, record } of packages) {
  if (directory === ".") continue;
  const declared = new Set([
    ...Object.keys(record.dependencies ?? {}),
    ...Object.keys(record.devDependencies ?? {}),
  ]);
  const packageRoot = path.join(modulesRoot, directory);
  const scanFiles = new Set();
  for (const scanDirectory of SCAN_DIRECTORIES) {
    let entries;
    try {
      entries = await readdir(path.join(packageRoot, scanDirectory), { recursive: true, withFileTypes: true });
    } catch (errorValue) {
      if (errorValue.code === "ENOENT") continue;
      throw errorValue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
      scanFiles.add(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  for (const field of ENTRY_FIELDS) {
    const entry = record[field];
    if (typeof entry !== "string" || !SOURCE_FILE.test(entry)) continue;
    const entryPath = path.resolve(packageRoot, entry);
    if (!entryPath.startsWith(packageRoot + path.sep)) {
      problems.push(`${record.name}: package.json ${field} '${entry}' must stay inside the package`);
      continue;
    }
    scanFiles.add(entryPath);
  }
  const used = new Map();
  for (const filePath of scanFiles) {
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch (errorValue) {
      if (errorValue.code === "ENOENT") continue;
      throw errorValue;
    }
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (packageName === record.name) continue;
      if (!used.has(packageName)) used.set(packageName, path.relative(modulesRoot, filePath));
    }
  }
  for (const [packageName, filePath] of used) {
    if (!declared.has(packageName)) {
      problems.push(`${record.name}: '${packageName}' imported from ${filePath} but not declared in package.json`);
    }
  }
  for (const packageName of declared) {
    if (!used.has(packageName)) warnings.push(`${record.name}: '${packageName}' is declared but never imported (peer/type-only packages are fine)`);
  }
}
for (const directory of missing) problems.push(`${directory}: workspace is declared in package.json but has not been moved into Modules/ yet`);

for (const warning of warnings) console.warn(`dependency policy (warning): ${warning}`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`dependency policy: ${problem}`);
  process.exit(1);
}
console.log(`Checked ${packages.length} package(s) against the Modules dependency policy.`);
