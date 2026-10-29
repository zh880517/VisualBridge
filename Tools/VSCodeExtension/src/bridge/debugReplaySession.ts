/**
 * 回看会话：打开一个 `.vbdrec`，把数据块重放成一个独立的 `DebugInstanceManager`。
 *
 * 与在线会话**完全隔离**（不写进 `EditorBridgeServer.debug`，不触发任何连接/筛选逻辑）：
 * 面板在回看模式里把数据源切换到这个 manager，退出回看再切回去，在线记录一条不动。
 * 这也保证"回看不会改变面板开关"：回看会话没有传输层，`debugSetEnabled` 发不出去。
 *
 * 内存预算（P1-A，第 2/3 轮评审纠正；F8-§7-f 补齐联合上界）：**压缩后文件大小不是内存上界**。
 *
 * 逐条解码开销**不是**一个固定的放大倍数，单看"小帧 ≈3.5×"会同时低估与高估：
 * 实测（同一批 fixture）2 参事件 213.9 B raw → 739.6 B 解码（≈3.5×，压缩比 61×）；
 * 空参事件 ≈6.11×、无参事件 ≈6.97×（逐字段/逐对象的固定开销在小载荷上比重更大）；
 * 6 参事件 460.0 B raw → 1106.9 B 解码（≈2.4×）。所以预算是**两个上限的联合**：
 * - **记录数**先绑住极小帧：20 万条 × 740–1107 B ⇒ 148–221 MB 解码（与线上字节无关）；
 * - **原始线上字节**（64 MiB）绑住大帧：200_000 × 335 B = 67.0 MB（63.9 MiB）线上字节 ⇒
 *   ×2.4 ≈ 161 MB 解码；更大的载荷按 ≈1× 递增，1 MB 重复载荷更极端（压缩比 ~1000×，
 *   13 万条能装进 128 MB 压缩文件）。
 * **两个上限不能同时取到**：221 MB 需要 20 万条 1107 B 的记录，而那些记录来自约 460 B 的帧，
 * 20 万条就是 ≈92 MB 线上字节，已越过 64 MiB；64 MiB 里塞满 335 B 的帧也就 20 万条 ⇒ ≈161 MB。
 * 所以真实最坏 ≈161 MB，221 MB 只是记录数侧单独取满的保守值；取 221 MB 当联合上界是**故意保守**
 * （两侧各自独立成立，不依赖载荷分布），并没有"某一侧单独放开就爆"的路径。
 * 因此：
 * - **原始线上字节**预算（{@link DEBUG_REPLAY_MAX_WIRE_BYTES}，64 MB）是主预算；
 * - 记录数上限（{@link DEBUG_REPLAY_MAX_RECORDS}，20 万条）兜住逐条对象的固定开销；
 * - 打开前用文件头 + 文件尾 + 文件字节数做**不解码的预检**，任一超限**拒绝打开**，
 *   面板留在实时态并显示明确错误；
 * - 不静默截断/淘汰：那会让 `footer.records` 与视图变成两个真源。
 */

import {
  DEBUG_REPLAY_MAX_RECORDS,
  DEBUG_REPLAY_MAX_WIRE_BYTES,
  type DebugRecordingFooter,
  type DebugRecordingHeader,
} from "./debugRecordingFormat";
import {
  FileDebugSource,
  preflightRecordingFile,
  type DebugReplayPreflight,
  type DebugReplayPreflightLimits,
  type DebugReplayResult,
} from "./debugRecordingSource";
import type { DebugContractSnapshot } from "./debugContractRegistry";
import type { DebugInstanceManagerLimits } from "./debugInstanceManager";

/**
 * 回看管理器的容量上限（F5-07 / P1-A）。
 *
 * 回看是"离线完整重放"，不能再按在线预算淘汰：否则一段大录制会在回看里被二次淘汰，
 * "录制完整"就不成立，`footer.records` 也会与视图对不上。这里把所有淘汰维度都设成**有限**值，
 * 且这些值由回看预算推导：
 * - `maxRecordsPerInstance` = 20 万条（逐条对象/Map 的固定开销兜底，单条约 148–221 MB 堆）；
 * - `maxBytesPerInstance` / `maxBytesGlobal` = {@link DEBUG_REPLAY_MAX_WIRE_BYTES}（64 MB）：
 *   文件总原始线上字节 ≤ 64 MB，store 只按每条记录的 `wireBytes` 记账（不含 6 B 帧头），
 *   因此通过预检的文件不可能触发字节淘汰；
 * - `maxInstances` = 20 万（每条记录至少属于一个实例，不可能超过记录数）。
 *
 * 不再使用 `Number.MAX_SAFE_INTEGER`，也不再使用"记录数 × 协议最大帧长"的名义上界（200 GB）：
 * 后者拦不住 1 MB 重复载荷；真正的内存预算是记录数 + 原始线上字节，由
 * `preflightRecordingFile` 在**解码前**执行。
 */
export const DEBUG_REPLAY_MANAGER_LIMITS: Partial<DebugInstanceManagerLimits> = {
  maxInstances: DEBUG_REPLAY_MAX_RECORDS,
  maxBytesGlobal: DEBUG_REPLAY_MAX_WIRE_BYTES,
  maxBytesPerInstance: DEBUG_REPLAY_MAX_WIRE_BYTES,
  maxRecordsPerInstance: DEBUG_REPLAY_MAX_RECORDS,
};

export interface DebugReplaySessionOptions {
  readonly now?: () => number;
  /** 预检上限（只给测试注入小值；生产用默认的 20 万条 / 64 MB 原始字节 / 128 MB 文件兜底）。 */
  readonly preflight?: DebugReplayPreflightLimits;
}

export class DebugReplaySession {
  private constructor(
    public readonly filePath: string,
    private readonly source: FileDebugSource,
    private readonly resultValue: DebugReplayResult,
  ) {}

  /** 打开前的廉价预检（不解码）：UI 用它显示记录数，超限时在 `withProgress` 之前就失败。 */
  public static async preflight(
    filePath: string,
    limits: DebugReplayPreflightLimits = {},
  ): Promise<DebugReplayPreflight> {
    return preflightRecordingFile(filePath, limits);
  }

  /** 打开并完整重放（回看是只读的：解析完即可关闭文件句柄）。 */
  public static async load(filePath: string, options: DebugReplaySessionOptions = {}): Promise<DebugReplaySession> {
    // 预检必须在任何解码之前：超限时直接拒绝，不分配回看 manager，也不进入回看态。
    await preflightRecordingFile(filePath, options.preflight ?? {});
    const source = await FileDebugSource.open(filePath);
    try {
      // 显式传回看上限：manager 默认的 32 MB/实例 + 128 MB 全局会让大录制在回看里二次淘汰。
      const result = await source.replay({
        managerOptions: {
          limits: DEBUG_REPLAY_MANAGER_LIMITS,
          ...(options.now === undefined ? {} : { now: options.now }),
        },
      });
      return new DebugReplaySession(filePath, source, result);
    } finally {
      // `replay` 已经把块读进 manager；文件句柄可以立刻释放。
      await source.close();
    }
  }

  public get header(): DebugRecordingHeader {
    return this.resultValue.header;
  }

  public get footer(): DebugRecordingFooter | undefined {
    return this.resultValue.footer;
  }

  public get welcome(): DebugReplayResult["welcome"] {
    return this.resultValue.welcome;
  }

  public get contracts(): DebugContractSnapshot | undefined {
    return this.resultValue.contracts;
  }

  public get manager(): DebugReplayResult["manager"] {
    return this.resultValue.manager;
  }

  public get result(): DebugReplayResult {
    return this.resultValue;
  }

  public get sessionId(): string {
    return this.header.sessionId;
  }

  public dispose(): void {
    this.resultValue.manager.dispose();
  }
}
