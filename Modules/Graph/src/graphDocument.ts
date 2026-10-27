// Public barrel for the Graph document implementation.
//
// The implementation is split by responsibility under ./graphDocument/:
//   types.ts        public and mutable document types / constants
//   json.ts         JSON value helpers
//   diagnostics.ts  diagnostic construction helpers
//   factory.ts      default document and graph construction
//   parse.ts        document parsing and primitive readers
//   serialize.ts    deterministic serialization
//   operations.ts   operation batch parsing and application entry points
//   applyOperation.ts  individual operation application
//   mutable.ts      mutable clones and structural edge helpers
//   ports.ts        port resolution helpers
//   replacement.ts  lossless node type replacement checks
//   validation.ts / validationStructure.ts / validationEdges.ts  validation
//   references.ts   reference collection and replacement

export {
  GRAPH_DOCUMENT_FORMAT_VERSION,
  GRAPH_EDITOR_ID,
} from "./graphDocument/types";
export type {
  GraphAtomicNode,
  GraphDefinition,
  GraphDocument,
  GraphDynamicPort,
  GraphEdge,
  GraphEndpoint,
  GraphInterfaceEndpoint,
  GraphInterfacePort,
  GraphNode,
  GraphNodeEndpoint,
  GraphOperation,
  GraphPosition,
  GraphResolvedPort,
  GraphSubgraphNode,
  JsonValue,
} from "./graphDocument/types";

export {
  createDefaultPropertyValues,
  createEmptyGraphDocument,
  createGraphDefinition,
} from "./graphDocument/factory";

export { parseGraphDocument } from "./graphDocument/parse";
export { serializeGraphDocument } from "./graphDocument/serialize";

export {
  applyGraphOperations,
  renameGraphDocumentId,
} from "./graphDocument/operations";

export { validateGraphDocument } from "./graphDocument/validation";

export {
  collectGraphReferences,
  findDanglingGraphElementReferenceDiagnostics,
  replaceGraphReferenceValues,
} from "./graphDocument/references";

export { getGraphNodePorts } from "./graphDocument/ports";
export { getReplacementCandidates } from "./graphDocument/replacement";
