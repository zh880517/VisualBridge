/**
 * 录制收尾监视器（F5-05）：轮询 bridge 的录制状态，**只在文件 finalize 之后**发一次 `onStopped`。
 *
 * 自动收尾（`sizeLimit` / 断连）由 bridge 层完成：先写文件尾、`sync`、`close`，再撤掉 recorder。
 * 面板的 1 s 轮询如果只看 `active === false` 就提示"可打开回看"，可能抢在 `write/sync/close`
 * 之前，用户点进去读到的是无尾文件。因此这里用 `finalized`（sink 已 close）作为唯一放行条件，
 * 并把 footer 的统计（条数/丢弃/结束原因）一并交给 toast。
 *
 * 本模块不依赖 `vscode`：宿主里由 {@link DebugRecordingService} 驱动，单测可以直接调
 * {@link DebugRecordingMonitor.check} 验证"finalize 前不提示、finalize 后只提示一次"。
 */

import type { DebugRecordingEndReason } from "../bridge/debugRecordingFormat";

/** 收尾提示需要的最小 footer 摘要（`endedAt` 等文件内字段不用于 toast）。 */
export interface DebugRecordingStopSummary {
  readonly records: number;
  readonly droppedRecords: number;
  readonly droppedBytes: number;
  readonly endedReason: DebugRecordingEndReason | undefined;
}

/** 监视器只读的录制状态子集（宿主里就是 `EditorBridgeRecordingState`）。 */
export interface DebugRecordingMonitorSource {
  readonly recordingState: {
    readonly active: boolean;
    readonly filePath: string | undefined;
    readonly records: number;
    readonly droppedRecords: number;
    readonly droppedBytes: number;
    readonly endedReason: DebugRecordingEndReason | undefined;
    /** 文件尾已写完且 sink 已 close；`false` 时绝不能提示"可打开回看"。 */
    readonly finalized: boolean;
    /** 文件尾确实写成功；`finalized && deliverable === false` = 收尾失败（P2-4）。 */
    readonly deliverable: boolean;
    /** 收尾失败原因；非空时走错误提示，不能提示"已保存"。 */
    readonly failure: string | undefined;
  };
}

export interface DebugRecordingMonitorOptions {
  readonly bridge: () => DebugRecordingMonitorSource | undefined;
  readonly onStopped: (filePath: string, summary: DebugRecordingStopSummary | undefined) => void;
  /** 收尾失败（footer 没写成/写盘失败）：UI 走错误提示，**不**提示"已保存"（P2-4）。 */
  readonly onFailed?: (filePath: string, message: string) => void;
  /** 轮询周期（默认 1 s；测试可直接调 `check()`）。 */
  readonly pollMs?: number;
  readonly schedule?: (callback: () => void, intervalMs: number) => unknown;
  readonly cancelSchedule?: (handle: unknown) => void;
}

export const DEBUG_RECORDING_MONITOR_MS = 1_000;

/**
 * 从 bridge 的录制状态里取收尾摘要（成功路径）。
 *
 * `endedReason` 缺失 = 没有 footer，此时不编造条数（`undefined`）——与 `DebugRecordingStopSummary`
 * 的约定一致：缺 footer 的录制不能宣称"已保存 N 帧"。
 */
export function recordingStopSummary(
  state: DebugRecordingMonitorSource["recordingState"],
): DebugRecordingStopSummary | undefined {
  return state.endedReason === undefined
    ? undefined
    : {
        records: state.records,
        droppedRecords: state.droppedRecords,
        droppedBytes: state.droppedBytes,
        endedReason: state.endedReason,
      };
}

export class DebugRecordingMonitor {
  private readonly options: DebugRecordingMonitorOptions;
  private filePathValue: string | undefined;
  private handle: unknown;

  public constructor(options: DebugRecordingMonitorOptions) {
    this.options = options;
  }

  /**
   * 仍在监视、且**还欠一条**收尾结果的录制文件（`undefined` = 已经交付或没在监视）。
   *
   * 手动停止落在自动收尾窗口（两次轮询之间）时，`DebugRecordingService` 用它与
   * {@link DebugRecordingMonitor} 交付完之后的状态对齐：欠着就必须补一次显式提示（§7-d）。
   */
  public get watching(): string | undefined {
    return this.filePathValue;
  }

  /** 开始监视一次录制；重复调用以最后一次为准。 */
  public start(filePath: string): void {
    this.stop();
    this.filePathValue = filePath;
    const schedule = this.options.schedule ?? defaultSchedule;
    this.handle = schedule(() => this.check(), this.options.pollMs ?? DEBUG_RECORDING_MONITOR_MS);
  }

  /** 停止轮询（手动停止时先调它，避免与 bridge 的 stop 抢同一个提示）。 */
  public stop(): void {
    if (this.handle !== undefined) {
      const cancel = this.options.cancelSchedule ?? defaultCancelSchedule;
      cancel(this.handle);
      this.handle = undefined;
    }
  }

  /**
   * 停止轮询并放弃"欠一条"的记账：调用方**自己**负责这一次的提示（手动停止 /
   * 已由手动路径交付过的收尾）。不清掉它会让下一次 `stop()` 重复交付同一条。
   */
  public forget(): void {
    this.stop();
    this.filePathValue = undefined;
  }

  public dispose(): void {
    this.forget();
  }

  /** 一次轮询：仅在 `!active && finalized` 时交付一次（测试可直接调用）。 */
  public check(): void {
    const filePath = this.filePathValue;
    if (filePath === undefined) {
      return;
    }

    const bridge = this.options.bridge();
    if (bridge === undefined) {
      return;
    }

    const state = bridge.recordingState;
    if (state.active || !state.finalized) {
      // 仍在写 / footer+sync+close 未完成：等下一拍，宁可晚一秒也不提示半截文件。
      return;
    }

    this.forget();
    if (!state.deliverable || state.failure !== undefined) {
      // sink 已 close 但文件尾没写成功：文件不可交付。宁可报错，也不能让用户以为"已保存"。
      this.options.onFailed?.(filePath, state.failure ?? "the recording footer was not written");
      return;
    }

    this.options.onStopped(filePath, recordingStopSummary(state));
  }
}

function defaultSchedule(callback: () => void, intervalMs: number): unknown {
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  return timer;
}

function defaultCancelSchedule(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}
