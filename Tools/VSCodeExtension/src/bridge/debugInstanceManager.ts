/**
 * 调试实例生命周期与全局容量（附录 C.2/C.3/C.4）。
 *
 * 负责四件事：
 * 1. **实例表**：`debugCreate` 建实例、`debugFinish` 标结束；同一 `(category, instance)` 结束后
 *    再来 `Create` 是新的一条实例记录（旧的原样保留，C.3）；`Finish` 之后到达的 **数据帧一律丢弃**
 *    且**不得重建实例**（任务书 §评审清单 P0）。
 * 2. **记录先于 Create**：先暂存（最多 64 条或 1 s），超时按占位实例接收并标 `descriptorMissing`。
 * 3. **容量**：每实例上限交给 {@link DebugStore}；全局 128 MB 与实例数 32 在这里执行。
 *    实例数按**最后活跃时间**淘汰，选中实例受保护；被淘汰实例只抑制数据帧，
 *    `Create` / `Finish` / `frame` 照常处理，界面靠 `historyMissing` 标"历史未记录"。
 * 4. **存储与路由的顺序**：{@link DebugInstanceManager.ingest} 内固定为
 *    "先入 store → 再路由 → 最后捕获关键帧"。关键帧必须在**记录应用之后**捕获，
 *    否则重放会少一条（任务书 §评审清单 P1）。
 * 5. **关键帧回放按分类**：快照是分类主消费者的状态（`DebugKeyframeRegistry`），增量按
 *    **全局到达序** `arrivalSeq` 裁。同分类多实例交错时只补"同一实例的后续记录"会漏，
 *    因此 {@link DebugInstanceManager.replay} 的入参是 `category` 而不是实例键（评审 P1-2）。
 */

import type {
  DebugContractMethod,
  DebugContractParameter,
  DebugContractSnapshot,
  DebugContractWireType,
} from "./debugContractRegistry";
import type { DebugCreateEnvelope, DebugEnvelope, DebugEventEnvelope, DebugResultEnvelope } from "./debugIngress";
import type { DebugArg } from "./debugMessages";
import { DEBUG_KEYFRAME_MAX_PER_CATEGORY, DebugKeyframeRegistry } from "./debugKeyframe";
import { DebugRouter } from "./debugRouter";
import {
  DEBUG_KEYFRAME_INTERVAL_BYTES,
  DEBUG_KEYFRAME_INTERVAL_RECORDS,
  DEBUG_MAX_BYTES_PER_INSTANCE,
  DEBUG_MAX_RECORDS_PER_INSTANCE,
  DEBUG_NOTIFY_THROTTLE_MS,
  DebugStore,
  type DebugArgValue,
  type DebugCursorState,
  type DebugRecord,
  type DebugRecordInput,
} from "./debugStore";
import {
  compareText,
  defaultClearTimer,
  defaultSetTimer,
  normalizePositiveInteger,
  normalizePositiveNumber,
} from "./debugSupport";

/** 每实例 32 MB 的全局预算：128 MB（C.4）。 */
export const DEBUG_MAX_BYTES_GLOBAL = 128 * 1024 * 1024;

/** 实例数上限（按最后活跃时间淘汰，C.4）。 */
export const DEBUG_MAX_INSTANCES = 32;

/** 记录先于 `Create` 时的暂存条数上限（C.3）。 */
export const DEBUG_PENDING_RECORD_LIMIT = 64;

/** 记录先于 `Create` 时的暂存超时（C.3：1 s）。 */
export const DEBUG_PENDING_TIMEOUT_MS = 1_000;

/** 实例结束原因；`reconnect` / `disconnect` 由 F3/F5 的会话层赋值，F2 只产生前两个。 */
export type DebugInstanceEndReason = "finished" | "evicted" | "reconnect" | "disconnect";

/** 建实例的入参（`debugCreate` 的字段 + 来源标识）。 */
export interface DebugInstanceDescriptor {
  readonly category: string;
  readonly instanceId: string;
  readonly instanceSlot: number;
  readonly resName: string;
  readonly debugInfo: string;
}

/** 实例列表项（面板只读快照）。 */
export interface DebugInstanceView {
  readonly key: string;
  readonly category: string;
  readonly instanceId: string;
  readonly instanceSlot: number;
  readonly resName: string;
  readonly debugInfo: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly endedAt: number | undefined;
  readonly endedReason: DebugInstanceEndReason | undefined;
  /** 没收到 `Create` 就被超时接收的占位实例（C.3）。 */
  readonly descriptorMissing: boolean;
  /** 已被实例数上限淘汰：数据帧被抑制，界面标"历史未记录"（C.4）。 */
  readonly historyMissing: boolean;
  readonly selected: boolean;
  readonly active: boolean;
  readonly bytes: number;
  readonly recordCount: number;
  readonly cursor: DebugCursorState;
  readonly keyframeCount: number;
  readonly frame: number;
}

/**
 * 分类回放结果（F3 据此决定按钮状态与"partial"标注）。
 *
 * 回放**只重建消费者状态**（分类主消费者），不动实例游标——游标是"面板时间轴"的位置，
 * 由 F3 的步进驱动（`DebugStore.applyCursor/step`）。`applied` 是本次重新投递的记录条数，
 * 可能跨多个实例（同分类交错时）。
 */
export interface DebugCategoryReplayResult {
  readonly category: string;
  readonly fromKeyframe: boolean;
  readonly keyframeId: number | undefined;
  /** 增量起点：关键帧的全局到达序；从头重放为 0。 */
  readonly fromArrivalSeq: number;
  /** 增量里最后一条的全局到达序（没有增量为 `fromArrivalSeq`）。 */
  readonly toArrivalSeq: number;
  readonly applied: number;
  /** 回放存在空洞（关键帧之后的增量被淘汰，或过滤变化后的从头重放，C.4）。 */
  readonly partial: boolean;
}

/**
 * 实例级清空的结果（`DebugStore.clear()` 与**分类级**主消费者的边界说明）。
 *
 * - `releasedBytes`：该实例释放的字节数（全局记账由各 store 的 `bytes` 求和，无需另扣）；
 * - `categoryReset`：该分类已无任何剩余记录，因此顺带把分类主消费者重置成空——此时
 *   "清一个实例"与"清整个分类"的边界重合，重置没有额外副作用；
 * - `categoryStale`：同分类**还有别的实例记录**，主消费者状态仍是旧值（含被清空实例的内容）。
 *   宿主不在这里调用分类级 `replay`，由面板显式发起（`replayCategory`），并如实展示 `partial`。
 */
export interface DebugClearInstanceResult {
  readonly releasedBytes: number;
  readonly categoryReset: boolean;
  readonly categoryStale: boolean;
}

/** 实例上限（可注入；默认值即 C.4 的四道线上上限）。 */
export interface DebugInstanceManagerLimits {
  readonly maxInstances: number;
  readonly maxBytesGlobal: number;
  readonly maxBytesPerInstance: number;
  readonly maxRecordsPerInstance: number;
  readonly keyframeIntervalBytes: number;
  readonly keyframeIntervalRecords: number;
  /** 每个**分类**保留的关键帧个数（快照是分类级的，见 debugKeyframe.ts）。 */
  readonly keyframeMaxPerCategory: number;
  readonly notifyThrottleMs: number;
  readonly pendingRecordLimit: number;
  readonly pendingTimeoutMs: number;
}

export const DEBUG_INSTANCE_MANAGER_LIMITS: DebugInstanceManagerLimits = {
  maxInstances: DEBUG_MAX_INSTANCES,
  maxBytesGlobal: DEBUG_MAX_BYTES_GLOBAL,
  maxBytesPerInstance: DEBUG_MAX_BYTES_PER_INSTANCE,
  maxRecordsPerInstance: DEBUG_MAX_RECORDS_PER_INSTANCE,
  keyframeIntervalBytes: DEBUG_KEYFRAME_INTERVAL_BYTES,
  keyframeIntervalRecords: DEBUG_KEYFRAME_INTERVAL_RECORDS,
  keyframeMaxPerCategory: DEBUG_KEYFRAME_MAX_PER_CATEGORY,
  notifyThrottleMs: DEBUG_NOTIFY_THROTTLE_MS,
  pendingRecordLimit: DEBUG_PENDING_RECORD_LIMIT,
  pendingTimeoutMs: DEBUG_PENDING_TIMEOUT_MS,
};

/** 实例级计数（诊断 / 单测断言）。 */
export interface DebugInstanceManagerCounters {
  /** 当前保留的实例记录条数（含已结束、未淘汰的）。 */
  readonly instances: number;
  /** 被实例数上限淘汰后仍保留墓碑、只抑制数据帧的实例数。 */
  readonly suppressed: number;
  /** 当前暂存（还没等到 `Create`）的记录条数。 */
  readonly pendingRecords: number;
  /** 因超时/超长而按占位实例接收的次数。 */
  readonly placeholders: number;
  /** 其中由 1 s 超时触发的次数。 */
  readonly pendingTimeouts: number;
  /** 重复 `Create` 被忽略的次数（C.3：保留首次内容）。 */
  readonly duplicateCreates: number;
  /** `Finish` 之后到达的数据帧条数（不得重建实例）。 */
  readonly droppedAfterFinish: number;
  /** 被淘汰实例的数据帧条数（只抑制数据帧）。 */
  readonly droppedSuppressed: number;
  /** 无法确定实例身份而被丢弃的记录条数。 */
  readonly droppedWithoutIdentity: number;
  /** 全局 128 MB 上限触发的跨实例淘汰条数。 */
  readonly globalEvictions: number;
}

export interface DebugInstanceManagerOptions {
  readonly router?: DebugRouter;
  readonly now?: () => number;
  readonly limits?: Partial<DebugInstanceManagerLimits>;
  readonly log?: (message: string) => void;
  readonly setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** 初始过滤键（关键帧归属）；缺省空串。 */
  readonly filterKey?: string;
}

interface DebugInstanceEntry {
  readonly key: string;
  readonly order: number;
  readonly category: string;
  readonly instanceId: string;
  instanceSlot: number;
  resName: string;
  debugInfo: string;
  readonly createdAt: number;
  lastActiveAt: number;
  endedAt: number | undefined;
  endedReason: DebugInstanceEndReason | undefined;
  descriptorMissing: boolean;
  frame: number;
  readonly store: DebugStore;
}

interface DebugSuppressedInstance {
  readonly key: string;
  readonly category: string;
  readonly instanceId: string;
  readonly instanceSlot: number;
  readonly resName: string;
  readonly debugInfo: string;
  readonly createdAt: number;
  lastActiveAt: number;
  endedAt: number | undefined;
  endedReason: DebugInstanceEndReason | undefined;
  readonly descriptorMissing: boolean;
  readonly frame: number;
}

interface DebugPendingBucket {
  readonly category: string;
  readonly instanceId: string;
  readonly instanceSlot: number;
  readonly firstAt: number;
  /** 补投失败时会被截短（已投递的部分不再重放），其余字段不变。 */
  records: DebugRecordInput[];
  /**
   * 下一次可以尝试"建占位 + 补投"的时刻：正常是 `firstAt + pendingTimeoutMs`（C.3 的 1 s），
   * 补投失败后退避到 `now + pendingTimeoutMs`，避免 0 延迟自旋（评审 P2-b）。
   */
  nextAttemptAt: number;
}

/** 实例身份键：附录 C.3 的三元组去掉 `sessionId`（一个 manager 只属于一个会话）。 */
export function debugInstanceKey(category: string, instanceId: string): string {
  return `${category}\u0000${instanceId}`;
}

/**
 * 调试实例管理器。一个会话（一个窗口）一个实例；`reset()` 在真断开/新会话时调用
 * （15 s 内可恢复中断保留实例、记录与游标，C.3）。
 */
export class DebugInstanceManager {
  public readonly router: DebugRouter;
  /** 分类关键帧（快照属于分类主消费者，不是实例；见 debugKeyframe.ts）。 */
  public readonly keyframes: DebugKeyframeRegistry;

  private readonly limits: DebugInstanceManagerLimits;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly setTimer: (callback: () => void, timeoutMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /** 保留的实例记录（创建顺序），含已结束未淘汰的。 */
  private readonly entries: DebugInstanceEntry[] = [];
  /** 被实例数上限淘汰的墓碑（只抑制数据帧，仍接受 Finish）。 */
  private readonly suppressed = new Map<string, DebugSuppressedInstance>();
  private readonly pending = new Map<string, DebugPendingBucket>();
  /**
   * 已 `Finish` 的实例身份：之后到达的数据帧一律丢弃、**不得重建实例**
   * （任务书 §评审清单 P0）。`Create` 会让同一个身份重新可写（C.3 的复用同名 id）。
   */
  private readonly finished = new Set<string>();
  /**
   * 无分类 `Finish` 留下的 **id 级**抑制（二进制 `Finish` 不带分类，无从算身份键）：
   * `实例 id → 已被显式 `Create` 重新授权的分类集合`。
   *
   * `Finish` 只能整 id 抑制（它没说是哪个分类）；之后的 `Create` **只解禁它自己的分类**——
   * 否则任一分类型的 `Create` 都会拆掉所有分类的抑制，另一分类的同 id 记录会重新进暂存、
   * 1 s 后建出占位实例（评审 P2-a）。
   */
  private readonly finishedById = new Map<string, Set<string>>();

  /**
   * 分类级"主消费者状态已从头重建"闸门（评审第 4 轮 P1）。
   *
   * 关键帧只有在**当前主消费者确实看过该分类从头到现在的全部记录**时才完整：
   * - 缺省 `true`：新会话里消费者在第 1 条记录之前注册，状态天然完整；
   * - 换主消费者 ⇒ `false`（`DebugRouter.register` 不补投历史，新 facet 天生缺注册前的记录）；
   * - 换 `filterKey` ⇒ `false`（状态是按旧过滤建的）；
   * - 记录下界抬高（实例淘汰/逐条淘汰/clear）⇒ `false`（状态来源已不在可用窗口内）。
   *
   * 闸门为 `false` 时**不捕获关键帧**（否则会把"半截状态"当完整基线，回放标 `partial=false`
   * 却缺记录）；一次**成功的全量重放**（`resetMain` + 投完该分类全部可用记录）之后置回 `true`。
   * 不用 `replayPartial` 顶这个闸门：那是"数据缺失"信号，换主丢的是快照不是数据。
   */
  private readonly rebuilt = new Map<string, boolean>();

  private filterKeyValue = "";
  private currentFrameValue = -1;
  private selectedKeyValue: string | undefined;
  private orderCounter = 0;
  /** 全局应用序计数（真正写入 store 时递增，见 nextArrivalSeq）。 */
  private arrivalCounter = 0;
  /** 被淘汰实例带走的最大到达序（按分类），并入关键帧有效性判定。 */
  private readonly retiredMaxSeq = new Map<string, number>();
  /**
   * 每个分类的"已计入的下界"快照（`maxEvictedArrivalSeq` 的上一次观测值）。
   *
   * 用它判断"下界是否刚被抬高"，而不是在 append 里对单个分类前后各取一次：`enforceGlobalBytes`
   * 按全局最旧淘汰，可能淘汰**别的**分类的 store，那时被淘汰分类自己的 append 还没发生，
   * 前后对比永远相等（评审第 4 轮残留学例）。
   */
  private readonly categoryFloors = new Map<string, number>();
  /** 过滤变化后尚未重放的分类：下次分类回放标 `partial`（C.4）。 */
  private readonly replayPartial = new Set<string>();
  /**
   * "实例级清空"之后、尚未经过分类级回放的分类。
   *
   * `DebugStore.clear()` 的边界是**一个实例**，而 `DebugFacet` 是**分类级**的：宿主没有
   * "把某实例的贡献从 facet 状态里减掉"的 API（D.4 没有 reset/实例级事件）。因此清空一个实例后
   * 若同分类还有别的实例记录，主消费者状态**仍然是旧的**（多出已清空实例的内容），不能假装
   * 它已同步。这里只记"陈旧"，等面板显式发起分类级 `replay(category)` 再重建——**不在实例级
   * 操作里偷偷重建整个分类**（F3 评审转来的 P1；见 `clearInstance` 的注释）。
   *
   * **终止条件**（F4 返修 P1）：该分类**已没有任何可见记录**时，`settleStaleCategory` 直接结算
   * （重置主消费者并清掉标记）——与 `clearInstance` 的 `categoryReset` 分支是同一件事：
   * 分类就是空的，没有东西可重放。少了这一条，同分类剩余实例被淘汰后 `replay()` 会因
   * `stores.length === 0` 静默返回 `undefined`，界面永远卡在"等一次重建"上。
   */
  private readonly staleCategories = new Set<string>();
  private pendingTimer: unknown;
  private disposed = false;

  private placeholdersValue = 0;
  private pendingTimeoutsValue = 0;
  private duplicateCreatesValue = 0;
  private droppedAfterFinishValue = 0;
  private droppedSuppressedValue = 0;
  private droppedWithoutIdentityValue = 0;
  private globalEvictionsValue = 0;

  public constructor(options: DebugInstanceManagerOptions = {}) {
    this.router = options.router ?? new DebugRouter();
    this.keyframes = new DebugKeyframeRegistry(
      normalizePositiveInteger(options.limits?.keyframeMaxPerCategory ?? DEBUG_KEYFRAME_MAX_PER_CATEGORY, DEBUG_KEYFRAME_MAX_PER_CATEGORY),
    );
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.limits = normalizeManagerLimits(options.limits);
    this.filterKeyValue = options.filterKey ?? "";
    // 主消费者换人（facet 卸载/后注册者接位）⇒ 该分类的旧快照立刻作废，并关掉闸门：
    // `DebugRouter.register` 不补投历史，新 facet 天生缺注册前的记录，此时捕获的快照是"半截状态"。
    // 只丢快照、不标 `partial`：关键帧是加速手段而非数据，随后的全量重放在无淘汰时是完整的
    // （真丢了记录时 `maxEvictedArrivalSeq > 0` 会照实报 partial）。
    this.router.setOwnershipListener((category) => {
      this.keyframes.clear(category);
      if (this.hasCategoryRecords(category)) {
        this.rebuilt.set(category, false);
      }
    });
  }

  public get limitsSnapshot(): DebugInstanceManagerLimits {
    return this.limits;
  }

  /** 全局字节数：**唯一真源是各实例 store 的 `bytes` 之和**（没有第二份计数可算错）。 */
  public get totalBytes(): number {
    let total = 0;
    for (const entry of this.entries) {
      total += entry.store.bytes;
    }

    return total;
  }

  public get totalRecords(): number {
    let total = 0;
    for (const entry of this.entries) {
      total += entry.store.recordCount;
    }

    return total;
  }

  public get currentFrame(): number {
    return this.currentFrameValue;
  }

  public get filterKey(): string {
    return this.filterKeyValue;
  }

  public get selectedKey(): string | undefined {
    return this.selectedKeyValue;
  }

  public get counters(): DebugInstanceManagerCounters {
    let pendingRecords = 0;
    for (const bucket of this.pending.values()) {
      pendingRecords += bucket.records.length;
    }

    return {
      instances: this.entries.length,
      suppressed: this.suppressed.size,
      pendingRecords,
      placeholders: this.placeholdersValue,
      pendingTimeouts: this.pendingTimeoutsValue,
      duplicateCreates: this.duplicateCreatesValue,
      droppedAfterFinish: this.droppedAfterFinishValue,
      droppedSuppressed: this.droppedSuppressedValue,
      droppedWithoutIdentity: this.droppedWithoutIdentityValue,
      globalEvictions: this.globalEvictionsValue,
    };
  }

  /** 实例列表（创建顺序）：保留的实例 + 被淘汰的墓碑。 */
  public get instances(): readonly DebugInstanceView[] {
    const views: DebugInstanceView[] = [];
    for (const entry of this.entries) {
      views.push(this.viewOfEntry(entry));
    }

    for (const entry of this.suppressed.values()) {
      views.push(this.viewOfSuppressed(entry));
    }

    return views.sort(
      (left, right) => left.createdAt - right.createdAt
        || compareText(left.category, right.category)
        || compareText(left.instanceId, right.instanceId),
    );
  }

  public instance(key: string): DebugInstanceView | undefined {
    const entry = this.activeEntry(key) ?? this.entries.find((candidate) => candidate.key === key);
    if (entry !== undefined) {
      return this.viewOfEntry(entry);
    }

    const suppressedEntry = this.suppressed.get(key);
    return suppressedEntry === undefined ? undefined : this.viewOfSuppressed(suppressedEntry);
  }

  /** 该身份**当前活动**实例的 store（同名旧实例已结束时返回新实例的）。 */
  public storeFor(key: string): DebugStore | undefined {
    return this.activeEntry(key)?.store ?? this.entries.find((candidate) => candidate.key === key)?.store;
  }

  /**
   * 清空**一个实例**的已缓存记录（面板"清空"，C.7）。
   *
   * 为什么这里**不**调用分类级 `replay(category)`（F3 评审转来的 P1）：
   * - `DebugStore.clear()` 的身份是 `(category, instanceId)`，而 `replay` / `resetMain` 作用于
   *   **整个分类**（关键帧、主消费者都按分类归属，C.4/D.4）。在实例级操作里调它们，会顺带重建
   *   同分类的其它实例，并丢掉 `replay` 返回的 `partial`；
   * - `DebugFacet` 没有"移除某实例贡献"的 API（D.4 只有 `categories`/`onRecord`），所以正确的
   *   做法不是猜一个重建时机，而是：清掉该实例的记录 + **作废该分类的关键帧/闸门**（状态不可信）
   *   + 标记 `categoryStale`，等面板显式发起的分类级重建（`replayCategory`）。
   * - 同分类**没有**剩余记录时不变量退化成"分类就是空的"：此时重置主消费者是安全的，
   *   且不需要重放任何记录，所以 `categoryReset=true`。
   */
  public clearInstance(key: string): DebugClearInstanceResult | undefined {
    const entry = this.activeEntry(key) ?? this.entries.find((candidate) => candidate.key === key);
    if (entry === undefined) {
      return undefined;
    }

    const releasedBytes = entry.store.clear();
    const category = entry.category;
    // 记录离开可用窗口：分类级的"新消费者状态完整"闸门必须关掉，关键帧也不能再当基线。
    this.markCategoryDirty(category);
    if (!this.hasVisibleCategoryRecords(category)) {
      this.router.resetMain(category);
      this.rebuilt.set(category, true);
      // P2-7：`clear()` 抬高了该分类的淘汰下界，`noteCategoryFloors` 会在下一条 append 时据此
      // 再把闸门关回去，让上面这行 `rebuilt = true` 变成一次性的死代码（该分类本次会话再也不会
      // 捕获关键帧）。但这次下界抬高是**我们自己刚重置过的那次 clear** 带来的，主消费者状态
      // 已经是"空"——把它记成"已计入的下界"，下一条记录才不会误判成"状态来源已不在窗口内"。
      this.categoryFloors.set(category, this.maxEvictedArrivalSeq(category));
      this.staleCategories.delete(category);
      return { releasedBytes, categoryReset: true, categoryStale: false };
    }

    this.staleCategories.add(category);
    this.log(
      `[debug] cleared instance '${entry.instanceId}' (category '${category}'); the category main consumer is stale until an explicit category replay.`,
    );
    return { releasedBytes, categoryReset: false, categoryStale: true };
  }

  /** 该分类的主消费者是否因"实例级清空"而可能陈旧（等一次分类级 replay）。 */
  public isCategoryStale(category: string): boolean {
    return this.staleCategories.has(category);
  }

  /** 选中实例（受实例数上限保护）；`undefined` 取消选中。 */
  public select(key: string | undefined): void {
    this.selectedKeyValue = key;
  }

  /**
   * 过滤条件变化（C.4）：所有实例的关键帧失效、从头重放并标 `partial`。
   * 过滤本身的生效位置（服务端/客户端）不在 F2。
   *
   * 有记录的分类同时**关闸**：主消费者当前状态是按旧过滤建的，不能当新过滤的完整基线
   * （评审第 4 轮 P1）。没有记录的分类不关闸，否则它会永远等不到一次成功的重放而再也捕不到关键帧。
   */
  public setFilterKey(filterKey: string): void {
    if (filterKey === this.filterKeyValue) {
      return;
    }

    this.filterKeyValue = filterKey;
    // 不同 filterKey 的关键帧不采用：直接丢弃，避免重放用错基线（C.4）。
    this.keyframes.clear();
    for (const entry of this.entries) {
      entry.store.setFilterKey(filterKey);
      this.replayPartial.add(entry.category);
      if (entry.store.recordCount > 0) {
        this.rebuilt.set(entry.category, false);
      }
    }
  }

  /**
   * 建实例（`debugCreate` 的唯一入口）。重复 `Create` 保留首次内容；占位实例（`descriptorMissing`）
   * 收到迟到的 `Create` 时补齐描述；已结束的同名实例仍保留在列表里，新建一条（C.3）。
   */
  public create(descriptor: DebugInstanceDescriptor): DebugInstanceView {
    const key = debugInstanceKey(descriptor.category, descriptor.instanceId);
    const existing = this.activeEntry(key);
    if (existing !== undefined) {
      if (!existing.descriptorMissing) {
        this.duplicateCreatesValue += 1;
        this.log(`[debug] duplicate debugCreate for '${descriptor.instanceId}' ignored; the first descriptor stays (C.3).`);
        return this.viewOfEntry(existing);
      }

      existing.resName = descriptor.resName;
      existing.debugInfo = descriptor.debugInfo;
      if (Number.isInteger(descriptor.instanceSlot) && descriptor.instanceSlot > 0) {
        existing.instanceSlot = descriptor.instanceSlot;
      }

      existing.descriptorMissing = false;
      existing.lastActiveAt = this.now();
      return this.viewOfEntry(existing);
    }

    this.suppressed.delete(key);
    this.finished.delete(key);
    // 只解禁**本分类**：id 级抑制是整 id 的，其它分类的同 id 记录仍按 Finish 之后丢弃（评审 P2-a①）。
    this.releaseFinishedId(descriptor.category, descriptor.instanceId);
    const entry = this.openEntry(descriptor, false);
    this.drainPending(entry);
    return this.viewOfEntry(entry);
  }

  /**
   * 处理一条规范化包络（`DebugIngress` 的下游）。
   *
   * 顺序固定：记录先入 store、再路由、最后捕获关键帧（`appendRecord` 内）。
   * `contracts` 是产生该包络的契约快照（按连接绑定，C.8），只用于补 `named` 的默认值；
   * 热更新不回溯已产出的记录。
   */
  public ingest(envelope: DebugEnvelope, contracts?: DebugContractSnapshot): readonly DebugRecord[] {
    if (this.disposed) {
      return [];
    }

    this.expirePending();
    switch (envelope.type) {
      case "debugCreate":
        this.ingestCreate(envelope);
        return [];
      case "debugFinish":
        this.finish(envelope.category, envelope.instance);
        return [];
      case "debugFrame":
        // Frame 永不抑制（C.4）：被淘汰实例的连接也照常推进当前帧。
        this.currentFrameValue = envelope.frame;
        return [];
      case "debug":
      case "debugResult":
        return this.ingestRecord(envelope, contracts);
      default:
        return [];
    }
  }

  /**
   * 结束一个实例（`debugFinish`）：保留记录与游标，只标 `endedAt`。
   * `category` 缺省（二进制 `Finish` 不带分类）时按实例 id 找活动实例。
   * 返回是否命中了实例表（含墓碑与暂存）。
   */
  public finish(category: string | undefined, instanceId: string): boolean {
    this.expirePending();
    const now = this.now();
    if (category === undefined) {
      // 二进制 `Finish` 不带分类（`debugIngress` 的 category 缺省分支）：无从知道它属于哪个分类，
      // 于是**整 id 抑制**。仍在活动表里的同 id 实例不受影响（`ingestRecord` 先看 activeEntry），
      // 被挡住的是"以后重新进暂存、1 s 后建占位"这条路（评审 P2-1 / P2-a）。
      this.suppressInstanceId(instanceId);
      for (const [key, bucket] of [...this.pending]) {
        if (bucket.instanceId === instanceId) {
          this.pending.delete(key);
          this.finished.add(key);
          return true;
        }
      }

      const entry = this.entries.find((candidate) => candidate.instanceId === instanceId && candidate.endedAt === undefined);
      if (entry !== undefined) {
        entry.endedAt = now;
        entry.endedReason = "finished";
        entry.lastActiveAt = now;
        this.finished.add(entry.key);
        return true;
      }

      for (const suppressedEntry of this.suppressed.values()) {
        if (suppressedEntry.instanceId === instanceId && suppressedEntry.endedAt === undefined) {
          suppressedEntry.endedAt = now;
          suppressedEntry.endedReason = "finished";
          suppressedEntry.lastActiveAt = now;
          this.finished.add(suppressedEntry.key);
          return true;
        }
      }

      // 未命中：已经记过 id 级抑制了（见上方），这里只返回"没命中实例表"。
      return false;
    }

    const key = debugInstanceKey(category, instanceId);
    if (this.pending.delete(key)) {
      this.finished.add(key);
      return true;
    }

    const entry = this.activeEntry(key);
    if (entry !== undefined) {
      entry.endedAt = now;
      entry.endedReason = "finished";
      entry.lastActiveAt = now;
      this.finished.add(key);
      return true;
    }

    const suppressedEntry = this.suppressed.get(key);
    if (suppressedEntry !== undefined) {
      // 被淘汰实例的 Finish 照常生效（只是没有历史可看）。
      suppressedEntry.endedAt = now;
      suppressedEntry.endedReason = "finished";
      suppressedEntry.lastActiveAt = now;
      this.finished.add(key);
      return true;
    }

    // 未命中的 Finish 也留抑制标记：否则之后同身份的数据记录会走"记录先于 Create"暂存，
    // 1 s 后建出占位实例——那就是"Finish 之后重建实例"的一条旁路（评审 P2-5）。
    if (!this.finished.has(key)) {
      this.finished.add(key);
      this.log(`[debug] debugFinish for unknown instance '${instanceId}' (category '${category}'); later data records are suppressed.`);
    }

    return false;
  }

  /**
   * 处理到期的暂存批次（1 s，C.3）：超时即建占位实例并标 `descriptorMissing`。
   * 定时器会自动驱动；单测可传假时钟直接调用。
   */
  public expirePending(nowMs: number = this.now()): void {
    for (const [key, bucket] of [...this.pending]) {
      if (bucket.nextAttemptAt <= nowMs) {
        this.pendingTimeoutsValue += 1;
        this.materializePlaceholder(key);
      }
    }

    if (this.pending.size === 0) {
      this.clearPendingTimer();
    } else {
      this.schedulePendingTimer();
    }
  }

  /**
   * 从关键帧回放一个**分类**（C.4）：有可用关键帧就恢复分类主消费者的快照 + 按**全局到达序**
   * 补投该分类所有实例的增量；没有就重置主消费者、从最早可用记录全量重放。
   *
   * 语义（P1-2 的结论）：**关键帧属于分类主消费者，回放覆盖该分类在所有实例上的记录**。
   * 只重放给主消费者——观察者的通用视图可由 store 直接重建，不能重复喂。
   * 分类没有已注册的主消费者时返回 `undefined`（没有可重建的状态，也不去动观察者）。
   */
  public replay(category: string): DebugCategoryReplayResult | undefined {
    // 记录已全部离开可用窗口的陈旧分类先结算：`stale` 不能再挂到下一次真会话。
    this.settleStaleCategory(category);
    if (!this.router.hasOwner(category)) {
      return undefined;
    }

    const stores: DebugStore[] = [];
    for (const entry of this.entries) {
      if (entry.category === category) {
        stores.push(entry.store);
      }
    }

    if (stores.length === 0) {
      return undefined;
    }

    const maxEvicted = this.maxEvictedArrivalSeq(category);
    const keyframe = this.keyframes.latest(category, this.filterKeyValue, maxEvicted, this.router.ownerToken(category));
    let fromKeyframe = false;
    let fromArrivalSeq = 0;
    let partial = this.replayPartial.delete(category);
    if (keyframe !== undefined && this.router.restoreMainState(category, keyframe.state)) {
      fromKeyframe = true;
      fromArrivalSeq = keyframe.arrivalSeq;
    } else {
      // 没有可用基线：清空主消费者状态，从最早可用记录重放（C.4 的"从头重放"）。
      this.router.resetMain(category);
      partial = partial || maxEvicted > 0;
    }

    const increments: DebugRecord[] = [];
    for (const store of stores) {
      for (const record of store.records) {
        if (record.arrivalSeq > fromArrivalSeq) {
          increments.push(record);
        }
      }
    }

    increments.sort((left, right) => left.arrivalSeq - right.arrivalSeq);
    for (const record of increments) {
      this.router.replayToMain(record);
    }

    if (!fromKeyframe) {
      // 一次成功的全量重放（`resetMain` + 投完该分类所有可用记录）之后，主消费者状态重新完整，
      // 闸门打开——此后捕获的关键帧才可以当基线用（评审第 4 轮 P1）。
      this.rebuilt.set(category, true);
    }

    // 分类级重建覆盖了"实例级清空"留下的陈旧状态。
    this.staleCategories.delete(category);

    return {
      category,
      fromKeyframe,
      keyframeId: fromKeyframe && keyframe !== undefined ? keyframe.id : undefined,
      fromArrivalSeq,
      toArrivalSeq: increments.length > 0 ? (increments[increments.length - 1] as DebugRecord).arrivalSeq : fromArrivalSeq,
      applied: increments.length,
      partial,
    };
  }

  /** 该分类已淘汰记录的最大到达序（活实例 store 的淘汰 + 被淘汰实例带走的记录）。 */
  private maxEvictedArrivalSeq(category: string): number {
    let max = this.retiredMaxSeq.get(category) ?? 0;
    for (const entry of this.entries) {
      if (entry.category === category) {
        max = Math.max(max, entry.store.maxEvictedArrivalSeq);
      }
    }

    return max;
  }

  /** 该分类是否已经有记录进过 store（有记录才谈得上"新消费者缺历史"）。 */
  private hasCategoryRecords(category: string): boolean {
    if ((this.retiredMaxSeq.get(category) ?? 0) > 0) {
      return true;
    }

    for (const entry of this.entries) {
      if (entry.category === category && entry.store.recordCount > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * 该分类**当前可见**的 store 里是否还有记录（不含被淘汰实例带走的历史）。
   *
   * 两个使用方：内部 `clearInstance`/`settleStaleCategory` 判断"分类是否真的空了"；
   * facet 面板的 `rebuildable` 判断"按分类重建还有没有可重建的内容"（F4 返修 P2-1）。
   * 公开而不是另写一份判定：分类记录是否可见只有这一个真源。
   */
  public hasVisibleCategoryRecords(category: string): boolean {
    for (const entry of this.entries) {
      if (entry.category === category && entry.store.recordCount > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * 该分类是否还有 `replay()` 可用的数据源（F4 返修 P2-1）。
   *
   * `replay()` 从**活动实例的 store** 取记录；实例全被淘汰只剩墓碑时 `stores.length === 0`，
   * 调用直接返回 `undefined`。面板的 `rebuildable` 必须与这个前提一致，否则按钮点了没反应。
   * 记录维度复用 {@link hasVisibleCategoryRecords}，不新增第二套"有没有记录"的判定；
   * "记录先于 Create"的暂存批次也算——它们属于该分类，`Create` 到达后就会补进 store（C.3）。
   */
  public hasReplayableCategoryRecords(category: string): boolean {
    if (this.hasVisibleCategoryRecords(category)) {
      return true;
    }

    for (const bucket of this.pending.values()) {
      if (bucket.category === category && bucket.records.length > 0) {
        return true;
      }
    }

    return false;
  }

  /** 闸门是否打开（缺省打开：新会话里消费者在第 1 条记录之前注册，状态天然完整）。 */
  private isRebuilt(category: string): boolean {
    return this.rebuilt.get(category) ?? true;
  }

  /** 关闸 + 丢弃该分类的关键帧：状态不再可信，等一次成功的全量重放再开闸。 */
  private markCategoryDirty(category: string): void {
    this.rebuilt.set(category, false);
    this.keyframes.clear(category);
  }

  /**
   * `stale` 的终止条件（F4 返修 P1）：该分类**已没有任何可见记录**时结算成"不陈旧"。
   *
   * 理由：`stale` 的语义是"主消费者状态多出了已清空实例的内容"，它只在该分类还有别的记录、
   * 需要一次重建时才成立。记录全没了以后，重置主消费者与 `clearInstance` 的 `categoryReset`
   * 分支是同一件事（分类本来就是空的），继续挂着只会让界面永久停在"等一次重建"上：
   * 同分类剩余实例被实例数上限或全局字节上限淘汰后，`replay()` 因 `stores.length === 0`
   * 静默返回 `undefined`，没有任何用户可执行的出路。
   *
   * 同一次重置顺带把当前淘汰下界记成"已计入"，免得下一条记录到达时 `noteCategoryFloors`
   * 把刚刚修好的闸门又关回去（与 P2-7 同一个记账问题）。
   */
  private settleStaleCategory(category: string): boolean {
    if (!this.staleCategories.has(category) || this.hasVisibleCategoryRecords(category)) {
      return false;
    }

    this.router.resetMain(category);
    this.rebuilt.set(category, true);
    this.keyframes.clear(category);
    this.categoryFloors.set(category, this.maxEvictedArrivalSeq(category));
    this.staleCategories.delete(category);
    this.log(`[debug] category '${category}' has no records left; settling the stale marker by resetting its main consumer.`);
    return true;
  }

  /** 所有"记录已全部离开可用窗口"的陈旧分类都结算掉（淘汰路径调用）。 */
  private settleStaleCategories(): void {
    for (const category of [...this.staleCategories]) {
      this.settleStaleCategory(category);
    }
  }

  /**
   * 把所有分类的当前下界与上次观测值比一次：凡抬高的分类都清基线 + 关闸。
   *
   * "下界抬高 ⇒ 该分类关闸"必须对**所有**分类成立，而不是只看正在 append 的那个：
   * `enforceGlobalBytes()` 与 `retire()` 都按"全局最旧"淘汰，可能淘汰别的分类的 store；
   * 那个分类下次 append 时 `floorBefore` 早已是新值，前后一比永远相等，闸门就永远不会关
   * （评审第 4 轮残留学例：B 的基线里混着已不在可用窗口内的记录 ⇒ 回放结果是超集）。
   */
  private noteCategoryFloors(): void {
    const floors = new Map<string, number>();
    for (const entry of this.entries) {
      floors.set(entry.category, Math.max(floors.get(entry.category) ?? 0, entry.store.maxEvictedArrivalSeq));
    }

    for (const [category, retired] of this.retiredMaxSeq) {
      floors.set(category, Math.max(floors.get(category) ?? 0, retired));
    }

    for (const [category, floor] of floors) {
      if (floor > (this.categoryFloors.get(category) ?? 0)) {
        this.categoryFloors.set(category, floor);
        this.markCategoryDirty(category);
      }
    }
  }

  /** 登记一条无分类 `Finish`：整个实例 id 被抑制（尚未解禁任何分类）。 */
  private suppressInstanceId(instanceId: string): void {
    if (this.finishedById.has(instanceId)) {
      return;
    }

    this.finishedById.set(instanceId, new Set());
    this.log(`[debug] debugFinish for instance '${instanceId}' (no category); later data records of that id are suppressed for every category.`);
  }

  /** 该分类的同 id 记录是否仍被 id 级抑制（`Create` 只解禁它自己的分类）。 */
  private isFinishedById(category: string, instanceId: string): boolean {
    const released = this.finishedById.get(instanceId);
    return released !== undefined && !released.has(category);
  }

  /** 显式 `Create` 只给**它自己的分类**解禁这条 id 级抑制。 */
  private releaseFinishedId(category: string, instanceId: string): void {
    this.finishedById.get(instanceId)?.add(category);
  }

  /**
   * 可恢复中断（C.3）：把此前活跃、重连后还没再出现的旧实例标 `endedAt` + `reconnect`，
   * 让它们退出活动表。运行时随后重新 `debugCreate` 同一 ID 时，`create()` 找不到活动实例，
   * 于是**新建一条实例记录**（旧记录原样保留）；不标结束就会把新记录并进旧记录、误计重复 Create。
   *
   * 返回被标结束的实例数。一个 manager 只属于一个窗口/会话，因此"本连接此前活跃"就是
   * 当前活动表里的全部实例（调试连接同一时刻只有一条，E5）。
   */
  public reconnect(): number {
    const now = this.now();
    let ended = 0;
    for (const entry of this.entries) {
      if (entry.endedAt === undefined) {
        entry.endedAt = now;
        entry.endedReason = "reconnect";
        ended += 1;
      }
    }

    for (const entry of this.suppressed.values()) {
      if (entry.endedAt === undefined) {
        entry.endedAt = now;
        entry.endedReason = "reconnect";
        ended += 1;
      }
    }

    if (ended > 0) {
      this.log(`[debug] resumed session: ${ended} instance record(s) ended with reason 'reconnect' (C.3).`);
    }

    return ended;
  }

  /** 新会话 / 真断开：清空实例、墓碑、暂存、计数器与消费者状态（C.3）。 */
  public reset(): void {
    this.clearPendingTimer();
    for (const entry of this.entries) {
      entry.store.dispose();
    }

    this.entries.length = 0;
    this.suppressed.clear();
    this.pending.clear();
    this.finished.clear();
    this.finishedById.clear();
    this.rebuilt.clear();
    this.keyframes.reset();
    this.retiredMaxSeq.clear();
    this.categoryFloors.clear();
    this.replayPartial.clear();
    this.staleCategories.clear();
    this.arrivalCounter = 0;
    this.currentFrameValue = -1;
    this.selectedKeyValue = undefined;
    this.orderCounter = 0;
    this.placeholdersValue = 0;
    this.pendingTimeoutsValue = 0;
    this.duplicateCreatesValue = 0;
    this.droppedAfterFinishValue = 0;
    this.droppedSuppressedValue = 0;
    this.droppedWithoutIdentityValue = 0;
    this.globalEvictionsValue = 0;
    this.router.reset();
  }

  public dispose(): void {
    this.disposed = true;
    this.clearPendingTimer();
    for (const entry of this.entries) {
      entry.store.dispose();
    }
  }

  private ingestCreate(envelope: DebugCreateEnvelope): void {
    this.create({
      category: envelope.category,
      instanceId: envelope.instance,
      instanceSlot: envelope.instanceSlot,
      resName: envelope.resName,
      debugInfo: envelope.debugInfo,
    });
  }

  private ingestRecord(
    envelope: DebugEventEnvelope | DebugResultEnvelope,
    contracts: DebugContractSnapshot | undefined,
  ): readonly DebugRecord[] {
    const input = this.buildRecord(envelope, contracts);
    if (input === undefined) {
      return [];
    }

    const key = debugInstanceKey(input.category, input.instanceId);
    const entry = this.activeEntry(key);
    if (entry !== undefined) {
      const record = this.appendRecord(entry, input);
      return record === undefined ? [] : [record];
    }

    if (this.finished.has(key) || this.isFinishedById(input.category, input.instanceId)) {
      // P0：Finish 之后到达的记录不得重建实例，也不得回到暂存里等 1 s 复活。
      this.droppedAfterFinishValue += 1;
      return [];
    }

    if (this.suppressed.has(key)) {
      // 被淘汰实例只抑制数据帧（C.4）。
      this.droppedSuppressedValue += 1;
      return [];
    }

    // 记录先于 Create：暂存（C.3）。超时由 expirePending 建占位实例。
    let bucket = this.pending.get(key);
    if (bucket === undefined) {
      bucket = {
        category: input.category,
        instanceId: input.instanceId,
        instanceSlot: this.slotOf(envelope),
        firstAt: input.receivedAt,
        records: [],
        nextAttemptAt: input.receivedAt + this.limits.pendingTimeoutMs,
      };
      this.pending.set(key, bucket);
      this.schedulePendingTimer();
    }

    if (bucket.records.length >= this.limits.pendingRecordLimit) {
      // 已达 64 条：先按占位实例接收，本条随后走正常路径入 store。
      this.materializePlaceholder(key);
      const materialized = this.activeEntry(key);
      if (materialized === undefined) {
        return [];
      }

      const record = this.appendRecord(materialized, input);
      return record === undefined ? [] : [record];
    }

    bucket.records.push(input);
    return [];
  }

  /**
   * 暂存批次 → 占位实例（`descriptorMissing`）：按到达顺序补入 store 并路由。
   * 若同键实例已经存在（补投失败后被重试），直接补进已有实例，绝不重复建实例。
   */
  private materializePlaceholder(key: string): DebugInstanceEntry | undefined {
    const bucket = this.pending.get(key);
    if (bucket === undefined) {
      return undefined;
    }

    const existing = this.activeEntry(key);
    if (existing !== undefined) {
      this.drainPending(existing);
      return existing;
    }

    this.placeholdersValue += 1;
    const entry = this.openEntry(
      {
        category: bucket.category,
        instanceId: bucket.instanceId,
        instanceSlot: bucket.instanceSlot,
        resName: "",
        debugInfo: "",
      },
      true,
    );
    // 暂存批次由 `drainPending` 在投递成功后删除（失败时留下剩余记录，见评审 P2-4）。
    this.drainPending(entry);
    return entry;
  }

  /**
   * 把暂存记录补投进 `entry`：**投递成功后才从暂存里删**。
   *
   * 单条补投抛错时只丢掉已成功的那部分（按"这条是否真的写进了 store"判定，避免重复投递），
   * 剩余记录留在暂存里等重试——否则 `create()` 先 `delete bucket` 会把余下的记录整批丢掉（评审 P2-4）。
   */
  private drainPending(entry: DebugInstanceEntry): void {
    const bucket = this.pending.get(entry.key);
    if (bucket === undefined) {
      return;
    }

    if (bucket.records.length === 0) {
      this.pending.delete(entry.key);
      if (this.pending.size === 0) {
        this.clearPendingTimer();
      }

      return;
    }

    let index = 0;
    while (index < bucket.records.length) {
      const before = entry.store.recordCount;
      try {
        // 暂存记录先于 Create 到达：按到达顺序补入 store（顺序即时间轴）。
        this.appendRecord(entry, bucket.records[index] as DebugRecordInput);
        index += 1;
      } catch (errorValue) {
        const written = entry.store.recordCount > before;
        const remaining = bucket.records.length - index - (written ? 1 : 0);
        this.log(
          `[debug] replaying a staged record for '${entry.instanceId}' failed${written ? " after it was stored" : ""}; ${remaining} record(s) stay staged: ${String(errorValue)}`,
        );
        index += written ? 1 : 0;
        bucket.records = bucket.records.slice(index);
        // 退避到"一个占位超时"之后：`nextAttemptAt` 若仍停在过去，`schedulePendingTimer` 会算出 0 延迟，
        // 在 append 持久抛错时变成自旋（评审 P2-b）。
        bucket.nextAttemptAt = this.now() + this.limits.pendingTimeoutMs;
        this.clearPendingTimer();
        this.schedulePendingTimer();
        return;
      }
    }

    this.pending.delete(entry.key);
    if (this.pending.size === 0) {
      this.clearPendingTimer();
    }
  }

  /**
   * 入 store → 淘汰/结算 → 路由 → 关键帧（顺序固定）。
   *
   * F4 返修 P2-2：自动结算必须在 `dispatch` **之前**。一个 facet 可以同时认领多个分类，
   * 这些分类共享同一个 `ModuleDebugFacetConsumer`；结算兄弟分类时 `resetMain` 会 reset
   * 这个共享消费者（`reset()` 清 pending/content/delivered）。若结算发生在 `dispatch`
   * 之后（旧位置），刚入队的当前记录会被清掉，且 `captureKeyframe` 看到 `pending == 0`
   * 而捕获一份"空状态"基线。移到 `dispatch` 之前后：结算只可能发生在当前记录入队前，
   * 队列不会被清空；随后 `captureState` 也能看到 `pending > 0` 而拒绝捕获不完整快照。
   *
   * 淘汰（`enforceGlobalBytes`）也在 `dispatch` 之前：结算判据依赖"该分类已无可见记录"，
   * 而这一轮的淘汰正是把兄弟分类清空的原因；先淘汰再结算，本轮就能观察到该事实。
   * 记录仍会投递（`dispatch` 用的是 append 返回的记录对象），与旧顺序的投递结果一致。
   */
  private appendRecord(entry: DebugInstanceEntry, input: DebugRecordInput): DebugRecord | undefined {
    const record = entry.store.append(input);
    if (record === undefined) {
      return undefined;
    }

    entry.lastActiveAt = record.receivedAt;
    entry.frame = record.frame;
    this.enforceGlobalBytes();
    // 淘汰可能落在**别的**分类上，所以按分类全量比一次；关闸必须在捕获之前。
    this.noteCategoryFloors();
    // 逐条淘汰可能把某个陈旧分类的最后记录也带走（F4 返修 P1 的死角 b）。
    this.settleStaleCategories();
    this.router.dispatch(record);
    if (entry.store.takeKeyframeTrigger()) {
      this.captureKeyframe(entry, record);
    }

    return record;
  }

  /**
   * 捕获分类关键帧。三个前提：
   * - 闸门打开（`rebuilt === true`）：主消费者状态是从头重建的完整状态，不是"半截状态"；
   * - 主消费者支持并成功 `captureState`（拿不到就不入表，免得白占 64 个名额）；
   * - `filterKey`、消费者身份都在**当前时刻**取：关键帧属于分类主消费者，不属于实例。
   */
  private captureKeyframe(entry: DebugInstanceEntry, record: DebugRecord): void {
    if (!this.isRebuilt(entry.category)) {
      return;
    }

    const state = this.router.captureMainState(entry.category);
    if (state === undefined) {
      return;
    }

    this.keyframes.capture({
      category: entry.category,
      consumerToken: this.router.ownerToken(entry.category),
      consumerLabel: this.router.ownerLabel(entry.category) ?? "consumer",
      filterKey: this.filterKeyValue,
      instanceKey: entry.key,
      instanceId: entry.instanceId,
      position: entry.store.endPosition,
      arrivalSeq: record.arrivalSeq,
      bytes: entry.store.bytes,
      state,
    });
  }

  /** 全局 128 MB 硬上限：跨实例淘汰**最旧记录**，直到 Σ bytes 回到上限内。 */
  private enforceGlobalBytes(): void {
    let total = this.totalBytes;
    while (total > this.limits.maxBytesGlobal) {
      const store = this.oldestStore();
      if (store === undefined) {
        return;
      }

      const evicted = store.evictOldest();
      if (evicted === undefined) {
        return;
      }

      total -= evicted.wireBytes;
      this.globalEvictionsValue += 1;
    }
  }

  /**
   * 最旧记录所在的实例 store：先比 `receivedAt`，同一毫秒再比**全局到达序**
   * （`arrivalSeq` 跨实例唯一，因此淘汰顺序与"记录真正到达的先后"完全一致、可确定）。
   */
  private oldestStore(): DebugStore | undefined {
    let best: { readonly store: DebugStore; readonly receivedAt: number; readonly arrivalSeq: number } | undefined;
    for (const entry of this.entries) {
      const oldest = entry.store.oldest();
      if (oldest === undefined) {
        continue;
      }

      if (
        best === undefined
        || oldest.receivedAt < best.receivedAt
        || (oldest.receivedAt === best.receivedAt && oldest.arrivalSeq < best.arrivalSeq)
      ) {
        best = { store: entry.store, receivedAt: oldest.receivedAt, arrivalSeq: oldest.arrivalSeq };
      }
    }

    return best?.store;
  }

  private buildRecord(
    envelope: DebugEventEnvelope | DebugResultEnvelope,
    contracts: DebugContractSnapshot | undefined,
  ): DebugRecordInput | undefined {
    const category = envelope.category ?? "";
    const instanceId = envelope.instance !== undefined && envelope.instance.length > 0
      ? envelope.instance
      : this.slotPlaceholderId(envelope.instanceSlot);
    if (instanceId === undefined) {
      this.droppedWithoutIdentityValue += 1;
      this.log(`[debug] dropped a ${envelope.type} record: neither instance nor instanceSlot is known`);
      return undefined;
    }

    const methodId = envelope.methodId > 0 ? envelope.methodId : undefined;
    const declaration = contracts?.resolveMessage(category, methodId, envelope.interfaceId, envelope.method).declaration;
    return {
      kind: "event",
      category,
      interfaceId: envelope.interfaceId ?? "",
      instanceId,
      method: envelope.method ?? "",
      args: toArgumentMap(envelope.args),
      named: buildNamedArguments(envelope.args, declaration),
      frame: envelope.frame,
      wireBytes: envelope.wireBytes,
      receivedAt: this.now(),
      contractState: envelope.contractState,
    };
  }

  /**
   * 全局应用序：单调递增、跨实例唯一。
   *
   * **只在真正写入 store 时分配**（`DebugStore.append` 调它，见 `openEntry` 的注入）：
   * 若在 `buildRecord` 里预先分配，"记录先于 Create 暂存"的记录会带着一个比之后捕获的关键帧
   * 更小的序号，回放的增量过滤会把它静默丢掉（F2 评审第三轮 P1）。因此本计数器的递增顺序
   * **就是**记录进入 store 的顺序——"分配序 == 应用序"。
   */
  private nextArrivalSeq(): number {
    this.arrivalCounter += 1;
    return this.arrivalCounter;
  }

  private slotPlaceholderId(instanceSlot: number): string | undefined {
    return Number.isInteger(instanceSlot) && instanceSlot > 0 ? `slot#${instanceSlot}` : undefined;
  }

  private slotOf(envelope: DebugEventEnvelope | DebugResultEnvelope): number {
    return Number.isInteger(envelope.instanceSlot) && envelope.instanceSlot > 0 ? envelope.instanceSlot : 0;
  }

  private openEntry(descriptor: DebugInstanceDescriptor, descriptorMissing: boolean): DebugInstanceEntry {
    this.enforceInstanceLimit();
    const timestamp = this.now();
    this.orderCounter += 1;
    const entry: DebugInstanceEntry = {
      key: debugInstanceKey(descriptor.category, descriptor.instanceId),
      order: this.orderCounter,
      category: descriptor.category,
      instanceId: descriptor.instanceId,
      instanceSlot: descriptor.instanceSlot,
      resName: descriptor.resName,
      debugInfo: descriptor.debugInfo,
      createdAt: timestamp,
      lastActiveAt: timestamp,
      endedAt: undefined,
      endedReason: undefined,
      descriptorMissing,
      frame: this.currentFrameValue,
      store: new DebugStore({
        instanceId: descriptor.instanceId,
        category: descriptor.category,
        limits: {
          maxBytes: this.limits.maxBytesPerInstance,
          maxRecords: this.limits.maxRecordsPerInstance,
          keyframeIntervalBytes: this.limits.keyframeIntervalBytes,
          keyframeIntervalRecords: this.limits.keyframeIntervalRecords,
          notifyThrottleMs: this.limits.notifyThrottleMs,
        },
        filterKey: this.filterKeyValue,
        // 全局应用序分配器：seq 在 `append` 写入瞬间分配，外部无法自带（评审 P1 / P2-7）。
        nextArrivalSeq: () => this.nextArrivalSeq(),
        now: this.now,
        log: this.log,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
      }),
    };
    this.entries.push(entry);
    return entry;
  }

  /** 实例数上限：超了就先淘汰，再建新的（选中实例受保护）。 */
  private enforceInstanceLimit(): void {
    while (this.entries.length >= this.limits.maxInstances) {
      const victim = this.evictionVictim();
      if (victim === undefined) {
        return;
      }

      this.retire(victim);
    }
  }

  private evictionVictim(): DebugInstanceEntry | undefined {
    let victim: DebugInstanceEntry | undefined;
    for (const entry of this.entries) {
      if (entry.key === this.selectedKeyValue) {
        continue;
      }

      if (victim === undefined || entry.lastActiveAt < victim.lastActiveAt
        || (entry.lastActiveAt === victim.lastActiveAt && entry.order < victim.order)) {
        victim = entry;
      }
    }

    return victim;
  }

  /** 淘汰实例：保留墓碑（只抑制数据帧），记录与字节随 store 一起丢弃。 */
  private retire(entry: DebugInstanceEntry): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }

    // 整个实例的记录都没了：该分类关键帧的增量下限抬到"被带走的最大到达序"。
    let lost = entry.store.maxEvictedArrivalSeq;
    for (const record of entry.store.records) {
      lost = Math.max(lost, record.arrivalSeq);
    }

    if (lost > 0) {
      this.retiredMaxSeq.set(entry.category, Math.max(this.retiredMaxSeq.get(entry.category) ?? 0, lost));
      // 整个实例被淘汰 = 该分类下界抬高 ⇒ 主消费者状态不再等于"可用窗口内的全量重放"，关闸。
      this.noteCategoryFloors();
    }

    // 被淘汰的可能是该分类最后一个还有记录的实例：此时"陈旧"的前提消失，必须结算（F4 返修 P1 b）。
    this.settleStaleCategories();

    entry.store.dispose();
    this.suppressed.set(entry.key, {
      key: entry.key,
      category: entry.category,
      instanceId: entry.instanceId,
      instanceSlot: entry.instanceSlot,
      resName: entry.resName,
      debugInfo: entry.debugInfo,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      endedAt: entry.endedAt,
      endedReason: entry.endedReason,
      descriptorMissing: entry.descriptorMissing,
      frame: entry.frame,
    });
    while (this.suppressed.size > this.limits.maxInstances) {
      const oldestKey = this.suppressed.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }

      this.suppressed.delete(oldestKey);
    }

    this.log(`[debug] instance '${entry.instanceId}' evicted by the ${this.limits.maxInstances}-instance limit; data frames are suppressed but Create/Finish/frame still apply.`);
  }

  private activeEntry(key: string): DebugInstanceEntry | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry !== undefined && entry.key === key && entry.endedAt === undefined) {
        return entry;
      }
    }

    return undefined;
  }

  private schedulePendingTimer(): void {
    if (this.pendingTimer !== undefined || this.pending.size === 0 || this.disposed) {
      return;
    }

    let deadline = Number.POSITIVE_INFINITY;
    for (const bucket of this.pending.values()) {
      deadline = Math.min(deadline, bucket.nextAttemptAt);
    }

    if (!Number.isFinite(deadline)) {
      return;
    }

    const delay = Math.max(0, deadline - this.now());
    this.pendingTimer = this.setTimer(() => {
      this.pendingTimer = undefined;
      this.expirePending();
    }, delay);
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== undefined) {
      this.clearTimer(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }

  private viewOfEntry(entry: DebugInstanceEntry): DebugInstanceView {
    return {
      key: entry.key,
      category: entry.category,
      instanceId: entry.instanceId,
      instanceSlot: entry.instanceSlot,
      resName: entry.resName,
      debugInfo: entry.debugInfo,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      endedAt: entry.endedAt,
      endedReason: entry.endedReason,
      descriptorMissing: entry.descriptorMissing,
      historyMissing: false,
      selected: entry.key === this.selectedKeyValue,
      active: entry.endedAt === undefined,
      bytes: entry.store.bytes,
      recordCount: entry.store.recordCount,
      cursor: entry.store.cursor,
      keyframeCount: this.keyframes.count(entry.category),
      frame: entry.store.newest()?.frame ?? entry.frame,
    };
  }

  private viewOfSuppressed(entry: DebugSuppressedInstance): DebugInstanceView {
    return {
      key: entry.key,
      category: entry.category,
      instanceId: entry.instanceId,
      instanceSlot: entry.instanceSlot,
      resName: entry.resName,
      debugInfo: entry.debugInfo,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      endedAt: entry.endedAt,
      endedReason: entry.endedReason,
      descriptorMissing: entry.descriptorMissing,
      historyMissing: true,
      selected: entry.key === this.selectedKeyValue,
      active: entry.endedAt === undefined,
      bytes: 0,
      recordCount: 0,
      cursor: { position: 0, partial: false },
      // 关键帧是分类级的：墓碑也能看到所属分类还有几个基线可用。
      keyframeCount: this.keyframes.count(entry.category),
      frame: entry.frame,
    };
  }
}

/** `tag → 值`：保留到达顺序，重复 tag 取最后一条（与 JSON 数组语义一致）。 */
function toArgumentMap(args: readonly DebugArg[]): ReadonlyMap<number, DebugArgValue> {
  const map = new Map<number, DebugArgValue>();
  for (const arg of args) {
    map.set(arg.tag, arg);
  }

  return map;
}

/**
 * `参数名 → 值` 的完整表（C.2）：契约声明过的参数全部在表内，缺省的按类型默认值补齐
 * （B.2/B.3：稀疏载荷只带非默认参数）。契约缺失/未命中时为空 Map。
 */
function buildNamedArguments(
  args: readonly DebugArg[],
  declaration: DebugContractMethod | undefined,
): ReadonlyMap<string, DebugArgValue> {
  const named = new Map<string, DebugArgValue>();
  if (declaration === undefined) {
    return named;
  }

  const arrived = toArgumentMap(args);
  for (const parameter of declaration.parameters) {
    named.set(parameter.name, arrived.get(parameter.tag) ?? defaultArgument(parameter));
  }

  const result = declaration.result;
  if (result !== undefined) {
    named.set(result.name, arrived.get(result.tag) ?? defaultArgument(result));
  }

  return named;
}

function defaultArgument(parameter: DebugContractParameter): DebugArgValue {
  return {
    tag: parameter.tag,
    name: parameter.name,
    type: parameter.wireType,
    value: defaultValueForWireType(parameter.wireType),
  };
}

/**
 * 类型默认值（B.2：`false` / `0` / `""` / 空 `byte[]`；`byte[]` 的线上表示是 base64 串，
 * 因此空数组就是空串；浮点的默认值是 `+0.0`，-0.0 会照常写出）。
 */
function defaultValueForWireType(wireType: DebugContractWireType): unknown {
  switch (wireType) {
    case "bool":
      return false;
    case "int":
    case "long":
    case "ulong":
    case "float":
    case "double":
    case "enum":
      return 0;
    case "string":
    case "byte[]":
      return "";
    default:
      return undefined;
  }
}

function normalizeManagerLimits(overrides: Partial<DebugInstanceManagerLimits> | undefined): DebugInstanceManagerLimits {
  const merged = { ...DEBUG_INSTANCE_MANAGER_LIMITS, ...overrides };
  return {
    maxInstances: normalizePositiveInteger(merged.maxInstances, DEBUG_MAX_INSTANCES),
    maxBytesGlobal: normalizePositiveInteger(merged.maxBytesGlobal, DEBUG_MAX_BYTES_GLOBAL),
    maxBytesPerInstance: normalizePositiveInteger(merged.maxBytesPerInstance, DEBUG_MAX_BYTES_PER_INSTANCE),
    maxRecordsPerInstance: normalizePositiveInteger(merged.maxRecordsPerInstance, DEBUG_MAX_RECORDS_PER_INSTANCE),
    keyframeIntervalBytes: normalizePositiveNumber(merged.keyframeIntervalBytes, DEBUG_KEYFRAME_INTERVAL_BYTES),
    keyframeIntervalRecords: normalizePositiveNumber(merged.keyframeIntervalRecords, DEBUG_KEYFRAME_INTERVAL_RECORDS),
    keyframeMaxPerCategory: normalizePositiveInteger(merged.keyframeMaxPerCategory, DEBUG_KEYFRAME_MAX_PER_CATEGORY),
    notifyThrottleMs: Number.isFinite(merged.notifyThrottleMs) && merged.notifyThrottleMs >= 0
      ? merged.notifyThrottleMs
      : DEBUG_NOTIFY_THROTTLE_MS,
    pendingRecordLimit: normalizePositiveInteger(merged.pendingRecordLimit, DEBUG_PENDING_RECORD_LIMIT),
    pendingTimeoutMs: normalizePositiveInteger(merged.pendingTimeoutMs, DEBUG_PENDING_TIMEOUT_MS),
  };
}
