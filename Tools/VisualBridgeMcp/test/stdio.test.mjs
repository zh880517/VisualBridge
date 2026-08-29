import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const tableFixtureRoot = path.join(repositoryRoot, "TestData", "TableSemanticProject");
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
        "visualbridge_apply_table_operations",
        "visualbridge_catalog",
        "visualbridge_graph",
        "visualbridge_project",
        "visualbridge_references",
        "visualbridge_search_nodes",
        "visualbridge_search_table_rows",
        "visualbridge_table",
        "visualbridge_table_catalog",
        "visualbridge_validate_graph",
        "visualbridge_validate_table",
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

test("stdio MCP queries and atomically edits partitioned CSV and XLSX Tables", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-table-mcp-"));
  const projectRoot = path.join(temporaryRoot, "TableSemanticProject");
  await cp(tableFixtureRoot, projectRoot, { recursive: true });

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
  const client = new Client({ name: "visualbridge-table-stdio-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const projects = await call(client, "visualbridge_project", {});
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].projectId, "visualbridge.table-semantics");
    const projectFile = projects.projects[0].projectFile;

    const catalog = await call(client, "visualbridge_table_catalog", { projectFile, view: "summary" });
    assert.deepEqual(catalog.counts, { tableTypes: 1 });
    const catalogTypes = await call(client, "visualbridge_table_catalog", { projectFile, view: "tableTypes" });
    assert.equal(catalogTypes.tableTypes[0].id, "game.table.skills");

    const referenceSearch = await call(client, "visualbridge_references", {
      projectFile,
      action: "search",
      kind: "table.row",
      target: { tableTypeId: "game.table.skills", sheetId: "skills" },
      query: "fireball 101",
    });
    assert.ok(referenceSearch.results.length >= 1);
    assert.equal(referenceSearch.results[0].value, 101);
    assert.match(referenceSearch.results[0].title, /^101_Fireball/);
    assert.equal(referenceSearch.results[0].location.documentTypeId, "game.table.skills");

    const referenceResolution = await call(client, "visualbridge_references", {
      projectFile,
      action: "resolve",
      kind: "table.row",
      target: { tableTypeId: "game.table.skills", sheetId: "skills" },
      value: 999999,
    });
    assert.equal(referenceResolution.status, "missing");
    assert.deepEqual(referenceResolution.candidates, []);

    const csvPath = "Tables/Skills_A.csv";
    const csv = await call(client, "visualbridge_table", { projectFile, path: csvPath });
    assert.equal(csv.format, "csv");
    assert.match(csv.baseHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(csv.sources.map((source) => source.path), ["Tables/Skills_A.csv", "Tables/Skills_B.csv"]);
    assert.deepEqual(csv.sheets.map((sheet) => sheet.id), ["skills:Skills_A", "skills:Skills_B"]);

    const csvPage = await call(client, "visualbridge_table", {
      projectFile,
      path: csvPath,
      sheetId: "skills:Skills_A",
      limit: 1,
    });
    assert.equal(csvPage.page.total, 2);
    assert.equal(csvPage.page.rows[0].id, "Skills_A:key-101");
    assert.equal(csvPage.page.rows[0].cells.name, "Fireball");
    assert.equal(csvPage.page.rows[0].rawCells, undefined);

    const effectiveSearch = await call(client, "visualbridge_search_table_rows", {
      projectFile,
      path: csvPath,
      query: "fireball",
      sheetDefinitionId: "skills",
    });
    assert.equal(effectiveSearch.matchedCount, 1);
    assert.equal(effectiveSearch.results[0].sheetName, "Skills_A");
    assert.equal(effectiveSearch.results[0].displayName, "101_Fireball");

    const physicalSearch = await call(client, "visualbridge_search_table_rows", {
      projectFile,
      path: csvPath,
      query: "fireball",
      sheetDefinitionId: "skills",
      effectiveOnly: false,
    });
    assert.equal(physicalSearch.matchedCount, 2);

    const csvValidation = await call(client, "visualbridge_validate_table", { projectFile, path: csvPath });
    assert.equal(csvValidation.valid, true);
    assert.equal(csvValidation.baseHash, csv.baseHash);
    assert.ok(csvValidation.diagnostics.some((diagnostic) => diagnostic.code === "table.partitionDuplicateResolved"));

    const invalidCsvFile = path.join(projectRoot, "Tables", "Skills_Invalid.csv");
    await writeFile(invalidCsvFile, "description\nName\nInvalid\n", "utf8");
    const invalidCsvValidation = await call(client, "visualbridge_validate_table", {
      projectFile,
      path: "Tables/Skills_Invalid.csv",
    });
    assert.equal(invalidCsvValidation.valid, false);
    assert.ok(invalidCsvValidation.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
    await unlink(invalidCsvFile);

    const csvAFile = path.join(projectRoot, "Tables", "Skills_A.csv");
    const csvBFile = path.join(projectRoot, "Tables", "Skills_B.csv");
    const csvABefore = await readFile(csvAFile, "utf8");
    const csvBBefore = await readFile(csvBFile, "utf8");
    const staleCsv = await call(client, "visualbridge_apply_table_operations", {
      projectFile,
      path: csvPath,
      baseHash: "0".repeat(64),
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_B",
        rowId: "Skills_B:key-202",
        columnId: "name",
        value: "Must Not Persist",
      }],
    });
    assert.equal(staleCsv.status, "conflict");
    assert.equal(staleCsv.reason, "baseHashMismatch");
    assert.equal(await readFile(csvAFile, "utf8"), csvABefore);
    assert.equal(await readFile(csvBFile, "utf8"), csvBBefore);

    const csvCFile = path.join(projectRoot, "Tables", "Skills_C.csv");
    await writeFile(csvCFile, csvABefore.replace("101", "501").replace("102", "502"), "utf8");
    const membershipConflict = await call(client, "visualbridge_apply_table_operations", {
      projectFile,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_B",
        rowId: "Skills_B:key-202",
        columnId: "name",
        value: "Must Reject New Partition",
      }],
    });
    assert.equal(membershipConflict.status, "conflict");
    assert.equal(membershipConflict.reason, "baseHashMismatch");
    await unlink(csvCFile);

    const lockId = createHash("sha256")
      .update("game.table.skills\0game.table.skills")
      .digest("hex")
      .slice(0, 16);
    const tableLockFile = path.join(projectRoot, "Tables", `.visualbridge-table-${lockId}.lock`);
    await writeFile(tableLockFile, "external writer\n", "utf8");
    const lockedCsv = await call(client, "visualbridge_apply_table_operations", {
      projectFile,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_B",
        rowId: "Skills_B:key-202",
        columnId: "name",
        value: "Must Wait",
      }],
    });
    assert.equal(lockedCsv.status, "conflict");
    assert.equal(lockedCsv.reason, "writeInProgress");
    await unlink(tableLockFile);

    const appliedCsv = await call(client, "visualbridge_apply_table_operations", {
      projectFile,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_B",
        rowId: "Skills_B:key-202",
        columnId: "name",
        value: "Blink MCP",
      }],
    });
    assert.equal(appliedCsv.status, "applied");
    assert.notEqual(appliedCsv.hash, csv.baseHash);
    assert.equal(await readFile(csvAFile, "utf8"), csvABefore);
    assert.match(await readFile(csvBFile, "utf8"), /Blink MCP/);

    const staleAfterApply = await call(client, "visualbridge_apply_table_operations", {
      projectFile,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_B",
        rowId: "Skills_B:key-202",
        columnId: "name",
        value: "Stale Overwrite",
      }],
    });
    assert.equal(staleAfterApply.status, "conflict");

    const updatedCsv = await call(client, "visualbridge_table", { projectFile, path: csvPath });
    const csvBeforeInvalid = await readFile(csvBFile, "utf8");
    const invalidCsvBatch = await call(client, "visualbridge_apply_table_operations", {
      projectFile,
      path: csvPath,
      baseHash: updatedCsv.baseHash,
      operations: [
        {
          type: "table.setCell",
          sheetId: "skills:Skills_B",
          rowId: "Skills_B:key-202",
          columnId: "name",
          value: "Must Roll Back",
        },
        { type: "table.removeRow", sheetId: "skills:Skills_B", rowId: "missing" },
      ],
    });
    assert.equal(invalidCsvBatch.status, "invalid");
    assert.equal(await readFile(csvBFile, "utf8"), csvBeforeInvalid);

    const xlsxPath = "Tables/Skills.xlsx";
    const xlsx = await call(client, "visualbridge_table", {
      projectFile,
      path: xlsxPath,
      sheetId: "skills:Skills_A",
    });
    assert.equal(xlsx.format, "xlsx");
    assert.equal(xlsx.sources.length, 1);
    assert.equal(xlsx.page.rows[0].id, "Skills_A:key-301");
    assert.equal(xlsx.page.rows[0].cells.name, "Ice Bolt");
    const xlsxValidation = await call(client, "visualbridge_validate_table", { projectFile, path: xlsxPath });
    assert.equal(xlsxValidation.valid, true);

    const appliedXlsx = await call(client, "visualbridge_apply_table_operations", {
      projectFile,
      path: xlsxPath,
      baseHash: xlsx.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-301",
        columnId: "name",
        value: "Ice Bolt MCP",
      }],
    });
    assert.equal(appliedXlsx.status, "applied");
    const updatedXlsx = await call(client, "visualbridge_table", {
      projectFile,
      path: xlsxPath,
      sheetId: "skills:Skills_A",
    });
    assert.equal(updatedXlsx.page.rows[0].cells.name, "Ice Bolt MCP");
    assert.equal(updatedXlsx.baseHash, appliedXlsx.hash);

    const tableDirectoryEntries = await readdir(path.join(projectRoot, "Tables"));
    assert.ok(!tableDirectoryEntries.some((name) => name.includes(".visualbridge")));
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
