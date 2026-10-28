/**
 * 调试查询客户端（附录 C.1、A.5/A.6、E.6）：把 `DebugQueryTracker`（挂起表/超时/并发上限）
 * 接到真实连接上，产出「结果 / 可读错误 / 取消提示」，并把结果以 `queryResult` 记录交给存储层。
 *
 * 职责边界：
 * - **不**自己维护第二套定时器或并发计数：分配、`u32` 回绕、8 s 超时、作废表全部由
 *   {@link DebugQueryTracker} 负责（它是 HEAD 已有模块，F6 只接线，不复制）；
 * - **不**碰线上编解码：`send` 由连接层注入（生产就是 `encodeDebugRequest` + 通道 1 发送）；
 * - **不**直接写 store：`appendResult` 由宿主注入（生产是 `DebugInstanceManager`），
 *   这样 `queryResult` 与事件记录共用同一套容量记账、淘汰、路由与关键帧语义（C.2/C.4）。
 *
 * 晚到结果（任务书验收 `:43`）：超时/已结算/已取消之后到达的 `debugResult` **丢弃且不插入
 * 时间轴**（与 `:73` 的措辞冲突已按验收标准裁决）。丢弃不是静默的：`lateResults` 计数 +
 * 日志 + 一条 warning 通知，面板可展示。
 *
 * 错误码（权威源 `Protocol/contract-manifest.json` 的 `errors.debugQuery`，共 **7** 个）。
 * **口径修正（F6 收敛轮 P2-4）**：不是"6 个来自服务端、queryTimeout 由客户端生成"，每码的真实来源是：
 *
 * | 码 | 来源 | 说明 |
 * | `runtime.debugNotEnabled` | `server` | F7 总开关关闭：Unity 在请求入队前直接拒绝 |
 * | `runtime.instanceNotFound` | `server` | 服务端找不到实例 |
 * | `runtime.invalidArgument` | `server` | 参数/方法号非法 |
 * | `runtime.queryBusy` | **`both`** | 服务端排队满 + 客户端在途 8 条已满（本地直接拒绝） |
 * | `runtime.queryRejected` | `server` | 业务拒绝 / 处理器异常 |
 * | `runtime.queryTimeout` | **`both`** | 服务端 B.6.2 排队 2 s / 执行 3 s + 客户端总超时 8 s |
 * | `runtime.queryUnregistered` | `server` | 接口没有注册查询处理器 |
 *
 * 因此 {@link DebugQueryError.generatedBy} 的语义是"**这一条错误实例由谁产生**"，
 * 而不是"这个码归谁"：同一个码可以一边由服务端 `response` 产生（记 `server`），
 * 一边由客户端本地拒绝/超时产生（记 `client`）。`local.*` 码只表达本地条件
 * （没连接、实例已结束、发送失败、取消、多连接无法确定归属），**不冒充**服务端码。
 */

import type { DebugResultEnvelope, DebugResponseEnvelope } from "./debugIngress";
import {
  DEBUG_QUERY_ERROR_CODES,
  isDebugQueryErrorCode,
  type DebugArg,
  type DebugQueryErrorCode,
  type DebugRequestMessage,
  type DebugSlotBinding,
} from "./debugMessages";
import {
  DebugQueryTracker,
  MAX_PENDING_QUERIES,
  QUERY_TIMEOUT_MS,
  parseRequestSeq,
  type DebugQueryTrackerMetrics,
  type PendingDebugQuery,
} from "./debugQueryTracker";
import type { DebugRecord } from "./debugStore";

/** 7 个线上查询错误码的 UI 文案（键集合由权威清单派生，少一个都编译失败）。 */
export const DEBUG_QUERY_ERROR_MESSAGES: Readonly<Record<DebugQueryErrorCode, string>> = {
  "runtime.debugNotEnabled": "Unity 的 Debug 上报总开关已关闭：请在调试面板里打开上报后重试。",
  "runtime.instanceNotFound": "实例不存在或已结束：请重新选择仍存活的实例。",
  "runtime.invalidArgument": "查询参数不合法：请检查接口、方法与方法号。",
  "runtime.queryBusy": "查询并发已满（上限 8）：请等待在途查询结束后再试。",
  "runtime.queryRejected": "查询被 Unity 侧拒绝（业务拒绝或处理器异常），详情见下方 detail。",
  "runtime.queryTimeout": "查询超时（8 秒内没有结果）：本次查询已放弃，不会重试。",
  "runtime.queryUnregistered": "该接口没有注册查询处理器：请在 Unity 侧注册后重试。",
};

/** 本地条件码（不上线、不冒充服务端码）。 */
export type DebugQueryLocalErrorCode =
  | "local.notConnected"
  | "local.noConnection"
  | "local.sendFailed"
  | "local.instanceNotFound"
  | "local.instanceFinished"
  | "local.unknownMethod"
  | "local.disconnected"
  | "local.cancelled"
  | "local.disposed"
  | "local.unexpectedResponse";

const LOCAL_ERROR_MESSAGES: Readonly<Record<DebugQueryLocalErrorCode, string>> = {
  "local.notConnected": "没有可用的调试连接：查询没有发出。",
  "local.noConnection":
    "无法确定该实例属于哪条调试连接（多连接同时在线时不会猜）：请先在面板里选中该实例，或断开其它连接后重试。",
  "local.sendFailed": "查询请求发送失败（连接已关闭或队列拒绝）：请检查连接后重试。",
  "local.instanceNotFound": "实例不存在：请重新选择实例。",
  "local.instanceFinished": "实例已结束：本次查询已取消，不会重试。",
  "local.unknownMethod": "契约里找不到该接口/方法（或缺少方法号）：无法发起查询。",
  "local.disconnected": "连接已断开：该实例未完成的查询已全部取消。",
  "local.cancelled": "查询已取消（切换实例）。",
  "local.disposed": "调试面板已关闭：未完成的查询已取消。",
  "local.unexpectedResponse": "服务端返回了成功应答但没有结果（协议不一致）：本次查询失败。",
};

/** 查询失败的统一形态：`message` 已是可直接展示的中文文案。 */
export class DebugQueryError extends Error {
  public readonly code: string;
  /** 服务端 `detail`（业务拒绝原因等），可能为空。 */
  public readonly detail: string | undefined;
  /**
   * **这一条错误实例**由谁产生：服务端 `response` 记 `server`，客户端本地拒绝/超时/取消/路由失败记 `client`。
   *
   * 它不是"码的归属"：`runtime.queryBusy` / `runtime.queryTimeout` 是双来源（见文件头的 provenance 表），
   * 同一个码两边都会产生。
   */
  public readonly generatedBy: "server" | "client";

  public constructor(
    code: string,
    message: string,
    options: { readonly detail?: string; readonly generatedBy: "server" | "client" } = { generatedBy: "client" },
  ) {
    super(message);
    this.name = "DebugQueryError";
    this.code = code;
    this.detail = options.detail;
    this.generatedBy = options.generatedBy;
  }
}

/** 一次查询的上下文（结果记录用；`frame` 是**发起查询时**的当前帧，P1）。 */
export interface DebugQueryTargetMeta {
  readonly requestId: string;
  readonly requestSeq: number;
  readonly category: string;
  readonly instanceId: string;
  readonly interfaceId: string;
  readonly method: string;
  readonly methodId: number;
  readonly frame: number;
}

/** 成功结果。`record` 是写进时间轴的那条 `kind: "queryResult"` 记录。 */
export interface DebugQueryResult {
  readonly target: DebugQueryTargetMeta;
  readonly args: readonly DebugArg[];
  readonly wireBytes: number;
  readonly receivedAt: number;
  readonly contractState: string;
  readonly record: DebugRecord | undefined;
}

/** 面板/日志用的提示（不抛异常，不中断接收）。 */
export interface DebugQueryNotice {
  readonly kind: "info" | "warning" | "error";
  readonly message: string;
  readonly requestId?: string;
  readonly code?: string;
}

export interface DebugQueryInstanceInfo {
  readonly category: string;
  readonly instanceId: string;
  readonly active: boolean;
}

/** 查询入口参数（C.1 的 `options`）：`frame` 由宿主传发起时的当前帧。 */
export interface DebugQueryOptions {
  readonly frame?: number;
  /** 显式覆盖方法号（不传则按契约用 iface/method 反查）。 */
  readonly methodId?: number;
  readonly category?: string;
  readonly instanceId?: string;
}

export type DebugQueryCancelReason = "disconnect" | "user" | "dispose";

/** 取消原因 → 本地错误码与文案。 */
function cancelError(reason: DebugQueryCancelReason): DebugQueryError {
  switch (reason) {
    case "disconnect":
      return new DebugQueryError("local.disconnected", LOCAL_ERROR_MESSAGES["local.disconnected"], { generatedBy: "client" });
    case "dispose":
      return new DebugQueryError("local.disposed", LOCAL_ERROR_MESSAGES["local.disposed"], { generatedBy: "client" });
    default:
      return new DebugQueryError("local.cancelled", LOCAL_ERROR_MESSAGES["local.cancelled"], { generatedBy: "client" });
  }
}

export interface DebugQueryClientOptions {
  /** 发出一条 `request`（通道 1 JSON）；返回 `false` = 没发出去（连接已关/队列拒绝）。 */
  readonly send: (request: DebugRequestMessage) => boolean;
  /** 实例键 → 实例信息；缺省按 `category\0instanceId` 拆分且视为存活。 */
  readonly resolveInstance?: (instanceKey: string) => DebugQueryInstanceInfo | undefined;
  /** 契约反查方法号；缺省只能用 `options.methodId`。 */
  readonly resolveMethod?: (category: string, interfaceId: string, method: string) => { readonly methodId: number } | undefined;
  /** 结果写入时间轴；`target.frame` 必须盖在记录上（P1：不新增帧边界，跨帧时按追加顺序落在末尾）。 */
  readonly appendResult?: (envelope: DebugResultEnvelope, target: DebugQueryTargetMeta) => DebugRecord | undefined;
  readonly maxPending?: number;
  readonly timeoutMs?: number;
  /**
   * 首个请求号（默认 1）。只为**测试**注入：
   * 复现"特定 `u32` 字节形态"的迟到结果（如 `req-66051` = `0x00010203`）需要从该号开始，
   * 生产恒用默认值（`requestId` 的分配规则见 `DebugQueryTracker`）。
   */
  readonly initialRequestSeq?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onNotice?: (notice: DebugQueryNotice) => void;
  readonly log?: (message: string) => void;
}

interface ClientPendingQuery extends DebugQueryTargetMeta {
  readonly resolve: (result: DebugQueryResult) => void;
  readonly reject: (error: DebugQueryError) => void;
}

/**
 * 查询客户端：一个连接一个实例。断连/切换实例/实例结束都走显式取消（带不同文案），
 * 不静默清空挂起表。
 */
export class DebugQueryClient {
  public readonly tracker: DebugQueryTracker;

  private readonly options: DebugQueryClientOptions;
  private readonly pending = new Map<string, ClientPendingQuery>();
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private noticeValue: DebugQueryNotice | undefined;
  private disposed = false;
  /** 本地并发上限直接拒绝的次数（`createRequest` 不会走到，所以 tracker 的计数不含它）。 */
  private busyRejectedValue = 0;

  public constructor(options: DebugQueryClientOptions) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.tracker = new DebugQueryTracker({
      maxPending: options.maxPending ?? MAX_PENDING_QUERIES,
      timeoutMs: options.timeoutMs ?? QUERY_TIMEOUT_MS,
      ...(options.initialRequestSeq === undefined ? {} : { initialRequestSeq: options.initialRequestSeq }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
      ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
      onTimeout: (query) => this.onTimeout(query),
      log: this.log,
    });
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  public get capacity(): number {
    return this.tracker.capacity;
  }

  /** 在途已满：调用方应先置灰按钮并提示，而不是发一条必然失败的请求。 */
  public get isBusy(): boolean {
    return this.tracker.isBusy;
  }

  public get metrics(): DebugQueryTrackerMetrics {
    const metrics = this.tracker.metrics;
    return {
      ...metrics,
      busyRejected: metrics.busyRejected + this.busyRejectedValue,
    };
  }

  /** 最近一条提示（面板状态栏用）；查询成功也会写一条 info。 */
  public get lastNotice(): DebugQueryNotice | undefined {
    return this.noticeValue;
  }

  /**
   * 发起一次查询（C.1 的 `query(instanceKey, interfaceId, method, args, options)`）。
   *
   * 失败一律 reject {@link DebugQueryError}，**不重试**：
   * - 本地并发已满 → 立即 `runtime.queryBusy`（不入表、不发请求、不排队）；
   * - 实例不存在/已结束、方法号缺失 → 本地码，连请求都不发；
   * - 8 s 无响应 → `runtime.queryTimeout`（**客户端**生成；服务端 B.6.2 也会产生同码）；
   * - 服务端 `response` → 7 个查询码之一（`queryBusy` / `queryTimeout` 也可能是服务端产生的）；
   * - 断连/实例结束/切换实例 → `local.disconnected` / `local.instanceFinished` / `local.cancelled`。
   */
  public query(
    instanceKey: string,
    interfaceId: string,
    method: string,
    args: readonly DebugArg[] = [],
    options: DebugQueryOptions = {},
  ): Promise<DebugQueryResult> {
    if (this.disposed) {
      return Promise.reject(this.fail("local.disposed", LOCAL_ERROR_MESSAGES["local.disposed"]));
    }

    if (this.tracker.isBusy) {
      // 达到并发上限：立即可读提示，**不发请求**（不排队堆积，任务书验收 2）。
      this.busyRejectedValue += 1;
      return Promise.reject(this.fail(
        "runtime.queryBusy",
        DEBUG_QUERY_ERROR_MESSAGES["runtime.queryBusy"],
        { generatedBy: "client" },
      ));
    }

    let target: DebugQueryTargetMeta;
    try {
      target = this.resolveTarget(instanceKey, interfaceId, method, options);
    } catch (errorValue) {
      return Promise.reject(errorValue instanceof DebugQueryError
        ? errorValue
        : this.fail("local.unknownMethod", LOCAL_ERROR_MESSAGES["local.unknownMethod"]));
    }

    let request: DebugRequestMessage | undefined;
    try {
      request = this.tracker.createRequest({
        category: target.category,
        instance: target.instanceId,
        iface: target.interfaceId,
        method: target.method,
        methodId: target.methodId,
        args,
      });
    } catch (errorValue) {
      this.log(`[debug] query could not be created: ${String(errorValue)}`);
      return Promise.reject(this.fail("local.sendFailed", LOCAL_ERROR_MESSAGES["local.sendFailed"]));
    }

    if (request === undefined) {
      // `createRequest` 已自行计数 busyRejected；这里保留同一码，调用方按并发满处理。
      return Promise.reject(this.fail(
        "runtime.queryBusy",
        DEBUG_QUERY_ERROR_MESSAGES["runtime.queryBusy"],
        { generatedBy: "client" },
      ));
    }

    const requestSeq = parseRequestSeq(request.requestId);
    if (requestSeq === undefined) {
      return Promise.reject(this.fail("local.sendFailed", LOCAL_ERROR_MESSAGES["local.sendFailed"]));
    }

    return new Promise<DebugQueryResult>((resolve, reject) => {
      const entry: ClientPendingQuery = {
        ...target,
        requestId: request.requestId,
        requestSeq,
        frame: target.frame,
        resolve,
        reject,
      };
      this.pending.set(request.requestId, entry);

      let sent = false;
      try {
        sent = this.options.send(request);
      } catch (errorValue) {
        this.log(`[debug] sending query ${request.requestId} threw: ${String(errorValue)}`);
        sent = false;
      }

      if (!sent) {
        // 没发出去：立刻腾出挂起表槽位（否则要等 8 s 超时，等于把本地失败变成"忙"）。
        this.pending.delete(request.requestId);
        this.tracker.cancelRequest(request.requestId);
        reject(this.fail("local.sendFailed", LOCAL_ERROR_MESSAGES["local.sendFailed"]));
      }
    });
  }

  /**
   * 处理一条查询相关包络（服务端 `debugResult` / 失败 `response`）。
   * 返回结算状态：`settled` 完成；`late` 已超时/已结算（丢弃且不插时间轴）；`unknown` 不是本表号。
   */
  public handleEnvelope(envelope: DebugResultEnvelope | DebugResponseEnvelope): "settled" | "late" | "unknown" {
    if (envelope.type === "response") {
      const settlement = this.tracker.settle(envelope.requestId, "error");
      if (settlement.status !== "settled") {
        if (settlement.status === "late") {
          this.publish({
            kind: "warning",
            message: `查询 ${envelope.requestId} 的失败应答到达时已超时/已取消：已丢弃。`,
            requestId: envelope.requestId,
            ...(envelope.code === undefined ? {} : { code: envelope.code }),
          });
        }

        return settlement.status;
      }

      const pending = this.pending.get(envelope.requestId);
      if (pending === undefined) {
        return "late";
      }

      this.pending.delete(envelope.requestId);
      if (envelope.ok) {
        const error = this.fail(
          "local.unexpectedResponse",
          LOCAL_ERROR_MESSAGES["local.unexpectedResponse"],
          { requestId: envelope.requestId },
        );
        pending.reject(error);
        return "settled";
      }

      const error = this.errorFromResponse(envelope);
      pending.reject(error);
      this.publish({ kind: "error", message: error.message, requestId: envelope.requestId, code: error.code });
      return "settled";
    }

    // `debugResult`：只有 tracker 认定"仍在途"才结算；晚到结果**不插入时间轴**（验收 :43）。
    const settlement = this.tracker.settle(envelope.requestId, "result");
    if (settlement.status !== "settled") {
      if (settlement.status === "late") {
        this.publish({
          kind: "warning",
          message: `查询 ${envelope.requestId} 的结果晚到（已超时/已取消）：已丢弃，未插入时间轴。`,
          requestId: envelope.requestId,
        });
      }

      return settlement.status;
    }

    const pending = this.pending.get(envelope.requestId);
    if (pending === undefined) {
      return "late";
    }

    this.pending.delete(envelope.requestId);

    let record: DebugRecord | undefined;
    try {
      record = this.options.appendResult?.(envelope, pending);
    } catch (errorValue) {
      // 写入失败不得吞掉结果：Promise 仍然 resolve，只是 `record` 为空（调用方可提示"未插入"）。
      this.log(`[debug] appending query result ${envelope.requestId} failed: ${String(errorValue)}`);
      record = undefined;
    }

    const result: DebugQueryResult = {
      target: {
        requestId: pending.requestId,
        requestSeq: pending.requestSeq,
        category: pending.category,
        instanceId: pending.instanceId,
        interfaceId: pending.interfaceId,
        method: pending.method,
        methodId: pending.methodId,
        frame: pending.frame,
      },
      args: envelope.args,
      wireBytes: envelope.wireBytes,
      receivedAt: this.now(),
      contractState: envelope.contractState,
      record,
    };
    pending.resolve(result);
    this.publish({
      kind: "info",
      message: record === undefined
        ? `查询 ${envelope.requestId} 已返回，但实例已不在时间轴：结果未插入。`
        : `查询 ${envelope.requestId} 已返回：结果已作为查询记录插入时间轴（帧 ${pending.frame}）。`,
      requestId: envelope.requestId,
    });
    return "settled";
  }

  /** 实例 `Finish`：该实例在途查询全部取消，提示"实例已结束"（P1，不重试）。 */
  public handleInstanceFinished(instanceId: string): readonly PendingDebugQuery[] {
    const cancelled = this.tracker.cancelInstance(instanceId);
    for (const query of cancelled) {
      const pending = this.pending.get(query.requestId);
      if (pending !== undefined) {
        this.pending.delete(query.requestId);
        pending.reject(this.fail("local.instanceFinished", LOCAL_ERROR_MESSAGES["local.instanceFinished"], {
          requestId: query.requestId,
        }));
      }
    }

    if (cancelled.length !== 0) {
      this.publish({
        kind: "warning",
        message: `实例 ${instanceId} 已结束：${cancelled.length} 条未完成的查询已取消，不会重试。`,
      });
    }

    return cancelled;
  }

  /**
   * 取消全部在途查询。`reason` 决定文案：断连与用户切换实例**必须可区分**（P1），
   * 不是静默清空。返回被取消的条目供宿主提示。
   */
  public cancelAll(reason: DebugQueryCancelReason): readonly PendingDebugQuery[] {
    const cancelled = this.tracker.cancelAll();
    const error = cancelError(reason);
    for (const query of cancelled) {
      const pending = this.pending.get(query.requestId);
      if (pending !== undefined) {
        this.pending.delete(query.requestId);
        pending.reject(new DebugQueryError(error.code, error.message, {
          generatedBy: "client",
        }));
      }
    }

    if (cancelled.length !== 0) {
      this.publish({
        kind: "warning",
        message: `${error.message}（${cancelled.length} 条未完成）`,
      });
    }

    return cancelled;
  }

  /** 只取消某个实例的在途查询（切换实例；与断连文案区分）。 */
  public cancelInstance(instanceId: string, reason: DebugQueryCancelReason = "user"): readonly PendingDebugQuery[] {
    const cancelled = this.tracker.cancelInstance(instanceId);
    const error = cancelError(reason);
    for (const query of cancelled) {
      const pending = this.pending.get(query.requestId);
      if (pending !== undefined) {
        this.pending.delete(query.requestId);
        pending.reject(new DebugQueryError(error.code, error.message, { generatedBy: "client" }));
      }
    }

    if (cancelled.length !== 0) {
      this.publish({ kind: "warning", message: `${error.message}（${cancelled.length} 条未完成）` });
    }

    return cancelled;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cancelAll("dispose");
  }

  // ==== 内部 ====

  private resolveTarget(
    instanceKey: string,
    interfaceId: string,
    method: string,
    options: DebugQueryOptions,
  ): DebugQueryTargetMeta {
    const resolved = this.options.resolveInstance?.(instanceKey);
    const separator = instanceKey.indexOf("\u0000");
    const fallbackCategory = separator >= 0 ? instanceKey.slice(0, separator) : "";
    const fallbackInstance = separator >= 0 ? instanceKey.slice(separator + 1) : instanceKey;
    const category = options.category ?? resolved?.category ?? fallbackCategory;
    const instanceId = options.instanceId ?? resolved?.instanceId ?? fallbackInstance;
    if (instanceId.length === 0) {
      throw this.fail("local.instanceNotFound", LOCAL_ERROR_MESSAGES["local.instanceNotFound"]);
    }

    if (resolved !== undefined && !resolved.active) {
      throw this.fail("local.instanceFinished", LOCAL_ERROR_MESSAGES["local.instanceFinished"]);
    }

    if (resolved === undefined && this.options.resolveInstance !== undefined) {
      throw this.fail("local.instanceNotFound", LOCAL_ERROR_MESSAGES["local.instanceNotFound"]);
    }

    const methodId = options.methodId
      ?? this.options.resolveMethod?.(category, interfaceId, method)?.methodId;
    if (methodId === undefined || !Number.isInteger(methodId) || methodId <= 0 || methodId > 0xffff) {
      throw this.fail("local.unknownMethod", LOCAL_ERROR_MESSAGES["local.unknownMethod"]);
    }

    return {
      requestId: "",
      requestSeq: 0,
      category,
      instanceId,
      interfaceId,
      method,
      methodId,
      frame: options.frame ?? -1,
    };
  }

  private onTimeout(query: PendingDebugQuery): void {
    const pending = this.pending.get(query.requestId);
    if (pending === undefined) {
      return;
    }

    this.pending.delete(query.requestId);
    const error = this.fail("runtime.queryTimeout", DEBUG_QUERY_ERROR_MESSAGES["runtime.queryTimeout"], {
      requestId: query.requestId,
    });
    pending.reject(error);
    this.publish({
      kind: "error",
      message: error.message,
      requestId: query.requestId,
      code: error.code,
    });
  }

  private errorFromResponse(envelope: DebugResponseEnvelope): DebugQueryError {
    const code = envelope.code;
    if (code !== undefined && isDebugQueryErrorCode(code)) {
      return new DebugQueryError(code, DEBUG_QUERY_ERROR_MESSAGES[code], {
        ...(envelope.detail === undefined ? {} : { detail: envelope.detail }),
        generatedBy: "server",
      });
    }

    const fallbackCode = code ?? "runtime.queryRejected";
    const message = code === undefined
      ? "查询失败：服务端没有给出错误码。"
      : `查询失败（${code}）：不是已知的查询错误码，原样展示。`;
    return new DebugQueryError(fallbackCode, message, {
      ...(envelope.detail === undefined ? {} : { detail: envelope.detail }),
      generatedBy: "server",
    });
  }

  private fail(
    code: string,
    message: string,
    options: { readonly requestId?: string; readonly generatedBy?: "server" | "client" } = {},
  ): DebugQueryError {
    const error = new DebugQueryError(code, message, { generatedBy: options.generatedBy ?? "client" });
    this.publish({
      kind: "error",
      message,
      code,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    });
    return error;
  }

  private publish(notice: DebugQueryNotice): void {
    this.noticeValue = notice;
    this.log(`[debug] query notice (${notice.kind}): ${notice.message}`);
    this.options.onNotice?.(notice);
  }
}

/**
 * 实例定位信息：**直接取自现有的 `DebugInstanceView`**，不额外保存"实例 → 连接"映射。
 */
export interface DebugQueryInstanceTarget {
  readonly category: string;
  readonly instanceId: string;
  readonly instanceSlot: number;
}

/**
 * 一条可承载查询的连接。`owns` 由该连接**已有的**槽位绑定（`DebugIngress.slotRegistry`）判定：
 * 实例视图的 `instanceSlot/category/instanceId` 与该连接 `debugCreate` 建立的绑定一致才算归属。
 */
export interface DebugQueryConnection {
  readonly owns: (instance: DebugQueryInstanceTarget) => boolean;
  readonly client: DebugQueryClient;
  /**
   * 该连接自己的"当前帧"（E9 两条腿）：结果记录必须盖**发起查询那条腿**的帧号。
   * 缺省 = 调用方回退到共享的实例表当前帧（F1-F6 的单腿行为）。
   */
  readonly frame?: () => number;
}

/** 路由结果：`ready` 选中唯一连接；`noOwner` / `ambiguous` 都必须由调用方明确报错，不猜。 */
export type DebugQueryRoute =
  | { readonly status: "ready"; readonly client: DebugQueryClient; readonly frame?: () => number }
  | { readonly status: "noOwner" }
  | { readonly status: "ambiguous" };

/** 该连接的槽位表是否持有这个实例（F6 路由的归属判定，复用既有绑定，不新造映射）。 */
export function debugQueryOwnsInstance(
  slots: { resolve(instanceSlot: number): DebugSlotBinding | undefined },
  instance: DebugQueryInstanceTarget,
): boolean {
  const binding = slots.resolve(instance.instanceSlot);
  return binding !== undefined
    && binding.category === instance.category
    && binding.instance === instance.instanceId;
}

/**
 * 按实例解析查询客户端（F6 收敛轮 P2-3）。
 *
 * - 唯一归属 → 该连接；多个归属 → `ambiguous`（不猜，服务端回 `local.noConnection`）；
 * - 实例没有任何存活连接的槽位绑定 → `noOwner`（**即使只剩一条连接也不回退**：
 *   实例的原连接可能已断、实例可能是别的连接的，猜一条就会把查询发错连接）；
 * - 没有连接 → `noOwner`（调用方按 `local.notConnected` 报错）；
 * - 面板还没选中实例（`instance === undefined`）且只有一条连接时，用于全局状态展示。
 */
export function resolveDebugQueryClient(
  instance: DebugQueryInstanceTarget | undefined,
  connections: readonly DebugQueryConnection[],
): DebugQueryRoute {
  if (connections.length === 0) {
    return { status: "noOwner" };
  }

  if (instance === undefined) {
    // 面板还没选中实例：只有一条连接时无歧义；多条连接时不猜。
    const [only] = connections;
    return connections.length === 1 && only !== undefined
      ? { status: "ready", client: only.client, ...(only.frame === undefined ? {} : { frame: only.frame }) }
      : { status: "ambiguous" };
  }

  const owners = connections.filter((candidate) => candidate.owns(instance));
  const [owner] = owners;
  if (owners.length === 1 && owner !== undefined) {
    return { status: "ready", client: owner.client, ...(owner.frame === undefined ? {} : { frame: owner.frame }) };
  }

  return owners.length > 1 ? { status: "ambiguous" } : { status: "noOwner" };
}

/** 查询入口状态快照：`client === undefined` 就是"该实例此刻不可查询"（不借用别的连接）。 */
export interface DebugQueryAvailability {
  readonly available: boolean;
  readonly pending: number;
  readonly limit: number;
  readonly busy: boolean;
  readonly notice: DebugQueryNotice | undefined;
}

/** 把"解析到的查询客户端"折叠成面板状态；没有客户端时 `available=false`。 */
export function debugQueryAvailability(
  client: DebugQueryClient | undefined,
  limit: number = MAX_PENDING_QUERIES,
): DebugQueryAvailability {
  if (client === undefined) {
    return { available: false, pending: 0, limit, busy: false, notice: undefined };
  }

  return {
    available: true,
    pending: client.pendingCount,
    limit: client.capacity,
    busy: client.isBusy,
    notice: client.lastNotice,
  };
}

/** 每条权威错误码都必须有文案；供单测与 `check` 双重保证。 */
export function isKnownDebugQueryMessage(code: string): boolean {
  return (DEBUG_QUERY_ERROR_CODES as readonly string[]).includes(code);
}

/** 构造一个本地条件错误（服务端等宿主侧需要不经过查询就拒绝时用）。 */
export function debugQueryLocalError(code: DebugQueryLocalErrorCode): DebugQueryError {
  return new DebugQueryError(code, LOCAL_ERROR_MESSAGES[code], { generatedBy: "client" });
}
