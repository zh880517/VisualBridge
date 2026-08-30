import {
  useCallback,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TABLE_RECORD_OVERSCAN,
  TABLE_RECORD_ROW_HEIGHT,
  tableRecordRangeExtractor,
} from "./tableRecordVirtualization";

export type TableRecordKey = string | number;

export interface VirtualizedTableRecordViewportProps<TItem> {
  readonly items: readonly TItem[];
  readonly getItemKey: (item: TItem, index: number) => TableRecordKey;
  readonly renderItem: (item: TItem, index: number) => ReactNode;
  readonly scrollToKey?: TableRecordKey | undefined;
  readonly emptyContent?: ReactNode;
  readonly ariaLabel?: string | undefined;
}

export function VirtualizedTableRecordViewport<TItem>(
  props: VirtualizedTableRecordViewportProps<TItem>,
): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback((index: number): TableRecordKey => {
    const item = props.items[index];
    return item === undefined ? `missing-record-${index}` : props.getItemKey(item, index);
  }, [props.getItemKey, props.items]);
  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement,
    estimateSize: () => TABLE_RECORD_ROW_HEIGHT,
    getItemKey,
    overscan: TABLE_RECORD_OVERSCAN,
    rangeExtractor: tableRecordRangeExtractor,
    useFlushSync: false,
  });

  useEffect(() => {
    if (props.scrollToKey === undefined) {
      return;
    }
    const targetIndex = props.items.findIndex(
      (item, index) => props.getItemKey(item, index) === props.scrollToKey,
    );
    if (targetIndex >= 0) {
      virtualizer.scrollToIndex(targetIndex, { align: "auto" });
    }
  }, [props.getItemKey, props.items, props.scrollToKey, virtualizer]);

  return (
    <div
      ref={scrollRef}
      className="record-scroll"
      aria-label={props.ariaLabel}
      data-record-count={props.items.length}
    >
      <div
        className="record-virtual-spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = props.items[virtualRow.index];
          if (item === undefined) {
            return null;
          }
          const itemKey = props.getItemKey(item, virtualRow.index);
          return (
            <div
              key={virtualRow.key}
              className="record-virtual-row"
              data-record-key={String(itemKey)}
              data-virtual-index={virtualRow.index}
              style={{
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {props.renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
      {props.items.length === 0 && props.emptyContent}
    </div>
  );
}
