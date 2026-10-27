/**
 * 编辑器通道并入统一协议后的三个硬约束（E3）：
 *
 * 1. 一对一连接门必须与异步 `close` 事件解耦：对端 FIN 已可见但事件尚未派发时，
 *    重连不得被误判为 `runtime.alreadyConnected`（真实竞态，非 flake）。
 * 2. 通道 0 的编辑器请求/应答不得被通道 1 的调试数据帧饿死：控制消息永不淘汰，
 *    且写出顺序由屏障 + 单调序号决定（附录 A.9）。
 * 3. `response` 的 requestId 空间按通道隔离：通道 1 的同名 response 绝不会被当成
 *    通道 0 的编辑器应答（附录 A.2/A.5）。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";
import { BridgeSocket } from "../../src/bridge/bridgeSocket";
import {
  EditorBridgeConnectionGate,
  type EditorBridgeTransport,
} from "../../src/bridge/editorBridgeConnections";
import {
  BridgeChannel,
  BridgeFrameDecoder,
  BridgePayloadKind,
  MAX_MESSAGE_BYTES,
  encodeFrame,
} from "../../src/bridge/framing";
import { BridgeSendQueues } from "../../src/bridge/sendQueues";

/** 只实现 BridgeSocket 用到的 net.Socket 表面。 */
class FakeSocket extends EventEmitter {
  public readonly writes: Buffer[] = [];
  public ended = false;
  public destroyed = false;
  public readableEnded = false;

  public setNoDelay(): void {
    // 测试替身没有 TCP 参数。
  }

  public write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
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

function createBridge(): { socket: FakeSocket; bridge: BridgeSocket; control: Buffer[]; debug: Buffer[] } {
  const socket = new FakeSocket();
  const control: Buffer[] = [];
  const debug: Buffer[] = [];
  const bridge = new BridgeSocket(socket as unknown as net.Socket, {
    onControlPayload: (payload) => control.push(Buffer.from(payload)),
    onDebugFrame: (_kind, payload) => debug.push(Buffer.from(payload)),
    onClosed: () => undefined,
  });
  return { socket, bridge, control, debug };
}

class FakeTransport implements EditorBridgeTransport {
  public isTerminated = false;
}

test("the connection gate releases the slot from the transport state, not the close event", () => {
  const gate = new EditorBridgeConnectionGate<FakeTransport>();

  const first = gate.accept(new FakeTransport());
  // 未完成握手的探测连接不占用一对一槽位。
  assert.equal(gate.hasActiveConnection(first), false);
  gate.markHandshaken(first);

  const concurrent = gate.accept(new FakeTransport());
  assert.equal(gate.hasActiveConnection(concurrent), true, "A live handshaken connection must occupy the endpoint.");

  // 对端 FIN 已收到、`close` 事件尚未派发：只把 transport 标为已终止，不触发任何回调。
  first.transport.isTerminated = true;
  assert.equal(
    gate.hasActiveConnection(concurrent),
    false,
    "A connection whose transport is already terminated must not block a reconnect.",
  );
  assert.equal(gate.size, 1, "accept/hasActiveConnection must prune terminated connections synchronously.");

  // 真正的并发第二个客户端仍然被拒。
  const third = gate.accept(new FakeTransport());
  gate.markHandshaken(concurrent);
  assert.equal(gate.hasActiveConnection(third), true);

  // retire 幂等，dispose 路径重复释放不会破坏状态。
  assert.equal(gate.retire(concurrent), true);
  assert.equal(gate.retire(concurrent), false);
  assert.equal(gate.hasActiveConnection(third), false);
  assert.equal(gate.retire(third), true);
  assert.equal(gate.size, 0);
});

test("bridge socket reports a peer-closed transport synchronously while still writable", () => {
  const { socket, bridge } = createBridge();

  assert.equal(bridge.isOpen, true);
  assert.equal(bridge.isTerminated, false);

  // 对端 FIN：读回调先设置 destroyed/readableEnded，`close` 事件在之后的阶段才派发。
  socket.readableEnded = true;
  assert.equal(bridge.isOpen, true, "isOpen only tracks the local intent to send.");
  assert.equal(bridge.isTerminated, true, "A peer FIN must be observable before the close event.");

  // 本地关闭路径同样是同步可见的。
  const local = createBridge();
  local.bridge.close();
  assert.equal(local.bridge.isTerminated, true);
  assert.equal(local.bridge.isOpen, false);
});

test("an editor response is never starved by debug data enqueued after it", () => {
  const queues = new BridgeSendQueues();
  const data = Buffer.from([1, 2, 3, 4]);
  const response = Buffer.from("{\"type\":\"response\",\"requestId\":\"req-editor\",\"status\":\"ok\"}", "utf8");

  for (let index = 0; index < 1000; index++) {
    assert.equal(queues.enqueueDebug(data, BridgePayloadKind.Binary).ok, true);
  }

  assert.equal(queues.enqueueControl(response, BridgePayloadKind.Json, BridgeChannel.Control).ok, true);

  for (let index = 0; index < 1000; index++) {
    assert.equal(queues.enqueueDebug(data, BridgePayloadKind.Binary).ok, true);
  }

  const order: string[] = [];
  for (let message = queues.dequeue(); message !== undefined; message = queues.dequeue()) {
    order.push(message.channel === BridgeChannel.Control ? "control" : "data");
  }

  assert.equal(order.length, 2001);
  // 屏障只让控制消息等待"入队前"的数据；其后入队的 1000 条数据不构成延迟。
  assert.equal(order.indexOf("control"), 1000);
  assert.equal(queues.counterSnapshot.writtenControl, 1);
  assert.equal(queues.counterSnapshot.writtenDebug, 2000);
});

test("one write sequence keeps editor responses in enqueue order across both queues", () => {
  const { socket, bridge } = createBridge();

  for (let index = 0; index < 5; index++) {
    assert.equal(bridge.sendDebug(Buffer.from([index]), BridgePayloadKind.Binary), true);
  }

  assert.equal(
    bridge.sendControlJson({ type: "response", requestId: "req-editor-1", status: "ok" }),
    true,
  );

  for (let index = 0; index < 5; index++) {
    assert.equal(bridge.sendDebug(Buffer.from([100 + index]), BridgePayloadKind.Binary), true);
  }

  const frames = new BridgeFrameDecoder().push(Buffer.concat(socket.writes));
  assert.equal(frames.length, 11);
  assert.deepEqual(
    frames.map((frame) => frame.channel),
    [
      BridgeChannel.Debug, BridgeChannel.Debug, BridgeChannel.Debug, BridgeChannel.Debug, BridgeChannel.Debug,
      BridgeChannel.Control,
      BridgeChannel.Debug, BridgeChannel.Debug, BridgeChannel.Debug, BridgeChannel.Debug, BridgeChannel.Debug,
    ],
  );
  const response = JSON.parse(frames[5]!.payload.toString("utf8")) as Record<string, unknown>;
  assert.equal(response.requestId, "req-editor-1");
  assert.equal(bridge.sendCounters.writtenControl, 1);
  assert.equal(bridge.sendCounters.writtenDebug, 10);
});

test("the control queue is never evicted to make room for debug data", () => {
  const queues = new BridgeSendQueues({ ...{ controlCapacity: 4, dataCapacityBytes: 32, dataCapacityMessages: 4, maxMessageBytes: MAX_MESSAGE_BYTES } });
  const response = Buffer.from("{}", "utf8");
  assert.equal(queues.enqueueControl(response, BridgePayloadKind.Json, BridgeChannel.Control).ok, true);

  for (let index = 0; index < 50; index++) {
    assert.equal(queues.enqueueDebug(Buffer.alloc(8), BridgePayloadKind.Binary).ok, true);
  }

  assert.equal(queues.controlPendingCount, 1, "Debug backpressure must never drop a control message.");
  assert.ok(queues.counterSnapshot.debugDroppedMessages > 0);
  const first = queues.dequeue();
  assert.equal(first?.channel, BridgeChannel.Control);
});

test("channel 1 responses never reach the editor control handler", () => {
  const { socket, bridge, control, debug } = createBridge();

  const debugResponse = "{\"type\":\"response\",\"requestId\":\"req-editor-1\",\"status\":\"ok\",\"detail\":\"debug query\"}";
  socket.emit("data", encodeFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(debugResponse, "utf8")));
  assert.equal(control.length, 0, "A channel 1 response must not be parsed as an editor message.");
  assert.deepEqual(debug.map((payload) => payload.toString("utf8")), [debugResponse]);

  const editorResponse = "{\"type\":\"response\",\"requestId\":\"req-editor-1\",\"status\":\"error\",\"error\":\"bridge.documentUnresolved\"}";
  socket.emit("data", encodeFrame(BridgeChannel.Control, BridgePayloadKind.Json, Buffer.from(editorResponse, "utf8")));
  assert.deepEqual(control.map((payload) => payload.toString("utf8")), [editorResponse]);
  assert.equal(debug.length, 1, "A channel 0 message must not leak into the debug handler.");
  assert.equal(bridge.isOpen, true);
});

test("editor channel messages are sent on channel 0 while debug control stays on channel 1", () => {
  const { socket, bridge } = createBridge();

  assert.equal(bridge.sendControlJson({ type: "welcome" }), true);
  assert.equal(bridge.sendDebugControl(Buffer.from("{\"type\":\"debugFrame\",\"frame\":1}", "utf8")), true);

  const frames = new BridgeFrameDecoder().push(Buffer.concat(socket.writes));
  assert.deepEqual(frames.map((frame) => frame.channel), [BridgeChannel.Control, BridgeChannel.Debug]);
  // 两者都走控制队列、永不淘汰，但帧头通道位不同（附录 A.2）。
  assert.equal(bridge.sendCounters.writtenControl, 2);
  assert.equal(bridge.sendCounters.writtenDebug, 0);
});
