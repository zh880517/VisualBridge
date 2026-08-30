import {
  cloneJsonValue,
  canonicalJsonStringify,
  isJsonValue,
  type FieldValueDefinition,
  type JsonValue,
} from "@visualbridge/core";

export type FieldEditorControl =
  | "select"
  | "reference"
  | "json"
  | "object"
  | "array"
  | "boolean"
  | "number"
  | "color"
  | "string";

export function resolveFieldEditorValue(
  value: JsonValue | undefined,
  defaultValue: JsonValue,
): JsonValue {
  return value === undefined ? cloneJsonValue(defaultValue) : value;
}

export function resolveFieldEditorControl(
  definition: FieldValueDefinition,
  value: JsonValue,
): FieldEditorControl {
  if (definition.editor?.kind === "select") return "select";
  if (
    definition.editor?.kind === "reference"
    && definition.reference !== undefined
    && (typeof value === "string" || typeof value === "number")
  ) return "reference";
  if (definition.editor?.kind === "json") return "json";
  if (definition.valueType === "object") return "object";
  if (definition.valueType === "array") return "array";
  if (definition.valueType === "boolean" || definition.editor?.kind === "checkbox") return "boolean";
  if (definition.valueType === "number") return "number";
  if (definition.editor?.kind === "color") return "color";
  if (definition.valueType === "json") return "json";
  return "string";
}

export function parseNumberDraft(draft: string, currentValue: number): number | undefined {
  if (draft.trim().length === 0) return undefined;
  const value = Number(draft);
  return Number.isFinite(value) && value !== currentValue ? value : undefined;
}

export function acceptReferenceSelection(
  currentValue: string | number,
  candidate: string | number | undefined,
): string | number | undefined {
  return candidate !== undefined
    && typeof candidate === typeof currentValue
    && candidate !== currentValue
    ? candidate
    : undefined;
}

export function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

export type JsonDraftResult =
  | { readonly success: true; readonly value: JsonValue }
  | { readonly success: false };

export function parseJsonDraft(draft: string): JsonDraftResult {
  try {
    const value: unknown = JSON.parse(draft);
    return isJsonValue(value) ? { success: true, value } : { success: false };
  } catch {
    return { success: false };
  }
}
