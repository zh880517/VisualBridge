import type { DocumentDiagnostic } from "@visualbridge/module-sdk";
import { error } from "./diagnostics";

export function validateUniqueIds(
  values: readonly { readonly id: string }[],
  basePath: string,
  code: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) {
      diagnostics.push(error(code, `${basePath}[${index}].id`, `Duplicate id '${value.id}'.`));
    }
    ids.add(value.id);
  });
}

export function validateUniqueStrings(
  values: readonly string[],
  basePath: string,
  code: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      diagnostics.push(error(code, `${basePath}[${index}]`, `Duplicate id '${value}'.`));
    }
    seen.add(value);
  });
}

export function validateAliases(
  values: readonly { readonly id: string; readonly aliases: readonly string[] }[],
  basePath: string,
  code: string,
  diagnostics: DocumentDiagnostic[],
): void {
  const canonicalIds = new Set(values.map((value) => value.id));
  const aliases = new Set<string>();
  values.forEach((value, valueIndex) => {
    value.aliases.forEach((alias, aliasIndex) => {
      if (canonicalIds.has(alias) || aliases.has(alias)) {
        diagnostics.push(error(
          code,
          `${basePath}[${valueIndex}].aliases[${aliasIndex}]`,
          `Alias '${alias}' is already used in this identity namespace.`,
        ));
      }
      aliases.add(alias);
    });
  });
}
