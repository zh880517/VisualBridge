/**
 * Webview 资源解包与旧 hash 目录清理（附录 D.6）。
 *
 * bundle 的 `webviews[key]` 是**文本**（`buildModule()` 把 IIFE 脚本与样式塞进 `.vbmodule.js`），
 * 宿主必须把它们落到磁盘才能用 `webview.asWebviewUri()`：`<globalStorage>/modules/<sha256>/<key>.js|.css`。
 * 目录名用 bundle 实际字节的 SHA-256（`LoadedModule.hash` 的十六进制部分），因此同一份 bundle
 * 被多个 Project 引用时共用同一目录。
 *
 * **清理集的判据**：磁盘上存在 − 当前**所有**已装载 Project 的模块引用集。
 * 绝不能写成"除当前 Project 之外全删"——hash 是内容 hash，两个 Project 完全可能引用同一个目录，
 * 按 Project 差集会把它删掉，正在打开的那个窗口随即白屏。`staleModuleHashDirectories` 只接受
 * 引用集、不接受"当前 Project"，结构上就不给误用留口子。
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

/** 一个 webview key 的脚本文本与样式文本（bundle 里就是字符串）。 */
export interface ModuleWebviewContent {
  readonly script: string;
  readonly style: string;
}

/** 解包输入：与 `LoadedModule` 的最小交集（`hash` 是 `sha256:<hex>`）。 */
export interface ModuleWebviewAssetSource {
  readonly moduleId: string;
  readonly hash: string;
  readonly webviews: Readonly<Record<string, ModuleWebviewContent>>;
}

/** 解包后每个 webview key 的**绝对路径**。 */
export interface UnpackedModuleWebview {
  readonly moduleId: string;
  /** 目录名（`LoadedModule.hash` 的十六进制部分）。 */
  readonly hash: string;
  readonly directory: string;
  readonly webviews: Readonly<Record<string, { readonly script: string; readonly style: string }>>;
}

const HASH_HEX = /^[0-9a-f]{64}$/u;
const BUNDLE_HASH = /^sha256:([0-9a-f]{64})$/u;

/** `sha256:<hex>` → `<hex>`；形状不对直接抛错（目录名不可信会写进用户数据目录）。 */
export function moduleHashHex(hash: string): string {
  const matched = BUNDLE_HASH.exec(hash);
  if (matched === null) {
    throw new Error(`Bundle hash '${hash}' is not 'sha256:<64 lowercase hex>'.`);
  }
  return matched[1]!;
}

/** 引用集既可能来自 `LoadedModule.hash`，也可能已经是目录名；两种形态都收。 */
function normalizeHashHex(value: string): string {
  return HASH_HEX.test(value) ? value : moduleHashHex(value);
}

/** 把一批 bundle 的 webview 文本写到 `modulesRoot/<hash>/`，内容相同则不重写。 */
export async function unpackModuleWebviews(
  modulesRoot: string,
  sources: readonly ModuleWebviewAssetSource[],
): Promise<readonly UnpackedModuleWebview[]> {
  const unpacked: UnpackedModuleWebview[] = [];
  for (const source of sources) {
    const hash = moduleHashHex(source.hash);
    const directory = path.join(modulesRoot, hash);
    await mkdir(directory, { recursive: true });
    const webviews: Record<string, { readonly script: string; readonly style: string }> = {};
    for (const [key, content] of Object.entries(source.webviews)) {
      const script = path.join(directory, `${key}.js`);
      const style = path.join(directory, `${key}.css`);
      await writeIfChanged(script, content.script);
      await writeIfChanged(style, content.style);
      webviews[key] = { script, style };
    }
    unpacked.push({ moduleId: source.moduleId, hash, directory, webviews });
  }
  return unpacked;
}

/**
 * 列出**无人引用**的 hash 目录（绝对路径，已排序）。
 *
 * `referencedHashes` 必须是"当前所有已装载 Project 的模块引用集"的并集；只传当前 Project
 * 会删掉别的 Project 正在用的目录（P0）。非 64 位十六进制的条目一律不动，避免误删用户目录里
 * 的其它内容。
 */
export async function staleModuleHashDirectories(
  modulesRoot: string,
  referencedHashes: Iterable<string>,
): Promise<readonly string[]> {
  const referenced = new Set([...referencedHashes].map(normalizeHashHex));
  const stale: string[] = [];
  for (const entry of await readDirectoryIfPresent(modulesRoot)) {
    if (!entry.isDirectory() || !HASH_HEX.test(entry.name)) continue;
    if (!referenced.has(entry.name)) stale.push(path.join(modulesRoot, entry.name));
  }
  return stale.sort();
}

/**
 * 删除无人引用的 hash 目录，返回真正删掉的路径。
 *
 * `globalStorageUri/modules` 是**跨窗口共享**的：另一个窗口（另一个扩展宿主进程）可能正引用着
 * 本窗口看不到的 hash。所以清理前先登记本窗口的引用（`.refs/<pid>.json`），并把其它窗口的
 * 未过期引用一并算进引用集——否则一个窗口会把另一个窗口正在用的目录删掉。
 */
export async function cleanModuleWebviewDirectories(
  modulesRoot: string,
  referencedHashes: Iterable<string>,
): Promise<readonly string[]> {
  const own = [...referencedHashes].map(normalizeHashHex);
  await writeWindowReference(modulesRoot, own);
  const referenced = new Set([...own, ...(await liveWindowReferences(modulesRoot))]);
  const stale = await staleModuleHashDirectories(modulesRoot, referenced);
  for (const directory of stale) {
    await rm(directory, { recursive: true, force: true });
  }
  return stale;
}

/** 引用文件目录：`.refs/<pid>.json`，与 hash 目录同级，不会被当成 hash 目录清理。 */
const WINDOW_REFERENCE_DIRECTORY = ".refs";
/** 超过这个时间的引用文件视为僵尸窗口（进程被杀/崩溃时不会清理自己）。 */
const WINDOW_REFERENCE_TTL_MS = 10 * 60 * 1000;

interface WindowReferenceRecord {
  readonly pid: number;
  readonly updatedAt: number;
  readonly hashes: readonly string[];
}

function windowReferencePath(modulesRoot: string): string {
  return path.join(modulesRoot, WINDOW_REFERENCE_DIRECTORY, `${process.pid}.json`);
}

async function writeWindowReference(modulesRoot: string, hashes: readonly string[]): Promise<void> {
  const directory = path.join(modulesRoot, WINDOW_REFERENCE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const record: WindowReferenceRecord = { pid: process.pid, updatedAt: Date.now(), hashes: [...hashes].sort() };
  await writeFile(windowReferencePath(modulesRoot), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
}

/** 读取其它窗口（含本窗口，幂等）未过期的引用；顺手删掉过期引用文件。 */
async function liveWindowReferences(modulesRoot: string): Promise<readonly string[]> {
  const directory = path.join(modulesRoot, WINDOW_REFERENCE_DIRECTORY);
  const hashes: string[] = [];
  const now = Date.now();
  for (const entry of await readDirectoryIfPresent(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    let record: WindowReferenceRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as WindowReferenceRecord;
    } catch {
      // 半写入/被外部改坏：当作没有引用，交给 TTL 之外的逻辑处理。
      continue;
    }
    if (typeof record.updatedAt !== "number" || now - record.updatedAt > WINDOW_REFERENCE_TTL_MS) {
      await rm(file, { force: true });
      continue;
    }
    for (const hash of record.hashes ?? []) {
      try {
        hashes.push(normalizeHashHex(hash));
      } catch {
        // 形状不对的 hash 不参与引用集（不可信输入不写进目录名）。
      }
    }
  }
  return hashes;
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  try {
    const current = await readFile(file);
    if (current.equals(bytes)) return;
  } catch {
    // 不存在就走写入路径。
  }
  await writeFile(file, bytes);
}

async function readDirectoryIfPresent(directory: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (errorValue) {
    if ((errorValue as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw errorValue;
  }
}
