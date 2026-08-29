import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { GraphService } from "./graphService.js";
import { VisualBridgeMcpError, VisualBridgeWorkspace } from "./projectWorkspace.js";
import { TableService } from "./tableService.js";
import { VisualBridgeReferenceService, referenceDefinition } from "./referenceService.js";

const workspaceRoot = process.env.VISUALBRIDGE_WORKSPACE === undefined
  ? process.cwd()
  : path.resolve(process.env.VISUALBRIDGE_WORKSPACE);
const workspace = await VisualBridgeWorkspace.create(workspaceRoot);
const tableService = new TableService(workspace);
const referenceService = new VisualBridgeReferenceService(workspace, tableService);
tableService.setReferenceService(referenceService);
const graphService = new GraphService(workspace, referenceService);

function createServer(): McpServer {
  const server = new McpServer(
    { name: "visualbridge", version: "0.1.0" },
    {
      instructions:
        "Discover a VisualBridge Project first. Use the Reference tool for stable cross-document targets. Read or validate a Graph/Table to obtain baseHash before applying Operations. Never retry a conflict with a stale baseHash, and never edit CSV/XLSX carrier bytes outside the Table tools.",
    },
  );

  server.registerTool(
    "visualbridge_project",
    {
      title: "Discover or read VisualBridge Projects",
      description:
        "Lists valid VisualBridge Project files and diagnostics, or returns one complete project definition when projectFile is provided.",
      inputSchema: z.object({
        projectFile: z.string().optional().describe("Workspace-relative VisualBridge.project.vbjson path."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile }) => handle(async () => {
      if (projectFile === undefined) {
        const discovery = await workspace.discoverProjects();
        return {
          workspaceRoot: discovery.workspaceRoot,
          projects: discovery.projects.map((project) => ({
            projectFile: project.projectFile,
            projectId: project.definition.projectId,
            formatVersion: project.definition.formatVersion,
          })),
          issues: discovery.issues,
        };
      }
      const project = await workspace.resolveProject(projectFile);
      return {
        workspaceRoot: workspace.root,
        projectFile: project.projectFile,
        definition: project.definition,
      };
    }),
  );

  server.registerTool(
    "visualbridge_references",
    {
      title: "Search or resolve VisualBridge references",
      description:
        "Uses the shared project Reference Service to search candidates or resolve one typed stable value. Built-in table.row targets use Table Type, Sheet, and key-column semantics rather than filenames or display names.",
      inputSchema: z.object({
        projectFile: z.string().optional(),
        action: z.enum(["search", "resolve"]),
        kind: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
        target: z.record(z.string(), z.json()).default({}),
        allowMissing: z.boolean().default(false),
        query: z.string().max(512).optional(),
        value: z.union([z.string(), z.number().finite()]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }).superRefine((value, context) => {
        if (value.action === "resolve" && value.value === undefined) {
          context.addIssue({ code: "custom", path: ["value"], message: "Resolve requires value." });
        }
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, action, kind, target, allowMissing, query, value, limit }) => handle(() =>
      referenceService.query({
        ...(projectFile === undefined ? {} : { projectFile }),
        action,
        definition: referenceDefinition(kind, target, allowMissing),
        ...(query === undefined ? {} : { query }),
        ...(value === undefined ? {} : { value }),
        limit,
      })),
  );

  server.registerTool(
    "visualbridge_catalog",
    {
      title: "Query a VisualBridge Graph Catalog Registry",
      description:
        "Loads the selected Graph Document Type's Catalogs into the shared Graph Registry and returns a summary or one full definition collection.",
      inputSchema: z.object({
        projectFile: z.string().optional(),
        documentTypeId: z.string().optional(),
        view: z.enum(["summary", "dataTypes", "graphTypes", "nodeTypes"]).default("summary"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, view }) => handle(() =>
      graphService.queryCatalog(projectFile, documentTypeId, view)),
  );

  server.registerTool(
    "visualbridge_graph",
    {
      title: "Read a VisualBridge Graph",
      description:
        "Reads and parses one declared .vbgraph with its baseHash, semantic document, and shared Catalog diagnostics.",
      inputSchema: graphPathSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, path: graphPath }) => handle(() =>
      graphService.readGraph(graphPath, projectFile, documentTypeId)),
  );

  server.registerTool(
    "visualbridge_search_nodes",
    {
      title: "Search registered Graph node types",
      description:
        "Searches shared Catalog Registry metadata and optionally applies Graph Type Catalog/selector restrictions.",
      inputSchema: z.object({
        projectFile: z.string().optional(),
        documentTypeId: z.string().optional(),
        query: z.string().max(512).default(""),
        graphTypeId: z.string().optional(),
        includeSubgraphNodeTypes: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, query, graphTypeId, includeSubgraphNodeTypes, limit }) => handle(() =>
      graphService.searchNodes({
        ...(projectFile === undefined ? {} : { projectFile }),
        ...(documentTypeId === undefined ? {} : { documentTypeId }),
        ...(graphTypeId === undefined ? {} : { graphTypeId }),
        query,
        includeSubgraphNodeTypes,
        limit,
      })),
  );

  server.registerTool(
    "visualbridge_validate_graph",
    {
      title: "Validate a VisualBridge Graph",
      description:
        "Runs the shared Graph parser, Catalog Registry, and semantic validator without modifying the source file.",
      inputSchema: graphPathSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, path: graphPath }) => handle(() =>
      graphService.validateGraph(graphPath, projectFile, documentTypeId)),
  );

  server.registerTool(
    "visualbridge_apply_graph_operations",
    {
      title: "Atomically apply VisualBridge Graph Operations",
      description:
        "Applies one non-empty GraphOperation batch through shared Core semantics. Requires the exact baseHash returned by read/validate, rejects conflicts, and atomically replaces the file only after complete validation.",
      inputSchema: z.object({
        projectFile: z.string().optional(),
        documentTypeId: z.string().optional(),
        path: z.string().describe("Project-relative declared .vbgraph path using '/' separators."),
        baseHash: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact SHA-256 hash returned by a prior read or validation."),
        operations: z.array(z.unknown()).min(1).describe("Ordered GraphOperation batch applied as one transaction."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ projectFile, documentTypeId, path: graphPath, baseHash, operations }) => handle(() =>
      graphService.applyOperations({
        ...(projectFile === undefined ? {} : { projectFile }),
        ...(documentTypeId === undefined ? {} : { documentTypeId }),
        graphPath,
        baseHash,
        operations,
      })),
  );

  server.registerTool(
    "visualbridge_table_catalog",
    {
      title: "Query a VisualBridge Table Catalog Registry",
      description:
        "Loads the selected Table Document Type's Catalogs into the shared Table Registry and returns a summary or complete Table Type definitions.",
      inputSchema: z.object({
        projectFile: z.string().optional(),
        documentTypeId: z.string().optional(),
        view: z.enum(["summary", "tableTypes"]).default("summary"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, view }) => handle(() =>
      tableService.queryCatalog(projectFile, documentTypeId, view)),
  );

  server.registerTool(
    "visualbridge_table",
    {
      title: "Read a VisualBridge Table",
      description:
        "Reads a declared CSV family or XLSX workbook through the shared Table codecs. Returns the combined baseHash, source hashes, physical sheets, diagnostics, and an optional semantic row page.",
      inputSchema: tablePathSchema.extend({
        sheetId: z.string().optional().describe("Physical sheet ID returned by a prior Table read."),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, path: tablePath, sheetId, offset, limit }) => handle(() =>
      tableService.readTable({
        ...(projectFile === undefined ? {} : { projectFile }),
        ...(documentTypeId === undefined ? {} : { documentTypeId }),
        ...(sheetId === undefined ? {} : { sheetId }),
        tablePath,
        offset,
        limit,
      })),
  );

  server.registerTool(
    "visualbridge_search_table_rows",
    {
      title: "Search VisualBridge Table rows",
      description:
        "Searches semantic row display names and typed cells. By default partition duplicate policy is applied and only the effective logical rows are returned.",
      inputSchema: tablePathSchema.extend({
        query: z.string().max(512).default(""),
        sheetDefinitionId: z.string().optional().describe("Stable Sheet definition ID from the Table Catalog."),
        effectiveOnly: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, path: tablePath, query, sheetDefinitionId, effectiveOnly, limit }) =>
      handle(() => tableService.searchRows({
        ...(projectFile === undefined ? {} : { projectFile }),
        ...(documentTypeId === undefined ? {} : { documentTypeId }),
        ...(sheetDefinitionId === undefined ? {} : { sheetDefinitionId }),
        tablePath,
        query,
        effectiveOnly,
        limit,
      })),
  );

  server.registerTool(
    "visualbridge_validate_table",
    {
      title: "Validate a VisualBridge Table",
      description:
        "Runs the shared Table Catalog, CSV/XLSX codec, partition, Field, and semantic validators without modifying any source.",
      inputSchema: tablePathSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, documentTypeId, path: tablePath }) => handle(() =>
      tableService.validateTable(tablePath, projectFile, documentTypeId)),
  );

  server.registerTool(
    "visualbridge_apply_table_operations",
    {
      title: "Atomically apply VisualBridge Table Operations",
      description:
        "Applies one non-empty TableOperation batch through shared semantics. Requires the combined baseHash returned by read/validate, rejects any changed CSV partition or workbook, and stages all changed sources before replacement.",
      inputSchema: tablePathSchema.extend({
        baseHash: z.string().regex(/^[a-f0-9]{64}$/).describe("Exact combined SHA-256 baseline returned by a prior Table read or validation."),
        operations: z.array(z.unknown()).min(1).describe("Ordered TableOperation batch applied as one semantic transaction."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ projectFile, documentTypeId, path: tablePath, baseHash, operations }) => handle(() =>
      tableService.applyOperations({
        ...(projectFile === undefined ? {} : { projectFile }),
        ...(documentTypeId === undefined ? {} : { documentTypeId }),
        tablePath,
        baseHash,
        operations,
      })),
  );

  return server;
}

const graphPathSchema = z.object({
  projectFile: z.string().optional(),
  documentTypeId: z.string().optional(),
  path: z.string().describe("Project-relative declared .vbgraph path using '/' separators."),
});

const tablePathSchema = z.object({
  projectFile: z.string().optional(),
  documentTypeId: z.string().optional(),
  path: z.string().describe("Project-relative declared CSV/XLSX Table path using '/' separators."),
});

async function handle(action: () => Promise<Record<string, unknown>>) {
  try {
    return toolResult(await action());
  } catch (errorValue) {
    const error = errorValue instanceof VisualBridgeMcpError
      ? { status: "error", code: errorValue.code, message: errorValue.message, details: errorValue.details }
      : { status: "error", code: "internal", message: errorValue instanceof Error ? errorValue.message : String(errorValue) };
    return toolResult(error, true);
  }
}

function toolResult(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, undefined, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

const serverHandle = serveStdio(createServer, {
  onerror: (error) => console.error(`[visualbridge-mcp] ${error.message}`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void serverHandle.close().finally(() => process.exit(0));
  });
}
