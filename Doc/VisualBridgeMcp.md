# VisualBridge MCP Server

## Scope

`Tools/VisualBridgeMcp` is the project-level stdio MCP adapter for the landed Graph, Structured, Table and Reference authoring cores. It gives an AI host a small structured API for discovering a VisualBridge Project, inspecting Catalog semantics, reading and validating documents, searching nodes, semantic table rows or shared references, and applying domain Operation batches.

The server is intentionally thin:

- Project File parsing comes from `@visualbridge/core`.
- Graph/Catalog parsing, multi-Catalog Registry construction, node search, validation, GraphOperation application, and deterministic serialization come from `@visualbridge/graph`.
- Table/Catalog parsing, CSV/XLSX codecs, effective partition rows, validation and TableOperation application come from `@visualbridge/table`.
- Structured Catalog/Document parsing, Project type binding, shared Field validation, reference collection, StructuredOperation application and deterministic serialization come from `@visualbridge/structured`.
- MCP code owns only filesystem discovery, safe project-relative path resolution, tool schemas, semantic result paging/search projection, `baseHash` conflict checks, and the atomic file persistence adapter.

There is no standalone CLI. The current server does not implement Unity Catalog export, Unity import, Runtime compilation, Debug, Entity Documents, or project-defined Provider execution.

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

The surface contains sixteen tools.

| Tool | Required input | Purpose |
| --- | --- | --- |
| `visualbridge_project` | none, or `projectFile` | List valid projects and marker diagnostics, or read one complete Project definition. |
| `visualbridge_catalog` | optional project/type selectors; `view` | Build the declared multi-Catalog Registry and query summary, Data Types, Graph Types, or Node Types. |
| `visualbridge_graph` | `path` | Read one declared `.vbgraph`, returning its semantic document, diagnostics, and SHA-256 `baseHash`. |
| `visualbridge_search_nodes` | `query` | Search shared Registry metadata and optionally apply one Graph Type's supported-Catalog and selector restrictions. |
| `visualbridge_validate_graph` | `path` | Run the shared parser, Registry, and Graph validator without writing. |
| `visualbridge_apply_graph_operations` | `path`, `baseHash`, non-empty `operations` | Apply one GraphOperation batch and persist it only when the complete transaction is valid and current. |
| `visualbridge_table_catalog` | optional project/type selectors; `view` | Build the declared Table Catalog Registry and query its summary or complete Table Types. |
| `visualbridge_table` | `path`; optional `sheetId`, `offset`, `limit` | Read one declared CSV family or XLSX workbook, its physical-sheet summary, combined `baseHash`, source hashes and an optional semantic row page. |
| `visualbridge_search_table_rows` | `path`, `query` | Search formatted row names and typed semantic cells, using effective partition rows by default. |
| `visualbridge_validate_table` | `path` | Run shared Catalog, codec, Field, partition and Table validation without writing. |
| `visualbridge_apply_table_operations` | `path`, `baseHash`, non-empty `operations` | Apply one TableOperation batch and persist it only when the complete logical Table is valid and every physical source is current. |
| `visualbridge_structured_catalog` | optional project/type selectors; `view` | Build the Structured Catalog Registry and query its required Config Type binding, summary or full types. |
| `visualbridge_structured` | `path` | Read one declared Structured Config, its bound Config Type, diagnostics and SHA-256 `baseHash`. |
| `visualbridge_validate_structured` | `path` | Run the strict V1 parser, Project type binding, shared Field and Reference validators without writing. |
| `visualbridge_apply_structured_operations` | `path`, `baseHash`, non-empty `operations` | Atomically apply one `structured.setField` batch through shared semantics. |
| `visualbridge_references` | `action`, `kind`, `target`; action-specific query/value | Search or resolve a shared Reference Provider and return typed stable values plus target locations. |

`projectFile` is the workspace-relative path returned by `visualbridge_project`. It can be omitted when the workspace contains exactly one valid project. Domain and Catalog tools accept an optional `documentTypeId`; it can be omitted when selection is unambiguous. All paths use `/`, are resolved below the selected Project root, and are rejected if normalization or a resolved symlink leaves that root. Structured paths may use any extension declared by the Project.

Catalog views return full Registry contracts rather than reinterpreted MCP-specific rules. Node search matches Catalog titles and IDs, node titles and IDs, aliases, category/menu path, tags, traits, and source provenance. Table search matches the Catalog-defined `rowDisplayNamePattern` plus typed semantic cells. Space-separated query terms are combined with AND. Search results are deterministic and limited to at most 200 entries.

`visualbridge_references` currently exposes the shared `table.row` Provider. Its target requires stable `tableTypeId` and `sheetId`, with optional `documentTypeId`; search returns Catalog-formatted row titles, strictly typed key values and project-relative Table locations. Resolve distinguishes `resolved`, `missing`, `ambiguous` and `providerUnavailable`. Graph/Structured/Table reads and validation append the same Core Reference diagnostics, and write transactions reject new reference errors without reimplementing Provider rules in MCP. The contract is documented in `ReferenceSystem.md`.

`visualbridge_table` does not return raw CSV cells or workbook objects. Without `sheetId` it returns document/source/sheet metadata; with a physical `sheetId` it adds a bounded semantic row page. Each row contains its Operation-facing row ID and typed `cells`. AI callers must use these identities with Table Operations rather than editing carrier bytes.

Partitioned CSV files are one logical Table. The read and validation tools return both a combined document `baseHash` and each sorted member's source hash. The combined hash includes member paths and hashes, so adding, removing or changing any matching partition invalidates the baseline. XLSX uses the workbook file hash as its document baseline.

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

The lock coordinates independent VisualBridge MCP processes. The second Hash check detects external editors that changed the source during transaction preparation. The temporary file is on the same volume and directory as the target so replacement does not expose a partially written document. Graph and Structured use the same single-text-file transaction adapter.

The tool returns one of four non-overlapping structured statuses:

- `applied`: the atomic replacement succeeded; `hash` is the new baseline.
- `unchanged`: the valid transaction serialized to the current bytes; the Hash is unchanged.
- `conflict`: the supplied baseline was stale, another MCP writer holds the lock, or the file changed before replacement. No write occurs. The caller must re-read and decide how to proceed; the server never overwrites or retries with a stale baseline.
- `invalid`: parsing, operation application, or semantic validation rejected the transaction. No write occurs and structured diagnostics explain the failure.

Unexpected project, path, Catalog, or I/O failures are MCP tool errors with a stable VisualBridge error `code`, message, and optional details.

## Structured write transaction

A Structured writer first calls `visualbridge_structured` or `visualbridge_validate_structured`. The Project Document Type ID must resolve to exactly one Config Type; the Structured file does not contain a second type ID. After the shared single-file lock and `baseHash` check, the server parses the strict V1 document, applies the complete `structured.setField` batch to a clone, rejects new Field or Reference errors, deterministically serializes, and atomically replaces the file. It returns the same `applied`, `unchanged`, `conflict`, or `invalid` statuses as Graph.

## Table write transaction

A Table writer first calls `visualbridge_table` or `visualbridge_validate_table` and retains the combined `baseHash`. The server discovers the complete CSV family or XLSX workbook, acquires one logical-table lock and reloads the sources after locking. It then:

```text
Compare the complete source manifest with baseHash
  -> parse through the shared CSV/XLSX Codec
  -> apply the complete TableOperation batch to a clone
  -> run complete Field, key and partition validation
  -> render every affected physical source
  -> stage and flush every changed source beside its target
  -> reload and compare the complete source manifest
  -> replace the staged sources
  -> verify every persisted source hash and family membership
  -> release the logical-table lock
```

For a CSV family, no replacement starts until every changed partition has serialized and every source hash still matches. If a replacement reports an I/O failure after another member was replaced, the adapter restores already-replaced members from the transaction baseline and reports a stable write error. Ordinary filesystem APIs cannot make several independent files crash-atomic as one kernel operation, but the lock, preflight, staging, rollback and verification prevent a known partial result from being accepted as success. One XLSX workbook is replaced as a single file.

Table writes use the same four statuses as Graph writes: `applied`, `unchanged`, `conflict`, or `invalid`. A conflict caused by any partition, changed family membership or another MCP writer rejects the complete request without applying Table Operations to disk.

## Validation

The fixed projects under `TestData/GraphSemanticProject`, `TestData/StructuredSemanticProject` and `TestData/TableSemanticProject` are used by semantic and stdio integration tests:

```text
npm test
```

The MCP test launches `dist/server.js` through the official client stdio transport and lists every structured tool schema. The Graph flow queries Project/Catalog/Graph data, searches a node alias, validates the Graph, proves conflict rejection leaves bytes unchanged, commits a valid operation, rejects a stale follow-up, and proves an invalid multi-operation batch is atomic.

The Structured flow uses project-defined `.gamesettings` and `.skillstable` extensions, queries the bound Config Type, searches a real Table Row reference, validates the document, rejects stale hashes and held locks, commits a multi-field batch, rejects invalid values and missing references, and proves rejected batches leave bytes unchanged.

The Table flow queries Catalog and paged semantic rows, compares effective and physical partition search, searches and resolves a real `table.row` reference through stdio, validates CSV/XLSX, rejects a stale hash, rejects changed partition membership, rejects a held logical-table lock, proves an invalid batch leaves source bytes unchanged, commits a CSV partition edit without rewriting its sibling, and round-trips an XLSX cell edit. All writes use temporary project copies. No Unity tests are added.
