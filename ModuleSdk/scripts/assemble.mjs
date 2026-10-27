/**
 * 把 SDK 的声明与运行时整理成自包含形态：
 * - 复制 Core 的公开 `.d.ts` **与 dist JS** 到 `dist/core/`（Core 公开 API 变化会进入 tgz；
 *   JS 是模块运行时面 `src/index.ts` 那批纯函数的实现，模块打包时必须能解析到）；
 * - 复制 Protocol 生成的 `contracts.d.ts` 到 `dist/protocol/`；
 * - 把 `@visualbridge/core` 与源码内的 Protocol 相对路径改写成包内相对路径。
 *
 * 这样 `Modules/Sdk/*.tgz` 可以被独立 npm 工程消费，同时 `check:sdk` 能发现
 * “改了 Core 公开 API 但没重打包”的漂移。
 */

import { statSync } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(sdkRoot);
const distRoot = path.join(sdkRoot, "dist");
const coreDist = path.join(repositoryRoot, "Core", "dist");
const protocolGenerated = path.join(repositoryRoot, "Protocol", "Generated");

await assertExists(path.join(distRoot, "index.d.ts"), "SDK declarations are missing; run tsc first.");
await assertExists(path.join(distRoot, "index.js"), "SDK JavaScript output is missing; run tsc first.");
await assertExists(path.join(coreDist, "index.d.ts"), "Core declarations are missing; build @visualbridge/core first.");
await assertExists(path.join(coreDist, "index.js"), "Core JavaScript is missing; build @visualbridge/core first.");

await cp(coreDist, path.join(distRoot, "core"), {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(coreDist, source);
    if (relative === "") return true;
    const segments = relative.split(path.sep);
    if (segments.includes("test")) return false;
    if (statSync(source).isDirectory()) return true;
    // 只要声明与运行时；`.js.map` 以 `.map` 结尾自然被排除（发布包不带 source map）。
    return source.endsWith(".d.ts") || source.endsWith(".js");
  },
});
await mkdir(path.join(distRoot, "protocol"), { recursive: true });
await cp(path.join(protocolGenerated, "contracts.d.ts"), path.join(distRoot, "protocol", "contracts.d.ts"));

const emittedFiles = await collectEmittedFiles(distRoot);
for (const emittedFile of emittedFiles) {
  const original = await readFile(emittedFile, "utf8");
  const rewritten = original
    .replace(/(["'])@visualbridge\/core\1/gu, () => `"${specifierFrom(emittedFile, path.join(distRoot, "core", "index"))}"`)
    .replace(
      /(["'])(?:\.\.\/)+Protocol\/Generated\/contracts\1/gu,
      () => `"${specifierFrom(emittedFile, path.join(distRoot, "protocol", "contracts"))}"`,
    );
  if (rewritten !== original) {
    await writeFile(emittedFile, rewritten, "utf8");
  }
}

for (const emittedFile of emittedFiles) {
  const text = await readFile(emittedFile, "utf8");
  if (/(["'])@visualbridge\//u.test(text)) {
    throw new Error(`SDK output '${path.relative(sdkRoot, emittedFile)}' still references a workspace package.`);
  }
  // Protocol 只以类型形式进入模块契约，编译后的 JS 不应出现该路径；对 JS 一并检查没有副作用。
  if (/Protocol\/Generated/u.test(text)) {
    throw new Error(`SDK output '${path.relative(sdkRoot, emittedFile)}' still references the repository Protocol path.`);
  }
}

// 运行时面必须真的落在 dist/index.js 里：只改源码却没装包 Core 的 JS 是本脚本最容易漏的半成品。
const indexText = await readFile(path.join(distRoot, "index.js"), "utf8");
if (!/["']\.\/core\/index["']/u.test(indexText)) {
  throw new Error("SDK dist/index.js does not re-export the packaged Core runtime; check ModuleSdk/src/index.ts.");
}

console.log(
  `[module-sdk] assembled ${emittedFiles.length} declaration/runtime files into ${path.relative(repositoryRoot, distRoot)}.`,
);

async function collectEmittedFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectEmittedFiles(entryPath));
    } else if (entry.isFile() && (entry.name.endsWith(".d.ts") || entry.name.endsWith(".js"))) {
      result.push(entryPath);
    }
  }
  return result.sort();
}

function specifierFrom(fromFile, toFile) {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function assertExists(filePath, message) {
  try {
    const entry = await stat(filePath);
    if (!entry.isFile()) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}
