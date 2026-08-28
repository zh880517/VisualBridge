# VisualBridge MCP Server

## Scope

`Tools/VisualBridgeMcp` is the project-level stdio MCP adapter for the landed Graph authoring core. It gives an AI host a small structured API for discovering a VisualBridge Project, inspecting Graph Catalog semantics, reading and validating Graphs, finding node types, and applying GraphOperation batches.

The server is intentionally thin:

- Project File parsing comes from `@visualbridge/core`.
- Graph/Catalog parsing, multi-Catalog Registry construction, node search, validation, GraphOperation application, and deterministic serialization come from `@visualbridge/graph`.
- MCP code owns only filesystem discovery, safe project-relative path resolution, tool schemas, `baseHash` conflict checks, and the atomic file persistence adapter.

There is no standalone CLI. The current server does not implement Unity Catalog export, Unity import, Runtime compilation, Debug, Table Documents, or Provider execution.

## Process lifecycle

The AI host launches one server process per MCP session and communicates over stdin/stdout. The workspace discovery root is:

1. `VISUALBRIDGE_WORKSPACE`, when the environment variable is present.
2. Otherwise, the server process working directory.

After `npm run build`, the stdio entry is:

```text
node Tools/VisualBridgeMcp/dist/server.js
```

Stdout is reserved for MCP protocol messages. Server diagnostics go to stderr. The host should set the process working directory or environment variable instead of passing command-line arguments; this keeps the entry a stdio server rather than a separate CLI surface.

Project discovery recursively searches for `VisualBridge.project.vbjson` and skips `.git`, `.codegraph`, `node_modules`, and Unity `Library`. Invalid markers and duplicate `projectId` values are returned as project diagnostics and are not selectable project contexts.

## Stable tools

The initial surface contains six tools.

| Tool | Required input | Purpose |
| --- | --- | --- |
| `visualbridge_project` | none, or `projectFile` | List valid projects and marker diagnostics, or read one complete Project definition. |
| `visualbridge_catalog` | optional project/type selectors; `view` | Build the declared multi-Catalog Registry and query summary, Data Types, Graph Types, or Node Types. |
| `visualbridge_graph` | `path` | Read one declared `.vbgraph`, returning its semantic document, diagnostics, and SHA-256 `baseHash`. |
| `visualbridge_search_nodes` | `query` | Search shared Registry metadata and optionally apply one Graph Type's supported-Catalog and selector restrictions. |
| `visualbridge_validate_graph` | `path` | Run the shared parser, Registry, and Graph validator without writing. |
| `visualbridge_apply_graph_operations` | `path`, `baseHash`, non-empty `operations` | Apply one GraphOperation batch and persist it only when the complete transaction is valid and current. |

`projectFile` is the workspace-relative path returned by `visualbridge_project`. It can be omitted when the workspace contains exactly one valid project. Graph and Catalog tools accept an optional `documentTypeId`; it can be omitted when selection is unambiguous. All paths use `/`, are resolved below the selected Project root, and are rejected if normalization or a resolved symlink leaves that root.

Catalog views return full Registry contracts rather than reinterpreted MCP-specific node rules. Node search matches Catalog titles and IDs, node titles and IDs, aliases, category/menu path, tags, traits, and source provenance. Space-separated query terms are combined with AND. Results have deterministic display-path order and a maximum limit of 200.

## Graph write transaction

An MCP writer must first call `visualbridge_graph` or `visualbridge_validate_graph` and retain the returned `baseHash`. The write sequence is:

```text
Acquire per-file MCP lock
  -> read current bytes and compare baseHash
  -> parse Graph and build declared Catalog Registry
  -> apply the complete GraphOperation batch to a clone
  -> run complete semantic validation
  -> deterministically serialize to a same-directory temporary file
  -> flush the temporary file
  -> re-read and compare the target Hash
  -> atomically replace the target
  -> verify the persisted Hash
  -> release lock
```

The lock coordinates independent VisualBridge MCP processes. The second Hash check detects external editors that changed the source during transaction preparation. The temporary file is on the same volume and directory as the target so replacement does not expose a partially written Graph.

The tool returns one of four non-overlapping structured statuses:

- `applied`: the atomic replacement succeeded; `hash` is the new baseline.
- `unchanged`: the valid transaction serialized to the current bytes; the Hash is unchanged.
- `conflict`: the supplied baseline was stale, another MCP writer holds the lock, or the file changed before replacement. No write occurs. The caller must re-read and decide how to proceed; the server never overwrites or retries with a stale baseline.
- `invalid`: parsing, operation application, or semantic validation rejected the transaction. No write occurs and structured diagnostics explain the failure.

Unexpected project, path, Catalog, or I/O failures are MCP tool errors with a stable VisualBridge error `code`, message, and optional details.

## Validation

The fixed project under `TestData/GraphSemanticProject` is used by both semantic and stdio integration tests:

```text
npm test
```

The MCP test launches `dist/server.js` through the official client stdio transport, lists all tool schemas, queries Project/Catalog/Graph data, searches a node alias, validates the Graph, proves conflict rejection leaves bytes unchanged, commits a valid operation, rejects a stale follow-up, and proves an invalid multi-operation batch is atomic. It performs all writes against a temporary copy and does not add Unity tests.
