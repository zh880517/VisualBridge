/**
 * 调试实例存储（附录 C.2/C.4）：有界环形缓冲、按 `wireBytes` 记账、淘汰最旧、回放游标与关键帧。
 *
 * 记账口径（C.4，评审 P0）：
 * - 只按 {@link DebugRecord.wireBytes}（= 线上载荷字节数 `payloadLength`，由 F1 的接收门写入），
 *   **不含** 6 字节帧头；
 * - 每实例两道上限（32 MB / 20000 条）由本类就地淘汰最旧，淘汰后 `bytes` 立即扣减；
 * - 全局 128 MB 由 `DebugInstanceManager` 跨实例执行（本类只暴露 `bytes` / `evictOldest()`），
 *   保证"全局计数只有 Σ 实例 bytes 这一个真源"，不存在第二份可能算错的计数。
 *
 * 游标（C.4）：`position` 是**绝对应用位置**（实例创建以来应用过的记录条数，含已被淘汰的），
 * 因此淘汰只会让"最早可用位置"前移；一旦游标落到已淘汰区间就夹到最早可用记录并标 `partial`，
 * 绝不重置。`partial` 一旦置位保持到 `clear()` / 过滤变化 / 从头重放为止。
 *
 * 关键帧（C.4）：每 1 MB 或 2000 条**触发**一次（本类只提供 {@link DebugStore.takeKeyframeTrigger}
 * 与触发计数），快照与上限由 `DebugKeyframeRegistry` 按**分类**持有——快照是分类主消费者的状态，
 * 属于消费者身份而不是实例身份。捕获时机由调用方（`DebugInstanceManager`）保证在"记录应用之后"。
 */

import type { DebugContractState } from "./debugContractRegistry";
import type { DebugArg } from "./debugMessages";
import {
  defaultClearTimer,
  defaultSetTimer,
  normalizeByteCount,
  normalizePosition,
  normalizePositiveInteger,
  normalizePositiveNumber,
} from "./debugSupport";

/** 记录种类：`queryResult` 由 F6 追加（C.1 的查询结果也进时间轴）。 */
export type DebugRecordKind = "event" | "queryResult";

/** 一个载荷参数（C.2 的值单元）：`tag` / 名字 / 线上类型 / 值。 */
export type DebugArgValue = DebugArg;

/**
 * 未分配序号的记录（C.2 的字段清单）。
 *
 * `interfaceId` / `method` 按 C.2 是必填字符串：契约未命中时为空串（通用视图据此显示 `arg#<tag>`）。
 * `kind` 为 F6 预留：F6 的查询结果与调试事件共用同一时间轴与同一套容量记账。
 *
 * **`arrivalSeq` 不在这里**：它由 {@link DebugStore.append} 通过注入的分配器**在写入瞬间**分配
 * （见 {@link DebugStoreOptions.nextArrivalSeq}），外部调用者无法自带序号——否则"记录先于 Create
 * 暂存、之后才被应用"的记录会带着一个比关键帧更小的序号进 store，回放的增量过滤会把它静默丢掉
 * （评审 P1，第三轮）。
 */
export interface DebugRecordInput {
  readonly kind: DebugRecordKind;
  readonly category: string;
  readonly interfaceId: string;
  readonly instanceId: string;
  readonly method: string;
  /** `tag → 值`：只含线上实际到达的非默认参数，保留到达顺序（C.2）。 */
  readonly args: ReadonlyMap<number, DebugArgValue>;
  /** `参数名 → 值`：按契约补齐默认值后的完整表；契约缺失/未命中时为空 Map（C.2）。 */
  readonly named: ReadonlyMap<string, DebugArgValue>;
  /** 最近的 `debugFrame`；`-1` 表示无帧（C.2）。 */
  readonly frame: number;
  /** 载荷字节数，容量记账单位（C.4）。 */
  readonly wireBytes: number;
  readonly receivedAt: number;
  readonly contractState: DebugContractState;
}

/**
 * 归一化记录（C.2）：`id` 是实例内单调序号，`arrivalSeq` 是跨实例的全局应用序。
 * 两者都由 store 在 {@link DebugStore.append} 内分配，调用方只提供 {@link DebugRecordInput}。
 */
export interface DebugRecord extends DebugRecordInput {
  readonly id: number;
  /**
   * 全局应用序（1 起、跨实例唯一）：**分配序 == 应用序**，即写入 store 的先后。
   * 关键帧回放用它裁增量（见 debugKeyframe.ts）。
   */
  readonly arrivalSeq: number;
}

/** 步进粒度（附录 C.7 / F2 §范围）：按记录一条、按帧一整帧。 */
export type DebugCursorGranularity = "record" | "frame";

/** 步进方向：`1` 下一步，`-1` 上一步。 */
export type DebugCursorDirection = 1 | -1;

/** 回放游标状态。 */
export interface DebugCursorState {
  /** 绝对应用位置（含已淘汰记录），见文件头。 */
  readonly position: number;
  /** 已有记录被淘汰，回放存在空洞（C.4）。 */
  readonly partial: boolean;
}

/** {@link DebugStore.recordsFrom} 的结果：带上夹取信号，别让调用方以为从请求位置开始。 */
export interface DebugRecordSlice {
  /** 调用方请求的绝对位置。 */
  readonly requestedPosition: number;
  /** 实际起点（请求位置落在已淘汰区间时被夹到 `earliestPosition`）。 */
  readonly fromPosition: number;
  /** 当前末尾（绝对位置）。 */
  readonly toPosition: number;
  /** 请求位置早于最早可用记录：结果里缺了 `requestedPosition..fromPosition-1`。 */
  readonly partial: boolean;
  readonly records: readonly DebugRecord[];
}

export type DebugStoreChangeKind = "append" | "evict" | "clear" | "cursor";

/** 一次批量通知：自上次通知以来发生的变化（批通知 + 渲染节流）。 */
export interface DebugStoreNotification {
  readonly instanceId: string;
  readonly category: string;
  readonly changes: readonly DebugStoreChangeKind[];
  readonly appended: readonly DebugRecord[];
  readonly evicted: readonly DebugRecord[];
  readonly cursor: DebugCursorState;
  readonly bytes: number;
  readonly recordCount: number;
  readonly earliestPosition: number;
}

export type DebugStoreListener = (notification: DebugStoreNotification) => void;

/** 单实例上限（C.4）。`notifyThrottleMs` 是批通知的合批窗口，不是容量项。 */
export interface DebugStoreLimits {
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly keyframeIntervalBytes: number;
  readonly keyframeIntervalRecords: number;
  readonly notifyThrottleMs: number;
}

/** 每实例 32 MB（C.4）。 */
export const DEBUG_MAX_BYTES_PER_INSTANCE = 32 * 1024 * 1024;

/** 每实例 20000 条（C.4 的辅助上限）。 */
export const DEBUG_MAX_RECORDS_PER_INSTANCE = 20_000;

/** 环形缓冲的初始槽位数：稀疏增长，不再按 `maxRecords` 预分配一个可能极大的数组。 */
const DEBUG_STORE_INITIAL_RECORDS = 1_024;

/** 关键帧字节阈值 1 MB（C.4）。 */
export const DEBUG_KEYFRAME_INTERVAL_BYTES = 1024 * 1024;

/** 关键帧条数阈值 2000（C.4）。 */
export const DEBUG_KEYFRAME_INTERVAL_RECORDS = 2_000;

/** 批通知合批窗口（毫秒）；步进/清空不走节流，立即 flush（F2 §评审清单 P1）。 */
export const DEBUG_NOTIFY_THROTTLE_MS = 50;

export const DEBUG_STORE_LIMITS: DebugStoreLimits = {
  maxBytes: DEBUG_MAX_BYTES_PER_INSTANCE,
  maxRecords: DEBUG_MAX_RECORDS_PER_INSTANCE,
  keyframeIntervalBytes: DEBUG_KEYFRAME_INTERVAL_BYTES,
  keyframeIntervalRecords: DEBUG_KEYFRAME_INTERVAL_RECORDS,
  notifyThrottleMs: DEBUG_NOTIFY_THROTTLE_MS,
};

export interface DebugStoreOptions {
  readonly instanceId: string;
  readonly category: string;
  readonly limits?: Partial<DebugStoreLimits>;
  /** 初始过滤键（关键帧归属）；缺省空串。 */
  readonly filterKey?: string;
  /**
   * 全局应用序分配器（**必填**）：`append` 在写入前调用一次，把返回值盖在记录上。
   *
   * 跨实例唯一性由调用方保证——生产路径只有 `DebugInstanceManager`（注入自己的单调计数器）。
   * 没有缺省值：store 自带一个局部计数器会让"每个 store 各自从 1 开始"变成**跨实例撞号**，
   * 而回放的 `arrivalSeq > keyframe.arrivalSeq` 过滤会因此静默丢记录——正是本轮在修的静默路径。
   * 因此漏注入时宁可**编译失败**，也不退化成局部计数（评审 P2-e）。
   */
  readonly nextArrivalSeq: () => number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** 定时器注入点（测试用假定时器；缺省 `setTimeout` 且 `unref()`）。 */
  readonly setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * 一个调试实例的有界记录缓冲。**一个实例一个 store**（类别与实例 id 固定），
 * 全局容量与实例数上限由 `DebugInstanceManager` 负责。
 */
export class DebugStore {
  public readonly instanceId: string;
  public readonly category: string;

  private readonly limits: DebugStoreLimits;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly setTimer: (callback: () => void, timeoutMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly nextArrivalSeq: () => number;

  /** 环形缓冲：槽位复用，`head` 是最旧一条。 */
  private slots: Array<DebugRecord | undefined>;
  private head = 0;
  private count = 0;
  private bytesValue = 0;
  private nextId = 0;
  /** 累计被淘汰（或清空）的记录条数 = 最早可用记录的绝对位置。 */
  private evicted = 0;
  private cursorPosition = 0;
  private cursorPartial = false;

  private filterKeyValue = "";
  private bytesSinceKeyframe = 0;
  private recordsSinceKeyframe = 0;
  /**
   * 已淘汰（含 `clear()` 清掉）记录的最大**全局到达序**：关键帧回放的增量下限。
   * 关键帧的 `arrivalSeq` 必须 ≥ 它，否则"关键帧之后的增量"已经有洞（见 debugKeyframe.ts）。
   */
  private maxEvictedArrivalSeqValue = 0;

  private readonly listeners = new Set<DebugStoreListener>();
  private pendingAppended: DebugRecord[] = [];
  private pendingEvicted: DebugRecord[] = [];
  private pendingChanges = new Set<DebugStoreChangeKind>();
  private notifyTimer: unknown;
  private pausedValue = false;
  private disposed = false;
  private oversizeDropsValue = 0;

  public constructor(options: DebugStoreOptions) {
    this.instanceId = options.instanceId;
    this.category = options.category;
    this.limits = normalizeLimits(options.limits);
    this.filterKeyValue = options.filterKey ?? "";
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.nextArrivalSeq = options.nextArrivalSeq;
    this.slots = new Array<DebugRecord | undefined>(Math.min(this.limits.maxRecords, DEBUG_STORE_INITIAL_RECORDS));
  }

  public get limitsSnapshot(): DebugStoreLimits {
    return this.limits;
  }

  /** 当前缓冲字节数（= Σ 缓冲记录 `wireBytes`）。 */
  public get bytes(): number {
    return this.bytesValue;
  }

  public get recordCount(): number {
    return this.count;
  }

  /** 最早可用记录的绝对位置（= 已淘汰条数）。 */
  public get earliestPosition(): number {
    return this.evicted;
  }

  /** 下一条记录将占用的绝对位置（= 已应用到的末尾）。 */
  public get endPosition(): number {
    return this.evicted + this.count;
  }

  public get cursor(): DebugCursorState {
    return { position: this.cursorPosition, partial: this.cursorPartial };
  }

  public get paused(): boolean {
    return this.pausedValue;
  }

  public get filterKey(): string {
    return this.filterKeyValue;
  }

  /** 已淘汰记录的最大全局到达序（关键帧有效性判定；只对同分类有意义）。 */
  public get maxEvictedArrivalSeq(): number {
    return this.maxEvictedArrivalSeqValue;
  }

  /** 当前缓冲（按到达顺序，最旧在前）。 */
  public get records(): readonly DebugRecord[] {
    const result: DebugRecord[] = [];
    for (let index = 0; index < this.count; index += 1) {
      const record = this.recordAt(index);
      if (record !== undefined) {
        result.push(record);
      }
    }

    return result;
  }

  /**
   * 追加一条记录：分配实例内序号与**全局应用序**（写入瞬间分配，见 `nextArrivalSeq`），
   * 就地执行每实例上限淘汰。单条超过 `maxBytes` 时拒收并计数（生产上不可能：单帧 ≤ 1 MB < 32 MB）。
   */
  public append(input: DebugRecordInput): DebugRecord | undefined {
    if (this.disposed) {
      return undefined;
    }

    const wireBytes = normalizeByteCount(input.wireBytes);
    if (wireBytes > this.limits.maxBytes) {
      this.log(`[debug] dropped a ${wireBytes} byte record: larger than the ${this.limits.maxBytes} byte instance budget`);
      this.oversizeDropsValue += 1;
      return undefined;
    }

    const record: DebugRecord = {
      kind: input.kind,
      category: input.category,
      interfaceId: input.interfaceId,
      instanceId: input.instanceId,
      method: input.method,
      args: input.args,
      named: input.named,
      frame: input.frame,
      wireBytes,
      receivedAt: input.receivedAt,
      arrivalSeq: this.nextArrivalSeq(),
      contractState: input.contractState,
      id: this.nextId + 1,
    };
    this.nextId += 1;

    // 先腾出空间再写；`count >= maxRecords` 时环形缓冲的槽位会是同一个。
    while (this.count > 0 && (this.bytesValue + record.wireBytes > this.limits.maxBytes || this.count >= this.limits.maxRecords)) {
      const evictedRecord = this.dropOldest();
      if (evictedRecord === undefined) {
        break;
      }

      this.pendingEvicted.push(evictedRecord);
      this.pendingChanges.add("evict");
    }

    this.ensureCapacity();
    const slot = (this.head + this.count) % this.slots.length;
    this.slots[slot] = record;
    this.count += 1;
    this.bytesValue += record.wireBytes;
    this.bytesSinceKeyframe += record.wireBytes;
    this.recordsSinceKeyframe += 1;

    this.pendingAppended.push(record);
    this.markChanged("append");
    return record;
  }

  /** 单条拒收计数（只有注入极小 `maxBytes` 的单测会触发）。 */
  public get oversizeDrops(): number {
    return this.oversizeDropsValue;
  }

  /** 最旧一条（全局容量执行者用它比较"谁的记录更旧"）。 */
  public oldest(): DebugRecord | undefined {
    return this.count === 0 ? undefined : this.recordAt(0);
  }

  /** 最新一条。 */
  public newest(): DebugRecord | undefined {
    return this.count === 0 ? undefined : this.recordAt(this.count - 1);
  }

  /**
   * 淘汰最旧一条；返回被淘汰的记录（调用方据此扣减全局计数）。
   * 每实例上限由 {@link append} 自动执行，本方法是给全局 128 MB 上限用的。
   */
  public evictOldest(): DebugRecord | undefined {
    const record = this.dropOldest();
    if (record === undefined) {
      return undefined;
    }

    this.pendingEvicted.push(record);
    this.pendingChanges.add("evict");
    this.markChanged("evict");
    return record;
  }

  /**
   * 绝对位置 `position` 对应的**单条**记录：O(1)、不复制数组（P2-2）。
   *
   * 面板时间轴只为游标取一条明细；用 `recordsFrom(position)` 会把 `position → 末尾`
   * 整段拷出来（2 万条记录的回看里一次快照就是 2 万条），这是不可接受的读取放大。
   * 位置落在已淘汰区间/末尾之外时返回 `undefined`（与 `recordsFrom` 的夹取语义区分开：
   * 这里没有"起点"可夹，越界就是没有）。
   */
  public recordAtPosition(position: number): DebugRecord | undefined {
    const index = normalizePosition(position);
    if (index < this.evicted || index >= this.endPosition) {
      return undefined;
    }

    return this.recordAt(index - this.evicted);
  }

  /**
   * 绝对区间 `[fromPosition, toPositionExclusive)` 的记录（最多 `toPosition - fromPosition` 条）。
   *
   * 与 {@link recordsFrom} 的区别：区间**两端都夹住**，不会从起点一路复制到末尾。
   * 面板的渲染窗口需要的就是这个语义（游标附近 500 条）。返回的 `toPosition` 仍是当前末尾
   * （与 `DebugRecordSlice` 的既有字段含义保持一致），窗口末位由 `fromPosition + records.length` 得出。
   */
  public recordsBetween(fromPosition: number, toPositionExclusive: number): DebugRecordSlice {
    const requestedPosition = normalizePosition(fromPosition);
    const endPosition = this.endPosition;
    const start = Math.min(Math.max(requestedPosition, this.evicted), endPosition);
    const stop = Math.min(Math.max(normalizePosition(toPositionExclusive), start), endPosition);
    const records: DebugRecord[] = [];
    for (let position = start; position < stop; position += 1) {
      const record = this.recordAt(position - this.evicted);
      if (record !== undefined) {
        records.push(record);
      }
    }

    return {
      requestedPosition,
      fromPosition: start,
      toPosition: endPosition,
      partial: requestedPosition < this.evicted,
      records,
    };
  }

  /**
   * 绝对位置 `position` 起的缓冲记录（F3 的区间读取）。
   *
   * 请求位置落在已淘汰区间时**夹到最早可用记录**，并把这件事显式报出来
   * （`DebugRecordSlice.fromPosition` / `partial`）：只返回记录数组会让调用方渲染出
   * "从 requested 位置开始"的假象（评审 P2-6）。`fromPosition` 同时夹在 `[evicted, endPosition]` 内，
   * 因此 `fromPosition <= toPosition` 恒成立——请求位置超过末尾时得到空切片而不是负区间（评审 P2-d）。
   *
   * 注意它是"到末尾"的整段读取（增量扫描用）；渲染窗口请用 {@link recordsBetween}。
   */
  public recordsFrom(position: number): DebugRecordSlice {
    const requestedPosition = normalizePosition(position);
    const toPosition = this.endPosition;
    const start = Math.min(Math.max(requestedPosition, this.evicted), toPosition);
    const index = start - this.evicted;
    const records: DebugRecord[] = [];
    for (let cursor = index; cursor < this.count; cursor += 1) {
      const record = this.recordAt(cursor);
      if (record !== undefined) {
        records.push(record);
      }
    }

    return {
      requestedPosition,
      fromPosition: start,
      toPosition,
      partial: requestedPosition < this.evicted,
      records,
    };
  }

  /**
   * 应用游标到绝对位置 `position`（C.4）：
   * - 低于最早可用 → 夹到最早可用并标 `partial`（不重置）；
   * - 高于末尾 → 夹到末尾（没有丢数据，不标 `partial`）。
   */
  public applyCursor(position: number): DebugCursorState {
    const earliest = this.evicted;
    const end = this.endPosition;
    let next = normalizePosition(position);
    if (next < earliest) {
      next = earliest;
      this.cursorPartial = true;
    } else if (next > end) {
      next = end;
    }

    this.cursorPosition = next;
    this.markChanged("cursor");
    // 步进/跳转必须立即反映到界面，不能被渲染节流压住（F2 §评审清单 P1）。
    this.flush();
    return this.cursor;
  }

  /**
   * 按粒度步进（C.7）：按记录一条一条；按帧以"连续同帧号"为一组
   * （同帧号不连续视为两帧、`frame == -1` 也按连续成组、帧号回退或重复不重排）。
   * 成帧规则只有 {@link groupRecordsByFrame} 一份实现，步进直接复用它。
   */
  public step(granularity: DebugCursorGranularity, direction: DebugCursorDirection): DebugCursorState {
    const end = this.endPosition;
    if (granularity === "record") {
      return this.applyCursor(this.cursorPosition + direction);
    }

    const index = this.cursorPosition - this.evicted;
    const groups = groupRecordsByFrame(this.records);
    if (direction > 0) {
      let stop = 0;
      for (const group of groups) {
        stop += group.length;
        if (stop > index) {
          return this.applyCursor(this.evicted + stop);
        }
      }

      return this.applyCursor(end);
    }

    if (index <= 0) {
      return this.applyCursor(this.evicted);
    }

    // 后退到"游标前一条所在的组"的开头（游标在组内即本组开头，在组首即上一组开头）。
    let start = 0;
    for (const group of groups) {
      const stop = start + group.length;
      if (index - 1 < stop) {
        return this.applyCursor(this.evicted + start);
      }

      start = stop;
    }

    return this.applyCursor(this.evicted);
  }

  /**
   * 过滤条件变化（C.4）：游标退回最早可用并标 `partial`，关键帧全部失效（由
   * `DebugInstanceManager` 清 {@link DebugKeyframeRegistry}）。过滤本身（哪些记录通过）不在本类。
   */
  public setFilterKey(filterKey: string): boolean {
    if (filterKey === this.filterKeyValue) {
      return false;
    }

    this.filterKeyValue = filterKey;
    this.bytesSinceKeyframe = 0;
    this.recordsSinceKeyframe = 0;
    this.cursorPartial = true;
    this.cursorPosition = this.evicted;
    this.markChanged("cursor");
    this.flush();
    return true;
  }

  /** 自上次捕获以来的阈值是否到达（到达即清零，避免同一批反复触发）。 */
  public takeKeyframeTrigger(): boolean {
    const due = this.recordsSinceKeyframe >= this.limits.keyframeIntervalRecords
      || this.bytesSinceKeyframe >= this.limits.keyframeIntervalBytes;
    if (!due) {
      return false;
    }

    this.bytesSinceKeyframe = 0;
    this.recordsSinceKeyframe = 0;
    return true;
  }

  /** 清空记录与游标（面板"清空"）：返回释放的字节数，供全局记账扣减。 */
  public clear(): number {
    const released = this.bytesValue;
    // 清空等于把所有记录从"可用集合"里拿掉：关键帧的增量下限随之抬到当前最大到达序。
    for (let index = 0; index < this.count; index += 1) {
      const record = this.recordAt(index);
      if (record !== undefined) {
        this.maxEvictedArrivalSeqValue = Math.max(this.maxEvictedArrivalSeqValue, record.arrivalSeq);
      }
    }

    this.slots = new Array<DebugRecord | undefined>(Math.min(this.limits.maxRecords, DEBUG_STORE_INITIAL_RECORDS));
    this.head = 0;
    this.count = 0;
    this.bytesValue = 0;
    this.evicted = 0;
    this.cursorPosition = 0;
    this.cursorPartial = false;
    this.bytesSinceKeyframe = 0;
    this.recordsSinceKeyframe = 0;
    this.pendingAppended = [];
    this.pendingEvicted = [];
    this.pendingChanges = new Set<DebugStoreChangeKind>();
    this.markChanged("clear");
    this.flush();
    return released;
  }

  /**
   * 暂停界面刷新（C.7 / F3 P0）：记录**照常入 store**，只是不发通知；
   * {@link resume} 立即补发全部待通知批次，恢复不丢数据。
   */
  public pause(): void {
    this.pausedValue = true;
  }

  public resume(): void {
    if (!this.pausedValue) {
      return;
    }

    this.pausedValue = false;
    this.flush();
  }

  public subscribe(listener: DebugStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 立即发出待通知批次（步进、清空、测试用；渲染节流的合批窗口被跳过）。 */
  public flush(): void {
    if (this.notifyTimer !== undefined) {
      this.clearTimer(this.notifyTimer);
      this.notifyTimer = undefined;
    }

    if (this.pausedValue || this.pendingChanges.size === 0) {
      return;
    }

    const notification: DebugStoreNotification = {
      instanceId: this.instanceId,
      category: this.category,
      changes: [...this.pendingChanges],
      appended: this.pendingAppended,
      evicted: this.pendingEvicted,
      cursor: this.cursor,
      bytes: this.bytesValue,
      recordCount: this.count,
      earliestPosition: this.evicted,
    };
    this.pendingAppended = [];
    this.pendingEvicted = [];
    this.pendingChanges = new Set<DebugStoreChangeKind>();

    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch (errorValue) {
        // 界面监听器抛错不得打断接收（与消费者隔离同一条纪律）。
        this.log(`[debug] store listener for '${this.instanceId}' threw: ${String(errorValue)}`);
      }
    }
  }

  public dispose(): void {
    if (this.notifyTimer !== undefined) {
      this.clearTimer(this.notifyTimer);
      this.notifyTimer = undefined;
    }

    this.disposed = true;
    this.listeners.clear();
    this.pendingAppended = [];
    this.pendingEvicted = [];
    this.pendingChanges.clear();
  }

  private recordAt(index: number): DebugRecord | undefined {
    if (index < 0 || index >= this.count || this.slots.length === 0) {
      return undefined;
    }

    return this.slots[(this.head + index) % this.slots.length];
  }

  /**
   * 环形缓冲按需翻倍（上限 `maxRecords`）。
   *
   * 之前构造时就 `new Array(maxRecords)`：默认 2 万槽 × 最多 32 实例 = 固定几 MB，而回看要给
   * `maxRecordsPerInstance` 传"回看预算"（20 万条）时，预分配会白占一大片内存（F5-07）。
   * 现在按实际记录数增长，回看才能安全地用与解码预算匹配的上限。
   */
  private ensureCapacity(): void {
    if (this.count < this.slots.length || this.slots.length >= this.limits.maxRecords) {
      return;
    }

    const nextLength = Math.min(
      this.limits.maxRecords,
      Math.max(DEBUG_STORE_INITIAL_RECORDS, this.slots.length * 2),
    );
    if (nextLength <= this.slots.length) {
      return;
    }

    const next = new Array<DebugRecord | undefined>(nextLength);
    for (let index = 0; index < this.count; index += 1) {
      next[index] = this.slots[(this.head + index) % this.slots.length];
    }

    this.slots = next;
    this.head = 0;
  }

  private dropOldest(): DebugRecord | undefined {
    if (this.count === 0 || this.slots.length === 0) {
      return undefined;
    }

    const record = this.recordAt(0);
    if (record === undefined) {
      return undefined;
    }

    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.slots.length;
    this.count -= 1;
    this.bytesValue -= record.wireBytes;
    this.evicted += 1;
    this.maxEvictedArrivalSeqValue = Math.max(this.maxEvictedArrivalSeqValue, record.arrivalSeq);

    // 游标落到已淘汰区间：夹到最早可用并标 partial（C.4，不重置）。
    if (this.cursorPosition < this.evicted) {
      this.cursorPosition = this.evicted;
      this.cursorPartial = true;
      this.pendingChanges.add("cursor");
    }

    return record;
  }

  private markChanged(kind: DebugStoreChangeKind): void {
    if (!this.disposed) {
      this.pendingChanges.add(kind);
    }

    if (this.pausedValue || this.disposed || this.notifyTimer !== undefined) {
      return;
    }

    if (this.listeners.size === 0) {
      // 没有监听者时不攒批次，避免长会话里无界堆积。
      this.pendingAppended = [];
      this.pendingEvicted = [];
      this.pendingChanges.clear();
      return;
    }

    if (this.limits.notifyThrottleMs <= 0) {
      this.flush();
      return;
    }

    this.notifyTimer = this.setTimer(() => {
      this.notifyTimer = undefined;
      this.flush();
    }, this.limits.notifyThrottleMs);
  }
}

/** 连续的相同帧号编一组（C.7）：同帧号不连续就是两帧，帧号回退/重复不重排。 */
export function groupRecordsByFrame(records: readonly DebugRecord[]): readonly (readonly DebugRecord[])[] {
  const groups: DebugRecord[][] = [];
  let currentFrame: number | undefined;
  let current: DebugRecord[] | undefined;
  for (const record of records) {
    if (current === undefined || record.frame !== currentFrame) {
      current = [];
      currentFrame = record.frame;
      groups.push(current);
    }

    current.push(record);
  }

  return groups;
}

function normalizeLimits(overrides: Partial<DebugStoreLimits> | undefined): DebugStoreLimits {
  const merged = { ...DEBUG_STORE_LIMITS, ...overrides };
  return {
    maxBytes: normalizePositiveInteger(merged.maxBytes, DEBUG_MAX_BYTES_PER_INSTANCE),
    maxRecords: normalizePositiveInteger(merged.maxRecords, DEBUG_MAX_RECORDS_PER_INSTANCE),
    keyframeIntervalBytes: normalizePositiveNumber(merged.keyframeIntervalBytes, DEBUG_KEYFRAME_INTERVAL_BYTES),
    keyframeIntervalRecords: normalizePositiveNumber(merged.keyframeIntervalRecords, DEBUG_KEYFRAME_INTERVAL_RECORDS),
    notifyThrottleMs: Number.isFinite(merged.notifyThrottleMs) && merged.notifyThrottleMs >= 0
      ? merged.notifyThrottleMs
      : DEBUG_NOTIFY_THROTTLE_MS,
  };
}
