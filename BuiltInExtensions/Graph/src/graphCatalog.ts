import type { DocumentDiagnostic, DocumentParseResult } from "@visualbridge/core";
import type { JsonValue } from "./graphDocument";

export const GRAPH_CATALOG_FORMAT_VERSION = 2;

export type GraphPortKind = "flow" | "data";
export type GraphPortDirection = "input" | "output";
export type GraphPropertyValueType = "string" | "number" | "boolean" | "json";
export type GraphPropertyEditorKind = "text" | "multiline" | "number" | "checkbox" | "select" | "json" | "reference";

export interface GraphDataTypeDefinition {
  readonly id: string;
  readonly title: string;
  readonly accepts: readonly string[];
}

export interface GraphPortDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly kind: GraphPortKind;
  readonly direction: GraphPortDirection;
  readonly dataTypeId?: string;
  readonly maxConnections?: number;
}

export interface GraphPropertyEditorOption {
  readonly title: string;
  readonly value: JsonValue;
}

export interface GraphPropertyEditorDefinition {
  readonly kind: GraphPropertyEditorKind;
  readonly readOnly: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly options: readonly GraphPropertyEditorOption[];
}

export interface GraphPropertyDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly valueType: GraphPropertyValueType;
  readonly dataTypeId?: string;
  readonly required: boolean;
  readonly defaultValue?: JsonValue;
  readonly editor?: GraphPropertyEditorDefinition;
}

export interface GraphDynamicPortGroupDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly port: {
    readonly kind: GraphPortKind;
    readonly direction: GraphPortDirection;
    readonly dataTypeId?: string;
    readonly maxConnections?: number;
  };
  readonly item: {
    readonly valueType: GraphPropertyValueType;
    readonly dataTypeId?: string;
    readonly defaultValue: JsonValue;
    readonly editor?: GraphPropertyEditorDefinition;
  };
  readonly maxItems?: number;
}

export interface GraphNodeSourceDefinition {
  readonly providerId: string;
  readonly assemblyName?: string;
  readonly typeName: string;
  readonly wrapperTypeName?: string;
}

export interface GraphNodeSelector {
  readonly nodeTypeIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly traits?: readonly string[];
}

export interface GraphNodeCountConstraint {
  readonly id: string;
  readonly selector: GraphNodeSelector;
  readonly minInstances?: number;
  readonly maxInstances?: number;
}

export interface GraphInitialNodeDefinition {
  readonly nodeTypeId: string;
  readonly title?: string;
}

export interface GraphTypeDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly usage: "root" | "subgraph" | "any";
  readonly source?: GraphNodeSourceDefinition;
  readonly allowedNodeSelectors?: readonly GraphNodeSelector[];
  readonly properties: readonly GraphPropertyDefinition[];
  readonly nodeConstraints: readonly GraphNodeCountConstraint[];
  readonly initialNodes: readonly GraphInitialNodeDefinition[];
  readonly allowSubgraphs: boolean;
  readonly allowedSubgraphTypeIds?: readonly string[];
}

export interface GraphSubgraphNodeDefinition {
  readonly graphTypeIds?: readonly string[];
}

export interface GraphNodeTypeDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly category: string;
  readonly menuPath: readonly string[];
  readonly tags: readonly string[];
  readonly traits: readonly string[];
  readonly source?: GraphNodeSourceDefinition;
  readonly subgraph?: GraphSubgraphNodeDefinition;
  readonly ports: readonly GraphPortDefinition[];
  readonly dynamicPortGroups: readonly GraphDynamicPortGroupDefinition[];
  readonly properties: readonly GraphPropertyDefinition[];
}

export interface GraphCatalog {
  readonly formatVersion: typeof GRAPH_CATALOG_FORMAT_VERSION;
  readonly catalogId: string;
  readonly dataTypes: readonly GraphDataTypeDefinition[];
  readonly graphTypes: readonly GraphTypeDefinition[];
  readonly nodeTypes: readonly GraphNodeTypeDefinition[];
}

export function createEmptyGraphCatalog(catalogId = "empty"): GraphCatalog {
  return {
    formatVersion: GRAPH_CATALOG_FORMAT_VERSION,
    catalogId,
    dataTypes: [],
    graphTypes: [],
    nodeTypes: [],
  };
}

export function parseGraphCatalog(text: string): DocumentParseResult<GraphCatalog> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("graphCatalog.invalidJson", "$", formatError(errorValue));
  }

  if (!isRecord(value)) {
    return failure("graphCatalog.invalidRoot", "$", "Graph Catalog must contain a JSON object.");
  }

  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(value, ["formatVersion", "catalogId", "dataTypes", "graphTypes", "nodeTypes"], "$", diagnostics);
  if (value.formatVersion !== 1 && value.formatVersion !== GRAPH_CATALOG_FORMAT_VERSION) {
    diagnostics.push(error(
      "graphCatalog.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${GRAPH_CATALOG_FORMAT_VERSION}.`,
    ));
  }

  const catalogId = readIdentifier(value.catalogId, "catalogId", diagnostics);
  const dataTypes = readDataTypes(value.dataTypes, diagnostics);
  const nodeTypes = readNodeTypes(value.nodeTypes, diagnostics);
  const graphTypes = value.graphTypes === undefined
    ? []
    : readGraphTypes(value.graphTypes, diagnostics);
  validateUniqueIds(dataTypes, "dataTypes", "graphCatalog.duplicateDataTypeId", diagnostics);
  validateUniqueIds(nodeTypes, "nodeTypes", "graphCatalog.duplicateNodeTypeId", diagnostics);
  validateUniqueIds(graphTypes, "graphTypes", "graphCatalog.duplicateGraphTypeId", diagnostics);

  const dataTypeIds = new Set(["any", ...dataTypes.map((dataType) => dataType.id)]);
  dataTypes.forEach((dataType, dataTypeIndex) => {
    dataType.accepts.forEach((acceptedTypeId, acceptedTypeIndex) => {
      if (!dataTypeIds.has(acceptedTypeId)) {
        diagnostics.push(error(
          "graphCatalog.unknownAcceptedDataType",
          `dataTypes[${dataTypeIndex}].accepts[${acceptedTypeIndex}]`,
          `Data type '${acceptedTypeId}' is not declared.`,
        ));
      }
    });
  });

  validateAliases(nodeTypes, "nodeTypes", "graphCatalog.duplicateNodeTypeAlias", diagnostics);
  validateAliases(graphTypes, "graphTypes", "graphCatalog.duplicateGraphTypeAlias", diagnostics);
  nodeTypes.forEach((nodeType, nodeTypeIndex) => {
    validateUniqueIds(nodeType.ports, `nodeTypes[${nodeTypeIndex}].ports`, "graphCatalog.duplicatePortId", diagnostics);
    validateAliases(
      nodeType.ports,
      `nodeTypes[${nodeTypeIndex}].ports`,
      "graphCatalog.duplicatePortAlias",
      diagnostics,
    );
    nodeType.subgraph?.graphTypeIds?.forEach((graphTypeId, graphTypeIndex) => {
      if (!graphTypes.some((graphType) => graphType.id === graphTypeId || graphType.aliases.includes(graphTypeId))) {
        diagnostics.push(error(
          "graphCatalog.unknownSubgraphTargetType",
          `nodeTypes[${nodeTypeIndex}].subgraph.graphTypeIds[${graphTypeIndex}]`,
          `Graph type '${graphTypeId}' is not declared.`,
        ));
      }
    });
    validateUniqueIds(
      nodeType.properties,
      `nodeTypes[${nodeTypeIndex}].properties`,
      "graphCatalog.duplicatePropertyId",
      diagnostics,
    );
    validateAliases(
      nodeType.properties,
      `nodeTypes[${nodeTypeIndex}].properties`,
      "graphCatalog.duplicatePropertyAlias",
      diagnostics,
    );
    validateUniqueIds(
      nodeType.dynamicPortGroups,
      `nodeTypes[${nodeTypeIndex}].dynamicPortGroups`,
      "graphCatalog.duplicateDynamicPortGroupId",
      diagnostics,
    );
    validateAliases(
      nodeType.dynamicPortGroups,
      `nodeTypes[${nodeTypeIndex}].dynamicPortGroups`,
      "graphCatalog.duplicateDynamicPortGroupAlias",
      diagnostics,
    );
    nodeType.ports.forEach((port, portIndex) => {
      if (port.dataTypeId !== undefined && !dataTypeIds.has(port.dataTypeId)) {
        diagnostics.push(error(
          "graphCatalog.unknownPortDataType",
          `nodeTypes[${nodeTypeIndex}].ports[${portIndex}].dataTypeId`,
          `Data type '${port.dataTypeId}' is not declared.`,
        ));
      }
    });
    nodeType.properties.forEach((property, propertyIndex) => {
      if (property.dataTypeId !== undefined && !dataTypeIds.has(property.dataTypeId)) {
        diagnostics.push(error(
          "graphCatalog.unknownPropertyDataType",
          `nodeTypes[${nodeTypeIndex}].properties[${propertyIndex}].dataTypeId`,
          `Data type '${property.dataTypeId}' is not declared.`,
        ));
      }
    });
    nodeType.dynamicPortGroups.forEach((group, groupIndex) => {
      if (group.port.dataTypeId !== undefined && !dataTypeIds.has(group.port.dataTypeId)) {
        diagnostics.push(error(
          "graphCatalog.unknownDynamicPortDataType",
          `nodeTypes[${nodeTypeIndex}].dynamicPortGroups[${groupIndex}].port.dataTypeId`,
          `Data type '${group.port.dataTypeId}' is not declared.`,
        ));
      }
      if (group.item.dataTypeId !== undefined && !dataTypeIds.has(group.item.dataTypeId)) {
        diagnostics.push(error(
          "graphCatalog.unknownDynamicPortItemDataType",
          `nodeTypes[${nodeTypeIndex}].dynamicPortGroups[${groupIndex}].item.dataTypeId`,
          `Data type '${group.item.dataTypeId}' is not declared.`,
        ));
      }
    });
    if (nodeType.subgraph !== undefined) {
      nodeType.ports.forEach((port, portIndex) => {
        if (port.kind !== "data") {
          diagnostics.push(error(
            "graphCatalog.subgraphStaticFlowPort",
            `nodeTypes[${nodeTypeIndex}].ports[${portIndex}].kind`,
            "Typed subgraph static ports must be data ports; flow crosses the subgraph interface.",
          ));
        }
      });
      nodeType.dynamicPortGroups.forEach((group, groupIndex) => {
        if (group.port.kind !== "data") {
          diagnostics.push(error(
            "graphCatalog.subgraphDynamicFlowPort",
            `nodeTypes[${nodeTypeIndex}].dynamicPortGroups[${groupIndex}].port.kind`,
            "Typed subgraph dynamic ports must be data ports; flow crosses the subgraph interface.",
          ));
        }
      });
    }
  });

  graphTypes.forEach((graphType, graphTypeIndex) => {
    const basePath = `graphTypes[${graphTypeIndex}]`;
    validateUniqueIds(graphType.properties, `${basePath}.properties`, "graphCatalog.duplicateGraphPropertyId", diagnostics);
    validateAliases(graphType.properties, `${basePath}.properties`, "graphCatalog.duplicateGraphPropertyAlias", diagnostics);
    validateUniqueIds(graphType.nodeConstraints, `${basePath}.nodeConstraints`, "graphCatalog.duplicateNodeConstraintId", diagnostics);
    graphType.properties.forEach((property, propertyIndex) => {
      if (property.dataTypeId !== undefined && !dataTypeIds.has(property.dataTypeId)) {
        diagnostics.push(error(
          "graphCatalog.unknownGraphPropertyDataType",
          `${basePath}.properties[${propertyIndex}].dataTypeId`,
          `Data type '${property.dataTypeId}' is not declared.`,
        ));
      }
    });
    graphType.allowedNodeSelectors?.forEach((selector, selectorIndex) => {
      validateSelectorNodeTypes(selector, `${basePath}.allowedNodeSelectors[${selectorIndex}]`, nodeTypes, diagnostics);
    });
    graphType.nodeConstraints.forEach((constraint, constraintIndex) => {
      validateSelectorNodeTypes(constraint.selector, `${basePath}.nodeConstraints[${constraintIndex}].selector`, nodeTypes, diagnostics);
    });
    graphType.initialNodes.forEach((initialNode, initialNodeIndex) => {
      const nodeType = resolveNodeTypeFromList(nodeTypes, initialNode.nodeTypeId);
      if (nodeType === undefined) {
        diagnostics.push(error(
          "graphCatalog.unknownInitialNodeType",
          `${basePath}.initialNodes[${initialNodeIndex}].nodeTypeId`,
          `Node type '${initialNode.nodeTypeId}' is not declared.`,
        ));
      } else if (nodeType.subgraph !== undefined) {
        diagnostics.push(error(
          "graphCatalog.initialSubgraphNodeNotSupported",
          `${basePath}.initialNodes[${initialNodeIndex}].nodeTypeId`,
          "Initial nodes must be atomic node types.",
        ));
      } else if (!isNodeTypeAllowed(graphType, nodeType)) {
        diagnostics.push(error(
          "graphCatalog.initialNodeNotAllowed",
          `${basePath}.initialNodes[${initialNodeIndex}].nodeTypeId`,
          `Initial node type '${nodeType.id}' is not allowed by Graph Type '${graphType.id}'.`,
        ));
      }
    });
    graphType.allowedSubgraphTypeIds?.forEach((graphTypeId, allowedIndex) => {
      if (resolveGraphTypeFromList(graphTypes, graphTypeId) === undefined) {
        diagnostics.push(error(
          "graphCatalog.unknownAllowedSubgraphType",
          `${basePath}.allowedSubgraphTypeIds[${allowedIndex}]`,
          `Graph type '${graphTypeId}' is not declared.`,
        ));
      }
    });
    graphType.nodeConstraints.forEach((constraint, constraintIndex) => {
      const initialCount = graphType.initialNodes.filter((initialNode) => {
        const nodeType = resolveNodeTypeFromList(nodeTypes, initialNode.nodeTypeId);
        return nodeType !== undefined && matchesNodeSelector(nodeType, constraint.selector);
      }).length;
      if (constraint.minInstances !== undefined && initialCount < constraint.minInstances) {
        diagnostics.push(error(
          "graphCatalog.initialNodesBelowMinimum",
          `${basePath}.nodeConstraints[${constraintIndex}]`,
          `Initial nodes satisfy ${initialCount} instances for '${constraint.id}', below minInstances ${constraint.minInstances}.`,
        ));
      }
      if (constraint.maxInstances !== undefined && initialCount > constraint.maxInstances) {
        diagnostics.push(error(
          "graphCatalog.initialNodesAboveMaximum",
          `${basePath}.nodeConstraints[${constraintIndex}]`,
          `Initial nodes satisfy ${initialCount} instances for '${constraint.id}', above maxInstances ${constraint.maxInstances}.`,
        ));
      }
    });
  });

  if (catalogId === undefined || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, diagnostics };
  }

  return {
    success: true,
    document: {
      formatVersion: GRAPH_CATALOG_FORMAT_VERSION,
      catalogId,
      dataTypes,
      graphTypes,
      nodeTypes,
    },
    diagnostics,
  };
}

export function serializeGraphCatalog(catalog: GraphCatalog): string {
  const normalized: GraphCatalog = {
    formatVersion: GRAPH_CATALOG_FORMAT_VERSION,
    catalogId: catalog.catalogId,
    dataTypes: [...catalog.dataTypes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((dataType) => ({
        id: dataType.id,
        title: dataType.title,
        accepts: [...dataType.accepts].sort(),
      })),
    graphTypes: [...catalog.graphTypes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((graphType) => ({
        id: graphType.id,
        aliases: [...graphType.aliases].sort(),
        title: graphType.title,
        ...(graphType.description === undefined ? {} : { description: graphType.description }),
        usage: graphType.usage,
        ...(graphType.source === undefined ? {} : { source: serializeNodeSource(graphType.source) }),
        ...(graphType.allowedNodeSelectors === undefined ? {} : {
          allowedNodeSelectors: graphType.allowedNodeSelectors.map(serializeNodeSelector),
        }),
        properties: graphType.properties.map(serializePropertyDefinition),
        nodeConstraints: graphType.nodeConstraints.map((constraint) => ({
          id: constraint.id,
          selector: serializeNodeSelector(constraint.selector),
          ...(constraint.minInstances === undefined ? {} : { minInstances: constraint.minInstances }),
          ...(constraint.maxInstances === undefined ? {} : { maxInstances: constraint.maxInstances }),
        })),
        initialNodes: graphType.initialNodes.map((node) => ({
          nodeTypeId: node.nodeTypeId,
          ...(node.title === undefined ? {} : { title: node.title }),
        })),
        allowSubgraphs: graphType.allowSubgraphs,
        ...(graphType.allowedSubgraphTypeIds === undefined ? {} : {
          allowedSubgraphTypeIds: [...graphType.allowedSubgraphTypeIds].sort(),
        }),
      })),
    nodeTypes: [...catalog.nodeTypes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((nodeType) => ({
        id: nodeType.id,
        aliases: [...nodeType.aliases].sort(),
        title: nodeType.title,
        category: nodeType.category,
        menuPath: [...nodeType.menuPath],
        tags: [...nodeType.tags].sort(),
        traits: [...nodeType.traits].sort(),
        ...(nodeType.source === undefined ? {} : { source: serializeNodeSource(nodeType.source) }),
        ...(nodeType.subgraph === undefined ? {} : {
          subgraph: nodeType.subgraph.graphTypeIds === undefined
            ? {}
            : { graphTypeIds: [...nodeType.subgraph.graphTypeIds].sort() },
        }),
        ports: nodeType.ports.map((port) => ({
            id: port.id,
            aliases: [...port.aliases].sort(),
            title: port.title,
            ...(port.description === undefined ? {} : { description: port.description }),
            kind: port.kind,
            direction: port.direction,
            ...(port.dataTypeId === undefined ? {} : { dataTypeId: port.dataTypeId }),
            ...(port.maxConnections === undefined ? {} : { maxConnections: port.maxConnections }),
          })),
        dynamicPortGroups: nodeType.dynamicPortGroups.map((group) => ({
            id: group.id,
            aliases: [...group.aliases].sort(),
            title: group.title,
            ...(group.description === undefined ? {} : { description: group.description }),
            port: {
              kind: group.port.kind,
              direction: group.port.direction,
              ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
              ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
            },
            item: {
              valueType: group.item.valueType,
              ...(group.item.dataTypeId === undefined ? {} : { dataTypeId: group.item.dataTypeId }),
              defaultValue: sortJsonValue(group.item.defaultValue),
              ...(group.item.editor === undefined ? {} : { editor: serializePropertyEditor(group.item.editor) }),
            },
            ...(group.maxItems === undefined ? {} : { maxItems: group.maxItems }),
          })),
        properties: nodeType.properties.map(serializePropertyDefinition),
      })),
  };
  return `${JSON.stringify(normalized, undefined, 2)}\n`;
}

function serializeNodeSource(source: GraphNodeSourceDefinition): GraphNodeSourceDefinition {
  return {
    providerId: source.providerId,
    ...(source.assemblyName === undefined ? {} : { assemblyName: source.assemblyName }),
    typeName: source.typeName,
    ...(source.wrapperTypeName === undefined ? {} : { wrapperTypeName: source.wrapperTypeName }),
  };
}

function serializePropertyDefinition(property: GraphPropertyDefinition): GraphPropertyDefinition {
  return {
    id: property.id,
    aliases: [...property.aliases].sort(),
    title: property.title,
    ...(property.description === undefined ? {} : { description: property.description }),
    valueType: property.valueType,
    ...(property.dataTypeId === undefined ? {} : { dataTypeId: property.dataTypeId }),
    required: property.required,
    ...(property.defaultValue === undefined ? {} : { defaultValue: sortJsonValue(property.defaultValue) }),
    ...(property.editor === undefined ? {} : { editor: serializePropertyEditor(property.editor) }),
  };
}

function serializeNodeSelector(selector: GraphNodeSelector): GraphNodeSelector {
  return {
    ...(selector.nodeTypeIds === undefined ? {} : { nodeTypeIds: [...selector.nodeTypeIds].sort() }),
    ...(selector.tags === undefined ? {} : { tags: [...selector.tags].sort() }),
    ...(selector.traits === undefined ? {} : { traits: [...selector.traits].sort() }),
  };
}

function serializePropertyEditor(editor: GraphPropertyEditorDefinition): GraphPropertyEditorDefinition {
  return {
    kind: editor.kind,
    readOnly: editor.readOnly,
    ...(editor.min === undefined ? {} : { min: editor.min }),
    ...(editor.max === undefined ? {} : { max: editor.max }),
    options: editor.options.map((option) => ({
      title: option.title,
      value: sortJsonValue(option.value),
    })),
  };
}

export function resolveNodeType(
  catalog: GraphCatalog,
  nodeTypeId: string,
): GraphNodeTypeDefinition | undefined {
  return catalog.nodeTypes.find(
    (nodeType) => nodeType.id === nodeTypeId || nodeType.aliases.includes(nodeTypeId),
  );
}

export function resolveGraphType(
  catalog: GraphCatalog,
  graphTypeId: string,
): GraphTypeDefinition | undefined {
  return resolveGraphTypeFromList(catalog.graphTypes, graphTypeId);
}

export function matchesNodeSelector(
  nodeType: GraphNodeTypeDefinition,
  selector: GraphNodeSelector,
): boolean {
  const nodeTypeMatch = selector.nodeTypeIds === undefined
    || selector.nodeTypeIds.some((id) => id === nodeType.id || nodeType.aliases.includes(id));
  const tagMatch = selector.tags === undefined
    || selector.tags.some((tag) => nodeType.tags.includes(tag));
  const traitMatch = selector.traits === undefined
    || selector.traits.every((trait) => nodeType.traits.includes(trait));
  return nodeTypeMatch && tagMatch && traitMatch;
}

export function isNodeTypeAllowed(
  graphType: GraphTypeDefinition,
  nodeType: GraphNodeTypeDefinition,
): boolean {
  return graphType.allowedNodeSelectors === undefined
    || graphType.allowedNodeSelectors.some((selector) => matchesNodeSelector(nodeType, selector));
}

export function resolveNodePort(
  catalog: GraphCatalog,
  nodeTypeId: string,
  portId: string,
): GraphPortDefinition | undefined {
  const nodeType = resolveNodeType(catalog, nodeTypeId);
  return nodeType === undefined ? undefined : resolvePortDefinition(nodeType, portId);
}

export function resolveNodeProperty(
  catalog: GraphCatalog,
  nodeTypeId: string,
  propertyId: string,
): GraphPropertyDefinition | undefined {
  const nodeType = resolveNodeType(catalog, nodeTypeId);
  return nodeType === undefined ? undefined : resolvePropertyDefinition(nodeType, propertyId);
}

export function resolvePortDefinition(
  nodeType: GraphNodeTypeDefinition,
  portId: string,
): GraphPortDefinition | undefined {
  return nodeType.ports.find((port) => port.id === portId || port.aliases.includes(portId));
}

export function resolvePropertyDefinition(
  nodeType: GraphNodeTypeDefinition,
  propertyId: string,
): GraphPropertyDefinition | undefined {
  return nodeType.properties.find(
    (property) => property.id === propertyId || property.aliases.includes(propertyId),
  );
}

export function resolveDynamicPortGroup(
  nodeType: GraphNodeTypeDefinition,
  groupId: string,
): GraphDynamicPortGroupDefinition | undefined {
  return nodeType.dynamicPortGroups.find(
    (group) => group.id === groupId || group.aliases.includes(groupId),
  );
}

export function isDataTypeAssignable(
  catalog: GraphCatalog,
  sourceDataTypeId: string,
  targetDataTypeId: string,
): boolean {
  if (sourceDataTypeId === targetDataTypeId || sourceDataTypeId === "any" || targetDataTypeId === "any") {
    return true;
  }
  return catalog.dataTypes
    .find((dataType) => dataType.id === targetDataTypeId)
    ?.accepts.includes(sourceDataTypeId) ?? false;
}

function readDataTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphDataTypeDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidDataTypes", "dataTypes", "Expected an array."));
    return [];
  }

  return value.flatMap((entry, index) => {
    const path = `dataTypes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidDataType", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "title", "accepts"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const accepts = entry.accepts === undefined
      ? []
      : readIdentifierArray(entry.accepts, `${path}.accepts`, diagnostics);
    return id === undefined || title === undefined ? [] : [{ id, title, accepts }];
  });
}

function readGraphTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphTypeDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidGraphTypes", "graphTypes", "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `graphTypes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidGraphType", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, [
      "id", "aliases", "title", "description", "usage", "source", "allowedNodeSelectors",
      "properties", "nodeConstraints", "initialNodes", "allowSubgraphs", "allowedSubgraphTypeIds",
    ], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifierArray(entry.aliases, `${path}.aliases`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const description = entry.description === undefined ? undefined : readString(entry.description, `${path}.description`, diagnostics);
    const usage = entry.usage === undefined
      ? "any" as const
      : readEnum(entry.usage, ["root", "subgraph", "any"] as const, `${path}.usage`, diagnostics);
    const source = entry.source === undefined ? undefined : readNodeSource(entry.source, `${path}.source`, diagnostics);
    const allowedNodeSelectors = entry.allowedNodeSelectors === undefined
      ? undefined
      : readNodeSelectors(entry.allowedNodeSelectors, `${path}.allowedNodeSelectors`, diagnostics);
    const properties = readPropertyDefinitions(entry.properties ?? [], `${path}.properties`, diagnostics);
    const nodeConstraints = entry.nodeConstraints === undefined
      ? []
      : readNodeConstraints(entry.nodeConstraints, `${path}.nodeConstraints`, diagnostics);
    const initialNodes = entry.initialNodes === undefined
      ? []
      : readInitialNodes(entry.initialNodes, `${path}.initialNodes`, diagnostics);
    const allowSubgraphs = entry.allowSubgraphs === undefined
      ? true
      : readBoolean(entry.allowSubgraphs, `${path}.allowSubgraphs`, diagnostics);
    const allowedSubgraphTypeIds = entry.allowedSubgraphTypeIds === undefined
      ? undefined
      : readIdentifierArray(entry.allowedSubgraphTypeIds, `${path}.allowedSubgraphTypeIds`, diagnostics);
    if (allowSubgraphs === false && allowedSubgraphTypeIds !== undefined) {
      diagnostics.push(error(
        "graphCatalog.unexpectedAllowedSubgraphTypes",
        `${path}.allowedSubgraphTypeIds`,
        "allowedSubgraphTypeIds is only valid when allowSubgraphs is true.",
      ));
    }
    return id === undefined || title === undefined || usage === undefined || allowSubgraphs === undefined
      ? []
      : [{
          id,
          aliases,
          title,
          ...(description === undefined ? {} : { description }),
          usage,
          ...(source === undefined ? {} : { source }),
          ...(allowedNodeSelectors === undefined ? {} : { allowedNodeSelectors }),
          properties,
          nodeConstraints,
          initialNodes,
          allowSubgraphs,
          ...(allowedSubgraphTypeIds === undefined ? {} : { allowedSubgraphTypeIds }),
        }];
  });
}

function readNodeSelectors(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphNodeSelector[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidNodeSelectors", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const selector = readNodeSelector(entry, `${basePath}[${index}]`, diagnostics);
    return selector === undefined ? [] : [selector];
  });
}

function readNodeSelector(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphNodeSelector | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graphCatalog.invalidNodeSelector", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["nodeTypeIds", "tags", "traits"], path, diagnostics);
  const nodeTypeIds = value.nodeTypeIds === undefined ? undefined : readIdentifierArray(value.nodeTypeIds, `${path}.nodeTypeIds`, diagnostics);
  const tags = value.tags === undefined ? undefined : readIdentifierArray(value.tags, `${path}.tags`, diagnostics);
  const traits = value.traits === undefined ? undefined : readIdentifierArray(value.traits, `${path}.traits`, diagnostics);
  if (
    (nodeTypeIds === undefined || nodeTypeIds.length === 0)
    && (tags === undefined || tags.length === 0)
    && (traits === undefined || traits.length === 0)
  ) {
    diagnostics.push(error("graphCatalog.emptyNodeSelector", path, "A node selector must contain at least one value."));
    return undefined;
  }
  return {
    ...(nodeTypeIds === undefined ? {} : { nodeTypeIds }),
    ...(tags === undefined ? {} : { tags }),
    ...(traits === undefined ? {} : { traits }),
  };
}

function readNodeConstraints(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphNodeCountConstraint[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidNodeConstraints", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidNodeConstraint", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "selector", "minInstances", "maxInstances"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const selector = readNodeSelector(entry.selector, `${path}.selector`, diagnostics);
    const minInstances = entry.minInstances === undefined
      ? undefined
      : readNonNegativeInteger(entry.minInstances, `${path}.minInstances`, diagnostics);
    const maxInstances = entry.maxInstances === undefined
      ? undefined
      : readNonNegativeInteger(entry.maxInstances, `${path}.maxInstances`, diagnostics);
    if (minInstances === undefined && maxInstances === undefined) {
      diagnostics.push(error("graphCatalog.emptyNodeConstraint", path, "A node constraint requires minInstances or maxInstances."));
    }
    if (minInstances !== undefined && maxInstances !== undefined && minInstances > maxInstances) {
      diagnostics.push(error("graphCatalog.invalidNodeConstraintRange", path, "minInstances cannot be greater than maxInstances."));
    }
    return id === undefined || selector === undefined || (minInstances === undefined && maxInstances === undefined)
      ? []
      : [{ id, selector, ...(minInstances === undefined ? {} : { minInstances }), ...(maxInstances === undefined ? {} : { maxInstances }) }];
  });
}

function readInitialNodes(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphInitialNodeDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidInitialNodes", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidInitialNode", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["nodeTypeId", "title"], path, diagnostics);
    const nodeTypeId = readIdentifier(entry.nodeTypeId, `${path}.nodeTypeId`, diagnostics);
    const title = entry.title === undefined ? undefined : readString(entry.title, `${path}.title`, diagnostics);
    return nodeTypeId === undefined ? [] : [{ nodeTypeId, ...(title === undefined ? {} : { title }) }];
  });
}

function readNodeTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphNodeTypeDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidNodeTypes", "nodeTypes", "Expected an array."));
    return [];
  }

  return value.flatMap((entry, index) => {
    const path = `nodeTypes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidNodeType", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "aliases", "title", "category", "menuPath", "tags", "traits", "source", "subgraph", "ports", "dynamicPortGroups", "properties"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const aliases = entry.aliases === undefined
      ? []
      : readIdentifierArray(entry.aliases, `${path}.aliases`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const category = readString(entry.category, `${path}.category`, diagnostics);
    const menuPath = entry.menuPath === undefined
      ? category === undefined ? [] : category.split("/").filter((segment) => segment.length > 0)
      : readStringArray(entry.menuPath, `${path}.menuPath`, diagnostics);
    const tags = entry.tags === undefined ? [] : readIdentifierArray(entry.tags, `${path}.tags`, diagnostics);
    const traits = entry.traits === undefined ? [] : readIdentifierArray(entry.traits, `${path}.traits`, diagnostics);
    const source = entry.source === undefined ? undefined : readNodeSource(entry.source, `${path}.source`, diagnostics);
    const subgraph = entry.subgraph === undefined ? undefined : readSubgraphNode(entry.subgraph, `${path}.subgraph`, diagnostics);
    const ports = readPorts(entry.ports, `${path}.ports`, diagnostics);
    const dynamicPortGroups = entry.dynamicPortGroups === undefined
      ? []
      : readDynamicPortGroups(entry.dynamicPortGroups, `${path}.dynamicPortGroups`, diagnostics);
    const properties = readPropertyDefinitions(entry.properties, `${path}.properties`, diagnostics);
    return id === undefined || title === undefined || category === undefined
      ? []
      : [{ id, aliases, title, category, menuPath, tags, traits, ...(source === undefined ? {} : { source }), ...(subgraph === undefined ? {} : { subgraph }), ports, dynamicPortGroups, properties }];
  });
}

function readSubgraphNode(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphSubgraphNodeDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graphCatalog.invalidSubgraphNode", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["graphTypeIds"], path, diagnostics);
  const graphTypeIds = value.graphTypeIds === undefined
    ? undefined
    : readIdentifierArray(value.graphTypeIds, `${path}.graphTypeIds`, diagnostics);
  return graphTypeIds === undefined ? {} : { graphTypeIds };
}

function readDynamicPortGroups(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphDynamicPortGroupDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidDynamicPortGroups", basePath, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidDynamicPortGroup", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "aliases", "title", "description", "port", "item", "maxItems"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifierArray(entry.aliases, `${path}.aliases`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const description = entry.description === undefined ? undefined : readString(entry.description, `${path}.description`, diagnostics);
    const port = readDynamicPortTemplate(entry.port, `${path}.port`, diagnostics);
    const item = readDynamicPortItem(entry.item, `${path}.item`, diagnostics);
    const maxItems = entry.maxItems === undefined
      ? undefined
      : readPositiveInteger(entry.maxItems, `${path}.maxItems`, diagnostics);
    return id === undefined || title === undefined || port === undefined || item === undefined
      ? []
      : [{ id, aliases, title, ...(description === undefined ? {} : { description }), port, item, ...(maxItems === undefined ? {} : { maxItems }) }];
  });
}

function readDynamicPortTemplate(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphDynamicPortGroupDefinition["port"] | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graphCatalog.invalidDynamicPortTemplate", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["kind", "direction", "dataTypeId", "maxConnections"], path, diagnostics);
  const kind = readEnum(value.kind, ["flow", "data"] as const, `${path}.kind`, diagnostics);
  const direction = readEnum(value.direction, ["input", "output"] as const, `${path}.direction`, diagnostics);
  const dataTypeId = value.dataTypeId === undefined
    ? undefined
    : readIdentifier(value.dataTypeId, `${path}.dataTypeId`, diagnostics);
  const maxConnections = value.maxConnections === undefined
    ? undefined
    : readPositiveInteger(value.maxConnections, `${path}.maxConnections`, diagnostics);
  if (kind === "data" && dataTypeId === undefined) {
    diagnostics.push(error("graphCatalog.missingDataType", `${path}.dataTypeId`, "Dynamic data ports require a dataTypeId."));
  }
  if (kind === "flow" && dataTypeId !== undefined) {
    diagnostics.push(error("graphCatalog.unexpectedDataType", `${path}.dataTypeId`, "Dynamic flow ports cannot declare a dataTypeId."));
  }
  return kind === undefined || direction === undefined
    ? undefined
    : { kind, direction, ...(dataTypeId === undefined ? {} : { dataTypeId }), ...(maxConnections === undefined ? {} : { maxConnections }) };
}

function readDynamicPortItem(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphDynamicPortGroupDefinition["item"] | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graphCatalog.invalidDynamicPortItem", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["valueType", "dataTypeId", "defaultValue", "editor"], path, diagnostics);
  const valueType = readEnum(value.valueType, ["string", "number", "boolean", "json"] as const, `${path}.valueType`, diagnostics);
  const dataTypeId = value.dataTypeId === undefined
    ? undefined
    : readIdentifier(value.dataTypeId, `${path}.dataTypeId`, diagnostics);
  const rawDefaultValue = value.defaultValue;
  const defaultValue = isJsonValue(rawDefaultValue) ? rawDefaultValue : undefined;
  if (defaultValue === undefined) {
    diagnostics.push(error("graphCatalog.invalidDefaultValue", `${path}.defaultValue`, "Dynamic port items require a JSON defaultValue."));
  } else if (valueType !== undefined && !matchesValueType(defaultValue, valueType)) {
    diagnostics.push(error(
      "graphCatalog.defaultValueTypeMismatch",
      `${path}.defaultValue`,
      `Default value does not match '${valueType}'.`,
    ));
  }
  const editor = value.editor === undefined
    ? undefined
    : readPropertyEditor(value.editor, `${path}.editor`, valueType, diagnostics);
  return valueType === undefined || defaultValue === undefined
    ? undefined
    : { valueType, ...(dataTypeId === undefined ? {} : { dataTypeId }), defaultValue, ...(editor === undefined ? {} : { editor }) };
}

function readPorts(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphPortDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidPorts", basePath, "Expected an array."));
    return [];
  }

  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidPort", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "aliases", "title", "description", "kind", "direction", "dataTypeId", "maxConnections"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifierArray(entry.aliases, `${path}.aliases`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const description = entry.description === undefined ? undefined : readString(entry.description, `${path}.description`, diagnostics);
    const kind = readEnum(entry.kind, ["flow", "data"] as const, `${path}.kind`, diagnostics);
    const direction = readEnum(entry.direction, ["input", "output"] as const, `${path}.direction`, diagnostics);
    const dataTypeId = entry.dataTypeId === undefined
      ? undefined
      : readIdentifier(entry.dataTypeId, `${path}.dataTypeId`, diagnostics);
    const maxConnections = entry.maxConnections === undefined
      ? undefined
      : readPositiveInteger(entry.maxConnections, `${path}.maxConnections`, diagnostics);
    if (kind === "data" && dataTypeId === undefined) {
      diagnostics.push(error("graphCatalog.missingDataType", `${path}.dataTypeId`, "Data ports require a dataTypeId."));
    }
    if (kind === "flow" && dataTypeId !== undefined) {
      diagnostics.push(error("graphCatalog.unexpectedDataType", `${path}.dataTypeId`, "Flow ports cannot declare a dataTypeId."));
    }
    return id === undefined || title === undefined || kind === undefined || direction === undefined
      ? []
      : [{ id, aliases, title, ...(description === undefined ? {} : { description }), kind, direction, ...(dataTypeId === undefined ? {} : { dataTypeId }), ...(maxConnections === undefined ? {} : { maxConnections }) }];
  });
}

function readPropertyDefinitions(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphPropertyDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidProperties", basePath, "Expected an array."));
    return [];
  }

  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidProperty", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "aliases", "title", "description", "valueType", "dataTypeId", "required", "defaultValue", "editor"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifierArray(entry.aliases, `${path}.aliases`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const description = entry.description === undefined ? undefined : readString(entry.description, `${path}.description`, diagnostics);
    const valueType = readEnum(
      entry.valueType,
      ["string", "number", "boolean", "json"] as const,
      `${path}.valueType`,
      diagnostics,
    );
    const required = entry.required === undefined
      ? false
      : readBoolean(entry.required, `${path}.required`, diagnostics);
    const dataTypeId = entry.dataTypeId === undefined
      ? undefined
      : readIdentifier(entry.dataTypeId, `${path}.dataTypeId`, diagnostics);
    const rawDefaultValue = entry.defaultValue;
    const defaultValue = isJsonValue(rawDefaultValue) ? rawDefaultValue : undefined;
    if (rawDefaultValue !== undefined && defaultValue === undefined) {
      diagnostics.push(error("graphCatalog.invalidDefaultValue", `${path}.defaultValue`, "Expected a JSON value."));
    } else if (defaultValue !== undefined && valueType !== undefined && !matchesValueType(defaultValue, valueType)) {
      diagnostics.push(error(
        "graphCatalog.defaultValueTypeMismatch",
        `${path}.defaultValue`,
        `Default value does not match '${valueType}'.`,
      ));
    }
    const editor = entry.editor === undefined
      ? undefined
      : readPropertyEditor(entry.editor, `${path}.editor`, valueType, diagnostics);
    return id === undefined || title === undefined || valueType === undefined || required === undefined
      ? []
      : [{
          id,
          aliases,
          title,
          ...(description === undefined ? {} : { description }),
          valueType,
          ...(dataTypeId === undefined ? {} : { dataTypeId }),
          required,
          ...(defaultValue === undefined ? {} : { defaultValue }),
          ...(editor === undefined ? {} : { editor }),
        }];
  });
}

function readNodeSource(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphNodeSourceDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graphCatalog.invalidNodeSource", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["providerId", "assemblyName", "typeName", "wrapperTypeName"], path, diagnostics);
  const providerId = readIdentifier(value.providerId, `${path}.providerId`, diagnostics);
  const assemblyName = value.assemblyName === undefined
    ? undefined
    : readString(value.assemblyName, `${path}.assemblyName`, diagnostics);
  const typeName = readNonEmptyString(value.typeName, `${path}.typeName`, diagnostics);
  const wrapperTypeName = value.wrapperTypeName === undefined
    ? undefined
    : readNonEmptyString(value.wrapperTypeName, `${path}.wrapperTypeName`, diagnostics);
  return providerId === undefined || typeName === undefined
    ? undefined
    : { providerId, ...(assemblyName === undefined ? {} : { assemblyName }), typeName, ...(wrapperTypeName === undefined ? {} : { wrapperTypeName }) };
}

function readPropertyEditor(
  value: unknown,
  path: string,
  valueType: GraphPropertyValueType | undefined,
  diagnostics: DocumentDiagnostic[],
): GraphPropertyEditorDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graphCatalog.invalidPropertyEditor", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["kind", "readOnly", "min", "max", "options"], path, diagnostics);
  const kind = readEnum(
    value.kind,
    ["text", "multiline", "number", "checkbox", "select", "json", "reference"] as const,
    `${path}.kind`,
    diagnostics,
  );
  const readOnly = value.readOnly === undefined ? false : readBoolean(value.readOnly, `${path}.readOnly`, diagnostics);
  const min = value.min === undefined ? undefined : readFiniteNumber(value.min, `${path}.min`, diagnostics);
  const max = value.max === undefined ? undefined : readFiniteNumber(value.max, `${path}.max`, diagnostics);
  const options = value.options === undefined ? [] : readPropertyEditorOptions(value.options, `${path}.options`, diagnostics);
  if (min !== undefined && max !== undefined && min > max) {
    diagnostics.push(error("graphCatalog.invalidPropertyRange", path, "Editor min cannot be greater than max."));
  }
  if (kind === "select" && options.length === 0) {
    diagnostics.push(error("graphCatalog.missingPropertyOptions", `${path}.options`, "Select editors require at least one option."));
  }
  if (kind !== undefined && valueType !== undefined && !isEditorCompatible(kind, valueType)) {
    diagnostics.push(error(
      "graphCatalog.propertyEditorTypeMismatch",
      `${path}.kind`,
      `Editor '${kind}' is not compatible with '${valueType}'.`,
    ));
  }
  if ((min !== undefined || max !== undefined) && kind !== "number") {
    diagnostics.push(error(
      "graphCatalog.unexpectedPropertyRange",
      path,
      "Editor min and max are only valid for number editors.",
    ));
  }
  if (options.length > 0 && kind !== "select") {
    diagnostics.push(error(
      "graphCatalog.unexpectedPropertyOptions",
      `${path}.options`,
      "Editor options are only valid for select editors.",
    ));
  }
  if (valueType !== undefined) {
    options.forEach((option, index) => {
      if (!matchesValueType(option.value, valueType)) {
        diagnostics.push(error(
          "graphCatalog.propertyOptionTypeMismatch",
          `${path}.options[${index}].value`,
          `Option value does not match '${valueType}'.`,
        ));
      }
    });
  }
  return kind === undefined || readOnly === undefined
    ? undefined
    : { kind, readOnly, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), options };
}

function readPropertyEditorOptions(
  value: unknown,
  basePath: string,
  diagnostics: DocumentDiagnostic[],
): readonly GraphPropertyEditorOption[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidPropertyOptions", basePath, "Expected an array."));
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("graphCatalog.invalidPropertyOption", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["title", "value"], path, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    if (!isJsonValue(entry.value)) {
      diagnostics.push(error("graphCatalog.invalidPropertyOptionValue", `${path}.value`, "Expected a JSON value."));
      return [];
    }
    const key = JSON.stringify(sortJsonValue(entry.value));
    if (seen.has(key)) {
      diagnostics.push(error("graphCatalog.duplicatePropertyOption", `${path}.value`, "Option values must be unique."));
    }
    seen.add(key);
    return title === undefined ? [] : [{ title, value: entry.value }];
  });
}

function validateUniqueIds(
  values: readonly { readonly id: string }[],
  basePath: string,
  code: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) {
      diagnostics.push(error(code, `${basePath}[${index}].id`, `Duplicate id '${value.id}'.`));
    }
    ids.add(value.id);
  });
}

function validateAliases(
  values: readonly { readonly id: string; readonly aliases: readonly string[] }[],
  basePath: string,
  code: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const canonicalIds = new Set(values.map((value) => value.id));
  const aliases = new Set<string>();
  values.forEach((value, valueIndex) => {
    value.aliases.forEach((alias, aliasIndex) => {
      if (canonicalIds.has(alias) || aliases.has(alias)) {
        diagnostics.push(error(
          code,
          `${basePath}[${valueIndex}].aliases[${aliasIndex}]`,
          `Alias '${alias}' is already used in this identity namespace.`,
        ));
      }
      aliases.add(alias);
    });
  });
}

function validateSelectorNodeTypes(
  selector: GraphNodeSelector,
  basePath: string,
  nodeTypes: readonly GraphNodeTypeDefinition[],
  diagnostics: DocumentDiagnostic[],
): void {
  selector.nodeTypeIds?.forEach((nodeTypeId, index) => {
    if (resolveNodeTypeFromList(nodeTypes, nodeTypeId) === undefined) {
      diagnostics.push(error(
        "graphCatalog.unknownSelectorNodeType",
        `${basePath}.nodeTypeIds[${index}]`,
        `Node type '${nodeTypeId}' is not declared.`,
      ));
    }
  });
}

function resolveNodeTypeFromList(
  nodeTypes: readonly GraphNodeTypeDefinition[],
  nodeTypeId: string,
): GraphNodeTypeDefinition | undefined {
  return nodeTypes.find((nodeType) => nodeType.id === nodeTypeId || nodeType.aliases.includes(nodeTypeId));
}

function resolveGraphTypeFromList(
  graphTypes: readonly GraphTypeDefinition[],
  graphTypeId: string,
): GraphTypeDefinition | undefined {
  return graphTypes.find((graphType) => graphType.id === graphTypeId || graphType.aliases.includes(graphTypeId));
}

function readIdentifierArray(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidIdentifierArray", path, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const id = readIdentifier(entry, `${path}[${index}]`, diagnostics);
    return id === undefined ? [] : [id];
  });
}

function readStringArray(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidStringArray", path, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const item = readNonEmptyString(entry, `${path}[${index}]`, diagnostics);
    return item === undefined ? [] : [item];
  });
}

function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("graphCatalog.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

function readString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string") {
    diagnostics.push(error("graphCatalog.invalidString", path, "Expected a string."));
    return undefined;
  }
  return value;
}

function readNonEmptyString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  const result = readString(value, path, diagnostics);
  if (result !== undefined && result.trim().length === 0) {
    diagnostics.push(error("graphCatalog.emptyString", path, "Expected a non-empty string."));
    return undefined;
  }
  return result;
}

function readBoolean(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): boolean | undefined {
  if (typeof value !== "boolean") {
    diagnostics.push(error("graphCatalog.invalidBoolean", path, "Expected a boolean."));
    return undefined;
  }
  return value;
}

function readPositiveInteger(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    diagnostics.push(error("graphCatalog.invalidPositiveInteger", path, "Expected a positive integer."));
    return undefined;
  }
  return value;
}

function readNonNegativeInteger(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    diagnostics.push(error("graphCatalog.invalidNonNegativeInteger", path, "Expected a non-negative integer."));
    return undefined;
  }
  return value;
}

function readFiniteNumber(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    diagnostics.push(error("graphCatalog.invalidNumber", path, "Expected a finite number."));
    return undefined;
  }
  return value;
}

function readEnum<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): TValue | undefined {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    diagnostics.push(error("graphCatalog.invalidEnum", path, `Expected one of: ${allowed.join(", ")}.`));
    return undefined;
  }
  return value as TValue;
}

function matchesValueType(value: JsonValue, valueType: GraphPropertyValueType): boolean {
  return valueType === "json" || typeof value === valueType;
}

function isEditorCompatible(kind: GraphPropertyEditorKind, valueType: GraphPropertyValueType): boolean {
  switch (kind) {
    case "text":
    case "multiline":
    case "reference":
      return valueType === "string";
    case "number":
      return valueType === "number";
    case "checkbox":
      return valueType === "boolean";
    case "json":
      return valueType === "json";
    case "select":
      return true;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child as JsonValue)]),
    );
  }
  return value;
}

function checkKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const allowed = new Set(allowedKeys);
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) {
      diagnostics.push(error("graphCatalog.unknownProperty", path === "$" ? key : `${path}.${key}`, `Unknown property '${key}'.`));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function failure(code: string, path: string, message: string): DocumentParseResult<never> {
  return { success: false, diagnostics: [error(code, path, message)] };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : "Unknown JSON parse error.";
}
