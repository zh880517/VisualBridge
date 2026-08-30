import { createHash } from "node:crypto";
import process from "node:process";
import readline from "node:readline";

const assets = [
  { value: "asset.shield", title: "Shield" },
  { value: "asset.sword", title: "Sword" },
];
const snapshotHash = createHash("sha256").update(JSON.stringify(assets)).digest("hex");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "$/cancelRequest" || request.id === undefined) return;
  const result = handle(request.method, request.params ?? {});
  if (result === undefined) {
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found." } });
    return;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === "shutdown") setImmediate(() => process.exit(0));
});

function handle(method, params) {
  switch (method) {
    case "initialize":
      return { protocolVersion: 2 };
    case "capabilities":
      return {
        capabilities: {
          reference: { kinds: ["sample.asset"] },
          validator: { documentTypes: ["sample.settings"] },
        },
      };
    case "reference/validateTarget":
      return validTarget(params)
        ? { status: "valid" }
        : {
            status: "invalidTarget",
            message: "sample.asset requires target.scope 'weapons'.",
            issues: [{ path: "target.scope", message: "Expected 'weapons'." }],
          };
    case "reference/search": {
      if (!validTarget(params)) return handle("reference/validateTarget", params);
      const query = String(params.query ?? "").toLowerCase();
      return {
        status: "ok",
        candidates: assets
          .filter((asset) => `${asset.title} ${asset.value}`.toLowerCase().includes(query))
          .slice(0, params.limit)
          .map(candidate),
        snapshotHash,
      };
    }
    case "reference/resolve": {
      if (!validTarget(params)) return handle("reference/validateTarget", params);
      const match = assets.find((asset) => asset.value === params.value);
      return match === undefined
        ? { status: "missing", candidates: [] }
        : { status: "resolved", candidates: [candidate(match)] };
    }
    case "validator/diagnostics":
      return {
        status: "ok",
        diagnostics: (params.documents ?? []).flatMap((document) => (
          document.content?.properties?.displayName === "Sample Game"
            ? [{
                documentTypeId: document.documentTypeId,
                documentPath: document.path,
                severity: "warning",
                code: "sample.provider.reviewDisplayName",
                path: "properties.displayName",
                message: "Replace the sample display name before production use.",
              }]
            : []
        )),
      };
    case "shutdown":
      return {};
    default:
      return undefined;
  }
}

function candidate(asset) {
  return {
    kind: "sample.asset",
    target: { scope: "weapons" },
    value: asset.value,
    title: asset.title,
  };
}

function validTarget(params) {
  return params.kind === "sample.asset" && params.target?.scope === "weapons";
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
