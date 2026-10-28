/**
 * 宿主 bundle 的「无领域代码」结构判据。
 *
 * 字符串标记只能覆盖"碰巧留下字符串"的依赖（`@xyflow/react`、`exceljs` 之类只出现在 Webview
 * 源里），把 Entity / Structured 重新 import 回宿主时一个标记都不会红。所以第一层判据是
 * **esbuild metafile 的输入图**：宿主 bundle 只能由 `Core/`、`Protocol/`、`Tools/`（NodeHost）
 * 与 `node_modules/` 组成，出现 `BuiltInExtensions/`、`Modules/`、`Editors/`、`Packages/`、
 * `Samples/`、`UnityProject/` 就是领域代码泄漏。
 *
 * 第二层是四域各一个**只存在于领域产物里的符号**：领域包一旦被 import，这些字符串必然被内联进
 * 宿主 bundle（构建时实测：`entityCatalog` / `graphCatalog` / `structuredCatalog` / `tableCatalog`
 * 在当前产物里都是 0，四域一起 import 后变成 28 / 109 / 20 / 41）。注意不能用领域 id
 * （`visualbridge.entity` 等）：它们在宿主里本来就有合法引用，不可证伪。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryRoot = path.resolve(extensionRoot, "..", "..");

/** 允许进入宿主 bundle 的顶层目录；其余一律视为领域代码。 */
const ALLOWED_INPUT_ROOTS = new Set(["Core", "Protocol", "Tools", "node_modules"]);

/** 四域各一个只存在于领域产物里的符号（实测：四域一起 import 后 0 → 28/109/20/41）。 */
export const DOMAIN_BUNDLE_MARKERS = Object.freeze([
  "entityCatalog",
  "graphCatalog",
  "structuredCatalog",
  "tableCatalog",
]);

/** 只允许出现在 Webview 产物里的重型依赖。 */
export const WEBVIEW_ONLY_MARKERS = Object.freeze([
  "@xyflow/react",
  "exceljs",
  "csv-parse",
  "@tanstack/react-virtual",
]);

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * @returns {Promise<{ ok: boolean, failures: string[], inputs: number, bundleBytes: number }>}
 */
export async function verifyHostBundle(options = {}) {
  const metafilePath = options.metafilePath ?? path.join(extensionRoot, "dist", "extension.meta.json");
  const bundlePath = options.bundlePath ?? path.join(extensionRoot, "dist", "extension.js");
  const failures = [];

  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const inputs = Object.keys(metafile.inputs ?? {});
  if (inputs.length === 0) failures.push(`esbuild metafile '${metafilePath}' lists no inputs.`);

  const allowed = [...ALLOWED_INPUT_ROOTS].sort().join(", ");
  for (const input of inputs) {
    const relative = path
      .relative(repositoryRoot, path.resolve(extensionRoot, input))
      .replace(/\\/gu, "/");
    if (relative.startsWith("../")) {
      failures.push(`Host bundle input '${input}' resolves outside the repository ('${relative}').`);
      continue;
    }
    const root = relative.split("/")[0];
    if (!ALLOWED_INPUT_ROOTS.has(root)) {
      failures.push(`Host bundle includes '${relative}' from '${root}/' (allowed roots: ${allowed}).`);
    }
  }

  const bundle = await readFile(bundlePath, "utf8");
  for (const marker of DOMAIN_BUNDLE_MARKERS) {
    const count = countOccurrences(bundle, marker);
    if (count > 0) {
      failures.push(`Host bundle contains domain marker '${marker}' (${count} occurrence(s)); domain code leaked into the host.`);
    }
  }
  for (const marker of WEBVIEW_ONLY_MARKERS) {
    const count = countOccurrences(bundle, marker);
    if (count > 0) {
      failures.push(`Host bundle contains webview-only dependency marker '${marker}' (${count} occurrence(s)).`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    inputs: inputs.length,
    bundleBytes: Buffer.byteLength(bundle, "utf8"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyHostBundle();
  console.log(
    `host bundle: ${result.inputs} inputs, ${result.bundleBytes} bytes, ${result.ok ? "no domain code" : "DOMAIN CODE DETECTED"}`,
  );
  for (const failure of result.failures) console.error(` - ${failure}`);
  process.exit(result.ok ? 0 : 1);
}
