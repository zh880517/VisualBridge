/**
 * `buildModule()`：用 esbuild 把模块宿主入口与 Webview 打成单个自包含
 * `.vbmodule.js`。
 *
 * 约束（附录 D.2）：
 * - Webview 先打成 IIFE + CSS（browser / es2022 / minify）；
 * - 宿主入口再打成 CJS（node / node22 / bundle），Webview 文本注入虚拟模块；
 * - 发布构建默认不写 source map；
 * - 产物必须可求值、manifest 合法、只允许 `require` Node 内置模块。
 */

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import {
  build as esbuildBuild,
  type Loader,
  type Metafile,
  type Plugin,
} from "esbuild";
import { MODULE_API_VERSION } from "../index";
import type {
  ModuleManifest,
  ModuleWebview,
} from "../index";

export type ModuleBuildErrorCode =
  | "module.invalidPath"
  | "module.loadFailed"
  | "module.manifestInvalid"
  | "module.apiVersionMismatch";

export class ModuleBuildError extends Error {
  public readonly code: ModuleBuildErrorCode;

  public constructor(code: ModuleBuildErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ModuleBuildError";
    this.code = code;
  }
}

export interface ModuleBuildOptions {
  /** 模块宿主入口（TypeScript/JavaScript）。相对路径按 `workingDirectory` 解析。 */
  readonly entry: string;
  /** 输出文件，必须以 `.vbmodule.js` 结尾。 */
  readonly outfile: string;
  /** Webview key → 入口文件；key 必须与 registration 的 `webview` 一致。 */
  readonly webviews?: Readonly<Record<string, string>>;
  /** 宿主 bundle 是否压缩；默认 true。Webview 始终按附录要求压缩。 */
  readonly minify?: boolean;
  /** 调试构建可开启；发布构建必须保持 false。 */
  readonly sourcemap?: boolean;
  /** esbuild 的编译期常量替换。 */
  readonly define?: Readonly<Record<string, string>>;
  /** 解析相对路径的基准目录；默认 `process.cwd()`。 */
  readonly workingDirectory?: string;
}

export interface ModuleBuildResult {
  readonly outfile: string;
  /** `sha256:<hex>`，即 Project File `modules[].hash` 可直接使用的值。 */
  readonly hash: string;
  readonly manifest: ModuleManifest;
  readonly webviews: Readonly<Record<string, ModuleWebview>>;
  readonly byteLength: number;
}

interface BuiltWebview {
  readonly key: string;
  readonly webview: ModuleWebview;
}

const WEBVIEW_ENTRY_NAMESPACE = "visualbridge-webview";
const WEBVIEW_MODULE_SPECIFIER = "visualbridge:webviews";

/**
 * 打包一个模块。
 *
 * 产物写入 `outfile`，返回 manifest、hash 与 Webview 文本。校验失败时抛
 * `ModuleBuildError`，不会留下半成品（先构建到内存、校验通过后再写文件）。
 */
export async function buildModule(options: ModuleBuildOptions): Promise<ModuleBuildResult> {
  const workingDirectory = path.resolve(options.workingDirectory ?? process.cwd());
  const entryPath = path.resolve(workingDirectory, options.entry);
  const outfilePath = path.resolve(workingDirectory, options.outfile);
  if (!outfilePath.endsWith(".vbmodule.js") || path.basename(outfilePath) === ".vbmodule.js") {
    throw new ModuleBuildError("module.invalidPath", `Module outfile '${options.outfile}' must end with '.vbmodule.js' and include a file name stem.`);
  }

  const webviews = await buildWebviews(options.webviews ?? {}, workingDirectory);
  const webviewTexts = Object.fromEntries(webviews.map((entry) => [entry.key, entry.webview]));

  const wrapper = [
    `import { manifest as __vbManifest, activate as __vbActivate } from ${JSON.stringify(`./${path.basename(entryPath)}`)};`,
    `import { webviews as __vbWebviews } from ${JSON.stringify(WEBVIEW_MODULE_SPECIFIER)};`,
    "export const manifest = __vbManifest;",
    "export const activate = __vbActivate;",
    "export const webviews = __vbWebviews;",
  ].join("\n");

  const result = await esbuildBuild({
    stdin: {
      contents: wrapper,
      resolveDir: path.dirname(entryPath),
      sourcefile: "visualbridge-module-entry.ts",
      loader: loaderForEntry(entryPath),
    },
    outfile: outfilePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: options.minify ?? true,
    sourcemap: options.sourcemap === true,
    write: false,
    logLevel: "silent",
    metafile: true,
    ...(options.define === undefined ? {} : { define: { ...options.define } }),
    plugins: [webviewPlugin(webviewTexts)],
  });

  const outputFiles = result.outputFiles ?? [];
  const codeFile = outputFiles.find((file) => file.path.endsWith(".js"));
  if (codeFile === undefined) {
    throw new ModuleBuildError("module.loadFailed", "esbuild did not produce a JavaScript bundle.");
  }
  const code = codeFile.text;
  assertOnlyBuiltinImports(result.metafile);
  const bundle = evaluateBundle(code, outfilePath);

  await mkdir(path.dirname(outfilePath), { recursive: true });
  const codeBytes = Buffer.from(code, "utf8");
  await writeFile(outfilePath, codeBytes);
  const mapFile = outputFiles.find((file) => file.path.endsWith(".map"));
  if (options.sourcemap === true && mapFile !== undefined) {
    await writeFile(`${outfilePath}.map`, Buffer.from(mapFile.text, "utf8"));
  } else if (options.sourcemap !== true) {
    // 发布构建必须不留旧 map，即使上一次调试构建生成过。
    await rm(`${outfilePath}.map`, { force: true });
  }

  return {
    outfile: outfilePath,
    hash: hashBytes(codeBytes),
    manifest: bundle.manifest,
    webviews: bundle.webviews,
    byteLength: codeBytes.byteLength,
  };
}

/**
 * CLI 的 JSON 配置形状；相对路径相对于配置文件所在目录。
 */
export interface ModuleBuildConfig {
  readonly entry: string;
  readonly outfile: string;
  readonly webviews?: Readonly<Record<string, string>>;
  readonly minify?: boolean;
  readonly sourcemap?: boolean;
  readonly define?: Readonly<Record<string, string>>;
}

/** 校验并规范化 CLI 配置；未知/缺失字段直接报错，避免静默忽略拼写错误。 */
export function readModuleBuildConfig(value: unknown): ModuleBuildConfig {
  if (!isRecord(value)) {
    throw new ModuleBuildError("module.manifestInvalid", "Module build config must be a JSON object.");
  }
  const knownKeys = new Set(["entry", "outfile", "webviews", "minify", "sourcemap", "define"]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      throw new ModuleBuildError("module.manifestInvalid", `Unknown module build config property '${key}'.`);
    }
  }
  if (typeof value.entry !== "string" || value.entry.length === 0) {
    throw new ModuleBuildError("module.invalidPath", "Module build config 'entry' must be a non-empty string.");
  }
  if (
    typeof value.outfile !== "string"
    || !value.outfile.endsWith(".vbmodule.js")
    || path.basename(value.outfile) === ".vbmodule.js"
  ) {
    throw new ModuleBuildError("module.invalidPath", "Module build config 'outfile' must end with '.vbmodule.js' and include a file name stem.");
  }
  const webviews = value.webviews === undefined ? undefined : readWebviewEntries(value.webviews);
  if (value.minify !== undefined && typeof value.minify !== "boolean") {
    throw new ModuleBuildError("module.manifestInvalid", "Module build config 'minify' must be a boolean.");
  }
  if (value.sourcemap !== undefined && typeof value.sourcemap !== "boolean") {
    throw new ModuleBuildError("module.manifestInvalid", "Module build config 'sourcemap' must be a boolean.");
  }
  if (value.define !== undefined) {
    if (!isRecord(value.define)) {
      throw new ModuleBuildError("module.manifestInvalid", "Module build config 'define' must be an object of strings.");
    }
    for (const [key, definition] of Object.entries(value.define)) {
      if (typeof definition !== "string") {
        throw new ModuleBuildError("module.manifestInvalid", `Module build config define['${key}'] must be a string.`);
      }
    }
  }
  return {
    entry: value.entry,
    outfile: value.outfile,
    ...(webviews === undefined ? {} : { webviews }),
    ...(value.minify === undefined ? {} : { minify: value.minify }),
    ...(value.sourcemap === undefined ? {} : { sourcemap: value.sourcemap }),
    ...(value.define === undefined ? {} : { define: { ...(value.define as Record<string, string>) } }),
  };
}

async function buildWebviews(
  webviews: Readonly<Record<string, string>>,
  workingDirectory: string,
): Promise<readonly BuiltWebview[]> {
  const entries = Object.entries(webviews);
  const built: BuiltWebview[] = [];
  for (const [key, entry] of entries) {
    if (!isWebviewKey(key)) {
      throw new ModuleBuildError("module.invalidPath", `Webview key '${key}' is not a valid bundle webview key.`);
    }
    const entryPath = path.resolve(workingDirectory, entry);
    const result = await esbuildBuild({
      entryPoints: [entryPath],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      write: false,
      absWorkingDir: workingDirectory,
      outdir: `visualbridge-webview/${key}`,
      logLevel: "silent",
    });
    const files = result.outputFiles ?? [];
    const scriptFile = files.find((file) => file.path.endsWith(".js"));
    if (scriptFile === undefined) {
      throw new ModuleBuildError("module.loadFailed", `Webview '${key}' did not produce JavaScript output.`);
    }
    const unsupported = files.find((file) => !file.path.endsWith(".js") && !file.path.endsWith(".css"));
    if (unsupported !== undefined) {
      throw new ModuleBuildError(
        "module.loadFailed",
        `Webview '${key}' produced unsupported asset '${path.basename(unsupported.path)}'; only script and CSS are supported.`,
      );
    }
    const styleFile = files.find((file) => file.path.endsWith(".css"));
    built.push({
      key,
      webview: { script: scriptFile.text, style: styleFile?.text ?? "" },
    });
  }
  return built;
}

function webviewPlugin(webviews: Readonly<Record<string, ModuleWebview>>): Plugin {
  const contents = `export const webviews = ${JSON.stringify(webviews)};`;
  return {
    name: "visualbridge-webviews",
    setup(buildContext): void {
      buildContext.onResolve({ filter: /^visualbridge:webviews$/ }, () => ({
        path: WEBVIEW_MODULE_SPECIFIER,
        namespace: WEBVIEW_ENTRY_NAMESPACE,
      }));
      buildContext.onLoad({ filter: /.*/, namespace: WEBVIEW_ENTRY_NAMESPACE }, () => ({
        contents,
        loader: "js",
      }));
    },
  };
}

function loaderForEntry(entryPath: string): Loader {
  switch (path.extname(entryPath).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    default:
      return "js";
  }
}

function evaluateBundle(code: string, filename: string): {
  readonly manifest: ModuleManifest;
  readonly webviews: Readonly<Record<string, ModuleWebview>>;
} {
  let exportsValue: unknown;
  try {
    const moduleObject: { exports: unknown } = { exports: {} };
    const compiled = compileFunction(code, ["module", "exports", "require"], { filename });
    compiled(moduleObject, moduleObject.exports, guardedRequire);
    exportsValue = moduleObject.exports;
  } catch (errorValue) {
    throw new ModuleBuildError(
      "module.loadFailed",
      `Built module is not evaluable: ${describeError(errorValue)}.`,
      { cause: errorValue },
    );
  }

  if (!isRecord(exportsValue)) {
    throw new ModuleBuildError("module.manifestInvalid", "Built module exports must be an object.");
  }
  const manifest = readManifest(exportsValue.manifest);
  if (manifest === undefined) {
    throw new ModuleBuildError(
      "module.manifestInvalid",
      "Built module manifest is invalid; expected id/version/apiVersion/editors.",
    );
  }
  if (manifest.apiVersion !== MODULE_API_VERSION) {
    throw new ModuleBuildError(
      "module.apiVersionMismatch",
      `Built module apiVersion ${manifest.apiVersion} does not match MODULE_API_VERSION ${MODULE_API_VERSION}.`,
    );
  }
  const webviews = readWebviews(exportsValue.webviews);
  if (webviews === undefined) {
    throw new ModuleBuildError(
      "module.manifestInvalid",
      "Built module webviews must be a record of { script, style } strings.",
    );
  }
  if (typeof exportsValue.activate !== "function") {
    throw new ModuleBuildError("module.manifestInvalid", "Built module must export activate(host).");
  }
  return { manifest, webviews };
}

function guardedRequire(specifier: string): unknown {
  if (typeof specifier !== "string" || !isBuiltin(specifier)) {
    throw new ModuleBuildError(
      "module.loadFailed",
      `Built module may only require Node builtins, found '${String(specifier)}'.`,
    );
  }
  return require(specifier);
}

/**
 * 用 esbuild metafile 校验所有外部依赖都是 Node 内置模块。
 *
 * 相比扫描产物文本，metafile 不会把 Webview 字符串或注释里的 `require(` 当成真实调用；
 * 动态 `require(variable)` 由运行时白名单 `require` 兜底。
 */
function assertOnlyBuiltinImports(metafile: Metafile | undefined): void {
  if (metafile === undefined) {
    throw new ModuleBuildError("module.loadFailed", "esbuild did not produce a metafile.");
  }
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    for (const importEntry of output.imports) {
      if (importEntry.external !== true) continue;
      if (!isBuiltin(importEntry.path)) {
        throw new ModuleBuildError(
          "module.loadFailed",
          `Built output '${outputPath}' depends on non-builtin module '${importEntry.path}' (${importEntry.kind}); bundle all dependencies instead.`,
        );
      }
    }
  }
}

function readManifest(value: unknown): ModuleManifest | undefined {
  if (!isRecord(value)) return undefined;
  const id = readIdentifier(value.id);
  const version = typeof value.version === "string" && value.version.length > 0 ? value.version : undefined;
  const apiVersion = typeof value.apiVersion === "number" && Number.isSafeInteger(value.apiVersion)
    ? value.apiVersion
    : undefined;
  const sdkVersion = value.sdkVersion === undefined
    ? undefined
    : typeof value.sdkVersion === "string" && value.sdkVersion.length > 0
      ? value.sdkVersion
      : null;
  const editors = readIdentifiers(value.editors);
  if (id === undefined || version === undefined || apiVersion === undefined || sdkVersion === null || editors === undefined) {
    return undefined;
  }
  return {
    id,
    version,
    apiVersion,
    ...(sdkVersion === undefined ? {} : { sdkVersion }),
    editors,
  };
}

function readWebviews(value: unknown): Readonly<Record<string, ModuleWebview>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, ModuleWebview> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isWebviewKey(key) || !isRecord(entry) || typeof entry.script !== "string" || typeof entry.style !== "string") {
      return undefined;
    }
    result[key] = { script: entry.script, style: entry.style };
  }
  return result;
}

function readWebviewEntries(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new ModuleBuildError("module.manifestInvalid", "Module build config 'webviews' must be an object.");
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isWebviewKey(key) || typeof entry !== "string" || entry.length === 0) {
      throw new ModuleBuildError(
        "module.invalidPath",
        `Module build config webviews['${key}'] must be a non-empty entry path.`,
      );
    }
    result[key] = entry;
  }
  return result;
}

function readIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ? value : undefined;
}

function readIdentifiers(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const identifier = readIdentifier(entry);
    if (identifier === undefined || seen.has(identifier)) return undefined;
    seen.add(identifier);
    result.push(identifier);
  }
  return result;
}

function isWebviewKey(value: string): boolean {
  return value.length > 0
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype";
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function describeError(errorValue: unknown): string {
  return errorValue instanceof Error ? `${errorValue.name}: ${errorValue.message}` : String(errorValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
