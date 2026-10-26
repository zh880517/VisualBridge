/**
 * 发送侧两条队列与单一写序列。
 *
 * - 控制队列：256 条、永不淘汰；满则连接必须断开（否则控制消息会静默丢失）。
 * - 数据队列：按字节 16 MB、按条数 65536；入队处丢最旧（只丢数据，不丢控制）。
 * - 每条消息入队时取全局单调序号；写线程永远按序号递增写出。
 * - 控制消息入队时记录数据队列尾序号作为屏障：屏障之前的数据消息必须先写出，
 *   保证 `Finish` 之类的控制消息不会越过在途数据帧。
 */

import {
  BridgeChannel,
  BridgePayloadKind,
  MAX_MESSAGE_BYTES,
} from "./framing";

export interface BridgeSendLimits {
  readonly controlCapacity: number;
  readonly dataCapacityBytes: number;
  readonly dataCapacityMessages: number;
  readonly maxMessageBytes: number;
}

export const DEFAULT_BRIDGE_SEND_LIMITS: BridgeSendLimits = {
  controlCapacity: 256,
  dataCapacityBytes: 16 * 1024 * 1024,
  dataCapacityMessages: 65536,
  maxMessageBytes: MAX_MESSAGE_BYTES,
};

export type BridgeEnqueueFailure = "messageTooLarge" | "controlQueueFull" | "closed";

export type BridgeEnqueueResult =
  | { readonly ok: true; readonly sequence: number }
  | { readonly ok: false; readonly reason: BridgeEnqueueFailure };

export interface BridgeSendCounters {
  readonly controlEnqueued: number;
  readonly debugEnqueued: number;
  readonly debugDroppedMessages: number;
  readonly debugDroppedBytes: number;
  readonly rejectedTooLarge: number;
  readonly writtenMessages: number;
  readonly writtenBytes: number;
  readonly writtenControl: number;
  readonly writtenDebug: number;
}

export interface BridgeQueuedMessage {
  readonly sequence: number;
  readonly channel: BridgeChannel;
  readonly payloadKind: BridgePayloadKind;
  readonly payload: Buffer;
  /** 仅控制消息：入队时的数据队列尾序号（0 表示此前无数据消息）。 */
  readonly barrier: number;
}

/**
 * 线程安全由调用方保证（Node 单线程；C# 侧对应实现用锁）。
 * `payload` 入队后按只读处理，调用方不得再修改其内容。
 */
export class BridgeSendQueues {
  private readonly limits: BridgeSendLimits;
  private readonly controlQueue: BridgeQueuedMessage[] = [];
  private readonly dataQueue: BridgeQueuedMessage[] = [];
  private nextSequence = 1;
  private lastDataSequence = 0;
  private dataBytes = 0;
  private accepting = true;
  private closed = false;
  private readonly counters: MutableSendCounters = {
    controlEnqueued: 0,
    debugEnqueued: 0,
    debugDroppedMessages: 0,
    debugDroppedBytes: 0,
    rejectedTooLarge: 0,
    writtenMessages: 0,
    writtenBytes: 0,
    writtenControl: 0,
    writtenDebug: 0,
  };

  public constructor(limits: BridgeSendLimits = DEFAULT_BRIDGE_SEND_LIMITS) {
    this.limits = limits;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get controlPendingCount(): number {
    return this.controlQueue.length;
  }

  public get dataPendingCount(): number {
    return this.dataQueue.length;
  }

  public get dataPendingBytes(): number {
    return this.dataBytes;
  }

  public get counterSnapshot(): BridgeSendCounters {
    return { ...this.counters };
  }

  /** 控制消息入队；满 256 条返回 `controlQueueFull`，调用方必须断开连接。 */
  public enqueueControl(payload: Uint8Array, payloadKind: BridgePayloadKind = BridgePayloadKind.Json): BridgeEnqueueResult {
    if (!this.accepting) {
      return { ok: false, reason: "closed" };
    }

    if (!this.acceptableSize(payload)) {
      this.counters.rejectedTooLarge += 1;
      return { ok: false, reason: "messageTooLarge" };
    }

    if (this.controlQueue.length >= this.limits.controlCapacity) {
      return { ok: false, reason: "controlQueueFull" };
    }

    const sequence = this.nextSequence++;
    this.controlQueue.push({
      sequence,
      channel: BridgeChannel.Control,
      payloadKind,
      payload: Buffer.from(payload),
      barrier: this.lastDataSequence,
    });
    this.counters.controlEnqueued += 1;
    return { ok: true, sequence };
  }

  /** 数据消息入队；超过任一容量上限时先淘汰最旧的数据消息。 */
  public enqueueDebug(payload: Uint8Array, payloadKind: BridgePayloadKind): BridgeEnqueueResult {
    if (!this.accepting) {
      return { ok: false, reason: "closed" };
    }

    if (!this.acceptableSize(payload)) {
      this.counters.rejectedTooLarge += 1;
      return { ok: false, reason: "messageTooLarge" };
    }

    if (payload.length > this.limits.dataCapacityBytes) {
      // 单条即超过整个数据队列容量：无可淘汰的旧消息，只能拒绝。
      this.counters.rejectedTooLarge += 1;
      return { ok: false, reason: "messageTooLarge" };
    }

    while (this.dataQueue.length > 0
      && (this.dataQueue.length + 1 > this.limits.dataCapacityMessages
        || this.dataBytes + payload.length > this.limits.dataCapacityBytes)) {
      this.evictOldestDebug();
    }

    const sequence = this.nextSequence++;
    this.lastDataSequence = sequence;
    this.dataQueue.push({
      sequence,
      channel: BridgeChannel.Debug,
      payloadKind,
      payload: Buffer.from(payload),
      barrier: 0,
    });
    this.dataBytes += payload.length;
    this.counters.debugEnqueued += 1;
    return { ok: true, sequence };
  }

  /**
   * 取下一个可写消息：按序号递增；控制消息只有在
   * 「序号不大于其屏障」的数据消息全部写出后才可写。
   */
  public dequeue(): BridgeQueuedMessage | undefined {
    if (this.closed) {
      return undefined;
    }

    const control = this.controlQueue[0];
    const data = this.dataQueue[0];
    let message: BridgeQueuedMessage | undefined;
    if (control !== undefined && data !== undefined) {
      // 屏障未满足时先写数据；否则按序号取较小者（控制消息序号必然大于其屏障）。
      message = data.sequence <= control.barrier || data.sequence < control.sequence
        ? this.shiftData()
        : this.shiftControl();
    } else if (control !== undefined) {
      message = this.shiftControl();
    } else if (data !== undefined) {
      message = this.shiftData();
    }

    if (message === undefined) {
      return undefined;
    }

    this.counters.writtenMessages += 1;
    this.counters.writtenBytes += message.payload.length;
    if (message.channel === BridgeChannel.Control) {
      this.counters.writtenControl += 1;
    } else {
      this.counters.writtenDebug += 1;
    }

    return message;
  }

  /** 停止接受新消息，但已入队内容仍可写出（优雅关闭的队列部分）。 */
  public stopAccepting(): void {
    this.accepting = false;
  }

  /** 关闭后不再接受入队，也不再有可写消息；已入队内容被丢弃。 */
  public close(): void {
    this.accepting = false;
    this.closed = true;
    this.controlQueue.length = 0;
    this.dataQueue.length = 0;
    this.dataBytes = 0;
  }

  private acceptableSize(payload: Uint8Array): boolean {
    return payload.length <= this.limits.maxMessageBytes;
  }

  private shiftControl(): BridgeQueuedMessage | undefined {
    return this.controlQueue.shift();
  }

  private shiftData(): BridgeQueuedMessage | undefined {
    const message = this.dataQueue.shift();
    if (message !== undefined) {
      this.dataBytes -= message.payload.length;
    }

    return message;
  }

  private evictOldestDebug(): void {
    const dropped = this.shiftData();
    if (dropped === undefined) {
      return;
    }

    this.counters.debugDroppedMessages += 1;
    this.counters.debugDroppedBytes += dropped.payload.length;
  }
}

interface MutableSendCounters {
  controlEnqueued: number;
  debugEnqueued: number;
  debugDroppedMessages: number;
  debugDroppedBytes: number;
  rejectedTooLarge: number;
  writtenMessages: number;
  writtenBytes: number;
  writtenControl: number;
  writtenDebug: number;
}
