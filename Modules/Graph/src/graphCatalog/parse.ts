import type { DocumentDiagnostic, DocumentParseResult } from "@visualbridge/module-sdk";
import { parseCatalogSourceDefinition } from "@visualbridge/module-sdk";
import { checkKeys, error, failure, formatError, isRecord } from "./diagnostics";
import { readDataTypes, readGraphTypes, readNodeTypes } from "./parsing";
import { readIdentifier, readNonEmptyString } from "./readers";
import type { GraphCatalog } from "./types";
import { GRAPH_CATALOG_FORMAT_VERSION } from "./types";
import { validateAliases, validateUniqueIds } from "./validation";

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
  checkKeys(value, ["formatVersion", "catalogId", "title", "source", "dataTypes", "graphTypes", "nodeTypes"], "$", diagnostics);
  if (value.formatVersion !== GRAPH_CATALOG_FORMAT_VERSION) {
    diagnostics.push(error(
      "graphCatalog.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${GRAPH_CATALOG_FORMAT_VERSION}.`,
    ));
  }

  const catalogId = readIdentifier(value.catalogId, "catalogId", diagnostics);
  const title = readNonEmptyString(value.title, "title", diagnostics);
  const sourceResult = parseCatalogSourceDefinition(value.source);
  if (!sourceResult.success) {
    diagnostics.push(...sourceResult.issues.map((issue) => error(
      "graphCatalog.invalidSource",
      issue.path,
      issue.message,
    )));
  }
  const dataTypes = readDataTypes(value.dataTypes, diagnostics);
  const nodeTypes = readNodeTypes(value.nodeTypes, diagnostics);
  if (value.graphTypes === undefined) {
    diagnostics.push(error(
      "graphCatalog.missingGraphTypes",
      "graphTypes",
      "Graph Catalog V4 requires a graphTypes array.",
    ));
  }
  const graphTypes = value.graphTypes === undefined
    ? []
    : readGraphTypes(value.graphTypes, diagnostics);
  validateUniqueIds(dataTypes, "dataTypes", "graphCatalog.duplicateDataTypeId", diagnostics);
  validateUniqueIds(nodeTypes, "nodeTypes", "graphCatalog.duplicateNodeTypeId", diagnostics);
  validateUniqueIds(graphTypes, "graphTypes", "graphCatalog.duplicateGraphTypeId", diagnostics);

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
    nodeType.dynamicPortGroups.forEach((group, groupIndex) => {
      if (group.listPortMode === undefined) {
        return;
      }
      const groupPath = `nodeTypes[${nodeTypeIndex}].dynamicPortGroups[${groupIndex}]`;
      if (group.port.kind !== "data" || group.port.direction !== "input") {
        diagnostics.push(error(
          "graphCatalog.invalidListPort",
          `${groupPath}.port`,
          "List fields require a data input port template.",
        ));
      }
      if (group.item.dataTypeId === undefined) {
        diagnostics.push(error(
          "graphCatalog.missingListItemDataType",
          `${groupPath}.item.dataTypeId`,
          "List fields require an item dataTypeId.",
        ));
      }
      if (
        group.listPortMode === "element"
        && group.item.dataTypeId !== undefined
        && group.port.dataTypeId !== group.item.dataTypeId
      ) {
        diagnostics.push(error(
          "graphCatalog.listElementDataTypeMismatch",
          `${groupPath}.port.dataTypeId`,
          "Element-port List fields must use the item dataTypeId for their port template.",
        ));
      }
      if (group.listPortMode === "list") {
        const groupIds = new Set([group.id, ...group.aliases]);
        const collidingPort = nodeType.ports.find((port) =>
          [port.id, ...port.aliases].some((portId) => groupIds.has(portId)),
        );
        if (collidingPort !== undefined) {
          diagnostics.push(error(
            "graphCatalog.listPortIdCollision",
            `${groupPath}.id`,
            `List port '${group.id}' collides with static port '${collidingPort.id}'.`,
          ));
        }
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
  });

  if (
    catalogId === undefined
    || title === undefined
    || !sourceResult.success
    || diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    return { success: false, diagnostics };
  }

  return {
    success: true,
    document: {
      formatVersion: GRAPH_CATALOG_FORMAT_VERSION,
      catalogId,
      title,
      source: sourceResult.value,
      dataTypes,
      graphTypes,
      nodeTypes,
    },
    diagnostics,
  };
}
