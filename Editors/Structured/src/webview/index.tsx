import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { DocumentDiagnostic } from "@visualbridge/core";
import type {
  RegisteredStructuredConfigTypeDefinition,
  StructuredDocument,
  StructuredOperation,
} from "@visualbridge/structured";
import { FieldsEditor, WebviewReferenceBridge } from "@visualbridge/form-editor";
import "../styles.css";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface StructuredStateMessage {
  readonly type: "structuredState";
  readonly documentVersion: number;
  readonly document: StructuredDocument;
  readonly configType: RegisteredStructuredConfigTypeDefinition;
  readonly isDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

interface StructuredInvalidMessage {
  readonly type: "structuredInvalid";
  readonly documentVersion: number;
  readonly isDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

type HostMessage = StructuredStateMessage | StructuredInvalidMessage | {
  readonly type: "operationRejected";
  readonly message: string;
} | {
  readonly type: "operationCompleted";
  readonly changed: boolean;
};

const vscode = acquireVsCodeApi();
const references = new WebviewReferenceBridge(vscode);
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Structured editor root element is missing.");
}

createRoot(rootElement).render(<StructuredEditorApp />);

function StructuredEditorApp(): ReactElement {
  const [state, setState] = useState<StructuredStateMessage>();
  const [invalid, setInvalid] = useState<StructuredInvalidMessage>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("正在加载 Structured Config…");

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (references.handleMessage(message)) {
        return;
      }
      if (message.type === "structuredState") {
        setState(message);
        setInvalid(undefined);
        setPending(false);
        setStatus("就绪");
      } else if (message.type === "structuredInvalid") {
        setState(undefined);
        setInvalid(message);
        setPending(false);
        setStatus("Structured Config 无效");
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
      references.dispose();
    };
  }, []);

  const submit = (operations: readonly StructuredOperation[]): void => {
    if (state === undefined || pending) {
      return;
    }
    setPending(true);
    setStatus("正在应用修改…");
    vscode.postMessage({ type: "applyOperations", documentVersion: state.documentVersion, operations });
  };

  if (state === undefined) {
    return (
      <main className="structured-loading">
        <h1>VisualBridge Structured Config</h1>
        <p>{status}</p>
        {invalid !== undefined && <Diagnostics diagnostics={invalid.diagnostics} />}
      </main>
    );
  }

  return (
    <div className="structured-app">
      <header className="structured-toolbar">
        <SaveState dirty={state.isDirty} pending={pending} />
      </header>
      <main className="structured-scroll">
        <section className="structured-card">
          <header>
            <h1>{state.configType.title}</h1>
            {state.configType.description !== undefined && <p>{state.configType.description}</p>}
          </header>
          <FieldsEditor
            definitions={state.configType.properties}
            properties={state.document.properties}
            disabled={pending}
            referenceActions={references}
            onCommit={(fieldId, value) => submit([{ type: "structured.setField", fieldId, value }])}
          />
        </section>
      </main>
      <footer className="structured-status">
        <span>{status}</span>
        <span>{formatDiagnosticSummary(state.diagnostics)}</span>
      </footer>
    </div>
  );
}

function SaveState(props: { readonly dirty: boolean; readonly pending: boolean }): ReactElement {
  const text = props.pending ? "正在修改" : props.dirty ? "未保存" : "已保存";
  return <span className={`structured-save-state${props.dirty ? " dirty" : ""}${props.pending ? " pending" : ""}`}><i />{text}</span>;
}

function Diagnostics(props: { readonly diagnostics: readonly DocumentDiagnostic[] }): ReactElement {
  return (
    <ul className="diagnostics">
      {props.diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code}:${diagnostic.path}:${index}`} className={diagnostic.severity}>
          {diagnostic.path}: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

function formatDiagnosticSummary(diagnostics: readonly DocumentDiagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  return errors === 0 && warnings === 0 ? "无诊断" : `${errors} 错误 · ${warnings} 警告`;
}
