// 由 Protocol/Schema 生成，勿手工编辑。
// 每个正式 Schema 输出为一个命名空间，包含 Root 与全部 $defs 声明。

// 来源：Protocol/Schema/visualbridge-authoring-contracts.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-authoring-contracts.schema.json
export namespace VisualBridgeAuthoringContracts {
  export type Root = unknown;
  export type ApplyOperationsRequest = { readonly "baseHash": VisualBridgePrimitives.Sha256; readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": "graph" | "entity" | "structured" | "table"; readonly "operations": readonly DocumentOperation[]; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectFile": VisualBridgePrimitives.NormalizedPath };
  export type DocumentOperation = (GraphOperation) | (EntityOperation) | (StructuredOperation) | (TableOperation);
  export type DocumentTransport = { readonly "baseHash": VisualBridgePrimitives.Sha256; readonly "catalogHash"?: VisualBridgePrimitives.Sha256; readonly "diagnostics": readonly VisualBridgePrimitives.Diagnostic[]; readonly "document": VisualBridgePrimitives.JsonValue; readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": "graph" | "entity" | "structured" | "table"; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectId": VisualBridgePrimitives.StableId };
  export type EntityOperation = ({ readonly "title": string; readonly "type": "entity.setTitle" }) | ({ readonly "propertyId": VisualBridgePrimitives.StableId; readonly "type": "entity.setProperty"; readonly "value": VisualBridgePrimitives.JsonValue }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "componentTypeId": VisualBridgePrimitives.StableId; readonly "index"?: number; readonly "type": "entity.addComponent" }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "newComponentId": VisualBridgePrimitives.StableId; readonly "type": "entity.renameComponent" }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "type": "entity.removeComponent" }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "index": number; readonly "type": "entity.moveComponent" }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "enabled": boolean; readonly "type": "entity.setComponentEnabled" }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "propertyId": VisualBridgePrimitives.StableId; readonly "type": "entity.setComponentProperty"; readonly "value": VisualBridgePrimitives.JsonValue }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "index"?: number; readonly "newComponentId": VisualBridgePrimitives.StableId; readonly "type": "entity.duplicateComponent" });
  export type GraphAddDynamicPort = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "port": VisualBridgeGraph.DynamicPort; readonly "type": "graph.addDynamicPort" };
  export type GraphAddEdge = { readonly "edge": VisualBridgeGraph.Edge; readonly "graphId": VisualBridgePrimitives.StableId; readonly "type": "graph.addEdge" };
  export type GraphAddInterfacePort = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "port": VisualBridgeGraph.InterfacePort; readonly "type": "graph.addInterfacePort" };
  export type GraphAddNode = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "node": VisualBridgeGraph.AtomicNode; readonly "type": "graph.addNode" };
  export type GraphAddSubgraph = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "node": VisualBridgeGraph.SubgraphNode; readonly "subgraph": VisualBridgeGraph.Graph; readonly "type": "graph.addSubgraph" };
  export type GraphAssignType = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "graphTypeId": VisualBridgePrimitives.StableId; readonly "type": "graph.assignType" };
  export type GraphMoveNode = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "position": VisualBridgeGraph.Position; readonly "type": "graph.moveNode" };
  export type GraphNodeIdOperation = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "type": "graph.removeNode" };
  export type GraphOperation = (GraphRenameElement) | (GraphAddNode) | (GraphAddSubgraph) | (GraphRemoveNode) | (GraphMoveNode) | (GraphUpdateNode) | (GraphReplaceNodeType) | (GraphAddDynamicPort) | (GraphUpdateDynamicPort) | (GraphRemoveDynamicPort) | (GraphReorderDynamicPorts) | (GraphAddEdge) | (GraphRemoveEdge) | (GraphAssignType) | (GraphUpdateGraph) | (GraphAddInterfacePort) | (GraphUpdateInterfacePort) | (GraphRemoveInterfacePort) | (GraphReorderInterfacePorts);
  export type GraphRemoveDynamicPort = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "portId": VisualBridgePrimitives.StableId; readonly "type": "graph.removeDynamicPort" };
  export type GraphRemoveEdge = { readonly "edgeId": VisualBridgePrimitives.StableId; readonly "graphId": VisualBridgePrimitives.StableId; readonly "type": "graph.removeEdge" };
  export type GraphRemoveInterfacePort = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "portId": VisualBridgePrimitives.StableId; readonly "type": "graph.removeInterfacePort" };
  export type GraphRemoveNode = GraphNodeIdOperation;
  export type GraphRenameElement = { readonly "elementId": VisualBridgePrimitives.StableId; readonly "elementKind": "graph" | "node" | "interfacePort" | "dynamicPort"; readonly "graphId": VisualBridgePrimitives.StableId; readonly "newElementId": VisualBridgePrimitives.StableId; readonly "nodeId"?: VisualBridgePrimitives.StableId; readonly "type": "graph.renameElement" };
  export type GraphReorderDynamicPorts = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "portIds": readonly VisualBridgePrimitives.StableId[]; readonly "type": "graph.reorderDynamicPorts" };
  export type GraphReorderInterfacePorts = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "portIds": readonly VisualBridgePrimitives.StableId[]; readonly "type": "graph.reorderInterfacePorts" };
  export type GraphReplaceNodeType = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "nodeTypeId": VisualBridgePrimitives.StableId; readonly "type": "graph.replaceNodeType" };
  export type GraphUpdateDynamicPort = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "portId": VisualBridgePrimitives.StableId; readonly "title": string; readonly "type": "graph.updateDynamicPort"; readonly "value": VisualBridgePrimitives.JsonValue };
  export type GraphUpdateGraph = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "properties": VisualBridgePrimitives.JsonObject; readonly "title": string; readonly "type": "graph.updateGraph" };
  export type GraphUpdateInterfacePort = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "portId": VisualBridgePrimitives.StableId; readonly "title": string; readonly "type": "graph.updateInterfacePort" };
  export type GraphUpdateNode = { readonly "graphId": VisualBridgePrimitives.StableId; readonly "nodeId": VisualBridgePrimitives.StableId; readonly "properties": VisualBridgePrimitives.JsonObject; readonly "title": string; readonly "type": "graph.updateNode" };
  export type LifecycleOperation = ({ readonly "kind": "create"; readonly "parameters": VisualBridgePrimitives.JsonObject; readonly "target": LifecycleSelector }) | ({ readonly "kind": "copy"; readonly "source": LifecycleSelector; readonly "stableIdRemap": readonly StableIdentityRemap[]; readonly "target": LifecycleSelector }) | ({ readonly "kind": "move"; readonly "source": LifecycleSelector; readonly "target": LifecycleSelector }) | ({ readonly "kind": "delete"; readonly "source": LifecycleSelector; readonly "target": VisualBridgePrimitives.JsonObject });
  export type LifecycleRequest = ({ readonly "action": "preview"; readonly "operation": LifecycleOperation; readonly "projectFile": VisualBridgePrimitives.NormalizedPath }) | ({ readonly "action": "apply"; readonly "baseHashes": VisualBridgePrimitives.HashManifest; readonly "dependencies": readonly VisualBridgePrimitives.Dependency[]; readonly "operation": LifecycleOperation; readonly "planPayload": string; readonly "previewHash": VisualBridgePrimitives.Sha256; readonly "projectFile": VisualBridgePrimitives.NormalizedPath });
  export type LifecycleSelector = { readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": "graph" | "entity" | "structured" | "table"; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectId": VisualBridgePrimitives.StableId };
  export type RefactorApplyNumberRequest = (RefactorApplyRequest) & ({ readonly "newValue"?: number; readonly "oldValue"?: number; readonly [key: string]: unknown });
  export type RefactorApplyRequest = { readonly "action": "apply"; readonly "baseHashes": VisualBridgePrimitives.HashManifest; readonly "kind": "document" | "entity.component" | "graph.element" | "table.row"; readonly "newValue": VisualBridgePrimitives.ReferenceValue; readonly "oldValue": VisualBridgePrimitives.ReferenceValue; readonly "previewHash": VisualBridgePrimitives.Sha256; readonly "projectFile": VisualBridgePrimitives.NormalizedPath; readonly "target": VisualBridgePrimitives.JsonObject };
  export type RefactorApplyStringRequest = (RefactorApplyRequest) & ({ readonly "newValue"?: string; readonly "oldValue"?: string; readonly [key: string]: unknown });
  export type RefactorPreviewNumberRequest = (RefactorPreviewRequest) & ({ readonly "newValue"?: number; readonly "oldValue"?: number; readonly [key: string]: unknown });
  export type RefactorPreviewRequest = { readonly "action": "preview"; readonly "kind": "document" | "entity.component" | "graph.element" | "table.row"; readonly "newValue": VisualBridgePrimitives.ReferenceValue; readonly "oldValue": VisualBridgePrimitives.ReferenceValue; readonly "projectFile": VisualBridgePrimitives.NormalizedPath; readonly "target": VisualBridgePrimitives.JsonObject };
  export type RefactorPreviewStringRequest = (RefactorPreviewRequest) & ({ readonly "newValue"?: string; readonly "oldValue"?: string; readonly [key: string]: unknown });
  export type RefactorRequest = (RefactorPreviewStringRequest) | (RefactorPreviewNumberRequest) | (RefactorApplyStringRequest) | (RefactorApplyNumberRequest);
  export type ReferenceCandidate = { readonly "description"?: string; readonly "kind": VisualBridgePrimitives.StableId; readonly "location"?: ReferenceLocation; readonly "target": VisualBridgePrimitives.JsonObject; readonly "title": string; readonly "value": VisualBridgePrimitives.ReferenceValue };
  export type ReferenceDefinition = { readonly "allowMissing": boolean; readonly "kind": VisualBridgePrimitives.StableId; readonly "target": VisualBridgePrimitives.JsonObject };
  export type ReferenceLocation = { readonly "componentId"?: string; readonly "documentId"?: string; readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "elementId"?: string; readonly "elementKind"?: string; readonly "graphId"?: string; readonly "nodeId"?: string; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "portId"?: string; readonly "projectId": VisualBridgePrimitives.StableId; readonly "rowId"?: string; readonly "sheetId"?: string };
  export type ReferenceSearchCursor = { readonly "after": { readonly "candidateKey": string; readonly "title": string; readonly "value": VisualBridgePrimitives.ReferenceValue; readonly "valueType": "number" | "string" }; readonly "canonicalTarget": string; readonly "kind": VisualBridgePrimitives.StableId; readonly "providerContinuation"?: { readonly "cursor": string; readonly "entryHash": VisualBridgePrimitives.Sha256; readonly "generation": number; readonly "instanceId": string; readonly "providerId": VisualBridgePrimitives.StableId; readonly "snapshotHash": VisualBridgePrimitives.Sha256 }; readonly "query": string; readonly "snapshotDependencyKey": string; readonly "version": 2 };
  export type ReferenceSearchPage = ({ readonly "candidates": readonly ReferenceCandidate[]; readonly "nextCursor"?: ReferenceSearchCursor; readonly "status": "ok" }) | ({ readonly "candidates": readonly []; readonly "message": string; readonly "status": "invalidTarget" | "providerUnavailable" | "cursor.invalid" | "cursor.queryMismatch" | "cursor.snapshotChanged" });
  export type StableIdentityRemap = { readonly "from": VisualBridgePrimitives.ReferenceValue; readonly "identityKey": string; readonly "to": VisualBridgePrimitives.ReferenceValue };
  export type StructuredOperation = { readonly "fieldId": VisualBridgePrimitives.StableId; readonly "type": "structured.setField"; readonly "value": VisualBridgePrimitives.JsonValue };
  export type TableOperation = ({ readonly "columnId": VisualBridgePrimitives.StableId; readonly "rowId": string; readonly "sheetId": string; readonly "type": "table.setCell"; readonly "value": VisualBridgePrimitives.JsonValue }) | ({ readonly "cells"?: VisualBridgePrimitives.JsonObject; readonly "index"?: number; readonly "rowId": string; readonly "sheetId": string; readonly "type": "table.insertRow" }) | ({ readonly "rowId": string; readonly "sheetId": string; readonly "type": "table.removeRow" }) | ({ readonly "index": number; readonly "rowId": string; readonly "sheetId": string; readonly "type": "table.moveRow" }) | ({ readonly "index"?: number; readonly "newRowId": string; readonly "rowId": string; readonly "sheetId": string; readonly "type": "table.duplicateRow" });
  export type TransactionMutation = ({ readonly "afterHash": VisualBridgePrimitives.Sha256; readonly "beforeHash": VisualBridgePrimitives.Sha256; readonly "path": VisualBridgePrimitives.NormalizedPath }) | ({ readonly "afterHash": VisualBridgePrimitives.Sha256; readonly "path": VisualBridgePrimitives.NormalizedPath }) | ({ readonly "beforeHash": VisualBridgePrimitives.Sha256; readonly "path": VisualBridgePrimitives.NormalizedPath });
  export type TransactionPrecondition = ({ readonly "hash": VisualBridgePrimitives.Sha256; readonly "path": VisualBridgePrimitives.NormalizedPath }) | ({ readonly "expectedAbsent": true; readonly "path": VisualBridgePrimitives.NormalizedPath });
  export type TransactionResult = { readonly "maintenance"?: { readonly "code": "transaction.finalizationPending"; readonly "message": string }; readonly "mutations": readonly TransactionMutation[] };
}

// 来源：Protocol/Schema/visualbridge-catalog-source.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-catalog-source.schema.json
export namespace VisualBridgeCatalogSource {
  export type Root = ({ readonly "status": "unknown" }) | ({ readonly "providerId": Identifier; readonly "sourceHash": Hash; readonly "status": "current" }) | ({ readonly "currentSourceHash": Hash; readonly "providerId": Identifier; readonly "sourceHash": Hash; readonly "status": "stale" });
  export type Hash = string;
  export type Identifier = string;
}

// 来源：Protocol/Schema/visualbridge-editor-bridge.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-editor-bridge.schema.json
export namespace VisualBridgeEditorBridge {
  export type Root = (HelloMessage) | (WelcomeMessage) | (OpenRequest) | (RevealRequest) | (ResponseMessage) | (ErrorMessage);
  export type AbsolutePath = string;
  export type Capability = "open" | "reveal";
  export type CapabilityList = readonly Capability[];
  export type DiscoveryRecord = { readonly "capabilities": CapabilityList; readonly "formatVersion": 1; readonly "generation": ServerGeneration; readonly "pid": ProcessId; readonly "pipePath": PipePath; readonly "projectRoots": readonly AbsolutePath[]; readonly "protocolVersion": ProtocolVersion; readonly "startedAt": string; readonly "tcpPort": TcpPort; readonly "token": Token; readonly "windowId": InstanceId };
  export type ErrorCode = "bridge.capabilityMissing" | "bridge.documentAmbiguous" | "bridge.documentUnresolved" | "bridge.internalError" | "bridge.invalidJson" | "bridge.invalidMessage" | "bridge.invalidToken" | "bridge.protocolVersionMismatch" | "bridge.unknownMessageType";
  export type ErrorMessage = { readonly "code": ErrorCode; readonly "detail"?: string; readonly "type": "error" };
  export type HelloMessage = { readonly "capabilities": CapabilityList; readonly "clientInstanceId": InstanceId; readonly "protocolVersion": ProtocolVersion; readonly "token": Token; readonly "type": "hello" };
  export type InstanceId = string;
  export type OpenRequest = { readonly "documentPath": VisualBridgePrimitives.NormalizedPath; readonly "requestId": RequestId; readonly "type": "open" };
  export type PipePath = string;
  export type ProcessId = number;
  export type ProtocolVersion = 1;
  export type RequestId = string;
  export type ResponseMessage = ({ readonly "requestId": RequestId; readonly "status": "ok"; readonly "type": "response" }) | ({ readonly "error": ErrorCode; readonly "requestId": RequestId; readonly "status": "error"; readonly "type": "response" });
  export type RevealRequest = { readonly "reference": VisualBridgePrimitives.ReferenceValue; readonly "requestId": RequestId; readonly "type": "reveal" };
  export type ServerGeneration = number;
  export type TcpPort = number;
  export type Token = string;
  export type WelcomeMessage = { readonly "capabilities": CapabilityList; readonly "protocolVersion": ProtocolVersion; readonly "serverGeneration": ServerGeneration; readonly "type": "welcome"; readonly "windowId": InstanceId };
}

// 来源：Protocol/Schema/visualbridge-entity-catalog.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-entity-catalog.schema.json
export namespace VisualBridgeEntityCatalog {
  export type Root = { readonly "catalogId": Identifier; readonly "componentGroups": readonly ComponentGroup[]; readonly "componentTypes": readonly ComponentType[]; readonly "entityTypes": readonly EntityType[]; readonly "formatVersion": 1; readonly "source": VisualBridgeCatalogSource.Root; readonly "title": NonEmptyString };
  export type ComponentGroup = { readonly "aliases"?: IdentifierArray; readonly "id": Identifier; readonly "title": NonEmptyString };
  export type ComponentType = { readonly "aliases"?: IdentifierArray; readonly "description"?: NonEmptyString; readonly "groupId": Identifier; readonly "id": Identifier; readonly "menuPath"?: readonly NonEmptyString[]; readonly "properties": readonly Field[]; readonly "source"?: Source; readonly "title": NonEmptyString };
  export type Editor = ({ readonly "integer"?: boolean; readonly "kind": "select"; readonly "max"?: number; readonly "min"?: number; readonly "options": readonly EditorOption[]; readonly "readOnly"?: boolean; readonly "step"?: number }) | ({ readonly "integer"?: boolean; readonly "kind": "text" | "multiline" | "number" | "checkbox" | "color" | "reference" | "json"; readonly "max"?: number; readonly "min"?: number; readonly "options"?: never; readonly "readOnly"?: boolean; readonly "step"?: number });
  export type EditorOption = { readonly "title": NonEmptyString; readonly "value": unknown };
  export type EntityType = { readonly "aliases"?: IdentifierArray; readonly "allowedComponentGroupIds": IdentifierArray; readonly "description"?: NonEmptyString; readonly "id": Identifier; readonly "properties": readonly Field[]; readonly "title": NonEmptyString };
  export type Field = ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "array" }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type Identifier = string;
  export type IdentifierArray = readonly Identifier[];
  export type NonEmptyString = string;
  export type Reference = { readonly "allowMissing"?: boolean; readonly "kind": Identifier; readonly "target": VisualBridgePrimitives.JsonObject };
  export type Source = { readonly "providerId": Identifier; readonly "typeName": NonEmptyString };
  export type ValueDefinition = ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "valueType": "array" }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type ValueShape = ({ readonly "fields": unknown; readonly "item"?: never; readonly "valueType": "object"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item": unknown; readonly "valueType": "array"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType": "boolean" | "json" | "number" | "string"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType"?: never; readonly [key: string]: unknown });
  export type ValueType = "string" | "number" | "boolean" | "object" | "array" | "json";
}

// 来源：Protocol/Schema/visualbridge-entity.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-entity.schema.json
export namespace VisualBridgeEntity {
  export type Root = { readonly "components": readonly Component[]; readonly "documentId": Identifier; readonly "entityTypeId": Identifier; readonly "formatVersion": 1; readonly "properties": PropertyValues; readonly "title": string };
  export type Component = { readonly "componentTypeId": Identifier; readonly "enabled": boolean; readonly "id": Identifier; readonly "properties": PropertyValues };
  export type Identifier = string;
  export type PropertyValues = VisualBridgePrimitives.JsonObject;
}

// 来源：Protocol/Schema/visualbridge-graph-catalog.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-graph-catalog.schema.json
export namespace VisualBridgeGraphCatalog {
  export type Root = { readonly "catalogId": Identifier; readonly "dataTypes": readonly { readonly "accepts"?: readonly Identifier[]; readonly "acceptsAnySource"?: boolean; readonly "color"?: string; readonly "id": Identifier; readonly "title": string }[]; readonly "formatVersion": 4; readonly "graphTypes": readonly GraphType[]; readonly "nodeTypes": readonly NodeType[]; readonly "source": CatalogSource; readonly "title": string };
  export type CatalogSource = VisualBridgeCatalogSource.Root;
  export type DynamicPortGroup = { readonly "aliases"?: readonly Identifier[]; readonly "description"?: string; readonly "id": Identifier; readonly "item": ValueDefinition; readonly "listPortMode"?: "list" | "element"; readonly "maxItems"?: number; readonly "port": DynamicPortTemplate; readonly "title": string };
  export type DynamicPortTemplate = ({ readonly "dataTypeId": Identifier; readonly "direction": "input" | "output"; readonly "kind": "data"; readonly "maxConnections"?: number }) | ({ readonly "dataTypeId"?: never; readonly "direction": "input" | "output"; readonly "kind": "flow"; readonly "maxConnections"?: number });
  export type Editor = ({ readonly "integer"?: boolean; readonly "kind": "select"; readonly "max"?: number; readonly "min"?: number; readonly "options": readonly EditorOption[]; readonly "readOnly"?: boolean; readonly "step"?: number }) | ({ readonly "integer"?: boolean; readonly "kind": "text" | "multiline" | "number" | "checkbox" | "color" | "reference" | "json"; readonly "max"?: number; readonly "min"?: number; readonly "options"?: never; readonly "readOnly"?: boolean; readonly "step"?: number });
  export type EditorOption = { readonly "title": NonEmptyString; readonly "value": unknown };
  export type Field = ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "array" }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type GraphType = ({ readonly "aliases"?: readonly Identifier[]; readonly "allowSubgraphs": false; readonly "allowedNodeSelectors"?: readonly NodeSelector[]; readonly "allowedSubgraphTypeIds"?: never; readonly "description"?: string; readonly "id": Identifier; readonly "initialNodes"?: readonly InitialNode[]; readonly "nodeConstraints"?: readonly NodeConstraint[]; readonly "portConnectionRules": PortConnectionRules; readonly "properties": readonly Field[]; readonly "source"?: NodeSource; readonly "supportedCatalogIds": readonly Identifier[]; readonly "title": string; readonly "usage"?: "root" | "subgraph" | "any" }) | ({ readonly "aliases"?: readonly Identifier[]; readonly "allowSubgraphs": true; readonly "allowedNodeSelectors"?: readonly NodeSelector[]; readonly "allowedSubgraphTypeIds"?: readonly Identifier[]; readonly "description"?: string; readonly "id": Identifier; readonly "initialNodes"?: readonly InitialNode[]; readonly "nodeConstraints"?: readonly NodeConstraint[]; readonly "portConnectionRules": PortConnectionRules; readonly "properties": readonly Field[]; readonly "source"?: NodeSource; readonly "supportedCatalogIds": readonly Identifier[]; readonly "title": string; readonly "usage"?: "root" | "subgraph" | "any" }) | ({ readonly "aliases"?: readonly Identifier[]; readonly "allowSubgraphs"?: never; readonly "allowedNodeSelectors"?: readonly NodeSelector[]; readonly "allowedSubgraphTypeIds"?: readonly Identifier[]; readonly "description"?: string; readonly "id": Identifier; readonly "initialNodes"?: readonly InitialNode[]; readonly "nodeConstraints"?: readonly NodeConstraint[]; readonly "portConnectionRules": PortConnectionRules; readonly "properties": readonly Field[]; readonly "source"?: NodeSource; readonly "supportedCatalogIds": readonly Identifier[]; readonly "title": string; readonly "usage"?: "root" | "subgraph" | "any" });
  export type Identifier = string;
  export type IdentifierArray = readonly Identifier[];
  export type InitialNode = { readonly "nodeTypeId": Identifier; readonly "title"?: string };
  export type NodeConstraint = ({ readonly "id": Identifier; readonly "maxInstances"?: number; readonly "minInstances": number; readonly "selector": NodeSelector }) | ({ readonly "id": Identifier; readonly "maxInstances": number; readonly "minInstances"?: number; readonly "selector": NodeSelector });
  export type NodeSelector = ({ readonly "nodeTypeIds": readonly Identifier[]; readonly "tags"?: readonly Identifier[]; readonly "traits"?: readonly Identifier[] }) | ({ readonly "nodeTypeIds"?: readonly Identifier[]; readonly "tags": readonly Identifier[]; readonly "traits"?: readonly Identifier[] }) | ({ readonly "nodeTypeIds"?: readonly Identifier[]; readonly "tags"?: readonly Identifier[]; readonly "traits": readonly Identifier[] });
  export type NodeSource = { readonly "assemblyName"?: string; readonly "providerId": Identifier; readonly "typeName": string; readonly "wrapperTypeName"?: string };
  export type NodeType = { readonly "aliases"?: readonly Identifier[]; readonly "category": string; readonly "dynamicPortGroups"?: readonly DynamicPortGroup[]; readonly "icon"?: string; readonly "id": Identifier; readonly "menuPath"?: readonly string[]; readonly "ports": readonly Port[]; readonly "properties": readonly Field[]; readonly "source"?: NodeSource; readonly "subgraph"?: SubgraphNodeContract; readonly "tags"?: readonly Identifier[]; readonly "title": string; readonly "traits"?: readonly Identifier[] };
  export type NonEmptyString = string;
  export type Port = ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId": Identifier; readonly "description"?: NonEmptyString; readonly "direction": "input" | "output"; readonly "id": Identifier; readonly "kind": "data"; readonly "maxConnections"?: number; readonly "title": NonEmptyString }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: never; readonly "description"?: NonEmptyString; readonly "direction": "input" | "output"; readonly "id": Identifier; readonly "kind": "flow"; readonly "maxConnections"?: number; readonly "title": NonEmptyString });
  export type PortConnectionRules = { readonly "input": "single" | "multiple"; readonly "output": "single" | "multiple" };
  export type Reference = { readonly "allowMissing"?: boolean; readonly "kind": Identifier; readonly "target": VisualBridgePrimitives.JsonObject };
  export type SubgraphNodeContract = { readonly "graphTypeIds"?: readonly Identifier[] };
  export type ValueDefinition = ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "valueType": "array" }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type ValueShape = ({ readonly "fields": unknown; readonly "item"?: never; readonly "valueType": "object"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item": unknown; readonly "valueType": "array"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType": "boolean" | "json" | "number" | "string"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType"?: never; readonly [key: string]: unknown });
  export type ValueType = "string" | "number" | "boolean" | "object" | "array" | "json";
}

// 来源：Protocol/Schema/visualbridge-graph.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-graph.schema.json
export namespace VisualBridgeGraph {
  export type Root = { readonly "documentId": Identifier; readonly "formatVersion": 3; readonly "graphs": readonly Graph[]; readonly "rootGraphId": Identifier };
  export type AtomicNode = { readonly "dynamicPorts"?: readonly DynamicPort[]; readonly "id": Identifier; readonly "kind": "node"; readonly "nodeTypeId": Identifier; readonly "position": Position; readonly "properties": Properties; readonly "title": string };
  export type DynamicPort = { readonly "groupId": Identifier; readonly "id": Identifier; readonly "title": string; readonly "value": VisualBridgePrimitives.JsonValue };
  export type Edge = { readonly "id": Identifier; readonly "kind": "flow" | "data"; readonly "source": Endpoint; readonly "target": Endpoint };
  export type Endpoint = (NodeEndpoint) | (InterfaceEndpoint);
  export type Graph = { readonly "edges": readonly Edge[]; readonly "graphTypeId"?: Identifier; readonly "id": Identifier; readonly "interfacePorts": readonly InterfacePort[]; readonly "nodes": readonly ((AtomicNode) | (SubgraphNode))[]; readonly "properties": Properties; readonly "title": string };
  export type Identifier = string;
  export type InterfaceEndpoint = { readonly "kind": "interface"; readonly "portId": Identifier };
  export type InterfacePort = ({ readonly "dataTypeId": Identifier; readonly "direction": "input" | "output"; readonly "dynamic"?: boolean; readonly "id": Identifier; readonly "kind": "data"; readonly "maxConnections"?: number; readonly "title": string }) | ({ readonly "dataTypeId"?: never; readonly "direction": "input" | "output"; readonly "dynamic"?: false; readonly "id": Identifier; readonly "kind": "flow"; readonly "maxConnections"?: number; readonly "title": string });
  export type NodeEndpoint = { readonly "kind": "node"; readonly "nodeId": Identifier; readonly "portId": Identifier };
  export type Position = { readonly "x": number; readonly "y": number };
  export type Properties = VisualBridgePrimitives.JsonObject;
  export type SubgraphNode = { readonly "dynamicPorts"?: readonly DynamicPort[]; readonly "id": Identifier; readonly "kind": "subgraph"; readonly "nodeTypeId"?: Identifier; readonly "position": Position; readonly "properties": Properties; readonly "subgraphId": Identifier; readonly "title": string };
}

// 来源：Protocol/Schema/visualbridge-mcp-tools.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-mcp-tools.schema.json
export namespace VisualBridgeMcpTools {
  export type Root = unknown;
  export type McpLifecycleCreateOperation = ({ readonly "kind": "create"; readonly "parameters": { readonly "documentId": VisualBridgePrimitives.StableId; readonly "graphTypeId"?: VisualBridgePrimitives.StableId; readonly "initialNodeIds"?: readonly VisualBridgePrimitives.StableId[]; readonly "rootGraphId": VisualBridgePrimitives.StableId }; readonly "target": { readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": "graph"; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectId": VisualBridgePrimitives.StableId } }) | ({ readonly "kind": "create"; readonly "parameters": { readonly "documentId": VisualBridgePrimitives.StableId; readonly "entityTypeId": VisualBridgePrimitives.StableId; readonly "title"?: string }; readonly "target": { readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": "entity"; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectId": VisualBridgePrimitives.StableId } }) | ({ readonly "kind": "create"; readonly "parameters": { readonly "documentId": VisualBridgePrimitives.StableId }; readonly "target": { readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": "structured"; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectId": VisualBridgePrimitives.StableId } }) | ({ readonly "kind": "create"; readonly "parameters": ({ readonly "format": "csv"; readonly "physicalName"?: string }) | ({ readonly "format": "xlsx" }); readonly "target": { readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": "table"; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectId": VisualBridgePrimitives.StableId } });
  export type McpLifecycleDeleteTarget = ({ readonly "kind": "document" }) | ({ readonly "componentId": VisualBridgePrimitives.StableId; readonly "kind": "entity.component" }) | ({ readonly "elementId": VisualBridgePrimitives.StableId; readonly "elementKind": "graph"; readonly "graphId": VisualBridgePrimitives.StableId; readonly "kind": "graph.element" }) | ({ readonly "elementId": VisualBridgePrimitives.StableId; readonly "elementKind": "node" | "interfacePort"; readonly "graphId": VisualBridgePrimitives.StableId; readonly "kind": "graph.element" }) | ({ readonly "elementId": VisualBridgePrimitives.StableId; readonly "elementKind": "dynamicPort"; readonly "graphId": VisualBridgePrimitives.StableId; readonly "kind": "graph.element"; readonly "nodeId": VisualBridgePrimitives.StableId }) | ({ readonly "kind": "table.row"; readonly "rowId": string; readonly "sheetId": string });
  export type McpLifecycleOperation = (McpLifecycleCreateOperation) | ({ readonly "kind": "copy"; readonly "source": McpLifecycleSelector; readonly "stableIdRemap": readonly McpLifecycleStableIdentityRemap[]; readonly "target": McpLifecycleSelector }) | ({ readonly "kind": "move"; readonly "source": McpLifecycleSelector; readonly "target": McpLifecycleSelector }) | ({ readonly "kind": "delete"; readonly "source": McpLifecycleSelector; readonly "target": McpLifecycleDeleteTarget });
  export type McpLifecycleSelector = VisualBridgeAuthoringContracts.LifecycleSelector;
  export type McpLifecycleStableIdentityRemap = { readonly "from": McpLifecycleStableIdentityValue; readonly "identityKey": string; readonly "to": McpLifecycleStableIdentityValue };
  export type McpLifecycleStableIdentityValue = (string) | (number);
  export type ToolOutput = ({ readonly "contractVersion": 2; readonly "data": VisualBridgePrimitives.JsonObject; readonly "status": "ok" | "preview" | "applied" | "unchanged" | "invalid" | "blocked" | "conflict" }) | ({ readonly "contractVersion": 2; readonly "error": VisualBridgePrimitives.Error; readonly "status": "error" });
  export type VisualbridgeApplyOperationsInput = VisualBridgeAuthoringContracts.ApplyOperationsRequest;
  export type VisualbridgeApplyOperationsOutput = ToolOutput;
  export type VisualbridgeCatalogInput = { readonly "action": "read" | "search"; readonly "cursor"?: VisualBridgePrimitives.ShortCursor; readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": VisualBridgePrimitives.StableId; readonly "kind"?: VisualBridgePrimitives.StableId; readonly "limit"?: VisualBridgePrimitives.PageLimit; readonly "projectFile": VisualBridgePrimitives.NormalizedPath; readonly "query"?: VisualBridgePrimitives.Query; readonly "selector"?: VisualBridgePrimitives.JsonObject };
  export type VisualbridgeCatalogOutput = ToolOutput;
  export type VisualbridgeDocumentInput = { readonly "action": "read" | "search" | "validate"; readonly "cursor"?: VisualBridgePrimitives.ShortCursor; readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "editor": VisualBridgePrimitives.StableId; readonly "limit"?: VisualBridgePrimitives.DocumentPageLimit; readonly "path": VisualBridgePrimitives.NormalizedPath; readonly "projectFile": VisualBridgePrimitives.NormalizedPath; readonly "query"?: VisualBridgePrimitives.Query; readonly "selector"?: VisualBridgePrimitives.JsonObject };
  export type VisualbridgeDocumentOutput = ToolOutput;
  export type VisualbridgeDocumentLifecycleInput = ({ readonly "action": "preview"; readonly "operation": McpLifecycleOperation; readonly "projectFile": VisualBridgePrimitives.NormalizedPath }) | ({ readonly "action": "apply"; readonly "baseHashes": VisualBridgePrimitives.HashManifest; readonly "dependencies": readonly VisualBridgePrimitives.Dependency[]; readonly "operation": McpLifecycleOperation; readonly "planPayload": string; readonly "previewHash": VisualBridgePrimitives.Sha256; readonly "projectFile": VisualBridgePrimitives.NormalizedPath });
  export type VisualbridgeDocumentLifecycleOutput = ToolOutput;
  export type VisualbridgeProjectInput = { readonly "action": "discover" | "read" | "listDocuments"; readonly "cursor"?: VisualBridgePrimitives.ShortCursor; readonly "documentTypeId"?: VisualBridgePrimitives.StableId; readonly "editor"?: VisualBridgePrimitives.StableId; readonly "limit"?: VisualBridgePrimitives.PageLimit; readonly "projectFile"?: VisualBridgePrimitives.NormalizedPath; readonly "query"?: VisualBridgePrimitives.Query };
  export type VisualbridgeProjectOutput = ToolOutput;
  export type VisualbridgeRefactorReferenceInput = (VisualBridgeAuthoringContracts.RefactorPreviewStringRequest) | (VisualBridgeAuthoringContracts.RefactorPreviewNumberRequest) | (VisualBridgeAuthoringContracts.RefactorApplyStringRequest) | (VisualBridgeAuthoringContracts.RefactorApplyNumberRequest);
  export type VisualbridgeRefactorReferenceOutput = ToolOutput;
  export type VisualbridgeReferencesInput = { readonly "action": "search" | "resolve"; readonly "allowMissing"?: boolean; readonly "cursor"?: VisualBridgePrimitives.Cursor; readonly "kind": VisualBridgePrimitives.StableId; readonly "limit"?: VisualBridgePrimitives.PageLimit; readonly "projectFile": VisualBridgePrimitives.NormalizedPath; readonly "query"?: VisualBridgePrimitives.Query; readonly "target"?: VisualBridgePrimitives.JsonObject; readonly "value"?: VisualBridgePrimitives.ReferenceValue };
  export type VisualbridgeReferencesOutput = ToolOutput;
}

// 来源：Protocol/Schema/visualbridge-primitives.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-primitives.schema.json
export namespace VisualBridgePrimitives {
  export type Root = unknown;
  export type Alias = string;
  export type Cursor = string;
  export type Dependency = { readonly "hash": Sha256; readonly "key": string; readonly "kind": "project" | "catalog" | "documentSet" | "referenceIndex"; readonly "paths": readonly NormalizedPath[] };
  export type Diagnostic = { readonly "code": StableId; readonly "message": string; readonly "path": string; readonly "severity": "error" | "warning" };
  export type DocumentPageLimit = number;
  export type Error = { readonly "code": StableId; readonly "details"?: JsonValue; readonly "message": string };
  export type FormatVersion = number;
  export type HashManifest = { readonly [key: string]: Sha256 };
  export type JsonObject = { readonly [key: string]: JsonValue };
  export type JsonValue = (null) | (boolean) | (number) | (string) | (readonly JsonValue[]) | ({ readonly [key: string]: JsonValue });
  export type LockOwner = { readonly "pid": number; readonly "startedAt": string; readonly "token": string; readonly "version": 1 };
  export type NormalizedPath = string;
  export type PageLimit = number;
  export type Query = string;
  export type ReferenceValue = (string) | (number);
  export type Sha256 = string;
  export type ShortCursor = string;
  export type StableId = string;
}

// 来源：Protocol/Schema/visualbridge-project-provider.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-project-provider.schema.json
export namespace VisualBridgeProjectProvider {
  export type Root = (HostMessage) | (ProviderResponse);
  export type CancelRequestNotification = { readonly "jsonrpc": "2.0"; readonly "method": "$/cancelRequest"; readonly "params": { readonly "id": RequestId } };
  export type Capabilities = ({ readonly "reference": { readonly "kinds": readonly Identifier[] }; readonly "validator"?: { readonly "documentTypes": readonly Identifier[] } }) | ({ readonly "reference"?: { readonly "kinds": readonly Identifier[] }; readonly "validator": { readonly "documentTypes": readonly Identifier[] } });
  export type CapabilitiesRequest = (RequestBase) & ({ readonly "method": "capabilities"; readonly "params": EmptyObject; readonly [key: string]: unknown });
  export type EmptyObject = {  };
  export type ErrorData = { readonly "details"?: JsonValue; readonly "kind": "parseError" | "invalidRequest" | "methodNotFound" | "invalidParams" | "internalError" | "providerUnavailable" | "protocolVersionMismatch" | "protocolViolation"; readonly "retryable": boolean };
  export type Hash = string;
  export type HostMessage = (InitializeRequest) | (CapabilitiesRequest) | (ReferenceSearchRequest) | (ReferenceResolveRequest) | (ReferenceValidateTargetRequest) | (ValidatorDiagnosticsRequest) | (ShutdownRequest) | (ProjectChangedNotification) | (CancelRequestNotification);
  export type Identifier = string;
  export type InitializeRequest = (RequestBase) & ({ readonly "method": "initialize"; readonly "params": { readonly "project": ProjectSnapshot; readonly "protocolVersion": 2; readonly "providerId": Identifier }; readonly [key: string]: unknown });
  export type InvalidTargetResult = { readonly "issues": readonly { readonly "message": string; readonly "path": string }[]; readonly "message": string; readonly "status": "invalidTarget" };
  export type JsonObject = { readonly [key: string]: JsonValue };
  export type JsonValue = (null) | (boolean) | (number) | (string) | (readonly JsonValue[]) | ({ readonly [key: string]: JsonValue });
  export type ProjectChangedNotification = { readonly "jsonrpc": "2.0"; readonly "method": "projectChanged"; readonly "params": { readonly "documentSetHash": Hash; readonly "projectHash": Hash; readonly "projectId": Identifier; readonly "revision": number } };
  export type ProjectSnapshot = { readonly "projectHash": Hash; readonly "projectId": Identifier };
  export type ProviderCursor = string;
  export type ProviderResponse = ({ readonly "id": RequestId; readonly "jsonrpc": "2.0"; readonly "result": SuccessResult }) | ({ readonly "error": StructuredError; readonly "id": RequestId; readonly "jsonrpc": "2.0" });
  export type ProviderUnavailableResult = { readonly "message": string; readonly "retryable": boolean; readonly "status": "providerUnavailable" };
  export type ReferenceCandidate = { readonly "description"?: string; readonly "kind": Identifier; readonly "location"?: ReferenceLocation; readonly "target": JsonObject; readonly "title": string; readonly "value": string | number };
  export type ReferenceLocation = { readonly "componentId"?: string; readonly "documentId"?: string; readonly "documentTypeId": Identifier; readonly "elementId"?: string; readonly "elementKind"?: string; readonly "graphId"?: string; readonly "nodeId"?: string; readonly "path": RelativePath; readonly "portId"?: string; readonly "projectId": Identifier; readonly "rowId"?: string; readonly "sheetId"?: string };
  export type ReferenceResolveRequest = (RequestBase) & ({ readonly "method": "reference/resolve"; readonly "params": { readonly "kind": Identifier; readonly "target": JsonObject; readonly "value": string | number }; readonly [key: string]: unknown });
  export type ReferenceResolveResult = ({ readonly "candidates": readonly ReferenceCandidate[]; readonly "status": "resolved" }) | ({ readonly "candidates": readonly []; readonly "status": "missing" }) | ({ readonly "candidates": readonly ReferenceCandidate[]; readonly "status": "ambiguous" }) | (InvalidTargetResult) | (ProviderUnavailableResult);
  export type ReferenceSearchRequest = (RequestBase) & ({ readonly "method": "reference/search"; readonly "params": { readonly "cursor"?: ProviderCursor; readonly "kind": Identifier; readonly "limit": number; readonly "query": string; readonly "snapshotHash"?: Hash; readonly "target": JsonObject }; readonly [key: string]: unknown });
  export type ReferenceSearchResult = ({ readonly "candidates": readonly ReferenceCandidate[]; readonly "nextCursor"?: ProviderCursor; readonly "snapshotHash": Hash; readonly "status": "ok" }) | ({ readonly "message": string; readonly "status": "cursor.invalid" | "cursor.queryMismatch" | "cursor.snapshotChanged" }) | (InvalidTargetResult) | (ProviderUnavailableResult);
  export type ReferenceValidateTargetRequest = (RequestBase) & ({ readonly "method": "reference/validateTarget"; readonly "params": { readonly "kind": Identifier; readonly "target": JsonObject }; readonly [key: string]: unknown });
  export type ReferenceValidateTargetResult = ({ readonly "status": "valid" }) | (InvalidTargetResult) | (ProviderUnavailableResult);
  export type RelativePath = string;
  export type RequestBase = { readonly "id": RequestId; readonly "jsonrpc": "2.0"; readonly "method": string; readonly "params": JsonObject };
  export type RequestId = (string) | (number);
  export type ShutdownRequest = (RequestBase) & ({ readonly "method": "shutdown"; readonly "params": EmptyObject; readonly [key: string]: unknown });
  export type StructuredError = ({ readonly "code": -32700; readonly "data": (ErrorData) & ({ readonly "kind": "parseError"; readonly [key: string]: unknown }); readonly "message": string }) | ({ readonly "code": -32600; readonly "data": (ErrorData) & ({ readonly "kind": "invalidRequest"; readonly [key: string]: unknown }); readonly "message": string }) | ({ readonly "code": -32601; readonly "data": (ErrorData) & ({ readonly "kind": "methodNotFound"; readonly [key: string]: unknown }); readonly "message": string }) | ({ readonly "code": -32602; readonly "data": (ErrorData) & ({ readonly "kind": "invalidParams"; readonly [key: string]: unknown }); readonly "message": string }) | ({ readonly "code": -32603; readonly "data": (ErrorData) & ({ readonly "kind": "internalError"; readonly [key: string]: unknown }); readonly "message": string }) | ({ readonly "code": -32001; readonly "data": (ErrorData) & ({ readonly "kind": "providerUnavailable"; readonly [key: string]: unknown }); readonly "message": string }) | ({ readonly "code": -32002; readonly "data": (ErrorData) & ({ readonly "kind": "protocolVersionMismatch"; readonly [key: string]: unknown }); readonly "message": string }) | ({ readonly "code": -32003; readonly "data": (ErrorData) & ({ readonly "kind": "protocolViolation"; readonly [key: string]: unknown }); readonly "message": string });
  export type SuccessResult = ({ readonly "protocolVersion": 2 }) | ({ readonly "capabilities": Capabilities }) | (ReferenceSearchResult) | (ReferenceResolveResult) | (ReferenceValidateTargetResult) | (ValidatorDiagnosticsResult) | (EmptyObject);
  export type ValidatorDiagnosticsRequest = (RequestBase) & ({ readonly "method": "validator/diagnostics"; readonly "params": { readonly "documents": readonly { readonly "content": JsonValue; readonly "documentTypeId": Identifier; readonly "path": RelativePath; readonly "sourceHash": Hash }[]; readonly "project": ProjectSnapshot }; readonly [key: string]: unknown });
  export type ValidatorDiagnosticsResult = ({ readonly "diagnostics": readonly ({ readonly "code": Identifier; readonly "documentPath": RelativePath; readonly "documentTypeId": Identifier; readonly "message": string; readonly "path": string; readonly "severity": "error" | "warning" })[]; readonly "status": "ok" }) | (ProviderUnavailableResult);
}

// 来源：Protocol/Schema/visualbridge-project.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-project.schema.json
export namespace VisualBridgeProject {
  export type Root = { readonly "documentRoots": readonly string[]; readonly "documentTypes": readonly ({ readonly "catalogs"?: readonly string[]; readonly "editor": string; readonly "exclude"?: readonly ((SafeGlob) & (string))[]; readonly "id": string; readonly "include": readonly ((SafeGlob) & (string))[] })[]; readonly "formatVersion": 1; readonly "projectId": string; readonly "providers"?: readonly Provider[]; readonly "tableLayout"?: { readonly "dataStartRow": number; readonly "nameKeyRow": number } };
  export type Identifier = string;
  export type Provider = { readonly "args": readonly string[]; readonly "capabilities": ProviderCapabilities; readonly "entry": string; readonly "id": Identifier };
  export type ProviderCapabilities = ({ readonly "reference": { readonly "kinds": readonly Identifier[] }; readonly "validator"?: { readonly "documentTypes": readonly Identifier[] } }) | ({ readonly "reference"?: { readonly "kinds": readonly Identifier[] }; readonly "validator": { readonly "documentTypes": readonly Identifier[] } });
  export type SafeGlob = string;
}

// 来源：Protocol/Schema/visualbridge-runtime-bridge.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-runtime-bridge.schema.json
export namespace VisualBridgeRuntimeBridge {
  export type Root = (HelloMessage) | (WelcomeMessage) | (SnapshotRequest) | (ResponseMessage) | (EventMessage) | (ErrorMessage);
  export type Capability = "snapshot" | "events" | "lease" | "sources";
  export type CapabilityList = readonly Capability[];
  export type CoreVersion = 1;
  export type DiscoveryRecord = { readonly "capabilities": CapabilityList; readonly "coreVersion": CoreVersion; readonly "formatVersion": 1; readonly "generation": Generation; readonly "instanceId": InstanceId; readonly "kind": InstanceKind; readonly "pid": ProcessId; readonly "protocolVersion": ProtocolVersion; readonly "startedAt": string; readonly "tcpPort": TcpPort; readonly "token": Token };
  export type DocumentSnapshot = { readonly "data": { readonly [key: string]: unknown }; readonly "documentId": string; readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "kind": string };
  export type DocumentSource = { readonly "documentId": string; readonly "documentTypeId": VisualBridgePrimitives.StableId; readonly "sourcePath": VisualBridgePrimitives.NormalizedPath; readonly "sourceSha256": VisualBridgePrimitives.Sha256 };
  export type ErrorCode = "runtime.capabilityMissing" | "runtime.internalError" | "runtime.invalidJson" | "runtime.invalidMessage" | "runtime.invalidToken" | "runtime.leaseDenied" | "runtime.leaseNotHeld" | "runtime.leaseRequired" | "runtime.protocolVersionMismatch" | "runtime.unknownMessageType" | "runtime.unknownRequest";
  export type ErrorMessage = { readonly "code": ErrorCode; readonly "detail"?: string; readonly "type": "error" };
  export type EventMessage = { readonly "documents": readonly DocumentSnapshot[]; readonly "event": "artifactsChanged"; readonly "type": "event" };
  export type Generation = number;
  export type HelloMessage = { readonly "capabilities": CapabilityList; readonly "clientInstanceId": string; readonly "coreVersion": CoreVersion; readonly "protocolVersion": ProtocolVersion; readonly "token": Token; readonly "type": "hello" };
  export type InstanceId = string;
  export type InstanceKind = "editor-play" | "player";
  export type ProcessId = number;
  export type ProtocolVersion = 1;
  export type RequestId = string;
  export type ResponseMessage = (({ readonly "documents": readonly DocumentSnapshot[]; readonly "requestId": RequestId; readonly "sources"?: readonly DocumentSource[]; readonly "status": "ok"; readonly "type": "response" }) | ({ readonly "documents"?: readonly DocumentSnapshot[]; readonly "requestId": RequestId; readonly "sources": readonly DocumentSource[]; readonly "status": "ok"; readonly "type": "response" }) | ({ readonly "documents"?: readonly DocumentSnapshot[]; readonly "requestId": RequestId; readonly "sources"?: readonly DocumentSource[]; readonly "status": "ok"; readonly "type": "response" })) | ({ readonly "detail"?: string; readonly "error": ErrorCode; readonly "requestId": RequestId; readonly "status": "error"; readonly "type": "response" });
  export type SnapshotRequest = ({ readonly "action": "getSnapshot"; readonly "documentTypeIds"?: readonly VisualBridgePrimitives.StableId[]; readonly "requestId": RequestId; readonly "type": "request" }) | ({ readonly "action": "acquireLease" | "releaseLease" | "getDocumentSources"; readonly "documentTypeIds"?: never; readonly "requestId": RequestId; readonly "type": "request" });
  export type TcpPort = number;
  export type Token = string;
  export type WelcomeMessage = { readonly "capabilities": CapabilityList; readonly "coreVersion": CoreVersion; readonly "generation": Generation; readonly "instanceId": InstanceId; readonly "kind": InstanceKind; readonly "protocolVersion": ProtocolVersion; readonly "startedAt": string; readonly "type": "welcome" };
}

// 来源：Protocol/Schema/visualbridge-structured-catalog.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-structured-catalog.schema.json
export namespace VisualBridgeStructuredCatalog {
  export type Root = { readonly "catalogId": Identifier; readonly "configTypes": readonly ConfigType[]; readonly "formatVersion": 1; readonly "source": VisualBridgeCatalogSource.Root; readonly "title": NonEmptyString };
  export type ConfigType = { readonly "aliases": readonly Identifier[]; readonly "description"?: NonEmptyString; readonly "id": Identifier; readonly "properties": readonly Field[]; readonly "source"?: Source; readonly "title": NonEmptyString };
  export type Editor = ({ readonly "integer"?: boolean; readonly "kind": "select"; readonly "max"?: number; readonly "min"?: number; readonly "options": readonly EditorOption[]; readonly "readOnly"?: boolean; readonly "step"?: number }) | ({ readonly "integer"?: boolean; readonly "kind": "text" | "multiline" | "number" | "checkbox" | "color" | "reference" | "json"; readonly "max"?: number; readonly "min"?: number; readonly "options"?: never; readonly "readOnly"?: boolean; readonly "step"?: number });
  export type EditorOption = { readonly "title": NonEmptyString; readonly "value": unknown };
  export type Field = ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "array" }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type Identifier = string;
  export type IdentifierArray = readonly Identifier[];
  export type NonEmptyString = string;
  export type Reference = { readonly "allowMissing"?: boolean; readonly "kind": Identifier; readonly "target": VisualBridgePrimitives.JsonObject };
  export type Source = { readonly "providerId": Identifier; readonly "typeName": NonEmptyString };
  export type ValueDefinition = ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "valueType": "array" }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type ValueShape = ({ readonly "fields": unknown; readonly "item"?: never; readonly "valueType": "object"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item": unknown; readonly "valueType": "array"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType": "boolean" | "json" | "number" | "string"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType"?: never; readonly [key: string]: unknown });
  export type ValueType = "string" | "number" | "boolean" | "object" | "array" | "json";
}

// 来源：Protocol/Schema/visualbridge-structured.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-structured.schema.json
export namespace VisualBridgeStructured {
  export type Root = { readonly "documentId": Identifier; readonly "formatVersion": 1; readonly "properties": VisualBridgePrimitives.JsonObject };
  export type Identifier = string;
}

// 来源：Protocol/Schema/visualbridge-table-catalog.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-table-catalog.schema.json
export namespace VisualBridgeTableCatalog {
  export type Root = { readonly "catalogId": Identifier; readonly "formatVersion": 1; readonly "source": VisualBridgeCatalogSource.Root; readonly "tableTypes": readonly TableType[]; readonly "title": NonEmptyString };
  export type CellEncoding = ({ readonly "kind": "scalar" }) | ({ readonly "kind": "json" }) | ({ readonly "item"?: CellEncoding; readonly "kind": "delimited"; readonly "separator": string });
  export type Column = ({ readonly "aliases"?: IdentifierArray; readonly "cellEncoding": CellEncoding; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "id": Identifier; readonly "item"?: never; readonly "nameKey": NonEmptyString; readonly "nameKeyAliases"?: readonly NonEmptyString[]; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "aliases"?: IdentifierArray; readonly "cellEncoding": CellEncoding; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item": ValueDefinition; readonly "nameKey": NonEmptyString; readonly "nameKeyAliases"?: readonly NonEmptyString[]; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "array" }) | ({ readonly "aliases"?: IdentifierArray; readonly "cellEncoding": CellEncoding; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item"?: never; readonly "nameKey": NonEmptyString; readonly "nameKeyAliases"?: readonly NonEmptyString[]; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type Csv = { readonly "delimiter": string };
  export type Editor = ({ readonly "integer"?: boolean; readonly "kind": "select"; readonly "max"?: number; readonly "min"?: number; readonly "options": readonly EditorOption[]; readonly "readOnly"?: boolean; readonly "step"?: number }) | ({ readonly "integer"?: boolean; readonly "kind": "text" | "multiline" | "number" | "checkbox" | "color" | "reference" | "json"; readonly "max"?: number; readonly "min"?: number; readonly "options"?: never; readonly "readOnly"?: boolean; readonly "step"?: number });
  export type EditorOption = { readonly "title": NonEmptyString; readonly "value": unknown };
  export type Field = ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "array" }) | ({ readonly "aliases"?: IdentifierArray; readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "description"?: NonEmptyString; readonly "editor"?: Editor; readonly "fields"?: never; readonly "id": Identifier; readonly "item"?: never; readonly "reference"?: Reference; readonly "title": NonEmptyString; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type Identifier = string;
  export type IdentifierArray = readonly Identifier[];
  export type NonEmptyString = string;
  export type Partition = { readonly "deduplicateByColumnId": Identifier; readonly "duplicatePolicy": "error" | "keepFirst" | "keepLast"; readonly "namePattern": string };
  export type Reference = { readonly "allowMissing"?: boolean; readonly "kind": Identifier; readonly "target": VisualBridgePrimitives.JsonObject };
  export type Sheet = { readonly "aliases"?: IdentifierArray; readonly "columns": readonly Column[]; readonly "id": Identifier; readonly "keyColumnId"?: Identifier; readonly "name": NonEmptyString; readonly "nameAliases"?: readonly NonEmptyString[]; readonly "partition"?: Partition; readonly "rowDisplayNamePattern": string; readonly "title": NonEmptyString };
  export type Source = { readonly "providerId": Identifier; readonly "typeName": NonEmptyString };
  export type TableType = { readonly "aliases"?: IdentifierArray; readonly "csv"?: Csv; readonly "description"?: NonEmptyString; readonly "id": Identifier; readonly "sheets": readonly Sheet[]; readonly "source"?: Source; readonly "title": NonEmptyString };
  export type ValueDefinition = ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields": readonly Field[]; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": (ValueType) & ("object") }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item": ValueDefinition; readonly "reference"?: Reference; readonly "valueType": "array" }) | ({ readonly "dataTypeId"?: Identifier; readonly "defaultValue": unknown; readonly "editor"?: Editor; readonly "fields"?: never; readonly "item"?: never; readonly "reference"?: Reference; readonly "valueType": "string" | "number" | "boolean" | "json" });
  export type ValueShape = ({ readonly "fields": unknown; readonly "item"?: never; readonly "valueType": "object"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item": unknown; readonly "valueType": "array"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType": "boolean" | "json" | "number" | "string"; readonly [key: string]: unknown }) | ({ readonly "fields"?: never; readonly "item"?: never; readonly "valueType"?: never; readonly [key: string]: unknown });
  export type ValueType = "string" | "number" | "boolean" | "object" | "array" | "json";
}

// 来源：Protocol/Schema/visualbridge-unity-integration-profile.schema.json
// $id: https://visualbridge.dev/schema/visualbridge-unity-integration-profile.schema.json
export namespace VisualBridgeUnityIntegrationProfile {
  export type Root = { readonly "authoringProject": ProjectRelativePath; readonly "catalogExports": readonly CatalogExport[]; readonly "compileOutputRoot": ProjectRelativePath; readonly "formatVersion": 1 };
  export type CatalogExport = { readonly "catalogId": Identifier; readonly "output": (ProjectRelativePath) & (string); readonly "title": NonEmptyString; readonly "types": readonly string[] };
  export type Identifier = string;
  export type NonEmptyString = string;
  export type ProjectRelativePath = string;
}
