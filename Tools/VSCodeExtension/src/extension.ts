import * as vscode from "vscode";
import { createGraphDocument } from "./commands/createGraphDocument";
import {
  DEFAULT_EDITOR_VIEW_TYPE,
  DocumentEditorProvider,
  OPTIONAL_EDITOR_VIEW_TYPE,
} from "./editor/documentEditorProvider";
import { ProjectRegistry } from "./project/projectRegistry";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VisualBridge", { log: true });
  const projectDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-project");
  const documentDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-document");
  const projects = new ProjectRegistry(projectDiagnostics, output);
  const editorProvider = new DocumentEditorProvider(
    context.extensionUri,
    projects,
    documentDiagnostics,
    output,
  );
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
    projects,
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

      await vscode.commands.executeCommand("vscode.openWith", uri, OPTIONAL_EDITOR_VIEW_TYPE);
    }),
    vscode.commands.registerCommand("visualbridge.createGraphDocument", async () => {
      await createGraphDocument(projects);
    }),
    vscode.window.registerCustomEditorProvider(DEFAULT_EDITOR_VIEW_TYPE, editorProvider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerCustomEditorProvider(OPTIONAL_EDITOR_VIEW_TYPE, editorProvider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  await projects.initialize();
  updateStatus();
  output.appendLine("[extension] VisualBridge extension shell activated.");
}

export function deactivate(): void {}
