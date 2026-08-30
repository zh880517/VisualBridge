import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const schemaPath = path.join(repositoryRoot, "Protocol", "Schema", "visualbridge-mcp-tools.schema.json");
const authoringSchemaPath = path.join(repositoryRoot, "Protocol", "Schema", "visualbridge-authoring-contracts.schema.json");
const serverPath = path.join(repositoryRoot, "Tools", "VisualBridgeMcp", "dist", "server.js");
const protocol = JSON.parse(await readFile(schemaPath, "utf8"));
const authoring = JSON.parse(await readFile(authoringSchemaPath, "utf8"));
const primitives = JSON.parse(await readFile(
  path.join(repositoryRoot, "Protocol", "Schema", "visualbridge-primitives.schema.json"),
  "utf8",
));
await readFile(serverPath);
verifyComparatorRejectsSemanticDrift();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, VISUALBRIDGE_WORKSPACE: path.join(repositoryRoot, "TestData", "GraphSemanticProject") },
  stderr: "pipe",
});
const client = new Client({ name: "visualbridge-protocol-contract-check", version: "1.0.0" });
await client.connect(transport);
try {
  const listed = await client.listTools();
  const expectedNames = Object.keys(protocol.$defs)
    .filter((name) => name.endsWith(".input"))
    .map((name) => name.slice(0, -".input".length))
    .sort(compareOrdinal);
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(compareOrdinal), expectedNames);
  for (const tool of listed.tools) {
    const expected = resolve(protocol.$defs[`${tool.name}.input`], protocol);
    const actual = tool.inputSchema;
    compareSchema(expected, actual, `${tool.name}.input`, protocol, actual);
    compareSchema(resolve(protocol.$defs[`${tool.name}.output`], protocol), tool.outputSchema, `${tool.name}.output`, protocol, tool.outputSchema);
  }
  await verifyLiveNegativeExamples(client);
  console.log(`Checked ${listed.tools.length} live MCP tool schemas against Protocol.`);
} finally {
  await client.close();
}

function resolve(schema, root) {
  if (schema?.$ref?.startsWith("#/$defs/")) {
    const name = schema.$ref.slice("#/$defs/".length);
    const owner = [root, protocol, authoring, primitives].find((candidate) => candidate.$defs?.[name] !== undefined);
    return owner === undefined ? schema : mergeReference(resolve(owner.$defs[name], owner), schema);
  }
  if (schema?.$ref?.includes("visualbridge-authoring-contracts.schema.json")) {
    return mergeReference(resolve(authoring.$defs[schema.$ref.split("#/$defs/").at(-1)], authoring), schema);
  }
  if (schema?.$ref?.includes("visualbridge-primitives.schema.json")) {
    return mergeReference(resolve(primitives.$defs[schema.$ref.split("#/$defs/").at(-1)], primitives), schema);
  }
  return schema;
}

function compareSchema(expectedValue, actualValue, contractPath, expectedRoot, actualRoot) {
  const expected = resolve(expectedValue, expectedRoot);
  const actual = resolveLocal(actualValue, actualRoot);
  if (isOpaquePayload(contractPath)) return;
  if (isDomainObjectBoundary(contractPath)) {
    assert.equal(inferredType(expected), "object", `${contractPath} formal boundary must be an object.`);
    assert.equal(inferredType(actual), "object", `${contractPath} live boundary must be an object.`);
    assert.notEqual(actual?.additionalProperties, false, `${contractPath} must admit domain-owned keys.`);
    return;
  }
  if (contractPath === "visualbridge_apply_operations.input.operations.items") {
    assert.equal(inferredType(actual), "object", `${contractPath} live adapter must advertise an object.`);
    assert.deepEqual(actual?.required, ["type"], `${contractPath} must require the operation discriminator.`);
    assert.deepEqual(Object.keys(actual?.properties ?? {}), ["type"], `${contractPath} adapter may only freeze the discriminator.`);
    compareSchema(primitives.$defs.stableId, actual.properties.type, `${contractPath}.type`, primitives, actualRoot);
    assert.notEqual(actual?.additionalProperties, false, `${contractPath} must admit domain operation fields.`);
    return;
  }
  const expectedType = inferredType(expected);
  if (expectedType !== undefined) assert.deepEqual(inferredType(actual), expectedType, `${contractPath}.type drift.`);
  for (const key of [
    "const",
    "default",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minContains",
    "maxContains",
    "minProperties",
    "maxProperties",
    "uniqueItems",
    "pattern",
  ]) {
    if (expected?.[key] !== undefined || actual?.[key] !== undefined) {
      const expectedConstraint = key === "pattern" ? normalizePattern(expected?.[key]) : expected?.[key];
      const actualConstraint = key === "pattern" ? normalizePattern(actual?.[key]) : actual?.[key];
      assert.deepEqual(actualConstraint, expectedConstraint, `${contractPath}.${key} drift.`);
    }
  }
  if (expected?.enum !== undefined || actual?.enum !== undefined) {
    assert.deepEqual(actual?.enum, expected?.enum, `${contractPath}.enum drift.`);
  }
  const expectedUnion = expected?.oneOf ?? expected?.anyOf;
  const actualUnion = actual?.oneOf ?? actual?.anyOf;
  if (expectedUnion !== undefined || actualUnion !== undefined) {
    assert.equal(Array.isArray(actualUnion), true, `${contractPath} lost its union.`);
    assert.equal(actualUnion.length, expectedUnion.length, `${contractPath} union branch drift.`);
    expectedUnion.forEach((branch, index) => compareSchema(
      branch,
      actualUnion[index],
      `${contractPath}.union[${index}]`,
      expectedRoot,
      actualRoot,
    ));
  }
  compareSchemaArrayKeyword("allOf", expected, actual, contractPath, expectedRoot, actualRoot);
  compareSchemaArrayKeyword("prefixItems", expected, actual, contractPath, expectedRoot, actualRoot);
  for (const key of ["if", "then", "else", "not", "contains"]) {
    compareSchemaKeyword(key, expected, actual, contractPath, expectedRoot, actualRoot);
  }
  if (expected?.required !== undefined || actual?.required !== undefined) {
    assert.deepEqual(
      [...(actual?.required ?? [])].sort(compareOrdinal),
      [...(expected?.required ?? [])].sort(compareOrdinal),
      `${contractPath}.required-field drift.`,
    );
  }
  if (expected?.properties !== undefined || actual?.properties !== undefined) {
    assert.deepEqual(Object.keys(actual?.properties ?? {}).sort(compareOrdinal), Object.keys(expected?.properties ?? {}).sort(compareOrdinal), `${contractPath} property drift.`);
    for (const key of Object.keys(expected.properties ?? {}).sort(compareOrdinal)) {
      compareSchema(expected.properties[key], actual.properties[key], `${contractPath}.${key}`, expectedRoot, actualRoot);
    }
  }
  if (expected?.items !== undefined || actual?.items !== undefined) {
    compareSchema(expected?.items, actual?.items, `${contractPath}.items`, expectedRoot, actualRoot);
  }
  for (const key of ["additionalProperties", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]) {
    if (expected?.[key] === undefined && actual?.[key] === undefined) continue;
    if (typeof expected?.[key] === "object" || typeof actual?.[key] === "object") {
      assert.equal(typeof expected?.[key], "object", `${contractPath}.${key} formal shape drift.`);
      assert.equal(typeof actual?.[key], "object", `${contractPath}.${key} live shape drift.`);
      compareSchema(expected[key], actual[key], `${contractPath}.${key}`, expectedRoot, actualRoot);
    } else {
      assert.deepEqual(actual?.[key], expected?.[key], `${contractPath}.${key} drift.`);
    }
  }
  for (const key of ["dependentSchemas", "patternProperties"]) {
    compareSchemaMapKeyword(key, expected, actual, contractPath, expectedRoot, actualRoot);
  }
  if (expected?.dependentRequired !== undefined || actual?.dependentRequired !== undefined) {
    assert.deepEqual(
      normalizeRequiredMap(actual?.dependentRequired),
      normalizeRequiredMap(expected?.dependentRequired),
      `${contractPath}.dependentRequired drift.`,
    );
  }
}

function compareSchemaArrayKeyword(key, expected, actual, contractPath, expectedRoot, actualRoot) {
  if (expected?.[key] === undefined && actual?.[key] === undefined) return;
  assert.equal(Array.isArray(expected?.[key]), true, `${contractPath}.${key} formal shape drift.`);
  assert.equal(Array.isArray(actual?.[key]), true, `${contractPath}.${key} live shape drift.`);
  assert.equal(actual[key].length, expected[key].length, `${contractPath}.${key} branch drift.`);
  expected[key].forEach((branch, index) => compareSchema(
    branch,
    actual[key][index],
    `${contractPath}.${key}[${index}]`,
    expectedRoot,
    actualRoot,
  ));
}

function compareSchemaKeyword(key, expected, actual, contractPath, expectedRoot, actualRoot) {
  if (expected?.[key] === undefined && actual?.[key] === undefined) return;
  assert.equal(typeof expected?.[key], "object", `${contractPath}.${key} formal shape drift.`);
  assert.equal(typeof actual?.[key], "object", `${contractPath}.${key} live shape drift.`);
  compareSchema(expected[key], actual[key], `${contractPath}.${key}`, expectedRoot, actualRoot);
}

function compareSchemaMapKeyword(key, expected, actual, contractPath, expectedRoot, actualRoot) {
  if (expected?.[key] === undefined && actual?.[key] === undefined) return;
  assert.equal(typeof expected?.[key], "object", `${contractPath}.${key} formal shape drift.`);
  assert.equal(typeof actual?.[key], "object", `${contractPath}.${key} live shape drift.`);
  const expectedKeys = Object.keys(expected[key]).sort(compareOrdinal);
  assert.deepEqual(Object.keys(actual[key]).sort(compareOrdinal), expectedKeys, `${contractPath}.${key} key drift.`);
  for (const name of expectedKeys) {
    compareSchema(expected[key][name], actual[key][name], `${contractPath}.${key}.${name}`, expectedRoot, actualRoot);
  }
}

function resolveLocal(schema, root) {
  if (schema?.$ref?.startsWith("#/$defs/")) return mergeReference(resolveLocal(root.$defs?.[schema.$ref.slice("#/$defs/".length)], root), schema);
  return schema;
}

function mergeReference(target, reference) {
  const { $ref: _reference, ...siblings } = reference;
  const merged = { ...target, ...siblings };
  if (target?.properties !== undefined && siblings.properties !== undefined) {
    merged.properties = { ...target.properties, ...siblings.properties };
  }
  if (target?.required !== undefined || siblings.required !== undefined) {
    merged.required = [...new Set([...(target?.required ?? []), ...(siblings.required ?? [])])];
  }
  return merged;
}

function inferredType(schema) {
  if (schema?.type !== undefined) return schema.type;
  const union = schema?.oneOf ?? schema?.anyOf;
  if (Array.isArray(union) && union.length > 0) {
    const branchTypes = [...new Set(union.map(inferredType))];
    if (branchTypes.length === 1) return branchTypes[0];
  }
  const values = schema?.enum ?? (schema?.const === undefined ? undefined : [schema.const]);
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const types = [...new Set(values.map((value) => value === null ? "null" : typeof value))];
  return types.length === 1 ? types[0] : undefined;
}

function isDomainObjectBoundary(value) {
  return value.endsWith(".selector")
    || value === "visualbridge_references.input.target"
    || (value.startsWith("visualbridge_refactor_reference.input.") && value.endsWith(".target"));
}

function isOpaquePayload(value) {
  return value.includes(".output.") && (value.endsWith(".data") || value.endsWith(".error.details"));
}

function compareOrdinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function normalizePattern(value) { return typeof value === "string" ? value.replaceAll("\\/", "/") : value; }

function normalizeRequiredMap(value) {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([key, required]) => [key, [...required].sort(compareOrdinal)]));
}

function verifyComparatorRejectsSemanticDrift() {
  const semanticKeywords = [
    ["allOf", [{ required: ["action"] }]],
    ["if", { properties: { action: { const: "apply" } } }],
    ["then", { required: ["previewHash"] }],
    ["else", { not: { required: ["previewHash"] } }],
    ["not", { required: ["unknown"] }],
  ];
  for (const [keyword, schema] of semanticKeywords) {
    assert.throws(
      () => compareSchema({ type: "object", [keyword]: schema }, { type: "object" }, `comparator.${keyword}`, {}, {}),
      { name: "AssertionError" },
      `Live MCP comparison must reject a dropped ${keyword} constraint.`,
    );
  }
}

async function verifyLiveNegativeExamples(client) {
  const hash = "a".repeat(64);
  const operation = {
    kind: "create",
    target: {
      projectId: "sample",
      documentTypeId: "game.graph",
      editor: "graph",
      path: "Graph/A.vbgraph",
    },
    parameters: { documentId: "graph.a", rootGraphId: "root" },
  };
  const invalidCalls = [
    {
      label: "refactor preview with apply-only fields",
      name: "visualbridge_refactor_reference",
      arguments: {
        action: "preview",
        projectFile: "VisualBridge.project.vbjson",
        kind: "document",
        target: {},
        oldValue: "old",
        newValue: "next",
        previewHash: hash,
      },
    },
    {
      label: "Lifecycle preview with apply-only fields",
      name: "visualbridge_document_lifecycle",
      arguments: {
        action: "preview",
        projectFile: "VisualBridge.project.vbjson",
        operation,
        previewHash: hash,
      },
    },
    {
      label: "normalized path with a trailing slash",
      name: "visualbridge_project",
      arguments: { action: "read", projectFile: "VisualBridge.project.vbjson/" },
    },
  ];
  for (const invalidCall of invalidCalls) {
    const result = await client.callTool({ name: invalidCall.name, arguments: invalidCall.arguments });
    assert.equal(result.isError, true, `${invalidCall.label} must be rejected before dispatch.`);
  }
}
