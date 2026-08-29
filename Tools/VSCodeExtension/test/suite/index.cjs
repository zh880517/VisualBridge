const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "kyl.visualbridge";
const EXPECTED_COMMANDS = [
  "visualbridge.createDocument",
  "visualbridge.createEntityDocument",
  "visualbridge.createGraphDocument",
  "visualbridge.createStructuredDocument",
  "visualbridge.createTableDocument",
  "visualbridge.documentBrowser.create",
  "visualbridge.documentBrowser.open",
  "visualbridge.documentBrowser.refresh",
  "visualbridge.documentBrowser.renameReferenceTarget",
  "visualbridge.documentBrowser.revealReference",
  "visualbridge.documentBrowser.search",
  "visualbridge.documentBrowser.validateAll",
  "visualbridge.openDocument",
  "visualbridge.refreshProjects",
  "visualbridge.revealReference",
];

exports.run = async function run() {
  const workspacePath = requiredEnvironmentPath("VISUALBRIDGE_TEST_WORKSPACE");
  const expectedExtensionVersion = requiredEnvironmentValue("VISUALBRIDGE_TEST_EXTENSION_VERSION");
  await test("opens the isolated VisualBridge workspace", async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.equal(folders.length, 1);
    assert.equal(normalizeFileSystemPath(folders[0].uri.fsPath), normalizeFileSystemPath(workspacePath));
  });

  const extension = await test("activates VisualBridge", async () => {
    const candidate = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(candidate, `Extension '${EXTENSION_ID}' was not discovered.`);
    await waitFor(
      () => candidate.isActive,
      (isActive) => isActive,
      20_000,
      `Extension '${EXTENSION_ID}' was not activated by its workspaceContains event.`,
    );
    assert.equal(candidate.isActive, true);
    assert.equal(candidate.packageJSON.version, expectedExtensionVersion);
    return candidate;
  });
  assert.ok(extension);

  await test("registers the stable host commands", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    EXPECTED_COMMANDS.forEach((command) => {
      assert.ok(commands.has(command), `Command '${command}' was not registered.`);
    });
  });

  await test("routes a project-defined Entity extension to the optional document editor", async () => {
    await assertEditorRoute(
      workspacePath,
      ["EntitySemanticProject", "Config", "Entities", "Player.herojson"],
      "visualbridge.documentEditor.option",
      "visualbridge.openDocument",
    );
  });

  await test("opens the default Graph extension with its declared default editor", async () => {
    await assertEditorRoute(
      workspacePath,
      ["GraphSemanticProject", "Graph", "SemanticSample.vbgraph"],
      "visualbridge.documentEditor",
      "vscode.open",
    );
  });

  await test("re-handshakes a Graph Webview after its hidden context is recreated", async () => {
    const graphUri = vscode.Uri.file(path.join(
      workspacePath,
      "GraphSemanticProject",
      "Graph",
      "SemanticSample.vbgraph",
    ));
    const markerUri = vscode.Uri.file(path.join(
      workspacePath,
      "GraphSemanticProject",
      "VisualBridge.project.vbjson",
    ));
    await withTimeout(vscode.commands.executeCommand("vscode.open", graphUri), 20_000, "Graph did not open.");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", graphUri),
      (isReady) => isReady === true,
      20_000,
      "Graph Webview did not complete its first ready handshake.",
    );
    const firstHandshake = await vscode.commands.executeCommand(
      "visualbridge.test.getGraphEditorState",
      graphUri,
    );
    assert.equal(firstHandshake.readySessionCount, 1);
    assert.ok(firstHandshake.maxReadyGeneration > 0);
    assert.equal(firstHandshake.sessionIds.length, 1);
    assert.equal(firstHandshake.readyTokens.length, 1);
    await withTimeout(vscode.commands.executeCommand("vscode.open", markerUri), 20_000, "Marker did not open.");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", graphUri),
      (state) => state?.readySessionCount === 0,
      5_000,
      "Hidden Graph Webview remained ready after its context was released.",
    );
    await withTimeout(vscode.commands.executeCommand("vscode.open", graphUri), 20_000, "Graph did not reopen.");
    const reopenedTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(reopenedTab?.input instanceof vscode.TabInputCustom);
    assert.equal(reopenedTab.input.uri.toString(), graphUri.toString());
    assert.equal(reopenedTab.input.viewType, "visualbridge.documentEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", graphUri),
      (state) => state?.readySessionCount === 1
        && state.readyTokens.some((token) => !firstHandshake.readyTokens.includes(token)),
      20_000,
      "Recreated Graph Webview did not repeat its ready handshake.",
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", graphUri),
      (isReady) => isReady === false,
      5_000,
      "Closed Graph Webview remained ready.",
    );
  });

  await test("routes a project-defined Structured extension to the optional document editor", async () => {
    await assertEditorRoute(
      workspacePath,
      ["StructuredSemanticProject", "Config", "Game.gamesettings"],
      "visualbridge.documentEditor.option",
      "visualbridge.openDocument",
    );
  });

  await test("routes a project-defined Table extension to the Table editor", async () => {
    await assertEditorRoute(
      workspacePath,
      ["EntitySemanticProject", "Tables", "Skills_Main.skillstable"],
      "visualbridge.tableEditor",
      "visualbridge.openDocument",
    );
  });

  await test("queues and acknowledges a Table row reveal before its editor is open", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Tables",
      "Skills_Main.skillstable",
    ));
    await withTimeout(vscode.commands.executeCommand("visualbridge.revealReference", {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      path: "Tables/Skills_Main.skillstable",
      sheetId: "skills:Skills_Main",
      rowId: "Skills_Main:key-101",
    }), 20_000, "Table reveal command did not open its target editor.");
    const activeTab = await waitFor(
      () => vscode.window.tabGroups.activeTabGroup.activeTab,
      (tab) => tab?.input instanceof vscode.TabInputCustom
        && tab.input.uri.toString() === uri.toString()
        && tab.input.viewType === "visualbridge.tableEditor",
      20_000,
      "Table reveal did not open the expected custom editor.",
    );
    assert.ok(activeTab);
    const state = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.activeReadyPanelCount === 1
        && value.pendingRevealCount === 0
        && value.lastRevealResult?.found === true,
      20_000,
      "Table reveal was not acknowledged by the active Webview.",
    );
    assert.equal(state.panelCount, 1);
    assert.deepEqual(state.lastRevealTarget, {
      sheetId: "skills:Skills_Main",
      rowId: "Skills_Main:key-101",
    });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 0
        && value.pendingRevealCount === 0
        && value.lastRevealResult === undefined,
      5_000,
      "Closed Table editor retained panel, reveal, or acknowledgement state.",
    );
  });

  await test("cancels an unacknowledged Table reveal when its last panel closes", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Tables",
      "Skills_Main.skillstable",
    ));
    await withTimeout(
      vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor"),
      20_000,
      "Table editor did not open for the close-cancellation test.",
    );
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 1 && value.activeReadyPanelCount === 1,
      20_000,
      "Table panel did not become ready for the close-cancellation test.",
    );
    assert.equal(
      await vscode.commands.executeCommand("visualbridge.test.pauseNextTableReveal", uri),
      true,
    );
    await vscode.commands.executeCommand("visualbridge.revealReference", {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      path: "Tables/Skills_Main.skillstable",
      sheetId: "skills:Skills_Main",
      rowId: "Skills_Main:key-101",
    });
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 1
        && value.pendingRevealCount === 1
        && value.lastRevealResult === undefined,
      20_000,
      "The Table reveal was not held pending before closing its last panel.",
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 0
        && value.pendingRevealCount === 0
        && value.lastRevealResult === undefined,
      5_000,
      "Closing the last Table panel retained its unacknowledged reveal.",
    );
    await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 1
        && value.activeReadyPanelCount === 1
        && value.pendingRevealCount === 0
        && value.lastRevealResult === undefined,
      20_000,
      "Reopening the Table editor replayed a cancelled reveal.",
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  await test("keeps only the latest Table reveal across split custom-editor panels", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Tables",
      "Skills_Main.skillstable",
    ));
    await withTimeout(
      vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor"),
      20_000,
      "Table editor did not open for the latest-reveal test.",
    );
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 1 && value.activeReadyPanelCount === 1,
      20_000,
      "Initial Table panel did not become ready.",
    );
    await withTimeout(
      vscode.commands.executeCommand("workbench.action.splitEditorRight"),
      20_000,
      "VS Code did not split the Table custom editor.",
    );
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 2 && value.activeReadyPanelCount === 1,
      20_000,
      "Both split Table panels did not become ready.",
    );
    assert.equal(
      await vscode.commands.executeCommand("visualbridge.test.pauseNextTableReveal", uri),
      true,
    );
    await vscode.commands.executeCommand("visualbridge.revealReference", {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      path: "Tables/Skills_Main.skillstable",
      sheetId: "skills:Skills_Main",
      rowId: "Skills_Main:key-101",
    });
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.pendingRevealCount === 1 && value.lastRevealResult === undefined,
      20_000,
      "The first split-panel reveal was not held pending.",
    );
    await vscode.commands.executeCommand("workbench.action.focusLeftGroup");
    await vscode.commands.executeCommand("visualbridge.revealReference", {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      path: "Tables/Skills_Main.skillstable",
      sheetId: "skills:Skills_Main",
      rowId: "Skills_Main:key-102",
    });
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 2
        && value.pendingRevealCount === 0
        && value.lastRevealResult?.found === true
        && value.lastRevealTarget?.rowId === "Skills_Main:key-102",
      20_000,
      "The newer Table reveal did not supersede the pending request.",
    );
    await vscode.commands.executeCommand("workbench.action.focusRightGroup");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 1
        && value.pendingRevealCount === 0
        && value.lastRevealTarget?.rowId === "Skills_Main:key-102",
      5_000,
      "Closing the superseded panel restored its stale reveal.",
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 0 && value.pendingRevealCount === 0,
      5_000,
      "Closing the latest-reveal test panels retained state.",
    );
  });

  await test("hands an unacknowledged Table reveal to a surviving split panel", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Tables",
      "Skills_Main.skillstable",
    ));
    await withTimeout(
      vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor"),
      20_000,
      "Table editor did not open for the split-panel test.",
    );
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 1 && value.activeReadyPanelCount === 1,
      20_000,
      "Initial Table panel did not become ready.",
    );
    await withTimeout(
      vscode.commands.executeCommand("workbench.action.splitEditorRight"),
      20_000,
      "VS Code did not split the Table custom editor.",
    );
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 2 && value.activeReadyPanelCount === 1,
      20_000,
      "Both split Table panels did not become ready.",
    );
    assert.equal(
      await vscode.commands.executeCommand("visualbridge.test.pauseNextTableReveal", uri),
      true,
    );
    await withTimeout(vscode.commands.executeCommand("visualbridge.revealReference", {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      path: "Tables/Skills_Main.skillstable",
      sheetId: "skills:Skills_Main",
      rowId: "Skills_Main:key-102",
    }), 20_000, "Split-panel Table reveal command did not complete.");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 2
        && value.pendingRevealCount === 1
        && value.lastRevealResult === undefined,
      20_000,
      "The addressed Table panel did not retain the deliberately unacknowledged request.",
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 1
        && value.pendingRevealCount === 0
        && value.lastRevealResult?.found === true
        && value.lastRevealTarget?.rowId === "Skills_Main:key-102",
      20_000,
      "The surviving Table panel did not take over and acknowledge the pending reveal.",
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri),
      (value) => value?.panelCount === 0
        && value.pendingRevealCount === 0
        && value.lastRevealResult === undefined,
      5_000,
      "Closing both split Table panels retained editor state.",
    );
  });
};

async function assertEditorRoute(workspacePath, segments, expectedViewType, openCommand) {
  const uri = vscode.Uri.file(path.join(workspacePath, ...segments));
  await vscode.workspace.fs.stat(uri);
  let openError;
  const openPromise = vscode.commands.executeCommand(openCommand, uri).catch((error) => {
    openError = error;
  });
  const activeTab = await waitFor(
    () => {
      if (openError !== undefined) throw openError;
      return vscode.window.tabGroups.activeTabGroup.activeTab;
    },
    (tab) => tab?.input instanceof vscode.TabInputCustom
      && tab.input.uri.toString() === uri.toString(),
    20_000,
    `No custom editor tab appeared for '${uri.fsPath}'.`,
  );
  assert.ok(activeTab, `No active tab after opening '${uri.fsPath}'.`);
  assert.ok(activeTab.input instanceof vscode.TabInputCustom, `Expected a custom editor for '${uri.fsPath}'.`);
  assert.equal(activeTab.input.viewType, expectedViewType);
  assert.equal(activeTab.input.uri.toString(), uri.toString());

  await waitForAsync(
    async () => {
      if (openError !== undefined) throw openError;
      return vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri);
    },
    (isReady) => isReady === true,
    20_000,
    `Custom editor provider did not finish initializing '${uri.fsPath}'.`,
  );

  await withTimeout(openPromise, 5_000, `Opening '${uri.fsPath}' did not settle while its ready tab remained open.`);
  if (openError !== undefined) throw openError;
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitForAsync(
    () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
    (isReady) => isReady === false,
    5_000,
    `Closed custom editor still reports ready for '${uri.fsPath}'.`,
  );
}

async function test(name, action) {
  const startedAt = Date.now();
  try {
    const result = await action();
    console.log(`[vscode-host] PASS ${name} (${Date.now() - startedAt} ms)`);
    return result;
  } catch (error) {
    console.error(`[vscode-host] FAIL ${name}`);
    throw error;
  }
}

function requiredEnvironmentPath(name) {
  const value = requiredEnvironmentValue(name);
  if (!path.isAbsolute(value)) {
    throw new Error(`Environment variable '${name}' must contain an absolute path.`);
  }
  return value;
}

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Environment variable '${name}' is required.`);
  }
  return value;
}

function normalizeFileSystemPath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function withTimeout(promise, timeoutMilliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(read, accepts, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue;
  while (Date.now() < deadline) {
    const value = read();
    lastValue = value;
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message} Last observed value: ${formatObservedValue(lastValue)}`);
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
  throw new Error(`${message} Last observed value: ${formatObservedValue(lastValue)}`);
}

function formatObservedValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
