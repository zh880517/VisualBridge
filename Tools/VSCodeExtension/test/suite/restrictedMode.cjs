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
    await new Promise((resolve) => setTimeout(resolve, 750));
    await assert.rejects(
      readFile(path.join(providerStatePath, "events.ndjson"), "utf8"),
      (error) => error?.code === "ENOENT",
      "Project Provider wrote a startup event in Restricted Mode.",
    );
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
