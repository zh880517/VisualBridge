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
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModule } from "@visualbridge/module-sdk/build";

const modulesRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(modulesRoot);
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
        console.error(`DRIFT ${projectRoot}: missing ${module.entry}`);
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
