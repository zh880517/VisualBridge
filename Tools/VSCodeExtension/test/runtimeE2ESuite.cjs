const assert = require("node:assert/strict");
const { readFile, writeFile, stat } = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "kyl.visualbridge";

exports.run = async function run() {
  const repositoryRoot = requiredEnvironmentPath("VISUALBRIDGE_REPOSITORY_ROOT");
  const artifactsRoot = path.join(repositoryRoot, "UnityProject", "Library", "VisualBridge", "Compiled");

  await test("activates VisualBridge and discovers the runtime instance", async () => {
    const candidate = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(candidate, `Extension '${EXTENSION_ID}' was not discovered.`);
    await waitFor(
      () => candidate.isActive,
      (isActive) => isActive,
      60_000,
      `Extension '${EXTENSION_ID}' was not activated.`,
    );
    const instances = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances"),
      (value) => Array.isArray(value) && value.some((instance) => instance.kind === "editor-play" && instance.staleReason === undefined),
      120_000,
      "No live editor-play runtime instance was discovered.",
    );
    const instance = instances.find((entry) => entry.kind === "editor-play" && entry.staleReason === undefined);
    const welcome = await vscode.commands.executeCommand("visualbridge.test.connectRuntimeInstance", instance);
    assert.equal(welcome.instanceId, instance.instanceId);
    assert.equal(welcome.generation, instance.generation);
    assert.ok(welcome.capabilities.includes("snapshot"), "Runtime instance does not advertise the snapshot capability.");
    console.log(`[runtime-e2e] connected to ${welcome.instanceId} generation ${welcome.generation} on port ${instance.tcpPort}`);
  });

  await test("receives the compiled artifact snapshot from the runtime instance", async () => {
    const documents = await vscode.commands.executeCommand("visualbridge.test.getRuntimeSnapshot");
    assert.ok(Array.isArray(documents), "Snapshot response did not carry a documents array.");
    const hero = documents.find((document) => document.documentId === "sample.unity.hero.default");
    assert.ok(hero, "Snapshot does not contain the compiled entity fixture.");
    assert.equal(hero.documentTypeId, "sample.unity.hero");
    assert.equal(hero.kind, "visualbridge.entity.compiled");
    assert.equal(hero.data.properties.name, "Ranger");
    assert.ok(documents.length >= 4, `Expected all four domain artifacts, found ${documents.length}.`);
    const state = await vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
    assert.equal(state.connected, true);
    assert.equal(state.lastSnapshotCount, 1);
  });

  await test("receives the artifactsChanged event after a compiled artifact changes", async () => {
    const artifactPath = path.join(
      artifactsRoot,
      "documents",
      "visualbridge.unity-sample",
      "sample.unity.game.settings",
      "sample.unity.game.settings.default.vbcompiled.json",
    );
    const original = await readFile(artifactPath, "utf8");
    try {
      // 重排 JSON（内容不同但仍是合法产物）触发实例侧 digest 轮询。
      const modified = `${JSON.stringify(JSON.parse(original), undefined, 4)}\n`;
      await writeFile(artifactPath, modified, "utf8");
      const state = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState"),
        (value) => value?.lastEventCount >= 1,
        10_000,
        "The runtime instance did not push an artifactsChanged event.",
      );
      assert.equal(state.connected, true);
      console.log(`[runtime-e2e] received artifactsChanged (events=${state.lastEventCount})`);
    } finally {
      await writeFile(artifactPath, original, "utf8");
      await stat(artifactPath);
    }
  });
};

async function test(name, action) {
  console.log(`[runtime-e2e] ${name}`);
  try {
    await action();
    console.log(`[runtime-e2e] PASS ${name}`);
  } catch (errorValue) {
    console.error(`[runtime-e2e] FAIL ${name}`);
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
  throw new Error(`${message} Last observed value: ${JSON.stringify(lastValue)}`);
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
  throw new Error(`${message} Last observed value: ${JSON.stringify(lastValue)}`);
}

function requiredEnvironmentPath(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable '${name}' is not set.`);
  }
  return value;
}
