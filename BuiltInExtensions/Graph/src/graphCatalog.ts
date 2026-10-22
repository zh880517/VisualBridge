// Public barrel for the Graph Catalog implementation.
//
// The implementation is split by responsibility under ./graphCatalog/:
//   types.ts       public catalog types and constants
//   factory.ts     empty catalog / registry construction
//   diagnostics.ts diagnostic and record helpers
//   readers.ts     primitive field readers
//   validation.ts  unique id / alias validation
//   parsing.ts     catalog JSON parsing
//   parse.ts       parseGraphCatalog entry point
//   serialize.ts   deterministic catalog serialization
//   registry.ts    catalog registry construction and validation
//   lookup.ts      type resolution, selector matching, node search
//   ports.ts       port / property / dynamic group resolution

export { GRAPH_CATALOG_FORMAT_VERSION } from "./graphCatalog/types";
export type {
  GraphCatalog,
  GraphCatalogIdentity,
  GraphCatalogLookup,
  GraphCatalogRegistry,
  GraphDataTypeDefinition,
  GraphDynamicPortGroupDefinition,
  GraphInitialNodeDefinition,
  GraphListPortMode,
  GraphNodeCountConstraint,
  GraphNodeSearchOptions,
  GraphNodeSelector,
  GraphNodeSourceDefinition,
  GraphNodeTypeDefinition,
  GraphPortConnectionMode,
  GraphPortDefinition,
  GraphPortDirection,
  GraphPortKind,
  GraphSubgraphNodeDefinition,
  GraphTypeDefinition,
  RegisteredGraphDataTypeDefinition,
  RegisteredGraphNodeTypeDefinition,
  RegisteredGraphTypeDefinition,
} from "./graphCatalog/types";

export {
  createEmptyGraphCatalog,
  createEmptyGraphCatalogRegistry,
} from "./graphCatalog/factory";

export { parseGraphCatalog } from "./graphCatalog/parse";
export { serializeGraphCatalog } from "./graphCatalog/serialize";
export { buildGraphCatalogRegistry } from "./graphCatalog/registry";

export {
  isNodeTypeAllowed,
  matchesNodeSelector,
  resolveGraphType,
  resolveNodeType,
  searchGraphNodeTypes,
} from "./graphCatalog/lookup";

export {
  isDataTypeAssignable,
  resolveDynamicPortGroup,
  resolveListPortDefinition,
  resolveNodePort,
  resolveNodeProperty,
  resolvePortDefinition,
  resolvePropertyDefinition,
} from "./graphCatalog/ports";
