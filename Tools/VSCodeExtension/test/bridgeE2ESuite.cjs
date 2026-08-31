const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "kyl.visualbridge";

exports.run = async function run() {
  const workspacePath = requiredEnvironmentPath("VISUALBRIDGE_TEST_WORKSPACE");
  const resultPath = requiredEnvironmentPath("VISUALBRIDGE_BRIDGE_E2E_RESULT");
  const documentPath = process.env.VISUALBRIDGE_BRIDGE_E2E_DOCUMENT ?? "Config/Game.gamesettings";

  await test("activates VisualBridge and starts the Editor Bridge server", async () => {
    const candidate = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(candidate, `Extension '${EXTENSION_ID}' was not discovered.`);
    await waitFor(
      () => candidate.isActive,
      (isActive) => isActive,
      60_000,
      `Extension '${EXTENSION_ID}' was not activated.`,
    );
    const state = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getBridgeServerState"),
      (value) => value !== null && value !== undefined,
      60_000,
      "Editor Bridge server did not start during activation.",
    );
    const authoringRoot = normalizeFileSystemPath(path.join(workspacePath, "VisualBridgeAuthoring"));
    assert.ok(
      state.projectRoots.some((root) => normalizeFileSystemPath(root) === authoringRoot),
      `Bridge discovery roots miss the Unity authoring project: ${JSON.stringify(state.projectRoots)}`,
    );
  });

  await test("receives the Unity Editor open and reveal round trip", async () => {
    const content = await waitForAsync(
      () => readFile(resultPath, "utf8").catch(() => undefined),
      (value) => value !== undefined,
      300_000,
      "Unity Editor never wrote the bridge E2E result file.",
    );
    const lines = content.trim().split(/\r?\n/);
    const openLine = lines.find((line) => line.startsWith("open="));
    const revealLine = lines.find((line) => line.startsWith("reveal="));
    assert.equal(openLine, "open=ok", `Unity bridge open failed: ${content}`);
    assert.equal(revealLine, "reveal=ok", `Unity bridge reveal failed: ${content}`);

    const documentUri = vscode.Uri.file(path.join(workspacePath, "VisualBridgeAuthoring", ...documentPath.split("/")));
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", documentUri),
      (ready) => ready === true,
      30_000,
      "The bridge open request did not leave the authoring document open in VS Code.",
    );
  });
};

async function test(name, action) {
  console.log(`[bridge-e2e] ${name}`);
  try {
    await action();
    console.log(`[bridge-e2e] PASS ${name}`);
  } catch (errorValue) {
    console.error(`[bridge-e2e] FAIL ${name}`);
    console.error(errorValue);
    throw errorValue;
  }
}

async function waitFor(read, accepts, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue;
  while (Date.now() < deadline) {
    const value = read();
    lastValue = value;
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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

function normalizeFileSystemPath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function requiredEnvironmentPath(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable '${name}' is not set.`);
  }
  return value;
}
