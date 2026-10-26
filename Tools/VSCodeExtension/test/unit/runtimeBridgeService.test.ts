import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  RuntimeBridgeConnection,
  RuntimeBridgeInstance,
} from "../../src/bridge/runtimeBridgeService";
import {
  BridgeChannel,
  BridgeFrameDecoder,
  BridgePayloadKind,
  encodeFrame,
} from "../../src/bridge/framing";

const TOKEN = "a".repeat(48);
const INSTANCE_ID = "editor-1234";
const SNAPSHOT_DOCUMENT = {
  documentTypeId: "logicGraph",
  documentId: "sample.document",
  kind: "visualbridge.graph.compiled",
  data: { label: "中文内容", nested: { text: "跨包解析完成" } },
};

/** 与服务端一致的控制通道 JSON 帧。 */
function frame(message: unknown): Buffer {
  return encodeFrame(BridgeChannel.Control, BridgePayloadKind.Json, Buffer.from(JSON.stringify(message), "utf8"));
}

function welcomeFrame(): Buffer {
  return frame({
    type: "welcome",
    protocolVersion: 4,
    coreVersion: 1,
    instanceId: INSTANCE_ID,
    kind: "editor-play",
    generation: 1,
    capabilities: ["snapshot", "events", "lease", "sources", "graphExecution"],
    startedAt: "2026-01-01T00:00:00Z",
  });
}

function instanceFor(port: number): RuntimeBridgeInstance {
  return {
    recordPath: "test.json",
    instanceId: INSTANCE_ID,
    kind: "editor-play",
    tcpPort: port,
    token: TOKEN,
    pid: process.pid,
    generation: 1,
    startedAt: "2026-01-01T00:00:00Z",
  };
}

interface ReceivedMessage {
  readonly type: string;
  readonly requestId?: string;
}

/** 帧解码对端：按统一协议的帧头解析客户端消息。 */
function createFrameReader(onMessage: (message: ReceivedMessage) => void): (chunk: Buffer) => void {
  const decoder = new BridgeFrameDecoder();
  return (chunk: Buffer): void => {
    for (const received of decoder.push(chunk)) {
      if (received.channel !== BridgeChannel.Control) continue;
      onMessage(JSON.parse(received.payload.toString("utf8")) as ReceivedMessage);
    }
  };
}

async function withFakeServer(
  handler: (socket: net.Socket) => void,
  run: (context: { readonly connection: RuntimeBridgeConnection; readonly port: number }) => Promise<void>,
): Promise<void> {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    handler(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const connection = new RuntimeBridgeConnection(instanceFor(address.port), () => undefined, () => undefined);
  try {
    await run({ connection, port: address.port });
  } finally {
    connection.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("runtime bridge client decodes a multibyte JSON payload split across TCP chunks", async () => {
  let splitInsideMultibyte = false;
  await withFakeServer((socket) => {
    let replied = false;
    const readFrames = createFrameReader((message) => {
      if (message.type === "hello") {
        socket.write(welcomeFrame());
        return;
      }

      if (message.type !== "request" || replied) return;
      replied = true;
      const response = frame({
        type: "response",
        requestId: message.requestId,
        status: "ok",
        documents: [SNAPSHOT_DOCUMENT],
      });
      const chineseIndex = response.indexOf(Buffer.from("中", "utf8"));
      assert.ok(chineseIndex > 0);
      const splitIndex = chineseIndex + 1;
      splitInsideMultibyte = splitIndex > chineseIndex && splitIndex < chineseIndex + 3;
      socket.write(response.subarray(0, splitIndex));
      setTimeout(() => socket.write(response.subarray(splitIndex)), 20);
    });
    socket.on("data", readFrames);
  }, async ({ connection }) => {
    await connection.connect(2000);
    const documents = await connection.getSnapshot();
    assert.equal(documents.length, 1);
    assert.equal(documents[0]?.data.label, "中文内容");
    assert.deepEqual(documents[0]?.data.nested, { text: "跨包解析完成" });
    assert.equal(JSON.stringify(documents).includes("�"), false);
  });
  assert.equal(splitInsideMultibyte, true);
});

test("runtime bridge client rejects a pending request when the server drops the socket after welcome", async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);
  try {
    await withFakeServer((socket) => {
      const readFrames = createFrameReader((message) => {
        if (message.type === "hello") {
          socket.write(welcomeFrame());
          return;
        }

        if (message.type === "request") {
          socket.destroy();
        }
      });
      socket.on("data", readFrames);
    }, async ({ connection }) => {
      await connection.connect(2000);
      await assert.rejects(connection.getSnapshot(), /closed|failed|reset|ECONNRESET|timed out/i);
    });
    await delay(20);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("runtime bridge client handles an event before the response without resending the request", async () => {
  let requestCount = 0;
  await withFakeServer((socket) => {
    const readFrames = createFrameReader((message) => {
      if (message.type === "hello") {
        socket.write(welcomeFrame());
        return;
      }

      if (message.type !== "request") return;
      requestCount += 1;
      socket.write(frame({ type: "event", event: "artifactsChanged", documents: [] }));
      setTimeout(() => {
        socket.write(frame({
          type: "response",
          requestId: message.requestId,
          status: "ok",
          documents: [SNAPSHOT_DOCUMENT],
        }));
      }, 20);
    });
    socket.on("data", readFrames);
  }, async ({ connection }) => {
    await connection.connect(2000);
    const documents = await connection.getSnapshot();
    assert.equal(documents.length, 1);
    assert.equal(documents[0]?.data.label, "中文内容");
    assert.equal(requestCount, 1);
  });
});
