const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, symlink, unlink, writeFile } = require("node:fs/promises");
const fsPromises = require("node:fs/promises");
const { createHash } = require("node:crypto");
const net = require("node:net");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const ExcelJS = require("exceljs");

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
  "visualbridge.openDocument",
  "visualbridge.openProjectSettings",
  "visualbridge.refreshProjects",
  "visualbridge.safeDeleteElement",
  "visualbridge.revealReference",
];

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
        type: "project.setTableLayout",
        tableLayout: { nameKeyRow: 1, dataStartRow: 3 },
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
        type: "project.setTableLayout",
        tableLayout: { nameKeyRow: 1, dataStartRow },
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
    assert.equal(changed.tableLayout.nameKeyRow, 1);
    assert.ok(changed.tableLayout.dataStartRow === 3 || changed.tableLayout.dataStartRow === 4);
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
      const result = await vscode.commands.executeCommand("visualbridge.test.parseGraphCatalog", testCase.value);
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
    assert.equal(record.formatVersion, 1);
    assert.equal(record.protocolVersion, 1);
    assert.equal(record.windowId, state.windowId);
    assert.equal(record.token, state.token);
    assert.equal(record.pid, process.pid);
    assert.equal(record.generation, state.generation);
    assert.match(record.token, /^[0-9a-f]{48,64}$/);
    assert.match(record.pipePath, /^\\\\.\\pipe\\visualbridge-bridge-[0-9a-f-]+$/);
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
      socket.setEncoding("utf8");
      const lines = [];
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length > 0) lines.push(JSON.parse(line));
        }
      });
      return {
        socket,
        lines,
        send: (message) => socket.write(`${JSON.stringify(message)}\n`),
        sendRaw: (line) => socket.write(`${line}\n`),
        waitForLine: async (predicate, message) => {
          await waitForAsync(() => lines.find(predicate), (value) => value !== undefined, 20_000, message);
          return lines.find(predicate);
        },
      };
    };
    const hello = (token) => ({
      type: "hello",
      protocolVersion: 1,
      token,
      clientInstanceId: "1b3121ab-2646-4e0f-a789-e970d4fbca8f",
      capabilities: ["open", "reveal"],
    });

    // 无效 token 以连接级错误拒绝。
    {
      const connection = await connectBridge();
      try {
        connection.send(hello("0".repeat(48)));
        const errorLine = await connection.waitForLine(
          (line) => line.type === "error", "Bridge server did not reject an invalid token.");
        assert.equal(errorLine.code, "bridge.invalidToken");
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
        assert.equal(welcome.protocolVersion, 1);
        assert.equal(welcome.windowId, state.windowId);
        assert.equal(welcome.serverGeneration, state.generation);

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
    const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      let handshake = false;
      socket.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line);
          if (!handshake) {
            if (message.type === "hello" && message.token === token && message.protocolVersion === 1) {
              handshake = true;
              send(socket, {
                type: "welcome",
                protocolVersion: 1,
                coreVersion: 1,
                instanceId,
                kind: "editor-play",
                generation: 1,
                capabilities,
                startedAt,
              });
            } else {
              send(socket, { type: "error", code: "runtime.invalidToken" });
              socket.destroy();
            }
            continue;
          }

          if (message.type !== "request") continue;
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
      protocolVersion: 1,
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
        second.setEncoding("utf8");
        const lines = [];
        let lineBuffer = "";
        second.on("data", (chunk) => {
          lineBuffer += chunk;
          let index;
          while ((index = lineBuffer.indexOf("\n")) >= 0) {
            const line = lineBuffer.slice(0, index);
            lineBuffer = lineBuffer.slice(index + 1);
            if (line.trim().length > 0) lines.push(JSON.parse(line));
          }
        });
        send(second, {
          type: "hello",
          protocolVersion: 1,
          coreVersion: 1,
          token,
          clientInstanceId: "6e4d75d6-2b15-4f5e-9d8a-4c0d5f1a9b2c",
          capabilities,
        });
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
    const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);
    const pushBatch = (events) => {
      for (const socket of subscribers) {
        send(socket, { type: "event", event: "graphExecution", executionEvents: events });
      }
    };
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      let handshake = false;
      socket.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line);
          if (!handshake) {
            if (message.type === "hello" && message.token === token && message.protocolVersion === 1) {
              handshake = true;
              send(socket, {
                type: "welcome",
                protocolVersion: 1,
                coreVersion: 1,
                instanceId,
                kind: "editor-play",
                generation: 1,
                capabilities,
                startedAt,
              });
            } else {
              send(socket, { type: "error", code: "runtime.invalidToken" });
              socket.destroy();
            }
            continue;
          }

          if (message.type !== "request") continue;
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
      protocolVersion: 1,
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
      assert.deepEqual([...welcome.capabilities], capabilities);

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
      observer.setEncoding("utf8");
      const observerLines = [];
      let observerBuffer = "";
      observer.on("data", (chunk) => {
        observerBuffer += chunk;
        let index;
        while ((index = observerBuffer.indexOf("\n")) >= 0) {
          const line = observerBuffer.slice(0, index);
          observerBuffer = observerBuffer.slice(index + 1);
          if (line.trim().length > 0) observerLines.push(JSON.parse(line));
        }
      });
      send(observer, {
        type: "hello",
        protocolVersion: 1,
        coreVersion: 1,
        token,
        clientInstanceId: "6e4d75d6-2b15-4f5e-9d8a-4c0d5f1a9b2d",
        capabilities,
      });
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
    const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);
    const pushBatch = (events) => {
      for (const socket of subscribers) {
        send(socket, { type: "event", event: "graphExecution", executionEvents: events });
      }
    };
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      let handshake = false;
      socket.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line);
          if (!handshake) {
            if (message.type === "hello" && message.token === token && message.protocolVersion === 1) {
              handshake = true;
              send(socket, {
                type: "welcome",
                protocolVersion: 1,
                coreVersion: 1,
                instanceId,
                kind: "editor-play",
                generation: 1,
                capabilities,
                startedAt,
              });
            } else {
              send(socket, { type: "error", code: "runtime.invalidToken" });
              socket.destroy();
            }
            continue;
          }

          if (message.type !== "request") continue;
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
      protocolVersion: 1,
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
