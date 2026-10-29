import * as vscode from "vscode";
import path from "node:path";
import type {
  DocumentLifecycleDeleteTarget,
  ProjectProviderDocumentSnapshot,
  ReferenceLocation,
} from "@visualbridge/core";
import { RuntimeBridgeService } from "./bridge/runtimeBridgeService";
import { parseRuntimeBridgeDiscoveryRecord, parseRuntimeBridgeMessage, RuntimeBridgeProtocolError } from "./bridge/runtimeBridgeProtocol";
import { CatalogBrowser } from "./catalog/catalogBrowser";
import { createDocument } from "./commands/createDocument";
import { DocumentBrowser } from "./document/documentBrowser";
import { WorkspaceDocumentIndex } from "./document/workspaceDocumentIndex";
import { WorkspaceDocumentLifecycle, WorkspaceLifecycleError } from "./document/workspaceDocumentLifecycle";
import {
  UnsavedDocumentsTree,
  discardAllUnsavedDocuments,
  saveAllUnsavedDocuments,
} from "./document/unsavedDocuments";
import {
  DEFAULT_EDITOR_VIEW_TYPE,
  DocumentEditorProvider,
  OPTIONAL_EDITOR_VIEW_TYPE,
} from "./editor/documentEditorProvider";
import { TABLE_EDITOR_VIEW_TYPE, TableEditorProvider } from "./editor/tableEditorProvider";
import { TableEditorGate } from "./editor/tableEditorGate";
import { ProjectRegistry, type ProjectContext } from "./project/projectRegistry";
import {
  PROJECT_SETTINGS_EDITOR_VIEW_TYPE,
  ProjectSettingsEditorProvider,
} from "./project/projectSettingsEditorProvider";
import { HostModuleRegistry } from "./modules/hostModuleRegistry";
import {
  catalogFacetFor,
  documentFacetEntries,
  documentFacetFor,
  documentFacetSourcesForTest,
} from "./modules/documentFacetRegistry";
import { createBundleModuleSource } from "./modules/bundleModuleSource";
import { WorkspaceProjectProviderService } from "./provider/workspaceProjectProviderService";
import {
  REVEAL_REFERENCE_COMMAND,
  WorkspaceReferenceService,
} from "./reference/workspaceReferenceService";
import { WorkspaceReferenceRefactor } from "./refactor/workspaceReferenceRefactor";
import { EditorBridgeServer } from "./bridge/editorBridgeServer";
import { DebugRecordingHost } from "./bridge/debugRecordingHost";
import { BridgeProtocolError, parseBridgeMessage, parseDiscoveryRecord } from "./bridge/bridgeProtocol";
import { RuntimeDebugAdapter } from "./debug/runtimeDebugAdapter";
import { RuntimeDebugConfigurationProvider, RUNTIME_DEBUG_TYPE } from "./debug/runtimeDebugConfigurationProvider";
import { DebugPanelController } from "./debug/debugPanelController";
import { RuntimePanelConnection } from "./debug/runtimePanelConnection";
import { DebugRecordingService } from "./debug/debugRecordingService";
import { DebugReplaySession } from "./bridge/debugReplaySession";
import { DebugFacetHost } from "./debug/debugFacetRouter";
import { collectDebugFacetSources } from "./debug/debugFacetSources";
import type { DebugEnvelope } from "./bridge/debugIngress";

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
  // 宿主模块注册表：C2 起由 ModuleLoader 支撑（`Tools/NodeHost` 里唯一一份装载实现）。
  // 装载受 Workspace Trust 门禁；未受信任时注册源不求值任何 bundle。
  // 注册源的信任判定要跟宿主一致（含测试 override），因此延迟绑定到 registry 本身。
  const modules: HostModuleRegistry = new HostModuleRegistry(
    projects,
    createBundleModuleSource({
      modulesRoot: vscode.Uri.joinPath(context.globalStorageUri, "modules"),
      output,
      isTrusted: () => modules.isTrusted(),
    }),
    output,
  );
  const projectProviders = new WorkspaceProjectProviderService(projects, output);
  const references = new WorkspaceReferenceService(projects, output, projectProviders);
  const documents = new WorkspaceDocumentIndex(
    projects,
    modules,
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
    modules,
  );
  const projectSettingsEditor = new ProjectSettingsEditorProvider(
    context.extensionUri,
    projects,
    modules,
    output,
  );
  const tableEditorProvider = new TableEditorProvider(
    context.extensionUri,
    projects,
    references,
    documentDiagnostics,
    output,
    modules,
  );
  // Table 编辑器入口统一走模块门禁：未受信任/模块失败时只给只读 Shell（P0）。
  const tableEditorGate = new TableEditorGate(tableEditorProvider, projects, modules, output);
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
  const browser = new DocumentBrowser(projects, documents, references, refactors, lifecycle, modules);
  const catalogBrowser = new CatalogBrowser(projects, modules, catalogDiagnostics, output);
  // 在注册任何编辑器/命令之前完成项目加载：窗口重启恢复编辑器标签页时，
  // VS Code 会在提供器注册后立刻调用 openCustomDocument，此时若 Project Registry
  // 尚未完成首次刷新，文档解析会失败并留下无法恢复的死标签页。
  await projects.initialize();
  // 模块首次装载也必须在注册 Custom Editor 之前完成，否则首批文档会错误回退只读 Shell。
  await modules.initialize();

  // `VB_SKIP_MODULES=1`：受信任也跳过装载，用于把"编辑器自身的问题"与"模块的问题"分开排查。
  if (modules.authorization === "skipped") {
    void vscode.window.showWarningMessage(
      "VB_SKIP_MODULES=1：已跳过模块装载，领域编辑器回退为只读视图。",
    );
  }

  /**
   * 模块 bundle 变更后提示重载。
   *
   * 只标 `stale` 不动正在运行的实例：重载会重建 loader 与解包资产，用户可能在编辑中，
   * 因此必须由用户确认（VS Code 自己在文件变化时也不强杀面板）。
   */
  const moduleWatcher = vscode.workspace.createFileSystemWatcher("**/*.vbmodule.js");
  let pendingModuleReload = false;
  const promptModuleReload = async (): Promise<void> => {
    if (pendingModuleReload) return;
    pendingModuleReload = true;
    try {
      const stale = await modules.refreshStale();
      if (stale.length === 0) return;
      output.appendLine(`[modules] 模块字节已变化：${stale.join(", ")}`);
      const choice = await vscode.window.showWarningMessage(
        `检测到模块文件变化（${stale.join(", ")}）。重新加载模块？`,
        "重新加载模块",
      );
      if (choice !== "重新加载模块") return;
      // force：注册源在模块定义未变时会复用旧 loader，不强制丢弃就等于"点了没反应"。
      await modules.reloadAllProjects("moduleFileChanged", true);
    } finally {
      pendingModuleReload = false;
    }
  };
  moduleWatcher.onDidChange(() => void promptModuleReload());
  moduleWatcher.onDidCreate(() => void promptModuleReload());
  const catalogTree = vscode.window.createTreeView("visualbridge.catalogs", {
    treeDataProvider: catalogBrowser,
    showCollapseAll: true,
  });
  const unsavedDocumentsTree = new UnsavedDocumentsTree(projects, tableEditorProvider);
  const unsavedDocumentsView = vscode.window.createTreeView("visualbridge.unsavedDocuments", {
    treeDataProvider: unsavedDocumentsTree,
  });
  unsavedDocumentsTree.attachView(unsavedDocumentsView);
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

  /**
   * 命令级模块门禁：模块未加载（未信任 / 失败 / 停用 / 未声明）时不得执行领域代码。
   * 返回 true 表示至少有一个工程已加载该 editor，命令可以继续。
   */
  const requireAvailableEditor = async (editor: string): Promise<boolean> => {
    let reason: string | undefined;
    for (const project of projects.projects) {
      if (!project.definition.documentTypes.some((documentType) => documentType.editor === editor)) continue;
      await modules.ensureProject(project);
      const availability = modules.editorAvailability(project, editor);
      if (availability.kind === "available") return true;
      reason ??= availability.message;
    }
    void vscode.window.showWarningMessage(
      reason ?? `没有工程声明编辑器 '${editor}'。`,
    );
    return false;
  };

  /** 模块未加载（未信任 / failed / disabled）时不得执行领域代码。 */
  const isEditorAvailable = (project: ProjectContext, editor: string): boolean => (
    modules.editorAvailability(project, editor).kind === "available"
  );

  context.subscriptions.push(moduleWatcher);

  /** 历史命令（每个领域一个）走同一条通用创建路径，只是预选 editor。 */
  const createDocumentForModule = async (moduleId: string): Promise<void> => {
    const editor = documentFacetEntries().find((entry) => entry.moduleId === moduleId)?.facet.editor;
    if (editor === undefined || !await requireAvailableEditor(editor)) return;
    await createDocument(projects, lifecycle, { editor, isEditorAvailable });
  };

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "visualbridge.test.isEditorReady",
        (uri: vscode.Uri) => editorProvider.isEditorReady(uri)
          || tableEditorProvider.isEditorReady(uri)
          || tableEditorGate.isReadonlyShellActive(uri)
          || projectSettingsEditor.isReady(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getProjectSettingsState",
        (uri: vscode.Uri) => projectSettingsEditor.getTestState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getModuleRegistryState",
        () => modules.testState,
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getReadonlyShellState",
        (uri: vscode.Uri) => editorProvider.getReadonlyShellState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getTableReadonlyShellState",
        (uri: vscode.Uri) => tableEditorGate.getReadonlyShellState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.assertTableShellReadonly",
        (uri: vscode.Uri) => tableEditorGate.assertReadonlyShellRejectsWritesForTest(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.setModuleActivationFailure",
        (moduleId: string | undefined) => modules.setActivationFailureForTest(moduleId ?? undefined),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getModuleStorageRoot",
        () => context.globalStorageUri.fsPath,
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.setModuleTrustOverride",
        (trusted: boolean | undefined) => modules.setTrustOverrideForTest(trusted ?? undefined),
      ),
      // 只改 Trust 状态、**不**触发重载：用来验证生产路径（ensureProject 的默认 force=false）
      // 真的会在授权漂移时释放旧 loader 并注销 facet。
      vscode.commands.registerCommand(
        "visualbridge.test.setModuleTrustWithoutReload",
        (trusted: boolean | undefined) => modules.setTrustOverrideWithoutReloadForTest(trusted ?? undefined),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getDocumentFacetSources",
        () => documentFacetSourcesForTest(),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.disposeProjectModulesForTest",
        (markerKey: string) => modules.disposeProjectModulesForTest(markerKey),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.simulateWorkspaceTrustGranted",
        () => modules.simulateGrantedTrustForTest(),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.refreshStaleModules",
        () => modules.refreshStale(),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.reloadModules",
        () => modules.reloadAllProjects("testReload", true),
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
        "visualbridge.test.getDocumentBrowserIncomingReferences",
        () => browser.incomingReferenceTestSnapshot(),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getDocumentDetailsSnapshot",
        (selector: { readonly projectId: string; readonly path: string }) => (
          browser.documentDetailsTestSnapshot(selector)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.showDocumentDetails",
        (
          selector: { readonly projectId: string; readonly path: string },
          group: "diagnostics" | "references",
        ) => browser.showDocumentDetailsForTest(selector, group),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.localizeDocumentDiagnostic",
        (diagnostic: import("@visualbridge/core").DocumentDiagnostic) => browser.localizeDiagnosticForTest(diagnostic),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.revealDocumentBrowserIncomingReference",
        (selector: {
          readonly projectId: string;
          readonly targetPath: string;
          readonly sourcePath: string;
          readonly occurrencePath: string;
        }) => browser.revealIncomingReferenceForTest(selector),
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
        "visualbridge.test.getGraphEditorDebugState",
        (uri: vscode.Uri) => editorProvider.getGraphEditorDebugState(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.sendGraphEditorDebugMessage",
        (uri: vscode.Uri, message: unknown) => editorProvider.sendGraphEditorDebugMessage(uri, message),
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
        "visualbridge.test.getTableOpenDiagnostics",
        (uri: vscode.Uri) => tableEditorProvider.openDiagnosticsForTest(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.applyDocumentOperations",
        (uri: vscode.Uri, editor: string, operations: unknown, revision?: number) => (
          editorProvider.applyOperationsForTest(uri, editor, operations, revision)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getEditorLastRejection",
        (uri: vscode.Uri) => editorProvider.getLastRejection(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getEditorLastOperationCompleted",
        (uri: vscode.Uri) => editorProvider.getLastOperationCompleted(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getTableLastOperationCompleted",
        (uri: vscode.Uri) => tableEditorProvider.getLastOperationCompleted(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.backupTableDocument",
        (uri: vscode.Uri, destination: vscode.Uri) => tableEditorProvider.backupForTest(uri, destination),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.restoreTableDocumentFromBackup",
        (uri: vscode.Uri, backup: vscode.Uri, save?: boolean) => (
          tableEditorProvider.restoreFromBackupForTest(uri, backup, save === true)
        ),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.revertTableDocument",
        (uri: vscode.Uri) => tableEditorProvider.revertForTest(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.getTableLastRejection",
        (uri: vscode.Uri) => tableEditorProvider.getLastRejection(uri),
      ),
      vscode.commands.registerCommand(
        "visualbridge.test.applyTableOperationsWithRevision",
        (uri: vscode.Uri, operations: unknown, revision: number) => (
          tableEditorProvider.applyOperationsWithRevisionForTest(uri, operations, revision)
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
        (uri: vscode.Uri, editor: string, operations: unknown) => (
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
    modules,
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

      // 模块未装载时不把文档交给领域编辑器：Table 一律走 TableEditorGate（不可用时给只读 Shell，
      // 二进制 XLSX 也不会落到 CustomTextEditorProvider 的文本 Shell），其余走通用只读 Shell。
      await modules.ensureProject(match.project);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        viewTypeForEditor(match.documentType.editor),
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
    vscode.commands.registerCommand("visualbridge.createGraphDocument", () => createDocumentForModule("visualbridge.graph")),
    vscode.commands.registerCommand("visualbridge.createEntityDocument", () => createDocumentForModule("visualbridge.entity")),
    vscode.commands.registerCommand("visualbridge.createStructuredDocument", () => createDocumentForModule("visualbridge.structured")),
    vscode.commands.registerCommand("visualbridge.createTableDocument", () => createDocumentForModule("visualbridge.table")),
    vscode.commands.registerCommand("visualbridge.createDocument", async () => {
      // 候选 Document Type 只保留模块已加载的 editor。
      await createDocument(projects, lifecycle, { isEditorAvailable });
    }),
    vscode.commands.registerCommand("visualbridge.safeDeleteElement", async (request?: LifecycleElementDeleteRequest) => {
      if (request === undefined) {
        void vscode.window.showWarningMessage("Safe Delete Element requires a structured element target from a VisualBridge editor.");
        return;
      }
      try {
        return await safeDeleteElement(request, true);
      } catch (errorValue) {
        if (errorValue instanceof WorkspaceLifecycleError && errorValue.code === "lifecycle.workspaceDirty") {
          // 弹窗必须 fire-and-forget：该命令运行在编辑器的串行消息队列里，
          // await 用户点击会阻塞队列，导致面板 ready 握手永远排不上队（表格一直"正在加载"）。
          void vscode.window.showWarningMessage(errorValue.message, "管理未保存的文档").then((choice) => {
            if (choice !== undefined) {
              void vscode.commands.executeCommand("visualbridge.manageUnsavedDocuments");
            }
          });
          return undefined;
        }
        void vscode.window.showWarningMessage(errorValue instanceof Error ? errorValue.message : String(errorValue));
        return undefined;
      }
    }),
    vscode.commands.registerCommand("visualbridge.manageUnsavedDocuments", () => (
      // 报错弹窗的入口：聚焦常驻的"未保存的文档"树视图。
      vscode.commands.executeCommand("visualbridge.unsavedDocuments.focus")
    )),
    vscode.commands.registerCommand("visualbridge.unsavedDocuments.refresh", () => (
      unsavedDocumentsTree.refresh()
    )),
    vscode.commands.registerCommand("visualbridge.unsavedDocuments.saveAll", async () => {
      const saved = await saveAllUnsavedDocuments(projects, tableEditorProvider);
      unsavedDocumentsTree.refresh();
      void vscode.window.showInformationMessage(`已保存 ${saved} 个文档。`);
    }),
    vscode.commands.registerCommand("visualbridge.unsavedDocuments.discardAll", async () => {
      const choice = await vscode.window.showWarningMessage(
        "确定放弃所有未保存的 VisualBridge 文档改动？",
        { modal: true },
        "放弃改动",
      );
      if (choice === undefined) {
        return;
      }
      const reverted = await discardAllUnsavedDocuments(projects, tableEditorProvider);
      unsavedDocumentsTree.refresh();
      void vscode.window.showInformationMessage(`已放弃 ${reverted} 个文档的改动。`);
    }),
    vscode.commands.registerCommand(REVEAL_REFERENCE_COMMAND, async (location) => {
      if (isTableReferenceLocation(location)) {
        // Table 模块未加载时只打开只读 Shell，不执行表格领域代码。
        const tableProject = projects.projects.find(
          (candidate) => candidate.definition.projectId === location.projectId,
        );
        if (tableProject === undefined) throw new Error(`VisualBridge Project '${location.projectId}' is not open.`);
        await modules.ensureProject(tableProject);
        const tableEditor = tableProject.definition.documentTypes
          .find((documentType) => documentType.id === location.documentTypeId)?.editor;
        if (tableEditor === undefined || modules.editorAvailability(tableProject, tableEditor).kind !== "available") {
          const shellUri = vscode.Uri.joinPath(tableProject.rootUri, ...location.path.split("/"));
          // 表格一律走 TableEditorGate：模块不可用时它渲染只读 Shell（二进制 XLSX 也适用）。
          await vscode.commands.executeCommand("vscode.openWith", shellUri, TABLE_EDITOR_VIEW_TYPE);
          return;
        }
        await tableEditorProvider.revealReference(location);
        return;
      }
      if (!isReferenceLocation(location)) {
        throw new Error("Invalid VisualBridge reference location.");
      }
      if (isGraphElementReferenceLocation(location) || isEntityComponentReferenceLocation(location)) {
        await editorProvider.revealElementReference(location);
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
        viewTypeForEditor(match.documentType.editor),
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
    tableEditorGate,
    vscode.window.registerCustomEditorProvider(TABLE_EDITOR_VIEW_TYPE, tableEditorGate, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  // projects.initialize 已在注册块之前完成（见上）；documents 索引在注册后初始化。
  await documents.initialize();
  await catalogBrowser.refresh();

  // 模块状态变化（装载/失败/授权变化）必须主动重建索引与只读回退，而不是等下一次编辑（P1）。
  context.subscriptions.push(
    modules.onDidChange(() => {
      editorProvider.refreshModuleAvailability();
      tableEditorGate.refreshModuleAvailability();
      projectSettingsEditor.notifyModulesChanged();
      void documents.refresh().catch((errorValue: unknown) => {
        output.appendLine(`[modules] Document Index refresh failed after a module state change: ${String(errorValue)}`);
      });
      void catalogBrowser.refresh();
    }),
  );

  // "未保存的文档"树视图的自动刷新：文本编辑、保存/打开/关闭、项目变化与 Table 编辑器状态。
  let unsavedRefreshTimer: NodeJS.Timeout | undefined;
  const scheduleUnsavedRefresh = (): void => {
    if (unsavedRefreshTimer !== undefined) {
      clearTimeout(unsavedRefreshTimer);
    }
    unsavedRefreshTimer = setTimeout(() => {
      unsavedRefreshTimer = undefined;
      unsavedDocumentsTree.refresh();
    }, 400);
  };
  context.subscriptions.push(
    unsavedDocumentsView,
    projects.onDidChange(scheduleUnsavedRefresh),
    tableEditorProvider.onDidChangeDocuments(scheduleUnsavedRefresh),
    vscode.workspace.onDidChangeTextDocument(scheduleUnsavedRefresh),
    vscode.workspace.onDidSaveTextDocument(scheduleUnsavedRefresh),
    vscode.workspace.onDidOpenTextDocument(scheduleUnsavedRefresh),
    vscode.workspace.onDidCloseTextDocument(scheduleUnsavedRefresh),
  );
  unsavedDocumentsTree.refresh();

  // 跨腿录制宿主（E9）：两条腿（Editor 桥 / Runtime 桥）共用同一个录制状态机，
  // 保证"Runtime 腿的帧也能录进 .vbdrec"，而不是只在 Editor 腿留一条录制旁路。
  const debugRecordingHost = new DebugRecordingHost({ log: (message) => output.appendLine(message) });
  const bridgeServer = new EditorBridgeServer(projects, documents, output, { recordingHost: debugRecordingHost });
  context.subscriptions.push(bridgeServer);
  try {
    await bridgeServer.start();
  } catch (errorValue) {
    output.appendLine(`[bridge] Editor Bridge server failed to start: ${String(errorValue)}`);
  }

  // Runtime 腿的调试接线（E9）：ch1 帧接进与 Editor 腿**同一个**实例表与录制宿主；
  // 查询归属由 F6 的 `resolveDebugQueryClient` 按实例解析（两条腿各一条连接，不按腿分支）。
  const runtimeBridge = new RuntimeBridgeService((message) => output.appendLine(`[runtime] ${message}`), {
    debug: {
      manager: bridgeServer.debug,
      resolveContracts: (contractHash) => bridgeServer.contractSnapshots.snapshotForHash(contractHash),
      recording: debugRecordingHost,
    },
  });
  context.subscriptions.push(
    { dispose: () => runtimeBridge.disconnect() },
    bridgeServer.registerDebugQuerySource(() => runtimeBridge.debugQueryConnections),
  );

  /**
   * 面板 Runtime 腿的生产连接触发（E10）。**只复用上面那一个 `runtimeBridge` 实例**：
   * 多一个服务实例就是多一条会抢 Unity 侧 ch1 的连接。
   *
   * DAP 与面板的并发处置（写在这里，避免后来者再发明第二套生命周期）：
   * - DAP attach 仍由 `RuntimeDebugAdapter` 调 `service.connect(...)`（并持租约）；面板是观察者、不取租约。
   *   两者共用同一实例，所以 DAP attach 只是把连接换到它选的实例，面板随后继续从**同一个** manager 收帧。
   * - DAP 断开时会 `service.disconnect()`，面板随之显示"未连接"（不静默换成别的实例）；
   *   面板"重试连接"或重开面板即重新 ensure。
   * - 面板关闭**不断开**：面板关闭保留模型与已缓存记录（F3 既有语义），而断开会让 Unity 侧
   *   `ResetSessionLocked` 清空实例/槽位；连接由扩展停用或 DAP 负责收尾。
   */
  const runtimePanelDiscovery = process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
  // 宿主机隔离探针地址（只在非 Production 读）：宿主测试把它指向 TEST-NET-1，
  // 这样「没有 Runtime 端点」这条失败路径既不会连到开发者本机真实 Play 会话，也不会被占用的端口干扰。
  const runtimePanelProbeHost = context.extensionMode === vscode.ExtensionMode.Production
    ? undefined
    : process.env.VISUALBRIDGE_TEST_RUNTIME_PROBE_HOST;
  const runtimePanelConnection = new RuntimePanelConnection({
    service: () => runtimeBridge,
    log: (message) => output.appendLine(`[runtime] panel: ${message}`),
    // 与 DAP 工厂一致：宿主测试用这个环境变量指向隔离的发现记录目录。
    ...(runtimePanelDiscovery === undefined ? {} : { discoveryDirectory: runtimePanelDiscovery }),
    ...(runtimePanelProbeHost === undefined ? {} : { probe: { host: runtimePanelProbeHost } }),
  });
  context.subscriptions.push({ dispose: () => runtimePanelConnection.dispose() });

  // 独立 Debug 面板（F3）：数据只来自 `bridgeServer.debug`，开关状态只来自 welcome 与广播。
  // 模块 debug facet（F4）：宿主把分类路由到已装载模块，通用视图始终是观察者（C.5）。
  const debugFacetHost = new DebugFacetHost({
    router: bridgeServer.debug.router,
    replay: (category) => bridgeServer.debug.replay(category),
    knownCategories: () => [...new Set(bridgeServer.debug.instances.map((instance) => instance.category))],
    isCategoryStale: (category) => bridgeServer.debug.isCategoryStale(category),
    hasReplayableRecords: (category) => bridgeServer.debug.hasReplayableCategoryRecords(category),
    sessionId: () => bridgeServer.state?.sessionId ?? "",
    log: (message) => output.appendLine(message),
  });
  context.subscriptions.push(debugFacetHost);
  // 录制（F5）：真正的写盘在 bridge 层；这里只负责路径选择与 UI 反馈。
  const debugRecording = new DebugRecordingService({
    storageUri: context.globalStorageUri,
    bridge: () => bridgeServer,
    log: (message) => output.appendLine(message),
    onStopped: (filePath, footer) => {
      const summary = footer === undefined
        ? ""
        : `（${footer.records} 帧${footer.endedReason === "sizeLimit" ? "，达到文件上限" : ""}${footer.droppedRecords > 0 ? `，丢弃 ${footer.droppedRecords} 帧` : ""}）`;
      void vscode.window.showInformationMessage(
        `调试录制已保存${summary}：${path.basename(filePath)}`,
        "打开回看",
      ).then((choice) => {
        if (choice === "打开回看") {
          void openRecordingWithProgress(filePath);
        }
      });
    },
  });
  context.subscriptions.push(debugRecording);
  const pickDebugRecordingFile = async (storageUri: vscode.Uri): Promise<string | undefined> => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: vscode.Uri.joinPath(storageUri, "recordings"),
      openLabel: "回看",
      filters: { "VisualBridge Debug Recording": ["vbdrec"] },
    });
    return picked?.[0]?.fsPath;
  };
  const debugPanel = new DebugPanelController({
    storageUri: context.globalStorageUri,
    bridge: () => bridgeServer,
    facets: debugFacetHost,
    recording: {
      get: () => debugRecording.state,
      toggle: () => {
        void debugRecording.toggle();
      },
    },
    // 回看的模块 facet 按回看 manager 新建，退出回看时由控制器释放（F4 的在线 host 不动）。
    replayFacets: (session) => {
      const host = new DebugFacetHost({
        router: session.manager.router,
        replay: (category) => session.manager.replay(category),
        knownCategories: () => [...new Set(session.manager.instances.map((instance) => instance.category))],
        isCategoryStale: () => false,
        hasReplayableRecords: (category) => session.manager.hasReplayableCategoryRecords(category),
        sessionId: () => session.header.sessionId,
        log: (message) => output.appendLine(message),
      });
      host.rebuild(collectDebugFacetSources(
        projects.projects,
        (project) => modules.modulesFor(project),
        (moduleId, message) => output.appendLine(`[module:${moduleId}] ${message}`),
      ));
      return host;
    },
    log: (message) => output.appendLine(message),
    // E10：面板打开时按需建立 Runtime 腿连接（复用上面那一个 `runtimeBridge`），
    // 并让状态栏读两条腿的真实状态（不再只读 Editor 腿）。
    ensureRuntimeConnection: (reason) => {
      void runtimePanelConnection.ensureConnected(reason);
    },
    runtimeConnection: () => runtimePanelConnection.status,
  });
  context.subscriptions.push(debugPanel);

  // E10：打开图页面也按需连接（G1a 之后图调试数据只从 Runtime 腿来）。只对 graph 编辑器触发，
  // 其余文档类型打开时不去探测端口，避免每次开文档都白跑一轮 2 s 的端口段探测。
  // 尽力而为：`resolveCustomTextEditor` 的 catch 会 dispose 并 rethrow，监听器同步抛出会让图页面打不开，
  // 所以这里必须自己吞掉（与 debugPanelController 的 requestRuntimeConnection 同一套处置）。
  context.subscriptions.push(editorProvider.onDidOpenDocument((match) => {
    if (match.documentType.editor !== "graph") {
      return;
    }

    try {
      void runtimePanelConnection.ensureConnected("graph.editor.open");
    } catch (errorValue) {
      output.appendLine(`[runtime] graph page runtime connection trigger failed: ${String(errorValue)}`);
    }
  }));
  /**
   * 回看入口：大文件重放要占住宿主线程，给一个可见的进度提示（不可取消：解析没有中断点）。
   *
   * 先做**不解码的预检**（P1-A）：超大文件在这里快速失败，不进入 `withProgress`、不把面板切到
   * 回看态；只有通过预检才用"正在解码 N 条…"的进度提示真正重放（P2-11）。
   */
  const openRecordingWithProgress = async (filePath: string): Promise<void> => {
    try {
      const preflight = await DebugReplaySession.preflight(filePath);
      const decoded = preflight.records === undefined
        ? "正在解码录制内容…"
        : `正在解码 ${preflight.records} 帧（约 ${(preflight.estimatedDecodedBytes / (1024 * 1024)).toFixed(1)} MB）…`;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在回看 ${path.basename(filePath)}…`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: decoded });
          await debugPanel.openRecording(filePath);
        },
      );
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      output.appendLine(`[debug] failed to open recording '${filePath}': ${message}`);
      void vscode.window.showErrorMessage(`无法打开调试录制：${message}`);
    }
  };
  /** 模块装载/授权/Project 变化后重建分类路由；旧 facet 先注销，之后不会再收到记录（验收 A）。 */
  const rebuildDebugFacets = (): void => {
    debugFacetHost.rebuild(collectDebugFacetSources(
      projects.projects,
      (project) => modules.modulesFor(project),
      (moduleId, message) => output.appendLine(`[module:${moduleId}] ${message}`),
    ));
    debugPanel.refreshNow();
  };
  context.subscriptions.push(modules.onDidChange(rebuildDebugFacets), projects.onDidChange(rebuildDebugFacets));
  rebuildDebugFacets();
  context.subscriptions.push(
    bridgeServer.onDidChangeDebugReporting((reason) => debugPanel.applyBridgeChange(reason, bridgeServer.debugReporting.enabled)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("visualbridge.openDebugPanel", () => debugPanel.open()),
    // 回看（F5）：可带文件路径（宿主/测试），否则弹文件选择框；默认目录是录制目录。
    vscode.commands.registerCommand("visualbridge.openDebugRecording", async (argument?: unknown) => {
      const direct = argument instanceof vscode.Uri
        ? argument.fsPath
        : typeof argument === "string" && argument.length > 0
          ? argument
          : undefined;
      const filePath = direct ?? await pickDebugRecordingFile(context.globalStorageUri);
      if (filePath === undefined) {
        return;
      }

      await openRecordingWithProgress(filePath);
    }),
  );

  // Runtime 只检查 DAP 会话（VB-UX-11）：inline 适配器，一切状态经 Runtime Bridge 协议获取。
  let runtimeDebugAdapter: RuntimeDebugAdapter | undefined;
  const runtimeDebugFactory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor: async (session: vscode.DebugSession) => {
      const instanceId = session.configuration.instanceId;
      if (typeof instanceId !== "string" || instanceId.length === 0) {
        throw new Error("VisualBridge runtime attach requires an instanceId.");
      }

      // 连接时再次枚举校验实例仍存在且非陈旧，避免绑定到过期发现记录。
      const instances = await runtimeBridge.enumerateInstances(process.env.VISUALBRIDGE_TEST_RUNTIME_DIR);
      const match = instances.find((entry) => entry.instanceId === instanceId);
      if (match === undefined) {
        throw new Error(`Runtime instance '${instanceId}' was not discovered.`);
      }

      if (match.staleReason !== undefined) {
        throw new Error(`Runtime instance '${instanceId}' is stale (${match.staleReason}).`);
      }

      const adapter = new RuntimeDebugAdapter(runtimeBridge, match);
      adapter.onDidDispose(() => {
        if (runtimeDebugAdapter === adapter) runtimeDebugAdapter = undefined;
      });
      runtimeDebugAdapter = adapter;
      return new vscode.DebugAdapterInlineImplementation(adapter);
    },
  };
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(RUNTIME_DEBUG_TYPE, new RuntimeDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory(RUNTIME_DEBUG_TYPE, runtimeDebugFactory),
  );

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    /** 宿主测试的注入点：直接走 F2 的 `ingest`（面板只读 manager，不另建数据源）。 */
    const ingestDebugForTest = (envelopes: unknown): number => {
      if (!Array.isArray(envelopes)) return 0;
      let records = 0;
      for (const envelope of envelopes) {
        records += bridgeServer.debug.ingest(envelope as DebugEnvelope).length;
      }

      // 只灌数据，不碰开关状态（面板自己按刷新周期重绘）。
      return records;
    };
    context.subscriptions.push(
      vscode.commands.registerCommand("visualbridge.test.getBridgeServerState", () => bridgeServer.state ?? null),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.open", async () => {
        await debugPanel.open();
        return { openCount: debugPanel.openCountForTest, ready: debugPanel.isReady };
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.close", () => {
        debugPanel.close();
        return { openCount: debugPanel.openCountForTest };
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.state", () => debugPanel.getStateForTest()),
      // E9 的 E2E 驱动：一次真实查询往返（两条腿按实例归属路由；`methodId` 用于没有契约的样例工程）。
      vscode.commands.registerCommand("visualbridge.test.debugPanel.queryDebug", async (payload: {
        readonly key?: unknown;
        readonly interfaceId?: unknown;
        readonly method?: unknown;
        readonly methodId?: unknown;
      } = {}) => {
        if (typeof payload.key !== "string" || typeof payload.interfaceId !== "string" || typeof payload.method !== "string") {
          return { ok: false, error: "query debug requires key, interfaceId and method" };
        }

        try {
          const result = await bridgeServer.queryDebug(
            payload.key,
            payload.interfaceId,
            payload.method,
            [],
            typeof payload.methodId === "number" ? { methodId: payload.methodId } : {},
          );
          return {
            ok: true,
            kind: result.record?.kind,
            frame: result.target.frame,
            value: result.record?.args.get(1)?.value,
          };
        } catch (errorValue) {
          return {
            ok: false,
            error: errorValue instanceof Error ? errorValue.message : String(errorValue),
            code: (errorValue as { readonly code?: string }).code,
          };
        }
      }),
      // F5 宿主测试注入点：直接走控制器的回看入口（错误信息就是 `showErrorMessage` 会显示的那条），
      // 以及 bridge 层的录制启停/状态（不经过保存对话框）。
      vscode.commands.registerCommand("visualbridge.test.debugPanel.openRecording", async (filePath: unknown) => {
        if (typeof filePath !== "string") {
          return { ok: false, error: "missing file path" };
        }

        try {
          const snapshot = await debugPanel.openRecording(filePath);
          return { ok: true, replay: snapshot.replay };
        } catch (errorValue) {
          return { ok: false, error: errorValue instanceof Error ? errorValue.message : String(errorValue) };
        }
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.recordingStart", async (filePath: unknown) => {
        if (typeof filePath !== "string") {
          throw new Error("missing file path");
        }

        await bridgeServer.startRecording({ filePath });
        return bridgeServer.recordingState;
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.recordingStop", async () => {
        const footer = await bridgeServer.stopRecording();
        return { footer, state: bridgeServer.recordingState };
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.recordingState", () => bridgeServer.recordingState),
      // P2-3 的红/绿判据：面板关闭后线上 store 不能再停在暂停态（否则 pendingAppended 无界增长）。
      vscode.commands.registerCommand("visualbridge.test.debugPanel.liveStorePaused", (key: unknown) => {
        const store = typeof key === "string" ? bridgeServer.debug.storeFor(key) : undefined;
        return store?.paused;
      }),
      vscode.commands.registerCommand(
        "visualbridge.test.debugPanel.command",
        (command: unknown, payload: unknown) => debugPanel.handleCommand(
          typeof command === "string" ? command : "",
          (typeof payload === "object" && payload !== null ? payload : {}) as {
            readonly value?: unknown;
            readonly direction?: unknown;
            readonly key?: unknown;
            readonly interfaceId?: unknown;
            readonly method?: unknown;
            readonly methodId?: unknown;
          },
        ),
      ),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.setMode", (mode: unknown) => {
        debugPanel.setModeOverrideForTest(mode === "player" || mode === "editor" ? mode : undefined);
        return debugPanel.getStateForTest();
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.setEnableTimeout", (timeoutMs: unknown) => {
        debugPanel.setEnableTimeoutForTest(typeof timeoutMs === "number" ? timeoutMs : 0);
        return debugPanel.getStateForTest();
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.ingest", (envelopes: unknown) => ({
        records: ingestDebugForTest(envelopes),
        state: debugPanel.getStateForTest(),
      })),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.debugReporting", () => bridgeServer.debugReporting),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.facets", () => debugFacetHost.snapshot()),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.facetRoutes", () => debugFacetHost.routeSummaryForTest()),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.flushFacets", () => {
        debugFacetHost.flushForTest();
        return debugFacetHost.snapshot();
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.faultFacet", (category: unknown) => {
        debugFacetHost.setFaultInjectionForTest(typeof category === "string" ? category : undefined);
        debugFacetHost.flushForTest();
        return debugFacetHost.snapshot();
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.resetFacets", () => {
        debugFacetHost.setFaultInjectionForTest(undefined);
        debugFacetHost.reloadForTest();
        debugFacetHost.flushForTest();
        return debugFacetHost.snapshot();
      }),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.replayCategory", (category: unknown) =>
        (typeof category === "string" ? debugFacetHost.replayCategory(category) : undefined)),
      vscode.commands.registerCommand("visualbridge.test.debugPanel.noteWebviewFailure", (count: unknown) =>
        debugPanel.noteWebviewFailureForTest(
          "injected for test",
          typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 1,
        )),
      vscode.commands.registerCommand("visualbridge.test.parseBridgeMessage", (value: unknown) => {
        try {
          return { ok: true, message: parseBridgeMessage(value) };
        } catch (errorValue) {
          if (errorValue instanceof BridgeProtocolError) {
            return { ok: false, code: errorValue.code, jsonPath: errorValue.jsonPath };
          }

          return { ok: false, code: "bridge.internalError", jsonPath: "$" };
        }
      }),
      vscode.commands.registerCommand("visualbridge.test.parseBridgeDiscoveryRecord", (value: unknown) => {
        try {
          return { ok: true, record: parseDiscoveryRecord(value) };
        } catch (errorValue) {
          if (errorValue instanceof BridgeProtocolError) {
            return { ok: false, code: errorValue.code, jsonPath: errorValue.jsonPath };
          }

          return { ok: false, code: "bridge.internalError", jsonPath: "$" };
        }
      }),
      vscode.commands.registerCommand("visualbridge.test.parseCatalog", (editor: unknown, value: unknown) => {
        if (typeof editor !== "string") return { ok: false, code: "catalog.editorMissing" };
        const facet = catalogFacetFor(editor);
        if (facet === undefined) return { ok: false, code: "catalog.facetMissing" };
        const result = facet.parse(JSON.stringify(value), "test.catalog.json");
        return { ok: result.success === true };
      }),
      vscode.commands.registerCommand("visualbridge.test.getRuntimeBridgeState", () => runtimeBridge.state),
      vscode.commands.registerCommand("visualbridge.test.enumerateRuntimeInstances", async () => {
        const directory = process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
        const instances = await runtimeBridge.enumerateInstances(directory);
        return instances.map((instance) => ({
          instanceId: instance.instanceId,
          kind: instance.kind,
          tcpPort: instance.tcpPort,
          token: instance.token,
          pid: instance.pid,
          generation: instance.generation,
          startedAt: instance.startedAt,
          ...(instance.staleReason === undefined ? {} : { staleReason: instance.staleReason }),
        }));
      }),
      vscode.commands.registerCommand("visualbridge.test.connectRuntimeInstance", async (instance: {
        readonly instanceId: string;
        readonly kind: string;
        readonly tcpPort: number;
        readonly token: string;
        readonly pid: number;
        readonly generation: number;
        readonly startedAt: string;
      }) => {
        const welcome = await runtimeBridge.connect({
          recordPath: "",
          instanceId: instance.instanceId,
          kind: instance.kind as "editor-play" | "player",
          tcpPort: instance.tcpPort,
          token: instance.token,
          pid: instance.pid,
          generation: instance.generation,
          startedAt: instance.startedAt,
        });
        return {
          instanceId: welcome.endpointId,
          kind: welcome.connectType,
          generation: welcome.generation,
          sessionId: welcome.sessionId,
          resumed: welcome.resumed,
          payloads: [...welcome.payloads],
        };
      }),
      vscode.commands.registerCommand("visualbridge.test.probeRuntimePorts", async (options: {
        readonly host?: string;
        readonly port?: number;
        readonly portRangeStart?: number;
        readonly portRangeEnd?: number;
        readonly timeoutMs?: number;
        readonly concurrency?: number;
        readonly token: string;
        readonly contractHash?: string;
      }) => {
        // 端口段探测（附录 A.8）：并发 8、单口 300 ms，第一个握手成功者胜出。
        const welcome = await runtimeBridge.probeAndConnect(options);
        return {
          instanceId: welcome.endpointId,
          kind: welcome.connectType,
          generation: welcome.generation,
          sessionId: welcome.sessionId,
          resumed: welcome.resumed,
          port: runtimeBridge.state.tcpPort,
        };
      }),
      vscode.commands.registerCommand("visualbridge.test.getRuntimeSnapshot", async (documentTypeIds?: readonly string[]) =>
        runtimeBridge.getSnapshot(documentTypeIds)),
      vscode.commands.registerCommand("visualbridge.test.acquireRuntimeLease", async () => {
        await runtimeBridge.acquireLease();
        return true;
      }),
      vscode.commands.registerCommand("visualbridge.test.releaseRuntimeLease", async () => {
        await runtimeBridge.releaseLease();
        return true;
      }),
      vscode.commands.registerCommand("visualbridge.test.getRuntimeDocumentSources", async () =>
        runtimeBridge.getDocumentSources()),
      vscode.commands.registerCommand("visualbridge.test.disconnectRuntimeInstance", async () => {
        runtimeBridge.disconnect();
        return true;
      }),
      vscode.commands.registerCommand("visualbridge.test.getGraphExecutionInstances", async (documentId?: string) =>
        runtimeBridge.getGraphExecutionInstances(documentId)),
      vscode.commands.registerCommand("visualbridge.test.getGraphExecutionSnapshot", async (executionId: string) =>
        runtimeBridge.getGraphExecutionSnapshot(executionId)),
      vscode.commands.registerCommand("visualbridge.test.subscribeGraphExecution", async (executionId: string) => {
        const recording = await runtimeBridge.subscribeGraphExecution(executionId);
        return {
          executionId: recording.executionId,
          graphName: recording.execution.graphName,
          debugKey: recording.execution.debugKey,
          state: recording.execution.state,
        };
      }),
      vscode.commands.registerCommand("visualbridge.test.unsubscribeGraphExecution", async () => {
        await runtimeBridge.unsubscribeGraphExecution();
        return true;
      }),
      vscode.commands.registerCommand("visualbridge.test.getGraphExecutionRecording", () => {
        const recording = runtimeBridge.activeRecording;
        if (recording === undefined) {
          return null;
        }

        return {
          executionId: recording.executionId,
          stopped: recording.isStopped,
          eventCount: recording.recordedEvents.length,
          frameCount: recording.frameSlices().length,
          events: recording.recordedEvents.map((event) => ({
            index: event.index,
            frameIndex: event.frameIndex,
            kind: event.kind,
            ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
            ...(event.outputIndex === undefined ? {} : { outputIndex: event.outputIndex }),
            ...(event.value === undefined ? {} : { value: event.value }),
          })),
        };
      }),
      vscode.commands.registerCommand("visualbridge.test.parseRuntimeBridgeMessage", (value: unknown) => {
        try {
          return { ok: true, message: parseRuntimeBridgeMessage(value) };
        } catch (errorValue) {
          if (errorValue instanceof RuntimeBridgeProtocolError) {
            return { ok: false, code: errorValue.code, jsonPath: errorValue.jsonPath };
          }

          return { ok: false, code: "runtime.internalError", jsonPath: "$" };
        }
      }),
      vscode.commands.registerCommand("visualbridge.test.parseRuntimeBridgeDiscoveryRecord", (value: unknown) => {
        try {
          return { ok: true, record: parseRuntimeBridgeDiscoveryRecord(value) };
        } catch (errorValue) {
          if (errorValue instanceof RuntimeBridgeProtocolError) {
            return { ok: false, code: errorValue.code, jsonPath: errorValue.jsonPath };
          }

          return { ok: false, code: "runtime.internalError", jsonPath: "$" };
        }
      }),
      vscode.commands.registerCommand(
        "visualbridge.test.attachRuntimeInstance",
        async (instance: { readonly instanceId: string }) => {
          const instanceId = typeof instance?.instanceId === "string" ? instance.instanceId : "";
          if (instanceId.length === 0) {
            throw new Error("attachRuntimeInstance requires a runtime instanceId.");
          }

          // 无头 attach：显式 instanceId 启动 DAP 会话并等待其出现，供 E2E 驱动。
          let settleSession: (session: vscode.DebugSession) => void = () => undefined;
          let rejectSession: (error: Error) => void = () => undefined;
          const sessionPromise = new Promise<vscode.DebugSession>((resolve, reject) => {
            settleSession = resolve;
            rejectSession = reject;
          });
          const subscription = vscode.debug.onDidStartDebugSession((started) => {
            if (started.type === RUNTIME_DEBUG_TYPE && started.configuration?.instanceId === instanceId) {
              settleSession(started);
            }
          });
          const timer = setTimeout(
            () => rejectSession(new Error("The VisualBridge runtime debug session did not start.")),
            30_000,
          );
          try {
            const accepted = await vscode.debug.startDebugging(undefined, {
              name: "VisualBridge Runtime Inspection",
              type: RUNTIME_DEBUG_TYPE,
              request: "attach",
              instanceId,
              __internal: true,
            });
            if (accepted !== true) {
              throw new Error("vscode.debug.startDebugging did not accept the VisualBridge runtime attach.");
            }

            return await sessionPromise;
          } finally {
            clearTimeout(timer);
            subscription.dispose();
          }
        },
      ),
      vscode.commands.registerCommand("visualbridge.test.getRuntimeDebugSessionState", () => (
        runtimeDebugAdapter?.getInspectionState() ?? {
          connected: false,
          leaseHeld: false,
          instanceId: "",
          documents: 0,
          topLevelVariables: 0,
          driftedDocuments: 0,
          driftedDocumentIds: [],
          unknownSourceDocuments: 0,
        }
      )),
    );
  }

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

/** 多源（`storage: "sources"`）文档一律走 TableEditorGate，其余走通用编辑器。 */
function viewTypeForEditor(editor: string): string {
  return documentFacetFor(editor)?.facet.storage === "sources"
    ? TABLE_EDITOR_VIEW_TYPE
    : OPTIONAL_EDITOR_VIEW_TYPE;
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
