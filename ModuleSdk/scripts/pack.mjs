/**
 * 打包 SDK 并维护 `Modules/Sdk/` 下的只读 tgz。
 *
 * `--update`：用确定性 packer 重新打包并写入 `Modules/Sdk/`。
 * `--check`：重新打包后与**已提交**的 tgz 逐字节比较。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareBytes, packPackage } from "./pack-lib.mjs";

const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(sdkRoot);
const sdkDirectory = path.join(repositoryRoot, "Modules", "Sdk");
const mode = process.argv[2];

if (mode !== "--update" && mode !== "--check") {
  throw new Error("Usage: node ModuleSdk/scripts/pack.mjs --update|--check");
}

await assertExists(path.join(sdkRoot, "dist", "index.js"), "SDK build output is missing; run npm run build --workspace @visualbridge/module-sdk first.");
const packed = await packPackage();
const baselinePath = path.join(sdkDirectory, packed.filename);

if (mode === "--update") {
  await mkdir(sdkDirectory, { recursive: true });
  await writeFile(baselinePath, packed.bytes);
  console.log(
    `[module-sdk] wrote ${path.relative(repositoryRoot, baselinePath)} `
    + `(${packed.hash}, ${packed.files.length} files).`,
  );
} else {
  await assertExists(baselinePath, `Committed SDK artifact '${path.relative(repositoryRoot, baselinePath)}' is missing; run npm run build:sdk.`);
  const baseline = await readFile(baselinePath);
  const comparison = compareBytes(packed.bytes, baseline);
  if (!comparison.matches) {
    throw new Error(
      `SDK artifact drift: packed ${comparison.actualHash} (${comparison.actualLength} bytes) does not match committed `
      + `${comparison.baselineHash} (${comparison.baselineLength} bytes). Run 'npm run build:sdk' to refresh the artifact.`,
    );
  }
  console.log(`[module-sdk] ${path.relative(repositoryRoot, baselinePath)} matches the packed bytes (${packed.hash}).`);
}

async function assertExists(filePath, message) {
  try {
    const entry = await stat(filePath);
    if (!entry.isFile()) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}
