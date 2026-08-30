import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  McpDocumentAdapterRegistry,
  type DocumentCatalogRequest,
  type DocumentRequest,
} from "./documentAdapterRegistry.js";
import { EntityService } from "./entityService.js";
import { GraphService } from "./graphService.js";
import {
  DocumentLifecycleService,
  type DocumentLifecycleHostRequest,
} from "./lifecycleService.js";
import { pageItems } from "./pagination.js";
import { readProjectProviderAuthorization } from "./providerAuthorization.js";
import { McpProjectProviderService } from "./projectProviderService.js";
import { VisualBridgeMcpError, VisualBridgeWorkspace } from "./projectWorkspace.js";
import { ReferenceRefactorService } from "./refactorService.js";
import { VisualBridgeReferenceService, referenceDefinition } from "./referenceService.js";
import { StructuredService } from "./structuredService.js";
import { TableService } from "./tableService.js";

const CONTRACT_VERSION = 2 as const;
const workspaceRoot = process.env.VISUALBRIDGE_WORKSPACE === undefined
  ? process.cwd()
  : path.resolve(process.env.VISUALBRIDGE_WORKSPACE);
const workspace = await VisualBridgeWorkspace.create(workspaceRoot);
const providerService = new McpProjectProviderService(
  workspace,
  readProjectProviderAuthorization(process.env),
);
const tableService = new TableService(workspace);
const referenceService = new VisualBridgeReferenceService(workspace, tableService, providerService);
tableService.setReferenceService(referenceService);
const graphService = new GraphService(workspace, referenceService);
const entityService = new EntityService(workspace, referenceService);
const structuredService = new StructuredService(workspace, referenceService);
const refactorService = new ReferenceRefactorService(workspace, referenceService, tableService);
const lifecycleService = new DocumentLifecycleService(workspace, referenceService, tableService);
const adapters = new McpDocumentAdapterRegistry([
  {
    editor: "entity",
    queryCatalog: (request) => entityService.queryCatalog(request),
    executeDocument: (request) => entityService.executeDocument(request),
  },
  {
    editor: "graph",
    queryCatalog: (request) => graphService.queryCatalog(request),
    executeDocument: (request) => graphService.executeDocument(request),
  },
  {
    editor: "structured",
    queryCatalog: (request) => structuredService.queryCatalog(request),
    executeDocument: (request) => structuredService.executeDocument(request),
  },
  {
    editor: "table",
    queryCatalog: (request) => tableService.queryCatalog(request),
    executeDocument: (request) => tableService.executeDocument(request),
  },
]);

function createServer(): McpServer {
  const server = new McpServer(
    { name: "visualbridge", version: "2.0.0" },
    {
      instructions:
        "Discover the VisualBridge Project, then use its exact projectFile, projectId, documentTypeId, editor, and normalized path selectors. Catalog and Document tools are read-only. In-document edits use visualbridge_apply_operations with the exact baseHash returned by Document read/validate. Create, copy, path move, and safe delete use visualbridge_document_lifecycle preview followed by apply with the exact returned plan and dependency manifests. Conflicts and invalid operations are structured results and are never retried with stale state.",
    },
  );

  server.registerTool(
    "visualbridge_project",
    {
      title: "Discover and inspect VisualBridge Projects",
      description:
        "Discovers Projects, reads one Project definition and adapter capabilities, or lists its declared semantic documents with stable cursor pagination.",
      inputSchema: projectInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ action, projectFile, editor, documentTypeId, query, cursor, limit }) => handle(async () => {
      if (action === "discover") {
        const discovery = await workspace.discoverProjects();
        return {
          projects: discovery.projects.map((project) => ({
            projectFile: project.projectFile,
            projectId: project.definition.projectId,
            formatVersion: project.definition.formatVersion,
          })),
          issues: discovery.issues,
        };
      }
      if (projectFile === undefined) {
        throw new VisualBridgeMcpError("project.selectorRequired", `${action} requires projectFile.`);
      }
      const project = await workspace.resolveProject(projectFile);
      if (action === "read") {
        return {
          projectFile: project.projectFile,
          definition: project.definition,
          documentTypes: project.definition.documentTypes.map((documentType) => ({
            ...documentType,
            adapterAvailable: adapters.get(documentType.editor) !== undefined,
          })),
          supportedEditors: adapters.listEditors(),
          projectProviders: {
            enabled: providerService.authorization.enabled,
            declared: project.definition.providers.map((provider) => ({
              id: provider.id,
              entry: provider.entry,
              capabilities: provider.capabilities,
            })),
          },
        };
      }
      const declared = await workspace.listDeclaredDocuments(project);
      const normalizedQuery = query.toLocaleLowerCase();
      const results = declared
        .filter((entry) => editor === undefined || entry.documentType.editor === editor)
        .filter((entry) => documentTypeId === undefined || entry.documentType.id === documentTypeId)
        .filter((entry) => normalizedQuery.length === 0 || entry.path.toLocaleLowerCase().includes(normalizedQuery))
        .map((entry) => ({
          projectFile: entry.project.projectFile,
          documentTypeId: entry.documentType.id,
          editor: entry.documentType.editor,
          path: entry.path,
          adapterAvailable: adapters.get(entry.documentType.editor) !== undefined,
        }));
      const page = pageItems(results, cursor, limit, {
        tool: "visualbridge_project",
        action,
        projectFile: project.projectFile,
        editor,
        documentTypeId,
        query,
      });
      return { query, results: page.items, nextCursor: page.nextCursor };
    }),
  );

  server.registerTool(
    "visualbridge_catalog",
    {
      title: "Read or search a VisualBridge Catalog Registry",
      description:
        "Uses the Project-selected built-in adapter to read one Registry section or search Catalog definitions. Catalog search is distinct from Document instance search.",
      inputSchema: catalogInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ action, projectFile, documentTypeId, editor, kind, query, cursor, limit, selector }) =>
      handle(async () => {
        const resolved = await workspace.resolveDocumentType(editor, projectFile, documentTypeId);
        const adapter = adapters.require(resolved.documentType.editor);
        const request: DocumentCatalogRequest = {
          action,
          projectFile: resolved.project.projectFile,
          documentTypeId: resolved.documentType.id,
          ...(kind === undefined ? {} : { kind }),
          query,
          ...(cursor === undefined ? {} : { cursor }),
          limit,
          selector,
        };
        return adapter.queryCatalog(request);
      }),
  );

  server.registerTool(
    "visualbridge_document",
    {
      title: "Read, search or validate a VisualBridge Document",
      description:
        "Routes a declared path through its Project Document Type and shared built-in adapter. Search queries semantic instances; read and validate return the authoritative physical baseHash and diagnostics.",
      inputSchema: documentInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ action, projectFile, documentTypeId, editor, path: documentPath, query, cursor, limit, selector }) =>
      handle(async () => {
        const resolved = await workspace.resolveDocument(documentPath, editor, projectFile, documentTypeId);
        const adapter = adapters.require(resolved.documentType.editor);
        const request: DocumentRequest = {
          action,
          projectFile: resolved.project.projectFile,
          documentTypeId: resolved.documentType.id,
          path: resolved.path,
          query,
          ...(cursor === undefined ? {} : { cursor }),
          limit,
          selector,
        };
        return adapter.executeDocument(request);
      }),
  );

  server.registerTool(
    "visualbridge_apply_operations",
    {
      title: "Atomically apply VisualBridge Document Operations",
      description:
        "Routes one ordered, non-empty Operation batch through the declared Document Type. Requires the exact physical baseHash and rejects conflicts or invalid batches without partial semantic writes.",
      inputSchema: applyOperationsInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ projectFile, documentTypeId, editor, path: documentPath, baseHash, operations }) =>
      handle(async () => {
        const resolved = await workspace.resolveDeclaredDocument(documentPath, editor, projectFile, documentTypeId);
        const adapter = adapters.require(resolved.documentType.editor);
        return adapter.executeDocument({
          action: "apply",
          projectFile: resolved.project.projectFile,
          documentTypeId: resolved.documentType.id,
          path: resolved.path,
          query: "",
          limit: 1,
          selector: {},
          baseHash,
          operations,
        });
      }),
  );

  server.registerTool(
    "visualbridge_references",
    {
      title: "Search or resolve VisualBridge references",
      description:
        "Uses the shared project Reference Service to search candidates or resolve one typed stable value without relying on filenames or display names.",
      inputSchema: referenceInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ projectFile, action, kind, target, allowMissing, query, value, limit, cursor }) => handle(() =>
      referenceService.query({
        projectFile,
        action,
        definition: referenceDefinition(kind, target, allowMissing),
        ...(query === undefined ? {} : { query }),
        ...(value === undefined ? {} : { value }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      })),
  );

  server.registerTool(
    "visualbridge_refactor_reference",
    {
      title: "Preview or apply a VisualBridge reference refactor",
      description:
        "Renames one uniquely resolved stable value and all exact semantic references. Apply requires the complete previewHash and baseHashes manifest and performs an atomic project transaction.",
      inputSchema: refactorInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ projectFile, action, kind, target, oldValue, newValue, previewHash, baseHashes }) => handle(() =>
      refactorService.execute({
        projectFile,
        action,
        definition: referenceDefinition(kind, target, false),
        oldValue,
        newValue,
        ...(previewHash === undefined ? {} : { previewHash }),
        ...(baseHashes === undefined ? {} : { baseHashes }),
      })),
  );

  server.registerTool(
    "visualbridge_document_lifecycle",
    {
      title: "Preview or apply a VisualBridge Document Lifecycle operation",
      description:
        "Creates, copies, path-moves, or safely deletes a declared Document or supported contained target. Apply requires the exact canonical preview payload, base hashes, and Project/Catalog/index dependencies, then commits every physical mutation atomically.",
      inputSchema: documentLifecycleInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (request) => handle(() => lifecycleService.execute(request as DocumentLifecycleHostRequest)),
  );

  return server;
}

const stableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const normalizedPath = z.string().min(1).max(1024).refine(
  (value) => !value.includes("\\") && !value.includes(":") && !value.startsWith("/")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  "Expected a normalized project-relative path using '/' separators.",
);
const cursorSchema = z.string().min(1).max(256).optional();
const referenceCursorSchema = z.string().min(1).max(256 * 1024).optional();
const selectorSchema = z.record(z.string(), z.json()).default({});
const operationSchema = z.object({ type: stableId }).loose();
const toolOutputSchema = z.discriminatedUnion("status", [
  z.object({
    contractVersion: z.literal(CONTRACT_VERSION),
    status: z.enum(["ok", "preview", "applied", "unchanged", "invalid", "blocked", "conflict"]),
    data: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    contractVersion: z.literal(CONTRACT_VERSION),
    status: z.literal("error"),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }).strict(),
  }).strict(),
]);

const projectInputSchema = z.object({
  action: z.enum(["discover", "read", "listDocuments"]),
  projectFile: normalizedPath.optional(),
  editor: stableId.optional(),
  documentTypeId: stableId.optional(),
  query: z.string().max(512).default(""),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(200).default(50),
}).strict().superRefine((value, context) => {
  if (value.action !== "discover" && value.projectFile === undefined) {
    context.addIssue({ code: "custom", path: ["projectFile"], message: `${value.action} requires projectFile.` });
  }
});

const catalogInputSchema = z.object({
  action: z.enum(["read", "search"]),
  projectFile: normalizedPath,
  documentTypeId: stableId,
  editor: stableId,
  kind: stableId.optional(),
  query: z.string().max(512).default(""),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(200).default(50),
  selector: selectorSchema,
}).strict().superRefine((value, context) => {
  if (value.action === "search" && value.kind === undefined) {
    context.addIssue({ code: "custom", path: ["kind"], message: "Catalog search requires a searchable kind." });
  }
});

const documentInputSchema = z.object({
  action: z.enum(["read", "search", "validate"]),
  projectFile: normalizedPath,
  documentTypeId: stableId,
  editor: stableId,
  path: normalizedPath,
  query: z.string().max(512).default(""),
  cursor: cursorSchema,
  limit: z.number().int().min(1).max(1000).default(100),
  selector: selectorSchema,
}).strict();

const applyOperationsInputSchema = z.object({
  projectFile: normalizedPath,
  documentTypeId: stableId,
  editor: stableId,
  path: normalizedPath,
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  operations: z.array(operationSchema).min(1),
}).strict();

const referenceInputSchema = z.object({
  projectFile: normalizedPath,
  action: z.enum(["search", "resolve"]),
  kind: stableId,
  target: z.record(z.string(), z.json()).default({}),
  allowMissing: z.boolean().default(false),
  query: z.string().max(512).optional(),
  value: z.union([z.string(), z.number().finite()]).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: referenceCursorSchema,
}).strict().superRefine((value, context) => {
  if (value.action === "resolve" && value.value === undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: "Resolve requires value." });
  }
  if (value.action === "resolve" && value.cursor !== undefined) {
    context.addIssue({ code: "custom", path: ["cursor"], message: "Resolve does not accept cursor." });
  }
});

const refactorInputSchema = z.object({
  projectFile: normalizedPath,
  action: z.enum(["preview", "apply"]),
  kind: z.enum(["document", "entity.component", "graph.element", "table.row"]),
  target: z.record(z.string(), z.json()),
  oldValue: z.union([z.string(), z.number().finite()]),
  newValue: z.union([z.string(), z.number().finite()]),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  baseHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
}).strict().superRefine((value, context) => {
  if (typeof value.oldValue !== typeof value.newValue) {
    context.addIssue({ code: "custom", path: ["newValue"], message: "Reference value type must not change." });
  }
  if (value.action === "apply" && value.previewHash === undefined) {
    context.addIssue({ code: "custom", path: ["previewHash"], message: "Apply requires previewHash." });
  }
  if (value.action === "apply" && value.baseHashes === undefined) {
    context.addIssue({ code: "custom", path: ["baseHashes"], message: "Apply requires every source baseHash." });
  }
});

const lifecycleSelectorBase = {
  projectId: stableId,
  documentTypeId: stableId,
  path: normalizedPath,
};
const lifecycleSelectorSchema = z.object({
  ...lifecycleSelectorBase,
  editor: z.enum(["graph", "entity", "structured", "table"]),
}).strict();
const stableIdentityValueSchema = z.union([z.string().max(4096), z.number().finite()]);
const stableIdentityRemapSchema = z.object({
  identityKey: z.string().min(1).max(1024),
  from: stableIdentityValueSchema,
  to: stableIdentityValueSchema,
}).strict().superRefine((value, context) => {
  if (typeof value.from !== typeof value.to) {
    context.addIssue({ code: "custom", path: ["to"], message: "Stable identity value type must not change." });
  }
});
const lifecycleCreateOperationSchema = z.union([
  z.object({
    kind: z.literal("create"),
    target: z.object({ ...lifecycleSelectorBase, editor: z.literal("graph") }).strict(),
    parameters: z.object({
      documentId: stableId,
      rootGraphId: stableId,
      graphTypeId: stableId.optional(),
      initialNodeIds: z.array(stableId).default([]),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("create"),
    target: z.object({ ...lifecycleSelectorBase, editor: z.literal("entity") }).strict(),
    parameters: z.object({
      documentId: stableId,
      entityTypeId: stableId,
      title: z.string().min(1).max(512).optional(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("create"),
    target: z.object({ ...lifecycleSelectorBase, editor: z.literal("structured") }).strict(),
    parameters: z.object({ documentId: stableId }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("create"),
    target: z.object({ ...lifecycleSelectorBase, editor: z.literal("table") }).strict(),
    parameters: z.union([
      z.object({
        format: z.literal("csv"),
        physicalName: z.string().min(1).max(255).optional(),
      }).strict(),
      z.object({ format: z.literal("xlsx") }).strict(),
    ]),
  }).strict(),
]);
const lifecycleCopyOperationSchema = z.object({
  kind: z.literal("copy"),
  source: lifecycleSelectorSchema,
  target: lifecycleSelectorSchema,
  stableIdRemap: z.array(stableIdentityRemapSchema).max(100_000),
}).strict();
const lifecycleMoveOperationSchema = z.object({
  kind: z.literal("move"),
  source: lifecycleSelectorSchema,
  target: lifecycleSelectorSchema,
}).strict();
const lifecycleDeleteTargetSchema = z.union([
  z.object({ kind: z.literal("document") }).strict(),
  z.object({ kind: z.literal("entity.component"), componentId: stableId }).strict(),
  z.object({
    kind: z.literal("graph.element"),
    graphId: stableId,
    elementKind: z.literal("graph"),
    elementId: stableId,
  }).strict(),
  z.object({
    kind: z.literal("graph.element"),
    graphId: stableId,
    elementKind: z.enum(["node", "interfacePort"]),
    elementId: stableId,
  }).strict(),
  z.object({
    kind: z.literal("graph.element"),
    graphId: stableId,
    elementKind: z.literal("dynamicPort"),
    elementId: stableId,
    nodeId: stableId,
  }).strict(),
  z.object({
    kind: z.literal("table.row"),
    sheetId: z.string().min(1).max(1024),
    rowId: z.string().min(1).max(1024),
  }).strict(),
]);
const lifecycleDeleteOperationSchema = z.object({
  kind: z.literal("delete"),
  source: lifecycleSelectorSchema,
  target: lifecycleDeleteTargetSchema,
}).strict();
const lifecycleOperationSchema = z.union([
  lifecycleCreateOperationSchema,
  lifecycleCopyOperationSchema,
  lifecycleMoveOperationSchema,
  lifecycleDeleteOperationSchema,
]);
const lifecycleDependencySchema = z.object({
  kind: z.enum(["project", "catalog", "documentSet", "referenceIndex"]),
  key: z.string().min(1).max(1024),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  paths: z.array(normalizedPath).max(100_000),
}).strict();
const documentLifecycleInputSchema = z.object({
  action: z.enum(["preview", "apply"]),
  projectFile: normalizedPath,
  operation: lifecycleOperationSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  planPayload: z.string().min(1).max(16 * 1024 * 1024).optional(),
  baseHashes: z.record(normalizedPath, z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  dependencies: z.array(lifecycleDependencySchema).max(100_000).optional(),
}).strict().superRefine((value, context) => {
  const applyFields = ["previewHash", "planPayload", "baseHashes", "dependencies"] as const;
  if (value.action === "apply") {
    for (const field of applyFields) {
      if (value[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: `Apply requires ${field}.` });
      }
    }
    return;
  }
  for (const field of applyFields) {
    if (value[field] !== undefined) {
      context.addIssue({ code: "custom", path: [field], message: `Preview does not accept ${field}.` });
    }
  }
});

async function handle(action: () => Promise<Record<string, unknown>>) {
  try {
    const result = await action();
    const status = typeof result.status === "string" && ["preview", "applied", "unchanged", "invalid", "blocked", "conflict"].includes(result.status)
      ? result.status as "preview" | "applied" | "unchanged" | "invalid" | "blocked" | "conflict"
      : "ok";
    const data = status === "ok"
      ? result
      : Object.fromEntries(Object.entries(result).filter(([key]) => key !== "status"));
    return toolResult({ contractVersion: CONTRACT_VERSION, status, data });
  } catch (errorValue) {
    const error = errorValue instanceof VisualBridgeMcpError
      ? { code: errorValue.code, message: errorValue.message, details: errorValue.details }
      : { code: "internal", message: errorValue instanceof Error ? errorValue.message : String(errorValue) };
    return toolResult({ contractVersion: CONTRACT_VERSION, status: "error", error }, true);
  }
}

function toolResult(value: z.infer<typeof toolOutputSchema>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, undefined, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

const serverHandle = serveStdio(createServer, {
  onerror: (error) => console.error(`[visualbridge-mcp] ${error.message}`),
});

let providerShutdown: Promise<void> | undefined;
const shutdownProviders = (): Promise<void> => {
  providerShutdown ??= providerService.dispose();
  return providerShutdown;
};
process.stdin.once("end", () => {
  void shutdownProviders();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdownProviders()
      .finally(() => serverHandle.close())
      .finally(() => process.exit(0));
  });
}
