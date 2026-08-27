export type DiagnosticSeverity = "error" | "warning";

export interface DocumentDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type DocumentParseResult<TDocument> =
  | { readonly success: true; readonly document: TDocument; readonly diagnostics: readonly DocumentDiagnostic[] }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] };

export type DocumentOperationResult<TDocument> =
  | { readonly success: true; readonly document: TDocument; readonly diagnostics: readonly DocumentDiagnostic[] }
  | { readonly success: false; readonly diagnostics: readonly DocumentDiagnostic[] };
