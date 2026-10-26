/**
 * 确定性 tgz 打包器。
 *
 * 不使用 `npm pack`：npm/tar/zlib 版本会改变压缩字节，导致 `check:sdk` 在合规
 * 工具链上误报。这里自带最小 ustar writer，并用 gzip 的非压缩（stored）块输出，
 * 字节只由仓库内容决定，不受 Node/npm/zlib 版本影响；代价是 tgz 不再缩小。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SDK_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLOCK_SIZE = 512;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const GZIP_OS_UNKNOWN = 0xff;

/**
 * 打包 SDK 目录；返回文件名、字节、sha256 与按序文件清单。
 * `packageRoot` 仅供测试注入，默认是 ModuleSdk 根。
 */
export async function packPackage(options = {}) {
  const packageRoot = path.resolve(options.packageRoot ?? SDK_ROOT);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const filename = packageFilename(manifest);
  const entries = await collectEntries(packageRoot, manifest);
  const tarBytes = createTarArchive(entries);
  const bytes = gzipStored(tarBytes);
  return {
    filename,
    bytes,
    hash: sha256(bytes),
    files: entries.map((entry) => entry.path),
  };
}

/** `sha256:<hex>`，与 Project File 的模块 hash 格式一致。 */
export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 与基线逐字节比较；测试和 CLI 共用。 */
export function compareBytes(actual, baseline) {
  return {
    matches: actual.equals(baseline),
    actualHash: sha256(actual),
    baselineHash: sha256(baseline),
    actualLength: actual.byteLength,
    baselineLength: baseline.byteLength,
  };
}

async function collectEntries(packageRoot, manifest) {
  const paths = new Set(["package.json"]);
  for (const fileEntry of manifest.files ?? []) {
    if (typeof fileEntry !== "string" || fileEntry.length === 0) {
      throw new Error("ModuleSdk/package.json 'files' entries must be non-empty strings.");
    }
    const relativePath = normalizePackagePath(fileEntry);
    if (/[*?[\]{}]/u.test(relativePath)) {
      throw new Error(`Deterministic packer only supports literal files/directories, found '${fileEntry}'.`);
    }
    const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
    const info = await lstat(absolutePath).catch((errorValue) => {
      throw new Error(
        `Package file '${fileEntry}' is missing; run npm run build --workspace @visualbridge/module-sdk first. `
        + `(${errorValue instanceof Error ? errorValue.message : String(errorValue)})`,
      );
    });
    if (info.isSymbolicLink()) {
      throw new Error(`Package file '${fileEntry}' must not be a symlink.`);
    }
    if (info.isDirectory()) {
      await collectDirectory(absolutePath, relativePath, paths);
    } else if (info.isFile()) {
      paths.add(relativePath);
    } else {
      throw new Error(`Package file '${fileEntry}' must be a regular file or directory.`);
    }
  }

  const binTargets = new Set(
    Object.values(manifest.bin ?? {})
      .filter((value) => typeof value === "string")
      .map((value) => normalizePackagePath(value)),
  );

  const entries = [];
  for (const relativePath of [...paths].sort(compareCodeUnits)) {
    const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Package entry '${relativePath}' must be a regular file.`);
    }
    entries.push({
      path: relativePath,
      archivePath: `package/${relativePath}`,
      data: await readFile(absolutePath),
      mode: binTargets.has(relativePath) ? EXECUTABLE_MODE : FILE_MODE,
    });
  }
  return entries;
}

async function collectDirectory(absoluteDirectory, relativeDirectory, paths) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".DS_Store") continue;
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Package entry '${relativePath}' must not be a symlink.`);
    }
    if (entry.isDirectory()) {
      await collectDirectory(absolutePath, relativePath, paths);
    } else if (entry.isFile()) {
      paths.add(relativePath);
    }
  }
}

function createTarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const { name, prefix } = splitUstarName(entry.archivePath);
    const header = Buffer.alloc(BLOCK_SIZE, 0);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, entry.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, "0");
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    writeString(header, 265, 32, "root");
    writeString(header, 297, 32, "root");
    writeOctal(header, 329, 8, 0);
    writeOctal(header, 337, 8, 0);
    writeString(header, 345, 155, prefix);

    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, entry.data);

    const padding = (BLOCK_SIZE - (entry.data.byteLength % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(blocks);
}

function gzipStored(tarBytes) {
  const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, GZIP_OS_UNKNOWN])];
  if (tarBytes.byteLength === 0) {
    chunks.push(storedDeflateBlock(Buffer.alloc(0), true));
  } else {
    for (let offset = 0; offset < tarBytes.byteLength; offset += 0xffff) {
      const chunk = tarBytes.subarray(offset, Math.min(offset + 0xffff, tarBytes.byteLength));
      chunks.push(storedDeflateBlock(chunk, offset + chunk.byteLength >= tarBytes.byteLength));
    }
  }
  const trailer = Buffer.alloc(8, 0);
  trailer.writeUInt32LE(crc32(tarBytes), 0);
  trailer.writeUInt32LE(tarBytes.byteLength >>> 0, 4);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

function storedDeflateBlock(data, final) {
  const header = Buffer.alloc(5, 0);
  header[0] = final ? 0x01 : 0x00;
  header.writeUInt16LE(data.byteLength, 1);
  header.writeUInt16LE((~data.byteLength) & 0xffff, 3);
  return Buffer.concat([header, data]);
}

let crcTable;

function crc32(bytes) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function splitUstarName(fullName) {
  if (Buffer.byteLength(fullName) <= 100) return { name: fullName, prefix: "" };
  let slashIndex = fullName.lastIndexOf("/");
  while (slashIndex > 0) {
    const prefix = fullName.slice(0, slashIndex);
    const name = fullName.slice(slashIndex + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
    slashIndex = fullName.lastIndexOf("/", slashIndex - 1);
  }
  throw new Error(`Package path '${fullName}' cannot be represented in a ustar header.`);
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) {
    throw new Error(`Tar header field '${value}' exceeds ${length} bytes.`);
  }
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8);
  if (text.length > length - 1) {
    throw new Error(`Tar numeric field ${value} does not fit in ${length} bytes.`);
  }
  buffer.write(text.padStart(length - 1, "0"), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function packageFilename(manifest) {
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("ModuleSdk/package.json must declare name and version.");
  }
  return `${manifest.name.replace(/^@/u, "").replace(/\//gu, "-")}-${manifest.version}.tgz`;
}

function normalizePackagePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
