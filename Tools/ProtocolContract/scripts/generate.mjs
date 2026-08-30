import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const schemaRoot = path.join(repositoryRoot, "Protocol", "Schema");
const generatedRoot = path.join(repositoryRoot, "Protocol", "Generated");
const check = process.argv.includes("--check");

const schemaFiles = (await readdir(schemaRoot)).filter((name) => name.endsWith(".schema.json")).sort(compareOrdinal);
const schemas = await Promise.all(schemaFiles.map(async (name) => {
  const bytes = await readFile(path.join(schemaRoot, name));
  return { name, bytes, schema: JSON.parse(bytes.toString("utf8")) };
}));
const contractManifest = JSON.parse(await readFile(path.join(repositoryRoot, "Protocol", "contract-manifest.json"), "utf8"));

const ids = new Set();
for (const { name, schema } of schemas) {
  if (typeof schema.$id !== "string" || schema.$id.length === 0) throw new Error(`${name} must declare $id.`);
  if (ids.has(schema.$id)) throw new Error(`Duplicate JSON Schema $id '${schema.$id}'.`);
  ids.add(schema.$id);
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value)),
});
schemas.forEach(({ schema }) => ajv.addSchema(schema));
schemas.forEach(({ name, schema }) => {
  if (ajv.getSchema(schema.$id) === undefined) throw new Error(`AJV did not compile ${name}.`);
});
verifyContractExamples(ajv);
await verifyImplementationRegistry();

const index = {
  generatedBy: "Tools/ProtocolContract/scripts/generate.mjs",
  manifestVersion: 1,
  schemas: schemas.map(({ name, bytes, schema }) => ({
    file: `Schema/${name}`,
    id: schema.$id,
    sha256: sha256(bytes),
    definitions: Object.keys(schema.$defs ?? {}).sort(compareOrdinal),
  })),
};
const indexText = `${JSON.stringify(index, undefined, 2)}\n`;
const declarationText = generateDeclarations(schemas);
verifyDeclarationFidelity(declarationText);
await emit(path.join(generatedRoot, "schema-index.json"), indexText);
await emit(path.join(generatedRoot, "contracts.d.ts"), declarationText);
await compileDeclarations();
console.log(`${check ? "Checked" : "Generated"} ${schemas.length} compiled schemas and 2 deterministic artifacts.`);

async function emit(target, content) {
  if (check) {
    let current;
    try { current = await readFile(target, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Generated artifact is missing: ${path.relative(repositoryRoot, target)}`);
      throw error;
    }
    if (current !== content) throw new Error(`Generated artifact drift: ${path.relative(repositoryRoot, target)}`);
    return;
  }
  await writeFile(target, content, "utf8");
}

async function compileDeclarations() {
  const tsc = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  await promisify(execFile)(process.execPath, [
    tsc,
    "--noEmit",
    "--skipLibCheck", "false",
    "--target", "ES2022",
    "--module", "ESNext",
    "--moduleResolution", "bundler",
    path.join(generatedRoot, "contracts.d.ts"),
    path.join(packageRoot, "test", "contracts-assignment.ts"),
  ], { cwd: repositoryRoot });
}

function verifyContractExamples(compiler) {
  const authoringId = "https://visualbridge.dev/schema/visualbridge-authoring-contracts.schema.json";
  const mcpId = "https://visualbridge.dev/schema/visualbridge-mcp-tools.schema.json";
  const hash = "a".repeat(64);
  const primitivesId = "https://visualbridge.dev/schema/visualbridge-primitives.schema.json";
  const normalizedPath = requireValidator(compiler, `${primitivesId}#/$defs/normalizedPath`);
  assertValid(normalizedPath, "Config/A.json", "normalized path");
  assertInvalid(normalizedPath, "Config/", "normalized path with trailing slash");
  const lockOwner = requireValidator(compiler, `${primitivesId}#/$defs/lockOwner`);
  assertValid(lockOwner, {
    version: 1,
    token: "1b3121ab-2646-4e0f-a789-e970d4fbca8f",
    pid: 42,
    startedAt: "2026-08-30T12:34:56.000Z",
  }, "lock owner");
  assertInvalid(lockOwner, { version: 2, token: "not-a-uuid", pid: 0, startedAt: "yesterday" }, "invalid lock owner primitives");
  assertInvalid(lockOwner, {
    version: 1,
    token: "1b3121ab-2646-4e0f-a789-e970d4fbca8f",
    pid: 42,
    startedAt: "2026-08-30T12:34:56.000Z",
    unknown: true,
  }, "lock owner unknown field");

  const referenceCursor = requireValidator(compiler, `${authoringId}#/$defs/referenceSearchCursor`);
  assertInvalid(referenceCursor, { version: 2, snapshotHash: "not-a-hash", query: "", offset: 0 }, "invalid Reference hash");

  const transaction = requireValidator(compiler, `${authoringId}#/$defs/transactionMutation`);
  for (const value of [
    { path: "Config/A.json", afterHash: hash },
    { path: "Config/A.json", beforeHash: hash },
    { path: "Config/A.json", beforeHash: hash, afterHash: "b".repeat(64) },
  ]) assertValid(transaction, value, "transaction mutation");
  assertInvalid(transaction, { path: "Config/A.json" }, "empty transaction mutation");

  const refactor = requireValidator(compiler, `${authoringId}#/$defs/refactorRequest`);
  const mcpRefactor = requireValidator(compiler, `${mcpId}#/$defs/visualbridge_refactor_reference.input`);
  const refactorBase = {
    projectFile: "VisualBridge.project.vbjson",
    kind: "document",
    target: {},
    oldValue: "old",
    newValue: "next",
  };
  assertValid(refactor, { ...refactorBase, action: "preview" }, "refactor preview");
  assertValid(refactor, { ...refactorBase, action: "apply", previewHash: hash, baseHashes: { "Config/A.json": hash } }, "refactor apply");
  assertInvalid(refactor, { ...refactorBase, action: "preview", previewHash: hash }, "preview with apply fields");
  assertInvalid(refactor, { ...refactorBase, action: "apply" }, "apply without complete manifest");
  assertInvalid(refactor, { ...refactorBase, action: "preview", newValue: 2 }, "refactor value type change");
  assertInvalid(mcpRefactor, { ...refactorBase, action: "preview", previewHash: hash }, "MCP refactor preview with apply fields");

  const lifecycle = requireValidator(compiler, `${mcpId}#/$defs/visualbridge_document_lifecycle.input`);
  const operation = {
    kind: "create",
    target: { projectId: "sample", documentTypeId: "game.graph", editor: "graph", path: "Graph/A.vbgraph" },
    parameters: { documentId: "graph.a", rootGraphId: "root" },
  };
  assertValid(lifecycle, { action: "preview", projectFile: "VisualBridge.project.vbjson", operation }, "lifecycle preview");
  assertInvalid(lifecycle, { action: "preview", projectFile: "VisualBridge.project.vbjson", operation, previewHash: hash }, "lifecycle preview with apply fields");
  assertInvalid(lifecycle, { action: "apply", projectFile: "VisualBridge.project.vbjson", operation }, "lifecycle apply without manifest");
  assertInvalid(lifecycle, { action: "preview", projectFile: "VisualBridge.project.vbjson", operation: { ...operation, parameters: { documentId: "graph.a", rootGraphId: "root", unexpected: true } } }, "lifecycle unknown create parameter");

  const graphId = "https://visualbridge.dev/schema/visualbridge-graph.schema.json";
  const interfacePort = requireValidator(compiler, `${graphId}#/$defs/interfacePort`);
  const portBase = { id: "entry", title: "Entry", direction: "input" };
  assertValid(interfacePort, { ...portBase, kind: "data", dataTypeId: "number", dynamic: true }, "data InterfacePort");
  assertValid(interfacePort, { ...portBase, kind: "flow", dynamic: false }, "flow InterfacePort");
  assertInvalid(interfacePort, { ...portBase, kind: "data" }, "data InterfacePort without dataTypeId");
  assertInvalid(interfacePort, { ...portBase, kind: "flow", dataTypeId: "number" }, "flow InterfacePort with dataTypeId");
  assertInvalid(interfacePort, { ...portBase, kind: "flow", dynamic: true }, "dynamic flow InterfacePort");

  const providerId = "https://visualbridge.dev/schema/visualbridge-project-provider.schema.json";
  const structuredError = requireValidator(compiler, `${providerId}#/$defs/structuredError`);
  assertValid(structuredError, { code: -32001, message: "Unavailable", data: { kind: "providerUnavailable", retryable: true } }, "structured Provider error");
  assertInvalid(structuredError, { code: -32001, message: "Unavailable", data: { kind: "providerUnavailable" } }, "structured Provider error without retryable");
  assertInvalid(structuredError, { code: -32001, message: "Unavailable", data: { kind: "internalError", retryable: true } }, "structured Provider error with mismatched kind");
}

async function verifyImplementationRegistry() {
  assertSortedUnique(contractManifest.errors.transactionFailures, "transaction failure registry");
  assertSortedUnique(contractManifest.errors.lifecycleBlockers, "Lifecycle blocker registry");
  assertSortedUnique(contractManifest.errors.providerHost, "Provider Host error registry");
  assertSortedUnique(contractManifest.errors.mcpPublic, "MCP public error registry");

  const transactionSource = await readFile(path.join(repositoryRoot, "Tools", "NodeHost", "src", "projectTransaction.ts"), "utf8");
  const transactionFailures = literalMatches(transactionSource, /new ProjectTransactionFailure\(\s*"([^"]+)"/g);
  assertSameSet(transactionFailures, contractManifest.errors.transactionFailures, "transaction failures");
  assert.equal(transactionSource.includes(`code: "${contractManifest.errors.transactionMaintenance[0]}"`), true, "Transaction maintenance registry drift.");

  const lifecycleSource = await readFile(path.join(repositoryRoot, "Core", "Document", "documentLifecycle.ts"), "utf8");
  const blockerUnion = lifecycleSource.match(/export type DocumentLifecycleBlockerCode =([\s\S]*?);/)?.[1];
  if (blockerUnion === undefined) throw new Error("DocumentLifecycleBlockerCode was not found.");
  assertSameSet(literalMatches(blockerUnion, /"([^"]+)"/g), contractManifest.errors.lifecycleBlockers, "Lifecycle blockers");
  const lifecycleConflictUnion = lifecycleSource.match(/export type DocumentLifecycleApplyConflictReason =([\s\S]*?);/)?.[1];
  if (lifecycleConflictUnion === undefined) throw new Error("DocumentLifecycleApplyConflictReason was not found.");
  const lifecyclePlanConflicts = literalMatches(lifecycleConflictUnion, /"([^"]+)"/g);
  assertSameSet(lifecyclePlanConflicts, contractManifest.statuses.lifecyclePlanConflicts, "Lifecycle plan conflicts");
  assertSameSet(
    [...lifecyclePlanConflicts, ...contractManifest.transactionConflicts, "previewInvalidated"],
    contractManifest.statuses.lifecyclePublicConflicts,
    "Lifecycle public conflicts",
  );
  assertSameSet(
    [...contractManifest.transactionConflicts, "previewInvalidated", "previewHashMismatch"],
    contractManifest.statuses.refactorPublicConflicts,
    "Refactor public conflicts",
  );

  const providerSources = await Promise.all([
    "projectProviderRuntime.ts",
    "projectProviderHost.ts",
  ].map((name) => readFile(path.join(repositoryRoot, "Tools", "NodeHost", "src", name), "utf8")));
  const providerErrors = literalMatches(providerSources.join("\n"), /new ProjectProvider(?:Runtime|ExternalModification)Error\(\s*"([^"]+)"/g);
  providerErrors.push("provider.externalModification", "provider.invalidTarget");
  assertSameSet(providerErrors, contractManifest.errors.providerHost, "Provider Host errors");

  const mcpRoot = path.join(repositoryRoot, "Tools", "VisualBridgeMcp", "src");
  const mcpSources = await readTypeScriptTree(mcpRoot);
  const mcpErrors = literalMatches(mcpSources, /new VisualBridgeMcpError\(\s*"([^"]+)"/g);
  mcpErrors.push(
    ...contractManifest.errors.transactionFailures,
    "internal",
    "refactor.missingTargetLocation",
    "refactor.sameValue",
    "refactor.valueTypeMismatch",
  );
  assertSameSet(mcpErrors, contractManifest.errors.mcpPublic, "MCP public errors");

  verifySchemaVersion("visualbridge-project.schema.json", "project");
  verifySchemaVersion("visualbridge-graph.schema.json", "graphDocument");
  verifySchemaVersion("visualbridge-graph-catalog.schema.json", "graphCatalog");
  verifySchemaVersion("visualbridge-entity.schema.json", "entityDocument");
  verifySchemaVersion("visualbridge-entity-catalog.schema.json", "entityCatalog");
  verifySchemaVersion("visualbridge-structured.schema.json", "structuredDocument");
  verifySchemaVersion("visualbridge-structured-catalog.schema.json", "structuredCatalog");
  verifySchemaVersion("visualbridge-table-catalog.schema.json", "tableCatalog");
  assertSourceVersion(lifecycleSource, /DOCUMENT_LIFECYCLE_PLAN_VERSION\s*=\s*(\d+)/, "documentLifecyclePlan");
  assertSourceVersion(transactionSource, /interface TransactionJournal[\s\S]*?version:\s*(\d+)/, "projectTransactionJournal");
  const referenceSource = await readFile(path.join(repositoryRoot, "Core", "Reference", "reference.ts"), "utf8");
  assertSourceVersion(referenceSource, /REFERENCE_SEARCH_CURSOR_VERSION\s*=\s*(\d+)/, "referenceCursor");
  const providerProtocolSource = await readFile(path.join(repositoryRoot, "Core", "Provider", "projectProviderProtocol.ts"), "utf8");
  assertSourceVersion(providerProtocolSource, /PROJECT_PROVIDER_PROTOCOL_VERSION\s*=\s*(\d+)/, "projectProvider");
  const mcpServerSource = await readFile(path.join(repositoryRoot, "Tools", "VisualBridgeMcp", "src", "server.ts"), "utf8");
  assertSourceVersion(mcpServerSource, /CONTRACT_VERSION\s*=\s*(\d+)/, "mcp");
  assert.equal(contractManifest.versions.protocolContracts, 1, "Protocol contract manifest version drift.");
  assert.equal(contractManifest.versions.projectTransactionLockOwner, 1, "Project Transaction lock owner version drift.");

  const schemaByName = new Map(schemas.map((entry) => [entry.name, entry.schema]));
  const authoring = schemaByName.get("visualbridge-authoring-contracts.schema.json");
  const mcp = schemaByName.get("visualbridge-mcp-tools.schema.json");
  const provider = schemaByName.get("visualbridge-project-provider.schema.json");
  assertSameSet(statusValues(mcp.$defs.toolOutput, mcp), contractManifest.statuses.mcp, "MCP statuses");
  assertSameSet(statusValues(authoring.$defs.referenceSearchPage, authoring), contractManifest.statuses.referenceSearch, "Reference search statuses");
  assertSameSet(statusValues(provider.$defs.referenceSearchResult, provider), contractManifest.statuses.providerReferenceSearch, "Provider search statuses");
  assertSameSet(statusValues(provider.$defs.referenceResolveResult, provider), contractManifest.statuses.providerReferenceResolve, "Provider resolve statuses");
  assertSameSet(statusValues(provider.$defs.referenceValidateTargetResult, provider), contractManifest.statuses.providerReferenceValidateTarget, "Provider target statuses");
  assertSameSet(statusValues(provider.$defs.validatorDiagnosticsResult, provider), contractManifest.statuses.providerValidatorDiagnostics, "Provider validator statuses");
}

function verifySchemaVersion(fileName, manifestKey) {
  const schema = schemas.find((entry) => entry.name === fileName)?.schema;
  const version = schema?.properties?.formatVersion?.const;
  assert.equal(version, contractManifest.versions[manifestKey], `${manifestKey} version registry drift.`);
}

function assertSourceVersion(source, expression, manifestKey) {
  const value = Number(source.match(expression)?.[1]);
  assert.equal(value, contractManifest.versions[manifestKey], `${manifestKey} implementation version drift.`);
}

function statusValues(schema, root, seen = new Set()) {
  if (schema === undefined || schema === true || schema === false || seen.has(schema)) return [];
  seen.add(schema);
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("#/$defs/").at(-1);
    const owner = schemas.map((entry) => entry.schema).find((candidate) => candidate.$defs?.[name] !== undefined);
    return owner === undefined ? [] : statusValues(owner.$defs[name], owner, seen);
  }
  const values = [];
  const status = schema.properties?.status;
  if (status?.const !== undefined) values.push(status.const);
  if (Array.isArray(status?.enum)) values.push(...status.enum);
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    for (const branch of schema[key] ?? []) values.push(...statusValues(branch, root, seen));
  }
  return values;
}

async function readTypeScriptTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.sort((left, right) => compareOrdinal(left.name, right.name)).map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return readTypeScriptTree(target);
    return entry.name.endsWith(".ts") ? readFile(target, "utf8") : "";
  }));
  return contents.join("\n");
}

function literalMatches(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function assertSameSet(actual, expected, label) {
  const normalizedActual = [...new Set(actual)].sort(compareOrdinal);
  const normalizedExpected = [...new Set(expected)].sort(compareOrdinal);
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(`${label} registry drift.\nActual: ${JSON.stringify(normalizedActual)}\nRegistry: ${JSON.stringify(normalizedExpected)}`);
  }
}

function assertSortedUnique(values, label) {
  const sorted = [...new Set(values)].sort(compareOrdinal);
  if (JSON.stringify(values) !== JSON.stringify(sorted)) throw new Error(`${label} must be UTF-16 ordinal sorted and unique.`);
}

function requireValidator(compiler, id) {
  const validator = compiler.getSchema(id);
  if (validator === undefined) throw new Error(`AJV did not expose '${id}'.`);
  return validator;
}

function assertValid(validator, value, label) {
  if (!validator(value)) throw new Error(`Expected valid ${label}: ${JSON.stringify(validator.errors)}`);
}

function assertInvalid(validator, value, label) {
  if (validator(value)) throw new Error(`Expected invalid ${label}.`);
}

function generateDeclarations(allSchemas) {
  const registry = createDeclarationRegistry(allSchemas);
  const lines = [
    "// Generated from Protocol/Schema. Do not edit.",
    "// Every formal schema is emitted as a namespace with Root and all $defs declarations.",
    "",
  ];
  for (const { name: fileName, schema, namespace } of registry.schemas) {
    lines.push(`// Source: Protocol/Schema/${fileName}`);
    lines.push(`// $id: ${schema.$id}`);
    lines.push(`export namespace ${namespace} {`);
    const rootSchema = withInferredConditionalDomain(schema, schema.$id, registry);
    lines.push(`  export type Root = ${toType(rootSchema, registry.references, schema.$id, registry.schemaIdsByFile, namespace)};`);
    for (const [name, definition] of Object.entries(schema.$defs ?? {}).sort(([left], [right]) => compareOrdinal(left, right))) {
      const reference = `${schema.$id}#/$defs/${name}`;
      const declarationSchema = withInferredConditionalDomain(definition, reference, registry);
      lines.push(`  export type ${typeName(name)} = ${toType(declarationSchema, registry.references, schema.$id, registry.schemaIdsByFile, namespace)};`);
    }
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n");
}

function withInferredConditionalDomain(schema, targetReference, registry) {
  const discriminator = Object.keys(schema.if?.properties ?? {})[0];
  if (discriminator === undefined || literalValues(schema.properties?.[discriminator]) !== undefined) return schema;
  const values = [];
  for (const owner of registry.schemas) {
    visitSchemas(owner.schema, (candidate) => {
      const referencesTarget = (candidate.allOf ?? []).some((entry) => (
        entry?.$ref !== undefined
        && resolveReferenceId(entry.$ref, owner.schema.$id, registry.schemaIdsByFile) === targetReference
      ));
      if (!referencesTarget) return;
      const candidateValues = resolvedLiteralValues(
        candidate.properties?.[discriminator],
        registry.references,
        owner.schema.$id,
        registry.schemaIdsByFile,
      );
      if (candidateValues !== undefined) values.push(...candidateValues);
    });
  }
  const domain = [...new Set(values)].sort(compareJsonValues);
  if (domain.length === 0) return schema;
  return {
    ...schema,
    properties: { ...(schema.properties ?? {}), [discriminator]: literalSchema(domain) },
  };
}

function visitSchemas(schema, visitor, seen = new Set()) {
  if (schema === undefined || schema === true || schema === false || seen.has(schema)) return;
  seen.add(schema);
  visitor(schema);
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach((entry) => visitSchemas(entry, visitor, seen));
    else if (value !== null && typeof value === "object") visitSchemas(value, visitor, seen);
  }
}

function createDeclarationRegistry(allSchemas) {
  const schemaIdsByFile = new Map(allSchemas.map(({ name, schema }) => [name, schema.$id]));
  const namespaceOwners = new Map();
  const references = new Map();
  const registeredSchemas = allSchemas.map(({ name, ...entry }) => {
    const namespace = schemaNamespaceName(name);
    const namespaceOwner = namespaceOwners.get(namespace);
    if (namespaceOwner !== undefined) {
      throw new Error(`Schema namespace '${namespace}' collides between ${namespaceOwner} and ${name}.`);
    }
    namespaceOwners.set(namespace, name);

    const typeOwners = new Map([["Root", "schema root"]]);
    references.set(entry.schema.$id, { namespace, name: "Root", schema: entry.schema });
    for (const definitionName of Object.keys(entry.schema.$defs ?? {}).sort(compareOrdinal)) {
      const declarationName = typeName(definitionName);
      const typeOwner = typeOwners.get(declarationName);
      if (typeOwner !== undefined) {
        throw new Error(`${name} declaration '${declarationName}' collides between ${typeOwner} and $defs/${definitionName}.`);
      }
      typeOwners.set(declarationName, `$defs/${definitionName}`);
      references.set(`${entry.schema.$id}#/$defs/${definitionName}`, {
        namespace,
        name: declarationName,
        schema: entry.schema.$defs[definitionName],
      });
    }
    return { name, ...entry, namespace };
  });
  return { references, schemaIdsByFile, schemas: registeredSchemas };
}

function verifyDeclarationFidelity(declarations) {
  verifyDeclarationCoverage(declarations, schemas);
  const authoring = schemaNamespaceName("visualbridge-authoring-contracts.schema.json");
  const graph = schemaNamespaceName("visualbridge-graph.schema.json");
  const mcp = schemaNamespaceName("visualbridge-mcp-tools.schema.json");
  const provider = schemaNamespaceName("visualbridge-project-provider.schema.json");
  const entityCatalog = schemaNamespaceName("visualbridge-entity-catalog.schema.json");
  const tableCatalog = schemaNamespaceName("visualbridge-table-catalog.schema.json");
  assert.match(declarationOf(declarations, authoring, "RefactorPreviewStringRequest"), /\(RefactorPreviewRequest\) & \(\{[^\n]*"newValue"\?: string[^\n]*"oldValue"\?: string/);
  assert.match(declarationOf(declarations, authoring, "RefactorPreviewNumberRequest"), /\(RefactorPreviewRequest\) & \(\{[^\n]*"newValue"\?: number[^\n]*"oldValue"\?: number/);
  const lifecycle = declarationOf(declarations, mcp, "VisualbridgeDocumentLifecycleInput");
  assert.match(lifecycle, /"action": "apply"/);
  assert.match(lifecycle, /"action": "preview"/);
  assert.match(lifecycle, /"previewHash": VisualBridgePrimitives\.Sha256/);
  assert.doesNotMatch(lifecycle, /"previewHash"\?:/);
  const refactorInput = declarationOf(declarations, mcp, "VisualbridgeRefactorReferenceInput");
  for (const request of [
    "RefactorPreviewStringRequest",
    "RefactorPreviewNumberRequest",
    "RefactorApplyStringRequest",
    "RefactorApplyNumberRequest",
  ]) assert.match(refactorInput, new RegExp(`${authoring}\\.${request}`));
  const refactorApply = declarationOf(declarations, authoring, "RefactorApplyRequest");
  const refactorPreview = declarationOf(declarations, authoring, "RefactorPreviewRequest");
  assert.match(refactorApply, /"action": "apply"/);
  assert.match(refactorApply, /"previewHash": VisualBridgePrimitives\.Sha256/);
  assert.match(refactorPreview, /"action": "preview"/);
  assert.doesNotMatch(refactorPreview, /"previewHash"/);
  assert.match(declarationOf(declarations, authoring, "ReferenceSearchPage"), /readonly \[\]/);
  const interfacePort = declarationOf(declarations, graph, "InterfacePort");
  assert.match(interfacePort, /"dataTypeId": Identifier[^\n]*"kind": "data"/);
  assert.match(interfacePort, /"dataTypeId"\?: never[^\n]*"dynamic"\?: false[^\n]*"kind": "flow"/);
  assert.equal([...interfacePort.matchAll(/"kind": "(?:data|flow)"/g)].length, 2, "InterfacePort must be an exact data/flow discriminated union.");
  const errorData = declarationOf(declarations, provider, "ErrorData");
  assert.match(errorData, /"kind": [^;]+; readonly "retryable": boolean/);
  assert.doesNotMatch(errorData, /"kind"\?:|"retryable"\?:/);
  const structuredError = declarationOf(declarations, provider, "StructuredError");
  for (const [code, kind] of [
    [-32700, "parseError"],
    [-32600, "invalidRequest"],
    [-32601, "methodNotFound"],
    [-32602, "invalidParams"],
    [-32603, "internalError"],
    [-32001, "providerUnavailable"],
    [-32002, "protocolVersionMismatch"],
    [-32003, "protocolViolation"],
  ]) assert.match(structuredError, new RegExp(`"code": ${code}[^\\n]*"data": \\(ErrorData\\) & \\(\\{ readonly "kind": "${kind}"`));
  assert.doesNotMatch(structuredError, /"kind"\?:/, "StructuredError discriminators must remain required through nested intersections.");
  const entityField = declarationOf(declarations, entityCatalog, "Field");
  assert.match(entityField, /"fields": readonly Field\[\][^\n]*"item"\?: never[^\n]*"valueType": [^;\n]*"object"/);
  assert.match(entityField, /"fields"\?: never[^\n]*"item": ValueDefinition[^\n]*"valueType": "array"/);
  assert.match(entityField, /"fields"\?: never[^\n]*"item"\?: never[^\n]*"valueType": "string" \| "number" \| "boolean" \| "json"/);
  assertDeclarationOptionality(
    entityField,
    ["aliases", "dataTypeId", "description", "editor", "fields", "item", "reference"],
    ["defaultValue", "id", "title", "valueType"],
    "Entity Field",
  );
  const entityValueShape = declarationOf(declarations, entityCatalog, "ValueShape");
  assert.match(entityValueShape, /"fields": unknown[^\n]*"item"\?: never[^\n]*"valueType": "object"/);
  assert.match(entityValueShape, /"fields"\?: never[^\n]*"item": unknown[^\n]*"valueType": "array"/);
  assert.match(entityValueShape, /"fields"\?: never[^\n]*"item"\?: never[^\n]*"valueType": "boolean" \| "json" \| "number" \| "string"/);
  const tableColumn = declarationOf(declarations, tableCatalog, "Column");
  assert.match(tableColumn, /"fields": readonly Field\[\][^\n]*"item"\?: never[^\n]*"valueType": [^;\n]*"object"/);
  assert.match(tableColumn, /"fields"\?: never[^\n]*"item": ValueDefinition[^\n]*"valueType": "array"/);
  assert.match(tableColumn, /"fields"\?: never[^\n]*"item"\?: never[^\n]*"valueType": "string" \| "number" \| "boolean" \| "json"/);
  assertDeclarationOptionality(
    tableColumn,
    ["aliases", "dataTypeId", "description", "editor", "fields", "item", "nameKeyAliases", "reference"],
    ["cellEncoding", "defaultValue", "id", "nameKey", "title", "valueType"],
    "Table Column",
  );
  const tableValueShape = declarationOf(declarations, tableCatalog, "ValueShape");
  assert.match(tableValueShape, /"fields": unknown[^\n]*"item"\?: never[^\n]*"valueType": "object"/);
  assert.match(tableValueShape, /"fields"\?: never[^\n]*"item": unknown[^\n]*"valueType": "array"/);
  assert.match(tableValueShape, /"fields"\?: never[^\n]*"item"\?: never[^\n]*"valueType": "boolean" \| "json" \| "number" \| "string"/);
  assert.doesNotMatch(declarations, /\) & \(unknown\)/, "Schema annotations must not degrade referenced declarations to intersections with unknown.");
  for (const [namespace, name] of [
    [graph, "DynamicPort"],
    [graph, "InterfacePort"],
    [graph, "Properties"],
    [mcp, "VisualbridgeDocumentLifecycleInput"],
    [mcp, "VisualbridgeRefactorReferenceInput"],
  ]) {
    const declaration = declarationOf(declarations, namespace, name);
    assert.doesNotMatch(declaration, /\bunknown\b/, `${name} must not degrade to unknown.`);
  }
}

function assertDeclarationOptionality(declaration, optional, required, label) {
  for (const property of optional) {
    assert.match(declaration, new RegExp(`"${property}"\\?:`), `${label}.${property} must remain optional.`);
  }
  for (const property of required) {
    assert.match(declaration, new RegExp(`"${property}":`), `${label}.${property} must remain required.`);
    assert.doesNotMatch(declaration, new RegExp(`"${property}"\\?:`), `${label}.${property} must not become optional.`);
  }
}

function verifyDeclarationCoverage(declarations, allSchemas) {
  for (const { name, schema } of allSchemas) {
    const namespace = schemaNamespaceName(name);
    const header = `// Source: Protocol/Schema/${name}\n// $id: ${schema.$id}\nexport namespace ${namespace} {`;
    assert.equal(declarations.includes(header), true, `${name} declaration namespace is missing.`);
    const expected = ["Root", ...Object.keys(schema.$defs ?? {}).sort(compareOrdinal).map(typeName)];
    const block = declarationBlock(declarations, namespace);
    const actual = [...block.matchAll(/^  export type ([A-Za-z0-9]+) = /gm)].map((match) => match[1]);
    assert.deepEqual(actual, expected, `${name} declarations must contain Root and every $defs entry in schema order.`);
  }
  assert.equal(
    [...declarations.matchAll(/^export namespace ([A-Za-z0-9]+) \{/gm)].length,
    allSchemas.length,
    "Generated declaration namespace count must equal the formal schema count.",
  );
}

function declarationBlock(declarations, namespace) {
  const startMarker = `export namespace ${namespace} {\n`;
  const start = declarations.indexOf(startMarker);
  if (start < 0) throw new Error(`Declaration namespace '${namespace}' was not found.`);
  const contentStart = start + startMarker.length;
  const end = declarations.indexOf("\n}\n", contentStart);
  if (end < 0) throw new Error(`Declaration namespace '${namespace}' is unterminated.`);
  return declarations.slice(contentStart, end);
}

function declarationOf(declarations, namespace, name) {
  const block = declarationBlock(declarations, namespace);
  return block.match(new RegExp(`^  export type ${name} = ([^\\n]+);$`, "m"))?.[1] ?? "";
}

function toType(schema, names, currentSchemaId, schemaIdsByFile, currentNamespace) {
  if (schema === true || schema === undefined) return "unknown";
  if (schema === false) return "never";
  if (schema.$ref !== undefined) {
    const reference = resolveReferenceId(schema.$ref, currentSchemaId, schemaIdsByFile);
    const target = names.get(reference);
    if (target === undefined) throw new Error(`Unresolved declaration reference '${schema.$ref}' from '${currentSchemaId}'.`);
    const base = target.namespace === currentNamespace ? target.name : `${target.namespace}.${target.name}`;
    const { $ref: _reference, ...rawSiblings } = schema;
    const siblings = Object.fromEntries(Object.entries(rawSiblings).filter(([key]) => ![
      "$comment",
      "default",
      "deprecated",
      "description",
      "examples",
      "readOnly",
      "title",
      "writeOnly",
    ].includes(key)));
    if (Object.keys(siblings).length === 0) return base;
    return `(${base}) & (${toType(siblings, names, currentSchemaId, schemaIdsByFile, currentNamespace)})`;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const variants = schema.oneOf ?? schema.anyOf;
  if (
    Array.isArray(variants)
    && (schema.type === "object" || schema.properties !== undefined)
    && variants.every((entry) => entry.$ref === undefined && (entry.type === undefined || entry.type === "object"))
  ) {
    const base = { ...schema, oneOf: undefined, anyOf: undefined };
    return variants.map((entry) => `(${toType(mergeObjectConstraint(base, entry), names, currentSchemaId, schemaIdsByFile, currentNamespace)})`).join(" | ");
  }
  if (Array.isArray(variants)) return variants.map((entry) => `(${toType(entry, names, currentSchemaId, schemaIdsByFile, currentNamespace)})`).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map((type) => scalarType(type)).join(" | ");
  if (schema.type === "array" && schema.maxItems === 0) return "readonly []";
  if (schema.type === "array") return `readonly ${parenthesize(toType(schema.items, names, currentSchemaId, schemaIdsByFile, currentNamespace))}[]`;
  if (schema.type === "object" || schema.properties !== undefined) {
    const variants = expandConditionalObject(schema, names, currentSchemaId, schemaIdsByFile);
    if (variants.length === 0) return "never";
    if (variants.length > 1) {
      return variants.map((entry) => `(${toType(entry, names, currentSchemaId, schemaIdsByFile, currentNamespace)})`).join(" | ");
    }
    if (variants[0] !== schema) return toType(variants[0], names, currentSchemaId, schemaIdsByFile, currentNamespace);
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {}).sort(([left], [right]) => compareOrdinal(left, right)).map(([key, value]) => (
      `readonly ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${toType(value, names, currentSchemaId, schemaIdsByFile, currentNamespace)}`
    ));
    if (schema.additionalProperties !== false) {
      properties.push(`readonly [key: string]: ${schema.additionalProperties && typeof schema.additionalProperties === "object" ? toType(schema.additionalProperties, names, currentSchemaId, schemaIdsByFile, currentNamespace) : "unknown"}`);
    }
    return `{ ${properties.join("; ")} }`;
  }
  if (Array.isArray(schema.allOf)) {
    const rawMembers = schema.allOf
      .filter((entry) => entry.if === undefined && entry.then === undefined && entry.else === undefined && entry.not === undefined)
    const required = new Set(rawMembers.flatMap((entry) => requiredProperties(entry, names, currentSchemaId, schemaIdsByFile)));
    const members = rawMembers
      .map((entry) => requireKnownProperties(entry, required))
      .map((entry) => toType(entry, names, currentSchemaId, schemaIdsByFile, currentNamespace))
      .filter((entry) => entry !== "unknown");
    return members.length === 0 ? "unknown" : members.map((entry) => `(${entry})`).join(" & ");
  }
  return scalarType(schema.type);
}

function requiredProperties(schema, names, currentSchemaId, schemaIdsByFile, seen = new Set()) {
  if (schema === undefined || schema === true || schema === false || seen.has(schema)) return [];
  seen.add(schema);
  if (schema.$ref !== undefined) {
    const reference = resolveReferenceId(schema.$ref, currentSchemaId, schemaIdsByFile);
    const target = names.get(reference);
    if (target === undefined) throw new Error(`Unresolved declaration reference '${schema.$ref}' from '${currentSchemaId}'.`);
    return requiredProperties(target.schema, names, currentSchemaId, schemaIdsByFile, seen);
  }
  return [
    ...(schema.required ?? []),
    ...(schema.allOf ?? []).flatMap((entry) => requiredProperties(entry, names, currentSchemaId, schemaIdsByFile, seen)),
  ];
}

function requireKnownProperties(schema, required) {
  if (schema === true || schema === false || schema?.properties === undefined) return schema;
  const inherited = Object.keys(schema.properties).filter((name) => required.has(name));
  if (inherited.length === 0) return schema;
  return { ...schema, required: [...new Set([...(schema.required ?? []), ...inherited])] };
}

function expandConditionalObject(schema, names, currentSchemaId, schemaIdsByFile) {
  if (!Array.isArray(schema.allOf) && schema.if === undefined) return [schema];
  const {
    allOf = [],
    if: condition,
    then: accepted,
    else: rejected,
    ...baseSchema
  } = schema;
  let variants = [{ ...baseSchema, properties: { ...(baseSchema.properties ?? {}) } }];
  if (condition !== undefined) {
    const directConditional = { if: condition, then: accepted, else: rejected };
    const hasFiniteDiscriminator = conditionalDiscriminatorValues(
      variants[0],
      directConditional,
      names,
      currentSchemaId,
      schemaIdsByFile,
    ) !== undefined;
    if (!hasFiniteDiscriminator) return variants;
    variants = variants.flatMap((variant) => applyConditionalObjectConstraint(
      variant,
      directConditional,
      names,
      currentSchemaId,
      schemaIdsByFile,
    ));
  }
  for (const constraint of allOf) {
    variants = variants.flatMap((variant) => applyObjectConstraint(variant, constraint, names, currentSchemaId, schemaIdsByFile));
  }
  return variants;
}

function applyObjectConstraint(base, constraint, names, currentSchemaId, schemaIdsByFile) {
  if (constraint === true || constraint === undefined) return [base];
  if (constraint === false) return [];
  if (constraint.$ref !== undefined) {
    const reference = resolveReferenceId(constraint.$ref, currentSchemaId, schemaIdsByFile);
    const target = names.get(reference);
    if (target === undefined) throw new Error(`Unresolved declaration reference '${constraint.$ref}' from '${currentSchemaId}'.`);
    if (target.schema.if !== undefined || Array.isArray(target.schema.allOf)) {
      return applyObjectConstraint(base, target.schema, names, currentSchemaId, schemaIdsByFile);
    }
    return [{ allOf: [base, constraint] }];
  }
  if (Array.isArray(constraint.allOf)) {
    return constraint.allOf.reduce(
      (variants, entry) => variants.flatMap((variant) => applyObjectConstraint(variant, entry, names, currentSchemaId, schemaIdsByFile)),
      [base],
    );
  }
  const alternatives = constraint.oneOf ?? constraint.anyOf;
  if (Array.isArray(alternatives)) {
    return alternatives.flatMap((entry) => applyObjectConstraint(base, entry, names, currentSchemaId, schemaIdsByFile));
  }
  if (constraint.not !== undefined) return applyNegatedObjectConstraint(base, constraint.not);
  if (constraint.if !== undefined) {
    const { if: condition, then: accepted, else: rejected, ...baseConstraint } = constraint;
    const constrainedBase = mergeObjectConstraint(base, baseConstraint);
    return applyConditionalObjectConstraint(
      constrainedBase,
      { if: condition, then: accepted, else: rejected },
      names,
      currentSchemaId,
      schemaIdsByFile,
    );
  }
  return [mergeObjectConstraint(base, constraint)];
}

function applyConditionalObjectConstraint(base, constraint, names, currentSchemaId, schemaIdsByFile) {
    const discriminator = Object.keys(constraint.if?.properties ?? {})[0];
    const expected = discriminator === undefined ? undefined : constraint.if.properties[discriminator]?.const;
    const discriminatorRequired = discriminator !== undefined
      && ((constraint.if.required ?? []).includes(discriminator) || (base.required ?? []).includes(discriminator));
    if (discriminator !== undefined && base.properties?.[discriminator] === false) {
      return applyObjectConstraint(base, constraint.else, names, currentSchemaId, schemaIdsByFile);
    }
    const choices = discriminator === undefined
      ? undefined
      : resolvedLiteralValues(base.properties?.[discriminator], names, currentSchemaId, schemaIdsByFile);
    if (discriminator === undefined || expected === undefined || !discriminatorRequired || choices === undefined) {
      throw new Error(`Unsupported object conditional for discriminator '${discriminator ?? "unknown"}'.`);
    }
    const rejected = choices.filter((value) => value !== expected);
    const variants = [];
    if (choices.includes(expected)) {
      const accepted = mergeObjectConstraint(base, {
        properties: { [discriminator]: { const: expected } },
        required: [discriminator],
      });
      variants.push(...applyObjectConstraint(accepted, constraint.then, names, currentSchemaId, schemaIdsByFile));
    }
    if (rejected.length > 0) {
      const alternative = mergeObjectConstraint(base, {
        properties: { [discriminator]: literalSchema(rejected) },
        required: [discriminator],
      });
      variants.push(...applyObjectConstraint(alternative, constraint.else, names, currentSchemaId, schemaIdsByFile));
    }
    if (!(base.required ?? []).includes(discriminator) && (constraint.if.required ?? []).includes(discriminator)) {
      variants.push(...applyObjectConstraint(
        forbidObjectProperty(base, discriminator),
        constraint.else,
        names,
        currentSchemaId,
        schemaIdsByFile,
      ));
    }
    return variants;
}

function conditionalDiscriminatorValues(base, constraint, names, currentSchemaId, schemaIdsByFile) {
  const discriminator = Object.keys(constraint.if?.properties ?? {})[0];
  return discriminator === undefined
    ? undefined
    : resolvedLiteralValues(base.properties?.[discriminator], names, currentSchemaId, schemaIdsByFile);
}

function resolvedLiteralValues(schema, names, currentSchemaId, schemaIdsByFile, seen = new Set()) {
  if (schema === undefined || schema === true || schema === false || seen.has(schema)) return undefined;
  seen.add(schema);
  if (schema.$ref !== undefined) {
    const reference = resolveReferenceId(schema.$ref, currentSchemaId, schemaIdsByFile);
    const target = names.get(reference);
    if (target === undefined) throw new Error(`Unresolved declaration reference '${schema.$ref}' from '${currentSchemaId}'.`);
    return resolvedLiteralValues(target.schema, names, currentSchemaId, schemaIdsByFile, seen);
  }
  if (Array.isArray(schema.allOf)) {
    const sets = schema.allOf
      .map((entry) => resolvedLiteralValues(entry, names, currentSchemaId, schemaIdsByFile, seen))
      .filter((values) => values !== undefined);
    if (sets.length === 0) return undefined;
    return sets.slice(1).reduce(
      (values, candidate) => values.filter((value) => candidate.some((entry) => entry === value)),
      sets[0],
    );
  }
  return literalValues(schema);
}

function applyNegatedObjectConstraint(base, negated) {
  if (Array.isArray(negated.anyOf)) {
    return negated.anyOf.reduce(
      (variants, entry) => variants.flatMap((variant) => applyNegatedObjectConstraint(variant, entry)),
      [base],
    );
  }
  const required = negated.required ?? [];
  const constrainedProperties = Object.keys(negated.properties ?? {});
  if (required.length === 1 && constrainedProperties.length === 0) {
    return [forbidObjectProperty(base, required[0])];
  }
  if (required.length === 1 && constrainedProperties.length === 1 && required[0] === constrainedProperties[0]) {
    const property = required[0];
    const allowed = literalValues(base.properties?.[property]);
    const excluded = literalValues(negated.properties[property]);
    if (allowed === undefined || excluded === undefined) {
      throw new Error(`Unsupported negated constraint for property '${property}'.`);
    }
    const remaining = allowed.filter((value) => !excluded.some((candidate) => candidate === value));
    if (remaining.length === 0) return [];
    return [mergeObjectConstraint(base, { properties: { [property]: literalSchema(remaining) } })];
  }
  throw new Error("Unsupported negated object constraint.");
}

function mergeObjectConstraint(base, constraint) {
  const properties = { ...(base.properties ?? {}) };
  for (const [name, value] of Object.entries(constraint?.properties ?? {})) {
    properties[name] = intersectSchemas(properties[name], value);
  }
  return {
    ...base,
    ...constraint,
    properties,
    required: [...new Set([...(base.required ?? []), ...(constraint?.required ?? [])])],
  };
}

function forbidObjectProperty(base, property) {
  return {
    ...base,
    properties: { ...(base.properties ?? {}), [property]: false },
  };
}

function intersectSchemas(left, right) {
  if (left === undefined || left === true) return right;
  if (right === undefined || right === true) return left;
  if (left === false || right === false) return false;
  const leftValues = literalValues(left);
  const rightValues = literalValues(right);
  if (leftValues !== undefined && rightValues !== undefined) {
    const intersection = leftValues.filter((value) => rightValues.some((candidate) => candidate === value));
    return intersection.length === 0 ? false : literalSchema(intersection);
  }
  return { allOf: [left, right] };
}

function literalValues(schema) {
  if (schema === undefined || schema === true || schema === false) return undefined;
  if (schema.const !== undefined) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  if (schema.type === "boolean") return [false, true];
  if (Array.isArray(schema.allOf)) {
    const sets = schema.allOf.map(literalValues).filter((values) => values !== undefined);
    if (sets.length === 0) return undefined;
    return sets.slice(1).reduce(
      (values, candidate) => values.filter((value) => candidate.some((entry) => entry === value)),
      sets[0],
    );
  }
  return undefined;
}

function literalSchema(values) {
  return values.length === 1 ? { const: values[0] } : { enum: values };
}

function resolveReferenceId(reference, currentSchemaId, schemaIdsByFile) {
  if (reference.startsWith("#")) return `${currentSchemaId}${reference}`;
  if (reference.startsWith("https://")) return reference;
  const [fileName, fragment = ""] = reference.split("#", 2);
  const targetId = schemaIdsByFile.get(fileName);
  return targetId === undefined ? reference : `${targetId}${fragment.length === 0 ? "" : `#${fragment}`}`;
}

function scalarType(type) {
  return type === "integer" || type === "number" ? "number"
    : type === "string" ? "string"
      : type === "boolean" ? "boolean"
        : type === "null" ? "null"
          : "unknown";
}

function parenthesize(value) { return value.includes(" | ") || value.includes(" & ") ? `(${value})` : value; }
function typeName(value) {
  const normalized = value.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_match, _prefix, letter) => letter.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
  if (normalized.length === 0) throw new Error(`Cannot derive a TypeScript declaration name from '${value}'.`);
  return /^[A-Za-z]/.test(normalized) ? normalized : `Type${normalized}`;
}
function schemaNamespaceName(fileName) { return typeName(fileName.replace(/\.schema\.json$/, "")).replace(/^Visualbridge/, "VisualBridge"); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function compareOrdinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function compareJsonValues(left, right) { return compareOrdinal(JSON.stringify(left), JSON.stringify(right)); }
