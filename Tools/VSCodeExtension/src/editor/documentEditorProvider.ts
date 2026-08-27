import * as nodePath from "node:path";
import * as vscode from "vscode";
import { GRAPH_EDITOR_ID } from "@visualbridge/graph";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";
import { GraphEditorSession } from "./graphEditorSession";

export const DEFAULT_EDITOR_VIEW_TYPE = "visualbridge.documentEditor";
export const OPTIONAL_EDITOR_VIEW_TYPE = "visualbridge.documentEditor.option";

export class DocumentEditorProvider implements vscode.CustomTextEditorProvider {
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectRegistry,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const match = this.projects.resolveDocument(document.uri);
    if (match === undefined) {
      webviewPanel.dispose();
      await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      return;
    }

    if (match.documentType.editor === GRAPH_EDITOR_ID) {
      webviewPanel.title = `${match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
      const session = new GraphEditorSession(
        this.extensionUri,
        document,
        webviewPanel,
        match,
        this.projects,
        this.diagnostics,
        this.output,
      );
      await session.open();
      return;
    }

    webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewPanel.title = `${match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
    webviewPanel.webview.html = createEditorHtml(webviewPanel.webview, match, document.getText());

    const documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      void webviewPanel.webview.postMessage({ type: "documentChanged", text: event.document.getText() });
    });

    const projectSubscription = this.projects.onDidChange(() => {
      const refreshedMatch = this.projects.resolveDocument(document.uri);
      if (refreshedMatch === undefined) {
        webviewPanel.dispose();
        void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      }
    });

    webviewPanel.onDidDispose(() => {
      documentSubscription.dispose();
      projectSubscription.dispose();
    });
  }
}

function createEditorHtml(
  webview: vscode.Webview,
  match: DocumentMatch,
  documentText: string,
): string {
  const nonce = createNonce();
  const initialText = JSON.stringify(documentText).replaceAll("<", "\\u003c");
  const projectId = escapeHtml(match.project.definition.projectId);
  const documentType = escapeHtml(match.documentType.id);
  const editor = escapeHtml(match.documentType.editor);
  const relativePath = escapeHtml(match.relativePath);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>VisualBridge Editor</title>
  <style>
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
    dt { font-weight: 600; }
    dd { margin: 0; font-family: var(--vscode-editor-font-family); }
    main { padding: 20px; }
    .notice { margin: 0 0 12px; color: var(--vscode-descriptionForeground); }
    pre { box-sizing: border-box; min-height: 240px; margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; border: 1px solid var(--vscode-input-border); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  </style>
</head>
<body>
  <header>
    <h1>VisualBridge Document</h1>
    <dl>
      <dt>Project</dt><dd>${projectId}</dd>
      <dt>Type</dt><dd>${documentType}</dd>
      <dt>Editor module</dt><dd>${editor}</dd>
      <dt>Path</dt><dd>${relativePath}</dd>
    </dl>
  </header>
  <main>
    <p class="notice">The document shell is active. Domain-specific editing will load here.</p>
    <pre id="source"></pre>
  </main>
  <script nonce="${nonce}">
    const source = document.getElementById('source');
    source.textContent = ${initialText};
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'documentChanged') {
        source.textContent = event.data.text;
      }
    });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
