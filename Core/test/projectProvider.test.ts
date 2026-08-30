import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_PROVIDER_PROTOCOL_VERSION,
  parseProjectProviderHostMessage,
  parseProjectProviderResponse,
} from "../index";

const PROJECT_HASH = "a".repeat(64);
const DOCUMENT_SET_HASH = "b".repeat(64);
const SOURCE_HASH = "c".repeat(64);

test("Project Provider host messages require strict JSON-RPC V1 shapes", () => {
  assert.deepEqual(parseProjectProviderHostMessage({
    jsonrpc: "2.0",
    id: "initialize-1",
    method: "initialize",
    params: {
      protocolVersion: PROJECT_PROVIDER_PROTOCOL_VERSION,
      providerId: "sample.provider",
      project: { projectId: "sample.project", projectHash: PROJECT_HASH },
    },
  }), {
    success: true,
    value: {
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        protocolVersion: 1,
        providerId: "sample.provider",
        project: { projectId: "sample.project", projectHash: PROJECT_HASH },
      },
    },
  });

  const notification = parseProjectProviderHostMessage({
    jsonrpc: "2.0",
    method: "projectChanged",
    params: {
      projectId: "sample.project",
      projectHash: PROJECT_HASH,
      documentSetHash: DOCUMENT_SET_HASH,
      revision: 4,
    },
  });
  assert.equal(notification.success, true);

  assert.deepEqual(parseProjectProviderHostMessage({
    jsonrpc: "2.0",
    method: "$/cancelRequest",
    params: { id: 12 },
  }), {
    success: true,
    value: {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 12 },
    },
  });

  const notificationWithId = parseProjectProviderHostMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "projectChanged",
    params: {
      projectId: "sample.project",
      projectHash: PROJECT_HASH,
      documentSetHash: DOCUMENT_SET_HASH,
      revision: 4,
    },
  });
  assert.equal(notificationWithId.success, false);
  if (!notificationWithId.success) {
    assert.deepEqual(notificationWithId.issues, [{ path: "id", message: "Unknown property 'id'." }]);
  }
});

test("Reference requests retain invalidTarget and providerUnavailable as business states", () => {
  const invalidTarget = parseProjectProviderResponse({
    jsonrpc: "2.0",
    id: 2,
    result: {
      status: "invalidTarget",
      message: "Expected target.tableId.",
      issues: [{ path: "target.tableId", message: "Expected an identifier." }],
    },
  }, "reference/resolve");
  assert.equal(invalidTarget.success, true);
  if (invalidTarget.success && "result" in invalidTarget.value) {
    assert.equal(invalidTarget.value.result.status, "invalidTarget");
  }

  const unavailable = parseProjectProviderResponse({
    jsonrpc: "2.0",
    id: 3,
    result: { status: "providerUnavailable", message: "Backend offline.", retryable: true },
  }, "reference/search");
  assert.equal(unavailable.success, true);

  const illegalMissing = parseProjectProviderResponse({
    jsonrpc: "2.0",
    id: 4,
    result: { status: "missing", candidates: [], unexpected: true },
  }, "reference/resolve");
  assert.equal(illegalMissing.success, false);
  if (!illegalMissing.success) {
    assert.ok(illegalMissing.issues.some((issue) => issue.path === "result.unexpected"));
  }

  const falseAmbiguous = parseProjectProviderResponse({
    jsonrpc: "2.0",
    id: 5,
    result: { status: "ambiguous", candidates: [] },
  }, "reference/resolve");
  assert.equal(falseAmbiguous.success, false);
});

test("Validator receives host-parsed JSON semantic snapshots and rejects non-JSON content", () => {
  const valid = parseProjectProviderHostMessage({
    jsonrpc: "2.0",
    id: "validate-1",
    method: "validator/diagnostics",
    params: {
      project: { projectId: "sample.project", projectHash: PROJECT_HASH },
      documents: [{
        documentTypeId: "sample.settings",
        path: "Config/Game.settings",
        sourceHash: SOURCE_HASH,
        content: { documentId: "game", properties: { difficulty: 3 } },
      }],
    },
  });
  assert.equal(valid.success, true);

  const invalid = parseProjectProviderHostMessage({
    jsonrpc: "2.0",
    id: "validate-2",
    method: "validator/diagnostics",
    params: {
      project: { projectId: "sample.project", projectHash: PROJECT_HASH },
      documents: [{
        documentTypeId: "sample.settings",
        path: "Config/Game.settings",
        sourceHash: SOURCE_HASH,
        content: { invalid: undefined },
      }],
    },
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.ok(invalid.issues.some((issue) => issue.path === "params.documents[0].content.invalid"));
  }
});

test("Capabilities and structured errors reject undeclared fields and mismatched codes", () => {
  const capabilities = parseProjectProviderResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      capabilities: {
        reference: { kinds: ["sample.item"] },
        validator: { documentTypes: ["sample.settings"] },
      },
    },
  }, "capabilities");
  assert.equal(capabilities.success, true);

  const operationCapability = parseProjectProviderResponse({
    jsonrpc: "2.0",
    id: 1,
    result: { capabilities: { operation: true } },
  }, "capabilities");
  assert.equal(operationCapability.success, false);

  const mismatchedError = parseProjectProviderResponse({
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32602,
      message: "Invalid parameters.",
      data: { kind: "internalError", retryable: false },
    },
  }, "reference/search");
  assert.equal(mismatchedError.success, false);
  if (!mismatchedError.success) {
    assert.ok(mismatchedError.issues.some((issue) => issue.path === "error.data.kind"));
  }
});
