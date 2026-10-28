/**
 * 客户端查询挂起表（附录 A.5/A.6、E6）：`requestId`（`req-<n>` ↔ `u32`）的分配与回收、
 * 并发上限 8、总超时 8 s、晚到结果丢弃。
 *
 * 职责边界（刻意保持纯模块，不做接线）：
 * - 只记账「请求 ↔ 应答」与超时，不碰线上编解码（`debugMessages` 负责）与 UI / 记录存储（F6）；
 * - **不**在内部构造 `DebugIngress`：挂起表由 F6 注入解码上下文（`isPendingRequest` / `isKnownRequest`），
 *   注入点归 F6（F1 已把「缺表」改成 `ambiguousEnvelope`，不得退回旧行为）；
 * - 时钟与定时器都可注入，单测不需要真实等待 8 s。
 *
 * `u32` 回绕（评审 P0）：序号单调自增，只在**回绕后**从头找号，并跳过仍挂起或仍在作废表里的号。
 * 在途最多 8 条、作废表最多 4104 条（8 + 4096），因此回绕后最多探测这么多次就必得空号——
 * 要串号得先分配满 2^32 次。
 *
 * 作废表按**时间**保留（F6 收敛轮 P2-1）：条目上限 64 会被 8 并发的自动循环在几十秒内挤爆，
 * 被挤出的号迟到的二进制 `debugResult` 会被当成"自发 `debug`"解出垃圾参数并插入时间轴。
 * 改为 `expireAt = 结算时刻 + 60 s`，TTL 内一律识别为 `late`（丢弃 + 计数 + warning），
 * 只有 TTL 之后才不再识别（见 {@link DEBUG_QUERY_RETIRED_TTL_MS}）。
 *
 * **协议没有类型位导致的固有歧义**（本次不修协议，只写清）：自发 `debug` 帧没有 `requestId`，
 * 解码器用"`payload` offset 4 处的 `u32` 是否命中 live/retired"来判别 `debug` 与 `debugResult`。
 * 因此理论上存在"自发事件的前 4 字节恰好等于某个存活请求号 ⇒ 被误判成结果"的可能，
 * 概率约为（在途 + TTL 内作废号数）/ 2^32；它只能靠协议加类型位消除。
 */

import type { DebugArg, DebugRequestMessage } from "./debugMessages";

/** 在途查询上限（附录 A.6/B.6；与 F6 对齐）。 */
export const MAX_PENDING_QUERIES = 8;

/** 客户端总超时：服务端最坏 2 s 排队 + 3 s 执行，留网络余量（附录 A.5）。 */
export const QUERY_TIMEOUT_MS = 8000;

/**
 * 作废请求号的保留时长（F6 收敛轮 P2-1）。
 *
 * 依据：客户端总超时 8 s（{@link QUERY_TIMEOUT_MS}），服务端最坏 2 s 排队 + 3 s 执行，
 * 因此**迟到结果应在超时后 1–2 s 内到达**；60 s 比这个上限大一个数量级以上，留足重传/排程余量。
 * TTL 内到达的结果必须被识别为 `late`（丢弃 + 计数），**绝不解码成事件**。
 */
export const DEBUG_QUERY_RETIRED_TTL_MS = 60_000;

/**
 * 作废请求号的安全上限（防无界增长；正常速率下达不到）。
 *
 * 8 并发、8 s 超时的极端自动循环每秒最多收敛约 1 条，60 s TTL 内约 60 条，远小于 4096。
 * 真正超限时：先惰性清理过期项；若全部未过期，淘汰最旧的一条并**如实记日志**（不静默）。
 */
export const MAX_RETIRED_REQUEST_IDS = 4096;

const MAX_REQUEST_SEQ = 0xffffffff;

/** 一条在途查询。 */
export interface PendingDebugQuery {
  readonly requestId: string;
  /** 线上/二进制共用的方法号（`req-<n>` 里的 n 与二进制的 `u32 requestId` 同源）。 */
  readonly requestSeq: number;
  readonly category: string | undefined;
  readonly instance: string;
  readonly iface: string | undefined;
  readonly method: string | undefined;
  readonly methodId: number;
  /** 绝对截止时刻（注入时钟的毫秒值）。 */
  readonly deadlineMs: number;
}

/** 建一条查询时的入参（`requestId` 由挂起表分配）。 */
export interface DebugQueryTarget {
  readonly category?: string;
  readonly instance: string;
  readonly iface?: string;
  readonly method?: string;
  readonly methodId: number;
  readonly args?: readonly DebugArg[];
}

/** 挂起表计数快照（F6 用来做 UI 提示与诊断）。 */
export interface DebugQueryTrackerMetrics {
  /** 当前在途条数。 */
  readonly pending: number;
  /** 累计分配且成功入表的请求数。 */
  readonly accepted: number;
  /** 正常拿到 `debugResult` 的条数。 */
  readonly results: number;
  /** 拿到失败 `response` 的条数（含业务拒绝）。 */
  readonly errors: number;
  /** 自身 8 s 超时收敛的条数。 */
  readonly timedOut: number;
  /** 晚到结果条数（已超时/已结算后仍到达，丢弃且不完成 Promise）。 */
  readonly lateResults: number;
  /**
   * 结算到一个**既不在途、也不在作废表**的请求号的次数。
   * 包括：TTL 过期后才到的结果（无法再判别归属）、别的连接/别的挂起表发来的号。
   * 它不是"晚到"（无法证明是本表发出的），但同样必须可观测，不能只落日志。
   */
  readonly unknownSettlements: number;
  /** 因在途已满而被拒绝的发起次数（立即失败，不入表、不发请求）。 */
  readonly busyRejected: number;
  /** 被 `cancelAll` / `cancelInstance` 取消的条数。 */
  readonly cancelled: number;
}

/** 挂起表统计的结算方式：`result` = 成功结果，`error` = 失败应答。 */
export type DebugQuerySettlementOutcome = "result" | "error";

/** 结算结果：`settled` 正常完成；`late` 已超时/已结算后到达（丢弃）；`unknown` 不是本表发出的号。 */
export type DebugQuerySettlement =
  | { readonly status: "settled"; readonly query: PendingDebugQuery; readonly outcome: DebugQuerySettlementOutcome }
  | { readonly status: "late"; readonly requestId: string; readonly requestSeq: number | undefined }
  | { readonly status: "unknown"; readonly requestId: string };

export interface DebugQueryTrackerOptions {
  /** 在途上限；默认 {@link MAX_PENDING_QUERIES}。 */
  readonly maxPending?: number;
  /** 总超时毫秒；默认 {@link QUERY_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  /** 毫秒时钟（可注入）；默认 `Date.now`。 */
  readonly now?: () => number;
  /** 定时器（可注入）；默认 `setTimeout` 且 `unref()`，不阻止进程退出。 */
  readonly setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  /** 清定时器（可注入）；默认 `clearTimeout`。 */
  readonly clearTimer?: (handle: unknown) => void;
  /**
   * 首个序号（默认 1，0 视为 1）。只用于**测试回绕**与重连后接着编号；
   * 正常连接从 1 开始，`u32` 回绕的空号判定见 {@link DebugQueryTracker.allocateSeq}。
   */
  readonly initialRequestSeq?: number;
  /**
   * 请求号空间的上界（含，默认 `0xffffffff`，即线上 `u32`）。
   *
   * **只为测试注入**：用极小空间（如 4）才能在不分配 2^32 次的前提下验证回绕。
   * 生产必须保持默认值——协议里 `requestId` 就是 `u32`，收窄空间只会在会话中提前耗尽。
   */
  readonly requestSeqSpace?: number;
  /** 超时回调（F6 用来提示"查询超时"）；只对仍在途的查询触发一次。 */
  readonly onTimeout?: (query: PendingDebugQuery) => void;
  readonly log?: (message: string) => void;
}

/** 作废表条目：号 + 何时不再识别（`settledAt + TTL`）。 */
interface RetiredRequestId {
  readonly requestId: string;
  /** 结算/超时/取消的时刻（毫秒）。 */
  readonly settledAt: number;
  /** 到此刻起不再把该号当作"已知请求号"。 */
  readonly expireAt: number;
}

/**
 * 客户端查询挂起表。一个连接一个实例（断连/切换实例时 `cancelAll`）；
 * 所有变更都是同步的，回调在锁外语义上只触发一次。
 */
export class DebugQueryTracker {
  private readonly maxPending: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, timeoutMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onTimeout: ((query: PendingDebugQuery) => void) | undefined;
  private readonly log: (message: string) => void;
  /** 可分配的请求号上界（含）；见 {@link DebugQueryTrackerOptions.requestSeqSpace}。 */
  private readonly seqSpace: number;

  private readonly pending = new Map<string, PendingDebugQuery>();
  private readonly timers = new Map<string, unknown>();
  /**
   * 已结算/已超时/已取消的请求号（识别晚到结果用）。
   * 保留到 `expireAt`（TTL），而非"最近 64 条"：条数上限会被高频查询挤出识别窗口。
   */
  private readonly retired = new Map<number, RetiredRequestId>();
  /** 退休顺序（FIFO），只用于剪枝与安全上限淘汰。 */
  private readonly retiredOrder: number[] = [];

  private nextSeq = 1;
  private accepted = 0;
  private results = 0;
  private errors = 0;
  private timedOut = 0;
  private lateResults = 0;
  private unknownSettlements = 0;
  private busyRejected = 0;
  private cancelled = 0;

  public constructor(options: DebugQueryTrackerOptions = {}) {
    this.maxPending = options.maxPending ?? MAX_PENDING_QUERIES;
    this.timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.onTimeout = options.onTimeout;
    this.log = options.log ?? (() => undefined);
    this.seqSpace = normalizeSeqSpace(options.requestSeqSpace);
    this.nextSeq = Math.min(normalizeInitialSeq(options.initialRequestSeq), this.seqSpace);
  }

  /** 在途条数。 */
  public get pendingCount(): number {
    return this.pending.size;
  }

  /** 在途上限。 */
  public get capacity(): number {
    return this.maxPending;
  }

  /** 已满：再发请求必须立即失败（不排队、不堆积，附录 A.6 的客户端侧同构）。 */
  public get isBusy(): boolean {
    return this.pending.size >= this.maxPending;
  }

  public get metrics(): DebugQueryTrackerMetrics {
    return {
      pending: this.pending.size,
      accepted: this.accepted,
      results: this.results,
      errors: this.errors,
      timedOut: this.timedOut,
      lateResults: this.lateResults,
      unknownSettlements: this.unknownSettlements,
      busyRejected: this.busyRejected,
      cancelled: this.cancelled,
    };
  }

  /**
   * 分配 `requestId` 并入表；在途已满时返回 `undefined`（调用方立即提示忙碌，不发请求）。
   * 返回的 `DebugRequestMessage` 可直接交给 `encodeDebugRequest`，`requestId` 与 `methodId` 都已填好。
   */
  public createRequest(target: DebugQueryTarget): DebugRequestMessage | undefined {
    // 惰性清理：不引入后台定时器，分配/结算/识别时各剪一次过期作废号。
    this.pruneRetired();
    if (this.isBusy) {
      this.busyRejected += 1;
      this.log(`[debug] query rejected locally: ${this.pending.size}/${this.maxPending} in flight`);
      return undefined;
    }

    const requestSeq = this.allocateSeq();
    const requestId = `req-${requestSeq}`;
    const query: PendingDebugQuery = {
      requestId,
      requestSeq,
      category: target.category,
      instance: target.instance,
      iface: target.iface,
      method: target.method,
      methodId: target.methodId,
      deadlineMs: this.now() + this.timeoutMs,
    };

    this.pending.set(requestId, query);
    this.accepted += 1;
    // 先入表再挂定时器：定时器在 0 ms 注入时钟下也不会有"未入表就超时"的窗口。
    this.timers.set(requestId, this.setTimer(() => this.expire(requestId), this.timeoutMs));
    return {
      kind: "request",
      requestId,
      action: "debugQuery",
      ...(target.category === undefined ? {} : { category: target.category }),
      instance: target.instance,
      ...(target.iface === undefined ? {} : { iface: target.iface }),
      ...(target.method === undefined ? {} : { method: target.method }),
      methodId: target.methodId,
      args: target.args ?? [],
    };
  }

  /**
   * 结算一条查询（`debugResult` 用 `"result"`，失败 `response` 用 `"error"`）。
   * 已超时/已结算/已取消的号返回 `late` 并计入 `lateResults`——晚到结果**丢弃、不完成 Promise**。
   */
  public settle(requestId: string, outcome: DebugQuerySettlementOutcome): DebugQuerySettlement {
    this.pruneRetired();
    const query = this.pending.get(requestId);
    if (query === undefined) {
      const requestSeq = parseRequestSeq(requestId);
      if (requestSeq !== undefined && this.retired.has(requestSeq)) {
        this.lateResults += 1;
        this.log(`[debug] dropped a late query ${outcome}: ${requestId}`);
        return { status: "late", requestId, requestSeq };
      }

      this.unknownSettlements += 1;
      this.log(`[debug] dropped a query ${outcome} for an unknown requestId: ${requestId}`);
      return { status: "unknown", requestId };
    }

    this.removePending(query);
    this.retire(query.requestSeq, requestId);
    if (outcome === "result") {
      this.results += 1;
    } else {
      this.errors += 1;
    }

    return { status: "settled", query, outcome };
  }

  /** 挂起表判定：`requestId` 是否仍在途（`u32` 形态，供二进制解码上下文注入）。 */
  public readonly isPendingRequest = (requestSeq: number): boolean => {
    return this.findBySeq(requestSeq) !== undefined;
  };

  /**
   * 已知请求号（在途 + TTL 内的作废号）：注入解码上下文后，**晚到的二进制 `debugResult`**
   * 仍按 `debugResult` 解出，而不是把 `u32 requestId` 当参数区解成垃圾（A.5 的按 `requestId` 关联）。
   *
   * TTL 之后返回 `false`：解析器会按 `debug` 解参数区（协议无类型位的固有歧义，见文件头）。
   * 迟到结果应在超时后 1–2 s 内到达，60 s 的 TTL 远大于该上限。
   */
  public readonly isKnownRequest = (requestSeq: number): boolean => {
    this.pruneRetired();
    return this.findBySeq(requestSeq) !== undefined || this.retired.has(requestSeq);
  };

  /** 按 `requestId` 取在途条目（F6 关联结果用）。 */
  public get(requestId: string): PendingDebugQuery | undefined {
    return this.pending.get(requestId);
  }

  /** 取消全部在途（断连 / 切换实例 / Domain Reload）：返回被取消的条目，供 UI 逐条提示。 */
  public cancelAll(): readonly PendingDebugQuery[] {
    const cancelled = [...this.pending.values()];
    for (const query of cancelled) {
      this.removePending(query);
      this.retire(query.requestSeq, query.requestId);
    }

    this.cancelled += cancelled.length;
    if (cancelled.length !== 0) {
      this.log(`[debug] cancelled ${cancelled.length} in-flight queries`);
    }

    return cancelled;
  }

  /** 取消某个实例的在途查询（实例 `Finish` 或切换实例时用）。 */
  public cancelInstance(instance: string): readonly PendingDebugQuery[] {
    const cancelled: PendingDebugQuery[] = [];
    for (const query of [...this.pending.values()]) {
      if (query.instance !== instance) {
        continue;
      }

      this.removePending(query);
      this.retire(query.requestSeq, query.requestId);
      cancelled.push(query);
    }

    this.cancelled += cancelled.length;
    return cancelled;
  }

  /**
   * 取消单条在途查询（客户端发送失败时用）：清句柄 + 进作废表，**不计入客户端结算**。
   * 返回被取消的条目；号已不在表里时返回 `undefined`（幂等）。
   */
  public cancelRequest(requestId: string): PendingDebugQuery | undefined {
    const query = this.pending.get(requestId);
    if (query === undefined) {
      return undefined;
    }

    this.removePending(query);
    this.retire(query.requestSeq, requestId);
    this.cancelled += 1;
    return query;
  }

  /**
   * 结算到期查询（8 s 总超时）。定时器会自动调用；也可由宿主的心跳/帧循环显式驱动，
   * 便于测试与"定时器不可用"的宿主。返回本次收敛的条目。
   */
  public expireDue(nowMs: number = this.now()): readonly PendingDebugQuery[] {
    const expired: PendingDebugQuery[] = [];
    for (const query of [...this.pending.values()]) {
      if (query.deadlineMs <= nowMs) {
        this.expireQuery(query);
        expired.push(query);
      }
    }

    return expired;
  }

  private expire(requestId: string): void {
    const query = this.pending.get(requestId);
    if (query !== undefined) {
      this.expireQuery(query);
    }
  }

  private expireQuery(query: PendingDebugQuery): void {
    // 超时收敛 = 移出在途 + 进作废表（晚到结果命中作废表后丢弃）。
    this.removePending(query);
    this.retire(query.requestSeq, query.requestId);
    this.timedOut += 1;
    this.log(`[debug] query ${query.requestId} timed out after ${this.timeoutMs} ms`);
    this.onTimeout?.(query);
  }

  private removePending(query: PendingDebugQuery): void {
    this.pending.delete(query.requestId);
    const timer = this.timers.get(query.requestId);
    if (timer !== undefined) {
      this.timers.delete(query.requestId);
      this.clearTimer(timer);
    }
  }

  private retire(requestSeq: number, requestId: string): void {
    if (this.retired.has(requestSeq)) {
      return;
    }

    const nowMs = this.now();
    this.retired.set(requestSeq, {
      requestId,
      settledAt: nowMs,
      expireAt: nowMs + DEBUG_QUERY_RETIRED_TTL_MS,
    });
    this.retiredOrder.push(requestSeq);

    // 安全上限：先清理过期项；若仍超限（全部未过期，只可能是极端配置/极端速率），
    // 淘汰最旧的一条并记日志——不静默。
    this.pruneRetired(nowMs);
    while (this.retired.size > MAX_RETIRED_REQUEST_IDS) {
      const oldest = this.retiredOrder.shift();
      if (oldest === undefined) {
        break;
      }

      const evicted = this.retired.get(oldest);
      if (evicted === undefined) {
        // 极小编号空间把它从作废表里回收了，但顺序表还留着墓碑。
        continue;
      }

      this.retired.delete(oldest);
      this.log(
        `[debug] retired request-id table exceeded ${MAX_RETIRED_REQUEST_IDS} entries; evicted the oldest unexpired id ${oldest} (${evicted.requestId}) before its TTL ended — late results for it will no longer be recognised`,
      );
    }
  }

  /**
   * 惰性清理过期作废号（不引入后台定时器）：从最旧的开始剪，遇到未过期即停
   * （`expireAt` 随退休顺序单调递增）。
   */
  private pruneRetired(nowMs: number = this.now()): void {
    while (this.retiredOrder.length !== 0) {
      const oldest = this.retiredOrder[0];
      if (oldest === undefined) {
        return;
      }

      const entry = this.retired.get(oldest);
      if (entry === undefined) {
        this.retiredOrder.shift();
        continue;
      }

      if (entry.expireAt > nowMs) {
        return;
      }

      this.retiredOrder.shift();
      this.retired.delete(oldest);
    }
  }

  private findBySeq(requestSeq: number): PendingDebugQuery | undefined {
    for (const query of this.pending.values()) {
      if (query.requestSeq === requestSeq) {
        return query;
      }
    }

    return undefined;
  }

  /**
   * 单调分配：跳过 0（保留）、仍挂起的号、仍在作废表里的号；`u32` 回绕后从 1 重新找空号。
   * 在途 ≤8、作废 ≤4096，所以最多 4106 次探测必得空号（评审 P0：回绕不得命中存活旧条目）。
   *
   * **可注入的极小空间**（{@link DebugQueryTrackerOptions.requestSeqSpace}，仅测试）：
   * 此时"作废号也不复用"可能把整个空间占满（如空间 4、在途 2 + 作废 2）。第二轮改为
   * **只保证不复用在途号**：回收一个已作废的号（并从作废表移除），空间内还有在途号时抛错。
   * 生产空间是 `u32`，该分支不可达；但它让回绕用例不必分配 2^32 次，也让行为在
   * "容量配置 > 号空间"这种错误配置下 fail-closed（宁可发起失败，也不串号）。
   *
   * **小空间复用已作废号的已知限制**：旧请求的晚到结果会被判成新请求的结果（串话）。
   * 生产 `space = u32` 不可达（要分配满 2^32 次）；这里保留复用是为了让回绕用例可测，
   * 且复用会写日志，不静默。
   */
  private allocateSeq(): number {
    const space = this.seqSpace;
    // 正常路径：从上次分配处递增，跳过 0、在途与作废号。p+r+2 次探测足以覆盖所有被占号。
    const probes = Math.min(space, this.pending.size + this.retired.size + 2);
    for (let attempt = 0; attempt < probes; attempt++) {
      const candidate = this.nextSeq;
      this.nextSeq = candidate >= space ? 1 : candidate + 1;
      if (candidate !== 0 && !this.retired.has(candidate) && this.findBySeq(candidate) === undefined) {
        return candidate;
      }
    }

    if (space > this.pending.size + this.retired.size + 1) {
      // 理论上不可达：更小的空间都排不满，何况更大的。
      throw new Error("DebugQueryTracker exhausted the request-id space without finding a free id");
    }

    // 极小注入空间：作废号可以回收（旧请求的晚到结果会退化为 unknown 并被丢弃），
    // 但**绝不**回收仍在途的号——这正是评审 P0 的红线。
    for (let candidate = 1; candidate <= space; candidate++) {
      if (this.findBySeq(candidate) === undefined) {
        if (this.retired.delete(candidate)) {
          this.log(`[debug] reusing retired request id ${candidate} (injected request-id space ${space})`);
        }

        return candidate;
      }
    }

    throw new Error(
      `DebugQueryTracker cannot allocate a request id: all ${space} id(s) are in flight (maxPending=${this.maxPending})`,
    );
  }
}

/** `"req-<n>"` → n；非本模块分配的形态返回 undefined。 */
export function parseRequestSeq(requestId: string): number | undefined {
  if (!requestId.startsWith("req-")) {
    return undefined;
  }

  const digits = requestId.slice(4);
  if (digits.length === 0 || !/^[0-9]+$/.test(digits)) {
    return undefined;
  }

  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_REQUEST_SEQ ? value : undefined;
}

function defaultSetTimer(callback: () => void, timeoutMs: number): unknown {
  const handle = setTimeout(callback, timeoutMs) as unknown as { unref?: () => void };
  // 扩展宿主里超时定时器不应阻止进程退出（node:test 里同理）。
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function normalizeInitialSeq(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0 || value > MAX_REQUEST_SEQ) {
    return 1;
  }

  return value;
}

/** 请求号空间归一化：非法值一律回退到线上 `u32` 上界（收窄空间只用于测试）。 */
function normalizeSeqSpace(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > MAX_REQUEST_SEQ) {
    return MAX_REQUEST_SEQ;
  }

  return value;
}
