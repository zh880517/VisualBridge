import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { GraphService } from "./graphService.js";
import { VisualBridgeMcpError, VisualBridgeWorkspace } from "./projectWorkspace.js";

const workspaceRoot = process.env.VISUALBRIDGE_WORKSPACE === undefined
  ? process.cwd()
  : path.resolve(process.env.VISUALBRIDGE_WORKSPACE);
const workspace = await VisualBridgeWorkspace.create(workspaceRoot);
const graphService = new GraphService(workspace);

function createServer(): McpServer {
  const server = new McpServer(
    { name: "visualbridge", version: "0.1.0" },
    {
      instructions:
        "Discover a VisualBridge Project first. Read a Graph to obtain baseHash before calling visualbridge_apply_graph_operations. Never retry a conflict with a stale baseHash.",
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

  return server;
}

const graphPathSchema = z.object({
  projectFile: z.string().optional(),
  documentTypeId: z.string().optional(),
  path: z.string().describe("Project-relative declared .vbgraph path using '/' separators."),
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
