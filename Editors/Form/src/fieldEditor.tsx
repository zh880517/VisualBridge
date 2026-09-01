import { useEffect, useId, useMemo, useState, type ReactElement } from "react";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Popover } from "@base-ui/react/popover";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { CommonIcon, IconButton, ListItemActions, PropertyGrid } from "@visualbridge/editor-ui";
import { HexAlphaColorPicker, HexColorPicker } from "react-colorful";
import {
  acceptReferenceSelection,
  jsonValuesEqual,
  parseJsonDraft,
  parseNumberDraft,
  resolveFieldEditorControl,
  resolveFieldEditorValue,
} from "./fieldEditorLogic";
import type { ReferenceEditorActions } from "./referenceBridge";
import type {
  FieldDefinition,
  FieldValueDefinition,
  JsonValue,
  ReferenceDefinition,
} from "@visualbridge/core";
import { cloneJsonValue } from "@visualbridge/core";
import "./fieldEditor.css";
import "./listEditor.css";

export interface FieldsEditorProps {
  readonly definitions: readonly FieldDefinition[];
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly disabled?: boolean | undefined;
  readonly referenceActions?: ReferenceEditorActions | undefined;
  readonly onCommit: (fieldId: string, value: JsonValue) => void;
}

export interface FieldValueEditorProps {
  readonly definition: FieldValueDefinition;
  readonly value: JsonValue | undefined;
  readonly disabled?: boolean | undefined;
  readonly ariaLabel?: string | undefined;
  readonly referenceActions?: ReferenceEditorActions | undefined;
  readonly onCommit: (value: JsonValue) => void;
}

export function FieldsEditor(props: FieldsEditorProps): ReactElement {
  if (props.definitions.length === 0) {
    return <p className="vb-fields-empty">没有可编辑字段</p>;
  }
  return (
    <PropertyGrid>
      {props.definitions.map((definition) => {
        const value = resolvePropertyValue(props.properties, definition);
        return (
          <div className="vb-field" key={definition.id} title={definition.description}>
            <label className="vb-field-label" htmlFor={`field-${definition.id}`}>{definition.title}</label>
            <div className="vb-field-value">
              <FieldValueEditor
                key={`${definition.id}:${JSON.stringify(value)}`}
                definition={definition}
                value={value}
                disabled={props.disabled}
                ariaLabel={definition.title}
                referenceActions={props.referenceActions}
                onCommit={(nextValue) => props.onCommit(definition.id, nextValue)}
              />
            </div>
          </div>
        );
      })}
    </PropertyGrid>
  );
}

export function FieldValueEditor(props: FieldValueEditorProps): ReactElement {
  const value = resolveFieldEditorValue(props.value, props.definition.defaultValue);
  const disabled = props.disabled === true || props.definition.editor?.readOnly === true;
  const control = resolveFieldEditorControl(props.definition, value);

  if (control === "select") {
    const options = props.definition.editor?.options ?? [];
    const selectedIndex = options.findIndex((option) => jsonValuesEqual(option.value, value));
    return (
      <select
        aria-label={props.ariaLabel}
        value={selectedIndex < 0 ? "" : String(selectedIndex)}
        disabled={disabled}
        onChange={(event) => {
          const option = options[Number(event.target.value)];
          if (option !== undefined) {
            props.onCommit(cloneJsonValue(option.value));
          }
        }}
      >
        {selectedIndex < 0 && <option value="">未配置</option>}
        {options.map((option, index) => <option key={`${index}:${option.title}`} value={index}>{option.title}</option>)}
      </select>
    );
  }

  if (control === "reference" && props.definition.reference !== undefined
    && (typeof value === "string" || typeof value === "number")) {
    return (
      <ReferenceEditor
        definition={props.definition.reference}
        value={value}
        disabled={disabled}
        ariaLabel={props.ariaLabel}
        actions={props.referenceActions}
        onCommit={props.onCommit}
      />
    );
  }

  if (control === "json") {
    return (
      <JsonEditor
        value={value}
        disabled={disabled}
        ariaLabel={props.ariaLabel}
        onCommit={props.onCommit}
      />
    );
  }

  if (control === "object") {
    const objectValue = isRecord(value) ? value as Readonly<Record<string, JsonValue>> : {};
    return (
      <div className="vb-object-editor">
        <FieldsEditor
          definitions={props.definition.fields}
          properties={objectValue}
          disabled={disabled}
          referenceActions={props.referenceActions}
          onCommit={(fieldId, fieldValue) => {
            const nextValue = cloneRecord(objectValue);
            const definition = props.definition.fields.find(
              (field) => field.id === fieldId || field.aliases.includes(fieldId),
            );
            if (definition !== undefined) {
              [definition.id, ...definition.aliases].forEach((identity) => delete nextValue[identity]);
              nextValue[definition.id] = cloneJsonValue(fieldValue);
              props.onCommit(nextValue);
            }
          }}
        />
      </div>
    );
  }

  if (control === "array") {
    const values = Array.isArray(value) ? value : [];
    const item = props.definition.item;
    if (item === undefined) {
      return <span className="vb-field-error">缺少 List 元素定义</span>;
    }
    return <ListEditor {...props} values={values} item={item} disabled={disabled} />;
  }

  if (control === "boolean") {
    return (
      <Checkbox.Root
        className="vb-checkbox"
        aria-label={props.ariaLabel}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={props.onCommit}
      >
        <Checkbox.Indicator><CommonIcon name="check" /></Checkbox.Indicator>
      </Checkbox.Root>
    );
  }

  if (control === "number") {
    return (
      <NumberEditor
        definition={props.definition}
        value={typeof value === "number" ? value : Number(props.definition.defaultValue)}
        disabled={disabled}
        ariaLabel={props.ariaLabel}
        onCommit={props.onCommit}
      />
    );
  }

  if (control === "color") {
    const colorValue = typeof value === "string" ? value : String(props.definition.defaultValue);
    return (
      <ColorEditor
        value={colorValue}
        disabled={disabled}
        ariaLabel={props.ariaLabel}
        onCommit={props.onCommit}
      />
    );
  }

  return (
    <StringEditor
      value={typeof value === "string" ? value : String(value)}
      multiline={props.definition.editor?.kind === "multiline"}
      disabled={disabled}
      ariaLabel={props.ariaLabel}
      onCommit={props.onCommit}
    />
  );
}

function ListEditor(props: FieldValueEditorProps & {
  readonly values: readonly JsonValue[];
  readonly item: FieldValueDefinition;
  readonly disabled: boolean;
}): ReactElement {
  const instanceId = useId();
  const itemIds = props.values.map((_, index) => `${instanceId}:${index}`);
  const addAt = (index: number): void => props.onCommit(insertArrayItem(
    props.values,
    index,
    props.item.defaultValue,
  ));
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) {
          return;
        }
        const { source } = event.operation;
        if (isSortable(source) && source.initialIndex !== source.index) {
          props.onCommit(moveArrayItem(props.values, source.initialIndex, source.index));
        }
      }}
    >
      <div className="vb-list-editor">
        {props.values.map((entry, index) => (
          <SortableListItem
            key={itemIds[index]}
            id={itemIds[index]!}
            group={instanceId}
            index={index}
            entry={entry}
            item={props.item}
            values={props.values}
            disabled={props.disabled}
            ariaLabel={props.ariaLabel}
            referenceActions={props.referenceActions}
            onCommit={props.onCommit}
            onAdd={() => addAt(index + 1)}
          />
        ))}
        {props.values.length === 0 && (
          <div className="vb-list-empty-actions">
            <span>列表为空</span>
            <IconButton
              className="secondary"
              icon="add"
              label="添加第 1 项"
              title="添加"
              disabled={props.disabled}
              onClick={() => addAt(0)}
            />
          </div>
        )}
      </div>
    </DragDropProvider>
  );
}

function SortableListItem(props: {
  readonly id: string;
  readonly group: string;
  readonly index: number;
  readonly entry: JsonValue;
  readonly item: FieldValueDefinition;
  readonly values: readonly JsonValue[];
  readonly disabled: boolean;
  readonly ariaLabel?: string | undefined;
  readonly referenceActions?: ReferenceEditorActions | undefined;
  readonly onCommit: (value: JsonValue) => void;
  readonly onAdd: () => void;
}): ReactElement {
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({
    id: props.id,
    index: props.index,
    group: props.group,
    type: "visualbridge-list-item",
    accept: "visualbridge-list-item",
    disabled: props.disabled,
  });
  return (
    <div
      ref={ref}
      className={`vb-list-item${isDragging ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}
    >
      <span className="vb-list-index">{props.index + 1}</span>
      <FieldValueEditor
        definition={props.item}
        value={props.entry}
        disabled={props.disabled}
        ariaLabel={`${props.ariaLabel ?? "List"} ${props.index + 1}`}
        referenceActions={props.referenceActions}
        onCommit={(nextEntry) => props.onCommit(replaceArrayItem(props.values, props.index, nextEntry))}
      />
      <ListItemActions
        dragRef={handleRef}
        dragLabel={`拖动第 ${props.index + 1} 项排序`}
        addLabel={`在第 ${props.index + 1} 项后添加`}
        deleteLabel={`删除第 ${props.index + 1} 项`}
        disabled={props.disabled}
        onAdd={props.onAdd}
        onDelete={() => props.onCommit(props.values.filter((_, index) => index !== props.index))}
      />
    </div>
  );
}

function ReferenceEditor(props: {
  readonly definition: ReferenceDefinition;
  readonly value: string | number;
  readonly disabled: boolean;
  readonly ariaLabel?: string | undefined;
  readonly actions?: ReferenceEditorActions | undefined;
  readonly onCommit: (value: JsonValue) => void;
}): ReactElement {
  const available = props.actions !== undefined;
  return (
    <div className="vb-reference-editor">
      <input
        type="text"
        aria-label={props.ariaLabel}
        value={String(props.value)}
        readOnly
        title={`${props.definition.kind}: ${String(props.value)}`}
      />
      <div className="vb-reference-actions" role="group" aria-label={`${props.ariaLabel ?? "引用"}操作`}>
        <IconButton
          className="secondary"
          icon="search"
          label={`选择${props.ariaLabel ?? "引用"}`}
          title="选择引用"
          disabled={props.disabled || !available}
          onClick={() => {
            void props.actions?.pick(props.definition, props.value).then((value) => {
              const accepted = acceptReferenceSelection(props.value, value);
              if (accepted !== undefined) {
                props.onCommit(accepted);
              }
            });
          }}
        />
        <IconButton
          className="secondary"
          icon="open"
          label={`打开${props.ariaLabel ?? "引用"}`}
          title="打开引用"
          disabled={!available}
          onClick={() => props.actions?.reveal(props.definition, props.value)}
        />
      </div>
    </div>
  );
}

function StringEditor(props: {
  readonly value: string;
  readonly multiline: boolean;
  readonly disabled: boolean;
  readonly ariaLabel?: string | undefined;
  readonly onCommit: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = (): void => {
    if (draft !== props.value) {
      props.onCommit(draft);
    }
  };
  return props.multiline ? (
    <textarea
      aria-label={props.ariaLabel}
      value={draft}
      disabled={props.disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  ) : (
    <input
      type="text"
      aria-label={props.ariaLabel}
      value={draft}
      disabled={props.disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function NumberEditor(props: {
  readonly definition: FieldValueDefinition;
  readonly value: number;
  readonly disabled: boolean;
  readonly ariaLabel?: string | undefined;
  readonly onCommit: (value: number) => void;
}): ReactElement {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  return (
    <input
      type="number"
      aria-label={props.ariaLabel}
      value={draft}
      disabled={props.disabled}
      min={props.definition.editor?.min}
      max={props.definition.editor?.max}
      step={props.definition.editor?.step ?? (props.definition.editor?.integer === true ? 1 : "any")}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const value = parseNumberDraft(draft, props.value);
        if (value !== undefined) {
          props.onCommit(value);
        } else {
          setDraft(String(props.value));
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

function ColorEditor(props: {
  readonly value: string;
  readonly disabled: boolean;
  readonly ariaLabel?: string | undefined;
  readonly onCommit: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.value);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    setDraft(props.value);
    setPickerOpen(false);
  }, [props.value]);
  const supportsAlpha = /^#[0-9A-Fa-f]{8}$/.test(props.value);
  const validDraft = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(draft);
  const previewValue = validDraft ? draft.toUpperCase() : props.value.toUpperCase();
  const pickerValue = supportsAlpha
    ? /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(draft) ? draft : props.value
    : /^#[0-9A-Fa-f]{6}$/.test(draft) ? draft : props.value.slice(0, 7);

  const normalizeForCommit = (value: string): string => {
    const normalized = value.toUpperCase();
    return supportsAlpha && /^#[0-9A-F]{6}$/.test(normalized)
      ? `${normalized}FF`
      : normalized;
  };

  const cancelPicker = (): void => {
    setDraft(props.value);
    setPickerOpen(false);
  };
  const applyPicker = (): void => {
    if (!validDraft) {
      return;
    }
    const value = normalizeForCommit(draft);
    setPickerOpen(false);
    if (value !== props.value.toUpperCase()) {
      props.onCommit(value);
    }
  };
  const updatePickerDraft = (value: string): void => {
    setDraft(value.toUpperCase());
  };
  return (
    <div className="vb-color-editor">
      <Popover.Root
        open={pickerOpen}
        onOpenChange={(open) => {
          setDraft(props.value);
          setPickerOpen(open);
        }}
      >
        <Popover.Trigger
          className="vb-color-swatch"
          aria-label={`${props.ariaLabel ?? "颜色"} 选择器`}
          disabled={props.disabled}
          title={pickerOpen ? "关闭颜色选择器" : "打开颜色选择器"}
        >
          <span style={{ backgroundColor: previewValue }} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner className="vb-color-picker-positioner" sideOffset={6} align="start">
            <Popover.Popup className="vb-color-picker-panel">
              <Popover.Title className="vb-sr-only">{props.ariaLabel ?? "颜色"}选择器</Popover.Title>
              {supportsAlpha
                ? (
                  <HexAlphaColorPicker
                    aria-label={`${props.ariaLabel ?? "颜色"} RGBA`}
                    color={pickerValue}
                    onChange={updatePickerDraft}
                  />
                )
                : (
                  <HexColorPicker
                    aria-label={`${props.ariaLabel ?? "颜色"} RGB`}
                    color={pickerValue}
                    onChange={updatePickerDraft}
                  />
                )}
              <div className="vb-color-picker-preview">
                <span style={{ backgroundColor: previewValue }} />
                <code>{previewValue}</code>
              </div>
              <div className="vb-color-picker-actions">
                <Popover.Close className="secondary">取消</Popover.Close>
                <Button type="button" disabled={!validDraft} onClick={applyPicker}>应用</Button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <input
        type="text"
        aria-label={props.ariaLabel}
        value={draft}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (pickerOpen) {
            return;
          }
          if (/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(draft)) {
            const value = normalizeForCommit(draft);
            if (value !== props.value.toUpperCase()) {
              props.onCommit(value);
            }
          } else {
            setDraft(props.value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            if (pickerOpen) {
              applyPicker();
            } else {
              event.currentTarget.blur();
            }
          } else if (event.key === "Escape" && pickerOpen) {
            cancelPicker();
          }
        }}
      />
    </div>
  );
}

function JsonEditor(props: {
  readonly value: JsonValue;
  readonly disabled: boolean;
  readonly ariaLabel?: string | undefined;
  readonly onCommit: (value: JsonValue) => void;
}): ReactElement {
  const text = useMemo(() => JSON.stringify(props.value, null, 2), [props.value]);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(text);
    setInvalid(false);
  }, [text]);
  return (
    <textarea
      className={invalid ? "invalid" : undefined}
      aria-label={props.ariaLabel}
      value={draft}
      disabled={props.disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const result = parseJsonDraft(draft);
        if (result.success) {
          setInvalid(false);
          if (!jsonValuesEqual(result.value, props.value)) {
            props.onCommit(result.value);
          }
        } else {
          setInvalid(true);
        }
      }}
    />
  );
}

function resolvePropertyValue(
  properties: Readonly<Record<string, JsonValue>>,
  definition: FieldDefinition,
): JsonValue {
  const direct = properties[definition.id];
  if (direct !== undefined) {
    return direct;
  }
  for (const alias of definition.aliases) {
    const aliasValue = properties[alias];
    if (aliasValue !== undefined) {
      return aliasValue;
    }
  }
  return cloneJsonValue(definition.defaultValue);
}

function cloneRecord(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]));
}

function replaceArrayItem(values: readonly JsonValue[], index: number, value: JsonValue): JsonValue[] {
  return values.map((entry, candidateIndex) => cloneJsonValue(candidateIndex === index ? value : entry));
}

function insertArrayItem(
  values: readonly JsonValue[],
  index: number,
  value: JsonValue,
): JsonValue[] {
  const result = values.map(cloneJsonValue);
  result.splice(index, 0, cloneJsonValue(value));
  return result;
}

function moveArrayItem(values: readonly JsonValue[], from: number, to: number): JsonValue[] {
  const result = values.map(cloneJsonValue);
  const [entry] = result.splice(from, 1);
  if (entry !== undefined) {
    result.splice(to, 0, entry);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
