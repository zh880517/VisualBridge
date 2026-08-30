import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type {
  CatalogAdapter,
  CatalogSourceDefinition,
  DocumentDiagnostic,
} from "@visualbridge/core";
import type { ProjectContext } from "../project/projectRegistry";

export interface CatalogSourceInspection<TCatalog> {
  readonly path: string;
  readonly uri: vscode.Uri;
  readonly contentHash?: string;
  readonly source?: CatalogSourceDefinition;
  readonly catalog?: TCatalog;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export interface CatalogRegistryLoadResult<TCatalog, TRegistry> {
  readonly registry: TRegistry;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly sources: readonly CatalogSourceInspection<TCatalog>[];
  readonly ready: boolean;
}

export interface CatalogWithSource {
  readonly catalogId: string;
  readonly title: string;
  readonly source: CatalogSourceDefinition;
}

export async function loadCatalogRegistry<TCatalog extends CatalogWithSource, TRegistry>(
  project: ProjectContext,
  catalogPaths: readonly string[],
  adapter: CatalogAdapter<TCatalog, TRegistry>,
  createEmptyRegistry: () => TRegistry,
): Promise<CatalogRegistryLoadResult<TCatalog, TRegistry>> {
  if (catalogPaths.length === 0) {
    return {
      registry: createEmptyRegistry(),
      diagnostics: [{
        severity: "warning",
        code: `${adapter.editor}.catalogsNotConfigured`,
        path: "catalogs",
        message: `The ${titleCase(adapter.editor)} Document Type does not declare any Catalogs.`,
      }],
      sources: [],
      ready: false,
    };
  }

  const diagnostics: DocumentDiagnostic[] = [];
  const catalogs: TCatalog[] = [];
  const sourceIndexes: number[] = [];
  const sources: CatalogSourceInspection<TCatalog>[] = [];
  for (const [catalogIndex, catalogPath] of catalogPaths.entries()) {
    const catalogUri = vscode.Uri.joinPath(project.rootUri, ...catalogPath.split("/"));
    try {
      const openDocument = vscode.workspace.textDocuments.find((candidate) => sameUri(candidate.uri, catalogUri));
      const diskBytes = openDocument === undefined
        ? await vscode.workspace.fs.readFile(catalogUri)
        : undefined;
      const text = openDocument?.getText()
        ?? new TextDecoder("utf-8", { fatal: true }).decode(diskBytes);
      const parsed = adapter.parse(text);
      const sourceDiagnostics = [...parsed.diagnostics];
      if (parsed.success && parsed.document.source.status === "stale") {
        sourceDiagnostics.push({
          severity: "warning",
          code: "catalog.sourceStale",
          path: "source",
          message: `Catalog '${parsed.document.catalogId}' was generated from ${shortHash(parsed.document.source.sourceHash)}, but the current source is ${shortHash(parsed.document.source.currentSourceHash)}.`,
        });
      }
      diagnostics.push(...sourceDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: prefixCatalogPath(catalogIndex, diagnostic.path),
      })));
      if (parsed.success) {
        catalogs.push(parsed.document);
        sourceIndexes.push(catalogIndex);
      }
      sources.push({
        path: catalogPath,
        uri: catalogUri,
        contentHash: diskBytes === undefined ? hashText(text) : hashBytes(diskBytes),
        ...(parsed.success ? { source: parsed.document.source, catalog: parsed.document } : {}),
        diagnostics: sourceDiagnostics,
      });
    } catch (errorValue) {
      const diagnostic: DocumentDiagnostic = {
        severity: "error",
        code: `${adapter.editor}.catalogUnavailable`,
        path: "$",
        message: `Unable to load '${catalogPath}': ${formatError(errorValue)}`,
      };
      diagnostics.push({ ...diagnostic, path: `catalogs[${catalogIndex}]` });
      sources.push({ path: catalogPath, uri: catalogUri, diagnostics: [diagnostic] });
    }
  }

  const registryResult = adapter.build(catalogs);
  diagnostics.push(...registryResult.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: remapRegistryPath(diagnostic.path, sourceIndexes),
  })));
  const ready = registryResult.success
    && !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  return {
    registry: ready ? registryResult.document : createEmptyRegistry(),
    diagnostics,
    sources,
    ready,
  };
}

export function catalogDiagnosticSourceIndex(path: string): number | undefined {
  const match = /^catalogs\[(\d+)\]/.exec(path);
  return match === null ? undefined : Number(match[1]);
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

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
