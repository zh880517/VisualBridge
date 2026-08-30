import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  referenceValuesEqual,
  type DocumentDiagnostic,
  type JsonValue,
  type ReferenceLocation,
  type ReferenceOccurrence,
  type TableLayoutDefinition,
} from "@visualbridge/core";
import {
  applyTableOperations,
  buildTableRowSearchText,
  buildTableCatalogRegistry,
  collectTableReferences,
  createEmptyCsvTableSource,
  createEmptyXlsxTableSource,
  createEmptyTableCatalogRegistry,
  formatTableRowDisplayName,
  matchTableSheetDefinitions,
  normalizeTableSearchQuery,
  parseCsvTable,
  parseTableCatalog,
  parseXlsxTable,
  replaceTableReferenceValues,
  resolveTableColumn,
  resolveEffectiveTableRows,
  resolveTableSheet,
  resolveTableType,
  serializeCsvTable,
  serializeXlsxTable,
  tableDocumentAdapter,
  validateTableDocument,
  type RegisteredTableTypeDefinition,
  type TableCatalog,
  type TableCatalogRegistry,
  type TableDocument,
  type TableRow,
  type TableReferenceDocument,
  type TableSheet,
} from "@visualbridge/table";
import {
  VisualBridgeMcpError,
  VisualBridgeWorkspace,
  resolveExistingProjectPath,
  type ProjectContext,
  type DeclaredDocumentContext,
  type TableDocumentContext,
} from "./projectWorkspace.js";
import type { VisualBridgeReferenceService } from "./referenceService.js";
import type { DocumentCatalogRequest, DocumentRequest } from "./documentAdapterRegistry.js";
import { pageItems } from "./pagination.js";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "./projectTransaction.js";

export interface TableCatalogContext {
  readonly project: ProjectContext;
  readonly documentTypeId: string;
  readonly catalogPaths: readonly string[];
  readonly catalogHash: string;
  readonly registry: TableCatalogRegistry;
  readonly tableType: RegisteredTableTypeDefinition;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export interface TableSource {
  readonly path: string;
  readonly absolutePath: string;
  readonly physicalName: string;
  readonly sheetIds: readonly string[];
  readonly bytes: Buffer;
  readonly hash: string;
}

export interface LoadedTable {
  readonly context: TableDocumentContext;
  readonly catalog: TableCatalogContext;
  readonly layout: TableLayoutDefinition;
  readonly sources: readonly TableSource[];
  readonly baseHash: string;
  readonly document: TableDocument;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export interface RenderedSource {
  readonly source: TableSource;
  readonly bytes: Buffer;
  readonly hash: string;
}

export interface PreparedTableReferenceWrite {
  readonly path: string;
  readonly absolutePath: string;
  readonly before: Buffer;
  readonly after: Buffer;
}

export interface PreparedTableLifecycleSource {
  readonly path: string;
  readonly absolutePath: string;
  readonly before?: Buffer;
  readonly after: Buffer;
}

export class TableService {
  private references: VisualBridgeReferenceService | undefined;

  public constructor(private readonly workspace: VisualBridgeWorkspace) {}

  public setReferenceService(references: VisualBridgeReferenceService): void {
    this.references = references;
  }

  public async queryCatalog(request: DocumentCatalogRequest): Promise<Record<string, unknown>> {
    const resolved = await this.workspace.resolveDocumentType("table", request.projectFile, request.documentTypeId);
    const catalog = await this.loadCatalog(resolved.project, resolved.documentType.id, resolved.documentType.catalogs);
    const base = {
      projectId: resolved.project.definition.projectId,
      projectFile: resolved.project.projectFile,
      documentTypeId: resolved.documentType.id,
      editor: resolved.documentType.editor,
      catalogPaths: catalog.catalogPaths,
      catalogs: catalog.registry.catalogs,
      diagnostics: catalog.diagnostics,
    };
    const kind = request.kind ?? "summary";
    const definitions = tableCatalogDefinitions(catalog.registry.tableTypes, kind);
    if (request.action === "read") {
      return kind === "summary"
        ? { ...base, counts: tableCatalogCounts(catalog.registry.tableTypes) }
        : { ...base, kind, definitions };
    }
    if (kind === "summary") {
      throw new VisualBridgeMcpError("catalog.kindUnsupported", "Table Catalog summary is not searchable.");
    }
    const query = normalizeCatalogSearchQuery(request.query);
    const filtered = definitions
      .filter((definition) => query.length === 0 || JSON.stringify(definition).toLowerCase().includes(query))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    const page = pageItems(
      filtered,
      request.cursor,
      request.limit,
      catalogCursorScope(request, kind),
      { catalogHash: catalog.catalogHash },
    );
    return { ...base, kind, query: request.query, results: page.items, nextCursor: page.nextCursor };
  }

  public async executeDocument(request: DocumentRequest): Promise<Record<string, unknown>> {
    if (request.action === "apply") {
      if (request.baseHash === undefined || request.operations === undefined) {
        throw new VisualBridgeMcpError("document.invalidApply", "Apply requires baseHash and operations.");
      }
      return this.applyOperations({
        ...(request.projectFile === undefined ? {} : { projectFile: request.projectFile }),
        ...(request.documentTypeId === undefined ? {} : { documentTypeId: request.documentTypeId }),
        tablePath: request.path,
        baseHash: request.baseHash,
        operations: request.operations,
      });
    }
    if (request.action === "validate") {
      return this.validateTable(request.path, request.projectFile, request.documentTypeId);
    }
    let loaded: LoadedTable;
    try {
      loaded = await this.loadTable(request.path, request.projectFile, request.documentTypeId);
    } catch (errorValue) {
      if (!(errorValue instanceof TableLoadError)) throw errorValue;
      const invalid = invalidTableLoadResult(errorValue);
      if (request.action !== "search") return invalid;
      const page = pageItems(
        [],
        request.cursor,
        request.limit,
        documentCursorScope(request),
        { sourceHash: errorValue.baseHash, catalogHash: errorValue.catalogHash },
      );
      return { ...invalid, query: request.query, results: page.items };
    }
    const referenceDiagnostics = await this.referenceDiagnostics(loaded);
    const diagnostics = [...loaded.diagnostics, ...referenceDiagnostics];
    if (request.action === "read") {
      const sheetId = optionalString(request.selector.sheetId, "selector.sheetId");
      const sheet = sheetId === undefined ? undefined : this.requirePhysicalSheet(loaded, sheetId);
      const page = sheet === undefined
        ? undefined
        : pageItems(
            sheet.rows.map(semanticRow),
            request.cursor,
            request.limit,
            documentCursorScope(request),
            tableCursorSnapshot(loaded),
          );
      return {
        ...tableIdentity(loaded),
        valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
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
        ...(sheet === undefined || page === undefined ? {} : {
          page: {
            sheetId: sheet.id,
            rows: page.items,
            nextCursor: page.nextCursor,
          },
        }),
        diagnostics,
      };
    }
    const sheetDefinitionId = optionalString(request.selector.sheetDefinitionId, "selector.sheetDefinitionId");
    const effectiveOnly = optionalBoolean(request.selector.effectiveOnly, "selector.effectiveOnly") ?? true;
    const definitions = sheetDefinitionId === undefined
      ? loaded.catalog.tableType.sheets
      : [this.requireSheetDefinition(loaded, sheetDefinitionId)];
    const terms = normalizeTableSearchQuery(request.query);
    const results: Record<string, unknown>[] = [];
    for (const definition of definitions) {
      const entries = effectiveOnly
        ? resolveEffectiveTableRows(loaded.document, loaded.catalog.tableType, definition.id).rows
        : loaded.document.sheets
            .filter((sheet) => sheet.definitionId === definition.id)
            .flatMap((sheet) => sheet.rows.map((row) => ({ sheetId: sheet.id, sheetName: sheet.name, row })));
      for (const entry of entries) {
        const displayName = formatTableRowDisplayName(entry.row.cells, definition);
        const searchText = buildTableRowSearchText(entry.row, definition);
        if (terms.every((term) => searchText.includes(term))) {
          results.push({
            kind: "row",
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
    const page = pageItems(
      results,
      request.cursor,
      request.limit,
      documentCursorScope(request),
      tableCursorSnapshot(loaded),
    );
    return {
      ...tableIdentity(loaded),
      valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      query: request.query,
      sheetDefinitionId,
      effectiveOnly,
      results: page.items,
      nextCursor: page.nextCursor,
      diagnostics,
    };
  }

  public async validateTable(
    tablePath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const loaded = await this.loadTable(tablePath, projectFile, documentTypeId);
      const referenceDiagnostics = await this.referenceDiagnostics(loaded);
      const diagnostics = [...loaded.diagnostics, ...referenceDiagnostics];
      return {
        ...tableIdentity(loaded),
        valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
        diagnostics,
      };
    } catch (errorValue) {
      if (!(errorValue instanceof TableLoadError)) {
        throw errorValue;
      }
      return {
        projectId: errorValue.context.project.definition.projectId,
        projectFile: errorValue.context.project.projectFile,
        documentTypeId: errorValue.context.documentType.id,
        editor: errorValue.context.documentType.editor,
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
    const project = await this.workspace.resolveProject(options.projectFile);
    let latest: LoadedTable | undefined;
    try {
      return await withProjectTransaction(project.projectRoot, async (transaction) => {
        let loaded: LoadedTable;
        try {
          loaded = await this.loadTable(options.tablePath, options.projectFile, options.documentTypeId);
        } catch (errorValue) {
          if (errorValue instanceof TableLoadError) return invalidTableLoadResult(errorValue, options.baseHash);
          throw errorValue;
        }
        latest = loaded;
        if (loaded.baseHash !== options.baseHash) {
          return conflictResult(loaded, options.baseHash, "baseHashMismatch");
        }
        const lifecycleGuard = tableLifecycleGuard(loaded, options.operations);
        if (lifecycleGuard.length > 0) return invalidResult(loaded, lifecycleGuard);
        const semanticContext = { tableType: loaded.catalog.tableType };
        const operationResult = tableDocumentAdapter.applyOperations(
          loaded.document,
          options.operations,
          semanticContext,
        );
        if (!operationResult.success
          || operationResult.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          return invalidResult(loaded, operationResult.diagnostics);
        }
        const referenceResult = this.references === undefined
          ? { diagnostics: [], introducedErrors: [] }
          : await this.references.validateChange(
            loaded.context.project.projectFile,
            tableDocumentAdapter.collectReferences(loaded.document, semanticContext),
            tableDocumentAdapter.collectReferences(operationResult.document, semanticContext),
          );
        if (referenceResult.introducedErrors.length > 0) {
          return invalidResult(loaded, referenceResult.introducedErrors);
        }
        const rendered = await this.renderSources(loaded, operationResult.document);
        const renderedByPath = new Map(rendered.map((entry) => [entry.source.path, entry]));
        const plannedSources = loaded.sources.map((source) => {
          const replacement = renderedByPath.get(source.path);
          return replacement === undefined ? source : { ...source, bytes: replacement.bytes, hash: replacement.hash };
        });
        const providerDiagnostics = this.references === undefined ? [] : await this.references.validateProviderDocument(
          loaded.context.project.projectFile,
          {
            documentTypeId: loaded.context.documentType.id,
            path: loaded.context.path,
            sourceHash: hashSourceManifest(plannedSources),
            content: operationResult.document as unknown as JsonValue,
          },
        );
        if (providerDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          return invalidResult(loaded, providerDiagnostics);
        }
        const operationDiagnostics = [
          ...operationResult.diagnostics,
          ...referenceResult.diagnostics,
          ...providerDiagnostics,
        ];
        const changed = rendered.filter((entry) => !entry.bytes.equals(entry.source.bytes));
        if (changed.length === 0) {
          return {
            status: "unchanged",
            ...tableIdentity(loaded),
            hash: loaded.baseHash,
            diagnostics: operationDiagnostics,
          };
        }
        const committed = await transaction.commit(changed.map((entry) => ({
          path: entry.source.path,
          absolutePath: entry.source.absolutePath,
          before: entry.source.bytes,
          after: entry.bytes,
        })));
        const nextSources = plannedSources;
        const nextHash = hashSourceManifest(nextSources);
        return {
          status: "applied",
          ...tableIdentity(loaded),
          baseHash: loaded.baseHash,
          hash: nextHash,
          sources: nextSources.map(sourceIdentity),
          diagnostics: operationDiagnostics,
          ...(committed.maintenance === undefined ? {} : { maintenance: committed.maintenance }),
        };
      });
    } catch (errorValue) {
      if (errorValue instanceof ProjectTransactionConflict) {
        let actual = latest;
        try {
          actual = await this.loadTable(options.tablePath, options.projectFile, options.documentTypeId);
        } catch {
          // The conflict still reports the last complete semantic snapshot when the current carrier is invalid.
        }
        return actual === undefined
          ? {
              status: "conflict",
              projectId: project.definition.projectId,
              projectFile: project.projectFile,
              documentTypeId: options.documentTypeId,
              editor: "table",
              path: options.tablePath,
              expectedBaseHash: options.baseHash,
              reason: errorValue.reason,
            }
          : conflictResult(actual, options.baseHash, errorValue.reason);
      }
      if (errorValue instanceof ProjectTransactionFailure) {
        throw new VisualBridgeMcpError(errorValue.code, errorValue.message, errorValue.details);
      }
      throw errorValue;
    }
  }

  public async loadReferenceDocuments(
    projectFile?: string,
    strict = false,
  ): Promise<readonly TableReferenceDocument[]> {
    const project = await this.workspace.resolveProject(projectFile);
    const declared = await this.workspace.listDeclaredDocuments(project, "table");
    const result: TableReferenceDocument[] = [];
    const seen = new Set<string>();
    for (const entry of declared) {
      try {
        const loaded = await this.loadTableForUse(entry.path, project.projectFile, entry.documentType.id);
        const key = `${entry.documentType.id}\u0000${loaded.sources.map((source) => source.path).join("\u0000")}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const sheetPaths = Object.fromEntries(loaded.sources.flatMap((source) =>
          source.sheetIds.map((sheetId) => [sheetId, source.path] as const)));
        result.push({
          projectId: project.definition.projectId,
          documentTypeId: entry.documentType.id,
          path: loaded.sources[0]?.path ?? entry.path,
          document: loaded.document,
          tableType: loaded.catalog.tableType,
          sheetPaths,
        });
      } catch (errorValue) {
        if (!(errorValue instanceof TableLoadError)) {
          throw errorValue;
        }
        if (strict) {
          throw new VisualBridgeMcpError(
            "refactor.invalidSource",
            `Table '${entry.path}' is invalid and cannot participate in a project refactor.`,
            errorValue.diagnostics,
          );
        }
      }
    }
    return result.sort((left, right) => `${left.documentTypeId}\u0000${left.path}`.localeCompare(`${right.documentTypeId}\u0000${right.path}`));
  }

  public async prepareReferenceRename(options: {
    readonly projectFile: string;
    readonly documentTypeId: string;
    readonly tablePath: string;
    readonly occurrencePaths: ReadonlySet<string>;
    readonly oldValue: string | number;
    readonly newValue: string | number;
    readonly targetLocation?: ReferenceLocation;
  }): Promise<readonly PreparedTableReferenceWrite[]> {
    const loaded = await this.loadTableForUse(options.tablePath, options.projectFile, options.documentTypeId);
    let next = loaded.document;
    if (options.occurrencePaths.size > 0) {
      assertOccurrenceValues(
        collectTableReferences(next, loaded.catalog.tableType),
        options.occurrencePaths,
        options.oldValue,
        options.tablePath,
      );
      const replaced = replaceTableReferenceValues(next, loaded.catalog.tableType, options.occurrencePaths, options.newValue);
      if (!replaced.success) {
        throw new VisualBridgeMcpError("refactor.invalid", "Table reference replacement is invalid.", replaced.diagnostics);
      }
      next = replaced.document;
    }
    if (options.targetLocation !== undefined) {
      const sheet = next.sheets.find((candidate) => candidate.id === options.targetLocation?.sheetId);
      const row = sheet?.rows.find((candidate) => candidate.id === options.targetLocation?.rowId);
      const definition = sheet === undefined ? undefined : resolveTableSheet(loaded.catalog.tableType, sheet.definitionId);
      const keyColumnId = definition?.keyColumnId;
      if (sheet === undefined || row === undefined || keyColumnId === undefined) {
        throw new VisualBridgeMcpError("refactor.targetChanged", "The target Table row or key column no longer exists.");
      }
      const keyValue = row.cells[keyColumnId];
      if (!isReferenceValue(keyValue) || !referenceValuesEqual(keyValue, options.oldValue)) {
        throw new VisualBridgeMcpError("refactor.targetChanged", "The target Table key changed after indexing.");
      }
      const duplicate = next.sheets.some((candidateSheet) => (
        candidateSheet.definitionId === sheet.definitionId
        && candidateSheet.rows.some((candidateRow) => {
          const candidateValue = candidateRow.cells[keyColumnId];
          return (candidateSheet.id !== sheet.id || candidateRow.id !== row.id)
            && isReferenceValue(candidateValue)
            && referenceValuesEqual(candidateValue, options.newValue);
        })
      ));
      if (duplicate) throw new VisualBridgeMcpError("refactor.duplicateTarget", `Table key '${String(options.newValue)}' already exists.`);
      const renamed = applyTableOperations(next, [{
        type: "table.setCell",
        sheetId: sheet.id,
        rowId: row.id,
        columnId: keyColumnId,
        value: options.newValue,
      }], loaded.catalog.tableType);
      if (!renamed.success) {
        throw new VisualBridgeMcpError("refactor.invalid", "Table key rename is invalid.", renamed.diagnostics);
      }
      next = renamed.document;
    }
    const rendered = await this.renderSources(loaded, next);
    return rendered.map((entry) => ({
      path: entry.source.path,
      absolutePath: entry.source.absolutePath,
      before: entry.source.bytes,
      after: entry.bytes,
    }));
  }

  public async loadLifecycleDocument(
    tablePath: string,
    projectFile?: string,
    documentTypeId?: string,
  ): Promise<LoadedTable> {
    return this.loadTableForUse(tablePath, projectFile, documentTypeId);
  }

  public async renderLifecycleDocument(
    loaded: LoadedTable,
    document: TableDocument,
  ): Promise<readonly PreparedTableLifecycleSource[]> {
    return (await this.renderSources(loaded, document)).map((entry) => ({
      path: entry.source.path,
      absolutePath: entry.source.absolutePath,
      before: entry.source.bytes,
      after: entry.bytes,
    }));
  }

  public async createLifecycleDocument(
    context: DeclaredDocumentContext,
    options: {
      readonly format: "csv" | "xlsx";
      readonly physicalName?: string;
    },
  ): Promise<readonly PreparedTableLifecycleSource[]> {
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
    if (options.format === "xlsx" && options.physicalName !== undefined) {
      throw new VisualBridgeMcpError(
        "lifecycle.invalidParameters",
        "Table XLSX create does not accept physicalName.",
      );
    }
    const created = options.format === "xlsx"
      ? await createEmptyXlsxTableSource(catalog.tableType, layout)
      : createEmptyCsvTableSource(
          catalog.tableType,
          layout,
          options.physicalName ?? path.basename(context.path, path.extname(context.path)),
        );
    if (!created.success) {
      throw new VisualBridgeMcpError(
        "lifecycle.invalidCreate",
        `Table '${context.path}' cannot be created from its declared Table Type.`,
        created.diagnostics,
      );
    }
    return [{
      path: context.path,
      absolutePath: context.absolutePath,
      after: Buffer.from(created.bytes),
    }];
  }

  private async referenceDiagnostics(loaded: LoadedTable): Promise<readonly DocumentDiagnostic[]> {
    return this.references === undefined
      ? []
      : this.references.validate(
          loaded.context.project.projectFile,
          collectTableReferences(loaded.document, loaded.catalog.tableType),
        );
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
      throw new TableLoadError(
        context,
        source.hash,
        catalog.catalogHash,
        [source],
        [...catalog.diagnostics, ...parsed.diagnostics],
      );
    }
    const loadedSource = { ...source, sheetIds: parsed.document.sheets.map((sheet) => sheet.id) };
    const providerDiagnostics = this.references === undefined ? [] : await this.references.validateProviderDocument(
      context.project.projectFile,
      {
        documentTypeId: context.documentType.id,
        path: context.path,
        sourceHash: loadedSource.hash,
        content: parsed.document as unknown as JsonValue,
      },
    );
    const diagnostics = [
      ...catalog.diagnostics,
      ...parsed.diagnostics,
      ...validateTableDocument(parsed.document, catalog.tableType),
      ...providerDiagnostics,
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
          catalog.catalogHash,
          [...sources, baseSource],
          [diagnostic("table.invalidUtf8", sourcePath, formatError(errorValue))],
        );
      }
      if (!parsed.success) {
        throw new TableLoadError(
          context,
          hashSourceManifest([...sources, baseSource]),
          catalog.catalogHash,
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
    const baseHash = hashSourceManifest(sources);
    if (this.references !== undefined) {
      diagnostics.push(...await this.references.validateProviderDocument(context.project.projectFile, {
        documentTypeId: context.documentType.id,
        path: context.path,
        sourceHash: baseHash,
        content: document as unknown as JsonValue,
      }));
    }
    return {
      context,
      catalog,
      layout,
      sources,
      baseHash,
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
          || !["document.notDeclared", "path.notFound"].includes(errorValue.code)) {
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
    const catalogSources: { readonly path: string; readonly hash: string }[] = [];
    const sourceIndexes: number[] = [];
    for (const [catalogIndex, catalogPath] of catalogPaths.entries()) {
      try {
        const absolutePath = await resolveExistingProjectPath(project, catalogPath);
        const bytes = await readFile(absolutePath);
        catalogSources.push({ path: catalogPath, hash: hashBytes(bytes) });
        const result = parseTableCatalog(decodeUtf8(bytes, catalogPath));
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
    return {
      project,
      documentTypeId,
      catalogPaths,
      catalogHash: hashPathManifest(catalogSources),
      registry,
      tableType,
      diagnostics,
    };
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

function tableLifecycleGuard(loaded: LoadedTable, operations: unknown): readonly DocumentDiagnostic[] {
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((raw, index): readonly DocumentDiagnostic[] => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
    const operation = raw as Readonly<Record<string, unknown>>;
    if (operation.type === "table.removeRow") {
      return [{
        severity: "error",
        code: "lifecycle.required",
        path: `operations[${index}].type`,
        message: "Removing a Table row requires visualbridge_document_lifecycle Safe Delete.",
      }];
    }
    if (operation.type !== "table.setCell"
      || typeof operation.sheetId !== "string"
      || typeof operation.columnId !== "string") return [];
    const sheetId = operation.sheetId;
    const columnId = operation.columnId;
    const sheet = loaded.document.sheets.find((candidate) => candidate.id === sheetId);
    const definition = sheet === undefined
      ? undefined
      : resolveTableSheet(loaded.catalog.tableType, sheet.definitionId);
    const column = definition === undefined ? undefined : resolveTableColumn(definition, columnId);
    const keyColumn = definition?.keyColumnId === undefined
      ? undefined
      : resolveTableColumn(definition, definition.keyColumnId);
    if (column !== undefined && keyColumn !== undefined && column.id === keyColumn.id) {
      return [{
        severity: "error",
        code: "lifecycle.required",
        path: `operations[${index}].type`,
        message: "Changing a Table row key requires visualbridge_refactor_reference so every exact semantic reference is updated atomically.",
      }];
    }
    return [];
  });
}

class TableLoadError extends Error {
  public constructor(
    public readonly context: TableDocumentContext,
    public readonly baseHash: string,
    public readonly catalogHash: string,
    public readonly sources: readonly TableSource[],
    public readonly diagnostics: readonly DocumentDiagnostic[],
  ) {
    super(`Table '${context.tablePath}' is structurally invalid.`);
    this.name = "TableLoadError";
  }
}

function tableIdentity(loaded: LoadedTable) {
  return {
    projectId: loaded.context.project.definition.projectId,
    projectFile: loaded.context.project.projectFile,
    documentTypeId: loaded.context.documentType.id,
    editor: loaded.context.documentType.editor,
    path: loaded.context.tablePath,
    format: loaded.document.format,
    baseHash: loaded.baseHash,
    sources: loaded.sources.map(sourceIdentity),
  };
}

function catalogCursorScope(request: DocumentCatalogRequest, kind: string): unknown {
  return {
    tool: "visualbridge_catalog",
    action: request.action,
    projectFile: request.projectFile,
    documentTypeId: request.documentTypeId,
    editor: "table",
    kind,
    query: normalizeCatalogSearchQuery(request.query),
    selector: request.selector,
  };
}

function documentCursorScope(request: DocumentRequest): unknown {
  return {
    tool: "visualbridge_document",
    action: request.action,
    projectFile: request.projectFile,
    documentTypeId: request.documentTypeId,
    editor: "table",
    path: request.path,
    query: normalizeTableSearchQuery(request.query),
    selector: request.selector,
  };
}

function normalizeCatalogSearchQuery(query: string): string {
  return query.normalize("NFC").trim().toLowerCase();
}

function tableCursorSnapshot(loaded: LoadedTable): unknown {
  return {
    sourceHash: loaded.baseHash,
    catalogHash: loaded.catalog.catalogHash,
  };
}

function sourceIdentity(source: TableSource) {
  return { path: source.path, hash: source.hash, sheetIds: source.sheetIds };
}

function assertOccurrenceValues(
  occurrences: readonly ReferenceOccurrence[],
  paths: ReadonlySet<string>,
  expectedValue: string | number,
  documentPath: string,
): void {
  for (const occurrencePath of paths) {
    const matching = occurrences.filter((occurrence) => (
      occurrence.path === occurrencePath && referenceValuesEqual(occurrence.value, expectedValue)
    ));
    if (matching.length !== 1) {
      throw new VisualBridgeMcpError(
        "refactor.occurrenceChanged",
        `Reference occurrence '${documentPath}: ${occurrencePath}' changed after indexing.`,
      );
    }
  }
}

function isReferenceValue(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function semanticRow(row: TableRow) {
  return {
    id: row.id,
    cells: row.cells,
    ...(row.sourceRowNumber === undefined ? {} : { sourceRowNumber: row.sourceRowNumber }),
  };
}

function tableCatalogCounts(tableTypes: readonly RegisteredTableTypeDefinition[]): Record<string, number> {
  return {
    tableTypes: tableTypes.length,
    sheets: tableTypes.reduce((count, tableType) => count + tableType.sheets.length, 0),
    columns: tableTypes.reduce(
      (count, tableType) => count + tableType.sheets.reduce((sheetCount, sheet) => sheetCount + sheet.columns.length, 0),
      0,
    ),
  };
}

function tableCatalogDefinitions(
  tableTypes: readonly RegisteredTableTypeDefinition[],
  kind: string,
): readonly Record<string, unknown>[] {
  switch (kind) {
    case "summary":
      return [];
    case "tableTypes":
      return tableTypes.map((tableType) => ({ ...tableType }));
    case "sheets":
      return tableTypes.flatMap((tableType) => tableType.sheets.map((sheet) => ({
        tableTypeId: tableType.id,
        catalogId: tableType.catalogId,
        ...sheet,
      })));
    case "columns":
      return tableTypes.flatMap((tableType) => tableType.sheets.flatMap((sheet) => sheet.columns.map((column) => ({
        tableTypeId: tableType.id,
        sheetId: sheet.id,
        catalogId: tableType.catalogId,
        ...column,
      }))));
    default:
      throw new VisualBridgeMcpError("catalog.kindUnsupported", `Table Catalog kind '${kind}' is not supported.`);
  }
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new VisualBridgeMcpError("request.invalidSelector", `${path} must be a string.`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new VisualBridgeMcpError("request.invalidSelector", `${path} must be a boolean.`);
  }
  return value;
}

function conflictResult(loaded: LoadedTable, requestedHash: string, reason: string) {
  return {
    status: "conflict",
    projectId: loaded.context.project.definition.projectId,
    projectFile: loaded.context.project.projectFile,
    documentTypeId: loaded.context.documentType.id,
    editor: loaded.context.documentType.editor,
    path: loaded.context.tablePath,
    expectedBaseHash: requestedHash,
    actualHash: loaded.baseHash,
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

function invalidTableLoadResult(errorValue: TableLoadError, requestedHash?: string): Record<string, unknown> {
  if (requestedHash !== undefined && requestedHash !== errorValue.baseHash) {
    return {
      status: "conflict",
      projectId: errorValue.context.project.definition.projectId,
      projectFile: errorValue.context.project.projectFile,
      documentTypeId: errorValue.context.documentType.id,
      editor: errorValue.context.documentType.editor,
      path: errorValue.context.tablePath,
      expectedBaseHash: requestedHash,
      actualHash: errorValue.baseHash,
      sources: errorValue.sources.map(sourceIdentity),
      reason: "baseHashMismatch",
    };
  }
  return {
    ...(requestedHash === undefined ? {} : { status: "invalid" }),
    projectId: errorValue.context.project.definition.projectId,
    projectFile: errorValue.context.project.projectFile,
    documentTypeId: errorValue.context.documentType.id,
    editor: errorValue.context.documentType.editor,
    path: errorValue.context.tablePath,
    baseHash: errorValue.baseHash,
    sources: errorValue.sources.map(sourceIdentity),
    valid: false,
    diagnostics: errorValue.diagnostics,
  };
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

function hashPathManifest(entries: readonly { readonly path: string; readonly hash: string }[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.hash);
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

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
