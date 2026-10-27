import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ChangeEvent, ReactElement } from "react";
import { maximumTableRecordRenderCount, TABLE_RECORD_ROW_HEIGHT } from "../src/tableRecordVirtualization";

interface TestRecord {
  readonly id: string;
  readonly name: string;
}

const VIEWPORT_HEIGHT = 600;

test("production Table viewport keeps real React DOM bounded through scroll, search, edit, and dnd", async () => {
  const dom = installDom();
  const React = require("react") as typeof import("react");
  const { act } = React;
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const { DragDropProvider } = require("@dnd-kit/react");
  const { useSortable } = require("@dnd-kit/react/sortable");
  const { VirtualizedTableRecordViewport } = require(
    "../src/virtualizedTableRecordViewport",
  ) as typeof import("../src/virtualizedTableRecordViewport");

  function SortableTestRecord(props: {
    readonly item: TestRecord;
    readonly index: number;
    readonly selected: boolean;
    readonly onSelect: () => void;
  }): ReactElement {
    const { ref, handleRef } = useSortable({
      id: props.item.id,
      index: props.index,
      group: "table-records",
      type: "visualbridge-table-record",
      accept: "visualbridge-table-record",
    });
    return (
      <div ref={ref} data-sortable-record={props.item.id}>
        <button
          type="button"
          aria-pressed={props.selected}
          onClick={props.onSelect}
        >
          {props.item.name}
        </button>
        <button ref={handleRef} type="button" aria-label={`Drag ${props.item.name}`}>Drag</button>
      </div>
    );
  }

  function Harness(props: {
    readonly items: readonly TestRecord[];
    readonly focusId: string;
  }): ReactElement {
    const [selectedId, setSelectedId] = React.useState(props.items[0]?.id);
    const [edits, setEdits] = React.useState<Readonly<Record<string, string>>>({});
    const selected = props.items.find((item) => item.id === selectedId);
    const updateField = (event: ChangeEvent<HTMLInputElement>): void => {
      if (selectedId === undefined) return;
      setEdits((current) => ({ ...current, [selectedId]: event.target.value }));
    };
    return (
      <div>
        <button type="button" data-focus-record onClick={() => setSelectedId(props.focusId)}>Focus</button>
        <DragDropProvider>
          <VirtualizedTableRecordViewport
            items={props.items}
            getItemKey={testRecordKey}
            scrollToKey={selectedId}
            ariaLabel="Test records"
            renderItem={(item, index) => (
              <SortableTestRecord
                item={item}
                index={index}
                selected={item.id === selectedId}
                onSelect={() => setSelectedId(item.id)}
              />
            )}
          />
        </DragDropProvider>
        <input
          data-record-field
          value={selected === undefined ? "" : edits[selected.id] ?? selected.name}
          onChange={updateField}
        />
      </div>
    );
  }

  const container = document.getElementById("root")!;
  const root = createRoot(container);
  const thousand = createRecords(1_000);
  const fiftyThousand = createRecords(50_000);
  const domLimit = maximumTableRecordRenderCount(VIEWPORT_HEIGHT, 50_000);
  assert.equal(maximumTableRecordRenderCount(VIEWPORT_HEIGHT, 1_000), domLimit);

  try {
    await act(async () => {
      root.render(<Harness items={thousand} focusId="row-900" />);
    });
    assertBoundedRecordDom(container, 1_000, domLimit);
    const thousandDomCount = container.querySelectorAll(".record-virtual-row").length;

    const rowThree = container.querySelector<HTMLButtonElement>("[data-record-key='row-3'] button")!;
    await act(async () => rowThree.click());
    await act(async () => waitForAnimationFrame(window));
    const field = container.querySelector<HTMLInputElement>("[data-record-field]")!;
    assert.equal(field.value, "Record 3");
    await act(async () => setInputValue(field, "Edited record 3"));
    assert.equal(field.value, "Edited record 3");

    const viewport = container.querySelector<HTMLElement>(".record-scroll")!;
    await act(async () => {
      viewport.scrollTop = 500 * TABLE_RECORD_ROW_HEIGHT;
      viewport.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    });
    const afterManualScroll = renderedIndexes(container);
    assert.ok(
      afterManualScroll.some((index) => index >= 490 && index <= 510),
      `manual scroll top ${viewport.scrollTop} rendered indexes ${afterManualScroll.join(",")}`,
    );
    assert.equal(field.value, "Edited record 3");
    assertBoundedRecordDom(container, 1_000, domLimit);

    await act(async () => {
      root.render(<Harness items={fiftyThousand} focusId="row-40000" />);
    });
    assertBoundedRecordDom(container, 50_000, domLimit);
    assert.ok(container.querySelectorAll(".record-virtual-row").length <= domLimit);
    assert.ok(thousandDomCount <= domLimit);

    const focus = container.querySelector<HTMLButtonElement>("[data-focus-record]")!;
    await act(async () => focus.click());
    await act(async () => waitForAnimationFrame(window));
    assert.ok(viewport.scrollTop > 1_000_000);
    assert.notEqual(container.querySelector("[data-record-key='row-40000']"), null);
    assertBoundedRecordDom(container, 50_000, domLimit);

    assert.equal(field.value, "Record 40000");
    await act(async () => setInputValue(field, "Edited record 40000"));
    assert.equal(field.value, "Edited record 40000");

    const searchResults = fiftyThousand.filter((_item, index) => index % 500 === 0);
    await act(async () => {
      root.render(<Harness items={searchResults} focusId="row-40000" />);
    });
    await act(async () => waitForAnimationFrame(window));
    assert.equal(searchResults.length, 100);
    assertBoundedRecordDom(container, 100, domLimit);
    assert.notEqual(container.querySelector("[data-record-key='row-40000']"), null);
    assert.equal(field.value, "Edited record 40000");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

function testRecordKey(item: TestRecord): string {
  return item.id;
}

function createRecords(count: number): readonly TestRecord[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `row-${index}`,
    name: `Record ${index}`,
  }));
}

function renderedIndexes(container: Element): number[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".record-virtual-row"), (element) => (
    Number(element.dataset.virtualIndex)
  ));
}

function assertBoundedRecordDom(container: Element, total: number, limit: number): void {
  const viewport = container.querySelector<HTMLElement>(".record-scroll")!;
  const virtualRows = container.querySelectorAll(".record-virtual-row");
  assert.equal(viewport.dataset.recordCount, String(total));
  assert.ok(virtualRows.length > 0);
  assert.ok(virtualRows.length <= limit, `${virtualRows.length} mounted rows exceeded ${limit}`);
  assert.equal(container.querySelectorAll("[data-sortable-record]").length, virtualRows.length);
  assert.ok(virtualRows.length < total);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView!.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new input.ownerDocument.defaultView!.Event("input", { bubbles: true }));
}

function waitForAnimationFrame(targetWindow: Window): Promise<void> {
  return new Promise((resolve) => targetWindow.requestAnimationFrame(() => resolve()));
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  class TestResizeObserver {
    public observe(): void {}
    public unobserve(): void {}
    public disconnect(): void {}
  }
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TestResizeObserver,
  });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    AbortController: window.AbortController,
    AbortSignal: window.AbortSignal,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains("record-scroll") ? VIEWPORT_HEIGHT : TABLE_RECORD_ROW_HEIGHT;
      },
    },
    offsetWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => VIEWPORT_HEIGHT },
    clientWidth: { configurable: true, get: () => 320 },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement): number {
        if (!this.classList.contains("record-scroll")) return this.offsetHeight;
        const spacer = this.querySelector<HTMLElement>(".record-virtual-spacer");
        return spacer === null ? VIEWPORT_HEIGHT : Number.parseFloat(spacer.style.height) || VIEWPORT_HEIGHT;
      },
    },
    scrollTo: {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions | number, y?: number): void {
        const top = typeof options === "number" ? y ?? 0 : options.top ?? this.scrollTop;
        this.scrollTop = top;
        this.dispatchEvent(new window.Event("scroll"));
      },
    },
  });
  return dom;
}
