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
  readonly onControlPayload: (payload: Buffer) => void;
  readonly onDebugFrame: (payloadKind: BridgePayloadKind, payload: Buffer) => void;
  readonly onClosed: (error: Error | undefined) => void;
}

export interface BridgeSocketOptions {
  readonly limits?: Partial<BridgeSendLimits>;
  readonly log?: (message: string) => void;
}

export class BridgeSocket {
  private readonly socket: net.Socket;
  private readonly handlers: BridgeSocketHandlers;
  private readonly queues: BridgeSendQueues;
  private readonly decoder = new BridgeFrameDecoder();
  private readonly log: (message: string) => void;
  private finished = false;
  private ending = false;
  private waitingDrain = false;

  public constructor(socket: net.Socket, handlers: BridgeSocketHandlers, options: BridgeSocketOptions = {}) {
    this.socket = socket;
    this.handlers = handlers;
    this.log = options.log ?? (() => undefined);
    this.queues = new BridgeSendQueues({
      ...DEFAULT_BRIDGE_SEND_LIMITS,
      ...(options.limits ?? {}),
    });

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
    return this.handleEnqueueResult(result, "control");
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
    return this.handleEnqueueResult(result, "debug");
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
          this.handlers.onControlPayload(frame.payload);
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
    this.queues.close();
    this.socket.removeAllListeners("data");
    this.socket.destroy();
    try {
      this.handlers.onClosed(error);
    } catch (errorValue) {
      this.log(`[bridge] close handler failed: ${asError(errorValue).message}`);
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
