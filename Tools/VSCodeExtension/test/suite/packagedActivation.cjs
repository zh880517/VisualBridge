const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "kyl.visualbridge";

exports.run = async function run() {
  const expectedRoot = requiredEnvironmentPath("VISUALBRIDGE_PACKAGED_EXTENSION_ROOT");
  const workspacePath = requiredEnvironmentPath("VISUALBRIDGE_TEST_WORKSPACE");
  const expectedVersion = requiredEnvironmentValue("VISUALBRIDGE_TEST_EXTENSION_VERSION");
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Installed extension '${EXTENSION_ID}' was not discovered.`);
  assert.equal(normalizePath(extension.extensionPath), normalizePath(expectedRoot));
  assert.equal(extension.packageJSON.version, expectedVersion);

  await waitFor(
    () => extension.isActive,
    (active) => active === true,
    20_000,
    `Installed extension '${EXTENSION_ID}' did not activate from workspaceContains.`,
  );
  await vscode.commands.executeCommand("visualbridge.refreshProjects");
  const commands = new Set(await vscode.commands.getCommands(true));
  assert.ok(commands.has("visualbridge.openDocument"));

  const graphUri = vscode.Uri.file(path.join(
    workspacePath,
    "GraphSemanticProject",
    "Graph",
    "SemanticSample.vbgraph",
  ));
  await vscode.commands.executeCommand("visualbridge.openDocument", graphUri);
  const activeTab = await waitFor(
    () => vscode.window.tabGroups.activeTabGroup.activeTab,
    (tab) => tab?.input instanceof vscode.TabInputCustom
      && tab.input.uri.toString() === graphUri.toString(),
    20_000,
    "The packaged extension did not resolve its Graph custom editor.",
  );
  assert.equal(activeTab.input.viewType, "visualbridge.documentEditor.option");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  console.log(`[vscode-cli] PASS activated packaged ${EXTENSION_ID}@${expectedVersion}`);
};

function requiredEnvironmentPath(name) {
  const value = requiredEnvironmentValue(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must contain an absolute path.`);
  return value;
}

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function normalizePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function waitFor(read, accepts, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = read();
    if (accepts(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message} Last observed value: ${String(lastValue)}`);
}
