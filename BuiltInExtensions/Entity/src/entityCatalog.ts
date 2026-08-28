import type { DocumentDiagnostic, DocumentParseResult, FieldDefinition } from "@visualbridge/core";
import {
  normalizeJsonValue,
  parseFieldDefinitions,
} from "@visualbridge/core";

export const ENTITY_EDITOR_ID = "entity";
export const ENTITY_CATALOG_FORMAT_VERSION = 1;

export interface EntityComponentGroupDefinition {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
}

export interface EntityTypeDefinition {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly allowedComponentGroupIds: readonly string[];
  readonly properties: readonly FieldDefinition[];
}

export interface EntityTypeSourceDefinition {
  readonly providerId: string;
  readonly typeName: string;
}

export interface EntityComponentTypeDefinition {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly groupId: string;
  readonly menuPath: readonly string[];
  readonly source?: EntityTypeSourceDefinition;
  readonly properties: readonly FieldDefinition[];
}

export interface EntityCatalog {
  readonly formatVersion: typeof ENTITY_CATALOG_FORMAT_VERSION;
  readonly catalogId: string;
  readonly title: string;
  readonly componentGroups: readonly EntityComponentGroupDefinition[];
  readonly entityTypes: readonly EntityTypeDefinition[];
  readonly componentTypes: readonly EntityComponentTypeDefinition[];
}

export interface EntityCatalogIdentity {
  readonly catalogId: string;
  readonly title: string;
}

export interface RegisteredEntityComponentGroupDefinition extends EntityComponentGroupDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface RegisteredEntityTypeDefinition extends EntityTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface RegisteredEntityComponentTypeDefinition extends EntityComponentTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface EntityCatalogRegistry {
  readonly catalogs: readonly EntityCatalogIdentity[];
  readonly componentGroups: readonly RegisteredEntityComponentGroupDefinition[];
  readonly entityTypes: readonly RegisteredEntityTypeDefinition[];
  readonly componentTypes: readonly RegisteredEntityComponentTypeDefinition[];
}

export interface EntityComponentSearchOptions {
  readonly query?: string;
  readonly entityTypeId?: string;
  readonly limit?: number;
}

export function createEmptyEntityCatalog(catalogId = "empty"): EntityCatalog {
  return {
    formatVersion: ENTITY_CATALOG_FORMAT_VERSION,
    catalogId,
    title: catalogId,
    componentGroups: [],
    entityTypes: [],
    componentTypes: [],
  };
}

export function createEmptyEntityCatalogRegistry(): EntityCatalogRegistry {
  return { catalogs: [], componentGroups: [], entityTypes: [], componentTypes: [] };
}

export function parseEntityCatalog(text: string): DocumentParseResult<EntityCatalog> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("entityCatalog.invalidJson", "$", formatError(errorValue));
  }
  if (!isRecord(value)) {
    return failure("entityCatalog.invalidRoot", "$", "Entity Catalog must contain a JSON object.");
  }

  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(
    value,
    ["formatVersion", "catalogId", "title", "componentGroups", "entityTypes", "componentTypes"],
    "$",
    diagnostics,
  );
  if (value.formatVersion !== ENTITY_CATALOG_FORMAT_VERSION) {
    diagnostics.push(error(
      "entityCatalog.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${ENTITY_CATALOG_FORMAT_VERSION}.`,
    ));
  }
  const catalogId = readIdentifier(value.catalogId, "catalogId", diagnostics);
  const title = readNonEmptyString(value.title, "title", diagnostics);
  const componentGroups = readComponentGroups(value.componentGroups, diagnostics);
  const entityTypes = readEntityTypes(value.entityTypes, diagnostics);
  const componentTypes = readComponentTypes(value.componentTypes, diagnostics);
  validateLocalIdentityNamespace(componentGroups, "componentGroups", diagnostics);
  validateLocalIdentityNamespace(entityTypes, "entityTypes", diagnostics);
  validateLocalIdentityNamespace(componentTypes, "componentTypes", diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error") || catalogId === undefined || title === undefined) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      formatVersion: ENTITY_CATALOG_FORMAT_VERSION,
      catalogId,
      title,
      componentGroups,
      entityTypes,
      componentTypes,
    },
    diagnostics,
  };
}

export function buildEntityCatalogRegistry(
  catalogs: readonly EntityCatalog[],
): DocumentParseResult<EntityCatalogRegistry> {
  const diagnostics: DocumentDiagnostic[] = [];
  const catalogIds = new Map<string, number>();
  const groupIdentities = new Map<string, string>();
  const entityTypeIdentities = new Map<string, string>();
  const componentTypeIdentities = new Map<string, string>();
  const componentGroups: RegisteredEntityComponentGroupDefinition[] = [];
  const entityTypes: RegisteredEntityTypeDefinition[] = [];
  const componentTypes: RegisteredEntityComponentTypeDefinition[] = [];

  catalogs.forEach((catalog, catalogIndex) => {
    const previousCatalog = catalogIds.get(catalog.catalogId);
    if (previousCatalog !== undefined) {
      diagnostics.push(error(
        "entityCatalog.duplicateCatalogId",
        `catalogs[${catalogIndex}].catalogId`,
        `Catalog ID '${catalog.catalogId}' is already declared by catalogs[${previousCatalog}].`,
      ));
    } else {
      catalogIds.set(catalog.catalogId, catalogIndex);
    }
    catalog.componentGroups.forEach((group, index) => {
      registerIdentities(group, groupIdentities, `catalogs[${catalogIndex}].componentGroups[${index}]`, diagnostics);
      componentGroups.push({ ...group, catalogId: catalog.catalogId, catalogTitle: catalog.title });
    });
    catalog.entityTypes.forEach((entityType, index) => {
      registerIdentities(entityType, entityTypeIdentities, `catalogs[${catalogIndex}].entityTypes[${index}]`, diagnostics);
      entityTypes.push({ ...entityType, catalogId: catalog.catalogId, catalogTitle: catalog.title });
    });
    catalog.componentTypes.forEach((componentType, index) => {
      registerIdentities(componentType, componentTypeIdentities, `catalogs[${catalogIndex}].componentTypes[${index}]`, diagnostics);
      componentTypes.push({ ...componentType, catalogId: catalog.catalogId, catalogTitle: catalog.title });
    });
  });

  entityTypes.forEach((entityType, entityIndex) => {
    entityType.allowedComponentGroupIds.forEach((groupId, groupIndex) => {
      if (!groupIdentities.has(groupId)) {
        diagnostics.push(error(
          "entityCatalog.unknownAllowedGroup",
          `entityTypes[${entityIndex}].allowedComponentGroupIds[${groupIndex}]`,
          `Unknown Component Group '${groupId}'.`,
        ));
      }
    });
  });
  componentTypes.forEach((componentType, componentIndex) => {
    if (!groupIdentities.has(componentType.groupId)) {
      diagnostics.push(error(
        "entityCatalog.unknownComponentGroup",
        `componentTypes[${componentIndex}].groupId`,
        `Unknown Component Group '${componentType.groupId}'.`,
      ));
    }
  });

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      catalogs: catalogs.map((catalog) => ({ catalogId: catalog.catalogId, title: catalog.title })),
      componentGroups,
      entityTypes,
      componentTypes,
    },
    diagnostics,
  };
}

export function resolveEntityType(
  registry: EntityCatalogRegistry,
  entityTypeId: string,
): RegisteredEntityTypeDefinition | undefined {
  return registry.entityTypes.find((definition) => definition.id === entityTypeId || definition.aliases.includes(entityTypeId));
}

export function resolveEntityComponentType(
  registry: EntityCatalogRegistry,
  componentTypeId: string,
): RegisteredEntityComponentTypeDefinition | undefined {
  return registry.componentTypes.find(
    (definition) => definition.id === componentTypeId || definition.aliases.includes(componentTypeId),
  );
}

export function resolveEntityComponentGroup(
  registry: EntityCatalogRegistry,
  groupId: string,
): RegisteredEntityComponentGroupDefinition | undefined {
  return registry.componentGroups.find((definition) => definition.id === groupId || definition.aliases.includes(groupId));
}

export function isEntityComponentTypeAllowed(
  entityType: EntityTypeDefinition,
  componentType: EntityComponentTypeDefinition,
  registry: EntityCatalogRegistry,
): boolean {
  const componentGroup = resolveEntityComponentGroup(registry, componentType.groupId);
  if (componentGroup === undefined) {
    return false;
  }
  return entityType.allowedComponentGroupIds.some((allowedGroupId) => {
    const allowedGroup = resolveEntityComponentGroup(registry, allowedGroupId);
    return allowedGroup?.id === componentGroup.id;
  });
}

export function searchEntityComponentTypes(
  registry: EntityCatalogRegistry,
  options: EntityComponentSearchOptions = {},
): readonly RegisteredEntityComponentTypeDefinition[] {
  const entityType = options.entityTypeId === undefined ? undefined : resolveEntityType(registry, options.entityTypeId);
  if (options.entityTypeId !== undefined && entityType === undefined) {
    return [];
  }
  const terms = (options.query ?? "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  return registry.componentTypes
    .filter((componentType) => entityType === undefined || isEntityComponentTypeAllowed(entityType, componentType, registry))
    .filter((componentType) => {
      const group = resolveEntityComponentGroup(registry, componentType.groupId);
      const haystack = [
        componentType.catalogTitle,
        componentType.catalogId,
        group?.title,
        group?.id,
        componentType.title,
        componentType.id,
        ...componentType.aliases,
        ...componentType.menuPath,
        componentType.source?.providerId,
        componentType.source?.typeName,
      ].filter((entry): entry is string => entry !== undefined).join(" ").toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((left, right) => componentDisplayPath(left, registry).localeCompare(componentDisplayPath(right, registry))
      || left.id.localeCompare(right.id))
    .slice(0, limit);
}

export function serializeEntityCatalog(catalog: EntityCatalog): string {
  return `${JSON.stringify({
    formatVersion: ENTITY_CATALOG_FORMAT_VERSION,
    catalogId: catalog.catalogId,
    title: catalog.title,
    componentGroups: [...catalog.componentGroups]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((group) => ({ id: group.id, title: group.title, aliases: [...group.aliases].sort() })),
    entityTypes: [...catalog.entityTypes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entityType) => ({
        id: entityType.id,
        title: entityType.title,
        aliases: [...entityType.aliases].sort(),
        ...(entityType.description === undefined ? {} : { description: entityType.description }),
        allowedComponentGroupIds: [...entityType.allowedComponentGroupIds].sort(),
        properties: entityType.properties.map(serializeFieldDefinition),
      })),
    componentTypes: [...catalog.componentTypes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((componentType) => ({
        id: componentType.id,
        title: componentType.title,
        aliases: [...componentType.aliases].sort(),
        ...(componentType.description === undefined ? {} : { description: componentType.description }),
        groupId: componentType.groupId,
        menuPath: [...componentType.menuPath],
        ...(componentType.source === undefined ? {} : { source: componentType.source }),
        properties: componentType.properties.map(serializeFieldDefinition),
      })),
  }, null, 2)}\n`;
}

function readComponentGroups(
  value: unknown,
  diagnostics: DocumentDiagnostic[],
): readonly EntityComponentGroupDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("entityCatalog.invalidComponentGroups", "componentGroups", "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `componentGroups[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("entityCatalog.invalidComponentGroup", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "title", "aliases"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readNonEmptyString(entry.title, `${path}.title`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifiers(entry.aliases, `${path}.aliases`, diagnostics);
    return id === undefined || title === undefined ? [] : [{ id, title, aliases }];
  });
}

function readEntityTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly EntityTypeDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("entityCatalog.invalidEntityTypes", "entityTypes", "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `entityTypes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("entityCatalog.invalidEntityType", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "title", "aliases", "description", "allowedComponentGroupIds", "properties"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readNonEmptyString(entry.title, `${path}.title`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifiers(entry.aliases, `${path}.aliases`, diagnostics);
    const description = entry.description === undefined
      ? undefined
      : readNonEmptyString(entry.description, `${path}.description`, diagnostics);
    const allowedComponentGroupIds = readIdentifiers(
      entry.allowedComponentGroupIds,
      `${path}.allowedComponentGroupIds`,
      diagnostics,
    );
    const properties = parseFieldDefinitions(entry.properties, `${path}.properties`, diagnostics, { allowEmpty: true });
    return id === undefined || title === undefined ? [] : [{
      id,
      title,
      aliases,
      ...(description === undefined ? {} : { description }),
      allowedComponentGroupIds,
      properties,
    }];
  });
}

function readComponentTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly EntityComponentTypeDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("entityCatalog.invalidComponentTypes", "componentTypes", "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `componentTypes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("entityCatalog.invalidComponentType", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "title", "aliases", "description", "groupId", "menuPath", "source", "properties"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readNonEmptyString(entry.title, `${path}.title`, diagnostics);
    const aliases = entry.aliases === undefined ? [] : readIdentifiers(entry.aliases, `${path}.aliases`, diagnostics);
    const description = entry.description === undefined
      ? undefined
      : readNonEmptyString(entry.description, `${path}.description`, diagnostics);
    const groupId = readIdentifier(entry.groupId, `${path}.groupId`, diagnostics);
    const menuPath = entry.menuPath === undefined ? [] : readStringArray(entry.menuPath, `${path}.menuPath`, diagnostics);
    const source = entry.source === undefined ? undefined : readSource(entry.source, `${path}.source`, diagnostics);
    const properties = parseFieldDefinitions(entry.properties, `${path}.properties`, diagnostics, { allowEmpty: true });
    return id === undefined || title === undefined || groupId === undefined ? [] : [{
      id,
      title,
      aliases,
      ...(description === undefined ? {} : { description }),
      groupId,
      menuPath,
      ...(source === undefined ? {} : { source }),
      properties,
    }];
  });
}

function readSource(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): EntityTypeSourceDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("entityCatalog.invalidSource", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["providerId", "typeName"], path, diagnostics);
  const providerId = readIdentifier(value.providerId, `${path}.providerId`, diagnostics);
  const typeName = readNonEmptyString(value.typeName, `${path}.typeName`, diagnostics);
  return providerId === undefined || typeName === undefined ? undefined : { providerId, typeName };
}

function serializeFieldDefinition(definition: FieldDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    title: definition.title,
    aliases: [...definition.aliases].sort(),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...serializeValueDefinition(definition),
  };
}

function serializeValueDefinition(definition: import("@visualbridge/core").FieldValueDefinition): Record<string, unknown> {
  return {
    valueType: definition.valueType,
    ...(definition.dataTypeId === undefined ? {} : { dataTypeId: definition.dataTypeId }),
    defaultValue: normalizeJsonValue(definition.defaultValue),
    ...(definition.editor === undefined ? {} : {
      editor: {
        kind: definition.editor.kind,
        readOnly: definition.editor.readOnly,
        integer: definition.editor.integer,
        ...(definition.editor.min === undefined ? {} : { min: definition.editor.min }),
        ...(definition.editor.max === undefined ? {} : { max: definition.editor.max }),
        ...(definition.editor.step === undefined ? {} : { step: definition.editor.step }),
        ...(definition.editor.options.length === 0 ? {} : {
          options: definition.editor.options.map((option) => ({ title: option.title, value: normalizeJsonValue(option.value) })),
        }),
      },
    }),
    ...(definition.valueType === "object" ? { fields: definition.fields.map(serializeFieldDefinition) } : {}),
    ...(definition.valueType === "array" && definition.item !== undefined
      ? { item: serializeValueDefinition(definition.item) }
      : {}),
  };
}

function componentDisplayPath(
  componentType: RegisteredEntityComponentTypeDefinition,
  registry: EntityCatalogRegistry,
): string {
  const group = resolveEntityComponentGroup(registry, componentType.groupId);
  return [componentType.catalogTitle, group?.title ?? componentType.groupId, ...componentType.menuPath, componentType.title].join("/");
}

function validateLocalIdentityNamespace(
  definitions: readonly { readonly id: string; readonly aliases: readonly string[] }[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const identities = new Map<string, string>();
  definitions.forEach((definition, index) => {
    [definition.id, ...definition.aliases].forEach((identity) => {
      const existing = identities.get(identity);
      if (existing !== undefined) {
        diagnostics.push(error(
          "entityCatalog.duplicateLocalIdentity",
          `${path}[${index}]`,
          `Identity '${identity}' is already used by '${existing}'.`,
        ));
      } else {
        identities.set(identity, definition.id);
      }
    });
  });
}

function registerIdentities(
  definition: { readonly id: string; readonly aliases: readonly string[] },
  identities: Map<string, string>,
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  [definition.id, ...definition.aliases].forEach((identity) => {
    const existing = identities.get(identity);
    if (existing !== undefined) {
      diagnostics.push(error(
        "entityCatalog.registryIdentityConflict",
        path,
        `Identity '${identity}' is already used by '${existing}' in this Registry namespace.`,
      ));
    } else {
      identities.set(identity, definition.id);
    }
  });
}

function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("entityCatalog.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

function readIdentifiers(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("entityCatalog.invalidIdentifiers", path, "Expected an identifier array."));
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const identity = readIdentifier(entry, `${path}[${index}]`, diagnostics);
    if (identity === undefined) {
      return;
    }
    if (seen.has(identity)) {
      diagnostics.push(error("entityCatalog.duplicateIdentifier", `${path}[${index}]`, `Duplicate identifier '${identity}'.`));
      return;
    }
    seen.add(identity);
    result.push(identity);
  });
  return result;
}

function readStringArray(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("entityCatalog.invalidStringArray", path, "Expected a string array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const text = readNonEmptyString(entry, `${path}[${index}]`, diagnostics);
    return text === undefined ? [] : [text];
  });
}

function readNonEmptyString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(error("entityCatalog.invalidString", path, "Expected a non-empty string."));
    return undefined;
  }
  return value;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  Object.keys(value).forEach((key) => {
    if (!allowed.includes(key)) {
      diagnostics.push(error("entityCatalog.unknownKey", `${path}.${key}`, `Unknown key '${key}'.`));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: string, path: string, message: string): DocumentParseResult<never> {
  return { success: false, diagnostics: [error(code, path, message)] };
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
