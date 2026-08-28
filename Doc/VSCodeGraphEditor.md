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
      "icon": "▶",
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
- Add nodes from the current Graph Type's searchable, allowed catalog types. The picker groups types by `menuPath`; search spans names, IDs, categories, paths, tags, and traits. Types at a count maximum, typed-subgraph call types, and types whose required fields lack deterministic defaults are excluded from the atomic-node picker.
- Drop an unfinished connection on empty canvas space to open a filtered list of compatible node ports. Choosing one atomically creates the node and edge at the drop position; kind, direction, data assignability, connection limits, allowed selectors, and count constraints are respected.
- Add typed embedded subgraphs by selecting a compatible call-node type and target Graph Type. The call node renders its static fields/data ports together with the child graph's public interfaces.
- Render declared flow and data ports; flow edges are solid and data edges are dashed.
- Permit connection cycles. Data edges never determine execution order.
- Double-click a subgraph to enter it and use the breadcrumb to return.
- Render public subgraph interfaces on both the call site and child canvas. Interface definitions remain part of the Graph contract, but the Graph Inspector does not create, rename, or remove them.
- Configure an optional text glyph with a node type's `icon` field. Every node reserves a fixed icon slot before its title, keeping titles aligned even when some types omit the icon. The toolbar checkbox controls whether the node type subtitle is visible; this is transient view state and is not serialized.
- Edit a node title by double-clicking its header. Catalog-defined fields are edited directly on each node using text, multiline, number/range, checkbox, select, JSON, reference, and read-only presentations. A field and its matching data-input handle share one row; while connected, the literal editor is hidden and the fallback value is retained. Disconnecting restores that value and editor.
- Add, edit, reorder, and remove instance-level dynamic ports directly on a node. Reordering preserves endpoint IDs; deleting a port removes its related edges in the same operation.
- Edit only the current Graph's title and Graph Type-defined fields in a Graph-only Inspector that can collapse to the right edge. Assigned Graph Type is read-only.
- Keep node type display-only; it is never edited as a text field.
- Multi-select nodes and edges using React Flow selection gestures, then delete them as one Graph Operation batch. Final semantic validation prevents deleting required Graph Type nodes.
- Copy, Paste, and Duplicate selected atomic nodes together with edges whose endpoints are both selected. Pasted instances receive fresh node and edge IDs. Singleton required nodes and embedded subgraphs are intentionally excluded from the V1 clipboard payload.
- Right-click an atomic or typed-subgraph node to select every node of the same canonical type or replace its type. Only same-kind, lossless replacement candidates that preserve Graph Type constraints are offered.
- Use the MiniMap for large-graph navigation. Viewport, selection, open menus, and clipboard state remain transient editor state.
- Show structural and semantic diagnostics in the Webview and VS Code Problems.

Every persistent action is a Graph Operation applied through `WorkspaceEdit`, retaining VS Code dirty state and Undo/Redo. Node drag emits one operation when the drag ends. External disk changes still require overwrite or discard-and-refresh confirmation.

React Flow remains a controlled view layer. Selection, viewport, and transient drag positions do not enter `.vbgraph`; the Graph document and Catalog remain authoritative. See `GraphSemanticModel.md` for the complete semantic contract.
