# VisualBridge VS Code Extension

This package contains the VS Code host adapter for VisualBridge. The extension activates project features only when it discovers and validates a `VisualBridge.project.vbjson` file in the current workspace.

Use **VisualBridge: Open Project Settings** to edit roots, Document Types, arbitrary include/exclude patterns, Catalog bindings, Table layout and Project Providers through validated structured Operations. The **Catalogs** Activity Bar view is read-only and shows Registry types, aliases, source/content Hashes, stale state, conflicts and diagnostics. See [`ProjectCatalogManagement.md`](../../Doc/ProjectCatalogManagement.md).

## Development

From the repository root:

```powershell
npm install
npm run check
npm run build
```

Open the repository root in VS Code and press `F5` after running `npm run build` to start an Extension Development Host. Use `VisualBridge: Refresh Projects` after changing a project file.

## Automated host and package tests

Run the real Extension Host suite from the repository root:

```powershell
npm run test:vscode:host
```

The runner uses the official `@vscode/test-electron` package and pins the declared minimum VS Code version, 1.105.1. It copies `TestData` into a unique temporary workspace, uses isolated User Data and Extensions directories, and verifies automatic workspace activation, command registration, the default Graph editor association, project-defined Entity, Structured, and Table routing, hidden Webview re-handshakes, queued Table row reveals, and split Table custom-editor panels without changing the tracked fixtures or the user's VS Code profile. The downloaded VS Code runtime is cached under the ignored `.utmp/vscode-test` directory. A failed run preserves its temporary directory and prints the path so that Extension Host logs remain available; set `VISUALBRIDGE_CLEAN_FAILED_TEST=1` to remove failed runs automatically.

Validate the packaged artifact separately:

```powershell
npm run test:vscode:cli
```

This command builds the VSIX, resolves the installed VS Code CLI, installs the package into unique temporary User Data and Extensions directories, verifies the exact `kyl.visualbridge` identity/version, and checks the packaged extension entry point, every Manifest-declared JSON Schema, icon, and all four Webview JavaScript/CSS bundles. It also rejects leaked test files, packaging scripts, and source maps. The result proves that the VSIX is installable and structurally complete; interactive Webview behavior remains covered by domain tests and targeted real-page checks rather than being inferred from CLI installation.

The extension currently includes the Graph Document V3 editor with Graph Catalog V4, the Entity Document V1 editor with Entity Catalog V1, the Structured Config V1 editor with Structured Catalog V1, the Table Document V1 editor with Table Catalog V1, the unified Document Browser, and Project Provider V2 references/validators. A Project File's document type selects the broad editor category through `"editor": "graph"`, `"editor": "entity"`, `"editor": "structured"` or `"editor": "table"`; its stable `id` is the project-defined subtype, while `include` and `exclude` own the file association. File extensions are not hardcoded type discriminators.

Project Providers run only in a trusted workspace as isolated `.mjs` child processes; Restricted Mode never starts them. They can add declared Reference kinds and Validator diagnostics but cannot add write operations. Provider stderr and structured lifecycle events are written to the `VisualBridge` Output Channel. See `Doc/ProjectProvider.md` for the declaration, protocol, trust and troubleshooting contract.

`.vbgraph`, `.vbentity` and `.vbconfig` have default convenience associations. Project-defined extensions such as `.herojson` or `.gamesettings` use `VisualBridge: Open Document` from the Explorer context menu or Command Palette, a workspace-level `workbench.editorAssociations` entry, or the Document Browser. In all cases the Project Registry must match the file before the editor is created. The unified create command selects a project subtype, derives the suggested extension from its first usable `include` pattern, and rejects a target outside that exact document type. Table creation emits a real XLSX workbook for `.xlsx` targets and a configured UTF-8 CSV-compatible carrier for other project extensions.

The VisualBridge Activity Bar contains the `Documents` view. It groups the four editor categories by Project Document Type, searches titles/stable IDs/paths/diagnostics/references, creates documents, validates the workspace, publishes Problems, reveals outgoing references, lists incoming references, and expands physical CSV partition sources without replacing the native Explorer. Resolved `document`, `entity.component`, `graph.element`, and `table.row` reference items can preview and atomically rename the target key plus every incoming Graph, Entity, Structured, or Table occurrence. Graph element navigation enters the owning Graph, selects and centers nodes, and temporarily highlights interface or dynamic ports; Entity Component navigation expands, focuses, and highlights the exact Component card. See `Doc/DocumentBrowser.md` and `Doc/ProjectRefactoring.md`.

Graph V3 uses a React Flow Webview and a registry of multiple Catalogs. Graph Types use `supportedCatalogIds` as a coarse node filter and optional selectors as a refinement; cross-Catalog data connections use the same global Data Type compatibility rules. The editor also supports node-count constraints, directional connection limits, initial nodes, typed embedded subgraphs, flow/data ports, optional node icons, public graph interfaces, safe context-menu node replacement, inline properties, multi-select, Copy/Paste/Duplicate, hierarchical creation menus, connection-created nodes, MiniMap navigation, VS Code Undo/Redo through `WorkspaceEdit`, diagnostics, and external-file conflict prompts. React Flow remains a view layer; every persistent change is applied through a Graph Operation. Unity integration remains outside the current editor version. See `Doc/VSCodeGraphEditor.md` and `Doc/GraphSemanticModel.md` for the format and semantic contract.

Entity V1 edits root properties and ordered Component cards, including add/search, enable, reorder, duplicate, remove, shared numeric/color/object/list fields, diagnostics, Undo/Redo, and external-file conflict prompts. It uses authoritative JSON rather than `ScriptableObject` assets. See `Doc/EntityComponentModel.md` for the Catalog, document, shared field, operation, custom-extension, and deferred Unity contracts.

Structured Config V1 edits one ordinary C# runtime-shaped object without `ScriptableObject`. The Project Document Type ID is the sole Config Type binding; the file stores only its document ID and complete properties. It reuses the shared Field and Reference editors, supports arbitrary project extensions, strict Catalog validation, deterministic JSON, Undo/Redo and external-file conflict prompts. See `Doc/StructuredConfigModel.md`.

Table V1 edits UTF-8 CSV-compatible files and XLSX workbooks through one semantic model. The Project config owns the one-based name-key and data-start rows; C#-exported Table Catalog JSON owns types, field editors, name keys, row display-name patterns and cell encodings. Matching CSV siblings or XLSX worksheets can form one logical partitioned table with a naming template and `error`, `keepFirst` or `keepLast` de-duplication policy. The editor uses a searchable record list and a selected-record form, reusing the shared Field editor for color, List and ordinary nested structures. Table Operation batches are atomic, all physical sources use base-hash conflict rejection, and writes use staged replacement. See `Doc/TableSemanticModel.md`.
