import { useEffect, useMemo, useState, type ReactElement } from "react";
import type {
  FieldDefinition,
  FieldValueDefinition,
  JsonValue,
} from "@visualbridge/core";
import { cloneJsonValue } from "@visualbridge/core";

export interface FieldsEditorProps {
  readonly definitions: readonly FieldDefinition[];
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly disabled?: boolean | undefined;
  readonly onCommit: (fieldId: string, value: JsonValue) => void;
}

export interface FieldValueEditorProps {
  readonly definition: FieldValueDefinition;
  readonly value: JsonValue | undefined;
  readonly disabled?: boolean | undefined;
  readonly ariaLabel?: string | undefined;
  readonly onCommit: (value: JsonValue) => void;
}

export function FieldsEditor(props: FieldsEditorProps): ReactElement {
  if (props.definitions.length === 0) {
    return <p className="vb-fields-empty">没有可编辑字段</p>;
  }
  return (
    <div className="vb-fields">
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
                onCommit={(nextValue) => props.onCommit(definition.id, nextValue)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function FieldValueEditor(props: FieldValueEditorProps): ReactElement {
  const value = props.value ?? cloneJsonValue(props.definition.defaultValue);
  const disabled = props.disabled === true || props.definition.editor?.readOnly === true;

  if (props.definition.valueType === "object") {
    const objectValue = isRecord(value) ? value as Readonly<Record<string, JsonValue>> : {};
    return (
      <div className="vb-object-editor">
        <FieldsEditor
          definitions={props.definition.fields}
          properties={objectValue}
          disabled={disabled}
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

  if (props.definition.valueType === "array") {
    const values = Array.isArray(value) ? value : [];
    const item = props.definition.item;
    if (item === undefined) {
      return <span className="vb-field-error">缺少 List 元素定义</span>;
    }
    return (
      <div className="vb-list-editor">
        {values.map((entry, index) => (
          <div className="vb-list-item" key={`${index}:${JSON.stringify(entry)}`}>
            <span className="vb-list-index">{index}</span>
            <FieldValueEditor
              definition={item}
              value={entry}
              disabled={disabled}
              ariaLabel={`${props.ariaLabel ?? "List"} ${index}`}
              onCommit={(nextEntry) => props.onCommit(replaceArrayItem(values, index, nextEntry))}
            />
            <div className="vb-list-actions">
              <button
                type="button"
                className="icon secondary"
                title="上移"
                disabled={disabled || index === 0}
                onClick={() => props.onCommit(moveArrayItem(values, index, index - 1))}
              >↑</button>
              <button
                type="button"
                className="icon secondary"
                title="下移"
                disabled={disabled || index === values.length - 1}
                onClick={() => props.onCommit(moveArrayItem(values, index, index + 1))}
              >↓</button>
              <button
                type="button"
                className="icon secondary"
                title="删除"
                disabled={disabled}
                onClick={() => props.onCommit(values.filter((_, candidateIndex) => candidateIndex !== index))}
              >×</button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="secondary vb-list-add"
          disabled={disabled}
          onClick={() => props.onCommit([...values.map(cloneJsonValue), cloneJsonValue(item.defaultValue)])}
        >添加元素</button>
      </div>
    );
  }

  if (props.definition.editor?.kind === "select") {
    const options = props.definition.editor.options;
    const selectedIndex = options.findIndex((option) => jsonEqual(option.value, value));
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

  if (props.definition.valueType === "boolean" || props.definition.editor?.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={props.ariaLabel}
        checked={value === true}
        disabled={disabled}
        onChange={(event) => props.onCommit(event.target.checked)}
      />
    );
  }

  if (props.definition.valueType === "number") {
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

  if (props.definition.editor?.kind === "color") {
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

  if (props.definition.valueType === "json" || props.definition.editor?.kind === "json") {
    return (
      <JsonEditor
        value={value}
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
        const value = Number(draft);
        if (Number.isFinite(value) && value !== props.value) {
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
  useEffect(() => setDraft(props.value), [props.value]);
  const pickerValue = /^#[0-9A-Fa-f]{6}/.test(draft) ? draft.slice(0, 7) : "#000000";
  return (
    <div className="vb-color-editor">
      <input
        type="color"
        aria-label={`${props.ariaLabel ?? "颜色"} 选择器`}
        value={pickerValue}
        disabled={props.disabled}
        onChange={(event) => {
          const alpha = /^#[0-9A-Fa-f]{8}$/.test(draft) ? draft.slice(7, 9) : "";
          const value = `${event.target.value.toUpperCase()}${alpha.toUpperCase()}`;
          setDraft(value);
          props.onCommit(value);
        }}
      />
      <input
        type="text"
        aria-label={props.ariaLabel}
        value={draft}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(draft)) {
            if (draft.toUpperCase() !== props.value.toUpperCase()) {
              props.onCommit(draft.toUpperCase());
            }
          } else {
            setDraft(props.value);
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
        try {
          const value = JSON.parse(draft) as JsonValue;
          setInvalid(false);
          if (!jsonEqual(value, props.value)) {
            props.onCommit(value);
          }
        } catch {
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

function moveArrayItem(values: readonly JsonValue[], from: number, to: number): JsonValue[] {
  const result = values.map(cloneJsonValue);
  const [entry] = result.splice(from, 1);
  if (entry !== undefined) {
    result.splice(to, 0, entry);
  }
  return result;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
