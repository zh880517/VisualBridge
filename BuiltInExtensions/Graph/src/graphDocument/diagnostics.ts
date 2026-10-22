// Diagnostic construction and counting helpers.
import type { DocumentDiagnostic, DocumentParseResult } from "@visualbridge/core";


export function diagnosticCounts(diagnostics: readonly DocumentDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  diagnostics.filter((diagnostic) => diagnostic.severity === "error").forEach((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

export function diagnosticKey(diagnostic: DocumentDiagnostic): string {
  return `${diagnostic.code}|${diagnostic.path}`;
}

export function error(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path, message };
}

export function warning(code: string, path: string, message: string): DocumentDiagnostic {
  return { severity: "warning", code, path, message };
}

export function failure(code: string, path: string, message: string): DocumentParseResult<never> {
  return { success: false, diagnostics: [error(code, path, message)] };
}

export function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : "Unknown JSON parse error.";
}
