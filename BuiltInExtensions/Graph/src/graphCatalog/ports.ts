import type { FieldDefinition } from "@visualbridge/core";
import { resolveNodeType } from "./lookup";
import type {
  GraphCatalogLookup,
  GraphDynamicPortGroupDefinition,
  GraphNodeTypeDefinition,
  GraphPortDefinition,
} from "./types";

export function resolveNodePort(
  catalog: GraphCatalogLookup,
  nodeTypeId: string,
  portId: string,
): GraphPortDefinition | undefined {
  const nodeType = resolveNodeType(catalog, nodeTypeId);
  return nodeType === undefined
    ? undefined
    : resolvePortDefinition(nodeType, portId) ?? resolveListPortDefinition(nodeType, portId);
}

export function resolveNodeProperty(
  catalog: GraphCatalogLookup,
  nodeTypeId: string,
  propertyId: string,
): FieldDefinition | undefined {
  const nodeType = resolveNodeType(catalog, nodeTypeId);
  return nodeType === undefined ? undefined : resolvePropertyDefinition(nodeType, propertyId);
}

export function resolvePortDefinition(
  nodeType: GraphNodeTypeDefinition,
  portId: string,
): GraphPortDefinition | undefined {
  return nodeType.ports.find((port) => port.id === portId || port.aliases.includes(portId));
}

export function resolveListPortDefinition(
  nodeType: GraphNodeTypeDefinition,
  portId: string,
): GraphPortDefinition | undefined {
  const group = nodeType.dynamicPortGroups.find((candidate) =>
    candidate.listPortMode === "list"
    && (candidate.id === portId || candidate.aliases.includes(portId)),
  );
  return group === undefined
    ? undefined
    : {
        id: group.id,
        aliases: group.aliases,
        title: group.title,
        ...(group.description === undefined ? {} : { description: group.description }),
        kind: group.port.kind,
        direction: group.port.direction,
        ...(group.port.dataTypeId === undefined ? {} : { dataTypeId: group.port.dataTypeId }),
        ...(group.port.maxConnections === undefined ? {} : { maxConnections: group.port.maxConnections }),
      };
}

export function resolvePropertyDefinition(
  nodeType: GraphNodeTypeDefinition,
  propertyId: string,
): FieldDefinition | undefined {
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
  catalog: GraphCatalogLookup,
  sourceDataTypeId: string,
  targetDataTypeId: string,
): boolean {
  if (sourceDataTypeId === targetDataTypeId || sourceDataTypeId === "any" || targetDataTypeId === "any") {
    return true;
  }
  const targetDataType = catalog.dataTypes.find((dataType) => dataType.id === targetDataTypeId);
  return targetDataType?.acceptsAnySource === true
    || targetDataType?.accepts.includes(sourceDataTypeId) === true;
}
