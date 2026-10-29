const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, symlink, unlink, writeFile } = require("node:fs/promises");
const fsPromises = require("node:fs/promises");
const { createHash } = require("node:crypto");
const net = require("node:net");
const { tmpdir } = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const vscode = require("vscode");
const ExcelJS = require("exceljs");
const { attachJsonReader, encodeFrame, KIND_JSON, sendJson } = require("../support/bridgeFrames.cjs");
const { createRuntimeWelcome, createRuntimeHello, runtimeSessionId } = require("../support/runtimeHandshake.cjs");

const EXTENSION_ID = "kyl.visualbridge";
const EXPECTED_COMMANDS = [
  "visualbridge.createDocument",
  "visualbridge.createEntityDocument",
  "visualbridge.createGraphDocument",
  "visualbridge.createStructuredDocument",
  "visualbridge.createTableDocument",
  "visualbridge.documentBrowser.create",
  "visualbridge.documentBrowser.copy",
  "visualbridge.documentBrowser.copyProblem",
  "visualbridge.documentBrowser.move",
  "visualbridge.documentBrowser.open",
  "visualbridge.documentBrowser.refresh",
  "visualbridge.documentBrowser.renamePath",
  "visualbridge.documentBrowser.renameReferenceTarget",
  "visualbridge.documentBrowser.revealReference",
  "visualbridge.documentBrowser.search",
  "visualbridge.documentBrowser.safeDelete",
  "visualbridge.documentBrowser.showProblems",
  "visualbridge.documentBrowser.showReferences",
  "visualbridge.documentBrowser.validateAll",
  "visualbridge.catalogBrowser.open",
  "visualbridge.catalogBrowser.refresh",
  "visualbridge.manageUnsavedDocuments",
  "visualbridge.openDebugPanel",
  "visualbridge.openDebugRecording",
  "visualbridge.openDocument",
  "visualbridge.openProjectSettings",
  "visualbridge.refreshProjects",
  "visualbridge.safeDeleteElement",
  "visualbridge.unsavedDocuments.discardAll",
  "visualbridge.unsavedDocuments.refresh",
  "visualbridge.unsavedDocuments.saveAll",
  "visualbridge.revealReference",
];

/**
 * 生成一个最小、可被 `FileDebugSource` 打开的 `.vbdrec`（附录 C.6）。
 * 宿主测试无法 import TS 源码，这里只复刻容器字节：块头 type(1)+length(4)+crc32(4) + zlib 载荷。
 */
const RECORD_BLOCK_HEADER = 0;
const RECORD_BLOCK_DATA = 1;
const RECORD_BLOCK_FOOTER = 2;

function debugRecordingBlock(type, payload) {
  const compressed = zlib.deflateSync(payload);
  const head = Buffer.alloc(9);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(compressed.length, 1);
  head.writeUInt32BE(zlib.crc32(payload), 5);
  return Buffer.concat([head, compressed]);
}

async function writeDebugRecording(filePath, frames, options = {}) {
  const header = {
    recordVersion: 1,
    protocolVersion: 4,
    contractSchemaVersion: 2,
    contractHash: "",
    sessionId: "host-recording#session",
    endpointId: "host-recording",
    bootId: "host-recording-boot",
    connectType: "editor",
    startedAt: "2026-10-29T01:00:00.000Z",
    contracts: null,
  };
  const payloads = frames.map((frame) => Buffer.from(JSON.stringify(frame), "utf8"));
  const footer = {
    records: options.footerRecords ?? frames.length,
    wireBytes: options.footerWireBytes ?? payloads.reduce((sum, payload) => sum + 6 + payload.length, 0),
    droppedRecords: 0,
    droppedBytes: 0,
    endedAt: "2026-10-29T01:00:01.000Z",
    endedReason: options.endedReason ?? "disconnect",
  };
  const data = Buffer.concat(payloads.map((payload) => encodeFrame(1, KIND_JSON, payload)));
  await writeFile(filePath, Buffer.concat([
    debugRecordingBlock(RECORD_BLOCK_HEADER, Buffer.from(JSON.stringify(header), "utf8")),
    debugRecordingBlock(RECORD_BLOCK_DATA, data),
    debugRecordingBlock(RECORD_BLOCK_FOOTER, Buffer.from(JSON.stringify(footer), "utf8")),
  ]));
}

/** 读回一个 `.vbdrec`：数据块里的原样线上帧 + 文件尾（宿主测试不能 import TS 源码）。 */
async function readDebugRecording(filePath) {
  const bytes = await readFile(filePath);
  const frames = [];
  let footer;
  let offset = 0;
  while (offset + 9 <= bytes.length) {
    const type = bytes.readUInt8(offset);
    const length = bytes.readUInt32BE(offset + 1);
    const payload = zlib.inflateSync(bytes.subarray(offset + 9, offset + 9 + length));
    if (type === RECORD_BLOCK_DATA) {
      let position = 0;
      while (position + 6 <= payload.length) {
        const word = payload.readUInt32BE(position);
        const payloadLength = word & 0x1fffffff;
        frames.push({
          channel: word >>> 31,
          payload: payload.subarray(position + 6, position + 6 + payloadLength),
        });
        position += 6 + payloadLength;
      }
    } else if (type === RECORD_BLOCK_FOOTER) {
      footer = JSON.parse(payload.toString("utf8"));
    }

    offset += 9 + length;
  }

  return { frames, footer };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async function run() {
  const workspacePath = requiredEnvironmentPath("VISUALBRIDGE_TEST_WORKSPACE");
  const providerStatePath = requiredEnvironmentPath("VISUALBRIDGE_PROVIDER_TEST_STATE_DIR");
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

  await test("runs trusted Project Provider reference and validator requests out of process", async () => {
    assert.equal(vscode.workspace.isTrusted, true);

    await vscode.commands.executeCommand("visualbridge.documentBrowser.validateAll");
    const events = await waitForAsync(
      async () => readProviderEvents(providerStatePath),
      (items) => items.some((event) => event.method === "reference/resolve")
        && items.some((event) => event.method === "validator/diagnostics"),
      20_000,
      "Trusted Project Provider requests were not observed.",
    );
    assert.ok(events.some((event) => event.method === "initialize"));
    assert.ok(events.some((event) => event.method === "capabilities"));
  });

  await test("caches only successful Provider validation for the current source, dependency and host generation", async () => {
    const projectPath = path.join(workspacePath, "ProviderSemanticProject", "VisualBridge.project.vbjson");
    const markerUri = vscode.Uri.file(projectPath);
    const sourcePath = path.join(workspacePath, "ProviderSemanticProject", "Config", "ProviderSettings.providerconfig");
    const sourceBytes = await readFile(sourcePath);
    const content = JSON.parse(sourceBytes.toString("utf8"));
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const snapshot = {
      documentTypeId: "sample.provider.settings",
      path: "Config/ProviderSettings.providerconfig",
      sourceHash,
      content,
    };
    const validate = (currentSnapshot, dependencyKey) => vscode.commands.executeCommand(
      "visualbridge.test.validateProviderDocument",
      markerUri,
      currentSnapshot,
      dependencyKey,
    );
    const validatorRequestCount = async () => (await readProviderEvents(providerStatePath))
      .filter((event) => event.method === "validator/diagnostics").length;

    const beforeCache = await validatorRequestCount();
    await validate(snapshot, "provider-cache-dependency-a");
    await validate(snapshot, "provider-cache-dependency-a");
    assert.equal(await validatorRequestCount(), beforeCache + 1);

    const changedContent = {
      ...content,
      properties: { ...content.properties, displayName: "Provider cache source variant" },
    };
    const changedBytes = Buffer.from(`${JSON.stringify(changedContent, undefined, 2)}\n`, "utf8");
    const changedSnapshot = {
      ...snapshot,
      sourceHash: createHash("sha256").update(changedBytes).digest("hex"),
      content: changedContent,
    };
    await validate(changedSnapshot, "provider-cache-dependency-a");
    assert.equal(await validatorRequestCount(), beforeCache + 2);
    await validate(snapshot, "provider-cache-dependency-b");
    assert.equal(await validatorRequestCount(), beforeCache + 3);

    const projectBytes = await readFile(projectPath);
    try {
      const definition = JSON.parse(projectBytes.toString("utf8"));
      definition.providers[0].args.push("--echo-arg", "provider-cache-generation");
      await writeFile(projectPath, `${JSON.stringify(definition, undefined, 2)}\n`, "utf8");
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const beforeNewHost = await validatorRequestCount();
      await validate(snapshot, "provider-cache-dependency-b");
      assert.equal(await validatorRequestCount(), beforeNewHost + 1);
    } finally {
      await writeFile(projectPath, projectBytes);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  });

  await test("registers the stable host commands", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    EXPECTED_COMMANDS.forEach((command) => {
      assert.ok(commands.has(command), `Command '${command}' was not registered.`);
    });
    // 反向断言：manifest 新增公开命令而忘记同步 EXPECTED_COMMANDS 时必须失败，
    // 否则上面的正向断言会随数组老化而静默失去覆盖面。
    const unasserted = (extension.packageJSON.contributes.commands ?? [])
      .map((entry) => entry.command)
      .filter((command) => !EXPECTED_COMMANDS.includes(command));
    assert.deepEqual(unasserted, [], "Manifest contributes commands that EXPECTED_COMMANDS does not assert.");
  });

  await test("incrementally rebuilds one semantic document and matches a full scan", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "Config",
      "Game.gamesettings",
    ));
    const beforeBytes = await vscode.workspace.fs.readFile(uri);
    const before = JSON.parse(new TextDecoder().decode(beforeBytes));
    const stabilized = await vscode.commands.executeCommand("visualbridge.test.rebuildDocumentIndex");
    assert.equal(stabilized.result.status, "applied");
    const baseline = { documents: stabilized.documents, stats: stabilized.stats };
    let lastEpoch = baseline.stats.epoch;
    const unrelatedUri = vscode.Uri.file(path.join(workspacePath, "unrelated-index-event.txt"));
    const excludedUri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "Config",
      "Excluded",
      "Ignored.gamesettings",
    ));
    try {
      await vscode.workspace.fs.writeFile(unrelatedUri, new TextEncoder().encode("not an authoring source\n"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const unrelated = await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot");
      assert.equal(unrelated.stats.epoch, baseline.stats.epoch);

      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(excludedUri, ".."));
      await vscode.workspace.fs.writeFile(excludedUri, new TextEncoder().encode("{}\n"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const excluded = await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot");
      assert.equal(excluded.stats.epoch, baseline.stats.epoch);

      const changed = { ...before, properties: { ...before.properties, maxPlayers: before.properties.maxPlayers + 1 } };
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${JSON.stringify(changed, undefined, 2)}\n`));
      const incremental = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > baseline.stats.epoch && snapshot.stats.loaded === 1,
        20_000,
        "A single source change did not produce a one-unit incremental semantic refresh.",
      );
      lastEpoch = incremental.stats.epoch;
      assert.equal(incremental.stats.reused, incremental.stats.planned - 1);

      const rebuilt = await vscode.commands.executeCommand("visualbridge.test.rebuildDocumentIndex");
      assert.equal(rebuilt.result.status, "applied");
      assert.equal(rebuilt.stats.loaded, rebuilt.stats.planned);
      assert.equal(rebuilt.stats.reused, 0);
      assert.deepEqual(rebuilt.documents, incremental.documents);
      lastEpoch = rebuilt.stats.epoch;
    } finally {
      await vscode.workspace.fs.delete(unrelatedUri, { useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(excludedUri, { useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs.writeFile(uri, beforeBytes);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > lastEpoch && snapshot.stats.loaded === 1,
        20_000,
        "The restored source did not refresh incrementally.",
      );
    }
  });

  await test("invalidates only documents bound to a changed Catalog and matches a full scan", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "Catalog",
      "Game.vbstructuredcatalog",
    ));
    const beforeBytes = await vscode.workspace.fs.readFile(uri);
    const before = JSON.parse(new TextDecoder().decode(beforeBytes));
    const baseline = await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot");
    let lastEpoch = baseline.stats.epoch;
    try {
      const changed = {
        ...before,
        configTypes: before.configTypes.map((entry, index) => (
          index === 0 ? { ...entry, title: `${entry.title} Incremental` } : entry
        )),
      };
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${JSON.stringify(changed, undefined, 2)}\n`));
      const incremental = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > baseline.stats.epoch && snapshot.stats.loaded === 1,
        20_000,
        "A Catalog change did not invalidate exactly its bound semantic document.",
      );
      assert.equal(incremental.stats.reused, incremental.stats.planned - 1);
      assert.ok(incremental.documents.some((document) => document.title.endsWith(" Incremental")));

      const rebuilt = await vscode.commands.executeCommand("visualbridge.test.rebuildDocumentIndex");
      assert.equal(rebuilt.result.status, "applied");
      assert.deepEqual(rebuilt.documents, incremental.documents);
      lastEpoch = rebuilt.stats.epoch;
    } finally {
      await vscode.workspace.fs.writeFile(uri, beforeBytes);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > lastEpoch && snapshot.stats.loaded === 1,
        20_000,
        "The restored Catalog did not invalidate exactly its bound semantic document.",
      );
    }
  });

  await test("invalidates one logical CSV family when a physical partition changes", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "Tables",
      "Skills_Extra.skillstable",
    ));
    const baseline = await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot");
    let lastEpoch = baseline.stats.epoch;
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode([
        "技能ID\t技能名",
        "Id\tName",
        "103\tLightning",
        "",
      ].join("\n")));
      const incremental = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > baseline.stats.epoch
          && snapshot.stats.loaded === 1
          && snapshot.documents.some((document) => (
            document.documentTypeId === "sample.table.skills"
            && document.sourcePaths.includes("Tables/Skills_Extra.skillstable")
          )),
        20_000,
        "A CSV partition change did not invalidate exactly one logical family.",
      );
      assert.equal(incremental.stats.reused, incremental.stats.planned - 1);
      const table = incremental.documents.find((document) => (
        document.projectId === "visualbridge.structured-semantics"
        && document.documentTypeId === "sample.table.skills"
      ));
      assert.ok(table);
      assert.deepEqual(table.sourcePaths, [
        "Tables/Skills_Extra.skillstable",
        "Tables/Skills_Main.skillstable",
      ]);

      const rebuilt = await vscode.commands.executeCommand("visualbridge.test.rebuildDocumentIndex");
      assert.equal(rebuilt.result.status, "applied");
      assert.deepEqual(rebuilt.documents, incremental.documents);
      lastEpoch = rebuilt.stats.epoch;
    } finally {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > lastEpoch
          && snapshot.stats.loaded === 1
          && !snapshot.documents.some((document) => document.sourcePaths.includes("Tables/Skills_Extra.skillstable")),
        20_000,
        "Deleting the CSV partition did not invalidate exactly one logical family.",
      );
    }
  });

  await test("keeps the last complete index when a refresh is cancelled before commit", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "Config",
      "Game.gamesettings",
    ));
    const document = await vscode.workspace.openTextDocument(uri);
    const originalText = document.getText();
    const original = JSON.parse(originalText);
    const baseline = await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot");
    const changed = {
      ...original,
      properties: { ...original.properties, maxPlayers: 999 },
    };
    const replaceDocument = async (text) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    try {
      await replaceDocument(`${JSON.stringify(changed, undefined, 2)}\n`);
      const cancelled = await vscode.commands.executeCommand(
        "visualbridge.test.cancelDocumentIndexRefreshAtPhase",
        "provider",
      );
      assert.equal(cancelled.observed, true);
      assert.equal(cancelled.result.status, "cancelled");
      assert.deepEqual(cancelled.documents, baseline.documents);
      assert.deepEqual(cancelled.stats, baseline.stats);

      const changedResult = await vscode.commands.executeCommand("visualbridge.test.rebuildDocumentIndex");
      assert.equal(changedResult.result.status, "applied");
      assert.notDeepEqual(changedResult.documents, baseline.documents);
    } finally {
      await replaceDocument(originalText);
      await document.save();
      const restored = await vscode.commands.executeCommand("visualbridge.test.rebuildDocumentIndex");
      assert.equal(restored.result.status, "applied");
      assert.deepEqual(restored.documents, baseline.documents);
    }
  });

  await test("moves and safely deletes a Structured document through lifecycle transactions", async () => {
    const projectId = "visualbridge.structured-semantics";
    const sourcePath = "Config/Game.gamesettings";
    const movedPath = "Config/Moved.gamesettings";
    const sourceUri = vscode.Uri.file(path.join(workspacePath, "StructuredSemanticProject", ...sourcePath.split("/")));
    const movedUri = vscode.Uri.file(path.join(workspacePath, "StructuredSemanticProject", ...movedPath.split("/")));
    const before = await vscode.workspace.fs.readFile(sourceUri);
    try {
      const moved = await vscode.commands.executeCommand("visualbridge.test.lifecycleMove", {
        projectId,
        sourcePath,
        targetPath: movedPath,
      });
      assert.equal(moved.mutationCount, 1);
      await assertMissing(sourceUri);
      assert.deepEqual(await vscode.workspace.fs.readFile(movedUri), before);
      const deleted = await vscode.commands.executeCommand("visualbridge.test.lifecycleDelete", {
        projectId,
        sourcePath: movedPath,
      });
      assert.equal(deleted.mutationCount, 1);
      await assertMissing(movedUri);
    } finally {
      await vscode.workspace.fs.writeFile(sourceUri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("blocks lifecycle preview while a Project Catalog is dirty", async () => {
    const projectRoot = path.join(workspacePath, "StructuredSemanticProject");
    const sourceUri = vscode.Uri.file(path.join(projectRoot, "Config", "Game.gamesettings"));
    const targetUri = vscode.Uri.file(path.join(projectRoot, "Config", "DirtyCatalogBlocked.gamesettings"));
    const catalogUri = vscode.Uri.file(path.join(projectRoot, "Catalog", "Game.vbstructuredcatalog"));
    const catalog = await vscode.workspace.openTextDocument(catalogUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(catalogUri, new vscode.Position(0, 0), " ");
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(catalog.isDirty, true);
    try {
      await assert.rejects(vscode.commands.executeCommand("visualbridge.test.lifecycleMove", {
        projectId: "visualbridge.structured-semantics",
        sourcePath: "Config/Game.gamesettings",
        targetPath: "Config/DirtyCatalogBlocked.gamesettings",
      }), /Save or revert every dirty VisualBridge editor/u);
      await vscode.workspace.fs.stat(sourceUri);
      await assertMissing(targetUri);
    } finally {
      await revertTextDocument(catalogUri);
    }
  });

  await test("rechecks Project cleanliness immediately before lifecycle mutation", async () => {
    const projectRoot = path.join(workspacePath, "StructuredSemanticProject");
    const sourceUri = vscode.Uri.file(path.join(projectRoot, "Config", "Game.gamesettings"));
    const targetUri = vscode.Uri.file(path.join(projectRoot, "Config", "DirtyBeforeMutate.gamesettings"));
    const markerUri = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson"));
    try {
      await assert.rejects(vscode.commands.executeCommand("visualbridge.test.lifecycleMove", {
        projectId: "visualbridge.structured-semantics",
        sourcePath: "Config/Game.gamesettings",
        targetPath: "Config/DirtyBeforeMutate.gamesettings",
        dirtyBeforeMutatePath: "VisualBridge.project.vbjson",
      }), /Save or revert every dirty VisualBridge editor/u);
      await vscode.workspace.fs.stat(sourceUri);
      await assertMissing(targetUri);
    } finally {
      await revertTextDocument(markerUri);
    }
  });

  await test("reports a stale index as committed success without retrying the lifecycle write", async () => {
    const projectRoot = path.join(workspacePath, "StructuredSemanticProject");
    const sourcePath = "Config/Game.gamesettings";
    const targetPath = "Config/StaleIndex.gamesettings";
    const sourceUri = vscode.Uri.file(path.join(projectRoot, ...sourcePath.split("/")));
    const targetUri = vscode.Uri.file(path.join(projectRoot, ...targetPath.split("/")));
    const before = await vscode.workspace.fs.readFile(sourceUri);
    try {
      const result = await vscode.commands.executeCommand("visualbridge.test.lifecycleMove", {
        projectId: "visualbridge.structured-semantics",
        sourcePath,
        targetPath,
        failCommittedRefresh: true,
      });
      assert.equal(result.mutationCount, 1);
      assert.equal(result.indexStale, true);
      await assertMissing(sourceUri);
      assert.equal(Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(targetUri)), Buffer.from(before)), 0);
    } finally {
      await vscode.workspace.fs.delete(targetUri, { useTrash: false }).catch(() => undefined);
      await vscode.workspace.fs.writeFile(sourceUri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("creates, copies, and deletes a Structured document through lifecycle transactions", async () => {
    const projectId = "visualbridge.structured-semantics";
    const createdPath = "Config/Created.gamesettings";
    const copiedPath = "Config/Copied.gamesettings";
    const createdUri = vscode.Uri.file(path.join(workspacePath, "StructuredSemanticProject", ...createdPath.split("/")));
    const copiedUri = vscode.Uri.file(path.join(workspacePath, "StructuredSemanticProject", ...copiedPath.split("/")));
    try {
      const created = await vscode.commands.executeCommand("visualbridge.test.lifecycleCreate", {
        projectId,
        documentTypeId: "sample.game.settings",
        targetPath: createdPath,
        parameters: { documentId: "test.created.settings" },
      });
      assert.equal(created.mutationCount, 1);
      assert.deepEqual(created.baseHashes, {});
      assert.deepEqual(created.dependencies.map((dependency) => dependency.kind), [
        "catalog",
        "documentSet",
        "project",
        "referenceIndex",
      ]);
      assert.ok(created.ownedIdentities.every((identity) => (
        identity.reference === undefined || Object.hasOwn(identity.reference, "location") === false
      )));
      assert.equal(JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(createdUri))).documentId, "test.created.settings");
      const copied = await vscode.commands.executeCommand("visualbridge.test.lifecycleCopy", {
        projectId,
        sourcePath: createdPath,
        targetPath: copiedPath,
        stableIdRemap: [{ identityKey: "document", from: "test.created.settings", to: "test.copied.settings" }],
      });
      assert.equal(copied.mutationCount, 1);
      assert.deepEqual(Object.keys(copied.baseHashes), [createdPath]);
      assert.ok(copied.referenceImpacts.every((impact) => impact.kind !== "targetLocationChanged"));
      assert.equal(JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(copiedUri))).documentId, "test.copied.settings");
      await vscode.commands.executeCommand("visualbridge.test.lifecycleDelete", { projectId, sourcePath: copiedPath });
      await vscode.commands.executeCommand("visualbridge.test.lifecycleDelete", { projectId, sourcePath: createdPath });
      await assertMissing(copiedUri);
      await assertMissing(createdUri);
    } finally {
      await vscode.workspace.fs.delete(copiedUri, { useTrash: false }).catch(() => undefined);
      await vscode.workspace.fs.delete(createdUri, { useTrash: false }).catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("classifies Entity copy references by indexed resolution", async () => {
    const projectId = "visualbridge.entity-semantics";
    const sourcePath = "Config/Entities/Player.herojson";
    const copiedPath = "Config/Entities/PlayerCopy.herojson";
    const copiedUri = vscode.Uri.file(path.join(workspacePath, "EntitySemanticProject", ...copiedPath.split("/")));
    try {
      const copied = await vscode.commands.executeCommand("visualbridge.test.lifecycleCopy", {
        projectId,
        sourcePath,
        targetPath: copiedPath,
        stableIdRemap: [
          { identityKey: "document", from: "sample.player", to: "sample.player.copy" },
          { identityKey: "component:health", from: "health", to: "health-copy" },
          { identityKey: "component:move", from: "move", to: "move-copy" },
        ],
      });
      assert.equal(copied.mutationCount, 1);
      const document = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(copiedUri)));
      assert.equal(document.properties.primaryComponentId, "health-copy");
      assert.equal(document.properties.primarySkillId, 101);
      assert.ok(copied.referenceImpacts.some((impact) => impact.kind === "internalRetarget"
        && impact.occurrence.path === "properties.primaryComponentId"
        && impact.replacement === "health-copy"));
      assert.ok(copied.referenceImpacts.some((impact) => impact.kind === "outboundPreserved"
        && impact.occurrence.path === "properties.primarySkillId"
        && impact.target?.rowId === "Skills_Main:key-101"));
      assert.ok(copied.referenceImpacts.every((impact) => impact.kind !== "targetLocationChanged"));
    } finally {
      await vscode.workspace.fs.delete(copiedUri, { useTrash: false }).catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("preserves an allowMissing outbound reference during Entity copy", async () => {
    const projectRoot = path.join(workspacePath, "EntitySemanticProject");
    const sourcePath = "Config/Entities/Player.herojson";
    const copiedPath = "Config/Entities/PlayerMissingCopy.herojson";
    const sourceUri = vscode.Uri.file(path.join(projectRoot, ...sourcePath.split("/")));
    const catalogUri = vscode.Uri.file(path.join(projectRoot, "Catalog", "Common.vbentitycatalog"));
    const copiedUri = vscode.Uri.file(path.join(projectRoot, ...copiedPath.split("/")));
    const sourceBefore = await vscode.workspace.fs.readFile(sourceUri);
    const catalogBefore = await vscode.workspace.fs.readFile(catalogUri);
    try {
      const source = JSON.parse(new TextDecoder().decode(sourceBefore));
      source.properties.primarySkillId = 999999;
      const catalog = JSON.parse(new TextDecoder().decode(catalogBefore));
      const entityType = catalog.entityTypes.find((candidate) => candidate.id === "sample.entity.player");
      const property = entityType.properties.find((candidate) => candidate.id === "primarySkillId");
      property.reference.allowMissing = true;
      await vscode.workspace.fs.writeFile(sourceUri, new TextEncoder().encode(`${JSON.stringify(source, null, 2)}\n`));
      await vscode.workspace.fs.writeFile(catalogUri, new TextEncoder().encode(`${JSON.stringify(catalog, null, 2)}\n`));
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");

      const copied = await vscode.commands.executeCommand("visualbridge.test.lifecycleCopy", {
        projectId: "visualbridge.entity-semantics",
        sourcePath,
        targetPath: copiedPath,
        stableIdRemap: [
          { identityKey: "document", from: "sample.player", to: "sample.player.missing-copy" },
          { identityKey: "component:health", from: "health", to: "health-missing-copy" },
          { identityKey: "component:move", from: "move", to: "move-missing-copy" },
        ],
      });
      const document = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(copiedUri)));
      assert.equal(document.properties.primarySkillId, 999999);
      assert.ok(copied.referenceImpacts.some((impact) => impact.kind === "outboundPreserved"
        && impact.occurrence.path === "properties.primarySkillId"
        && impact.target === undefined));
    } finally {
      await vscode.workspace.fs.delete(copiedUri, { useTrash: false }).catch(() => undefined);
      await vscode.workspace.fs.writeFile(sourceUri, sourceBefore);
      await vscode.workspace.fs.writeFile(catalogUri, catalogBefore);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("copies CSV families with keepFirst and keepLast physical-only rows", async () => {
    const projectRoot = path.join(workspacePath, "TableSemanticProject");
    const markerUri = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson"));
    const catalogUri = vscode.Uri.file(path.join(projectRoot, "Catalog", "Gameplay.vbtablecatalog"));
    const secondSourceUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_B.csv"));
    const markerBefore = await vscode.workspace.fs.readFile(markerUri);
    const catalogBefore = await vscode.workspace.fs.readFile(catalogUri);
    const secondSourceBefore = await vscode.workspace.fs.readFile(secondSourceUri);
    try {
      const marker = JSON.parse(new TextDecoder().decode(markerBefore));
      marker.documentTypes[0].include = ["Tables/**/*.csv"];
      await vscode.workspace.fs.writeFile(markerUri, new TextEncoder().encode(`${JSON.stringify(marker, null, 2)}\n`));
      const secondSource = new TextDecoder().decode(secondSourceBefore).replace("Fireball Override\t101\t", "Fireball Override\t201\t");
      await vscode.workspace.fs.writeFile(secondSourceUri, new TextEncoder().encode(secondSource));
      for (const duplicatePolicy of ["keepFirst", "keepLast"]) {
        const catalog = JSON.parse(new TextDecoder().decode(catalogBefore));
        catalog.tableTypes[0].sheets[0].partition.deduplicateByColumnId = "name";
        catalog.tableTypes[0].sheets[0].partition.duplicatePolicy = duplicatePolicy;
        await vscode.workspace.fs.writeFile(catalogUri, new TextEncoder().encode(`${JSON.stringify(catalog, null, 2)}\n`));
        await vscode.commands.executeCommand("visualbridge.refreshProjects");
        await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");

        const directoryName = duplicatePolicy === "keepFirst" ? "CopyKeepFirst" : "CopyKeepLast";
        const targetPath = `Tables/${directoryName}/Skills_A.csv`;
        const targetDirectoryUri = vscode.Uri.file(path.join(projectRoot, "Tables", directoryName));
        await vscode.workspace.fs.createDirectory(targetDirectoryUri);
        const stableIdRemap = [
          { identityKey: 'table.row:["skills","number",101]', from: 101, to: 1101 },
          { identityKey: 'table.row:["skills","number",102]', from: 102, to: 1102 },
          { identityKey: 'table.row:["skills","number",201]', from: 201, to: 1201 },
          { identityKey: 'table.row:["skills","number",202]', from: 202, to: 1202 },
          { identityKey: 'table.dedup:["skills","string","Blink"]', from: "Blink", to: `Blink ${duplicatePolicy}` },
          { identityKey: 'table.dedup:["skills","string","Fireball"]', from: "Fireball", to: `Fireball ${duplicatePolicy}` },
          { identityKey: 'table.dedup:["skills","string","Fireball Override"]', from: "Fireball Override", to: `Fireball Override ${duplicatePolicy}` },
        ];
        const dedupCollision = await vscode.commands.executeCommand("visualbridge.test.lifecycleCopy", {
          projectId: "visualbridge.table-semantics",
          sourcePath: "Tables/Skills_A.csv",
          targetPath,
          stableIdRemap: stableIdRemap.map((entry) => (
            entry.identityKey === 'table.dedup:["skills","string","Fireball"]'
              ? { ...entry, to: "Blink" }
              : entry
          )),
          previewOnly: true,
        });
        assert.ok(dedupCollision.blockers.some((blocker) => (
          blocker.code === "identity.targetCollision"
          && blocker.identityKey === 'table.dedup:["skills","string","Fireball"]'
        )), JSON.stringify(dedupCollision.blockers));
        const copied = await vscode.commands.executeCommand("visualbridge.test.lifecycleCopy", {
          projectId: "visualbridge.table-semantics",
          sourcePath: "Tables/Skills_A.csv",
          targetPath,
          stableIdRemap,
        });
        assert.equal(copied.mutationCount, 2);
        const physicalOnlyPath = duplicatePolicy === "keepFirst" ? "Skills_B.csv" : "Skills_A.csv";
        const physicalOnlyText = new TextDecoder().decode(await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(targetDirectoryUri, physicalOnlyPath),
        ));
        assert.ok(physicalOnlyText.includes(duplicatePolicy === "keepFirst" ? "\t1202\t" : "\t1102\t"));
        await vscode.workspace.fs.delete(targetDirectoryUri, { recursive: true, useTrash: false });
        await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
      }
    } finally {
      await vscode.workspace.fs.writeFile(markerUri, markerBefore);
      await vscode.workspace.fs.writeFile(catalogUri, catalogBefore);
      await vscode.workspace.fs.writeFile(secondSourceUri, secondSourceBefore);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("safely deletes an Entity component through the shared lifecycle adapter", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Config",
      "Entities",
      "Player.herojson",
    ));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      const result = await vscode.commands.executeCommand("visualbridge.test.lifecycleDeleteElement", {
        projectId: "visualbridge.entity-semantics",
        documentTypeId: "hero-config",
        path: "Config/Entities/Player.herojson",
        target: { kind: "entity.component", componentId: "move" },
      });
      assert.equal(result.mutationCount, 1);
      assert.deepEqual(result.ownedIdentityKeys, ["component:move"]);
      const document = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      assert.equal(document.components.some((component) => component.id === "move"), false);
    } finally {
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("renames an Entity component through the reference facet and rewrites its occurrences", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Config",
      "Entities",
      "Player.herojson",
    ));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      const result = await vscode.commands.executeCommand("visualbridge.test.renameReferenceTarget", {
        projectId: "visualbridge.entity-semantics",
        definition: {
          kind: "entity.component",
          target: { documentTypeId: "hero-config" },
          allowMissing: false,
        },
        location: {
          projectId: "visualbridge.entity-semantics",
          documentTypeId: "hero-config",
          path: "Config/Entities/Player.herojson",
          documentId: "sample.player",
          componentId: "health",
          elementKind: "component",
          elementId: "health",
        },
        oldValue: "health",
        newValue: "health_primary",
        confirm: false,
      });
      assert.equal(result.success, true, result.success ? "" : result.message);
      const document = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      assert.deepEqual(document.components.map((component) => component.id), ["health_primary", "move"]);
      // `properties.primaryComponentId` 是同文档内的引用 occurrence，必须一起改写。
      assert.equal(document.properties.primaryComponentId, "health_primary");
    } finally {
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("renames a Graph element through the reference facet and rewrites subgraph references", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Graph", "SemanticSample.vbgraph"));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      const result = await vscode.commands.executeCommand("visualbridge.test.renameReferenceTarget", {
        projectId: "GraphSemanticProject",
        definition: {
          kind: "graph.element",
          target: { documentTypeId: "logicGraph", elementKind: "graph" },
          allowMissing: false,
        },
        location: {
          projectId: "GraphSemanticProject",
          documentTypeId: "logicGraph",
          path: "Graph/SemanticSample.vbgraph",
          documentId: "semantic-sample",
          elementKind: "graph",
          elementId: "child",
          graphId: "child",
        },
        oldValue: "child",
        newValue: "child_renamed",
        confirm: false,
      });
      assert.equal(result.success, true, result.success ? "" : result.message);
      const document = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      assert.equal(document.graphs.some((graph) => graph.id === "child_renamed"), true);
      const root = document.graphs.find((graph) => graph.id === "root");
      // 引用该子图的 Subgraph 节点必须同步改写。
      assert.equal(root.nodes.find((node) => node.id === "subgraph_call").subgraphId, "child_renamed");
    } finally {
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("renames a Structured document ID through the built-in document facet", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "Config",
      "Game.gamesettings",
    ));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      const result = await vscode.commands.executeCommand("visualbridge.test.renameReferenceTarget", {
        projectId: "visualbridge.structured-semantics",
        definition: {
          kind: "document",
          target: { documentTypeId: "sample.game.settings" },
          allowMissing: false,
        },
        location: {
          projectId: "visualbridge.structured-semantics",
          documentTypeId: "sample.game.settings",
          path: "Config/Game.gamesettings",
          documentId: "sample.game.settings.default",
        },
        oldValue: "sample.game.settings.default",
        newValue: "sample.game.settings.renamed",
        confirm: false,
      });
      assert.equal(result.success, true, result.success ? "" : result.message);
      const document = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      assert.equal(document.documentId, "sample.game.settings.renamed");
    } finally {
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("reports unknown reference kinds as a generic preflight error instead of crashing", async () => {
    const result = await vscode.commands.executeCommand("visualbridge.test.renameReferenceTarget", {
      projectId: "GraphSemanticProject",
      definition: {
        kind: "custom.provider",
        target: { documentTypeId: "logicGraph" },
        allowMissing: false,
      },
      location: {
        projectId: "GraphSemanticProject",
        documentTypeId: "logicGraph",
        path: "Graph/SemanticSample.vbgraph",
        documentId: "semantic-sample",
        elementKind: "graph",
        elementId: "child",
        graphId: "child",
      },
      oldValue: "child",
      newValue: "child_renamed",
      confirm: false,
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "refactor.targetUnavailable");
    assert.match(result.message, /custom\.provider/u);
  });

  await test("reports unknown lifecycle delete kinds as a readable blocker", async () => {
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.lifecycleDeleteElement", {
        projectId: "GraphSemanticProject",
        documentTypeId: "logicGraph",
        path: "Graph/SemanticSample.vbgraph",
        target: { kind: "custom.provider", elementId: "child" },
      }),
      (error) => /custom\.provider/u.test(String(error?.message ?? error)) && !/TypeError/u.test(String(error)),
    );
  });

  await test("safely deletes a Graph node and its connected edge through lifecycle", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Graph", "SemanticSample.vbgraph"));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      const result = await vscode.commands.executeCommand("visualbridge.test.lifecycleDeleteElement", {
        projectId: "GraphSemanticProject",
        documentTypeId: "logicGraph",
        path: "Graph/SemanticSample.vbgraph",
        target: { kind: "graph.element", graphId: "root", elementKind: "node", elementId: "step_b" },
      });
      assert.equal(result.mutationCount, 1);
      assert.deepEqual(result.ownedIdentityKeys, ["edge:root:flow_step_a_step_b", "node:root:step_b"]);
      const document = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      const root = document.graphs.find((graph) => graph.id === "root");
      assert.equal(root.nodes.some((node) => node.id === "step_b"), false);
      assert.equal(root.edges.some((edge) => edge.id === "flow_step_a_step_b"), false);
    } finally {
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("blocks Graph Copy when a non-Reference Edge remap collides Project-wide", async () => {
    const request = {
      projectId: "GraphSemanticProject",
      sourcePath: "Graph/SemanticSample.vbgraph",
      targetPath: "Graph/EdgeCollisionCopy.vbgraph",
      stableIdRemap: [],
      previewOnly: true,
    };
    const seed = await vscode.commands.executeCommand("visualbridge.test.lifecycleCopy", request);
    const edges = seed.ownedIdentities.filter((identity) => identity.kind === "edge");
    assert.ok(edges.length >= 2);
    const colliding = edges[0];
    const existing = edges[1];
    const preview = await vscode.commands.executeCommand("visualbridge.test.lifecycleCopy", {
      ...request,
      stableIdRemap: seed.ownedIdentities.map((identity, index) => ({
        identityKey: identity.identityKey,
        from: identity.value,
        to: identity.identityKey === colliding.identityKey ? existing.value : `copy${index}`,
      })),
    });
    assert.ok(preview.blockers.some((blocker) => (
      blocker.code === "identity.targetCollision" && blocker.identityKey === colliding.identityKey
    )), JSON.stringify(preview.blockers));
  });

  await test("blocks aliased Table inbound and remaining internal references during Safe Delete", async () => {
    const projectRoot = path.join(workspacePath, "EntitySemanticProject");
    const entityUri = vscode.Uri.file(path.join(projectRoot, "Config", "Entities", "Player.herojson"));
    const entityCatalogUri = vscode.Uri.file(path.join(projectRoot, "Catalog", "Common.vbentitycatalog"));
    const tableCatalogUri = vscode.Uri.file(path.join(projectRoot, "Catalog", "Skills.vbtablecatalog"));
    const tableUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_Main.skillstable"));
    const entityBefore = await vscode.workspace.fs.readFile(entityUri);
    const entityCatalogBefore = await vscode.workspace.fs.readFile(entityCatalogUri);
    const tableCatalogBefore = await vscode.workspace.fs.readFile(tableCatalogUri);
    const tableBefore = await vscode.workspace.fs.readFile(tableUri);
    try {
      const entityCatalog = JSON.parse(new TextDecoder().decode(entityCatalogBefore));
      const primarySkill = entityCatalog.entityTypes[0].properties.find((property) => property.id === "primarySkillId");
      primarySkill.reference.target.tableTypeId = "legacy.table.skills";
      primarySkill.reference.target.sheetId = "legacy.skills";

      const tableCatalog = JSON.parse(new TextDecoder().decode(tableCatalogBefore));
      const tableType = tableCatalog.tableTypes[0];
      const sheet = tableType.sheets[0];
      tableType.aliases = ["legacy.table.skills"];
      sheet.aliases = ["legacy.skills"];
      sheet.nameAliases = ["Skills_Main"];
      sheet.partition.namePattern = "SkillPartitions_{part}";
      await vscode.workspace.fs.writeFile(
        entityCatalogUri,
        new TextEncoder().encode(`${JSON.stringify(entityCatalog, null, 2)}\n`),
      );
      await vscode.workspace.fs.writeFile(
        tableCatalogUri,
        new TextEncoder().encode(`${JSON.stringify(tableCatalog, null, 2)}\n`),
      );
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");

      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.lifecycleDeleteElement", {
          projectId: "visualbridge.entity-semantics",
          documentTypeId: "sample.table.skills",
          path: "Tables/Skills_Main.skillstable",
          target: { kind: "table.row", sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-101" },
        }),
        /reference\.inbound/u,
      );
      assert.deepEqual(await vscode.workspace.fs.readFile(tableUri), tableBefore);

      const entity = JSON.parse(new TextDecoder().decode(entityBefore));
      entity.properties.primarySkillId = 102;
      sheet.columns.push({
        id: "parentId",
        title: "Parent Skill",
        aliases: [],
        nameKey: "ParentId",
        nameKeyAliases: [],
        valueType: "number",
        dataTypeId: "int",
        defaultValue: 101,
        editor: {
          kind: "reference",
          readOnly: false,
          integer: true,
        },
        reference: {
          kind: "table.row",
          target: {
            documentTypeId: "sample.table.skills",
            tableTypeId: "legacy.table.skills",
            sheetId: "legacy.skills",
          },
        },
        cellEncoding: { kind: "scalar" },
      });
      const tableWithInternalReference = new TextEncoder().encode(
        "Skill name\tSkill ID\tParent Skill\nName\tId\tParentId\nFireball\t101\t102\nBlink\t102\t101\n",
      );
      await vscode.workspace.fs.writeFile(entityUri, new TextEncoder().encode(`${JSON.stringify(entity, null, 2)}\n`));
      await vscode.workspace.fs.writeFile(
        tableCatalogUri,
        new TextEncoder().encode(`${JSON.stringify(tableCatalog, null, 2)}\n`),
      );
      await vscode.workspace.fs.writeFile(tableUri, tableWithInternalReference);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");

      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.lifecycleDeleteElement", {
          projectId: "visualbridge.entity-semantics",
          documentTypeId: "sample.table.skills",
          path: "Tables/Skills_Main.skillstable",
          target: { kind: "table.row", sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-101" },
        }),
        /reference\.unresolvedInternal/u,
      );
      assert.equal(
        Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(tableUri)), Buffer.from(tableWithInternalReference)),
        0,
      );
    } finally {
      await vscode.workspace.fs.writeFile(entityUri, entityBefore);
      await vscode.workspace.fs.writeFile(entityCatalogUri, entityCatalogBefore);
      await vscode.workspace.fs.writeFile(tableCatalogUri, tableCatalogBefore);
      await vscode.workspace.fs.writeFile(tableUri, tableBefore);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("safely deletes a Table row through lifecycle", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "EntitySemanticProject", "Tables", "Skills_Main.skillstable"));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      const result = await vscode.commands.executeCommand("visualbridge.test.lifecycleDeleteElement", {
        projectId: "visualbridge.entity-semantics",
        documentTypeId: "sample.table.skills",
        path: "Tables/Skills_Main.skillstable",
        target: { kind: "table.row", sheetId: "skills:Skills_Main", rowId: "Skills_Main:key-102" },
      });
      assert.equal(result.mutationCount, 1);
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      assert.equal(text.includes("Blink\t102"), false);
      assert.equal(text.includes("Fireball\t101"), true);
    } finally {
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("renames an existing Table key through atomic Reference Refactor while preserving new-row editing", async () => {
    const projectRoot = path.join(workspacePath, "EntitySemanticProject");
    const tableUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_Main.skillstable"));
    const extraUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_Extra.skillstable"));
    const entityUri = vscode.Uri.file(path.join(projectRoot, "Config", "Entities", "Player.herojson"));
    const tableBefore = await vscode.workspace.fs.readFile(tableUri);
    const entityBefore = await vscode.workspace.fs.readFile(entityUri);
    const extraBytes = new TextEncoder().encode(
      "Skill name\tSkill ID\nName\tId\nShield\t201\n",
    );
    try {
      await vscode.workspace.fs.writeFile(extraUri, extraBytes);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
      await vscode.commands.executeCommand("vscode.openWith", tableUri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", tableUri),
        (value) => value?.activeReadyPanelCount === 1,
        20_000,
        "Table editor did not become ready for the key-refactor test.",
      );
      const indexBeforeRefactor = await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot");

      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", tableUri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_Main",
        rowId: "Skills_Main:key-101",
        columnId: "id",
        value: 1001,
      }]);
      const tableAfter = new TextDecoder().decode(await vscode.workspace.fs.readFile(tableUri));
      const entityAfter = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(entityUri)));
      assert.ok(tableAfter.includes("Fireball\t1001"));
      assert.equal(tableAfter.includes("Fireball\t101"), false);
      assert.equal(entityAfter.properties.primarySkillId, 1001);
      assert.equal(
        Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(extraUri)), Buffer.from(extraBytes)),
        0,
      );
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > indexBeforeRefactor.stats.epoch,
        20_000,
        "Reference Refactor did not refresh the Workspace Document Index.",
      );
      const refreshedEditor = await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", tableUri);
      assert.equal(refreshedEditor.activeReadyPanelCount, 1, "Reference Refactor did not retain a refreshed Table editor.");

      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", tableUri, [{
        type: "table.duplicateRow",
        sheetId: "skills:Skills_Main",
        rowId: "Skills_Main:key-1001",
        newRowId: "new-row",
      }, {
        type: "table.setCell",
        sheetId: "skills:Skills_Main",
        rowId: "new-row",
        columnId: "id",
        value: 1002,
      }]);
      assert.equal(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(tableUri)).includes("\t1002"),
        false,
      );
      await vscode.commands.executeCommand("workbench.action.files.revert");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
      await vscode.workspace.fs.writeFile(tableUri, tableBefore);
      await vscode.workspace.fs.writeFile(entityUri, entityBefore);
      await vscode.workspace.fs.delete(extraUri, { useTrash: false }).catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("reports committed Reference Refactors when Table or Document Index refresh fails", async () => {
    const projectRoot = path.join(workspacePath, "EntitySemanticProject");
    const tableUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_Main.skillstable"));
    const entityUri = vscode.Uri.file(path.join(projectRoot, "Config", "Entities", "Player.herojson"));
    const tableBefore = await vscode.workspace.fs.readFile(tableUri);
    const entityBefore = await vscode.workspace.fs.readFile(entityUri);
    const failures = [
      { phase: "tableEditor", message: "injected committed Table refresh failure", newValue: 1001 },
      { phase: "documentIndex", message: "injected committed Document Index failure result", newValue: 1002 },
    ];

    for (const failure of failures) {
      try {
        await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
        await vscode.commands.executeCommand(
          "visualbridge.test.failReferenceRefactorCommittedRefresh",
          failure.phase,
          failure.message,
        );
        const result = await vscode.commands.executeCommand(
          "visualbridge.test.renameReferenceTarget",
          tableKeyRenameRequest(failure.newValue),
        );
        assert.equal(result.success, true, "A committed refactor must not report that it was not applied.");
        assert.equal(result.maintenance?.code, "refactor.committedRefreshFailed");
        assert.deepEqual(result.maintenance?.failures, [{ phase: failure.phase, message: failure.message }]);
        assert.match(result.maintenance?.message ?? "", /Refactor committed/u);
        assert.match(result.maintenance?.message ?? "", /Do not retry/u);

        const tableAfter = new TextDecoder().decode(await vscode.workspace.fs.readFile(tableUri));
        const entityAfter = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(entityUri)));
        assert.ok(tableAfter.includes(`Fireball\t${failure.newValue}`));
        assert.equal(entityAfter.properties.primarySkillId, failure.newValue);
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
        await vscode.workspace.fs.writeFile(tableUri, tableBefore);
        await vscode.workspace.fs.writeFile(entityUri, entityBefore);
        await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
      }
    }
  });

  await test("applies Graph, Entity, and Structured Webview operations with Undo, Redo, save, and disk persistence", async () => {
    const cases = [
      {
        editor: "graph",
        uri: vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Graph", "SemanticSample.vbgraph")),
        operations: [{
          type: "graph.updateGraph",
          graphId: "root",
          title: "Host Operation Graph",
          properties: { priority: 1 },
        }],
        readValue: (value) => value.graphs.find((graph) => graph.id === "root")?.title,
        beforeValue: "Semantic Sample",
        afterValue: "Host Operation Graph",
        followUpOperations: [{
          type: "graph.updateGraph",
          graphId: "root",
          title: "Host Operation Graph Again",
          properties: { priority: 2 },
        }],
        followUpValue: "Host Operation Graph Again",
      },
      {
        editor: "entity",
        uri: vscode.Uri.file(path.join(workspacePath, "EntitySemanticProject", "Config", "Entities", "Player.herojson")),
        operations: [{ type: "entity.setTitle", title: "Host Operation Entity" }],
        readValue: (value) => value.title,
        beforeValue: "Sample Player",
        afterValue: "Host Operation Entity",
        followUpOperations: [{ type: "entity.setTitle", title: "Host Operation Entity Again" }],
        followUpValue: "Host Operation Entity Again",
      },
      {
        editor: "structured",
        uri: vscode.Uri.file(path.join(workspacePath, "StructuredSemanticProject", "Config", "Game.gamesettings")),
        operations: [{ type: "structured.setField", fieldId: "maxPlayers", value: 8 }],
        readValue: (value) => value.properties.maxPlayers,
        beforeValue: 5,
        afterValue: 8,
        followUpOperations: [{ type: "structured.setField", fieldId: "maxPlayers", value: 9 }],
        followUpValue: 9,
      },
    ];

    for (const entry of cases) {
      const before = await vscode.workspace.fs.readFile(entry.uri);
      let document;
      try {
        await vscode.commands.executeCommand("vscode.openWith", entry.uri, "visualbridge.documentEditor.option");
        await waitForAsync(
          () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", entry.uri),
          (ready) => ready === true,
          20_000,
          `${entry.editor} editor did not become ready for the operation lifecycle test.`,
        );
        document = await vscode.workspace.openTextDocument(entry.uri);
        assert.equal(entry.readValue(JSON.parse(document.getText())), entry.beforeValue);

        await vscode.commands.executeCommand(
          "visualbridge.test.applyDocumentOperations",
          entry.uri,
          entry.editor,
          entry.operations,
        );
        await waitFor(
          () => entry.readValue(JSON.parse(document.getText())),
          (value) => value === entry.afterValue,
          10_000,
          `${entry.editor} operation did not update the authoritative TextDocument.`,
        );
        await vscode.commands.executeCommand(
          "visualbridge.test.applyDocumentOperations",
          entry.uri,
          entry.editor,
          entry.followUpOperations,
        );
        await waitFor(
          () => entry.readValue(JSON.parse(document.getText())),
          (value) => value === entry.followUpValue,
          10_000,
          `${entry.editor} consecutive operation was mistaken for an external modification.`,
        );
        assert.equal(document.isDirty, true);

        await vscode.commands.executeCommand("undo");
        await waitFor(
          () => entry.readValue(JSON.parse(document.getText())),
          (value) => value === entry.afterValue,
          10_000,
          `${entry.editor} undo did not restore the previous semantic edit.`,
        );
        await vscode.commands.executeCommand("redo");
        await waitFor(
          () => entry.readValue(JSON.parse(document.getText())),
          (value) => value === entry.followUpValue,
          10_000,
          `${entry.editor} redo did not restore the operation.`,
        );

        assert.equal(await document.save(), true);
        assert.equal(document.isDirty, false);
        const diskValue = entry.readValue(JSON.parse(new TextDecoder().decode(
          await vscode.workspace.fs.readFile(entry.uri),
        )));
        assert.equal(diskValue, entry.followUpValue);
      } finally {
        if (document?.isDirty) {
          await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
        }
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
        await vscode.workspace.fs.writeFile(entry.uri, before);
        await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
      }
    }
  });

  /**
   * 打开 → 编辑 → 保存 → 关闭重开：四个领域各跑一次（每次断言磁盘持久化与会话干净）。
   */
  const reopenDomainDocument = async (entry) => {
    const before = await vscode.workspace.fs.readFile(entry.uri);
    const openEditor = async () => {
      await vscode.commands.executeCommand("vscode.openWith", entry.uri, entry.viewType);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", entry.uri),
        (ready) => ready === true,
        20_000,
        `${entry.domain} editor did not become ready for the reopen test.`,
      );
    };
    const readDiskText = async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(entry.uri));
    try {
      await openEditor();
      if (entry.domain === "table") {
        await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", entry.uri, entry.operations);
        assert.equal(
          await vscode.commands.executeCommand("visualbridge.test.saveTable", entry.uri),
          1,
          "A single Table cell edit must write exactly one source file.",
        );
      } else {
        const document = await vscode.workspace.openTextDocument(entry.uri);
        await vscode.commands.executeCommand(
          "visualbridge.test.applyDocumentOperations",
          entry.uri,
          entry.domain,
          entry.operations,
        );
        await waitFor(
          () => {
            try {
              return entry.read(JSON.parse(document.getText()));
            } catch {
              return undefined;
            }
          },
          (value) => value === entry.expected,
          10_000,
          `${entry.domain} operation did not reach the authoritative TextDocument `
          + `(last rejection: ${String(await vscode.commands.executeCommand("visualbridge.test.getEditorLastRejection", entry.uri))}).`,
        );
        assert.equal(await document.save(), true);
        assert.equal(document.isDirty, false);
      }
      // 关闭再重开：会话必须从磁盘重新装载并保持干净。
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await openEditor();
      const diskText = await readDiskText();
      assert.ok(
        entry.domain === "table" ? diskText.includes(entry.expected) : entry.read(JSON.parse(diskText)) === entry.expected,
        `${entry.domain} save did not persist to disk before the reopen.`,
      );
      if (entry.domain === "table") {
        assert.equal(
          (await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", entry.uri)).dirty,
          false,
          "A reopened Table document must not be dirty.",
        );
      } else {
        const document = await vscode.workspace.openTextDocument(entry.uri);
        assert.equal(document.isDirty, false, `A reopened ${entry.domain} document must not be dirty.`);
        assert.equal(entry.read(JSON.parse(document.getText())), entry.expected);
      }
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(entry.uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
      }
  };

  await test("saves, reopens and reloads an Entity document through the module session", () => (
    reopenDomainDocument({
      domain: "entity",
      uri: vscode.Uri.file(path.join(workspacePath, "EntitySemanticProject", "Config", "Entities", "Player.herojson")),
      viewType: "visualbridge.documentEditor.option",
      operations: [{ type: "entity.setTitle", title: "Reopened Entity" }],
      read: (value) => value.title,
      expected: "Reopened Entity",
    })
  ));
  await test("saves, reopens and reloads a Graph document through the module session", () => (
    reopenDomainDocument({
      domain: "graph",
      uri: vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Graph", "SemanticSample.vbgraph")),
      viewType: "visualbridge.documentEditor.option",
      operations: [{
        type: "graph.updateGraph",
        graphId: "root",
        title: "Reopened Graph",
        properties: { priority: 1 },
      }],
      read: (value) => value.graphs.find((graph) => graph.id === "root")?.title,
      expected: "Reopened Graph",
    })
  ));
  await test("saves, reopens and reloads a Structured Config document through the module session", () => (
    reopenDomainDocument({
      domain: "structured",
      uri: vscode.Uri.file(path.join(workspacePath, "StructuredSemanticProject", "Config", "Game.gamesettings")),
      viewType: "visualbridge.documentEditor.option",
      operations: [{ type: "structured.setField", fieldId: "maxPlayers", value: 6 }],
      read: (value) => value.properties.maxPlayers,
      expected: 6,
    })
  ));
  await test("saves, reopens and reloads a multi-source Table document through the module session", () => (
    reopenDomainDocument({
      domain: "table",
      uri: vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv")),
      viewType: "visualbridge.tableEditor",
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "name",
        value: "Reopened Table",
      }],
      expected: "Reopened Table",
    })
  ));

  await test("backs up and restores an unsaved multi-source Table document after a crash", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
    const backupUri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.vbbak"));
    const before = await vscode.workspace.fs.readFile(uri);
    const readDiskText = async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "Table editor did not become ready for the backup test.",
      );
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", uri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "name",
        value: "Backupprobe",
      }]);
      assert.equal(
        (await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri)).dirty,
        true,
      );

      const backup = await vscode.commands.executeCommand(
        "visualbridge.test.backupTableDocument",
        uri,
        backupUri,
      );
      assert.equal(backup.id, backupUri.toString());
      const backupValue = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(backupUri)));
      assert.equal(backupValue.formatVersion, 1);
      // 逻辑文档是 Skills_A + Skills_B 两源分表家族，备份必须覆盖整个家族。
      assert.equal(backupValue.sources.length, 2);
      assert.ok(
        backupValue.sources.some((source) => /Backupprobe/u.test(
          Buffer.from(source.bytes, "base64").toString("utf8"),
        )),
        "The backup must contain the unsaved Table edit bytes.",
      );

      // 模拟崩溃：丢弃内存编辑（从磁盘重读），磁盘上不应有未保存的编辑。
      await vscode.commands.executeCommand("visualbridge.test.revertTableDocument", uri);
      assert.equal(
        (await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri)).dirty,
        false,
      );
      assert.doesNotMatch(await readDiskText(), /Backupprobe/u);
      await vscode.commands.executeCommand("workbench.action.closeAllGroups");

      // 从备份恢复并保存：恢复出的文档带着未保存编辑，并能写回源文件。
      const restored = await vscode.commands.executeCommand(
        "visualbridge.test.restoreTableDocumentFromBackup",
        uri,
        backupUri,
        true,
      );
      assert.equal(restored.restoredDirty, true, "A backup must restore as an unsaved (dirty) document.");
      assert.equal(restored.isDirty, false);
      assert.equal(restored.savedWrites, 1);
      assert.match(await readDiskText(), /Backupprobe/u);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.workspace.fs.delete(backupUri).catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("reverts unsaved multi-source edits back to the disk sources", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "Table editor did not become ready for the revert test.",
      );
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", uri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "name",
        value: "Revertprobe",
      }]);
      assert.equal(
        (await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri)).dirty,
        true,
      );
      await vscode.commands.executeCommand("visualbridge.test.revertTableDocument", uri);
      assert.equal(
        (await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", uri)).dirty,
        false,
      );
      // revert 不写盘：磁盘仍是原字节。
      assert.equal(
        Buffer.compare(
          Buffer.from(await vscode.workspace.fs.readFile(uri)),
          Buffer.from(before),
        ),
        0,
      );
      assert.doesNotMatch(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), /Revertprobe/u);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("rejects stale revision batches with a readable message and no write", async () => {
    const entityUri = vscode.Uri.file(path.join(
      workspacePath, "EntitySemanticProject", "Config", "Entities", "Player.herojson"));
    const entityBefore = await vscode.workspace.fs.readFile(entityUri);
    let entityDocument;
    try {
      await vscode.commands.executeCommand("vscode.openWith", entityUri, "visualbridge.documentEditor.option");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", entityUri),
        (ready) => ready === true,
        20_000,
        "Entity editor did not become ready for the stale revision test.",
      );
      entityDocument = await vscode.workspace.openTextDocument(entityUri);
      const beforeText = entityDocument.getText();
      const staleVersion = entityDocument.version - 1;
      await vscode.commands.executeCommand(
        "visualbridge.test.applyDocumentOperations",
        entityUri,
        "entity",
        [{ type: "entity.setTitle", title: "Stale Entity" }],
        staleVersion,
      );
      assert.equal(entityDocument.getText(), beforeText, "A stale Entity batch must not write any effect.");
      assert.match(
        String(await vscode.commands.executeCommand("visualbridge.test.getEditorLastRejection", entityUri)),
        /文档已发生变化/u,
      );
    } finally {
      if (entityDocument?.isDirty) {
        await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
      }
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(entityUri, entityBefore);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }

    const tableUri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
    const tableBefore = await vscode.workspace.fs.readFile(tableUri);
    try {
      await vscode.commands.executeCommand("vscode.openWith", tableUri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", tableUri),
        (ready) => ready === true,
        20_000,
        "Table editor did not become ready for the stale revision test.",
      );
      await vscode.commands.executeCommand(
        "visualbridge.test.applyTableOperationsWithRevision",
        tableUri,
        [{
          type: "table.setCell",
          sheetId: "skills:Skills_A",
          rowId: "Skills_A:key-101",
          columnId: "name",
          value: "Stale Table",
        }],
        0,
      );
      assert.match(
        String(await vscode.commands.executeCommand("visualbridge.test.getTableLastRejection", tableUri)),
        /文档已发生变化/u,
      );
      // 生产执行器（与 Webview 同一路径）必须在批处理前拒绝：文档修订号、脏状态与磁盘都不推进。
      const staleState = await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", tableUri);
      assert.equal(staleState.dirty, false, "A stale Table batch must leave the document clean.");
      assert.equal(staleState.revision, 1, "A stale Table batch must not advance the document revision.");
      assert.doesNotMatch(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(tableUri)),
        /Stale Table/u,
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(tableUri, tableBefore);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("stamps operationCompleted with the post-apply revision in both session types", async () => {
    const entityUri = vscode.Uri.file(path.join(
      workspacePath, "EntitySemanticProject", "Config", "Entities", "Player.herojson"));
    const entityBefore = await vscode.workspace.fs.readFile(entityUri);
    let entityDocument;
    try {
      await vscode.commands.executeCommand("vscode.openWith", entityUri, "visualbridge.documentEditor.option");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", entityUri),
        (ready) => ready === true,
        20_000,
        "Entity editor did not become ready for the revision stamping test.",
      );
      entityDocument = await vscode.workspace.openTextDocument(entityUri);
      const versionBefore = entityDocument.version;
      await vscode.commands.executeCommand(
        "visualbridge.test.applyDocumentOperations",
        entityUri,
        "entity",
        [{ type: "entity.setTitle", title: "Stamped Entity" }],
      );
      await waitFor(
        () => entityDocument.getText(),
        (text) => text.includes("Stamped Entity"),
        10_000,
        "Entity operation did not reach the TextDocument.",
      );
      assert.ok(entityDocument.version > versionBefore);
      const completed = await vscode.commands.executeCommand(
        "visualbridge.test.getEditorLastOperationCompleted",
        entityUri,
      );
      assert.equal(completed?.changed, true);
      // 宿主必须用 apply 之后的 version 盖章，而不是控制器里的 apply 前 snapshot.revision。
      assert.equal(completed?.documentVersion, entityDocument.version);
    } finally {
      if (entityDocument?.isDirty) {
        await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
      }
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(entityUri, entityBefore);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }

    const tableUri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
    const tableBefore = await vscode.workspace.fs.readFile(tableUri);
    try {
      await vscode.commands.executeCommand("vscode.openWith", tableUri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", tableUri),
        (ready) => ready === true,
        20_000,
        "Table editor did not become ready for the revision stamping test.",
      );
      const revisionBefore = (await vscode.commands.executeCommand(
        "visualbridge.test.getTableEditorState",
        tableUri,
      )).revision;
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", tableUri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "name",
        value: "Stamped Table",
      }]);
      const stateAfter = await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", tableUri);
      const completed = await vscode.commands.executeCommand(
        "visualbridge.test.getTableLastOperationCompleted",
        tableUri,
      );
      assert.equal(completed?.changed, true);
      assert.equal(completed?.revision, stateAfter.revision);
      assert.ok(stateAfter.revision > revisionBefore);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(tableUri, tableBefore);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("keeps multi-source diagnostics unique when a partition warning is present", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
    const before = await vscode.workspace.fs.readFile(uri);
    const uniquenessHolds = (diagnostics) => {
      const keys = diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.message,
        diagnostic.range.start.line,
        diagnostic.range.start.character,
      ].join("\u0000"));
      return new Set(keys).size === keys.length;
    };
    try {
      // open 阶段（未建面板、未 ready）必须已经去重：ready 之后 `state.diagnostics` 会覆盖
      // open 阶段发布结果，只在 ready 之后断言无法证明 `updateDiagnostics` 的去重生效。
      const openProbe = await vscode.commands.executeCommand(
        "visualbridge.test.getTableOpenDiagnostics",
        uri,
      );
      assert.ok(
        openProbe.raw.length > openProbe.published.length,
        "The open path must produce duplicate diagnostics that get deduped.",
      );
      const publishKeys = openProbe.published.map((diagnostic) => JSON.stringify(diagnostic));
      assert.equal(
        new Set(publishKeys).size,
        publishKeys.length,
        "Open-phase published diagnostics must be unique.",
      );
      await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "Table editor did not become ready for the diagnostics test.",
      );
      const opened = vscode.languages.getDiagnostics(uri).filter(
        (diagnostic) => diagnostic.source === "VisualBridge",
      );
      // 夹具的 Skills_A + Skills_B 各有一行 key 101，keepFirst 策略产出一条分区去重告警。
      assert.equal(
        opened.filter((diagnostic) => diagnostic.code === "table.partitionDuplicateResolved").length,
        1,
        "The partition warning must be published exactly once.",
      );
      assert.ok(uniquenessHolds(opened), "Opening a multi-source document must not publish duplicate diagnostics.");

      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", uri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "name",
        value: "Diagnostics Probe",
      }]);
      const afterApply = vscode.languages.getDiagnostics(uri).filter(
        (diagnostic) => diagnostic.source === "VisualBridge",
      );
      assert.ok(uniquenessHolds(afterApply), "Applying an operation must not publish duplicate diagnostics.");
      assert.equal(
        afterApply.filter((diagnostic) => diagnostic.code === "table.partitionDuplicateResolved").length,
        1,
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("restores a Table backup as dirty when the disk source is unparseable", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
    const backupUri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.crashbak"));
    const before = await vscode.workspace.fs.readFile(uri);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.tableEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "Table editor did not become ready for the damaged-source backup test.",
      );
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", uri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "name",
        value: "Crashprobe",
      }]);
      await vscode.commands.executeCommand("visualbridge.test.backupTableDocument", uri, backupUri);
      await vscode.commands.executeCommand("workbench.action.closeAllGroups");

      // 模拟崩溃后磁盘源损坏：只留 name-key 行，缺少 dataStartRow，解析必然失败。
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from("技能名\t技能编号\t标签\t奖励\t颜色\n", "utf8"),
      );
      const restored = await vscode.commands.executeCommand(
        "visualbridge.test.restoreTableDocumentFromBackup",
        uri,
        backupUri,
      );
      // 没有可比较的磁盘基线时必须强制为脏，不能把备份当成已保存内容。
      assert.equal(restored.restoredDirty, true, "A backup restored over an unparseable source must be dirty.");
      assert.equal(restored.isDirty, true);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.workspace.fs.delete(backupUri).catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("jumps to Graph nodes and Entity components through real Webview acknowledgements", async () => {
    const graphUri = vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Graph", "SemanticSample.vbgraph"));
    const entityUri = vscode.Uri.file(path.join(workspacePath, "EntitySemanticProject", "Config", "Entities", "Player.herojson"));
    try {
      await vscode.commands.executeCommand("visualbridge.revealReference", {
        projectId: "GraphSemanticProject",
        documentTypeId: "logicGraph",
        path: "Graph/SemanticSample.vbgraph",
        elementKind: "node",
        elementId: "step_b",
        graphId: "root",
        nodeId: "step_b",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", graphUri),
        (state) => state.lastRevealResults.some((result) => (
          result.found === true && result.target.nodeId === "step_b"
        )),
        20_000,
        "Graph reference jump was not acknowledged by the Webview.",
      );
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

      await vscode.commands.executeCommand("visualbridge.revealReference", {
        projectId: "visualbridge.entity-semantics",
        documentTypeId: "hero-config",
        path: "Config/Entities/Player.herojson",
        documentId: "sample.player",
        elementKind: "component",
        elementId: "health",
        componentId: "health",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getEntityEditorState", entityUri),
        (state) => state.lastRevealResults.some((result) => (
          result.found === true && result.target.componentId === "health"
        )),
        20_000,
        "Entity reference jump was not acknowledged by the Webview.",
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
    }
  });

  await test("shows Graph and node names for incoming references and reveals the referencing node", async () => {
    const graphUri = vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Graph", "SemanticSample.vbgraph"));
    const selector = {
      projectId: "GraphSemanticProject",
      targetPath: "Tables/Skills_Main.skillstable",
      sourcePath: "Graph/SemanticSample.vbgraph",
      occurrencePath: "graphs[1].nodes[2].properties.settings.targetId",
    };
    try {
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
      const incomingItems = await vscode.commands.executeCommand(
        "visualbridge.test.getDocumentBrowserIncomingReferences",
      );
      const item = incomingItems.find((candidate) => (
        candidate.projectId === selector.projectId
        && candidate.targetPath === selector.targetPath
        && candidate.sourcePath === selector.sourcePath
        && candidate.occurrencePath === selector.occurrencePath
      ));
      assert.ok(item, "Graph incoming reference was not exposed by the Document Browser.");
      assert.equal(item.label, "Semantic Sample · Step B");
      assert.equal(item.description, "settings.targetId · 101");
      assert.equal(item.graphTitle, "Semantic Sample");
      assert.equal(item.nodeTitle, "Step B");
      assert.equal(item.command, "visualbridge.documentBrowser.revealReference");

      await withTimeout(vscode.commands.executeCommand(
        "visualbridge.test.revealDocumentBrowserIncomingReference",
        selector,
      ), 20_000, "Incoming Graph reference did not complete its reveal command.");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", graphUri),
        (state) => state.lastRevealResults.some((result) => (
          result.found === true
          && result.target.graphId === "root"
          && result.target.nodeId === "step_b"
        )),
        20_000,
        "Incoming Graph reference did not select and focus its source node.",
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
    }
  });

  await test("shows flat document counters and linked Problems and References details", async () => {
    const selector = {
      projectId: "GraphSemanticProject",
      path: "Graph/SemanticSample.vbgraph",
    };
    await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    const snapshot = await vscode.commands.executeCommand(
      "visualbridge.test.getDocumentDetailsSnapshot",
      selector,
    );
    assert.equal(snapshot.row.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.match(snapshot.row.label, /^Semantic Sample\s+\$\(issues\) \d+\s+\$\(references\) \d+$/);
    assert.deepEqual(snapshot.details.groups.map((group) => group.label), ["Problems", "References"]);
    assert.equal(snapshot.details.groups[0].count, snapshot.details.groups[0].items.length);
    assert.equal(snapshot.details.groups[1].count, snapshot.details.groups[1].items.length);
    assert.ok(snapshot.details.groups[1].count > 0, "The selected Graph should expose reference details.");

    assert.equal(
      await vscode.commands.executeCommand("visualbridge.test.localizeDocumentDiagnostic", {
        severity: "error",
        code: "reference.missingTarget",
        path: "graphs[0].nodes[10].properties.settings.targets[1]",
        message: "Reference '0' does not resolve for kind 'table.row'.",
      }),
      "引用值“0”无法解析为“table.row”类型。",
    );

    const detailState = await vscode.commands.executeCommand(
      "visualbridge.test.showDocumentDetails",
      selector,
      "references",
    );
    assert.equal(detailState.visible, true);
    assert.equal(detailState.selectedDocument, selector.path);
    assert.equal(detailState.selectedGroup, "references");
  });

  await test("rejects Structured operations after external changes before and after a save", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "StructuredSemanticProject", "Config", "Game.gamesettings"));
    const before = await vscode.workspace.fs.readFile(uri);
    let document;
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.documentEditor.option");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "Structured editor did not become ready for the external-change test.",
      );
      document = await vscode.workspace.openTextDocument(uri);
      const original = JSON.parse(document.getText());
      const externallyChangedBeforeSave = `${JSON.stringify({
        ...original,
        properties: { ...original.properties, maxPlayers: 6 },
      }, undefined, 2)}\n`;
      const versionBeforeExternalRefresh = document.version;
      await vscode.commands.executeCommand(
        "visualbridge.test.applyStructuredOperationsAfterExternalWrite",
        uri,
        externallyChangedBeforeSave,
        [{ type: "structured.setField", fieldId: "maxPlayers", value: 9 }],
      );
      assert.ok(document.version > versionBeforeExternalRefresh);
      assert.equal(document.getText(), externallyChangedBeforeSave);
      assert.equal(document.isDirty, false);
      assert.equal(
        Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(uri)), Buffer.from(externallyChangedBeforeSave, "utf8")),
        0,
      );

      await vscode.commands.executeCommand(
        "visualbridge.test.applyDocumentOperations",
        uri,
        "structured",
        [{ type: "structured.setField", fieldId: "maxPlayers", value: 9 }],
      );
      assert.equal(JSON.parse(document.getText()).properties.maxPlayers, 9);
      assert.equal(await document.save(), true);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const saved = JSON.parse(document.getText());
      const externallyChangedAfterSave = `${JSON.stringify({
        ...saved,
        properties: { ...saved.properties, maxPlayers: 7 },
      }, undefined, 2)}\n`;
      const versionBeforeSecondExternalRefresh = document.version;
      await vscode.commands.executeCommand(
        "visualbridge.test.applyStructuredOperationsAfterExternalWrite",
        uri,
        externallyChangedAfterSave,
        [{ type: "structured.setField", fieldId: "maxPlayers", value: 10 }],
      );
      assert.ok(document.version > versionBeforeSecondExternalRefresh);
      assert.equal(document.getText(), externallyChangedAfterSave);
      assert.equal(document.isDirty, false);
      assert.equal(
        Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(uri)), Buffer.from(externallyChangedAfterSave, "utf8")),
        0,
      );
    } finally {
      if (document?.isDirty) {
        await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
      }
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("retains split Graph diagnostics until their owning panels close", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "GraphSemanticProject",
      "Graph",
      "SemanticSample.vbgraph",
    ));
    const before = await vscode.workspace.fs.readFile(uri);
    const beforeText = new TextDecoder().decode(before);
    let document;
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.documentEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", uri),
        (state) => state?.sessionCount === 1 && state.diagnosticOwnerCount === 1,
        20_000,
        "Graph editor did not publish its initial owned diagnostic snapshot.",
      );
      await withTimeout(
        vscode.commands.executeCommand("workbench.action.splitEditorRight"),
        20_000,
        "VS Code did not split the Graph custom editor.",
      );
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", uri),
        (state) => state?.sessionCount === 2 && state.diagnosticOwnerCount === 2,
        20_000,
        "Both Graph panels did not publish owned diagnostic snapshots.",
      );

      document = await vscode.workspace.openTextDocument(uri);
      const invalidEdit = new vscode.WorkspaceEdit();
      invalidEdit.replace(
        uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        "{ invalid graph document\n",
      );
      assert.equal(await vscode.workspace.applyEdit(invalidEdit), true);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", uri),
        (state) => state?.diagnosticOwnerCount === 2 && state.publishedDiagnosticCount > 0,
        20_000,
        "Split Graph panels did not publish the invalid-document diagnostics.",
      );

      await vscode.commands.executeCommand("workbench.action.focusLeftGroup");
      await vscode.commands.executeCommand("workbench.action.closeEditorsInOtherGroups");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", uri),
        (state) => state?.sessionCount === 1
          && state.diagnosticOwnerCount === 1
          && state.publishedDiagnosticCount > 0,
        5_000,
        "Closing one Graph panel cleared diagnostics still owned by the surviving panel.",
      );
      assert.ok(vscode.languages.getDiagnostics(uri).some((diagnostic) => diagnostic.source === "VisualBridge"));

      const restoreEdit = new vscode.WorkspaceEdit();
      restoreEdit.replace(
        uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        beforeText,
      );
      assert.equal(await vscode.workspace.applyEdit(restoreEdit), true);
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", uri),
        (state) => state?.sessionCount === 0
          && state.diagnosticOwnerCount === 0
          && state.publishedDiagnosticCount === 0,
        5_000,
        "Closing the last Graph panel retained its diagnostic ownership.",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterAsyncValidation = await vscode.commands.executeCommand(
        "visualbridge.test.getGraphEditorState",
        uri,
      );
      assert.equal(afterAsyncValidation.diagnosticOwnerCount, 0);
      assert.equal(afterAsyncValidation.publishedDiagnosticCount, 0);
    } finally {
      if (document !== undefined && !document.isClosed && document.getText() !== beforeText) {
        const restoreEdit = new vscode.WorkspaceEdit();
        restoreEdit.replace(
          uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          beforeText,
        );
        await vscode.workspace.applyEdit(restoreEdit);
      }
      if (document !== undefined && !document.isClosed && document.isDirty) {
        await document.save();
      }
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(uri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("rejects direct Entity and Graph stable identity rename batches at the Host boundary", async () => {
    const entityUri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Config",
      "Entities",
      "Player.herojson",
    ));
    const graphUri = vscode.Uri.file(path.join(
      workspacePath,
      "GraphSemanticProject",
      "Graph",
      "SemanticSample.vbgraph",
    ));
    try {
      await vscode.commands.executeCommand("vscode.openWith", entityUri, "visualbridge.documentEditor.option");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", entityUri),
        (value) => value === true,
        20_000,
        "Entity editor did not become ready for the identity guard test.",
      );
      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.assertIdentityOperationsAllowed", entityUri, "entity", [{
          type: "entity.renameComponent",
          componentId: "move",
          newComponentId: "movement",
        }]),
        /refactor\.required/u,
      );
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

      await vscode.commands.executeCommand("vscode.openWith", graphUri, "visualbridge.documentEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", graphUri),
        (value) => value === true,
        20_000,
        "Graph editor did not become ready for the identity guard test.",
      );
      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.assertIdentityOperationsAllowed", graphUri, "graph", [{
          type: "graph.renameElement",
          graphId: "root",
          elementKind: "node",
          elementId: "step_b",
          newElementId: "step_c",
        }, {
          type: "graph.removeEdge",
          graphId: "root",
          edgeId: "flow_step_a_step_b",
        }]),
        /refactor\.required/u,
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
    }
  });

  await test("rejects unparsable Operation payloads through the relaxed applyOperations contract", async () => {
    const graphUri = vscode.Uri.file(path.join(
      workspacePath,
      "GraphSemanticProject",
      "Graph",
      "SemanticSample.vbgraph",
    ));
    const before = await vscode.workspace.fs.readFile(graphUri);
    try {
      await vscode.commands.executeCommand("vscode.openWith", graphUri, "visualbridge.documentEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", graphUri),
        (value) => value === true,
        20_000,
        "Graph editor did not become ready for the invalid operation test.",
      );
      const version = (await vscode.workspace.openTextDocument(graphUri)).version;
      for (const operations of [[{ type: "graph.notAnOperation" }], ["not-an-operation-object"]]) {
        await vscode.commands.executeCommand(
          "visualbridge.test.applyDocumentOperations",
          graphUri,
          "graph",
          operations,
          version,
        );
        assert.equal(
          Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(graphUri)), Buffer.from(before)),
          0,
          "An invalid Operation batch must not write.",
        );
        const rejection = String(await vscode.commands.executeCommand(
          "visualbridge.test.getEditorLastRejection",
          graphUri,
        ));
        // 拒绝文案必须可读并指向具体操作，而不是一个空泛的 TypeError。
        assert.match(
          rejection,
          /operations\[0\]|Unknown operation|Expected an operation object/u,
          `Unreadable rejection for an invalid Operation batch: ${rejection}`,
        );
        assert.equal(/TypeError|undefined is not/u.test(rejection), false);
      }
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllGroups").catch(() => undefined);
      await vscode.workspace.fs.writeFile(graphUri, before);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("returns a structured blocker for illegal CSV family copy and move basenames", async () => {
    const projectRoot = path.join(workspacePath, "TableSemanticProject");
    const firstUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_A.csv"));
    const secondUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_B.csv"));
    const targetUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Renamed.csv"));
    const firstBefore = await vscode.workspace.fs.readFile(firstUri);
    const secondBefore = await vscode.workspace.fs.readFile(secondUri);
    for (const command of ["visualbridge.test.lifecycleMove", "visualbridge.test.lifecycleCopy"]) {
      await assert.rejects(
        vscode.commands.executeCommand(command, {
          projectId: "visualbridge.table-semantics",
          sourcePath: "Tables/Skills_A.csv",
          targetPath: "Tables/Renamed.csv",
          ...(command.endsWith("Copy") ? { stableIdRemap: [] } : {}),
        }),
        (error) => /target\.typeMismatch/u.test(String(error)) && !/TypeError/u.test(String(error)),
      );
      assert.equal(Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(firstUri)), Buffer.from(firstBefore)), 0);
      assert.equal(Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(secondUri)), Buffer.from(secondBefore)), 0);
      await assertMissing(targetUri);
    }
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

  await test("saves a two-source CSV family atomically and refuses partial conflict writes", async () => {
    const firstUri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
    const secondUri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_B.csv"));
    const firstBefore = await vscode.workspace.fs.readFile(firstUri);
    const secondBefore = await vscode.workspace.fs.readFile(secondUri);
    try {
      await withTimeout(vscode.commands.executeCommand("visualbridge.openDocument", firstUri), 20_000, "CSV family did not open.");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", firstUri),
        (ready) => ready === true,
        20_000,
        "CSV family editor did not become ready.",
      );
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", firstUri, [
        {
          type: "table.setCell",
          sheetId: "skills:Skills_A",
          rowId: "Skills_A:key-101",
          columnId: "name",
          value: "Fireball Saved",
        },
        {
          type: "table.setCell",
          sheetId: "skills:Skills_B",
          rowId: "Skills_B:key-101",
          columnId: "name",
          value: "Fireball Override Saved",
        },
      ]);
      const externalSecond = new TextEncoder().encode(
        new TextDecoder().decode(secondBefore).replace("Fireball Override", "External Override"),
      );
      await vscode.workspace.fs.writeFile(secondUri, externalSecond);
      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.saveTable", firstUri),
        /changed on disk; no source was written/u,
      );
      assert.equal(Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(firstUri)), Buffer.from(firstBefore)), 0);
      assert.equal(Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(secondUri)), Buffer.from(externalSecond)), 0);

      await vscode.workspace.fs.writeFile(secondUri, secondBefore);
      const sourceCount = await vscode.commands.executeCommand("visualbridge.test.saveTable", firstUri);
      assert.equal(sourceCount, 2);
      assert.ok(new TextDecoder().decode(await vscode.workspace.fs.readFile(firstUri)).includes("Fireball Saved\t101"));
      assert.ok(new TextDecoder().decode(await vscode.workspace.fs.readFile(secondUri)).includes("Fireball Override Saved\t101"));
    } finally {
      await vscode.workspace.fs.writeFile(firstUri, firstBefore);
      await vscode.workspace.fs.writeFile(secondUri, secondBefore);
      await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("rolls a two-source CSV family back when the second transaction publish fails", async () => {
    const projectRoot = path.join(workspacePath, "TableSemanticProject");
    const firstUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_A.csv"));
    const secondUri = vscode.Uri.file(path.join(projectRoot, "Tables", "Skills_B.csv"));
    const firstBefore = await vscode.workspace.fs.readFile(firstUri);
    const secondBefore = await vscode.workspace.fs.readFile(secondUri);
    const originalRename = fsPromises.rename;
    let publishedCount = 0;
    try {
      await withTimeout(vscode.commands.executeCommand("visualbridge.openDocument", firstUri), 20_000, "CSV rollback family did not open.");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", firstUri),
        (ready) => ready === true,
        20_000,
        "CSV rollback editor did not become ready.",
      );
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", firstUri, [
        {
          type: "table.setCell",
          sheetId: "skills:Skills_A",
          rowId: "Skills_A:key-101",
          columnId: "name",
          value: "Fireball Rollback",
        },
        {
          type: "table.setCell",
          sheetId: "skills:Skills_B",
          rowId: "Skills_B:key-101",
          columnId: "name",
          value: "Fireball Override Rollback",
        },
      ]);

      fsPromises.rename = async (source, destination) => {
        const isCsvPublish = source.endsWith(".tmp")
          && source.includes(".visualbridge-")
          && (destination === firstUri.fsPath || destination === secondUri.fsPath);
        if (isCsvPublish && publishedCount === 1) {
          throw Object.assign(new Error("Injected CSV second publish failure."), { code: "EIO" });
        }
        await originalRename(source, destination);
        if (isCsvPublish) publishedCount += 1;
      };
      await assert.rejects(vscode.commands.executeCommand("visualbridge.test.saveTable", firstUri));
      assert.equal(publishedCount, 1);
      assert.equal(Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(firstUri)), Buffer.from(firstBefore)), 0);
      assert.equal(Buffer.compare(Buffer.from(await vscode.workspace.fs.readFile(secondUri)), Buffer.from(secondBefore)), 0);
      const tableEntries = await fsPromises.readdir(path.join(projectRoot, "Tables"));
      assert.equal(tableEntries.some((entry) => entry.includes(".visualbridge-")), false);
    } finally {
      fsPromises.rename = originalRename;
      await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
      await vscode.workspace.fs.writeFile(firstUri, firstBefore);
      await vscode.workspace.fs.writeFile(secondUri, secondBefore);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
  });

  await test("saves XLSX edits while preserving unrelated sheet state, formulas, and styles", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills.xlsx"));
    const original = await vscode.workspace.fs.readFile(uri);
    try {
      const seeded = new ExcelJS.Workbook();
      await seeded.xlsx.load(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength));
      const notes = seeded.getWorksheet("Notes");
      assert.ok(notes);
      notes.state = "hidden";
      notes.getCell("B1").value = { formula: "SUM(Skills_A!B3:B4)", result: 602 };
      notes.getCell("A1").font = { bold: true, color: { argb: "FF336699" } };
      const seededBytes = Uint8Array.from(Buffer.from(await seeded.xlsx.writeBuffer()));
      await vscode.workspace.fs.writeFile(uri, seededBytes);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");

      await withTimeout(vscode.commands.executeCommand("visualbridge.openDocument", uri), 20_000, "XLSX did not open.");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
        (ready) => ready === true,
        20_000,
        "XLSX editor did not become ready.",
      );
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", uri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-301",
        columnId: "name",
        value: "Fireball Host Saved",
      }]);
      assert.equal(await vscode.commands.executeCommand("visualbridge.test.saveTable", uri), 1);

      const savedBytes = await vscode.workspace.fs.readFile(uri);
      const saved = new ExcelJS.Workbook();
      await saved.xlsx.load(savedBytes.buffer.slice(savedBytes.byteOffset, savedBytes.byteOffset + savedBytes.byteLength));
      assert.equal(saved.getWorksheet("Skills_A")?.getCell("A3").value, "Fireball Host Saved");
      assert.equal(saved.getWorksheet("Notes")?.state, "hidden");
      assert.equal(saved.getWorksheet("Notes")?.getCell("B1").value?.formula, "SUM(Skills_A!B3:B4)");
      assert.equal(saved.getWorksheet("Notes")?.getCell("A1").font.bold, true);
      assert.equal(saved.getWorksheet("Notes")?.getCell("A1").font.color?.argb, "FF336699");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
      await vscode.workspace.fs.writeFile(uri, original);
      await vscode.commands.executeCommand("visualbridge.documentBrowser.refresh");
    }
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

  await test("browses Catalog provenance, content Hashes, types, aliases, and stale diagnostics read-only", async () => {
    const catalogUri = vscode.Uri.file(path.join(
      workspacePath,
      "ProviderSemanticProject",
      "Catalog",
      "Provider.vbstructuredcatalog",
    ));
    const before = await vscode.workspace.fs.readFile(catalogUri);
    const snapshots = await vscode.commands.executeCommand("visualbridge.test.getCatalogBrowserSnapshot");
    const registry = snapshots.find((entry) => entry.projectId === "visualbridge.provider-semantics"
      && entry.documentTypeId === "sample.provider.settings");
    assert.ok(registry);
    assert.equal(registry.ready, true);
    assert.ok(registry.definitions.some((entry) => entry.kind === "configType"));
    assert.equal(registry.sources.length, 1);
    assert.equal(registry.sources[0].source.status, "stale");
    assert.match(registry.sources[0].contentHash, /^[0-9a-f]{64}$/u);
    assert.ok(registry.diagnostics.some((entry) => entry.code === "catalog.sourceStale"));
    assert.ok(vscode.languages.getDiagnostics(catalogUri).some((entry) => entry.code === "catalog.sourceStale"));
    assert.deepEqual(await vscode.workspace.fs.readFile(catalogUri), before, "Catalog Browser rewrote a read-only source.");
  });

  await test("publishes Catalog Registry conflicts to both Catalog Browser and Problems", async () => {
    const uri = vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Catalog", "Logic.vbgraphcatalog"));
    const before = await vscode.workspace.fs.readFile(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    try {
      const catalog = JSON.parse(new TextDecoder().decode(before));
      catalog.catalogId = "sample.common";
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), `${JSON.stringify(catalog, undefined, 2)}\n`);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      const snapshots = await vscode.commands.executeCommand("visualbridge.test.getCatalogBrowserSnapshot");
      const registry = snapshots.find((entry) => entry.projectId === "GraphSemanticProject"
        && entry.documentTypeId === "logicGraph");
      assert.ok(registry);
      assert.equal(registry.ready, false);
      assert.ok(registry.diagnostics.some((entry) => entry.code === "graphCatalogRegistry.duplicateCatalogId"));
      assert.ok(vscode.languages.getDiagnostics(uri).some((entry) => entry.code === "graphCatalogRegistry.duplicateCatalogId"));
    } finally {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await vscode.commands.executeCommand("visualbridge.catalogBrowser.refresh");
    }
    await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (diagnostics) => !diagnostics.some((entry) => entry.code === "graphCatalogRegistry.duplicateCatalogId"),
      10_000,
      "Resolved Catalog Registry conflicts were not cleared from Problems.",
    );
  });

  await test("edits Project Settings through validated Operations and rejects stale or ambiguous changes", async () => {
    const uri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "VisualBridge.project.vbjson",
    ));
    const before = await vscode.workspace.fs.readFile(uri);
    await vscode.commands.executeCommand("vscode.openWith", uri, "visualbridge.projectSettingsEditor");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", uri),
      (ready) => ready === true,
      20_000,
      "Project Settings editor did not become ready.",
    );
    const baseline = await vscode.commands.executeCommand("visualbridge.test.getProjectSettingsState", uri);
    assert.equal(baseline.projectId, "visualbridge.structured-semantics");
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, "0".repeat(64), [{
        type: "project.setModuleOptions",
        moduleId: "visualbridge.table",
        options: { tableLayout: { nameKeyRow: 1, dataStartRow: 3 } },
      }]),
      /sourceHash conflict/u,
    );
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, baseline.sourceHash, [{
        type: "project.upsertDocumentType",
        documentType: {
          id: "ambiguous.settings",
          editor: "structured",
          include: ["Config/**/*.gamesettings"],
          exclude: [],
          catalogs: ["Catalog/Game.vbstructuredcatalog"],
        },
      }]),
      /overlaps the identical include/u,
    );
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, baseline.sourceHash, [{
        type: "project.upsertDocumentType",
        documentType: {
          id: "ambiguous.future-file",
          editor: "structured",
          include: ["Config/Heroes/**/*.gamesettings"],
          exclude: [],
          catalogs: ["Catalog/Game.vbstructuredcatalog"],
        },
      }]),
      /overlaps Document Type 'sample\.game\.settings'/u,
    );
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, baseline.sourceHash, [{
        type: "project.upsertDocumentType",
        documentType: {
          id: "sample.game.settings",
          editor: "structured",
          include: ["Config/A*.gamesettings"],
          exclude: [],
          catalogs: ["Catalog/Game.vbstructuredcatalog"],
        },
      }, {
        type: "project.upsertDocumentType",
        documentType: {
          id: "sample.entity.overlap",
          editor: "entity",
          include: ["Config/*B.gamesettings"],
          exclude: [],
          catalogs: [],
        },
      }]),
      /overlaps Document Type 'sample\.game\.settings'.*Config\/AxB\.gamesettings/u,
    );
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, baseline.sourceHash, [{
        type: "project.upsertDocumentType",
        documentType: {
          id: "ambiguous.actual-file",
          editor: "structured",
          include: ["Config/Game.*"],
          exclude: [],
          catalogs: ["Catalog/Game.vbstructuredcatalog"],
        },
      }]),
      /ambiguous ownership/u,
    );
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, baseline.sourceHash, [{
        type: "project.renameDocumentType",
        documentTypeId: "sample.game.settings",
        newId: "sample.missing.settings",
      }]),
      /does not resolve to a Config Type ID or alias/u,
    );
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, baseline.sourceHash, [{
        type: "project.renameDocumentType",
        documentTypeId: "sample.table.skills",
        newId: "sample.table.missing",
      }]),
      /does not resolve to a Table Type ID or alias/u,
    );
    assert.deepEqual(await vscode.workspace.fs.readFile(uri), before);

    const concurrent = await Promise.allSettled([3, 4].map((dataStartRow) => (
      vscode.commands.executeCommand("visualbridge.test.applyProjectOperations", uri, baseline.sourceHash, [{
        type: "project.setModuleOptions",
        moduleId: "visualbridge.table",
        options: { tableLayout: { nameKeyRow: 1, dataStartRow } },
      }])
    )));
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((entry) => (
      entry.status === "rejected" && /sourceHash conflict/u.test(String(entry.reason))
    )).length, 1);
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getProjectSettingsState", uri),
      (state) => state.sourceHash !== baseline.sourceHash,
      10_000,
      "Project Settings Operation was not applied.",
    );
    const changed = JSON.parse((await vscode.workspace.openTextDocument(uri)).getText());
    const changedTableModule = changed.modules.find((module) => module.id === "visualbridge.table");
    assert.equal(changedTableModule.options.tableLayout.nameKeyRow, 1);
    assert.ok(changedTableModule.options.tableLayout.dataStartRow === 3 || changedTableModule.options.tableLayout.dataStartRow === 4);
    await vscode.commands.executeCommand("undo");
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getProjectSettingsState", uri),
      (state) => state.sourceHash === baseline.sourceHash,
      10_000,
      "Project Settings undo did not restore the original semantic source.",
    );
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.deepEqual(await vscode.workspace.fs.readFile(uri), before);
  });

  await test("loads declared modules per Project and keeps domain editors available", async () => {
    const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
    assert.equal(state.trusted, true);
    assert.ok(state.activationCount > 0, "No module activation was observed in the trusted workspace.");
    // 已信任时注册源 activate 了四个模块（只观测注册源路径；bundle 级静态 init 不在观测范围，
    // 归 C1/C2 把领域代码移出宿主，Restricted Mode 下这个列表必须为空）。
    // C2 起 bundle 由 ModuleLoader 求值：测试工作区里 TestData/ModuleLoaderProject 的 fixture
    // bundle 也会被求值（它们的 loaded/failed 状态由各自的断言覆盖）。这里只排除**那个 fixture
    // Project 自己声明的模块 id**，而不是任意 `visualbridge.fixture.` 前缀——否则新增一个 fixture
    // 模块就会悄悄通过。
    const fixtureProject = JSON.parse(new TextDecoder("utf-8").decode(
      await vscode.workspace.fs.readFile(
        vscode.Uri.file(path.join(workspacePath, "ModuleLoaderProject", "VisualBridge.project.vbjson")),
      ),
    ));
    const fixtureModuleIds = new Set((fixtureProject.modules ?? []).map((module) => module.id));
    assert.deepEqual(
      [...state.evaluatedModuleIds].filter((id) => !fixtureModuleIds.has(id)).sort(),
      ["visualbridge.entity", "visualbridge.graph", "visualbridge.structured", "visualbridge.table"],
    );
    const expectLoaded = (projectId, modules) => {
      const project = state.projects.find((entry) => entry.projectId === projectId);
      assert.ok(project, `Project '${projectId}' is missing from the module registry snapshot.`);
      assert.deepEqual(
        project.modules.map((module) => [module.id, module.status]),
        modules,
        `Unexpected module states for '${projectId}'.`,
      );
      for (const module of project.modules) {
        assert.ok(module.editors.length > 0, `Module '${module.id}' did not expose editors.`);
        assert.deepEqual(module.diagnostics, [], `Module '${module.id}' reported diagnostics while loaded.`);
      }
    };
    expectLoaded("visualbridge.entity-semantics", [["visualbridge.entity", "loaded"], ["visualbridge.table", "loaded"]]);
    expectLoaded("GraphSemanticProject", [["visualbridge.graph", "loaded"], ["visualbridge.table", "loaded"]]);
    expectLoaded("visualbridge.structured-semantics", [["visualbridge.structured", "loaded"], ["visualbridge.table", "loaded"]]);
    expectLoaded("visualbridge.table-semantics", [["visualbridge.table", "loaded"]]);
    expectLoaded("visualbridge.provider-semantics", [["visualbridge.structured", "loaded"]]);

    // 已加载时不出现只读回退：行为与改造前一致。
    const entityUri = vscode.Uri.file(path.join(
      workspacePath,
      "EntitySemanticProject",
      "Config",
      "Entities",
      "Player.herojson",
    ));
    await vscode.commands.executeCommand("visualbridge.openDocument", entityUri);
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", entityUri),
      (ready) => ready === true,
      20_000,
      "The Entity editor did not become ready while its module is loaded.",
    );
    const shell = await vscode.commands.executeCommand("visualbridge.test.getReadonlyShellState", entityUri);
    assert.equal(shell.active, false);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

    // 直接 openWith Table 编辑器（绕过 openDocument）也必须走真实编辑器，而不是只读 Shell。
    const tableUri = vscode.Uri.file(path.join(
      workspacePath,
      "TableSemanticProject",
      "Tables",
      "Skills_A.csv",
    ));
    await withTimeout(
      vscode.commands.executeCommand("vscode.openWith", tableUri, "visualbridge.tableEditor"),
      20_000,
      "The standalone Table editor did not open.",
    );
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", tableUri),
      (ready) => ready === true,
      20_000,
      "The standalone Table editor did not become ready.",
    );
    const tableShell = await vscode.commands.executeCommand("visualbridge.test.getTableReadonlyShellState", tableUri);
    assert.equal(tableShell.active, false);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  await test("reloads a changed module bundle from stale back to loaded", async () => {
    // 验收第 4 条：bundle 在磁盘上变化后进入 stale，用户确认重载必须真的重新装载
    // （注册源在模块定义未变时会复用旧 loader，reload 必须带 force）。
    const projectRoot = path.join(workspacePath, "TableSemanticProject");
    const projectUri = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson"));
    const bundleUri = vscode.Uri.file(path.join(projectRoot, "Modules", "table.vbmodule.js"));
    const bundleBefore = await vscode.workspace.fs.readFile(bundleUri);
    const projectBefore = await vscode.workspace.fs.readFile(projectUri);
    const moduleState = async () => {
      const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
      const project = state.projects.find((entry) => entry.projectId === "visualbridge.table-semantics");
      assert.ok(project, "The Table project is missing from the module registry snapshot.");
      const module = project.modules.find((entry) => entry.id === "visualbridge.table");
      assert.ok(module, "The Table module is missing from the module registry snapshot.");
      return module;
    };
    try {
      const replaced = Buffer.concat([Buffer.from(bundleBefore), Buffer.from("\n/* updated bundle */\n")]);
      await vscode.workspace.fs.writeFile(bundleUri, replaced);

      const stale = await vscode.commands.executeCommand("visualbridge.test.refreshStaleModules");
      assert.ok(
        stale.includes("visualbridge.table"),
        `refreshStale did not report the changed bundle: ${JSON.stringify(stale)}`,
      );
      assert.equal((await moduleState()).status, "stale", "A changed bundle must be reported as stale.");

      // 用户点"重新加载模块"：注册源在模块定义未变时会复用旧 loader，重载必须带 force，
      // 所以这里唯一可信的判据是 `stale → loaded`（不带 force 时状态会停在 `stale`）。
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
      const afterReload = await moduleState();
      assert.equal(afterReload.status, "loaded", "Reload must bring the changed Table module back to loaded.");
      assert.deepEqual(afterReload.diagnostics, [], "A reloaded module must not keep diagnostics.");
    } finally {
      await vscode.workspace.fs.writeFile(bundleUri, bundleBefore);
      await vscode.workspace.fs.writeFile(projectUri, projectBefore);
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
      assert.equal((await moduleState()).status, "loaded", "The restored Table bundle must load again.");
    }
  });

  await test("keeps activate alive, isolates a real unpack failure, and reclaims the loader", async () => {
    // 注入点必须是**真实抛错点**：解包目录被一个同名文件占住时 `mkdir` 抛错（P2-3）。
    // 断言：只有命中的 Project 落到 failed 并给出原因、其余 Project 照常、条目与 loader 被回收、
    // 清掉障碍后同一条重载路径能恢复。
    const projectRoot = path.join(workspacePath, "EntitySemanticProject");
    const bundleUri = vscode.Uri.file(path.join(projectRoot, "Modules", "entity.vbmodule.js"));
    const bundleBefore = await vscode.workspace.fs.readFile(bundleUri);
    const storageRoot = await vscode.commands.executeCommand("visualbridge.test.getModuleStorageRoot");
    const modulesRoot = path.join(storageRoot, "modules");
    const replaced = Buffer.concat([Buffer.from(bundleBefore), Buffer.from("\n/* unpack failure probe */\n")]);
    const blockedHash = createHash("sha256").update(replaced).digest("hex");
    const blockerPath = path.join(modulesRoot, blockedHash);
    const entityState = async () => {
      const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
      return {
        state,
        entity: state.projects.find((entry) => entry.projectId === "visualbridge.entity-semantics"),
      };
    };
    try {
      await fsPromises.mkdir(modulesRoot, { recursive: true });
      await fsPromises.writeFile(blockerPath, "not a directory");
      await vscode.workspace.fs.writeFile(bundleUri, replaced);
      // 计数器是会话累计量：取**差值**才可证伪（历史 reload 早已把同一 marker 记过多次）。
      const disposedBefore = (await entityState()).state.disposedProjectKeys.length;
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");

      const { state, entity } = await entityState();
      assert.ok(entity, "The Entity project is missing from the module registry snapshot.");
      // 本次加载里该 Project 的 marker key 必须被释放两次：先释放上一个条目，再释放解包失败的这个
      // loader。只在 buildEntry 之后登记条目的写法下，失败时一次都不会发生（loader 永久泄漏）。
      const entityMarker = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson")).toString();
      const entityDisposals = state.disposedProjectKeys
        .slice(disposedBefore)
        .filter((key) => key === entityMarker).length;
      assert.ok(
        entityDisposals >= 2,
        `A failed preparation must dispose its loader and registration (disposed the Entity project ${entityDisposals} time(s) in this reload).`,
      );
      for (const module of entity.modules) {
        assert.equal(module.status, "failed", `Module '${module.id}' must fail when its webview assets cannot be unpacked.`);
        assert.ok(
          module.diagnostics.some((entry) => entry.code === "module.loadFailed"),
          `Module '${module.id}' must explain the preparation failure: ${JSON.stringify(module.diagnostics)}`,
        );
        assert.equal(module.webviewDirectory, undefined, "A failed module must not expose a webview directory.");
      }
      assert.ok(
        !state.evaluatedModuleIds.includes("visualbridge.entity"),
        "A failed preparation must be removed from the source entries (otherwise the disposed loader still reports loaded).",
      );
      const table = state.projects.find((entry) => entry.projectId === "visualbridge.table-semantics");
      assert.deepEqual(
        table.modules.map((module) => [module.id, module.status]),
        [["visualbridge.table", "loaded"]],
        "Other projects must keep loading when one project fails to unpack.",
      );
      assert.equal((await fsPromises.stat(blockerPath)).isFile(), true, "The blocker must still be a file (no partial directory).");

      // 其它 Project 的编辑器照常可用：activate 没有被这一次失败打挂。
      const tableUri = vscode.Uri.file(path.join(workspacePath, "TableSemanticProject", "Tables", "Skills_A.csv"));
      await withTimeout(
        vscode.commands.executeCommand("vscode.openWith", tableUri, "visualbridge.tableEditor"),
        20_000,
        "The Table editor did not open while another project failed to unpack.",
      );
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", tableUri),
        (ready) => ready === true,
        20_000,
        "The Table editor did not become ready while another project failed to unpack.",
      );
      const shell = await vscode.commands.executeCommand("visualbridge.test.getTableReadonlyShellState", tableUri);
      assert.equal(shell.active, false, "The Table editor must stay usable when another module fails to unpack.");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } finally {
      await fsPromises.rm(blockerPath, { force: true });
      await vscode.workspace.fs.writeFile(bundleUri, bundleBefore);
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
    }
    const recovered = await entityState();
    assert.deepEqual(
      recovered.entity.modules.map((module) => module.status),
      ["loaded", "loaded"],
      "The Entity project must recover after the unpack blocker is removed.",
    );
  });

  await test("keeps old webview assets alive across a reload and points at the new bundle", async () => {
    // P1-b：重载后在本次会话内**不删**旧 `<hash>` 目录（否则已打开面板隐藏再显示会 404），
    // 并且给用户一条"模块已更新，请重新打开该文档"的可见提示。
    const projectRoot = path.join(workspacePath, "GraphSemanticProject");
    const bundleUri = vscode.Uri.file(path.join(projectRoot, "Modules", "graph.vbmodule.js"));
    const bundleBefore = await vscode.workspace.fs.readFile(bundleUri);
    const graphUri = vscode.Uri.file(path.join(projectRoot, "Graph", "SemanticSample.vbgraph"));
    const graphModule = async () => {
      const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
      const project = state.projects.find((entry) => entry.projectId === "GraphSemanticProject");
      assert.ok(project, "The Graph project is missing from the module registry snapshot.");
      const module = project.modules.find((entry) => entry.id === "visualbridge.graph");
      assert.ok(module, "The Graph module is missing from the module registry snapshot.");
      return { state, module };
    };
    let oldDirectory;
    try {
      const before = await graphModule();
      oldDirectory = before.module.webviewDirectory;
      assert.ok(oldDirectory, "The loaded Graph module must expose its webview directory.");

      await vscode.commands.executeCommand("visualbridge.openDocument", graphUri);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", graphUri),
        (ready) => ready === true,
        20_000,
        "The Graph editor did not become ready before the bundle changed.",
      );

      const replaced = Buffer.concat([Buffer.from(bundleBefore), Buffer.from("\n/* updated bundle */\n")]);
      const replacedHash = createHash("sha256").update(replaced).digest("hex");
      const newDirectory = path.join(path.dirname(oldDirectory), replacedHash);
      await vscode.workspace.fs.writeFile(bundleUri, replaced);

      const stale = await vscode.commands.executeCommand("visualbridge.test.refreshStaleModules");
      assert.ok(stale.includes("visualbridge.graph"), `refreshStale did not report the changed bundle: ${JSON.stringify(stale)}`);

      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
      const after = await graphModule();
      assert.equal(after.module.status, "loaded", "The changed Graph bundle must reload.");
      assert.equal(after.module.webviewDirectory, newDirectory, "The reloaded module must point at the new hash directory.");
      assert.equal((await fsPromises.stat(oldDirectory)).isDirectory(), true, "The old hash directory must survive this session.");
      assert.ok(
        after.state.reloadNotices.some((notice) => notice.includes("graph") && notice.includes("重新打开")),
        `A reload must tell the user to reopen the document: ${JSON.stringify(after.state.reloadNotices)}`,
      );

      // 隐藏面板再显示：面板不可见时 Webview 上下文被销毁，重新可见时会重新请求旧目录里的脚本。
      // 旧目录若在重载时被删，这里必然拿不到 ready 会话（404/空白）。
      const projectFileUri = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson"));
      const projectDocument = await vscode.workspace.openTextDocument(projectFileUri);
      await vscode.window.showTextDocument(projectDocument);
      // 用扩展自己的命令回到 Graph 面板：它按模块注册的 viewType 打开（直接写 viewType 会开出另一个 tab）。
      await vscode.commands.executeCommand("visualbridge.openDocument", graphUri);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", graphUri),
        (state) => state.sessionCount === 0 || (state.visibleSessionCount >= 1 && state.readySessionCount >= 1),
        20_000,
        "Showing the Graph panel again left it without a ready Webview session (old assets deleted too early).",
      );
      const shown = await vscode.commands.executeCommand("visualbridge.test.getGraphEditorState", graphUri);
      assert.equal((await fsPromises.stat(oldDirectory)).isDirectory(), true, "Showing the panel again must not require deleting old assets.");

      // 重新打开文档则切到新版本：新目录存在，编辑器可用。
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("visualbridge.openDocument", graphUri);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", graphUri),
        (ready) => ready === true,
        20_000,
        "Reopening the document after a module update must bring the Graph editor back.",
      );
      assert.equal((await fsPromises.stat(newDirectory)).isDirectory(), true, "Reopening must use the new hash directory.");
      // 观察值：重载后隐藏再显示时是否真有 ready 会话（报告里如实给出）。
      console.log(`[vscode-host] Graph panel after hide/show: sessions=${shown.sessionCount} ready=${shown.readySessionCount}`);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.workspace.fs.writeFile(bundleUri, bundleBefore);
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
      if (oldDirectory !== undefined) {
        assert.equal((await fsPromises.stat(oldDirectory)).isDirectory(), true, "The restored module must reuse its original assets.");
      }
    }
  });

  await test("clears module entries when trust is revoked mid-session", async () => {
    // P2-2：会话中撤回信任后，注册源必须把条目删干净（`evaluatedModuleIds` 不能继续报 loaded）。
    const before = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
    assert.equal(before.trusted, true);
    assert.ok(before.evaluatedModuleIds.includes("visualbridge.entity"), "The trusted baseline must have loaded modules.");
    try {
      await vscode.commands.executeCommand("visualbridge.test.setModuleTrustOverride", false);
      const revoked = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
      assert.equal(revoked.trusted, false);
      assert.deepEqual(revoked.evaluatedModuleIds, [], "Revoking trust must clear every source entry.");
      for (const project of revoked.projects) {
        for (const module of project.modules) {
          assert.equal(module.status, "untrusted", `Module '${module.id}' must be reported untrusted after revocation.`);
        }
      }
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.setModuleTrustOverride", undefined);
    }
    const restored = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
    assert.equal(restored.trusted, true);
    assert.ok(
      restored.evaluatedModuleIds.includes("visualbridge.entity"),
      "Restoring trust must reload the modules.",
    );
  });

  await test("drops modules on the production ensureProject path when trust is revoked", async () => {
    // P1-3：生产路径是 `ensureProject`（`reloadProject` 默认 force=false），不是测试专用的强制重载。
    // 注册源必须在幂等短路**之前**比较授权态，否则会话中撤回信任后条目/facet/loader 全都留着。
    const projectRoot = path.join(workspacePath, "EntitySemanticProject");
    const entityUri = vscode.Uri.file(path.join(projectRoot, "Config", "Entities", "Player.herojson"));
    const entityMarker = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson")).toString();
    const state = async () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
    const facetSources = async () => vscode.commands.executeCommand("visualbridge.test.getDocumentFacetSources");
    const entityFacet = (sources) => sources.find((entry) => entry.editor === "entity");
    const before = await state();
    assert.equal(before.trusted, true);
    assert.ok(before.evaluatedModuleIds.includes("visualbridge.entity"), "The trusted baseline must have loaded modules.");
    assert.ok(entityFacet(await facetSources()) !== undefined, "The entity facet must be registered while trusted.");
    try {
      // 只改 Trust 状态，不触发重载：随后用生产命令打开文档，让 ensureProject(force=false) 自己发现漂移。
      await vscode.commands.executeCommand("visualbridge.test.setModuleTrustWithoutReload", false);
      const disposedBefore = (await state()).disposedProjectKeys.length;
      await vscode.commands.executeCommand("visualbridge.openDocument", entityUri);

      const revoked = await state();
      assert.equal(revoked.trusted, false);
      // 生产路径只 `ensureProject` 被访问的那个 Project（VS Code 没有撤销 Trust 的事件），
      // 因此断言该 Project 的模块退出 `evaluatedModuleIds`，而不是要求整张表为空。
      assert.ok(
        !revoked.evaluatedModuleIds.includes("visualbridge.entity"),
        `The touched project must leave evaluatedModuleIds: ${JSON.stringify(revoked.evaluatedModuleIds)}`,
      );
      const entityModules = revoked.projects.find((entry) => entry.projectId === "visualbridge.entity-semantics").modules;
      for (const module of entityModules) {
        assert.equal(module.status, "untrusted", `Module '${module.id}' must be untrusted after revocation.`);
      }
      assert.equal(entityFacet(await facetSources()), undefined, "Revoking trust must unregister the entity facet.");
      assert.ok(
        revoked.disposedProjectKeys.slice(disposedBefore).includes(entityMarker),
        "The old loader of the revoked project must be disposed on the production path.",
      );
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.setModuleTrustWithoutReload", undefined);
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
    }
    const restored = await state();
    assert.equal(restored.trusted, true);
    assert.ok(restored.evaluatedModuleIds.includes("visualbridge.entity"), "Restoring trust must reload the modules again.");
  });

  await test("publishes the newest facet when a shared editor is reloaded", async () => {
    // P1-2：同一 editor 被多个 Project 声明时，重载其中一个必须让**新** bundle 的 facet 成为当前项，
    // 否则编辑器会话用新 facet、语义索引/Catalog/创建/引用重构仍用旧 facet。
    const projectRoot = path.join(workspacePath, "TableSemanticProject");
    const bundleUri = vscode.Uri.file(path.join(projectRoot, "Modules", "table.vbmodule.js"));
    const bundleBefore = await vscode.workspace.fs.readFile(bundleUri);
    const marker = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson")).toString();
    const facetSources = async () => vscode.commands.executeCommand("visualbridge.test.getDocumentFacetSources");
    const tableFacet = async () => (await facetSources()).find((entry) => entry.editor === "table");
    let previousHash;
    try {
      const initial = await tableFacet();
      assert.ok(initial?.current, "The table facet must be registered while trusted.");
      // 同一 editor 至少有 3 个 Project 声明（TestData 里的三个 Table 工程），这是本条的前提。
      assert.ok(initial.all.length >= 2, `Expected a shared editor, got ${JSON.stringify(initial.all)}`);
      assert.ok(initial.all.some((entry) => entry.ownerKey === marker), "The Table project must be one of the owners.");
      previousHash = initial.current.hash;

      const replaced = Buffer.concat([Buffer.from(bundleBefore), Buffer.from("\n/* facet version probe */\n")]);
      await vscode.workspace.fs.writeFile(bundleUri, replaced);
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");

      const reloaded = await tableFacet();
      assert.ok(reloaded?.current, "The table facet must stay registered after a reload.");
      assert.notEqual(reloaded.current.hash, previousHash, "The current facet must come from the new bundle.");
      assert.equal(reloaded.current.ownerKey, marker, "The reloaded Project's facet must win.");
      const stillOld = reloaded.all.find((entry) => entry.ownerKey !== marker);
      assert.ok(stillOld, "The other Projects' facets must stay registered as fallbacks.");

      // 撤销新条目后要回退到剩余条目，而不是变 undefined。
      const afterDispose = await vscode.commands.executeCommand("visualbridge.test.disposeProjectModulesForTest", marker);
      assert.equal(afterDispose, true, "Disposing the project modules must report success.");
      const fallback = await tableFacet();
      assert.ok(fallback?.current, "The table facet must fall back to another Project instead of disappearing.");
      assert.notEqual(fallback.current.ownerKey, marker, "The fallback must not be the disposed owner.");
    } finally {
      await vscode.workspace.fs.writeFile(bundleUri, bundleBefore);
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
      const restored = await tableFacet();
      assert.ok(restored?.current, "The restored module must publish its facet again.");
    }
  });

  await test("isolates a failed module and reports module.activateFailed at modules[i]", async () => {
    const projectRoot = path.join(workspacePath, "EntitySemanticProject");
    const markerUri = vscode.Uri.file(path.join(projectRoot, "VisualBridge.project.vbjson"));
    const entityUri = vscode.Uri.file(path.join(projectRoot, "Config", "Entities", "Player.herojson"));
    const epochBefore = (await vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot")).stats.epoch;
    try {
      // 先在模块可用时打开真实编辑器，验证"模块转 failed 后已有会话被关闭并回退只读"。
      await vscode.commands.executeCommand("visualbridge.openDocument", entityUri);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", entityUri),
        (ready) => ready === true,
        20_000,
        "The Entity editor did not open before the injected failure.",
      );
      assert.equal(
        (await vscode.commands.executeCommand("visualbridge.test.getReadonlyShellState", entityUri)).active,
        false,
      );

      await vscode.commands.executeCommand("visualbridge.test.setModuleActivationFailure", "visualbridge.entity");
      const state = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => {
          const project = value.projects.find((entry) => entry.projectId === "visualbridge.entity-semantics");
          return project?.modules[0]?.status === "failed" && project?.modules[1]?.status === "loaded";
        },
        20_000,
        "The injected activation failure did not isolate the entity module.",
      );
      const failed = state.projects
        .find((entry) => entry.projectId === "visualbridge.entity-semantics")
        .modules[0];
      assert.equal(failed.id, "visualbridge.entity");
      assert.equal(failed.diagnostics[0].path, "modules[0]");
      assert.ok(failed.diagnostics.some((diagnostic) => diagnostic.code === "module.activateFailed"));

      // 模块状态变化主动重建索引（P1），不依赖下一次编辑。
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getDocumentIndexSnapshot"),
        (snapshot) => snapshot.stats.epoch > epochBefore,
        20_000,
        "A module state change did not rebuild the Document Index.",
      );

      // 模块失效（dispose）后其 referenceData 必须离开语义快照：组件自引用不再出现在索引里。
      const incomingAfterFailure = await vscode.commands.executeCommand(
        "visualbridge.test.getDocumentBrowserIncomingReferences",
      );
      assert.equal(
        incomingAfterFailure.some((entry) => (
          entry.sourcePath === "Config/Entities/Player.herojson"
          && entry.occurrencePath === "properties.primaryComponentId"
        )),
        false,
        "A failed module still contributed referenceData to the semantic snapshot.",
      );

      // Problems 里定位到 modules[0] 条目，而不是整个文件第 0 行。
      const diagnostics = vscode.languages.getDiagnostics(markerUri);
      const activation = diagnostics.find((entry) => entry.code === "module.activateFailed");
      assert.ok(activation, "No module.activateFailed diagnostic was published on the Project File.");
      assert.match(activation.message, /^modules\[0\]: /u);
      const lines = (await readFile(markerUri.fsPath, "utf8")).split(/\r?\n/u);
      const located = lines.slice(activation.range.start.line, activation.range.end.line + 1).join("\n");
      assert.ok(
        located.includes("\"visualbridge.entity\""),
        `module.activateFailed was not located at modules[0]: ${located}`,
      );

      // 已有领域会话被关闭，同一文档回退只读 Shell；不建立领域会话（只读证据）。
      const shell = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getReadonlyShellState", entityUri),
        (value) => value?.active === true,
        20_000,
        "The Entity session was not replaced by the read-only shell after the module failed.",
      );
      assert.equal(shell.reason, "failed");
      assert.match(shell.message, /visualbridge\.entity/u);
      const entityState = await vscode.commands.executeCommand("visualbridge.test.getEntityEditorState", entityUri);
      assert.equal(entityState.sessionCount, 0);
      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.applyDocumentOperations", entityUri, "entity", []),
        /No active entity editor session/u,
      );
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

      // 同一 Project 的 table 模块不受影响。
      await assertEditorRoute(
        workspacePath,
        ["EntitySemanticProject", "Tables", "Skills_Main.skillstable"],
        "visualbridge.tableEditor",
        "visualbridge.openDocument",
      );
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.setModuleActivationFailure", undefined);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.projects
          .find((entry) => entry.projectId === "visualbridge.entity-semantics")
          ?.modules.every((module) => module.status === "loaded") === true,
        20_000,
        "The entity module did not recover after clearing the injected failure.",
      );
    }
  });

  await test("keeps a dirty Table editor open when its module becomes unavailable", async () => {
    const tableUri = vscode.Uri.file(path.join(
      workspacePath,
      "TableSemanticProject",
      "Tables",
      "Skills_A.csv",
    ));
    try {
      await withTimeout(
        vscode.commands.executeCommand("visualbridge.openDocument", tableUri),
        20_000,
        "The Table editor did not open.",
      );
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", tableUri),
        (ready) => ready === true,
        20_000,
        "The Table editor did not become ready.",
      );
      await vscode.commands.executeCommand("visualbridge.test.applyTableOperations", tableUri, [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "name",
        value: "Dirty Before Module Failure",
      }]);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getTableEditorState", tableUri),
        (state) => state?.dirty === true && state.panelCount === 1,
        20_000,
        "The Table edit did not mark the custom document dirty.",
      );

      await vscode.commands.executeCommand("visualbridge.test.setModuleActivationFailure", "visualbridge.table");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.projects
          .find((entry) => entry.projectId === "visualbridge.table-semantics")
          ?.modules.every((module) => module.status === "failed") === true,
        20_000,
        "The Table module was not marked failed.",
      );

      // dirty 的自定义文档没有 backup-on-dispose：模块失效时面板必须保留，不能静默丢编辑。
      await new Promise((resolve) => setTimeout(resolve, 500));
      const kept = await vscode.commands.executeCommand("visualbridge.test.getTableEditorState", tableUri);
      assert.equal(kept.panelCount, 1, "The dirty Table panel was disposed after its module failed.");
      assert.equal(kept.dirty, true);
      const shell = await vscode.commands.executeCommand("visualbridge.test.getTableReadonlyShellState", tableUri);
      assert.equal(shell.active, false, "The dirty Table panel was replaced by a read-only shell.");
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.setModuleActivationFailure", undefined);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.projects
          .find((entry) => entry.projectId === "visualbridge.table-semantics")
          ?.modules.every((module) => module.status === "loaded") === true,
        20_000,
        "The Table module did not recover after clearing the injected failure.",
      );
      await vscode.commands.executeCommand("workbench.action.files.revert").catch(() => undefined);
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
    }
  });

  await test("falls back to a read-only shell when no module declares the editor", async () => {
    const projectRoot = vscode.Uri.file(path.join(workspacePath, "UncoveredShellProject"));
    const markerUri = vscode.Uri.joinPath(projectRoot, "VisualBridge.project.vbjson");
    const documentUri = vscode.Uri.joinPath(projectRoot, "Config", "Sample.fixtureconfig");
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(projectRoot, "Config"));
      await vscode.workspace.fs.writeFile(markerUri, new TextEncoder().encode(`${JSON.stringify({
        formatVersion: 2,
        projectId: "visualbridge.b1.shell-fixture",
        documentRoots: ["Config"],
        modules: [],
        documentTypes: [{
          id: "shell.fixture",
          editor: "structured",
          include: ["Config/**/*.fixtureconfig"],
          exclude: [],
          catalogs: [],
        }],
      }, undefined, 2)}\n`));
      await vscode.workspace.fs.writeFile(
        documentUri,
        new TextEncoder().encode("{\n  \"formatVersion\": 1\n}\n"),
      );
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.projects.some((entry) => entry.projectId === "visualbridge.b1.shell-fixture"),
        20_000,
        "The shell fixture project was not discovered.",
      );
      await vscode.commands.executeCommand("visualbridge.openDocument", documentUri);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", documentUri),
        (ready) => ready === true,
        20_000,
        "The undeclared-module shell did not become ready.",
      );
      const shell = await vscode.commands.executeCommand("visualbridge.test.getReadonlyShellState", documentUri);
      assert.equal(shell.active, true);
      assert.equal(shell.reason, "undeclared");
      assert.match(shell.message, /未声明/u);
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

      const diagnostics = vscode.languages.getDiagnostics(markerUri);
      const undeclared = diagnostics.find((entry) => entry.code === "module.notFound");
      assert.ok(undeclared, "No documentTypes[].editor diagnostic was published for the undeclared editor.");
      assert.match(undeclared.message, /^documentTypes\[0\]\.editor: /u);
    } finally {
      // 先移除文档与 Project File，等文件监视器收敛后再删目录，避免 VS Code 对已删目录的 scandir 噪声。
      await vscode.workspace.fs.delete(documentUri, { useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(markerUri, { useTrash: false }).then(undefined, () => undefined);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.workspace.fs.delete(projectRoot, { recursive: true, useTrash: false }).then(undefined, () => undefined);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
    }
  });

  await test("shows module status and the first 12 hash characters in Project Settings", async () => {
    const markerUri = vscode.Uri.file(path.join(
      workspacePath,
      "StructuredSemanticProject",
      "VisualBridge.project.vbjson",
    ));
    const before = await vscode.workspace.fs.readFile(markerUri);
    const tableHash = `sha256:${"ab12cd34ef56".repeat(5)}7890`;
    try {
      const definition = JSON.parse(new TextDecoder().decode(before));
      definition.modules.find((module) => module.id === "visualbridge.table").hash = tableHash;
      await vscode.workspace.fs.writeFile(markerUri, new TextEncoder().encode(`${JSON.stringify(definition, undefined, 2)}\n`));
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState"),
        (value) => value.projects
          .find((entry) => entry.projectId === "visualbridge.structured-semantics")
          ?.modules.find((module) => module.id === "visualbridge.table")?.hash === tableHash,
        20_000,
        "The declared module hash was not recorded by the registry.",
      );
      await vscode.commands.executeCommand("vscode.openWith", markerUri, "visualbridge.projectSettingsEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", markerUri),
        (ready) => ready === true,
        20_000,
        "Project Settings did not become ready.",
      );
      const settings = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getProjectSettingsState", markerUri),
        (state) => state?.modules?.length === 2,
        20_000,
        "Project Settings did not expose module runtime state.",
      );
      const table = settings.modules.find((module) => module.id === "visualbridge.table");
      // C2：hash 由 ModuleLoader 逐字节校验（B1 只记录不比对）。声明的 hash 与 bundle 字节不符
      // 时模块按 D.1 语义停用（disabled），并在 Project File 的 modules[].hash 上给出诊断。
      assert.equal(table.status, "disabled");
      assert.equal(table.hash, tableHash);
      assert.equal(table.hashShort, "ab12cd34ef56");
      assert.equal(
        vscode.languages.getDiagnostics(markerUri).filter((entry) => entry.code === "module.hashMismatch").length,
        1,
        "A declared module hash that differs from the bundle bytes must produce one module.hashMismatch.",
      );
      const structured = settings.modules.find((module) => module.id === "visualbridge.structured");
      assert.equal(structured.hash, undefined);
      assert.equal(structured.hashShort, "");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } finally {
      await vscode.workspace.fs.writeFile(markerUri, before);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  await test("shares the Editor Bridge parity fixture with the schema and Unity validators", async () => {
    const fixturePath = path.join(__dirname, "..", "..", "..", "..",
      "Packages", "com.kyle.visualbridge", "Tests", "Fixtures", "visualbridge-editor-bridge-cases.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0);
    for (const testCase of fixture.cases) {
      const command = testCase.target === "discoveryRecord"
        ? "visualbridge.test.parseBridgeDiscoveryRecord"
        : "visualbridge.test.parseBridgeMessage";
      const result = await vscode.commands.executeCommand(command, testCase.value);
      if (testCase.valid) {
        assert.equal(result.ok, true, `${testCase.label}: expected a valid parse.`);
      } else {
        assert.equal(result.ok, false, `${testCase.label}: expected an invalid parse.`);
        assert.equal(result.code, testCase.loaderCode, `${testCase.label}: error code mismatch.`);
      }
    }
  });

  await test("shares the Graph Catalog parity fixture with the schema and Unity validators", async () => {
    const fixturePath = path.join(__dirname, "..", "..", "..", "..",
      "Packages", "com.kyle.visualbridge", "Tests", "Fixtures", "visualbridge-graph-catalog-cases.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 12);
    for (const testCase of fixture.cases) {
      const result = await vscode.commands.executeCommand("visualbridge.test.parseCatalog", "graph", testCase.value);
      if (testCase.valid) {
        assert.equal(result.ok, true, `${testCase.label}: expected a valid parse.`);
      } else {
        assert.equal(result.ok, false, `${testCase.label}: expected an invalid parse.`);
      }
    }
  });

  await test("shares the Runtime Bridge parity fixture with the schema and Unity validators", async () => {
    const fixturePath = path.join(__dirname, "..", "..", "..", "..",
      "Packages", "com.kyle.visualbridge", "Tests", "Fixtures", "visualbridge-runtime-bridge-cases.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 12);
    for (const testCase of fixture.cases) {
      const command = testCase.target === "discoveryRecord"
        ? "visualbridge.test.parseRuntimeBridgeDiscoveryRecord"
        : "visualbridge.test.parseRuntimeBridgeMessage";
      const result = await vscode.commands.executeCommand(command, testCase.value);
      if (testCase.valid) {
        assert.equal(result.ok, true, `${testCase.label}: expected a valid parse.`);
      } else {
        assert.equal(result.ok, false, `${testCase.label}: expected an invalid parse.`);
        assert.equal(result.code, testCase.loaderCode, `${testCase.label}: error code mismatch.`);
      }
    }
  });

  await test("runs the Editor Bridge discovery record, handshake, open, and reveal", async () => {
    const state = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getBridgeServerState"),
      (value) => value !== null && value !== undefined,
      20_000,
      "Editor Bridge server did not start during activation.",
    );

    const record = JSON.parse(await readFile(state.recordPath, "utf8"));
    assert.equal(record.formatVersion, 2);
    assert.equal(record.protocolVersion, 4);
    assert.equal(record.role, "vscode");
    assert.equal(record.windowId, state.windowId);
    assert.equal(record.token, state.token);
    assert.equal(record.pid, process.pid);
    assert.equal(record.generation, state.generation);
    assert.equal(state.sessionId, `${state.windowId}#${state.bootId}`);
    assert.match(record.token, /^[0-9a-f]{48,64}$/);
    assert.equal("capabilities" in record, false, "Discovery record v2 must not publish the removed capabilities field.");
    assert.equal("startedAt" in record, false, "Discovery record v2 heartbeat is mtime, not startedAt.");
    assert.ok(record.tcpPort >= 1 && record.tcpPort <= 65535);
    const structuredRoot = normalizeFileSystemPath(path.join(workspacePath, "StructuredSemanticProject")).replaceAll("\\", "/");
    assert.ok(record.projectRoots.some((root) => normalizeFileSystemPath(root).replaceAll("\\", "/") === structuredRoot),
      `Discovery record project roots miss the structured project: ${JSON.stringify(record.projectRoots)}`);

    const connectBridge = async () => {
      const socket = net.connect({ host: "127.0.0.1", port: state.tcpPort });
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const lines = [];
      attachJsonReader(socket, (message) => lines.push(message));
      return {
        socket,
        lines,
        send: (message) => sendJson(socket, message),
        sendRaw: (line) => socket.write(encodeFrame(0, KIND_JSON, Buffer.from(line, "utf8"))),
        waitForLine: async (predicate, message) => {
          await waitForAsync(() => lines.find(predicate), (value) => value !== undefined, 20_000, message);
          return lines.find(predicate);
        },
      };
    };
    // 指纹跟服务端发布值走：约定 ArtifactsRoot 里一旦有契约产物，监听方指纹就不再是空串，
    // 默认 hello 必须用它才算"匹配"，否则每个用例都会静默走降级分支。
    const hello = (token, overrides = {}) => ({
      type: "hello",
      protocolVersion: 4,
      role: "editor",
      clientEndpointId: "editor-1234",
      token,
      contractHash: state.contractHash,
      payloads: ["json", "binary"],
      ...overrides,
    });
    // 抖动一位十六进制：用它证明"不匹配"判定真的来自契约注册表，而不是写死的字符串。
    const flipHex = (value) => `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;
    const probeHash = state.contractHash.length === 0 ? "a".repeat(16) : flipHex(state.contractHash);

    // 无效 token 以连接级错误拒绝。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello("0".repeat(48)));
        const errorLine = await connection.waitForLine(
          (line) => line.type === "error", "Bridge server did not reject an invalid token.");
        assert.equal(errorLine.code, "runtime.invalidToken");
      } finally {
        connection.socket.destroy();
      }
    }

    // 方向层：监听方是 vscode，拨号方必须声明 editor。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello(state.token, { role: "vscode" }));
        const errorLine = await connection.waitForLine(
          (line) => line.type === "error", "Bridge server did not reject a role mismatch.");
        assert.equal(errorLine.code, "runtime.roleMismatch");
      } finally {
        connection.socket.destroy();
      }
    }

    // 载荷协商：缺少 json 或以纯 binary 声明时拒绝。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello(state.token, { payloads: ["binary"] }));
        const errorLine = await connection.waitForLine(
          (line) => line.type === "error", "Bridge server did not reject an unsupported payload set.");
        assert.equal(errorLine.code, "runtime.unsupportedPayload");
      } finally {
        connection.socket.destroy();
      }
    }

    // 非 JSON 行以 invalidJson 拒绝。
    {
      const connection = await connectBridge();
      try {
        connection.sendRaw("{not json");
        const errorLine = await connection.waitForLine(
          (line) => line.type === "error", "Bridge server did not reject a non-JSON line.");
        assert.equal(errorLine.code, "bridge.invalidJson");
      } finally {
        connection.socket.destroy();
      }
    }

    // 首条消息不是 hello 时以 unknownMessageType 拒绝。
    {
      const connection = await connectBridge();
      try {
        connection.send({ type: "open", requestId: "bridge-premature-1", documentPath: "Config/Game.gamesettings" });
        const errorLine = await connection.waitForLine(
          (line) => line.type === "error", "Bridge server did not reject a premature request.");
        assert.equal(errorLine.code, "bridge.unknownMessageType");
      } finally {
        connection.socket.destroy();
      }
    }

    // 正常握手、文档 open、未命中 open 与 Reference reveal。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello(state.token));
        const welcome = await connection.waitForLine(
          (line) => line.type === "welcome", "Bridge server did not answer the hello handshake.");
        assert.equal(welcome.protocolVersion, 4);
        assert.equal(welcome.endpointId, state.windowId);
        assert.equal(welcome.sessionId, state.sessionId);
        // generation 每次传输 +1：前面的拒绝探针各消耗一次，只要求不落后于记录。
        assert.ok(welcome.generation >= state.generation);
        assert.equal(welcome.connectType, "editor");
        assert.deepEqual(welcome.payloads, ["json", "binary"]);
        assert.equal(welcome.contractHash, state.contractHash);
        assert.equal(welcome.resumed, false);

        // 一对一约束：第二条连接被拒，且不影响已建立的连接。
        {
          const second = await connectBridge();
          try {
            second.send(hello(state.token));
            const errorLine = await second.waitForLine(
              (line) => line.type === "error", "Bridge server did not reject a second connection.");
            assert.equal(errorLine.code, "runtime.alreadyConnected");
          } finally {
            second.socket.destroy();
          }
        }

        connection.send({ type: "open", requestId: "bridge-open-1", documentPath: "Config/Missing.gamesettings" });
        const unresolved = await connection.waitForLine(
          (line) => line.type === "response" && line.requestId === "bridge-open-1",
          "Bridge server did not answer the unresolved open request.");
        assert.equal(unresolved.status, "error");
        assert.equal(unresolved.error, "bridge.documentUnresolved");

        connection.send({ type: "open", requestId: "bridge-open-2", documentPath: "Config/Game.gamesettings" });
        const opened = await connection.waitForLine(
          (line) => line.type === "response" && line.requestId === "bridge-open-2",
          "Bridge server did not answer the open request.");
        assert.equal(opened.status, "ok");
        const structuredUri = vscode.Uri.file(path.join(
          workspacePath, "StructuredSemanticProject", "Config", "Game.gamesettings"));
        await waitForAsync(
          () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", structuredUri),
          (ready) => ready === true,
          20_000,
          "Bridge open request did not open the structured editor.",
        );
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

        // Reference 101 同时出现在 Structured 与 Entity 两个 Project；
        // 冻结设计要求显式的歧义错误而不是猜测。
        connection.send({ type: "reveal", requestId: "bridge-reveal-ambiguous", reference: 101 });
        const ambiguous = await connection.waitForLine(
          (line) => line.type === "response" && line.requestId === "bridge-reveal-ambiguous",
          "Bridge server did not answer the ambiguous reveal request.");
        assert.equal(ambiguous.status, "error");
        assert.equal(ambiguous.error, "bridge.documentAmbiguous");

        // entity component 引用 'health' 可唯一解析。
        connection.send({ type: "reveal", requestId: "bridge-reveal-1", reference: "health" });
        const revealed = await connection.waitForLine(
          (line) => line.type === "response" && line.requestId === "bridge-reveal-1",
          "Bridge server did not answer the reveal request.");
        assert.equal(revealed.status, "ok");
        const entityUri = vscode.Uri.file(path.join(
          workspacePath, "EntitySemanticProject", "Config", "Entities", "Player.herojson"));
        await waitForAsync(
          () => vscode.commands.executeCommand("visualbridge.test.getEntityEditorState", entityUri),
          (value) => value?.lastRevealResults?.some((result) => (
            result.found === true && result.target.componentId === "health"
          )),
          20_000,
          "Bridge reveal request did not reveal the referenced entity component.",
        );
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      } finally {
        connection.socket.destroy();
      }
    }

    // 指纹层：两侧 hash 不同仍建立连接，welcome.payloads 去掉 binary，且回发监听方指纹。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello(state.token, { contractHash: probeHash }));
        const welcome = await connection.waitForLine(
          (line) => line.type === "welcome", "Bridge server did not complete a mismatched-fingerprint handshake.");
        assert.equal(welcome.contractHash, state.contractHash);
        assert.deepEqual(welcome.payloads, ["json"]);
      } finally {
        connection.socket.destroy();
      }
    }

    // 会话续接：resumeSessionId 与服务端当前 sessionId 相同时 resumed=true。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello(state.token, { resumeSessionId: state.sessionId }));
        const welcome = await connection.waitForLine(
          (line) => line.type === "welcome", "Bridge server did not complete a resumed handshake.");
        assert.equal(welcome.resumed, true);
        assert.equal(welcome.sessionId, state.sessionId);
      } finally {
        connection.socket.destroy();
      }
    }

    // 不匹配的 resumeSessionId 必须安全起新会话：resumed=false，sessionId 仍为当前会话。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello(state.token, { resumeSessionId: `${state.windowId}#other-boot` }));
        const welcome = await connection.waitForLine(
          (line) => line.type === "welcome", "Bridge server did not complete a fresh handshake.");
        assert.equal(welcome.resumed, false);
        assert.equal(welcome.sessionId, state.sessionId);
      } finally {
        connection.socket.destroy();
      }
    }

    // 契约注册表：工作区里出现 Unity 工程根 + 约定 ArtifactsRoot 产物后，监听方指纹就变成
    // 产物里的 contractHash（无需任何设置项）；产物被删掉后回到空串。这里在临时工作区里
    // 造一份真实布局，验证"按约定定位 + 热更新"而不是断言某个写死的值。
    {
      const unityVersionPath = path.join(workspacePath, "ProjectSettings", "ProjectVersion.txt");
      const contractDirectory = path.join(workspacePath, "Assets", "VisualBridgeGenerated", "Debug");
      const contractPath = path.join(contractDirectory, "debug-contracts.json");
      const fixturePath = path.join(__dirname, "..", "..", "..", "..",
        "TestData", "DebugContracts", "UnityProject", "Assets", "VisualBridgeGenerated", "Debug", "debug-contracts.json");
      const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
      const expectedHash = fixture.contractHash;
      assert.match(expectedHash, /^[0-9a-f]{16}$/, "The fixture must carry a real 16-hex contract fingerprint.");
      const readState = () => vscode.commands.executeCommand("visualbridge.test.getBridgeServerState");
      try {
        await fsPromises.mkdir(contractDirectory, { recursive: true });
        await fsPromises.mkdir(path.dirname(unityVersionPath), { recursive: true });
        await writeFile(unityVersionPath, "m_EditorVersion: 6000.3.10f1\n", "utf8");
        await writeFile(contractPath, await readFile(fixturePath, "utf8"), "utf8");

        const located = await waitForAsync(
          readState,
          (value) => value?.contractHash === expectedHash,
          20_000,
          "The bridge server did not adopt debug-contracts.json from the conventional ArtifactsRoot.",
        );
        assert.equal(located.contractHash, expectedHash);

        // 命中时保留 binary 数据面，并把命中的指纹回给客户端。
        {
          const matched = await connectBridge();
          try {
            matched.send(hello(located.token, { contractHash: expectedHash }));
            const welcome = await matched.waitForLine(
              (line) => line.type === "welcome", "Bridge server did not complete a matched-fingerprint handshake.");
            assert.equal(welcome.contractHash, expectedHash);
            assert.deepEqual(welcome.payloads, ["json", "binary"]);
          } finally {
            matched.socket.destroy();
          }
        }

        // 抖动一位仍是"不匹配"：连接保留，只降级数据面（A.3）。
        {
          const mismatch = await connectBridge();
          try {
            mismatch.send(hello(located.token, { contractHash: flipHex(expectedHash) }));
            const welcome = await mismatch.waitForLine(
              (line) => line.type === "welcome", "Bridge server did not complete a mismatched-fingerprint handshake.");
            assert.equal(welcome.contractHash, expectedHash);
            assert.deepEqual(welcome.payloads, ["json"]);
          } finally {
            mismatch.socket.destroy();
          }
        }
      } finally {
        await rm(contractPath, { force: true });
        await rm(unityVersionPath, { force: true });
        await rm(path.join(workspacePath, "Assets"), { recursive: true, force: true });
        await rm(path.join(workspacePath, "ProjectSettings"), { recursive: true, force: true });
        const restored = await waitForAsync(
          readState,
          (value) => value?.contractHash === "",
          20_000,
          "The bridge server kept the contract fingerprint after the artifacts disappeared.",
        );
        assert.equal(restored.contractHash, "");
      }
    }
  });

  await test("rejects a malformed debugEnabled broadcast sent by Unity", async () => {
    // 握手后收到缺 enabled 的 debugEnabled：监听侧必须回 error 帧并断开，
    // 不能把一条状态广播静默当未知消息放过去（形状按 schema 严格校验）。
    const state = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getBridgeServerState"),
      (value) => value !== null && value !== undefined,
      20_000,
      "Editor Bridge server did not start during activation.",
    );
    const socket = net.connect({ host: "127.0.0.1", port: state.tcpPort });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const lines = [];
    attachJsonReader(socket, (message) => lines.push(message));
    const closed = new Promise((resolve) => socket.once("close", () => resolve(true)));
    try {
      sendJson(socket, {
        type: "hello",
        protocolVersion: 4,
        role: "editor",
        clientEndpointId: "editor-malformed-debug-enabled",
        token: state.token,
        contractHash: state.contractHash,
        payloads: ["json", "binary"],
      });
      await waitForAsync(
        () => lines.find((line) => line.type === "welcome"),
        (value) => value !== undefined,
        20_000,
        "Bridge server did not complete the handshake.",
      );
      sendJson(socket, { type: "debugEnabled" });
      const errorLine = await waitForAsync(
        () => lines.find((line) => line.type === "error"),
        (value) => value !== undefined,
        20_000,
        "Bridge server did not reject a malformed debugEnabled broadcast.",
      );
      assert.equal(errorLine.code, "bridge.invalidMessage",
        "缺 enabled 的 debugEnabled 必须按 schema 形状拒绝，而不是被当成未知消息放过。");
      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("The bridge server kept the connection open after a malformed debugEnabled broadcast.")),
          10_000)),
      ]);
    } finally {
      socket.destroy();
    }
  });

  await test("rejects Authoring files that resolve outside the Project through a directory link", async () => {
    const externalRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-outside-authoring-"));
    const linkedRoot = path.join(workspacePath, "StructuredSemanticProject", "Config", "OutsideLink");
    const externalDocument = path.join(externalRoot, "Outside.gamesettings");
    await writeFile(externalDocument, "{}\n", "utf8");
    let linkCreated = false;
    try {
      await symlink(externalRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
      linkCreated = true;
      const match = await vscode.commands.executeCommand(
        "visualbridge.test.resolveDocument",
        vscode.Uri.file(path.join(linkedRoot, "Outside.gamesettings")),
      );
      assert.equal(match, undefined);
    } finally {
      if (linkCreated) await unlink(linkedRoot);
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  await test("attaches a VisualBridge runtime inspection debug session", async () => {
    // 宿主测试没有 Unity：起一个按协议实现的假 Runtime 实例驱动 DAP 只检查会话。
    const instanceId = `editor-${process.pid}`;
    const discoveryDirectory = await mkdtemp(path.join(tmpdir(), "visualbridge-runtime-debug-"));
    const recordPath = path.join(discoveryDirectory, `${instanceId}.json`);
    const token = createHash("sha256").update(`runtime-debug-${instanceId}`).digest("hex");
    const startedAt = new Date().toISOString();
    const capabilities = ["snapshot", "events", "lease", "sources"];
    const documents = [
      {
        documentTypeId: "test.debug.hero",
        documentId: "test.debug.hero.default",
        kind: "visualbridge.entity.compiled",
        data: { properties: { name: "Ranger", hp: 100 }, tags: ["alpha", "beta"] },
      },
      {
        documentTypeId: "test.debug.settings",
        documentId: "test.debug.settings.default",
        kind: "visualbridge.structured.compiled",
        data: { properties: { maxPlayers: 5 } },
      },
    ];
    const sources = [
      {
        documentTypeId: "test.debug.hero",
        documentId: "test.debug.hero.default",
        sourcePath: "Entities/TestDebugHero.vbentity",
        sourceSha256: "1".repeat(64),
      },
      {
        documentTypeId: "test.debug.settings",
        documentId: "test.debug.settings.default",
        sourcePath: "Config/TestDebugSettings.gamesettings",
        sourceSha256: "2".repeat(64),
      },
    ];
    const actions = [];
    let leaseHolder = null;
    const send = (socket, message) => sendJson(socket, message);
    const server = net.createServer((socket) => {
      let handshake = false;
      attachJsonReader(socket, (message) => {
          if (!handshake) {
            if (message.type === "hello" && message.token === token && message.protocolVersion === 4
              && message.role === "vscode" && Array.isArray(message.payloads)) {
              handshake = true;
              send(socket, createRuntimeWelcome({ instanceId, startedAt }));
            } else {
              send(socket, { type: "error", code: "runtime.invalidToken" });
              socket.destroy();
            }
            return;
          }

          if (message.type !== "request") return;
          actions.push({ action: message.action });
          if (message.action === "getSnapshot") {
            send(socket, { type: "response", requestId: message.requestId, status: "ok", documents });
          } else if (message.action === "acquireLease") {
            if (leaseHolder !== null && leaseHolder !== socket) {
              send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.leaseDenied" });
            } else {
              leaseHolder = socket;
              send(socket, { type: "response", requestId: message.requestId, status: "ok" });
            }
          } else if (message.action === "releaseLease") {
            if (leaseHolder === socket) {
              leaseHolder = null;
              send(socket, { type: "response", requestId: message.requestId, status: "ok" });
            } else {
              send(socket, {
                type: "response",
                requestId: message.requestId,
                status: "error",
                error: leaseHolder === null ? "runtime.leaseNotHeld" : "runtime.leaseDenied",
              });
            }
          } else if (message.action === "getDocumentSources") {
            if (leaseHolder !== socket) {
              send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.leaseRequired" });
            } else {
              send(socket, { type: "response", requestId: message.requestId, status: "ok", sources });
            }
          } else {
            send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.unknownRequest" });
          }
      });
      // 断线自动释放租约（对齐 §18.3 单控制者语义）。
      socket.on("close", () => {
        if (leaseHolder === socket) leaseHolder = null;
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tcpPort = server.address().port;
    const writeRecord = () => writeFile(recordPath, `${JSON.stringify({
      formatVersion: 1,
      protocolVersion: 4,
      coreVersion: 1,
      instanceId,
      kind: "editor-play",
      capabilities,
      tcpPort,
      token,
      pid: process.pid,
      generation: 1,
      startedAt,
    })}\n`, "utf8");
    await writeRecord();
    const heartbeat = setInterval(() => {
      void writeRecord();
    }, 2000);

    const previousRuntimeDirectory = process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
    process.env.VISUALBRIDGE_TEST_RUNTIME_DIR = discoveryDirectory;
    try {
      const instances = await vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances");
      const instance = instances.find((entry) => entry.instanceId === instanceId);
      assert.ok(instance, "The fake runtime instance was not enumerated.");
      assert.equal(instance.staleReason, undefined, "The fresh fake runtime instance must not be classified as stale.");

      const session = await vscode.commands.executeCommand("visualbridge.test.attachRuntimeInstance", instance);
      assert.equal(session.type, "visualbridge-runtime");
      const state = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getRuntimeDebugSessionState"),
        (value) => value?.connected === true && value?.leaseHeld === true && value?.documents === 2,
        20_000,
        "The VisualBridge runtime inspection session did not attach.",
      );
      assert.equal(state.instanceId, instanceId);
      assert.equal(state.topLevelVariables, 2, "Top-level variables must mirror the runtime document list.");
      // 宿主工作区没有 UnityProject 文件夹：漂移只能判 unknown，绝不能误报 true。
      assert.equal(state.driftedDocuments, 0);
      assert.equal(state.unknownSourceDocuments, 2);

      await vscode.debug.stopDebugging(session);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getRuntimeDebugSessionState"),
        (value) => value?.connected !== true && value?.leaseHeld !== true && value?.documents === 0,
        20_000,
        "The VisualBridge runtime inspection session did not disconnect.",
      );
      assert.ok(
        actions.some((entry) => entry.action === "releaseLease"),
        "The fake runtime instance did not receive releaseLease on disconnect.",
      );

      // 租约确实已释放：第二个客户端可立即 acquire。
      const second = net.connect({ host: "127.0.0.1", port: tcpPort });
      try {
        await new Promise((resolve, reject) => {
          second.once("connect", resolve);
          second.once("error", reject);
        });
        const lines = [];
        attachJsonReader(second, (message) => lines.push(message));
        send(second, createRuntimeHello({ token, clientEndpointId: "vscode-test-second" }));
        await waitForAsync(
          () => lines.find((line) => line.type === "welcome"),
          (value) => value !== undefined,
          10_000,
          "The second client did not complete the handshake.",
        );
        send(second, { type: "request", requestId: "runtime-debug-second-lease", action: "acquireLease" });
        const leaseResponse = await waitForAsync(
          () => lines.find((line) => line.type === "response" && line.requestId === "runtime-debug-second-lease"),
          (value) => value !== undefined,
          10_000,
          "The second client did not receive an acquireLease response.",
        );
        assert.equal(leaseResponse.status, "ok", "The released lease must be acquirable by a second client.");
      } finally {
        second.destroy();
      }
    } finally {
      clearInterval(heartbeat);
      if (previousRuntimeDirectory === undefined) delete process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
      else process.env.VISUALBRIDGE_TEST_RUNTIME_DIR = previousRuntimeDirectory;
      await new Promise((resolve) => server.close(resolve));
      await rm(discoveryDirectory, { recursive: true, force: true });
    }
  });

  await test("subscribes to graph execution and records the session", async () => {
    // 假 Runtime 实例实现 graphExecution 语义：实例枚举/订阅/浅快照/批量事件推送。
    const instanceId = `editor-${process.pid}`;
    const discoveryDirectory = await mkdtemp(path.join(tmpdir(), "visualbridge-runtime-graph-exec-"));
    const recordPath = path.join(discoveryDirectory, `${instanceId}.json`);
    const token = createHash("sha256").update(`graph-exec-${instanceId}`).digest("hex");
    const startedAt = new Date().toISOString();
    const capabilities = ["snapshot", "events", "lease", "sources", "graphExecution"];
    const executionInstance = {
      executionId: "exec-1",
      documentTypeId: "test.graph.encounter",
      documentId: "test.graph.encounter.default",
      graphName: "Encounter",
      debugKey: "hero-01",
      state: "running",
      currentNodeId: null,
      frameIndex: 0,
    };
    let executionActive = true;
    const subscribers = new Set();
    const actions = [];
    const send = (socket, message) => sendJson(socket, message);
    const pushBatch = (events) => {
      for (const socket of subscribers) {
        send(socket, { type: "event", event: "graphExecution", executionEvents: events });
      }
    };
    const server = net.createServer((socket) => {
      let handshake = false;
      attachJsonReader(socket, (message) => {
          if (!handshake) {
            if (message.type === "hello" && message.token === token && message.protocolVersion === 4
              && message.role === "vscode" && Array.isArray(message.payloads)) {
              handshake = true;
              send(socket, createRuntimeWelcome({ instanceId, startedAt }));
            } else {
              send(socket, { type: "error", code: "runtime.invalidToken" });
              socket.destroy();
            }
            return;
          }

          if (message.type !== "request") return;
          actions.push({ action: message.action });
          if (message.action === "getGraphExecutionInstances") {
            const executions = executionActive
              && (message.documentId === undefined || message.documentId === executionInstance.documentId)
                ? [executionInstance]
                : [];
            send(socket, { type: "response", requestId: message.requestId, status: "ok", executions });
          } else if (message.action === "getGraphExecutionSnapshot") {
            if (executionActive && message.executionId === "exec-1") {
              send(socket, { type: "response", requestId: message.requestId, status: "ok", execution: executionInstance });
            } else {
              send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.executionNotFound" });
            }
          } else if (message.action === "subscribeGraphExecution") {
            if (executionActive && message.executionId === "exec-1") {
              subscribers.add(socket);
              send(socket, { type: "response", requestId: message.requestId, status: "ok" });
              send(socket, {
                type: "event",
                event: "graphExecution",
                executionEvents: [{ executionId: "exec-1", frameIndex: 0, kind: "instanceStarted" }],
              });
            } else {
              send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.executionNotFound" });
            }
          } else if (message.action === "unsubscribeGraphExecution") {
            subscribers.delete(socket);
            send(socket, { type: "response", requestId: message.requestId, status: "ok" });
          } else {
            send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.unknownRequest" });
          }
      });
      socket.on("close", () => {
        subscribers.delete(socket);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tcpPort = server.address().port;
    const writeRecord = () => writeFile(recordPath, `${JSON.stringify({
      formatVersion: 1,
      protocolVersion: 4,
      coreVersion: 1,
      instanceId,
      kind: "editor-play",
      capabilities,
      tcpPort,
      token,
      pid: process.pid,
      generation: 1,
      startedAt,
    })}\n`, "utf8");
    await writeRecord();
    const heartbeat = setInterval(() => {
      void writeRecord();
    }, 2000);

    const previousRuntimeDirectory = process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
    process.env.VISUALBRIDGE_TEST_RUNTIME_DIR = discoveryDirectory;
    let observer;
    try {
      const instances = await vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances");
      const instance = instances.find((entry) => entry.instanceId === instanceId);
      assert.ok(instance, "The fake runtime instance was not enumerated.");
      const welcome = await vscode.commands.executeCommand("visualbridge.test.connectRuntimeInstance", instance);
      // 握手统一（附录 A.3）：welcome 是 endpointId/sessionId/connectType，不再协商 capabilities。
      assert.deepEqual([...welcome.payloads], ["json"]);
      assert.equal(welcome.instanceId, instanceId);
      assert.equal(welcome.kind, "editor-player");
      assert.equal(welcome.sessionId, runtimeSessionId(instanceId));
      assert.equal(welcome.resumed, false);

      // 实例枚举：documentId 过滤。
      const unfiltered = await vscode.commands.executeCommand("visualbridge.test.getGraphExecutionInstances");
      assert.equal(unfiltered.length, 1);
      assert.equal(unfiltered[0].executionId, "exec-1");
      const filtered = await vscode.commands.executeCommand(
        "visualbridge.test.getGraphExecutionInstances", "test.graph.encounter.default");
      assert.equal(filtered.length, 1);
      const excluded = await vscode.commands.executeCommand(
        "visualbridge.test.getGraphExecutionInstances", "other.document");
      assert.equal(excluded.length, 0);

      // 浅快照：活跃 ok、未知实例 executionNotFound。
      const snapshot = await vscode.commands.executeCommand("visualbridge.test.getGraphExecutionSnapshot", "exec-1");
      assert.equal(snapshot.state, "running");
      await assert.rejects(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphExecutionSnapshot", "exec-404"),
        (errorValue) => String(errorValue).includes("runtime.executionNotFound"));

      // 第二个观察者（裸 TCP）：多客户端并行观察不占租约（观察者语义）。
      observer = net.connect({ host: "127.0.0.1", port: tcpPort });
      await new Promise((resolve, reject) => {
        observer.once("connect", resolve);
        observer.once("error", reject);
      });
      const observerLines = [];
      attachJsonReader(observer, (message) => observerLines.push(message));
      send(observer, createRuntimeHello({ token, clientEndpointId: "vscode-test-observer" }));
      await waitForAsync(
        () => observerLines.find((line) => line.type === "welcome"),
        (value) => value !== undefined,
        10_000,
        "The observer client did not complete the handshake.",
      );
      send(observer, { type: "request", requestId: "graph-exec-observer-sub", action: "subscribeGraphExecution", executionId: "exec-1" });

      // 服务侧订阅：记录以合成 instanceStarted 开流。
      const subscribed = await vscode.commands.executeCommand("visualbridge.test.subscribeGraphExecution", "exec-1");
      assert.equal(subscribed.executionId, "exec-1");
      assert.equal(subscribed.graphName, "Encounter");
      assert.equal(subscribed.debugKey, "hero-01");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphExecutionRecording"),
        (value) => value !== null && value.eventCount >= 1,
        10_000,
        "The synthetic instanceStarted event was not recorded.",
      );
      let recording = await vscode.commands.executeCommand("visualbridge.test.getGraphExecutionRecording");
      assert.equal(recording.events[0].kind, "instanceStarted");
      assert.equal(recording.stopped, false);

      // 批量事件（含乱序帧号）：记录保持到达顺序。
      pushBatch([
        { executionId: "exec-1", frameIndex: 5, kind: "nodeStart", nodeId: "node.entry" },
        { executionId: "exec-1", frameIndex: 5, kind: "nodeOutput", nodeId: "node.entry", outputIndex: 0 },
        { executionId: "exec-1", frameIndex: 6, kind: "edgeValueChanged", nodeId: "node.entry", outputIndex: 1, value: "42" },
      ]);
      pushBatch([
        { executionId: "exec-1", frameIndex: 8, kind: "nodeStart", nodeId: "node.branch" },
        { executionId: "exec-1", frameIndex: 7, kind: "dataNode", nodeId: "node.value" },
      ]);
      recording = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphExecutionRecording"),
        (value) => value.eventCount === 6,
        10_000,
        "The execution event batches were not recorded.",
      );
      assert.deepEqual(
        recording.events.map((event) => `${event.frameIndex}:${event.kind}`),
        ["0:instanceStarted", "5:nodeStart", "5:nodeOutput", "6:edgeValueChanged", "8:nodeStart", "7:dataNode"],
        "The recording must preserve arrival order including out-of-order frame indices.",
      );
      assert.equal(recording.frameCount, 5, "Frame slices must merge consecutive same-frame events.");
      // 第二个观察者也收到同一批事件（观察者语义，不占租约）。
      await waitForAsync(
        () => observerLines.find((line) => line.type === "event" && line.event === "graphExecution"
          && line.executionEvents.some((event) => event.kind === "edgeValueChanged")),
        (value) => value !== undefined,
        10_000,
        "The observer client did not receive the pushed execution events.",
      );

      // 实例停止：收尾标记、快照失效、后续事件忽略。
      pushBatch([{ executionId: "exec-1", frameIndex: 9, kind: "instanceStopped" }]);
      executionActive = false;
      recording = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphExecutionRecording"),
        (value) => value.stopped === true,
        10_000,
        "The recording did not finalize on instanceStopped.",
      );
      assert.equal(recording.eventCount, 7);
      pushBatch([{ executionId: "exec-1", frameIndex: 10, kind: "nodeStart", nodeId: "node.late" }]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      recording = await vscode.commands.executeCommand("visualbridge.test.getGraphExecutionRecording");
      assert.equal(recording.eventCount, 7, "Events after instanceStopped must be ignored.");
      await assert.rejects(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphExecutionSnapshot", "exec-1"),
        (errorValue) => String(errorValue).includes("runtime.executionNotFound"));

      // 退订：服务端收到 unsubscribe，记录随会话摘除。
      assert.equal(await vscode.commands.executeCommand("visualbridge.test.unsubscribeGraphExecution"), true);
      assert.ok(actions.some((entry) => entry.action === "unsubscribeGraphExecution"));
      assert.equal(await vscode.commands.executeCommand("visualbridge.test.getGraphExecutionRecording"), null);
    } finally {
      if (observer !== undefined) observer.destroy();
      // 先断开服务层连接：server.close() 等待全部连接结束，否则假实例永不回调。
      await vscode.commands.executeCommand("visualbridge.test.disconnectRuntimeInstance").catch(() => undefined);
      clearInterval(heartbeat);
      if (previousRuntimeDirectory === undefined) delete process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
      else process.env.VISUALBRIDGE_TEST_RUNTIME_DIR = previousRuntimeDirectory;
      await new Promise((resolve) => server.close(resolve));
      await rm(discoveryDirectory, { recursive: true, force: true });
    }
  });

  await test("drives graph execution debug through the Graph editor session", async () => {
    // 真实 Graph 编辑器 + 假 Runtime 实例：页面执行调试链路（§19.5）端到端。
    const graphUri = vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "Graph", "SemanticSample.vbgraph"));
    // 实例 ID 必须符合 editor-<pid> 约定（发现记录解析会拒绝其他形态）。
    const instanceId = `editor-${process.pid}`;
    const discoveryDirectory = await mkdtemp(path.join(tmpdir(), "visualbridge-runtime-graph-debug-"));
    const recordPath = path.join(discoveryDirectory, `${instanceId}.json`);
    const token = createHash("sha256").update(`graph-debug-${instanceId}`).digest("hex");
    const startedAt = new Date().toISOString();
    const capabilities = ["snapshot", "events", "lease", "sources", "graphExecution"];
    // documentId 与 SemanticSample.vbgraph 一致：宿主按当前文档过滤实例。
    const executionInstance = {
      executionId: "exec-1",
      documentTypeId: "logicGraph",
      documentId: "semantic-sample",
      graphName: "Semantic Sample",
      debugKey: "hero-01",
      state: "running",
      currentNodeId: null,
      frameIndex: 0,
    };
    let executionActive = true;
    const subscribers = new Set();
    const actions = [];
    const send = (socket, message) => sendJson(socket, message);
    const pushBatch = (events) => {
      for (const socket of subscribers) {
        send(socket, { type: "event", event: "graphExecution", executionEvents: events });
      }
    };
    const server = net.createServer((socket) => {
      let handshake = false;
      attachJsonReader(socket, (message) => {
          if (!handshake) {
            if (message.type === "hello" && message.token === token && message.protocolVersion === 4
              && message.role === "vscode" && Array.isArray(message.payloads)) {
              handshake = true;
              send(socket, createRuntimeWelcome({ instanceId, startedAt }));
            } else {
              send(socket, { type: "error", code: "runtime.invalidToken" });
              socket.destroy();
            }
            return;
          }

          if (message.type !== "request") return;
          actions.push({ action: message.action });
          if (message.action === "getGraphExecutionInstances") {
            const executions = executionActive
              && (message.documentId === undefined || message.documentId === executionInstance.documentId)
                ? [executionInstance]
                : [];
            send(socket, { type: "response", requestId: message.requestId, status: "ok", executions });
          } else if (message.action === "getGraphExecutionSnapshot") {
            if (executionActive && message.executionId === "exec-1") {
              send(socket, { type: "response", requestId: message.requestId, status: "ok", execution: executionInstance });
            } else {
              send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.executionNotFound" });
            }
          } else if (message.action === "subscribeGraphExecution") {
            if (executionActive && message.executionId === "exec-1") {
              subscribers.add(socket);
              send(socket, { type: "response", requestId: message.requestId, status: "ok" });
              send(socket, {
                type: "event",
                event: "graphExecution",
                executionEvents: [{ executionId: "exec-1", frameIndex: 0, kind: "instanceStarted" }],
              });
            } else {
              send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.executionNotFound" });
            }
          } else if (message.action === "unsubscribeGraphExecution") {
            subscribers.delete(socket);
            send(socket, { type: "response", requestId: message.requestId, status: "ok" });
          } else {
            send(socket, { type: "response", requestId: message.requestId, status: "error", error: "runtime.unknownRequest" });
          }
      });
      socket.on("close", () => {
        subscribers.delete(socket);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tcpPort = server.address().port;
    const writeRecord = () => writeFile(recordPath, `${JSON.stringify({
      formatVersion: 1,
      protocolVersion: 4,
      coreVersion: 1,
      instanceId,
      kind: "editor-play",
      capabilities,
      tcpPort,
      token,
      pid: process.pid,
      generation: 1,
      startedAt,
    })}\n`, "utf8");
    await writeRecord();
    const heartbeat = setInterval(() => {
      void writeRecord();
    }, 2000);

    const previousRuntimeDirectory = process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
    process.env.VISUALBRIDGE_TEST_RUNTIME_DIR = discoveryDirectory;
    try {
      await vscode.commands.executeCommand("vscode.openWith", graphUri, "visualbridge.documentEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", graphUri),
        (ready) => ready === true,
        20_000,
        "The Graph editor did not become ready for the execution debug test.",
      );

      // 实例枚举：控制器自动连接假实例，并按当前文档过滤出执行实例。
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", graphUri, {
        type: "requestGraphExecutionInstances",
        requestId: "graph-debug-list-1",
      });
      const listed = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", graphUri),
        (state) => state?.runtimeConnected === true && state?.instanceCount === 1,
        20_000,
        "The debug controller did not connect and list the execution instance.",
      );
      assert.deepEqual(listed.instanceIds, ["exec-1"]);
      assert.equal(listed.runtimeInstanceId, instanceId);
      assert.equal(listed.subscribedExecutionId, undefined);

      // 订阅：合成 instanceStarted 开流，随后事件驱动 Webview 高亮并回执 ack。
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", graphUri, {
        type: "subscribeGraphExecution",
        requestId: "graph-debug-sub-1",
        executionId: "exec-1",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", graphUri),
        (state) => state?.subscribedExecutionId === "exec-1" && state?.totalEvents >= 1,
        20_000,
        "The debug controller did not subscribe to the execution instance.",
      );
      pushBatch([{ executionId: "exec-1", frameIndex: 3, kind: "nodeStart", nodeId: "step_a" }]);
      const liveAck = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", graphUri),
        (state) => state?.lastWebviewAck !== undefined
          && state.lastWebviewAck.executingNodeId === "step_a"
          && state.lastWebviewAck.mode === "follow",
        20_000,
        "The Webview did not acknowledge the live execution events.",
      );
      assert.equal(liveAck.subscribedExecutionId, "exec-1");
      assert.ok(liveAck.lastWebviewAck.eventCount >= 2, "The acknowledged event count must include the open-stream marker.");
      assert.ok(liveAck.lastWebviewAck.cursor === liveAck.lastWebviewAck.eventCount - 1,
        "The follow-mode cursor must track the latest event.");

      // 再推一批：实时态光标继续跟随事件末尾。
      pushBatch([
        { executionId: "exec-1", frameIndex: 4, kind: "nodeOutput", nodeId: "step_a", outputIndex: 0 },
        { executionId: "exec-1", frameIndex: 5, kind: "nodeStart", nodeId: "step_b" },
      ]);
      const followed = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", graphUri),
        (state) => state?.lastWebviewAck?.executingNodeId === "step_b" && state.lastWebviewAck.eventCount >= 4,
        20_000,
        "The Webview did not follow the subsequent execution events.",
      );
      assert.equal(followed.lastWebviewAck.mode, "follow");
      assert.equal(followed.lastWebviewAck.cursor, followed.lastWebviewAck.eventCount - 1);

      // 退订：会话摘除订阅并断开控制器的 Runtime 连接；服务端收到 unsubscribe。
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", graphUri, {
        type: "unsubscribeGraphExecution",
        requestId: "graph-debug-unsub-1",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", graphUri),
        (state) => state?.subscribedExecutionId === undefined && state?.runtimeConnected === false,
        20_000,
        "The debug controller did not unsubscribe and disconnect.",
      );
      assert.ok(actions.some((entry) => entry.action === "unsubscribeGraphExecution"),
        "The fake runtime instance did not receive unsubscribeGraphExecution.");

      executionActive = false;
    } finally {
      // 先关闭编辑器（会话 dispose 断开控制器连接）：server.close() 等待全部连接结束。
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", graphUri),
        (state) => state === undefined || state?.runtimeConnected === false,
        10_000,
        "The Graph editor session did not release its runtime connection on close.",
      ).catch(() => undefined);
      clearInterval(heartbeat);
      if (previousRuntimeDirectory === undefined) delete process.env.VISUALBRIDGE_TEST_RUNTIME_DIR;
      else process.env.VISUALBRIDGE_TEST_RUNTIME_DIR = previousRuntimeDirectory;
      await new Promise((resolve) => server.close(resolve));
      await rm(discoveryDirectory, { recursive: true, force: true });
    }
  });

  // ==== F3：独立 Debug 面板（附录 C.7） ====

  const bridgeState = await waitForAsync(
    () => vscode.commands.executeCommand("visualbridge.test.getBridgeServerState"),
    (value) => value !== null && value !== undefined,
    20_000,
    "Editor Bridge server did not start during activation.",
  );
  /** 连一条"Unity 侧"的假客户端（复用 C2 的帧编解码，不新写协议）。 */
  const connectDebugPeer = async (endpointId) => {
    const socket = net.connect({ host: "127.0.0.1", port: bridgeState.tcpPort });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const lines = [];
    attachJsonReader(socket, (message) => lines.push(message));
    const peer = {
      socket,
      lines,
      send: (message) => sendJson(socket, message),
      /** 通道 1 的调试帧（录制/接收门测试用；与线上帧逐字节一致）。 */
      sendDebug: (message) => socket.write(encodeFrame(1, KIND_JSON, Buffer.from(JSON.stringify(message), "utf8"))),
      handshaken: false,
      welcome: undefined,
      async handshake() {
        peer.send({
          type: "hello",
          protocolVersion: 4,
          role: "editor",
          clientEndpointId: endpointId,
          token: bridgeState.token,
          contractHash: bridgeState.contractHash,
          payloads: ["json", "binary"],
        });
        peer.welcome = await waitForAsync(
          () => lines.find((line) => line.type === "welcome"),
          (value) => value !== undefined,
          20_000,
          `Debug panel peer '${endpointId}' did not receive a welcome.`,
        );
        peer.handshaken = true;
        return peer.welcome;
      },
      waitForLine: async (predicate, message) => waitForAsync(
        () => lines.find(predicate),
        (value) => value !== undefined,
        20_000,
        message,
      ),
      close: () => new Promise((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }

        socket.once("close", resolve);
        socket.destroy();
      }),
    };
    return peer;
  };
  const debugPolicyCommand = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.debugReporting");
  const panelState = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
  const panelCommand = (command, payload = {}) => vscode.commands.executeCommand("visualbridge.test.debugPanel.command", command, payload);
  const ingestDebug = (envelopes) => vscode.commands.executeCommand("visualbridge.test.debugPanel.ingest", envelopes);
  /** 合成调试信封：字段对齐 F1 的 `DebugEnvelope`（C.1），不经过网络，只为喂满面板数据。 */
  const debugEvent = (category, instance, frame, method, value) => ({
    type: "debug",
    frame,
    wireBytes: 24,
    payloadKind: 1,
    category,
    instance,
    interfaceId: "IGraphDebuger",
    method,
    methodId: 10,
    instanceSlot: 1,
    args: [{ tag: 1, name: "nodeId", type: "string", value }],
    contractState: "unknown-interface",
  });
  const debugCreate = (category, instance) => ({
    type: "debugCreate",
    frame: -1,
    wireBytes: 10,
    payloadKind: 1,
    category,
    instance,
    instanceSlot: 1,
    resName: `${instance}-res`,
    debugInfo: "",
  });
  const facetSnapshot = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.facets");
  const flushFacetBatch = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.flushFacets");
  const graphWindowOf = (snapshot) => snapshot.windows.find((window) => window.category === "graph");

  await test("keeps the Debug panel switch in sync with welcome and the debugEnabled broadcast", async () => {
    const peer = await connectDebugPeer("debug-panel-welcome");
    try {
      const welcome = await peer.handshake();
      // A.5：welcome 通告初值；A.3 的 connectType 决定面板拓扑。
      assert.equal(welcome.debugEnabled, true);
      assert.equal(welcome.connectType, "editor");

      await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
      const opened = await waitForAsync(
        () => panelState(),
        (state) => state?.connection?.state === "connected" && state?.connection?.endpointId === "debug-panel-welcome",
        20_000,
        "The Debug panel did not see the handshaken connection.",
      );
      assert.equal(opened.enable.enabled, true, "初值必须来自 welcome.debugEnabled");
      assert.equal(opened.enable.source, "welcome");
      assert.equal(opened.enable.canToggle, true);
      assert.equal(opened.connection.target, `127.0.0.1:${bridgeState.tcpPort}`);
      assert.equal((await debugPolicyCommand()).enabled, true);

      // Unity 侧回报"已关闭"：广播到达后按钮才变，且连接不能被这条控制消息弄断。
      peer.send({ type: "debugEnabled", enabled: false });
      const off = await waitForAsync(
        () => panelState(),
        (state) => state?.enable?.enabled === false,
        20_000,
        "The debugEnabled broadcast did not reach the Debug panel.",
      );
      assert.equal(off.enable.source, "broadcast");
      assert.equal(off.enable.error, undefined);
      assert.equal((await debugPolicyCommand()).enabled, false);

      // 连接仍然可用：再发一条广播（true）仍能被面板收到，证明没有走"未知消息断开"分支。
      peer.send({ type: "debugEnabled", enabled: true });
      await waitForAsync(
        () => panelState(),
        (state) => state?.enable?.enabled === true && state.enable.source === "broadcast",
        20_000,
        "The Debug panel stopped accepting debugEnabled broadcasts.",
      );
      assert.equal(peer.socket.destroyed, false, "A state broadcast must not kill the connection.");
    } finally {
      await peer.close();
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    }

    // 断开后：状态栏回到未连接，开关不能再点（C.7 状态栏）。
    const disconnected = await waitForAsync(
      () => panelState(),
      (state) => state?.connection?.state === "disconnected" && state?.enable?.canToggle === false,
      20_000,
      "The Debug panel did not notice the connection going away.",
    );
    assert.equal(disconnected.connection.endpointId, undefined);
  });

  await test("opens the Debug panel without waiting for a failing runtime connection and shows the reason", async () => {
    // 隔离：发现目录是 runTest.mjs 为本轮建的空目录，探针地址是 TEST-NET-1（192.0.2.1，本机不可达），
    // 因此「没有 Runtime 端点」是确定的，不会被开发者本机开着的 Play 模式或占用的端口干扰。
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    const opened = await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
    assert.ok(opened.openCount >= 1, "Opening the panel must create or reveal the panel.");

    // 因果证据（不用墙钟阈值）：端口段探测至少 50 口 / 并发 8 / 单口 300 ms ≈ 1.9 s。
    // 若 open 在等探测，返回时这里已经是 failed；返回时仍是 connecting 才说明尝试被留在后台。
    const inFlight = await panelState();
    assert.equal(inFlight.connection.state, "disconnected");
    assert.equal(inFlight.connection.detail, "正在连接 Runtime Bridge（192.0.2.1）…",
      "open 必须立即返回，把连接尝试留在后台（返回时仍应是 connecting）");

    const failed = await waitForAsync(
      () => panelState(),
      (state) => state?.connection?.state === "disconnected" && typeof state?.connection?.detail === "string"
        && /未找到 Runtime 端点|连接 Runtime Bridge 失败/u.test(state.connection.detail),
      30_000,
      "The Debug panel did not surface a readable runtime connection failure.",
    );
    assert.deepEqual(failed.connection.sources, { editor: false, runtime: false });
    assert.equal(failed.enable.canToggle, false);
    assert.match(failed.connection.detail, /已探测 192\.0\.2\.1:28300-28349/u,
      "失败原因必须带上真实探针地址（隔离探针确实被用上了）");

    // 可重试：命令通道不抛错，快照立刻回到 connecting（重试真的发起了新尝试），随后落回同一条原因。
    const retried = await panelCommand("retryConnection");
    assert.equal(retried.connection.state, "disconnected");
    assert.equal(retried.connection.detail, "正在连接 Runtime Bridge（192.0.2.1）…",
      "重试必须真的发起新尝试，而不是静默失败");
    const afterRetry = await waitForAsync(
      () => panelState(),
      (state) => state?.connection?.state === "disconnected" && typeof state?.connection?.detail === "string"
        && /未找到 Runtime 端点|连接 Runtime Bridge 失败/u.test(state.connection.detail),
      30_000,
      "The retry path did not settle back to a readable failure.",
    );
    assert.match(afterRetry.connection.detail, /未找到 Runtime 端点/u);
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
  });

  await test("sends debugSetEnabled without an optimistic switch and rolls back on timeout", async () => {
    // 先等上一条连接彻底退休：服务端的 close 通知会以 welcome 语义清掉挂起请求，
    // 迟到的 close 落进本用例的等待窗口就会把 pending 提前结算（宿主事件是异步的）。
    await waitForAsync(
      () => debugPolicyCommand(),
      (reporting) => reporting?.available === false,
      20_000,
      "The previous Debug panel connection was still alive.",
    );
    const peer = await connectDebugPeer("debug-panel-toggle");
    try {
      await peer.handshake();
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
      // 用例自洽：先把服务端值广播成 false 再广播回 true，两次都等到面板采纳再点。
      // 不能只等 `enabled === true`：welcome 的初值就是 true，那样会立刻通过，
      // 迟到的广播反而落进点击之后的等待窗口，把挂起请求提前结算。
      peer.send({ type: "debugEnabled", enabled: false });
      await waitForAsync(
        () => panelState(),
        (state) => state?.enable?.enabled === false && state?.enable?.source === "broadcast",
        20_000,
        "The panel did not adopt the debugEnabled=false broadcast.",
      );
      peer.send({ type: "debugEnabled", enabled: true });
      await waitForAsync(
        () => panelState(),
        (state) => state?.enable?.enabled === true && state?.enable?.source === "broadcast",
        20_000,
        "The panel did not adopt the debugEnabled=true broadcast.",
      );
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.setEnableTimeout", 1_000);

      // 点击 = 发一条 debugSetEnabled（A.5，通道 0 JSON）；本地值**不动**。
      // 用命令的返回值（点击那一刻的快照）断言，避免把后续异步事件混进 P0 判定。
      const pending = await panelCommand("enable", { value: false });
      const request = await peer.waitForLine(
        (line) => line.type === "debugSetEnabled",
        "The panel did not send debugSetEnabled to the Unity peer.",
      );
      assert.equal(request.enabled, false);

      const pendingDetail = JSON.stringify(pending?.enable);
      assert.equal(pending.enable.enabled, true, `P0：面板不许本地乐观更新 ${pendingDetail}`);
      assert.equal(pending.enable.pending, true, `P0：点击后应处于等广播状态 ${pendingDetail}`);
      assert.equal(pending.enable.pendingTarget, false, pendingDetail);
      assert.equal(pending.enable.canToggle, false, `等广播期间按钮置灰 ${pendingDetail}`);

      // 对端不回广播 ⇒ 超时后回到服务端状态（仍是 true），只多一条 timeout 提示。
      const rolledBack = await waitForAsync(
        () => panelState(),
        (state) => state?.enable?.pending === false && state?.enable?.error === "timeout",
        20_000,
        "The Debug panel did not roll back after the debugEnabled timeout.",
      );
      assert.equal(rolledBack.enable.enabled, true, "超时后必须回到服务端的 true，而不是点击的 false");
      assert.equal(rolledBack.enable.canToggle, true);

      // 迟到的广播才是唯一能让它变 true→false 的事件。
      peer.send({ type: "debugEnabled", enabled: false });
      const settled = await waitForAsync(
        () => panelState(),
        (state) => state?.enable?.enabled === false && state?.enable?.error === undefined,
        20_000,
        "A late debugEnabled broadcast did not settle the switch.",
      );
      assert.equal(settled.enable.source, "broadcast");
      assert.equal(peer.socket.destroyed, false);
    } finally {
      await peer.close();
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    }
  });

  await test("rolls the Debug panel switch back immediately when no connection can carry the request", async () => {
    await waitForAsync(
      () => debugPolicyCommand(),
      (reporting) => reporting?.available === false,
      20_000,
      "Expected no handshaken connection before this case ran.",
    );
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
    try {
      const before = await panelState();
      assert.equal(before.connection.state, "disconnected");
      assert.equal(before.enable.canToggle, false, "没有可承载请求的连接时按钮置灰");
      assert.equal(before.enable.enabled, (await debugPolicyCommand()).enabled);
      await panelCommand("enable", { value: !before.enable.enabled });
      const after = await panelState();
      assert.equal(after.enable.enabled, before.enable.enabled, "请求发不出去时值必须原样");
      assert.equal(after.enable.pending, false, "发不出去不该留挂起（否则按钮永远锁死）");
      assert.equal(after.enable.error, "sendFailed");
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    }
  });

  await test("greys the Debug panel switch in Player mode without sending any request", async () => {
    const peer = await connectDebugPeer("debug-panel-player");
    try {
      await peer.handshake();
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
      // 生产上 connectType 只有一个来源（A.3）；这里用注入点覆盖成 Player 拓扑。
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.setMode", "player");
      const player = await panelState();
      assert.equal(player.enable.mode, "player");
      assert.equal(player.enable.canToggle, false);
      const beforeValue = player.enable.enabled;

      await panelCommand("enable", { value: !beforeValue });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(
        peer.lines.filter((line) => line.type === "debugSetEnabled"),
        [],
        "Player 模式不得发送 debugSetEnabled",
      );
      const unchanged = await panelState();
      assert.equal(unchanged.enable.enabled, beforeValue);
      assert.equal(unchanged.enable.error, undefined, "没有请求就不该有回滚提示");
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.setMode", "editor");
      await peer.close();
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    }
  });

  await test("keeps the per-instance cursor, granularity and filter across Debug panel instance switches", async () => {
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
    try {
      await ingestDebug([
        debugCreate("f3-graph", "hero"),
        debugCreate("f3-entity", "boss"),
      ]);
      // 乱序到达：1,2,1,3 —— 分组必须是 4 段（不重排）。
      await ingestDebug([
        debugEvent("f3-graph", "hero", 1, "NodeStarted", "a"),
        debugEvent("f3-graph", "hero", 2, "NodeStarted", "b"),
        debugEvent("f3-graph", "hero", 1, "NodeStarted", "c"),
        debugEvent("f3-graph", "hero", 3, "NodeStarted", "d"),
        debugEvent("f3-entity", "boss", 9, "NodeStarted", "x"),
      ]);
      const heroKey = "f3-graph\u0000hero";
      const bossKey = "f3-entity\u0000boss";

      await panelCommand("select", { key: heroKey });
      const hero = await panelState();
      assert.equal(hero.timeline.groups.length, 4, "1,2,1,3 必须分成 4 段（按到达顺序）");
      assert.deepEqual(hero.timeline.groups.map((group) => group.frame), [1, 2, 1, 3]);
      assert.equal(hero.timeline.cursor, hero.timeline.toPosition, "首次选中看末尾");

      // 按记录退一步，再切到 boss：hero 的游标必须原样保留（验收标准 1）。
      await panelCommand("step", { direction: -1 });
      const stepped = await panelState();
      assert.equal(stepped.mode, "replay");
      const heroCursor = stepped.timeline.cursor;
      assert.equal(heroCursor, stepped.timeline.toPosition - 1);

      await panelCommand("filter", { value: "boss" });
      await panelCommand("select", { key: bossKey });
      const boss = await panelState();
      assert.equal(boss.timeline.records.length, 1);
      assert.equal(boss.filter, "boss", "过滤状态跨实例保留");

      await panelCommand("select", { key: heroKey });
      const back = await panelState();
      assert.equal(back.timeline.cursor, heroCursor, "切回来游标原样保留");
      assert.equal(back.mode, "replay");
      assert.equal(back.filter, "boss");

      // 按帧步进：粒度切换不丢游标，回退一帧跨过整组。
      await panelCommand("granularity", { value: "frame" });
      await panelCommand("step", { direction: -1 });
      const byFrame = await panelState();
      assert.equal(byFrame.granularity, "frame");
      assert.ok(byFrame.timeline.cursor < back.timeline.cursor);

      // 回到实时：F2 的 replay() 不动游标，面板必须自己补到末尾。
      await panelCommand("live");
      const live = await panelState();
      assert.equal(live.mode, "live");
      assert.equal(live.timeline.cursor, live.timeline.toPosition);
      assert.equal(live.timeline.atEnd, true);
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    }
  });

  await test("keeps Debug panel records cached across close and reopen", async () => {
    const first = await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
    try {
      await ingestDebug([debugCreate("f3-cache", "keeper")]);
      await ingestDebug([
        debugEvent("f3-cache", "keeper", 1, "NodeStarted", "a"),
        debugEvent("f3-cache", "keeper", 2, "NodeStarted", "b"),
      ]);
      await panelCommand("select", { key: "f3-cache\u0000keeper" });
      const before = await panelState();
      assert.equal(before.timeline.records.length, 2);
      const recordIds = before.timeline.records.map((record) => record.id);
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");

      const second = await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
      assert.equal(second.openCount, first.openCount + 1, "重开应复用同一控制器而不是新建");
      const after = await panelState();
      // 没有新的 ingest：记录、游标、选中实例全部来自缓存（不重新拉取）。
      assert.deepEqual(after.timeline.records.map((record) => record.id), recordIds);
      assert.equal(after.selectedKey, "f3-cache\u0000keeper");
      assert.equal(after.timeline.cursor, before.timeline.cursor);
      assert.equal(after.status.records, before.status.records);
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    }
  });

  await test("pauses the Debug panel view without dropping the records that keep arriving", async () => {
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
    try {
      await ingestDebug([debugCreate("f3-pause", "pilot")]);
      await ingestDebug([debugEvent("f3-pause", "pilot", 1, "NodeStarted", "a")]);
      await panelCommand("select", { key: "f3-pause\u0000pilot" });
      await panelCommand("togglePause");
      const paused = await panelState();
      assert.equal(paused.paused, true);
      // 下限守卫：先证明暂停前时间轴确实有行可丢，否则下面的行数相等在 0 vs 0 时恒真。
      assert.ok(
        paused.timeline.records.length >= 1,
        "暂停前时间轴必须至少有一行：否则 equal(before, after) 在 0 vs 0 时恒真，无法证明暂停未丢记录",
      );
      const recordsWhilePaused = paused.status.records;

      await ingestDebug([
        debugEvent("f3-pause", "pilot", 2, "NodeStarted", "b"),
        debugEvent("f3-pause", "pilot", 3, "NodeStarted", "c"),
      ]);
      const stillPaused = await panelState();
      assert.equal(stillPaused.paused, true);
      assert.equal(stillPaused.timeline.cursor, paused.timeline.cursor, "暂停中不跟随末尾");
      // 暂停冻结时间轴窗口：新记录只进 store，不能出现在渲染列表里。
      assert.equal(
        stillPaused.timeline.records.length,
        paused.timeline.records.length,
        "暂停期间两次快照的行数相同",
      );

      await panelCommand("togglePause");
      const resumed = await panelState();
      assert.equal(resumed.paused, false);
      assert.equal(resumed.status.records, recordsWhilePaused + 2, "暂停期间的记录一条不少");
      assert.ok(resumed.timeline.records.length > stillPaused.timeline.records.length, "恢复后行数增加");
      assert.equal(resumed.timeline.cursor, resumed.timeline.toPosition, "恢复后追平末尾");
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
    }
  });

  await test("opens a debug recording through the public command and restores the live selection on return", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "visualbridge-recording-"));
    const filePath = path.join(directory, "session.vbdrec");
    try {
      await writeDebugRecording(filePath, [
        { type: "debugCreate", category: "f5-replay", instance: "recorded", instanceSlot: 1, resName: "recorded-res", debugInfo: "" },
        { type: "debugFrame", frame: 1 },
        { type: "debug", category: "f5-replay", instance: "recorded", iface: "IGraphDebuger", method: "NodeStarted", args: [{ tag: 1, name: "nodeId", type: "string", value: "r1" }] },
        { type: "debug", category: "f5-replay", instance: "recorded", iface: "IGraphDebuger", method: "NodeStarted", args: [{ tag: 1, name: "nodeId", type: "string", value: "r2" }] },
      ]);

      await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
      // 在线选中一个实例，作为"返回实时"必须恢复的目标。
      const liveKey = "f5-live\u0000before";
      await ingestDebug([debugCreate("f5-live", "before")]);
      await ingestDebug([debugEvent("f5-live", "before", 1, "NodeStarted", "live-1")]);
      await panelCommand("select", { key: liveKey });
      const before = await panelState();
      assert.equal(before.selectedKey, liveKey);
      assert.equal(before.mode, "live");
      assert.equal(before.replay, undefined);

      // 真正执行公开命令（不只是把命令列进 EXPECTED_COMMANDS）：参数是 Uri，走过命令注册 +
      // 参数解析 + 会话打开三层；命令本身不返回快照，因此从面板状态断言进入了回看态。
      await vscode.commands.executeCommand("visualbridge.openDebugRecording", vscode.Uri.file(filePath));
      const replay = await waitForAsync(
        () => panelState(),
        (state) => state?.replay !== undefined,
        20_000,
        "The public openDebugRecording command did not switch the panel into replay mode.",
      );
      assert.equal(
        replay.replay.filePath.toLowerCase(),
        filePath.toLowerCase(),
        "回看状态必须指向命令传入的文件",
      );
      assert.equal(replay.replay.records, 4, "文件尾的 records 必须原样呈现");
      assert.equal(replay.replay.droppedRecords, 0);
      assert.equal(replay.replay.endedReason, "disconnect");
      assert.equal(replay.recording.available, false, "回看期间录制按钮不可用");
      assert.equal(replay.enable.canToggle, false, "回看没有传输层：开关显式置灰（不依赖 connection.state）");
      assert.equal(replay.selectedKey, undefined, "进入回看从默认实例重新开始");

      // 回看里的浏览（选中 B + 单步）不能泄漏回在线。
      const replayKey = "f5-replay\u0000recorded";
      await panelCommand("select", { key: replayKey });
      const stepped = await panelCommand("step", { direction: -1 });
      assert.equal(stepped.selectedKey, replayKey);
      assert.equal(stepped.mode, "replay", "回看里单步后处于逐步回放");

      // Webview 的"返回实时"按钮发的就是 closeRecording；这里走同一个命令入口验证可用。
      const returned = await panelCommand("closeRecording");
      assert.equal(returned.replay, undefined, "返回实时后不再有回看状态");
      assert.equal(returned.selectedKey, liveKey, "关闭回看必须恢复在线选中");
      assert.equal(returned.mode, "live", "进入回看前的 followIntent 必须恢复");
    } finally {
      // 断言失败时也必须先退回收看：回看会话持有第二个 manager/文件句柄，只关面板会把它留在
      // 同一进程的后续套件里（P2-9）。
      await panelCommand("closeRecording").catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("an oversized recording is rejected before the panel leaves the live view (P1-A)", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "visualbridge-oversize-"));
    const filePath = path.join(directory, "oversize.vbdrec");
    try {
      // footer 声明 200001 条（> 回看上限 200000），文件本身只有一帧：预检必须在解码前拒绝。
      await writeDebugRecording(
        filePath,
        [{ type: "debugCreate", category: "f5-oversize", instance: "recorded", instanceSlot: 1, resName: "r", debugInfo: "" }],
        { footerRecords: 200001 },
      );
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
      await ingestDebug([debugCreate("f5-oversize", "live")]);
      const live = await panelState();
      assert.equal(live.replay, undefined);

      const rejected = await vscode.commands.executeCommand("visualbridge.test.debugPanel.openRecording", filePath);
      assert.equal(rejected.ok, false, "预检必须拒绝超大录制");
      assert.match(rejected.error, /200001/u, "错误信息必须含文件声明的条数");
      assert.match(rejected.error, /200000/u, "错误信息必须含回看上限");
      assert.match(rejected.error, /超过回看上限/u);
      assert.match(rejected.error, /分段录制/u);

      const after = await panelState();
      assert.equal(after.replay, undefined, "拒绝后必须停留在实时模式（不能进入回看态）");
      assert.equal(after.connection.state, live.connection.state);
      assert.equal(after.mode, live.mode);
    } finally {
      await panelCommand("closeRecording").catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("recording is bound to its source connection (P1-B)", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "visualbridge-recording-bound-"));
    const filePath = path.join(directory, "bound.vbdrec");
    let primary;
    let intruder;
    const recordingState = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingState");
    try {
      primary = await connectDebugPeer("recording-source");
      await primary.handshake();
      const started = await vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingStart", filePath);
      assert.equal(started.active, true);
      assert.equal(started.available, true);

      primary.sendDebug({
        type: "debugCreate", category: "f5-bound", instance: "primary", instanceSlot: 1, resName: "r", debugInfo: "",
      });
      primary.sendDebug({
        type: "debug", category: "f5-bound", instance: "primary", iface: "IGraphDebuger",
        method: "NodeStarted", frame: 1, args: [{ tag: 1, name: "nodeId", type: "string", value: "primary-1" }],
      });
      await delay(200);

      // 第二个客户端：先发两帧（未握手），再发 hello（会被一对一门槛拒绝并 close）。
      intruder = await connectDebugPeer("recording-intruder");
      intruder.sendDebug({
        type: "debug", category: "f5-bound", instance: "intruder", iface: "IGraphDebuger",
        method: "NodeStarted", frame: 2, args: [{ tag: 1, name: "nodeId", type: "string", value: "intruder-1" }],
      });
      intruder.sendDebug({
        type: "debug", category: "f5-bound", instance: "intruder", iface: "IGraphDebuger",
        method: "NodeStarted", frame: 3, args: [{ tag: 1, name: "nodeId", type: "string", value: "intruder-2" }],
      });
      intruder.send({
        type: "hello",
        protocolVersion: 4,
        role: "editor",
        clientEndpointId: "recording-intruder",
        token: bridgeState.token,
        contractHash: bridgeState.contractHash,
        payloads: ["json", "binary"],
      });
      await intruder.waitForLine((line) => line.type === "error", "the second client was not rejected");
      await delay(200);

      const duringIntruder = await recordingState();
      assert.equal(duringIntruder.active, true, "第二连接发帧/握手不能收尾录制");
      assert.equal(duringIntruder.endedReason, undefined);

      await intruder.close();
      await delay(300);
      const afterIntruder = await recordingState();
      assert.equal(afterIntruder.active, true, "第二连接关闭不能把录制截断成 disconnect");
      assert.equal(afterIntruder.endedReason, undefined);

      // 主连接继续录，然后正常停止。
      primary.sendDebug({
        type: "debug", category: "f5-bound", instance: "primary", iface: "IGraphDebuger",
        method: "NodeStarted", frame: 4, args: [{ tag: 1, name: "nodeId", type: "string", value: "primary-2" }],
      });
      await delay(200);
      const stopped = await vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingStop");
      assert.equal(stopped.footer.endedReason, "disconnect");
      assert.equal(stopped.footer.records, 3, "主连接 3 帧：Create + 2 个事件");

      const recording = await readDebugRecording(filePath);
      assert.equal(recording.footer.records, 3);
      const texts = recording.frames.map((frame) => frame.payload.toString("utf8"));
      assert.equal(
        texts.some((text) => text.includes("intruder")),
        false,
        `第二连接的帧不得出现在录制文件里：${texts.join(" | ")}`,
      );
      assert.equal(texts.filter((text) => text.includes("primary-")).length, 2);

      // 主连接断开后没有已握手的源连接：开始录制必须拒绝。
      await primary.close();
      await waitForAsync(recordingState, (state) => state?.active === false, 20_000, "the recording did not finish after the source disconnected");
      await assert.rejects(
        vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingStart", path.join(directory, "no-source.vbdrec")),
        /handshaken/u,
        "没有源连接时 startRecording 必须拒绝（不能录一个『还没有源』的会话）",
      );
    } finally {
      await intruder?.close().catch(() => undefined);
      await primary?.close().catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingStop").catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("closing the panel while replaying resumes the live store (P2-3)", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "visualbridge-recording-paused-"));
    const filePath = path.join(directory, "paused.vbdrec");
    const liveKey = "f5-paused\u0000pilot";
    const liveStorePaused = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.liveStorePaused", liveKey);
    try {
      await writeDebugRecording(filePath, [
        { type: "debugCreate", category: "f5-paused", instance: "recorded", instanceSlot: 1, resName: "r", debugInfo: "" },
        { type: "debugFrame", frame: 1 },
        { type: "debug", category: "f5-paused", instance: "recorded", iface: "IGraphDebuger", method: "NodeStarted", args: [{ tag: 1, name: "nodeId", type: "string", value: "r1" }] },
      ]);

      await vscode.commands.executeCommand("visualbridge.test.debugPanel.open");
      await ingestDebug([debugCreate("f5-paused", "pilot"), debugEvent("f5-paused", "pilot", 1, "NodeStarted", "live")]);
      await panelCommand("select", { key: liveKey });
      await panelCommand("togglePause");
      assert.equal(await liveStorePaused(), true, "前提：线上 store 确实被暂停了");

      const opened = await vscode.commands.executeCommand("visualbridge.test.debugPanel.openRecording", filePath);
      assert.equal(opened.ok, true, String(opened.error));
      assert.ok((await panelState()).replay, "必须真的进入回看态");

      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
      assert.equal(
        await liveStorePaused(),
        false,
        "关闭面板必须解开线上 store 的暂停（修复前它永久停在 paused=true，pendingAppended 无界增长）",
      );
      assert.equal((await panelState()).paused, false);
    } finally {
      await panelCommand("closeRecording").catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("F4 routes graph records to the Graph module facet and still feeds the generic view", async () => {
    // 前一个用例留了关键词过滤；先清掉，否则下面按 instanceId 找通用视图的行会被过滤掉。
    await panelCommand("filter", { value: "" });
    const before = await facetSnapshot();
    await ingestDebug([
      debugCreate("graph", "facet-hero"),
      debugEvent("graph", "facet-hero", 1, "NodeStarted", "node-a"),
      debugEvent("graph", "facet-hero", 2, "NodeFinished", "node-b"),
    ]);
    await flushFacetBatch();

    const after = await facetSnapshot();
    const window = graphWindowOf(after);
    assert.ok(window, "The Graph facet window must exist once the module declared the category.");
    assert.equal(window.state, "active");
    assert.equal(window.moduleId, "visualbridge.graph");
    assert.equal(window.editor, "graph");
    assert.equal(window.path, "modules[0].editors[0].debug");
    assert.equal(window.records, 2);
    assert.equal(window.batches, 1);
    assert.deepEqual(window.content, {
      kind: "graph.debug",
      category: "graph",
      seq: window.content.seq,
      instanceId: "facet-hero",
      frame: 2,
      method: "NodeFinished",
      wireBytes: 24,
      nodeId: "node-b",
    });
    // 验收 B：同一批记录 facet 与通用观察者都收到。
    assert.equal(after.generic.records, before.generic.records + 2);
    assert.equal(after.generic.dropped, 0);

    // 通用视图仍然可见：同一实例在面板时间轴里仍有两条记录。
    const state = await panelState();
    const instance = state.instances.find((row) => row.instanceId === "facet-hero");
    assert.ok(instance);
    assert.equal(instance.recordCount, 2);

    // 投递诊断不是"吞掉就完"：Webview 消息失败计数必须出现在面板快照里（验收 D）。
    // 计数是**进程级**的：无头宿主里前序面板用例的 `postMessage` 本来就可能返回 false，
    // 因此这里断言"注入恰好 +1"，而不是假设全局计数从 0 开始。
    const beforeFailures = (await panelState()).delivery.webviewFailures;
    const failures = await vscode.commands.executeCommand("visualbridge.test.debugPanel.noteWebviewFailure");
    assert.equal(failures, beforeFailures + 1);
    assert.equal((await panelState()).delivery.webviewFailures, beforeFailures + 1);
  });

  await test("F4 falls back to generic when onRecord throws and keeps other categories intact", async () => {
    const before = await facetSnapshot();
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.faultFacet", "graph");
    await ingestDebug([
      debugCreate("graph", "fault-hero"),
      debugEvent("graph", "fault-hero", 1, "NodeStarted", "node-fault"),
      debugEvent("graph", "fault-hero", 2, "NodeStarted", "node-fault-2"),
    ]);
    await flushFacetBatch();

    const failed = await facetSnapshot();
    const window = graphWindowOf(failed);
    assert.equal(window.state, "fallback");
    assert.equal(window.diagnostics[0].code, "module.callFailed");
    assert.equal(window.diagnostics[0].path, "modules[0].editors[0].debug");
    assert.match(window.message, /回退到通用视图/u);
    // 记录不丢：通用观察者收到了这 2 条（转储记录也计入观察者）。
    assert.equal(failed.generic.records, before.generic.records + 2);

    // 复位注入并重建路由后，同一分类恢复正常。
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.resetFacets");
    await flushFacetBatch();
    await ingestDebug([debugEvent("graph", "fault-hero", 3, "NodeStarted", "node-recovered")]);
    await flushFacetBatch();
    const recovered = graphWindowOf(await facetSnapshot());
    assert.equal(recovered.state, "active");
    assert.equal(recovered.content.nodeId, "node-recovered");
  });

  await test("F4 re-reads modules[].options.debug after a module reload and locates invalid options", async () => {
    const projectUri = vscode.Uri.file(path.join(workspacePath, "GraphSemanticProject", "VisualBridge.project.vbjson"));
    const original = await vscode.workspace.fs.readFile(projectUri);
    const readDefinition = () => JSON.parse(new TextDecoder("utf-8").decode(original));
    const writeDefinition = async (definition) => {
      await vscode.workspace.fs.writeFile(
        projectUri,
        new TextEncoder().encode(`${JSON.stringify(definition, undefined, 2)}\n`),
      );
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
    };
    const moduleState = (id) => waitForAsync(
      async () => {
        const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
        const project = state.projects.find((entry) => entry.projectId === "GraphSemanticProject");
        return project?.modules.find((module) => module.id === id);
      },
      (module) => module !== undefined && module.status === "loaded",
      20_000,
      `Module '${id}' did not settle as loaded.`,
    );

    try {
      const tuned = readDefinition();
      assert.equal(tuned.modules[0].id, "visualbridge.graph");
      tuned.modules[0].options = { debug: { title: "Hosted Graph" } };
      await writeDefinition(tuned);
      await moduleState("visualbridge.graph");
      // 先证明重建后的路由上下文确实拿到了新的 modules[0].options（否则下面的窗口断言会掩盖
      // "重载了模块但路由源还是旧 Project 定义"这一类缺陷）。
      const routes = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.debugPanel.facetRoutes"),
        (entries) => entries.some((entry) => entry.moduleId === "visualbridge.graph"
          && entry.options?.debug?.title === "Hosted Graph"),
        20_000,
        "The rebuilt facet route did not pick up modules[0].options.debug after the reload.",
      );
      assert.ok(routes.some((entry) => entry.path === "modules[0].editors[0].debug"));
      await ingestDebug([
        debugCreate("graph", "options-hero"),
        debugEvent("graph", "options-hero", 1, "NodeStarted", "node-options"),
      ]);
      await flushFacetBatch();
      const window = graphWindowOf(await facetSnapshot());
      assert.equal(window.state, "active");
      assert.deepEqual(
        window.content.options,
        { title: "Hosted Graph" },
        `unexpected facet content: ${JSON.stringify(window.content)}`,
      );

      const invalid = readDefinition();
      invalid.modules[0].options = { debug: { title: 42 } };
      await writeDefinition(invalid);
      const disabled = await waitForAsync(
        async () => {
          const state = await vscode.commands.executeCommand("visualbridge.test.getModuleRegistryState");
          const project = state.projects.find((entry) => entry.projectId === "GraphSemanticProject");
          return project?.modules.find((module) => module.id === "visualbridge.graph");
        },
        (module) => module !== undefined && module.status !== "loaded"
          && module.diagnostics.some((entry) => entry.code === "module.optionsInvalid"),
        20_000,
        "The Graph module was not rejected after modules[0].options.debug became invalid.",
      );
      const diagnostic = disabled.diagnostics.find((entry) => entry.code === "module.optionsInvalid");
      assert.ok(diagnostic, "validateOptions failure must be reported as module.optionsInvalid.");
      assert.equal(diagnostic.path, "modules[0].options");
      assert.match(diagnostic.message, /graph\.options\.debugInvalid/u);
      assert.match(diagnostic.message, /\$\.debug\.title/u);

      // 模块被停用后，该分类立即回退通用视图，面板给出"模块未加载"。
      await flushFacetBatch();
      await ingestDebug([debugEvent("graph", "options-hero", 2, "NodeStarted", "node-disabled")]);
      await flushFacetBatch();
      const unavailable = graphWindowOf(await facetSnapshot());
      assert.equal(unavailable.state, "unavailable");
      assert.match(unavailable.message, /模块未加载/u);
    } finally {
      await vscode.workspace.fs.writeFile(projectUri, original);
      await vscode.commands.executeCommand("visualbridge.refreshProjects");
      await vscode.commands.executeCommand("visualbridge.test.reloadModules");
      await moduleState("visualbridge.graph");
    }
  });

  await test("F4 revoking module trust invalidates the route immediately and replay never double-feeds generic", async () => {
    const before = await facetSnapshot();
    const genericBefore = before.generic.records;
    // 撤销信用前旧消费者已投递的条数 = 该分类在 store 里的可见记录数（上一次 rebuild 已全量重放）。
    const beforeRecords = graphWindowOf(before).records;
    try {
      await vscode.commands.executeCommand("visualbridge.test.setModuleTrustOverride", false);
      await waitForAsync(
        async () => graphWindowOf(await facetSnapshot())?.state,
        (state) => state === "unavailable",
        20_000,
        "The Graph facet route did not go generic after trust was revoked.",
      );
      await ingestDebug([
        debugCreate("graph", "revoked-hero"),
        debugEvent("graph", "revoked-hero", 1, "NodeStarted", "node-offline"),
      ]);
      await flushFacetBatch();
      const offline = await facetSnapshot();
      // 验收 A：注销后的消费者一次都没有再被调用，分类立刻走通用视图。
      assert.equal(offline.lateRecords, 0);
      assert.equal(offline.generic.records, genericBefore + 1);
      assert.match(graphWindowOf(offline).message, /模块未加载/u);
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.setModuleTrustOverride", undefined);
    }

    await waitForAsync(
      async () => graphWindowOf(await facetSnapshot()),
      (window) => window?.state === "active",
      20_000,
      "The Graph facet route did not recover after trust was restored.",
    );
    await flushFacetBatch();
    const replayed = await facetSnapshot();
    // 信任恢复后新 facet 在 rebuild() 里按分类全量重放该分类**当前可用**的记录，所以投递数是
    // 精确值而不是"至少 1 条"：撤销前旧消费者已投递的 beforeRecords + 卸载期间存下的条数。
    // 卸载期间存下的条数由通用视图基线算出（观察者始终收到每条记录；debugCreate 不是记录）。
    const storedWhileUnloaded = replayed.generic.records - genericBefore;
    assert.equal(storedWhileUnloaded, 1, "卸载期间恰好只存下 1 条记录");
    assert.equal(
      graphWindowOf(replayed).records,
      beforeRecords + storedWhileUnloaded,
      "records stored while unloaded must all be replayed to the new facet",
    );
    assert.equal(replayed.generic.records, genericBefore + 1, "replay must not feed the generic observer twice");
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

function tableKeyRenameRequest(newValue) {
  return {
    projectId: "visualbridge.entity-semantics",
    definition: {
      kind: "table.row",
      target: {
        tableTypeId: "sample.table.skills",
        sheetId: "skills",
        documentTypeId: "sample.table.skills",
      },
      allowMissing: false,
    },
    location: {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      path: "Tables/Skills_Main.skillstable",
      sheetId: "skills:Skills_Main",
      rowId: "Skills_Main:key-101",
    },
    oldValue: 101,
    newValue,
    confirm: false,
  };
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

async function assertMissing(uri) {
  await assert.rejects(vscode.workspace.fs.stat(uri));
}

async function revertTextDocument(uri) {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand("workbench.action.files.revert");
  assert.equal(document.isDirty, false);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
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

async function readProviderEvents(stateDirectory) {
  try {
    return (await readFile(path.join(stateDirectory, "events.ndjson"), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
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
