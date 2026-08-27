# VisualBridge Graph V2

Graph V2 is the first semantic VisualBridge document editor. It provides catalog-driven node types, flow and data ports, embedded subgraphs, validation, and VS Code editing behavior. Unity, runtime compilation, and debug communication are not connected yet.

## Project declaration

The `VisualBridge.project.vbjson` marker enables the editor and declares its Graph Catalog:

```json
{
  "formatVersion": 1,
  "projectId": "ExampleGame",
  "documentRoots": ["Graph"],
  "documentTypes": [
    {
      "id": "logicGraph",
      "editor": "graph",
      "include": ["Graph/**/*.vbgraph"],
      "exclude": [],
      "catalog": "Catalog/Logic.vbgraphcatalog"
    }
  ]
}
```

The catalog path is relative to the marker. Without a valid catalog, existing unknown nodes remain readable and editable, but new typed nodes and type replacement are unavailable. Node, port, and property aliases are migration identities, not display names. The parser rejects aliases that collide with a canonical ID or another alias in the same namespace.

## Catalog example

```json
{
  "formatVersion": 1,
  "catalogId": "example.logic",
  "dataTypes": [
    { "id": "number", "title": "Number", "accepts": [] }
  ],
  "nodeTypes": [
    {
      "id": "example.flow.step",
      "aliases": ["legacy.flow.step"],
      "title": "Step",
      "category": "Flow",
      "menuPath": ["Flow", "Basic"],
      "tags": ["common"],
      "traits": ["flowInput", "flowOutput"],
      "source": {
        "providerId": "unity",
        "assemblyName": "Example.Runtime",
        "typeName": "Example.StepData",
        "wrapperTypeName": "Example.StepNode"
      },
      "ports": [
        { "id": "flow.in", "aliases": [], "title": "In", "kind": "flow", "direction": "input", "maxConnections": 1 },
        { "id": "flow.out", "aliases": [], "title": "Out", "kind": "flow", "direction": "output", "maxConnections": 1 },
        { "id": "value", "aliases": ["Value"], "title": "Value", "kind": "data", "direction": "input", "dataTypeId": "number", "maxConnections": 1 }
      ],
      "dynamicPortGroups": [
        {
          "id": "branches",
          "aliases": ["OutPort"],
          "title": "Branches",
          "port": { "kind": "flow", "direction": "output", "maxConnections": 1 },
          "item": {
            "valueType": "number",
            "defaultValue": 0,
            "editor": { "kind": "number", "readOnly": false, "min": 0, "max": 100, "options": [] }
          },
          "maxItems": 8
        }
      ],
      "properties": [
        {
          "id": "amount",
          "aliases": ["Value"],
          "title": "Amount",
          "description": "Value consumed by the step.",
          "valueType": "number",
          "dataTypeId": "number",
          "required": true,
          "defaultValue": 0,
          "editor": { "kind": "number", "readOnly": false, "min": 0, "max": 100, "options": [] }
        }
      ]
    }
  ]
}
```

## Editing behavior

- Add nodes from searchable catalog types and add embedded subgraphs. Search includes title, stable ID, menu path, tags, and traits.
- Render declared flow and data ports; flow edges are solid and data edges are dashed.
- Permit connection cycles. Data edges never determine execution order.
- Double-click a subgraph to enter it and use the breadcrumb to return.
- Add, rename, and remove public subgraph interfaces. Removing an interface also removes its internal and parent connections.
- Edit node titles and catalog-defined fields directly on each node. Catalog hints provide text, multiline, number/range, checkbox, select, JSON, reference, and read-only presentations. Advanced JSON editing remains available inside the node for unknown or additional fields.
- Add, edit, reorder, and remove instance-level dynamic ports directly on a node. Reordering preserves endpoint IDs; deleting a port removes its related edges in the same operation.
- Edit the current Graph's title, JSON properties, and public interfaces in a Graph-only Inspector that can collapse to the right edge.
- Keep node type display-only; it is never edited as a text field.
- Right-click an atomic node to replace its type. Only lossless candidates are offered.
- Show structural and semantic diagnostics in the Webview and VS Code Problems.

Every persistent action is a Graph Operation applied through `WorkspaceEdit`, retaining VS Code dirty state and Undo/Redo. Node drag emits one operation when the drag ends. External disk changes still require overwrite or discard-and-refresh confirmation.

React Flow remains a controlled view layer. Selection, viewport, and transient drag positions do not enter `.vbgraph`; the Graph document and Catalog remain authoritative. See `GraphSemanticModel.md` for the complete semantic contract.
