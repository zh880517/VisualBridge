import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { DocumentDiagnostic } from "@visualbridge/core";
import type { StructuredOperation } from "@visualbridge/structured";
import { EditorShell, EditorStatusBar, EditorToolbar, SaveState } from "@visualbridge/editor-ui";
import { FieldsEditor, WebviewReferenceBridge } from "@visualbridge/form-editor";
import {
  createSetFieldOperation,
  formatDiagnosticSummary,
  initialStructuredEditorState,
  reduceStructuredHostMessage,
  withWebviewToken,
  type StructuredEditorState,
  type StructuredHostMessage,
} from "../structuredEditorLogic";
import "../styles.css";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const rawVscode = acquireVsCodeApi();
const webviewInstanceId = crypto.randomUUID();
let webviewToken: string | undefined;
const vscode: VsCodeApi = {
  postMessage: (message) => rawVscode.postMessage(withWebviewToken(message, webviewToken)),
};
const references = new WebviewReferenceBridge(vscode);
const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Structured editor root element is missing.");
}

createRoot(rootElement).render(<StructuredEditorApp />);

function StructuredEditorApp(): ReactElement {
  const [editorState, setEditorState] = useState<StructuredEditorState>(initialStructuredEditorState);
  const { state, invalid, pending, status } = editorState;

  useEffect(() => {
    const listener = (event: MessageEvent<StructuredHostMessage>): void => {
      const message = event.data;
      if (message.type === "requestReady") {
        webviewToken = message.webviewToken;
        vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
        return;
      }
      if (references.handleMessage(message)) {
        return;
      }
      setEditorState((current) => reduceStructuredHostMessage(current, message));
    };
    window.addEventListener("message", listener);
    webviewToken = undefined;
    vscode.postMessage({ type: "ready", instanceId: webviewInstanceId });
    return () => {
      window.removeEventListener("message", listener);
      references.dispose();
    };
  }, []);

  const submit = (operations: readonly StructuredOperation[]): void => {
    if (state === undefined || pending) {
      return;
    }
    setEditorState((current) => ({ ...current, pending: true, status: "正在应用修改…" }));
    vscode.postMessage({ type: "applyOperations", documentVersion: state.documentVersion, operations });
  };

  if (state === undefined) {
    return (
      <main className="structured-loading">
        <h1>VisualBridge 结构化配置</h1>
        <p>{status}</p>
        {invalid !== undefined && <Diagnostics diagnostics={invalid.diagnostics} />}
      </main>
    );
  }

  return (
    <EditorShell className="structured-app">
      <EditorToolbar className="structured-toolbar">
        <SaveState dirty={state.isDirty} pending={pending} pendingLabel="正在修改" />
      </EditorToolbar>
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
            onCommit={(fieldId, value) => submit([createSetFieldOperation(fieldId, value)])}
          />
        </section>
      </main>
      <EditorStatusBar className="structured-status">
        <span>{status}</span>
        <span>{formatDiagnosticSummary(state.diagnostics)}</span>
      </EditorStatusBar>
    </EditorShell>
  );
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
