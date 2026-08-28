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
    { "id": "int", "title": "Integer", "color": "#4DA3FF", "accepts": [] },
    { "id": "float", "title": "Float", "color": "#4FC3F7", "accepts": ["int"] }
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
        { "id": "value", "aliases": ["Value"], "title": "Value", "kind": "data", "direction": "input", "dataTypeId": "int", "maxConnections": 1 }
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
          "dataTypeId": "int",
          "required": true,
          "defaultValue": 0,
          "editor": { "kind": "number", "readOnly": false, "min": 0, "max": 100, "options": [] }
        }
      ]
    }
  ]
}
```

`valueType` describes the JSON scalar shape and editor control, so integer and floating-point fields both use `valueType: "number"`. Runtime semantics belong to `dataTypeId`: C# numeric contracts use distinct stable IDs such as `int` and `float`, never a shared `number` Data Type. The future Unity exporter maps `System.Int32` to `int` and `System.Single` to `float`. A target Data Type may list accepted source types explicitly; the example lets `float` accept `int` to model the C# widening conversion while keeping `float` to `int` invalid.

## List fields

A data `dynamicPortGroup` represents an editable `List<T>` when it declares `listPortMode`. Its ordered instance elements remain in `node.dynamicPorts` so every element has a stable ID across reorder, Undo/Redo, and serialization. The legacy field name is retained for Graph Document V3 compatibility; in `list` mode those item IDs are not connection endpoints.

```json
{
  "id": "values",
  "aliases": [],
  "title": "Values",
  "listPortMode": "element",
  "port": { "kind": "data", "direction": "input", "dataTypeId": "int", "maxConnections": 1 },
  "item": {
    "valueType": "number",
    "dataTypeId": "int",
    "defaultValue": 0,
    "editor": { "kind": "number", "readOnly": false, "options": [] }
  }
}
```

`listPortMode: "list"` creates one input handle using the group ID and requires `port.dataTypeId` to identify the complete list type, such as `int-list`; connecting it hides the entire literal list editor. `listPortMode: "element"` creates one input handle per stable item ID, requires `port.dataTypeId` to equal `item.dataTypeId`, and hides only the connected element editor. Both modes require a data input template and an item `dataTypeId`. Omitting `listPortMode` preserves the existing dynamic flow/data-port behavior.

## Editing behavior

- New documents select a root-compatible Graph Type; a single candidate is selected automatically. Initial node templates make required entries available immediately.
- Add nodes from the current Graph Type's searchable registered types. A node belongs to its declaring Catalog. `supportedCatalogIds` first restricts the available Catalogs, then `allowedNodeSelectors` optionally refines their nodes. Each declaring Catalog's `title` is the node's root path and `menuPath` is relative to that root, so Catalog `通用`, path `操作 / 整数`, and node `加法` appear as `通用 / 操作 / 整数 / 加法`. Search spans the Catalog title, names, IDs, categories, paths, tags, and traits. Types at a count maximum, typed-subgraph call types, and types whose required fields lack deterministic defaults are excluded from the atomic-node picker.
- Drop an unfinished connection on empty canvas space to open a filtered list of compatible node ports. Choosing one atomically creates the node and edge at the drop position; kind, direction, registry-wide Data Type assignability, connection limits, supported Catalogs, allowed selectors, and count constraints are respected. `portConnectionRules` supplies the Graph Type's input/output limit and a port's `maxConnections` may only make that limit stricter.
- Add typed embedded subgraphs by selecting a compatible call-node type and target Graph Type. The call node renders its static fields/data ports together with the child graph's public interfaces.
- Render declared flow and data ports; flow edges are solid and data edges are dashed.
- Give every Data Type a stable built-in color derived from its ID. An optional Catalog `color` in `#RRGGBB` format overrides that default. Property inputs, static and dynamic data handles, interface ports, and data edges use the resolved type color; flow ports keep their separate flow color.
- Permit connection cycles. Data edges never determine execution order.
- Replace an existing edge automatically when a valid new edge uses an occupied port whose effective connection limit is one. The editor removes the old edge before adding the new edge in the same host operation batch; ports with a multi-connection limit still report capacity instead of guessing which edge to remove.
- Double-click a subgraph to enter it and use the breadcrumb to return.
- Render public subgraph interfaces on both the call site and child canvas. The child canvas owns non-deletable Input Parameters and Output Parameters interface nodes. Their Add icon creates an untyped dynamic data parameter; rows support direct rename, selected-item deletion, drag ordering, and `Alt+↑/↓`. The first concrete connection made inside the child or outside on the parent call node locks the shared Data Type. Removing the final connection unlocks it to `any`. Dynamic parameters remain visible on the parent call node by default, with the unlocked `any` state rendered in light gray. The Graph Inspector still does not manage interfaces.
- Configure an optional text glyph with a node type's `icon` field. Every node reserves a fixed icon slot before its title, keeping titles aligned even when some types omit the icon. Toolbar checkboxes independently control the node type subtitle and stable node instance ID; the type is visible by default and the ID is hidden by default. Both are transient view state and are not serialized.
- Render static flow inputs and outputs immediately after the node type, before property editors and data ports. Property-bound data inputs stay beside their editor, while remaining static data ports follow the property area. Dynamic handles are rendered on their own element row instead of in the static port section.
- Edit a node title by double-clicking its header. Catalog-defined fields are edited directly on each node using text, multiline, number/range, checkbox, select, JSON, reference, and read-only presentations. A field and its matching data-input handle share one row; while connected, the literal editor is hidden and the fallback value is retained. Disconnecting restores that value and editor.
- Keep required-field semantics in the Catalog and validator without adding an asterisk to field labels in the canvas or Graph Inspector.
- Add, select, edit, drag-reorder, and remove instance-level dynamic elements directly on a node. A row edits only the element value and places its dynamic handle at the row edge; there is no separate port-name editor. Each row has a visible selected state and a grip handle. Selecting a row reveals the group-level delete action immediately after Add; deleting removes that element and its related edges in one operation. Dropping a row commits one reorder operation while preserving endpoint IDs, and `Alt+↑/↓` on the grip provides keyboard reordering.
- Edit `List<T>` elements with the same stable-element controls. Whole-List port mode renders one group input and hides all element editors while connected; element-port mode renders a handle after every element and hides only the connected element's literal editor.
- Edit only the current Graph's title and Graph Type-defined fields in a Graph-only Inspector that can collapse to the right edge. Assigned Graph Type is read-only.
- Keep node type display-only; it is never edited as a text field.
- Drag the left mouse button on empty canvas space to box-select every partially intersected node; drag the middle mouse button to pan. The canvas uses the default arrow cursor and switches to the grabbing cursor only while middle-button panning. Multi-selected nodes and edges are deleted as one Graph Operation batch. When a mixed selection contains Graph Type minimum-required nodes, deletion removes the other selected items and retains only the nodes needed to satisfy those constraints; an all-required selection remains unavailable.
- Copy, Paste, and Duplicate selected atomic nodes together with edges whose endpoints are both selected. Pasted instances receive fresh node and edge IDs. Singleton required nodes and embedded subgraphs are intentionally excluded from the V1 clipboard payload.
- Right-click an atomic or typed-subgraph node to select every node of the same canonical type, replace its type, Copy, Duplicate, or Delete. Right-click an edge or selection to access the applicable selection actions. Only same-kind, lossless replacement candidates that preserve Graph Type constraints are offered; unavailable actions remain visible in a disabled state with a reason tooltip.
- Right-click empty canvas space for Graph-level Add Node, Add Subgraph, and Paste actions. Newly added nodes and subgraphs use the clicked canvas position. Persistent editing actions live in context menus rather than the top toolbar. Context menus use an opaque editor-widget surface so the graph remains visually separated from menu text.
- Show the VS Code text document's saved/unsaved state in the top toolbar. Graph Operations make the document dirty through `WorkspaceEdit`; normal VS Code Save clears the indicator after the host observes the save event.
- Use the MiniMap for large-graph navigation. Viewport, selection, open menus, and clipboard state remain transient editor state.
- Show structural and semantic diagnostics in the Webview and VS Code Problems.

Every persistent action is a Graph Operation applied through `WorkspaceEdit`, retaining VS Code dirty state and Undo/Redo. Each document operation stores its before/after Graph and node selection snapshots, so Undo and Redo restore the matching selection. Clicking or box-selecting only updates the current snapshot and never creates an Undo entry. Node drag emits one operation when the drag ends. External disk changes still require overwrite or discard-and-refresh confirmation.

React Flow remains a controlled view layer. Selection, viewport, and transient drag positions do not enter `.vbgraph`; the Graph document and Catalog remain authoritative. See `GraphSemanticModel.md` for the complete semantic contract.
