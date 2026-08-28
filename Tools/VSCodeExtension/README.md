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

The extension currently includes the Graph Document V3 editor with Graph Catalog V4. A project document type with `"editor": "graph"` can open matching `.vbgraph` files as a node canvas and may declare project-relative Catalog files through `"catalogs": ["Catalog/Common.vbgraphcatalog", "Catalog/Logic.vbgraphcatalog"]`. Use `VisualBridge: Create Graph Document` to select a compatible root Graph Type and create a valid graph inside a declared Graph document root.

Graph V3 uses a React Flow Webview and a registry of multiple Catalogs. Graph Types use `supportedCatalogIds` as a coarse node filter and optional selectors as a refinement; cross-Catalog data connections use the same global Data Type compatibility rules. The editor also supports node-count constraints, directional connection limits, initial nodes, typed embedded subgraphs, flow/data ports, optional node icons, public graph interfaces, safe context-menu node replacement, inline properties, multi-select, Copy/Paste/Duplicate, hierarchical creation menus, connection-created nodes, MiniMap navigation, VS Code Undo/Redo through `WorkspaceEdit`, diagnostics, and external-file conflict prompts. React Flow remains a view layer; every persistent change is applied through a Graph Operation. Unity integration remains outside the current editor version. See `Doc/VSCodeGraphEditor.md` and `Doc/GraphSemanticModel.md` for the format and semantic contract.
