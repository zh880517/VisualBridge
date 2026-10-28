/**
 * 会话录制写入端（附录 C.6）：独立异步队列 + 丢块计数 + 大小上限。
 *
 * 接收路径只做三件同步的事：判定是否录制、把帧追加进当前块、块满时入队。
 * 压缩与写盘在**异步队列**里进行；队列满时丢弃**新块**并计数，`recordFrame` 永远不等待、
 * 不抛异常（录制是旁路，不能把连接的读循环拖慢或打挂）。
 *
 * 契约快照在 {@link DebugSessionRecorder.start} 时就序列化进文件头（P0：不是结束时），
 * 之后注册表怎么热更新都影响不到已写出的文件头。
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import {
  DEBUG_RECORD_VERSION,
  DEBUG_RECORDING_BLOCK_TARGET_BYTES,
  DEBUG_RECORDING_DEFAULT_MAX_FILE_BYTES,
  DEBUG_RECORDING_DEFAULT_MAX_RECORDS,
  DEBUG_RECORDING_DEFAULT_MAX_WIRE_BYTES,
  DEBUG_RECORDING_DEFAULT_QUEUE_BLOCKS,
  DEBUG_RECORD_BLOCK_DATA,
  DEBUG_RECORD_BLOCK_FOOTER,
  DEBUG_RECORD_BLOCK_HEADER,
  encodeRawFrame,
  encodeRecordBlock,
  encodeRecordingFooter,
  encodeRecordingHeader,
  shouldRecordInboundFrame,
  type DebugRecordingConnectType,
  type DebugRecordingEndReason,
  type DebugRecordingFooter,
  type DebugRecordingHeader,
  type RecordedDebugContracts,
} from "./debugRecordingFormat";
import { FRAME_HEADER_BYTES, type BridgePayloadKind } from "./framing";

/** 文件头里由录制器自己补的字段之外的输入。 */
export interface DebugRecordingHeaderInput {
  readonly protocolVersion: number;
  readonly contractSchemaVersion: number;
  readonly contractHash: string;
  readonly sessionId: string;
  readonly endpointId: string;
  readonly bootId: string;
  readonly connectType: DebugRecordingConnectType;
  readonly contracts: RecordedDebugContracts | null;
}

/** 写盘抽象：默认是 `fs.promises.open` + 每块 `sync`；单测可注入慢速 sink 验证队列丢块。 */
export interface DebugRecorderSink {
  write(bytes: Buffer): Promise<void>;
  /** 每块写完 flush（C.6）。 */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type DebugRecorderOpenSink = (filePath: string) => Promise<DebugRecorderSink>;

export interface DebugSessionRecorderOptions {
  readonly filePath: string;
  readonly header: DebugRecordingHeaderInput;
  /**
   * 文件字节上限（含块头与压缩后数据；到达后写尾 `sizeLimit` 并停止）。
   * 注意它限的是**压缩后**字节，不能当成回看的内存上界。
   */
  readonly maxFileBytes?: number;
  /**
   * 记录条数上限（默认 {@link DEBUG_RECORDING_DEFAULT_MAX_RECORDS} = 回看预算）。
   * 到上限后与 `maxFileBytes` 走**同一条收尾路径**：写尾 `sizeLimit` 并停止。
   * 有它才能保证"能录出来的文件一定能打开"（P1-A 的闭环不变量）。
   */
  readonly maxRecords?: number;
  /**
   * 原始线上字节上限（默认 {@link DEBUG_RECORDING_DEFAULT_MAX_WIRE_BYTES} = 回看预算 64 MB）。
   * 到上限后与 `maxFileBytes` / `maxRecords` 走**同一条收尾路径**：写尾 `sizeLimit` 并停止。
   * 这是“解码内存”的正确计量单位：压缩后文件大小与记录条数都拦不住 1 MB 重复载荷。
   */
  readonly maxWireBytes?: number;
  /** 解压后一个块的刷新阈值（默认 64 KB）。 */
  readonly blockBytes?: number;
  /** 写队列容量（块数，默认 16）；满则丢新块并计数。 */
  readonly queueBlocks?: number;
  /** 注入时钟（epoch ms）；`startedAt` / `endedAt` 都用它，不散落 `Date.now()`。 */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** 测试注入：替换真实的文件打开/写入。 */
  readonly openSink?: DebugRecorderOpenSink;
  /**
   * 观测钩子：**块压缩开始前**回调一次（参数是块的未压缩字节数）。
   * 用于证明 `recordFrame` 的同步段里没有 `deflateSync`（F5-04），生产不设置。
   */
  readonly onEncode?: (uncompressedBytes: number) => void;
}

/** 录制器运行期统计（面板/诊断用；文件尾只保留 C.6 规定的四个计数字段）。 */
export interface DebugSessionRecorderStats {
  readonly active: boolean;
  readonly filePath: string;
  readonly startedAt: string | undefined;
  readonly records: number;
  readonly droppedRecords: number;
  /** 丢弃的**未压缩**帧字节数（6 字节帧头 + 载荷；与 `dropBlock` / `dropFrame` 两条路径同口径）。 */
  readonly droppedBytes: number;
  readonly droppedBlocks: number;
  readonly bytesWritten: number;
  readonly queuedBlocks: number;
  readonly endedReason: DebugRecordingEndReason | undefined;
  readonly endedAt: string | undefined;
  /** sink 已 `close`（文件尾已写完，或启动失败已回收）：UI 只能在这之后提示"可打开回看"。 */
  readonly finalized: boolean;
  /** 文件尾确实写成功（`finalized && deliverable` 才能当"已保存"宣传，见 P2-4）。 */
  readonly deliverable: boolean;
  /** 收尾失败原因（footer 写失败 / 写盘失败）；非空时 UI 必须走错误提示，不能提示"已保存"。 */
  readonly failure: string | undefined;
}

interface QueuedBlock {
  readonly bytes: Buffer;
  readonly records: number;
}

/**
 * 录制器。生命周期：`start()` → `recordFrame()`* → `stop()`。
 * 同一个实例只录一个文件；停止后 `recordFrame` 只是计数丢弃，不会复活。
 */
export class DebugSessionRecorder {
  private readonly options: DebugSessionRecorderOptions;
  private readonly maxFileBytes: number;
  private readonly maxRecords: number;
  private readonly maxWireBytes: number;
  private readonly blockBytes: number;
  private readonly queueBlocks: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private sink: DebugRecorderSink | undefined;
  private headerValue: DebugRecordingHeader | undefined;
  /** 文件头已写完前的"ready 门"：false 时帧只进 `current`，不 seal / 不 pump / 不 finalize。 */
  private started = false;
  /** 已开始收尾（footer 构建/写盘）：此后的迟到帧不再计数，避免写进已固定的 footer 账目。 */
  private closed = false;
  /** 文件尾 + sync + close 全部完成（F5-05 的 monitor 只有这时才能提示"可打开回看"）。 */
  private finalized = false;
  /** 收尾失败原因（footer 写失败/写盘失败）；非空时不能宣称"已保存"（P2-4）。 */
  private failureValue: string | undefined;
  /**
   * 已接受（成功编码并准备写入）的帧数：记录条数上限的唯一计数。
   * 与 `recordsValue`（已落盘）分开：达到上限的那一帧必须还能写进文件，
   * 才能让 `footer.records` 正好等于上限、且"文件里的记录数 == 视图里的记录数"。
   */
  private acceptedRecordsValue = 0;
  /** 记录条数已达上限：后续帧按丢弃计数，等队列排空后写尾 `sizeLimit`。 */
  private recordsLimitReached = false;
  /**
   * 已接受（成功编码并准备写入）的帧的原始线上字节和，也是 `footer.wireBytes`。
   * 用于**写入前**判定下一帧是否会超出线上字节预算：超出时该帧直接丢弃，
   * 保证 `footer.wireBytes ≤ maxWireBytes`，从而“录得出来的一定打得开”。
   * 队列满导致整块被丢时，块内帧不再写进文件，但仍计入这里——它是“录制期间接受的全部帧”，
   * 对文件实际内容始终是保守上界。
   */
  private acceptedWireBytesValue = 0;
  /** 线上字节已达上限：后续帧按丢弃计数，等队列排空后写尾 `sizeLimit`。 */
  private wireLimitReached = false;
  /**
   * `start()` 的单一 promise：`stop()` 先 `await` 它，保证 footer 永远排在 header 之后。
   * 启动失败时它也 reject（半开 sink 已在 `openAndWriteHeader` 里 close 掉）。
   */
  private startPromise: Promise<DebugRecordingHeader> | undefined;
  /** 当前还没满的块（原样线上帧的拼接片段）。 */
  private current: Buffer[] = [];
  private currentBytes = 0;
  private currentRecords = 0;
  private readonly queue: QueuedBlock[] = [];
  private pumping = false;
  private pumpScheduled = false;
  private stopReason: DebugRecordingEndReason | undefined;
  private footerValue: DebugRecordingFooter | undefined;
  private finishDeferred: { promise: Promise<DebugRecordingFooter>; resolve: (footer: DebugRecordingFooter) => void; reject: (error: unknown) => void } | undefined;
  private recordsValue = 0;
  private droppedRecordsValue = 0;
  private droppedBytesValue = 0;
  private droppedBlocksValue = 0;
  private bytesWrittenValue = 0;
  private startedAtValue: string | undefined;

  public constructor(options: DebugSessionRecorderOptions) {
    this.options = options;
    this.maxFileBytes = options.maxFileBytes ?? DEBUG_RECORDING_DEFAULT_MAX_FILE_BYTES;
    this.maxRecords = Math.max(1, options.maxRecords ?? DEBUG_RECORDING_DEFAULT_MAX_RECORDS);
    this.maxWireBytes = Math.max(1, options.maxWireBytes ?? DEBUG_RECORDING_DEFAULT_MAX_WIRE_BYTES);
    this.blockBytes = options.blockBytes ?? DEBUG_RECORDING_BLOCK_TARGET_BYTES;
    this.queueBlocks = Math.max(1, options.queueBlocks ?? DEBUG_RECORDING_DEFAULT_QUEUE_BLOCKS);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  public get filePath(): string {
    return this.options.filePath;
  }

  public get header(): DebugRecordingHeader | undefined {
    return this.headerValue;
  }

  public get footer(): DebugRecordingFooter | undefined {
    return this.footerValue;
  }

  public get active(): boolean {
    return this.headerValue !== undefined && !this.closed;
  }

  public get stats(): DebugSessionRecorderStats {
    return {
      active: this.active,
      filePath: this.options.filePath,
      startedAt: this.startedAtValue,
      records: this.recordsValue,
      droppedRecords: this.droppedRecordsValue,
      droppedBytes: this.droppedBytesValue,
      droppedBlocks: this.droppedBlocksValue,
      bytesWritten: this.bytesWrittenValue,
      queuedBlocks: this.queue.length,
      endedReason: this.footerValue?.endedReason,
      endedAt: this.footerValue?.endedAt,
      finalized: this.finalized,
      deliverable: this.footerValue !== undefined,
      failure: this.failureValue,
    };
  }

  /**
   * 打开文件并写文件头块；之后的帧都追加到数据块。
   * 并发调用返回同一个 promise；失败时关闭已打开的 sink 并清掉 header 状态（不留悬空 fd）。
   */
  public start(): Promise<DebugRecordingHeader> {
    if (this.headerValue !== undefined) {
      return Promise.resolve(this.headerValue);
    }

    this.startPromise ??= this.openAndWriteHeader();
    return this.startPromise;
  }

  private async openAndWriteHeader(): Promise<DebugRecordingHeader> {
    const startedAt = new Date(this.now()).toISOString();
    const header: DebugRecordingHeader = {
      recordVersion: DEBUG_RECORD_VERSION,
      protocolVersion: this.options.header.protocolVersion,
      contractSchemaVersion: this.options.header.contractSchemaVersion,
      contractHash: this.options.header.contractHash,
      sessionId: this.options.header.sessionId,
      endpointId: this.options.header.endpointId,
      bootId: this.options.header.bootId,
      connectType: this.options.header.connectType,
      startedAt,
      // 深拷贝：热更新替换的是注册表里的快照对象，绝不能把它的引用写进文件头（P0）。
      contracts: this.options.header.contracts === null ? null : JSON.parse(JSON.stringify(this.options.header.contracts)),
    };
    // ready 门先置：从这一刻到 header 写完之间到达的帧只进 `current`，不 seal / 不 pump。
    this.headerValue = header;
    this.startedAtValue = startedAt;

    let sink: DebugRecorderSink | undefined;
    try {
      sink = this.options.openSink === undefined
        ? await openFileSink(this.options.filePath)
        : await this.options.openSink(this.options.filePath);
      this.sink = sink;
      const block = encodeRecordBlock(DEBUG_RECORD_BLOCK_HEADER, encodeRecordingHeader(header));
      await sink.write(block);
      await sink.sync();
      this.bytesWrittenValue += block.length;
      this.started = true;
      // 启动窗口里攒下的帧现在可以按块边界封口了（此前只进 current）。
      if (this.currentBytes >= this.blockBytes || this.recordsLimitReached || this.wireLimitReached) {
        this.sealCurrentBlock();
      }

      if (this.recordsLimitReached || this.wireLimitReached) {
        // 启动窗口里就到了记录上限：队列可能已空，必须补一次调度才能写尾收尾。
        this.schedulePump();
      }

      this.log(`[debug] recording started: ${this.options.filePath} (max ${this.maxFileBytes} bytes, block ${this.blockBytes} bytes)`);
      return header;
    } catch (errorValue) {
      // 启动失败：close 半开 sink、清掉 header/ready 状态；stop() 会从同一个 startPromise 收到 reject。
      this.closed = true;
      this.started = false;
      this.sink = undefined;
      this.headerValue = undefined;
      this.startedAtValue = undefined;
      this.finalized = true;
      this.failureValue = `recording failed to start: ${String(errorValue)}`;
      await sink?.close().catch(() => undefined);
      this.log(`[debug] recording failed to start: ${String(errorValue)}`);
      throw errorValue;
    }
  }

  /**
   * 接收一帧（同步、不抛）。只有 {@link shouldRecordInboundFrame} 判为业务帧的才写入；
   * 握手/保活/控制帧连"丢弃计数"都不进——它们本来就不属于录制内容。
   */
  public recordFrame(channel: number, payloadKind: BridgePayloadKind, payload: Buffer): void {
    if (this.headerValue === undefined) {
      return;
    }

    if (this.closed) {
      // 收尾已开始/已完成：footer 账目只覆盖"finalize 开始前到达"的帧；之后到达的帧
      // 既写不进文件、也不该再改已固定的 footer，因此直接忽略。
      return;
    }

    if (this.stopReason !== undefined) {
      // 已请求停止、还在排空队列：这些帧确定写不进文件，计为丢弃（footer 在排空后才构建）。
      this.droppedRecordsValue += 1;
      this.droppedBytesValue += payload.length + FRAME_HEADER_BYTES;
      return;
    }

    if (this.recordsLimitReached || this.wireLimitReached) {
      // 任一上限已到：与 stopReason 路径同口径——既写不进文件，也要在 footer 里如实计数。
      this.droppedRecordsValue += 1;
      this.droppedBytesValue += payload.length + FRAME_HEADER_BYTES;
      return;
    }

    const decision = shouldRecordInboundFrame(channel, payloadKind, payload);
    if (!decision.record) {
      return;
    }

    let frame: Buffer;
    try {
      frame = encodeRawFrame(channel, payloadKind, payload);
    } catch (errorValue) {
      // 单帧超限等编码失败：丢弃并计数，绝不让录制把接收循环打挂。
      this.droppedRecordsValue += 1;
      this.droppedBytesValue += payload.length + FRAME_HEADER_BYTES;
      this.log(`[debug] recording dropped a frame: ${String(errorValue)}`);
      return;
    }

    if (this.acceptedWireBytesValue + frame.length > this.maxWireBytes) {
      // 帧级预算检查在**接受之前**：这一帧放进去会让 footer.wireBytes 超过回看预算，
      // 于是它必须算丢弃。否则会出现“录得出来、预检却拒绝”的自相矛盾。
      this.droppedRecordsValue += 1;
      this.droppedBytesValue += frame.length;
      if (!this.wireLimitReached) {
        this.wireLimitReached = true;
        this.log(`[debug] recording reached maxWireBytes (${this.maxWireBytes}); stopping with reason 'sizeLimit'.`);
        if (this.started) {
          this.sealCurrentBlock();
          this.schedulePump();
        }
      }

      return;
    }

    this.current.push(frame);
    this.currentBytes += frame.length;
    this.currentRecords += 1;
    this.acceptedRecordsValue += 1;
    this.acceptedWireBytesValue += frame.length;
    // ready 门前只入 current：header 还没落盘时 seal/pump 会与头部写并发（P1-02）。
    if (this.started && this.currentBytes >= this.blockBytes) {
      this.sealCurrentBlock();
    }

    if (this.acceptedRecordsValue >= this.maxRecords && !this.recordsLimitReached) {
      // 达到记录上限：先把**这一帧**按块封口（它必须进文件，footer.records 才能正好等于上限），
      // 再等队列排空后由 pump 写尾 `sizeLimit`。不能立刻置 stopReason：那会让 seal 出来的
      // 最后一块被 enqueue 丢掉（footer.records < 上限，文件与预算又对不上）。
      this.recordsLimitReached = true;
      this.log(`[debug] recording reached maxRecords (${this.maxRecords}); stopping with reason 'sizeLimit'.`);
      if (this.started) {
        this.sealCurrentBlock();
        this.schedulePump();
      }
    } else if (this.acceptedWireBytesValue >= this.maxWireBytes && !this.wireLimitReached) {
      // 恰好用完字节预算：当前块（含这一帧）先落盘，再等队列排空后写尾 sizeLimit。
      this.wireLimitReached = true;
      this.log(`[debug] recording reached maxWireBytes (${this.maxWireBytes}); stopping with reason 'sizeLimit'.`);
      if (this.started) {
        this.sealCurrentBlock();
        this.schedulePump();
      }
    }
  }

  /**
   * 停止录制并写文件尾。`sizeLimit` 由内部在超限时自动触发；手动停止/断开用 `disconnect`
   * （C.6 的 `endedReason` 只有这两个值）。
   *
   * 顺序保证：`start()` 在途时先 `await` 它。即使 server 在 start 完成前就把 recorder 暴露给
   * 断连路径，footer 也只能排在 header 之后；启动失败时这里收到同一个 reject，不会写出半截文件。
   */
  public async stop(reason: DebugRecordingEndReason = "disconnect"): Promise<DebugRecordingFooter> {
    if (this.startPromise !== undefined) {
      await this.startPromise;
    }

    if (this.footerValue !== undefined) {
      return this.footerValue;
    }

    if (this.finishDeferred !== undefined) {
      return this.finishDeferred.promise;
    }

    if (this.headerValue === undefined || this.closed) {
      throw new Error("The recorder has not been started.");
    }

    // 先落盘当前不完整的块，再置停止原因：`enqueue` 在停止后会丢块，顺序不能反。
    this.sealCurrentBlock();
    const deferred = createDeferred();
    this.finishDeferred = deferred;
    this.stopReason ??= reason;
    void this.pump();
    return deferred.promise;
  }

  /** 把 current 封成一个块（含 sizeLimit 收尾时"最后一块"的账目）。 */
  private sealCurrentBlock(): void {
    if (this.currentRecords === 0) {
      return;
    }

    const bytes = this.current.length === 1
      ? this.current[0]!
      : Buffer.concat(this.current, this.currentBytes);
    const records = this.currentRecords;
    this.current = [];
    this.currentBytes = 0;
    this.currentRecords = 0;
    this.enqueue({ bytes, records });
  }

  private enqueue(block: QueuedBlock): void {
    if (this.stopReason !== undefined || this.closed) {
      this.dropBlock(block);
      return;
    }

    if (this.queue.length >= this.queueBlocks) {
      // 队列满：丢**新块**并计数，绝不阻塞接收（P0 / C.6）。
      this.dropBlock(block);
      this.log(`[debug] recording queue full (${this.queueBlocks} blocks); dropped ${block.records} frame(s).`);
      return;
    }

    this.queue.push(block);
    this.schedulePump();
  }

  /**
   * 异步调度写循环：`recordFrame` 的调用栈里只入队，压缩（`deflateSync`）与写盘留给微任务，
   * 这样"不阻塞接收"对 pad 与真实大帧都成立（F5-04）。
   */
  private schedulePump(): void {
    if (this.pumpScheduled) {
      return;
    }

    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private dropBlock(block: QueuedBlock): void {
    this.droppedBlocksValue += 1;
    this.droppedRecordsValue += block.records;
    // 未压缩的帧字节（块里存的就是原样线上帧，压缩发生在写盘前）。
    this.droppedBytesValue += block.bytes.length;
  }

  /** 单飞写循环：按入队顺序压缩、检查上限、写盘并 flush。 */
  private async pump(): Promise<void> {
    if (this.pumping || this.closed || !this.started || this.sink === undefined) {
      return;
    }

    this.pumping = true;
    try {
      for (;;) {
        const block = this.queue.shift();
        if (block === undefined) {
          break;
        }

        if (this.stopReason === "sizeLimit") {
          // 已到上限：后面排队的块不再写，全部计为丢弃。
          this.dropBlock(block);
          continue;
        }

        this.options.onEncode?.(block.bytes.length);
        const encoded = encodeRecordBlock(DEBUG_RECORD_BLOCK_DATA, block.bytes);
        if (this.bytesWrittenValue + encoded.length > this.maxFileBytes) {
          this.dropBlock(block);
          this.stopReason = "sizeLimit";
          this.log(`[debug] recording reached maxFileBytes (${this.maxFileBytes}); stopping with reason 'sizeLimit'.`);
          continue;
        }

        await this.sink.write(encoded);
        await this.sink.sync();
        this.bytesWrittenValue += encoded.length;
        this.recordsValue += block.records;
      }

      if (this.stopReason === undefined && (this.recordsLimitReached || this.wireLimitReached)) {
        // 记录数/原始字节上限：队列里全是"上限内"的块，必须写完再收尾；这里才置 sizeLimit。
        this.stopReason = "sizeLimit";
      }

      if (this.stopReason !== undefined) {
        // 收尾：`current` 里不足一个 block 的帧也要进账（写不下就计入 dropped），
        // 保证 footer.records + footer.droppedRecords === 到达帧总数（F5-06）。
        this.sealCurrentBlock();
        // sealCurrentBlock 在 stopReason 已置时只会走 dropBlock；这里把新入队的块也消费掉。
        while (this.queue.length > 0) {
          this.dropBlock(this.queue.shift()!);
        }

        await this.finalize();
      }
    } catch (errorValue) {
      await this.fail(errorValue);
    } finally {
      this.pumping = false;
      // stop() 可能恰好落在"队列已空、finally 还没执行"的窗口里：那时它看到的 `pumping`
      // 仍是 true，不会启动新的写循环。这里补一次调度，保证 sealed block 与文件尾不丢。
      if (!this.closed && (this.queue.length > 0 || this.stopReason !== undefined)) {
        this.schedulePump();
      }
    }
  }

  private async fail(errorValue: unknown): Promise<void> {
    this.log(`[debug] recording write failed: ${String(errorValue)}`);
    const sink = this.sink;
    this.sink = undefined;
    await sink?.close().catch(() => undefined);
    this.closed = true;
    // sink 已关，但文件尾没写成：`finalized` 只能表示"可以判定结果"，不能表示"已保存"。
    this.finalized = true;
    this.failureValue = `recording write failed: ${String(errorValue)}`;
    this.finishDeferred?.reject(errorValue);
  }

  private async finalize(): Promise<void> {
    const sink = this.sink;
    if (sink === undefined || this.finalized) {
      return;
    }

    // 先封口再构建 footer：本函数 await 期间到达的帧由 recordFrame 直接忽略，
    // 不会出现"计数在 footer 之后增加"的半截账（F5-06）。
    this.closed = true;
    // 自动收尾（sizeLimit）没有 stop() 事先建 deferred；这里补一个，让紧跟着的 stop()
    // 能等到 footer 写完，而不是在"已 closed、footer 还没落盘"的窗口里误判为未启动。
    this.finishDeferred ??= createDeferred();
    void this.finishDeferred.promise.catch(() => undefined);

    const footer: DebugRecordingFooter = {
      records: this.recordsValue,
      wireBytes: this.acceptedWireBytesValue,
      droppedRecords: this.droppedRecordsValue,
      droppedBytes: this.droppedBytesValue,
      endedAt: new Date(this.now()).toISOString(),
      endedReason: this.stopReason ?? "disconnect",
    };
    const block = encodeRecordBlock(DEBUG_RECORD_BLOCK_FOOTER, encodeRecordingFooter(footer));
    let failure: unknown;
    try {
      // 文件尾允许略微越过 maxFileBytes：它很小，且"能打开并标注 sizeLimit"优先于严格不超限。
      await sink.write(block);
      await sink.sync();
      this.bytesWrittenValue += block.length;
      this.footerValue = footer;
      this.failureValue = undefined;
      this.log(
        `[debug] recording stopped (${footer.endedReason}): ${footer.records} record(s), dropped ${footer.droppedRecords}/${footer.droppedBytes} B`,
      );
    } catch (errorValue) {
      failure = errorValue;
      // footer 没写成功 ⇒ 文件不可交付：`footerValue` 保持 undefined（stats.deliverable=false），
      // monitor 会走错误提示而不是"已保存"（P2-4）。
      this.failureValue = `footer write failed: ${String(errorValue)}`;
      this.log(`[debug] recording failed to write the footer: ${String(errorValue)}`);
    } finally {
      await sink.close().catch((errorValue: unknown) => this.log(`[debug] recording failed to close the file: ${String(errorValue)}`));
      this.closed = true;
      this.finalized = true;
      this.sink = undefined;
    }

    if (failure !== undefined) {
      this.finishDeferred?.reject(failure);
    } else {
      this.finishDeferred?.resolve(footer);
    }
  }
}

function createDeferred(): {
  promise: Promise<DebugRecordingFooter>;
  resolve: (footer: DebugRecordingFooter) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (footer: DebugRecordingFooter) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DebugRecordingFooter>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function openFileSink(filePath: string): Promise<DebugRecorderSink> {
  await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  return {
    write: async (bytes) => {
      await handle.write(bytes);
    },
    sync: async () => {
      await handle.sync();
    },
    close: async () => {
      await handle.close();
    },
  };
}
