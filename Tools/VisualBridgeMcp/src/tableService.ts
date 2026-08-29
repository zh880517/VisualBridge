import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DocumentDiagnostic, TableLayoutDefinition } from "@visualbridge/core";
import {
  applyTableOperations,
  buildTableCatalogRegistry,
  createEmptyTableCatalogRegistry,
  formatTableRowDisplayName,
  matchTableSheetDefinitions,
  parseCsvTable,
  parseTableCatalog,
  parseXlsxTable,
  resolveEffectiveTableRows,
  resolveTableSheet,
  resolveTableType,
  serializeCsvTable,
  serializeXlsxTable,
  validateTableDocument,
  type RegisteredTableTypeDefinition,
  type TableCatalog,
  type TableCatalogRegistry,
  type TableDocument,
  type TableRow,
  type TableSheet,
} from "@visualbridge/table";
import {
  VisualBridgeMcpError,
  VisualBridgeWorkspace,
  resolveExistingProjectPath,
  type ProjectContext,
  type TableDocumentContext,
} from "./projectWorkspace.js";

interface TableCatalogContext {
  readonly project: ProjectContext;
  readonly documentTypeId: string;
  readonly catalogPaths: readonly string[];
  readonly registry: TableCatalogRegistry;
  readonly tableType: RegisteredTableTypeDefinition;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface TableSource {
  readonly path: string;
  readonly absolutePath: string;
  readonly physicalName: string;
  readonly sheetIds: readonly string[];
  readonly bytes: Buffer;
  readonly hash: string;
}

interface LoadedTable {
  readonly context: TableDocumentContext;
  readonly catalog: TableCatalogContext;
  readonly layout: TableLayoutDefinition;
  readonly sources: readonly TableSource[];
  readonly baseHash: string;
  readonly document: TableDocument;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface RenderedSource {
  readonly source: TableSource;
  readonly bytes: Buffer;
  readonly hash: string;
}

export class TableService {
  public constructor(private readonly workspace: VisualBridgeWorkspace) {}

  public async queryCatalog(
    projectFile: string | undefined,
    documentTypeId: string | undefined,
    view: "summary" | "tableTypes",
  ): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveTableDocumentType(projectFile, documentTypeId);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.id, resolved.documentType.catalogs);
    const base = {
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      catalogPaths: catalog.catalogPaths,
      catalogs: catalog.registry.catalogs,
      diagnostics: catalog.diagnostics,
    };
    return view === "tableTypes"
      ? { ...base, tableTypes: catalog.registry.tableTypes }
      : { ...base, counts: { tableTypes: catalog.registry.tableTypes.length } };
  }

  public async readTable(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly tablePath: string;
    readonly sheetId?: string;
    readonly offset: number;
    readonly limit: number;
  }): Promise<Record<string, unknown>> {
    const loaded = await this.loadTableForUse(options.tablePath, options.projectFile, options.documentTypeId);
    const sheet = options.sheetId === undefined
      ? undefined
      : this.requirePhysicalSheet(loaded, options.sheetId);
    const rows = sheet === undefined
      ? undefined
      : sheet.rows.slice(options.offset, options.offset + options.limit).map(semanticRow);
    return {
      ...tableIdentity(loaded),
      tableType: {
        id: loaded.catalog.tableType.id,
        title: loaded.catalog.tableType.title,
        catalogId: loaded.catalog.tableType.catalogId,
      },
      sheets: loaded.document.sheets.map((candidate) => ({
        id: candidate.id,
        definitionId: candidate.definitionId,
        title: candidate.title,
        name: candidate.name,
        rowCount: candidate.rows.length,
      })),
      ...(sheet === undefined ? {} : {
        page: {
          sheetId: sheet.id,
          offset: options.offset,
          limit: options.limit,
          total: sheet.rows.length,
          rows,
        },
      }),
      diagnostics: loaded.diagnostics,
    };
  }

  public async searchRows(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly tablePath: string;
    readonly query: string;
    readonly sheetDefinitionId?: string;
    readonly effectiveOnly: boolean;
    readonly limit: number;
  }): Promise<Record<string, unknown>> {
    const loaded = await this.loadTableForUse(options.tablePath, options.projectFile, options.documentTypeId);
    const definitions = options.sheetDefinitionId === undefined
      ? loaded.catalog.tableType.sheets
      : [this.requireSheetDefinition(loaded, options.sheetDefinitionId)];
    const terms = options.query.toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 0);
    const results: Record<string, unknown>[] = [];
    let matchedCount = 0;
    for (const definition of definitions) {
      const entries = options.effectiveOnly
        ? resolveEffectiveTableRows(loaded.document, loaded.catalog.tableType, definition.id).rows
        : loaded.document.sheets
            .filter((sheet) => sheet.definitionId === definition.id)
            .flatMap((sheet) => sheet.rows.map((row) => ({ sheetId: sheet.id, sheetName: sheet.name, row })));
      for (const entry of entries) {
        const displayName = formatTableRowDisplayName(entry.row.cells, definition);
        const searchText = `${displayName}\n${stableJson(entry.row.cells)}`.toLocaleLowerCase();
        if (!terms.every((term) => searchText.includes(term))) {
          continue;
        }
        matchedCount += 1;
        if (results.length < options.limit) {
          results.push({
            sheetDefinitionId: definition.id,
            sheetId: entry.sheetId,
            sheetName: entry.sheetName,
            rowId: entry.row.id,
            displayName,
            cells: entry.row.cells,
          });
        }
      }
    }
    return {
      ...tableIdentity(loaded),
      query: options.query,
      sheetDefinitionId: options.sheetDefinitionId,
      effectiveOnly: options.effectiveOnly,
      matchedCount,
      truncated: matchedCount > results.length,
      results,
      diagnostics: loaded.diagnostics,
    };
  }

  public async validateTable(
    tablePath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const loaded = await this.loadTable(tablePath, projectFile, documentTypeId);
      return {
        ...tableIdentity(loaded),
        valid: !loaded.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
        diagnostics: loaded.diagnostics,
      };
    } catch (errorValue) {
      if (!(errorValue instanceof TableLoadError)) {
        throw errorValue;
      }
      return {
        projectFile: errorValue.context.project.projectFile,
        documentTypeId: errorValue.context.documentType.id,
        path: errorValue.context.tablePath,
        baseHash: errorValue.baseHash,
        sources: errorValue.sources.map(sourceIdentity),
        valid: false,
        diagnostics: errorValue.diagnostics,
      };
    }
  }

  public async applyOperations(options: {
    readonly projectFile?: string;
    readonly documentTypeId?: string;
    readonly tablePath: string;
    readonly baseHash: string;
    readonly operations: unknown;
  }): Promise<Record<string, unknown>> {
    const preliminary = await this.loadTableForUse(options.tablePath, options.projectFile, options.documentTypeId);
    const lockPath = tableLockPath(preliminary);
    let lockHandle;
    try {
      lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
      await lockHandle.sync();
    } catch (errorValue) {
      if (isNodeError(errorValue, "EEXIST")) {
        return conflictResult(preliminary, options.baseHash, "writeInProgress");
      }
      if (lockHandle !== undefined) {
        await lockHandle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
      throw errorValue;
    }

    const temporaryPaths = new Set<string>();
    try {
      const loaded = await this.loadTableForUse(options.tablePath, options.projectFile, options.documentTypeId);
      if (loaded.baseHash !== options.baseHash) {
        return conflictResult(loaded, options.baseHash, "baseHashMismatch");
      }
      const operationResult = applyTableOperations(
        loaded.document,
        options.operations,
        loaded.catalog.tableType,
      );
      if (!operationResult.success
        || operationResult.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return invalidResult(loaded, operationResult.diagnostics);
      }

      const rendered = await this.renderSources(loaded, operationResult.document);
      const changed = rendered.filter((entry) => !entry.bytes.equals(entry.source.bytes));
      if (changed.length === 0) {
        return {
          status: "unchanged",
          ...tableIdentity(loaded),
          hash: loaded.baseHash,
          diagnostics: operationResult.diagnostics,
        };
      }

      const staged = new Map<string, string>();
      for (const entry of changed) {
        const temporaryPath = await stageBytes(entry.source.absolutePath, entry.bytes);
        temporaryPaths.add(temporaryPath);
        staged.set(entry.source.absolutePath, temporaryPath);
      }

      const beforeReplace = await this.loadTableForUse(options.tablePath, options.projectFile, options.documentTypeId);
      if (beforeReplace.baseHash !== loaded.baseHash) {
        return conflictResult(beforeReplace, options.baseHash, "changedBeforeReplace");
      }

      const replaced: TableSource[] = [];
      try {
        for (const entry of changed) {
          const temporaryPath = staged.get(entry.source.absolutePath)!;
          await rename(temporaryPath, entry.source.absolutePath);
          temporaryPaths.delete(temporaryPath);
          replaced.push(entry.source);
        }
      } catch (errorValue) {
        const rollbackFailures: string[] = [];
        for (const source of replaced.reverse()) {
          try {
            const rollbackPath = await stageBytes(source.absolutePath, source.bytes);
            temporaryPaths.add(rollbackPath);
            await rename(rollbackPath, source.absolutePath);
            temporaryPaths.delete(rollbackPath);
          } catch (rollbackError) {
            rollbackFailures.push(`${source.path}: ${formatError(rollbackError)}`);
          }
        }
        throw new VisualBridgeMcpError(
          rollbackFailures.length === 0 ? "table.atomicWriteFailed" : "table.atomicRollbackFailed",
          rollbackFailures.length === 0
            ? `Table '${loaded.context.tablePath}' could not be atomically replaced; prior sources were restored.`
            : `Table '${loaded.context.tablePath}' failed during replacement and rollback.`,
          { writeError: formatError(errorValue), rollbackFailures },
        );
      }

      const persisted = await this.loadTableForUse(options.tablePath, options.projectFile, options.documentTypeId);
      const expectedHashes = new Map(rendered.map((entry) => [entry.source.path, entry.hash]));
      const persistedHashes = new Map(persisted.sources.map((source) => [source.path, source.hash]));
      const mismatchedPaths = [...new Set([
        ...[...expectedHashes].flatMap(([sourcePath, sourceHash]) =>
          persistedHashes.get(sourcePath) === sourceHash ? [] : [sourcePath]),
        ...[...persistedHashes].flatMap(([sourcePath, sourceHash]) =>
          expectedHashes.get(sourcePath) === sourceHash ? [] : [sourcePath]),
      ])];
      if (mismatchedPaths.length > 0) {
        throw new VisualBridgeMcpError(
          "table.atomicWriteVerificationFailed",
          `Table '${loaded.context.tablePath}' did not match the serialized transaction after replacement.`,
          mismatchedPaths,
        );
      }
      return {
        status: "applied",
        ...tableIdentity(persisted),
        previousHash: loaded.baseHash,
        hash: persisted.baseHash,
        diagnostics: operationResult.diagnostics,
      };
    } finally {
      await Promise.all([...temporaryPaths].map((temporaryPath) => unlink(temporaryPath).catch(() => undefined)));
      if (lockHandle !== undefined) {
        await lockHandle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    }
  }

  private async loadTable(
    tablePath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<LoadedTable> {
    const context = await this.workspace.resolveTableDocument(tablePath, projectFile, documentTypeId);
    const layout = context.project.definition.tableLayout;
    if (layout === undefined) {
      throw new VisualBridgeMcpError(
        "table.layoutNotConfigured",
        "VisualBridge Project must configure tableLayout.nameKeyRow and tableLayout.dataStartRow.",
      );
    }
    const catalog = await this.loadCatalog(
      context.project,
      context.documentType.id,
      context.documentType.catalogs,
    );
    const activeBytes = await readFile(context.absoluteTablePath);
    return isXlsx(activeBytes)
      ? this.loadXlsx(context, layout, catalog, activeBytes)
      : this.loadCsvFamily(context, layout, catalog);
  }

  private async loadTableForUse(
    tablePath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<LoadedTable> {
    try {
      return await this.loadTable(tablePath, projectFile, documentTypeId);
    } catch (errorValue) {
      if (!(errorValue instanceof TableLoadError)) {
        throw errorValue;
      }
      throw new VisualBridgeMcpError(
        "table.parseFailed",
        `Table '${errorValue.context.tablePath}' is structurally invalid.`,
        errorValue.diagnostics,
      );
    }
  }

  private async loadXlsx(
    context: TableDocumentContext,
    layout: TableLayoutDefinition,
    catalog: TableCatalogContext,
    bytes: Buffer,
  ): Promise<LoadedTable> {
    const source: TableSource = {
      path: context.tablePath,
      absolutePath: context.absoluteTablePath,
      physicalName: path.basename(context.tablePath),
      sheetIds: [],
      bytes,
      hash: hashBytes(bytes),
    };
    const parsed = await parseXlsxTable(bytes, catalog.tableType, layout);
    if (!parsed.success) {
      throw new TableLoadError(context, source.hash, [source], [...catalog.diagnostics, ...parsed.diagnostics]);
    }
    const loadedSource = { ...source, sheetIds: parsed.document.sheets.map((sheet) => sheet.id) };
    const diagnostics = [
      ...catalog.diagnostics,
      ...parsed.diagnostics,
      ...validateTableDocument(parsed.document, catalog.tableType),
    ];
    return {
      context,
      catalog,
      layout,
      sources: [loadedSource],
      baseHash: loadedSource.hash,
      document: parsed.document,
      diagnostics,
    };
  }

  private async loadCsvFamily(
    context: TableDocumentContext,
    layout: TableLayoutDefinition,
    catalog: TableCatalogContext,
  ): Promise<LoadedTable> {
    const sourcePaths = await this.findCsvFamilyPaths(context, catalog.tableType);
    const sources: TableSource[] = [];
    const sheets: TableSheet[] = [];
    const diagnostics: DocumentDiagnostic[] = [...catalog.diagnostics];
    for (const sourcePath of sourcePaths) {
      const absolutePath = await resolveExistingProjectPath(context.project, sourcePath);
      const bytes = await readFile(absolutePath);
      const physicalName = path.basename(sourcePath, path.extname(sourcePath));
      const baseSource: TableSource = {
        path: sourcePath,
        absolutePath,
        physicalName,
        sheetIds: [],
        bytes,
        hash: hashBytes(bytes),
      };
      let parsed;
      try {
        parsed = parseCsvTable(decodeUtf8(bytes, sourcePath), catalog.tableType, layout, physicalName);
      } catch (errorValue) {
        throw new TableLoadError(
          context,
          hashSourceManifest([...sources, baseSource]),
          [...sources, baseSource],
          [diagnostic("table.invalidUtf8", sourcePath, formatError(errorValue))],
        );
      }
      if (!parsed.success) {
        throw new TableLoadError(
          context,
          hashSourceManifest([...sources, baseSource]),
          [...sources, baseSource],
          parsed.diagnostics.map((item) => ({ ...item, path: `${physicalName}.${item.path}` })),
        );
      }
      sheets.push(...parsed.document.sheets);
      diagnostics.push(...parsed.diagnostics.map((item) => ({ ...item, path: `${physicalName}.${item.path}` })));
      sources.push({ ...baseSource, sheetIds: parsed.document.sheets.map((sheet) => sheet.id) });
    }
    const document: TableDocument = { format: "csv", sheets };
    diagnostics.push(...validateTableDocument(document, catalog.tableType));
    return {
      context,
      catalog,
      layout,
      sources,
      baseHash: hashSourceManifest(sources),
      document,
      diagnostics,
    };
  }

  private async findCsvFamilyPaths(
    context: TableDocumentContext,
    tableType: RegisteredTableTypeDefinition,
  ): Promise<readonly string[]> {
    if (!tableType.sheets.some((sheet) => sheet.partition !== undefined)) {
      return [context.tablePath];
    }
    const relativeDirectory = path.posix.dirname(context.tablePath);
    const absoluteDirectory = path.dirname(context.absoluteTablePath);
    const extension = path.extname(context.tablePath).toLocaleLowerCase();
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== extension) {
        continue;
      }
      const candidatePath = relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
      const physicalName = path.basename(entry.name, path.extname(entry.name));
      if (!matchTableSheetDefinitions(tableType, physicalName).some((sheet) => sheet.partition !== undefined)) {
        continue;
      }
      try {
        await this.workspace.resolveTableDocument(
          candidatePath,
          context.project.projectFile,
          context.documentType.id,
        );
        candidates.push(candidatePath);
      } catch (errorValue) {
        if (!(errorValue instanceof VisualBridgeMcpError)
          || !["table.notDeclared", "path.notFound"].includes(errorValue.code)) {
          throw errorValue;
        }
      }
    }
    if (!candidates.includes(context.tablePath)) {
      candidates.push(context.tablePath);
    }
    return candidates.sort((left, right) => left.localeCompare(right));
  }

  private async loadCatalog(
    project: ProjectContext,
    documentTypeId: string,
    catalogPaths: readonly string[],
  ): Promise<TableCatalogContext> {
    if (catalogPaths.length === 0) {
      throw new VisualBridgeMcpError(
        "table.catalogsNotConfigured",
        `Table Document Type '${documentTypeId}' does not declare any Catalogs.`,
      );
    }
    const diagnostics: DocumentDiagnostic[] = [];
    const catalogs: TableCatalog[] = [];
    const sourceIndexes: number[] = [];
    for (const [catalogIndex, catalogPath] of catalogPaths.entries()) {
      try {
        const absolutePath = await resolveExistingProjectPath(project, catalogPath);
        const result = parseTableCatalog(decodeUtf8(await readFile(absolutePath), catalogPath));
        diagnostics.push(...result.diagnostics.map((item) => ({
          ...item,
          path: prefixCatalogPath(catalogIndex, item.path),
        })));
        if (result.success) {
          catalogs.push(result.document);
          sourceIndexes.push(catalogIndex);
        }
      } catch (errorValue) {
        diagnostics.push(diagnostic(
          "table.catalogUnavailable",
          `catalogs[${catalogIndex}]`,
          `Unable to load '${catalogPath}': ${formatError(errorValue)}`,
        ));
      }
    }
    const registryResult = buildTableCatalogRegistry(catalogs);
    diagnostics.push(...registryResult.diagnostics.map((item) => ({
      ...item,
      path: remapRegistryPath(item.path, sourceIndexes),
    })));
    const registry = registryResult.success ? registryResult.document : createEmptyTableCatalogRegistry();
    const tableType = resolveTableType(registry, documentTypeId);
    if (diagnostics.some((item) => item.severity === "error") || tableType === undefined) {
      throw new VisualBridgeMcpError(
        "table.catalogUnavailable",
        tableType === undefined
          ? `Table Catalog does not declare '${documentTypeId}' or an alias.`
          : `Table Catalogs for '${documentTypeId}' are invalid.`,
        diagnostics,
      );
    }
    return { project, documentTypeId, catalogPaths, registry, tableType, diagnostics };
  }

  private async renderSources(loaded: LoadedTable, document: TableDocument): Promise<readonly RenderedSource[]> {
    const result: RenderedSource[] = [];
    for (const source of loaded.sources) {
      const bytes = loaded.document.format === "xlsx"
        ? Buffer.from(await serializeXlsxTable(source.bytes, document, loaded.catalog.tableType, loaded.layout))
        : Buffer.from(serializeCsvTable(
            { format: "csv", sheets: document.sheets.filter((sheet) => source.sheetIds.includes(sheet.id)) },
            loaded.catalog.tableType,
            decodeUtf8(source.bytes, source.path),
          ), "utf8");
      result.push({ source, bytes, hash: hashBytes(bytes) });
    }
    return result;
  }

  private requirePhysicalSheet(loaded: LoadedTable, sheetId: string): TableSheet {
    const sheet = loaded.document.sheets.find((candidate) => candidate.id === sheetId);
    if (sheet === undefined) {
      throw new VisualBridgeMcpError("table.sheetNotFound", `Unknown physical sheet '${sheetId}'.`);
    }
    return sheet;
  }

  private requireSheetDefinition(loaded: LoadedTable, sheetDefinitionId: string) {
    const definition = resolveTableSheet(loaded.catalog.tableType, sheetDefinitionId);
    if (definition === undefined) {
      throw new VisualBridgeMcpError(
        "table.sheetDefinitionNotFound",
        `Unknown Sheet definition '${sheetDefinitionId}'.`,
      );
    }
    return definition;
  }
}

class TableLoadError extends Error {
  public constructor(
    public readonly context: TableDocumentContext,
    public readonly baseHash: string,
    public readonly sources: readonly TableSource[],
    public readonly diagnostics: readonly DocumentDiagnostic[],
  ) {
    super(`Table '${context.tablePath}' is structurally invalid.`);
    this.name = "TableLoadError";
  }
}

function tableIdentity(loaded: LoadedTable) {
  return {
    projectFile: loaded.context.project.projectFile,
    documentTypeId: loaded.context.documentType.id,
    path: loaded.context.tablePath,
    format: loaded.document.format,
    baseHash: loaded.baseHash,
    sources: loaded.sources.map(sourceIdentity),
  };
}

function sourceIdentity(source: TableSource) {
  return { path: source.path, baseHash: source.hash, sheetIds: source.sheetIds };
}

function semanticRow(row: TableRow) {
  return {
    id: row.id,
    cells: row.cells,
    ...(row.sourceRowNumber === undefined ? {} : { sourceRowNumber: row.sourceRowNumber }),
  };
}

function conflictResult(loaded: LoadedTable, requestedHash: string, reason: string) {
  return {
    status: "conflict",
    projectFile: loaded.context.project.projectFile,
    documentTypeId: loaded.context.documentType.id,
    path: loaded.context.tablePath,
    baseHash: requestedHash,
    hash: loaded.baseHash,
    sources: loaded.sources.map(sourceIdentity),
    reason,
  };
}

function invalidResult(loaded: LoadedTable, diagnostics: readonly DocumentDiagnostic[]) {
  return {
    status: "invalid",
    ...tableIdentity(loaded),
    hash: loaded.baseHash,
    diagnostics,
  };
}

function tableLockPath(loaded: LoadedTable): string {
  if (loaded.document.format === "xlsx") {
    return path.join(
      path.dirname(loaded.context.absoluteTablePath),
      `.${path.basename(loaded.context.absoluteTablePath)}.visualbridge.lock`,
    );
  }
  const lockId = createHash("sha256")
    .update(`${loaded.context.documentType.id}\0${loaded.catalog.tableType.id}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(path.dirname(loaded.context.absoluteTablePath), `.visualbridge-table-${lockId}.lock`);
}

async function stageBytes(targetPath: string, bytes: Buffer): Promise<string> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.visualbridge-${randomUUID()}.tmp`,
  );
  try {
    const targetStat = await stat(targetPath);
    const handle = await open(temporaryPath, "wx", targetStat.mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporaryPath;
  } catch (errorValue) {
    await unlink(temporaryPath).catch(() => undefined);
    throw errorValue;
  }
}

function hashSourceManifest(sources: readonly TableSource[]): string {
  if (sources.length === 1) {
    return sources[0]!.hash;
  }
  const hash = createHash("sha256");
  for (const source of sources) {
    hash.update(source.path);
    hash.update("\0");
    hash.update(source.hash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function decodeUtf8(bytes: Uint8Array, displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    throw new Error(`File '${displayPath}' is not valid UTF-8: ${formatError(errorValue)}`);
  }
}

function prefixCatalogPath(catalogIndex: number, itemPath: string): string {
  return itemPath === "$" ? `catalogs[${catalogIndex}].$` : `catalogs[${catalogIndex}].${itemPath}`;
}

function remapRegistryPath(itemPath: string, sourceIndexes: readonly number[]): string {
  return itemPath.replace(/^catalogs\[(\d+)\]/, (match, indexText: string) => {
    const sourceIndex = sourceIndexes[Number(indexText)];
    return sourceIndex === undefined ? match : `catalogs[${sourceIndex}]`;
  });
}

function diagnostic(code: string, itemPath: string, message: string): DocumentDiagnostic {
  return { severity: "error", code, path: itemPath, message };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNodeError(errorValue: unknown, code: string): errorValue is NodeJS.ErrnoException {
  return errorValue instanceof Error && "code" in errorValue && errorValue.code === code;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
