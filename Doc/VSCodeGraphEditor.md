# VisualBridge Graph V3

Graph Document V3 and Graph Catalog V4 add multi-Catalog registration, Catalog-defined Graph Types, instance constraints, initial nodes, typed embedded subgraphs, and Catalog-rooted node menus to the semantic editor. Unity, runtime compilation, and debug communication are not connected yet.

## Project declaration

The `VisualBridge.project.vbjson` marker enables the editor and declares its Graph Catalogs:

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
      "catalogs": [
        "Catalog/Common.vbgraphcatalog",
        "Catalog/Logic.vbgraphcatalog"
      ]
    }
  ]
}
```

Catalog paths are relative to the marker. The host loads them into one registry. Catalog IDs and Data Type IDs must be globally unique; Node Type and Graph Type IDs and aliases must be globally unambiguous in their respective namespaces. Conflicts invalidate the registry instead of being resolved by load order. Without a valid registry, existing unknown nodes remain readable and editable, but new typed nodes and type replacement are unavailable.

## Catalog example

```json
{
  "formatVersion": 4,
  "catalogId": "example.logic",
  "title": "通用",
  "dataTypes": [
    { "id": "number", "title": "Number", "color": "#4DA3FF", "accepts": [] }
  ],
  "graphTypes": [
    {
      "id": "example.main-flow",
      "aliases": [],
      "title": "Main Flow",
      "usage": "root",
      "supportedCatalogIds": ["example.common", "example.logic"],
      "portConnectionRules": { "input": "single", "output": "multiple" },
      "allowedNodeSelectors": [{ "tags": ["common"] }],
      "properties": [],
      "nodeConstraints": [
        { "id": "entry", "selector": { "traits": ["flowEntry"] }, "minInstances": 1, "maxInstances": 1 }
      ],
      "initialNodes": [{ "nodeTypeId": "example.flow.step" }],
      "allowSubgraphs": true
    }
  ],
  "nodeTypes": [
    {
      "id": "example.flow.step",
      "aliases": ["legacy.flow.step"],
      "title": "Step",
      "icon": "▶",
      "category": "Operation",
      "menuPath": ["操作", "整数"],
      "tags": ["common"],
      "traits": ["flowEntry", "flowInput", "flowOutput"],
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
- Add nodes from the current Graph Type's searchable registered types. A node belongs to its declaring Catalog. `supportedCatalogIds` first restricts the available Catalogs, then `allowedNodeSelectors` optionally refines their nodes. Each declaring Catalog's `title` is the node's root path and `menuPath` is relative to that root, so Catalog `通用`, path `操作 / 整数`, and node `加法` appear as `通用 / 操作 / 整数 / 加法`. Search spans the Catalog title, names, IDs, categories, paths, tags, and traits. Types at a count maximum, typed-subgraph call types, and types whose required fields lack deterministic defaults are excluded from the atomic-node picker.
- Drop an unfinished connection on empty canvas space to open a filtered list of compatible node ports. Choosing one atomically creates the node and edge at the drop position; kind, direction, registry-wide Data Type assignability, connection limits, supported Catalogs, allowed selectors, and count constraints are respected. `portConnectionRules` supplies the Graph Type's input/output limit and a port's `maxConnections` may only make that limit stricter.
- Add typed embedded subgraphs by selecting a compatible call-node type and target Graph Type. The call node renders its static fields/data ports together with the child graph's public interfaces.
- Render declared flow and data ports; flow edges are solid and data edges are dashed.
- Give every Data Type a stable built-in color derived from its ID. An optional Catalog `color` in `#RRGGBB` format overrides that default. Property inputs, static and dynamic data handles, interface ports, and data edges use the resolved type color; flow ports keep their separate flow color.
- Permit connection cycles. Data edges never determine execution order.
- Double-click a subgraph to enter it and use the breadcrumb to return.
- Render public subgraph interfaces on both the call site and child canvas. The child canvas owns non-deletable Input Parameters and Output Parameters interface nodes. Their `+` action creates an untyped dynamic data parameter; rows support direct rename, selected-item deletion, drag ordering, and `Alt+↑/↓`. The first concrete connection made inside the child or outside on the parent call node locks the shared Data Type. Removing the final connection unlocks it to `any`. Dynamic parameters remain visible on the parent call node by default, with the unlocked `any` state rendered in light gray. The Graph Inspector still does not manage interfaces.
- Configure an optional text glyph with a node type's `icon` field. Every node reserves a fixed icon slot before its title, keeping titles aligned even when some types omit the icon. Toolbar checkboxes independently control the node type subtitle and stable node instance ID; the type is visible by default and the ID is hidden by default. Both are transient view state and are not serialized.
- Render static flow inputs and outputs immediately after the node type, before property editors and data ports. Property-bound data inputs stay beside their editor, while remaining static data ports follow the property area. Dynamic handles are rendered on their own element row instead of in the static port section.
- Edit a node title by double-clicking its header. Catalog-defined fields are edited directly on each node using text, multiline, number/range, checkbox, select, JSON, reference, and read-only presentations. A field and its matching data-input handle share one row; while connected, the literal editor is hidden and the fallback value is retained. Disconnecting restores that value and editor.
- Keep required-field semantics in the Catalog and validator without adding an asterisk to field labels in the canvas or Graph Inspector.
- Add, select, edit, drag-reorder, and remove instance-level dynamic elements directly on a node. A row edits only the element value and places its dynamic handle at the row edge; there is no separate port-name editor. Each row has a visible selected state and a grip handle. Selecting a row reveals the group-level delete action immediately after Add; deleting removes that element and its related edges in one operation. Dropping a row commits one reorder operation while preserving endpoint IDs, and `Alt+↑/↓` on the grip provides keyboard reordering.
- Edit only the current Graph's title and Graph Type-defined fields in a Graph-only Inspector that can collapse to the right edge. Assigned Graph Type is read-only.
- Keep node type display-only; it is never edited as a text field.
- Multi-select nodes and edges using React Flow selection gestures, then delete them as one Graph Operation batch. Final semantic validation prevents deleting required Graph Type nodes.
- Copy, Paste, and Duplicate selected atomic nodes together with edges whose endpoints are both selected. Pasted instances receive fresh node and edge IDs. Singleton required nodes and embedded subgraphs are intentionally excluded from the V1 clipboard payload.
- Right-click an atomic or typed-subgraph node to select every node of the same canonical type or replace its type. Only same-kind, lossless replacement candidates that preserve Graph Type constraints are offered.
- Right-click empty canvas space for Graph-level Add Node, Add Subgraph, and Paste actions. Newly added nodes and subgraphs use the clicked canvas position. Context menus use an opaque editor-widget surface so the graph remains visually separated from menu text.
- Use the MiniMap for large-graph navigation. Viewport, selection, open menus, and clipboard state remain transient editor state.
- Show structural and semantic diagnostics in the Webview and VS Code Problems.

Every persistent action is a Graph Operation applied through `WorkspaceEdit`, retaining VS Code dirty state and Undo/Redo. Node drag emits one operation when the drag ends. External disk changes still require overwrite or discard-and-refresh confirmation.

React Flow remains a controlled view layer. Selection, viewport, and transient drag positions do not enter `.vbgraph`; the Graph document and Catalog remain authoritative. See `GraphSemanticModel.md` for the complete semantic contract.
