import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// Runtime Bridge V1 协议常量（与 visualbridge-runtime-bridge.schema.json 一致）。
export const RUNTIME_BRIDGE_PROTOCOL_VERSION = 1;
export const RUNTIME_BRIDGE_CORE_VERSION = 1;
export const RUNTIME_BRIDGE_DISCOVERY_FORMAT_VERSION = 1;
export const RUNTIME_BRIDGE_DISCOVERY_DIRECTORY = "visualbridge-runtime";

// 全能力 hello：MCP 客户端声明支持全部能力，具体可用性由实例 welcome 返回。
// MCP 客户端不消费 graphExecution（执行观察属 VS Code 扩展），但解析侧
// 必须接受该能力值——实例发现记录会通告它。
const CLIENT_CAPABILITIES = ["snapshot", "events", "lease", "sources"] as const;
const KNOWN_CAPABILITIES = ["snapshot", "events", "lease", "sources", "graphExecution"] as const;
const ERROR_CODES = new Set([
  "runtime.capabilityMissing",
  "runtime.executionNotFound",
  "runtime.internalError",
  "runtime.invalidJson",
  "runtime.invalidMessage",
  "runtime.invalidToken",
  "runtime.leaseDenied",
  "runtime.leaseNotHeld",
  "runtime.leaseRequired",
  "runtime.protocolVersionMismatch",
  "runtime.unknownMessageType",
  "runtime.unknownRequest",
]);
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;
const STALE_HEARTBEAT_MS = 5000;

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f]{48,64}$/;
const INSTANCE_ID_PATTERN = /^(editor|player)-[0-9]+$/;
const STARTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DOCUMENT_KIND_PATTERN = /^visualbridge\.(structured|entity|table|graph)\.compiled$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NORMALIZED_SOURCE_PATH_PATTERN = /^(?!\/)(?![A-Za-z]:\/)(?!.*:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*\/\/)(?:[^/]+\/)*[^/]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type RuntimeBridgeCapability = (typeof KNOWN_CAPABILITIES)[number];
export type RuntimeInstanceKind = "editor-play" | "player";
export type RuntimeStaleReason = "runtime.staleRecord" | "runtime.deadPid";

export interface RuntimeBridgeInstanceRecord {
  readonly instanceId: string;
  readonly kind: RuntimeInstanceKind;
  readonly capabilities: readonly RuntimeBridgeCapability[];
  readonly tcpPort: number;
  readonly token: string;
  readonly pid: number;
  readonly generation: number;
  readonly startedAt: string;
}

export interface RuntimeBridgeDiscoveredInstance extends RuntimeBridgeInstanceRecord {
  readonly staleReason?: RuntimeStaleReason;
}

export interface RuntimeDocumentSnapshot {
  readonly documentTypeId: string;
  readonly documentId: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

export interface RuntimeDocumentSource {
  readonly documentTypeId: string;
  readonly documentId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

interface WelcomeMessage {
  readonly type: "welcome";
  readonly instanceId: string;
}

type ResponseMessage =
  | { readonly status: "ok"; readonly documents?: readonly RuntimeDocumentSnapshot[]; readonly sources?: readonly RuntimeDocumentSource[] }
  | { readonly status: "error"; readonly error: string; readonly detail?: string };

type RequestAction = "getSnapshot" | "acquireLease" | "releaseLease" | "getDocumentSources";

/** 携带 runtime.* 协议错误码的客户端错误。 */
export class RuntimeBridgeClientError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeBridgeClientError";
  }
}

/** 枚举发现目录；非法记录跳过，返回按 instanceId 排序的结果。 */
export async function enumerateRuntimeInstances(directoryOverride?: string): Promise<readonly RuntimeBridgeDiscoveredInstance[]> {
  const directory = directoryOverride
    ?? path.join(os.tmpdir(), RUNTIME_BRIDGE_DISCOVERY_DIRECTORY);
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const instances: RuntimeBridgeDiscoveredInstance[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".json")) continue;
    const recordPath = path.join(directory, entry);
    let text: string;
    let mtimeMs: number;
    try {
      text = await readFile(recordPath, "utf8");
      mtimeMs = (await stat(recordPath)).mtimeMs;
    } catch {
      continue;
    }

    try {
      const record = parseDiscoveryRecord(JSON.parse(text));
      // 陈旧判定：心跳 >5 秒或 pid 已死双信号。
      let staleReason: RuntimeStaleReason | undefined;
      if (Date.now() - mtimeMs > STALE_HEARTBEAT_MS) staleReason = "runtime.staleRecord";
      else if (!processExists(record.pid)) staleReason = "runtime.deadPid";
      instances.push({ ...record, ...(staleReason === undefined ? {} : { staleReason }) });
    } catch {
      // 非法发现记录直接跳过，不中断枚举。
    }
  }

  return instances.sort((left, right) => compareIds(left.instanceId, right.instanceId));
}

interface PendingRequest {
  readonly resolve: (response: ResponseMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface Handshake {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface SocketListeners {
  readonly onData: (chunk: Buffer) => void;
  readonly onError: (error: Error) => void;
  readonly onClose: () => void;
}

/**
 * NDJSON 行解码器：用 StringDecoder 保留跨 TCP chunk 的不完整多字节序列，
 * 只在遇到换行后才把整行交给 JSON 解析。
 */
export class Utf8LineDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";

  public push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    const lines: string[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      lines.push(this.buffer.slice(0, newlineIndex));
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
    }

    return lines;
  }

  public reset(): void {
    this.buffer = "";
    // StringDecoder 没有 reset()，重新创建以丢弃跨连接残留的不完整序列。
    this.decoder = new StringDecoder("utf8");
  }
}

/** 单连接 Runtime Bridge 客户端：hello 握手后按 requestId 配对请求/响应。 */
export class RuntimeBridgeConnection {
  private socket: net.Socket | undefined;
  private decoder = new Utf8LineDecoder();
  private pending = new Map<string, PendingRequest>();
  private handshake: Handshake | undefined;
  private listeners: SocketListeners | undefined;
  private welcomed = false;
  private connectionError: RuntimeBridgeClientError | undefined;

  public constructor(private readonly instance: RuntimeBridgeInstanceRecord) {}

  public connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: this.instance.tcpPort });
      this.socket = socket;
      this.decoder.reset();
      this.welcomed = false;
      this.connectionError = undefined;

      const handshake: Handshake = { resolve, reject, timer: undefined };
      this.handshake = handshake;
      handshake.timer = setTimeout(() => {
        this.finishHandshake(new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge connect timed out."));
      }, timeoutMs);

      const onData = (chunk: Buffer): void => {
        for (const line of this.decoder.push(chunk)) this.handleLine(line);
      };
      const onError = (error: Error): void => {
        const failure = new RuntimeBridgeClientError("runtime.internalError", `Runtime bridge connection failed: ${error.message}`);
        if (this.handshake !== undefined) this.finishHandshake(failure);
        else this.invalidate(failure);
      };
      const onClose = (): void => {
        const failure = new RuntimeBridgeClientError(
          "runtime.internalError",
          this.handshake === undefined
            ? "Runtime bridge connection closed."
            : "Runtime bridge connection closed before welcome.",
        );
        if (this.handshake !== undefined) this.finishHandshake(failure);
        else this.invalidate(failure);
      };
      this.listeners = { onData, onError, onClose };

      // 握手前后都保留 error/close 监听：握手成功后若移除唯一 error 监听，
      // 对端 RST 会变成未捕获的 'error' 事件并终止进程。
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("data", onData);
      socket.on("connect", () => {
        socket.write(serializeMessage({
          type: "hello",
          protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION,
          coreVersion: RUNTIME_BRIDGE_CORE_VERSION,
          token: this.instance.token,
          clientInstanceId: randomUUID(),
          capabilities: [...CLIENT_CAPABILITIES],
        }));
      });
    });
  }

  public async getSnapshot(documentTypeIds?: readonly string[]): Promise<readonly RuntimeDocumentSnapshot[]> {
    const response = await this.request("getSnapshot", documentTypeIds);
    if (response.status !== "ok" || response.documents === undefined) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", "Snapshot response did not carry documents.");
    }
    return response.documents;
  }

  public async acquireLease(): Promise<void> {
    await this.expectLeaseResponse(await this.request("acquireLease"), "Lease acquisition failed.");
  }

  public async releaseLease(): Promise<void> {
    await this.expectLeaseResponse(await this.request("releaseLease"), "Lease release failed.");
  }

  public async getDocumentSources(): Promise<readonly RuntimeDocumentSource[]> {
    const response = await this.request("getDocumentSources");
    if (response.status !== "ok" || response.sources === undefined) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", "Sources response did not carry sources.");
    }
    return response.sources;
  }

  public dispose(): void {
    this.invalidate(new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge connection disposed."));
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && this.listeners !== undefined) {
      socket.off("data", this.listeners.onData);
      socket.off("error", this.listeners.onError);
      socket.off("close", this.listeners.onClose);
    }

    this.listeners = undefined;
    this.decoder.reset();
  }

  private async expectLeaseResponse(response: ResponseMessage, fallback: string): Promise<void> {
    if (response.status !== "ok") {
      throw new RuntimeBridgeClientError(response.error, response.detail ?? fallback);
    }
  }

  private request(action: RequestAction, documentTypeIds?: readonly string[]): Promise<ResponseMessage> {
    if (!this.welcomed || this.connectionError !== undefined || this.socket === undefined || this.socket.destroyed) {
      return Promise.reject(new RuntimeBridgeClientError("runtime.invalidMessage", "Runtime bridge is not connected."));
    }
    const requestId = `req-${randomUUID().slice(0, 8)}`;
    const payload = {
      type: "request",
      requestId,
      action,
      ...(action === "getSnapshot" && documentTypeIds !== undefined ? { documentTypeIds: [...documentTypeIds] } : {}),
    };

    return new Promise<ResponseMessage>((resolve, reject) => {
      let settled = false;
      const settle = (error: Error | undefined, response?: ResponseMessage): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (error === undefined && response !== undefined) resolve(response);
        else reject(error ?? new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge request failed."));
      };
      const timer = setTimeout(() => {
        settle(new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge request timed out."));
      }, REQUEST_TIMEOUT_MS);

      // 先登记等待器再写请求：请求只写一次，响应按 requestId 分发。
      this.pending.set(requestId, {
        resolve: (response) => settle(undefined, response),
        reject: (error) => settle(error),
        timer,
      });
      try {
        this.socket?.write(serializeMessage(payload), (error?: Error | null) => {
          if (error !== undefined && error !== null) {
            settle(new RuntimeBridgeClientError("runtime.internalError", `Runtime bridge write failed: ${error.message}`));
          }
        });
      } catch (errorValue) {
        settle(new RuntimeBridgeClientError("runtime.internalError", `Runtime bridge write failed: ${formatError(errorValue)}`));
      }
    });
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (errorValue) {
      const failure = new RuntimeBridgeClientError("runtime.invalidJson", `Runtime bridge sent an unparseable line: ${formatError(errorValue)}`);
      if (this.handshake !== undefined) this.finishHandshake(failure);
      else this.invalidate(failure);
      return;
    }

    if (this.handshake !== undefined) {
      // 握手阶段：首条必须是 welcome（或连接级 error）。
      let message: ParsedMessage;
      try {
        message = parseMessage(value);
      } catch (errorValue) {
        this.finishHandshake(toClientError(errorValue));
        return;
      }

      if (message.type === "welcome") {
        if (message.instanceId !== this.instance.instanceId) {
          this.finishHandshake(new RuntimeBridgeClientError(
            "runtime.invalidMessage",
            `Runtime instance identity mismatch: expected '${this.instance.instanceId}', received '${message.instanceId}'.`,
          ));
          return;
        }
        this.finishHandshake();
        return;
      }
      if (message.type === "error") {
        this.finishHandshake(new RuntimeBridgeClientError(message.code, message.detail ?? "Runtime bridge rejected the hello handshake."));
        return;
      }
      this.finishHandshake(new RuntimeBridgeClientError("runtime.invalidMessage", `Expected a welcome message, received '${message.type}'.`));
      return;
    }

    let message: ParsedMessage;
    try {
      message = parseMessage(value);
    } catch (errorValue) {
      this.invalidate(toClientError(errorValue));
      return;
    }

    if (message.type === "response") {
      const waiter = this.pending.get(message.requestId);
      if (waiter === undefined) {
        // 超时后的迟到响应：直接丢弃，不影响后续请求。
        return;
      }
      this.pending.delete(message.requestId);
      clearTimeout(waiter.timer);
      try {
        waiter.resolve(parseResponse(message.raw));
      } catch (errorValue) {
        waiter.reject(toClientError(errorValue));
      }
      return;
    }

    if (message.type === "error") {
      this.rejectPending(new RuntimeBridgeClientError(message.code, message.detail ?? "Runtime bridge reported a connection-level error."));
      return;
    }

    // event 等非配对消息忽略；请求只写一次，不因事件重新发送。
  }

  private finishHandshake(error?: RuntimeBridgeClientError): void {
    const handshake = this.handshake;
    if (handshake === undefined) return;
    this.handshake = undefined;
    if (handshake.timer !== undefined) clearTimeout(handshake.timer);
    if (error === undefined) {
      this.welcomed = true;
      handshake.resolve();
      return;
    }

    this.welcomed = false;
    this.connectionError = error;
    this.rejectPending(error);
    this.socket?.destroy();
    handshake.reject(error);
  }

  /** 连接失效：拒绝所有等待者并销毁 socket，绝不留下静默挂起的请求。 */
  private invalidate(error: RuntimeBridgeClientError): void {
    if (this.handshake !== undefined) {
      this.finishHandshake(error);
      return;
    }

    if (this.connectionError === undefined) this.connectionError = error;
    this.welcomed = false;
    this.rejectPending(this.connectionError);
    this.socket?.destroy();
  }

  private rejectPending(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function toClientError(errorValue: unknown): RuntimeBridgeClientError {
  return errorValue instanceof RuntimeBridgeClientError
    ? errorValue
    : new RuntimeBridgeClientError("runtime.invalidMessage", formatError(errorValue));
}

type ParsedMessage =
  | { readonly type: "welcome"; readonly instanceId: string }
  | { readonly type: "response"; readonly requestId: string; readonly raw: Record<string, unknown> }
  | { readonly type: "error"; readonly code: string; readonly detail?: string }
  | { readonly type: "event" };

function parseMessage(value: unknown): ParsedMessage {
  const record = requireObject(value);
  const type = requireString(record, "type", "$.type");
  if (type === "welcome") return { type, instanceId: parseWelcome(record).instanceId };
  if (type === "response") return { type, requestId: requireRequestId(record), raw: record };
  if (type === "error") {
    const code = requireString(record, "code", "$.code");
    if (!ERROR_CODES.has(code)) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.code: Unknown runtime error code.");
    }
    const detail = record.detail === undefined ? undefined : requireString(record, "detail", "$.detail");
    return { type, code, ...(detail === undefined ? {} : { detail }) };
  }
  if (type === "event") {
    // 事件消息只做形状校验，MCP 检查工具不订阅事件。
    requireExactKeys(record, ["type", "event", "documents"]);
    if (requireString(record, "event", "$.event") !== "artifactsChanged" || !Array.isArray(record.documents)) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.event: Unknown runtime event.");
    }
    return { type };
  }
  throw new RuntimeBridgeClientError("runtime.unknownMessageType", `$.type: Unknown message type '${type}'.`);
}

function parseResponse(record: Record<string, unknown>): ResponseMessage {
  requireExactKeys(record, ["type", "requestId", "status", "documents", "sources", "error", "detail"]);
  const status = requireString(record, "status", "$.status");
  if (status === "ok") {
    if (record.documents !== undefined && record.sources !== undefined) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", "$: documents and sources are mutually exclusive.");
    }
    if (record.documents !== undefined) {
      return { status, documents: requireArray(record, "documents").map(parseDocumentSnapshot) };
    }
    if (record.sources !== undefined) {
      return { status, sources: requireArray(record, "sources").map(parseDocumentSource) };
    }
    return { status };
  }
  if (status !== "error") {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.status: Expected a response status.");
  }
  const error = requireString(record, "error", "$.error");
  if (!ERROR_CODES.has(error)) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.error: Unknown runtime error code.");
  }
  const detail = record.detail === undefined ? undefined : requireString(record, "detail", "$.detail");
  return { status, error, ...(detail === undefined ? {} : { detail }) };
}

function parseDiscoveryRecord(value: unknown): RuntimeBridgeInstanceRecord {
  const record = requireObject(value);
  requireExactKeys(record, [
    "formatVersion", "protocolVersion", "coreVersion", "instanceId", "kind",
    "capabilities", "tcpPort", "token", "pid", "generation", "startedAt",
  ]);
  requireConstVersion(record, "formatVersion", RUNTIME_BRIDGE_DISCOVERY_FORMAT_VERSION);
  requireConstVersion(record, "protocolVersion", RUNTIME_BRIDGE_PROTOCOL_VERSION);
  requireConstVersion(record, "coreVersion", RUNTIME_BRIDGE_CORE_VERSION);

  const instanceId = requirePatternedString(record, "instanceId", INSTANCE_ID_PATTERN);
  const kind = requireString(record, "kind", "$.kind");
  if ((instanceId.startsWith("editor-") && kind !== "editor-play")
    || (instanceId.startsWith("player-") && kind !== "player")) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.kind: Instance id prefix must match the kind.");
  }

  const tcpPort = requireInteger(record, "tcpPort", "$.tcpPort");
  if (tcpPort < 1 || tcpPort > 65535) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.tcpPort: Expected a TCP port between 1 and 65535.");
  }
  const pid = requireInteger(record, "pid", "$.pid");
  if (pid < 1) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.pid: Expected a positive process id.");
  }
  const generation = requireInteger(record, "generation", "$.generation");
  if (generation < 1) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.generation: Expected a positive generation.");
  }
  requirePatternedString(record, "startedAt", STARTED_AT_PATTERN);

  return {
    instanceId,
    kind: kind as RuntimeInstanceKind,
    capabilities: requireCapabilities(record),
    tcpPort,
    token: requirePatternedString(record, "token", TOKEN_PATTERN),
    pid,
    generation,
    startedAt: record.startedAt as string,
  };
}

function parseWelcome(record: Record<string, unknown>): { readonly instanceId: string } {
  requireExactKeys(record, ["type", "protocolVersion", "coreVersion", "instanceId", "kind", "generation", "capabilities", "startedAt"]);
  requireConstVersion(record, "protocolVersion", RUNTIME_BRIDGE_PROTOCOL_VERSION);
  requireConstVersion(record, "coreVersion", RUNTIME_BRIDGE_CORE_VERSION);
  const instanceId = requirePatternedString(record, "instanceId", INSTANCE_ID_PATTERN);
  const kind = requireString(record, "kind", "$.kind");
  if ((instanceId.startsWith("editor-") && kind !== "editor-play")
    || (instanceId.startsWith("player-") && kind !== "player")) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.kind: Instance id prefix must match the kind.");
  }
  const generation = requireInteger(record, "generation", "$.generation");
  if (generation < 1) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.generation: Expected a positive generation.");
  }
  requirePatternedString(record, "startedAt", STARTED_AT_PATTERN);
  requireCapabilities(record);
  return { instanceId };
}

function parseDocumentSnapshot(value: unknown): RuntimeDocumentSnapshot {
  const record = requireObject(value);
  requireExactKeys(record, ["documentTypeId", "documentId", "kind", "data"]);
  const kind = requirePatternedString(record, "kind", DOCUMENT_KIND_PATTERN);
  const data = record.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.data: Expected an artifact data object.");
  }
  return {
    documentTypeId: requirePatternedString(record, "documentTypeId", STABLE_ID_PATTERN),
    documentId: requirePatternedString(record, "documentId", STABLE_ID_PATTERN),
    kind,
    data: data as Record<string, unknown>,
  };
}

function parseDocumentSource(value: unknown): RuntimeDocumentSource {
  const record = requireObject(value);
  requireExactKeys(record, ["documentTypeId", "documentId", "sourcePath", "sourceSha256"]);
  return {
    documentTypeId: requirePatternedString(record, "documentTypeId", STABLE_ID_PATTERN),
    documentId: requirePatternedString(record, "documentId", STABLE_ID_PATTERN),
    sourcePath: requirePatternedString(record, "sourcePath", NORMALIZED_SOURCE_PATH_PATTERN),
    sourceSha256: requirePatternedString(record, "sourceSha256", SHA256_PATTERN),
  };
}

function requireCapabilities(record: Record<string, unknown>): readonly RuntimeBridgeCapability[] {
  const value = record.capabilities;
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.capabilities: Expected a non-empty capability list.");
  }
  const capabilities = value.map((entry) => {
    if (typeof entry !== "string" || !(KNOWN_CAPABILITIES as readonly string[]).includes(entry)) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.capabilities: Expected runtime capability names.");
    }
    return entry as RuntimeBridgeCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$.capabilities: Capabilities must be unique.");
  }
  return capabilities;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", "$: Expected an object.");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", `$: Unknown property '${key}'.`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, jsonPath: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", `${jsonPath}: Expected a string for '${key}'.`);
  }
  return value;
}

function requirePatternedString(record: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = requireString(record, key, `$.${key}`);
  if (!pattern.test(value)) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", `$.${key}: Unexpected value for '${key}'.`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, jsonPath: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", `${jsonPath}: Expected an integer for '${key}'.`);
  }
  return value;
}

function requireConstVersion(record: Record<string, unknown>, key: string, expected: number): void {
  if (requireInteger(record, key, `$.${key}`) !== expected) {
    throw new RuntimeBridgeClientError("runtime.protocolVersionMismatch", `$.${key}: Expected ${key} ${expected}.`);
  }
}

function requireArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new RuntimeBridgeClientError("runtime.invalidMessage", `$.${key}: Expected an array.`);
  }
  return value;
}

function requireRequestId(record: Record<string, unknown>): string {
  return requirePatternedString(record, "requestId", REQUEST_ID_PATTERN);
}

function serializeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (errorValue) {
    return (errorValue as NodeJS.ErrnoException).code === "EPERM";
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
