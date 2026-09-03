import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type {
  DocumentTypeDefinition,
  ProjectFileIssue,
  ProjectOperation,
  ProjectProviderDefinition,
  VisualBridgeProjectDefinition,
} from "@visualbridge/core";
import {
  CommonIcon,
  EditorShell,
  EditorStatusBar,
  EditorToolbar,
  SaveState,
  ToolbarSpacer,
} from "@visualbridge/editor-ui";
import "../styles.css";

interface VsCodeApi { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;

interface ProjectStateMessage {
  readonly type: "projectState";
  readonly documentVersion: number;
  readonly sourceHash: string;
  readonly project: VisualBridgeProjectDefinition;
  readonly isDirty: boolean;
  readonly issues: readonly ProjectFileIssue[];
}

type HostMessage = ProjectStateMessage | {
  readonly type: "projectInvalid";
  readonly documentVersion: number;
  readonly sourceHash: string;
  readonly isDirty: boolean;
  readonly issues: readonly ProjectFileIssue[];
} | { readonly type: "operationRejected"; readonly message: string }
  | { readonly type: "requestReady"; readonly webviewToken: string };

const rawVscode = acquireVsCodeApi();
const instanceId = crypto.randomUUID();
let webviewToken: string | undefined;
const vscode: VsCodeApi = {
  postMessage(message) {
    rawVscode.postMessage(typeof message === "object" && message !== null && !Array.isArray(message)
      ? { ...message, ...(webviewToken === undefined ? {} : { webviewToken }) }
      : message);
  },
};
const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Project editor root element is missing.");
createRoot(rootElement).render(<ProjectEditorApp />);

function ProjectEditorApp(): ReactElement {
  const [state, setState] = useState<ProjectStateMessage>();
  const [invalid, setInvalid] = useState<Extract<HostMessage, { readonly type: "projectInvalid" }>>();
  const [status, setStatus] = useState("正在加载工程设置…");
  const [pending, setPending] = useState(false);
  const [providerDraft, setProviderDraft] = useState<ProjectProviderDefinition>();

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "requestReady") {
        webviewToken = message.webviewToken;
        vscode.postMessage({ type: "ready", instanceId });
      } else if (message.type === "projectState") {
        setState(message);
        setProviderDraft((draft) => draft !== undefined
          && message.project.providers.some((provider) => provider.id === draft.id)
          ? undefined
          : draft);
        setInvalid(undefined);
        setPending(false);
        setStatus("配置有效");
      } else if (message.type === "projectInvalid") {
        setState(undefined);
        setInvalid(message);
        setPending(false);
        setStatus("工程文件无效");
      } else if (message.type === "operationRejected") {
        setPending(false);
        setStatus(message.message);
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready", instanceId });
    return () => window.removeEventListener("message", listener);
  }, []);

  const submit = (operations: readonly ProjectOperation[]): void => {
    if (state === undefined || pending) return;
    setPending(true);
    setStatus("正在验证并应用…");
    vscode.postMessage({
      type: "applyOperations",
      documentVersion: state.documentVersion,
      sourceHash: state.sourceHash,
      operations,
    });
  };

  if (state === undefined) {
    return <main className="loading"><h1>VisualBridge 工程设置</h1><p>{status}</p><IssueList issues={invalid?.issues ?? []} /></main>;
  }
  const project = state.project;
  return <EditorShell className="project-app">
    <EditorToolbar className="toolbar">
      <strong>工程设置</strong>
      <ToolbarSpacer />
      <SaveState dirty={state.isDirty} pending={pending} pendingLabel="正在修改" />
    </EditorToolbar>
    <main className="scroll">
      <section className="settings-section general">
        <SectionTitle title="常规" />
        <LabeledInput label="工程 ID" value={project.projectId} disabled={pending} onCommit={(projectId) => submit([{ type: "project.setProjectId", projectId }])} />
        <StringList label="文档根目录" values={project.documentRoots} disabled={pending} group="document-roots" placeholder="Config" onCommit={(documentRoots) => submit([{ type: "project.setDocumentRoots", documentRoots }])} />
      </section>

      <section className="settings-section">
        <SectionTitle title="文档类型" count={project.documentTypes.length} onAdd={() => submit([{
          type: "project.upsertDocumentType",
          documentType: createDocumentType(project),
        }])} disabled={pending} />
        <DragDropProvider onDragEnd={(event) => {
          if (event.canceled) return;
          const { source } = event.operation;
          if (isSortable(source) && source.initialIndex !== source.index) {
            const item = project.documentTypes[source.initialIndex];
            if (item !== undefined) submit([{ type: "project.moveDocumentType", documentTypeId: item.id, toIndex: source.index }]);
          }
        }}>
          <div className="card-list">
            {project.documentTypes.map((documentType, index) => <DocumentTypeCard key={documentType.id} documentType={documentType} index={index} disabled={pending} submit={submit} />)}
          </div>
        </DragDropProvider>
      </section>

      <section className="settings-section">
        <SectionTitle title="表格布局" />
        <label className="toggle"><input type="checkbox" checked={project.tableLayout !== undefined} disabled={pending} onChange={(event) => submit([event.currentTarget.checked
          ? { type: "project.setTableLayout", tableLayout: { nameKeyRow: 2, dataStartRow: 3 } }
          : { type: "project.clearTableLayout" }])} />启用工程级表头布局</label>
        {project.tableLayout !== undefined && <div className="grid two">
          <NumberInput label="名称键行" value={project.tableLayout.nameKeyRow} disabled={pending} onCommit={(nameKeyRow) => submit([{ type: "project.setTableLayout", tableLayout: { ...project.tableLayout!, nameKeyRow } }])} />
          <NumberInput label="数据起始行" value={project.tableLayout.dataStartRow} disabled={pending} onCommit={(dataStartRow) => submit([{ type: "project.setTableLayout", tableLayout: { ...project.tableLayout!, dataStartRow } }])} />
        </div>}
      </section>

      <section className="settings-section">
        <SectionTitle
          title="工程提供器"
          count={project.providers.length + (providerDraft === undefined ? 0 : 1)}
          onAdd={() => setProviderDraft(createProvider(project))}
          disabled={pending || providerDraft !== undefined}
        />
        <DragDropProvider onDragEnd={(event) => {
          if (event.canceled) return;
          const { source } = event.operation;
          if (isSortable(source) && source.initialIndex !== source.index) {
            const item = project.providers[source.initialIndex];
            if (item !== undefined) submit([{ type: "project.moveProvider", providerId: item.id, toIndex: source.index }]);
          }
        }}>
          <div className="card-list">
            {project.providers.map((provider, index) => <ProviderCard key={provider.id} provider={provider} index={index} disabled={pending} submit={submit} />)}
            {providerDraft !== undefined && <ProviderDraftCard
              provider={providerDraft}
              disabled={pending}
              onChange={setProviderDraft}
              onCancel={() => setProviderDraft(undefined)}
              onSave={(provider) => submit([{ type: "project.addProvider", provider }])}
            />}
          </div>
        </DragDropProvider>
      </section>
      <IssueList issues={state.issues} />
    </main>
    <EditorStatusBar className="status"><span>{status}</span><span>{state.issues.length} 个问题</span></EditorStatusBar>
  </EditorShell>;
}

function DocumentTypeCard(props: {
  readonly documentType: DocumentTypeDefinition;
  readonly index: number;
  readonly disabled: boolean;
  readonly submit: (operations: readonly ProjectOperation[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.documentType);
  useEffect(() => setDraft(props.documentType), [props.documentType]);
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({
    id: props.documentType.id,
    index: props.index,
    group: "project-document-types",
    type: "project-document-type",
    accept: "project-document-type",
    disabled: props.disabled,
  });
  const commit = (next: DocumentTypeDefinition): void => props.submit([
    ...(next.id === props.documentType.id ? [] : [{
      type: "project.renameDocumentType" as const,
      documentTypeId: props.documentType.id,
      newId: next.id,
    }]),
    { type: "project.upsertDocumentType", documentType: next },
  ]);
  return <article ref={ref} className={`settings-card${isDragging ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}>
    <header className="card-header">
      <button ref={handleRef} className="icon secondary drag" title="拖动排序" aria-label="拖动文档类型"><CommonIcon name="drag" /></button>
      <strong>{props.documentType.id}</strong><span className="tag">{props.documentType.editor}</span><span className="spacer" />
      <button className="icon danger" title="删除文档类型" aria-label="删除文档类型" disabled={props.disabled} onClick={() => props.submit([{ type: "project.removeDocumentType", documentTypeId: props.documentType.id }])}><CommonIcon name="delete" /></button>
    </header>
    <div className="card-body">
      <div className="grid two">
        <LabeledInput label="ID" value={draft.id} disabled={props.disabled} onChange={(id) => setDraft({ ...draft, id })} onCommit={(id) => commit({ ...draft, id })} />
        <LabeledInput label="编辑器" value={draft.editor} disabled={props.disabled} list="visualbridge-editors" onChange={(editor) => setDraft({ ...draft, editor })} onCommit={(editor) => commit({ ...draft, editor })} />
      </div>
      <StringList label="包含" values={draft.include} disabled={props.disabled} group={`${props.documentType.id}-include`} placeholder="Config/**/*.custom" onCommit={(include) => { const next = { ...draft, include }; setDraft(next); commit(next); }} />
      <StringList label="排除" values={draft.exclude} disabled={props.disabled} group={`${props.documentType.id}-exclude`} placeholder="Config/**/Generated/**" allowEmpty onCommit={(exclude) => { const next = { ...draft, exclude }; setDraft(next); commit(next); }} />
      <StringList label="目录" values={draft.catalogs} disabled={props.disabled} group={`${props.documentType.id}-catalogs`} placeholder="Catalog/Game.vbcatalog" allowEmpty onCommit={(catalogs) => { const next = { ...draft, catalogs }; setDraft(next); commit(next); }} />
      <datalist id="visualbridge-editors"><option value="graph" /><option value="entity" /><option value="structured" /><option value="table" /></datalist>
    </div>
  </article>;
}

function ProviderCard(props: {
  readonly provider: ProjectProviderDefinition;
  readonly index: number;
  readonly disabled: boolean;
  readonly submit: (operations: readonly ProjectOperation[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.provider);
  useEffect(() => setDraft(props.provider), [props.provider]);
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({
    id: props.provider.id,
    index: props.index,
    group: "project-providers",
    type: "project-provider",
    accept: "project-provider",
    disabled: props.disabled,
  });
  const commit = (next: ProjectProviderDefinition): void => props.submit([
    ...(next.id === props.provider.id ? [] : [{
      type: "project.renameProvider" as const,
      providerId: props.provider.id,
      newId: next.id,
    }]),
    { type: "project.upsertProvider", provider: next },
  ]);
  const update = (next: ProjectProviderDefinition): void => { setDraft(next); commit(next); };
  return <article ref={ref} className={`settings-card${isDragging ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}>
    <header className="card-header">
      <button ref={handleRef} className="icon secondary drag" title="拖动排序" aria-label="拖动提供器"><CommonIcon name="drag" /></button>
      <strong>{props.provider.id}</strong><span className="spacer" />
      <button className="icon danger" title="删除提供器" aria-label="删除提供器" disabled={props.disabled} onClick={() => props.submit([{ type: "project.removeProvider", providerId: props.provider.id }])}><CommonIcon name="delete" /></button>
    </header>
    <div className="card-body">
      <div className="grid two">
        <LabeledInput label="ID" value={draft.id} disabled={props.disabled} onChange={(id) => setDraft({ ...draft, id })} onCommit={(id) => commit({ ...draft, id })} />
        <LabeledInput label="入口 (.mjs)" value={draft.entry} disabled={props.disabled} onChange={(entry) => setDraft({ ...draft, entry })} onCommit={(entry) => commit({ ...draft, entry })} />
      </div>
      <StringList label="参数" values={draft.args} disabled={props.disabled} group={`${props.provider.id}-args`} placeholder="--flag" allowEmpty onCommit={(args) => update({ ...draft, args })} />
      <StringList label="引用类型" values={draft.capabilities.reference?.kinds ?? []} disabled={props.disabled} group={`${props.provider.id}-references`} placeholder="game.asset" allowEmpty onCommit={(kinds) => update({ ...draft, capabilities: withReferenceKinds(draft, kinds) })} />
      <StringList label="校验器文档类型" values={draft.capabilities.validator?.documentTypes ?? []} disabled={props.disabled} group={`${props.provider.id}-validators`} placeholder="game.settings" allowEmpty onCommit={(documentTypes) => update({ ...draft, capabilities: withValidatorTypes(draft, documentTypes) })} />
    </div>
  </article>;
}

function ProviderDraftCard(props: {
  readonly provider: ProjectProviderDefinition;
  readonly disabled: boolean;
  readonly onChange: (provider: ProjectProviderDefinition) => void;
  readonly onCancel: () => void;
  readonly onSave: (provider: ProjectProviderDefinition) => void;
}): ReactElement {
  const draft = props.provider;
  return <article className="settings-card draft-card">
    <header className="card-header">
      <span className="draft-spacer" aria-hidden="true" />
      <strong>新建提供器</strong><span className="tag">草稿</span><span className="spacer" />
      <button className="icon secondary" title="保存提供器" aria-label="保存提供器" disabled={props.disabled} onClick={() => props.onSave(draft)}><CommonIcon name="check" /></button>
      <button className="icon ghost" title="取消新增提供器" aria-label="取消新增提供器" disabled={props.disabled} onClick={props.onCancel}><CommonIcon name="close" /></button>
    </header>
    <div className="card-body">
      <div className="grid two">
        <LabeledInput label="ID" value={draft.id} disabled={props.disabled} onChange={(id) => props.onChange({ ...draft, id })} onCommit={() => undefined} />
        <LabeledInput label="入口 (.mjs)" value={draft.entry} disabled={props.disabled} onChange={(entry) => props.onChange({ ...draft, entry })} onCommit={() => undefined} />
      </div>
      <StringList label="参数" values={draft.args} disabled={props.disabled} group={`${draft.id}-draft-args`} placeholder="--flag" allowEmpty onCommit={(args) => props.onChange({ ...draft, args })} />
      <StringList label="引用类型" values={draft.capabilities.reference?.kinds ?? []} disabled={props.disabled} group={`${draft.id}-draft-references`} placeholder="game.asset" allowEmpty onCommit={(kinds) => props.onChange({ ...draft, capabilities: withReferenceKinds(draft, kinds) })} />
      <StringList label="校验器文档类型" values={draft.capabilities.validator?.documentTypes ?? []} disabled={props.disabled} group={`${draft.id}-draft-validators`} placeholder="game.settings" allowEmpty onCommit={(documentTypes) => props.onChange({ ...draft, capabilities: withValidatorTypes(draft, documentTypes) })} />
    </div>
  </article>;
}

function StringList(props: {
  readonly label: string;
  readonly values: readonly string[];
  readonly disabled: boolean;
  readonly group: string;
  readonly placeholder: string;
  readonly allowEmpty?: boolean;
  readonly onCommit: (values: readonly string[]) => void;
}): ReactElement {
  return <div className="string-list">
    <div className="list-heading"><span>{props.label}</span><button className="icon secondary" title={`添加 ${props.label}`} aria-label={`添加 ${props.label}`} disabled={props.disabled} onClick={() => props.onCommit([...props.values, props.placeholder])}><CommonIcon name="add" /></button></div>
    <DragDropProvider onDragEnd={(event) => {
      if (event.canceled) return;
      const { source } = event.operation;
      if (isSortable(source) && source.initialIndex !== source.index) props.onCommit(move(props.values, source.initialIndex, source.index));
    }}>
      <div className="string-items">
        {props.values.map((value, index) => <StringItem key={`${index}:${value}`} value={value} index={index} group={props.group} disabled={props.disabled} onCommit={(next) => props.onCommit(props.values.map((entry, entryIndex) => entryIndex === index ? next : entry))} onRemove={() => {
          if (!props.allowEmpty && props.values.length === 1) return;
          props.onCommit(props.values.filter((_, entryIndex) => entryIndex !== index));
        }} />)}
      </div>
    </DragDropProvider>
  </div>;
}

function StringItem(props: { readonly value: string; readonly index: number; readonly group: string; readonly disabled: boolean; readonly onCommit: (value: string) => void; readonly onRemove: () => void }): ReactElement {
  const [value, setValue] = useState(props.value);
  useEffect(() => setValue(props.value), [props.value]);
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({ id: `${props.group}:${props.index}`, index: props.index, group: props.group, type: props.group, accept: props.group, disabled: props.disabled });
  return <div ref={ref} className={`string-item${isDragging ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}>
    <button ref={handleRef} className="icon ghost drag" title="拖动排序" aria-label="拖动排序"><CommonIcon name="drag" /></button>
    <input value={value} disabled={props.disabled} onChange={(event) => setValue(event.currentTarget.value)} onBlur={() => { if (value !== props.value) props.onCommit(value); }} />
    <button className="icon ghost danger" title="删除" aria-label="删除" disabled={props.disabled} onClick={props.onRemove}><CommonIcon name="delete" /></button>
  </div>;
}

function SectionTitle(props: { readonly title: string; readonly count?: number; readonly onAdd?: () => void; readonly disabled?: boolean }): ReactElement {
  return <div className="section-title"><h2>{props.title}</h2>{props.count !== undefined && <span className="count">{props.count}</span>}<span className="spacer" />{props.onAdd !== undefined && <button className="icon secondary" title={`添加 ${props.title}`} aria-label={`添加 ${props.title}`} disabled={props.disabled} onClick={props.onAdd}><CommonIcon name="add" /></button>}</div>;
}

function LabeledInput(props: { readonly label: string; readonly value: string; readonly disabled: boolean; readonly list?: string; readonly onChange?: (value: string) => void; readonly onCommit: (value: string) => void }): ReactElement {
  const [value, setValue] = useState(props.value);
  useEffect(() => setValue(props.value), [props.value]);
  return <label className="field"><span>{props.label}</span><input value={value} list={props.list} disabled={props.disabled} onChange={(event) => { setValue(event.currentTarget.value); props.onChange?.(event.currentTarget.value); }} onBlur={() => { if (value !== props.value) props.onCommit(value); }} /></label>;
}

function NumberInput(props: { readonly label: string; readonly value: number; readonly disabled: boolean; readonly onCommit: (value: number) => void }): ReactElement {
  return <label className="field"><span>{props.label}</span><input type="number" min={1} value={props.value} disabled={props.disabled} onChange={(event) => props.onCommit(Number(event.currentTarget.value))} /></label>;
}

function IssueList(props: { readonly issues: readonly ProjectFileIssue[] }): ReactElement {
  return props.issues.length === 0 ? <></> : <section className="issues"><h2>校验</h2><ul>{props.issues.map((issue, index) => <li key={`${issue.path}:${index}`}><code>{issue.path}</code> {issue.message}</li>)}</ul></section>;
}

function createDocumentType(project: VisualBridgeProjectDefinition): DocumentTypeDefinition {
  let index = project.documentTypes.length + 1;
  while (project.documentTypes.some((entry) => entry.id === `document.type.${index}`)) index += 1;
  return { id: `document.type.${index}`, editor: "structured", include: [`Config/**/*.type${index}`], exclude: [], catalogs: [] };
}

function createProvider(project: VisualBridgeProjectDefinition): ProjectProviderDefinition {
  let index = project.providers.length + 1;
  while (project.providers.some((entry) => entry.id === `project.provider.${index}`)) index += 1;
  return { id: `project.provider.${index}`, entry: `Providers/provider-${index}.mjs`, args: [], capabilities: { reference: { kinds: [`custom.reference.${index}`] } } };
}

function withReferenceKinds(
  provider: ProjectProviderDefinition,
  kinds: readonly string[],
): ProjectProviderDefinition["capabilities"] {
  return {
    ...(kinds.length === 0 ? {} : { reference: { kinds } }),
    ...(provider.capabilities.validator === undefined ? {} : { validator: provider.capabilities.validator }),
  };
}

function withValidatorTypes(
  provider: ProjectProviderDefinition,
  documentTypes: readonly string[],
): ProjectProviderDefinition["capabilities"] {
  return {
    ...(provider.capabilities.reference === undefined ? {} : { reference: provider.capabilities.reference }),
    ...(documentTypes.length === 0 ? {} : { validator: { documentTypes } }),
  };
}

function move<T>(values: readonly T[], from: number, to: number): T[] {
  const result = [...values];
  const [entry] = result.splice(from, 1);
  if (entry !== undefined) result.splice(to, 0, entry);
  return result;
}
