# VisualBridge VS Code Extension

This package contains the VS Code host adapter for VisualBridge. The extension activates project features only when it discovers and validates a `VisualBridge.project.vbjson` file in the current workspace.

## Development

From the repository root:

```powershell
npm install
npm run check
npm run build
```

Open the repository root in VS Code and press `F5` after running `npm run build` to start an Extension Development Host. Use `VisualBridge: Refresh Projects` after changing a project file.

The extension currently includes the Graph Document V3 editor with Graph Catalog V4 and the Entity Document V1 editor with Entity Catalog V1. A Project File's document type selects the broad editor category through `"editor": "graph"` or `"editor": "entity"`; its stable `id` is the project-defined subtype, while `include` and `exclude` own the file association. File extensions are not hardcoded type discriminators.

`.vbgraph` and `.vbentity` have default convenience associations. Project-defined extensions such as `.herojson` use `VisualBridge: Open Document` from the Explorer context menu or Command Palette, or a workspace-level `workbench.editorAssociations` entry. In all cases the Project Registry must match the file before the editor is created. `VisualBridge: Create Graph Document` and `VisualBridge: Create Entity Document` select a project subtype, derive the suggested extension from its first usable `include` pattern, and reject a target outside that exact document type.

Graph V3 uses a React Flow Webview and a registry of multiple Catalogs. Graph Types use `supportedCatalogIds` as a coarse node filter and optional selectors as a refinement; cross-Catalog data connections use the same global Data Type compatibility rules. The editor also supports node-count constraints, directional connection limits, initial nodes, typed embedded subgraphs, flow/data ports, optional node icons, public graph interfaces, safe context-menu node replacement, inline properties, multi-select, Copy/Paste/Duplicate, hierarchical creation menus, connection-created nodes, MiniMap navigation, VS Code Undo/Redo through `WorkspaceEdit`, diagnostics, and external-file conflict prompts. React Flow remains a view layer; every persistent change is applied through a Graph Operation. Unity integration remains outside the current editor version. See `Doc/VSCodeGraphEditor.md` and `Doc/GraphSemanticModel.md` for the format and semantic contract.

Entity V1 edits root properties and ordered Component cards, including add/search, enable, reorder, duplicate, remove, shared numeric/color/object/list fields, diagnostics, Undo/Redo, and external-file conflict prompts. It uses authoritative JSON rather than `ScriptableObject` assets. See `Doc/EntityComponentModel.md` for the Catalog, document, shared field, operation, custom-extension, and deferred Unity contracts.
