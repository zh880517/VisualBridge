/**
 * 连接级 socket 封装：把任意 `net.Socket` 变成「帧解码 + 通道分流 + 双队列单写序列」。
 *
 * 收发语义：
 * - 接收：字节流交给 {@link BridgeFrameDecoder}；帧头 CRC/长度非法立即断开，不重同步。
 *   通道 0 交给 `onControlPayload`，通道 1 交给 `onDebugFrame`。
 * - 发送：控制/数据消息进入 {@link BridgeSendQueues}，由单一直写循环按序号写出；
 *   控制队列满时断开连接（控制消息不可丢）。
 *
 * 与 C# 侧 `VisualBridgeBridgeSocket` 保持同一语义。
 */

import * as net from "node:net";
import {
  BridgeChannel,
  BridgeFrameDecoder,
  BridgeFrameError,
  BridgePayloadKind,
  encodeFrame,
} from "./framing";
import {
  BridgeEnqueueResult,
  BridgeSendCounters,
  BridgeSendLimits,
  BridgeSendQueues,
  DEFAULT_BRIDGE_SEND_LIMITS,
} from "./sendQueues";

export interface BridgeSocketHandlers {
  /** 通道 0 的业务载荷；`payloadKind` 原样带出，录制端要据此还原线上帧头。 */
  readonly onControlPayload: (payload: Buffer, payloadKind: BridgePayloadKind) => void;
  readonly onDebugFrame: (payloadKind: BridgePayloadKind, payload: Buffer) => void;
  readonly onClosed: (error: Error | undefined) => void;
}

/** 保活参数（附录 A.9）：空闲 10 s 入队 ping；30 s 无入站字节断开。 */
export interface BridgeHeartbeatOptions {
  readonly intervalMs?: number;
  readonly idleTimeoutMs?: number;
  readonly disabled?: boolean;
  /** 可注入时钟与定时器：单测用假时钟驱动 {@link BridgeSocket.tickHeartbeat} 的同一逻辑。 */
  readonly now?: () => number;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface BridgeSocketOptions {
  readonly limits?: Partial<BridgeSendLimits>;
  readonly log?: (message: string) => void;
  readonly heartbeat?: BridgeHeartbeatOptions;
}

export const DEFAULT_BRIDGE_HEARTBEAT_INTERVAL_MS = 10000;
export const DEFAULT_BRIDGE_IDLE_TIMEOUT_MS = 30000;

const PING_PAYLOAD = Buffer.from("{\"type\":\"ping\"}", "utf8");
const PONG_PAYLOAD = Buffer.from("{\"type\":\"pong\"}", "utf8");
const MAX_CONTROL_CLASSIFY_BYTES = 64;

export class BridgeSocket {
  private readonly socket: net.Socket;
  private readonly handlers: BridgeSocketHandlers;
  private readonly queues: BridgeSendQueues;
  private readonly decoder = new BridgeFrameDecoder();
  private readonly log: (message: string) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatIdleTimeoutMs: number;
  private readonly heartbeatNow: () => number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private finished = false;
  private ending = false;
  private waitingDrain = false;
  private lastInboundAt: number;
  private lastOutboundAt: number;
  private heartbeatTimer: unknown;

  public constructor(socket: net.Socket, handlers: BridgeSocketHandlers, options: BridgeSocketOptions = {}) {
    this.socket = socket;
    this.handlers = handlers;
    this.log = options.log ?? (() => undefined);
    const heartbeat = options.heartbeat ?? {};
    this.heartbeatIntervalMs = heartbeat.intervalMs ?? DEFAULT_BRIDGE_HEARTBEAT_INTERVAL_MS;
    this.heartbeatIdleTimeoutMs = heartbeat.idleTimeoutMs ?? DEFAULT_BRIDGE_IDLE_TIMEOUT_MS;
    this.heartbeatNow = heartbeat.now ?? (() => Date.now());
    this.setIntervalFn = heartbeat.setInterval ?? ((handler, ms) => {
      const timer = setInterval(handler, ms);
      // 保活定时器不得单独吊住 Node 进程。
      (timer as { unref?: () => void }).unref?.();
      return timer;
    });
    this.clearIntervalFn = heartbeat.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

    this.queues = new BridgeSendQueues({
      ...DEFAULT_BRIDGE_SEND_LIMITS,
      ...(options.limits ?? {}),
    });

    const now = this.heartbeatNow();
    this.lastInboundAt = now;
    this.lastOutboundAt = now;
    if (heartbeat.disabled !== true) {
      const period = Math.max(10, Math.min(100, Math.floor(Math.max(1, this.heartbeatIntervalMs) / 4)));
      this.heartbeatTimer = this.setIntervalFn(() => this.tickHeartbeat(), period);
    }

    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("drain", () => {
      this.waitingDrain = false;
      this.drain();
    });
    socket.on("end", () => this.handleEnd());
    socket.on("close", () => this.finish(undefined));
  }

  public get isOpen(): boolean {
    return !this.finished && !this.ending;
  }

  /**
   * 传输是否已不可用：本端已 end/close，或对端 FIN / 套接字销毁已**同步可见**
   * （`destroyed` / `readableEnded` 由读回调设置，早于异步投递的 `close` 事件）。
   *
   * 与 {@link isOpen} 的区别：`isOpen` 只表达本端还能不能发；该值用于必须与关闭事件
   * 解耦的判定（编辑器通道的一对一连接门，附录 A.6 `runtime.alreadyConnected`）——
   * 只看 `close` 事件会让"对端已断但事件未派发"的连接继续占位并误拒重连。
   */
  public get isTerminated(): boolean {
    return this.finished || this.ending || this.socket.destroyed || this.socket.readableEnded;
  }

  public get sendCounters(): BridgeSendCounters {
    return this.queues.counterSnapshot;
  }

  /** 入队并写出一个通道 0 JSON 消息；超过 1 MB 被拒绝并计数，连接保持。 */
  public sendControlJson(message: unknown): boolean {
    return this.sendControl(Buffer.from(JSON.stringify(message), "utf8"));
  }

  /**
   * 控制队列消息（不淘汰）；`channel` 决定帧头通道位，默认通道 0。
   * 通道 1 的控制类消息用 {@link sendDebugControl}，两者共用同一条控制队列与屏障语义。
   */
  public sendControl(
    payload: Uint8Array,
    payloadKind: BridgePayloadKind = BridgePayloadKind.Json,
    channel: BridgeChannel = BridgeChannel.Control,
  ): boolean {
    if (!this.isOpen) {
      return false;
    }

    const result = this.queues.enqueueControl(payload, payloadKind, channel);
    const enqueued = this.handleEnqueueResult(result, "control");
    if (enqueued) this.lastOutboundAt = this.heartbeatNow();
    return enqueued;
  }

  /** 通道 1 的控制类消息：走控制队列（不淘汰）但帧头通道位是 1（附录 A.2/A.9）。 */
  public sendDebugControl(payload: Uint8Array, payloadKind: BridgePayloadKind = BridgePayloadKind.Json): boolean {
    return this.sendControl(payload, payloadKind, BridgeChannel.Debug);
  }

  /** 入队并写出一个通道 1 消息；数据队列满时淘汰最旧数据消息。 */
  public sendDebug(payload: Uint8Array, payloadKind: BridgePayloadKind): boolean {
    if (!this.isOpen) {
      return false;
    }

    const result = this.queues.enqueueDebug(payload, payloadKind);
    const enqueued = this.handleEnqueueResult(result, "debug");
    if (enqueued) this.lastOutboundAt = this.heartbeatNow();
    return enqueued;
  }

  /** 立即断开（丢弃未写出的队列内容）。 */
  public close(): void {
    if (this.finished) {
      return;
    }

    this.finish(undefined);
  }

  /**
   * 优雅关闭：不再接受新消息，把已入队内容写完再关闭写方向；
   * 用于「先回错误帧再断开」的错误路径。
   *
   * 背压下（{@link waitingDrain}）不能立即 `socket.end()`：队列里尚未写出的
   * 最后一帧（典型是错误回复）会随写方向关闭被丢掉。此时只标记 `ending`，
   * 由 `drain` 事件重入 {@link drain} 写空队列后再收尾。
   */
  public end(): void {
    if (this.finished || this.ending) {
      return;
    }

    this.ending = true;
    this.queues.stopAccepting();
    this.drain();
  }

  private receive(chunk: Buffer): void {
    if (this.finished) {
      return;
    }

    // 任意入站字节都算活动（附录 A.9：30 s 无入站字节才断开）。
    this.lastInboundAt = this.heartbeatNow();

    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (errorValue) {
      this.fail(asError(errorValue));
      return;
    }

    for (const frame of frames) {
      try {
        if (frame.channel === BridgeChannel.Control) {
          // 保活消息在连接层消化：ping 立即回 pong，pong 只刷新空闲计时，都不交给握手/业务。
          if (frame.payloadKind === BridgePayloadKind.Json && classifyKeepAlive(frame.payload) === "ping") {
            this.sendControl(PONG_PAYLOAD);
          } else if (frame.payloadKind === BridgePayloadKind.Json && classifyKeepAlive(frame.payload) === "pong") {
            continue;
          } else {
            this.handlers.onControlPayload(frame.payload, frame.payloadKind);
          }
        } else {
          this.handlers.onDebugFrame(frame.payloadKind, frame.payload);
        }
      } catch (errorValue) {
        // 业务处理抛错等同于连接不可继续：断开，避免半处理状态被后续帧放大。
        this.fail(asError(errorValue));
        return;
      }
    }
  }

  /**
   * 写线程的保活判定（附录 A.9）：空闲超心跳间隔就入队 `ping`；连续超过空闲上限没有
   * 入站字节就断开（把"静默死链"变成显式的断开判定，而不是永远等不到数据）。
   * 定时器与假时钟共用本方法，单测直接驱动同一逻辑。
   */
  public tickHeartbeat(): void {
    if (this.finished) {
      return;
    }

    const now = this.heartbeatNow();
    if (this.heartbeatIdleTimeoutMs > 0 && now - this.lastInboundAt > this.heartbeatIdleTimeoutMs) {
      const idleMs = now - this.lastInboundAt;
      this.log(`[bridge] no inbound bytes for ${idleMs} ms (idle timeout ${this.heartbeatIdleTimeoutMs} ms); closing the connection.`);
      this.fail(new Error(`Idle timeout: no inbound bytes for ${idleMs} ms.`));
      return;
    }

    if (now - this.lastOutboundAt < this.heartbeatIntervalMs) {
      return;
    }

    if (this.queues.controlPendingCount > 0 || this.queues.dataPendingCount > 0) {
      // 已有积压：等它们写出后 lastOutboundAt 会前进，不必再塞 ping。
      return;
    }

    this.sendControl(PING_PAYLOAD);
  }

  private handleEnd(): void {
    if (this.finished) {
      return;
    }

    try {
      this.decoder.finish();
    } catch (errorValue) {
      this.fail(asError(errorValue));
      return;
    }

    // 对端正常半关闭；等待 close 事件统一收尾。
  }

  private handleEnqueueResult(result: BridgeEnqueueResult, channel: "control" | "debug"): boolean {
    if (result.ok) {
      this.drain();
      return true;
    }

    if (result.reason === "messageTooLarge") {
      this.log(`[bridge] ${channel} message rejected: exceeds the maximum message size.`);
      return false;
    }

    if (result.reason === "controlQueueFull") {
      this.log("[bridge] control queue is full; closing the connection instead of dropping control messages.");
      this.fail(new Error("Control queue is full."));
      return false;
    }

    return false;
  }

  /** 单一写循环：按队列给出的序号顺序写出，直到队列空或遇到背压。 */
  private drain(): void {
    if (this.finished || this.waitingDrain) {
      return;
    }

    while (!this.finished) {
      const message = this.queues.dequeue();
      if (message === undefined) {
        break;
      }

      let frame: Buffer;
      try {
        frame = encodeFrame(message.channel, message.payloadKind, message.payload);
      } catch (errorValue) {
        this.fail(asError(errorValue));
        return;
      }

      try {
        if (!this.socket.write(frame)) {
          this.waitingDrain = true;
          break;
        }
      } catch (errorValue) {
        this.fail(asError(errorValue));
        return;
      }
    }

    if (this.ending && !this.finished && !this.waitingDrain) {
      this.socket.end();
    }
  }

  private fail(error: Error): void {
    if (error instanceof BridgeFrameError) {
      this.log(`[bridge] framing error: ${error.message}`);
    } else {
      this.log(`[bridge] connection failed: ${error.message}`);
    }

    this.finish(error);
  }

  private finish(error: Error | undefined): void {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.stopHeartbeat();
    this.queues.close();
    this.socket.removeAllListeners("data");
    this.socket.destroy();
    try {
      this.handlers.onClosed(error);
    } catch (errorValue) {
      this.log(`[bridge] close handler failed: ${asError(errorValue).message}`);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) {
      return;
    }

    const timer = this.heartbeatTimer;
    this.heartbeatTimer = undefined;
    try {
      this.clearIntervalFn(timer);
    } catch {
      // 定时器已随进程/测试时钟消失。
    }
  }
}

/**
 * 只识别 ≤64 字节的通道 0 JSON 控制载荷：其余一律原样交给上层，避免误吞业务消息。
 * 返回 `"ping"` / `"pong"` / undefined。
 */
function classifyKeepAlive(payload: Buffer): "ping" | "pong" | undefined {
  if (payload.length === 0 || payload.length > MAX_CONTROL_CLASSIFY_BYTES) return undefined;
  const text = payload.toString("utf8");
  if (!text.includes("\"type\"")) return undefined;
  try {
    const value = JSON.parse(text) as { readonly type?: unknown };
    return value.type === "ping" || value.type === "pong" ? value.type : undefined;
  } catch {
    return undefined;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
