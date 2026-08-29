import type { DocumentDiagnostic } from "../Document/document";
import type { ReferenceDefinition, ReferenceOccurrence } from "../Reference/reference";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type FieldValueType = "string" | "number" | "boolean" | "object" | "array" | "json";
export type FieldEditorKind = "text" | "multiline" | "number" | "checkbox" | "select" | "color" | "reference" | "json";

export interface FieldEditorOption {
  readonly title: string;
  readonly value: JsonValue;
}

export interface FieldEditorDefinition {
  readonly kind: FieldEditorKind;
  readonly readOnly: boolean;
  readonly integer: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options: readonly FieldEditorOption[];
}

export interface FieldValueDefinition {
  readonly valueType: FieldValueType;
  readonly dataTypeId?: string;
  readonly defaultValue: JsonValue;
  readonly editor?: FieldEditorDefinition;
  readonly reference?: ReferenceDefinition;
  readonly fields: readonly FieldDefinition[];
  readonly item?: FieldValueDefinition;
}

export interface FieldDefinition extends FieldValueDefinition {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly description?: string;
}

export interface FieldParseOptions {
  readonly allowEmpty?: boolean;
}

export function parseFieldDefinitions(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
  options: FieldParseOptions = {},
): readonly FieldDefinition[] {
  if (!Array.isArray(value) || (value.length === 0 && options.allowEmpty !== true)) {
    diagnostics.push(error("field.invalidDefinitions", path, options.allowEmpty === true
      ? "Expected an array of field definitions."
      : "Expected a non-empty array of field definitions."));
    return [];
  }

  const definitions = value.flatMap((entry, index) => {
    const definition = parseFieldDefinition(entry, `${path}[${index}]`, diagnostics);
    return definition === undefined ? [] : [definition];
  });
  validateFieldIdentityNamespace(definitions, path, diagnostics);
  return definitions;
}

export function parseFieldValueDefinition(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): FieldValueDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("field.invalidDefinition", path, "Expected a field value definition object."));
    return undefined;
  }
  checkKeys(value, ["valueType", "dataTypeId", "defaultValue", "editor", "reference", "fields", "item"], path, diagnostics);
  return parseValueDefinitionMembers(value, path, diagnostics);
}

export function resolveFieldDefinition(
  definitions: readonly FieldDefinition[],
  fieldId: string,
): FieldDefinition | undefined {
  return definitions.find((definition) => definition.id === fieldId || definition.aliases.includes(fieldId));
}

export function createDefaultProperties(
  definitions: readonly FieldDefinition[],
): Record<string, JsonValue> {
  return Object.fromEntries(definitions.map((definition) => [definition.id, cloneJsonValue(definition.defaultValue)]));
}

export function validateFieldProperties(
  properties: Readonly<Record<string, JsonValue>>,
  definitions: readonly FieldDefinition[],
  path: string,
): readonly DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = [];
  for (const [fieldId, value] of Object.entries(properties)) {
    const definition = resolveFieldDefinition(definitions, fieldId);
    if (definition === undefined) {
      diagnostics.push(warning("field.unknownProperty", `${path}.${fieldId}`, `Unknown field '${fieldId}' is preserved.`));
      continue;
    }
    validateFieldValue(value, definition, `${path}.${fieldId}`, diagnostics);
  }
  return diagnostics;
}

export function validateFieldValue(
  value: JsonValue,
  definition: FieldValueDefinition,
  path: string,
  diagnostics: DocumentDiagnostic[] = [],
): readonly DocumentDiagnostic[] {
  if (!matchesValueType(value, definition.valueType)) {
    diagnostics.push(error(
      "field.invalidValueType",
      path,
      `Expected ${definition.valueType} value${definition.dataTypeId === undefined ? "" : ` for '${definition.dataTypeId}'`}.`,
    ));
    return diagnostics;
  }

  if (definition.valueType === "number" && typeof value === "number") {
    if (!Number.isFinite(value)) {
      diagnostics.push(error("field.invalidNumber", path, "Expected a finite number."));
      return diagnostics;
    }
    if (definition.editor?.integer === true && !Number.isInteger(value)) {
      diagnostics.push(error("field.invalidInteger", path, "Expected an integer."));
    }
    if (definition.editor?.min !== undefined && value < definition.editor.min) {
      diagnostics.push(error("field.numberBelowMinimum", path, `Expected a value greater than or equal to ${definition.editor.min}.`));
    }
    if (definition.editor?.max !== undefined && value > definition.editor.max) {
      diagnostics.push(error("field.numberAboveMaximum", path, `Expected a value less than or equal to ${definition.editor.max}.`));
    }
  }

  if (definition.editor?.kind === "color" && typeof value === "string" && !isColor(value)) {
    diagnostics.push(error("field.invalidColor", path, "Expected a color in #RRGGBB or #RRGGBBAA format."));
  }

  if (definition.valueType === "object" && isRecord(value)) {
    diagnostics.push(...validateFieldProperties(value as Readonly<Record<string, JsonValue>>, definition.fields, path));
  }
  if (definition.valueType === "array" && Array.isArray(value) && definition.item !== undefined) {
    value.forEach((entry, index) => validateFieldValue(entry, definition.item!, `${path}[${index}]`, diagnostics));
  }
  return diagnostics;
}

export function collectFieldReferences(
  properties: Readonly<Record<string, JsonValue>>,
  definitions: readonly FieldDefinition[],
  path: string,
): readonly ReferenceOccurrence[] {
  return definitions.flatMap((definition) => {
    const value = resolvePropertyValue(properties, definition);
    return collectValueReferences(value, definition, `${path}.${definition.id}`);
  });
}

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJsonValue(entry as JsonValue)]),
    );
  }
  return value;
}

export function serializeFieldDefinition(definition: FieldDefinition): Readonly<Record<string, JsonValue>> {
  return {
    id: definition.id,
    title: definition.title,
    aliases: [...definition.aliases].sort(),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...serializeFieldValueDefinition(definition),
  };
}

export function serializeFieldValueDefinition(
  definition: FieldValueDefinition,
): Readonly<Record<string, JsonValue>> {
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
          options: definition.editor.options.map((option) => ({
            title: option.title,
            value: normalizeJsonValue(option.value),
          })),
        }),
      },
    }),
    ...(definition.reference === undefined ? {} : {
      reference: {
        kind: definition.reference.kind,
        target: normalizeJsonValue(definition.reference.target),
        ...(definition.reference.allowMissing ? { allowMissing: true } : {}),
      },
    }),
    ...(definition.valueType === "object"
      ? { fields: definition.fields.map(serializeFieldDefinition) }
      : {}),
    ...(definition.valueType === "array" && definition.item !== undefined
      ? { item: serializeFieldValueDefinition(definition.item) }
      : {}),
  };
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  return isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));
}

function parseFieldDefinition(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): FieldDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("field.invalidDefinition", path, "Expected a field definition object."));
    return undefined;
  }
  checkKeys(
    value,
    ["id", "title", "aliases", "description", "valueType", "dataTypeId", "defaultValue", "editor", "reference", "fields", "item"],
    path,
    diagnostics,
  );
  const id = readIdentifier(value.id, `${path}.id`, diagnostics);
  const title = readNonEmptyString(value.title, `${path}.title`, diagnostics);
  const aliases = value.aliases === undefined ? [] : readIdentifiers(value.aliases, `${path}.aliases`, diagnostics);
  const description = value.description === undefined
    ? undefined
    : readNonEmptyString(value.description, `${path}.description`, diagnostics);
  const members = parseValueDefinitionMembers(value, path, diagnostics);
  if (id === undefined || title === undefined || members === undefined) {
    return undefined;
  }
  return { id, title, aliases, ...(description === undefined ? {} : { description }), ...members };
}

function parseValueDefinitionMembers(
  value: Record<string, unknown>,
  path: string,
  diagnostics: DocumentDiagnostic[],
): FieldValueDefinition | undefined {
  const valueType = readEnum(
    value.valueType,
    ["string", "number", "boolean", "object", "array", "json"] as const,
    `${path}.valueType`,
    diagnostics,
  );
  const dataTypeId = value.dataTypeId === undefined
    ? undefined
    : readIdentifier(value.dataTypeId, `${path}.dataTypeId`, diagnostics);
  if (!isJsonValue(value.defaultValue)) {
    diagnostics.push(error("field.invalidDefaultValue", `${path}.defaultValue`, "Expected a finite JSON value."));
  }
  const editor = value.editor === undefined
    ? undefined
    : parseEditor(value.editor, `${path}.editor`, diagnostics);
  const reference = value.reference === undefined
    ? undefined
    : parseReferenceDefinition(value.reference, `${path}.reference`, diagnostics);

  let fields: readonly FieldDefinition[] = [];
  let item: FieldValueDefinition | undefined;
  if (valueType === "object") {
    fields = parseFieldDefinitions(value.fields, `${path}.fields`, diagnostics, { allowEmpty: true });
    if (value.item !== undefined) {
      diagnostics.push(error("field.unexpectedItem", `${path}.item`, "Object fields cannot declare an item definition."));
    }
  } else if (valueType === "array") {
    item = parseFieldValueDefinition(value.item, `${path}.item`, diagnostics);
    if (value.fields !== undefined) {
      diagnostics.push(error("field.unexpectedFields", `${path}.fields`, "Array fields cannot declare nested fields directly."));
    }
  } else {
    if (value.fields !== undefined) {
      diagnostics.push(error("field.unexpectedFields", `${path}.fields`, `Fields are not valid for ${valueType ?? "unknown"} values.`));
    }
    if (value.item !== undefined) {
      diagnostics.push(error("field.unexpectedItem", `${path}.item`, `Item is not valid for ${valueType ?? "unknown"} values.`));
    }
  }

  if (valueType === undefined || !isJsonValue(value.defaultValue)) {
    return undefined;
  }
  const definition: FieldValueDefinition = {
    valueType,
    ...(dataTypeId === undefined ? {} : { dataTypeId }),
    defaultValue: cloneJsonValue(value.defaultValue),
    ...(editor === undefined ? {} : { editor }),
    ...(reference === undefined ? {} : { reference }),
    fields,
    ...(item === undefined ? {} : { item }),
  };
  validateEditorCompatibility(definition, path, diagnostics);
  validateReferenceCompatibility(definition, path, diagnostics);
  validateFieldValue(definition.defaultValue, definition, `${path}.defaultValue`, diagnostics);
  return definition;
}

export function parseReferenceDefinition(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): ReferenceDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("field.invalidReference", path, "Expected a reference definition object."));
    return undefined;
  }
  checkKeys(value, ["kind", "target", "allowMissing"], path, diagnostics);
  const kind = readIdentifier(value.kind, `${path}.kind`, diagnostics);
  const target = value.target;
  if (!isRecord(target) || !isJsonValue(target)) {
    diagnostics.push(error("field.invalidReferenceTarget", `${path}.target`, "Expected a JSON object."));
  }
  const allowMissing = value.allowMissing === undefined
    ? false
    : readBoolean(value.allowMissing, `${path}.allowMissing`, diagnostics);
  return kind === undefined || !isRecord(target) || !isJsonValue(target)
    ? undefined
    : {
        kind,
        target: normalizeJsonValue(target as Readonly<Record<string, JsonValue>>) as Readonly<Record<string, JsonValue>>,
        allowMissing: allowMissing ?? false,
      };
}

function parseEditor(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): FieldEditorDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error("field.invalidEditor", path, "Expected an editor definition object."));
    return undefined;
  }
  checkKeys(value, ["kind", "readOnly", "integer", "min", "max", "step", "options"], path, diagnostics);
  const kind = readEnum(
    value.kind,
    ["text", "multiline", "number", "checkbox", "select", "color", "reference", "json"] as const,
    `${path}.kind`,
    diagnostics,
  );
  const readOnly = value.readOnly === undefined ? false : readBoolean(value.readOnly, `${path}.readOnly`, diagnostics);
  const integer = value.integer === undefined ? false : readBoolean(value.integer, `${path}.integer`, diagnostics);
  const min = value.min === undefined ? undefined : readFiniteNumber(value.min, `${path}.min`, diagnostics);
  const max = value.max === undefined ? undefined : readFiniteNumber(value.max, `${path}.max`, diagnostics);
  const step = value.step === undefined ? undefined : readFiniteNumber(value.step, `${path}.step`, diagnostics);
  const options = value.options === undefined ? [] : readEditorOptions(value.options, `${path}.options`, diagnostics);
  if (min !== undefined && max !== undefined && min > max) {
    diagnostics.push(error("field.invalidEditorRange", path, "Editor min cannot exceed max."));
  }
  if (step !== undefined && step <= 0) {
    diagnostics.push(error("field.invalidEditorStep", `${path}.step`, "Editor step must be greater than zero."));
  }
  if (kind !== "select" && options.length > 0) {
    diagnostics.push(error("field.unexpectedEditorOptions", `${path}.options`, "Only select editors may declare options."));
  }
  return kind === undefined ? undefined : {
    kind,
    readOnly: readOnly ?? false,
    integer: integer ?? false,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(step === undefined ? {} : { step }),
    options,
  };
}

function readEditorOptions(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly FieldEditorOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(error("field.invalidEditorOptions", path, "Expected a non-empty option array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(error("field.invalidEditorOption", entryPath, "Expected an option object."));
      return [];
    }
    checkKeys(entry, ["title", "value"], entryPath, diagnostics);
    const title = readNonEmptyString(entry.title, `${entryPath}.title`, diagnostics);
    if (!isJsonValue(entry.value)) {
      diagnostics.push(error("field.invalidEditorOptionValue", `${entryPath}.value`, "Expected a finite JSON value."));
      return [];
    }
    return title === undefined ? [] : [{ title, value: cloneJsonValue(entry.value) }];
  });
}

function validateEditorCompatibility(
  definition: FieldValueDefinition,
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const editor = definition.editor;
  if (editor === undefined) {
    return;
  }
  const compatible = editor.kind === "select"
    || editor.kind === "json"
    || ((editor.kind === "text" || editor.kind === "multiline" || editor.kind === "color")
      && definition.valueType === "string")
    || (editor.kind === "reference" && (definition.valueType === "string" || definition.valueType === "number"))
    || (editor.kind === "number" && definition.valueType === "number")
    || (editor.kind === "checkbox" && definition.valueType === "boolean");
  if (!compatible) {
    diagnostics.push(error(
      "field.incompatibleEditor",
      `${path}.editor.kind`,
      `Editor '${editor.kind}' is not compatible with ${definition.valueType}.`,
    ));
  }
  if (editor.kind === "select") {
    if (editor.options.length === 0) {
      diagnostics.push(error("field.missingEditorOptions", `${path}.editor.options`, "Select editors require options."));
    }
    const { editor: ignoredEditor, ...valueDefinition } = definition;
    void ignoredEditor;
    editor.options.forEach((option, index) => validateFieldValue(
      option.value,
      valueDefinition,
      `${path}.editor.options[${index}].value`,
      diagnostics,
    ));
  }
}

function validateReferenceCompatibility(
  definition: FieldValueDefinition,
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  if (definition.reference === undefined) {
    if (definition.editor?.kind === "reference") {
      diagnostics.push(error(
        "field.missingReferenceDefinition",
        `${path}.reference`,
        "Reference editors require a reference definition.",
      ));
    }
    return;
  }
  if (definition.editor?.kind !== "reference") {
    diagnostics.push(error(
      "field.missingReferenceEditor",
      `${path}.editor.kind`,
      "Reference definitions require a reference editor.",
    ));
  }
  if (definition.valueType !== "string" && definition.valueType !== "number") {
    diagnostics.push(error(
      "field.invalidReferenceValueType",
      `${path}.valueType`,
      "References require a string or number JSON value.",
    ));
  }
}

function collectValueReferences(
  value: JsonValue,
  definition: FieldValueDefinition,
  path: string,
): readonly ReferenceOccurrence[] {
  const result: ReferenceOccurrence[] = [];
  if (definition.reference !== undefined && (typeof value === "string" || typeof value === "number")) {
    result.push({ definition: definition.reference, value, path });
  }
  if (definition.valueType === "object" && isRecord(value)) {
    result.push(...collectFieldReferences(value as Readonly<Record<string, JsonValue>>, definition.fields, path));
  } else if (definition.valueType === "array" && Array.isArray(value) && definition.item !== undefined) {
    value.forEach((entry, index) => result.push(...collectValueReferences(entry, definition.item!, `${path}[${index}]`)));
  }
  return result;
}

function resolvePropertyValue(
  properties: Readonly<Record<string, JsonValue>>,
  definition: FieldDefinition,
): JsonValue {
  const direct = properties[definition.id];
  if (direct !== undefined) {
    return direct;
  }
  for (const alias of definition.aliases) {
    const aliasValue = properties[alias];
    if (aliasValue !== undefined) {
      return aliasValue;
    }
  }
  return cloneJsonValue(definition.defaultValue);
}

function validateFieldIdentityNamespace(
  definitions: readonly FieldDefinition[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const identities = new Map<string, string>();
  definitions.forEach((definition, index) => {
    [definition.id, ...definition.aliases].forEach((identity) => {
      const existing = identities.get(identity);
      if (existing !== undefined) {
        diagnostics.push(error(
          "field.duplicateIdentity",
          `${path}[${index}]`,
          `Field identity '${identity}' is already used by '${existing}'.`,
        ));
      } else {
        identities.set(identity, definition.id);
      }
    });
  });
}

function matchesValueType(value: JsonValue, valueType: FieldValueType): boolean {
  switch (valueType) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "json": return true;
  }
}

function isColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value);
}

function readIdentifier(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("field.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

function readIdentifiers(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("field.invalidAliases", path, "Expected an identifier array."));
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
      diagnostics.push(error("field.duplicateAlias", `${path}[${index}]`, `Duplicate alias '${identity}'.`));
      return;
    }
    seen.add(identity);
    result.push(identity);
  });
  return result;
}

function readEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): T | undefined {
  if (typeof value !== "string" || !values.includes(value as T)) {
    diagnostics.push(error("field.invalidEnum", path, `Expected one of: ${values.join(", ")}.`));
    return undefined;
  }
  return value as T;
}

function readNonEmptyString(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(error("field.invalidString", path, "Expected a non-empty string."));
    return undefined;
  }
  return value;
}

function readBoolean(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): boolean | undefined {
  if (typeof value !== "boolean") {
    diagnostics.push(error("field.invalidBoolean", path, "Expected a boolean."));
    return undefined;
  }
  return value;
}

function readFiniteNumber(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    diagnostics.push(error("field.invalidNumber", path, "Expected a finite number."));
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
      diagnostics.push(error("field.unknownDefinitionKey", `${path}.${key}`, `Unknown field definition key '${key}'.`));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

function warning(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "warning", code, path, message };
}
