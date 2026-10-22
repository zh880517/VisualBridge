import type { DocumentDiagnostic, DocumentParseResult, FieldValueDefinition } from "@visualbridge/core";
import { error } from "./diagnostics";
import {
  isNodeTypeAllowed,
  matchesNodeSelector,
  resolveGraphTypeFromList,
  resolveNodeTypeFromList,
} from "./lookup";
import type {
  GraphCatalog,
  GraphCatalogRegistry,
  GraphNodeSelector,
  RegisteredGraphDataTypeDefinition,
  RegisteredGraphNodeTypeDefinition,
  RegisteredGraphTypeDefinition,
} from "./types";

interface RegisteredDefinitionSource<TDefinition> {
  readonly definition: TDefinition;
  readonly path: string;
}

export function buildGraphCatalogRegistry(
  catalogs: readonly GraphCatalog[],
): DocumentParseResult<GraphCatalogRegistry> {
  const diagnostics: DocumentDiagnostic[] = [];
  const catalogIds = new Set<string>();
  catalogs.forEach((catalog, catalogIndex) => {
    if (catalogIds.has(catalog.catalogId)) {
      diagnostics.push(error(
        "graphCatalogRegistry.duplicateCatalogId",
        `catalogs[${catalogIndex}].catalogId`,
        `Duplicate Catalog id '${catalog.catalogId}'.`,
      ));
    }
    catalogIds.add(catalog.catalogId);
  });

  const dataTypeSources: RegisteredDefinitionSource<RegisteredGraphDataTypeDefinition>[] = [];
  const graphTypeSources: RegisteredDefinitionSource<RegisteredGraphTypeDefinition>[] = [];
  const nodeTypeSources: RegisteredDefinitionSource<RegisteredGraphNodeTypeDefinition>[] = [];
  catalogs.forEach((catalog, catalogIndex) => {
    catalog.dataTypes.forEach((dataType, dataTypeIndex) => dataTypeSources.push({
      definition: { ...dataType, catalogId: catalog.catalogId, catalogTitle: catalog.title },
      path: `catalogs[${catalogIndex}].dataTypes[${dataTypeIndex}]`,
    }));
    catalog.graphTypes.forEach((graphType, graphTypeIndex) => graphTypeSources.push({
      definition: { ...graphType, catalogId: catalog.catalogId, catalogTitle: catalog.title },
      path: `catalogs[${catalogIndex}].graphTypes[${graphTypeIndex}]`,
    }));
    catalog.nodeTypes.forEach((nodeType, nodeTypeIndex) => nodeTypeSources.push({
      definition: { ...nodeType, catalogId: catalog.catalogId, catalogTitle: catalog.title },
      path: `catalogs[${catalogIndex}].nodeTypes[${nodeTypeIndex}]`,
    }));
  });

  validateRegistryIds(
    dataTypeSources,
    "graphCatalogRegistry.duplicateDataTypeId",
    diagnostics,
    new Set(["any"]),
  );
  validateRegistryAliases(
    graphTypeSources,
    "graphCatalogRegistry.duplicateGraphTypeId",
    "graphCatalogRegistry.duplicateGraphTypeAlias",
    diagnostics,
  );
  validateRegistryAliases(
    nodeTypeSources,
    "graphCatalogRegistry.duplicateNodeTypeId",
    "graphCatalogRegistry.duplicateNodeTypeAlias",
    diagnostics,
  );

  const dataTypes = dataTypeSources.map((source) => source.definition);
  const graphTypes = graphTypeSources.map((source) => source.definition);
  const nodeTypes = nodeTypeSources.map((source) => source.definition);
  const dataTypeIds = new Set(["any", ...dataTypes.map((dataType) => dataType.id)]);

  dataTypeSources.forEach(({ definition: dataType, path }) => {
    dataType.accepts.forEach((acceptedTypeId, acceptedTypeIndex) => {
      if (!dataTypeIds.has(acceptedTypeId)) {
        diagnostics.push(error(
          "graphCatalogRegistry.unknownAcceptedDataType",
          `${path}.accepts[${acceptedTypeIndex}]`,
          `Data type '${acceptedTypeId}' is not declared by a loaded Catalog.`,
        ));
      }
    });
  });

  nodeTypeSources.forEach(({ definition: nodeType, path }) => {
    nodeType.subgraph?.graphTypeIds?.forEach((graphTypeId, graphTypeIndex) => {
      if (resolveGraphTypeFromList(graphTypes, graphTypeId) === undefined) {
        diagnostics.push(error(
          "graphCatalogRegistry.unknownSubgraphTargetType",
          `${path}.subgraph.graphTypeIds[${graphTypeIndex}]`,
          `Graph type '${graphTypeId}' is not declared by a loaded Catalog.`,
        ));
      }
    });
    nodeType.ports.forEach((port, portIndex) => validateRegistryDataTypeReference(
      port.dataTypeId,
      `${path}.ports[${portIndex}].dataTypeId`,
      "graphCatalogRegistry.unknownPortDataType",
      dataTypeIds,
      diagnostics,
    ));
    nodeType.properties.forEach((property, propertyIndex) => validateFieldDataTypeReferences(
      property,
      `${path}.properties[${propertyIndex}]`,
      "graphCatalogRegistry.unknownPropertyDataType",
      dataTypeIds,
      diagnostics,
    ));
    nodeType.dynamicPortGroups.forEach((group, groupIndex) => {
      validateRegistryDataTypeReference(
        group.port.dataTypeId,
        `${path}.dynamicPortGroups[${groupIndex}].port.dataTypeId`,
        "graphCatalogRegistry.unknownDynamicPortDataType",
        dataTypeIds,
        diagnostics,
      );
      validateFieldDataTypeReferences(
        group.item,
        `${path}.dynamicPortGroups[${groupIndex}].item`,
        "graphCatalogRegistry.unknownDynamicPortItemDataType",
        dataTypeIds,
        diagnostics,
      );
    });
  });

  graphTypeSources.forEach(({ definition: graphType, path }) => {
    graphType.supportedCatalogIds.forEach((supportedCatalogId, supportedIndex) => {
      if (!catalogIds.has(supportedCatalogId)) {
        diagnostics.push(error(
          "graphCatalogRegistry.unknownSupportedCatalog",
          `${path}.supportedCatalogIds[${supportedIndex}]`,
          `Catalog '${supportedCatalogId}' is not loaded.`,
        ));
      }
    });
    graphType.properties.forEach((property, propertyIndex) => validateFieldDataTypeReferences(
      property,
      `${path}.properties[${propertyIndex}]`,
      "graphCatalogRegistry.unknownGraphPropertyDataType",
      dataTypeIds,
      diagnostics,
    ));
    graphType.allowedNodeSelectors?.forEach((selector, selectorIndex) => validateRegistrySelectorNodeTypes(
      selector,
      `${path}.allowedNodeSelectors[${selectorIndex}]`,
      graphType,
      nodeTypes,
      diagnostics,
    ));
    graphType.nodeConstraints.forEach((constraint, constraintIndex) => validateRegistrySelectorNodeTypes(
      constraint.selector,
      `${path}.nodeConstraints[${constraintIndex}].selector`,
      graphType,
      nodeTypes,
      diagnostics,
    ));
    graphType.initialNodes.forEach((initialNode, initialNodeIndex) => {
      const initialPath = `${path}.initialNodes[${initialNodeIndex}].nodeTypeId`;
      const nodeType = resolveNodeTypeFromList(nodeTypes, initialNode.nodeTypeId);
      if (nodeType === undefined) {
        diagnostics.push(error(
          "graphCatalogRegistry.unknownInitialNodeType",
          initialPath,
          `Node type '${initialNode.nodeTypeId}' is not declared by a loaded Catalog.`,
        ));
      } else if (nodeType.subgraph !== undefined) {
        diagnostics.push(error(
          "graphCatalogRegistry.initialSubgraphNodeNotSupported",
          initialPath,
          "Initial nodes must be atomic node types.",
        ));
      } else if (!isNodeTypeAllowed(graphType, nodeType)) {
        diagnostics.push(error(
          "graphCatalogRegistry.initialNodeNotAllowed",
          initialPath,
          `Initial node type '${nodeType.id}' is not allowed by Graph Type '${graphType.id}'.`,
        ));
      }
    });
    graphType.allowedSubgraphTypeIds?.forEach((graphTypeId, allowedIndex) => {
      if (resolveGraphTypeFromList(graphTypes, graphTypeId) === undefined) {
        diagnostics.push(error(
          "graphCatalogRegistry.unknownAllowedSubgraphType",
          `${path}.allowedSubgraphTypeIds[${allowedIndex}]`,
          `Graph type '${graphTypeId}' is not declared by a loaded Catalog.`,
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
          "graphCatalogRegistry.initialNodesBelowMinimum",
          `${path}.nodeConstraints[${constraintIndex}]`,
          `Initial nodes satisfy ${initialCount} instances for '${constraint.id}', below minInstances ${constraint.minInstances}.`,
        ));
      }
      if (constraint.maxInstances !== undefined && initialCount > constraint.maxInstances) {
        diagnostics.push(error(
          "graphCatalogRegistry.initialNodesAboveMaximum",
          `${path}.nodeConstraints[${constraintIndex}]`,
          `Initial nodes satisfy ${initialCount} instances for '${constraint.id}', above maxInstances ${constraint.maxInstances}.`,
        ));
      }
    });
  });

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      catalogs: catalogs.map((catalog) => ({ catalogId: catalog.catalogId, title: catalog.title })),
      dataTypes,
      graphTypes,
      nodeTypes,
    },
    diagnostics,
  };
}

function validateRegistryIds<TDefinition extends { readonly id: string }>(
  sources: readonly RegisteredDefinitionSource<TDefinition>[],
  duplicateCode: string,
  diagnostics: DocumentDiagnostic[],
  reservedIds: ReadonlySet<string> = new Set(),
): void {
  const seen = new Set<string>();
  sources.forEach(({ definition, path }) => {
    if (reservedIds.has(definition.id)) {
      diagnostics.push(error(
        "graphCatalogRegistry.reservedDataTypeId",
        `${path}.id`,
        `Id '${definition.id}' is reserved by VisualBridge.`,
      ));
    } else if (seen.has(definition.id)) {
      diagnostics.push(error(duplicateCode, `${path}.id`, `Duplicate id '${definition.id}'.`));
    }
    seen.add(definition.id);
  });
}

function validateRegistryAliases<TDefinition extends { readonly id: string; readonly aliases: readonly string[] }>(
  sources: readonly RegisteredDefinitionSource<TDefinition>[],
  duplicateIdCode: string,
  duplicateAliasCode: string,
  diagnostics: DocumentDiagnostic[],
): void {
  validateRegistryIds(sources, duplicateIdCode, diagnostics);
  const canonicalIds = new Set(sources.map(({ definition }) => definition.id));
  const aliases = new Set<string>();
  sources.forEach(({ definition, path }) => definition.aliases.forEach((alias, aliasIndex) => {
    if (canonicalIds.has(alias) || aliases.has(alias)) {
      diagnostics.push(error(
        duplicateAliasCode,
        `${path}.aliases[${aliasIndex}]`,
        `Alias '${alias}' is already used in this identity namespace.`,
      ));
    }
    aliases.add(alias);
  }));
}

function validateRegistryDataTypeReference(
  dataTypeId: string | undefined,
  path: string,
  code: string,
  dataTypeIds: ReadonlySet<string>,
  diagnostics: DocumentDiagnostic[],
): void {
  if (dataTypeId !== undefined && !dataTypeIds.has(dataTypeId)) {
    diagnostics.push(error(code, path, `Data type '${dataTypeId}' is not declared by a loaded Catalog.`));
  }
}

function validateFieldDataTypeReferences(
  definition: FieldValueDefinition,
  path: string,
  code: string,
  dataTypeIds: ReadonlySet<string>,
  diagnostics: DocumentDiagnostic[],
): void {
  validateRegistryDataTypeReference(definition.dataTypeId, `${path}.dataTypeId`, code, dataTypeIds, diagnostics);
  definition.fields.forEach((field, index) => validateFieldDataTypeReferences(
    field,
    `${path}.fields[${index}]`,
    code,
    dataTypeIds,
    diagnostics,
  ));
  if (definition.item !== undefined) {
    validateFieldDataTypeReferences(definition.item, `${path}.item`, code, dataTypeIds, diagnostics);
  }
}

function validateRegistrySelectorNodeTypes(
  selector: GraphNodeSelector,
  path: string,
  graphType: RegisteredGraphTypeDefinition,
  nodeTypes: readonly RegisteredGraphNodeTypeDefinition[],
  diagnostics: DocumentDiagnostic[],
): void {
  selector.nodeTypeIds?.forEach((nodeTypeId, nodeTypeIndex) => {
    const nodeType = resolveNodeTypeFromList(nodeTypes, nodeTypeId);
    if (nodeType === undefined) {
      diagnostics.push(error(
        "graphCatalogRegistry.unknownSelectorNodeType",
        `${path}.nodeTypeIds[${nodeTypeIndex}]`,
        `Node type '${nodeTypeId}' is not declared by a loaded Catalog.`,
      ));
    } else if (!graphType.supportedCatalogIds.includes(nodeType.catalogId)) {
      diagnostics.push(error(
        "graphCatalogRegistry.selectorNodeTypeFromUnsupportedCatalog",
        `${path}.nodeTypeIds[${nodeTypeIndex}]`,
        `Node type '${nodeType.id}' belongs to unsupported Catalog '${nodeType.catalogId}'.`,
      ));
    }
  });
}
