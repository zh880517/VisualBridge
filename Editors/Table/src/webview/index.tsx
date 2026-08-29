import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@base-ui/react/button";
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import { CommonIcon, FieldsEditor, IconButton } from "@visualbridge/form-editor";
import {
  encodeTableCell,
  formatTableRowDisplayName,
  resolveTableColumn,
  resolveTableSheet,
  type TableColumnDefinition,
  type TableDocument,
  type TableOperation,
  type TableRow,
  type TableSheetDefinition,
  type TableTypeDefinition,
} from "@visualbridge/table/webview";
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
  const filteredRows = useMemo(
    () => sheet === undefined || definition === undefined
      ? []
      : sheet.rows.filter((row) => matchesQuery(row, definition, query)),
    [definition, query, sheet],
  );
  const selectedRow = sheet?.rows.find((row) => row.id === selectedRowId);
  const selectedIndex = selectedRow === undefined || sheet === undefined ? -1 : sheet.rows.indexOf(selectedRow);

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

  if (state === undefined) {
    return (
      <main className="table-loading">
        <h1>VisualBridge Table</h1>
        <p>{status}</p>
        {invalid !== undefined && <Diagnostics diagnostics={invalid.diagnostics} />}
      </main>
    );
  }

  return (
    <div className="table-app">
      <header className="table-toolbar">
        <SaveState dirty={state.isDirty} pending={pending} />
        <span className="table-path">{rootElement!.dataset.relativePath}</span>
        <IconButton
          className="secondary"
          icon="add"
          label="新增记录"
          title="新增记录"
          disabled={pending || sheet === undefined || definition === undefined}
          onClick={() => {
            if (sheet === undefined || definition === undefined) {
              return;
            }
            const rowId = `row_${crypto.randomUUID()}`;
            setSelectedRowId(rowId);
            submit([{
              type: "table.insertRow",
              sheetId: sheet.id,
              rowId,
              cells: createNewRowCells(state.document, definition),
            }]);
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
              setQuery("");
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
            <aside className="record-list">
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
              <div className="record-scroll">
                {filteredRows.map((row) => {
                  const sourceIndex = sheet.rows.indexOf(row);
                  return (
                    <Button
                      key={row.id}
                      className={`record-item${row.id === selectedRow?.id ? " active" : ""}${row.changedColumnIds.length > 0 ? " changed" : ""}`}
                      aria-pressed={row.id === selectedRow?.id}
                      onClick={() => setSelectedRowId(row.id)}
                    >
                      <strong className="record-name">{displayRowName(row, definition)}</strong>
                      <span className="record-meta">{row.sourceRowNumber === undefined ? "新增记录" : `第 ${sourceIndex + 1} 条`}</span>
                    </Button>
                  );
                })}
                {filteredRows.length === 0 && <p className="record-empty">没有匹配的记录</p>}
              </div>
            </aside>
            <section className="record-editor">
              {selectedRow === undefined
                ? <p className="record-editor-empty">从左侧选择一条记录开始编辑。</p>
                : (
                  <>
                    <header className="record-editor-header">
                      <h1>{displayRowName(selectedRow, definition)}</h1>
                      <div className="record-actions">
                        <IconButton
                          className="secondary"
                          icon="moveUp"
                          label="上移记录"
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
                          label="下移记录"
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
                          label="复制记录"
                          title="复制"
                          disabled={pending}
                          onClick={() => {
                            const rowId = `row_${crypto.randomUUID()}`;
                            setSelectedRowId(rowId);
                            submit(createDuplicateOperations(state.document, sheet.id, definition, selectedRow, rowId));
                          }}
                        />
                        <IconButton
                          className="secondary danger-text"
                          icon="delete"
                          label="删除记录"
                          title="删除"
                          disabled={pending}
                          onClick={() => submit([{
                            type: "table.removeRow",
                            sheetId: sheet.id,
                            rowId: selectedRow.id,
                          }])}
                        />
                      </div>
                    </header>
                    <div className="record-fields">
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
                    </div>
                  </>
                )}
            </section>
          </main>
        )}
      <footer className="table-status">
        <span>{status}</span>
        <span>{state.diagnostics.length === 0 ? "校验通过" : `${state.diagnostics.length} 个诊断`}</span>
      </footer>
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

function matchesQuery(row: TableRow, definition: TableSheetDefinition, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const haystack = [
    displayRowName(row, definition),
    ...definition.columns.map((column) => formatCellValue(row.cells[column.id], column)),
  ].join(" ").toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function displayRowName(row: TableRow, definition: TableSheetDefinition): string {
  const name = formatTableRowDisplayName(row.cells, definition).trim();
  return name.length === 0 ? "未命名记录" : name;
}

function formatCellValue(value: JsonValue | undefined, column: TableColumnDefinition): string {
  if (value === undefined) {
    return "";
  }
  try {
    return encodeTableCell(value, column);
  } catch {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
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
