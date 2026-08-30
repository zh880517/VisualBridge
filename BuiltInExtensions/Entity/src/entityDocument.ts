import type {
  DocumentDiagnostic,
  DocumentOperationResult,
  DocumentParseResult,
  FieldDefinition,
  JsonValue,
  ReferenceOccurrence,
} from "@visualbridge/core";
import {
  cloneJsonValue,
  compareUtf16CodeUnits,
  collectFieldReferences,
  createDefaultProperties,
  isJsonValue,
  normalizeJsonValue,
  replaceFieldReferenceValues,
  resolveFieldDefinition,
  validateFieldProperties,
  validateFieldValue,
} from "@visualbridge/core";
import {
  type EntityCatalogRegistry,
  isEntityComponentTypeAllowed,
  resolveEntityComponentType,
  resolveEntityType,
} from "./entityCatalog";

export const ENTITY_DOCUMENT_FORMAT_VERSION = 1;

export interface EntityComponentInstance {
  readonly id: string;
  readonly componentTypeId: string;
  readonly enabled: boolean;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface EntityDocument {
  readonly formatVersion: typeof ENTITY_DOCUMENT_FORMAT_VERSION;
  readonly documentId: string;
  readonly entityTypeId: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly components: readonly EntityComponentInstance[];
}

export type EntityOperation =
  | { readonly type: "entity.setTitle"; readonly title: string }
  | { readonly type: "entity.setProperty"; readonly propertyId: string; readonly value: JsonValue }
  | { readonly type: "entity.addComponent"; readonly componentId: string; readonly componentTypeId: string; readonly index?: number }
  | { readonly type: "entity.renameComponent"; readonly componentId: string; readonly newComponentId: string }
  | { readonly type: "entity.removeComponent"; readonly componentId: string }
  | { readonly type: "entity.moveComponent"; readonly componentId: string; readonly index: number }
  | { readonly type: "entity.setComponentEnabled"; readonly componentId: string; readonly enabled: boolean }
  | { readonly type: "entity.setComponentProperty"; readonly componentId: string; readonly propertyId: string; readonly value: JsonValue }
  | { readonly type: "entity.duplicateComponent"; readonly componentId: string; readonly newComponentId: string; readonly index?: number };

export function createEmptyEntityDocument(
  documentId: string,
  entityTypeId: string,
  registry: EntityCatalogRegistry,
  title = "New Entity",
): EntityDocument {
  const entityType = resolveEntityType(registry, entityTypeId);
  if (entityType === undefined) {
    throw new Error(`Unknown Entity Type '${entityTypeId}'.`);
  }
  return {
    formatVersion: ENTITY_DOCUMENT_FORMAT_VERSION,
    documentId,
    entityTypeId: entityType.id,
    title,
    properties: createDefaultProperties(entityType.properties),
    components: [],
  };
}

export function parseEntityDocument(text: string): DocumentParseResult<EntityDocument> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("entity.invalidJson", "$", formatError(errorValue));
  }
  if (!isRecord(value)) {
    return failure("entity.invalidRoot", "$", "Entity Document must contain a JSON object.");
  }

  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(value, ["formatVersion", "documentId", "entityTypeId", "title", "properties", "components"], "$", diagnostics);
  if (value.formatVersion !== ENTITY_DOCUMENT_FORMAT_VERSION) {
    diagnostics.push(error(
      "entity.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${ENTITY_DOCUMENT_FORMAT_VERSION}.`,
    ));
  }
  const documentId = readIdentifier(value.documentId, "documentId", diagnostics);
  const entityTypeId = readIdentifier(value.entityTypeId, "entityTypeId", diagnostics);
  const title = readNonEmptyString(value.title, "title", diagnostics);
  const properties = readProperties(value.properties, "properties", diagnostics);
  const components = readComponents(value.components, diagnostics);
  const componentIds = new Set<string>();
  components.forEach((component, index) => {
    if (componentIds.has(component.id)) {
      diagnostics.push(error(
        "entity.duplicateComponentId",
        `components[${index}].id`,
        `Duplicate Component instance ID '${component.id}'.`,
      ));
    }
    componentIds.add(component.id);
  });
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === "error")
    || documentId === undefined
    || entityTypeId === undefined
    || title === undefined
  ) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      formatVersion: ENTITY_DOCUMENT_FORMAT_VERSION,
      documentId,
      entityTypeId,
      title,
      properties,
      components,
    },
    diagnostics,
  };
}

export function validateEntityDocument(
  document: EntityDocument,
  registry?: EntityCatalogRegistry,
): readonly DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = [];
  if (registry === undefined) {
    return diagnostics;
  }
  const entityType = resolveEntityType(registry, document.entityTypeId);
  if (entityType === undefined) {
    diagnostics.push(error(
      "entity.unknownEntityType",
      "entityTypeId",
      `Unknown Entity Type '${document.entityTypeId}'.`,
    ));
    return diagnostics;
  }
  diagnostics.push(...validateFieldProperties(document.properties, entityType.properties, "properties"));
  document.components.forEach((component, index) => {
    const componentPath = `components[${index}]`;
    const componentType = resolveEntityComponentType(registry, component.componentTypeId);
    if (componentType === undefined) {
      diagnostics.push(warning(
        "entity.unknownComponentType",
        `${componentPath}.componentTypeId`,
        `Unknown Component Type '${component.componentTypeId}' is preserved.`,
      ));
      return;
    }
    if (!isEntityComponentTypeAllowed(entityType, componentType, registry)) {
      diagnostics.push(error(
        "entity.componentTypeNotAllowed",
        `${componentPath}.componentTypeId`,
        `Component Type '${componentType.id}' is not allowed by Entity Type '${entityType.id}'.`,
      ));
    }
    diagnostics.push(...validateFieldProperties(component.properties, componentType.properties, `${componentPath}.properties`));
  });
  return diagnostics;
}

export function renameEntityDocumentId(
  document: EntityDocument,
  documentId: string,
  registry?: EntityCatalogRegistry,
): DocumentOperationResult<EntityDocument> {
  if (!isStableIdentifier(documentId)) {
    return { success: false, diagnostics: [error("entity.invalidIdentifier", "documentId", "Expected a stable identifier.")] };
  }
  if (document.documentId === documentId) {
    return { success: false, diagnostics: [error("entity.sameDocumentId", "documentId", "The new document ID must be different.")] };
  }
  const next: EntityDocument = { ...document, documentId };
  return { success: true, document: next, diagnostics: validateEntityDocument(next, registry) };
}

export function collectEntityReferences(
  document: EntityDocument,
  registry: EntityCatalogRegistry,
): readonly ReferenceOccurrence[] {
  const entityType = resolveEntityType(registry, document.entityTypeId);
  if (entityType === undefined) {
    return [];
  }
  return [
    ...collectFieldReferences(document.properties, entityType.properties, "properties"),
    ...document.components.flatMap((component, index) => {
      const componentType = resolveEntityComponentType(registry, component.componentTypeId);
      return componentType === undefined
        ? []
        : collectFieldReferences(component.properties, componentType.properties, `components[${index}].properties`);
    }),
  ];
}

export function replaceEntityReferenceValues(
  document: EntityDocument,
  registry: EntityCatalogRegistry,
  occurrencePaths: ReadonlySet<string>,
  replacement: string | number,
): DocumentOperationResult<EntityDocument> {
  const entityType = resolveEntityType(registry, document.entityTypeId);
  if (entityType === undefined) {
    return { success: false, diagnostics: validateEntityDocument(document, registry) };
  }
  const operations: EntityOperation[] = [];
  const entityProperties = replaceFieldReferenceValues(
    document.properties,
    entityType.properties,
    "properties",
    (occurrence) => occurrencePaths.has(occurrence.path),
    replacement,
  );
  for (const definition of entityType.properties) {
    if (entityProperties.changedPaths.some((path) => path === `properties.${definition.id}` || path.startsWith(`properties.${definition.id}.`) || path.startsWith(`properties.${definition.id}[`))) {
      operations.push({ type: "entity.setProperty", propertyId: definition.id, value: entityProperties.properties[definition.id]! });
    }
  }
  document.components.forEach((component, index) => {
    const componentType = resolveEntityComponentType(registry, component.componentTypeId);
    if (componentType === undefined) {
      return;
    }
    const basePath = `components[${index}].properties`;
    const properties = replaceFieldReferenceValues(
      component.properties,
      componentType.properties,
      basePath,
      (occurrence) => occurrencePaths.has(occurrence.path),
      replacement,
    );
    for (const definition of componentType.properties) {
      if (properties.changedPaths.some((path) => path === `${basePath}.${definition.id}` || path.startsWith(`${basePath}.${definition.id}.`) || path.startsWith(`${basePath}.${definition.id}[`))) {
        operations.push({
          type: "entity.setComponentProperty",
          componentId: component.id,
          propertyId: definition.id,
          value: properties.properties[definition.id]!,
        });
      }
    }
  });
  return applyEntityOperations(document, operations, registry);
}

export function applyEntityOperations(
  document: EntityDocument,
  operationsValue: unknown,
  registry?: EntityCatalogRegistry,
): DocumentOperationResult<EntityDocument> {
  const parsed = parseOperations(operationsValue);
  if (!parsed.success) {
    return parsed;
  }
  const baselineErrors = diagnosticCounts(validateEntityDocument(document, registry));
  const working = cloneDocument(document);
  for (let index = 0; index < parsed.operations.length; index += 1) {
    const operation = parsed.operations[index];
    if (operation === undefined) {
      continue;
    }
    const diagnostic = applyOperation(working, operation, index, registry);
    if (diagnostic !== undefined) {
      return { success: false, diagnostics: [diagnostic] };
    }
  }
  const diagnostics = validateEntityDocument(working, registry);
  const introducedErrors = diagnostics.filter((diagnostic) => {
    if (diagnostic.severity !== "error") {
      return false;
    }
    const key = diagnosticKey(diagnostic);
    const count = baselineErrors.get(key) ?? 0;
    if (count === 0) {
      return true;
    }
    baselineErrors.set(key, count - 1);
    return false;
  });
  return introducedErrors.length > 0
    ? { success: false, diagnostics: introducedErrors }
    : { success: true, document: working, diagnostics };
}

export function serializeEntityDocument(document: EntityDocument): string {
  return `${JSON.stringify({
    formatVersion: ENTITY_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    entityTypeId: document.entityTypeId,
    title: document.title,
    properties: normalizeProperties(document.properties),
    components: document.components.map((component) => ({
      id: component.id,
      componentTypeId: component.componentTypeId,
      enabled: component.enabled,
      properties: normalizeProperties(component.properties),
    })),
  }, null, 2)}\n`;
}

function applyOperation(
  document: MutableEntityDocument,
  operation: EntityOperation,
  operationIndex: number,
  registry?: EntityCatalogRegistry,
): DocumentDiagnostic | undefined {
  const operationPath = `operations[${operationIndex}]`;
  switch (operation.type) {
    case "entity.setTitle":
      document.title = operation.title;
      return undefined;
    case "entity.setProperty": {
      const entityType = registry === undefined ? undefined : resolveEntityType(registry, document.entityTypeId);
      return setProperty(document.properties, entityType?.properties, operation.propertyId, operation.value, operationPath);
    }
    case "entity.addComponent": {
      if (document.components.some((component) => component.id === operation.componentId)) {
        return operationError(operationPath, `Component instance ID '${operation.componentId}' already exists.`);
      }
      const entityType = registry === undefined ? undefined : resolveEntityType(registry, document.entityTypeId);
      const componentType = registry === undefined
        ? undefined
        : resolveEntityComponentType(registry, operation.componentTypeId);
      if (entityType === undefined || componentType === undefined || registry === undefined) {
        return operationError(operationPath, "Adding a Component requires a ready Entity Catalog Registry.");
      }
      if (!isEntityComponentTypeAllowed(entityType, componentType, registry)) {
        return operationError(
          operationPath,
          `Component Type '${componentType.id}' is not allowed by Entity Type '${entityType.id}'.`,
        );
      }
      const index = operation.index ?? document.components.length;
      if (index < 0 || index > document.components.length) {
        return operationError(operationPath, `Component insertion index ${index} is out of range.`);
      }
      document.components.splice(index, 0, {
        id: operation.componentId,
        componentTypeId: componentType.id,
        enabled: true,
        properties: createDefaultProperties(componentType.properties),
      });
      return undefined;
    }
    case "entity.removeComponent": {
      const index = document.components.findIndex((component) => component.id === operation.componentId);
      if (index < 0) {
        return operationError(operationPath, `Unknown Component instance '${operation.componentId}'.`);
      }
      document.components.splice(index, 1);
      return undefined;
    }
    case "entity.renameComponent": {
      const component = findComponent(document, operation.componentId);
      if (component === undefined) {
        return operationError(operationPath, `Unknown Component instance '${operation.componentId}'.`);
      }
      if (operation.componentId === operation.newComponentId) {
        return operationError(operationPath, "The new Component instance ID must be different.");
      }
      if (document.components.some((candidate) => candidate.id === operation.newComponentId)) {
        return operationError(operationPath, `Component instance ID '${operation.newComponentId}' already exists.`);
      }
      component.id = operation.newComponentId;
      return undefined;
    }
    case "entity.moveComponent": {
      const index = document.components.findIndex((component) => component.id === operation.componentId);
      if (index < 0) {
        return operationError(operationPath, `Unknown Component instance '${operation.componentId}'.`);
      }
      if (operation.index < 0 || operation.index >= document.components.length) {
        return operationError(operationPath, `Component target index ${operation.index} is out of range.`);
      }
      const [component] = document.components.splice(index, 1);
      if (component !== undefined) {
        document.components.splice(operation.index, 0, component);
      }
      return undefined;
    }
    case "entity.setComponentEnabled": {
      const component = findComponent(document, operation.componentId);
      if (component === undefined) {
        return operationError(operationPath, `Unknown Component instance '${operation.componentId}'.`);
      }
      component.enabled = operation.enabled;
      return undefined;
    }
    case "entity.setComponentProperty": {
      const component = findComponent(document, operation.componentId);
      if (component === undefined) {
        return operationError(operationPath, `Unknown Component instance '${operation.componentId}'.`);
      }
      const componentType = registry === undefined
        ? undefined
        : resolveEntityComponentType(registry, component.componentTypeId);
      return setProperty(component.properties, componentType?.properties, operation.propertyId, operation.value, operationPath);
    }
    case "entity.duplicateComponent": {
      if (document.components.some((component) => component.id === operation.newComponentId)) {
        return operationError(operationPath, `Component instance ID '${operation.newComponentId}' already exists.`);
      }
      const sourceIndex = document.components.findIndex((component) => component.id === operation.componentId);
      const source = document.components[sourceIndex];
      if (source === undefined) {
        return operationError(operationPath, `Unknown Component instance '${operation.componentId}'.`);
      }
      const targetIndex = operation.index ?? sourceIndex + 1;
      if (targetIndex < 0 || targetIndex > document.components.length) {
        return operationError(operationPath, `Component insertion index ${targetIndex} is out of range.`);
      }
      document.components.splice(targetIndex, 0, {
        id: operation.newComponentId,
        componentTypeId: source.componentTypeId,
        enabled: source.enabled,
        properties: cloneProperties(source.properties),
      });
      return undefined;
    }
  }
}

function setProperty(
  properties: Record<string, JsonValue>,
  definitions: readonly FieldDefinition[] | undefined,
  propertyId: string,
  value: JsonValue,
  operationPath: string,
): DocumentDiagnostic | undefined {
  if (definitions === undefined) {
    return operationError(operationPath, "Editing fields requires a ready Entity Catalog Registry.");
  }
  const definition = resolveFieldDefinition(definitions, propertyId);
  if (definition === undefined) {
    return operationError(operationPath, `Unknown field '${propertyId}'.`);
  }
  const diagnostics: DocumentDiagnostic[] = [];
  validateFieldValue(value, definition, `${operationPath}.value`, diagnostics);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError !== undefined) {
    return firstError;
  }
  [definition.id, ...definition.aliases].forEach((identity) => delete properties[identity]);
  properties[definition.id] = cloneJsonValue(value);
  return undefined;
}

function parseOperations(value: unknown):
  | { readonly success: true; readonly operations: readonly EntityOperation[] }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { success: false, diagnostics: [error("entity.invalidOperations", "operations", "Expected a non-empty operation array.")] };
  }
  const diagnostics: DocumentDiagnostic[] = [];
  const operations = value.flatMap((entry, index) => {
    const operation = parseOperation(entry, index, diagnostics);
    return operation === undefined ? [] : [operation];
  });
  return diagnostics.length > 0 ? { success: false, diagnostics } : { success: true, operations };
}

function parseOperation(
  value: unknown,
  index: number,
  diagnostics: DocumentDiagnostic[],
): EntityOperation | undefined {
  const path = `operations[${index}]`;
  if (!isRecord(value) || typeof value.type !== "string") {
    diagnostics.push(error("entity.invalidOperation", path, "Expected an operation object with a type."));
    return undefined;
  }
  switch (value.type) {
    case "entity.setTitle": {
      checkKeys(value, ["type", "title"], path, diagnostics);
      const title = readNonEmptyString(value.title, `${path}.title`, diagnostics);
      return title === undefined ? undefined : { type: value.type, title };
    }
    case "entity.setProperty": {
      checkKeys(value, ["type", "propertyId", "value"], path, diagnostics);
      const propertyId = readIdentifier(value.propertyId, `${path}.propertyId`, diagnostics);
      const propertyValue = readJsonValue(value.value, `${path}.value`, diagnostics);
      return propertyId === undefined || propertyValue === undefined
        ? undefined
        : { type: value.type, propertyId, value: propertyValue };
    }
    case "entity.addComponent": {
      checkKeys(value, ["type", "componentId", "componentTypeId", "index"], path, diagnostics);
      const componentId = readIdentifier(value.componentId, `${path}.componentId`, diagnostics);
      const componentTypeId = readIdentifier(value.componentTypeId, `${path}.componentTypeId`, diagnostics);
      const targetIndex = value.index === undefined ? undefined : readIndex(value.index, `${path}.index`, diagnostics);
      return componentId === undefined || componentTypeId === undefined
        ? undefined
        : { type: value.type, componentId, componentTypeId, ...(targetIndex === undefined ? {} : { index: targetIndex }) };
    }
    case "entity.removeComponent": {
      checkKeys(value, ["type", "componentId"], path, diagnostics);
      const componentId = readIdentifier(value.componentId, `${path}.componentId`, diagnostics);
      return componentId === undefined ? undefined : { type: value.type, componentId };
    }
    case "entity.renameComponent": {
      checkKeys(value, ["type", "componentId", "newComponentId"], path, diagnostics);
      const componentId = readIdentifier(value.componentId, `${path}.componentId`, diagnostics);
      const newComponentId = readIdentifier(value.newComponentId, `${path}.newComponentId`, diagnostics);
      return componentId === undefined || newComponentId === undefined
        ? undefined
        : { type: value.type, componentId, newComponentId };
    }
    case "entity.moveComponent": {
      checkKeys(value, ["type", "componentId", "index"], path, diagnostics);
      const componentId = readIdentifier(value.componentId, `${path}.componentId`, diagnostics);
      const targetIndex = readIndex(value.index, `${path}.index`, diagnostics);
      return componentId === undefined || targetIndex === undefined
        ? undefined
        : { type: value.type, componentId, index: targetIndex };
    }
    case "entity.setComponentEnabled": {
      checkKeys(value, ["type", "componentId", "enabled"], path, diagnostics);
      const componentId = readIdentifier(value.componentId, `${path}.componentId`, diagnostics);
      const enabled = readBoolean(value.enabled, `${path}.enabled`, diagnostics);
      return componentId === undefined || enabled === undefined
        ? undefined
        : { type: value.type, componentId, enabled };
    }
    case "entity.setComponentProperty": {
      checkKeys(value, ["type", "componentId", "propertyId", "value"], path, diagnostics);
      const componentId = readIdentifier(value.componentId, `${path}.componentId`, diagnostics);
      const propertyId = readIdentifier(value.propertyId, `${path}.propertyId`, diagnostics);
      const propertyValue = readJsonValue(value.value, `${path}.value`, diagnostics);
      return componentId === undefined || propertyId === undefined || propertyValue === undefined
        ? undefined
        : { type: value.type, componentId, propertyId, value: propertyValue };
    }
    case "entity.duplicateComponent": {
      checkKeys(value, ["type", "componentId", "newComponentId", "index"], path, diagnostics);
      const componentId = readIdentifier(value.componentId, `${path}.componentId`, diagnostics);
      const newComponentId = readIdentifier(value.newComponentId, `${path}.newComponentId`, diagnostics);
      const targetIndex = value.index === undefined ? undefined : readIndex(value.index, `${path}.index`, diagnostics);
      return componentId === undefined || newComponentId === undefined
        ? undefined
        : { type: value.type, componentId, newComponentId, ...(targetIndex === undefined ? {} : { index: targetIndex }) };
    }
    default:
      diagnostics.push(error("entity.unknownOperation", `${path}.type`, `Unknown Entity Operation '${value.type}'.`));
      return undefined;
  }
}

function readComponents(value: unknown, diagnostics: DocumentDiagnostic[]): readonly EntityComponentInstance[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("entity.invalidComponents", "components", "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `components[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("entity.invalidComponent", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "componentTypeId", "enabled", "properties"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const componentTypeId = readIdentifier(entry.componentTypeId, `${path}.componentTypeId`, diagnostics);
    const enabled = readBoolean(entry.enabled, `${path}.enabled`, diagnostics);
    const properties = readProperties(entry.properties, `${path}.properties`, diagnostics);
    return id === undefined || componentTypeId === undefined || enabled === undefined
      ? []
      : [{ id, componentTypeId, enabled, properties }];
  });
}

function readProperties(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): Record<string, JsonValue> {
  if (!isRecord(value)) {
    diagnostics.push(error("entity.invalidProperties", path, "Expected a JSON object."));
    return {};
  }
  const result: Record<string, JsonValue> = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
      diagnostics.push(error("entity.invalidPropertyId", `${path}.${key}`, "Expected a stable field identifier."));
      return;
    }
    if (!isJsonValue(entry)) {
      diagnostics.push(error("entity.invalidPropertyValue", `${path}.${key}`, "Expected a finite JSON value."));
      return;
    }
    result[key] = cloneJsonValue(entry);
  });
  return result;
}

function readJsonValue(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): JsonValue | undefined {
  if (!isJsonValue(value)) {
    diagnostics.push(error("entity.invalidJsonValue", path, "Expected a finite JSON value."));
    return undefined;
  }
  return cloneJsonValue(value);
}

function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (!isStableIdentifier(value)) {
    diagnostics.push(error("entity.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

function isStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function readNonEmptyString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(error("entity.invalidString", path, "Expected a non-empty string."));
    return undefined;
  }
  return value;
}

function readBoolean(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): boolean | undefined {
  if (typeof value !== "boolean") {
    diagnostics.push(error("entity.invalidBoolean", path, "Expected a boolean."));
    return undefined;
  }
  return value;
}

function readIndex(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    diagnostics.push(error("entity.invalidIndex", path, "Expected a non-negative integer."));
    return undefined;
  }
  return value;
}

function normalizeProperties(properties: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(properties)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([key, value]) => [key, normalizeJsonValue(value)]),
  );
}

function cloneDocument(document: EntityDocument): MutableEntityDocument {
  return {
    formatVersion: ENTITY_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    entityTypeId: document.entityTypeId,
    title: document.title,
    properties: cloneProperties(document.properties),
    components: document.components.map((component) => ({
      id: component.id,
      componentTypeId: component.componentTypeId,
      enabled: component.enabled,
      properties: cloneProperties(component.properties),
    })),
  };
}

function cloneProperties(properties: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, cloneJsonValue(value)]));
}

function findComponent(document: MutableEntityDocument, componentId: string): MutableEntityComponent | undefined {
  return document.components.find((component) => component.id === componentId);
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  Object.keys(value).forEach((key) => {
    if (!allowed.includes(key)) {
      diagnostics.push(error("entity.unknownKey", `${path}.${key}`, `Unknown key '${key}'.`));
    }
  });
}

function diagnosticCounts(diagnostics: readonly DocumentDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  diagnostics.filter((diagnostic) => diagnostic.severity === "error").forEach((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`;
}

function operationError(path: string, message: string): DocumentDiagnostic {
  return error("entity.operationRejected", path, message);
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

function warning(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "warning", code, path, message };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

interface MutableEntityComponent {
  id: string;
  componentTypeId: string;
  enabled: boolean;
  properties: Record<string, JsonValue>;
}

interface MutableEntityDocument {
  formatVersion: typeof ENTITY_DOCUMENT_FORMAT_VERSION;
  documentId: string;
  entityTypeId: string;
  title: string;
  properties: Record<string, JsonValue>;
  components: MutableEntityComponent[];
}
