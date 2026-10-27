export const TABLE_RECORD_ROW_HEIGHT = 48;
export const TABLE_RECORD_OVERSCAN = 8;

export interface IndexedTableRecord<TRecord> {
  readonly record: TRecord;
  readonly sourceIndex: number;
}

export interface TableRecordVirtualRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly overscan: number;
  readonly count: number;
}

export function indexTableRecords<TRecord>(
  records: readonly TRecord[],
): readonly IndexedTableRecord<TRecord>[] {
  return records.map((record, sourceIndex) => ({ record, sourceIndex }));
}

export function tableRecordRangeExtractor(range: TableRecordVirtualRange): number[] {
  if (range.count <= 0 || range.endIndex < range.startIndex) {
    return [];
  }
  const start = Math.max(0, range.startIndex - range.overscan);
  const end = Math.min(range.count - 1, range.endIndex + range.overscan);
  return Array.from({ length: end - start + 1 }, (_value, offset) => start + offset);
}

export function maximumTableRecordRenderCount(
  viewportHeight: number,
  totalCount: number,
  rowHeight = TABLE_RECORD_ROW_HEIGHT,
  overscan = TABLE_RECORD_OVERSCAN,
): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0 || totalCount <= 0
    || !Number.isFinite(rowHeight) || rowHeight <= 0 || overscan < 0) {
    return 0;
  }
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1;
  return Math.min(totalCount, visibleCount + (overscan * 2));
}
