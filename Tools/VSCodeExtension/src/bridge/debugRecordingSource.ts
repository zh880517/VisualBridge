/**
 * 录制文件读取与回看（附录 C.6/C.8）。
 *
 * 读取顺序：文件头块 → 数据块* → 文件尾块?。块级 CRC 失败**只跳过该块**继续读下一个块
 * （块头里的 `length` 是压缩字节数，可据此定位下一块）；帧层失败交给 {@link DebugIngress}
 * 计数并在下一个块边界恢复（{@link DebugIngress.resumeRecordedStream}），两者互不牵连。
 *
 * 回看不依赖当前工作区契约（C.8）：文件头里的 `contracts` 快照直接重建
 * {@link DebugContractSnapshot}；合成的 `welcome` 固定
 * `payloads=["json","binary"]`、`resumed=false`、`debugEnabled=true`，`endpointId` 取自文件头，
 * 因此回看不会插入第二条 `welcome`，也不会改变面板开关。
 *
 * 录制流里的握手/控制帧（`hello`/`welcome`/`error`/`ping`/`pong`/`debugEnabled`/`debugSetEnabled`/
 * 通道 0 的 `response`）在 `DebugIngress` 的通道分流处被丢弃（计入 `controlFrames`）——
 * 本模块不另写一套"哪些消息该忽略"的判定，保证"文件里没有 + 万一有也不生效"。
 */

import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { BridgeWelcomeMessage } from "./bridgeProtocol";
import {
  DebugIngress,
  type DebugIngressCounters,
  type DebugIngressOptions,
} from "./debugIngress";
import { DebugInstanceManager, type DebugInstanceManagerOptions } from "./debugInstanceManager";
import {
  DEBUG_RECORDING_MAX_COMPRESSED_BYTES,
  DEBUG_RECORDING_MAX_DECOMPRESSED_BYTES,
  DEBUG_RECORD_BLOCK_DATA,
  DEBUG_RECORD_BLOCK_FOOTER,
  DEBUG_RECORD_BLOCK_HEADER,
  DEBUG_RECORD_BLOCK_HEADER_BYTES,
  DEBUG_REPLAY_DECODED_BYTES_PER_RECORD,
  DEBUG_REPLAY_MAX_FILE_BYTES,
  DEBUG_REPLAY_MAX_RECORDS,
  DEBUG_REPLAY_MAX_WIRE_BYTES,
  DebugRecordingError,
  crc32,
  parseRecordingFooter,
  parseRecordingHeader,
  type DebugRecordingFooter,
  type DebugRecordingHeader,
} from "./debugRecordingFormat";
import type { DebugContractSnapshot } from "./debugContractRegistry";
import { snapshotFromRecordedContracts } from "./debugRecordingContracts";

/** 读取计数（块层；帧层计数来自 {@link DebugIngress.counters}）。 */
export interface DebugRecordingReadCounters {
  /** 读到的块总数（含头/尾/未知类型）。 */
  readonly blocks: number;
  readonly dataBlocks: number;
  /** 块 CRC / zlib / 长度非法而跳过的块数（**不**影响后续块）。 */
  readonly corruptedBlocks: number;
  /** 文件在块中途截断（崩溃未写文件尾）；已读出的块仍然有效。 */
  readonly truncated: boolean;
  /** 录到文件尾块：`false` = 未正常收尾（崩溃/截断）。 */
  readonly footerFound: boolean;
}

/**
 * 顺序块读取器：一次只持有一个块的压缩字节，不在内存里展开整个文件。
 * 读取路径只有一条：从文件头之后**顺序扫块头**，每块的 `length` 用来定位下一个块，
 * 命中数据块时对该块做一次解压（同时校验块 CRC）。
 * **没有**随机跳块/跳帧 API——要定位第 N 条记录，只能顺序扫过前置块头并解压目标块。
 * 复杂度：读取 O(文件大小)。
 */
export class DebugRecordingReader {
  private readonly handle: FileHandle;
  private readonly fileSize: number;
  private readonly headerValue: DebugRecordingHeader;
  private offset: number;
  private footerValue: DebugRecordingFooter | undefined;
  private blocksValue = 1;
  private dataBlocksValue = 0;
  private corruptedBlocksValue = 0;
  private truncatedValue = false;
  private footerFoundValue = false;
  /** `readFooter()` 已经扫过一遍（找到或确认没有），避免重复扫盘。 */
  private footerScanned = false;

  private constructor(handle: FileHandle, fileSize: number, header: DebugRecordingHeader, offset: number) {
    this.handle = handle;
    this.fileSize = fileSize;
    this.headerValue = header;
    this.offset = offset;
  }

  public static async open(filePath: string): Promise<DebugRecordingReader> {
    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, "r");
    } catch (errorValue) {
      throw new DebugRecordingError("recording.truncated", `Unable to open '${filePath}': ${String(errorValue)}`);
    }

    try {
      const stat = await handle.stat();
      const head = await readFully(handle, 0, DEBUG_RECORD_BLOCK_HEADER_BYTES);
      if (head === undefined) {
        throw new DebugRecordingError("recording.truncated", "Recording file is shorter than one block header.");
      }

      const type = head.readUInt8(0);
      if (type !== DEBUG_RECORD_BLOCK_HEADER) {
        throw new DebugRecordingError("recording.invalidHeader", `First block is type ${type}; expected the file header (0).`);
      }

      const length = head.readUInt32BE(1);
      if (length === 0 || length > DEBUG_RECORDING_MAX_COMPRESSED_BYTES) {
        throw new DebugRecordingError("recording.invalidHeader", `File header block has an invalid length ${length}.`);
      }

      const compressed = await readFully(handle, DEBUG_RECORD_BLOCK_HEADER_BYTES, length);
      if (compressed === undefined) {
        throw new DebugRecordingError("recording.truncated", "Recording file ends inside the file header block.");
      }

      const payload = inflateBlock(compressed, head.readUInt32BE(5));
      const header = parseRecordingHeader(payload);
      return new DebugRecordingReader(handle, stat.size, header, DEBUG_RECORD_BLOCK_HEADER_BYTES + length);
    } catch (errorValue) {
      await handle.close().catch(() => undefined);
      throw errorValue;
    }
  }

  public get header(): DebugRecordingHeader {
    return this.headerValue;
  }

  public get footer(): DebugRecordingFooter | undefined {
    return this.footerValue;
  }

  /** 文件字节数（预检的磁盘上限判定）。 */
  public get fileBytes(): number {
    return this.fileSize;
  }

  /**
   * **只读文件尾**（不解压数据块）：打开前的廉价预检用。
   *
   * 顺序扫块头、按 `length` 跳过数据块载荷；只有文件尾块做一次解压 + CRC。找到尾部后
   * `footerFound=true`，确认没有（截断/损坏）则返回 `undefined`。幂等：重复调用不再扫盘——
   * 但注意它会把 `offset` 推到文件尾，之后不能再拿同一个 reader 做 `dataBlocks()`。
   */
  public async readFooter(): Promise<DebugRecordingFooter | undefined> {
    if (this.footerValue !== undefined) {
      return this.footerValue;
    }

    if (this.footerScanned) {
      return undefined;
    }

    this.footerScanned = true;
    while (this.offset < this.fileSize) {
      const header = await readFully(this.handle, this.offset, DEBUG_RECORD_BLOCK_HEADER_BYTES);
      if (header === undefined) {
        this.truncatedValue = true;
        return undefined;
      }

      const type = header.readUInt8(0);
      const length = header.readUInt32BE(1);
      const expectedCrc = header.readUInt32BE(5);
      if (length === 0 || length > DEBUG_RECORDING_MAX_COMPRESSED_BYTES) {
        this.corruptedBlocksValue += 1;
        this.truncatedValue = true;
        return undefined;
      }

      const payloadOffset = this.offset + DEBUG_RECORD_BLOCK_HEADER_BYTES;
      this.offset = payloadOffset + length;
      if (this.offset > this.fileSize) {
        this.truncatedValue = true;
        return undefined;
      }

      if (type !== DEBUG_RECORD_BLOCK_FOOTER) {
        // 数据块/未知块：长度可信就跳过，不解压（预检不花解码成本）。
        this.blocksValue += 1;
        continue;
      }

      const compressed = await readFully(this.handle, payloadOffset, length);
      if (compressed === undefined) {
        this.truncatedValue = true;
        return undefined;
      }

      this.blocksValue += 1;
      try {
        this.footerValue = parseRecordingFooter(inflateBlock(compressed, expectedCrc));
        this.footerFoundValue = true;
      } catch {
        this.corruptedBlocksValue += 1;
      }

      return this.footerValue;
    }

    return undefined;
  }

  public get counters(): DebugRecordingReadCounters {
    return {
      blocks: this.blocksValue,
      dataBlocks: this.dataBlocksValue,
      corruptedBlocks: this.corruptedBlocksValue,
      truncated: this.truncatedValue,
      footerFound: this.footerFoundValue,
    };
  }

  /**
   * 顺序产出数据块（已解压）。块级损坏只计数并跳过；读到文件尾块或文件结束时停止。
   * 调用方每拿到一个块就交给 `DebugIngress.acceptRecordedBytes`，从而保持"块边界可恢复"。
   */
  public async *dataBlocks(): AsyncGenerator<Buffer, void, void> {
    while (this.offset < this.fileSize) {
      const header = await readFully(this.handle, this.offset, DEBUG_RECORD_BLOCK_HEADER_BYTES);
      if (header === undefined) {
        this.truncatedValue = true;
        return;
      }

      const type = header.readUInt8(0);
      const length = header.readUInt32BE(1);
      const expectedCrc = header.readUInt32BE(5);
      if (length === 0 || length > DEBUG_RECORDING_MAX_COMPRESSED_BYTES) {
        // 长度字段不可信 ⇒ 无法定位下一个块；这是文件级损坏，不是"块坏可跳过"。
        this.corruptedBlocksValue += 1;
        this.truncatedValue = true;
        return;
      }

      const compressed = await readFully(this.handle, this.offset + DEBUG_RECORD_BLOCK_HEADER_BYTES, length);
      this.offset += DEBUG_RECORD_BLOCK_HEADER_BYTES + length;
      this.blocksValue += 1;
      if (compressed === undefined) {
        this.truncatedValue = true;
        return;
      }

      if (type === DEBUG_RECORD_BLOCK_FOOTER) {
        try {
          this.footerValue = parseRecordingFooter(inflateBlock(compressed, expectedCrc));
          this.footerFoundValue = true;
        } catch {
          this.corruptedBlocksValue += 1;
        }

        return;
      }

      if (type === DEBUG_RECORD_BLOCK_DATA) {
        let payload: Buffer;
        try {
          payload = inflateBlock(compressed, expectedCrc);
        } catch {
          this.corruptedBlocksValue += 1;
          continue;
        }

        this.dataBlocksValue += 1;
        yield payload;
        continue;
      }

      // 未知块类型：长度可信，跳过并计数（未来扩展的块不应让整个文件打不开）。
      this.corruptedBlocksValue += 1;
    }
  }

  public async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

async function readFully(handle: FileHandle, position: number, length: number): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) {
      return undefined;
    }

    read += result.bytesRead;
  }

  return buffer;
}

/** 解压并校验块 CRC；zlib 失败或 CRC 不符都抛（调用方决定"跳过块"还是"拒绝文件"）。 */
function inflateBlock(compressed: Buffer, expectedCrc: number): Buffer {
  let payload: Buffer;
  try {
    payload = inflateSync(compressed, { maxOutputLength: DEBUG_RECORDING_MAX_DECOMPRESSED_BYTES });
  } catch (errorValue) {
    throw new DebugRecordingError("recording.corruptBlock", `zlib inflate failed: ${String(errorValue)}`);
  }

  if (payload.length > DEBUG_RECORDING_MAX_DECOMPRESSED_BYTES) {
    throw new DebugRecordingError("recording.corruptBlock", `Block decompresses to ${payload.length} bytes.`);
  }

  if (crc32(payload) !== expectedCrc) {
    throw new DebugRecordingError("recording.corruptBlock", "Block CRC mismatch.");
  }

  return payload;
}

/** 回看结果：管理器、接收门与计数都在这里，UI 只读。 */
export interface DebugReplayResult {
  readonly header: DebugRecordingHeader;
  readonly footer: DebugRecordingFooter | undefined;
  readonly welcome: BridgeWelcomeMessage;
  readonly contracts: DebugContractSnapshot | undefined;
  readonly manager: DebugInstanceManager;
  readonly ingress: DebugIngress;
  readonly read: DebugRecordingReadCounters;
  readonly ingressCounters: DebugIngressCounters;
}

export interface FileDebugSourceOptions {
  readonly now?: () => number;
}

/**
 * 录制文件数据源：读文件、合成 `welcome`、把数据块逐块喂给 `DebugIngress`。
 * 与网络源产出**完全同构**的 `DebugRecord`（同一 `DebugIngress` + 同一 `DebugInstanceManager`）。
 */
export class FileDebugSource {
  private readonly reader: DebugRecordingReader;
  private readonly options: FileDebugSourceOptions;
  private readonly contractsValue: DebugContractSnapshot | undefined;
  private readonly welcomeValue: BridgeWelcomeMessage;

  private constructor(reader: DebugRecordingReader, options: FileDebugSourceOptions) {
    this.reader = reader;
    this.options = options;
    const header = reader.header;
    this.contractsValue = header.contracts === undefined || header.contracts === null
      ? undefined
      : snapshotFromRecordedContracts(header.contracts);
    this.welcomeValue = {
      type: "welcome",
      protocolVersion: header.protocolVersion,
      endpointId: header.endpointId,
      sessionId: header.sessionId,
      // 回看不是续接：固定 false（C.6）。
      resumed: false,
      connectType: header.connectType,
      // generation 只用于日志与陈旧判定（A.3），回看没有传输换代，固定 0。
      generation: 0,
      bootId: header.bootId,
      contractHash: header.contractHash,
      // 文件里同时可能有 JSON 与二进制帧：回看两端能力都满配（C.6 固定值）。
      payloads: ["json", "binary"],
      debugEnabled: true,
      startedAt: header.startedAt,
    };
  }

  /** 打开并校验文件头；`recordVersion` 不符直接拒绝（不做迁移）。 */
  public static async open(filePath: string, options: FileDebugSourceOptions = {}): Promise<FileDebugSource> {
    const reader = await DebugRecordingReader.open(filePath);
    return new FileDebugSource(reader, options);
  }

  public get header(): DebugRecordingHeader {
    return this.reader.header;
  }

  public get footer(): DebugRecordingFooter | undefined {
    return this.reader.footer;
  }

  /** 合成的握手：唯一的一条 `welcome`，不会随录制流重复。 */
  public get welcome(): BridgeWelcomeMessage {
    return this.welcomeValue;
  }

  /** 文件内契约快照（C.8：回看不读工作区契约）。 */
  public get contracts(): DebugContractSnapshot | undefined {
    return this.contractsValue;
  }

  /**
   * 顺序重放：逐块解码，包络按到达顺序交给 `DebugInstanceManager`。
   * 块之间的帧失败只在块内截断（`DebugIngress` 的停止标志），下一块继续。
   */
  public async replay(options: {
    readonly manager?: DebugInstanceManager;
    readonly managerOptions?: DebugInstanceManagerOptions;
    readonly ingressOptions?: Omit<DebugIngressOptions, "contracts">;
  } = {}): Promise<DebugReplayResult> {
    const now = options.managerOptions?.now ?? this.options.now;
    const manager = options.manager ?? new DebugInstanceManager({
      ...(now === undefined ? {} : { now }),
      ...(options.managerOptions ?? {}),
    });
    const ingress = new DebugIngress({
      ...(options.ingressOptions ?? {}),
      ...(this.contractsValue === undefined ? {} : { contracts: this.contractsValue }),
    });

    for await (const block of this.reader.dataBlocks()) {
      for (const envelope of ingress.acceptRecordedBytes(block)) {
        manager.ingest(envelope, this.contractsValue);
      }

      if (ingress.recordedStopped) {
        // 帧头 CRC 失败 ⇒ 长度不可信，停在当前块；下一块是新的块边界，可以恢复。
        ingress.resumeRecordedStream();
      }
    }

    ingress.finishRecordedStream();
    return {
      header: this.reader.header,
      footer: this.reader.footer,
      welcome: this.welcomeValue,
      contracts: this.contractsValue,
      manager,
      ingress,
      read: this.reader.counters,
      ingressCounters: ingress.counters,
    };
  }

  public async close(): Promise<void> {
    await this.reader.close();
  }
}

/** 打开前预检的结果：供 UI 显示"正在解码 N 条"与拒绝信息，不含任何解码后的记录。 */
export interface DebugReplayPreflight {
  readonly fileBytes: number;
  /** 是否找到了文件尾（`false` = 崩溃/截断，记录数未知）。 */
  readonly footerFound: boolean;
  /** 文件尾声明的记录条数；没有文件尾时为 `undefined`。 */
  readonly records: number | undefined;
  /** 文件尾声明的原始线上字节和；没有文件尾时为 `undefined`。 */
  readonly wireBytes: number | undefined;
  /** 按评审实测的 1107 B/记录估算的解码内存（没有文件尾时为 0，表示未知）。 */
  readonly estimatedDecodedBytes: number;
}

/** 预检上限（测试可注入小值验证拒绝路径；生产不传）。 */
export interface DebugReplayPreflightLimits {
  readonly maxRecords?: number;
  readonly maxWireBytes?: number;
  readonly maxFileBytes?: number;
}

/**
 * 打开前的**廉价**预检（P1-A）：只看文件头、文件尾与文件字节数，**不解码任何数据块**。
 *
 * 两条独立的拒绝线：
 * 1. 有文件尾 ⇒ `footer.records` 与 `footer.wireBytes` 都必须在上限内。
 *    原始线上字节才是解码内存的真源（小帧 3.5×、大载荷≈1×）；压缩后大小与记录条数都可能漏。
 * 2. 没有文件尾（崩溃/截断）⇒ 以文件字节数兜底（两个计数都不可知）。
 *
 * 选择**拒绝**而不是"回看时静默截断/淘汰"：partial 会让"文件说 N 条、视图显示 M 条"变成两个
 * 真源，而验收项要求"回看完整"。这里在打开前就把话说清楚，面板不进入回看态。
 */
export async function preflightRecordingFile(
  filePath: string,
  limits: DebugReplayPreflightLimits = {},
): Promise<DebugReplayPreflight> {
  const maxRecords = limits.maxRecords ?? DEBUG_REPLAY_MAX_RECORDS;
  const maxWireBytes = limits.maxWireBytes ?? DEBUG_REPLAY_MAX_WIRE_BYTES;
  const maxFileBytes = limits.maxFileBytes ?? DEBUG_REPLAY_MAX_FILE_BYTES;
  const reader = await DebugRecordingReader.open(filePath);
  try {
    const footer = await reader.readFooter();
    const fileBytes = reader.fileBytes;
    if (footer === undefined) {
      if (fileBytes > maxFileBytes) {
        throw new DebugRecordingError(
          "recording.tooLarge",
          `该录制文件 ${formatMegabytes(fileBytes)} MB，超过回看上限（${formatMegabytes(maxFileBytes)} MB），`
            + "且没有可用的文件尾（截断文件无法判定记录条数）。请录制更短的会话，或改用分段录制。",
        );
      }

      return { fileBytes, footerFound: false, records: undefined, wireBytes: undefined, estimatedDecodedBytes: 0 };
    }

    if (footer.records > maxRecords) {
      // footer.records 是帧数，解码后的记录数 ≤ 帧数；用它做上界已经足够保守。
      throw new DebugRecordingError(
        "recording.tooLarge",
        `该录制包含 ${footer.records} 条记录（约 ${formatMegabytes(footer.records * DEBUG_REPLAY_DECODED_BYTES_PER_RECORD)} MB 解码内存），`
          + `超过回看上限（${maxRecords} 条 / ${formatMegabytes(maxRecords * DEBUG_REPLAY_DECODED_BYTES_PER_RECORD)} MB）。`
          + "请录制更短的会话，或改用分段录制。",
      );
    }

    if (footer.wireBytes > maxWireBytes) {
      // 记录数没超限也可能因为“1 MB 重复载荷”装进天量解压字节；原始线上字节才是内存预算。
      throw new DebugRecordingError(
        "recording.tooLarge",
        `该录制包含 ${footer.records} 条记录、原始帧字节 ${formatMegabytes(footer.wireBytes)} MB，`
          + `超过回看上限（${maxRecords} 条 / ${formatMegabytes(maxWireBytes)} MB 原始字节）。`
          + "请录制更短的会话，或改用分段录制。",
      );
    }

    return {
      fileBytes,
      footerFound: true,
      records: footer.records,
      wireBytes: footer.wireBytes,
      estimatedDecodedBytes: footer.records * DEBUG_REPLAY_DECODED_BYTES_PER_RECORD,
    };
  } finally {
    await reader.close();
  }
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** 文件尾的 `endedReason` 是否表示"到上限停止"（UI 据此标注，而不是当成打不开）。 */
export function isSizeLimitRecording(footer: DebugRecordingFooter | undefined): boolean {
  return footer?.endedReason === "sizeLimit";
}
