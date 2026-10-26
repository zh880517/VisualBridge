import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";
import { BridgeSocket } from "../../src/bridge/bridgeSocket";
import {
  BridgeChannel,
  BridgeFrameDecoder,
  BridgeFrameError,
  BridgePayloadKind,
  MAX_MESSAGE_BYTES,
  encodeFrame,
} from "../../src/bridge/framing";

interface ReceivedEvent {
  readonly channel: BridgeChannel;
  readonly payloadKind: BridgePayloadKind;
  readonly payload: Buffer;
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for the condition."));
        return;
      }

      setTimeout(tick, 5);
    };

    tick();
  });
}

test("bridge socket dispatches control and debug frames on one connection", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  const clientSocket = net.connect({ host: "127.0.0.1", port: address.port });
  const serverSocket = await accepted;
  const events: ReceivedEvent[] = [];
  const serverBridge = new BridgeSocket(serverSocket, {
    onControlPayload: (payload) => events.push({ channel: BridgeChannel.Control, payloadKind: BridgePayloadKind.Json, payload }),
    onDebugFrame: (payloadKind, payload) => events.push({ channel: BridgeChannel.Debug, payloadKind, payload }),
    onClosed: () => undefined,
  });
  const clientBridge = new BridgeSocket(clientSocket, {
    onControlPayload: () => undefined,
    onDebugFrame: () => undefined,
    onClosed: () => undefined,
  });

  try {
    await waitFor(() => clientSocket.readyState === "open");
    assert.equal(clientBridge.sendControlJson({ type: "hello", protocolVersion: 4 }), true);
    assert.equal(clientBridge.sendDebug(Buffer.from([0, 1, 2, 3]), BridgePayloadKind.Binary), true);
    assert.equal(clientBridge.sendDebug(Buffer.from("{\"type\":\"debug\"}", "utf8"), BridgePayloadKind.Json), true);
    await waitFor(() => events.length === 3);

    assert.deepEqual(
      events.map((event) => [event.channel, event.payloadKind, event.payload.toString("utf8")]),
      [
        [BridgeChannel.Control, BridgePayloadKind.Json, "{\"type\":\"hello\",\"protocolVersion\":4}"],
        [BridgeChannel.Debug, BridgePayloadKind.Binary, "\u0000\u0001\u0002\u0003"],
        [BridgeChannel.Debug, BridgePayloadKind.Json, "{\"type\":\"debug\"}"],
      ],
    );
  } finally {
    clientBridge.close();
    serverBridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("bridge socket closes immediately on a corrupted frame header", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  const rawClient = net.connect({ host: "127.0.0.1", port: address.port });
  const serverSocket = await accepted;
  let closeError: Error | undefined;
  let received = 0;
  const serverBridge = new BridgeSocket(serverSocket, {
    onControlPayload: () => {
      received += 1;
    },
    onDebugFrame: () => {
      received += 1;
    },
    onClosed: (error) => {
      closeError = error;
    },
  });

  try {
    const frame = encodeFrame(BridgeChannel.Control, BridgePayloadKind.Json, Buffer.from("{}", "utf8"));
    const corrupted = Buffer.from(frame);
    corrupted[4] = (corrupted[4]! ^ 0xff) & 0xff;
    rawClient.write(corrupted);
    rawClient.write(frame);
    await waitFor(() => closeError !== undefined);

    assert.ok(closeError instanceof BridgeFrameError);
    assert.equal((closeError as BridgeFrameError).code, "frame.invalidCrc");
    assert.equal(received, 0, "CRC 失败后不得投递任何帧，也不得重同步");
  } finally {
    rawClient.destroy();
    serverBridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** 只实现 BridgeSocket 用到的 net.Socket 表面；写失败用于制造队列积压。 */
class FakeSocket extends EventEmitter {
  public readonly writes: Buffer[] = [];
  public ended = false;
  public destroyed = false;
  public writeReturnsTrue = true;

  public constructor() {
    super();
  }

  public setNoDelay(): void {
    // 测试替身无 TCP 参数。
  }

  public write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    return this.writeReturnsTrue;
  }

  public end(): void {
    if (this.ended) return;
    this.ended = true;
    this.emit("close");
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

test("bridge socket closes when the control queue fills instead of dropping control messages", () => {
  const socket = new FakeSocket();
  socket.writeReturnsTrue = false; // 首次写即背压：队列开始积压。
  let closeError: Error | undefined;
  const bridge = new BridgeSocket(socket as unknown as net.Socket, {
    onControlPayload: () => undefined,
    onDebugFrame: () => undefined,
    onClosed: (error) => {
      closeError = error;
    },
  });

  for (let index = 0; index < 258; index++) {
    assert.equal(bridge.sendControlJson({ index }), index !== 257 ? true : false);
  }

  assert.ok(closeError instanceof Error);
  assert.match((closeError as Error).message, /control queue/i);
  assert.equal(bridge.isOpen, false);
  // 第一条已写出，随后 256 条填满队列；第 258 条被拒绝。
  assert.equal(bridge.sendCounters.controlEnqueued, 257);
});

test("bridge socket rejects an oversized control message without closing", () => {
  const socket = new FakeSocket();
  let closed = false;
  const bridge = new BridgeSocket(socket as unknown as net.Socket, {
    onControlPayload: () => undefined,
    onDebugFrame: () => undefined,
    onClosed: () => {
      closed = true;
    },
  });

  assert.equal(bridge.sendControl(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), false);
  assert.equal(closed, false);
  assert.equal(bridge.isOpen, true);
  assert.equal(bridge.sendCounters.rejectedTooLarge, 1);
  assert.equal(socket.writes.length, 0);
});

test("bridge socket graceful end flushes queued frames before the write side closes", () => {
  const socket = new FakeSocket();
  let closed = false;
  const bridge = new BridgeSocket(socket as unknown as net.Socket, {
    onControlPayload: () => undefined,
    onDebugFrame: () => undefined,
    onClosed: () => {
      closed = true;
    },
  });

  assert.equal(bridge.sendControlJson({ type: "error", code: "bridge.invalidToken" }), true);
  assert.equal(bridge.sendDebug(Buffer.from([9]), BridgePayloadKind.Binary), true);
  bridge.end();

  assert.equal(socket.ended, true);
  assert.equal(closed, true);
  const decoder = new BridgeFrameDecoder();
  const frames = decoder.push(Buffer.concat(socket.writes));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.channel, BridgeChannel.Control);
  assert.equal(JSON.parse(frames[0]!.payload.toString("utf8")).code, "bridge.invalidToken");
  assert.equal(frames[1]?.channel, BridgeChannel.Debug);
  assert.deepEqual(frames[1]?.payload, Buffer.from([9]));
});
