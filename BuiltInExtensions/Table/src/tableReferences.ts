import {
  collectFieldReferences,
  DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
  normalizeReferenceQuery,
  paginateReferenceCandidates,
  type DocumentDiagnostic,
  type JsonValue,
  type ReferenceCandidate,
  type ReferenceOccurrence,
  type ReferenceProvider,
  type ReferenceSearchPageRequest,
} from "@visualbridge/core";
import {
  formatTableRowDisplayName,
  resolveTableColumn,
  resolveTableSheet,
  type TableTypeDefinition,
} from "./tableCatalog";
import { resolveEffectiveTableRows, type TableDocument } from "./tableDocument";

export const TABLE_ROW_REFERENCE_KIND = "table.row";

export interface TableReferenceDocument {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly path: string;
  readonly document: TableDocument;
  readonly tableType: TableTypeDefinition;
  readonly sheetPaths?: Readonly<Record<string, string>>;
}

interface TableRowReferenceTarget {
  readonly tableTypeId: string;
  readonly sheetId: string;
  readonly documentTypeId?: string;
}

export function createTableRowReferenceProvider(
  loadDocuments: () => Promise<readonly TableReferenceDocument[]>,
): ReferenceProvider {
  let documents: Promise<readonly TableReferenceDocument[]> | undefined;
  const candidates = new Map<string, Promise<readonly ReferenceCandidate[]>>();
  const loadCandidates = (target: TableRowReferenceTarget): Promise<readonly ReferenceCandidate[]> => {
    const key = `${target.tableTypeId}\u0000${target.sheetId}\u0000${target.documentTypeId ?? ""}`;
    const existing = candidates.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const loading = (documents ??= loadDocuments()).then((loaded) => collectCandidates(loaded, target));
    candidates.set(key, loading);
    return loading;
  };
  const searchPage = async (request: ReferenceSearchPageRequest) => {
    const target = readTarget(request.target);
    const terms = normalizeReferenceQuery(request.query).split(" ").filter(Boolean);
    const filtered = target === undefined ? [] : (await loadCandidates(target)).filter((candidate) => {
      const searchText = `${candidate.title}\n${candidate.description ?? ""}\n${String(candidate.value)}`.toLowerCase();
      return terms.every((term) => searchText.includes(term));
    });
    return paginateReferenceCandidates({
      kind: TABLE_ROW_REFERENCE_KIND,
      target: request.target,
      query: request.query,
      limit: request.limit,
      snapshotDependencyKey: request.snapshotDependencyKey,
      candidates: filtered,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
  };
  return {
    kind: TABLE_ROW_REFERENCE_KIND,
    validateTarget: validateTableRowReferenceTarget,
    async search(request) {
      return (await searchPage({
        ...request,
        snapshotDependencyKey: DEFAULT_REFERENCE_SNAPSHOT_DEPENDENCY_KEY,
      })).candidates;
    },
    searchPage,
    async resolve(request) {
      const target = readTarget(request.target);
      if (target === undefined) {
        return [];
      }
      return (await loadCandidates(target)).filter(
        (candidate) => typeof candidate.value === typeof request.value && candidate.value === request.value,
      );
    },
  };
}

export function collectTableReferences(
  document: TableDocument,
  tableType: TableTypeDefinition,
): readonly ReferenceOccurrence[] {
  return document.sheets.flatMap((sheet) => {
    const definition = resolveTableSheet(tableType, sheet.definitionId);
    if (definition === undefined) {
      return [];
    }
    return sheet.rows.flatMap((row) => collectFieldReferences(
      row.cells,
      definition.columns,
      `sheets.${sheet.id}.rows.${row.id}.cells`,
    ));
  });
}

export function validateTableRowReferenceTarget(
  value: Readonly<Record<string, JsonValue>>,
): string | undefined {
  return readTarget(value) === undefined
    ? "Table row references require only stable string 'tableTypeId', 'sheetId', and optional 'documentTypeId' selectors."
    : undefined;
}

function collectCandidates(
  documents: readonly TableReferenceDocument[],
  target: TableRowReferenceTarget,
): readonly ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  for (const source of documents) {
    if (target.documentTypeId !== undefined && source.documentTypeId !== target.documentTypeId) {
      continue;
    }
    if (source.tableType.id !== target.tableTypeId && !source.tableType.aliases.includes(target.tableTypeId)) {
      continue;
    }
    const sheet = resolveTableSheet(source.tableType, target.sheetId);
    if (sheet === undefined || sheet.keyColumnId === undefined) {
      continue;
    }
    const keyColumn = resolveTableColumn(sheet, sheet.keyColumnId);
    if (keyColumn === undefined) {
      continue;
    }
    const effective = resolveEffectiveTableRows(source.document, source.tableType, sheet.id);
    for (const entry of effective.rows) {
      const value = entry.row.cells[keyColumn.id];
      if (typeof value !== "string" && typeof value !== "number") {
        continue;
      }
      candidates.push({
        kind: TABLE_ROW_REFERENCE_KIND,
        target: {
          tableTypeId: source.tableType.id,
          sheetId: sheet.id,
          ...(target.documentTypeId === undefined ? {} : { documentTypeId: source.documentTypeId }),
        },
        value,
        title: formatTableRowDisplayName(entry.row.cells, sheet),
        description: `${source.tableType.title} / ${sheet.title}`,
        location: {
          projectId: source.projectId,
          documentTypeId: source.documentTypeId,
          path: source.sheetPaths?.[entry.sheetId] ?? source.path,
          sheetId: entry.sheetId,
          rowId: entry.row.id,
        },
      });
    }
  }
  return candidates.sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
}

function readTarget(value: Readonly<Record<string, JsonValue>>): TableRowReferenceTarget | undefined {
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "tableTypeId" && key !== "sheetId" && key !== "documentTypeId")) {
    return undefined;
  }
  const tableTypeId = value.tableTypeId;
  const sheetId = value.sheetId;
  const documentTypeId = value.documentTypeId;
  if (!isIdentifier(tableTypeId) || !isIdentifier(sheetId)
    || (documentTypeId !== undefined && !isIdentifier(documentTypeId))) {
    return undefined;
  }
  return {
    tableTypeId,
    sheetId,
    ...(documentTypeId === undefined ? {} : { documentTypeId }),
  };
}

function isIdentifier(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function candidateKey(candidate: ReferenceCandidate): string {
  return [
    candidate.title,
    typeof candidate.value,
    String(candidate.value),
    candidate.location?.path ?? "",
    candidate.location?.sheetId ?? "",
    candidate.location?.rowId ?? "",
  ].join("\u0000");
}

export function invalidTableReferenceTargetDiagnostic(path: string, message: string): DocumentDiagnostic {
  return { severity: "error", code: "reference.invalidTarget", path, message };
}
