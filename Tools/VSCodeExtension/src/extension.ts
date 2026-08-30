import * as vscode from "vscode";
import type {
  DocumentLifecycleDeleteTarget,
  ProjectProviderDocumentSnapshot,
  ReferenceLocation,
} from "@visualbridge/core";
import { TABLE_EDITOR_ID } from "@visualbridge/table";
import { CatalogBrowser } from "./catalog/catalogBrowser";
import { createDocument } from "./commands/createDocument";
import { createEntityDocument } from "./commands/createEntityDocument";
import { createGraphDocument } from "./commands/createGraphDocument";
import { createStructuredDocument } from "./commands/createStructuredDocument";
import { createTableDocument } from "./commands/createTableDocument";
import { DocumentBrowser } from "./document/documentBrowser";
import { WorkspaceDocumentIndex } from "./document/workspaceDocumentIndex";
import { WorkspaceDocumentLifecycle, WorkspaceLifecycleError } from "./document/workspaceDocumentLifecycle";
import {
  DEFAULT_EDITOR_VIEW_TYPE,
  DocumentEditorProvider,
  OPTIONAL_EDITOR_VIEW_TYPE,
} from "./editor/documentEditorProvider";
import { TABLE_EDITOR_VIEW_TYPE, TableEditorProvider } from "./editor/tableEditorProvider";
import { ProjectRegistry } from "./project/projectRegistry";
import {
  PROJECT_SETTINGS_EDITOR_VIEW_TYPE,
  ProjectSettingsEditorProvider,
} from "./project/projectSettingsEditorProvider";
import { WorkspaceProjectProviderService } from "./provider/workspaceProjectProviderService";
import {
  REVEAL_REFERENCE_COMMAND,
  WorkspaceReferenceService,
} from "./reference/workspaceReferenceService";
import { WorkspaceReferenceRefactor } from "./refactor/workspaceReferenceRefactor";

interface LifecycleElementDeleteRequest {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly path: string;
  readonly target: Exclude<DocumentLifecycleDeleteTarget, { readonly kind: "document" }>;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VisualBridge", { log: true });
  const projectDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-project");
  const documentDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-document");
  const workspaceDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-workspace");
  const catalogDiagnostics = vscode.languages.createDiagnosticCollection("visualbridge-catalog");
  const projects = new ProjectRegistry(projectDiagnostics, output);
  const projectProviders = new WorkspaceProjectProviderService(projects, output);
  const references = new WorkspaceReferenceService(projects, output, projectProviders);
  const documents = new WorkspaceDocumentIndex(
    projects,
    references,
    workspaceDiagnostics,
    output,
    projectProviders,
  );
  const editorProvider = new DocumentEditorProvider(
    context.extensionUri,
    projects,
    references,
    documentDiagnostics,
    output,
  );
  const projectSettingsEditor = new ProjectSettingsEditorProvider(context.extensionUri, projects, output);
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
  tableEditorProvider.setReferenceTargetRenamer((request) => refactors.renameTarget(request));
  const lifecycle = new WorkspaceDocumentLifecycle(
    projects,
    documents,
    references,
    tableEditorProvider,
    output,
  );
  const browser = new DocumentBrowser(projects, documents, references, refactors, lifecycle);
  const catalogBrowser = new CatalogBrowser(projects, catalogDiagnostics, output);
  const catalogTree = vscode.window.createTreeView("visualbridge.catalogs", {
    treeDataProvider: catalogBrowser,
    showCollapseAll: true,
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "VisualBridge Projects";
  status.command = "visualbridge.refreshProjects";

  const safeDeleteElement = async (
    request: LifecycleElementDeleteRequest,
    confirm: boolean,
  ): Promise<{ readonly mutationCount: number; readonly ownedIdentityKeys: readonly string[] } | undefined> => {
    let document = documents.documents.find((candidate) => (
      candidate.projectId === request.projectId
      && candidate.documentTypeId === request.documentTypeId
      && candidate.path === request.path
    ));
    if (document === undefined) {
      const refreshed = await documents.refresh();
      if (refreshed.status !== "applied") throw new Error("Document Index is unavailable for Safe Delete.");
      document = documents.documents.find((candidate) => (
        candidate.projectId === request.projectId
        && candidate.documentTypeId === request.documentTypeId
        && candidate.path === request.path
      ));
    }
    if (document === undefined) throw new Error("Safe Delete source is not indexed.");
    const preview = await lifecycle.previewDelete(document, request.target);
    if (preview.preview.plan.blockers.length > 0) {
      throw new WorkspaceLifecycleError(
        "lifecycle.blocked",
        preview.preview.plan.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("\n"),
      );
    }
    if (confirm) {
      const accepted = await vscode.window.showWarningMessage(
        `Safe Delete '${request.target.kind}' through lifecycle preview/apply?`,
        {
          modal: true,
          detail: JSON.stringify({
            operation: preview.preview.plan.operation,
            ownedIdentities: preview.preview.plan.ownedIdentities,
            referenceImpacts: preview.preview.plan.referenceImpacts,
            baseHashes: preview.preview.plan.baseHashes,
            dependencies: preview.preview.plan.dependencies,
            mutations: preview.preview.plan.mutations,
          }, undefined, 2),
        },
        "Safe Delete",
      );
      if (accepted !== "Safe Delete") return undefined;
    }
    await lifecycle.apply(preview);
    return {
      mutationCount: preview.preview.plan.mutations.length,
      ownedIdentityKeys: preview.preview.plan.ownedIdentities.map((identity) => identity.identityKey),
    };
  };

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "visualbridge.test.isEditorReady",
        (uri: vscode.Uri) => editorProvider.isEditorReady(uri)
          || tableEditorProvider.isEditorReady(uri)
          || projectSettingsEditor.isReady(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getProjectSettingsState",
        (uri: vscode.Uri) => projectSettingsEditor.getTestState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.applyProjectOperations",
        (uri: vscode.Uri, sourceHash: string, operations: unknown) => (
          projectSettingsEditor.applyOperationsForTest(uri, sourceHash, operations)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getCatalogBrowserSnapshot",
        () => catalogBrowser.snapshot(),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getDocumentIndexSnapshot",
        () => ({ documents: documents.documents, stats: documents.refreshStats }),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.rebuildDocumentIndex",
        async () => {
          const result = await documents.rebuild();
          return { result, documents: documents.documents, stats: documents.refreshStats };
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.cancelDocumentIndexRefreshAtPhase",
        async (phase: "discover" | "semantic" | "reference" | "provider" = "reference") => {
          const controller = new AbortController();
          let observed = false;
          const subscription = documents.onDidProgress((event) => {
            if (!observed && event.phase === phase) {
              observed = true;
              controller.abort();
            }
          });
          try {
            const result = await documents.refresh(controller.signal);
            return { result, observed, documents: documents.documents, stats: documents.refreshStats };
          } finally {
            subscription.dispose();
          }
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.validateProviderDocument",
        async (
          markerUri: vscode.Uri,
          snapshot: ProjectProviderDocumentSnapshot,
          dependencyKey: string,
          abortAfterMilliseconds?: number,
        ) => {
          const markerIdentity = process.platform === "win32"
            ? markerUri.fsPath.toLowerCase()
            : markerUri.fsPath;
          const project = projects.projects.find((candidate) => (
            (process.platform === "win32"
              ? candidate.markerUri.fsPath.toLowerCase()
              : candidate.markerUri.fsPath) === markerIdentity
          ));
          if (project === undefined) throw new Error(`Project '${markerUri.toString()}' is unavailable.`);
          const controller = abortAfterMilliseconds === undefined ? undefined : new AbortController();
          const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), abortAfterMilliseconds);
          try {
            return await projectProviders.validateDocument(project, snapshot, controller?.signal, dependencyKey);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.resolveDocument",
        (uri: vscode.Uri) => {
          const match = projects.resolveDocument(uri);
          return match === undefined ? undefined : {
            projectId: match.project.definition.projectId,
            documentTypeId: match.documentType.id,
            relativePath: match.relativePath,
          };
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getTableEditorState",
        (uri: vscode.Uri) => tableEditorProvider.getTestState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getGraphEditorState",
        (uri: vscode.Uri) => editorProvider.getGraphEditorTestState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getEntityEditorState",
        (uri: vscode.Uri) => editorProvider.getEntityEditorTestState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.pauseNextTableReveal",
        (uri: vscode.Uri) => tableEditorProvider.pauseNextRevealForTest(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.applyTableOperations",
        (uri: vscode.Uri, operations: unknown) => tableEditorProvider.applyOperationsForTest(uri, operations),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.applyDocumentOperations",
        (uri: vscode.Uri, editor: "entity" | "graph" | "structured", operations: unknown) => (
          editorProvider.applyOperationsForTest(uri, editor, operations)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.applyStructuredOperationsAfterExternalWrite",
        (uri: vscode.Uri, externalText: string, operations: unknown) => (
          editorProvider.applyOperationsAfterExternalWriteForTest(uri, externalText, operations)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.assertIdentityOperationsAllowed",
        (uri: vscode.Uri, editor: "entity" | "graph", operations: unknown) => (
          editorProvider.assertIdentityOperationsAllowedForTest(uri, editor, operations)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.saveTable",
        (uri: vscode.Uri) => tableEditorProvider.saveForTest(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.failReferenceRefactorCommittedRefresh",
        (phase: "tableEditor" | "documentIndex", message: string) => (
          refactors.failCommittedRefreshForTest(phase, message)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.renameReferenceTarget",
        (request: import("./refactor/workspaceReferenceRefactor").WorkspaceReferenceTargetRenameRequest) => (
          refactors.renameTarget(request)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.lifecycleMove",
        async (request: {
          readonly projectId: string;
          readonly sourcePath: string;
          readonly targetPath: string;
          readonly dirtyBeforeMutatePath?: string;
          readonly failCommittedRefresh?: boolean;
        }) => {
          let project = projects.projects.find((candidate) => candidate.definition.projectId === request.projectId);
          if (project === undefined) {
            await projects.refresh();
            project = projects.projects.find((candidate) => candidate.definition.projectId === request.projectId);
          }
          let document = documents.documents.find((candidate) => (
            candidate.projectId === request.projectId && candidate.path === request.sourcePath
          ));
          if (document === undefined) {
            await documents.refresh();
            document = documents.documents.find((candidate) => (
              candidate.projectId === request.projectId && candidate.path === request.sourcePath
            ));
          }
          if (document === undefined || project === undefined) throw new Error("Lifecycle test source was not indexed.");
          const preview = await lifecycle.previewMove(
            document,
            vscode.Uri.joinPath(project.rootUri, ...request.targetPath.split("/")),
          );
          if (request.dirtyBeforeMutatePath !== undefined) {
            const dirtyUri = vscode.Uri.joinPath(project.rootUri, ...request.dirtyBeforeMutatePath.split("/"));
            lifecycle.setBeforeMutateHookForTest(async () => {
              const dirtyDocument = await vscode.workspace.openTextDocument(dirtyUri);
              const edit = new vscode.WorkspaceEdit();
              edit.insert(dirtyUri, new vscode.Position(0, 0), " ");
              if (!await vscode.workspace.applyEdit(edit) || !dirtyDocument.isDirty) {
                throw new Error("Lifecycle test could not make the requested source dirty.");
              }
            });
          }
          if (request.failCommittedRefresh === true) {
            lifecycle.failCommittedRefreshForTest("injected post-commit refresh failure");
          }
          await lifecycle.apply(preview);
          return {
            previewHash: preview.preview.previewHash,
            mutationCount: preview.preview.plan.mutations.length,
            referenceImpacts: preview.preview.plan.referenceImpacts,
            ...lifecycle.getLastApplyStatusForTest(),
          };
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.lifecycleCreate",
        async (request: {
          readonly projectId: string;
          readonly documentTypeId: string;
          readonly targetPath: string;
          readonly parameters: Readonly<Record<string, import("@visualbridge/core").JsonValue>>;
        }) => {
          let project = projects.projects.find((candidate) => candidate.definition.projectId === request.projectId);
          if (project === undefined) {
            await projects.refresh();
            project = projects.projects.find((candidate) => candidate.definition.projectId === request.projectId);
          }
          const documentType = project?.definition.documentTypes.find((candidate) => candidate.id === request.documentTypeId);
          if (project === undefined || documentType === undefined) throw new Error("Lifecycle test target type was not found.");
          const preview = await lifecycle.previewCreate(
            project,
            documentType,
            vscode.Uri.joinPath(project.rootUri, ...request.targetPath.split("/")),
            request.parameters,
          );
          await lifecycle.apply(preview);
          return {
            previewHash: preview.preview.previewHash,
            mutationCount: preview.preview.plan.mutations.length,
            ownedIdentities: preview.preview.plan.ownedIdentities,
            referenceImpacts: preview.preview.plan.referenceImpacts,
            baseHashes: preview.preview.plan.baseHashes,
            dependencies: preview.preview.plan.dependencies,
          };
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.lifecycleCopy",
        async (request: {
          readonly projectId: string;
          readonly sourcePath: string;
          readonly targetPath: string;
          readonly stableIdRemap: readonly import("@visualbridge/core").StableIdentityRemap[];
          readonly previewOnly?: boolean;
        }) => {
          let project = projects.projects.find((candidate) => candidate.definition.projectId === request.projectId);
          if (project === undefined) {
            await projects.refresh();
            project = projects.projects.find((candidate) => candidate.definition.projectId === request.projectId);
          }
          let document = documents.documents.find((candidate) => candidate.projectId === request.projectId && candidate.path === request.sourcePath);
          if (document === undefined) {
            await documents.refresh();
            document = documents.documents.find((candidate) => candidate.projectId === request.projectId && candidate.path === request.sourcePath);
          }
          if (project === undefined || document === undefined) throw new Error("Lifecycle test copy source was not indexed.");
          const preview = await lifecycle.previewCopy(
            document,
            vscode.Uri.joinPath(project.rootUri, ...request.targetPath.split("/")),
            request.stableIdRemap,
          );
          if (request.previewOnly !== true) await lifecycle.apply(preview);
          return {
            previewHash: preview.preview.previewHash,
            mutationCount: preview.preview.plan.mutations.length,
            ownedIdentities: preview.preview.plan.ownedIdentities,
            referenceImpacts: preview.preview.plan.referenceImpacts,
            baseHashes: preview.preview.plan.baseHashes,
            dependencies: preview.preview.plan.dependencies,
            blockers: preview.preview.plan.blockers,
            mutations: preview.preview.plan.mutations,
          };
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.lifecycleDelete",
        async (request: { readonly projectId: string; readonly sourcePath: string }) => {
          if (!projects.projects.some((candidate) => candidate.definition.projectId === request.projectId)) {
            await projects.refresh();
          }
          let document = documents.documents.find((candidate) => (
            candidate.projectId === request.projectId && candidate.path === request.sourcePath
          ));
          if (document === undefined) {
            await documents.refresh();
            document = documents.documents.find((candidate) => (
              candidate.projectId === request.projectId && candidate.path === request.sourcePath
            ));
          }
          if (document === undefined) throw new Error("Lifecycle test source was not indexed.");
          const preview = await lifecycle.previewDelete(document);
          await lifecycle.apply(preview);
          return { previewHash: preview.preview.previewHash, mutationCount: preview.preview.plan.mutations.length };
        },
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.lifecycleDeleteElement",
        (request: LifecycleElementDeleteRequest) => safeDeleteElement(request, false),
      ),
    );
  }

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
    catalogDiagnostics,
    projects,
    projectProviders,
    references,
    documents,
    browser,
    catalogBrowser,
    catalogTree,
    projectSettingsEditor,
    status,
    projects.onDidChange(updateStatus),
    documents.onDidChange(() => void catalogBrowser.refresh()),
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
    vscode.commands.registerCommand("visualbridge.openProjectSettings", async (resource?: vscode.Uri) => {
      let uri = resource;
      if (uri === undefined) {
        const selected = await vscode.window.showQuickPick(projects.projects.map((project) => ({
          label: project.definition.projectId,
          description: project.markerUri.fsPath,
          uri: project.markerUri,
        })), { title: "Open VisualBridge Project Settings" });
        uri = selected?.uri;
      }
      if (uri !== undefined) await vscode.commands.executeCommand("vscode.openWith", uri, PROJECT_SETTINGS_EDITOR_VIEW_TYPE);
    }),
    vscode.commands.registerCommand("visualbridge.catalogBrowser.refresh", () => catalogBrowser.refresh()),
    vscode.commands.registerCommand("visualbridge.catalogBrowser.open", async (uri?: vscode.Uri) => {
      if (uri !== undefined) await vscode.window.showTextDocument(uri, { preview: true });
    }),
    vscode.commands.registerCommand("visualbridge.createGraphDocument", async () => {
      await createGraphDocument(projects, lifecycle);
    }),
    vscode.commands.registerCommand("visualbridge.createEntityDocument", async () => {
      await createEntityDocument(projects, lifecycle);
    }),
    vscode.commands.registerCommand("visualbridge.createStructuredDocument", async () => {
      await createStructuredDocument(projects, lifecycle);
    }),
    vscode.commands.registerCommand("visualbridge.createTableDocument", async () => {
      await createTableDocument(projects, lifecycle);
    }),
    vscode.commands.registerCommand("visualbridge.createDocument", async () => {
      await createDocument(projects, lifecycle);
    }),
    vscode.commands.registerCommand("visualbridge.safeDeleteElement", async (request?: LifecycleElementDeleteRequest) => {
      if (request === undefined) {
        void vscode.window.showWarningMessage("Safe Delete Element requires a structured element target from a VisualBridge editor.");
        return;
      }
      try {
        return await safeDeleteElement(request, true);
      } catch (errorValue) {
        void vscode.window.showWarningMessage(errorValue instanceof Error ? errorValue.message : String(errorValue));
        return undefined;
      }
    }),
    vscode.commands.registerCommand(REVEAL_REFERENCE_COMMAND, async (location) => {
      if (isTableReferenceLocation(location)) {
        await tableEditorProvider.revealReference(location);
        return;
      }
      if (!isReferenceLocation(location)) {
        throw new Error("Invalid VisualBridge reference location.");
      }
      if (isGraphElementReferenceLocation(location)) {
        await editorProvider.revealGraphReference(location);
        return;
      }
      if (isEntityComponentReferenceLocation(location)) {
        await editorProvider.revealEntityReference(location);
        return;
      }
      const project = projects.projects.find((candidate) => candidate.definition.projectId === location.projectId);
      if (project === undefined) throw new Error(`VisualBridge Project '${location.projectId}' is not open.`);
      const uri = vscode.Uri.joinPath(project.rootUri, ...location.path.split("/"));
      const match = projects.resolveDocument(uri);
      if (match?.project.markerUri.toString() !== project.markerUri.toString()
        || match.documentType.id !== location.documentTypeId) {
        throw new Error("Reference location is outside its declared Project Document Type.");
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        match.documentType.editor === TABLE_EDITOR_ID ? TABLE_EDITOR_VIEW_TYPE : OPTIONAL_EDITOR_VIEW_TYPE,
      );
    }),
    vscode.window.registerCustomEditorProvider(DEFAULT_EDITOR_VIEW_TYPE, editorProvider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerCustomEditorProvider(OPTIONAL_EDITOR_VIEW_TYPE, editorProvider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerCustomEditorProvider(PROJECT_SETTINGS_EDITOR_VIEW_TYPE, projectSettingsEditor, {
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
  await catalogBrowser.refresh();
  updateStatus();
  output.appendLine("[extension] VisualBridge extension shell activated.");
}

export function deactivate(): void {}

function isReferenceLocation(value: unknown): value is ReferenceLocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const location = value as Record<string, unknown>;
  return typeof location.projectId === "string"
    && typeof location.documentTypeId === "string"
    && typeof location.path === "string"
    && !location.path.includes("\\")
    && !location.path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function isTableReferenceLocation(value: unknown): boolean {
  return isReferenceLocation(value) && value.sheetId !== undefined && value.rowId !== undefined;
}

function isGraphElementReferenceLocation(value: unknown): boolean {
  return isReferenceLocation(value)
    && (value.elementKind === "graph"
      || value.elementKind === "node"
      || value.elementKind === "interfacePort"
      || value.elementKind === "dynamicPort");
}

function isEntityComponentReferenceLocation(value: unknown): boolean {
  return isReferenceLocation(value)
    && value.elementKind === "component"
    && value.componentId !== undefined
    && value.elementId === value.componentId;
}
