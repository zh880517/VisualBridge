import type { FieldDefinition, FieldValueDefinition, JsonValue } from "@visualbridge/core";
import { cloneJsonValue } from "@visualbridge/core";
import type { TableCellEncodingDefinition, TableColumnDefinition } from "./tableCatalog";

export function decodeTableCell(raw: string, column: TableColumnDefinition): JsonValue {
  if (raw.length === 0) {
    return cloneJsonValue(column.defaultValue);
  }
  return decodeValue(raw, column, column.cellEncoding);
}

export function encodeTableCell(value: JsonValue, column: TableColumnDefinition): string {
  return encodeValue(value, column, column.cellEncoding);
}

function decodeValue(
  raw: string,
  definition: FieldValueDefinition,
  encoding: TableCellEncodingDefinition,
): JsonValue {
  if (encoding.kind === "json") {
    return JSON.parse(raw) as JsonValue;
  }
  if (encoding.kind === "scalar") {
    switch (definition.valueType) {
      case "string": return raw;
      case "number": {
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw new Error(`Expected a finite number, received '${raw}'.`);
        }
        return value;
      }
      case "boolean": {
        const normalized = raw.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") {
          return true;
        }
        if (normalized === "false" || normalized === "0") {
          return false;
        }
        throw new Error(`Expected true, false, 1 or 0, received '${raw}'.`);
      }
      default: throw new Error(`Scalar encoding cannot decode ${definition.valueType}.`);
    }
  }
  if (definition.valueType === "array" && definition.item !== undefined) {
    if (raw.length === 0) {
      return [];
    }
    const itemEncoding = encoding.item ?? { kind: "scalar" as const };
    return raw.split(encoding.separator).map((part) => decodeValue(part, definition.item!, itemEncoding));
  }
  if (definition.valueType === "object") {
    const parts = raw.split(encoding.separator);
    return Object.fromEntries(definition.fields.map((field, index) => [
      field.id,
      decodeValue(parts[index] ?? "", field, encodingForObjectField(field)),
    ]));
  }
  throw new Error(`Delimited encoding cannot decode ${definition.valueType}.`);
}

function encodeValue(
  value: JsonValue,
  definition: FieldValueDefinition,
  encoding: TableCellEncodingDefinition,
): string {
  if (encoding.kind === "json") {
    return JSON.stringify(value);
  }
  if (encoding.kind === "scalar") {
    if (definition.valueType === "boolean") {
      return value === true ? "1" : "0";
    }
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    throw new Error(`Scalar encoding cannot encode ${definition.valueType}.`);
  }
  if (definition.valueType === "array" && Array.isArray(value) && definition.item !== undefined) {
    const itemEncoding = encoding.item ?? { kind: "scalar" as const };
    return value.map((entry) => encodeValue(entry, definition.item!, itemEncoding)).join(encoding.separator);
  }
  if (definition.valueType === "object" && isRecord(value)) {
    return definition.fields.map((field) => encodeValue(
      value[field.id] ?? cloneJsonValue(field.defaultValue),
      field,
      encodingForObjectField(field),
    )).join(encoding.separator);
  }
  throw new Error(`Delimited encoding cannot encode ${definition.valueType}.`);
}

function encodingForObjectField(field: FieldDefinition): TableCellEncodingDefinition {
  if (["string", "number", "boolean"].includes(field.valueType)) {
    return { kind: "scalar" };
  }
  return { kind: "json" };
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
