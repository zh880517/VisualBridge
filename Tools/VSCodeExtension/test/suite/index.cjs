const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, symlink, unlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
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
  "visualbridge.documentBrowser.copy",
  "visualbridge.documentBrowser.move",
  "visualbridge.documentBrowser.open",
  "visualbridge.documentBrowser.refresh",
  "visualbridge.documentBrowser.renamePath",
  "visualbridge.documentBrowser.renameReferenceTarget",
  "visualbridge.documentBrowser.revealReference",
  "visualbridge.documentBrowser.search",
  "visualbridge.documentBrowser.safeDelete",
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

  await test("registers the stable host commands", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    EXPECTED_COMMANDS.forEach((command) => {
      assert.ok(commands.has(command), `Command '${command}' was not registered.`);
    });
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
