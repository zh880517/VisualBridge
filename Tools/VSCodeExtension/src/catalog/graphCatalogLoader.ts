import * as vscode from "vscode";
import type { DocumentDiagnostic } from "@visualbridge/core";
import {
  buildGraphCatalogRegistry,
  createEmptyGraphCatalogRegistry,
  parseGraphCatalog,
  type GraphCatalog,
  type GraphCatalogRegistry,
} from "@visualbridge/graph";
import type { ProjectContext } from "../project/projectRegistry";

export interface GraphCatalogLoadResult {
  readonly registry: GraphCatalogRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly ready: boolean;
}

export async function loadGraphCatalogRegistry(
  project: ProjectContext,
  catalogPaths: readonly string[],
): Promise<GraphCatalogLoadResult> {
  if (catalogPaths.length === 0) {
    return {
      registry: createEmptyGraphCatalogRegistry(),
      diagnostics: [{
        severity: "warning",
        code: "graph.catalogsNotConfigured",
        path: "catalogs",
        message: "The Graph document type does not declare any Catalogs.",
      }],
      ready: false,
    };
  }

  const diagnostics: DocumentDiagnostic[] = [];
  const loadedCatalogs: GraphCatalog[] = [];
  const sourceIndexes: number[] = [];
  for (const [catalogIndex, catalogPath] of catalogPaths.entries()) {
    const catalogUri = vscode.Uri.joinPath(project.rootUri, ...catalogPath.split("/"));
    try {
      const openDocument = vscode.workspace.textDocuments.find((candidate) => sameUri(candidate.uri, catalogUri));
      const text = openDocument?.getText() ?? new TextDecoder("utf-8", { fatal: true }).decode(
        await vscode.workspace.fs.readFile(catalogUri),
      );
      const result = parseGraphCatalog(text);
      diagnostics.push(...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: prefixCatalogPath(catalogIndex, diagnostic.path),
      })));
      if (result.success) {
        loadedCatalogs.push(result.document);
        sourceIndexes.push(catalogIndex);
      }
    } catch (errorValue) {
      diagnostics.push({
        severity: "error",
        code: "graph.catalogUnavailable",
        path: `catalogs[${catalogIndex}]`,
        message: `Unable to load '${catalogPath}': ${formatError(errorValue)}`,
      });
    }
  }

  const registryResult = buildGraphCatalogRegistry(loadedCatalogs);
  diagnostics.push(...registryResult.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: remapRegistryPath(diagnostic.path, sourceIndexes),
  })));
  const ready = registryResult.success
    && !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  return {
    registry: ready ? registryResult.document : createEmptyGraphCatalogRegistry(),
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
