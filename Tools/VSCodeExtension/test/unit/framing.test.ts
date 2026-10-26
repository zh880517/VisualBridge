import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeChannel,
  BridgeFrameDecoder,
  BridgeFrameError,
  BridgePayloadKind,
  FRAME_HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  crc16CcittFalse,
  decodeFrameHeader,
  encodeFrame,
  encodeFrameHeader,
} from "../../src/bridge/framing";

/**
 * 跨语言固定 fixture：C# 侧 `VisualBridgeFramingTests` 断言同一组十六进制字节。
 * 帧 1 控制/JSON、帧 2 调试/二进制、帧 3 调试/JSON、帧 4 控制/空载荷。
 */
const FIXTURE = [
  {
    channel: BridgeChannel.Control,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from("{\"type\":\"hello\",\"protocolVersion\":4}", "utf8"),
    hex: "20000024D7687B2274797065223A2268656C6C6F222C2270726F746F636F6C56657273696F6E223A347D",
  },
  {
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
    hex: "80000008D8F00001020304050607",
  },
  {
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from("{\"type\":\"debug\"}", "utf8"),
    hex: "A00000107C877B2274797065223A226465627567227D",
  },
  {
    channel: BridgeChannel.Control,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.alloc(0),
    hex: "20000000B38E",
  },
] as const;

test("CRC-16/CCITT-FALSE matches the published check vector", () => {
  assert.equal(crc16CcittFalse(Buffer.from("123456789", "utf8")), 0x29b1);
});

test("fixed fixture encodes to the shared cross-language bytes", () => {
  for (const frame of FIXTURE) {
    assert.equal(
      encodeFrame(frame.channel, frame.payloadKind, frame.payload).toString("hex").toUpperCase(),
      frame.hex,
    );
    assert.equal(
      encodeFrameHeader(frame.channel, frame.payloadKind, frame.payload.length).toString("hex").toUpperCase(),
      frame.hex.slice(0, FRAME_HEADER_BYTES * 2),
    );
  }
});

test("frame decoder reassembles the fixture across every two-chunk split", () => {
  const stream = Buffer.concat(FIXTURE.map((frame) => Buffer.from(frame.hex, "hex")));
  for (let split = 1; split < stream.length; split++) {
    const decoder = new BridgeFrameDecoder();
    const frames = [
      ...decoder.push(stream.subarray(0, split)),
      ...decoder.push(stream.subarray(split)),
    ];
    assert.equal(frames.length, FIXTURE.length, `split ${split}`);
    for (const [index, frame] of frames.entries()) {
      const expected = FIXTURE[index]!;
      assert.equal(frame.channel, expected.channel, `split ${split} frame ${index} channel`);
      assert.equal(frame.payloadKind, expected.payloadKind, `split ${split} frame ${index} kind`);
      assert.deepEqual(frame.payload, expected.payload, `split ${split} frame ${index} payload`);
    }

    decoder.finish();
  }
});

test("frame decoder emits a frame only after the full declared payload arrives", () => {
  const decoder = new BridgeFrameDecoder();
  const frame = encodeFrame(BridgeChannel.Debug, BridgePayloadKind.Binary, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(decoder.push(frame.subarray(0, FRAME_HEADER_BYTES)), []);
  assert.equal(decoder.pendingBytes, FRAME_HEADER_BYTES);
  assert.deepEqual(decoder.push(frame.subarray(FRAME_HEADER_BYTES, frame.length - 1)), []);
  const frames = decoder.push(frame.subarray(frame.length - 1));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]?.payload, Buffer.from([1, 2, 3, 4]));
});

test("frame decoder rejects a corrupted header CRC and never resynchronizes", () => {
  const stream = Buffer.concat(FIXTURE.map((frame) => Buffer.from(frame.hex, "hex")));
  const corrupted = Buffer.from(stream);
  corrupted[4] = (corrupted[4]! ^ 0xff) & 0xff;
  const decoder = new BridgeFrameDecoder();
  assert.throws(
    () => decoder.push(corrupted),
    (error: unknown) => error instanceof BridgeFrameError && error.code === "frame.invalidCrc",
  );
  // 失败状态被锁定：后续字节不会被当成新帧重新同步。
  assert.throws(
    () => decoder.push(stream),
    (error: unknown) => error instanceof BridgeFrameError && error.code === "frame.invalidCrc",
  );
});

test("frame decoder rejects a payload length above 1 MB", () => {
  // 手工构造合法 CRC 的帧头，但 payloadLength 超出上限。
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE((((1 << 31) | (BridgePayloadKind.Json << 29) | (MAX_MESSAGE_BYTES + 1)) >>> 0), 0);
  header.writeUInt16BE(crc16CcittFalse(header.subarray(0, 4)), 4);
  assert.throws(
    () => decodeFrameHeader(header),
    (error: unknown) => error instanceof BridgeFrameError && error.code === "frame.payloadTooLarge",
  );
  assert.throws(
    () => encodeFrameHeader(BridgeChannel.Control, BridgePayloadKind.Json, MAX_MESSAGE_BYTES + 1),
    (error: unknown) => error instanceof BridgeFrameError && error.code === "frame.payloadTooLarge",
  );
});

test("frame decoder rejects an unregistered payload kind", () => {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE((((2 << 29) | 4) >>> 0), 0);
  header.writeUInt16BE(crc16CcittFalse(header.subarray(0, 4)), 4);
  assert.throws(
    () => decodeFrameHeader(header),
    (error: unknown) => error instanceof BridgeFrameError && error.code === "frame.invalidPayloadKind",
  );
});

test("frame decoder reports an incomplete trailing frame on connection end", () => {
  const frame = encodeFrame(BridgeChannel.Control, BridgePayloadKind.Json, Buffer.from("{\"a\":1}", "utf8"));
  const decoder = new BridgeFrameDecoder();
  decoder.push(frame.subarray(0, frame.length - 2));
  assert.throws(
    () => decoder.finish(),
    (error: unknown) => error instanceof BridgeFrameError && error.code === "frame.truncated",
  );

  const clean = new BridgeFrameDecoder();
  clean.push(frame);
  clean.finish();
  assert.equal(clean.pendingBytes, 0);
});
