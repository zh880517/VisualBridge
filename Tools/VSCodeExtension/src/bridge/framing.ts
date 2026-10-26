/**
 * 统一协议连接层的成帧：6 字节帧头 + 载荷。
 *
 * 帧头布局（大端）：
 * +0  u32  channel(1) | payloadKind(2) | payloadLength(29)
 * +4  u16  CRC-16/CCITT-FALSE（只覆盖前 4 字节，载荷不参与）
 * +6  ...  载荷
 *
 * 无魔数；收到 CRC 或长度非法的帧头即判定连接损坏，调用方必须立即断开，
 * 不尝试重同步（长度字段已不可信）。
 */

export const FRAME_HEADER_BYTES = 6;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_PAYLOAD_LENGTH = 0x1fffffff;

const CRC16_POLYNOMIAL = 0x1021;
const CRC16_INITIAL = 0xffff;
const CHANNEL_SHIFT = 31;
const PAYLOAD_KIND_SHIFT = 29;
const PAYLOAD_LENGTH_MASK = 0x1fffffff;
const CRC16_TABLE = buildCrc16Table();

/** 通道 0 = 控制/编辑器（JSON）；通道 1 = 调试（JSON 或二进制）。 */
export enum BridgeChannel {
  Control = 0,
  Debug = 1,
}

/** 载荷类型 0 = 二进制；1 = JSON。 */
export enum BridgePayloadKind {
  Binary = 0,
  Json = 1,
}

export type BridgeFrameErrorCode =
  | "frame.invalidCrc"
  | "frame.payloadTooLarge"
  | "frame.invalidChannel"
  | "frame.invalidPayloadKind"
  | "frame.truncated";

/** 帧层协议错误：出现即断开，绝不重同步。 */
export class BridgeFrameError extends Error {
  public constructor(
    public readonly code: BridgeFrameErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "BridgeFrameError";
  }
}

export interface BridgeFrameHeader {
  readonly channel: BridgeChannel;
  readonly payloadKind: BridgePayloadKind;
  readonly payloadLength: number;
}

export interface BridgeFrame extends BridgeFrameHeader {
  readonly payload: Buffer;
}

/** CRC-16/CCITT-FALSE：poly 0x1021、init 0xFFFF、不反射、xorout 0。 */
export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = CRC16_INITIAL;
  for (const byte of bytes) {
    crc = CRC16_TABLE[((crc >>> 8) ^ byte) & 0xff]! ^ ((crc << 8) & 0xffff);
  }

  return crc & 0xffff;
}

/** 编码 6 字节帧头（含 CRC）；入参在写线上前先做范围校验。 */
export function encodeFrameHeader(
  channel: BridgeChannel,
  payloadKind: BridgePayloadKind,
  payloadLength: number,
): Buffer {
  validateChannel(channel);
  validatePayloadKind(payloadKind);
  if (!Number.isInteger(payloadLength) || payloadLength < 0 || payloadLength > MAX_PAYLOAD_LENGTH) {
    throw new BridgeFrameError("frame.payloadTooLarge", `Payload length ${payloadLength} does not fit the 29-bit header field.`);
  }

  if (payloadLength > MAX_MESSAGE_BYTES) {
    throw new BridgeFrameError("frame.payloadTooLarge", `Payload length ${payloadLength} exceeds the ${MAX_MESSAGE_BYTES}-byte limit.`);
  }

  const word = ((channel << CHANNEL_SHIFT) | (payloadKind << PAYLOAD_KIND_SHIFT) | payloadLength) >>> 0;
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(word, 0);
  header.writeUInt16BE(crc16CcittFalse(header.subarray(0, 4)), 4);
  return header;
}

/** 校验并解码 6 字节帧头。 */
export function decodeFrameHeader(header: Uint8Array): BridgeFrameHeader {
  if (header.length !== FRAME_HEADER_BYTES) {
    throw new BridgeFrameError("frame.truncated", `Frame header must be ${FRAME_HEADER_BYTES} bytes, received ${header.length}.`);
  }

  const expected = ((header[4]! << 8) | header[5]!) & 0xffff;
  const actual = crc16CcittFalse(header.subarray(0, 4));
  if (actual !== expected) {
    throw new BridgeFrameError("frame.invalidCrc", `Frame header CRC mismatch: expected 0x${expected.toString(16)}, computed 0x${actual.toString(16)}.`);
  }

  const word = (((header[0]! << 24) | (header[1]! << 16) | (header[2]! << 8) | header[3]!) >>> 0);
  const channel = word >>> CHANNEL_SHIFT;
  const payloadKind = (word >>> PAYLOAD_KIND_SHIFT) & 0x3;
  const payloadLength = word & PAYLOAD_LENGTH_MASK;
  validateChannel(channel);
  validatePayloadKind(payloadKind);
  if (payloadLength > MAX_MESSAGE_BYTES) {
    throw new BridgeFrameError("frame.payloadTooLarge", `Payload length ${payloadLength} exceeds the ${MAX_MESSAGE_BYTES}-byte limit.`);
  }

  return { channel, payloadKind, payloadLength };
}

/** 编码完整帧（帧头 + 载荷），用于发送队列与单测。 */
export function encodeFrame(
  channel: BridgeChannel,
  payloadKind: BridgePayloadKind,
  payload: Uint8Array,
): Buffer {
  const header = encodeFrameHeader(channel, payloadKind, payload.length);
  return Buffer.concat([header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)]);
}

/**
 * 增量帧解码器：允许任意字节切分，只在读满帧头并校验通过后读取载荷。
 * 任一步失败即抛 {@link BridgeFrameError} 并锁定失败状态，调用方必须断开。
 */
export class BridgeFrameDecoder {
  private buffer = Buffer.alloc(0);
  private failure: BridgeFrameError | undefined;

  public push(chunk: Uint8Array): BridgeFrame[] {
    if (this.failure !== undefined) {
      throw this.failure;
    }

    if (chunk.length > 0) {
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, Buffer.from(chunk)]);
    }

    const frames: BridgeFrame[] = [];
    let offset = 0;
    try {
      while (this.buffer.length - offset >= FRAME_HEADER_BYTES) {
        const header = decodeFrameHeader(this.buffer.subarray(offset, offset + FRAME_HEADER_BYTES));
        const frameEnd = offset + FRAME_HEADER_BYTES + header.payloadLength;
        if (this.buffer.length < frameEnd) {
          break;
        }

        frames.push({
          channel: header.channel,
          payloadKind: header.payloadKind,
          payloadLength: header.payloadLength,
          payload: Buffer.from(this.buffer.subarray(offset + FRAME_HEADER_BYTES, frameEnd)),
        });
        offset = frameEnd;
      }
    } catch (errorValue) {
      this.failure = errorValue instanceof BridgeFrameError
        ? errorValue
        : new BridgeFrameError("frame.truncated", String(errorValue));
      throw this.failure;
    } finally {
      this.buffer = offset === 0 ? this.buffer : Buffer.from(this.buffer.subarray(offset));
    }

    return frames;
  }

  /**
   * 对端关闭时调用：若残留半帧，说明帧头声明的长度与实际字节数不符，
   * 按帧层错误处理；恰好停在帧边界则属正常关闭。
   */
  public finish(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }

    if (this.buffer.length > 0) {
      this.failure = new BridgeFrameError("frame.truncated", `Connection closed with ${this.buffer.length} pending byte(s) of an incomplete frame.`);
      throw this.failure;
    }
  }

  public reset(): void {
    this.buffer = Buffer.alloc(0);
    this.failure = undefined;
  }

  /** 尚未成帧的残留字节数（调试与单测用）。 */
  public get pendingBytes(): number {
    return this.buffer.length;
  }
}

function validateChannel(channel: number): asserts channel is BridgeChannel {
  if (channel !== BridgeChannel.Control && channel !== BridgeChannel.Debug) {
    throw new BridgeFrameError("frame.invalidChannel", `Unknown channel ${channel}.`);
  }
}

function validatePayloadKind(payloadKind: number): asserts payloadKind is BridgePayloadKind {
  if (payloadKind !== BridgePayloadKind.Binary && payloadKind !== BridgePayloadKind.Json) {
    throw new BridgeFrameError("frame.invalidPayloadKind", `Unknown payload kind ${payloadKind}.`);
  }
}

function buildCrc16Table(): Uint16Array {
  const table = new Uint16Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index << 8;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 0x8000) !== 0 ? ((value << 1) ^ CRC16_POLYNOMIAL) & 0xffff : (value << 1) & 0xffff;
    }

    table[index] = value;
  }

  return table;
}
