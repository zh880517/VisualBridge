import type { DocumentDiagnostic } from "../Document/document";
import type { JsonValue } from "../Form/field";
import type { ProjectProviderCapabilities } from "../Project/projectFile";
import type { ReferenceCandidate, ReferenceLocation } from "../Reference/reference";
import { compareUtf16CodeUnits } from "../Ordering/ordinal";

export const PROJECT_PROVIDER_PROTOCOL_VERSION = 2;
export const PROJECT_PROVIDER_JSON_RPC_VERSION = "2.0" as const;
export const PROJECT_PROVIDER_REFERENCE_CURSOR_MAX_LENGTH = 16_384;

export type ProjectProviderRequestId = string | number;
export type ProjectProviderMethod =
  | "initialize"
  | "capabilities"
  | "reference/search"
  | "reference/resolve"
  | "reference/validateTarget"
  | "validator/diagnostics"
  | "shutdown";

export interface ProjectProviderProjectSnapshot {
  readonly projectId: string;
  readonly projectHash: string;
}

export interface ProjectProviderDocumentSnapshot {
  readonly documentTypeId: string;
  readonly path: string;
  readonly sourceHash: string;
  readonly content: JsonValue;
}

export interface ProjectProviderInitializeParams {
  readonly protocolVersion: typeof PROJECT_PROVIDER_PROTOCOL_VERSION;
  readonly providerId: string;
  readonly project: ProjectProviderProjectSnapshot;
}

export interface ProjectProviderCapabilitiesParams {}

export interface ProjectProviderReferenceSearchParams {
  readonly kind: string;
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly query: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly snapshotHash?: string;
}

export interface ProjectProviderReferenceResolveParams {
  readonly kind: string;
  readonly target: Readonly<Record<string, JsonValue>>;
  readonly value: string | number;
}

export interface ProjectProviderReferenceValidateTargetParams {
  readonly kind: string;
  readonly target: Readonly<Record<string, JsonValue>>;
}

export interface ProjectProviderValidatorDiagnosticsParams {
  readonly project: ProjectProviderProjectSnapshot;
  readonly documents: readonly ProjectProviderDocumentSnapshot[];
}

export interface ProjectProviderShutdownParams {}

export type ProjectProviderHostRequest =
  | ProjectProviderRequest<"initialize", ProjectProviderInitializeParams>
  | ProjectProviderRequest<"capabilities", ProjectProviderCapabilitiesParams>
  | ProjectProviderRequest<"reference/search", ProjectProviderReferenceSearchParams>
  | ProjectProviderRequest<"reference/resolve", ProjectProviderReferenceResolveParams>
  | ProjectProviderRequest<"reference/validateTarget", ProjectProviderReferenceValidateTargetParams>
  | ProjectProviderRequest<"validator/diagnostics", ProjectProviderValidatorDiagnosticsParams>
  | ProjectProviderRequest<"shutdown", ProjectProviderShutdownParams>;

export interface ProjectProviderProjectChangedParams extends ProjectProviderProjectSnapshot {
  readonly documentSetHash: string;
  readonly revision: number;
}

export interface ProjectProviderCancelRequestParams {
  readonly id: ProjectProviderRequestId;
}

export type ProjectProviderHostNotification =
  | ProjectProviderNotification<"projectChanged", ProjectProviderProjectChangedParams>
  | ProjectProviderNotification<"$/cancelRequest", ProjectProviderCancelRequestParams>;

export type ProjectProviderHostMessage = ProjectProviderHostRequest | ProjectProviderHostNotification;

export interface ProjectProviderInitializeResult {
  readonly protocolVersion: typeof PROJECT_PROVIDER_PROTOCOL_VERSION;
}

export interface ProjectProviderCapabilitiesResult {
  readonly capabilities: ProjectProviderCapabilities;
}

export interface ProjectProviderInvalidTargetResult {
  readonly status: "invalidTarget";
  readonly message: string;
  readonly issues: readonly ProjectProviderIssue[];
}

export interface ProjectProviderUnavailableResult {
  readonly status: "providerUnavailable";
  readonly message: string;
  readonly retryable: boolean;
}

export type ProjectProviderReferenceSearchResult =
  | {
      readonly status: "ok";
      readonly candidates: readonly ReferenceCandidate[];
      readonly snapshotHash: string;
      readonly nextCursor?: string;
    }
  | {
      readonly status: "cursor.invalid" | "cursor.queryMismatch" | "cursor.snapshotChanged";
      readonly message: string;
    }
  | ProjectProviderInvalidTargetResult
  | ProjectProviderUnavailableResult;

export type ProjectProviderReferenceResolveResult =
  | { readonly status: "resolved"; readonly candidates: readonly [ReferenceCandidate] }
  | { readonly status: "missing"; readonly candidates: readonly [] }
  | { readonly status: "ambiguous"; readonly candidates: readonly ReferenceCandidate[] }
  | ProjectProviderInvalidTargetResult
  | ProjectProviderUnavailableResult;

export type ProjectProviderReferenceValidateTargetResult =
  | { readonly status: "valid" }
  | ProjectProviderInvalidTargetResult
  | ProjectProviderUnavailableResult;

export interface ProjectProviderDiagnostic extends DocumentDiagnostic {
  readonly documentTypeId: string;
  readonly documentPath: string;
}

export type ProjectProviderValidatorDiagnosticsResult =
  | { readonly status: "ok"; readonly diagnostics: readonly ProjectProviderDiagnostic[] }
  | ProjectProviderUnavailableResult;

export interface ProjectProviderShutdownResult {}

export interface ProjectProviderResultByMethod {
  readonly initialize: ProjectProviderInitializeResult;
  readonly capabilities: ProjectProviderCapabilitiesResult;
  readonly "reference/search": ProjectProviderReferenceSearchResult;
  readonly "reference/resolve": ProjectProviderReferenceResolveResult;
  readonly "reference/validateTarget": ProjectProviderReferenceValidateTargetResult;
  readonly "validator/diagnostics": ProjectProviderValidatorDiagnosticsResult;
  readonly shutdown: ProjectProviderShutdownResult;
}

export type ProjectProviderErrorKind =
  | "parseError"
  | "invalidRequest"
  | "methodNotFound"
  | "invalidParams"
  | "internalError"
  | "providerUnavailable"
  | "protocolVersionMismatch"
  | "protocolViolation";

export interface ProjectProviderErrorData {
  readonly kind: ProjectProviderErrorKind;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export interface ProjectProviderError {
  readonly code: number;
  readonly message: string;
  readonly data: ProjectProviderErrorData;
}

export type ProjectProviderResponse<M extends ProjectProviderMethod = ProjectProviderMethod> =
  | {
    readonly jsonrpc: typeof PROJECT_PROVIDER_JSON_RPC_VERSION;
    readonly id: ProjectProviderRequestId;
    readonly result: ProjectProviderResultByMethod[M];
  }
  | {
    readonly jsonrpc: typeof PROJECT_PROVIDER_JSON_RPC_VERSION;
    readonly id: ProjectProviderRequestId;
    readonly error: ProjectProviderError;
  };

export interface ProjectProviderIssue {
  readonly path: string;
  readonly message: string;
}

export type ProjectProviderParseResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly ProjectProviderIssue[] };

interface ProjectProviderRequest<M extends ProjectProviderMethod, P> {
  readonly jsonrpc: typeof PROJECT_PROVIDER_JSON_RPC_VERSION;
  readonly id: ProjectProviderRequestId;
  readonly method: M;
  readonly params: P;
}

interface ProjectProviderNotification<M extends string, P> {
  readonly jsonrpc: typeof PROJECT_PROVIDER_JSON_RPC_VERSION;
  readonly method: M;
  readonly params: P;
}

export function parseProjectProviderHostMessage(
  value: unknown,
): ProjectProviderParseResult<ProjectProviderHostMessage> {
  const issues: ProjectProviderIssue[] = [];
  if (!isRecord(value)) {
    return failure("$", "Expected a JSON-RPC object.");
  }
  if (value.method === "projectChanged") {
    rejectUnknownKeys(value, ["jsonrpc", "method", "params"], "$", issues);
    readJsonRpcVersion(value.jsonrpc, "jsonrpc", issues);
    const params = readProjectChangedParams(value.params, "params", issues);
    return finish(issues, params === undefined ? undefined : {
      jsonrpc: PROJECT_PROVIDER_JSON_RPC_VERSION,
      method: "projectChanged",
      params,
    });
  }
  if (value.method === "$/cancelRequest") {
    rejectUnknownKeys(value, ["jsonrpc", "method", "params"], "$", issues);
    readJsonRpcVersion(value.jsonrpc, "jsonrpc", issues);
    const params = readCancelRequestParams(value.params, "params", issues);
    return finish(issues, params === undefined ? undefined : {
      jsonrpc: PROJECT_PROVIDER_JSON_RPC_VERSION,
      method: "$/cancelRequest",
      params,
    });
  }

  rejectUnknownKeys(value, ["jsonrpc", "id", "method", "params"], "$", issues);
  readJsonRpcVersion(value.jsonrpc, "jsonrpc", issues);
  const id = readRequestId(value.id, "id", issues);
  const method = readMethod(value.method, "method", issues);
  const params = method === undefined
    ? undefined
    : readRequestParams(method, value.params, "params", issues);
  if (id === undefined || method === undefined || params === undefined) {
    return { success: false, issues: stableIssues(issues) };
  }
  return { success: true, value: createRequest(id, method, params) };
}

export function parseProjectProviderResponse<M extends ProjectProviderMethod>(
  value: unknown,
  expectedMethod: M,
): ProjectProviderParseResult<ProjectProviderResponse<M>> {
  const issues: ProjectProviderIssue[] = [];
  if (!isRecord(value)) {
    return failure("$", "Expected a JSON-RPC response object.");
  }
  rejectUnknownKeys(value, ["jsonrpc", "id", "result", "error"], "$", issues);
  readJsonRpcVersion(value.jsonrpc, "jsonrpc", issues);
  const id = readRequestId(value.id, "id", issues);
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) {
    issues.push({ path: "$", message: "Expected exactly one of 'result' or 'error'." });
  }
  if (id === undefined || hasResult === hasError) {
    return { success: false, issues: stableIssues(issues) };
  }
  if (hasError) {
    const error = readError(value.error, "error", issues);
    return finish(issues, error === undefined ? undefined : {
      jsonrpc: PROJECT_PROVIDER_JSON_RPC_VERSION,
      id,
      error,
    } as ProjectProviderResponse<M>);
  }
  const result = readResponseResult(expectedMethod, value.result, "result", issues);
  return finish(issues, result === undefined ? undefined : {
    jsonrpc: PROJECT_PROVIDER_JSON_RPC_VERSION,
    id,
    result,
  } as ProjectProviderResponse<M>);
}

function readRequestParams(
  method: ProjectProviderMethod,
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderHostRequest["params"] | undefined {
  switch (method) {
    case "initialize":
      return readInitializeParams(value, path, issues);
    case "capabilities":
    case "shutdown":
      return readEmptyObject(value, path, issues);
    case "reference/search":
      return readReferenceSearchParams(value, path, issues);
    case "reference/resolve":
      return readReferenceResolveParams(value, path, issues);
    case "reference/validateTarget":
      return readReferenceValidateTargetParams(value, path, issues);
    case "validator/diagnostics":
      return readValidatorDiagnosticsParams(value, path, issues);
  }
}

function readInitializeParams(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderInitializeParams | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["protocolVersion", "providerId", "project"], path, issues);
  if (value.protocolVersion !== PROJECT_PROVIDER_PROTOCOL_VERSION) {
    issues.push({ path: `${path}.protocolVersion`, message: `Expected protocol version ${PROJECT_PROVIDER_PROTOCOL_VERSION}.` });
  }
  const providerId = readIdentifier(value.providerId, `${path}.providerId`, issues);
  const project = readProjectSnapshot(value.project, `${path}.project`, issues);
  return providerId === undefined || project === undefined || value.protocolVersion !== PROJECT_PROVIDER_PROTOCOL_VERSION
    ? undefined
    : { protocolVersion: PROJECT_PROVIDER_PROTOCOL_VERSION, providerId, project };
}

function readProjectChangedParams(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderProjectChangedParams | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["projectId", "projectHash", "documentSetHash", "revision"], path, issues);
  const projectId = readIdentifier(value.projectId, `${path}.projectId`, issues);
  const projectHash = readHash(value.projectHash, `${path}.projectHash`, issues);
  const documentSetHash = readHash(value.documentSetHash, `${path}.documentSetHash`, issues);
  const revision = readNonNegativeInteger(value.revision, `${path}.revision`, issues);
  return projectId === undefined || projectHash === undefined || documentSetHash === undefined || revision === undefined
    ? undefined
    : { projectId, projectHash, documentSetHash, revision };
}

function readCancelRequestParams(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderCancelRequestParams | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["id"], path, issues);
  const id = readRequestId(value.id, `${path}.id`, issues);
  return id === undefined ? undefined : { id };
}

function readReferenceSearchParams(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderReferenceSearchParams | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["kind", "target", "query", "limit", "cursor", "snapshotHash"], path, issues);
  const shared = readReferenceParams(value, path, issues);
  const query = readString(value.query, `${path}.query`, issues);
  const limit = readBoundedInteger(value.limit, `${path}.limit`, 1, 200, issues);
  const hasCursor = Object.prototype.hasOwnProperty.call(value, "cursor");
  const hasSnapshotHash = Object.prototype.hasOwnProperty.call(value, "snapshotHash");
  if (hasCursor !== hasSnapshotHash) {
    issues.push({ path, message: "Expected 'cursor' and 'snapshotHash' to be supplied together." });
  }
  const cursor = hasCursor
    ? readBoundedNonEmptyString(value.cursor, `${path}.cursor`, PROJECT_PROVIDER_REFERENCE_CURSOR_MAX_LENGTH, issues)
    : undefined;
  const snapshotHash = hasSnapshotHash ? readHash(value.snapshotHash, `${path}.snapshotHash`, issues) : undefined;
  return shared === undefined || query === undefined || limit === undefined || hasCursor !== hasSnapshotHash
    || (hasCursor && (cursor === undefined || snapshotHash === undefined))
    ? undefined
    : { ...shared, query, limit, ...(cursor === undefined ? {} : { cursor, snapshotHash: snapshotHash! }) };
}

function readReferenceResolveParams(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderReferenceResolveParams | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["kind", "target", "value"], path, issues);
  const shared = readReferenceParams(value, path, issues);
  const referenceValue = readReferenceValue(value.value, `${path}.value`, issues);
  return shared === undefined || referenceValue === undefined
    ? undefined
    : { ...shared, value: referenceValue };
}

function readReferenceValidateTargetParams(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderReferenceValidateTargetParams | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["kind", "target"], path, issues);
  return readReferenceParams(value, path, issues);
}

function readReferenceParams(
  value: Readonly<Record<string, unknown>>,
  path: string,
  issues: ProjectProviderIssue[],
): Pick<ProjectProviderReferenceSearchParams, "kind" | "target"> | undefined {
  const kind = readIdentifier(value.kind, `${path}.kind`, issues);
  const target = readJsonObject(value.target, `${path}.target`, issues);
  return kind === undefined || target === undefined ? undefined : { kind, target };
}

function readValidatorDiagnosticsParams(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderValidatorDiagnosticsParams | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["project", "documents"], path, issues);
  const project = readProjectSnapshot(value.project, `${path}.project`, issues);
  if (!Array.isArray(value.documents)) {
    issues.push({ path: `${path}.documents`, message: "Expected an array." });
    return undefined;
  }
  const documents: ProjectProviderDocumentSnapshot[] = [];
  value.documents.forEach((entry, index) => {
    const document = readDocumentSnapshot(entry, `${path}.documents[${index}]`, issues);
    if (document !== undefined) documents.push(document);
  });
  return project === undefined || documents.length !== value.documents.length
    ? undefined
    : { project, documents };
}

function readProjectSnapshot(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderProjectSnapshot | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["projectId", "projectHash"], path, issues);
  const projectId = readIdentifier(value.projectId, `${path}.projectId`, issues);
  const projectHash = readHash(value.projectHash, `${path}.projectHash`, issues);
  return projectId === undefined || projectHash === undefined ? undefined : { projectId, projectHash };
}

function readDocumentSnapshot(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderDocumentSnapshot | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["documentTypeId", "path", "sourceHash", "content"], path, issues);
  const documentTypeId = readIdentifier(value.documentTypeId, `${path}.documentTypeId`, issues);
  const documentPath = readRelativePath(value.path, `${path}.path`, issues);
  const sourceHash = readHash(value.sourceHash, `${path}.sourceHash`, issues);
  const content = readJsonValue(value.content, `${path}.content`, issues);
  return documentTypeId === undefined || documentPath === undefined || sourceHash === undefined || content === undefined
    ? undefined
    : { documentTypeId, path: documentPath, sourceHash, content };
}

function readResponseResult<M extends ProjectProviderMethod>(
  method: M,
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderResultByMethod[M] | undefined {
  switch (method) {
    case "initialize":
      return readInitializeResult(value, path, issues) as ProjectProviderResultByMethod[M] | undefined;
    case "capabilities":
      return readCapabilitiesResult(value, path, issues) as ProjectProviderResultByMethod[M] | undefined;
    case "reference/search":
      return readReferenceSearchResult(value, path, issues) as ProjectProviderResultByMethod[M] | undefined;
    case "reference/resolve":
      return readReferenceResolveResult(value, path, issues) as ProjectProviderResultByMethod[M] | undefined;
    case "reference/validateTarget":
      return readReferenceValidateTargetResult(value, path, issues) as ProjectProviderResultByMethod[M] | undefined;
    case "validator/diagnostics":
      return readValidatorDiagnosticsResult(value, path, issues) as ProjectProviderResultByMethod[M] | undefined;
    case "shutdown":
      return readEmptyObject(value, path, issues) as ProjectProviderResultByMethod[M] | undefined;
  }
}

function readInitializeResult(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderInitializeResult | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["protocolVersion"], path, issues);
  if (value.protocolVersion !== PROJECT_PROVIDER_PROTOCOL_VERSION) {
    issues.push({ path: `${path}.protocolVersion`, message: `Expected protocol version ${PROJECT_PROVIDER_PROTOCOL_VERSION}.` });
    return undefined;
  }
  return { protocolVersion: PROJECT_PROVIDER_PROTOCOL_VERSION };
}

function readCapabilitiesResult(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderCapabilitiesResult | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["capabilities"], path, issues);
  const capabilities = readCapabilities(value.capabilities, `${path}.capabilities`, issues);
  return capabilities === undefined ? undefined : { capabilities };
}

function readReferenceSearchResult(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderReferenceSearchResult | undefined {
  const status = readStatus(value, path, issues);
  if (status === "invalidTarget") return readInvalidTarget(value, path, issues);
  if (status === "providerUnavailable") return readUnavailable(value, path, issues);
  if (status === "cursor.invalid" || status === "cursor.queryMismatch" || status === "cursor.snapshotChanged") {
    if (!isRecord(value)) return undefined;
    rejectUnknownKeys(value, ["status", "message"], path, issues);
    const message = readNonEmptyString(value.message, `${path}.message`, issues);
    return message === undefined ? undefined : { status, message };
  }
  if (status !== "ok" || !isRecord(value)) {
    if (status !== undefined) issues.push({ path: `${path}.status`, message: "Expected 'ok', a cursor status, 'invalidTarget' or 'providerUnavailable'." });
    return undefined;
  }
  rejectUnknownKeys(value, ["status", "candidates", "snapshotHash", "nextCursor"], path, issues);
  const candidates = readCandidates(value.candidates, `${path}.candidates`, issues);
  const snapshotHash = readHash(value.snapshotHash, `${path}.snapshotHash`, issues);
  const nextCursor = value.nextCursor === undefined
    ? undefined
    : readBoundedNonEmptyString(
        value.nextCursor,
        `${path}.nextCursor`,
        PROJECT_PROVIDER_REFERENCE_CURSOR_MAX_LENGTH,
        issues,
      );
  return candidates === undefined || snapshotHash === undefined
    || (value.nextCursor !== undefined && nextCursor === undefined)
    ? undefined
    : { status: "ok", candidates, snapshotHash, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function readReferenceResolveResult(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderReferenceResolveResult | undefined {
  const status = readStatus(value, path, issues);
  if (status === "invalidTarget") return readInvalidTarget(value, path, issues);
  if (status === "providerUnavailable") return readUnavailable(value, path, issues);
  if ((status !== "resolved" && status !== "missing" && status !== "ambiguous") || !isRecord(value)) {
    if (status !== undefined) issues.push({ path: `${path}.status`, message: "Expected 'resolved', 'missing', 'ambiguous', 'invalidTarget' or 'providerUnavailable'." });
    return undefined;
  }
  rejectUnknownKeys(value, ["status", "candidates"], path, issues);
  const candidates = readCandidates(value.candidates, `${path}.candidates`, issues);
  if (candidates === undefined) return undefined;
  if (status === "resolved" && candidates.length !== 1) {
    issues.push({ path: `${path}.candidates`, message: "Resolved result must contain exactly one candidate." });
    return undefined;
  }
  if (status === "missing" && candidates.length !== 0) {
    issues.push({ path: `${path}.candidates`, message: "Missing result must not contain candidates." });
    return undefined;
  }
  if (status === "ambiguous" && candidates.length < 2) {
    issues.push({ path: `${path}.candidates`, message: "Ambiguous result must contain at least two candidates." });
    return undefined;
  }
  if (status === "resolved") return { status, candidates: [candidates[0]!] };
  if (status === "missing") return { status, candidates: [] };
  return { status, candidates };
}

function readReferenceValidateTargetResult(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderReferenceValidateTargetResult | undefined {
  const status = readStatus(value, path, issues);
  if (status === "invalidTarget") return readInvalidTarget(value, path, issues);
  if (status === "providerUnavailable") return readUnavailable(value, path, issues);
  if (status !== "valid" || !isRecord(value)) {
    if (status !== undefined) issues.push({ path: `${path}.status`, message: "Expected 'valid', 'invalidTarget' or 'providerUnavailable'." });
    return undefined;
  }
  rejectUnknownKeys(value, ["status"], path, issues);
  return { status: "valid" };
}

function readValidatorDiagnosticsResult(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderValidatorDiagnosticsResult | undefined {
  const status = readStatus(value, path, issues);
  if (status === "providerUnavailable") return readUnavailable(value, path, issues);
  if (status !== "ok" || !isRecord(value)) {
    if (status !== undefined) issues.push({ path: `${path}.status`, message: "Expected 'ok' or 'providerUnavailable'." });
    return undefined;
  }
  rejectUnknownKeys(value, ["status", "diagnostics"], path, issues);
  if (!Array.isArray(value.diagnostics)) {
    issues.push({ path: `${path}.diagnostics`, message: "Expected an array." });
    return undefined;
  }
  const diagnostics: ProjectProviderDiagnostic[] = [];
  value.diagnostics.forEach((entry, index) => {
    const diagnostic = readDiagnostic(entry, `${path}.diagnostics[${index}]`, issues);
    if (diagnostic !== undefined) diagnostics.push(diagnostic);
  });
  return diagnostics.length !== value.diagnostics.length ? undefined : { status: "ok", diagnostics };
}

function readInvalidTarget(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderInvalidTargetResult | undefined {
  if (!isRecord(value)) return undefined;
  rejectUnknownKeys(value, ["status", "message", "issues"], path, issues);
  const message = readNonEmptyString(value.message, `${path}.message`, issues);
  if (!Array.isArray(value.issues)) {
    issues.push({ path: `${path}.issues`, message: "Expected an array." });
    return undefined;
  }
  const targetIssues: ProjectProviderIssue[] = [];
  value.issues.forEach((entry, index) => {
    const issue = readIssue(entry, `${path}.issues[${index}]`, issues);
    if (issue !== undefined) targetIssues.push(issue);
  });
  return message === undefined || targetIssues.length !== value.issues.length
    ? undefined
    : { status: "invalidTarget", message, issues: targetIssues };
}

function readUnavailable(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderUnavailableResult | undefined {
  if (!isRecord(value)) return undefined;
  rejectUnknownKeys(value, ["status", "message", "retryable"], path, issues);
  const message = readNonEmptyString(value.message, `${path}.message`, issues);
  if (typeof value.retryable !== "boolean") issues.push({ path: `${path}.retryable`, message: "Expected a boolean." });
  return message === undefined || typeof value.retryable !== "boolean"
    ? undefined
    : { status: "providerUnavailable", message, retryable: value.retryable };
}

function readCapabilities(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderCapabilities | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["reference", "validator"], path, issues);
  let reference: ProjectProviderCapabilities["reference"];
  if (value.reference !== undefined) {
    if (!isRecordAt(value.reference, `${path}.reference`, issues)) return undefined;
    rejectUnknownKeys(value.reference, ["kinds"], `${path}.reference`, issues);
    const kinds = readIdentifierArray(value.reference.kinds, `${path}.reference.kinds`, issues);
    if (kinds !== undefined) reference = { kinds };
  }
  let validator: ProjectProviderCapabilities["validator"];
  if (value.validator !== undefined) {
    if (!isRecordAt(value.validator, `${path}.validator`, issues)) return undefined;
    rejectUnknownKeys(value.validator, ["documentTypes"], `${path}.validator`, issues);
    const documentTypes = readIdentifierArray(
      value.validator.documentTypes,
      `${path}.validator.documentTypes`,
      issues,
    );
    if (documentTypes !== undefined) validator = { documentTypes };
  }
  if (reference === undefined && validator === undefined) {
    issues.push({ path, message: "Expected at least one 'reference' or 'validator' capability." });
    return undefined;
  }
  return {
    ...(reference === undefined ? {} : { reference }),
    ...(validator === undefined ? {} : { validator }),
  };
}

function readCandidates(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): readonly ReferenceCandidate[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected an array." });
    return undefined;
  }
  const candidates: ReferenceCandidate[] = [];
  value.forEach((entry, index) => {
    const candidate = readCandidate(entry, `${path}[${index}]`, issues);
    if (candidate !== undefined) candidates.push(candidate);
  });
  return candidates.length === value.length ? candidates : undefined;
}

function readCandidate(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ReferenceCandidate | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["kind", "target", "value", "title", "description", "location"], path, issues);
  const kind = readIdentifier(value.kind, `${path}.kind`, issues);
  const target = readJsonObject(value.target, `${path}.target`, issues);
  const candidateValue = readReferenceValue(value.value, `${path}.value`, issues);
  const title = readNonEmptyString(value.title, `${path}.title`, issues);
  const description = value.description === undefined
    ? undefined
    : readString(value.description, `${path}.description`, issues);
  const location = value.location === undefined
    ? undefined
    : readLocation(value.location, `${path}.location`, issues);
  if (kind === undefined || target === undefined || candidateValue === undefined || title === undefined
    || (value.description !== undefined && description === undefined)
    || (value.location !== undefined && location === undefined)) return undefined;
  return {
    kind,
    target,
    value: candidateValue,
    title,
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
  };
}

function readLocation(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ReferenceLocation | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  const optionalKeys = ["documentId", "componentId", "elementKind", "elementId", "graphId", "nodeId", "portId", "sheetId", "rowId"] as const;
  rejectUnknownKeys(value, ["projectId", "documentTypeId", "path", ...optionalKeys], path, issues);
  const projectId = readIdentifier(value.projectId, `${path}.projectId`, issues);
  const documentTypeId = readIdentifier(value.documentTypeId, `${path}.documentTypeId`, issues);
  const locationPath = readRelativePath(value.path, `${path}.path`, issues);
  const optional: Partial<Record<(typeof optionalKeys)[number], string>> = {};
  for (const key of optionalKeys) {
    if (value[key] !== undefined) {
      const fieldValue = readNonEmptyString(value[key], `${path}.${key}`, issues);
      if (fieldValue !== undefined) optional[key] = fieldValue;
    }
  }
  return projectId === undefined || documentTypeId === undefined || locationPath === undefined
    ? undefined
    : { projectId, documentTypeId, path: locationPath, ...optional };
}

function readDiagnostic(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderDiagnostic | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["documentTypeId", "documentPath", "severity", "code", "path", "message"], path, issues);
  const documentTypeId = readIdentifier(value.documentTypeId, `${path}.documentTypeId`, issues);
  const documentPath = readRelativePath(value.documentPath, `${path}.documentPath`, issues);
  const severity = value.severity === "error" || value.severity === "warning"
    ? value.severity
    : undefined;
  if (severity === undefined) issues.push({ path: `${path}.severity`, message: "Expected 'error' or 'warning'." });
  const code = readIdentifier(value.code, `${path}.code`, issues);
  const diagnosticPath = readString(value.path, `${path}.path`, issues);
  const message = readNonEmptyString(value.message, `${path}.message`, issues);
  return documentTypeId === undefined || documentPath === undefined || severity === undefined
    || code === undefined || diagnosticPath === undefined || message === undefined
    ? undefined
    : { documentTypeId, documentPath, severity, code, path: diagnosticPath, message };
}

function readIssue(value: unknown, path: string, issues: ProjectProviderIssue[]): ProjectProviderIssue | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["path", "message"], path, issues);
  const issuePath = readString(value.path, `${path}.path`, issues);
  const message = readNonEmptyString(value.message, `${path}.message`, issues);
  return issuePath === undefined || message === undefined ? undefined : { path: issuePath, message };
}

const ERROR_KINDS_BY_CODE = new Map<number, ProjectProviderErrorKind>([
  [-32700, "parseError"],
  [-32600, "invalidRequest"],
  [-32601, "methodNotFound"],
  [-32602, "invalidParams"],
  [-32603, "internalError"],
  [-32001, "providerUnavailable"],
  [-32002, "protocolVersionMismatch"],
  [-32003, "protocolViolation"],
]);

function readError(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): ProjectProviderError | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, ["code", "message", "data"], path, issues);
  const code = readInteger(value.code, `${path}.code`, issues);
  const message = readNonEmptyString(value.message, `${path}.message`, issues);
  const expectedKind = code === undefined ? undefined : ERROR_KINDS_BY_CODE.get(code);
  if (code !== undefined && expectedKind === undefined) {
    issues.push({ path: `${path}.code`, message: "Expected a registered Project Provider error code." });
  }
  if (!isRecordAt(value.data, `${path}.data`, issues)) return undefined;
  rejectUnknownKeys(value.data, ["kind", "retryable", "details"], `${path}.data`, issues);
  if (expectedKind !== undefined && value.data.kind !== expectedKind) {
    issues.push({ path: `${path}.data.kind`, message: `Expected '${expectedKind}' for error code ${String(code)}.` });
  }
  if (typeof value.data.retryable !== "boolean") {
    issues.push({ path: `${path}.data.retryable`, message: "Expected a boolean." });
  }
  const details = value.data.details === undefined
    ? undefined
    : readJsonValue(value.data.details, `${path}.data.details`, issues);
  if (code === undefined || expectedKind === undefined || message === undefined
    || value.data.kind !== expectedKind || typeof value.data.retryable !== "boolean"
    || (value.data.details !== undefined && details === undefined)) return undefined;
  return {
    code,
    message,
    data: {
      kind: expectedKind,
      retryable: value.data.retryable,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function readStatus(value: unknown, path: string, issues: ProjectProviderIssue[]): string | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  return readNonEmptyString(value.status, `${path}.status`, issues);
}

function readMethod(value: unknown, path: string, issues: ProjectProviderIssue[]): ProjectProviderMethod | undefined {
  const methods: readonly ProjectProviderMethod[] = [
    "initialize", "capabilities", "reference/search", "reference/resolve",
    "reference/validateTarget", "validator/diagnostics", "shutdown",
  ];
  if (typeof value !== "string" || !methods.includes(value as ProjectProviderMethod)) {
    issues.push({ path, message: "Expected a supported Project Provider method." });
    return undefined;
  }
  return value as ProjectProviderMethod;
}

function readRequestId(value: unknown, path: string, issues: ProjectProviderIssue[]): ProjectProviderRequestId | undefined {
  if ((typeof value === "string" && value.length > 0)
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return value;
  issues.push({ path, message: "Expected a non-empty string or non-negative safe integer request id." });
  return undefined;
}

function readJsonRpcVersion(value: unknown, path: string, issues: ProjectProviderIssue[]): void {
  if (value !== PROJECT_PROVIDER_JSON_RPC_VERSION) issues.push({ path, message: "Expected JSON-RPC version '2.0'." });
}

function readIdentifier(value: unknown, path: string, issues: ProjectProviderIssue[]): string | undefined {
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return value;
  issues.push({ path, message: "Expected an identifier using letters, digits, '.', '_' or '-'." });
  return undefined;
}

function readIdentifierArray(value: unknown, path: string, issues: ProjectProviderIssue[]): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "Expected a non-empty array of identifiers." });
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const identifier = readIdentifier(entry, `${path}[${index}]`, issues);
    if (identifier === undefined) return;
    if (seen.has(identifier)) issues.push({ path: `${path}[${index}]`, message: `Duplicate identifier '${identifier}'.` });
    else {
      seen.add(identifier);
      result.push(identifier);
    }
  });
  return result.length === value.length ? result : undefined;
}

function readRelativePath(value: unknown, path: string, issues: ProjectProviderIssue[]): string | undefined {
  if (typeof value === "string" && value !== "." && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")) return value;
  issues.push({ path, message: "Expected a normalized project-relative path using '/' separators." });
  return undefined;
}

function readHash(value: unknown, path: string, issues: ProjectProviderIssue[]): string | undefined {
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return value;
  issues.push({ path, message: "Expected a lowercase SHA-256 hash." });
  return undefined;
}

function readString(value: unknown, path: string, issues: ProjectProviderIssue[]): string | undefined {
  if (typeof value === "string") return value;
  issues.push({ path, message: "Expected a string." });
  return undefined;
}

function readNonEmptyString(value: unknown, path: string, issues: ProjectProviderIssue[]): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  issues.push({ path, message: "Expected a non-empty string." });
  return undefined;
}

function readBoundedNonEmptyString(
  value: unknown,
  path: string,
  maxLength: number,
  issues: ProjectProviderIssue[],
): string | undefined {
  const result = readNonEmptyString(value, path, issues);
  if (result !== undefined && result.length > maxLength) {
    issues.push({ path, message: `Expected a string no longer than ${String(maxLength)} characters.` });
    return undefined;
  }
  return result;
}

function readInteger(value: unknown, path: string, issues: ProjectProviderIssue[]): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  issues.push({ path, message: "Expected a safe integer." });
  return undefined;
}

function readNonNegativeInteger(value: unknown, path: string, issues: ProjectProviderIssue[]): number | undefined {
  const integer = readInteger(value, path, issues);
  if (integer !== undefined && integer < 0) {
    issues.push({ path, message: "Expected a non-negative integer." });
    return undefined;
  }
  return integer;
}

function readBoundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: ProjectProviderIssue[],
): number | undefined {
  const integer = readInteger(value, path, issues);
  if (integer !== undefined && (integer < minimum || integer > maximum)) {
    issues.push({ path, message: `Expected an integer from ${minimum} through ${maximum}.` });
    return undefined;
  }
  return integer;
}

function readReferenceValue(value: unknown, path: string, issues: ProjectProviderIssue[]): string | number | undefined {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  issues.push({ path, message: "Expected a string or finite number." });
  return undefined;
}

function readJsonObject(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): Readonly<Record<string, JsonValue>> | undefined {
  const parsed = readJsonValue(value, path, issues);
  return parsed !== undefined && isRecord(parsed) ? parsed : undefined;
}

function readJsonValue(value: unknown, path: string, issues: ProjectProviderIssue[]): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    issues.push({ path, message: "Expected a finite JSON number." });
    return undefined;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    value.forEach((entry, index) => {
      const parsed = readJsonValue(entry, `${path}[${index}]`, issues);
      if (parsed !== undefined) result.push(parsed);
    });
    return result.length === value.length ? result : undefined;
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const parsed = readJsonValue(entry, `${path}.${key}`, issues);
      if (parsed !== undefined) result[key] = parsed;
    }
    return Object.keys(result).length === Object.keys(value).length ? result : undefined;
  }
  issues.push({ path, message: "Expected a JSON value." });
  return undefined;
}

function readEmptyObject(value: unknown, path: string, issues: ProjectProviderIssue[]): Record<string, never> | undefined {
  if (!isRecordAt(value, path, issues)) return undefined;
  rejectUnknownKeys(value, [], path, issues);
  return {};
}

function createRequest(
  id: ProjectProviderRequestId,
  method: ProjectProviderMethod,
  params: ProjectProviderHostRequest["params"],
): ProjectProviderHostRequest {
  return { jsonrpc: PROJECT_PROVIDER_JSON_RPC_VERSION, id, method, params } as ProjectProviderHostRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordAt(
  value: unknown,
  path: string,
  issues: ProjectProviderIssue[],
): value is Record<string, unknown> {
  if (isRecord(value)) return true;
  issues.push({ path, message: "Expected an object." });
  return false;
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
  issues: ProjectProviderIssue[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value).sort(compareUtf16CodeUnits)) {
    if (!allowedKeys.has(key)) issues.push({ path: path === "$" ? key : `${path}.${key}`, message: `Unknown property '${key}'.` });
  }
}

function failure<T>(path: string, message: string): ProjectProviderParseResult<T> {
  return { success: false, issues: [{ path, message }] };
}

function finish<T>(
  issues: readonly ProjectProviderIssue[],
  value: T | undefined,
): ProjectProviderParseResult<T> {
  return issues.length > 0 || value === undefined
    ? { success: false, issues: stableIssues(issues) }
    : { success: true, value };
}

function stableIssues(issues: readonly ProjectProviderIssue[]): readonly ProjectProviderIssue[] {
  return [...issues].sort((left, right) => compareUtf16CodeUnits(left.path, right.path) || compareUtf16CodeUnits(left.message, right.message));
}
