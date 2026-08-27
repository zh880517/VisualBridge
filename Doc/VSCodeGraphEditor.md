# VisualBridge Graph V3

Graph V3 adds Catalog-defined Graph Types, instance constraints, initial nodes, and typed embedded subgraphs to the semantic editor. Unity, runtime compilation, and debug communication are not connected yet.

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
  "formatVersion": 2,
  "catalogId": "example.logic",
  "dataTypes": [
    { "id": "number", "title": "Number", "accepts": [] }
  ],
  "graphTypes": [
    {
      "id": "example.main-flow",
      "aliases": [],
      "title": "Main Flow",
      "usage": "root",
      "allowedNodeSelectors": [{ "tags": ["common"] }],
      "properties": [],
      "nodeConstraints": [
        { "id": "entry", "selector": { "traits": ["flowEntry"] }, "minInstances": 1, "maxInstances": 1 }
      ],
      "initialNodes": [{ "nodeTypeId": "example.flow.entry" }],
      "allowSubgraphs": true
    }
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

- New documents select a root-compatible Graph Type; a single candidate is selected automatically. Initial node templates make required entries available immediately.
- Add nodes from the current Graph Type's searchable, allowed catalog types. Types at a count maximum and typed-subgraph call types are excluded from the atomic-node picker.
- Add typed embedded subgraphs by selecting a compatible call-node type and target Graph Type. The call node renders its static fields/data ports together with the child graph's public interfaces.
- Render declared flow and data ports; flow edges are solid and data edges are dashed.
- Permit connection cycles. Data edges never determine execution order.
- Double-click a subgraph to enter it and use the breadcrumb to return.
- Add, rename, and remove public subgraph interfaces. Removing an interface also removes its internal and parent connections.
- Edit node titles and catalog-defined fields directly on each node. Catalog hints provide text, multiline, number/range, checkbox, select, JSON, reference, and read-only presentations. Advanced JSON editing remains available inside the node for unknown or additional fields.
- Add, edit, reorder, and remove instance-level dynamic ports directly on a node. Reordering preserves endpoint IDs; deleting a port removes its related edges in the same operation.
- Edit the current Graph's title, Graph Type-defined fields, advanced JSON properties, and public interfaces in a Graph-only Inspector that can collapse to the right edge. Assigned Graph Type is read-only.
- Keep node type display-only; it is never edited as a text field.
- Right-click an atomic or typed-subgraph node to replace its type. Only same-kind, lossless candidates that preserve Graph Type constraints are offered.
- Show structural and semantic diagnostics in the Webview and VS Code Problems.

Every persistent action is a Graph Operation applied through `WorkspaceEdit`, retaining VS Code dirty state and Undo/Redo. Node drag emits one operation when the drag ends. External disk changes still require overwrite or discard-and-refresh confirmation.

React Flow remains a controlled view layer. Selection, viewport, and transient drag positions do not enter `.vbgraph`; the Graph document and Catalog remain authoritative. See `GraphSemanticModel.md` for the complete semantic contract.
