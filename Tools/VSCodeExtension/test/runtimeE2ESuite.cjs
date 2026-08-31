const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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

  await test("acquires the debug lease and maps document sources with drift detection", async () => {
    await vscode.commands.executeCommand("visualbridge.test.acquireRuntimeLease");
    const sources = await vscode.commands.executeCommand("visualbridge.test.getRuntimeDocumentSources");
    assert.ok(Array.isArray(sources) && sources.length >= 4, `Expected source mappings for all domains, found ${sources?.length}.`);
    const heroSource = sources.find((source) => source.documentId === "sample.unity.hero.default");
    assert.ok(heroSource, "Source mapping does not contain the entity fixture.");
    assert.equal(heroSource.documentTypeId, "sample.unity.hero");
    assert.match(heroSource.sourcePath, /Entities\/Hero\.vbentity$/);
    assert.match(heroSource.sourceSha256, /^[0-9a-f]{64}$/);

    // 漂移防护：工作区当前文档字节与运行时加载的源 Hash 必须一致（未修改时）。
    const heroPath = path.join(repositoryRoot, "UnityProject", "VisualBridgeAuthoring", ...heroSource.sourcePath.split("/"));
    const currentBytes = await readFile(heroPath);
    const currentSha = createHash("sha256").update(currentBytes).digest("hex");
    assert.equal(currentSha, heroSource.sourceSha256, "Unmodified authoring document should not be reported as drifted.");

    // 修改 Authoring 文档后，源映射必须能暴露漂移（运行时仍持有旧 Hash）。
    const original = await readFile(heroPath, "utf8");
    try {
      await writeFile(heroPath, original.replace('"Ranger"', '"Drifted Ranger"'), "utf8");
      const driftedBytes = await readFile(heroPath);
      const driftedSha = createHash("sha256").update(driftedBytes).digest("hex");
      assert.notEqual(driftedSha, heroSource.sourceSha256, "Modified authoring document must differ from the runtime source hash.");
    } finally {
      await writeFile(heroPath, original, "utf8");
    }

    await vscode.commands.executeCommand("visualbridge.test.releaseRuntimeLease");
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

  await test("inspects the runtime snapshot through the DAP debug session", async () => {
    // 前置测试已释放租约且仅持有观察者连接：DAP attach 可重新连接并 acquire。
    const instances = await vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances");
    const instance = Array.isArray(instances)
      ? instances.find((entry) => entry.kind === "editor-play" && entry.staleReason === undefined)
      : undefined;
    assert.ok(instance, "No live editor-play runtime instance for the DAP inspection session.");
    const session = await vscode.commands.executeCommand("visualbridge.test.attachRuntimeInstance", instance);
    assert.equal(session.type, "visualbridge-runtime");
    const attached = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getRuntimeDebugSessionState"),
      (value) => value?.connected === true && value?.leaseHeld === true && value?.documents >= 4,
      30_000,
      "The DAP inspection session did not attach with the full runtime snapshot.",
    );
    // 未修改 Authoring 源（hero 漂移测试已还原）：hero 与全部文档 drifted=false。
    assert.equal(attached.driftedDocuments, 0, "Unmodified authoring documents must not be reported as drifted.");
    assert.equal(attached.driftedDocumentIds.includes("sample.unity.hero.default"), false,
      "The unmodified hero document must not be reported as drifted.");
    assert.equal(attached.topLevelVariables, attached.documents, "Top-level variables must mirror the runtime document list.");

    await vscode.debug.stopDebugging(session);
    const closed = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getRuntimeDebugSessionState"),
      (value) => value?.connected !== true && value?.leaseHeld !== true && value?.documents === 0,
      30_000,
      "The DAP inspection session did not release the lease and disconnect.",
    );
    assert.equal(closed.leaseHeld, false);
  });

  await test("drives graph execution debug through the Graph editor with live Unity events", async () => {
    // Unity 侧执行模拟器持续上报 Encounter 图的节点/边事件（VB-UX-16）。
    const encounterUri = vscode.Uri.file(path.join(
      repositoryRoot, "UnityProject", "VisualBridgeAuthoring", "Graphs", "Encounter.vbflow"));
    try {
      await vscode.commands.executeCommand("vscode.openWith", encounterUri, "visualbridge.documentEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", encounterUri),
        (ready) => ready === true,
        30_000,
        "The Graph editor did not become ready for the execution debug E2E.",
      );

      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "requestGraphExecutionInstances",
        requestId: "e2e-graph-debug-list",
      });
      const listed = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.runtimeConnected === true && state?.instanceCount >= 1,
        60_000,
        "The debug controller did not discover the Unity execution instance.",
      );
      const executionId = listed.instanceIds[0];
      assert.ok(executionId, "No execution instance id was listed for the Encounter graph.");

      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "subscribeGraphExecution",
        requestId: "e2e-graph-debug-subscribe",
        executionId,
      });
      const live = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === executionId
          && state?.lastWebviewAck !== undefined
          && state.lastWebviewAck.eventCount >= 1
          && typeof state.lastWebviewAck.executingNodeId === "string"
          && state.lastWebviewAck.executingNodeId.length > 0
          && state.lastWebviewAck.mode === "follow",
        60_000,
        "The Webview did not acknowledge live Unity execution events.",
      );
      const liveNodeId = live.lastWebviewAck.executingNodeId;
      assert.equal(live.lastWebviewAck.cursor, live.lastWebviewAck.eventCount - 1,
        "The follow-mode cursor must track the latest Unity event.");
      console.log(`[runtime-e2e] execution debug live: execution=${executionId} node=${liveNodeId} events=${live.lastWebviewAck.eventCount}`);

      // 退订停采：断开连接后事件不再累计。
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "unsubscribeGraphExecution",
        requestId: "e2e-graph-debug-unsubscribe",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === undefined && state?.runtimeConnected === false,
        30_000,
        "The debug controller did not unsubscribe and disconnect.",
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // 切换实例：模拟器保持实例存活，重新订阅后事件从低计数恢复增长。
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "requestGraphExecutionInstances",
        requestId: "e2e-graph-debug-relist",
      });
      const relisted = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.runtimeConnected === true && state?.instanceCount >= 1,
        60_000,
        "The debug controller did not re-discover the Unity execution instance.",
      );
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "subscribeGraphExecution",
        requestId: "e2e-graph-debug-resubscribe",
        executionId: relisted.instanceIds[0],
      });
      const resumed = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === relisted.instanceIds[0]
          && state?.lastWebviewAck !== undefined
          && state.lastWebviewAck.eventCount >= 1,
        60_000,
        "The Webview did not resume execution events after re-subscribing.",
      );
      assert.ok(resumed.lastWebviewAck.eventCount <= 5,
        `Re-subscription must start from a fresh recording (events=${resumed.lastWebviewAck.eventCount}); `
        + "a large count means events kept accumulating while unsubscribed.");
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "unsubscribeGraphExecution",
        requestId: "e2e-graph-debug-final-unsubscribe",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === undefined && state?.runtimeConnected === false,
        30_000,
        "The debug controller did not release the final subscription.",
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
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