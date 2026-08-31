import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { ReferenceLocation } from "@visualbridge/core";
import { ENTITY_EDITOR_ID } from "@visualbridge/entity";
import { readEntityRevealTarget, type EntityRevealTarget } from "@visualbridge/entity-editor";
import { GRAPH_EDITOR_ID } from "@visualbridge/graph";
import { readGraphRevealTarget, type GraphRevealTarget } from "@visualbridge/graph-editor";
import { STRUCTURED_EDITOR_ID } from "@visualbridge/structured";
import { TABLE_EDITOR_ID } from "@visualbridge/table";
import type { DocumentMatch, ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "../reference/workspaceReferenceService";
import type { GraphExecutionDebugTestState } from "./graphExecutionDebugController";
import { EntityEditorSession } from "./entityEditorSession";
import { GraphEditorSession } from "./graphEditorSession";
import { StructuredEditorSession } from "./structuredEditorSession";
import { TABLE_EDITOR_VIEW_TYPE } from "./tableEditorProvider";

export const DEFAULT_EDITOR_VIEW_TYPE = "visualbridge.documentEditor";
export const OPTIONAL_EDITOR_VIEW_TYPE = "visualbridge.documentEditor.option";

export class DocumentEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly graphSessions = new Map<string, Set<GraphEditorSession>>();
  private readonly pendingGraphReveals = new Map<string, GraphRevealTarget>();
  private readonly entitySessions = new Map<string, Set<EntityEditorSession>>();
  private readonly pendingEntityReveals = new Map<string, EntityRevealTarget>();
  private readonly structuredSessions = new Map<string, Set<StructuredEditorSession>>();
  private readonly initializedPanels = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly sessionDiagnostics = new Map<
    string,
    Map<symbol, readonly vscode.Diagnostic[]>
  >();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projects: ProjectRegistry,
    private readonly references: WorkspaceReferenceService,
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

    if (match.documentType.editor === TABLE_EDITOR_ID) {
      webviewPanel.dispose();
      await vscode.commands.executeCommand("vscode.openWith", document.uri, TABLE_EDITOR_VIEW_TYPE);
      return;
    }

    if (match.documentType.editor === GRAPH_EDITOR_ID) {
      webviewPanel.title = `${match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
      const diagnosticsOwner = this.createDiagnosticsOwner(document.uri);
      const session = new GraphEditorSession(
        this.extensionUri,
        document,
        webviewPanel,
        match,
        this.projects,
        this.references,
        diagnosticsOwner.publish,
        this.output,
      );
      const uriKey = document.uri.toString();
      let sessions = this.graphSessions.get(uriKey);
      if (sessions === undefined) {
        sessions = new Set();
        this.graphSessions.set(uriKey, sessions);
      }
      sessions.add(session);
      const panelSubscription = webviewPanel.onDidDispose(() => {
        diagnosticsOwner.dispose();
        this.removeGraphSession(uriKey, session);
      });
      try {
        await session.open();
        const pendingReveal = this.pendingGraphReveals.get(uriKey);
        if (pendingReveal !== undefined) {
          this.pendingGraphReveals.delete(uriKey);
          await session.reveal(pendingReveal);
        }
      } catch (error) {
        panelSubscription.dispose();
        diagnosticsOwner.dispose();
        this.removeGraphSession(uriKey, session);
        throw error;
      }
      return;
    }

    if (match.documentType.editor === ENTITY_EDITOR_ID) {
      webviewPanel.title = `${match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
      const diagnosticsOwner = this.createDiagnosticsOwner(document.uri);
      const session = new EntityEditorSession(
        this.extensionUri,
        document,
        webviewPanel,
        match,
        this.projects,
        this.references,
        diagnosticsOwner.publish,
        this.output,
      );
      const uriKey = document.uri.toString();
      let sessions = this.entitySessions.get(uriKey);
      if (sessions === undefined) {
        sessions = new Set();
        this.entitySessions.set(uriKey, sessions);
      }
      sessions.add(session);
      const panelSubscription = webviewPanel.onDidDispose(() => {
        diagnosticsOwner.dispose();
        this.removeEntitySession(uriKey, session);
      });
      try {
        await session.open();
        const pendingReveal = this.pendingEntityReveals.get(uriKey);
        if (pendingReveal !== undefined) {
          this.pendingEntityReveals.delete(uriKey);
          await session.reveal(pendingReveal);
        }
      } catch (error) {
        panelSubscription.dispose();
        diagnosticsOwner.dispose();
        this.removeEntitySession(uriKey, session);
        throw error;
      }
      return;
    }

    if (match.documentType.editor === STRUCTURED_EDITOR_ID) {
      webviewPanel.title = `${match.documentType.id}: ${nodePath.basename(document.uri.fsPath)}`;
      const diagnosticsOwner = this.createDiagnosticsOwner(document.uri);
      const session = new StructuredEditorSession(
        this.extensionUri,
        document,
        webviewPanel,
        match,
        this.projects,
        this.references,
        diagnosticsOwner.publish,
        this.output,
      );
      const uriKey = document.uri.toString();
      let sessions = this.structuredSessions.get(uriKey);
      if (sessions === undefined) {
        sessions = new Set();
        this.structuredSessions.set(uriKey, sessions);
      }
      sessions.add(session);
      const panelSubscription = webviewPanel.onDidDispose(() => {
        diagnosticsOwner.dispose();
        this.removeStructuredSession(uriKey, session);
      });
      try {
        await session.open();
      } catch (error) {
        panelSubscription.dispose();
        diagnosticsOwner.dispose();
        this.removeStructuredSession(uriKey, session);
        throw error;
      }
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
      this.removeInitializedPanel(document.uri.toString(), webviewPanel);
    });
    this.addInitializedPanel(document.uri.toString(), webviewPanel);
  }

  public isEditorReady(uri: vscode.Uri): boolean {
    const uriKey = uri.toString();
    return [...this.graphSessions.get(uriKey) ?? []].some((session) => session.isReady)
      || [...this.entitySessions.get(uriKey) ?? []].some((session) => session.isReady)
      || [...this.structuredSessions.get(uriKey) ?? []].some((session) => session.isReady)
      || (this.initializedPanels.get(uriKey)?.size ?? 0) > 0;
  }

  public getGraphEditorTestState(uri: vscode.Uri): {
    readonly sessionCount: number;
    readonly readySessionCount: number;
    readonly activeSessionCount: number;
    readonly visibleSessionCount: number;
    readonly maxReadyGeneration: number;
    readonly diagnosticOwnerCount: number;
    readonly publishedDiagnosticCount: number;
    readonly sessionIds: readonly number[];
    readonly readyTokens: readonly string[];
    readonly lastRevealResults: readonly {
      readonly target: GraphRevealTarget;
      readonly found: boolean;
    }[];
    readonly debugStates: readonly GraphExecutionDebugTestState[];
  } {
    const uriKey = uri.toString();
    const sessions = [...this.graphSessions.get(uriKey) ?? []];
    const states = sessions.map((session) => session.testState);
    return {
      sessionCount: states.length,
      readySessionCount: states.filter((state) => state.ready).length,
      activeSessionCount: states.filter((state) => state.active).length,
      visibleSessionCount: states.filter((state) => state.visible).length,
      sessionIds: sessions.map((session) => session.testSessionId),
      readyTokens: states.flatMap((state) => state.readyToken === undefined ? [] : [state.readyToken]),
      lastRevealResults: states.flatMap((state) => (
        state.lastRevealResult === undefined ? [] : [state.lastRevealResult]
      )),
      debugStates: sessions.map((session) => session.debugTestState),
      maxReadyGeneration: states.reduce(
        (maximum, state) => Math.max(maximum, state.readyGeneration),
        0,
      ),
      diagnosticOwnerCount: this.sessionDiagnostics.get(uriKey)?.size ?? 0,
      publishedDiagnosticCount: this.diagnostics.get(uri)?.length ?? 0,
    };
  }

  /** 首个 Graph 会话的执行调试状态（测试轮询用）。 */
  public getGraphEditorDebugState(uri: vscode.Uri): GraphExecutionDebugTestState | undefined {
    const session = [...this.graphSessions.get(uri.toString()) ?? []][0];
    return session === undefined ? undefined : session.debugTestState;
  }

  /** 向首个 Graph 会话注入执行调试消息（带 token，与真实 Webview 同路径）。 */
  public async sendGraphEditorDebugMessage(uri: vscode.Uri, message: unknown): Promise<void> {
    const session = [...this.graphSessions.get(uri.toString()) ?? []][0];
    if (session === undefined) throw new Error("No active graph editor session was found.");
    await session.sendDebugMessageForTest(message);
  }

  public getEntityEditorTestState(uri: vscode.Uri): {
    readonly sessionCount: number;
    readonly readySessionCount: number;
    readonly lastRevealResults: readonly {
      readonly target: EntityRevealTarget;
      readonly found: boolean;
    }[];
  } {
    const states = [...this.entitySessions.get(uri.toString()) ?? []].map((session) => session.testState);
    return {
      sessionCount: states.length,
      readySessionCount: states.filter((state) => state.ready).length,
      lastRevealResults: states.flatMap((state) => (
        state.lastRevealResult === undefined ? [] : [state.lastRevealResult]
      )),
    };
  }

  public assertIdentityOperationsAllowedForTest(
    uri: vscode.Uri,
    editor: "entity" | "graph",
    operations: unknown,
  ): void {
    const uriKey = uri.toString();
    const session = editor === "entity"
      ? [...this.entitySessions.get(uriKey) ?? []][0]
      : [...this.graphSessions.get(uriKey) ?? []][0];
    if (session === undefined) throw new Error(`No active ${editor} editor session was found.`);
    session.assertIdentityOperationsAllowedForTest(operations);
  }

  public async applyOperationsForTest(
    uri: vscode.Uri,
    editor: "entity" | "graph" | "structured",
    operations: unknown,
  ): Promise<void> {
    const uriKey = uri.toString();
    const session = editor === "entity"
      ? [...this.entitySessions.get(uriKey) ?? []][0]
      : editor === "graph"
        ? [...this.graphSessions.get(uriKey) ?? []][0]
        : [...this.structuredSessions.get(uriKey) ?? []][0];
    if (session === undefined) throw new Error(`No active ${editor} editor session was found.`);
    await session.applyOperationsForTest(operations);
  }

  public async applyOperationsAfterExternalWriteForTest(
    uri: vscode.Uri,
    externalText: string,
    operations: unknown,
  ): Promise<void> {
    const session = [...this.structuredSessions.get(uri.toString()) ?? []][0];
    if (session === undefined) throw new Error("No active structured editor session was found.");
    await session.applyOperationsAfterExternalWriteForTest(externalText, operations);
  }

  public async revealGraphReference(location: ReferenceLocation): Promise<void> {
    const target = readGraphRevealTarget(location);
    if (target === undefined || !isProjectRelativePath(location.path)) {
      throw new Error("Invalid Graph element reference location.");
    }
    const project = this.projects.projects.find(
      (candidate) => candidate.definition.projectId === location.projectId,
    );
    if (project === undefined) {
      throw new Error(`VisualBridge Project '${location.projectId}' is not open.`);
    }
    const uri = vscode.Uri.joinPath(project.rootUri, ...location.path.split("/"));
    const match = this.projects.resolveDocument(uri);
    if (match?.project.markerUri.toString() !== project.markerUri.toString()
      || match.documentType.editor !== GRAPH_EDITOR_ID
      || match.documentType.id !== location.documentTypeId) {
      throw new Error("Graph reference location is outside its declared Project Document Type.");
    }
    const uriKey = uri.toString();
    const session = [...(this.graphSessions.get(uriKey) ?? [])][0];
    if (session !== undefined) {
      await session.reveal(target);
      return;
    }
    this.pendingGraphReveals.set(uriKey, target);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, OPTIONAL_EDITOR_VIEW_TYPE);
    } catch (error) {
      if (this.pendingGraphReveals.get(uriKey) === target) {
        this.pendingGraphReveals.delete(uriKey);
      }
      throw error;
    }
  }

  public async revealEntityReference(location: ReferenceLocation): Promise<void> {
    const target = readEntityRevealTarget(location);
    if (target === undefined || !isProjectRelativePath(location.path)) {
      throw new Error("Invalid Entity component reference location.");
    }
    const project = this.projects.projects.find(
      (candidate) => candidate.definition.projectId === location.projectId,
    );
    if (project === undefined) {
      throw new Error(`VisualBridge Project '${location.projectId}' is not open.`);
    }
    const uri = vscode.Uri.joinPath(project.rootUri, ...location.path.split("/"));
    const match = this.projects.resolveDocument(uri);
    if (match?.project.markerUri.toString() !== project.markerUri.toString()
      || match.documentType.editor !== ENTITY_EDITOR_ID
      || match.documentType.id !== location.documentTypeId) {
      throw new Error("Entity reference location is outside its declared Project Document Type.");
    }
    const uriKey = uri.toString();
    const session = [...(this.entitySessions.get(uriKey) ?? [])][0];
    if (session !== undefined) {
      await session.reveal(target);
      return;
    }
    this.pendingEntityReveals.set(uriKey, target);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, OPTIONAL_EDITOR_VIEW_TYPE);
    } catch (error) {
      if (this.pendingEntityReveals.get(uriKey) === target) {
        this.pendingEntityReveals.delete(uriKey);
      }
      throw error;
    }
  }

  private removeGraphSession(uriKey: string, session: GraphEditorSession): void {
    const sessions = this.graphSessions.get(uriKey);
    sessions?.delete(session);
    if (sessions?.size === 0) {
      this.graphSessions.delete(uriKey);
    }
  }

  private removeEntitySession(uriKey: string, session: EntityEditorSession): void {
    const sessions = this.entitySessions.get(uriKey);
    sessions?.delete(session);
    if (sessions?.size === 0) {
      this.entitySessions.delete(uriKey);
    }
  }

  private removeStructuredSession(uriKey: string, session: StructuredEditorSession): void {
    const sessions = this.structuredSessions.get(uriKey);
    sessions?.delete(session);
    if (sessions?.size === 0) {
      this.structuredSessions.delete(uriKey);
    }
  }

  private createDiagnosticsOwner(uri: vscode.Uri): {
    readonly publish: (diagnostics: readonly vscode.Diagnostic[]) => void;
    readonly dispose: () => void;
  } {
    const uriKey = uri.toString();
    const owner = Symbol(uriKey);
    let disposed = false;
    return {
      publish: (diagnostics) => {
        if (disposed) {
          return;
        }
        let snapshots = this.sessionDiagnostics.get(uriKey);
        if (snapshots === undefined) {
          snapshots = new Map();
          this.sessionDiagnostics.set(uriKey, snapshots);
        }
        snapshots.set(owner, diagnostics);
        this.publishDiagnostics(uri, snapshots);
      },
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const snapshots = this.sessionDiagnostics.get(uriKey);
        snapshots?.delete(owner);
        if (snapshots === undefined || snapshots.size === 0) {
          this.sessionDiagnostics.delete(uriKey);
          this.diagnostics.delete(uri);
          return;
        }
        this.publishDiagnostics(uri, snapshots);
      },
    };
  }

  private publishDiagnostics(
    uri: vscode.Uri,
    snapshots: ReadonlyMap<symbol, readonly vscode.Diagnostic[]>,
  ): void {
    const published = new Map<string, vscode.Diagnostic>();
    for (const diagnostics of snapshots.values()) {
      for (const diagnostic of diagnostics) {
        published.set(diagnosticIdentity(diagnostic), diagnostic);
      }
    }
    this.diagnostics.set(uri, [...published.values()]);
  }

  private addInitializedPanel(uriKey: string, panel: vscode.WebviewPanel): void {
    let panels = this.initializedPanels.get(uriKey);
    if (panels === undefined) {
      panels = new Set();
      this.initializedPanels.set(uriKey, panels);
    }
    panels.add(panel);
  }

  private removeInitializedPanel(uriKey: string, panel: vscode.WebviewPanel): void {
    const panels = this.initializedPanels.get(uriKey);
    panels?.delete(panel);
    if (panels?.size === 0) {
      this.initializedPanels.delete(uriKey);
    }
  }
}

function diagnosticIdentity(diagnostic: vscode.Diagnostic): string {
  const code = typeof diagnostic.code === "object"
    ? `${diagnostic.code.value}:${diagnostic.code.target.toString()}`
    : String(diagnostic.code ?? "");
  const { start, end } = diagnostic.range;
  return [
    start.line,
    start.character,
    end.line,
    end.character,
    diagnostic.severity,
    diagnostic.source ?? "",
    code,
    diagnostic.message,
  ].join("\u0000");
}

function isProjectRelativePath(value: string): boolean {
  return !value.includes("\\")
    && !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
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
