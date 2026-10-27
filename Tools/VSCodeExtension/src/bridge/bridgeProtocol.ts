/**
 * 统一连接协议（附录 A.3）的握手、编辑器通道消息与发现记录 v2（附录 A.7）。
 *
 * 连接层版本只有 `BRIDGE_PROTOCOL_VERSION = 4` 一个来源：Editor 腿与 Runtime 腿
 * 都从这里取值。Runtime 腿的历史消息在 E3/E5 收敛前仍复用本模块的握手解析。
 */

/** 唯一连接层版本（附录 A.1/A.3）。 */
export const BRIDGE_PROTOCOL_VERSION = 4;

/** 发现记录格式版本（附录 A.7）；旧格式视为无记录，不做迁移。 */
export const BRIDGE_DISCOVERY_FORMAT_VERSION = 2;

/** D2 产出的 debug-contracts.json 的 manifest.schemaVersion；不一致的目录契约不加载。 */
export const BRIDGE_CONTRACT_SCHEMA_VERSION = 2;

/** 发现记录目录名（os.tmpdir()/visualbridge-bridge）。 */
export const BRIDGE_DISCOVERY_DIRECTORY_NAME = "visualbridge-bridge";

/** 陈旧判定：心跳 mtime 龄上限（附录 A.7）。 */
export const BRIDGE_HEARTBEAT_TIMEOUT_MS = 5000;

export type BridgeRole = "editor" | "vscode";
export type BridgePayload = "json" | "binary";
export type BridgeConnectType = "editor" | "editor-player" | "player";

export const BRIDGE_ROLES: readonly BridgeRole[] = ["editor", "vscode"];
export const BRIDGE_CONNECT_TYPES: readonly BridgeConnectType[] = ["editor", "editor-player", "player"];
export const BRIDGE_PAYLOAD_KINDS: readonly BridgePayload[] = ["json", "binary"];

/** 编辑器通道的请求级错误码（open/reveal 应答沿用）。 */
export const BRIDGE_ERROR_CODES = [
  "bridge.capabilityMissing",
  "bridge.documentAmbiguous",
  "bridge.documentUnresolved",
  "bridge.internalError",
  "bridge.invalidJson",
  "bridge.invalidMessage",
  "bridge.invalidToken",
  "bridge.protocolVersionMismatch",
  "bridge.unknownMessageType",
] as const;

/** 握手拒绝层级的安全错误码（附录 A.6）。 */
export const BRIDGE_HANDSHAKE_ERROR_CODES = [
  "runtime.alreadyConnected",
  "runtime.contractHashMismatch",
  "runtime.invalidToken",
  "runtime.roleMismatch",
  "runtime.unsupportedPayload",
  "runtime.unsupportedProtocolVersion",
] as const;

export type BridgeErrorCode = typeof BRIDGE_ERROR_CODES[number] | typeof BRIDGE_HANDSHAKE_ERROR_CODES[number];
export type BridgeHandshakeErrorCode = typeof BRIDGE_HANDSHAKE_ERROR_CODES[number];

export class BridgeProtocolError extends Error {
  public constructor(
    public readonly code: string,
    public readonly jsonPath: string,
    message: string,
  ) {
    super(`${code} at ${jsonPath}: ${message}`);
    this.name = "BridgeProtocolError";
  }
}

export interface BridgeHelloMessage {
  readonly type: "hello";
  readonly protocolVersion: number;
  readonly role: BridgeRole;
  readonly clientEndpointId: string;
  readonly token?: string;
  readonly contractHash: string;
  readonly payloads: readonly BridgePayload[];
  readonly debugCategories?: readonly string[];
  readonly debugInstances?: readonly string[];
  readonly resumeSessionId?: string;
}

export interface BridgeWelcomeMessage {
  readonly type: "welcome";
  readonly protocolVersion: number;
  readonly endpointId: string;
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly connectType: BridgeConnectType;
  readonly generation: number;
  readonly bootId: string;
  readonly contractHash: string;
  readonly payloads: readonly BridgePayload[];
  readonly debugEnabled: boolean;
  readonly startedAt: string;
}

export interface BridgeOpenRequest {
  readonly type: "open";
  readonly requestId: string;
  readonly documentPath: string;
}

export interface BridgeRevealRequest {
  readonly type: "reveal";
  readonly requestId: string;
  readonly reference: string | number;
}

export type BridgeResponseMessage =
  | { readonly type: "response"; readonly requestId: string; readonly status: "ok" }
  | { readonly type: "response"; readonly requestId: string; readonly status: "error"; readonly error: BridgeErrorCode };

export interface BridgeErrorMessage {
  readonly type: "error";
  readonly code: BridgeErrorCode;
  readonly detail?: string;
}

export type BridgeMessage =
  | BridgeHelloMessage
  | BridgeWelcomeMessage
  | BridgeOpenRequest
  | BridgeRevealRequest
  | BridgeResponseMessage
  | BridgeErrorMessage;

/** 发现记录 v2：写盘方（监听方）发布自己的端点信息；心跳是文件 mtime。 */
export interface BridgeDiscoveryRecord {
  readonly formatVersion: number;
  readonly protocolVersion: number;
  readonly role: BridgeRole;
  readonly tcpPort: number;
  readonly token: string;
  readonly pid: number;
  readonly generation: number;
  readonly windowId: string;
  readonly projectRoots: readonly string[];
}

export interface BridgeListenerPolicy {
  /** 监听方自身身份；拨号方 hello.role 必须与其互补（方向层）。 */
  readonly role: BridgeRole;
  /** 编辑器模式下监听方持有的 token；缺省表示该方向不做认证（Player）。 */
  readonly token?: string;
  /** 是否已存在完成握手的连接（一对一约束）。 */
  readonly hasActiveConnection: boolean;
  /** 监听方是否支持二进制载荷（指纹不一致时为 false）。 */
  readonly supportsBinary: boolean;
}

export type BridgeHandshakeRejection = {
  readonly code: BridgeHandshakeErrorCode | "bridge.invalidMessage";
  readonly detail: string;
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}#[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTRACT_HASH_PATTERN = /^(?:[0-9a-f]{16})?$/;
const TOKEN_PATTERN = /^[0-9a-f]{48,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:)?\/(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*\/$)(?:[^/]+\/)*[^/]+$/;
const STARTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ERROR_CODE_SET = new Set<string>([...BRIDGE_ERROR_CODES, ...BRIDGE_HANDSHAKE_ERROR_CODES]);
const ROLE_SET = new Set<string>(BRIDGE_ROLES);
const CONNECT_TYPE_SET = new Set<string>(BRIDGE_CONNECT_TYPES);
const PAYLOAD_SET = new Set<string>(BRIDGE_PAYLOAD_KINDS);

export function isBridgeErrorCode(value: string): value is BridgeErrorCode {
  return ERROR_CODE_SET.has(value);
}

export function isBridgeProtocolError(errorValue: unknown): errorValue is BridgeProtocolError {
  return errorValue instanceof BridgeProtocolError;
}

export function parseBridgeMessage(value: unknown): BridgeMessage {
  const record = requireObject(value);
  if (typeof record.type !== "string") {
    throw protocolError("bridge.missingProperty", "$.type", "Expected a message 'type' string.");
  }

  switch (record.type) {
    case "hello": return parseHello(record);
    case "welcome": return parseWelcome(record);
    case "open": return parseOpen(record);
    case "reveal": return parseReveal(record);
    case "response": return parseResponse(record);
    case "error": return parseError(record);
    default:
      throw protocolError("bridge.unknownMessageType", "$.type", `Unknown message type '${String(record.type)}'.`);
  }
}

/** 解析 hello（含连接层版本优先检查；方向层由 evaluateHello 判定）。 */
export function parseBridgeHello(value: unknown): BridgeHelloMessage {
  return parseHello(requireObject(value));
}

/** 解析 welcome（客户端对连接层版本不一致同样立即失败）。 */
export function parseBridgeWelcome(value: unknown): BridgeWelcomeMessage {
  return parseWelcome(requireObject(value));
}

/**
 * 按附录 A.3 的拒绝层级判定 hello：方向层 → 连接层 → 认证/一对一 → 载荷协商。
 * 返回 undefined 表示可以进入 welcome。
 */
export function evaluateHello(hello: BridgeHelloMessage, policy: BridgeListenerPolicy): BridgeHandshakeRejection | undefined {
  const expectedRole: BridgeRole = policy.role === "editor" ? "vscode" : "editor";
  if (hello.role !== expectedRole) {
    return {
      code: "runtime.roleMismatch",
      detail: `Listener role '${policy.role}' expects a '${expectedRole}' dialer, received '${hello.role}'.`,
    };
  }

  if (hello.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return {
      code: "runtime.unsupportedProtocolVersion",
      detail: `Listener speaks protocolVersion ${BRIDGE_PROTOCOL_VERSION}, received ${hello.protocolVersion}.`,
    };
  }

  if (policy.token !== undefined && hello.token !== policy.token) {
    return { code: "runtime.invalidToken", detail: "Authentication token rejected." };
  }

  if (policy.hasActiveConnection) {
    return { code: "runtime.alreadyConnected", detail: "Another client already owns this endpoint." };
  }

  if (negotiatePayloads(hello.payloads, policy.supportsBinary) === undefined) {
    return {
      code: "runtime.unsupportedPayload",
      detail: `No supported payload kind in [${hello.payloads.join(", ")}]; 'json' is mandatory.`,
    };
  }

  return undefined;
}

/**
 * 客户端对 welcome 的校验：版本、载荷与 sessionId 结构。
 * 指纹层不拒绝连接（降级为 JSON），因此这里不做 contractHash 相等判定。
 */
export function evaluateWelcome(welcome: BridgeWelcomeMessage): BridgeHandshakeRejection | undefined {
  if (welcome.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return {
      code: "runtime.unsupportedProtocolVersion",
      detail: `Server speaks protocolVersion ${welcome.protocolVersion}, expected ${BRIDGE_PROTOCOL_VERSION}.`,
    };
  }

  if (!welcome.payloads.includes("json")) {
    return { code: "runtime.unsupportedPayload", detail: "Server welcome must retain the 'json' payload kind." };
  }

  if (welcome.sessionId !== `${welcome.endpointId}#${welcome.bootId}`) {
    return {
      code: "bridge.invalidMessage",
      detail: `sessionId '${welcome.sessionId}' must equal endpointId#bootId.`,
    };
  }

  return undefined;
}

/**
 * 载荷协商：返回客户端声明与监听方支持的交集（保持 ["json","binary"] 的规范顺序）；
 * 交集为空或缺少 json 时返回 undefined。
 */
export function negotiatePayloads(
  clientPayloads: readonly BridgePayload[],
  supportsBinary: boolean,
): BridgePayload[] | undefined {
  const client = new Set(clientPayloads);
  if (!client.has("json")) {
    return undefined;
  }

  return supportsBinary && client.has("binary") ? ["json", "binary"] : ["json"];
}

/** 指纹层：两侧指纹不同时连接保留，但数据面去掉 binary（附录 A.3）。 */
export function shouldDegradeToJson(clientContractHash: string, serverContractHash: string): boolean {
  return clientContractHash !== serverContractHash;
}

/**
 * 契约层：debug-contracts.json 的 manifest.schemaVersion 不等于当前格式时，
 * 该目录的契约整体不加载（不参与指纹与二进制编码）。
 */
export function isSupportedContractManifest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const manifest = (value as Record<string, unknown>).manifest;
  return typeof manifest === "object"
    && manifest !== null
    && !Array.isArray(manifest)
    && (manifest as Record<string, unknown>).schemaVersion === BRIDGE_CONTRACT_SCHEMA_VERSION;
}

export function parseDiscoveryRecord(value: unknown): BridgeDiscoveryRecord {
  const record = requireObject(value);
  requireOnlyKeys(record, "$", [
    "formatVersion", "protocolVersion", "role", "tcpPort", "token", "pid", "generation", "windowId", "projectRoots",
  ]);
  const formatVersion = requireInteger(record, "formatVersion", "$.formatVersion");
  if (formatVersion !== BRIDGE_DISCOVERY_FORMAT_VERSION) {
    throw protocolError(
      "bridge.unsupportedFormatVersion",
      "$.formatVersion",
      `Expected formatVersion ${BRIDGE_DISCOVERY_FORMAT_VERSION}.`,
    );
  }

  const protocolVersion = requireInteger(record, "protocolVersion", "$.protocolVersion");
  if (protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw protocolError(
      "bridge.unsupportedProtocolVersion",
      "$.protocolVersion",
      `Expected protocolVersion ${BRIDGE_PROTOCOL_VERSION}.`,
    );
  }

  const role = requireRole(record, "$.role");
  const tcpPort = requireInteger(record, "tcpPort", "$.tcpPort");
  if (tcpPort < 1 || tcpPort > 65535) {
    throw protocolError("bridge.invalidMessage", "$.tcpPort", "Expected a TCP port between 1 and 65535.");
  }

  const token = requireString(record, "token", "$.token");
  if (!TOKEN_PATTERN.test(token)) {
    throw protocolError("bridge.invalidToken", "$.token", "Expected a hex authentication token.");
  }

  const pid = requireInteger(record, "pid", "$.pid");
  if (pid < 1) {
    throw protocolError("bridge.invalidMessage", "$.pid", "Expected a positive process id.");
  }

  const generation = requireInteger(record, "generation", "$.generation");
  if (generation < 1) {
    throw protocolError("bridge.invalidMessage", "$.generation", "Expected a positive listener generation.");
  }

  const windowId = requireString(record, "windowId", "$.windowId");
  if (!UUID_PATTERN.test(windowId)) {
    throw protocolError("bridge.invalidMessage", "$.windowId", "Expected a UUID window identifier.");
  }

  const projectRoots = requireProjectRoots(record, "$.projectRoots");
  return { formatVersion, protocolVersion, role, tcpPort, token, pid, generation, windowId, projectRoots };
}

function parseHello(record: Record<string, unknown>): BridgeHelloMessage {
  // 连接层优先：旧版本的 hello 可能连字段集合都不同，先按版本拒绝，
  // 避免把"版本不符"误报成缺字段/未知字段（附录 A.3 的拒绝层级）。
  precheckProtocolVersion(record);
  requireOnlyKeys(
    record,
    "$",
    ["type", "protocolVersion", "role", "clientEndpointId", "contractHash", "payloads"],
    ["token", "debugCategories", "debugInstances", "resumeSessionId"],
  );
  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const role = requireRole(record, "$.role");
  const clientEndpointId = requireEndpointId(record, "clientEndpointId", "$.clientEndpointId");
  const token = record.token === undefined ? undefined : requireToken(record);
  const contractHash = requireContractHash(record);
  const payloads = requirePayloads(record, "$.payloads");
  const debugCategories = record.debugCategories === undefined
    ? undefined
    : requireDebugFilter(record, "debugCategories", "$.debugCategories");
  const debugInstances = record.debugInstances === undefined
    ? undefined
    : requireDebugFilter(record, "debugInstances", "$.debugInstances");
  const resumeSessionId = record.resumeSessionId === undefined
    ? undefined
    : requireSessionId(record, "resumeSessionId", "$.resumeSessionId");

  return {
    type: "hello",
    protocolVersion,
    role,
    clientEndpointId,
    ...(token === undefined ? {} : { token }),
    contractHash,
    payloads,
    ...(debugCategories === undefined ? {} : { debugCategories }),
    ...(debugInstances === undefined ? {} : { debugInstances }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  };
}

function parseWelcome(record: Record<string, unknown>): BridgeWelcomeMessage {
  precheckProtocolVersion(record);
  requireOnlyKeys(record, "$", [
    "type", "protocolVersion", "endpointId", "sessionId", "resumed", "connectType", "generation",
    "bootId", "contractHash", "payloads", "debugEnabled", "startedAt",
  ]);
  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const endpointId = requireEndpointId(record, "endpointId", "$.endpointId");
  const bootId = requireEndpointId(record, "bootId", "$.bootId");
  const sessionId = requireSessionId(record, "sessionId", "$.sessionId");
  if (sessionId !== `${endpointId}#${bootId}`) {
    throw protocolError("bridge.invalidMessage", "$.sessionId", "sessionId must equal endpointId#bootId.");
  }

  const resumed = requireBoolean(record, "resumed", "$.resumed");
  const connectType = requireConnectType(record, "$.connectType");
  const generation = requireInteger(record, "generation", "$.generation");
  if (generation < 1) {
    throw protocolError("bridge.invalidMessage", "$.generation", "Expected a positive listener generation.");
  }

  const contractHash = requireContractHash(record);
  const payloads = requirePayloads(record, "$.payloads");
  const debugEnabled = requireBoolean(record, "debugEnabled", "$.debugEnabled");
  const startedAt = requireString(record, "startedAt", "$.startedAt");
  if (!STARTED_AT_PATTERN.test(startedAt)) {
    throw protocolError("bridge.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
  }

  return {
    type: "welcome",
    protocolVersion,
    endpointId,
    sessionId,
    resumed,
    connectType,
    generation,
    bootId,
    contractHash,
    payloads,
    debugEnabled,
    startedAt,
  };
}

function parseOpen(record: Record<string, unknown>): BridgeOpenRequest {
  requireOnlyKeys(record, "$", ["type", "requestId", "documentPath"]);
  const requestId = requireRequestId(record);
  const documentPath = requireString(record, "documentPath", "$.documentPath");
  if (documentPath.length === 0
    || documentPath.length > 1024
    || documentPath.startsWith("/")
    || documentPath.includes(":")
    || documentPath.includes("\\")
    || documentPath.includes("//")
    || documentPath.endsWith("/")
    || documentPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw protocolError("bridge.invalidMessage", "$.documentPath", "Expected a normalized project-relative forward-slash path.");
  }

  return { type: "open", requestId, documentPath };
}

function parseReveal(record: Record<string, unknown>): BridgeRevealRequest {
  requireOnlyKeys(record, "$", ["type", "requestId", "reference"]);
  const requestId = requireRequestId(record);
  const reference = record.reference;
  if (typeof reference === "string") {
    if (reference.length === 0 || reference.length > 1024) {
      throw protocolError("bridge.invalidMessage", "$.reference", "Expected a non-empty reference value.");
    }

    return { type: "reveal", requestId, reference };
  }

  if (typeof reference === "number" && Number.isSafeInteger(reference)) {
    return { type: "reveal", requestId, reference };
  }

  throw protocolError("bridge.invalidMessage", "$.reference", "Expected a string or number reference value.");
}

function parseResponse(record: Record<string, unknown>): BridgeResponseMessage {
  requireOnlyKeys(record, "$", ["type", "requestId", "status"], ["error"]);
  const requestId = requireRequestId(record);
  const status = record.status;
  if (status === "ok") {
    // 附录 A.5：ok 分支不携带 error（schema 的 ok 分支 additionalProperties:false），
    // 出现即按未知属性拒绝，与 C# 校验器同判据——不得静默忽略。
    if (Object.prototype.hasOwnProperty.call(record, "error")) {
      throw protocolError("bridge.unknownProperty", "$.error", "Unknown property 'error'.");
    }

    return { type: "response", requestId, status: "ok" };
  }

  if (status === "error") {
    const error = record.error;
    if (typeof error !== "string" || !isBridgeErrorCode(error)) {
      throw protocolError("bridge.invalidMessage", "$.error", "Expected a registered bridge error code.");
    }

    return { type: "response", requestId, status: "error", error };
  }

  throw protocolError("bridge.invalidMessage", "$.status", "Expected status 'ok' or 'error'.");
}

function parseError(record: Record<string, unknown>): BridgeErrorMessage {
  requireOnlyKeys(record, "$", ["type", "code"], ["detail"]);
  const code = record.code;
  if (typeof code !== "string" || !isBridgeErrorCode(code)) {
    throw protocolError("bridge.invalidMessage", "$.code", "Expected a registered bridge error code.");
  }

  const detail = record.detail;
  if (detail !== undefined && (typeof detail !== "string" || detail.length === 0 || detail.length > 512)) {
    throw protocolError("bridge.invalidMessage", "$.detail", "Expected a non-empty detail string of at most 512 characters.");
  }

  return detail === undefined ? { type: "error", code } : { type: "error", code, detail };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("bridge.invalidMessage", "$", "Expected an object.");
  }

  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  record: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw protocolError("bridge.unknownProperty", `${path}.${key}`, `Unknown property '${key}'.`);
    }
  }

  for (const key of required) {
    if (!(key in record)) {
      throw protocolError("bridge.missingProperty", `${path}.${key}`, `Missing property '${key}'.`);
    }
  }
}

/** 版本字段存在且为整数时先做连接层判定；缺字段/类型错留给形状校验报错。 */
function precheckProtocolVersion(record: Record<string, unknown>): void {
  const value = record.protocolVersion;
  if (typeof value === "number" && Number.isSafeInteger(value) && value !== BRIDGE_PROTOCOL_VERSION) {
    throw protocolError(
      "runtime.unsupportedProtocolVersion",
      "$.protocolVersion",
      `Expected protocolVersion ${BRIDGE_PROTOCOL_VERSION}.`,
    );
  }
}

function requireProtocolVersion(record: Record<string, unknown>, path: string): number {
  const protocolVersion = requireInteger(record, "protocolVersion", path);
  if (protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw protocolError(
      "runtime.unsupportedProtocolVersion",
      path,
      `Expected protocolVersion ${BRIDGE_PROTOCOL_VERSION}.`,
    );
  }

  return protocolVersion;
}

function requireRole(record: Record<string, unknown>, path: string): BridgeRole {
  const value = record[path.slice(2)];
  if (typeof value !== "string" || !ROLE_SET.has(value)) {
    throw protocolError("bridge.invalidMessage", path, "Expected role 'editor' or 'vscode'.");
  }

  return value as BridgeRole;
}

function requireConnectType(record: Record<string, unknown>, path: string): BridgeConnectType {
  const value = record[path.slice(2)];
  if (typeof value !== "string" || !CONNECT_TYPE_SET.has(value)) {
    throw protocolError("bridge.invalidMessage", path, "Expected connectType 'editor', 'editor-player', or 'player'.");
  }

  return value as BridgeConnectType;
}

function requireEndpointId(record: Record<string, unknown>, property: string, path: string): string {
  const value = requireString(record, property, path);
  if (!ENDPOINT_ID_PATTERN.test(value)) {
    throw protocolError("bridge.invalidMessage", path, "Expected a stable endpoint identifier.");
  }

  return value;
}

function requireSessionId(record: Record<string, unknown>, property: string, path: string): string {
  const value = requireString(record, property, path);
  if (!SESSION_ID_PATTERN.test(value)) {
    throw protocolError("bridge.invalidMessage", path, "Expected an 'endpointId#bootId' session identifier.");
  }

  return value;
}

function requireContractHash(record: Record<string, unknown>): string {
  const value = requireString(record, "contractHash", "$.contractHash");
  if (!CONTRACT_HASH_PATTERN.test(value)) {
    throw protocolError("bridge.invalidMessage", "$.contractHash", "Expected 16 lowercase hex characters or an empty string.");
  }

  return value;
}

function requireToken(record: Record<string, unknown>): string {
  const value = requireString(record, "token", "$.token");
  if (!TOKEN_PATTERN.test(value)) {
    throw protocolError("bridge.invalidToken", "$.token", "Expected a hex authentication token.");
  }

  return value;
}

function requirePayloads(record: Record<string, unknown>, path: string): readonly BridgePayload[] {
  const value = record[path.slice(2)];
  if (!Array.isArray(value)) {
    throw protocolError("bridge.invalidMessage", path, "Expected a payload array.");
  }

  // 空交集与缺 json 同属载荷协商失败（附录 A.3），不是形状错误。
  if (value.length === 0) {
    throw protocolError("runtime.unsupportedPayload", path, "No supported payload kind; 'json' is mandatory.");
  }

  const payloads: BridgePayload[] = [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !PAYLOAD_SET.has(entry)) {
      throw protocolError("bridge.invalidMessage", path, "Expected payload kinds 'json' and/or 'binary'.");
    }

    if (unique.has(entry)) {
      throw protocolError("bridge.invalidMessage", path, "Duplicate payload kind.");
    }

    unique.add(entry);
    payloads.push(entry as BridgePayload);
  }

  if (!unique.has("json")) {
    throw protocolError("runtime.unsupportedPayload", path, "The 'json' payload kind is mandatory.");
  }

  return payloads;
}

function requireDebugFilter(record: Record<string, unknown>, property: string, path: string): readonly string[] {
  const value = record[property];
  if (!Array.isArray(value)) {
    throw protocolError("bridge.invalidMessage", path, "Expected an array of filter names.");
  }

  const filters: string[] = [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
      throw protocolError("bridge.invalidMessage", path, "Expected non-empty filter names of at most 256 characters.");
    }

    if (unique.has(entry)) {
      throw protocolError("bridge.invalidMessage", path, "Duplicate filter name.");
    }

    unique.add(entry);
    filters.push(entry);
  }

  return filters;
}

function requireProjectRoots(record: Record<string, unknown>, path: string): readonly string[] {
  const value = record.projectRoots;
  if (!Array.isArray(value) || value.length === 0) {
    throw protocolError("bridge.invalidMessage", path, "Expected a non-empty projectRoots array.");
  }

  const roots: string[] = [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !ABSOLUTE_PATH_PATTERN.test(entry)) {
      throw protocolError("bridge.invalidMessage", path, "Expected a normalized absolute forward-slash path.");
    }

    if (unique.has(entry)) {
      throw protocolError("bridge.invalidMessage", path, "Duplicate project root.");
    }

    unique.add(entry);
    roots.push(entry);
  }

  return roots;
}

function requireRequestId(record: Record<string, unknown>): string {
  const requestId = requireString(record, "requestId", "$.requestId");
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw protocolError("bridge.invalidMessage", "$.requestId", "Expected a request identifier.");
  }

  return requestId;
}

function requireInteger(record: Record<string, unknown>, property: string, path: string): number {
  const value = record[property];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw protocolError("bridge.invalidMessage", path, "Expected an integer.");
  }

  return value;
}

function requireBoolean(record: Record<string, unknown>, property: string, path: string): boolean {
  const value = record[property];
  if (typeof value !== "boolean") {
    throw protocolError("bridge.invalidMessage", path, "Expected a boolean.");
  }

  return value;
}

function requireString(record: Record<string, unknown>, property: string, path: string): string {
  const value = record[property];
  if (typeof value !== "string") {
    throw protocolError("bridge.invalidMessage", path, "Expected a string.");
  }

  return value;
}

function protocolError(code: string, jsonPath: string, message: string): BridgeProtocolError {
  return new BridgeProtocolError(code, jsonPath, message);
}
