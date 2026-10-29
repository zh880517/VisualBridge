import assert from "node:assert/strict";
import * as net from "node:net";
import * as nodeModule from "node:module";
import test, { after } from "node:test";
import { BRIDGE_PROTOCOL_VERSION } from "../../src/bridge/bridgeProtocol";
import { DebugContractRegistry } from "../../src/bridge/debugContractRegistry";
import type { EditorBridgeServerTransport } from "../../src/bridge/editorBridgeConnections";
import type { BridgeSocketHandlers } from "../../src/bridge/bridgeSocket";
import { BridgePayloadKind } from "../../src/bridge/framing";
import type { DebugQueryError } from "../../src/bridge/debugQueryClient";
import type { LogOutputChannel } from "vscode";

/**
 * **真实** `EditorBridgeServer` 上的查询路由用例（F8-§4）。
 *
 * 之前的用例只测纯函数（`resolveDebugQueryClient`），无法发现"路由层把 `endedReason` 丢了"
 * 这类接线错误。这里用真服务端（真握手、真实例表、真挂起表）加一个**内存传输**
 * （{@link EditorBridgeServerTransport} 的注入点）驱动完整路径，不开端口。
 *
 * 唯一的测试侧妥协：`editorBridgeServer` 在模块顶层 `require("vscode")`，单测进程里没有这个模块，
 * 所以在 `require` 之前把 `vscode` 换成最小 stub。本用例不会走到编辑器 API
 * （`autoLoadContracts:false`，也不做 open/reveal），stub 只是让模块能加载。
 */

const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (): undefined => undefined }),
    workspaceFolders: [],
    createFileSystemWatcher: () => {
      throw new Error("the route test must not create a file-system watcher");
    },
  },
  Uri: {
    joinPath: (base: { readonly fsPath: string }, ...segments: string[]) => ({ fsPath: [base.fsPath, ...segments].join("/") }),
  },
  commands: { executeCommand: async (): Promise<undefined> => undefined },
};

type ModuleLoader = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
// `import * as nodeModule` 在 CJS 编译下是 `__importStar` 的命名空间（属性是只读 getter）；
// 真正的模块对象挂在 `.default` 上（esModuleInterop），`_load` 必须在那个对象上替换。
const moduleNamespace = nodeModule as unknown as {
  readonly default?: { _load: ModuleLoader };
  readonly _load?: ModuleLoader;
};
const moduleApi = moduleNamespace.default ?? (moduleNamespace as { _load: ModuleLoader });
const originalLoad = moduleApi._load;

/**
 * 本文件装的补丁（具名保存，`after()` 靠它做身份判定）。
 *
 * `Module._load` 是**进程级**的：不恢复会让同一进程里随后加载的任何模块都拿到这个 stub，
 * 所以必须在 `after()` 还原（F8 评审必修七 ①）。但还原也**不能无条件写回**——若别人在本文件
 * 之后又装了补丁，无条件写回会把别人的补丁顶掉。判据是"当前值仍是本文件装的那一个"
 * （F8 评审二轮必修二）：`moduleApi._load === patchedLoad` 才还原，否则原样不动。
 */
const patchedLoad: ModuleLoader = function load(request, parent, isMain) {
  return request === "vscode" ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};
moduleApi._load = patchedLoad;

after(() => {
  // 别人后装的补丁不动（只撤销自己的那一层）。
  if (moduleApi._load === patchedLoad) {
    moduleApi._load = originalLoad;
  }
});

type ServerModule = typeof import("../../src/bridge/editorBridgeServer.js");

/** 必须在打过 `vscode` 补丁之后才加载服务端模块。 */
async function loadServerModule(): Promise<ServerModule> {
  return import("../../src/bridge/editorBridgeServer.js");
}

interface FakeTransport {
  readonly transport: EditorBridgeServerTransport;
  /** 服务端发往通道 0 的 JSON（欢迎/错误/debugSetEnabled）。 */
  readonly controlSent: unknown[];
  /** 服务端发往通道 1 的 JSON（查询 `request`）。 */
  readonly debugSent: Record<string, unknown>[];
  bind(handlers: BridgeSocketHandlers): void;
  feedControl(value: unknown): void;
  feedDebug(value: unknown): void;
  peerClose(): void;
}

/** 内存传输：把"入站帧 → handlers"与"出站帧 → 数组"接起来，行为足够驱动真实服务端。 */
function createFakeTransport(): FakeTransport {
  let handlers: BridgeSocketHandlers | undefined;
  let open = true;
  const controlSent: unknown[] = [];
  const debugSent: Record<string, unknown>[] = [];
  const requireHandlers = (): BridgeSocketHandlers => {
    assert.notEqual(handlers, undefined, "the server never bound transport handlers");
    return handlers as BridgeSocketHandlers;
  };

  const transport: EditorBridgeServerTransport = {
    get isOpen() {
      return open;
    },
    get isTerminated() {
      return !open;
    },
    sendControlJson: (message: unknown) => {
      if (!open) {
        return false;
      }

      controlSent.push(message);
      return true;
    },
    sendDebugControl: (payload: Uint8Array) => {
      if (!open) {
        return false;
      }

      debugSent.push(JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>);
      return true;
    },
    close: () => {
      open = false;
    },
    end: () => {
      open = false;
    },
  };

  return {
    transport,
    controlSent,
    debugSent,
    bind: (value: BridgeSocketHandlers) => {
      handlers = value;
    },
    feedControl: (value: unknown) => {
      requireHandlers().onControlPayload(Buffer.from(JSON.stringify(value), "utf8"), BridgePayloadKind.Json);
    },
    feedDebug: (value: unknown) => {
      requireHandlers().onDebugFrame(BridgePayloadKind.Json, Buffer.from(JSON.stringify(value), "utf8"));
    },
    peerClose: () => {
      open = false;
      requireHandlers().onClosed(undefined);
    },
  };
}

type ServerInstance = InstanceType<ServerModule["EditorBridgeServer"]>;

interface Harness {
  readonly server: ServerInstance;
  readonly token: string;
  readonly sessionId: string;
  readonly port: number;
  readonly lines: string[];
  dispose(): void;
}

async function startHarness(): Promise<Harness> {
  const { EditorBridgeServer } = await loadServerModule();
  const lines: string[] = [];
  const output = {
    name: "visualbridge-test",
    logLevel: 1,
    appendLine: (line: string) => lines.push(line),
    append: () => undefined,
  } as unknown as LogOutputChannel;
  const server = new EditorBridgeServer(
    { projects: [], onDidChange: () => ({ dispose: () => undefined }) } as never,
    {} as never,
    output,
    { contracts: new DebugContractRegistry(), autoLoadContracts: false },
  );
  await server.start();
  const state = server.state;
  assert.notEqual(state, undefined, "the server did not publish its listening state");
  return {
    server,
    token: state!.token,
    sessionId: state!.sessionId,
    port: state!.tcpPort,
    lines,
    dispose: () => server.dispose(),
  };
}

/** 接一条内存传输（生产这里是 `BridgeSocket`）。 */
function attach(harness: Harness): FakeTransport {
  const fake = createFakeTransport();
  harness.server.acceptTransport((handlers) => {
    fake.bind(handlers);
    return fake.transport;
  });
  return fake;
}

function handshake(
  fake: FakeTransport,
  harness: Harness,
  options: { readonly resumeSessionId?: string } = {},
): Record<string, unknown> {
  fake.feedControl({
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    role: "editor",
    clientEndpointId: "unity-editor-test",
    contractHash: "",
    payloads: ["json"],
    token: harness.token,
    ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
  });
  const welcome = fake.controlSent.find((message) => (message as Record<string, unknown>).type === "welcome");
  assert.notEqual(welcome, undefined, `handshake was rejected: ${JSON.stringify(fake.controlSent)}`);
  return welcome as Record<string, unknown>;
}

const CATEGORY = "graph";
const INSTANCE = "hero";
const KEY = `${CATEGORY}\u0000${INSTANCE}`;

function createInstance(fake: FakeTransport, instanceId = INSTANCE, slot = 1): void {
  fake.feedDebug({
    type: "debugCreate",
    category: CATEGORY,
    instance: instanceId,
    instanceSlot: slot,
    resName: "Hero",
    debugInfo: "",
  });
}

function queryHero(harness: Harness): Promise<unknown> {
  return harness.server.queryDebug(KEY, "IGraphQuery", "Query", [{ tag: 0, type: "bool", value: true }], { methodId: 12 });
}

function isQueryError(code: string, message?: RegExp) {
  return (errorValue: unknown): boolean => {
    const error = errorValue as DebugQueryError;
    assert.equal(error.code, code, `expected ${code}, received ${String(error.code)} (${error.message})`);
    if (message !== undefined) {
      assert.match(error.message, message);
    }

    return true;
  };
}

test("a real server maps notConnected / instanceNotFound to local errors", async () => {
  const harness = await startHarness();
  try {
    await assert.rejects(queryHero(harness), isQueryError("local.notConnected", /没有可用的调试连接/u));

    const fake = attach(harness);
    handshake(fake, harness);
    await assert.rejects(queryHero(harness), isQueryError("local.instanceNotFound", /实例不存在/u));
    assert.deepEqual(fake.debugSent, [], "a rejected query must not reach the wire");
  } finally {
    harness.dispose();
  }
});

test("a real server reports noOwner when no live connection holds the instance", async () => {
  const harness = await startHarness();
  try {
    const fake = attach(harness);
    handshake(fake, harness);
    // 实例在表里、但没有任何连接的槽位绑定持有它（原连接已断/实例是别的腿的）。
    harness.server.debug.create({ category: CATEGORY, instanceId: INSTANCE, instanceSlot: 9, resName: "Ghost", debugInfo: "" });

    await assert.rejects(queryHero(harness), isQueryError("local.noOwner", /没有任何存活的调试连接持有/u));
    assert.deepEqual(fake.debugSent, []);
  } finally {
    harness.dispose();
  }
});

test("a real server reports ambiguous when two connections claim the instance", async () => {
  const harness = await startHarness();
  try {
    const fake = attach(harness);
    handshake(fake, harness);
    harness.server.debug.create({ category: CATEGORY, instanceId: INSTANCE, instanceSlot: 9, resName: "Ghost", debugInfo: "" });
    // 另一条腿（Runtime 桥）的两个查询源都声称持有同一实例：不猜，回 local.noConnection。
    const external = [1, 2].map(() => ({ owns: () => true, client: undefined as never }));
    harness.server.registerDebugQuerySource(() => external);

    await assert.rejects(queryHero(harness), isQueryError("local.noConnection", /无法确定该实例属于哪条调试连接/u));
    assert.deepEqual(fake.debugSent, []);
  } finally {
    harness.dispose();
  }
});

test("a real server says the instance finished after debugFinish cancels the in-flight query", async () => {
  const harness = await startHarness();
  try {
    const fake = attach(harness);
    handshake(fake, harness);
    createInstance(fake);

    const inFlight = queryHero(harness);
    const expectation = assert.rejects(
      inFlight,
      isQueryError("local.instanceFinished", /实例已结束：本次查询已取消，不会重试/u),
    );
    assert.equal(fake.debugSent.length, 1, "the query must have reached the wire before Finish");
    fake.feedDebug({ type: "debugFinish", category: CATEGORY, instance: INSTANCE });
    await expectation;

    // 结束之后的新查询：同一个码，但文案是"没有发出"（区分在途取消与发起时拒绝）。
    await assert.rejects(queryHero(harness), isQueryError("local.instanceFinished", /本次查询没有发出/u));
    assert.equal(fake.debugSent.length, 1, "a finished instance must not receive a new query");
  } finally {
    harness.dispose();
  }
});

test("a real server reports reconnect (not finished) while the session is being rebuilt", async () => {
  const harness = await startHarness();
  try {
    const first = attach(harness);
    const welcome = handshake(first, harness);
    createInstance(first);
    first.peerClose();

    // 15 s 宽限内带 resumeSessionId 重连：旧实例标 endedAt + reason=reconnect（C.3），等运行时重新 Create。
    const second = attach(harness);
    const resumed = handshake(second, harness, { resumeSessionId: String(welcome.sessionId) });
    assert.equal(resumed.resumed, true, "the reconnect must resume the previous session");

    await assert.rejects(
      queryHero(harness),
      isQueryError("local.instanceFinished", /连接正在重建，该实例暂不可查询：本次查询没有发出/u),
    );
    assert.deepEqual(second.debugSent, [], "a reconnecting instance must not receive a query");
    assert.match(
      harness.lines.filter((line) => line.includes("reconnect")).join("\n"),
      /ended with reason 'reconnect'/u,
      "the reconnect marker must be the reason the route reports",
    );
  } finally {
    harness.dispose();
  }
});

test("a real server rejects a capacity-evicted instance at the route instead of sending a doomed query", async () => {
  const harness = await startHarness();
  try {
    const fake = attach(harness);
    handshake(fake, harness);
    // 33 条（上限 32）：第一条被淘汰成墓碑 —— 视图还在（active=true），历史不再记录。
    for (let index = 0; index < 33; index++) {
      createInstance(fake, `hero-${index}`, index + 1);
    }

    const evicted = harness.server.debug.instance(`${CATEGORY}\u0000hero-0`);
    assert.notEqual(evicted, undefined);
    assert.equal(evicted?.historyMissing, true, "the first instance must be a capacity tombstone");
    assert.equal(evicted?.active, true, "a tombstone keeps the Finish semantics (still 'active' until Finish)");

    await assert.rejects(
      harness.server.queryDebug(`${CATEGORY}\u0000hero-0`, "IGraphQuery", "Query", [], { methodId: 12 }),
      isQueryError("local.instanceEvicted", /该实例已被淘汰，历史未记录/u),
    );
    assert.deepEqual(fake.debugSent, [], "an evicted instance must not receive a query");
  } finally {
    harness.dispose();
  }
});

test("a real server completes a query roundtrip and a peer disconnect cancels the in-flight one", async () => {
  const harness = await startHarness();
  try {
    const fake = attach(harness);
    handshake(fake, harness);
    createInstance(fake);

    const roundtrip = queryHero(harness);
    const request = fake.debugSent.at(0);
    assert.notEqual(request, undefined);
    assert.equal(request?.type, "request", "the query must go out as a channel-1 request envelope");
    assert.equal(request?.action, "debugQuery");
    fake.feedDebug({
      type: "debugResult",
      requestId: String(request?.requestId),
      category: CATEGORY,
      instance: INSTANCE,
      methodId: 12,
      args: [{ tag: 0, type: "bool", value: true }],
    });
    const result = await roundtrip as { readonly record?: { readonly kind: string } };
    assert.equal(result.record?.kind, "queryResult", "the result must land in the timeline as a queryResult record");

    const pending = queryHero(harness);
    const expectation = assert.rejects(pending, isQueryError("local.disconnected", /连接已断开/u));
    fake.peerClose();
    await expectation;
  } finally {
    harness.dispose();
  }
});

test("disposing the server releases its loopback listener (F8 必修七 ②)", async () => {
  // 这个文件为了让模块能加载替换了 `Module._load`；但服务端仍然**真的**监听了 loopback 端口。
  // 用例结束时端口必须释放，否则同一进程里的后续用例会撞端口、且退出被 listener 拖住。
  const harness = await startHarness();
  assert.ok(harness.port > 0, "the server must report a real port");
  harness.dispose();

  // `net.Server.close()` 是异步的：轮询到端口可再次绑定为止（上限 2 s，超时即失败）。
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  for (;;) {
    try {
      await bindOnce(harness.port);
      return;
    } catch (errorValue) {
      lastError = errorValue;
      if (Date.now() >= deadline) {
        throw new Error(`the bridge port ${harness.port} was not released: ${String(lastError)}`);
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
});

function bindOnce(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      probe.close();
      reject(error);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve());
    });
  });
}
