import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { DocumentDiagnostic } from "@visualbridge/core";
import type {
  EntityCatalogRegistry,
  EntityComponentInstance,
  EntityDocument,
  EntityOperation,
  RegisteredEntityComponentGroupDefinition,
  RegisteredEntityComponentTypeDefinition,
  RegisteredEntityTypeDefinition,
} from "@visualbridge/entity";
import { FieldsEditor } from "@visualbridge/form-editor";
import "../styles.css";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface EntityStateMessage {
  readonly type: "entityState";
  readonly documentVersion: number;
  readonly document: EntityDocument;
  readonly catalogRegistry: EntityCatalogRegistry;
  readonly catalogReady: boolean;
  readonly addableComponentTypeIds: readonly string[];
  readonly isDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface EntityInvalidMessage {
  readonly type: "entityInvalid";
  readonly documentVersion: number;
  readonly isDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

type HostMessage = EntityStateMessage | EntityInvalidMessage | {
  readonly type: "operationRejected";
  readonly message: string;
} | {
  readonly type: "operationCompleted";
  readonly changed: boolean;
  readonly documentVersion: number;
};

const vscode = acquireVsCodeApi();
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Entity editor root element is missing.");
}

createRoot(rootElement).render(<EntityEditorApp />);

function EntityEditorApp(): ReactElement {
  const [state, setState] = useState<EntityStateMessage>();
  const [invalid, setInvalid] = useState<EntityInvalidMessage>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("正在加载 Entity Document…");
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "entityState") {
        setState(message);
        setInvalid(undefined);
        setPending(false);
        setStatus(message.catalogReady ? "就绪" : "Catalog 未就绪，只能查看已保存内容");
      } else if (message.type === "entityInvalid") {
        setInvalid(message);
        setState(undefined);
        setPending(false);
        setStatus("Entity Document 无效");
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

  const submit = (operations: readonly EntityOperation[]): void => {
    if (state === undefined || pending) {
      return;
    }
    setPending(true);
    setStatus("正在应用修改…");
    vscode.postMessage({ type: "applyOperations", documentVersion: state.documentVersion, operations });
  };

  if (state === undefined) {
    return (
      <main className="entity-loading">
        <h1>VisualBridge Entity</h1>
        <p>{status}</p>
        {invalid !== undefined && <Diagnostics diagnostics={invalid.diagnostics} />}
      </main>
    );
  }

  const entityType = resolveEntityType(state.catalogRegistry, state.document.entityTypeId);
  return (
    <div className="entity-app">
      <header className="entity-toolbar">
        <SaveState dirty={state.isDirty} pending={pending} />
        <span className="entity-path">{rootElement!.dataset.relativePath}</span>
        <span className="entity-toolbar-spacer" />
        <span className="entity-type-label">{entityType?.title ?? state.document.entityTypeId}</span>
      </header>
      <div className="entity-scroll">
        <div className="entity-content">
          <section className="entity-card entity-header-card">
            <div className="entity-card-heading">
              <div>
                <span className="eyebrow">Entity</span>
                <TitleEditor
                  title={state.document.title}
                  disabled={pending}
                  onCommit={(title) => submit([{ type: "entity.setTitle", title }])}
                />
                <p>{entityType?.description ?? state.document.entityTypeId}</p>
              </div>
              <code>{state.document.documentId}</code>
            </div>
            {entityType === undefined
              ? <UnknownTypeNotice typeId={state.document.entityTypeId} />
              : (
                <FieldsEditor
                  definitions={entityType.properties}
                  properties={state.document.properties}
                  disabled={pending}
                  onCommit={(propertyId, value) => submit([{
                    type: "entity.setProperty",
                    propertyId,
                    value,
                  }])}
                />
              )}
          </section>

          <div className="component-section-heading">
            <div>
              <span className="eyebrow">Components</span>
              <h2>{state.document.components.length} 个组件</h2>
            </div>
            <button
              type="button"
              disabled={pending || !state.catalogReady || entityType === undefined}
              onClick={() => setAddOpen(true)}
            >添加组件</button>
          </div>

          <div className="component-list">
            {state.document.components.length === 0 && <p className="empty-components">尚未添加组件。</p>}
            {state.document.components.map((component, index) => (
              <ComponentCard
                key={component.id}
                component={component}
                index={index}
                count={state.document.components.length}
                componentType={resolveComponentType(state.catalogRegistry, component.componentTypeId)}
                group={resolveComponentGroupForType(state.catalogRegistry, component.componentTypeId)}
                pending={pending}
                submit={submit}
              />
            ))}
          </div>
        </div>
      </div>
      <footer className="entity-status">
        <span>{status}</span>
        <span>{state.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length} 错误 · {state.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length} 警告</span>
      </footer>
      {addOpen && entityType !== undefined && (
        <AddComponentDialog
          registry={state.catalogRegistry}
          componentTypeIds={state.addableComponentTypeIds}
          onClose={() => setAddOpen(false)}
          onAdd={(componentTypeId) => {
            setAddOpen(false);
            submit([{
              type: "entity.addComponent",
              componentId: `component_${crypto.randomUUID()}`,
              componentTypeId,
            }]);
          }}
        />
      )}
    </div>
  );
}

function ComponentCard(props: {
  readonly component: EntityComponentInstance;
  readonly componentType: RegisteredEntityComponentTypeDefinition | undefined;
  readonly group: RegisteredEntityComponentGroupDefinition | undefined;
  readonly index: number;
  readonly count: number;
  readonly pending: boolean;
  readonly submit: (operations: readonly EntityOperation[]) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(true);
  const displayName = props.componentType?.title ?? props.component.componentTypeId;
  return (
    <article className={`entity-card component-card${props.component.enabled ? "" : " disabled"}`}>
      <header className="component-card-header">
        <button
          type="button"
          className="component-collapse"
          aria-label={expanded ? `折叠 ${displayName}` : `展开 ${displayName}`}
          onClick={() => setExpanded((value) => !value)}
        >{expanded ? "⌄" : "›"}</button>
        <input
          type="checkbox"
          aria-label={`启用 ${displayName}`}
          checked={props.component.enabled}
          disabled={props.pending}
          onChange={(event) => props.submit([{
            type: "entity.setComponentEnabled",
            componentId: props.component.id,
            enabled: event.target.checked,
          }])}
        />
        <div className="component-title">
          <strong>{displayName}</strong>
          <span>{[props.group?.title, ...(props.componentType?.menuPath ?? [])].filter(Boolean).join(" / ")}</span>
        </div>
        <code>{props.component.id}</code>
        <div className="component-actions">
          <button
            type="button"
            className="icon secondary"
            title="上移"
            disabled={props.pending || props.index === 0}
            onClick={() => props.submit([{
              type: "entity.moveComponent",
              componentId: props.component.id,
              index: props.index - 1,
            }])}
          >↑</button>
          <button
            type="button"
            className="icon secondary"
            title="下移"
            disabled={props.pending || props.index === props.count - 1}
            onClick={() => props.submit([{
              type: "entity.moveComponent",
              componentId: props.component.id,
              index: props.index + 1,
            }])}
          >↓</button>
          <button
            type="button"
            className="secondary"
            disabled={props.pending}
            onClick={() => props.submit([{
              type: "entity.duplicateComponent",
              componentId: props.component.id,
              newComponentId: `component_${crypto.randomUUID()}`,
            }])}
          >复制</button>
          <button
            type="button"
            className="secondary danger-text"
            disabled={props.pending}
            onClick={() => props.submit([{ type: "entity.removeComponent", componentId: props.component.id }])}
          >删除</button>
        </div>
      </header>
      {expanded && (
        <div className="component-body">
          {props.componentType === undefined
            ? (
              <div>
                <UnknownTypeNotice typeId={props.component.componentTypeId} />
                <pre>{JSON.stringify(props.component.properties, null, 2)}</pre>
              </div>
            )
            : (
              <>
                {props.componentType.source !== undefined && (
                  <p className="component-source">
                    {props.componentType.source.providerId === "csharp"
                      ? <span className="csharp-source-icon" aria-label="C#" title="C#">C#</span>
                      : <span className="component-source-provider">{props.componentType.source.providerId}</span>}
                    <code>{props.componentType.source.typeName}</code>
                  </p>
                )}
                <FieldsEditor
                  definitions={props.componentType.properties}
                  properties={props.component.properties}
                  disabled={props.pending}
                  onCommit={(propertyId, value) => props.submit([{
                    type: "entity.setComponentProperty",
                    componentId: props.component.id,
                    propertyId,
                    value,
                  }])}
                />
              </>
            )}
        </div>
      )}
    </article>
  );
}

function AddComponentDialog(props: {
  readonly registry: EntityCatalogRegistry;
  readonly componentTypeIds: readonly string[];
  readonly onClose: () => void;
  readonly onAdd: (componentTypeId: string) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const candidates = useMemo(() => props.componentTypeIds
    .map((componentTypeId) => resolveComponentType(props.registry, componentTypeId))
    .filter((componentType): componentType is RegisteredEntityComponentTypeDefinition => componentType !== undefined)
    .filter((componentType) => {
      const group = resolveComponentGroupForType(props.registry, componentType.id);
      const haystack = [componentType.title, componentType.id, ...componentType.aliases, group?.title, ...componentType.menuPath]
        .filter((entry): entry is string => entry !== undefined)
        .join(" ")
        .toLocaleLowerCase();
      return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
    }), [props.componentTypeIds, props.registry, query]);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section className="add-dialog" role="dialog" aria-modal="true" aria-label="添加组件" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">Component Catalog</span>
            <h2>添加组件</h2>
          </div>
          <button type="button" className="icon secondary" onClick={props.onClose}>×</button>
        </header>
        <input
          autoFocus
          type="search"
          placeholder="搜索分组、路径、类型或旧 ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="add-list">
          {candidates.map((componentType) => {
            const group = resolveComponentGroupForType(props.registry, componentType.id);
            return (
              <button type="button" className="add-list-item" key={componentType.id} onClick={() => props.onAdd(componentType.id)}>
                <strong>{componentType.title}</strong>
                <span>{[componentType.catalogTitle, group?.title, ...componentType.menuPath].filter(Boolean).join(" / ")}</span>
                <code>{componentType.id}</code>
              </button>
            );
          })}
          {candidates.length === 0 && <p>没有匹配的允许组件。</p>}
        </div>
      </section>
    </div>
  );
}

function TitleEditor(props: {
  readonly title: string;
  readonly disabled: boolean;
  readonly onCommit: (title: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.title);
  useEffect(() => setDraft(props.title), [props.title]);
  return (
    <input
      className="entity-title-input"
      value={draft}
      disabled={props.disabled}
      aria-label="Entity 标题"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const title = draft.trim();
        if (title.length > 0 && title !== props.title) {
          props.onCommit(title);
        } else {
          setDraft(props.title);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SaveState(props: { readonly dirty: boolean; readonly pending: boolean }): ReactElement {
  const label = props.pending ? "修改中" : props.dirty ? "未保存" : "已保存";
  return <span className={`entity-save-state${props.dirty ? " dirty" : ""}${props.pending ? " pending" : ""}`}><i />{label}</span>;
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

function UnknownTypeNotice(props: { readonly typeId: string }): ReactElement {
  return <p className="unknown-type">Catalog 中不存在类型 <code>{props.typeId}</code>；原始数据会保留，但字段不可编辑。</p>;
}

function resolveEntityType(registry: EntityCatalogRegistry, typeId: string): RegisteredEntityTypeDefinition | undefined {
  return registry.entityTypes.find((definition) => definition.id === typeId || definition.aliases.includes(typeId));
}

function resolveComponentType(
  registry: EntityCatalogRegistry,
  typeId: string,
): RegisteredEntityComponentTypeDefinition | undefined {
  return registry.componentTypes.find((definition) => definition.id === typeId || definition.aliases.includes(typeId));
}

function resolveComponentGroupForType(
  registry: EntityCatalogRegistry,
  componentTypeId: string,
): RegisteredEntityComponentGroupDefinition | undefined {
  const componentType = resolveComponentType(registry, componentTypeId);
  if (componentType === undefined) {
    return undefined;
  }
  return registry.componentGroups.find(
    (group) => group.id === componentType.groupId || group.aliases.includes(componentType.groupId),
  );
}
