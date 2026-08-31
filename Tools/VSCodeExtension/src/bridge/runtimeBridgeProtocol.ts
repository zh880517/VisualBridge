export const RUNTIME_BRIDGE_PROTOCOL_VERSION = 1;
export const RUNTIME_BRIDGE_CORE_VERSION = 1;
export const RUNTIME_BRIDGE_DISCOVERY_FORMAT_VERSION = 1;
export const RUNTIME_BRIDGE_DISCOVERY_DIRECTORY = "visualbridge-runtime";

export type RuntimeBridgeCapability = "snapshot" | "events";

export const RUNTIME_BRIDGE_CAPABILITIES: readonly RuntimeBridgeCapability[] = ["snapshot", "events"];

export const RUNTIME_BRIDGE_ERROR_CODES = [
  "runtime.capabilityMissing",
  "runtime.internalError",
  "runtime.invalidJson",
  "runtime.invalidMessage",
  "runtime.invalidToken",
  "runtime.protocolVersionMismatch",
  "runtime.unknownMessageType",
  "runtime.unknownRequest",
] as const;

export type RuntimeBridgeErrorCode = typeof RUNTIME_BRIDGE_ERROR_CODES[number];

export class RuntimeBridgeProtocolError extends Error {
  public constructor(
    public readonly code: string,
    public readonly jsonPath: string,
    message: string,
  ) {
    super(`${code} at ${jsonPath}: ${message}`);
  }
}

export interface RuntimeBridgeHelloMessage {
  readonly type: "hello";
  readonly protocolVersion: number;
  readonly coreVersion: number;
  readonly token: string;
  readonly clientInstanceId: string;
  readonly capabilities: readonly RuntimeBridgeCapability[];
}

export type RuntimeBridgeInstanceKind = "editor-play" | "player";

export interface RuntimeBridgeWelcomeMessage {
  readonly type: "welcome";
  readonly protocolVersion: number;
  readonly coreVersion: number;
  readonly instanceId: string;
  readonly kind: RuntimeBridgeInstanceKind;
  readonly generation: number;
  readonly capabilities: readonly RuntimeBridgeCapability[];
  readonly startedAt: string;
}

export interface RuntimeBridgeSnapshotRequest {
  readonly type: "request";
  readonly requestId: string;
  readonly action: "getSnapshot";
  readonly documentTypeIds?: readonly string[];
}

export interface RuntimeBridgeDocumentSnapshot {
  readonly documentTypeId: string;
  readonly documentId: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

export type RuntimeBridgeResponseMessage =
  | { readonly type: "response"; readonly requestId: string; readonly status: "ok"; readonly documents: readonly RuntimeBridgeDocumentSnapshot[] }
  | { readonly type: "response"; readonly requestId: string; readonly status: "error"; readonly error: RuntimeBridgeErrorCode; readonly detail?: string };

export interface RuntimeBridgeEventMessage {
  readonly type: "event";
  readonly event: "artifactsChanged";
  readonly documents: readonly RuntimeBridgeDocumentSnapshot[];
}

export interface RuntimeBridgeErrorMessage {
  readonly type: "error";
  readonly code: RuntimeBridgeErrorCode;
  readonly detail?: string;
}

export type RuntimeBridgeMessage =
  | RuntimeBridgeHelloMessage
  | RuntimeBridgeWelcomeMessage
  | RuntimeBridgeSnapshotRequest
  | RuntimeBridgeResponseMessage
  | RuntimeBridgeEventMessage
  | RuntimeBridgeErrorMessage;

export interface RuntimeBridgeDiscoveryRecord {
  readonly formatVersion: number;
  readonly protocolVersion: number;
  readonly coreVersion: number;
  readonly instanceId: string;
  readonly kind: RuntimeBridgeInstanceKind;
  readonly capabilities: readonly RuntimeBridgeCapability[];
  readonly tcpPort: number;
  readonly token: string;
  readonly pid: number;
  readonly generation: number;
  readonly startedAt: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f]{48,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANCE_ID_PATTERN = /^(editor|player)-[0-9]+$/;
const STARTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DOCUMENT_KIND_PATTERN = /^visualbridge\.(structured|entity|table|graph)\.compiled$/;
const ERROR_CODE_SET = new Set<string>(RUNTIME_BRIDGE_ERROR_CODES);
const CAPABILITY_SET = new Set<string>(RUNTIME_BRIDGE_CAPABILITIES);

export function isRuntimeBridgeErrorCode(value: string): value is RuntimeBridgeErrorCode {
  return ERROR_CODE_SET.has(value);
}

export function parseRuntimeBridgeMessage(value: unknown): RuntimeBridgeMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Expected a message object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") {
    throw new RuntimeBridgeProtocolError("runtime.missingProperty", "$.type", "Expected a message 'type' string.");
  }

  switch (record.type) {
    case "hello": return parseHello(record);
    case "welcome": return parseWelcome(record);
    case "request": return parseRequest(record);
    case "response": return parseResponse(record);
    case "event": return parseEvent(record);
    case "error": return parseError(record);
    default:
      throw new RuntimeBridgeProtocolError("runtime.unknownMessageType", "$.type", `Unknown message type '${String(record.type)}'.`);
  }
}

export function parseRuntimeBridgeDiscoveryRecord(value: unknown): RuntimeBridgeDiscoveryRecord {
  const record = requireObject(value);
  requireOnlyKeys(record, "$", [
    "formatVersion", "protocolVersion", "coreVersion", "instanceId", "kind",
    "capabilities", "tcpPort", "token", "pid", "generation", "startedAt",
  ]);
  const formatVersion = requireStrictInteger(record, "formatVersion", "$.formatVersion");
  if (formatVersion !== RUNTIME_BRIDGE_DISCOVERY_FORMAT_VERSION) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.formatVersion", `Expected formatVersion ${RUNTIME_BRIDGE_DISCOVERY_FORMAT_VERSION}.`);
  }

  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const coreVersion = requireCoreVersion(record, "$.coreVersion");
  const instanceId = requireStrictString(record, "instanceId", "$.instanceId");
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.instanceId", "Expected an 'editor-<pid>' or 'player-<pid>' instance identifier.");
  }

  const kind = requireStrictString(record, "kind", "$.kind");
  if (kind !== "editor-play" && kind !== "player") {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.kind", "Expected an instance kind.");
  }

  if ((instanceId.startsWith("editor-") && kind !== "editor-play")
    || (instanceId.startsWith("player-") && kind !== "player")) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.kind", "Instance id prefix must match the kind.");
  }

  const capabilities = requireCapabilities(record, "$.capabilities");
  const tcpPort = requireStrictInteger(record, "tcpPort", "$.tcpPort");
  if (tcpPort < 1 || tcpPort > 65535) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.tcpPort", "Expected a TCP port between 1 and 65535.");
  }

  const token = requireToken(record);
  const pid = requireStrictInteger(record, "pid", "$.pid");
  if (pid < 1) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.pid", "Expected a positive process id.");
  }

  const generation = requireStrictInteger(record, "generation", "$.generation");
  if (generation < 1) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.generation", "Expected a positive generation.");
  }

  const startedAt = requireStrictString(record, "startedAt", "$.startedAt");
  if (!STARTED_AT_PATTERN.test(startedAt)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
  }

  return { formatVersion, protocolVersion, coreVersion, instanceId, kind, capabilities, tcpPort, token, pid, generation, startedAt };
}

export function serializeRuntimeBridgeMessage(message: RuntimeBridgeMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function isRuntimeBridgeProtocolError(errorValue: unknown): errorValue is RuntimeBridgeProtocolError {
  return errorValue instanceof RuntimeBridgeProtocolError;
}

function parseHello(record: Record<string, unknown>): RuntimeBridgeHelloMessage {
  requireOnlyKeys(record, "$", ["type", "protocolVersion", "coreVersion", "token", "clientInstanceId", "capabilities"]);
  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const coreVersion = requireCoreVersion(record, "$.coreVersion");
  const token = requireToken(record);
  const clientInstanceId = requireString(record, "clientInstanceId", "$.clientInstanceId");
  if (!UUID_PATTERN.test(clientInstanceId)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.clientInstanceId", "Expected a UUID client instance identifier.");
  }

  return { type: "hello", protocolVersion, coreVersion, token, clientInstanceId, capabilities: requireCapabilities(record, "$.capabilities") };
}

function parseWelcome(record: Record<string, unknown>): RuntimeBridgeWelcomeMessage {
  requireOnlyKeys(record, "$", ["type", "protocolVersion", "coreVersion", "instanceId", "kind", "generation", "capabilities", "startedAt"]);
  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const coreVersion = requireCoreVersion(record, "$.coreVersion");
  const instanceId = requireString(record, "instanceId", "$.instanceId");
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.instanceId", "Expected an 'editor-<pid>' or 'player-<pid>' instance identifier.");
  }

  const kind = requireString(record, "kind", "$.kind");
  if ((kind !== "editor-play" && kind !== "player")
    || (instanceId.startsWith("editor-") && kind !== "editor-play")
    || (instanceId.startsWith("player-") && kind !== "player")) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.kind", "Instance id prefix must match the kind.");
  }

  const generation = requireInteger(record, "generation", "$.generation");
  if (generation < 1) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.generation", "Expected a positive generation.");
  }

  const startedAt = requireString(record, "startedAt", "$.startedAt");
  if (!STARTED_AT_PATTERN.test(startedAt)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
  }

  return { type: "welcome", protocolVersion, coreVersion, instanceId, kind, generation, capabilities: requireCapabilities(record, "$.capabilities"), startedAt };
}

function parseRequest(record: Record<string, unknown>): RuntimeBridgeSnapshotRequest {
  requireOnlyKeys(record, "$", ["type", "requestId", "action", "documentTypeIds"]);
  const requestId = requireRequestId(record);
  const action = requireString(record, "action", "$.action");
  if (action !== "getSnapshot") {
    throw new RuntimeBridgeProtocolError("runtime.unknownRequest", "$.action", `Unknown request action '${action}'.`);
  }

  if (record.documentTypeIds === undefined) {
    return { type: "request", requestId, action };
  }

  if (!Array.isArray(record.documentTypeIds) || record.documentTypeIds.length === 0) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.documentTypeIds", "Expected a non-empty document type filter.");
  }

  const documentTypeIds: string[] = [];
  for (const entry of record.documentTypeIds) {
    if (typeof entry !== "string" || !STABLE_ID_PATTERN.test(entry)) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.documentTypeIds", "Expected document type identifiers.");
    }

    documentTypeIds.push(entry);
  }

  if (new Set(documentTypeIds).size !== documentTypeIds.length) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.documentTypeIds", "Document type filters must be unique.");
  }

  return { type: "request", requestId, action, documentTypeIds };
}

function parseResponse(record: Record<string, unknown>): RuntimeBridgeResponseMessage {
  requireOnlyKeys(record, "$", ["type", "requestId", "status", "documents", "error", "detail"]);
  const requestId = requireRequestId(record);
  const status = requireString(record, "status", "$.status");
  if (status === "ok") {
    if (record.documents === undefined || !Array.isArray(record.documents)) {
      throw new RuntimeBridgeProtocolError("runtime.missingProperty", "$.documents", "Expected a documents array.");
    }

    const documents = record.documents.map((entry) => parseDocumentSnapshot(entry));
    return { type: "response", requestId, status, documents };
  }

  if (status !== "error") {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.status", "Expected a response status.");
  }

  const error = requireString(record, "error", "$.error");
  if (!isRuntimeBridgeErrorCode(error)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.error", "Unknown runtime error code.");
  }

  if (record.detail !== undefined && typeof record.detail !== "string") {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.detail", "Expected a detail string.");
  }

  return { type: "response", requestId, status, error, ...(record.detail === undefined ? {} : { detail: record.detail as string }) };
}

function parseEvent(record: Record<string, unknown>): RuntimeBridgeEventMessage {
  requireOnlyKeys(record, "$", ["type", "event", "documents"]);
  const event = requireString(record, "event", "$.event");
  if (event !== "artifactsChanged") {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.event", `Unknown event '${event}'.`);
  }

  if (!Array.isArray(record.documents)) {
    throw new RuntimeBridgeProtocolError("runtime.missingProperty", "$.documents", "Expected a documents array.");
  }

  return { type: "event", event, documents: record.documents.map((entry) => parseDocumentSnapshot(entry)) };
}

function parseError(record: Record<string, unknown>): RuntimeBridgeErrorMessage {
  requireOnlyKeys(record, "$", ["type", "code", "detail"]);
  const code = requireString(record, "code", "$.code");
  if (!isRuntimeBridgeErrorCode(code)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.code", "Unknown runtime error code.");
  }

  if (record.detail !== undefined && typeof record.detail !== "string") {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.detail", "Expected a detail string.");
  }

  return { type: "error", code, ...(record.detail === undefined ? {} : { detail: record.detail as string }) };
}

function parseDocumentSnapshot(value: unknown): RuntimeBridgeDocumentSnapshot {
  const record = requireObject(value);
  requireOnlyKeys(record, "$", ["documentTypeId", "documentId", "kind", "data"]);
  const documentTypeId = requireString(record, "documentTypeId", "$.documentTypeId");
  if (!STABLE_ID_PATTERN.test(documentTypeId)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.documentTypeId", "Expected a document type identifier.");
  }

  const documentId = requireString(record, "documentId", "$.documentId");
  if (!STABLE_ID_PATTERN.test(documentId)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.documentId", "Expected a document identifier.");
  }

  const kind = requireString(record, "kind", "$.kind");
  if (!DOCUMENT_KIND_PATTERN.test(kind)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.kind", "Expected a compiled artifact kind.");
  }

  const data = record.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.data", "Expected an artifact data object.");
  }

  return { documentTypeId, documentId, kind, data: data as Record<string, unknown> };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Expected an object.");
  }

  return value as Record<string, unknown>;
}

function requireOnlyKeys(record: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new RuntimeBridgeProtocolError("runtime.unknownProperty", `${path}.${key}`, `Unknown property '${key}'.`);
    }
  }
}

function requireStrictString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", path, `Expected a string for '${key}'.`);
  }

  return value;
}

function requireStrictInteger(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", path, `Expected an integer for '${key}'.`);
  }

  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, path: string): number {
  if (!(key in record)) {
    throw new RuntimeBridgeProtocolError("runtime.missingProperty", path, `Missing property '${key}'.`);
  }

  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", path, `Expected an integer for '${key}'.`);
  }

  return value;
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  if (!(key in record)) {
    throw new RuntimeBridgeProtocolError("runtime.missingProperty", path, `Missing property '${key}'.`);
  }

  const value = record[key];
  if (typeof value !== "string") {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", path, `Expected a string for '${key}'.`);
  }

  return value;
}

function requireProtocolVersion(record: Record<string, unknown>, path: string): number {
  const value = requireInteger(record, "protocolVersion", path);
  if (value !== RUNTIME_BRIDGE_PROTOCOL_VERSION) {
    throw new RuntimeBridgeProtocolError("runtime.protocolVersionMismatch", path, `Expected protocolVersion ${RUNTIME_BRIDGE_PROTOCOL_VERSION}.`);
  }

  return value;
}

function requireCoreVersion(record: Record<string, unknown>, path: string): number {
  const value = requireInteger(record, "coreVersion", path);
  if (value !== RUNTIME_BRIDGE_CORE_VERSION) {
    throw new RuntimeBridgeProtocolError("runtime.protocolVersionMismatch", path, `Expected coreVersion ${RUNTIME_BRIDGE_CORE_VERSION}.`);
  }

  return value;
}

function requireToken(record: Record<string, unknown>): string {
  const value = requireString(record, "token", "$.token");
  if (!TOKEN_PATTERN.test(value)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidToken", "$.token", "Expected a hex token of 48 to 64 characters.");
  }

  return value;
}

function requireCapabilities(record: Record<string, unknown>, path: string): RuntimeBridgeCapability[] {
  const value = record.capabilities;
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", path, "Expected a non-empty capability list.");
  }

  const capabilities: RuntimeBridgeCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !CAPABILITY_SET.has(entry)) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", path, "Expected runtime capability names.");
    }

    capabilities.push(entry as RuntimeBridgeCapability);
  }

  if (new Set(capabilities).size !== capabilities.length) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", path, "Capabilities must be unique.");
  }

  return capabilities;
}

function requireRequestId(record: Record<string, unknown>): string {
  const value = requireString(record, "requestId", "$.requestId");
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$.requestId", "Expected a request identifier.");
  }

  return value;
}
