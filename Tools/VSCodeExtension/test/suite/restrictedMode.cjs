const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "kyl.visualbridge";

exports.run = async function run() {
  const workspacePath = requiredAbsolutePath("VISUALBRIDGE_TEST_WORKSPACE");
  const providerStatePath = requiredAbsolutePath("VISUALBRIDGE_PROVIDER_TEST_STATE_DIR");
  const expectedExtensionVersion = requiredValue("VISUALBRIDGE_TEST_EXTENSION_VERSION");

  await test("opens a real Restricted Mode workspace", async () => {
    assert.equal(vscode.workspace.isTrusted, false);
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.equal(folders.length, 1);
    assert.equal(normalizePath(folders[0].uri.fsPath), normalizePath(workspacePath));
  });

  await test("activates VisualBridge with safe untrusted-workspace support", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension '${EXTENSION_ID}' was not discovered.`);
    await waitFor(() => extension.isActive, 20_000, `Extension '${EXTENSION_ID}' was not activated.`);
    assert.equal(extension.packageJSON.version, expectedExtensionVersion);
    assert.equal(extension.packageJSON.capabilities.untrustedWorkspaces.supported, true);
  });

  await test("does not start a declared Project Provider while untrusted", async () => {
    await vscode.commands.executeCommand("visualbridge.refreshProjects");
    const diagnostics = await vscode.commands.executeCommand(
      "visualbridge.test.validateProviderDocument",
      vscode.Uri.file(path.join(workspacePath, "VisualBridge.project.vbjson")),
      {
        documentTypeId: "sample.provider.settings",
        path: "Config/ProviderSettings.providerconfig",
        sourceHash: "0".repeat(64),
        content: { formatVersion: 1, properties: {} },
      },
      "restricted-provider-cache",
    );
    assert.deepEqual(diagnostics, []);
    await new Promise((resolve) => setTimeout(resolve, 750));
    await assert.rejects(
      readFile(path.join(providerStatePath, "events.ndjson"), "utf8"),
      (error) => error?.code === "ENOENT",
      "Project Provider wrote a startup event in Restricted Mode.",
    );
  });
  await test("keeps every declared module untrusted and never activates a module through the registry", async () => {
    const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
    assert.equal(state.trusted, false);
    assert.equal(state.activationCount, 0, "Restricted Mode activated a module through the registry.");
    // 观测口径：注册源没有 activate 任何模块、也没有走模块驱动路径。
    // 注意这不观测 bundle 加载时由其它静态 import 触发的领域包初始化（B1 登记缺口，归 C1/C2）。
    assert.deepEqual(state.evaluatedModuleIds, [], "Restricted Mode activated a module through the registry.");
    const project = state.projects.find((entry) => entry.projectId === "visualbridge.provider-semantics");
    assert.ok(project, "The Restricted Mode project is missing from the module registry snapshot.");
    assert.deepEqual(project.modules.map((module) => [module.id, module.status]), [
      ["visualbridge.structured", "untrusted"],
    ]);
    // C2：manifest 只存在于 bundle 内部，未信任时宿主不得求值 bundle，因此这里拿不到声明的
    // editor 列表（B1 的 in-process 静态 import 才能读到 manifest）。editor 可用性由
    // editorAvailability 直接返回"需要信任工作区"的说明，不依赖 manifest。
    assert.deepEqual(project.modules[0].editors, []);
    assert.equal(project.modules[0].diagnostics[0].code, "module.untrusted");
    assert.equal(project.modules[0].diagnostics[0].path, "modules[0]");

    const markerUri = vscode.Uri.file(path.join(workspacePath, "VisualBridge.project.vbjson"));
    const untrusted = vscode.languages
      .getDiagnostics(markerUri)
      .find((entry) => entry.code === "module.untrusted");
    assert.ok(untrusted, "No module.untrusted diagnostic was published in Restricted Mode.");
    assert.match(untrusted.message, /^modules\[0\]: /u);

    // 语义索引与 Catalog 也不得解析领域文档（没有模块就没有语义能力）。
    const index = await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot");
    assert.equal(index.documents.length, 0, "Restricted Mode parsed domain documents.");
    assert.equal(index.stats.planned, 0, "Restricted Mode planned semantic document loads.");
    const catalogs = await vscode.commands.executeCommand("visualbridge.test.getCatalogBrowserSnapshot");
    assert.deepEqual(catalogs, [], "Restricted Mode parsed domain Catalogs.");
  });

  await test("renders an untrusted module document as a read-only shell with the trust hint", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "Config", "ProviderSettings.providerconfig"));
    const markerUri = vscode.Uri.file(path.join(workspacePath, "VisualBridge.project.vbjson"));
    try {
      await vscode.commands.executeCommand("visualbridge.openDocument", uri);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "The read-only shell did not become ready in Restricted Mode.",
      );
      const shell = await vscode.commands.executeCommand("visualbridge.test.getReadonlyShellState", uri);
      assert.equal(shell.active, true);
      assert.equal(shell.reason, "untrusted");
      assert.match(shell.message, /需要信任工作区才能加载模块/u);

      // 只读证据：没有领域会话，结构化操作被拒绝。
      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.applyDocumentOperations", uri, "structured", []),
        /No active structured editor session/u,
      );
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

      // 工程设置"模块"区同样显示未授权状态。
      await vscode.commands.executeCommand("vscode.openWith", markerUri, "visualbridge.projectSettingsEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", markerUri),
        (ready) => ready === true,
        20_000,
        "Project Settings did not become ready in Restricted Mode.",
      );
      const settings = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getProjectSettingsState", markerUri),
        (state) => state?.modules?.length === 1,
        20_000,
        "Project Settings did not expose the untrusted module state.",
      );
      assert.equal(settings.modules[0].status, "untrusted");
      assert.equal(settings.modules[0].hashShort, "");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors").catch(() => undefined);
    }
  });

  await test("auto-loads modules after Workspace Trust is granted without reloading the window", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "Config", "ProviderSettings.providerconfig"));
    const markerUri = vscode.Uri.file(path.join(workspacePath, "VisualBridge.project.vbjson"));
    try {
      await vscode.commands.executeCommand("visualbridge.openDocument", uri);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getReadonlyShellState", uri),
        (shell) => shell?.active === true && shell.reason === "untrusted",
        20_000,
        "The document did not start as an untrusted read-only shell.",
      );

      // 走与 onDidGrantWorkspaceTrust 相同的事件处理器；不重载窗口。
      await vscode.commands.executeCommand("visualbridge.test.simulateWorkspaceTrustGranted");
      const state = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.trusted === true
          && value.activationCount > 0
          && value.projects
            .find((entry) => entry.projectId === "visualbridge.provider-semantics")
            ?.modules[0]?.status === "loaded",
        20_000,
        "Modules were not loaded after the trust grant.",
      );
      assert.ok(state.activationCount > 0);
      // 授予信任后领域包才被求值。
      assert.ok(
        state.evaluatedModuleIds.includes("visualbridge.structured"),
        "The trust grant did not evaluate the structured domain package.",
      );

      // 已打开的只读 Shell 自动切换为领域编辑器。
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getReadonlyShellState", uri),
        (shell) => shell?.active === false,
        20_000,
        "The read-only shell was not replaced after the trust grant.",
      );
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "The Structured editor did not become ready after the trust grant.",
      );
      const remaining = vscode.languages
        .getDiagnostics(markerUri)
        .filter((entry) => typeof entry.code === "string" && entry.code.startsWith("module."));
      assert.deepEqual(remaining, [], "Module diagnostics were not cleared after the trust grant.");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors").catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.test.setModuleTrustOverride", undefined);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.trusted === false,
        20_000,
        "The module trust override did not reset.",
      );
    }
  });

  await test("gates the standalone Table editor behind module trust", async () => {
    const projectRoot = vscode.Uri.file(path.join(workspacePath, "TableGateProject"));
    const markerUri = vscode.Uri.joinPath(projectRoot, "VisualBridge.project.vbjson");
    const documentUri = vscode.Uri.joinPath(projectRoot, "Tables", "Sample.csv");
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectRoot, "Tables"));
      await vscode.workspace.fs.writeFile(markerUri, new TextEncoder().encode(`${JSON.stringify({
        formatVersion: 2,
        projectId: "visualbridge.b1.table-gate",
        documentRoots: ["Tables"],
        modules: [{
          id: "visualbridge.table",
          entry: "Modules/table.vbmodule.js",
          options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
        }],
        documentTypes: [{
          id: "shell.table",
          editor: "table",
          include: ["Tables/*.csv"],
          exclude: [],
          catalogs: [],
        }],
      }, undefined, 2)}\n`));
      await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode("key,name\n1,Sword\n"));
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.projects.some((entry) => entry.projectId === "visualbridge.b1.table-gate"),
        20_000,
        "The table gate fixture project was not discovered.",
      );

      // 直接 openWith Table 编辑器：未受信任时只能拿到只读 Shell。
      const probeBefore = (await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState")).evaluatedModuleIds;
      await vscode.commands.executeCommand("vscode.openWith", documentUri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", documentUri),
        (ready) => ready === true,
        20_000,
        "The gated Table shell did not become ready.",
      );
      const shell = await vscode.commands.executeCommand("visualbridge.test.getTableReadonlyShellState", documentUri);
      assert.equal(shell.active, true);
      assert.equal(shell.reason, "untrusted");
      assert.match(shell.message, /需要信任工作区才能加载模块/u);
      const tableState = await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", documentUri);
      assert.equal(tableState.panelCount, 0, "The Table editor session started in Restricted Mode.");
      // 只读 Shell 的四个写入口必须全部明确拒绝（不是静默 no-op）。
      const rejectedWrites = await vscode.commands.executeCommand(
        "visualbridge.test.assertTableShellReadonly",
        documentUri,
      );
      assert.deepEqual([...rejectedWrites].sort(), ["backup", "revert", "save", "saveAs"]);
      const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
      assert.deepEqual(state.evaluatedModuleIds, probeBefore, "The Table editor gate activated a module.");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } finally {
      await vscode.workspace.fs.delete(documentUri, { useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(markerUri, { useTrash: false }).then(undefined, () => undefined);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await vscode.workspace.fs.delete(projectRoot, { recursive: true, useTrash: false }).then(undefined, () => undefined);
    }
  });

  await test("does not parse domain Catalogs when applying Project Settings in Restricted Mode", async () => {
    const markerUri = vscode.Uri.file(path.join(workspacePath, "VisualBridge.project.vbjson"));
    const catalogUri = vscode.Uri.file(path.join(workspacePath, "Catalog", "Provider.vbstructuredcatalog"));
    const projectBefore = await vscode.workspace.fs.readFile(markerUri);
    const catalogBefore = await vscode.workspace.fs.readFile(catalogUri);
    try {
      // 文件存在但内容非法：若 apply 仍解析领域 Catalog，会因解析错误拒绝这次 Operation。
      await vscode.workspace.fs.writeFile(catalogUri, new TextEncoder().encode("{ not a valid catalog"));
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await vscode.commands.executeCommand("vscode.openWith", markerUri, "visualbridge.projectSettingsEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", markerUri),
        (ready) => ready === true,
        20_000,
        "Project Settings did not become ready in Restricted Mode.",
      );
      const baseline = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getProjectSettingsState", markerUri),
        (state) => typeof state?.sourceHash === "string" && state.sourceHash.length > 0,
        20_000,
        "Project Settings did not expose a source hash.",
      );
      const probeBefore = (await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState")).evaluatedModuleIds;
      await vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", markerUri, baseline.sourceHash, [{
        type: "project.setModuleOptions",
        moduleId: "visualbridge.structured",
        options: { restrictedProbe: true },
      }]);
      const applied = JSON.parse((await vscode.workspace.openTextDocument(markerUri)).getText());
      assert.deepEqual(
        applied.modules.find((module) => module.id === "visualbridge.structured").options,
        { restrictedProbe: true },
      );
      const probeAfter = (await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState")).evaluatedModuleIds;
      assert.deepEqual(probeAfter, probeBefore, "Applying Project Settings activated a module.");
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors").catch(() => undefined);
      await vscode.workspace.fs.writeFile(catalogUri, catalogBefore);
      await vscode.workspace.fs.writeFile(markerUri, projectBefore);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
    }
  });

  await test("blocks document creation commands while modules are untrusted", async () => {
    // 未授权时命令必须在弹 QuickPick 之前返回，否则测试会一直挂起。
    await Promise.race([
      vscode.commands.executeCommand("visualbridge.createStructuredDocument"),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("visualbridge.createStructuredDocument did not return quickly.")), 10_000);
      }),
    ]);
    await Promise.race([
      vscode.commands.executeCommand("visualbridge.createDocument"),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("visualbridge.createDocument did not return quickly.")), 10_000);
      }),
    ]);
  });

  await test("debug categories fall back to the generic view with an explicit module-unloaded notice", async () => {
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.ingest", [
      {
        type: "debugCreate",
        frame: -1,
        wireBytes: 10,
        payloadKind: 1,
        category: "graph",
        instance: "restricted-hero",
        instanceSlot: 1,
        resName: "restricted-hero-res",
        debugInfo: "",
      },
      {
        type: "debug",
        frame: 1,
        wireBytes: 24,
        payloadKind: 1,
        category: "graph",
        instance: "restricted-hero",
        interfaceId: "IGraphDebuger",
        method: "NodeStarted",
        methodId: 10,
        instanceSlot: 1,
        args: [{ tag: 1, name: "nodeId", type: "string", value: "node-restricted" }],
        contractState: "unknown-interface",
      },
    ]);
    const snapshot = await vscode.commands.executeCommand("visualbridge.test.debugPanel.flushFacets");
    const window = snapshot.windows.find((candidate) => candidate.category === "graph");
    assert.ok(window, "An untrusted workspace must still expose the category window as unavailable.");
    assert.equal(window.state, "unavailable");
    assert.match(window.message, /模块未加载/u);
    assert.equal(window.moduleId, undefined);
    assert.ok(snapshot.generic.records >= 1, "The record still reaches the generic consumer.");
  });
};

async function test(name, action) {
  const startedAt = Date.now();
  try {
    await action();
    console.log(`[vscode-restricted] PASS ${name} (${Date.now() - startedAt} ms)`);
  } catch (error) {
    console.error(`[vscode-restricted] FAIL ${name}`);
    throw error;
  }
}

async function waitFor(read, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function waitForAsync(read, accepts, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue;
  while (Date.now() < deadline) {
    const value = await read();
    lastValue = value;
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message} Last observed value: ${JSON.stringify(lastValue)}`);
}

function requiredAbsolutePath(name) {
  const value = requiredValue(name);
  if (!path.isAbsolute(value)) throw new Error(`Environment variable '${name}' must be absolute.`);
  return value;
}

function requiredValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Environment variable '${name}' is required.`);
  }
  return value;
}

function normalizePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
