import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const PROTOCOL_VERSION = 2;
const CAPABILITIES = {
  reference: { kinds: ["sample.asset"] },
  validator: { documentTypes: ["sample.provider.settings"] },
};
const ASSETS = [
  { value: 1, title: "Typed One", description: "Numeric stable value candidate." },
  { value: "1", title: "Typed One", description: "String stable value candidate." },
  { value: "asset.bow", title: "Bow", description: "Fixed ranged weapon candidate." },
  { value: "asset.shield", title: "Shield", description: "Fixed defensive candidate." },
  { value: "asset.sword", title: "Sword", description: "Fixed melee weapon candidate." },
  ...Array.from({ length: 260 }, (_, index) => ({
    value: `asset.bulk.${String(index).padStart(3, "0")}`,
    title: `Bulk Asset ${String(index).padStart(3, "0")}`,
    description: "Deterministic bulk pagination candidate.",
  })),
];
const options = parseArguments(process.argv.slice(2));
const mode = options.get("mode") ?? "healthy";
const stateDirectory = options.get("state-dir") ?? process.env.VISUALBRIDGE_PROVIDER_TEST_STATE_DIR;
const rewriteSource = options.get("rewrite-source") ?? process.env.VISUALBRIDGE_PROVIDER_TEST_REWRITE_SOURCE;
const rewriteContentBase64 = options.get("rewrite-content-base64")
  ?? process.env.VISUALBRIDGE_PROVIDER_TEST_REWRITE_CONTENT_BASE64;
const faultMethod = options.get("fault-method") ?? defaultFaultMethod(mode);
const crashStarts = readPositiveInteger(options.get("crash-starts") ?? "2", "crash-starts");
const startCount = incrementStartCount();
let faultEmitted = false;

recordEvent("start", {
  mode,
  startCount,
  argv: process.argv.slice(2),
  echoArgument: options.get("echo-arg"),
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    recordEvent("invalidInput", { message: String(error) });
    return;
  }
  recordEvent(message?.id === undefined ? "notification" : "request", {
    method: message?.method,
    id: message?.id,
  });

  if (message?.method === "$/cancelRequest") return;
  if (message?.id === undefined) return;
  if (mode === "crashOnContinuation" && startCount === 1
    && message.method === "reference/search" && message.params?.cursor !== undefined) {
    recordEvent("fault", { mode, method: message.method, id: message.id });
    process.exit(73);
  }
  if (shouldFault(message.method)) {
    if (mode === "rewriteAuthoringInvalidResult") rewriteAuthoringSource();
    emitFault(message);
    return;
  }

  if (mode === "stderr" && !faultEmitted && message.method === faultMethod) {
    faultEmitted = true;
    process.stderr.write("Project Provider fixture stderr line.\n");
    recordEvent("stderr", { method: message.method });
  }

  if (mode === "rewriteAuthoring" && message.method === faultMethod) {
    rewriteAuthoringSource();
  }

  const result = mutateHostResult(
    message.method,
    handleRequest(message.method, message.params ?? {}),
  );
  if (result === undefined) {
    writeError(message.id, -32601, "methodNotFound", `Unknown fixture method '${String(message.method)}'.`);
    return;
  }
  writeMessage({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "shutdown") {
    recordEvent("shutdown");
    setImmediate(() => process.exit(0));
  }
});

function handleRequest(method, params) {
  switch (method) {
    case "initialize":
      return { protocolVersion: PROTOCOL_VERSION };
    case "capabilities":
      return { capabilities: CAPABILITIES };
    case "reference/validateTarget":
      return validateTarget(params);
    case "reference/search": {
      const validation = validateTarget(params);
      if (validation.status !== "valid") return validation;
      const query = String(params.query ?? "").toLocaleLowerCase("en-US");
      const snapshotHash = referenceSnapshotHash();
      let offset = 0;
      if (params.cursor !== undefined || params.snapshotHash !== undefined) {
        if (typeof params.cursor !== "string" || typeof params.snapshotHash !== "string") {
          return cursorError("cursor.invalid", "cursor and snapshotHash must be supplied together.");
        }
        const decoded = decodeReferenceCursor(params.cursor);
        if (decoded === undefined) return cursorError("cursor.invalid", "Reference cursor is malformed.");
        if (decoded.query !== query || decoded.target !== canonicalJson(params.target)) {
          return cursorError("cursor.queryMismatch", "Reference cursor belongs to a different query or target.");
        }
        if (decoded.snapshotHash !== params.snapshotHash || params.snapshotHash !== snapshotHash) {
          return cursorError("cursor.snapshotChanged", "Reference candidate snapshot changed.");
        }
        offset = decoded.offset;
      }
      const matches = ASSETS
        .filter((asset) => `${asset.title}\u0000${asset.value}`.toLocaleLowerCase("en-US").includes(query))
        .sort(compareAssets);
      if (offset > matches.length) return cursorError("cursor.invalid", "Reference cursor offset is outside the result set.");
      const candidates = matches
        .slice(offset, offset + params.limit)
        .map(candidate);
      const nextOffset = offset + candidates.length;
      return {
        status: "ok",
        candidates,
        snapshotHash,
        ...(nextOffset < matches.length ? {
          nextCursor: encodeReferenceCursor({
            version: 1,
            query,
            target: canonicalJson(params.target),
            offset: nextOffset,
            snapshotHash,
          }),
        } : {}),
      };
    }
    case "reference/resolve": {
      const validation = validateTarget(params);
      if (validation.status !== "valid") return validation;
      if (params.value === "asset.ambiguous") {
        return {
          status: "ambiguous",
          candidates: [
            candidate({ value: "asset.ambiguous", title: "Ambiguous A", description: "First duplicate." }),
            candidate({ value: "asset.ambiguous", title: "Ambiguous B", description: "Second duplicate." }),
          ],
        };
      }
      const match = ASSETS.find((asset) => asset.value === params.value);
      return match === undefined
        ? { status: "missing", candidates: [] }
        : { status: "resolved", candidates: [candidate(match)] };
    }
    case "validator/diagnostics":
      return {
        status: "ok",
        diagnostics: Array.isArray(params.documents)
          ? params.documents.flatMap(validateDocument)
          : [],
      };
    case "shutdown":
      return {};
    default:
      return undefined;
  }
}

function validateTarget(params) {
  if (params.kind === "sample.asset" && params.target?.scope === "weapons") {
    return { status: "valid" };
  }
  return {
    status: "invalidTarget",
    message: "sample.asset requires target.scope 'weapons'.",
    issues: [{ path: "target.scope", message: "Expected 'weapons'." }],
  };
}

function validateDocument(document) {
  if (document?.documentTypeId !== "sample.provider.settings") {
    return [];
  }
  if (document.content?.properties?.displayName === "Rejected By Provider") {
    return [{
      documentTypeId: document.documentTypeId,
      documentPath: document.path,
      severity: "error",
      code: "sample.provider.displayNameRejected",
      path: "properties.displayName",
      message: "This display name is rejected by the fixed Provider validator.",
    }];
  }
  if (document.content?.properties?.displayName !== "Needs Provider Review") return [];
  return [{
    documentTypeId: document.documentTypeId,
    documentPath: document.path,
    severity: "warning",
    code: "sample.provider.displayNameReview",
    path: "properties.displayName",
    message: "Replace the fixed review marker before release.",
  }];
}

function candidate(asset) {
  return {
    kind: "sample.asset",
    target: { scope: "weapons" },
    value: asset.value,
    title: asset.title,
    description: asset.description,
  };
}

function referenceSnapshotHash() {
  let revision = "0";
  if (stateDirectory !== undefined) {
    try {
      revision = readFileSync(path.join(stateDirectory, "reference-snapshot.txt"), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return createHash("sha256").update(JSON.stringify({ revision, assets: ASSETS })).digest("hex");
}

function encodeReferenceCursor(value) {
  const payload = mode === "largeContinuation"
    ? { ...value, padding: "x".repeat(11_500) }
    : value;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeReferenceCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded?.version === 1
      && typeof decoded.query === "string"
      && typeof decoded.target === "string"
      && Number.isSafeInteger(decoded.offset)
      && decoded.offset >= 0
      && typeof decoded.snapshotHash === "string"
      && /^[a-f0-9]{64}$/u.test(decoded.snapshotHash)
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function cursorError(status, message) {
  return { status, message };
}

function compareAssets(left, right) {
  return left.title < right.title ? -1 : left.title > right.title ? 1
    : typeof left.value !== typeof right.value ? (typeof left.value === "number" ? -1 : 1)
      : left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function mutateHostResult(method, result) {
  if (result === undefined) return result;
  if (mode === "candidateWrongKind" && method === "reference/search" && result.status === "ok") {
    return {
      ...result,
      candidates: result.candidates.map((entry) => ({ ...entry, kind: "sample.other" })),
    };
  }
  if (mode === "candidateWrongTarget" && method === "reference/search" && result.status === "ok") {
    return {
      ...result,
      candidates: result.candidates.map((entry) => ({ ...entry, target: { scope: "armor" } })),
    };
  }
  if (mode === "candidateWrongValue" && method === "reference/resolve" && result.status === "resolved") {
    return {
      ...result,
      candidates: result.candidates.map((entry) => ({ ...entry, value: "asset.other" })),
    };
  }
  if (mode === "candidateOutsideLocation" && method === "reference/search" && result.status === "ok") {
    return {
      ...result,
      candidates: result.candidates.map((entry) => ({
        ...entry,
        location: {
          projectId: "another.project",
          documentTypeId: "sample.provider.settings",
          path: "Config/Outside.providerconfig",
        },
      })),
    };
  }
  if (mode === "diagnosticOutsideSnapshot" && method === "validator/diagnostics" && result.status === "ok") {
    return {
      ...result,
      diagnostics: [{
        documentTypeId: "sample.provider.settings",
        documentPath: "Config/Outside.providerconfig",
        severity: "error",
        code: "sample.provider.outsideSnapshot",
        path: "$",
        message: "This diagnostic intentionally escapes the requested snapshot.",
      }],
    };
  }
  return result;
}

function shouldFault(method) {
  if (faultEmitted || method !== faultMethod) return false;
  if (mode === "invalidJson" || mode === "invalidResult" || mode === "timeout" || mode === "crash"
    || mode === "rewriteAuthoringInvalidResult") return true;
  return mode === "crashThenHealthy" && startCount <= crashStarts;
}

function emitFault(message) {
  faultEmitted = true;
  recordEvent("fault", { mode, method: message.method, id: message.id });
  if (mode === "invalidJson") {
    process.stdout.write("{invalid-json\n");
  } else if (mode === "invalidResult" || mode === "rewriteAuthoringInvalidResult") {
    writeMessage({ jsonrpc: "2.0", id: message.id, result: { status: "fixture.invalid" } });
  } else if (mode === "crash" || mode === "crashThenHealthy") {
    process.exit(73);
  }
}

function rewriteAuthoringSource() {
  if (rewriteSource === undefined || rewriteContentBase64 === undefined) {
    throw new Error("rewriteAuthoring requires an injected source path and content.");
  }
  writeFileSync(rewriteSource, Buffer.from(rewriteContentBase64, "base64"));
  recordEvent("authoringRewritten", { source: rewriteSource });
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeError(id, code, kind, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message, data: { kind, retryable: false } },
  });
}

function incrementStartCount() {
  if (stateDirectory === undefined) return 1;
  mkdirSync(stateDirectory, { recursive: true });
  const countPath = path.join(stateDirectory, "start-count.txt");
  let count = 0;
  try {
    count = Number.parseInt(readFileSync(countPath, "utf8"), 10);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = Number.isInteger(count) && count >= 0 ? count + 1 : 1;
  writeFileSync(countPath, String(next), "utf8");
  return next;
}

function recordEvent(type, details = {}) {
  if (stateDirectory === undefined) return;
  mkdirSync(stateDirectory, { recursive: true });
  appendFileSync(path.join(stateDirectory, "events.ndjson"), `${JSON.stringify({
    type,
    pid: process.pid,
    timestamp: Date.now(),
    ...details,
  })}\n`, "utf8");
}

function defaultFaultMethod(value) {
  if (value === "crash" || value === "crashThenHealthy") return "initialize";
  if (value === "rewriteAuthoring" || value === "rewriteAuthoringInvalidResult") return "validator/diagnostics";
  return "reference/search";
}

function readPositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseArguments(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (typeof key !== "string" || !key.startsWith("--") || value === undefined) {
      throw new Error(`Invalid Provider fixture argument at index ${index}.`);
    }
    result.set(key.slice(2), value);
  }
  return result;
}
