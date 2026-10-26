/**
 * 把 SDK 的声明文件整理成自包含形态：
 * - 复制 Core 的公开 `.d.ts` 到 `dist/core/`（Core 公开 API 变化会进入 tgz）；
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
await assertExists(path.join(coreDist, "index.d.ts"), "Core declarations are missing; build @visualbridge/core first.");

await cp(coreDist, path.join(distRoot, "core"), {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(coreDist, source);
    if (relative === "") return true;
    const segments = relative.split(path.sep);
    if (segments.includes("test")) return false;
    if (statSync(source).isDirectory()) return true;
    return source.endsWith(".d.ts");
  },
});
await mkdir(path.join(distRoot, "protocol"), { recursive: true });
await cp(path.join(protocolGenerated, "contracts.d.ts"), path.join(distRoot, "protocol", "contracts.d.ts"));

const declarationFiles = await collectDeclarationFiles(distRoot);
for (const declarationFile of declarationFiles) {
  const original = await readFile(declarationFile, "utf8");
  const rewritten = original
    .replace(/(["'])@visualbridge\/core\1/gu, () => `"${specifierFrom(declarationFile, path.join(distRoot, "core", "index"))}"`)
    .replace(
      /(["'])(?:\.\.\/)+Protocol\/Generated\/contracts\1/gu,
      () => `"${specifierFrom(declarationFile, path.join(distRoot, "protocol", "contracts"))}"`,
    );
  if (rewritten !== original) {
    await writeFile(declarationFile, rewritten, "utf8");
  }
}

for (const declarationFile of declarationFiles) {
  const text = await readFile(declarationFile, "utf8");
  if (/(["'])@visualbridge\//u.test(text)) {
    throw new Error(`SDK declaration '${path.relative(sdkRoot, declarationFile)}' still references a workspace package.`);
  }
  if (/Protocol\/Generated/u.test(text)) {
    throw new Error(`SDK declaration '${path.relative(sdkRoot, declarationFile)}' still references the repository Protocol path.`);
  }
}

console.log(`[module-sdk] assembled ${declarationFiles.length} declaration files into ${path.relative(repositoryRoot, distRoot)}.`);

async function collectDeclarationFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectDeclarationFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
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
