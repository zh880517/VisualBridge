import type { DocumentDiagnostic } from "@visualbridge/module-sdk";
import { error } from "./diagnostics";

export function readIdentifierArray(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidIdentifierArray", path, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const id = readIdentifier(entry, `${path}[${index}]`, diagnostics);
    return id === undefined ? [] : [id];
  });
}

export function readStringArray(
  value: unknown,
  path: string,
  diagnostics: DocumentDiagnostic[],
): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("graphCatalog.invalidStringArray", path, "Expected an array."));
    return [];
  }
  return value.flatMap((entry, index) => {
    const item = readNonEmptyString(entry, `${path}[${index}]`, diagnostics);
    return item === undefined ? [] : [item];
  });
}

export function readIdentifier(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push(error("graphCatalog.invalidIdentifier", path, "Expected a stable identifier."));
    return undefined;
  }
  return value;
}

export function readString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string") {
    diagnostics.push(error("graphCatalog.invalidString", path, "Expected a string."));
    return undefined;
  }
  return value;
}

export function readNonEmptyString(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  const result = readString(value, path, diagnostics);
  if (result !== undefined && result.trim().length === 0) {
    diagnostics.push(error("graphCatalog.emptyString", path, "Expected a non-empty string."));
    return undefined;
  }
  return result;
}

export function readColor(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): string | undefined {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    diagnostics.push(error("graphCatalog.invalidColor", path, "Expected a color in #RRGGBB format."));
    return undefined;
  }
  return value.toUpperCase();
}

export function readBoolean(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): boolean | undefined {
  if (typeof value !== "boolean") {
    diagnostics.push(error("graphCatalog.invalidBoolean", path, "Expected a boolean."));
    return undefined;
  }
  return value;
}

export function readPositiveInteger(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    diagnostics.push(error("graphCatalog.invalidPositiveInteger", path, "Expected a positive integer."));
    return undefined;
  }
  return value;
}

export function readNonNegativeInteger(value: unknown, path: string, diagnostics: DocumentDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    diagnostics.push(error("graphCatalog.invalidNonNegativeInteger", path, "Expected a non-negative integer."));
    return undefined;
  }
  return value;
}

export function readEnum<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  path: string,
  diagnostics: DocumentDiagnostic[],
): TValue | undefined {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    diagnostics.push(error("graphCatalog.invalidEnum", path, `Expected one of: ${allowed.join(", ")}.`));
    return undefined;
  }
  return value as TValue;
}
