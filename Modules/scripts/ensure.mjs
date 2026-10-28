/**
 * 模块产物供给（存在即跳过，缺失才供给）。
 *
 * `Modules/node_modules`、四个 `*.vbmodule.js`、以及 7 个目标工程里分发出去的 bundle 都在
 * `.gitignore` 里，干净 clone 上任何一个门禁都可能缺料。本脚本把"补料"收敛成一处：
 * - `Modules/node_modules` 缺失/半装 → `npm ci --prefix Modules`；
 * - 已安装的 `@visualbridge/module-sdk` 与 `Modules/Sdk/*.tgz` 不一致（拉到含新 tgz 的提交后
 *   本机仍是旧 SDK）→ 重装该依赖后继续，绝不静默用旧 SDK 构建；
 * - 任一 bundle 或任一目标工程里的分发产物缺失 → `node Modules/scripts/build.mjs`；
 * - 都齐 → 什么都不做（毫秒级、不写盘、不连网）。
 *
 * 版本门禁**不绕过**：`.npmrc` 的 `engine-strict=true` 是刻意设计。`npm ci` 之前先比对
 * `engines.node` 与当前运行时，不符就直接给出可操作的错误并退出 1（而不是装到一半才失败）。
 */
import { access, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.dirname(modulesRoot);
const bundleIds = ["entity", "graph", "structured", "table"];
const sdkTarball = path.join(modulesRoot, "Sdk", "visualbridge-module-sdk-0.1.0.tgz");
const installedSdk = path.join(modulesRoot, "node_modules", "@visualbridge", "module-sdk");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

/** 只覆盖本仓库实际用到的 engines 形式（精确版本或 `>=x.y.z`）；其它形式按"无法判断"处理。 */
function satisfiesNodeRange(version, range) {
  const parse = (text) => text.replace(/^[v=^~]/, "").split(".").map((part) => Number.parseInt(part, 10));
  const actual = parse(version);
  const normalized = range.trim();
  if (normalized.startsWith(">=")) {
    const min = parse(normalized.slice(2));
    for (let index = 0; index < 3; index += 1) {
      if ((actual[index] ?? 0) !== (min[index] ?? 0)) return (actual[index] ?? 0) > (min[index] ?? 0);
    }
    return true;
  }
  if (/^[\d]/.test(normalized)) {
    const expected = parse(normalized);
    return expected.every((value, index) => (actual[index] ?? 0) === value);
  }
  return undefined;
}

async function assertEngineMatches() {
  let range;
  try {
    range = (await readJson(path.join(repositoryRoot, "package.json"))).engines?.node;
  } catch {
    return;
  }
  if (typeof range !== "string") return;
  const satisfied = satisfiesNodeRange(process.versions.node, range);
  if (satisfied !== false) return;
  console.error(
    `[modules] ensure: 当前 Node v${process.versions.node}，仓库要求 engines.node ${range}。\n`
    + "[modules] ensure: .npmrc 的 engine-strict=true 是刻意设计，不绕过版本门禁。\n"
    + `[modules] ensure: 请按 .nvmrc 切换到 Node ${range} 后重试（例如 nvm use / fnm use）。`,
  );
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: modulesRoot,
    stdio: "inherit",
    // 只有 npm（Windows 上是 npm.cmd）需要 shell；node 可执行文件路径可能含空格，
    // 交给 shell 会被拆成两段（'C:\Program' is not recognized）。
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`[modules] ensure failed: ${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

const runNpm = (args) => run("npm", args, { shell: process.platform === "win32" });

/** 读 tgz 里的一个文件（bsdtar/GNU tar 都支持 `-xzOf`）；读不到返回 undefined。 */
function readTarballEntry(entry) {
  const result = spawnSync("tar", ["-xzOf", sdkTarball, entry], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || result.stdout === undefined) return undefined;
  return result.stdout;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 列出 tgz 的全部条目（`package/<rel>` → sha256）。
 *
 * 不能只抽查几个"看起来重要"的文件：本次重打包唯一变化的可执行条目是
 * `dist/build/index.js`，抽查 `package.json`/`dist/index.js` 会漏掉它，于是旧 wrapper 被静默
 * 复用、bundle 又被重新构建（Webview 回到裸 `React.createElement`，永不回 ready）。
 * 读不到条目时返回 `undefined`，调用方必须按**不一致**处理（fail-closed）。
 */
function readTarballFingerprint() {
  const listing = spawnSync("tar", ["-tzf", sdkTarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listing.status !== 0 || typeof listing.stdout !== "string") return undefined;
  const files = listing.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.endsWith("/") && line.startsWith("package/"))
    .map((line) => line.slice("package/".length));
  if (files.length === 0) return undefined;
  const fingerprint = new Map();
  for (const relative of files) {
    const bytes = readTarballEntry(`package/${relative}`);
    if (bytes === undefined) return undefined;
    fingerprint.set(relative, sha256(bytes));
  }
  return fingerprint;
}

/** 已安装 SDK 目录的文件清单（相对路径 → sha256）；读不到任何文件时返回 `undefined`。 */
async function installedSdkFingerprint() {
  const fingerprint = new Map();
  const walk = async (directory, prefix) => {
    const items = await readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const absolute = path.join(directory, item.name);
      const relative = prefix === "" ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        await walk(absolute, relative);
      } else if (item.isFile()) {
        fingerprint.set(relative, sha256(await readFile(absolute)));
      }
    }
  };
  try {
    await walk(installedSdk, "");
  } catch {
    return undefined;
  }
  return fingerprint.size === 0 ? undefined : fingerprint;
}

/**
 * SDK 漂移检查：已安装的 `@visualbridge/module-sdk` 必须与已提交的 tgz **条目全集**一致。
 *
 * 逐条比 path + sha256：多一个、少一个、内容不同都算不一致；任何读不到的条目按不一致处理。
 * 返回 `"absent"`（没有可检查对象）、`"ok"`、`"drift"`，或不一致的诊断字符串（`"drift:<原因>"`）。
 */
async function sdkState() {
  if (!(await exists(sdkTarball)) || !(await exists(path.join(installedSdk, "package.json")))) return "absent";
  const expected = readTarballFingerprint();
  if (expected === undefined) return "drift:无法读取 Modules/Sdk 里的 tgz 条目，按不一致处理";
  const actual = await installedSdkFingerprint();
  if (actual === undefined) return "drift:无法读取已安装的 @visualbridge/module-sdk 文件，按不一致处理";
  for (const [relative, hash] of expected) {
    const installed = actual.get(relative);
    if (installed === undefined) return `drift:已安装 SDK 缺少 ${relative}`;
    if (installed !== hash) return `drift:${relative} 与 tgz 内容不同`;
  }
  for (const relative of actual.keys()) {
    if (!expected.has(relative)) return `drift:已安装 SDK 多出 ${relative}`;
  }
  return "ok";
}

const distributionTargets = (await readJson(path.join(modulesRoot, "build.targets.json"))).targets;
const missingDistribution = [];
for (const target of distributionTargets) {
  // 只检查该目标工程**自己声明**的模块：构建只分发声明过的 bundle，多查会永远报缺。
  const projectRoot = path.join(repositoryRoot, ...target.split("/"));
  let declaredIds;
  try {
    declaredIds = (await readJson(path.join(projectRoot, "VisualBridge.project.vbjson"))).modules
      ?.map((module) => module.id) ?? [];
  } catch (errorValue) {
    // 不静默跳过：读不到目标工程的 Project File 意味着这次供料无法验证该目标是否齐备。
    console.warn(`[modules] ensure: 无法读取 ${target}/VisualBridge.project.vbjson（${String(errorValue)}），跳过该目标的产物检查。`);
    continue;
  }
  for (const id of declaredIds) {
    const distributed = path.join(projectRoot, "Modules", `${id.replace(/^visualbridge\./u, "")}.vbmodule.js`);
    if (!(await exists(distributed))) missingDistribution.push(`${target}/Modules/${path.basename(distributed)}`);
  }
}

const missingNodeModules = !(await exists(path.join(modulesRoot, "node_modules")))
  // 目录在但装了一半（离线缓存残缺时会出现）同样要重装：只看目录存在会漏掉这种情况。
  || !(await exists(path.join(installedSdk, "package.json")))
  || !(await exists(path.join(modulesRoot, "node_modules", "esbuild", "package.json")));
const missingBundles = [];
for (const id of bundleIds) {
  if (!(await exists(path.join(modulesRoot, `${id}.vbmodule.js`)))) missingBundles.push(`${id}.vbmodule.js`);
}
const sdkDrift = missingNodeModules ? "absent" : await sdkState();

if (!missingNodeModules && sdkDrift !== "drift" && !String(sdkDrift).startsWith("drift:")
  && missingBundles.length === 0 && missingDistribution.length === 0) {
  console.log("[modules] ensure: node_modules、4 个 bundle、7 个目标与 SDK tgz 条目全集一致，跳过供给。");
  process.exit(0);
}

if (missingNodeModules) {
  await assertEngineMatches();
  console.log("[modules] ensure: Modules/node_modules 缺失，执行 npm ci --prefix Modules。");
  runNpm(["ci", "--prefix", modulesRoot]);
}

if (sdkDrift === "drift" || String(sdkDrift).startsWith("drift:")) {
  const detail = String(sdkDrift).startsWith("drift:") ? `（${String(sdkDrift).slice("drift:".length)}）` : "";
  console.log(
    `[modules] ensure: 已安装的 @visualbridge/module-sdk 与 Modules/Sdk/visualbridge-module-sdk-0.1.0.tgz 不一致${detail}，需要重装该依赖。`,
  );
  await assertEngineMatches();
  console.log("[modules] ensure: 重装 @visualbridge/module-sdk 后继续。");
  await rm(installedSdk, { recursive: true, force: true });
  runNpm(["ci", "--prefix", modulesRoot]);
}

if (missingBundles.length > 0 || missingDistribution.length > 0) {
  const missing = [...missingBundles, ...missingDistribution];
  console.log(`[modules] ensure: 缺失 ${missing.length} 个产物（${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}），执行 node Modules/scripts/build.mjs。`);
  run(process.execPath, [path.join(modulesRoot, "scripts", "build.mjs")]);
}
