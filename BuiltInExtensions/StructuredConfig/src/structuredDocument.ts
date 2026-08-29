import type {
  DocumentDiagnostic,
  DocumentOperationResult,
  DocumentParseResult,
  JsonValue,
  ReferenceOccurrence,
} from "@visualbridge/core";
import {
  cloneJsonValue,
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
  resolveStructuredConfigType,
  type StructuredCatalogRegistry,
} from "./structuredCatalog";

export const STRUCTURED_DOCUMENT_FORMAT_VERSION = 1;

export interface StructuredDocument {
  readonly formatVersion: typeof STRUCTURED_DOCUMENT_FORMAT_VERSION;
  readonly documentId: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export type StructuredOperation = {
  readonly type: "structured.setField";
  readonly fieldId: string;
  readonly value: JsonValue;
};

export function createEmptyStructuredDocument(
  documentId: string,
  configTypeId: string,
  registry: StructuredCatalogRegistry,
): StructuredDocument {
  const configType = resolveStructuredConfigType(registry, configTypeId);
  if (configType === undefined) {
    throw new Error(`Unknown Structured Config Type '${configTypeId}'.`);
  }
  return {
    formatVersion: STRUCTURED_DOCUMENT_FORMAT_VERSION,
    documentId,
    properties: createDefaultProperties(configType.properties),
  };
}

export function parseStructuredDocument(text: string): DocumentParseResult<StructuredDocument> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("structured.invalidJson", "$", formatError(errorValue));
  }
  if (!isRecord(value)) {
    return failure("structured.invalidRoot", "$", "Structured Document must contain a JSON object.");
  }
  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(value, ["formatVersion", "documentId", "properties"], "$", diagnostics);
  if (value.formatVersion !== STRUCTURED_DOCUMENT_FORMAT_VERSION) {
    diagnostics.push(error(
      "structured.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${STRUCTURED_DOCUMENT_FORMAT_VERSION}.`,
    ));
  }
  const documentId = readIdentifier(value.documentId, "documentId", diagnostics);
  const properties = readProperties(value.properties, "properties", diagnostics);
  if (documentId === undefined || hasErrors(diagnostics)) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      formatVersion: STRUCTURED_DOCUMENT_FORMAT_VERSION,
      documentId,
      properties,
    },
    diagnostics,
  };
}

export function validateStructuredDocument(
  document: StructuredDocument,
  registry: StructuredCatalogRegistry,
  configTypeId: string,
): readonly DocumentDiagnostic[] {
  const configType = resolveStructuredConfigType(registry, configTypeId);
  if (configType === undefined) {
    return [error(
      "structured.documentTypeUnbound",
      "documentTypeId",
      `Document Type '${configTypeId}' does not resolve to a Structured Config Type.`,
    )];
  }
  const diagnostics = [...validateFieldProperties(document.properties, configType.properties, "properties")];
  for (const definition of configType.properties) {
    if (document.properties[definition.id] === undefined
      && !definition.aliases.some((alias) => document.properties[alias] !== undefined)) {
      diagnostics.push(error(
        "structured.missingProperty",
        `properties.${definition.id}`,
        `Required field '${definition.id}' is missing from the Structured Document.`,
      ));
    }
  }
  return diagnostics;
}

export function renameStructuredDocumentId(
  document: StructuredDocument,
  documentId: string,
  registry: StructuredCatalogRegistry,
  configTypeId: string,
): DocumentOperationResult<StructuredDocument> {
  if (!isStableIdentifier(documentId)) {
    return { success: false, diagnostics: [error("structured.invalidIdentifier", "documentId", "Expected a stable identifier.")] };
  }
  if (document.documentId === documentId) {
    return { success: false, diagnostics: [error("structured.sameDocumentId", "documentId", "The new document ID must be different.")] };
  }
  const next: StructuredDocument = { ...document, documentId };
  return { success: true, document: next, diagnostics: validateStructuredDocument(next, registry, configTypeId) };
}

export function collectStructuredReferences(
  document: StructuredDocument,
  registry: StructuredCatalogRegistry,
  configTypeId: string,
): readonly ReferenceOccurrence[] {
  const configType = resolveStructuredConfigType(registry, configTypeId);
  return configType === undefined
    ? []
    : collectFieldReferences(document.properties, configType.properties, "properties");
}

export function replaceStructuredReferenceValues(
  document: StructuredDocument,
  registry: StructuredCatalogRegistry,
  configTypeId: string,
  occurrencePaths: ReadonlySet<string>,
  replacement: string | number,
): DocumentOperationResult<StructuredDocument> {
  const configType = resolveStructuredConfigType(registry, configTypeId);
  if (configType === undefined) {
    return { success: false, diagnostics: validateStructuredDocument(document, registry, configTypeId) };
  }
  const properties = replaceFieldReferenceValues(
    document.properties,
    configType.properties,
    "properties",
    (occurrence) => occurrencePaths.has(occurrence.path),
    replacement,
  );
  const operations: StructuredOperation[] = configType.properties.flatMap((definition) => (
    properties.changedPaths.some((path) => path === `properties.${definition.id}` || path.startsWith(`properties.${definition.id}.`) || path.startsWith(`properties.${definition.id}[`))
      ? [{ type: "structured.setField" as const, fieldId: definition.id, value: properties.properties[definition.id]! }]
      : []
  ));
  return applyStructuredOperations(document, operations, registry, configTypeId);
}

export function applyStructuredOperations(
  document: StructuredDocument,
  operationsValue: unknown,
  registry: StructuredCatalogRegistry,
  configTypeId: string,
): DocumentOperationResult<StructuredDocument> {
  const operations = parseOperations(operationsValue);
  if (!operations.success) {
    return operations;
  }
  const configType = resolveStructuredConfigType(registry, configTypeId);
  if (configType === undefined) {
    return { success: false, diagnostics: validateStructuredDocument(document, registry, configTypeId) };
  }
  const baseline = diagnosticCounts(validateStructuredDocument(document, registry, configTypeId));
  const properties = cloneProperties(document.properties);
  for (let index = 0; index < operations.operations.length; index += 1) {
    const operation = operations.operations[index]!;
    const definition = resolveFieldDefinition(configType.properties, operation.fieldId);
    if (definition === undefined) {
      return { success: false, diagnostics: [error(
        "structured.unknownField",
        `operations[${index}].fieldId`,
        `Unknown field '${operation.fieldId}'.`,
      )] };
    }
    if (definition.id !== operation.fieldId) {
      return { success: false, diagnostics: [error(
        "structured.nonCanonicalFieldId",
        `operations[${index}].fieldId`,
        `Operations must use canonical field ID '${definition.id}'.`,
      )] };
    }
    const valueDiagnostics: DocumentDiagnostic[] = [];
    validateFieldValue(operation.value, definition, `operations[${index}].value`, valueDiagnostics);
    if (hasErrors(valueDiagnostics)) {
      return { success: false, diagnostics: valueDiagnostics };
    }
    properties[definition.id] = cloneJsonValue(operation.value);
    definition.aliases.forEach((alias) => { delete properties[alias]; });
  }
  const next: StructuredDocument = { ...document, properties };
  const diagnostics = validateStructuredDocument(next, registry, configTypeId);
  const introducedErrors = diagnostics.filter((diagnostic) => consumeIntroducedError(baseline, diagnostic));
  return introducedErrors.length > 0
    ? { success: false, diagnostics: introducedErrors }
    : { success: true, document: next, diagnostics };
}

export function serializeStructuredDocument(document: StructuredDocument): string {
  return `${JSON.stringify({
    formatVersion: STRUCTURED_DOCUMENT_FORMAT_VERSION,
    documentId: document.documentId,
    properties: normalizeJsonValue(document.properties),
  }, null, 2)}\n`;
}

function parseOperations(value: unknown):
  | { readonly success: true; readonly operations: readonly StructuredOperation[] }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { success: false, diagnostics: [error(
      "structured.invalidOperations",
      "operations",
      "Expected a non-empty operation array.",
    )] };
  }
  const diagnostics: DocumentDiagnostic[] = [];
  const operations = value.flatMap((entry, index) => {
    const path = `operations[${index}]`;
    if (!isRecord(entry) || entry.type !== "structured.setField") {
      diagnostics.push(error("structured.invalidOperation", path, "Expected a structured.setField operation."));
      return [];
    }
    checkKeys(entry, ["type", "fieldId", "value"], path, diagnostics);
    const fieldId = readIdentifier(entry.fieldId, `${path}.fieldId`, diagnostics);
    if (!isJsonValue(entry.value)) {
      diagnostics.push(error("structured.invalidOperationValue", `${path}.value`, "Expected a finite JSON value."));
      return [];
    }
    return fieldId === undefined ? [] : [{ type: "structured.setField" as const, fieldId, value: entry.value }];
  });
  return hasErrors(diagnostics) ? { success: false, diagnostics } : { success: true, operations };
}

function readProperties(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value)) {
    diagnostics.push(error("structured.invalidProperties", path, "Expected a JSON object."));
    return {};
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isJsonValue(entry)) {
      diagnostics.push(error("structured.invalidPropertyValue", `${path}.${key}`, "Expected a finite JSON value."));
    } else {
      result[key] = entry;
    }
  }
  return result;
}

function cloneProperties(properties: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, cloneJsonValue(value)]));
}

function diagnosticCounts(diagnostics: readonly DocumentDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  diagnostics.filter((diagnostic) => diagnostic.severity === "error").forEach((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function consumeIntroducedError(baseline: Map<string, number>, diagnostic: DocumentDiagnostic): boolean {
  if (diagnostic.severity !== "error") {
    return false;
  }
  const key = diagnosticKey(diagnostic);
  const count = baseline.get(key) ?? 0;
  if (count === 0) {
    return true;
  }
  baseline.set(key, count - 1);
  return false;
}

function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`;
}

function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (!isStableIdentifier(value)) {
    diagnostics.push(error("structured.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

function isStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  Object.keys(value).filter((key) => !allowed.includes(key)).forEach((key) => diagnostics.push(error(
    "structured.unknownProperty",
    `${path}.${key}`,
    `Unknown property '${key}'.`,
  )));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrors(diagnostics: readonly DocumentDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function failure(code: string, path: string, message: string): DocumentParseResult<never> {
  return { success: false, diagnostics: [error(code, path, message)] };
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
