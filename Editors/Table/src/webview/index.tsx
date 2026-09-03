import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@base-ui/react/button";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import {
  CommonIcon,
  EditorShell,
  EditorStatusBar,
  EditorToolbar,
  IconButton,
  InspectorPane,
  ListItemActions,
  NavigatorPane,
  SaveState,
  SplitWorkspace,
} from "@visualbridge/editor-ui";
import { FieldsEditor, WebviewReferenceBridge } from "@visualbridge/form-editor";
import {
  buildTableRowSearchText,
  formatTableRowDisplayName,
  normalizeTableSearchQuery,
  resolveTableColumn,
  resolveTableSheet,
  type TableColumnDefinition,
  type TableDocument,
  type TableOperation,
  type TableRow,
  type TableSheetDefinition,
  type TableTypeDefinition,
} from "@visualbridge/table/webview";
import {
  TABLE_REVEAL_MESSAGE_TYPE,
  TABLE_REVEAL_RESULT_MESSAGE_TYPE,
  type TableRevealRequest,
} from "../tableReveal";
import { indexTableRecords } from "../tableRecordVirtualization";
import { VirtualizedTableRecordViewport } from "../virtualizedTableRecordViewport";
import "../styles.css";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface TableStateMessage {
  readonly type: "tableState";
  readonly revision: number;
  readonly document: TableDocument;
  readonly tableType: TableTypeDefinition;
  readonly isDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface TableInvalidMessage {
  readonly type: "tableInvalid";
  readonly revision: number;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface TableRecordListEntry {
  readonly row: TableRow;
  readonly sourceIndex: number;
  readonly name: string;
  readonly searchText: string;
}

type HostMessage = TableStateMessage | TableInvalidMessage | {
  readonly type: "operationRejected";
  readonly message: string;
} | {
  readonly type: "operationCompleted";
  readonly changed: boolean;
} | {
  readonly type: "requestReady";
  readonly webviewToken: string;
} | TableRevealRequest;

const rawVscode = acquireVsCodeApi();
const webviewInstanceId = crypto.randomUUID();
let webviewToken: string | undefined;
const vscode: VsCodeApi = {
  postMessage: (message) => rawVscode.postMessage(withWebviewToken(message, webviewToken)),
  getState: () => rawVscode.getState(),
  setState: (state) => rawVscode.setState(state),
};
const referenceBridge = new WebviewReferenceBridge(vscode);
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Table editor root element is missing.");
}
createRoot(rootElement).render(<TableEditorApp />);

function TableEditorApp(): ReactElement {
  const stateRef = useRef<TableStateMessage | undefined>(undefined);
  const [state, setState] = useState<TableStateMessage>();
  const [invalid, setInvalid] = useState<TableInvalidMessage>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("正在加载表格文档…");
  const [sheetId, setSheetId] = useState<string>();
  const [selectedRowId, setSelectedRowId] = useState<string>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "requestReady") {
        webviewToken = message.webviewToken;
        vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
        return;
      }
      if (referenceBridge.handleMessage(message)) {
        return;
      }
      if (message.type === TABLE_REVEAL_MESSAGE_TYPE) {
        const sheet = stateRef.current?.document.sheets.find(
          (candidate) => candidate.id === message.target.sheetId,
        );
        const found = sheet?.rows.some((row) => row.id === message.target.rowId) === true;
        if (found) {
          setQuery("");
          setSheetId(message.target.sheetId);
          setSelectedRowId(message.target.rowId);
        }
        vscode.postMessage({
          type: TABLE_REVEAL_RESULT_MESSAGE_TYPE,
          requestId: message.requestId,
          found,
          ...(!found ? { message: "表格行不存在或文档状态尚未就绪。" } : {}),
        });
      } else if (message.type === "tableState") {
        stateRef.current = message;
        setState(message);
        setInvalid(undefined);
        setPending(false);
        setStatus("就绪");
        setSheetId((current) => message.document.sheets.some((sheet) => sheet.id === current)
          ? current
          : message.document.sheets[0]?.id);
      } else if (message.type === "tableInvalid") {
        stateRef.current = undefined;
        setInvalid(message);
        setState(undefined);
        setPending(false);
        setStatus("表格文档无效");
      } else if (message.type === "operationRejected") {
        setPending(false);
        setStatus(message.message);
      } else if (message.type === "operationCompleted") {
        setPending(false);
        if (!message.changed) {
          setStatus("没有产生文档修改");
        }
      }
    };
    window.addEventListener("message", listener);
    webviewToken = undefined;
    vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
    return () => {
      window.removeEventListener("message", listener);
      referenceBridge.dispose();
    };
  }, []);

  const sheet = useMemo(
    () => state?.document.sheets.find((candidate) => candidate.id === sheetId) ?? state?.document.sheets[0],
    [sheetId, state],
  );
  const definition = useMemo(
    () => state === undefined || sheet === undefined
      ? undefined
      : resolveTableSheet(state.tableType, sheet.definitionId),
    [sheet, state],
  );
  const indexedRows = useMemo<readonly TableRecordListEntry[]>(
    () => sheet === undefined || definition === undefined
      ? []
      : indexTableRecords(sheet.rows).map(({ record: row, sourceIndex }) => ({
          row,
          sourceIndex,
          name: displayRowName(row, definition),
          searchText: buildTableRowSearchText(row, definition),
        })),
    [definition, sheet],
  );
  const rowsById = useMemo(
    () => new Map(indexedRows.map((entry) => [entry.row.id, entry])),
    [indexedRows],
  );
  const queryTerms = useMemo(() => normalizeTableSearchQuery(query), [query]);
  const filteredRows = useMemo(
    () => queryTerms.length === 0
      ? indexedRows
      : indexedRows.filter((entry) => queryTerms.every((term) => entry.searchText.includes(term))),
    [indexedRows, queryTerms],
  );
  const selectedRow = selectedRowId === undefined ? undefined : rowsById.get(selectedRowId)?.row;

  useEffect(() => {
    if (sheet === undefined) {
      setSelectedRowId(undefined);
      return;
    }
    setSelectedRowId((current) => sheet.rows.some((row) => row.id === current) ? current : sheet.rows[0]?.id);
  }, [sheet]);

  const submit = (operations: readonly TableOperation[]): void => {
    if (state === undefined || pending || operations.length === 0) {
      return;
    }
    setPending(true);
    setStatus("正在应用修改…");
    vscode.postMessage({ type: "applyOperations", revision: state.revision, operations });
  };

  const insertRowAt = (index: number): void => {
    if (state === undefined || sheet === undefined || definition === undefined) {
      return;
    }
    const rowId = `row_${crypto.randomUUID()}`;
    setSelectedRowId(rowId);
    submit([{
      type: "table.insertRow",
      sheetId: sheet.id,
      rowId,
      index,
      cells: createNewRowCells(state.document, definition),
    }]);
  };

  if (state === undefined) {
    return (
      <main className="table-loading">
        <h1>VisualBridge 表格</h1>
        <p>{status}</p>
        {invalid !== undefined && <Diagnostics diagnostics={invalid.diagnostics} />}
      </main>
    );
  }

  return (
    <EditorShell className="table-app">
      <EditorToolbar className="table-toolbar">
        <SaveState dirty={state.isDirty} pending={pending} pendingLabel="修改中" />
        <span className="table-path">{rootElement!.dataset.relativePath}</span>
        <IconButton
          className="secondary"
          icon="add"
          label="新增记录"
          title="新增记录"
          disabled={pending || sheet === undefined || definition === undefined}
          onClick={() => insertRowAt(sheet?.rows.length ?? 0)}
        />
      </EditorToolbar>
      <nav className="sheet-tabs" aria-label="表格分表">
        {state.document.sheets.map((candidate) => (
          <Button
            key={candidate.id}
            className={candidate.id === sheet?.id ? "sheet-tab active" : "sheet-tab"}
            aria-pressed={candidate.id === sheet?.id}
            onClick={() => {
              setSheetId(candidate.id);
              setSelectedRowId(undefined);
              setQuery("");
            }}
          >
            {candidate.name}
            <span>{candidate.rows.length}</span>
          </Button>
        ))}
      </nav>
      {sheet === undefined || definition === undefined
        ? <main className="table-loading"><p>目录中没有可编辑的分表定义。</p></main>
        : (
          <SplitWorkspace className="table-workspace">
            <NavigatorPane className="record-list">
              <div className="record-search">
                <CommonIcon name="search" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索记录名称或字段"
                  aria-label="搜索当前分表记录"
                />
              </div>
              <div className="record-count">
                <span>{query.trim().length === 0 ? `${sheet.rows.length} 条记录` : `${filteredRows.length} / ${sheet.rows.length} 条记录`}</span>
              </div>
              <DragDropProvider
                onDragEnd={(event) => {
                  if (event.canceled) {
                    return;
                  }
                  const { source } = event.operation;
                  if (isSortable(source) && source.initialIndex !== source.index) {
                    const row = sheet.rows[source.initialIndex];
                    if (row === undefined) {
                      return;
                    }
                    submit([{
                      type: "table.moveRow",
                      sheetId: sheet.id,
                      rowId: row.id,
                      index: source.index,
                    }]);
                  }
                }}
              >
                <VirtualizedTableRecordViewport
                  items={filteredRows}
                  getItemKey={tableRecordListEntryKey}
                  scrollToKey={selectedRowId}
                  ariaLabel="当前分表记录"
                  emptyContent={<p className="record-empty">没有匹配的记录</p>}
                  renderItem={(entry) => (
                    <SortableRecordItem
                      row={entry.row}
                      index={entry.sourceIndex}
                      active={entry.row.id === selectedRow?.id}
                      name={entry.name}
                      disabled={pending}
                      dragDisabled={query.trim().length > 0}
                      onSelect={() => setSelectedRowId(entry.row.id)}
                      onAdd={() => insertRowAt(entry.sourceIndex + 1)}
                      onDelete={() => submit([{
                        type: "table.removeRow",
                        sheetId: sheet.id,
                        rowId: entry.row.id,
                      }])}
                    />
                  )}
                />
              </DragDropProvider>
            </NavigatorPane>
            <InspectorPane className="record-editor">
              {selectedRow === undefined
                ? <p className="record-editor-empty">从左侧选择一条记录开始编辑。</p>
                : (
                  <>
                    <header className="record-editor-header">
                      <h1>{displayRowName(selectedRow, definition)}</h1>
                      <div className="record-actions">
                        <IconButton
                          className="secondary"
                          icon="copy"
                          label="复制记录"
                          title="复制"
                          disabled={pending}
                          onClick={() => {
                            const rowId = `row_${crypto.randomUUID()}`;
                            setSelectedRowId(rowId);
                            submit(createDuplicateOperations(state.document, sheet.id, definition, selectedRow, rowId));
                          }}
                        />
                      </div>
                    </header>
                    <div className="record-fields">
                      <FieldsEditor
                        definitions={definition.columns}
                        properties={selectedRow.cells}
                        disabled={pending}
                        referenceActions={referenceBridge}
                        onCommit={(columnId, value) => submit([{
                          type: "table.setCell",
                          sheetId: sheet.id,
                          rowId: selectedRow.id,
                          columnId,
                          value,
                        }])}
                      />
                    </div>
                  </>
                )}
            </InspectorPane>
          </SplitWorkspace>
        )}
      <EditorStatusBar className="table-status">
        <span>{status}</span>
        <span>{state.diagnostics.length === 0 ? "校验通过" : `${state.diagnostics.length} 个诊断`}</span>
      </EditorStatusBar>
    </EditorShell>
  );
}

function withWebviewToken(message: unknown, token: string | undefined): unknown {
  return token === undefined || typeof message !== "object" || message === null || Array.isArray(message)
    ? message
    : { ...message, webviewToken: token };
}

function SortableRecordItem(props: {
  readonly row: TableRow;
  readonly index: number;
  readonly active: boolean;
  readonly name: string;
  readonly disabled: boolean;
  readonly dragDisabled: boolean;
  readonly onSelect: () => void;
  readonly onAdd: () => void;
  readonly onDelete: () => void;
}): ReactElement {
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({
    id: props.row.id,
    index: props.index,
    group: "table-records",
    type: "visualbridge-table-record",
    accept: "visualbridge-table-record",
    disabled: props.disabled || props.dragDisabled,
  });
  return (
    <div
      ref={ref}
      className={`record-item-shell${props.active ? " active" : ""}${isDragging ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}
    >
      <Button
        className={`record-item${props.row.changedColumnIds.length > 0 ? " changed" : ""}`}
        aria-pressed={props.active}
        onClick={props.onSelect}
      >
        <strong className="record-name">{props.name}</strong>
        <span className="record-meta">{props.row.sourceRowNumber === undefined ? "新增记录" : `第 ${props.index + 1} 条`}</span>
      </Button>
      <ListItemActions
        dragRef={handleRef}
        dragLabel={`拖动 ${props.name} 排序`}
        addLabel={`在 ${props.name} 后新增记录`}
        deleteLabel={`删除 ${props.name}`}
        disabled={props.disabled}
        dragDisabled={props.dragDisabled}
        onAdd={props.onAdd}
        onDelete={props.onDelete}
      />
    </div>
  );
}

function createNewRowCells(
  document: TableDocument,
  definition: TableSheetDefinition,
): Readonly<Record<string, JsonValue>> {
  const cells = createUniqueIdentityCells(document, definition);
  const identities = new Set(identityColumns(definition).map((column) => column.id));
  const labelColumn = rowDisplayColumns(definition).find(
    (column) => column.valueType === "string" && !identities.has(column.id),
  );
  if (labelColumn !== undefined) {
    cells[labelColumn.id] = createUniqueString(document, definition, labelColumn, "新记录");
  }
  return cells;
}

function createDuplicateOperations(
  document: TableDocument,
  sheetId: string,
  definition: TableSheetDefinition,
  source: TableRow,
  newRowId: string,
): readonly TableOperation[] {
  const operations: TableOperation[] = [{
    type: "table.duplicateRow",
    sheetId,
    rowId: source.id,
    newRowId,
  }];
  const identities = identityColumns(definition);
  const values = createUniqueIdentityCells(document, definition, source);
  identities.forEach((column) => {
    const value = values[column.id];
    if (value !== undefined) {
      operations.push({ type: "table.setCell", sheetId, rowId: newRowId, columnId: column.id, value });
    }
  });
  const identityIds = new Set(identities.map((column) => column.id));
  const labelColumn = rowDisplayColumns(definition).find(
    (column) => column.valueType === "string" && !identityIds.has(column.id),
  );
  const label = labelColumn === undefined ? undefined : source.cells[labelColumn.id];
  if (labelColumn !== undefined && typeof label === "string") {
    operations.push({
      type: "table.setCell",
      sheetId,
      rowId: newRowId,
      columnId: labelColumn.id,
      value: createUniqueString(document, definition, labelColumn, `${label}·副本`),
    });
  }
  return operations;
}

function createUniqueIdentityCells(
  document: TableDocument,
  definition: TableSheetDefinition,
  source?: TableRow,
): Record<string, JsonValue> {
  return Object.fromEntries(identityColumns(definition).map((column) => [
    column.id,
    createUniqueValue(document, definition, column, source?.cells[column.id]),
  ]));
}

function identityColumns(definition: TableSheetDefinition): readonly TableColumnDefinition[] {
  const ids = [definition.keyColumnId, definition.partition?.deduplicateByColumnId]
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)].flatMap((id) => {
    const column = resolveTableColumn(definition, id);
    return column === undefined ? [] : [column];
  });
}

function rowDisplayColumns(definition: TableSheetDefinition): readonly TableColumnDefinition[] {
  const ids = [...definition.rowDisplayNamePattern.matchAll(/\{([A-Za-z0-9][A-Za-z0-9._-]{0,127})\}/g)]
    .map((match) => match[1]!)
    .filter((id, index, values) => values.indexOf(id) === index);
  return ids.flatMap((id) => {
    const column = resolveTableColumn(definition, id);
    return column === undefined ? [] : [column];
  });
}

function createUniqueValue(
  document: TableDocument,
  definition: TableSheetDefinition,
  column: TableColumnDefinition,
  sourceValue: JsonValue | undefined,
): JsonValue {
  const values = rowsForDefinition(document, definition)
    .map((row) => row.cells[column.id])
    .filter((value): value is JsonValue => value !== undefined);
  if (column.valueType === "number") {
    const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const maximum = numbers.length === 0 ? Number(column.defaultValue) - 1 : Math.max(...numbers);
    let next = Math.max(maximum + 1, column.editor?.min ?? Number.NEGATIVE_INFINITY);
    if (column.editor?.integer === true) {
      next = Math.ceil(next);
    }
    return next;
  }
  if (column.valueType === "string") {
    const defaultValue = typeof column.defaultValue === "string" ? column.defaultValue : "";
    const base = typeof sourceValue === "string" && sourceValue.length > 0
      ? `${sourceValue}_copy`
      : defaultValue.length > 0 ? defaultValue : "new";
    return createUniqueString(document, definition, column, base);
  }
  return column.defaultValue;
}

function createUniqueString(
  document: TableDocument,
  definition: TableSheetDefinition,
  column: TableColumnDefinition,
  base: string,
): string {
  const used = new Set(rowsForDefinition(document, definition)
    .map((row) => row.cells[column.id])
    .filter((value): value is string => typeof value === "string"));
  if (!used.has(base)) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

function rowsForDefinition(document: TableDocument, definition: TableSheetDefinition): readonly TableRow[] {
  return document.sheets
    .filter((sheet) => sheet.definitionId === definition.id)
    .flatMap((sheet) => sheet.rows);
}

function displayRowName(row: TableRow, definition: TableSheetDefinition): string {
  const name = formatTableRowDisplayName(row.cells, definition).trim();
  return name.length === 0 ? "未命名记录" : name;
}

function tableRecordListEntryKey(entry: TableRecordListEntry): string {
  return entry.row.id;
}

function Diagnostics(props: { readonly diagnostics: readonly DocumentDiagnostic[] }): ReactElement {
  return (
    <ul className="diagnostics">
      {props.diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code}:${diagnostic.path}:${index}`} className={diagnostic.severity}>
          <code>{diagnostic.path}</code> {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}
