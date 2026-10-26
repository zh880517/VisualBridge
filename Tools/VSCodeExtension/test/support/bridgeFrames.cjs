"use strict";

/**
 * 扩展宿主集成测试用的统一协议成帧工具（与 src/bridge/framing.ts 逐字节一致）。
 * 宿主测试运行在编译后的扩展里，不能直接 import TypeScript 源，因此保留一份最小实现。
 */

const FRAME_HEADER_BYTES = 6;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const CHANNEL_CONTROL = 0;
const CHANNEL_DEBUG = 1;
const KIND_BINARY = 0;
const KIND_JSON = 1;

const CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index << 8;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 0x8000) !== 0 ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
    }

    table[index] = value;
  }

  return table;
})();

function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[((crc >>> 8) ^ byte) & 0xff] ^ ((crc << 8) & 0xffff);
  }

  return crc & 0xffff;
}

function encodeFrame(channel, payloadKind, payload) {
  const body = Buffer.from(payload);
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new Error(`Payload length ${body.length} exceeds the ${MAX_MESSAGE_BYTES}-byte limit.`);
  }

  const header = Buffer.alloc(6);
  header.writeUInt32BE((((channel << 31) | (payloadKind << 29) | body.length) >>> 0), 0);
  header.writeUInt16BE(crc16(header.subarray(0, 4)), 4);
  return Buffer.concat([header, body]);
}

function encodeJsonFrame(message) {
  return encodeFrame(CHANNEL_CONTROL, KIND_JSON, Buffer.from(JSON.stringify(message), "utf8"));
}

function sendJson(socket, message) {
  socket.write(encodeJsonFrame(message));
}

/**
 * 增量帧解码：只在控制通道上回调 JSON 消息；帧层错误直接销毁连接（测试中即失败）。
 */
function attachJsonReader(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (; ;) {
      if (buffer.length < FRAME_HEADER_BYTES) {
        return;
      }

      const expected = (buffer[4] << 8) | buffer[5];
      if (crc16(buffer.subarray(0, 4)) !== expected) {
        socket.destroy(new Error("frame.invalidCrc"));
        return;
      }

      const word = buffer.readUInt32BE(0);
      const channel = word >>> 31;
      const payloadKind = (word >>> 29) & 0x3;
      const payloadLength = word & 0x1fffffff;
      if (payloadLength > MAX_MESSAGE_BYTES || (channel !== 0 && channel !== 1) || (payloadKind !== 0 && payloadKind !== 1)) {
        socket.destroy(new Error("frame.invalidHeader"));
        return;
      }

      const end = FRAME_HEADER_BYTES + payloadLength;
      if (buffer.length < end) {
        return;
      }

      const payload = buffer.subarray(FRAME_HEADER_BYTES, end);
      buffer = buffer.subarray(end);
      if (channel === CHANNEL_CONTROL) {
        // 非法 JSON 载荷不是帧层错误：测试对端会按业务错误帧响应，这里忽略该载荷。
        try {
          onMessage(JSON.parse(payload.toString("utf8")));
        } catch {
          // 由调用方的超时/显式断言暴露。
        }
      }
    }
  });
}

/**
 * 增量帧解码：只在控制通道上回调 JSON 文本行（供仍按字符串缓存的测试客户端复用）。
 */
function attachJsonLines(socket, onLine) {
  attachJsonReader(socket, (message) => onLine(JSON.stringify(message)));
}

module.exports = {
  FRAME_HEADER_BYTES,
  CHANNEL_DEBUG,
  KIND_BINARY,
  KIND_JSON,
  crc16,
  encodeFrame,
  encodeJsonFrame,
  sendJson,
  attachJsonReader,
  attachJsonLines,
};
