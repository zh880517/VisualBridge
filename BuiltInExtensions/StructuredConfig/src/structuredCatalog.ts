import type {
  CatalogSourceDefinition,
  DocumentDiagnostic,
  DocumentParseResult,
  FieldDefinition,
} from "@visualbridge/core";
import {
  compareUtf16CodeUnits,
  parseCatalogSourceDefinition,
  parseFieldDefinitions,
  serializeCatalogSourceDefinition,
  serializeFieldDefinition,
} from "@visualbridge/core";

export const STRUCTURED_EDITOR_ID = "structured";
export const STRUCTURED_CATALOG_FORMAT_VERSION = 1;

export interface StructuredTypeSourceDefinition {
  readonly providerId: string;
  readonly typeName: string;
}

export interface StructuredConfigTypeDefinition {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly source?: StructuredTypeSourceDefinition;
  readonly properties: readonly FieldDefinition[];
}

export interface StructuredCatalog {
  readonly formatVersion: typeof STRUCTURED_CATALOG_FORMAT_VERSION;
  readonly catalogId: string;
  readonly title: string;
  readonly source: CatalogSourceDefinition;
  readonly configTypes: readonly StructuredConfigTypeDefinition[];
}

export interface RegisteredStructuredConfigTypeDefinition extends StructuredConfigTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface StructuredCatalogRegistry {
  readonly catalogs: readonly { readonly catalogId: string; readonly title: string }[];
  readonly configTypes: readonly RegisteredStructuredConfigTypeDefinition[];
}

export function createEmptyStructuredCatalogRegistry(): StructuredCatalogRegistry {
  return { catalogs: [], configTypes: [] };
}

export function parseStructuredCatalog(text: string): DocumentParseResult<StructuredCatalog> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("structuredCatalog.invalidJson", "$", formatError(errorValue));
  }
  if (!isRecord(value)) {
    return failure("structuredCatalog.invalidRoot", "$", "Structured Catalog must contain a JSON object.");
  }
  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(value, ["formatVersion", "catalogId", "title", "source", "configTypes"], "$", diagnostics);
  if (value.formatVersion !== STRUCTURED_CATALOG_FORMAT_VERSION) {
    diagnostics.push(error(
      "structuredCatalog.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${STRUCTURED_CATALOG_FORMAT_VERSION}.`,
    ));
  }
  const catalogId = readIdentifier(value.catalogId, "catalogId", diagnostics);
  const title = readNonEmptyString(value.title, "title", diagnostics);
  const sourceResult = parseCatalogSourceDefinition(value.source);
  if (!sourceResult.success) {
    diagnostics.push(...sourceResult.issues.map((issue) => error(
      "structuredCatalog.invalidSource",
      issue.path,
      issue.message,
    )));
  }
  const configTypes = readConfigTypes(value.configTypes, diagnostics);
  validateIdentityNamespace(configTypes, "configTypes", diagnostics, "structuredCatalog.duplicateLocalIdentity");
  if (catalogId === undefined || title === undefined || !sourceResult.success || hasErrors(diagnostics)) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      formatVersion: STRUCTURED_CATALOG_FORMAT_VERSION,
      catalogId,
      title,
      source: sourceResult.value,
      configTypes,
    },
    diagnostics,
  };
}

export function buildStructuredCatalogRegistry(
  catalogs: readonly StructuredCatalog[],
): DocumentParseResult<StructuredCatalogRegistry> {
  const diagnostics: DocumentDiagnostic[] = [];
  const catalogIds = new Map<string, number>();
  const identities = new Map<string, string>();
  const configTypes: RegisteredStructuredConfigTypeDefinition[] = [];
  catalogs.forEach((catalog, catalogIndex) => {
    const existingCatalog = catalogIds.get(catalog.catalogId);
    if (existingCatalog !== undefined) {
      diagnostics.push(error(
        "structuredCatalog.duplicateCatalogId",
        `catalogs[${catalogIndex}].catalogId`,
        `Catalog ID '${catalog.catalogId}' is already declared by catalogs[${existingCatalog}].`,
      ));
    } else {
      catalogIds.set(catalog.catalogId, catalogIndex);
    }
    catalog.configTypes.forEach((configType, configTypeIndex) => {
      for (const identity of [configType.id, ...configType.aliases]) {
        const existing = identities.get(identity);
        if (existing !== undefined) {
          diagnostics.push(error(
            "structuredCatalog.registryIdentityConflict",
            `catalogs[${catalogIndex}].configTypes[${configTypeIndex}]`,
            `Config Type identity '${identity}' is already used by '${existing}'.`,
          ));
        } else {
          identities.set(identity, configType.id);
        }
      }
      configTypes.push({ ...configType, catalogId: catalog.catalogId, catalogTitle: catalog.title });
    });
  });
  if (hasErrors(diagnostics)) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      catalogs: catalogs.map((catalog) => ({ catalogId: catalog.catalogId, title: catalog.title })),
      configTypes,
    },
    diagnostics,
  };
}

export function resolveStructuredConfigType(
  registry: StructuredCatalogRegistry,
  configTypeId: string,
): RegisteredStructuredConfigTypeDefinition | undefined {
  return registry.configTypes.find(
    (configType) => configType.id === configTypeId || configType.aliases.includes(configTypeId),
  );
}

export function serializeStructuredCatalog(catalog: StructuredCatalog): string {
  return `${JSON.stringify({
    formatVersion: STRUCTURED_CATALOG_FORMAT_VERSION,
    catalogId: catalog.catalogId,
    title: catalog.title,
    source: serializeCatalogSourceDefinition(catalog.source),
    configTypes: [...catalog.configTypes]
      .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
      .map((configType) => ({
        id: configType.id,
        title: configType.title,
        aliases: [...configType.aliases].sort(compareUtf16CodeUnits),
        ...(configType.description === undefined ? {} : { description: configType.description }),
        ...(configType.source === undefined ? {} : { source: configType.source }),
        properties: configType.properties.map(serializeFieldDefinition),
      })),
  }, null, 2)}\n`;
}

function readConfigTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly StructuredConfigTypeDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(error("structuredCatalog.invalidConfigTypes", "configTypes", "Expected a non-empty array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `configTypes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("structuredCatalog.invalidConfigType", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "title", "aliases", "description", "source", "properties"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readNonEmptyString(entry.title, `${path}.title`, diagnostics);
    const aliases = readIdentifiers(entry.aliases ?? [], `${path}.aliases`, diagnostics);
    const description = entry.description === undefined
      ? undefined
      : readNonEmptyString(entry.description, `${path}.description`, diagnostics);
    const source = entry.source === undefined ? undefined : readSource(entry.source, `${path}.source`, diagnostics);
    const properties = parseFieldDefinitions(entry.properties, `${path}.properties`, diagnostics, { allowEmpty: true });
    return id === undefined || title === undefined ? [] : [{
      id,
      title,
      aliases,
      ...(description === undefined ? {} : { description }),
      ...(source === undefined ? {} : { source }),
      properties,
    }];
  });
}

function readSource(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): StructuredTypeSourceDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("structuredCatalog.invalidSource", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["providerId", "typeName"], path, diagnostics);
  const providerId = readIdentifier(value.providerId, `${path}.providerId`, diagnostics);
  const typeName = readNonEmptyString(value.typeName, `${path}.typeName`, diagnostics);
  return providerId === undefined || typeName === undefined ? undefined : { providerId, typeName };
}

function validateIdentityNamespace(
  definitions: readonly { readonly id: string; readonly aliases: readonly string[] }[],
  path: string,
  diagnostics: DocumentDiagnostic[],
  code: string,
): void {
  const identities = new Map<string, string>();
  definitions.forEach((definition, index) => {
    for (const identity of [definition.id, ...definition.aliases]) {
      const existing = identities.get(identity);
      if (existing !== undefined) {
        diagnostics.push(error(code, `${path}[${index}]`, `Identity '${identity}' is already used by '${existing}'.`));
      } else {
        identities.set(identity, definition.id);
      }
    }
  });
}

function readIdentifiers(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("structuredCatalog.invalidAliases", path, "Expected an identifier array."));
    return [];
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    const identity = readIdentifier(entry, `${path}[${index}]`, diagnostics);
    if (identity !== undefined) {
      result.push(identity);
    }
  });
  return result;
}

function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("structuredCatalog.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

function readNonEmptyString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(error("structuredCatalog.invalidString", path, "Expected a non-empty string."));
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
  Object.keys(value).filter((key) => !allowed.includes(key)).forEach((key) => diagnostics.push(error(
    "structuredCatalog.unknownProperty",
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
