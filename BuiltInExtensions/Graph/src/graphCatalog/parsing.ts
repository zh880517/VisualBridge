import type {
  DocumentDiagnostic,
  FieldValueDefinition,
} from "@visualbridge/core";
import {
  parseFieldDefinitions,
  parseFieldValueDefinition,
} from "@visualbridge/core";
import { checkKeys, error, isRecord } from "./diagnostics";
import {
  readBoolean,
  readColor,
  readEnum,
  readIdentifier,
  readIdentifierArray,
  readNonNegativeInteger,
  readNonEmptyString,
  readPositiveInteger,
  readString,
  readStringArray,
} from "./readers";
import type {
  GraphDataTypeDefinition,
  GraphDynamicPortGroupDefinition,
  GraphInitialNodeDefinition,
  GraphNodeCountConstraint,
  GraphNodeSelector,
  GraphNodeSourceDefinition,
  GraphNodeTypeDefinition,
  GraphPortDefinition,
  GraphSubgraphNodeDefinition,
  GraphTypeDefinition,
} from "./types";
import { validateUniqueStrings } from "./validation";

export function readDataTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphDataTypeDefinition[] {
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
    checkKeys(entry, ["id", "title", "color", "acceptsAnySource", "accepts"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const color = entry.color === undefined
      ? undefined
      : readColor(entry.color, `${path}.color`, diagnostics);
    const acceptsAnySource = entry.acceptsAnySource === undefined
      ? false
      : readBoolean(entry.acceptsAnySource, `${path}.acceptsAnySource`, diagnostics);
    const accepts = entry.accepts === undefined
      ? []
      : readIdentifierArray(entry.accepts, `${path}.accepts`, diagnostics);
    return id === undefined || title === undefined || acceptsAnySource === undefined
      ? []
      : [{ id, title, ...(color === undefined ? {} : { color }), acceptsAnySource, accepts }];
  });
}

export function readGraphTypes(
  value: unknown,
  diagnostics: DocumentDiagnostic[],
): readonly GraphTypeDefinition[] {
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
      "id", "aliases", "title", "description", "usage", "source", "supportedCatalogIds",
      "portConnectionRules", "allowedNodeSelectors",
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
    let supportedCatalogIds: readonly string[] | undefined;
    if (entry.supportedCatalogIds === undefined) {
      diagnostics.push(error(
        "graphCatalog.missingSupportedCatalogs",
        `${path}.supportedCatalogIds`,
        "Graph Catalog V4 Graph Types require at least one supported Catalog.",
      ));
    } else {
      supportedCatalogIds = readIdentifierArray(entry.supportedCatalogIds, `${path}.supportedCatalogIds`, diagnostics);
      if (supportedCatalogIds.length === 0) {
        diagnostics.push(error(
          "graphCatalog.emptySupportedCatalogs",
          `${path}.supportedCatalogIds`,
          "Graph Types require at least one supported Catalog.",
        ));
      }
      validateUniqueStrings(
        supportedCatalogIds,
        `${path}.supportedCatalogIds`,
        "graphCatalog.duplicateSupportedCatalogId",
        diagnostics,
      );
    }
    const portConnectionRules = entry.portConnectionRules === undefined
      ? undefined
      : readPortConnectionRules(entry.portConnectionRules, `${path}.portConnectionRules`, diagnostics);
    if (entry.portConnectionRules === undefined) {
      diagnostics.push(error(
        "graphCatalog.missingPortConnectionRules",
        `${path}.portConnectionRules`,
        "Graph Catalog V4 Graph Types require input and output connection rules.",
      ));
    }
    const allowedNodeSelectors = entry.allowedNodeSelectors === undefined
      ? undefined
      : readNodeSelectors(entry.allowedNodeSelectors, `${path}.allowedNodeSelectors`, diagnostics);
    if (entry.properties === undefined) {
      diagnostics.push(error(
        "graphCatalog.missingGraphTypeProperties",
        `${path}.properties`,
        "Graph Catalog V4 Graph Types require a properties array.",
      ));
    }
    const properties = parseFieldDefinitions(entry.properties ?? [], `${path}.properties`, diagnostics, { allowEmpty: true });
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
    return id === undefined
      || title === undefined
      || usage === undefined
      || supportedCatalogIds === undefined
      || portConnectionRules === undefined
      || allowSubgraphs === undefined
      ? []
      : [{
          id,
          aliases,
          title,
          ...(description === undefined ? {} : { description }),
          usage,
          ...(source === undefined ? {} : { source }),
          supportedCatalogIds,
          portConnectionRules,
          ...(allowedNodeSelectors === undefined ? {} : { allowedNodeSelectors }),
          properties,
          nodeConstraints,
          initialNodes,
          allowSubgraphs,
          ...(allowedSubgraphTypeIds === undefined ? {} : { allowedSubgraphTypeIds }),
        }];
  });
}

export function readPortConnectionRules(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphTypeDefinition["portConnectionRules"] | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("graphCatalog.invalidPortConnectionRules", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["input", "output"], path, diagnostics);
  const input = readEnum(value.input, ["single", "multiple"] as const, `${path}.input`, diagnostics);
  const output = readEnum(value.output, ["single", "multiple"] as const, `${path}.output`, diagnostics);
  return input === undefined || output === undefined ? undefined : { input, output };
}

export function readNodeSelectors(
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

export function readNodeSelector(
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

export function readNodeConstraints(
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

export function readInitialNodes(
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

export function readNodeTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly GraphNodeTypeDefinition[] {
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
    checkKeys(entry, ["id", "aliases", "title", "icon", "category", "menuPath", "tags", "traits", "source", "subgraph", "ports", "dynamicPortGroups", "properties"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const aliases = entry.aliases === undefined
      ? []
      : readIdentifierArray(entry.aliases, `${path}.aliases`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const icon = entry.icon === undefined ? undefined : readNonEmptyString(entry.icon, `${path}.icon`, diagnostics);
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
    const properties = parseFieldDefinitions(entry.properties, `${path}.properties`, diagnostics, { allowEmpty: true });
    return id === undefined || title === undefined || category === undefined
      ? []
      : [{ id, aliases, title, ...(icon === undefined ? {} : { icon }), category, menuPath, tags, traits, ...(source === undefined ? {} : { source }), ...(subgraph === undefined ? {} : { subgraph }), ports, dynamicPortGroups, properties }];
  });
}

export function readSubgraphNode(
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

export function readDynamicPortGroups(
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
    checkKeys(entry, ["id", "aliases", "title", "description", "listPortMode", "port", "item", "maxItems"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifierArray(entry.aliases, `${path}.aliases`, diagnostics);
    const title = readString(entry.title, `${path}.title`, diagnostics);
    const description = entry.description === undefined ? undefined : readString(entry.description, `${path}.description`, diagnostics);
    const listPortMode = entry.listPortMode === undefined
      ? undefined
      : readEnum(entry.listPortMode, ["list", "element"] as const, `${path}.listPortMode`, diagnostics);
    const port = readDynamicPortTemplate(entry.port, `${path}.port`, diagnostics);
    const item = readDynamicPortItem(entry.item, `${path}.item`, diagnostics);
    const maxItems = entry.maxItems === undefined
      ? undefined
      : readPositiveInteger(entry.maxItems, `${path}.maxItems`, diagnostics);
    return id === undefined || title === undefined || port === undefined || item === undefined
      ? []
      : [{ id, aliases, title, ...(description === undefined ? {} : { description }), ...(listPortMode === undefined ? {} : { listPortMode }), port, item, ...(maxItems === undefined ? {} : { maxItems }) }];
  });
}

export function readDynamicPortTemplate(
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

export function readDynamicPortItem(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): GraphDynamicPortGroupDefinition["item"] | undefined {
  return parseFieldValueDefinition(value, path, diagnostics);
}

export function readPorts(
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

export function readNodeSource(
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
