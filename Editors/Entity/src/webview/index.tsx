import { useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Collapsible } from "@base-ui/react/collapsible";
import { Dialog } from "@base-ui/react/dialog";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
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
import {
  CommonIcon,
  FieldsEditor,
  IconButton,
  ListItemActions,
  WebviewReferenceBridge,
  type ReferenceEditorActions,
} from "@visualbridge/form-editor";
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
const referenceBridge = new WebviewReferenceBridge(vscode);
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
  const [addIndex, setAddIndex] = useState<number>();

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (referenceBridge.handleMessage(message)) {
        return;
      }
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
    return () => {
      window.removeEventListener("message", listener);
      referenceBridge.dispose();
    };
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
                  referenceActions={referenceBridge}
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
            <IconButton
              className="component-add"
              icon="add"
              label="添加组件"
              disabled={pending || !state.catalogReady || entityType === undefined}
              onClick={() => {
                setAddIndex(state.document.components.length);
                setAddOpen(true);
              }}
            />
          </div>

          <DragDropProvider
            onDragEnd={(event) => {
              if (event.canceled) {
                return;
              }
              const { source } = event.operation;
              if (isSortable(source) && source.initialIndex !== source.index) {
                const component = state.document.components[source.initialIndex];
                if (component === undefined) {
                  return;
                }
                submit([{
                  type: "entity.moveComponent",
                  componentId: component.id,
                  index: source.index,
                }]);
              }
            }}
          >
            <div className="component-list">
              {state.document.components.length === 0 && <p className="empty-components">尚未添加组件。</p>}
              {state.document.components.map((component, index) => (
                <ComponentCard
                  key={component.id}
                  component={component}
                  index={index}
                  componentType={resolveComponentType(state.catalogRegistry, component.componentTypeId)}
                  pending={pending}
                  referenceActions={referenceBridge}
                  submit={submit}
                  onAdd={() => {
                    setAddIndex(index + 1);
                    setAddOpen(true);
                  }}
                />
              ))}
            </div>
          </DragDropProvider>
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
          onClose={() => {
            setAddOpen(false);
            setAddIndex(undefined);
          }}
          onAdd={(componentTypeId) => {
            setAddOpen(false);
            submit([{
              type: "entity.addComponent",
              componentId: `component_${crypto.randomUUID()}`,
              componentTypeId,
              index: addIndex ?? state.document.components.length,
            }]);
            setAddIndex(undefined);
          }}
        />
      )}
    </div>
  );
}

function ComponentCard(props: {
  readonly component: EntityComponentInstance;
  readonly componentType: RegisteredEntityComponentTypeDefinition | undefined;
  readonly index: number;
  readonly pending: boolean;
  readonly referenceActions: ReferenceEditorActions;
  readonly submit: (operations: readonly EntityOperation[]) => void;
  readonly onAdd: () => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(true);
  const displayName = props.componentType?.title ?? props.component.componentTypeId;
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({
    id: props.component.id,
    index: props.index,
    group: "entity-components",
    type: "visualbridge-entity-component",
    accept: "visualbridge-entity-component",
    disabled: props.pending,
  });
  return (
    <Collapsible.Root
      open={expanded}
      onOpenChange={setExpanded}
      render={<article
        ref={ref}
        className={`entity-card component-card${props.component.enabled ? "" : " disabled"}${isDragging ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}
      />}
    >
      <header className="component-card-header">
        <Collapsible.Trigger
          className="icon secondary component-collapse"
          aria-label={expanded ? `折叠 ${displayName}` : `展开 ${displayName}`}
          title={expanded ? "折叠组件" : "展开组件"}
        >
          <CommonIcon name={expanded ? "chevronDown" : "chevronRight"} />
        </Collapsible.Trigger>
        <Checkbox.Root
          className="component-enabled"
          aria-label={`启用 ${displayName}`}
          checked={props.component.enabled}
          disabled={props.pending}
          onCheckedChange={(checked) => props.submit([{
            type: "entity.setComponentEnabled",
            componentId: props.component.id,
            enabled: checked,
          }])}
        >
          <Checkbox.Indicator><CommonIcon name="check" /></Checkbox.Indicator>
        </Checkbox.Root>
        <div className="component-title">
          <strong>{displayName}</strong>
        </div>
        <div className="component-actions">
          <IconButton
            className="secondary"
            icon="copy"
            title="复制"
            label={`复制 ${displayName}`}
            disabled={props.pending}
            onClick={() => props.submit([{
              type: "entity.duplicateComponent",
              componentId: props.component.id,
              newComponentId: `component_${crypto.randomUUID()}`,
            }])}
          />
          <ListItemActions
            dragRef={handleRef}
            dragLabel={`拖动 ${displayName} 排序`}
            addLabel={`在 ${displayName} 后添加组件`}
            deleteLabel={`删除 ${displayName}`}
            disabled={props.pending}
            onAdd={props.onAdd}
            onDelete={() => props.submit([{ type: "entity.removeComponent", componentId: props.component.id }])}
          />
        </div>
      </header>
      <Collapsible.Panel className="component-body">
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
                  referenceActions={props.referenceActions}
                  onCommit={(propertyId, value) => props.submit([{
                    type: "entity.setComponentProperty",
                    componentId: props.component.id,
                    propertyId,
                    value,
                  }])}
                />
              </>
            )}
      </Collapsible.Panel>
    </Collapsible.Root>
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
    <Dialog.Root defaultOpen onOpenChange={(open) => {
      if (!open) {
        props.onClose();
      }
    }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="add-dialog">
            <header>
              <div>
                <span className="eyebrow">Component Catalog</span>
                <Dialog.Title className="add-dialog-title">添加组件</Dialog.Title>
              </div>
              <Dialog.Close className="icon secondary" aria-label="关闭" title="关闭">
                <CommonIcon name="close" />
              </Dialog.Close>
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
                  <Button className="add-list-item" key={componentType.id} onClick={() => props.onAdd(componentType.id)}>
                    <strong>{componentType.title}</strong>
                    <span>{[componentType.catalogTitle, group?.title, ...componentType.menuPath].filter(Boolean).join(" / ")}</span>
                    <code>{componentType.id}</code>
                  </Button>
                );
              })}
              {candidates.length === 0 && <p>没有匹配的允许组件。</p>}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
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
