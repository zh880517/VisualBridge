export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_DISCOVERY_FORMAT_VERSION = 1;

export type BridgeCapability = "open" | "reveal";

export const BRIDGE_CAPABILITIES: readonly BridgeCapability[] = ["open", "reveal"];

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

export type BridgeErrorCode = typeof BRIDGE_ERROR_CODES[number];

export class BridgeProtocolError extends Error {
  public constructor(
    public readonly code: string,
    public readonly jsonPath: string,
    message: string,
  ) {
    super(`${code} at ${jsonPath}: ${message}`);
  }
}

export interface BridgeHelloMessage {
  readonly type: "hello";
  readonly protocolVersion: number;
  readonly token: string;
  readonly clientInstanceId: string;
  readonly capabilities: readonly BridgeCapability[];
}

export interface BridgeWelcomeMessage {
  readonly type: "welcome";
  readonly protocolVersion: number;
  readonly windowId: string;
  readonly serverGeneration: number;
  readonly capabilities: readonly BridgeCapability[];
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

export interface BridgeDiscoveryRecord {
  readonly formatVersion: number;
  readonly protocolVersion: number;
  readonly windowId: string;
  readonly capabilities: readonly BridgeCapability[];
  readonly projectRoots: readonly string[];
  readonly pipePath: string;
  readonly tcpPort: number;
  readonly token: string;
  readonly pid: number;
  readonly generation: number;
  readonly startedAt: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f]{48,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIPE_PATH_PATTERN = /^\\\\\.\\pipe\\[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:)?\/(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*\/$)(?:[^/]+\/)*[^/]+$/;
const STARTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ERROR_CODE_SET = new Set<string>(BRIDGE_ERROR_CODES);
const CAPABILITY_SET = new Set<string>(BRIDGE_CAPABILITIES);

export function isBridgeErrorCode(value: string): value is BridgeErrorCode {
  return ERROR_CODE_SET.has(value);
}

function isBridgeCapability(value: string): value is BridgeCapability {
  return CAPABILITY_SET.has(value);
}

export function parseBridgeMessage(value: unknown): BridgeMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$", "Expected a message object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") {
    throw new BridgeProtocolError("bridge.missingProperty", "$.type", "Expected a message 'type' string.");
  }

  switch (record.type) {
    case "hello": return parseHello(record);
    case "welcome": return parseWelcome(record);
    case "open": return parseOpen(record);
    case "reveal": return parseReveal(record);
    case "response": return parseResponse(record);
    case "error": return parseError(record);
    default:
      throw new BridgeProtocolError("bridge.unknownMessageType", "$.type", `Unknown message type '${String(record.type)}'.`);
  }
}

export function parseDiscoveryRecord(value: unknown): BridgeDiscoveryRecord {
  const record = requireObject(value);
  requireOnlyKeys(record, "$", ["formatVersion", "protocolVersion", "windowId", "capabilities", "projectRoots", "pipePath", "tcpPort", "token", "pid", "generation", "startedAt"]);
  const formatVersion = requireInteger(record, "formatVersion", "$.formatVersion");
  if (formatVersion !== BRIDGE_DISCOVERY_FORMAT_VERSION) {
    throw new BridgeProtocolError("bridge.unsupportedFormatVersion", "$.formatVersion", `Expected formatVersion ${BRIDGE_DISCOVERY_FORMAT_VERSION}.`);
  }

  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const windowId = requireString(record, "windowId", "$.windowId");
  if (!UUID_PATTERN.test(windowId)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.windowId", "Expected a UUID window identifier.");
  }

  const capabilities = requireCapabilities(record, "$.capabilities");
  const projectRoots = requireProjectRoots(record, "$.projectRoots");
  const pipePath = requireString(record, "pipePath", "$.pipePath");
  if (!PIPE_PATH_PATTERN.test(pipePath)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.pipePath", "Expected a Windows named pipe path.");
  }

  const tcpPort = requireInteger(record, "tcpPort", "$.tcpPort");
  if (tcpPort < 1 || tcpPort > 65535) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.tcpPort", "Expected a TCP port between 1 and 65535.");
  }

  const token = requireToken(record);
  const pid = requireInteger(record, "pid", "$.pid");
  if (pid < 1) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.pid", "Expected a positive process id.");
  }

  const generation = requireInteger(record, "generation", "$.generation");
  if (generation < 1) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.generation", "Expected a positive server generation.");
  }

  const startedAt = requireString(record, "startedAt", "$.startedAt");
  if (!STARTED_AT_PATTERN.test(startedAt)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
  }

  return { formatVersion, protocolVersion, windowId, capabilities, projectRoots, pipePath, tcpPort, token, pid, generation, startedAt };
}

export function serializeMessage(message: BridgeMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function isBridgeProtocolError(errorValue: unknown): errorValue is BridgeProtocolError {
  return errorValue instanceof BridgeProtocolError;
}

function parseHello(record: Record<string, unknown>): BridgeHelloMessage {
  requireOnlyKeys(record, "$", ["type", "protocolVersion", "token", "clientInstanceId", "capabilities"]);
  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const token = requireToken(record);
  const clientInstanceId = requireString(record, "clientInstanceId", "$.clientInstanceId");
  if (!UUID_PATTERN.test(clientInstanceId)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.clientInstanceId", "Expected a UUID client instance identifier.");
  }

  return { type: "hello", protocolVersion, token, clientInstanceId, capabilities: requireCapabilities(record, "$.capabilities") };
}

function parseWelcome(record: Record<string, unknown>): BridgeWelcomeMessage {
  requireOnlyKeys(record, "$", ["type", "protocolVersion", "windowId", "serverGeneration", "capabilities"]);
  const protocolVersion = requireProtocolVersion(record, "$.protocolVersion");
  const windowId = requireString(record, "windowId", "$.windowId");
  if (!UUID_PATTERN.test(windowId)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.windowId", "Expected a UUID window identifier.");
  }

  const serverGeneration = requireInteger(record, "serverGeneration", "$.serverGeneration");
  if (serverGeneration < 1) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.serverGeneration", "Expected a positive server generation.");
  }

  return { type: "welcome", protocolVersion, windowId, serverGeneration, capabilities: requireCapabilities(record, "$.capabilities") };
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
    throw new BridgeProtocolError("bridge.invalidMessage", "$.documentPath", "Expected a normalized project-relative forward-slash path.");
  }

  return { type: "open", requestId, documentPath };
}

function parseReveal(record: Record<string, unknown>): BridgeRevealRequest {
  requireOnlyKeys(record, "$", ["type", "requestId", "reference"]);
  const requestId = requireRequestId(record);
  const reference = record.reference;
  if (typeof reference === "string") {
    if (reference.length === 0 || reference.length > 1024) {
      throw new BridgeProtocolError("bridge.invalidMessage", "$.reference", "Expected a non-empty reference value.");
    }

    return { type: "reveal", requestId, reference };
  }

  if (typeof reference === "number" && Number.isSafeInteger(reference)) {
    return { type: "reveal", requestId, reference };
  }

  throw new BridgeProtocolError("bridge.invalidMessage", "$.reference", "Expected a string or number reference value.");
}

function parseResponse(record: Record<string, unknown>): BridgeResponseMessage {
  requireOnlyKeys(record, "$", ["type", "requestId", "status"], ["error"]);
  const requestId = requireRequestId(record);
  const status = record.status;
  if (status === "ok") {
    return { type: "response", requestId, status: "ok" };
  }

  if (status === "error") {
    const error = record.error;
    if (typeof error !== "string" || !isBridgeErrorCode(error)) {
      throw new BridgeProtocolError("bridge.invalidMessage", "$.error", "Expected a registered bridge error code.");
    }

    return { type: "response", requestId, status: "error", error };
  }

  throw new BridgeProtocolError("bridge.invalidMessage", "$.status", "Expected status 'ok' or 'error'.");
}

function parseError(record: Record<string, unknown>): BridgeErrorMessage {
  requireOnlyKeys(record, "$", ["type", "code"], ["detail"]);
  const code = record.code;
  if (typeof code !== "string" || !isBridgeErrorCode(code)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.code", "Expected a registered bridge error code.");
  }

  const detail = record.detail;
  if (detail !== undefined && (typeof detail !== "string" || detail.length === 0 || detail.length > 512)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.detail", "Expected a non-empty detail string of at most 512 characters.");
  }

  return detail === undefined ? { type: "error", code } : { type: "error", code, detail };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$", "Expected an object.");
  }

  return value as Record<string, unknown>;
}

function requireOnlyKeys(record: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new BridgeProtocolError("bridge.unknownProperty", `${path}.${key}`, `Unknown property '${key}'.`);
    }
  }

  for (const key of required) {
    if (!(key in record)) {
      throw new BridgeProtocolError("bridge.missingProperty", `${path}.${key}`, `Missing property '${key}'.`);
    }
  }
}

function requireProtocolVersion(record: Record<string, unknown>, path: string): number {
  const protocolVersion = requireInteger(record, "protocolVersion", path);
  if (protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new BridgeProtocolError("bridge.unsupportedProtocolVersion", path, `Expected protocolVersion ${BRIDGE_PROTOCOL_VERSION}.`);
  }

  return protocolVersion;
}

function requireToken(record: Record<string, unknown>): string {
  const token = requireString(record, "token", "$.token");
  if (!TOKEN_PATTERN.test(token)) {
    throw new BridgeProtocolError("bridge.invalidToken", "$.token", "Expected a hex authentication token.");
  }

  return token;
}

function requireRequestId(record: Record<string, unknown>): string {
  const requestId = requireString(record, "requestId", "$.requestId");
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new BridgeProtocolError("bridge.invalidMessage", "$.requestId", "Expected a request identifier.");
  }

  return requestId;
}

function requireCapabilities(record: Record<string, unknown>, path: string): readonly BridgeCapability[] {
  const value = record.capabilities;
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeProtocolError("bridge.invalidMessage", path, "Expected a non-empty capabilities array.");
  }

  const capabilities: BridgeCapability[] = [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !isBridgeCapability(entry)) {
      throw new BridgeProtocolError("bridge.invalidMessage", path, "Expected a registered capability.");
    }

    if (unique.has(entry)) {
      throw new BridgeProtocolError("bridge.invalidMessage", path, "Duplicate capability.");
    }

    unique.add(entry);
    capabilities.push(entry);
  }

  return capabilities;
}

function requireProjectRoots(record: Record<string, unknown>, path: string): readonly string[] {
  const value = record.projectRoots;
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeProtocolError("bridge.invalidMessage", path, "Expected a non-empty projectRoots array.");
  }

  const roots: string[] = [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !ABSOLUTE_PATH_PATTERN.test(entry)) {
      throw new BridgeProtocolError("bridge.invalidMessage", path, "Expected a normalized absolute forward-slash path.");
    }

    if (unique.has(entry)) {
      throw new BridgeProtocolError("bridge.invalidMessage", path, "Duplicate project root.");
    }

    unique.add(entry);
    roots.push(entry);
  }

  return roots;
}

function requireInteger(record: Record<string, unknown>, property: string, path: string): number {
  const value = record[property];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new BridgeProtocolError("bridge.invalidMessage", path, "Expected an integer.");
  }

  return value;
}

function requireString(record: Record<string, unknown>, property: string, path: string): string {
  const value = record[property];
  if (typeof value !== "string") {
    throw new BridgeProtocolError("bridge.invalidMessage", path, "Expected a string.");
  }

  return value;
}
