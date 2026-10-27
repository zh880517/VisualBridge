import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** 真实 traversal 的域边界命中计数（见 `assertDomainBoundaryCoverage`）。 */
const domainBoundaryHits = new Map();

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
verifyDomainBoundaryAnchors();

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
  domainBoundaryHits.clear();
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
  assertDomainBoundaryCoverage({ hits: domainBoundaryHits, toolCount: listed.tools.length }, "live");
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
  const boundary = domainBoundaryKind(contractPath);
  if (boundary !== undefined) {
    recordDomainBoundary(boundary);
    assert.equal(inferredType(expected), "object", `${contractPath} formal boundary must be an object.`);
    assert.equal(inferredType(actual), "object", `${contractPath} live boundary must be an object.`);
    assert.notEqual(actual?.additionalProperties, false, `${contractPath} must admit domain-owned keys.`);
    if (boundary === "deleteTarget") assertLiveDeleteTarget(expected, actual, contractPath);
    if (boundary === "createParameters") assertLiveCreateParameters(actual, contractPath);
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
      `${contractPath}.union[${unionBranchLabel(branch, expectedRoot, index)}]`,
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

/**
 * 域自有对象的边界（宿主只冻结"边界"而不冻结内部字段）。
 *
 * 定位一律用**结构锚点**（工具路径 + 判别字段 `kind` 的 const），不用 `union[n]` 下标：
 * 分支顺序可以调，语义锚点不能。
 */
function domainBoundaryKind(value) {
  if (isLifecyclePath(value) && value.endsWith("operation.union[delete].target")) return "deleteTarget";
  // B4：create 的 parameters 由模块 create facet 解释，契约只冻结"JSON 对象"。
  if (isLifecyclePath(value) && value.endsWith("operation.union[create].parameters")) return "createParameters";
  if (value.endsWith(".selector")) return "selector";
  if (value === "visualbridge_references.input.target") return "referenceTarget";
  if (value.startsWith("visualbridge_refactor_reference.input.") && value.endsWith(".target")) return "referenceTarget";
  return undefined;
}

function isLifecyclePath(value) {
  return value === "visualbridge_document_lifecycle.input"
    || value.startsWith("visualbridge_document_lifecycle.input.");
}

/** delete 目标只冻结 `kind`：live 侧丢了 `required: ["kind"]` 或属性集被撑开都必须变红。 */
function assertLiveDeleteTarget(expected, actual, contractPath) {
  assert.ok(
    Array.isArray(actual?.required) && actual.required.includes("kind"),
    `${contractPath} live schema must require 'kind'.`,
  );
  assert.deepEqual(
    Object.keys(actual?.properties ?? {}),
    ["kind"],
    `${contractPath} live schema may only freeze 'kind'.`,
  );
  compareSchema(expected?.properties?.kind, actual?.properties?.kind, `${contractPath}.kind`, authoring, actual);
}

/** create 的 parameters 是模块自有的开放 JSON 对象：live 侧不得冻结字段或要求固定键。 */
function assertLiveCreateParameters(actual, contractPath) {
  assert.deepEqual(
    Object.keys(actual?.properties ?? {}),
    [],
    `${contractPath} live schema must not freeze create parameter fields.`,
  );
  assert.deepEqual(
    actual?.required ?? [],
    [],
    `${contractPath} live schema must not require create parameter fields.`,
  );
  assert.equal(
    typeof actual?.additionalProperties,
    "object",
    `${contractPath} live schema must admit arbitrary JSON parameters.`,
  );
}

function isOpaquePayload(value) {
  return value.includes(".output.") && (value.endsWith(".data") || value.endsWith(".error.details"));
}

function compareOrdinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function normalizePattern(value) { return typeof value === "string" ? value.replaceAll("\\/", "/") : value; }

/** union 分支的路径标签：优先用判别字段的 `const`（`kind`，其次 `action`），否则退回下标。 */
function unionBranchLabel(branch, root, index) {
  const resolved = resolve(branch, root);
  const discriminator = resolved?.properties?.kind?.const ?? resolved?.properties?.action?.const;
  return typeof discriminator === "string" ? discriminator : String(index);
}

function normalizeRequiredMap(value) {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([key, required]) => [key, [...required].sort(compareOrdinal)]));
}

/**
 * 本轮真实 traversal 的域边界命中计数（B4 第 2 轮 P2-3）。
 *
 * 只用硬编码字符串自检证明不了"真实 formal schema 仍会走到这些边界"：契约结构一变，
 * 自检照样绿而覆盖已经消失。这里让自检消费真实 traversal 的计数。
 */
function recordDomainBoundary(kind) {
  domainBoundaryHits.set(kind, (domainBoundaryHits.get(kind) ?? 0) + 1);
}

function assertDomainBoundaryCoverage({ hits, toolCount }, label) {
  assert.ok(toolCount > 0, `${label} traversal must list at least one tool.`);
  const total = [...hits.values()].reduce((sum, count) => sum + count, 0);
  assert.ok(
    total > 0,
    `${label} traversal never hit a domain boundary; boundary anchors cannot be verified against real data.`,
  );
  for (const kind of ["deleteTarget", "createParameters"]) {
    assert.ok(
      (hits.get(kind) ?? 0) > 0,
      `${label} traversal must hit the '${kind}' boundary at least once (hits=${JSON.stringify([...hits])}).`,
    );
  }
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

/**
 * 边界断言自检：证明"锚点 + live 侧必填判别字段"确实能变红，而不是随结构漂移静默失效。
 */
function verifyDomainBoundaryAnchors() {
  const deletePath = "visualbridge_document_lifecycle.input.union[preview].operation.union[delete].target";
  const createPath = "visualbridge_document_lifecycle.input.union[apply].operation.union[create].parameters";
  assert.equal(domainBoundaryKind(deletePath), "deleteTarget", "The delete target must be anchored by its kind discriminator.");
  assert.equal(domainBoundaryKind(createPath), "createParameters", "Create parameters must be anchored by their kind discriminator.");
  assert.equal(
    domainBoundaryKind("visualbridge_document_lifecycle.input.union[preview].operation.union[copy].target"),
    undefined,
    "Create/copy/move targets must stay strict selectors.",
  );
  assert.throws(
    () => assertLiveDeleteTarget({ properties: { kind: {} } }, { type: "object", properties: { kind: {} }, additionalProperties: {} }, "self.check"),
    { name: "AssertionError" },
    "A live delete target that lost required:kind must fail the contract check.",
  );
  assert.throws(
    () => assertLiveCreateParameters({ type: "object", properties: { documentId: {} }, required: ["documentId"] }, "self.check"),
    { name: "AssertionError" },
    "A live create parameters schema that froze fields must fail the contract check.",
  );
  // 计数自检的牙齿：真实 traversal 若一个边界都没命中，必须整体变红。
  assert.throws(
    () => assertDomainBoundaryCoverage({ hits: new Map(), toolCount: 1 }, "self.check"),
    { name: "AssertionError" },
    "A traversal that never hits a domain boundary must fail the contract check.",
  );
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
