/**
 * 调试接收入口（附录 C.1、A.4）：帧校验与计数、通道分流、按契约解码、`DebugEnvelope` 规范化。
 *
 * 两条数据源走同一个入口，产出**完全同构**的包络（F1 验收 1）：
 * - 网络源：连接层已解出帧，调用 {@link DebugIngress.acceptFrame}；
 * - 文件源（回看）：录制文件里是原样线上帧（6 字节头 + 载荷，C.6），
 *   调用 {@link DebugIngress.acceptRecordedBytes}，由本类自己按 `decodeFrameHeader` 切帧。
 *
 * 失败处理（A.1 的"失败即断"只约束网络传输）：网络源由连接层断开；文件源是录制回放，
 * 帧层失败**只计一次**并停在当前 block，文件源可在 block 边界调
 * {@link DebugIngress.resumeRecordedStream} 继续解后续 block（任务书 §评审清单 P1：
 * "CRC 失败只计数、文件源可跳过该帧"）。退出前已解出的帧照常交付。
 * 计数只累加、绝不抛异常——调试面不能把连接读循环打挂。
 *
 * 契约：包络里带 `contractState`（C.2）；二进制参数名由契约按 tag 补齐；契约级未知方法
 * 单独计数（A.5：不计入服务端 `dropped`）。产物按帧快照解析，热更新不回溯（C.8）。
 */

import {
  BridgeChannel,
  BridgeFrameError,
  BridgePayloadKind,
  FRAME_HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PAYLOAD_LENGTH,
  decodeFrameHeader,
} from "./framing";
import {
  DebugSlotRegistry,
  decodeDebugEnvelope,
  type DebugArg,
  type DebugDecodeContext,
  type DebugEnvelope as DebugMessageEnvelope,
} from "./debugMessages";
import type { DebugContractMethod, DebugContractSnapshot, DebugContractState } from "./debugContractRegistry";

/** 规范化后的包络判别值：与线上 `type` 同名（`debug` / `debugResult` / `request` / …）。 */
export type DebugEnvelopeType =
  | "debug"
  | "debugCreate"
  | "debugFinish"
  | "debugFrame"
  | "debugResult"
  | "dropped"
  | "request"
  | "response";

export interface DebugEnvelopeCommon {
  readonly type: DebugEnvelopeType;
  /** 最近的 `debugFrame`；`-1` 表示还没有帧（C.2）。 */
  readonly frame: number;
  /** 载荷字节数（C.4 的记账单位：只算 `payloadLength`，不含帧头）。 */
  readonly wireBytes: number;
  readonly payloadKind: BridgePayloadKind;
}

export interface DebugCreateEnvelope extends DebugEnvelopeCommon {
  readonly type: "debugCreate";
  readonly category: string;
  readonly instance: string;
  readonly instanceSlot: number;
  readonly resName: string;
  readonly debugInfo: string;
}

export interface DebugFinishEnvelope extends DebugEnvelopeCommon {
  readonly type: "debugFinish";
  readonly category: string | undefined;
  readonly instance: string;
}

export interface DebugFrameEnvelope extends DebugEnvelopeCommon {
  readonly type: "debugFrame";
}

export interface DebugEventEnvelope extends DebugEnvelopeCommon {
  readonly type: "debug";
  readonly category: string | undefined;
  readonly instance: string | undefined;
  readonly interfaceId: string | undefined;
  readonly method: string | undefined;
  readonly methodId: number;
  readonly instanceSlot: number;
  readonly args: readonly DebugArg[];
  readonly contractState: DebugContractState;
}

export interface DebugResultEnvelope extends DebugEnvelopeCommon {
  readonly type: "debugResult";
  readonly category: string | undefined;
  readonly instance: string | undefined;
  readonly interfaceId: string | undefined;
  readonly method: string | undefined;
  readonly methodId: number;
  readonly instanceSlot: number;
  readonly requestId: string;
  readonly args: readonly DebugArg[];
  readonly contractState: DebugContractState;
}

export interface DebugRequestEnvelope extends DebugEnvelopeCommon {
  readonly type: "request";
  readonly requestId: string;
  readonly action: "debugQuery";
  readonly category: string | undefined;
  readonly instance: string;
  readonly interfaceId: string | undefined;
  readonly method: string | undefined;
  /** 方法号（A.5 的 JSON 信封字段，与二进制载荷头同源）；参数名按它查声明表。 */
  readonly methodId: number;
  readonly args: readonly DebugArg[];
}

export interface DebugResponseEnvelope extends DebugEnvelopeCommon {
  readonly type: "response";
  readonly requestId: string;
  readonly ok: boolean;
  readonly code: string | undefined;
  readonly detail: string | undefined;
}

export interface DebugDroppedEnvelope extends DebugEnvelopeCommon {
  readonly type: "dropped";
  readonly filteredByServer: number;
  readonly unknownMethod: number;
  readonly unknownSlot: number;
  readonly invalidRequest: number;
  readonly encodeFailed: number;
  readonly oversize: number;
  readonly queueOverflow: number;
}

/** 规范化包络：`type` / `frame` / `instance` / `category` / `method` / `args` + `wireBytes`。 */
export type DebugEnvelope =
  | DebugCreateEnvelope
  | DebugFinishEnvelope
  | DebugFrameEnvelope
  | DebugEventEnvelope
  | DebugResultEnvelope
  | DebugRequestEnvelope
  | DebugResponseEnvelope
  | DebugDroppedEnvelope;

/** 连接层解出的帧（`BridgeFrame` 结构化兼容）。 */
export interface DebugFrameLike {
  readonly channel: number;
  readonly payloadKind: BridgePayloadKind;
  readonly payload: Buffer;
}

/** 接收计数快照；只增不减，{@link DebugIngress.reset} 之后归零。 */
export interface DebugIngressCounters {
  /** 收到的全部帧（含通道 0）。 */
  readonly frames: number;
  /** 通道 0 帧：属于编辑器/控制面，不进调试数据面（A.2）。 */
  readonly controlFrames: number;
  /** 通道 1 载荷字节数合计（C.4 记账单位）。 */
  readonly wireBytes: number;
  /** 成功交付的包络数。 */
  readonly envelopes: number;
  /** 帧头 CRC 失败（只发生在文件源；网络源由连接层断开，A.1）。 */
  readonly crcFailures: number;
  /** 非法通道 / 非法载荷类型。 */
  readonly invalidFrames: number;
  /** 单帧载荷超过 1 MB。 */
  readonly oversizeFrames: number;
  /** 帧头不足 6 字节 / 录制流末尾残留不足一帧。 */
  readonly truncatedFrames: number;
  /** 载荷无法解析为消息（JSON 语法、二进制截断、未知 type）。 */
  readonly malformedMessages: number;
  /** 槽位未知（`Create` 未到或已 `Finish`）。 */
  readonly unknownSlots: number;
  /** 服务端方法号不可用（0/3–9 预留或枚举宽度缺失）。 */
  readonly unknownMethods: number;
  /** 契约级未知方法：`(category, methodId)` 不在约定产物里（A.5：不计入服务端 dropped）。 */
  readonly unknownContractMethods: number;
  /** 二进制载荷无法判定 `debug` / `debugResult`（缺挂起表）。 */
  readonly ambiguousMessages: number;
  /** `request` 消息字段非法。 */
  readonly invalidRequests: number;
}

const ZERO_COUNTERS: DebugIngressCounters = {
  frames: 0,
  controlFrames: 0,
  wireBytes: 0,
  envelopes: 0,
  crcFailures: 0,
  invalidFrames: 0,
  oversizeFrames: 0,
  truncatedFrames: 0,
  malformedMessages: 0,
  unknownSlots: 0,
  unknownMethods: 0,
  unknownContractMethods: 0,
  ambiguousMessages: 0,
  invalidRequests: 0,
};

export interface DebugIngressOptions {
  /** 该连接/该数据源绑定的契约快照；缺省 = 无契约，全部走通用视图（C.8）。 */
  readonly contracts?: DebugContractSnapshot;
  /** 槽位路由表；F2 需要与接收共享同一份时注入。 */
  readonly slots?: DebugSlotRegistry;
  /**
   * 查询挂起表（A.4 用来区分 `debug` 与 `debugResult`）；**由 F6 显式注入**。
   * 缺省时保持 `undefined`，二进制载荷一律按 `ambiguousEnvelope` 计数丢弃——
   * 绝不把 `u32 requestId` 当参数区静默解析（E4 解码器的保护依赖这一点）。
   */
  readonly isPendingRequest?: (requestId: number) => boolean;
  /**
   * 已知请求号（在途 + 已结算/已超时）；同样由 F6 注入，与 {@link isPendingRequest} 同时给出时优先。
   * 只给挂起表时，超时请求的**晚到结果**会被解成 `debug`（垃圾参数）或按 `unknownMethod` 丢掉；
   * 给出本回调后仍解成 `debugResult`，由查询客户端判定"已完成 / 已超时后丢弃"（A.5）。
   */
  readonly isKnownRequest?: (requestId: number) => boolean;
  /**
   * 显式声明"本数据源确定没有挂起请求"（F1 单测解事件帧用）。
   * 与 {@link isPendingRequest} 同时给出时后者优先；缺省仍走 `ambiguousEnvelope`。
   */
  readonly assumeNoPendingRequests?: boolean;
  readonly maxPayloadBytes?: number;
  readonly log?: (message: string) => void;
}

/**
 * 调试接收入口。一个连接（或一次回看）一个实例：槽位表、当前帧与计数都属于该数据源。
 *
 * 契约快照在整个数据源生命周期里保持不变：热更新换掉的是注册表里的当前快照，
 * 已在飞的记录继续按旧快照展示（C.8）。
 */
export class DebugIngress {
  private readonly contracts: DebugContractSnapshot | undefined;
  private readonly slots: DebugSlotRegistry;
  private readonly pendingRequest: ((requestId: number) => boolean) | undefined;
  private readonly knownRequest: ((requestId: number) => boolean) | undefined;
  private readonly maxPayloadBytes: number;
  private readonly log: (message: string) => void;
  private countersValue: DebugIngressCounters = ZERO_COUNTERS;
  private currentFrame = -1;
  private recorded = Buffer.alloc(0);
  private recordedStreamStopped = false;

  public constructor(options: DebugIngressOptions = {}) {
    this.contracts = options.contracts;
    this.slots = options.slots ?? new DebugSlotRegistry();
    // 不提供挂起表时保持 undefined：让解码器返回 ambiguousEnvelope（A.4），由 F6 注入真实表。
    this.pendingRequest = options.isPendingRequest
      ?? (options.assumeNoPendingRequests === true ? () => false : undefined);
    this.knownRequest = options.isKnownRequest;
    this.maxPayloadBytes = options.maxPayloadBytes ?? MAX_MESSAGE_BYTES;
    this.log = options.log ?? (() => undefined);
  }

  /** 当前帧号；`-1` 表示还没收到 `debugFrame`（C.2）。 */
  public get frame(): number {
    return this.currentFrame;
  }

  /** 槽位路由表（`Create` 建立、`Finish`/断连移除，C.3）。 */
  public get slotRegistry(): DebugSlotRegistry {
    return this.slots;
  }

  /** 绑定到本数据源的契约快照。 */
  public get contractSnapshot(): DebugContractSnapshot | undefined {
    return this.contracts;
  }

  public get counters(): DebugIngressCounters {
    return { ...this.countersValue };
  }

  /** 新会话/新连接：清空槽位、当前帧与计数（分发器在重连时调用）。 */
  public reset(): void {
    this.slots.clear();
    this.currentFrame = -1;
    this.countersValue = ZERO_COUNTERS;
    this.recorded = Buffer.alloc(0);
    this.recordedStreamStopped = false;
  }

  /**
   * 处理一帧（网络源：帧已由连接层校验）。返回该帧产生的 0 或 1 条包络。
   * 通道 0、非法通道与超限帧只计数（A.1/A.2）。
   */
  public acceptFrame(frame: DebugFrameLike): readonly DebugEnvelope[] {
    const counters = { ...this.countersValue };
    counters.frames += 1;
    if (frame.channel === BridgeChannel.Control) {
      counters.controlFrames += 1;
      this.countersValue = counters;
      return [];
    }

    if (frame.channel !== BridgeChannel.Debug) {
      counters.invalidFrames += 1;
      this.countersValue = counters;
      return [];
    }

    if (frame.payloadKind !== BridgePayloadKind.Binary && frame.payloadKind !== BridgePayloadKind.Json) {
      counters.invalidFrames += 1;
      this.countersValue = counters;
      return [];
    }

    const wireBytes = frame.payload.length;
    counters.wireBytes += wireBytes;
    if (wireBytes > this.maxPayloadBytes) {
      counters.oversizeFrames += 1;
      this.countersValue = counters;
      return [];
    }

    this.countersValue = counters;
    return this.decode(frame.payloadKind, frame.payload, wireBytes);
  }

  /**
   * 处理一段录制字节（文件源）：按 6 字节帧头切帧后逐帧交付。
   *
   * 文件源是录制回放，帧层失败**不终止整次回看**（任务书 §评审清单 P1）：
   * - 帧头 CRC 失败 → 只计一次，停在**当前 block**；F5 在下一个 block 边界调
   *   {@link resumeRecordedStream} 继续，已建立的槽位、当前帧与计数全部保留；
   * - CRC 通过但通道/载荷类型非法或超过 1 MB → 长度字段可信，整帧跳过并交给
   *   {@link acceptFrame} 计数（与网络源的"跳过错帧继续"一致）；
   * - 末尾不足 6 字节的残帧由 {@link finishRecordedStream} 计数。
   */
  public acceptRecordedBytes(chunk: Uint8Array): readonly DebugEnvelope[] {
    if (this.recordedStreamStopped) {
      return [];
    }

    this.recorded = this.recorded.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.recorded, chunk]);
    const envelopes: DebugEnvelope[] = [];
    for (;;) {
      if (this.recorded.length < FRAME_HEADER_BYTES) {
        return envelopes;
      }

      let header;
      try {
        header = decodeFrameHeader(this.recorded.subarray(0, FRAME_HEADER_BYTES));
      } catch (errorValue) {
        const lengthTrusted = errorValue instanceof BridgeFrameError && errorValue.code !== "frame.invalidCrc";
        if (!lengthTrusted) {
          this.countFrameFailure(errorValue);
          this.stopRecordedBlock();
          return envelopes;
        }

        // CRC 通过 ⇒ 长度字段可信：超限/非法通道的帧整帧丢弃，后面的帧继续解。
        const word = this.recorded.readUInt32BE(0);
        const end = FRAME_HEADER_BYTES + (word & MAX_PAYLOAD_LENGTH);
        if (this.recorded.length < end) {
          // 整帧尚未到齐：等后续字节，计数留给真正把该帧交给 acceptFrame 的那次调用。
          return envelopes;
        }

        const payload = this.recorded.subarray(FRAME_HEADER_BYTES, end);
        this.recorded = this.recorded.subarray(end);
        envelopes.push(...this.acceptFrame({
          channel: word >>> 31,
          payloadKind: ((word >>> 29) & 0x3) as BridgePayloadKind,
          payload,
        }));
        continue;
      }

      const end = FRAME_HEADER_BYTES + header.payloadLength;
      if (this.recorded.length < end) {
        return envelopes;
      }

      const payload = this.recorded.subarray(FRAME_HEADER_BYTES, end);
      this.recorded = this.recorded.subarray(end);
      envelopes.push(...this.acceptFrame({ channel: header.channel, payloadKind: header.payloadKind, payload }));
    }
  }

  /**
   * 录制回放跨过坏块：只清当前 block 的残留字节与停止标志，
   * **保留**槽位表、当前帧与计数（{@link reset} 是"新会话全清"，不得复用作恢复）。
   */
  public resumeRecordedStream(): void {
    this.recorded = Buffer.alloc(0);
    this.recordedStreamStopped = false;
  }

  /**
   * 录制文件读完时调用：末尾不足一帧的残留字节计入 `truncatedFrames`。
   * 返回是否丢弃了残帧（调用方可据此标注录制损坏）。
   */
  public finishRecordedStream(): boolean {
    const trailing = this.recorded.length;
    this.recorded = Buffer.alloc(0);
    if (trailing === 0) {
      return false;
    }

    const counters = { ...this.countersValue };
    counters.truncatedFrames += 1;
    this.countersValue = counters;
    this.log(`[debug] recorded stream ended with ${trailing} trailing byte(s) of an incomplete frame`);
    return true;
  }

  /** 录制字节流当前 block 是否已因帧头 CRC 失败停止（`resumeRecordedStream` 可恢复）。 */
  public get recordedStopped(): boolean {
    return this.recordedStreamStopped;
  }

  private stopRecordedBlock(): void {
    this.recorded = Buffer.alloc(0);
    this.recordedStreamStopped = true;
  }

  private countFrameFailure(errorValue: unknown): void {
    const counters = { ...this.countersValue };
    if (errorValue instanceof BridgeFrameError) {
      switch (errorValue.code) {
        case "frame.invalidCrc":
          counters.crcFailures += 1;
          break;
        case "frame.truncated":
          counters.truncatedFrames += 1;
          break;
        case "frame.payloadTooLarge":
          counters.oversizeFrames += 1;
          break;
        default:
          counters.invalidFrames += 1;
          break;
      }

      this.log(`[debug] recorded frame rejected: ${errorValue.message}`);
    } else {
      counters.invalidFrames += 1;
      this.log(`[debug] recorded frame rejected: ${String(errorValue)}`);
    }

    this.countersValue = counters;
  }

  private decode(payloadKind: BridgePayloadKind, payload: Buffer, wireBytes: number): readonly DebugEnvelope[] {
    const decoded = decodeDebugEnvelope(payloadKind, payload, this.decodeContext());
    if (!decoded.ok) {
      const counters = { ...this.countersValue };
      switch (decoded.reason) {
        case "unknownSlot":
          counters.unknownSlots += 1;
          break;
        case "unknownMethod":
          counters.unknownMethods += 1;
          break;
        case "ambiguousEnvelope":
          counters.ambiguousMessages += 1;
          break;
        case "invalidRequest":
          counters.invalidRequests += 1;
          break;
        default:
          counters.malformedMessages += 1;
          break;
      }

      this.countersValue = counters;
      this.log(`[debug] dropped ${payloadKind === BridgePayloadKind.Binary ? "binary" : "json"} payload: ${decoded.reason} (${decoded.detail})`);
      return [];
    }

    const envelope = this.normalize(decoded.message, payloadKind, wireBytes);
    if (envelope === undefined) {
      return [];
    }

    const counters = { ...this.countersValue };
    counters.envelopes += 1;
    this.countersValue = counters;
    return [envelope];
  }

  private decodeContext(): DebugDecodeContext {
    const contracts = this.contracts;
    return {
      resolveSlot: (instanceSlot) => this.slots.resolve(instanceSlot),
      resolveEnumWidth: contracts === undefined
        ? () => undefined
        : (category, methodId, tag) => contracts.resolveEnumWidth(category ?? "", methodId, tag),
      // 缺表时整条键都不给，解码器才会走 `ambiguousEnvelope`（A.4）。
      ...(this.pendingRequest === undefined ? {} : { isPendingRequest: this.pendingRequest }),
      ...(this.knownRequest === undefined ? {} : { isKnownRequest: this.knownRequest }),
    };
  }

  private normalize(
    message: DebugMessageEnvelope,
    payloadKind: BridgePayloadKind,
    wireBytes: number,
  ): DebugEnvelope | undefined {
    const frame = this.currentFrame;
    switch (message.kind) {
      case "debugFrame":
        this.currentFrame = message.frame;
        return { type: "debugFrame", frame: message.frame, wireBytes, payloadKind };
      case "debugCreate":
        if (message.category.length === 0 || message.instance.length === 0 || !Number.isInteger(message.instanceSlot)) {
          // A.5 的必填身份字段缺失：拒绝并计数，绝不注册一个 category 为空、槽位被默认成 0 的实例。
          const counters = { ...this.countersValue };
          counters.malformedMessages += 1;
          this.countersValue = counters;
          this.log("[debug] dropped debugCreate: category/instance/instanceSlot are required by A.5");
          return undefined;
        }

        // Create 建立槽位：之后的二进制数据帧靠它反查实例与分类（A.4）。
        this.slots.register(message.instance, message.category, message.instanceSlot);
        return {
          type: "debugCreate",
          frame,
          wireBytes,
          payloadKind,
          category: message.category,
          instance: message.instance,
          instanceSlot: message.instanceSlot,
          resName: message.resName,
          debugInfo: message.debugInfo,
        };
      case "debugFinish":
        this.slots.finish(message.instance.length === 0 ? undefined : message.instance);
        return {
          type: "debugFinish",
          frame,
          wireBytes,
          payloadKind,
          category: message.category,
          instance: message.instance,
        };
      case "debug":
      case "debugResult": {
        // 只有二进制帧依赖契约才能解释（A.4）；JSON 自带类型与名字，缺契约时照样展示（C.2）。
        const strict = payloadKind === BridgePayloadKind.Binary;
        const resolved = this.resolveContract(
          message.category,
          message.methodId,
          message.iface,
          message.method,
          strict,
        );
        if (resolved === undefined) {
          // A.4：约定产物在手却查不到 (category, methodId) → 丢弃并计数（A.5 归消费端）。
          const counters = { ...this.countersValue };
          counters.unknownContractMethods += 1;
          this.countersValue = counters;
          this.log(
            `[debug] dropped ${message.kind} (category='${message.category ?? ""}', methodId=${message.methodId}): not in debug-contracts.json`,
          );
          return undefined;
        }

        const args = this.nameArguments(message.args, resolved.declaration);
        const common = {
          frame,
          wireBytes,
          payloadKind,
          category: message.category,
          instance: message.instance,
          // 二进制信封不带 iface/method（A.4）：命中契约时从声明补齐，与 JSON 同构；
          // 未命中时保持 undefined（C.2 的 contractState 已表达"没有身份"）。
          interfaceId: message.iface ?? resolved.declaration?.interfaceId,
          method: message.method ?? resolved.declaration?.name,
          methodId: message.methodId,
          instanceSlot: message.instanceSlot,
          args,
          contractState: resolved.state,
        };
        if (message.kind === "debugResult") {
          return { type: "debugResult", ...common, requestId: message.requestId };
        }

        return { type: "debug", ...common };
      }
      case "request":
        return {
          type: "request",
          frame,
          wireBytes,
          payloadKind,
          requestId: message.requestId,
          action: message.action,
          category: message.category,
          instance: message.instance,
          interfaceId: message.iface,
          method: message.method,
          methodId: message.methodId,
          args: this.nameArguments(
            message.args,
            this.declarationFor(message.category, message.iface, message.method, message.methodId),
          ),
        };
      case "response":
        return {
          type: "response",
          frame,
          wireBytes,
          payloadKind,
          requestId: message.requestId,
          ok: message.ok,
          code: message.code,
          detail: message.detail,
        };
      case "dropped":
        return {
          type: "dropped",
          frame,
          wireBytes,
          payloadKind,
          filteredByServer: message.filteredByServer,
          unknownMethod: message.unknownMethod,
          unknownSlot: message.unknownSlot,
          invalidRequest: message.invalidRequest,
          encodeFailed: message.encodeFailed,
          oversize: message.oversize,
          queueOverflow: message.queueOverflow,
        };
      default:
        return undefined;
    }
  }

  /**
   * 契约解析：命中返回声明与状态；未命中返回 `undefined` 只代表"**约定产物在手**却查不到"，
   * 该情形按 A.4 丢弃——但仅限二进制帧（`strict`），因为 JSON 帧自带类型与名字。
   * 没有主来源（只有补充目录或完全没契约）时返回兜底状态，让记录照常展示（C.2）。
   */
  private resolveContract(
    category: string | undefined,
    methodId: number,
    interfaceId: string | undefined,
    method: string | undefined,
    strict: boolean,
  ): { readonly declaration: DebugContractMethod | undefined; readonly state: DebugContractState } | undefined {
    const contracts = this.contracts;
    if (contracts === undefined) {
      return { declaration: undefined, state: "unknown-interface" };
    }

    const resolved = contracts.resolveMessage(
      category,
      methodId > 0 ? methodId : undefined,
      interfaceId,
      method,
    );
    if (resolved.declaration !== undefined) {
      return { declaration: resolved.declaration, state: resolved.state };
    }

    if (!strict || contracts.primary === undefined) {
      // 只有补充目录：不会因为"补充不全"丢掉约定产物本该覆盖的记录。
      return { declaration: undefined, state: resolved.state };
    }

    return undefined;
  }

  private declarationFor(
    category: string | undefined,
    interfaceId: string | undefined,
    method: string | undefined,
    methodId: number,
  ): DebugContractMethod | undefined {
    if (this.contracts === undefined || category === undefined) {
      return undefined;
    }

    // 方法号优先：A.5 的信封自带 methodId（与二进制载荷头同一真源），iface/method 只是名字兜底。
    if (methodId > 0) {
      return this.contracts.resolveMessage(category, methodId, interfaceId, method).declaration;
    }

    if (interfaceId === undefined || method === undefined) {
      return undefined;
    }

    return this.contracts.resolveByMethodName(category, interfaceId, method);
  }

  private nameArguments(
    args: readonly DebugArg[],
    declaration: DebugContractMethod | undefined,
  ): readonly DebugArg[] {
    if (declaration === undefined || args.length === 0) {
      return args;
    }

    const names = new Map<number, string>();
    for (const parameter of declaration.parameters) {
      names.set(parameter.tag, parameter.name);
    }

    if (declaration.result !== undefined) {
      names.set(declaration.result.tag, declaration.result.name);
    }

    return args.map((arg) => {
      if (arg.name !== undefined) {
        return arg;
      }

      const name = names.get(arg.tag);
      return name === undefined ? arg : { ...arg, name };
    });
  }
}
