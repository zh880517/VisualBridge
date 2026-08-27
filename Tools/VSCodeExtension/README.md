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

The extension currently includes the Graph V1 editor. A project document type with `"editor": "graph"` can open matching `.vbgraph` files as a node canvas. Use `VisualBridge: Create Graph Document` to create a valid empty graph inside a declared Graph document root.

Graph V1 uses a React Flow Webview and supports adding, moving, connecting and deleting nodes, editing node metadata and JSON properties, zooming and panning, VS Code Undo/Redo through `WorkspaceEdit`, diagnostics, and external-file conflict prompts. React Flow remains a view layer; every persistent change is applied through a Graph Operation. Unity integration and project-specific graph rules are intentionally outside this first editor version. See `Doc/VSCodeGraphEditor.md` in the repository for the format and project declaration.
