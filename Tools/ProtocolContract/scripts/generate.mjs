import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
await verifyUnityIntegrationProfileExamples(ajv);
await verifyEditorBridgeExamples(ajv);
await verifyGraphCatalogExamples(ajv);
verifySharedFormSchemaParity(ajv);
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
const csharpConfiguration = readCSharpConfiguration(contractManifest);
const csharpText = generateCSharpContracts(schemas, csharpConfiguration);
verifyDeclarationFidelity(declarationText);
verifyCSharpFidelity(csharpText, schemas, csharpConfiguration);
await emit(path.join(generatedRoot, "schema-index.json"), indexText);
await emit(path.join(generatedRoot, "contracts.d.ts"), declarationText);
for (const output of csharpConfiguration.outputs) {
  await emit(path.join(repositoryRoot, ...output.split("/")), csharpText);
}
await compileDeclarations();
console.log(`${check ? "Checked" : "Generated"} ${schemas.length} compiled schemas and ${2 + csharpConfiguration.outputs.length} deterministic artifacts.`);

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
  await mkdir(path.dirname(target), { recursive: true });
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

async function verifyUnityIntegrationProfileExamples(compiler) {
  const profileId = "https://visualbridge.dev/schema/visualbridge-unity-integration-profile.schema.json";
  const validator = requireValidator(compiler, profileId);
  const fixturePath = path.join(
    repositoryRoot,
    "Packages",
    "com.kyle.visualbridge",
    "Tests",
    "Fixtures",
    "visualbridge-unity-integration-profile-cases.json",
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(Array.isArray(fixture.cases), true, "Unity Integration Profile parity fixture must declare cases.");
  assert.equal(fixture.cases.length > 0, true, "Unity Integration Profile parity fixture must not be empty.");
  for (const testCase of fixture.cases) {
    assert.equal(typeof testCase.label, "string", "Unity Integration Profile fixture case requires a label.");
    assert.equal(typeof testCase.valid, "boolean", `${testCase.label} requires a boolean valid flag.`);
    assert.equal(
      validator(testCase.value),
      testCase.valid,
      `${testCase.label} Schema parity drift: ${JSON.stringify(validator.errors)}`,
    );
    if (!testCase.valid) {
      assert.equal(typeof testCase.loaderCode, "string", `${testCase.label} requires a loaderCode.`);
    }
  }
}

async function verifyEditorBridgeExamples(compiler) {
  const bridgeId = "https://visualbridge.dev/schema/visualbridge-editor-bridge.schema.json";
  const messageValidator = requireValidator(compiler, bridgeId);
  const discoveryValidator = requireValidator(compiler, `${bridgeId}#/$defs/discoveryRecord`);
  assert.equal(contractManifest.versions.editorBridge, 1, "Editor Bridge version registry drift.");
  const bridgeSchema = schemas.find((entry) => entry.name === "visualbridge-editor-bridge.schema.json")?.schema;
  assert.equal(
    bridgeSchema?.$defs?.discoveryRecord?.properties?.formatVersion?.const,
    contractManifest.versions.editorBridge,
    "Editor Bridge discovery record format version drift.",
  );
  const fixturePath = path.join(
    repositoryRoot,
    "Packages",
    "com.kyle.visualbridge",
    "Tests",
    "Fixtures",
    "visualbridge-editor-bridge-cases.json",
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(Array.isArray(fixture.cases), true, "Editor Bridge parity fixture must declare cases.");
  assert.equal(fixture.cases.length > 0, true, "Editor Bridge parity fixture must not be empty.");
  for (const testCase of fixture.cases) {
    assert.equal(typeof testCase.label, "string", "Editor Bridge fixture case requires a label.");
    assert.equal(typeof testCase.valid, "boolean", `${testCase.label} requires a boolean valid flag.`);
    const target = testCase.target === "discoveryRecord" ? discoveryValidator : messageValidator;
    assert.equal(
      target(testCase.value),
      testCase.valid,
      `${testCase.label} Schema parity drift: ${JSON.stringify(target.errors)}`,
    );
    if (!testCase.valid) {
      assert.equal(typeof testCase.loaderCode, "string", `${testCase.label} requires a loaderCode.`);
    }
  }
}

async function verifyGraphCatalogExamples(compiler) {
  const catalogId = "https://visualbridge.dev/schema/visualbridge-graph-catalog.schema.json";
  const validator = requireValidator(compiler, catalogId);
  assert.equal(contractManifest.versions.graphCatalog, 4, "Graph Catalog version registry drift.");
  const graphSchema = schemas.find((entry) => entry.name === "visualbridge-graph-catalog.schema.json")?.schema;
  assert.equal(
    graphSchema?.properties?.formatVersion?.const,
    contractManifest.versions.graphCatalog,
    "Graph Catalog formatVersion drift.",
  );
  const fixturePath = path.join(
    repositoryRoot,
    "Packages",
    "com.kyle.visualbridge",
    "Tests",
    "Fixtures",
    "visualbridge-graph-catalog-cases.json",
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(Array.isArray(fixture.cases), true, "Graph Catalog parity fixture must declare cases.");
  assert.equal(fixture.cases.length >= 12, true, "Graph Catalog parity fixture must declare at least 12 cases.");
  for (const testCase of fixture.cases) {
    assert.equal(typeof testCase.label, "string", "Graph Catalog fixture case requires a label.");
    assert.equal(typeof testCase.valid, "boolean", `${testCase.label} requires a boolean valid flag.`);
    assert.equal(
      validator(testCase.value),
      testCase.valid,
      `${testCase.label} Schema parity drift: ${JSON.stringify(validator.errors)}`,
    );
    if (!testCase.valid) {
      assert.equal(typeof testCase.validatorCode, "string", `${testCase.label} requires a validatorCode.`);
    }
  }
}

function verifySharedFormSchemaParity(compiler) {
  const catalogSchemas = [
    "visualbridge-graph-catalog.schema.json",
    "visualbridge-entity-catalog.schema.json",
    "visualbridge-structured-catalog.schema.json",
    "visualbridge-table-catalog.schema.json",
  ];
  const schemasByName = new Map(schemas.map(({ name, schema }) => [name, schema]));
  const sharedDefinitions = [
    "identifier",
    "identifierArray",
    "nonEmptyString",
    "field",
    "valueDefinition",
    "valueType",
    "valueShape",
    "reference",
    "editorOption",
    "editor",
  ];
  const baselineSchema = schemasByName.get(catalogSchemas[0]);
  if (baselineSchema === undefined) throw new Error(`Shared Form parity schema '${catalogSchemas[0]}' is missing.`);
  for (const schemaName of catalogSchemas.slice(1)) {
    const schema = schemasByName.get(schemaName);
    if (schema === undefined) throw new Error(`Shared Form parity schema '${schemaName}' is missing.`);
    for (const definitionName of sharedDefinitions) {
      assert.deepEqual(
        schema.$defs?.[definitionName],
        baselineSchema.$defs?.[definitionName],
        `${schemaName} shared Form $defs/${definitionName} drifted from ${catalogSchemas[0]}.`,
      );
    }
  }
  const cases = [
    {
      label: "minimal scalar field",
      definition: "field",
      value: { id: "title", title: "Title", valueType: "string", defaultValue: "" },
      valid: true,
    },
    {
      label: "recursive object field",
      definition: "field",
      value: {
        id: "position",
        aliases: [],
        title: "Position",
        valueType: "object",
        defaultValue: { x: 0 },
        fields: [{ id: "x", title: "X", valueType: "number", defaultValue: 0 }],
      },
      valid: true,
    },
    {
      label: "recursive array value",
      definition: "valueDefinition",
      value: {
        valueType: "array",
        defaultValue: [null],
        item: { valueType: "json", defaultValue: null, editor: { kind: "json" } },
      },
      valid: true,
    },
    {
      label: "structured select option",
      definition: "field",
      value: {
        id: "mode",
        title: "Mode",
        valueType: "object",
        defaultValue: { id: 1 },
        fields: [],
        editor: { kind: "select", options: [{ title: "One", value: { id: 1 } }] },
      },
      valid: true,
    },
    {
      label: "number reference",
      definition: "field",
      value: {
        id: "target",
        title: "Target",
        valueType: "number",
        defaultValue: 1,
        editor: { kind: "reference", integer: true },
        reference: { kind: "table.row", target: { tableTypeId: "skills" }, allowMissing: false },
      },
      valid: true,
    },
    {
      label: "whitespace field title",
      definition: "field",
      value: { id: "title", title: "   ", valueType: "string", defaultValue: "" },
      valid: false,
    },
    {
      label: "duplicate aliases",
      definition: "field",
      value: { id: "title", aliases: ["old", "old"], title: "Title", valueType: "string", defaultValue: "" },
      valid: false,
    },
    {
      label: "scalar with object fields",
      definition: "field",
      value: { id: "title", title: "Title", valueType: "string", defaultValue: "", fields: [] },
      valid: false,
    },
    {
      label: "object without fields",
      definition: "field",
      value: { id: "value", title: "Value", valueType: "object", defaultValue: {} },
      valid: false,
    },
    {
      label: "array without item",
      definition: "valueDefinition",
      value: { valueType: "array", defaultValue: [] },
      valid: false,
    },
    {
      label: "select without options",
      definition: "field",
      value: { id: "mode", title: "Mode", valueType: "string", defaultValue: "a", editor: { kind: "select" } },
      valid: false,
    },
    {
      label: "non-select with options",
      definition: "field",
      value: {
        id: "count",
        title: "Count",
        valueType: "number",
        defaultValue: 0,
        editor: { kind: "number", options: [{ title: "Zero", value: 0 }] },
      },
      valid: false,
    },
  ];

  for (const testCase of cases) {
    const results = catalogSchemas.map((schemaName) => {
      const schema = schemasByName.get(schemaName);
      if (schema === undefined) throw new Error(`Shared Form parity schema '${schemaName}' is missing.`);
      const validator = requireValidator(compiler, `${schema.$id}#/$defs/${testCase.definition}`);
      return { schemaName, valid: validator(testCase.value) };
    });
    for (const result of results) {
      assert.equal(
        result.valid,
        testCase.valid,
        `${result.schemaName} shared ${testCase.definition} disagrees for ${testCase.label}.`,
      );
    }
    assert.equal(
      new Set(results.map((result) => result.valid)).size,
      1,
      `Shared Form Schema parity drift for ${testCase.label}: ${JSON.stringify(results)}.`,
    );
  }
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
    "// 由 Protocol/Schema 生成，勿手工编辑。",
    "// 每个正式 Schema 输出为一个命名空间，包含 Root 与全部 $defs 声明。",
    "",
  ];
  for (const { name: fileName, schema, namespace } of registry.schemas) {
    lines.push(`// 来源：Protocol/Schema/${fileName}`);
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
    const header = `// 来源：Protocol/Schema/${name}\n// $id: ${schema.$id}\nexport namespace ${namespace} {`;
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

function readCSharpConfiguration(manifest) {
  const configuration = manifest.csharpGeneration;
  if (configuration === undefined || configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("contract-manifest.json must declare csharpGeneration.");
  }
  if (typeof configuration.namespace !== "string"
    || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(configuration.namespace)) {
    throw new Error("csharpGeneration.namespace must be a valid C# namespace.");
  }
  for (const [label, values] of [["schemas", configuration.schemas], ["outputs", configuration.outputs]]) {
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string")) {
      throw new Error(`csharpGeneration.${label} must be a non-empty string array.`);
    }
    assertSortedUnique(values, `C# generation ${label}`);
  }
  for (const output of configuration.outputs) {
    if (output.startsWith("/")
      || output.includes("\\")
      || output.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
      || !output.endsWith(".cs")) {
      throw new Error(`Invalid C# generated output '${output}'.`);
    }
  }
  return {
    namespace: configuration.namespace,
    schemas: [...configuration.schemas],
    outputs: [...configuration.outputs],
  };
}

function generateCSharpContracts(schemaEntries, configuration) {
  const entriesByName = new Map(schemaEntries.map((entry) => [entry.name, entry]));
  const schemaIdsByFile = new Map(schemaEntries.map((entry) => [entry.name, entry.schema.$id]));
  const registeredEntries = configuration.schemas.map((name) => {
    const entry = entriesByName.get(name);
    if (entry === undefined) throw new Error(`C# generation schema '${name}' does not exist.`);
    return entry;
  });
  const targets = new Map();
  for (const entry of registeredEntries) {
    targets.set(entry.schema.$id, { entry, name: "Root", schema: entry.schema });
    for (const [name, definition] of Object.entries(entry.schema.$defs ?? {})) {
      targets.set(`${entry.schema.$id}#/$defs/${name}`, { entry, name: typeName(name), schema: definition });
    }
  }

  const schemaModels = registeredEntries.map((entry) => buildCSharpSchemaModel(
    entry,
    configuration.namespace,
    targets,
    schemaIdsByFile,
  ));
  const lines = [
    "// <auto-generated />",
    "// 由 Tools/ProtocolContract/scripts/generate.mjs 基于 Protocol/Schema 与 contract-manifest.json 生成。",
    "// 勿直接编辑本文件。",
    "#nullable enable",
    "",
    "using System;",
    "using System.Collections.Generic;",
    "using System.Runtime.Serialization;",
    "",
    `namespace ${configuration.namespace}`,
    "{",
    "    public readonly struct VisualBridgeSchemaContract",
    "    {",
    "        public VisualBridgeSchemaContract(string file, string id, string sha256)",
    "        {",
    "            File = file;",
    "            Id = id;",
    "            Sha256 = sha256;",
    "        }",
    "",
    "        public string File { get; }",
    "        public string Id { get; }",
    "        public string Sha256 { get; }",
    "    }",
    "",
    "    public static class VisualBridgeSchemaRegistry",
    "    {",
    ...registeredEntries.map((entry) => (
      `        public const string ${schemaNamespaceName(entry.name)}Sha256 = ${csharpString(sha256(entry.bytes))};`
    )),
    "",
    "        public static readonly IReadOnlyList<VisualBridgeSchemaContract> Contracts =",
    "            new VisualBridgeSchemaContract[]",
    "            {",
    ...registeredEntries.map((entry) => (
      `                new VisualBridgeSchemaContract(${csharpString(`Schema/${entry.name}`)}, ${csharpString(entry.schema.$id)}, ${schemaNamespaceName(entry.name)}Sha256),`
    )),
    "            };",
    "    }",
    "}",
    "",
  ];
  for (const model of schemaModels) {
    if (model.declarations.length === 0) continue;
    lines.push(
      `namespace ${configuration.namespace}.${model.namespace}`,
      "{",
      `    // JSON Schema：${model.entry.schema.$id}`,
      ...model.declarations.flatMap((declaration, index) => [
        ...(index === 0 ? [] : [""]),
        ...renderCSharpClass(declaration, model),
      ]),
      "}",
      "",
    );
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function buildCSharpSchemaModel(entry, rootNamespace, targets, schemaIdsByFile) {
  const namespace = schemaNamespaceName(entry.name);
  const declarations = [];
  const declarationNames = new Map();
  const objectTypeNames = new Map();
  const model = {
    entry,
    namespace,
    rootNamespace,
    targets,
    schemaIdsByFile,
    declarations,
    declarationNames,
    objectTypeNames,
  };
  registerCSharpObject(entry.schema, "Root", model);
  for (const [name, definition] of Object.entries(entry.schema.$defs ?? {}).sort(([left], [right]) => compareOrdinal(left, right))) {
    registerCSharpObject(definition, typeName(name), model);
  }
  declarations.sort((left, right) => left.name === "Root" ? -1 : right.name === "Root" ? 1 : compareOrdinal(left.name, right.name));
  return model;
}

function registerCSharpObject(schema, suggestedName, model) {
  if (schema === undefined || schema === true || schema === false || schema.$ref !== undefined) return;
  const shape = csharpObjectShape(schema, model);
  if (shape === undefined || (shape.properties.length === 0 && shape.additionalProperties !== undefined)) return;
  const existingType = model.objectTypeNames.get(schema);
  if (existingType !== undefined) return;
  const className = typeName(suggestedName);
  const existingDeclaration = model.declarationNames.get(className);
  if (existingDeclaration !== undefined && existingDeclaration.schema !== schema) {
    throw new Error(`C# declaration name collision '${model.namespace}.${className}'.`);
  }
  const declaration = { name: className, schema, shape };
  model.declarationNames.set(className, declaration);
  model.objectTypeNames.set(schema, `${model.rootNamespace}.${model.namespace}.${className}`);
  model.declarations.push(declaration);
  for (const [propertyName, propertySchema] of shape.properties) {
    registerCSharpInlineObject(propertySchema, `${className}${typeName(propertyName)}`, model);
  }
}

function registerCSharpInlineObject(schema, suggestedName, model) {
  if (schema === undefined || schema === true || schema === false || schema.$ref !== undefined) return;
  if (schema.type === "array") {
    registerCSharpInlineObject(schema.items, `${suggestedName}Item`, model);
    return;
  }
  registerCSharpObject(schema, suggestedName, model);
}

function csharpObjectShape(schema, model) {
  const directProperties = schema.properties === undefined ? [] : Object.entries(schema.properties);
  if (schema.type === "object" || directProperties.length > 0 || schema.additionalProperties !== undefined) {
    return {
      properties: directProperties.sort(([left], [right]) => compareOrdinal(left, right)),
      required: new Set(schema.required ?? []),
      additionalProperties: schema.additionalProperties,
    };
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return undefined;
  const shapes = alternatives.map((alternative) => {
    const resolved = resolveCSharpSchema(alternative, model);
    return csharpObjectShape(resolved.schema, resolved.model);
  });
  if (shapes.some((shape) => shape === undefined)) return undefined;
  const propertySchemas = new Map();
  for (const shape of shapes) {
    for (const [name, propertySchema] of shape.properties) {
      const values = propertySchemas.get(name) ?? [];
      values.push(propertySchema);
      propertySchemas.set(name, values);
    }
  }
  const required = new Set([...shapes[0].required].filter((name) => shapes.every((shape) => shape.required.has(name))));
  return {
    properties: [...propertySchemas.entries()]
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([name, variants]) => [name, variants.length === 1 ? variants[0] : { oneOf: variants }]),
    required,
    additionalProperties: undefined,
  };
}

function resolveCSharpSchema(schema, model) {
  if (schema?.$ref === undefined) return { schema, model };
  const reference = resolveReferenceId(schema.$ref, model.entry.schema.$id, model.schemaIdsByFile);
  const target = model.targets.get(reference);
  if (target === undefined) throw new Error(`C# generation cannot resolve '${schema.$ref}' from '${model.entry.name}'.`);
  return {
    schema: target.schema,
    model: target.entry === model.entry ? model : buildCSharpReferenceModel(target.entry, model),
  };
}

function buildCSharpReferenceModel(entry, model) {
  return {
    ...model,
    entry,
    namespace: schemaNamespaceName(entry.name),
  };
}

function renderCSharpClass(declaration, model) {
  const propertyNames = new Set();
  const lines = [
    "    [DataContract]",
    `    public sealed class ${declaration.name}`,
    "    {",
  ];
  declaration.shape.properties.forEach(([jsonName, propertySchema], index) => {
    const propertyName = typeName(jsonName);
    if (propertyNames.has(propertyName)) {
      throw new Error(`C# property name collision '${model.namespace}.${declaration.name}.${propertyName}'.`);
    }
    propertyNames.add(propertyName);
    const required = declaration.shape.required.has(jsonName);
    const baseType = csharpType(propertySchema, `${declaration.name}${propertyName}`, model);
    const propertyType = required ? baseType : optionalCSharpType(baseType);
    const initializer = required ? requiredCSharpInitializer(baseType) : "";
    lines.push(
      `        [DataMember(Name = ${csharpString(jsonName)}, IsRequired = ${required ? "true" : "false"}, EmitDefaultValue = ${required ? "true" : "false"}, Order = ${index})]`,
      `        public ${propertyType} ${propertyName} { get; set; }${initializer}`,
      "",
    );
  });
  if (lines[lines.length - 1] === "") lines.pop();
  lines.push("    }");
  return lines;
}

function csharpType(schema, suggestedName, model, seen = new Set()) {
  if (schema === undefined || schema === true || schema === false) return "object?";
  if (seen.has(schema)) return "object?";
  const typeNameForObject = model.objectTypeNames.get(schema);
  if (typeNameForObject !== undefined) return typeNameForObject;
  if (schema.$ref !== undefined) {
    const reference = resolveReferenceId(schema.$ref, model.entry.schema.$id, model.schemaIdsByFile);
    const target = model.targets.get(reference);
    if (target === undefined) throw new Error(`C# generation cannot resolve '${schema.$ref}' from '${model.entry.name}'.`);
    const targetNamespace = schemaNamespaceName(target.entry.name);
    const targetModel = target.entry === model.entry ? model : buildCSharpReferenceModel(target.entry, model);
    const objectName = model.objectTypeNames.get(target.schema)
      ?? (target.entry === model.entry ? undefined : `${model.rootNamespace}.${targetNamespace}.${target.name}`);
    const targetShape = csharpObjectShape(target.schema, targetModel);
    if (targetShape !== undefined && !(targetShape.properties.length === 0 && targetShape.additionalProperties !== undefined)) {
      return objectName ?? `${model.rootNamespace}.${targetNamespace}.${target.name}`;
    }
    seen.add(schema);
    return csharpType(target.schema, target.name, targetModel, seen);
  }
  if (schema.type === "array") {
    return `IReadOnlyList<${csharpType(schema.items, `${suggestedName}Item`, model, seen)}>`;
  }
  if (schema.type === "object" || schema.additionalProperties !== undefined) {
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      return `IReadOnlyDictionary<string, ${csharpType(schema.additionalProperties, `${suggestedName}Value`, model, seen)}>`;
    }
    return model.objectTypeNames.get(schema) ?? "object?";
  }
  if (schema.const !== undefined) return csharpLiteralType(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = [...new Set(schema.enum.map(csharpLiteralType))];
    return types.length === 1 ? types[0] : "object?";
  }
  if (schema.type === "integer") return "int";
  if (schema.type === "number") return "double";
  if (schema.type === "boolean") return "bool";
  if (schema.type === "string") return "string";
  if (schema.type === "null") return "object?";
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alternatives)) {
    const variantTypes = [...new Set(alternatives
      .filter((alternative) => alternative?.type !== "null")
      .map((alternative) => csharpType(alternative, suggestedName, model, new Set(seen))))];
    return variantTypes.length === 1 ? variantTypes[0] : "object?";
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const types = [...new Set(schema.allOf.map((entry) => csharpType(entry, suggestedName, model, new Set(seen))))]
      .filter((entry) => entry !== "object?");
    return types.length === 1 ? types[0] : "object?";
  }
  return "object?";
}

function csharpLiteralType(value) {
  return typeof value === "boolean" ? "bool"
    : typeof value === "number" ? (Number.isInteger(value) ? "int" : "double")
      : typeof value === "string" ? "string"
        : "object?";
}

function optionalCSharpType(type) {
  return type.endsWith("?") ? type : `${type}?`;
}

function requiredCSharpInitializer(type) {
  if (type.endsWith("?")) return "";
  if (type.startsWith("IReadOnlyList<")) {
    return ` = Array.Empty<${type.slice("IReadOnlyList<".length, -1)}>();`;
  }
  if (type.startsWith("IReadOnlyDictionary<string, ")) {
    const valueType = type.slice("IReadOnlyDictionary<string, ".length, -1);
    return ` = new Dictionary<string, ${valueType}>();`;
  }
  return type === "string" || type.includes(".") ? " = null!;" : "";
}

function csharpString(value) {
  return JSON.stringify(value);
}

function verifyCSharpFidelity(text, schemaEntries, configuration) {
  assert.equal(text.includes("\r"), false, "Generated C# contracts must use LF line endings.");
  assert.equal(text.endsWith("\n"), true, "Generated C# contracts must end with a newline.");
  assert.equal(text.includes(`namespace ${configuration.namespace}`), true, "Generated C# namespace drift.");
  const entriesByName = new Map(schemaEntries.map((entry) => [entry.name, entry]));
  for (const name of configuration.schemas) {
    const entry = entriesByName.get(name);
    if (entry === undefined) throw new Error(`C# generation schema '${name}' does not exist.`);
    assert.equal(text.includes(`Schema/${name}`), true, `Generated C# registry is missing '${name}'.`);
    assert.equal(text.includes(entry.schema.$id), true, `Generated C# registry is missing '${entry.schema.$id}'.`);
    assert.equal(text.includes(sha256(entry.bytes)), true, `Generated C# registry is missing the Hash for '${name}'.`);
  }
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function compareOrdinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function compareJsonValues(left, right) { return compareOrdinal(JSON.stringify(left), JSON.stringify(right)); }
