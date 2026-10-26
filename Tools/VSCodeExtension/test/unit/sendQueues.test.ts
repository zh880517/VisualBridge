import assert from "node:assert/strict";
import test from "node:test";
import { BridgeChannel, BridgePayloadKind, MAX_MESSAGE_BYTES } from "../../src/bridge/framing";
import {
  BridgeSendQueues,
  DEFAULT_BRIDGE_SEND_LIMITS,
  type BridgeQueuedMessage,
} from "../../src/bridge/sendQueues";

function payload(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

function drain(queues: BridgeSendQueues): BridgeQueuedMessage[] {
  const messages: BridgeQueuedMessage[] = [];
  for (; ;) {
    const message = queues.dequeue();
    if (message === undefined) {
      break;
    }

    messages.push(message);
  }

  return messages;
}

test("send queues assign one monotonic sequence across both channels", () => {
  const queues = new BridgeSendQueues();
  const first = queues.enqueueDebug(payload("d1"), BridgePayloadKind.Json);
  const second = queues.enqueueControl(payload("c1"));
  const third = queues.enqueueDebug(payload("d2"), BridgePayloadKind.Binary);
  assert.ok(first.ok && second.ok && third.ok);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(third.sequence, 3);

  const messages = drain(queues);
  assert.deepEqual(messages.map((message) => message.sequence), [1, 2, 3]);
  assert.equal(messages[0]?.channel, BridgeChannel.Debug);
  assert.equal(messages[1]?.channel, BridgeChannel.Control);
  assert.equal(queues.counterSnapshot.rejectedTooLarge, 0);
});

test("control message barrier keeps already-enqueued data frames ahead of Finish", () => {
  const queues = new BridgeSendQueues();
  const data1 = queues.enqueueDebug(payload("frame-1"), BridgePayloadKind.Binary);
  const data2 = queues.enqueueDebug(payload("frame-2"), BridgePayloadKind.Binary);
  const finish = queues.enqueueControl(payload("{\"type\":\"Finish\"}"));
  const data3 = queues.enqueueDebug(payload("frame-3"), BridgePayloadKind.Binary);
  assert.ok(data1.ok && data2.ok && finish.ok && data3.ok);

  // 控制消息记录的数据队列尾序号 = Finish 入队前最尾的数据序号。
  const pendingFinish = drain(queues);
  assert.deepEqual(
    pendingFinish.map((message) => message.sequence),
    [data1.sequence, data2.sequence, finish.sequence, data3.sequence],
  );
  assert.equal(pendingFinish[2]?.channel, BridgeChannel.Control);
  assert.equal(pendingFinish[2]?.barrier, data2.sequence);
});

test("control messages written before later data frames still respect the barrier", () => {
  const queues = new BridgeSendQueues();
  const finish = queues.enqueueControl(payload("{\"type\":\"Finish\"}")); // barrier 0
  const data1 = queues.enqueueDebug(payload("frame-1"), BridgePayloadKind.Binary);
  const finish2 = queues.enqueueControl(payload("{\"type\":\"debugFinish\"}")); // barrier = data1
  assert.ok(finish.ok && data1.ok && finish2.ok);

  const messages = drain(queues);
  assert.deepEqual(
    messages.map((message) => message.sequence),
    [finish.sequence, data1.sequence, finish2.sequence],
  );
  assert.equal(messages[2]?.barrier, data1.sequence);
});

test("data queue drops the oldest data message when the message cap is reached", () => {
  const queues = new BridgeSendQueues({
    ...DEFAULT_BRIDGE_SEND_LIMITS,
    dataCapacityMessages: 4,
  });
  for (let index = 0; index < 6; index++) {
    assert.ok(queues.enqueueDebug(payload(`d${index}`), BridgePayloadKind.Json).ok);
  }

  assert.equal(queues.dataPendingCount, 4);
  const counters = queues.counterSnapshot;
  assert.equal(counters.debugDroppedMessages, 2);
  assert.equal(counters.debugEnqueued, 6);
  assert.deepEqual(
    drain(queues).map((message) => message.payload.toString("utf8")),
    ["d2", "d3", "d4", "d5"],
  );
});

test("data queue drops the oldest data message when the byte cap is reached", () => {
  const queues = new BridgeSendQueues({
    ...DEFAULT_BRIDGE_SEND_LIMITS,
    dataCapacityBytes: 10,
  });
  assert.ok(queues.enqueueDebug(Buffer.alloc(4), BridgePayloadKind.Binary).ok);
  assert.ok(queues.enqueueDebug(Buffer.alloc(4), BridgePayloadKind.Binary).ok);
  assert.ok(queues.enqueueDebug(Buffer.alloc(4), BridgePayloadKind.Binary).ok);

  // 4 + 4 + 4 > 10：淘汰最旧一条后为 8 字节。
  assert.equal(queues.dataPendingBytes, 8);
  assert.equal(queues.counterSnapshot.debugDroppedMessages, 1);
  assert.equal(queues.counterSnapshot.debugDroppedBytes, 4);
});

test("control queue never evicts and reports full at 256 pending messages", () => {
  const queues = new BridgeSendQueues();
  for (let index = 0; index < DEFAULT_BRIDGE_SEND_LIMITS.controlCapacity; index++) {
    assert.ok(queues.enqueueControl(payload(`c${index}`)).ok, `control ${index}`);
  }

  assert.equal(queues.controlPendingCount, 256);
  const overflow = queues.enqueueControl(payload("c-overflow"));
  assert.equal(overflow.ok, false);
  assert.equal(!overflow.ok ? overflow.reason : "", "controlQueueFull");
  assert.equal(queues.controlPendingCount, 256, "满队列不得淘汰控制消息");

  const messages = drain(queues);
  assert.equal(messages.length, 256);
  assert.equal(messages[0]?.payload.toString("utf8"), "c0");
  assert.equal(messages[255]?.payload.toString("utf8"), "c255");
  assert.equal(queues.counterSnapshot.writtenControl, 256);
});

test("a message above 1 MB is rejected before enqueue and counted", () => {
  const queues = new BridgeSendQueues();
  const oversized = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
  const control = queues.enqueueControl(oversized);
  const debug = queues.enqueueDebug(oversized, BridgePayloadKind.Binary);
  assert.equal(control.ok, false);
  assert.equal(debug.ok, false);
  assert.equal(!control.ok ? control.reason : "", "messageTooLarge");
  assert.equal(queues.controlPendingCount + queues.dataPendingCount, 0);
  assert.equal(queues.counterSnapshot.rejectedTooLarge, 2);
});

test("close discards queued messages and rejects further enqueues", () => {
  const queues = new BridgeSendQueues();
  assert.ok(queues.enqueueControl(payload("pending")).ok);
  queues.close();
  assert.equal(queues.dequeue(), undefined);
  const result = queues.enqueueControl(payload("after-close"));
  assert.equal(result.ok, false);
  assert.equal(!result.ok ? result.reason : "", "closed");
});
