import assert from "node:assert/strict";
import test from "node:test";
import {
  TABLE_RECORD_OVERSCAN,
  TABLE_RECORD_ROW_HEIGHT,
  indexTableRecords,
  maximumTableRecordRenderCount,
  tableRecordRangeExtractor,
} from "../src/tableRecordVirtualization";

test("indexes large Table record inputs once with stable source indexes", () => {
  const records = Array.from({ length: 50_000 }, (_value, index) => ({ id: `row-${index}` }));
  const indexed = indexTableRecords(records);

  assert.equal(indexed.length, records.length);
  assert.deepEqual(indexed[0], { record: records[0], sourceIndex: 0 });
  assert.deepEqual(indexed[49_999], { record: records[49_999], sourceIndex: 49_999 });
});

test("virtual Table record range stays bounded independently of total row count", () => {
  const viewportHeight = 600;
  const visibleStart = 20_000;
  const visibleEnd = visibleStart + Math.ceil(viewportHeight / TABLE_RECORD_ROW_HEIGHT);
  const rendered = tableRecordRangeExtractor({
    startIndex: visibleStart,
    endIndex: visibleEnd,
    overscan: TABLE_RECORD_OVERSCAN,
    count: 50_000,
  });

  assert.equal(rendered[0], visibleStart - TABLE_RECORD_OVERSCAN);
  assert.equal(rendered.at(-1), visibleEnd + TABLE_RECORD_OVERSCAN);
  assert.ok(rendered.length <= maximumTableRecordRenderCount(viewportHeight, 50_000));
  assert.equal(
    maximumTableRecordRenderCount(viewportHeight, 1_000),
    maximumTableRecordRenderCount(viewportHeight, 50_000),
  );
});

test("virtual Table record range clamps overscan at both document edges", () => {
  assert.deepEqual(tableRecordRangeExtractor({
    startIndex: 0,
    endIndex: 3,
    overscan: 2,
    count: 5,
  }), [0, 1, 2, 3, 4]);
  assert.deepEqual(tableRecordRangeExtractor({
    startIndex: 0,
    endIndex: 0,
    overscan: TABLE_RECORD_OVERSCAN,
    count: 0,
  }), []);
});
