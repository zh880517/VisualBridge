import * as vscode from "vscode";
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  buildTableCatalogRegistry,
  createEmptyTableCatalogRegistry,
  parseTableCatalog,
  type TableCatalog,
  type TableCatalogRegistry,
} from "@visualbridge/table";
import type { ProjectContext } from "../project/projectRegistry";

export interface TableCatalogLoadResult {
  readonly registry: TableCatalogRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly ready: boolean;
}

export async function loadTableCatalogRegistry(
  project: ProjectContext,
  catalogPaths: readonly string[],
): Promise<TableCatalogLoadResult> {
  if (catalogPaths.length === 0) {
    return {
      registry: createEmptyTableCatalogRegistry(),
      diagnostics: [{
        severity: "warning",
        code: "table.catalogsNotConfigured",
        path: "catalogs",
        message: "The Table document type does not declare any Catalogs.",
      }],
      ready: false,
    };
  }

  const diagnostics: DocumentDiagnostic[] = [];
  const catalogs: TableCatalog[] = [];
  const sourceIndexes: number[] = [];
  for (const [catalogIndex, catalogPath] of catalogPaths.entries()) {
    const catalogUri = vscode.Uri.joinPath(project.rootUri, ...catalogPath.split("/"));
    try {
      const openDocument = vscode.workspace.textDocuments.find((candidate) => sameUri(candidate.uri, catalogUri));
      const text = openDocument?.getText() ?? new TextDecoder("utf-8", { fatal: true }).decode(
        await vscode.workspace.fs.readFile(catalogUri),
      );
      const result = parseTableCatalog(text);
      diagnostics.push(...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: prefixCatalogPath(catalogIndex, diagnostic.path),
      })));
      if (result.success) {
        catalogs.push(result.document);
        sourceIndexes.push(catalogIndex);
      }
    } catch (errorValue) {
      diagnostics.push({
        severity: "error",
        code: "table.catalogUnavailable",
        path: `catalogs[${catalogIndex}]`,
        message: `Unable to load '${catalogPath}': ${formatError(errorValue)}`,
      });
    }
  }

  const registryResult = buildTableCatalogRegistry(catalogs);
  diagnostics.push(...registryResult.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: remapRegistryPath(diagnostic.path, sourceIndexes),
  })));
  const ready = registryResult.success
    && !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  return {
    registry: ready ? registryResult.document : createEmptyTableCatalogRegistry(),
    diagnostics,
    ready,
  };
}

function prefixCatalogPath(catalogIndex: number, path: string): string {
  return path === "$" ? `catalogs[${catalogIndex}].$` : `catalogs[${catalogIndex}].${path}`;
}

function remapRegistryPath(path: string, sourceIndexes: readonly number[]): string {
  return path.replace(/^catalogs\[(\d+)\]/, (match, indexText: string) => {
    const sourceIndex = sourceIndexes[Number(indexText)];
    return sourceIndex === undefined ? match : `catalogs[${sourceIndex}]`;
  });
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
