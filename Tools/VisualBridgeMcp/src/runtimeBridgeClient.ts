import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";

// Runtime Bridge V1 协议常量（与 visualbridge-runtime-bridge.schema.json 一致）。
export const RUNTIME_BRIDGE_PROTOCOL_VERSION = 1;
export const RUNTIME_BRIDGE_CORE_VERSION = 1;
export const RUNTIME_BRIDGE_DISCOVERY_FORMAT_VERSION = 1;
export const RUNTIME_BRIDGE_DISCOVERY_DIRECTORY = "visualbridge-runtime";

// 全能力 hello：MCP 客户端声明支持全部能力，具体可用性由实例 welcome 返回。
const CLIENT_CAPABILITIES = ["snapshot", "events", "lease", "sources"] as const;
const ERROR_CODES = new Set([
  "runtime.capabilityMissing",
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

export type RuntimeBridgeCapability = (typeof CLIENT_CAPABILITIES)[number];
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

/** 单连接 Runtime Bridge 客户端：hello 握手后按 requestId 配对请求/响应。 */
export class RuntimeBridgeConnection {
  private socket: net.Socket | undefined;
  private lineBuffer = "";
  private lineWaiters: ((line: string) => void)[] = [];
  private welcomed = false;

  public constructor(private readonly instance: RuntimeBridgeInstanceRecord) {}

  public connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: this.instance.tcpPort });
      this.socket = socket;
      let settled = false;
      const finish = (error: Error | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (error === undefined) {
          this.welcomed = true;
          resolve();
        } else {
          socket.destroy();
          reject(error);
        }
      };
      const onError = (error: Error): void => {
        finish(new RuntimeBridgeClientError("runtime.internalError", `Runtime bridge connection failed: ${error.message}`));
      };
      const onClose = (): void => {
        finish(new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge connection closed before welcome."));
      };
      const timer = setTimeout(() => {
        finish(new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge connect timed out."));
      }, timeoutMs);
      socket.on("error", onError);
      socket.on("close", onClose);
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
      socket.on("data", (chunk: Buffer) => {
        this.lineBuffer += chunk.toString("utf8");
        let newlineIndex = this.lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = this.lineBuffer.slice(0, newlineIndex);
          this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
          this.handleLine(line, settled ? undefined : finish);
          newlineIndex = this.lineBuffer.indexOf("\n");
        }
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
    this.socket?.destroy();
    this.socket = undefined;
    for (const waiter of this.lineWaiters.splice(0)) {
      waiter("");
    }
  }

  private async expectLeaseResponse(response: ResponseMessage, fallback: string): Promise<void> {
    if (response.status !== "ok") {
      throw new RuntimeBridgeClientError(response.error, response.detail ?? fallback);
    }
  }

  private async request(action: RequestAction, documentTypeIds?: readonly string[]): Promise<ResponseMessage> {
    if (!this.welcomed || this.socket === undefined) {
      throw new RuntimeBridgeClientError("runtime.invalidMessage", "Runtime bridge is not connected.");
    }
    const requestId = `req-${randomUUID().slice(0, 8)}`;
    const payload = {
      type: "request",
      requestId,
      action,
      ...(action === "getSnapshot" && documentTypeIds !== undefined ? { documentTypeIds: [...documentTypeIds] } : {}),
    };

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // 先注册行等待器再写请求，避免响应在等待器就位前到达被丢弃。
      const linePromise = this.waitForLine(deadline);
      this.socket.write(serializeMessage(payload));
      const line = await linePromise;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (errorValue) {
        throw new RuntimeBridgeClientError("runtime.invalidJson", `Runtime bridge sent an unparseable line: ${formatError(errorValue)}`);
      }

      const message = parseMessage(value);
      if (message.type === "response") {
        if (message.requestId !== requestId) continue;
        return parseResponse(message.raw);
      }
      if (message.type === "error") {
        throw new RuntimeBridgeClientError(message.code, message.detail ?? "Runtime bridge reported a connection-level error.");
      }
      // event 等非配对消息忽略，继续等待。
    }

    throw new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge request timed out.");
  }

  private handleLine(line: string, finishWelcome?: (error: Error | undefined) => void): void {
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (errorValue) {
      finishWelcome?.(new RuntimeBridgeClientError("runtime.invalidJson", `Runtime bridge sent an unparseable line: ${formatError(errorValue)}`));
      return;
    }

    if (this.welcomed) {
      const waiter = this.lineWaiters.shift();
      if (waiter !== undefined) waiter(line);
      return;
    }

    // 握手阶段：首条必须是 welcome（或连接级 error）。
    try {
      const message = parseMessage(value);
      if (message.type === "welcome") {
        if (message.instanceId !== this.instance.instanceId) {
          throw new RuntimeBridgeClientError(
            "runtime.invalidMessage",
            `Runtime instance identity mismatch: expected '${this.instance.instanceId}', received '${message.instanceId}'.`,
          );
        }
        finishWelcome?.(undefined);
        return;
      }
      if (message.type === "error") {
        throw new RuntimeBridgeClientError(message.code, message.detail ?? "Runtime bridge rejected the hello handshake.");
      }
      throw new RuntimeBridgeClientError("runtime.invalidMessage", `Expected a welcome message, received '${message.type}'.`);
    } catch (errorValue) {
      finishWelcome?.(errorValue instanceof Error ? errorValue : new Error(String(errorValue)));
    }
  }

  private waitForLine(deadline: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.lineWaiters.indexOf(waiter);
        if (index >= 0) this.lineWaiters.splice(index, 1);
        reject(new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge response timed out."));
      }, Math.max(1, deadline - Date.now()));
      const waiter = (line: string): void => {
        clearTimeout(timer);
        if (line.length === 0) reject(new RuntimeBridgeClientError("runtime.internalError", "Runtime bridge connection closed."));
        else resolve(line);
      };
      this.lineWaiters.push(waiter);
    });
  }
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
    if (typeof entry !== "string" || !(CLIENT_CAPABILITIES as readonly string[]).includes(entry)) {
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
