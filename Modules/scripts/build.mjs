#!/usr/bin/env node
/**
 * 打包 4 个领域 bundle，并把每个目标工程声明的那几个 `.vbmodule.js` 分发到它的
 * `Modules/` 目录（附录 D.1 / D.3）。
 *
 * 三条约定（README「入口形状」一节有完整解释），本脚本把它们钉死在构建期：
 *
 * 1. 入口只导出 `manifest` 与 `activate(host)`。**不要导出 `webviews`**：`buildModule()`
 *    的 wrapper 会用虚拟模块里由 `webviews` 配置生成的那份覆盖它
 *    （`ModuleSdk/src/build/index.ts:96-102`），入口自己导出的既不生效也不报错，
 *    是最容易误以为"生效了"的坑 —— `assertEntryShape` 会直接失败。
 * 2. 输出名固定 `<editor>.vbmodule.js`，与 7 个 Project File 的 `modules[].entry` 逐字一致，
 *    因此打包不需要改任何工程文件。
 * 3. 分发的模块集合**从目标工程的 Project File 反推**：声明了却没有 bundle 视为错误，
 *    目录里多出未声明的 bundle 也是错误。
 *
 * `--check` 只校验不落盘（目标目录内容与最新产物字节一致）。
 * `--no-distribute` 只打 `Modules/*.vbmodule.js`，不写 7 个目标工程（C1 第三轮用它，
 * 因为 `TestData/**` 在该轮是只读的；分发留到"翻开关"那一轮）。
 *
 * 构建前先跑 `assertNoResolutionEscape()`：bundle 的每个输入都必须落在 `Modules/` 内。
 * 见该函数上的注释 —— 没有它，"依赖悄悄解析到仓库根 node_modules"会让仓库内构建与
 * 干净副本构建产出不同字节，而 `--check` 因为只与本机产物比对，抓不到这种漂移。
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `Modules/` 是独立 npm 根：没装依赖时 `@visualbridge/module-sdk` 解析不到，
 * 直接报 "Cannot find package" 对使用者没有指向性，这里先给出该跑哪条命令。
 */
try {
  await import("@visualbridge/module-sdk/build");
} catch (error) {
  console.error(
    "缺少 Modules/ 依赖（@visualbridge/module-sdk / esbuild）；请先运行 npm run build:modules（或 npm ci --prefix Modules）。",
  );
  console.error(String(error));
  process.exit(1);
}
const { buildModule } = await import("@visualbridge/module-sdk/build");

const modulesRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(modulesRoot);
/**
 * 守卫用的 esbuild 从 SDK 的解析位置取，而不是假定它被提升到 `Modules/node_modules`：
 * 这样守卫与 `buildModule()` 用的是同一个实例、同一组解析语义。
 */
const sdkRequire = createRequire(import.meta.resolve("@visualbridge/module-sdk/package.json"));
const { build: esbuild } = sdkRequire("esbuild");
const config = JSON.parse(await readFile(path.join(modulesRoot, "build.targets.json"), "utf8"));
const checkOnly = process.argv.includes("--check");
const noDistribute = process.argv.includes("--no-distribute");
/** `--check` 仍要读目标工程比对；`--no-distribute` 则连读都不读。 */
const targetProjects = checkOnly || !noDistribute ? config.targets : [];

/** 入口不得声明 `webviews`（约定 1）：任何形式的导出都算违规。 */
const ENTRY_WEBVIEW_EXPORT = /export\s+(?:const|let|var|function|class|default|\{)[^\n]*\bwebviews\b/u;

async function assertEntryShape(entryPath) {
  let source;
  try {
    source = await readFile(entryPath, "utf8");
  } catch (errorValue) {
    throw new Error(`Module entry '${path.relative(modulesRoot, entryPath)}' is missing: ${errorValue.message}`);
  }
  if (ENTRY_WEBVIEW_EXPORT.test(source)) {
    throw new Error(
      `Module entry '${path.relative(modulesRoot, entryPath)}' exports 'webviews'; the bundle webviews come from `
      + "build.targets.json and the entry export is overwritten by the build wrapper. Remove it (see Modules/README.md).",
    );
  }
  for (const required of ["manifest", "activate"]) {
    if (!new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${required}\\b`, "u").test(source)) {
      throw new Error(`Module entry '${path.relative(modulesRoot, entryPath)}' must export '${required}'.`);
    }
  }
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析守卫：本次构建的每个输入文件都必须落在 `Modules/` 之内。
 *
 * `Modules/` 是独立 npm 根，但 Node 与 esbuild 都会逐级上溯解析 bare specifier：
 * 只要某个包没真正装进 `Modules/node_modules`，解析就会悄悄落到仓库根 `node_modules`，
 * 于是"仓库内构建"与"`Modules/` 拷出去 + `npm ci`"产出不同字节（历史事故：根
 * `package.json` 的 `overrides` 把 uuid 钉在 11.1.1，而 exceljs 声明 `^8.3.0`，
 * table bundle 因此相差 7KB）。`--check` 只跟本机产物比字节，抓不到这种漂移，
 * 所以把它钉在构建期。
 *
 * 判定用 esbuild metafile 的 inputs，配置与 `buildModule()` 保持一致（同一解析器、
 * 同一组 platform/format/target），只关掉 minify（不影响解析）。豁免只有两类：
 * - Node 内置模块一律 external，不产生 input；
 * - 内存里的虚拟模块（`visualbridge:webviews`）与 `<stdin>` 之类不是磁盘路径。
 * `Modules/` 内的相对路径（含 `Modules/node_modules` 与 workspace 软链指向的
 * `Modules/**`）都算合法；解析到 `Modules/` 之外的输入一律视为逃逸并让构建失败。
 */
const VIRTUAL_INPUTS = new Set(["visualbridge:webviews"]);

function isInsideModules(absolutePath) {
  const relative = path.relative(modulesRoot, absolutePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** 从 `.../node_modules/<name>/...` 取包名与包根，把逃逸点指到具体包而不是一堆文件。 */
function packageOf(inputPath) {
  const marker = "node_modules/";
  const index = inputPath.lastIndexOf(marker);
  if (index < 0) return { name: "(bundled file)", directory: path.dirname(inputPath) };
  const segments = inputPath.slice(index + marker.length).split("/");
  const name = segments[0].startsWith("@") && segments.length > 1 ? `${segments[0]}/${segments[1]}` : segments[0];
  return { name, directory: inputPath.slice(0, index + marker.length + name.length) };
}

async function assertNoResolutionEscape() {
  /** key 是逃逸包根（小写），同一包只报一行。 */
  const escapes = new Map();
  for (const definition of config.modules) {
    const audits = [
      { label: `${definition.id} entry`, entry: definition.entry, platform: "node", format: "cjs", target: "node22" },
      ...Object.entries(definition.webviews ?? {}).map(([key, entry]) => ({
        label: `${definition.id} webview '${key}'`,
        entry,
        platform: "browser",
        format: "iife",
        target: "es2022",
      })),
    ];
    for (const audit of audits) {
      const result = await esbuild({
        entryPoints: [path.join(modulesRoot, audit.entry)],
        absWorkingDir: modulesRoot,
        bundle: true,
        write: false,
        metafile: true,
        minify: false,
        logLevel: "silent",
        // CSS 输入必须给输出路径才肯解析；`write: false` 保证这里不落盘。
        outdir: "visualbridge-audit",
        platform: audit.platform,
        format: audit.format,
        target: audit.target,
      });
      for (const inputPath of Object.keys(result.metafile.inputs)) {
        if (VIRTUAL_INPUTS.has(inputPath) || inputPath.startsWith("<")) continue;
        const absolute = path.resolve(modulesRoot, inputPath);
        if (isInsideModules(absolute)) continue;
        const escapePackage = packageOf(inputPath);
        const directory = path.resolve(modulesRoot, escapePackage.directory);
        const key = directory.toLowerCase();
        const entry = escapes.get(key) ?? { name: escapePackage.name, directory, targets: new Set(), example: inputPath };
        entry.targets.add(audit.label);
        escapes.set(key, entry);
      }
    }
  }
  if (escapes.size === 0) return;
  console.error("resolution escape: bundle inputs must stay inside Modules/ (run 'npm ci --prefix Modules' first).");
  for (const escape of escapes.values()) {
    const targets = [...escape.targets].join(", ");
    console.error(`  ${escape.name} -> ${escape.directory} (via ${targets}; e.g. '${escape.example}')`);
  }
  process.exit(1);
}

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** 目标工程声明了哪些模块（`modules[].id` + `modules[].entry`）。 */
async function declaredModules(projectRoot) {
  const projectFile = path.join(repositoryRoot, projectRoot, "VisualBridge.project.vbjson");
  const definition = JSON.parse(await readFile(projectFile, "utf8"));
  if (!Array.isArray(definition.modules)) return [];
  return definition.modules.map((entry) => {
    if (typeof entry.id !== "string" || typeof entry.entry !== "string") {
      throw new Error(`${projectRoot}: every modules[] entry must declare id and entry.`);
    }
    if (!entry.entry.startsWith("Modules/") || !entry.entry.endsWith(".vbmodule.js") || entry.entry.includes("..")) {
      throw new Error(`${projectRoot}: module '${entry.id}' entry '${entry.entry}' must be 'Modules/<name>.vbmodule.js'.`);
    }
    return { id: entry.id, entry: entry.entry };
  });
}

// 先跑解析守卫：有解析逃逸就不该产出任何产物（否则分发写出去的字节不可复现）。
await assertNoResolutionEscape();

const built = new Map();
for (const definition of config.modules) {
  const entryPath = path.join(modulesRoot, definition.entry);
  await assertEntryShape(entryPath);
  const outfile = path.join(modulesRoot, definition.outfile);
  const result = await buildModule({
    entry: entryPath,
    outfile,
    webviews: definition.webviews ?? {},
    workingDirectory: modulesRoot,
  });
  built.set(definition.id, {
    id: definition.id,
    outfile,
    hash: result.hash,
    byteLength: result.byteLength,
    webviews: Object.keys(result.webviews),
  });
}

let drift = 0;
for (const projectRoot of targetProjects) {
  const declared = await declaredModules(projectRoot);
  const targetDirectory = path.join(repositoryRoot, projectRoot, "Modules");
  if (checkOnly) {
    for (const module of declared) {
      const targetPath = path.join(repositoryRoot, projectRoot, module.entry);
      const expected = built.get(module.id);
      if (expected === undefined) {
        throw new Error(`${projectRoot}: declares '${module.entry}' but no module builds as '${module.id}'.`);
      }
      if (!(await pathExists(targetPath))) {
        // 缺产物不是"字节漂移"，而是"从没分发过"——干净 clone 的默认状态。
        // 只丢一行 DRIFT 会让人以为是内容差异而去对比 hash，故显式给可执行的动作。
        console.error(`缺少分发产物 ${path.relative(repositoryRoot, targetPath)}；请先运行 npm run build:modules（或 npm run build:bundles）`);
        drift += 1;
        continue;
      }
      if (sha256(await readFile(targetPath)) !== expected.hash) {
        console.error(`DRIFT ${projectRoot}: ${module.entry} bytes differ from the fresh build`);
        drift += 1;
      }
    }
    const extra = (await pathExists(targetDirectory) ? await readdir(targetDirectory) : [])
      .filter((name) => name.endsWith(".vbmodule.js") && !declared.some((module) => path.basename(module.entry) === name));
    for (const name of extra) {
      console.error(`DRIFT ${projectRoot}: ${name} is not declared by the project file`);
      drift += 1;
    }
    continue;
  }
  await mkdir(targetDirectory, { recursive: true });
  for (const name of (await readdir(targetDirectory))
    .filter((entry) => entry.endsWith(".vbmodule.js") && !declared.some((module) => path.basename(module.entry) === entry))) {
    await rm(path.join(targetDirectory, name), { force: true });
  }
  for (const module of declared) {
    const source = built.get(module.id);
    if (source === undefined) {
      throw new Error(`${projectRoot}: declares '${module.entry}' but no module builds as '${module.id}'.`);
    }
    await cp(source.outfile, path.join(repositoryRoot, projectRoot, module.entry));
  }
  console.log(`${projectRoot}: ${declared.map((module) => module.id).join(", ") || "(no modules)"}`);
}

for (const module of built.values()) {
  console.log(`${module.id} -> ${path.relative(modulesRoot, module.outfile)} ${module.hash} ${module.byteLength}B webviews=${module.webviews.join(",")}`);
}

if (checkOnly) {
  if (drift > 0) {
    console.error(`${drift} distribution drift(s); run 'npm run build' in Modules/ to refresh.`);
    process.exit(1);
  }
  console.log("distribution matches the fresh build");
}
