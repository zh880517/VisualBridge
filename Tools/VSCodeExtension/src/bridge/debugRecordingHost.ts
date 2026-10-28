/**
 * 会话录制（F5）的**跨腿宿主**（E9）。
 *
 * F5 的录制状态机原本长在 `EditorBridgeServer` 里，只有 Editor 腿能开录。E9 之后两条腿
 * （Editor 桥 / Runtime 桥）都产生调试帧，录制必须能落在**任意一条**腿的连接上，并且
 * 录制帧仍然只能从 {@link DebugIngress} 的录制 tap（解码之前）流进来——不为 Runtime 腿
 * 单独写一条"录制旁路"，否则就会出现"Runtime 腿录制为空、但门禁全绿"的假绿。
 *
 * 设计要点：
 * - **一条录制只绑定一个源**（P1-B）：`start` 固定源 id，其它连接的帧一律不进文件；
 * - 源的可用性由创建者注册（握手/收到 welcome 之后），断连时注销；**活跃源注销即自动收尾**；
 * - 文件头的身份字段由源提供（Editor 腿来自监听方状态，Runtime 腿来自 welcome）；
 * - 这里只管字节与文件，不碰协议、不碰解码。
 */

import {
  BRIDGE_CONTRACT_SCHEMA_VERSION,
  BRIDGE_PROTOCOL_VERSION,
} from "./bridgeProtocol";
import type { DebugChannelOrigin } from "./debugChannel";
import type { DebugContractSnapshot } from "./debugContractRegistry";
import type { DebugRecorderOpenSink, DebugSessionRecorder } from "./debugRecorder";
import { DebugSessionRecorder as Recorder } from "./debugRecorder";
import { serializeRecordedContracts } from "./debugRecordingContracts";
import type {
  DebugRecordingConnectType,
  DebugRecordingEndReason,
  DebugRecordingFooter,
  DebugRecordingHeader,
} from "./debugRecordingFormat";
import type { BridgePayloadKind } from "./framing";

/** 会话录制能力的状态（F3 面板的"录制"按钮只读它）。 */
export interface EditorBridgeRecordingState {
  /** 桥接服务已启动、能写文件（与"当前有没有连接"无关：可以先开录再连）。 */
  readonly available: boolean;
  readonly active: boolean;
  readonly filePath: string | undefined;
  readonly startedAt: string | undefined;
  readonly records: number;
  readonly droppedRecords: number;
  readonly droppedBytes: number;
  readonly endedReason: DebugRecordingEndReason | undefined;
  readonly endedAt: string | undefined;
  /**
   * 文件已 finalize（文件尾 + sync + close 已完成，或写盘失败已回收 sink）。
   * 面板的自动收尾提示必须等它为 true，否则用户可能打开一个没有文件尾的半截文件（F5-05）。
   */
  readonly finalized: boolean;
  /**
   * 文件尾确实写成功（可以"打开回看"）。`finalized && !deliverable` = 收尾失败，
   * UI 必须走错误提示，不能提示"已保存"（P2-4）。
   */
  readonly deliverable: boolean;
  /** 收尾失败原因（footer 写失败 / 写盘失败）；非空时不能宣称"已保存"。 */
  readonly failure: string | undefined;
  /** 当前录制（或最近一次录制）绑定的是哪条腿（E9 显示层）。 */
  readonly origin: DebugChannelOrigin | undefined;
}

/** 开始录制的入参；路径由宿主（UI）确定，服务端只负责快照与写入。 */
export interface EditorBridgeRecordingOptions {
  readonly filePath: string;
  readonly maxFileBytes?: number;
  /** 记录条数上限（缺省 = 回看预算；保证"能录出来的文件一定能打开"）。 */
  readonly maxRecords?: number;
  readonly blockBytes?: number;
  readonly queueBlocks?: number;
  /** 注入时钟；缺省用服务端时钟（测试用假时钟断言 `startedAt`/`endedAt`）。 */
  readonly now?: () => number;
  /** 测试注入：替换文件写入。 */
  readonly openSink?: DebugRecorderOpenSink;
}

/**
 * 一个可录制的调试源（一条已握手的调试连接）。身份字段直接进 `.vbdrec` 文件头。
 */
export interface DebugRecordingSource {
  /** 稳定 id（一条连接一个）：只有这个 id 的帧会进当前录制。 */
  readonly id: string;
  readonly origin: DebugChannelOrigin;
  /** A.3 的 `connectType`：Editor 桥恒为 `editor`，Runtime 桥按 welcome 取值。 */
  readonly connectType: DebugRecordingConnectType;
  readonly sessionId: string;
  readonly endpointId: string;
  readonly bootId: string;
  readonly contractHash: string;
  readonly contracts: DebugContractSnapshot | undefined;
  /** 该连接此刻是否仍可接收帧（已握手且未断开）。 */
  readonly isOpen: () => boolean;
}

export interface DebugRecordingHostOptions {
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export class DebugRecordingHost {
  private readonly sources = new Map<string, DebugRecordingSource>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private recorder: DebugSessionRecorder | undefined;
  private activeSourceId: string | undefined;
  private lastRecording: EditorBridgeRecordingState | undefined;

  public constructor(options: DebugRecordingHostOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** 注册一个可录制源（握手/welcome 之后）；同一 id 重复注册只更新身份。 */
  public registerSource(source: DebugRecordingSource): void {
    this.sources.set(source.id, source);
  }

  /**
   * 注销源（连接关闭）：活跃源注销会**自动收尾**（`disconnect`），其它源注销无副作用。
   */
  public unregisterSource(id: string): void {
    this.sources.delete(id);
    if (this.activeSourceId !== id) {
      return;
    }

    this.activeSourceId = undefined;
    void this.stop("disconnect").catch((errorValue: unknown) => {
      this.log(`[debug] failed to finish the session recording: ${String(errorValue)}`);
    });
  }

  /** 现在有没有可录制的源（面板按它决定录制按钮是否可用）。 */
  public get hasOpenSource(): boolean {
    for (const source of this.sources.values()) {
      if (source.isOpen()) {
        return true;
      }
    }

    return false;
  }

  /** 当前录制绑定的源 id（诊断/测试用）。 */
  public get sourceId(): string | undefined {
    return this.activeSourceId;
  }

  public get state(): EditorBridgeRecordingState {
    const stats = this.recorder?.stats;
    if (stats !== undefined) {
      return {
        available: this.hasOpenSource,
        active: stats.active,
        filePath: stats.filePath,
        startedAt: stats.startedAt,
        records: stats.records,
        droppedRecords: stats.droppedRecords,
        droppedBytes: stats.droppedBytes,
        endedReason: stats.endedReason,
        endedAt: stats.endedAt,
        finalized: stats.finalized,
        deliverable: stats.deliverable,
        failure: stats.failure,
        origin: this.sourceOrigin(this.activeSourceId),
      };
    }

    const last = this.lastRecording;
    return {
      available: this.hasOpenSource,
      active: false,
      filePath: last?.filePath,
      startedAt: last?.startedAt,
      records: last?.records ?? 0,
      droppedRecords: last?.droppedRecords ?? 0,
      droppedBytes: last?.droppedBytes ?? 0,
      endedReason: last?.endedReason,
      endedAt: last?.endedAt,
      finalized: last !== undefined,
      deliverable: last?.deliverable ?? false,
      failure: last?.failure,
      origin: last?.origin,
    };
  }

  /**
   * 开始录制：固定**第一个可用源**（注册顺序 = Editor 腿优先），把契约快照与身份写进文件头。
   * 没有可用源时拒绝——不能录一个"还没有源"的会话。
   */
  public async start(options: EditorBridgeRecordingOptions): Promise<DebugRecordingHeader> {
    if (this.recorder?.active === true) {
      throw new Error("A debug session recording is already active.");
    }

    const source = this.firstOpenSource();
    if (source === undefined) {
      throw new Error(
        "Recording requires a handshaken debug connection (Editor Bridge or Runtime Bridge): a recording is bound to the connection it records.",
      );
    }

    const snapshot = source.contracts;
    const recorder = new Recorder({
      filePath: options.filePath,
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
      ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
      ...(options.blockBytes === undefined ? {} : { blockBytes: options.blockBytes }),
      ...(options.queueBlocks === undefined ? {} : { queueBlocks: options.queueBlocks }),
      ...(options.openSink === undefined ? {} : { openSink: options.openSink }),
      now: options.now ?? this.now,
      log: this.log,
      header: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        contractSchemaVersion: snapshot?.schemaVersion ?? BRIDGE_CONTRACT_SCHEMA_VERSION,
        contractHash: snapshot?.contractHash ?? source.contractHash,
        sessionId: source.sessionId,
        endpointId: source.endpointId,
        bootId: source.bootId,
        connectType: source.connectType,
        contracts: serializeRecordedContracts(snapshot),
      },
    });
    this.lastRecording = undefined;
    // 绑定必须在 `recorder.start()` 之前生效：文件头写入期间到达的帧也要归到同一条源连接。
    this.activeSourceId = source.id;
    this.recorder = recorder;
    try {
      return await recorder.start();
    } catch (errorValue) {
      if (this.recorder === recorder) {
        this.recorder = undefined;
        this.activeSourceId = undefined;
      }

      throw errorValue;
    }
  }

  /**
   * 停止录制并写文件尾；没有录制时返回 `undefined`。
   *
   * 顺序（F5-05）：先 `await recorder.stop()` 拿到 footer（文件尾已写出并 close），再撤掉
   * `this.recorder`——自动收尾的轮询在 finalize 期间仍能读到 stats，收尾后也能从
   * {@link lastRecording} 读到 footer 统计。
   */
  public async stop(reason: DebugRecordingEndReason = "disconnect"): Promise<DebugRecordingFooter | undefined> {
    const recorder = this.recorder;
    if (recorder === undefined) {
      return undefined;
    }

    try {
      const footer = await recorder.stop(reason);
      const stats = recorder.stats;
      this.lastRecording = {
        available: this.hasOpenSource,
        active: false,
        filePath: stats.filePath,
        startedAt: stats.startedAt,
        records: stats.records,
        droppedRecords: stats.droppedRecords,
        droppedBytes: stats.droppedBytes,
        endedReason: stats.endedReason,
        endedAt: stats.endedAt,
        finalized: stats.finalized,
        deliverable: stats.deliverable,
        failure: stats.failure,
        origin: this.sourceOrigin(this.activeSourceId),
      };
      return footer;
    } finally {
      if (this.recorder === recorder) {
        this.recorder = undefined;
        this.activeSourceId = undefined;
      }
    }
  }

  /**
   * 帧入口：只有**当前录制源**的帧进文件。两条腿在各自的入站入口调用它
   * （Editor 腿在 `BridgeSocket` 的 control/debug 回调，Runtime 腿在 `onDebugFrame`），
   * 因此录制顺序与到达顺序一致；非源连接的帧不影响当前录制。
   */
  public noteFrame(sourceId: string, channel: number, payloadKind: BridgePayloadKind, payload: Buffer): void {
    if (sourceId !== this.activeSourceId) {
      return;
    }

    try {
      this.recorder?.recordFrame(channel, payloadKind, payload);
    } catch (errorValue) {
      this.log(`[debug] recording hook failed (the frame is delivered normally): ${String(errorValue)}`);
    }
  }

  private firstOpenSource(): DebugRecordingSource | undefined {
    for (const source of this.sources.values()) {
      if (source.isOpen()) {
        return source;
      }
    }

    return undefined;
  }

  private sourceOrigin(sourceId: string | undefined): DebugChannelOrigin | undefined {
    return sourceId === undefined ? undefined : this.sources.get(sourceId)?.origin;
  }
}
