import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  RuntimeBridgeConnection,
  RuntimeBridgeInstance,
  RuntimeBridgeService,
} from "../../src/bridge/runtimeBridgeService";
import { RuntimeBridgeProtocolError } from "../../src/bridge/runtimeBridgeProtocol";
import {
  BridgeChannel,
  BridgeFrameDecoder,
  BridgePayloadKind,
  encodeFrame,
} from "../../src/bridge/framing";

const TOKEN = "a".repeat(48);
const INSTANCE_ID = "editor-1234";
const BOOT_ID = "b00t0000e5";
const SESSION_ID = `${INSTANCE_ID}#${BOOT_ID}`;
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

/** welcome（附录 A.3 统一形状；E5 起不再有 coreVersion/capabilities/instanceId/kind）。 */
function welcomeFrame(options: { readonly resumed?: boolean } = {}): Buffer {
  return frame({
    type: "welcome",
    protocolVersion: 4,
    endpointId: INSTANCE_ID,
    sessionId: SESSION_ID,
    resumed: options.resumed ?? false,
    connectType: "editor-player",
    generation: 1,
    bootId: BOOT_ID,
    contractHash: "",
    payloads: ["json"],
    debugEnabled: false,
    startedAt: "2026-01-01T00:00:00Z",
  });
}

function instanceFor(port: number, overrides: Partial<RuntimeBridgeInstance> = {}): RuntimeBridgeInstance {
  return {
    recordPath: "test.json",
    instanceId: INSTANCE_ID,
    kind: "editor-play",
    tcpPort: port,
    token: TOKEN,
    pid: process.pid,
    generation: 1,
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

type ReceivedMessage = {
  readonly type: string;
  readonly requestId?: string;
} & Record<string, unknown>;

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
  overrides: Partial<RuntimeBridgeInstance> = {},
  output: (line: string) => void = () => undefined,
): Promise<void> {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    handler(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const connection = new RuntimeBridgeConnection(instanceFor(address.port, overrides), output, () => undefined);
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

test("runtime bridge client sends the unified A.3 hello and exposes the welcome session identity", async () => {
  let hello: Record<string, unknown> | undefined;
  await withFakeServer((socket) => {
    const readFrames = createFrameReader((message) => {
      if (message.type === "hello") {
        hello = message;
        socket.write(welcomeFrame());
      }
    });
    socket.on("data", readFrames);
  }, async ({ connection }) => {
    const welcome = await connection.connect(2000);
    assert.equal(welcome.endpointId, INSTANCE_ID);
    assert.equal(welcome.sessionId, SESSION_ID);
    assert.equal(welcome.resumed, false);
    assert.equal(welcome.connectType, "editor-player");
    assert.deepEqual(welcome.payloads, ["json"]);
    assert.equal(connection.state.sessionId, SESSION_ID);
    assert.equal(connection.state.resumed, false);
    assert.equal(connection.state.instanceId, INSTANCE_ID);
    assert.equal(connection.state.kind, "editor-player");
  });

  assert.ok(hello !== undefined, "The client did not send hello.");
  // 统一握手：同一份 A.3 字段，旧字段（coreVersion/capabilities/clientInstanceId）必须消失。
  assert.equal(hello.type, "hello");
  assert.equal(hello.protocolVersion, 4);
  assert.equal(hello.role, "vscode");
  assert.equal(typeof hello.clientEndpointId, "string");
  assert.match(String(hello.clientEndpointId), /^vscode-/);
  assert.equal(hello.token, TOKEN);
  assert.equal(hello.contractHash, "");
  assert.deepEqual(hello.payloads, ["json"]);
  assert.equal("coreVersion" in hello, false, "hello must not carry the legacy coreVersion.");
  assert.equal("capabilities" in hello, false, "hello must not carry the legacy capabilities list.");
  assert.equal("clientInstanceId" in hello, false, "hello must not carry the legacy clientInstanceId.");
  assert.equal("resumeSessionId" in hello, false);
});

test("runtime bridge client asks to resume an existing session and reports resumed", async () => {
  let hello: Record<string, unknown> | undefined;
  await withFakeServer((socket) => {
    const readFrames = createFrameReader((message) => {
      if (message.type === "hello") {
        hello = message;
        socket.write(welcomeFrame({ resumed: true }));
      }
    });
    socket.on("data", readFrames);
  }, async ({ connection }) => {
    const welcome = await connection.connect(2000);
    assert.equal(welcome.resumed, true);
    assert.equal(connection.state.resumed, true);
  }, { resumeSessionId: SESSION_ID, contractHash: "0123456789abcdef" });

  assert.equal(hello?.resumeSessionId, SESSION_ID, "The client must ask to resume the requested session.");
  assert.equal(hello?.contractHash, "0123456789abcdef");
});

test("runtime bridge client warns when a player instance listens without a token", async () => {
  // 0.0.0.0 无认证监听必须在用户可见的输出通道里留警告（F3）：端口 + "局域网内无认证"。
  const lines: string[] = [];
  await withFakeServer((socket) => {
    const readFrames = createFrameReader((message) => {
      if (message.type === "hello") {
        socket.write(welcomeFrame());
        return;
      }
    });
    socket.on("data", readFrames);
  }, async ({ connection }) => {
    await connection.connect(2000);
  }, { kind: "player", token: "" }, (line) => lines.push(line));

  assert.ok(
    lines.some((line) => line.includes("0.0.0.0:") && line.includes("局域网内无认证")),
    `Expected an unauthenticated-player warning, got:\n${lines.join("\n")}`,
  );
});

test("runtime bridge client stays silent for an authenticated editor-play instance", async () => {
  const lines: string[] = [];
  await withFakeServer((socket) => {
    const readFrames = createFrameReader((message) => {
      if (message.type === "hello") {
        socket.write(welcomeFrame());
      }
    });
    socket.on("data", readFrames);
  }, async ({ connection }) => {
    await connection.connect(2000);
  }, {}, (line) => lines.push(line));

  assert.ok(!lines.some((line) => line.includes("局域网内无认证")), lines.join("\n"));
});

test("runtime bridge client omits the token for an unauthenticated player instance", async () => {
  let hello: Record<string, unknown> | undefined;
  await withFakeServer((socket) => {
    const readFrames = createFrameReader((message) => {
      if (message.type === "hello") {
        hello = message;
        socket.write(frame({
          type: "welcome",
          protocolVersion: 4,
          endpointId: "player-1234",
          sessionId: "player-1234#b00t0000e5",
          resumed: false,
          connectType: "player",
          generation: 1,
          bootId: "b00t0000e5",
          contractHash: "",
          payloads: ["json"],
          debugEnabled: false,
          startedAt: "2026-01-01T00:00:00Z",
        }));
      }
    });
    socket.on("data", readFrames);
  }, async ({ connection }) => {
    const welcome = await connection.connect(2000);
    assert.equal(welcome.connectType, "player");
    assert.equal(connection.state.instanceId, "player-1234");
  }, { token: "", instanceId: "player-1234", kind: "player" });

  assert.equal(hello !== undefined && "token" in hello, false, "An unauthenticated player hello must not carry a token.");
});

/** 模拟 Unity 侧的端口段监听方：只有 token 匹配才回 welcome，否则直接断开。 */
function startPlayerStyleListener(expectedToken: string): Promise<{ readonly port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const readFrames = createFrameReader((message) => {
      if (message.type !== "hello") return;
      if (message.token !== undefined && message.token !== expectedToken) {
        socket.destroy();
        return;
      }

      socket.write(welcomeFrame());
    });
    socket.on("data", readFrames);
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("runtime bridge service probes a port range and adopts the handshaken endpoint", async () => {
  const listener = await startPlayerStyleListener(TOKEN);
  const service = new RuntimeBridgeService(() => undefined);
  try {
    const welcome = await service.probeAndConnect({
      host: "127.0.0.1",
      portRangeStart: listener.port,
      portRangeEnd: listener.port,
      token: TOKEN,
    });
    assert.equal(welcome.sessionId, SESSION_ID);
    assert.equal(service.state.connected, true);
    assert.equal(service.state.tcpPort, listener.port);
  } finally {
    service.disconnect();
    await listener.close();
  }
});

test("runtime bridge service reports runtime.noEndpoint when the handshake is refused", async () => {
  const listener = await startPlayerStyleListener(TOKEN);
  const service = new RuntimeBridgeService(() => undefined);
  try {
    // 端口在听但 token 不匹配：TCP 可连、握手失败，因此算"无可握手端点"。
    await assert.rejects(
      service.probeAndConnect({
        host: "127.0.0.1",
        portRangeStart: listener.port,
        portRangeEnd: listener.port,
        token: "b".repeat(48),
        timeoutMs: 2000,
      }),
      (errorValue: unknown): boolean => {
        assert.ok(errorValue instanceof RuntimeBridgeProtocolError);
        assert.equal(errorValue.code, "runtime.noEndpoint");
        assert.match(errorValue.message, /attempts=1/u);
        return true;
      },
    );
    assert.equal(service.state.connected, false);
  } finally {
    service.disconnect();
    await listener.close();
  }
});

test("runtime bridge service probes only the explicit port when one is configured", async () => {
  // 先占一个端口再释放，得到一个"确定没人监听"的端口号。
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address !== null && typeof address !== "string");
  const closedPort = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const service = new RuntimeBridgeService(() => undefined);
  try {
    await assert.rejects(
      service.probeAndConnect({
        host: "127.0.0.1",
        port: closedPort,
        // 显式端口必须压过端口段：否则这段区间会带来大量无谓尝试。
        portRangeStart: 28300,
        portRangeEnd: 28349,
        token: TOKEN,
        timeoutMs: 300,
      }),
      (errorValue: unknown): boolean => {
        assert.ok(errorValue instanceof RuntimeBridgeProtocolError);
        assert.equal(errorValue.code, "runtime.noEndpoint");
        assert.match(errorValue.message, new RegExp(`(${String(closedPort)}; attempts=1)`, "u"));
        return true;
      },
    );
  } finally {
    service.disconnect();
  }
});
test("runtime bridge service probes with TCP liveness only and reuses an existing endpoint", async () => {
  // 每条被接受的连接记"收到多少字节"：探活连接必须 0 字节（不发 hello ⇒ Unity 侧不会
  // DebugLinkOpened ⇒ 不 Bind/不 Attach，E11 §1 的判据）。
  const accepted: Array<{ bytes: number }> = [];
  const server = net.createServer((socket) => {
    const entry = { bytes: 0 };
    accepted.push(entry);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      entry.bytes += chunk.length;
      socket.write(welcomeFrame());
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const service = new RuntimeBridgeService(() => undefined);
  try {
    const welcome = await service.probeAndConnect({
      host: "127.0.0.1",
      portRangeStart: address.port,
      portRangeEnd: address.port,
      token: TOKEN,
      timeoutMs: 2000,
    });
    assert.equal(welcome.sessionId, SESSION_ID);
    assert.equal(accepted.length, 2, "探活一条（不发字节）+ 唯一一条真连接");
    const [liveness, handshake] = accepted;
    assert.ok(liveness !== undefined && handshake !== undefined);
    assert.equal(liveness.bytes, 0,
      "探活连接一个字节都不写：没有 hello/welcome 就没有 debug link，探测不会被当成会话参与者");
    assert.ok(handshake.bytes > 0, "只有被采纳的那条连接才发 hello");

    // 已连着同一端点 + 相同 token：探测直接复用，连探活连接都不再建（探测不改变会话）。
    const reused = await service.probeAndConnect({
      host: "127.0.0.1",
      portRangeStart: address.port,
      portRangeEnd: address.port,
      token: TOKEN,
      timeoutMs: 2000,
    });
    assert.equal(reused.sessionId, SESSION_ID);
    assert.equal(accepted.length, 2, "复用路径不得再建任何连接");
  } finally {
    service.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runtime bridge service keeps a healthy connection when the probe finds no endpoint", async () => {
  const listener = await startPlayerStyleListener(TOKEN);
  const service = new RuntimeBridgeService(() => undefined);
  try {
    // 先连上真实端点。
    const instance = instanceFor(listener.port);
    await service.connect(instance, 2000);
    assert.equal(service.state.connected, true);

    // 探测一个没人监听的端口段：必须报 noEndpoint，但**不得**顺手断开已有连接
    // （旧实现先 disconnect 再探测：一次失败的探测会掐掉面板的健康连接）。
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedAddress = closed.address();
    assert.ok(closedAddress !== null && typeof closedAddress !== "string");
    const closedPort = closedAddress.port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await assert.rejects(
      service.probeAndConnect({
        host: "127.0.0.1",
        portRangeStart: closedPort,
        portRangeEnd: closedPort,
        token: TOKEN,
        timeoutMs: 300,
      }),
      (errorValue: unknown): boolean => {
        assert.ok(errorValue instanceof RuntimeBridgeProtocolError);
        assert.equal(errorValue.code, "runtime.noEndpoint");
        return true;
      },
    );
    assert.equal(service.state.connected, true, "失败的探测不能断开现有连接（探测不得影响会话）");

    // 已连接端点 + 不同 token：该端点必然拒绝这次 hello，探测连"候选"都不该有 ⇒ 报 noEndpoint，
    // 且**不得**先断开现有连接（旧实现先 disconnect 再探测，一次错误 token 的探测会掐掉面板连接）。
    await assert.rejects(
      service.probeAndConnect({
        host: "127.0.0.1",
        portRangeStart: listener.port,
        portRangeEnd: listener.port,
        token: "b".repeat(48),
        timeoutMs: 300,
      }),
      (errorValue: unknown): boolean => {
        assert.ok(errorValue instanceof RuntimeBridgeProtocolError);
        assert.equal(errorValue.code, "runtime.noEndpoint");
        return true;
      },
    );
    assert.equal(service.state.connected, true, "token 不匹配的探测同样不得断开现有连接");
  } finally {
    service.disconnect();
    await listener.close();
  }
});

test("runtime bridge service drops the previous connection when a live port refuses the handshake (documented trade-off)", async () => {
  // 评审 P2-3：上面两条只覆盖"无端点"与"token 不匹配"。"探活成功、但所有候选的 hello 都失败"
  // 时旧连接**仍会被断开**——这是刻意取舍（换链必须先断开，否则新 link 会在旧连接仍绑定时 Bind，
  // 传输层压栈、会话层看不到换代）。本用例把这条代价锁成已知行为，避免注释再写成"任何失败探测
  // 都不断开"。
  const listener = await startPlayerStyleListener(TOKEN);
  const mute = net.createServer((socket) => {
    // 收下 hello 但永不回应 ⇒ 握手超时（TCP 可连，但不是可握手的端点）。
    socket.on("data", () => undefined);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => mute.listen(0, "127.0.0.1", resolve));
  const muteAddress = mute.address();
  assert.ok(muteAddress !== null && typeof muteAddress !== "string");
  const service = new RuntimeBridgeService(() => undefined);
  try {
    await service.connect(instanceFor(listener.port), 2000);
    assert.equal(service.state.connected, true);

    await assert.rejects(
      service.probeAndConnect({
        host: "127.0.0.1",
        portRangeStart: muteAddress.port,
        portRangeEnd: muteAddress.port,
        token: TOKEN,
        timeoutMs: 300,
      }),
      (errorValue: unknown): boolean => {
        assert.ok(errorValue instanceof RuntimeBridgeProtocolError);
        assert.equal(errorValue.code, "runtime.noEndpoint");
        return true;
      },
    );
    assert.equal(service.state.connected, false,
      "换链失败后保持未连接：旧连接在握手前就被释放（已知取舍，见 probeAndConnect 的注释）。");
  } finally {
    service.disconnect();
    await new Promise<void>((resolve) => mute.close(() => resolve()));
    await listener.close();
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
