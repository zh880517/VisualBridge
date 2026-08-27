# VisualBridge Graph Semantic Model

## Scope

This document defines the landed Graph V2 authoring contract. It covers stable identity, flow and data connections, embedded subgraphs, catalog-driven validation, and safe node-type replacement. Runtime execution, Unity compilation, and debugging are outside the current implementation.

## Stable identity

Serialized references never depend on a display label, source filename, C# class name, or namespace. The following values are stable IDs:

- `documentId` and `graphId` identify documents and embedded graphs.
- `nodeId` identifies a node instance across edits and moves.
- `nodeTypeId` identifies the semantic node type declared by a Graph Catalog.
- `portId`, `propertyId`, and `interfacePortId` identify connection and property contracts.

Labels may be renamed freely. A node implementation must retain its existing `nodeTypeId` when its source class is renamed. Catalog `aliases` support explicit legacy IDs for node types, ports, and properties. Aliases participate in lookup, validation, cardinality, and safe replacement, but each identity namespace must remain unambiguous. If a type is unavailable, VisualBridge preserves the node and its complete property object and reports it as unknown.

## Document ownership and embedded subgraphs

A `.vbgraph` contains one root graph and zero or more embedded graphs:

```json
{
  "formatVersion": 2,
  "documentId": "combat_logic",
  "rootGraphId": "root",
  "graphs": [
    {
      "id": "root",
      "title": "Combat Logic",
      "properties": {},
      "interfacePorts": [],
      "nodes": [],
      "edges": []
    }
  ]
}
```

Graphs are stored as a flat collection for stable operation addressing. A subgraph node owns another graph through `subgraphId`; every non-root graph has exactly one owner. Removing a subgraph node removes its owned graph hierarchy in the same operation. Flow and data edges may contain cycles, but subgraph ownership must remain an acyclic tree.

Every graph also owns a JSON `properties` object. The collapsible Graph Inspector edits the current graph's title, properties, and public interfaces. Node titles and catalog-defined fields are edited directly on each canvas node; the Inspector never changes its target based on node or edge selection.

Subgraphs expose explicit interface ports. From the parent, an input interface is an input handle and an output interface is an output handle. Inside the subgraph, the directions are reversed: an input interface supplies values or flow to internal nodes, while an output interface receives them. Edges cannot bypass this public interface to address nodes in another graph.

## Flow and data connections

Every edge explicitly declares `kind`:

- `flow` defines execution order and may form cycles.
- `data` transfers values and never schedules or orders node execution.

Every port declares a stable ID, label, kind, direction, optional data type, and optional connection limit. Validation requires output-to-input direction, matching edge and port kinds, compatible data types, existing endpoints, unique connections, and respected cardinality. There is no global cycle validator; a future project-specific validator may impose additional constraints.

Data compatibility is deterministic. Identical types, `any`, and target types that explicitly list the source in `accepts` are compatible. VisualBridge does not insert implicit conversion nodes.

## Graph Catalog

A Graph document type declares a project-relative `.vbgraphcatalog` file:

```json
{
  "id": "logicGraph",
  "editor": "graph",
  "include": ["Graph/**/*.vbgraph"],
  "catalog": "Catalog/Logic.vbgraphcatalog"
}
```

The catalog is the authority for node types, ports, data types, properties, defaults, and aliases. It may also declare a hierarchical `menuPath`, tags, capability traits, source-code provenance, descriptions, and property editor hints. Editor hints affect presentation only; the declared value type remains authoritative. VS Code and future MCP adapters use the same parser and validators. Catalog files are text contracts and should be committed when editing must work without Unity.

Catalog serialization is deterministic: unordered type collections and identity aliases are sorted, JSON object keys in defaults are normalized, and the output ends with a newline. Port, dynamic-group, and property arrays preserve declaration order because that order controls the editor layout. This lets a future Unity exporter regenerate the same file without noisy diffs while retaining C# field and branch order.

## Stable dynamic ports

A node type may declare `dynamicPortGroups`. Each group defines the connection contract, item value contract, default value, editor hint, aliases, and optional item limit. A node instance stores its items in `dynamicPorts`:

```json
{
  "id": "choice_a",
  "groupId": "branches",
  "title": "Choice A",
  "value": 10
}
```

The item `id` is the actual endpoint `portId` and never changes when items are renamed or reordered. Add, update, remove, and reorder are atomic Graph Operations. Removing an item explicitly removes its connected edges in the same undo unit. Group aliases let a generated Catalog rename its declaration without losing existing items. Safe node replacement requires every dynamic item and connection to remain valid in the target type.

## Safe node replacement

Node type is display-only on the canvas. Replacement is available from the node context menu and lists only lossless candidates. A candidate is safe when:

- every current property ID exists with a compatible value type;
- every required target property already exists or has a default;
- every connected port ID remains present with the same kind and direction;
- every dynamic port group, item value, item limit, and instance port contract remains compatible;
- existing data types, cardinality, and all other connection rules remain valid.

`graph.replaceNodeType` changes only the stable type contract and adds deterministic defaults. It preserves node ID, title, position, properties, and connections and is committed as one VS Code Undo/Redo unit. VisualBridge never silently drops properties or disconnects edges during replacement.
