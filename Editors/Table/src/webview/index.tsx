import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@base-ui/react/button";
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import { CommonIcon, FieldsEditor, IconButton } from "@visualbridge/form-editor";
import {
  encodeTableCell,
  resolveTableColumn,
  resolveTableSheet,
  type TableColumnDefinition,
  type TableDocument,
  type TableOperation,
  type TableRow,
  type TableSheet,
  type TableSheetDefinition,
  type TableTypeDefinition,
} from "@visualbridge/table/webview";
import { DataGrid, type Column, type RenderEditCellProps, type RowsChangeData } from "react-data-grid";
import "react-data-grid/lib/styles.css";
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

type HostMessage = TableStateMessage | TableInvalidMessage | {
  readonly type: "operationRejected";
  readonly message: string;
} | {
  readonly type: "operationCompleted";
  readonly changed: boolean;
};

interface GridRow {
  readonly __rowId: string;
  readonly __sourceIndex: number;
  readonly [key: string]: JsonValue | string | number;
}

const vscode = acquireVsCodeApi();
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Table editor root element is missing.");
}
createRoot(rootElement).render(<TableEditorApp />);

function TableEditorApp(): ReactElement {
  const [state, setState] = useState<TableStateMessage>();
  const [invalid, setInvalid] = useState<TableInvalidMessage>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("正在加载 Table Document…");
  const [sheetId, setSheetId] = useState<string>();
  const [selectedRowId, setSelectedRowId] = useState<string>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "tableState") {
        setState(message);
        setInvalid(undefined);
        setPending(false);
        setStatus("就绪");
        setSheetId((current) => message.document.sheets.some((sheet) => sheet.id === current)
          ? current
          : message.document.sheets[0]?.id);
      } else if (message.type === "tableInvalid") {
        setInvalid(message);
        setState(undefined);
        setPending(false);
        setStatus("Table Document 无效");
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
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const submit = (operations: readonly TableOperation[]): void => {
    if (state === undefined || pending || operations.length === 0) {
      return;
    }
    setPending(true);
    setStatus("正在应用修改…");
    vscode.postMessage({ type: "applyOperations", revision: state.revision, operations });
  };

  if (state === undefined) {
    return (
      <main className="table-loading">
        <h1>VisualBridge Table</h1>
        <p>{status}</p>
        {invalid !== undefined && <Diagnostics diagnostics={invalid.diagnostics} />}
      </main>
    );
  }

  const sheet = state.document.sheets.find((candidate) => candidate.id === sheetId) ?? state.document.sheets[0];
  const definition = sheet === undefined ? undefined : resolveTableSheet(state.tableType, sheet.definitionId);
  const selectedRow = sheet?.rows.find((row) => row.id === selectedRowId);
  const selectedIndex = selectedRow === undefined ? -1 : sheet!.rows.indexOf(selectedRow);
  return (
    <div className="table-app">
      <header className="table-toolbar">
        <SaveState dirty={state.isDirty} pending={pending} />
        <span className="table-path">{rootElement!.dataset.relativePath}</span>
        <div className="table-search-wrap">
          <CommonIcon name="search" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索当前分表"
            aria-label="搜索当前分表"
          />
        </div>
        <IconButton
          className="secondary"
          icon="add"
          label="新增行"
          title="新增行"
          disabled={pending || sheet === undefined}
          onClick={() => {
            if (sheet !== undefined) {
              submit([{ type: "table.insertRow", sheetId: sheet.id, rowId: `row_${crypto.randomUUID()}` }]);
            }
          }}
        />
      </header>
      <nav className="sheet-tabs" aria-label="表格分表">
        {state.document.sheets.map((candidate) => (
          <Button
            key={candidate.id}
            className={candidate.id === sheet?.id ? "sheet-tab active" : "sheet-tab"}
            aria-pressed={candidate.id === sheet?.id}
            onClick={() => {
              setSheetId(candidate.id);
              setSelectedRowId(undefined);
            }}
          >
            {candidate.name}
            <span>{candidate.rows.length}</span>
          </Button>
        ))}
      </nav>
      {sheet === undefined || definition === undefined
        ? <main className="table-loading"><p>Catalog 中没有可编辑的分表定义。</p></main>
        : (
          <main className="table-workspace">
            <section className="table-grid-panel">
              <TableGrid
                sheet={sheet}
                definition={definition}
                query={query}
                pending={pending}
                selectedRowId={selectedRowId}
                onSelectRow={setSelectedRowId}
                submit={submit}
              />
            </section>
            <aside className="row-inspector">
              <header className="row-inspector-header">
                <div>
                  <span className="eyebrow">Row Inspector</span>
                  <h2>{selectedRow === undefined ? "选择一行" : rowLabel(selectedRow, definition)}</h2>
                </div>
                {selectedRow !== undefined && (
                  <div className="row-actions">
                    <IconButton
                      className="secondary"
                      icon="moveUp"
                      label="上移行"
                      title="上移"
                      disabled={pending || selectedIndex <= 0}
                      onClick={() => submit([{
                        type: "table.moveRow",
                        sheetId: sheet.id,
                        rowId: selectedRow.id,
                        index: selectedIndex - 1,
                      }])}
                    />
                    <IconButton
                      className="secondary"
                      icon="moveDown"
                      label="下移行"
                      title="下移"
                      disabled={pending || selectedIndex < 0 || selectedIndex >= sheet.rows.length - 1}
                      onClick={() => submit([{
                        type: "table.moveRow",
                        sheetId: sheet.id,
                        rowId: selectedRow.id,
                        index: selectedIndex + 1,
                      }])}
                    />
                    <IconButton
                      className="secondary"
                      icon="copy"
                      label="复制行"
                      title="复制"
                      disabled={pending}
                      onClick={() => submit([{
                        type: "table.duplicateRow",
                        sheetId: sheet.id,
                        rowId: selectedRow.id,
                        newRowId: `row_${crypto.randomUUID()}`,
                      }])}
                    />
                    <IconButton
                      className="secondary danger-text"
                      icon="delete"
                      label="删除行"
                      title="删除"
                      disabled={pending}
                      onClick={() => submit([{
                        type: "table.removeRow",
                        sheetId: sheet.id,
                        rowId: selectedRow.id,
                      }])}
                    />
                  </div>
                )}
              </header>
              {selectedRow === undefined
                ? <p className="row-empty">在左侧表格中选择一行；数组和普通 C# 结构在这里使用共享字段编辑器修改。</p>
                : (
                  <FieldsEditor
                    definitions={definition.columns}
                    properties={selectedRow.cells}
                    disabled={pending}
                    onCommit={(columnId, value) => submit([{
                      type: "table.setCell",
                      sheetId: sheet.id,
                      rowId: selectedRow.id,
                      columnId,
                      value,
                    }])}
                  />
                )}
            </aside>
          </main>
        )}
      <footer className="table-status">
        <span>{status}</span>
        <span>{state.diagnostics.filter((item) => item.severity === "error").length} 错误 · {state.diagnostics.filter((item) => item.severity === "warning").length} 警告</span>
      </footer>
    </div>
  );
}

function TableGrid(props: {
  readonly sheet: TableSheet;
  readonly definition: TableSheetDefinition;
  readonly query: string;
  readonly pending: boolean;
  readonly selectedRowId: string | undefined;
  readonly onSelectRow: (rowId: string) => void;
  readonly submit: (operations: readonly TableOperation[]) => void;
}): ReactElement {
  const rows = useMemo(() => props.sheet.rows.map((row, index) => toGridRow(row, index))
    .filter((row) => matchesQuery(row, props.definition, props.query)), [props.sheet, props.definition, props.query]);
  const columns = useMemo<readonly Column<GridRow>[]>(() => [
    {
      key: "__sourceIndex",
      name: "#",
      width: 56,
      frozen: true,
      resizable: false,
      renderCell: ({ row }) => <span className="row-number">{Number(row.__sourceIndex) + 1}</span>,
    },
    ...props.definition.columns.map((column): Column<GridRow> => ({
      key: column.id,
      name: <ColumnHeader column={column} />,
      width: column.valueType === "string" ? 190 : column.valueType === "array" || column.valueType === "object" ? 230 : 120,
      minWidth: 90,
      resizable: true,
      editable: !props.pending && column.editor?.readOnly !== true && isInlineEditable(column),
      renderCell: ({ row }) => <span title={formatCellValue(row[column.id], column)}>{formatCellValue(row[column.id], column)}</span>,
      ...(isInlineEditable(column) ? { renderEditCell: (editorProps) => <CellEditor {...editorProps} columnDefinition={column} /> } : {}),
    })),
  ], [props.definition, props.pending]);

  const handleRowsChange = (nextRows: GridRow[], data: RowsChangeData<GridRow>): void => {
    if (data.column.key.startsWith("__")) {
      return;
    }
    const operations = data.indexes.flatMap((index): TableOperation[] => {
      const row = nextRows[index];
      const value = row?.[data.column.key];
      return row === undefined || !isJsonValue(value) ? [] : [{
        type: "table.setCell",
        sheetId: props.sheet.id,
        rowId: row.__rowId,
        columnId: data.column.key,
        value,
      }];
    });
    props.submit(operations);
  };
  return (
    <DataGrid<GridRow>
      className="rdg-light table-grid"
      aria-label={props.sheet.title}
      columns={columns}
      rows={rows}
      rowKeyGetter={(row) => row.__rowId}
      onRowsChange={handleRowsChange}
      onCellClick={({ row }) => props.onSelectRow(row.__rowId)}
      rowClass={(row) => row.__rowId === props.selectedRowId ? "selected-row" : undefined}
      defaultColumnOptions={{ resizable: true }}
    />
  );
}

function ColumnHeader(props: { readonly column: TableColumnDefinition }): ReactElement {
  const showPhysicalName = props.column.title.trim().toLocaleLowerCase()
    !== props.column.nameKey.trim().toLocaleLowerCase();
  return (
    <span className="column-header" title={props.column.description}>
      <strong>{props.column.title}</strong>
      {showPhysicalName && <small>{props.column.nameKey}</small>}
    </span>
  );
}

function CellEditor(props: RenderEditCellProps<GridRow> & {
  readonly columnDefinition: TableColumnDefinition;
}): ReactElement {
  const value = props.row[props.column.key];
  const options = props.columnDefinition.editor?.options ?? [];
  if (props.columnDefinition.editor?.kind === "select") {
    return (
      <select
        autoFocus
        className="rdg-text-editor"
        value={JSON.stringify(value)}
        onChange={(event) => props.onRowChange({
          ...props.row,
          [props.column.key]: JSON.parse(event.target.value) as JsonValue,
        }, true)}
      >
        {options.map((option) => <option key={JSON.stringify(option.value)} value={JSON.stringify(option.value)}>{option.title}</option>)}
      </select>
    );
  }
  if (props.columnDefinition.valueType === "boolean") {
    return (
      <select
        autoFocus
        className="rdg-text-editor"
        value={value === true ? "true" : "false"}
        onChange={(event) => props.onRowChange({ ...props.row, [props.column.key]: event.target.value === "true" }, true)}
      >
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }
  return (
    <input
      autoFocus
      className="rdg-text-editor"
      type={props.columnDefinition.valueType === "number" ? "number" : "text"}
      value={typeof value === "string" || typeof value === "number" ? value : ""}
      min={props.columnDefinition.editor?.min}
      max={props.columnDefinition.editor?.max}
      step={props.columnDefinition.editor?.step}
      onChange={(event) => props.onRowChange({
        ...props.row,
        [props.column.key]: props.columnDefinition.valueType === "number"
          ? Number(event.target.value)
          : event.target.value,
      })}
      onBlur={() => props.onClose(true)}
    />
  );
}

function toGridRow(row: TableRow, sourceIndex: number): GridRow {
  return { __rowId: row.id, __sourceIndex: sourceIndex, ...row.cells };
}

function matchesQuery(row: GridRow, definition: TableSheetDefinition, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const haystack = definition.columns.map((column) => formatCellValue(row[column.id], column)).join(" ").toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function isInlineEditable(column: TableColumnDefinition): boolean {
  return column.valueType === "string" || column.valueType === "number" || column.valueType === "boolean";
}

function formatCellValue(value: unknown, column: TableColumnDefinition): string {
  if (!isJsonValue(value)) {
    return "";
  }
  try {
    return encodeTableCell(value, column);
  } catch {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
}

function rowLabel(row: TableRow, definition: TableSheetDefinition): string {
  const keyColumn = definition.keyColumnId === undefined ? undefined : resolveTableColumn(definition, definition.keyColumnId);
  if (keyColumn === undefined) {
    return row.id;
  }
  const value = row.cells[keyColumn.id];
  return value === undefined ? row.id : `#${formatCellValue(value, keyColumn)}`;
}

function SaveState(props: { readonly dirty: boolean; readonly pending: boolean }): ReactElement {
  const label = props.pending ? "修改中" : props.dirty ? "未保存" : "已保存";
  return <span className={`table-save-state${props.dirty ? " dirty" : ""}${props.pending ? " pending" : ""}`}><i />{label}</span>;
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}
