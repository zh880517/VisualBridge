import type {
  CatalogSourceDefinition,
  DocumentDiagnostic,
  DocumentParseResult,
  FieldDefinition,
  FieldValueDefinition,
  JsonValue,
} from "@visualbridge/core";
import { parseCatalogSourceDefinition, parseFieldDefinitions } from "@visualbridge/core";

export const TABLE_EDITOR_ID = "table";
export const TABLE_CATALOG_FORMAT_VERSION = 1;

export type TableCellEncodingDefinition =
  | { readonly kind: "scalar" }
  | { readonly kind: "json" }
  | {
      readonly kind: "delimited";
      readonly separator: string;
      readonly item?: TableCellEncodingDefinition;
    };

export interface TableColumnDefinition extends FieldDefinition {
  readonly nameKey: string;
  readonly nameKeyAliases: readonly string[];
  readonly cellEncoding: TableCellEncodingDefinition;
}

export interface TableSheetDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly name: string;
  readonly nameAliases: readonly string[];
  readonly rowDisplayNamePattern: string;
  readonly keyColumnId?: string;
  readonly partition?: TablePartitionDefinition;
  readonly columns: readonly TableColumnDefinition[];
}

export type TableDuplicatePolicy = "error" | "keepFirst" | "keepLast";

export interface TablePartitionDefinition {
  readonly namePattern: string;
  readonly deduplicateByColumnId: string;
  readonly duplicatePolicy: TableDuplicatePolicy;
}

export interface TableTypeSourceDefinition {
  readonly providerId: string;
  readonly typeName: string;
}

export interface TableTypeDefinition {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly source?: TableTypeSourceDefinition;
  readonly csv?: { readonly delimiter: string };
  readonly sheets: readonly TableSheetDefinition[];
}

export interface TableCatalog {
  readonly formatVersion: typeof TABLE_CATALOG_FORMAT_VERSION;
  readonly catalogId: string;
  readonly title: string;
  readonly source: CatalogSourceDefinition;
  readonly tableTypes: readonly TableTypeDefinition[];
}

export interface RegisteredTableTypeDefinition extends TableTypeDefinition {
  readonly catalogId: string;
  readonly catalogTitle: string;
}

export interface TableCatalogRegistry {
  readonly catalogs: readonly { readonly catalogId: string; readonly title: string }[];
  readonly tableTypes: readonly RegisteredTableTypeDefinition[];
}

export function createEmptyTableCatalogRegistry(): TableCatalogRegistry {
  return { catalogs: [], tableTypes: [] };
}

export function parseTableCatalog(text: string): DocumentParseResult<TableCatalog> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return failure("tableCatalog.invalidJson", "$", formatError(errorValue));
  }
  if (!isRecord(value)) {
    return failure("tableCatalog.invalidRoot", "$", "Table Catalog must contain a JSON object.");
  }

  const diagnostics: DocumentDiagnostic[] = [];
  checkKeys(value, ["formatVersion", "catalogId", "title", "source", "tableTypes"], "$", diagnostics);
  if (value.formatVersion !== TABLE_CATALOG_FORMAT_VERSION) {
    diagnostics.push(error(
      "tableCatalog.unsupportedVersion",
      "formatVersion",
      `Expected formatVersion ${TABLE_CATALOG_FORMAT_VERSION}.`,
    ));
  }
  const catalogId = readIdentifier(value.catalogId, "catalogId", diagnostics);
  const title = readNonEmptyString(value.title, "title", diagnostics);
  const sourceResult = parseCatalogSourceDefinition(value.source);
  if (!sourceResult.success) {
    diagnostics.push(...sourceResult.issues.map((issue) => error(
      "tableCatalog.invalidSource",
      issue.path,
      issue.message,
    )));
  }
  const tableTypes = readTableTypes(value.tableTypes, diagnostics);
  if (catalogId === undefined || title === undefined || !sourceResult.success || hasErrors(diagnostics)) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      formatVersion: TABLE_CATALOG_FORMAT_VERSION,
      catalogId,
      title,
      source: sourceResult.value,
      tableTypes,
    },
    diagnostics,
  };
}

export function buildTableCatalogRegistry(
  catalogs: readonly TableCatalog[],
): DocumentParseResult<TableCatalogRegistry> {
  const diagnostics: DocumentDiagnostic[] = [];
  const catalogIds = new Map<string, number>();
  const identities = new Map<string, string>();
  const tableTypes: RegisteredTableTypeDefinition[] = [];
  catalogs.forEach((catalog, catalogIndex) => {
    const previous = catalogIds.get(catalog.catalogId);
    if (previous !== undefined) {
      diagnostics.push(error(
        "tableCatalog.duplicateCatalogId",
        `catalogs[${catalogIndex}].catalogId`,
        `Catalog ID '${catalog.catalogId}' is already declared by catalogs[${previous}].`,
      ));
    } else {
      catalogIds.set(catalog.catalogId, catalogIndex);
    }
    catalog.tableTypes.forEach((tableType, tableIndex) => {
      for (const identity of [tableType.id, ...tableType.aliases]) {
        const existing = identities.get(identity);
        if (existing !== undefined) {
          diagnostics.push(error(
            "tableCatalog.duplicateTableTypeIdentity",
            `catalogs[${catalogIndex}].tableTypes[${tableIndex}]`,
            `Table Type identity '${identity}' is already used by '${existing}'.`,
          ));
        } else {
          identities.set(identity, tableType.id);
        }
      }
      tableTypes.push({ ...tableType, catalogId: catalog.catalogId, catalogTitle: catalog.title });
    });
  });
  if (hasErrors(diagnostics)) {
    return { success: false, diagnostics };
  }
  return {
    success: true,
    document: {
      catalogs: catalogs.map((catalog) => ({ catalogId: catalog.catalogId, title: catalog.title })),
      tableTypes,
    },
    diagnostics,
  };
}

export function resolveTableType(
  registry: TableCatalogRegistry,
  tableTypeId: string,
): RegisteredTableTypeDefinition | undefined {
  return registry.tableTypes.find(
    (tableType) => tableType.id === tableTypeId || tableType.aliases.includes(tableTypeId),
  );
}

export function resolveTableSheet(
  tableType: TableTypeDefinition,
  sheetId: string,
): TableSheetDefinition | undefined {
  return tableType.sheets.find((sheet) => sheet.id === sheetId || sheet.aliases.includes(sheetId));
}

export function matchTableSheetDefinitions(
  tableType: TableTypeDefinition,
  physicalName: string,
): readonly TableSheetDefinition[] {
  return tableType.sheets.filter((sheet) => sheet.name === physicalName
    || sheet.nameAliases.includes(physicalName)
    || (sheet.partition !== undefined && matchesPartitionPattern(sheet.partition.namePattern, physicalName)));
}

export function resolveTableColumn(
  sheet: TableSheetDefinition,
  columnId: string,
): TableColumnDefinition | undefined {
  return sheet.columns.find((column) => column.id === columnId || column.aliases.includes(columnId));
}

export function formatTableRowDisplayName(
  cells: Readonly<Record<string, JsonValue>>,
  sheet: TableSheetDefinition,
): string {
  return sheet.rowDisplayNamePattern.replace(/\{([A-Za-z0-9][A-Za-z0-9._-]{0,127})\}/g, (_match, columnId: string) => {
    const value = cells[columnId];
    if (value === undefined || value === null) {
      return "";
    }
    return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

function readTableTypes(value: unknown, diagnostics: DocumentDiagnostic[]): readonly TableTypeDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(error("tableCatalog.invalidTableTypes", "tableTypes", "Expected a non-empty array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const path = `tableTypes[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("tableCatalog.invalidTableType", path, "Expected an object."));
      return [];
    }
    checkKeys(entry, ["id", "title", "aliases", "description", "source", "csv", "sheets"], path, diagnostics);
    const id = readIdentifier(entry.id, `${path}.id`, diagnostics);
    const title = readNonEmptyString(entry.title, `${path}.title`, diagnostics);
    const aliases = readIdentifiers(entry.aliases ?? [], `${path}.aliases`, diagnostics);
    const description = entry.description === undefined
      ? undefined
      : readNonEmptyString(entry.description, `${path}.description`, diagnostics);
    const source = entry.source === undefined ? undefined : readSource(entry.source, `${path}.source`, diagnostics);
    const csv = entry.csv === undefined ? undefined : readCsv(entry.csv, `${path}.csv`, diagnostics);
    const sheets = readSheets(entry.sheets, `${path}.sheets`, diagnostics);
    if (id === undefined || title === undefined) {
      return [];
    }
    return [{
      id,
      title,
      aliases,
      ...(description === undefined ? {} : { description }),
      ...(source === undefined ? {} : { source }),
      ...(csv === undefined ? {} : { csv }),
      sheets,
    }];
  });
}

function readSheets(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly TableSheetDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(error("tableCatalog.invalidSheets", path, "Expected a non-empty array."));
    return [];
  }
  const identities = new Map<string, string>();
  return value.flatMap((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("tableCatalog.invalidSheet", entryPath, "Expected an object."));
      return [];
    }
    checkKeys(
      entry,
      ["id", "aliases", "title", "name", "nameAliases", "rowDisplayNamePattern", "keyColumnId", "partition", "columns"],
      entryPath,
      diagnostics,
    );
    const id = readIdentifier(entry.id, `${entryPath}.id`, diagnostics);
    const aliases = readIdentifiers(entry.aliases ?? [], `${entryPath}.aliases`, diagnostics);
    const title = readNonEmptyString(entry.title, `${entryPath}.title`, diagnostics);
    const name = readNonEmptyString(entry.name, `${entryPath}.name`, diagnostics);
    const nameAliases = readStrings(entry.nameAliases ?? [], `${entryPath}.nameAliases`, diagnostics);
    const keyColumnId = entry.keyColumnId === undefined
      ? undefined
      : readIdentifier(entry.keyColumnId, `${entryPath}.keyColumnId`, diagnostics);
    const columns = readColumns(entry.columns, `${entryPath}.columns`, diagnostics);
    const rowDisplayNamePattern = readRowDisplayNamePattern(
      entry.rowDisplayNamePattern,
      columns,
      `${entryPath}.rowDisplayNamePattern`,
      diagnostics,
    );
    const partition = entry.partition === undefined
      ? undefined
      : readPartition(entry.partition, columns, `${entryPath}.partition`, diagnostics);
    if (id !== undefined) {
      for (const identity of [id, ...aliases]) {
        const existing = identities.get(identity);
        if (existing !== undefined) {
          diagnostics.push(error(
            "tableCatalog.duplicateSheetIdentity",
            entryPath,
            `Sheet identity '${identity}' is already used by '${existing}'.`,
          ));
        } else {
          identities.set(identity, id);
        }
      }
    }
    if (keyColumnId !== undefined && !columns.some(
      (column) => column.id === keyColumnId || column.aliases.includes(keyColumnId),
    )) {
      diagnostics.push(error(
        "tableCatalog.unknownKeyColumn",
        `${entryPath}.keyColumnId`,
        `Unknown key column '${keyColumnId}'.`,
      ));
    }
    if (id === undefined || title === undefined || name === undefined || rowDisplayNamePattern === undefined) {
      return [];
    }
    return [{
      id,
      aliases,
      title,
      name,
      nameAliases,
      rowDisplayNamePattern,
      ...(keyColumnId === undefined ? {} : { keyColumnId }),
      ...(partition === undefined ? {} : { partition }),
      columns,
    }];
  });
}

function readRowDisplayNamePattern(
  value: unknown,
  columns: readonly TableColumnDefinition[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): string | undefined {
  const pattern = readNonEmptyString(value, path, diagnostics);
  if (pattern === undefined) {
    return undefined;
  }
  const placeholders = [...pattern.matchAll(/\{([A-Za-z0-9][A-Za-z0-9._-]{0,127})\}/g)];
  const unmatched = pattern.replace(/\{[A-Za-z0-9][A-Za-z0-9._-]{0,127}\}/g, "");
  if (placeholders.length === 0 || /[{}]/.test(unmatched)) {
    diagnostics.push(error(
      "tableCatalog.invalidRowDisplayNamePattern",
      path,
      "Row display-name pattern must contain valid '{columnId}' placeholders.",
    ));
    return undefined;
  }
  let valid = true;
  for (const placeholder of placeholders) {
    const columnId = placeholder[1]!;
    if (!columns.some((column) => column.id === columnId)) {
      diagnostics.push(error(
        "tableCatalog.unknownRowDisplayNameColumn",
        path,
        `Unknown row display-name column '${columnId}'. Use a stable Column ID, not a name key or alias.`,
      ));
      valid = false;
    }
  }
  return valid ? pattern : undefined;
}

function readPartition(
  value: unknown,
  columns: readonly TableColumnDefinition[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): TablePartitionDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("tableCatalog.invalidPartition", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["namePattern", "deduplicateByColumnId", "duplicatePolicy"], path, diagnostics);
  const namePattern = readNonEmptyString(value.namePattern, `${path}.namePattern`, diagnostics);
  if (namePattern !== undefined && countOccurrences(namePattern, "{part}") !== 1) {
    diagnostics.push(error(
      "tableCatalog.invalidPartitionPattern",
      `${path}.namePattern`,
      "Partition name pattern must contain exactly one '{part}' placeholder.",
    ));
  }
  const deduplicateByColumnId = readIdentifier(
    value.deduplicateByColumnId,
    `${path}.deduplicateByColumnId`,
    diagnostics,
  );
  if (deduplicateByColumnId !== undefined && !columns.some(
    (column) => column.id === deduplicateByColumnId || column.aliases.includes(deduplicateByColumnId),
  )) {
    diagnostics.push(error(
      "tableCatalog.unknownDeduplicateColumn",
      `${path}.deduplicateByColumnId`,
      `Unknown de-duplicate column '${deduplicateByColumnId}'.`,
    ));
  }
  const duplicatePolicy = readEnum(
    value.duplicatePolicy,
    ["error", "keepFirst", "keepLast"] as const,
    `${path}.duplicatePolicy`,
    diagnostics,
  );
  return namePattern === undefined
    || countOccurrences(namePattern, "{part}") !== 1
    || deduplicateByColumnId === undefined
    || duplicatePolicy === undefined
    ? undefined
    : { namePattern, deduplicateByColumnId, duplicatePolicy };
}

function readColumns(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly TableColumnDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(error("tableCatalog.invalidColumns", path, "Expected a non-empty array."));
    return [];
  }
  const identityOwners = new Map<string, string>();
  const nameKeyOwners = new Map<string, string>();
  return value.flatMap((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("tableCatalog.invalidColumn", entryPath, "Expected an object."));
      return [];
    }
    checkKeys(
      entry,
      [
        "id", "title", "aliases", "description", "valueType", "dataTypeId", "defaultValue",
        "editor", "reference", "fields", "item", "nameKey", "nameKeyAliases", "cellEncoding",
      ],
      entryPath,
      diagnostics,
    );
    const fieldPayload = Object.fromEntries(Object.entries(entry).filter(([key]) => [
      "id", "title", "aliases", "description", "valueType", "dataTypeId", "defaultValue",
      "editor", "reference", "fields", "item",
    ].includes(key)));
    const [field] = parseFieldDefinitions([fieldPayload], entryPath, diagnostics);
    const nameKey = readNonEmptyString(entry.nameKey, `${entryPath}.nameKey`, diagnostics);
    const nameKeyAliases = readStrings(entry.nameKeyAliases ?? [], `${entryPath}.nameKeyAliases`, diagnostics);
    const cellEncoding = readCellEncoding(
      entry.cellEncoding,
      field,
      `${entryPath}.cellEncoding`,
      diagnostics,
    );
    if (field === undefined || nameKey === undefined || cellEncoding === undefined) {
      return [];
    }
    for (const identity of [field.id, ...field.aliases]) {
      registerUnique(identityOwners, identity, field.id, entryPath, "column identity", diagnostics);
    }
    for (const physicalName of [nameKey, ...nameKeyAliases]) {
      registerUnique(nameKeyOwners, physicalName, field.id, entryPath, "name key", diagnostics);
    }
    return [{ ...field, nameKey, nameKeyAliases, cellEncoding }];
  });
}

function readCellEncoding(
  value: unknown,
  field: FieldValueDefinition | undefined,
  path: string,
  diagnostics: DocumentDiagnostic[],
): TableCellEncodingDefinition | undefined {
  if (value === undefined) {
    if (field !== undefined && ["string", "number", "boolean"].includes(field.valueType)) {
      return { kind: "scalar" };
    }
    diagnostics.push(error(
      "tableCatalog.missingCellEncoding",
      path,
      "Structured table columns require an explicit C#-exported cell encoding.",
    ));
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(error("tableCatalog.invalidCellEncoding", path, "Expected an object."));
    return undefined;
  }
  const kind = value.kind;
  if (kind === "scalar") {
    checkKeys(value, ["kind"], path, diagnostics);
    if (field !== undefined && !["string", "number", "boolean"].includes(field.valueType)) {
      diagnostics.push(error("tableCatalog.incompatibleCellEncoding", path, "Scalar encoding requires a primitive field."));
    }
    return { kind };
  }
  if (kind === "json") {
    checkKeys(value, ["kind"], path, diagnostics);
    return { kind };
  }
  if (kind === "delimited") {
    checkKeys(value, ["kind", "separator", "item"], path, diagnostics);
    const separator = readSeparator(value.separator, `${path}.separator`, diagnostics);
    if (field !== undefined && field.valueType !== "array" && field.valueType !== "object") {
      diagnostics.push(error(
        "tableCatalog.incompatibleCellEncoding",
        path,
        "Delimited encoding requires an array or object field.",
      ));
    }
    const nestedField = field?.valueType === "array" ? field.item : undefined;
    const item = value.item === undefined
      ? undefined
      : readCellEncoding(value.item, nestedField, `${path}.item`, diagnostics);
    if (value.item !== undefined && field?.valueType !== "array") {
      diagnostics.push(error(
        "tableCatalog.unexpectedNestedCellEncoding",
        `${path}.item`,
        "Only array encodings can declare a nested item encoding.",
      ));
    }
    return separator === undefined
      ? undefined
      : { kind, separator, ...(item === undefined ? {} : { item }) };
  }
  diagnostics.push(error(
    "tableCatalog.invalidCellEncodingKind",
    `${path}.kind`,
    "Expected scalar, json or delimited.",
  ));
  return undefined;
}

function readSource(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): TableTypeSourceDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("tableCatalog.invalidSource", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["providerId", "typeName"], path, diagnostics);
  const providerId = readIdentifier(value.providerId, `${path}.providerId`, diagnostics);
  const typeName = readNonEmptyString(value.typeName, `${path}.typeName`, diagnostics);
  return providerId === undefined || typeName === undefined ? undefined : { providerId, typeName };
}

function readCsv(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): { readonly delimiter: string } | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("tableCatalog.invalidCsv", path, "Expected an object."));
    return undefined;
  }
  checkKeys(value, ["delimiter"], path, diagnostics);
  const delimiter = readSeparator(value.delimiter, `${path}.delimiter`, diagnostics);
  return delimiter === undefined ? undefined : { delimiter };
}

function registerUnique(
  owners: Map<string, string>,
  identity: string,
  owner: string,
  path: string,
  kind: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const existing = owners.get(identity);
  if (existing !== undefined) {
    diagnostics.push(error(
      "tableCatalog.duplicateColumnIdentity",
      path,
      `Column ${kind} '${identity}' is already used by '${existing}'.`,
    ));
  } else {
    owners.set(identity, owner);
  }
}

function readSeparator(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    diagnostics.push(error("tableCatalog.invalidSeparator", path, "Expected a non-empty separator without line breaks."));
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): T | undefined {
  if (typeof value !== "string" || !values.includes(value as T)) {
    diagnostics.push(error("tableCatalog.invalidEnum", path, `Expected one of: ${values.join(", ")}.`));
    return undefined;
  }
  return value as T;
}

function matchesPartitionPattern(pattern: string, value: string): boolean {
  const [prefix = "", suffix = ""] = pattern.split("{part}");
  return value.length > prefix.length + suffix.length
    && value.startsWith(prefix)
    && value.endsWith(suffix);
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("tableCatalog.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

function readIdentifiers(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): readonly string[] {
  return readStrings(value, path, diagnostics).flatMap((entry, index) => {
    const identity = readIdentifier(entry, `${path}[${index}]`, diagnostics);
    return identity === undefined ? [] : [identity];
  });
}

function readStrings(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("tableCatalog.invalidStrings", path, "Expected a string array."));
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const text = readNonEmptyString(entry, `${path}[${index}]`, diagnostics);
    if (text === undefined) {
      return;
    }
    if (seen.has(text)) {
      diagnostics.push(error("tableCatalog.duplicateString", `${path}[${index}]`, `Duplicate value '${text}'.`));
      return;
    }
    seen.add(text);
    result.push(text);
  });
  return result;
}

function readNonEmptyString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(error("tableCatalog.invalidString", path, "Expected a non-empty string."));
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
      diagnostics.push(error("tableCatalog.unknownKey", `${path}.${key}`, `Unknown key '${key}'.`));
    }
  });
}

function hasErrors(diagnostics: readonly DocumentDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
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
