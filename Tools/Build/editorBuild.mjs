// Shared build/clean helpers for the editor webview bundles and the VS Code
// extension. Each caller passes its explicit configuration; no editor-specific
// behaviour lives here.
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const DEFAULT_DEFINE = {
  "process.env.NODE_ENV": JSON.stringify("production"),
};

const REMOVABLE_OUTPUTS = {
  dist: "dist",
  testDist: ".test-dist",
  artifacts: "artifacts",
};

/**
 * Build an editor webview bundle.
 *
 * @param {object} config
 * @param {string} config.root         Absolute editor/extension root.
 * @param {string} [config.outfile]    Output file, relative to `root`.
 * @param {string[]} [config.entryPoints=["src/webview/index.tsx"]]
 * @param {Array<{from: string, to: string}>} [config.assets]
 *        Files copied relative to `root`. Assets are copied before esbuild runs
 *        so that an asset whose destination is also an esbuild CSS output (e.g.
 *        Project's projectEditor.css) cannot race the bundle write.
 * @param {string[]} [config.external]
 * @param {Record<string, string>} [config.loader]
 * @param {Record<string, string>} [config.define] Extra defines, merged over NODE_ENV.
 */
export async function buildEditor(config) {
  if (!config || typeof config !== "object") {
    throw new Error("buildEditor: a configuration object is required");
  }

  const {
    root,
    outfile,
    entryPoints = ["src/webview/index.tsx"],
    assets = [],
    external = [],
    loader = {},
    define = {},
    format = "iife",
    minify = true,
    platform = "browser",
    sourcemap = true,
    target = "es2022",
  } = config;

  if (!root) {
    throw new Error("buildEditor: root is required");
  }
  if (!outfile) {
    throw new Error("buildEditor: outfile is required");
  }

  const absoluteOutfile = path.resolve(root, outfile);
  await mkdir(path.dirname(absoluteOutfile), { recursive: true });

  for (const asset of assets) {
    if (!asset || !asset.from || !asset.to) {
      throw new Error("buildEditor: each asset needs both 'from' and 'to'");
    }
    const from = path.resolve(root, asset.from);
    const to = path.resolve(root, asset.to);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }

  await build({
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    define: { ...DEFAULT_DEFINE, ...define },
    format,
    minify,
    outfile,
    platform,
    sourcemap,
    target,
    external,
    loader,
  });
}

/**
 * Remove generated output directories.
 *
 * @param {object} config
 * @param {string} config.root       Absolute package root.
 * @param {boolean} [config.dist=false]
 * @param {boolean} [config.testDist=false]
 * @param {boolean} [config.artifacts=false]
 * @param {string[]} [config.extra=[]] Additional paths relative to `root`.
 */
export async function cleanEditor(config) {
  if (!config || typeof config !== "object") {
    throw new Error("cleanEditor: a configuration object is required");
  }

  const { root, dist = false, testDist = false, artifacts = false, extra = [] } = config;
  if (!root) {
    throw new Error("cleanEditor: root is required");
  }

  const directories = [];
  if (dist) directories.push(REMOVABLE_OUTPUTS.dist);
  if (testDist) directories.push(REMOVABLE_OUTPUTS.testDist);
  if (artifacts) directories.push(REMOVABLE_OUTPUTS.artifacts);
  directories.push(...extra);

  await Promise.all(
    directories.map((directory) =>
      rm(path.resolve(root, directory), { recursive: true, force: true }),
    ),
  );
}

/**
 * Run a build/clean task, logging failures and preserving a non-zero exit code.
 */
export async function run(task) {
  try {
    await task();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(detail);
    process.exitCode = 1;
  }
}
