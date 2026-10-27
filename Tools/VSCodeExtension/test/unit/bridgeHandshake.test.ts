import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_DISCOVERY_FORMAT_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  evaluateHello,
  evaluateWelcome,
  isSupportedContractManifest,
  negotiatePayloads,
  parseBridgeHello,
  parseBridgeMessage,
  parseBridgeWelcome,
  parseDiscoveryRecord,
  selectBridgeContractHash,
  shouldDegradeToJson,
  type BridgeDiscoveryRecord,
  type BridgeHelloMessage,
} from "../../src/bridge/bridgeProtocol";

const TOKEN = "a".repeat(48);
const WINDOW_ID = "1b3121ab-2646-4e0f-a789-e970d4fbca8f";
const SESSION_ID = `${WINDOW_ID}#boot-1`;

function helloValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hello",
    protocolVersion: 4,
    role: "editor",
    clientEndpointId: "editor-1234",
    token: TOKEN,
    contractHash: "",
    payloads: ["json", "binary"],
    ...overrides,
  };
}

function welcomeValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "welcome",
    protocolVersion: 4,
    endpointId: WINDOW_ID,
    sessionId: SESSION_ID,
    resumed: false,
    connectType: "editor",
    generation: 3,
    bootId: "boot-1",
    contractHash: "",
    payloads: ["json", "binary"],
    debugEnabled: true,
    startedAt: "2026-10-26T12:00:00.000Z",
    ...overrides,
  };
}

function discoveryValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 2,
    protocolVersion: 4,
    role: "vscode",
    tcpPort: 28301,
    token: TOKEN,
    pid: process.pid,
    generation: 3,
    windowId: WINDOW_ID,
    projectRoots: ["D:/Authoring"],
    ...overrides,
  };
}

function expectProtocolError(action: () => unknown, code: string): void {
  assert.throws(action, (errorValue: unknown) => errorValue instanceof BridgeProtocolError && errorValue.code === code);
}

test("the connection layer exposes exactly protocolVersion 4 and discovery formatVersion 2", () => {
  assert.equal(BRIDGE_PROTOCOL_VERSION, 4);
  assert.equal(BRIDGE_DISCOVERY_FORMAT_VERSION, 2);
  assert.equal(isSupportedContractManifest({ manifest: { schemaVersion: 2 } }), true);
  assert.equal(isSupportedContractManifest({ manifest: { schemaVersion: 1 } }), false);
  assert.equal(isSupportedContractManifest({ manifest: {} }), false);
});

test("parses a complete hello and keeps optional filters/resume session", () => {
  const hello = parseBridgeHello(helloValue({
    contractHash: "efbd32c726d801eb",
    debugCategories: ["visualbridge.entity"],
    debugInstances: [],
    resumeSessionId: SESSION_ID,
  }));
  assert.equal(hello.protocolVersion, 4);
  assert.equal(hello.role, "editor");
  assert.equal(hello.clientEndpointId, "editor-1234");
  assert.equal(hello.token, TOKEN);
  assert.equal(hello.contractHash, "efbd32c726d801eb");
  assert.deepEqual(hello.payloads, ["json", "binary"]);
  assert.deepEqual(hello.debugCategories, ["visualbridge.entity"]);
  assert.deepEqual(hello.debugInstances, []);
  assert.equal(hello.resumeSessionId, SESSION_ID);
});

test("omitted handshake optional fields stay absent and contractHash defaults to the empty string", () => {
  const hello = parseBridgeHello(helloValue({ token: undefined }));
  assert.equal(hello.contractHash, "");
  assert.equal(hello.token, undefined);
  assert.equal(hello.debugCategories, undefined);
  assert.equal(hello.debugInstances, undefined);
  assert.equal(hello.resumeSessionId, undefined);
});

test("a different connection layer version fails immediately", () => {
  expectProtocolError(() => parseBridgeMessage(helloValue({ protocolVersion: 3 })), "runtime.unsupportedProtocolVersion");
  expectProtocolError(() => parseBridgeMessage(welcomeValue({ protocolVersion: 5 })), "runtime.unsupportedProtocolVersion");
});

test("a pre-unification hello is rejected by the connection layer before its unknown fields", () => {
  expectProtocolError(
    () => parseBridgeMessage({
      type: "hello",
      protocolVersion: 1,
      token: TOKEN,
      clientInstanceId: "1b3121ab-2646-4e0f-a789-e970d4fbca8f",
      capabilities: ["open", "reveal"],
    }),
    "runtime.unsupportedProtocolVersion",
  );
});

test("old handshake fields are rejected instead of silently ignored", () => {
  expectProtocolError(
    () => parseBridgeMessage(helloValue({ coreVersion: 1, capabilities: ["open"] })),
    "bridge.unknownProperty",
  );
});

test("hello payload negotiation requires json and reports an empty intersection", () => {
  expectProtocolError(() => parseBridgeMessage(helloValue({ payloads: ["binary"] })), "runtime.unsupportedPayload");
  expectProtocolError(() => parseBridgeMessage(helloValue({ payloads: [] })), "runtime.unsupportedPayload");
  assert.equal(negotiatePayloads(["binary"], true), undefined);
  assert.deepEqual(negotiatePayloads(["binary", "json"], true), ["json", "binary"]);
  assert.deepEqual(negotiatePayloads(["json", "binary"], false), ["json"]);
});

test("rejects a role that does not match the listener identity", () => {
  const hello = parseBridgeHello(helloValue({ role: "vscode" }));
  const rejection = evaluateHello(hello, {
    role: "vscode",
    token: TOKEN,
    hasActiveConnection: false,
    supportsBinary: true,
  });
  assert.equal(rejection?.code, "runtime.roleMismatch");
});

test("rejects a wrong token and a second connection while keeping the first", () => {
  const hello = parseBridgeHello(helloValue());
  assert.equal(evaluateHello(hello, {
    role: "vscode",
    token: "b".repeat(48),
    hasActiveConnection: false,
    supportsBinary: true,
  })?.code, "runtime.invalidToken");
  assert.equal(evaluateHello(hello, {
    role: "vscode",
    token: TOKEN,
    hasActiveConnection: true,
    supportsBinary: true,
  })?.code, "runtime.alreadyConnected");
});

test("accepts a valid hello and negotiates binary only when fingerprint and support agree", () => {
  const hello = parseBridgeHello(helloValue());
  assert.equal(evaluateHello(hello, {
    role: "vscode",
    token: TOKEN,
    hasActiveConnection: false,
    supportsBinary: true,
  }), undefined);
  assert.deepEqual(negotiatePayloads(hello.payloads, false), ["json"]);
});

test("welcome keeps the endpointId#bootId invariant and version/json checks", () => {
  const welcome = parseBridgeWelcome(welcomeValue());
  assert.equal(welcome.sessionId, `${welcome.endpointId}#${welcome.bootId}`);
  assert.equal(evaluateWelcome(welcome), undefined);

  expectProtocolError(
    () => parseBridgeWelcome(welcomeValue({ sessionId: "other-window#boot-1" })),
    "bridge.invalidMessage",
  );
  assert.equal(evaluateWelcome({ ...welcome, protocolVersion: 3 })?.code, "runtime.unsupportedProtocolVersion");
  assert.equal(evaluateWelcome({ ...welcome, payloads: ["json"] }), undefined);
});

test("parses discovery record v2 and rejects v1 records as absent", () => {
  const record: BridgeDiscoveryRecord = parseDiscoveryRecord(discoveryValue());
  assert.equal(record.formatVersion, 2);
  assert.equal(record.role, "vscode");
  assert.equal(record.windowId, WINDOW_ID);
  assert.deepEqual(record.projectRoots, ["D:/Authoring"]);

  expectProtocolError(() => parseDiscoveryRecord(discoveryValue({ formatVersion: 1 })), "bridge.unsupportedFormatVersion");
  expectProtocolError(
    () => parseDiscoveryRecord(discoveryValue({ capabilities: ["open"] })),
    "bridge.unknownProperty",
  );
});

test("hello and welcome reject a malformed contract hash", () => {
  expectProtocolError(() => parseBridgeHello(helloValue({ contractHash: "XYZ" })), "bridge.invalidMessage");
  expectProtocolError(() => parseBridgeWelcome(welcomeValue({ contractHash: "abc" })), "bridge.invalidMessage");
});

test("a parsed hello can be evaluated after the listener reports a degraded data plane", () => {
  const hello: BridgeHelloMessage = parseBridgeHello(helloValue({ payloads: ["json"] }));
  assert.equal(evaluateHello(hello, {
    role: "vscode",
    token: TOKEN,
    hasActiveConnection: false,
    supportsBinary: false,
  }), undefined);
});

test("contract fingerprints degrade the data plane instead of rejecting the connection", () => {
  // 两侧都没有契约：指纹相等，保留 binary。
  assert.deepEqual(selectBridgeContractHash("", []), { contractHash: "", degraded: false, matched: true });
  // 客户端有契约、监听方没有：不一致 → 降级，且监听方如常报告自己是空串。
  assert.deepEqual(selectBridgeContractHash("aaaaaaaaaaaaaaaa", []), {
    contractHash: "",
    degraded: true,
    matched: false,
  });

  // 多 Project 工作区：命中任意一个已加载契约就算一致（客户端指纹决定它来自哪个工程）。
  // 刻意让客户端取**非排序首个** hash：否则 `known[0] === client` 这类退化实现也能碰巧通过。
  const known = ["9f1c2d3e4a5b6c7d", "0123456789abcdef"];
  assert.deepEqual(selectBridgeContractHash("9f1c2d3e4a5b6c7d", known), {
    contractHash: "9f1c2d3e4a5b6c7d",
    degraded: false,
    matched: true,
  });
  // 都不命中：连接保留，welcome 回发排序首个指纹供 UI 提示两侧 hash。
  assert.deepEqual(selectBridgeContractHash("ffffffffffffffff", known), {
    contractHash: "0123456789abcdef",
    degraded: true,
    matched: false,
  });

  // 单契约工程里该函数与 A.3 的原始定义等价。
  assert.equal(shouldDegradeToJson("", ""), false);
  assert.equal(shouldDegradeToJson("9f1c2d3e4a5b6c7d", ""), true);
  assert.equal(shouldDegradeToJson("9f1c2d3e4a5b6c7d", "9f1c2d3e4a5b6c7d"), false);
  assert.equal(selectBridgeContractHash("9f1c2d3e4a5b6c7d", ["9f1c2d3e4a5b6c7d"]).degraded, false);
});

test("a client hash that is not the first known hash keeps the binary data plane", () => {
  // 排序后首个是 0123…；客户端命中中间的 9f1c…。任何"只认首个"的实现都会在这里降级。
  const known = ["1111111111111111", "9f1c2d3e4a5b6c7d", "0123456789abcdef"];
  const sortedFirst = "0123456789abcdef";
  const client = "9f1c2d3e4a5b6c7d";
  assert.notEqual(client, sortedFirst);

  const selection = selectBridgeContractHash(client, known);
  assert.deepEqual(selection, { contractHash: client, degraded: false, matched: true });
  // 命中非首个 hash 时 welcome 仍协商出 ["json","binary"]，不因排序位置降级。
  assert.deepEqual(negotiatePayloads(["json", "binary"], !selection.degraded), ["json", "binary"]);

  // 未命中任意一个时才降级，并回发排序首个指纹供 UI 提示。
  const miss = selectBridgeContractHash("ffffffffffffffff", known);
  assert.deepEqual(miss, { contractHash: sortedFirst, degraded: true, matched: false });
  assert.deepEqual(negotiatePayloads(["json", "binary"], !miss.degraded), ["json"]);
});
