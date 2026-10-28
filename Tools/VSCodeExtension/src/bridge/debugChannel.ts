/**
 * 调试通道的**发送端抽象**与**一条连接的接收/查询会话**（E9）。
 *
 * 生产里有两条腿把 Unity 的 ch1 调试数据送进同一个面板：
 * - **Editor 桥**（`EditorBridgeServer`）：VS Code 监听，Unity Editor 拨号；
 * - **Runtime 桥**（`RuntimeBridgeService`）：Unity Play/Player 监听，VS Code 拨号。
 *
 * 两条腿的差异只有三件事：连接对象、发送函数、来源标签。因此这里把它们收成一个
 * {@link DebugChannel}，查询客户端（`DebugQueryClient`）只拿到注入的 `send`，**不需要**知道
 * 自己在哪条腿上——`debugQueryClient` 里没有、也不允许出现 `if (leg === "runtime")` 这类分支。
 *
 * {@link DebugChannelSession} 把 F1 的解码（`DebugIngress`）、F3 的帧分组（`slotRegistry`）、
 * F4 的实例归属（`DebugInstanceManager`）、F5 的录制 tap 与 F6 的挂起表（`DebugQueryClient`）
 * 绑在**同一条帧路径**上：`acceptFrame` 是两条腿唯一的入站入口，录制 tap 在解码之前被调用。
 * 这样"录制在 runtime 腿为空而门禁不红"的假绿形态在结构上就不成立。
 *
 * 职责边界：
 * - 不自己建连接、不管握手/发现（那是 E3/E5 的腿）；
 * - 不写 store、不路由（`DebugInstanceManager.ingest`）；
 * - 不碰线上编解码（`encodeDebugRequest` 在 `DebugQueryClient` 的发送注入里）。
 */

import {
  DebugIngress,
  type DebugEnvelope,
  type DebugFrameRecorder,
  type DebugResponseEnvelope,
  type DebugResultEnvelope,
} from "./debugIngress";
import type { DebugContractSnapshot } from "./debugContractRegistry";
import { DebugInstanceManager, type DebugInstanceView } from "./debugInstanceManager";
import {
  DebugQueryClient,
  debugQueryOwnsInstance,
  type DebugQueryCancelReason,
  type DebugQueryConnection,
  type DebugQueryNotice,
  type DebugQueryResult,
} from "./debugQueryClient";
import { encodeDebugRequest, type DebugArg } from "./debugMessages";
import type { BridgePayloadKind } from "./framing";

/** 数据来源：面板据此区分两个可能同名的 Unity 进程（E9 §范围 1）。 */
export type DebugChannelOrigin = "editor" | "runtime";

/** 发送一端 ch1 载荷的抽象：Editor 腿与 Runtime 腿各实现一份。 */
export interface DebugChannel {
  readonly origin: DebugChannelOrigin;
  /** 诊断/日志用的连接身份（不是协议字段）。 */
  readonly id: string;
  /** 连接此刻还能不能发（发送前必须再查一次，避免向已断开的队列写入）。 */
  isOpen(): boolean;
  /** 发送一条通道 1 的 JSON 载荷（查询 `request`）。 */
  sendDebugPayload(payload: Uint8Array): boolean;
}

export interface DebugChannelSessionOptions {
  readonly channel: DebugChannel;
  readonly manager: DebugInstanceManager;
  /** 该连接绑定的契约快照（决定二进制解码与"方法名 → 方法号"）。 */
  readonly contracts?: DebugContractSnapshot;
  /** 录制 tap：帧在解码之前交给它（F5；缺省 = 不录制）。 */
  readonly recorder?: DebugFrameRecorder;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** 下游 ingest 抛错（单条记录失败不得升级成连接级错误）。 */
  readonly onIngestError?: (envelope: DebugEnvelope, error: unknown) => void;
  /** 查询提示（超时/晚到/繁忙）；缺省写日志。 */
  readonly onQueryNotice?: (notice: DebugQueryNotice) => void;
}

/**
 * 一条连接上的调试会话：入站帧 → 包络 → 实例/事件，并持有该连接的查询挂起表。
 *
 * 一个连接一个实例（断连即 `dispose`）；实例表本身是**跨连接共享**的
 * `DebugInstanceManager`，因此两条腿的实例落在同一个面板里（E9 方案 A）。
 */
export class DebugChannelSession {
  public readonly channel: DebugChannel;
  public readonly ingress: DebugIngress;
  public readonly queries: DebugQueryClient;

  private readonly manager: DebugInstanceManager;
  private readonly contracts: DebugContractSnapshot | undefined;
  private readonly log: (message: string) => void;
  private readonly onIngestError: ((envelope: DebugEnvelope, error: unknown) => void) | undefined;
  private disposed = false;

  public constructor(options: DebugChannelSessionOptions) {
    this.channel = options.channel;
    this.manager = options.manager;
    this.contracts = options.contracts;
    this.log = options.log ?? (() => undefined);
    this.onIngestError = options.onIngestError;

    this.queries = new DebugQueryClient({
      ...(options.now === undefined ? {} : { now: options.now }),
      send: (request) => this.channel.isOpen() && this.channel.sendDebugPayload(encodeDebugRequest(request)),
      resolveInstance: (key) => {
        const view = this.manager.instance(key);
        return view === undefined
          ? undefined
          : { category: view.category, instanceId: view.instanceId, active: view.active };
      },
      resolveMethod: (category, interfaceId, method) =>
        this.contracts?.resolveByMethodName(category, interfaceId, method),
      appendResult: (envelope, target) =>
        this.manager.appendQueryResult(envelope, this.contracts, target.frame),
      onNotice: options.onQueryNotice ?? ((notice) => this.log(`[debug] query ${notice.kind}: ${notice.message}`)),
      log: this.log,
    });

    this.ingress = new DebugIngress({
      ...(this.contracts === undefined ? {} : { contracts: this.contracts }),
      // F6 接线：二进制 `debug` / `debugResult` 只能靠本连接的挂起表区分（A.4）。
      // 两个回调都指向同一个 tracker：`isPendingRequest` 决定"当作结果"，`isKnownRequest`
      // 让已结算/已作废号的晚到结果仍被识别为 `debugResult`（然后由客户端按 :43 丢弃）。
      isPendingRequest: (requestSeq) => this.queries.tracker.isPendingRequest(requestSeq),
      isKnownRequest: (requestSeq) => this.queries.tracker.isKnownRequest(requestSeq),
      ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
      log: this.log,
    });
  }

  /** 该连接绑定的契约快照（录制文件头/诊断用）。 */
  public get contractSnapshot(): DebugContractSnapshot | undefined {
    return this.contracts;
  }

  /** 查询路由用的连接描述：归属判定直接读已建立的槽位绑定，不新造映射。 */
  public get connection(): DebugQueryConnection {
    return {
      owns: (instance) => this.ownsInstance(instance),
      client: this.queries,
      // 每条腿有自己的当前帧：结果必须盖"发起查询那条腿"的帧号（F6 的 P1）。
      frame: () => this.ingress.frame,
    };
  }

  public ownsInstance(instance: { readonly category: string; readonly instanceId: string; readonly instanceSlot: number }): boolean {
    return debugQueryOwnsInstance(this.ingress.slotRegistry, instance);
  }

  /**
   * 收下一帧（由连接层的 `onDebugFrame` 调用）：录制 tap → 计数/通道分流 → 解码 → 落库。
   * `debugResult` / `response` 不进普通事件流，交给本连接的查询客户端结算（C.1）。
   */
  public acceptFrame(payloadKind: BridgePayloadKind, payload: Buffer): void {
    if (this.disposed) {
      return;
    }

    const envelopes = this.ingress.acceptFrame({ channel: 1, payloadKind, payload });
    for (const envelope of envelopes) {
      // 顺序固定（F2）：记录先进 store、再路由——由 DebugInstanceManager.ingest 内部保证。
      // 单条坏记录不得升级成连接级错误（bridgeSocket 会把 acceptFrame 的异常判 fatal 并丢弃
      // 同批剩余帧），因此逐条兜住、计数、记日志。
      try {
        if (envelope.type === "debugResult" || envelope.type === "response") {
          this.handleQueryEnvelope(this.queries, envelope);
          continue;
        }

        this.manager.ingest(envelope, this.contracts, this.channel.origin);
        if (envelope.type === "debugFinish" && envelope.instance.length > 0) {
          // 实例在结果前结束：该实例的挂起查询全部取消并提示"实例已结束"（P1），不重试。
          this.queries.handleInstanceFinished(envelope.instance);
        }
      } catch (errorValue) {
        if (this.onIngestError !== undefined) {
          this.onIngestError(envelope, errorValue);
        } else {
          this.log(`[debug] ingest failed for '${envelope.type}': ${String(errorValue)}`);
        }
      }
    }
  }

  /**
   * 发起一次查询：结果按所属实例写进时间轴（`kind: "queryResult"`），帧号默认取本连接的当前帧。
   * `methodId` 显式给出时优先（样例工程没有调试契约时 E2E 用它驱动真实往返）。
   */
  public query(
    instanceKey: string,
    interfaceId: string,
    method: string,
    args: readonly DebugArg[] = [],
    options: { readonly frame?: number; readonly methodId?: number } = {},
  ): Promise<DebugQueryResult> {
    return this.queries.query(instanceKey, interfaceId, method, args, {
      frame: options.frame ?? this.ingress.frame,
      ...(options.methodId === undefined ? {} : { methodId: options.methodId }),
    });
  }

  public cancelAll(reason: DebugQueryCancelReason): void {
    this.queries.cancelAll(reason);
  }

  /**
   * 取消本连接上某个实例的在途查询。实例视图与连接归属不一致时**不取消**
   * （多腿场景下同 id 实例可能属于另一条腿）。
   */
  public cancelInstance(view: Pick<DebugInstanceView, "category" | "instanceId" | "instanceSlot">, reason: DebugQueryCancelReason = "user"): number {
    if (!this.ownsInstance(view)) {
      return 0;
    }

    return this.queries.cancelInstance(view.instanceId, reason).length;
  }

  /** 断开/回看结束：取消全部在途查询（文案区分断连与用户取消，P1）。 */
  public dispose(reason: DebugQueryCancelReason = "disconnect"): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.queries.cancelAll(reason);
  }

  private handleQueryEnvelope(
    queries: DebugQueryClient,
    envelope: DebugResultEnvelope | DebugResponseEnvelope,
  ): void {
    const status = queries.handleEnvelope(envelope);
    if (status === "late") {
      // 晚到结果按验收 :43 丢弃、不插时间轴；计数由 tracker 的 `lateResults` 承担，
      // 客户端还会发一条 warning 通知（不是静默丢弃）。
      this.log(`[debug] late query ${envelope.type} for ${envelope.requestId} was dropped`);
    }
  }
}
