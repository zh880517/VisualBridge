import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const fixtureRoot = path.join(repositoryRoot, "TestData", "GraphSemanticProject");
const serverPath = path.join(packageRoot, "dist", "server.js");

test("stdio MCP discovers, queries, validates, and atomically edits a Graph with baseHash conflicts", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-mcp-"));
  const projectRoot = path.join(temporaryRoot, "GraphSemanticProject");
  await cp(fixtureRoot, projectRoot, { recursive: true });

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  environment.VISUALBRIDGE_WORKSPACE = temporaryRoot;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "visualbridge-stdio-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "visualbridge_apply_graph_operations",
        "visualbridge_catalog",
        "visualbridge_graph",
        "visualbridge_project",
        "visualbridge_search_nodes",
        "visualbridge_validate_graph",
      ],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} must expose a structured object schema.`);
    }

    const projects = await call(client, "visualbridge_project", {});
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].projectId, "GraphSemanticProject");
    const projectFile = projects.projects[0].projectFile;

    const project = await call(client, "visualbridge_project", { projectFile });
    assert.equal(project.definition.documentTypes[0].catalogs.length, 3);

    const catalog = await call(client, "visualbridge_catalog", { projectFile, view: "summary" });
    assert.deepEqual(catalog.counts, { dataTypes: 5, graphTypes: 2, nodeTypes: 15 });

    const search = await call(client, "visualbridge_search_nodes", {
      projectFile,
      query: "legacy.step",
      graphTypeId: "legacy.root",
    });
    assert.deepEqual(search.results.map((result) => result.id), ["sample.step"]);

    const graphPath = "Graph/SemanticSample.vbgraph";
    const graph = await call(client, "visualbridge_graph", { projectFile, path: graphPath });
    assert.match(graph.baseHash, /^[a-f0-9]{64}$/);
    assert.equal(graph.document.documentId, "semantic-sample");

    const validation = await call(client, "visualbridge_validate_graph", { projectFile, path: graphPath });
    assert.equal(validation.valid, true);
    assert.equal(validation.baseHash, graph.baseHash);

    const invalidGraphFile = path.join(projectRoot, "Graph", "Invalid.vbgraph");
    await writeFile(invalidGraphFile, '{"formatVersion":3}\n', "utf8");
    const invalidValidation = await call(client, "visualbridge_validate_graph", {
      projectFile,
      path: "Graph/Invalid.vbgraph",
    });
    assert.equal(invalidValidation.valid, false);
    assert.ok(invalidValidation.diagnostics.some((diagnostic) => diagnostic.severity === "error"));

    const graphFile = path.join(projectRoot, "Graph", "SemanticSample.vbgraph");
    const beforeConflict = await readFile(graphFile, "utf8");
    const conflict = await call(client, "visualbridge_apply_graph_operations", {
      projectFile,
      path: graphPath,
      baseHash: "0".repeat(64),
      operations: [{
        type: "graph.updateGraph",
        graphId: "root",
        title: "Must Not Persist",
        properties: { priority: 2 },
      }],
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.reason, "baseHashMismatch");
    assert.equal(await readFile(graphFile, "utf8"), beforeConflict);

    const lockFile = path.join(path.dirname(graphFile), ".SemanticSample.vbgraph.visualbridge.lock");
    await writeFile(lockFile, "external writer\n", "utf8");
    const locked = await call(client, "visualbridge_apply_graph_operations", {
      projectFile,
      path: graphPath,
      baseHash: graph.baseHash,
      operations: [{
        type: "graph.updateGraph",
        graphId: "root",
        title: "Must Wait",
        properties: { priority: 2 },
      }],
    });
    assert.equal(locked.status, "conflict");
    assert.equal(locked.reason, "writeInProgress");
    assert.equal(await readFile(graphFile, "utf8"), beforeConflict);
    await unlink(lockFile);

    const applied = await call(client, "visualbridge_apply_graph_operations", {
      projectFile,
      path: graphPath,
      baseHash: graph.baseHash,
      operations: [{
        type: "graph.updateGraph",
        graphId: "root",
        title: "Updated Through MCP",
        properties: { priority: 2 },
      }],
    });
    assert.equal(applied.status, "applied");
    assert.notEqual(applied.hash, graph.baseHash);

    const staleWrite = await call(client, "visualbridge_apply_graph_operations", {
      projectFile,
      path: graphPath,
      baseHash: graph.baseHash,
      operations: [{
        type: "graph.updateGraph",
        graphId: "root",
        title: "Stale Overwrite",
        properties: { priority: 3 },
      }],
    });
    assert.equal(staleWrite.status, "conflict");

    const updated = await call(client, "visualbridge_graph", { projectFile, path: graphPath });
    assert.equal(updated.document.graphs.find((candidate) => candidate.id === "root").title, "Updated Through MCP");
    assert.equal(updated.baseHash, applied.hash);

    const invalidBatch = await call(client, "visualbridge_apply_graph_operations", {
      projectFile,
      path: graphPath,
      baseHash: updated.baseHash,
      operations: [
        { type: "graph.moveNode", graphId: "root", nodeId: "step_a", position: { x: 999, y: 999 } },
        { type: "graph.removeEdge", graphId: "root", edgeId: "missing" },
      ],
    });
    assert.equal(invalidBatch.status, "invalid");
    const afterInvalid = await call(client, "visualbridge_graph", { projectFile, path: graphPath });
    assert.equal(afterInvalid.baseHash, updated.baseHash);
    assert.deepEqual(
      afterInvalid.document.graphs
        .find((candidate) => candidate.id === "root")
        .nodes.find((candidate) => candidate.id === "step_a")
        .position,
      { x: 240, y: 0 },
    );

    const graphDirectoryEntries = await readdir(path.dirname(graphFile));
    assert.ok(!graphDirectoryEntries.some((name) => name.includes(".visualbridge")));
  } catch (error) {
    assert.fail(`${error instanceof Error ? error.stack ?? error.message : String(error)}\nMCP stderr:\n${stderr}`);
  } finally {
    await client.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, textContent(result));
  assert.equal(typeof result.structuredContent, "object", textContent(result));
  return result.structuredContent;
}

function textContent(result) {
  return result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}
