import * as vscode from "vscode";
import { TABLE_EDITOR_ID } from "@visualbridge/table";
import { createDocument } from "./commands/createDocument";
import { createEntityDocument } from "./commands/createEntityDocument";
import { createGraphDocument } from "./commands/createGraphDocument";
import { createStructuredDocument } from "./commands/createStructuredDocument";
import { createTableDocument } from "./commands/createTableDocument";
import { DocumentBrowser } from "./document/documentBrowser";
import { WorkspaceDocumentIndex } from "./document/workspaceDocumentIndex";
import {
  DEFAULT_EDITOR_VIEW_TYPE,
  DocumentEditorProvider,
  OPTIONAL_EDITOR_VIEW_TYPE,
} from "./editor/documentEditorProvider";
import { TABLE_EDITOR_VIEW_TYPE, TableEditorProvider } from "./editor/tableEditorProvider";
import { ProjectRegistry } from "./project/projectRegistry";
import {
  REVEAL_REFERENCE_COMMAND,
  WorkspaceReferenceService,
} from "./reference/workspaceReferenceService";
import { WorkspaceReferenceRefactor } from "./refactor/workspaceReferenceRefactor";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VisualBridge", { log: true });
  const projectDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-project");
  const documentDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-document");
  const workspaceDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-workspace");
  const projects = new ProjectRegistry(projectDiagnostics, output);
  const references = new WorkspaceReferenceService(projects, output);
  const documents = new WorkspaceDocumentIndex(projects, references, workspaceDiagnostics, output);
  const editorProvider = new DocumentEditorProvider(
    context.extensionUri,
    projects,
    references,
    documentDiagnostics,
    output,
  );
  const tableEditorProvider = new TableEditorProvider(
    context.extensionUri,
    projects,
    references,
    documentDiagnostics,
    output,
  );
  const refactors = new WorkspaceReferenceRefactor(
    projects,
    documents,
    references,
    tableEditorProvider,
    output,
  );
  const browser = new DocumentBrowser(projects, documents, references, refactors);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "VisualBridge Projects";
  status.command = "visualbridge.refreshProjects";

  const updateStatus = (): void => {
    if (projects.projects.length === 0) {
      status.hide();
      return;
    }

    const suffix = projects.projects.length === 1 ? "Project" : "Projects";
    status.text = `$(symbol-namespace) VisualBridge: ${projects.projects.length} ${suffix}`;
    status.tooltip = projects.projects
      .map((project) => `${project.definition.projectId} — ${project.rootUri.fsPath}`)
      .join("\n");
    status.show();
  };

  context.subscriptions.push(
    output,
    projectDiagnostics,
    documentDiagnostics,
    workspaceDiagnostics,
    projects,
    references,
    documents,
    browser,
    status,
    projects.onDidChange(updateStatus),
    vscode.commands.registerCommand("visualbridge.refreshProjects", async () => {
      await projects.refresh();
      const message = projects.projects.length === 0
        ? "No valid VisualBridge project was found in this workspace."
        : `Loaded ${projects.projects.length} VisualBridge project(s).`;
      void vscode.window.showInformationMessage(message);
    }),
    vscode.commands.registerCommand("visualbridge.openDocument", async (resource?: vscode.Uri) => {
      const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (uri === undefined) {
        void vscode.window.showWarningMessage("Select a file to open with VisualBridge.");
        return;
      }

      const match = projects.resolveDocument(uri);
      if (match === undefined) {
        void vscode.window.showWarningMessage(
          "The file is not included by a valid VisualBridge Project File.",
        );
        return;
      }

      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        match.documentType.editor === TABLE_EDITOR_ID ? TABLE_EDITOR_VIEW_TYPE : OPTIONAL_EDITOR_VIEW_TYPE,
      );
    }),
    vscode.commands.registerCommand("visualbridge.createGraphDocument", async () => {
      await createGraphDocument(projects);
    }),
    vscode.commands.registerCommand("visualbridge.createEntityDocument", async () => {
      await createEntityDocument(projects);
    }),
    vscode.commands.registerCommand("visualbridge.createStructuredDocument", async () => {
      await createStructuredDocument(projects);
    }),
    vscode.commands.registerCommand("visualbridge.createTableDocument", async () => {
      await createTableDocument(projects);
    }),
    vscode.commands.registerCommand("visualbridge.createDocument", async () => {
      await createDocument(projects);
    }),
    vscode.commands.registerCommand(REVEAL_REFERENCE_COMMAND, async (location) => {
      await tableEditorProvider.revealReference(location);
    }),
    vscode.window.registerCustomEditorProvider(DEFAULT_EDITOR_VIEW_TYPE, editorProvider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerCustomEditorProvider(OPTIONAL_EDITOR_VIEW_TYPE, editorProvider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    tableEditorProvider,
    vscode.window.registerCustomEditorProvider(TABLE_EDITOR_VIEW_TYPE, tableEditorProvider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  await projects.initialize();
  await documents.initialize();
  updateStatus();
  output.appendLine("[extension] VisualBridge extension shell activated.");
}

export function deactivate(): void {}
