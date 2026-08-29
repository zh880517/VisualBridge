import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const serverPath = path.join(packageRoot, "dist", "server.js");

test("MCP V2 exposes seven stable tools and routes Graph semantics with real cross-process conflicts", async () => {
  await withFixture("GraphSemanticProject", async ({ temporaryRoot, projectRoot, client, stderr }) => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "visualbridge_apply_operations",
        "visualbridge_catalog",
        "visualbridge_document",
        "visualbridge_document_lifecycle",
        "visualbridge_project",
        "visualbridge_refactor_reference",
        "visualbridge_references",
      ],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} input must be structured.`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} input must reject unknown keys.`);
      const outputBranches = tool.outputSchema.anyOf ?? tool.outputSchema.oneOf;
      assert.equal(outputBranches.length, 2, `${tool.name} output must discriminate success and error.`);
      assert.ok(outputBranches.every((branch) => branch.type === "object" && branch.additionalProperties === false));
    }
    assert.equal(
      listed.tools.find((tool) => tool.name === "visualbridge_apply_operations")?.annotations?.destructiveHint,
      true,
    );

    const discovery = await call(client, "visualbridge_project", { action: "discover" });
    assert.equal(discovery.projects.length, 1);
    const projectFile = discovery.projects[0].projectFile;
    const project = await call(client, "visualbridge_project", { action: "read", projectFile });
    assert.equal(project.definition.projectId, "GraphSemanticProject");
    assert.deepEqual(project.supportedEditors, ["entity", "graph", "structured", "table"]);
    const documents = await call(client, "visualbridge_project", {
      action: "listDocuments",
      projectFile,
      editor: "graph",
      query: "semantic",
    });
    assert.deepEqual(documents.results.map((entry) => entry.path), ["Graph/SemanticSample.vbgraph"]);

    const selector = { projectFile, documentTypeId: "logicGraph", editor: "graph" };
    const catalog = await call(client, "visualbridge_catalog", {
      ...selector,
      action: "read",
      kind: "summary",
    });
    assert.deepEqual(catalog.counts, { dataTypes: 5, graphTypes: 2, nodeTypes: 15 });
    const catalogSearch = await call(client, "visualbridge_catalog", {
      ...selector,
      action: "search",
      kind: "nodeTypes",
      query: "legacy.step",
      selector: { graphTypeId: "legacy.root" },
    });
    assert.deepEqual(catalogSearch.results.map((entry) => entry.id), ["sample.step"]);
    assert.deepEqual(await call(client, "visualbridge_catalog", {
      ...selector,
      action: "search",
      kind: "nodeTypes",
      query: "legacy.step",
      selector: { graphTypeId: "legacy.root" },
    }), catalogSearch);

    const graphPath = "Graph/SemanticSample.vbgraph";
    const graph = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: graphPath,
    });
    assert.equal(graph.valid, true);
    assert.match(graph.baseHash, /^[a-f0-9]{64}$/);
    assert.equal(graph.document.documentId, "semantic-sample");
    const search = await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: graphPath,
      query: "step_b",
      selector: { kind: "node" },
      limit: 1,
    });
    assert.deepEqual(search.results.map((entry) => entry.nodeId), ["step_b"]);
    assert.deepEqual(await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: graphPath,
      query: "step_b",
      selector: { kind: "node" },
      limit: 1,
    }), search);
    const validation = await call(client, "visualbridge_document", {
      ...selector,
      action: "validate",
      path: graphPath,
    });
    assert.equal(validation.valid, true);
    assert.equal(validation.baseHash, graph.baseHash);

    const graphCopySelector = {
      projectId: "GraphSemanticProject",
      documentTypeId: "logicGraph",
      editor: "graph",
    };
    const graphCopySeed = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: {
        kind: "copy",
        source: { ...graphCopySelector, path: graphPath },
        target: { ...graphCopySelector, path: "Graph/EdgeCollisionCopy.vbgraph" },
        stableIdRemap: [],
      },
    });
    const graphEdges = graphCopySeed.plan.ownedIdentities.filter((identity) => identity.kind === "edge");
    assert.ok(graphEdges.length >= 2);
    const collidingEdge = graphEdges[0];
    const existingEdge = graphEdges[1];
    const graphCollisionPreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: {
        kind: "copy",
        source: { ...graphCopySelector, path: graphPath },
        target: { ...graphCopySelector, path: "Graph/EdgeCollisionCopy.vbgraph" },
        stableIdRemap: graphCopySeed.plan.ownedIdentities.map((identity, index) => ({
          identityKey: identity.identityKey,
          from: identity.value,
          to: identity.identityKey === collidingEdge.identityKey ? existingEdge.value : `copy${index}`,
        })),
      },
    });
    assert.ok(graphCollisionPreview.plan.blockers.some((blocker) => (
      blocker.code === "identity.targetCollision" && blocker.identityKey === collidingEdge.identityKey
    )), JSON.stringify(graphCollisionPreview.plan.blockers));

    const wrongEditor = await client.callTool({
      name: "visualbridge_document",
      arguments: { ...selector, editor: "entity", action: "read", path: graphPath },
    });
    assert.equal(wrongEditor.isError, true);
    assert.equal(wrongEditor.structuredContent.status, "error");
    assert.equal(Object.hasOwn(wrongEditor.structuredContent, "data"), false);
    assert.equal(Object.hasOwn(wrongEditor.structuredContent, "error"), true);
    const unknownInput = await client.callTool({
      name: "visualbridge_document",
      arguments: { ...selector, action: "read", path: graphPath, unknown: true },
    });
    assert.equal(unknownInput.isError, true);
    const driveQualifiedPath = await client.callTool({
      name: "visualbridge_apply_operations",
      arguments: {
        ...selector,
        path: "Graph/C:/secret.vbgraph",
        baseHash: graph.baseHash,
        operations: [{ type: "graph.updateGraph", graphId: "root", title: "Unsafe", properties: {} }],
      },
    });
    assert.equal(driveQualifiedPath.isError, true);
    const wrongCatalogEditor = await client.callTool({
      name: "visualbridge_catalog",
      arguments: { ...selector, editor: "entity", action: "read", kind: "summary" },
    });
    assert.equal(wrongCatalogEditor.isError, true);
    const wrongApplyEditor = await client.callTool({
      name: "visualbridge_apply_operations",
      arguments: {
        ...selector,
        editor: "entity",
        path: graphPath,
        baseHash: graph.baseHash,
        operations: [{ type: "graph.updateGraph", graphId: "root", title: "Wrong", properties: {} }],
      },
    });
    assert.equal(wrongApplyEditor.isError, true);

    const documentReference = await call(client, "visualbridge_references", {
      projectFile,
      action: "resolve",
      kind: "document",
      target: { documentTypeId: "logicGraph" },
      value: "semantic-sample",
    });
    assert.equal(documentReference.status, "resolved");
    const refactor = await call(client, "visualbridge_refactor_reference", {
      projectFile,
      action: "preview",
      kind: "graph.element",
      target: { documentTypeId: "logicGraph", elementKind: "node" },
      oldValue: "step_b",
      newValue: "step_second",
    });
    assert.match(refactor.previewHash, /^[a-f0-9]{64}$/);
    assert.equal(refactor.sources.length, 1);

    const graphFile = path.join(projectRoot, "Graph", "SemanticSample.vbgraph");
    const beforeInvalid = await readFile(graphFile);
    const invalid = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: graphPath,
      baseHash: graph.baseHash,
      operations: [
        { type: "graph.updateGraph", graphId: "root", title: "Must Roll Back", properties: {} },
        { type: "graph.removeNode", graphId: "root", nodeId: "missing" },
      ],
    });
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(await readFile(graphFile), beforeInvalid);

    const second = await startClient(temporaryRoot);
    try {
      const secondRead = await call(second.client, "visualbridge_document", {
        ...selector,
        action: "read",
        path: graphPath,
      });
      assert.equal(secondRead.baseHash, graph.baseHash);
      const applied = await call(client, "visualbridge_apply_operations", {
        ...selector,
        path: graphPath,
        baseHash: graph.baseHash,
        operations: [{
          type: "graph.updateGraph",
          graphId: "root",
          title: "Updated Through MCP V2",
          properties: { priority: 2 },
        }],
      });
      assert.equal(applied.status, "applied");
      const conflict = await call(second.client, "visualbridge_apply_operations", {
        ...selector,
        path: graphPath,
        baseHash: secondRead.baseHash,
        operations: [{
          type: "graph.updateGraph",
          graphId: "root",
          title: "Stale Writer",
          properties: { priority: 3 },
        }],
      });
      assert.equal(conflict.status, "conflict");
      assert.equal(conflict.reason, "baseHashMismatch");
      const reread = await call(client, "visualbridge_document", {
        ...selector,
        action: "read",
        path: graphPath,
      });
      assert.equal(reread.document.graphs.find((entry) => entry.id === "root").title, "Updated Through MCP V2");
    } finally {
      await second.client.close().catch(() => undefined);
      assert.equal(second.stderr(), "", second.stderr());
    }

    const invalidPath = path.join(projectRoot, "Graph", "Invalid.vbgraph");
    await writeFile(invalidPath, '{"formatVersion":3}\n', "utf8");
    const invalidRead = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: "Graph/Invalid.vbgraph",
    });
    assert.equal(invalidRead.valid, false);
    assert.ok(invalidRead.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
    assert.equal(stderr(), "", stderr());
  });
});

test("MCP V2 Entity adapter reads custom extensions, searches Catalog/Documents and applies atomic batches", async () => {
  await withFixture("EntitySemanticProject", async ({ projectRoot, client }) => {
    const discovery = await call(client, "visualbridge_project", { action: "discover" });
    const projectFile = discovery.projects[0].projectFile;
    const selector = { projectFile, documentTypeId: "hero-config", editor: "entity" };
    const catalog = await call(client, "visualbridge_catalog", {
      ...selector,
      action: "read",
      kind: "summary",
    });
    assert.deepEqual(catalog.counts, { componentGroups: 3, entityTypes: 1, componentTypes: 4 });
    const componentTypes = await call(client, "visualbridge_catalog", {
      ...selector,
      action: "search",
      kind: "componentTypes",
      query: "health",
      selector: { entityTypeId: "sample.entity.player" },
    });
    assert.deepEqual(componentTypes.results.map((entry) => entry.id), ["sample.component.health"]);

    const entityPath = "Config/Entities/Player.herojson";
    const entity = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: entityPath,
    });
    assert.equal(entity.valid, true);
    assert.equal(entity.document.documentId, "sample.player");
    const fieldSearch = await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: entityPath,
      query: "Knight",
    });
    assert.ok(fieldSearch.results.some((entry) => entry.path === "properties.displayName"));
    const validation = await call(client, "visualbridge_document", {
      ...selector,
      action: "validate",
      path: entityPath,
    });
    assert.equal(validation.valid, true);

    const entityFile = path.join(projectRoot, "Config", "Entities", "Player.herojson");
    const beforeInvalid = await readFile(entityFile);
    const invalid = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: entityPath,
      baseHash: entity.baseHash,
      operations: [
        { type: "entity.setTitle", title: "Must Roll Back" },
        { type: "entity.removeComponent", componentId: "missing" },
      ],
    });
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(await readFile(entityFile), beforeInvalid);

    const applied = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: entityPath,
      baseHash: entity.baseHash,
      operations: [
        { type: "entity.setTitle", title: "Player MCP V2" },
        { type: "entity.setComponentEnabled", componentId: "move", enabled: true },
        { type: "entity.setComponentProperty", componentId: "health", propertyId: "regeneration", value: 3.5 },
      ],
    });
    assert.equal(applied.status, "applied", JSON.stringify(applied.diagnostics));
    const updated = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: entityPath,
    });
    assert.equal(updated.document.title, "Player MCP V2");
    assert.equal(updated.document.components.find((component) => component.id === "move").enabled, true);
    assert.equal(updated.document.components.find((component) => component.id === "health").properties.regeneration, 3.5);

    const renamePreview = await call(client, "visualbridge_refactor_reference", {
      projectFile,
      action: "preview",
      kind: "entity.component",
      target: { documentTypeId: "hero-config" },
      oldValue: "health",
      newValue: "health_primary",
    });
    const renamed = await call(client, "visualbridge_refactor_reference", {
      projectFile,
      action: "apply",
      kind: "entity.component",
      target: { documentTypeId: "hero-config" },
      oldValue: "health",
      newValue: "health_primary",
      previewHash: renamePreview.previewHash,
      baseHashes: renamePreview.baseHashes,
    });
    assert.equal(renamed.status, "applied");
    const refactored = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: entityPath,
    });
    assert.equal(refactored.document.properties.primaryComponentId, "health_primary");
    assert.ok(refactored.document.components.some((component) => component.id === "health_primary"));

    const stale = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: entityPath,
      baseHash: entity.baseHash,
      operations: [{ type: "entity.setTitle", title: "Stale" }],
    });
    assert.equal(stale.status, "conflict");
  });
});

test("MCP document lifecycle copies, moves, and safely deletes Entity content with strict preview conflicts", async () => {
  await withFixture("EntitySemanticProject", async ({ projectRoot, client }) => {
    const discovery = await call(client, "visualbridge_project", { action: "discover" });
    const projectFile = discovery.projects[0].projectFile;
    const projectId = "visualbridge.entity-semantics";
    const selector = { projectId, documentTypeId: "hero-config", editor: "entity" };
    const sourcePath = "Config/Entities/Player.herojson";
    const copyPath = "Config/Entities/PlayerCopy.herojson";
    const movedPath = "Config/Entities/PlayerMoved.herojson";
    const sourceFile = path.join(projectRoot, ...sourcePath.split("/"));
    const copyFile = path.join(projectRoot, ...copyPath.split("/"));
    const movedFile = path.join(projectRoot, ...movedPath.split("/"));
    const sourceBefore = await readFile(sourceFile);
    const copyOperation = {
      kind: "copy",
      source: { ...selector, path: sourcePath },
      target: { ...selector, path: copyPath },
      stableIdRemap: [{ identityKey: "document", from: "sample.player", to: "sample.player.copy" }, {
        identityKey: "component:health",
        from: "health",
        to: "health_copy",
      }, {
        identityKey: "component:move",
        from: "move",
        to: "move_copy",
      }],
    };
    const copyPreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: copyOperation,
    });
    assert.equal(copyPreview.status, "preview");
    assert.equal(copyPreview.plan.blockers.length, 0, JSON.stringify(copyPreview.plan.blockers));
    assert.deepEqual(copyPreview.plan.stableIdRemap.map((entry) => entry.identityKey), [
      "component:health",
      "component:move",
      "document",
    ]);
    assert.ok(copyPreview.plan.referenceImpacts.some((impact) => (
      impact.kind === "internalRetarget" && impact.occurrence.path === "properties.primaryComponentId"
    )));
    assert.ok(copyPreview.plan.referenceImpacts.some((impact) => (
      impact.kind === "outboundPreserved" && impact.occurrence.path === "properties.primarySkillId"
    )));
    assert.ok(copyPreview.plan.referenceImpacts.every((impact) => impact.kind !== "targetLocationChanged"));
    assert.deepEqual(copyPreview.plan.baseHashes, { [sourcePath]: hash(sourceBefore) });
    assert.deepEqual(copyPreview.plan.dependencies.map((dependency) => dependency.kind), [
      "catalog",
      "documentSet",
      "project",
      "referenceIndex",
    ]);
    const copied = await call(client, "visualbridge_document_lifecycle", lifecycleApply(
      projectFile,
      copyOperation,
      copyPreview,
    ));
    assert.equal(copied.status, "applied");
    assert.deepEqual(await readFile(sourceFile), sourceBefore, "Copy must not mutate its source document.");
    const copyDocument = await call(client, "visualbridge_document", {
      action: "read",
      projectFile,
      documentTypeId: selector.documentTypeId,
      editor: selector.editor,
      path: copyPath,
    });
    assert.equal(copyDocument.document.documentId, "sample.player.copy");
    assert.deepEqual(copyDocument.document.components.map((component) => component.id), ["health_copy", "move_copy"]);
    assert.equal(copyDocument.document.properties.primaryComponentId, "health_copy");
    assert.equal(copyDocument.document.properties.primarySkillId, 101);

    const blockedCopyPreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: copyOperation,
    });
    assert.ok(blockedCopyPreview.plan.blockers.some((blocker) => blocker.code === "target.exists"));
    assert.equal(blockedCopyPreview.plan.mutations.length, 1, "Blocked Copy still exposes its canonical mutation plan.");
    assert.deepEqual(blockedCopyPreview.plan.baseHashes, { [sourcePath]: hash(sourceBefore) });
    const invalidBlockedCopyPreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: { ...copyOperation, stableIdRemap: [] },
    });
    assert.ok(invalidBlockedCopyPreview.plan.blockers.some((blocker) => blocker.code === "target.exists"));
    assert.ok(invalidBlockedCopyPreview.plan.blockers.some((blocker) => blocker.code === "identity.remapMissing"));

    const moveOperation = {
      kind: "move",
      source: { ...selector, path: copyPath },
      target: { ...selector, path: movedPath },
    };
    const staleMovePreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: moveOperation,
    });
    const externallyChanged = JSON.parse(await readFile(copyFile, "utf8"));
    externallyChanged.title = "Changed after lifecycle preview";
    await writeFile(copyFile, `${JSON.stringify(externallyChanged, undefined, 2)}\n`, "utf8");
    const staleMove = await call(client, "visualbridge_document_lifecycle", lifecycleApply(
      projectFile,
      moveOperation,
      staleMovePreview,
    ));
    assert.equal(staleMove.status, "conflict");
    assert.equal(staleMove.reason, "baseHashMismatch");
    assert.equal(await readFile(copyFile, "utf8"), `${JSON.stringify(externallyChanged, undefined, 2)}\n`);
    await assert.rejects(readFile(movedFile), { code: "ENOENT" });

    const movePreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: moveOperation,
    });
    const moved = await call(client, "visualbridge_document_lifecycle", lifecycleApply(projectFile, moveOperation, movePreview));
    assert.equal(moved.status, "applied");
    await assert.rejects(readFile(copyFile), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(movedFile, "utf8")).title, "Changed after lifecycle preview");

    const sourceDocument = await call(client, "visualbridge_document", {
      action: "read",
      projectFile,
      documentTypeId: selector.documentTypeId,
      editor: selector.editor,
      path: sourcePath,
    });
    const guarded = await call(client, "visualbridge_apply_operations", {
      projectFile,
      documentTypeId: selector.documentTypeId,
      editor: selector.editor,
      path: sourcePath,
      baseHash: sourceDocument.baseHash,
      operations: [{ type: "entity.removeComponent", componentId: "move" }],
    });
    assert.equal(guarded.status, "invalid");
    assert.ok(guarded.diagnostics.some((diagnostic) => diagnostic.code === "lifecycle.required"));

    const deleteOperation = {
      kind: "delete",
      source: { ...selector, path: sourcePath },
      target: { kind: "entity.component", componentId: "move" },
    };
    const staleDeletePreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: deleteOperation,
    });
    const catalogFile = path.join(projectRoot, "Catalog", "Common.vbentitycatalog");
    await writeFile(catalogFile, `${await readFile(catalogFile, "utf8")}\n`, "utf8");
    const staleDelete = await call(client, "visualbridge_document_lifecycle", lifecycleApply(
      projectFile,
      deleteOperation,
      staleDeletePreview,
    ));
    assert.equal(staleDelete.status, "conflict");
    assert.equal(staleDelete.reason, "dependencyChanged");
    assert.ok(JSON.parse(await readFile(sourceFile, "utf8")).components.some((component) => component.id === "move"));

    const deletePreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: deleteOperation,
    });
    assert.equal(deletePreview.plan.blockers.length, 0, JSON.stringify(deletePreview.plan.blockers));
    assert.deepEqual(deletePreview.plan.ownedIdentities.map((identity) => identity.identityKey), ["component:move"]);
    const deleted = await call(client, "visualbridge_document_lifecycle", lifecycleApply(
      projectFile,
      deleteOperation,
      deletePreview,
    ));
    assert.equal(deleted.status, "applied");
    const afterDelete = JSON.parse(await readFile(sourceFile, "utf8"));
    assert.deepEqual(afterDelete.components.map((component) => component.id), ["health"]);
  });
});

test("MCP lifecycle preserves allowMissing outbound values while copying", async () => {
  await withFixture("EntitySemanticProject", async ({ projectRoot, client }) => {
    const catalogFile = path.join(projectRoot, "Catalog", "Common.vbentitycatalog");
    const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
    const primarySkill = catalog.entityTypes[0].properties.find((property) => property.id === "primarySkillId");
    primarySkill.reference.allowMissing = true;
    await writeFile(catalogFile, `${JSON.stringify(catalog, undefined, 2)}\n`, "utf8");

    const sourcePath = "Config/Entities/Player.herojson";
    const sourceFile = path.join(projectRoot, ...sourcePath.split("/"));
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    source.properties.primarySkillId = 999999;
    await writeFile(sourceFile, `${JSON.stringify(source, undefined, 2)}\n`, "utf8");

    const projectFile = (await call(client, "visualbridge_project", { action: "discover" })).projects[0].projectFile;
    const selector = {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "hero-config",
      editor: "entity",
    };
    const targetPath = "Config/Entities/PlayerAllowMissing.herojson";
    const operation = {
      kind: "copy",
      source: { ...selector, path: sourcePath },
      target: { ...selector, path: targetPath },
      stableIdRemap: [{ identityKey: "document", from: "sample.player", to: "sample.player.allow-missing" }, {
        identityKey: "component:health",
        from: "health",
        to: "health_allow_missing",
      }, {
        identityKey: "component:move",
        from: "move",
        to: "move_allow_missing",
      }],
    };
    const preview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation,
    });
    assert.equal(preview.plan.blockers.length, 0, JSON.stringify(preview.plan.blockers));
    const impact = preview.plan.referenceImpacts.find((entry) => (
      entry.kind === "outboundPreserved" && entry.occurrence.path === "properties.primarySkillId"
    ));
    assert.ok(impact, JSON.stringify(preview.plan.referenceImpacts));
    assert.equal(Object.hasOwn(impact, "target"), false);

    const applied = await call(client, "visualbridge_document_lifecycle", lifecycleApply(projectFile, operation, preview));
    assert.equal(applied.status, "applied");
    const copied = JSON.parse(await readFile(path.join(projectRoot, ...targetPath.split("/")), "utf8"));
    assert.equal(copied.properties.primarySkillId, 999999);
  });
});

test("MCP safe delete fails closed for invalid semantic sources and unavailable reference providers", async () => {
  await withFixture("EntitySemanticProject", async ({ projectRoot, client }) => {
    const projectFile = (await call(client, "visualbridge_project", { action: "discover" })).projects[0].projectFile;
    const selector = {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "hero-config",
      editor: "entity",
      path: "Config/Entities/Player.herojson",
    };
    const operation = {
      kind: "delete",
      source: selector,
      target: { kind: "entity.component", componentId: "move" },
    };
    const source = JSON.parse(await readFile(path.join(projectRoot, ...selector.path.split("/")), "utf8"));
    source.documentId = "sample.invalid.external";
    source.entityTypeId = "missing.entity.type";
    const invalidFile = path.join(projectRoot, "Config", "Entities", "Invalid.herojson");
    await writeFile(invalidFile, `${JSON.stringify(source, undefined, 2)}\n`, "utf8");

    const semanticError = await client.callTool({
      name: "visualbridge_document_lifecycle",
      arguments: { action: "preview", projectFile, operation },
    });
    assert.equal(semanticError.isError, true);
    assert.equal(semanticError.structuredContent.error.code, "lifecycle.invalidSource");
    assert.ok(semanticError.structuredContent.error.details.some((diagnostic) => diagnostic.severity === "error"));

    await unlink(invalidFile);
    const catalogFile = path.join(projectRoot, "Catalog", "Common.vbentitycatalog");
    const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
    const primarySkill = catalog.entityTypes[0].properties.find((property) => property.id === "primarySkillId");
    primarySkill.reference.kind = "missing.provider";
    await writeFile(catalogFile, `${JSON.stringify(catalog, undefined, 2)}\n`, "utf8");
    const providerError = await client.callTool({
      name: "visualbridge_document_lifecycle",
      arguments: { action: "preview", projectFile, operation },
    });
    assert.equal(providerError.isError, true);
    assert.equal(providerError.structuredContent.error.code, "lifecycle.invalidSource");
    assert.ok(providerError.structuredContent.error.details.some((diagnostic) => (
      diagnostic.code === "reference.providerUnavailable"
    )));

    primarySkill.reference.kind = "table.row";
    primarySkill.reference.target = {
      tableTypeId: "sample.table.skills",
      sheetId: "skills",
      unsupportedSelector: "invalid",
    };
    await writeFile(catalogFile, `${JSON.stringify(catalog, undefined, 2)}\n`, "utf8");
    const invalidTarget = await client.callTool({
      name: "visualbridge_document_lifecycle",
      arguments: { action: "preview", projectFile, operation },
    });
    assert.equal(invalidTarget.isError, true);
    assert.equal(invalidTarget.structuredContent.error.code, "lifecycle.invalidSource");
    assert.ok(invalidTarget.structuredContent.error.details.some((diagnostic) => (
      diagnostic.code === "reference.invalidTarget"
    )));
  });
});

test("MCP Table lifecycle resolves key aliases for safe delete", async () => {
  await withFixture("EntitySemanticProject", async ({ projectRoot, client }) => {
    const catalogFile = path.join(projectRoot, "Catalog", "Skills.vbtablecatalog");
    const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
    const sheetDefinition = catalog.tableTypes[0].sheets[0];
    sheetDefinition.columns.find((column) => column.id === "id").aliases = ["skillId"];
    sheetDefinition.keyColumnId = "skillId";
    sheetDefinition.partition.deduplicateByColumnId = "skillId";
    await writeFile(catalogFile, `${JSON.stringify(catalog, undefined, 2)}\n`, "utf8");

    const projectFile = (await call(client, "visualbridge_project", { action: "discover" })).projects[0].projectFile;
    const selector = {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      editor: "table",
      path: "Tables/Skills_Main.skillstable",
    };
    const table = await call(client, "visualbridge_document", {
      action: "read",
      projectFile,
      documentTypeId: selector.documentTypeId,
      editor: selector.editor,
      path: selector.path,
    });
    const physicalSheet = table.sheets[0];
    const tablePage = await call(client, "visualbridge_document", {
      action: "read",
      projectFile,
      documentTypeId: selector.documentTypeId,
      editor: selector.editor,
      path: selector.path,
      selector: { sheetId: physicalSheet.id },
    });
    const referencedRow = tablePage.page.rows.find((row) => row.cells.id === 101);
    const deletePreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: {
        kind: "delete",
        source: selector,
        target: { kind: "table.row", sheetId: physicalSheet.id, rowId: referencedRow.id },
      },
    });
    assert.ok(deletePreview.plan.blockers.some((blocker) => (
      blocker.code === "reference.inbound"
      && blocker.identityKey === 'table.row:["skills","number",101]'
    )), JSON.stringify(deletePreview.plan.blockers));
  });
});

test("MCP Table lifecycle copies physical-only rows while protecting effective identities", async () => {
  await withFixture("EntitySemanticProject", async ({ projectRoot, client }) => {
    const catalogFile = path.join(projectRoot, "Catalog", "Skills.vbtablecatalog");
    const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
    const sheetDefinition = catalog.tableTypes[0].sheets[0];
    sheetDefinition.partition.deduplicateByColumnId = "name";
    sheetDefinition.partition.duplicatePolicy = "keepFirst";
    await writeFile(catalogFile, `${JSON.stringify(catalog, undefined, 2)}\n`, "utf8");

    const projectFilePath = path.join(projectRoot, "VisualBridge.project.vbjson");
    const projectDefinition = JSON.parse(await readFile(projectFilePath, "utf8"));
    projectDefinition.documentTypes.find((documentType) => documentType.id === "sample.table.skills")
      .include.push("Tables/Copies/Skills_*.skillstable");
    await writeFile(projectFilePath, `${JSON.stringify(projectDefinition, undefined, 2)}\n`, "utf8");
    await writeFile(
      path.join(projectRoot, "Tables", "Skills_Override.skillstable"),
      "Skill name\tSkill ID\nName\tId\nFireball\t901\n",
      "utf8",
    );
    await mkdir(path.join(projectRoot, "Tables", "Copies"), { recursive: true });

    const projectFile = (await call(client, "visualbridge_project", { action: "discover" })).projects[0].projectFile;
    const selector = {
      projectId: "visualbridge.entity-semantics",
      documentTypeId: "sample.table.skills",
      editor: "table",
    };
    const operation = {
      kind: "copy",
      source: { ...selector, path: "Tables/Skills_Main.skillstable" },
      target: { ...selector, path: "Tables/Copies/Skills_Main.skillstable" },
      stableIdRemap: [
        ["table.row", 101, 1101],
        ["table.row", 102, 1102],
        ["table.row", 901, 1901],
        ["table.dedup", "Fireball", "Fireball Copy"],
        ["table.dedup", "Blink", "Blink Copy"],
      ].map(([kind, from, to]) => ({
        identityKey: `${kind}:${JSON.stringify(["skills", typeof from, from])}`,
        from,
        to,
      })),
    };
    const collisionOperation = {
      ...operation,
      stableIdRemap: operation.stableIdRemap.map((entry) => (
        entry.identityKey === 'table.row:["skills","number",901]'
          ? { ...entry, to: 101 }
          : entry
      )),
    };
    const collisionPreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: collisionOperation,
    });
    assert.ok(collisionPreview.plan.blockers.some((blocker) => (
      blocker.code === "identity.targetCollision"
      && blocker.identityKey === 'table.row:["skills","number",901]'
    )), JSON.stringify(collisionPreview.plan.blockers));
    const dedupCollisionPreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: {
        ...operation,
        stableIdRemap: operation.stableIdRemap.map((entry) => (
          entry.identityKey === 'table.dedup:["skills","string","Fireball"]'
            ? { ...entry, to: "Blink" }
            : entry
        )),
      },
    });
    assert.ok(dedupCollisionPreview.plan.blockers.some((blocker) => (
      blocker.code === "identity.targetCollision"
      && blocker.identityKey === 'table.dedup:["skills","string","Fireball"]'
    )), JSON.stringify(dedupCollisionPreview.plan.blockers));

    const preview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation,
    });
    assert.equal(preview.plan.blockers.length, 0, JSON.stringify(preview.plan.blockers));
    const physicalOnly = preview.plan.ownedIdentities.find((identity) => identity.identityKey === 'table.row:["skills","number",901]');
    assert.ok(physicalOnly);
    assert.equal(physicalOnly.reference.definition.kind, "table.row");
    assert.equal(Object.hasOwn(physicalOnly.reference, "location"), false);
    const effective = preview.plan.ownedIdentities.find((identity) => identity.identityKey === 'table.row:["skills","number",101]');
    assert.equal(effective.reference.location.rowId.includes("101"), true);

    const applied = await call(client, "visualbridge_document_lifecycle", lifecycleApply(projectFile, operation, preview));
    assert.equal(applied.status, "applied");
    assert.match(await readFile(path.join(projectRoot, "Tables", "Copies", "Skills_Main.skillstable"), "utf8"), /Fireball Copy\t1101/);
    assert.match(await readFile(path.join(projectRoot, "Tables", "Copies", "Skills_Override.skillstable"), "utf8"), /Fireball Copy\t1901/);
  });
});

test("MCP V2 Structured adapter uses one read/search/validate/apply contract", async () => {
  await withFixture("StructuredSemanticProject", async ({ projectRoot, client }) => {
    const discovery = await call(client, "visualbridge_project", { action: "discover" });
    const projectFile = discovery.projects[0].projectFile;
    const selector = {
      projectFile,
      documentTypeId: "sample.game.settings",
      editor: "structured",
    };
    const catalog = await call(client, "visualbridge_catalog", {
      ...selector,
      action: "search",
      kind: "configTypes",
      query: "settings",
    });
    assert.deepEqual(catalog.results.map((entry) => entry.id), ["sample.game.settings"]);

    const documentPath = "Config/Game.gamesettings";
    const document = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: documentPath,
    });
    assert.equal(document.valid, true);
    assert.equal(document.document.properties.maxPlayers, 5);
    const search = await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: documentPath,
      query: "maxPlayers 5",
    });
    assert.deepEqual(search.results.map((entry) => entry.path), ["properties.maxPlayers"]);
    const validation = await call(client, "visualbridge_document", {
      ...selector,
      action: "validate",
      path: documentPath,
    });
    assert.equal(validation.valid, true);
    assert.equal(validation.baseHash, document.baseHash);

    const sourceFile = path.join(projectRoot, "Config", "Game.gamesettings");
    const beforeInvalid = await readFile(sourceFile);
    const invalid = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: documentPath,
      baseHash: document.baseHash,
      operations: [
        { type: "structured.setField", fieldId: "maxPlayers", value: 8 },
        { type: "structured.setField", fieldId: "missing", value: 1 },
      ],
    });
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(await readFile(sourceFile), beforeInvalid);

    const applied = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: documentPath,
      baseHash: document.baseHash,
      operations: [
        { type: "structured.setField", fieldId: "maxPlayers", value: 8 },
        { type: "structured.setField", fieldId: "accent", value: "#112233FF" },
      ],
    });
    assert.equal(applied.status, "applied");
    const updated = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: documentPath,
    });
    assert.equal(updated.document.properties.maxPlayers, 8);
    assert.equal(updated.document.properties.accent, "#112233FF");

    const createOperation = {
      kind: "create",
      target: {
        projectId: "visualbridge.structured-semantics",
        documentTypeId: selector.documentTypeId,
        editor: selector.editor,
        path: "Config/CreatedByMcp.gamesettings",
      },
      parameters: { documentId: "sample.created.by-mcp" },
    };
    const createPreview = await call(client, "visualbridge_document_lifecycle", {
      action: "preview",
      projectFile,
      operation: createOperation,
    });
    assert.deepEqual(createPreview.plan.baseHashes, {});
    assert.ok(createPreview.plan.ownedIdentities.every((identity) => (
      identity.reference === undefined || Object.hasOwn(identity.reference, "location") === false
    )));
    assert.deepEqual(createPreview.plan.dependencies.map((dependency) => dependency.kind), [
      "catalog",
      "documentSet",
      "project",
      "referenceIndex",
    ]);
  });
});

test("MCP V2 Table adapter preserves CSV families and XLSX through the shared contract", async () => {
  await withFixture("TableSemanticProject", async ({ projectRoot, client }) => {
    const discovery = await call(client, "visualbridge_project", { action: "discover" });
    const projectFile = discovery.projects[0].projectFile;
    const selector = { projectFile, documentTypeId: "game.table.skills", editor: "table" };
    const catalog = await call(client, "visualbridge_catalog", {
      ...selector,
      action: "read",
      kind: "summary",
    });
    assert.deepEqual(catalog.counts, { tableTypes: 1, sheets: 1, columns: 5 });
    const columns = await call(client, "visualbridge_catalog", {
      ...selector,
      action: "search",
      kind: "columns",
      query: "rewards",
    });
    assert.deepEqual(columns.results.map((entry) => entry.id), ["rewards"]);

    const csvPath = "Tables/Skills_A.csv";
    const csv = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: csvPath,
      selector: { sheetId: "skills:Skills_A" },
    });
    assert.equal(csv.valid, true);
    assert.equal(csv.format, "csv");
    assert.equal(csv.sources.length, 2);
    assert.equal(csv.page.rows[0].cells.name, "Fireball");
    const rowSearch = await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: csvPath,
      query: "Blink",
      selector: { sheetDefinitionId: "skills", effectiveOnly: true },
    });
    assert.deepEqual(rowSearch.results.map((entry) => entry.rowId), ["Skills_A:key-102", "Skills_B:key-202"]);
    const firstPage = await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: csvPath,
      query: "Blink",
      selector: { sheetDefinitionId: "skills", effectiveOnly: true },
      limit: 1,
    });
    assert.deepEqual(firstPage.results.map((entry) => entry.rowId), ["Skills_A:key-102"]);
    assert.equal(typeof firstPage.nextCursor, "string");
    const secondPage = await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: csvPath,
      query: "Blink",
      selector: { sheetDefinitionId: "skills", effectiveOnly: true },
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    assert.deepEqual(secondPage.results.map((entry) => entry.rowId), ["Skills_B:key-202"]);
    assert.equal(secondPage.nextCursor, undefined);
    const mismatchedCursor = await client.callTool({
      name: "visualbridge_document",
      arguments: {
        ...selector,
        action: "search",
        path: csvPath,
        query: "Fireball",
        selector: { sheetDefinitionId: "skills", effectiveOnly: true },
        limit: 1,
        cursor: firstPage.nextCursor,
      },
    });
    assert.equal(mismatchedCursor.isError, true);
    const validation = await call(client, "visualbridge_document", {
      ...selector,
      action: "validate",
      path: csvPath,
    });
    assert.equal(validation.valid, true);

    const guardedRowDelete = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [{
        type: "table.removeRow",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
      }],
    });
    assert.equal(guardedRowDelete.status, "invalid");
    assert.ok(guardedRowDelete.diagnostics.some((diagnostic) => diagnostic.code === "lifecycle.required"));
    const guardedKeyRename = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-101",
        columnId: "id",
        value: 999,
      }],
    });
    assert.equal(guardedKeyRename.status, "invalid");
    assert.ok(guardedKeyRename.diagnostics.some((diagnostic) => diagnostic.code === "lifecycle.required"));

    const csvBFile = path.join(projectRoot, "Tables", "Skills_B.csv");
    const beforeInvalid = await readFile(csvBFile);
    const invalid = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [
        {
          type: "table.setCell",
          sheetId: "skills:Skills_B",
          rowId: "Skills_B:key-202",
          columnId: "name",
          value: "Must Roll Back",
        },
        {
          type: "table.setCell",
          sheetId: "skills:Skills_B",
          rowId: "missing",
          columnId: "name",
          value: "Invalid",
        },
      ],
    });
    assert.equal(invalid.status, "invalid");
    assert.deepEqual(await readFile(csvBFile), beforeInvalid);

    const appliedCsv = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: csvPath,
      baseHash: csv.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_B",
        rowId: "Skills_B:key-202",
        columnId: "name",
        value: "Frost Nova MCP V2",
      }],
    });
    assert.equal(appliedCsv.status, "applied");
    const updatedCsv = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: csvPath,
      selector: { sheetId: "skills:Skills_B" },
    });
    assert.equal(updatedCsv.page.rows.find((row) => row.id === "Skills_B:key-202").cells.name, "Frost Nova MCP V2");

    const recoverableBytes = await readFile(csvBFile);
    const interruptedBytes = Buffer.from("broken during interrupted table transaction\n", "utf8");
    const interruptedId = "00000000-0000-4000-8000-000000000005";
    const interruptedTemporary = `${csvBFile}.visualbridge-${interruptedId}.tmp`;
    const interruptedBackup = `${csvBFile}.visualbridge-${interruptedId}.rollback`;
    await writeFile(interruptedTemporary, interruptedBytes);
    await writeFile(interruptedBackup, recoverableBytes);
    await unlink(csvBFile);
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.json"), `${JSON.stringify({
      version: 1,
      transactionId: interruptedId,
      phase: "prepared",
      entries: [{
        path: "Tables/Skills_B.csv",
        absolutePath: csvBFile,
        temporaryPath: interruptedTemporary,
        backupPath: interruptedBackup,
        beforeHash: hash(recoverableBytes),
        afterHash: hash(interruptedBytes),
      }],
    }, null, 2)}\n`, "utf8");
    const deadTableOwner = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadTablePid = deadTableOwner.pid;
    await once(deadTableOwner, "exit");
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.lock"), `${JSON.stringify({
      version: 1,
      token: "dead-table-owner",
      pid: deadTablePid,
      startedAt: new Date(0).toISOString(),
    })}\n`, "utf8");
    const recoveredBeforeTableLoad = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: csvPath,
      baseHash: updatedCsv.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "missing",
        columnId: "name",
        value: "Invalid",
      }],
    });
    assert.equal(recoveredBeforeTableLoad.status, "invalid");
    assert.deepEqual(await readFile(csvBFile), recoverableBytes);
    await assertNoActiveTransactionArtifacts(projectRoot);

    const xlsxPath = "Tables/Skills.xlsx";
    const xlsx = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: xlsxPath,
      selector: { sheetId: "skills:Skills_A" },
    });
    assert.equal(xlsx.format, "xlsx");
    assert.equal(xlsx.sources.length, 1);
    assert.equal(xlsx.page.rows[0].cells.name, "Ice Bolt");
    const appliedXlsx = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: xlsxPath,
      baseHash: xlsx.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "Skills_A:key-301",
        columnId: "name",
        value: "Ice Bolt MCP V2",
      }],
    });
    assert.equal(appliedXlsx.status, "applied");
    const updatedXlsx = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: xlsxPath,
      selector: { sheetId: "skills:Skills_A" },
    });
    assert.equal(updatedXlsx.page.rows[0].cells.name, "Ice Bolt MCP V2");
    const tableEntries = await readdir(path.join(projectRoot, "Tables"));
    assert.ok(!tableEntries.some((name) => name.includes(".visualbridge")));

    await writeFile(csvBFile, "broken\n", "utf8");
    const invalidRead = await call(client, "visualbridge_document", {
      ...selector,
      action: "read",
      path: csvPath,
    });
    assert.equal(invalidRead.valid, false);
    assert.ok(invalidRead.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
    const invalidSearch = await call(client, "visualbridge_document", {
      ...selector,
      action: "search",
      path: csvPath,
      query: "anything",
    });
    assert.equal(invalidSearch.valid, false);
    assert.deepEqual(invalidSearch.results, []);
    const invalidWrongCursor = await client.callTool({
      name: "visualbridge_document",
      arguments: {
        ...selector,
        action: "search",
        path: csvPath,
        query: "anything",
        cursor: firstPage.nextCursor,
      },
    });
    assert.equal(invalidWrongCursor.isError, true);
    const invalidApply = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: csvPath,
      baseHash: invalidRead.baseHash,
      operations: [{
        type: "table.setCell",
        sheetId: "skills:Skills_A",
        rowId: "missing",
        columnId: "name",
        value: "Invalid",
      }],
    });
    assert.equal(invalidApply.status, "invalid");
  });
});

test("MCP project transactions recover dead-owner journals and preserve unknown external bytes", async () => {
  await withFixture("GraphSemanticProject", async ({ projectRoot, client }) => {
    const projectPath = path.join(projectRoot, "VisualBridge.project.vbjson");
    const projectDefinition = JSON.parse(await readFile(projectPath, "utf8"));
    projectDefinition.documentRoots = ["."];
    projectDefinition.documentTypes[0].include.push(".visualbridge-*", "**/*.visualbridge-*");
    await writeFile(projectPath, `${JSON.stringify(projectDefinition, null, 2)}\n`, "utf8");
    const discovery = await call(client, "visualbridge_project", { action: "discover" });
    const projectFile = discovery.projects[0].projectFile;
    const selector = { projectFile, documentTypeId: "logicGraph", editor: "graph" };
    const graphPath = "Graph/SemanticSample.vbgraph";
    const graphFile = path.join(projectRoot, "Graph", "SemanticSample.vbgraph");
    const baseline = await call(client, "visualbridge_document", { ...selector, action: "read", path: graphPath });
    const before = await readFile(graphFile);
    const outsideSentinel = path.join(projectRoot, "..", "outside-transaction-sentinel.txt");
    await writeFile(outsideSentinel, "outside must survive\n", "utf8");
    const internalSentinel = path.join(projectRoot, "Graph", "victim.tmp");
    const internalRollbackSentinel = path.join(projectRoot, "Graph", "victim.rollback");
    await writeFile(internalSentinel, "internal temp must survive\n", "utf8");
    await writeFile(internalRollbackSentinel, "internal rollback must survive\n", "utf8");
    const unsafeTransactionId = "ignored/../victim";
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.json"), `${JSON.stringify({
      version: 1,
      transactionId: unsafeTransactionId,
      phase: "committed",
      entries: [{
        path: graphPath,
        absolutePath: graphFile,
        temporaryPath: `${graphFile}.visualbridge-${unsafeTransactionId}.tmp`,
        backupPath: `${graphFile}.visualbridge-${unsafeTransactionId}.rollback`,
        beforeHash: hash(Buffer.from("before")),
        afterHash: hash(before),
      }],
    }, null, 2)}\n`, "utf8");
    const unsafeIdRecovery = await client.callTool({
      name: "visualbridge_apply_operations",
      arguments: {
        ...selector,
        path: graphPath,
        baseHash: baseline.baseHash,
        operations: [{ type: "graph.updateGraph", graphId: "root", title: "Must not run", properties: {} }],
      },
    });
    assert.equal(unsafeIdRecovery.isError, true);
    assert.equal(await readFile(internalSentinel, "utf8"), "internal temp must survive\n");
    assert.equal(await readFile(internalRollbackSentinel, "utf8"), "internal rollback must survive\n");
    await unlink(path.join(projectRoot, ".visualbridge-transaction.json"));
    await unlink(internalSentinel);
    await unlink(internalRollbackSentinel);

    const maliciousId = "00000000-0000-4000-8000-000000000001";
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.json"), `${JSON.stringify({
      version: 1,
      transactionId: maliciousId,
      phase: "committed",
      entries: [{
        path: graphPath,
        absolutePath: outsideSentinel,
        temporaryPath: `${outsideSentinel}.visualbridge-${maliciousId}.tmp`,
        backupPath: `${outsideSentinel}.visualbridge-${maliciousId}.rollback`,
        beforeHash: hash(Buffer.from("before")),
        afterHash: hash(Buffer.from("after")),
      }],
    }, null, 2)}\n`, "utf8");
    const maliciousRecovery = await client.callTool({
      name: "visualbridge_apply_operations",
      arguments: {
        ...selector,
        path: graphPath,
        baseHash: baseline.baseHash,
        operations: [{ type: "graph.updateGraph", graphId: "root", title: "Must not run", properties: {} }],
      },
    });
    assert.equal(maliciousRecovery.isError, true);
    assert.equal(await readFile(outsideSentinel, "utf8"), "outside must survive\n");
    await unlink(path.join(projectRoot, ".visualbridge-transaction.json"));
    await unlink(outsideSentinel);

    const committedId = "00000000-0000-4000-8000-000000000002";
    const committedTemporary = `${graphFile}.visualbridge-${committedId}.tmp`;
    const committedBackup = `${graphFile}.visualbridge-${committedId}.rollback`;
    await writeFile(committedBackup, Buffer.from("old backup"));
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.json"), `${JSON.stringify({
      version: 1,
      transactionId: committedId,
      phase: "committed",
      entries: [{
        path: graphPath,
        absolutePath: graphFile,
        temporaryPath: committedTemporary,
        backupPath: committedBackup,
        beforeHash: hash(Buffer.from("old backup")),
        afterHash: hash(before),
      }],
    }, null, 2)}\n`, "utf8");
    const finalized = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: graphPath,
      baseHash: baseline.baseHash,
      operations: [{ type: "graph.removeNode", graphId: "root", nodeId: "missing" }],
    });
    assert.equal(finalized.status, "invalid");
    await assertNoActiveTransactionArtifacts(projectRoot);

    const malformedLockPath = path.join(projectRoot, ".visualbridge-transaction.lock");
    await writeFile(malformedLockPath, "", "utf8");
    const oldTime = new Date(Date.now() - 10 * 60_000);
    await utimes(malformedLockPath, oldTime, oldTime);
    const recoveredMalformedLock = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: graphPath,
      baseHash: baseline.baseHash,
      operations: [{ type: "graph.removeNode", graphId: "root", nodeId: "missing" }],
    });
    assert.equal(recoveredMalformedLock.status, "invalid");
    const lockedPreview = await call(client, "visualbridge_refactor_reference", {
      projectFile,
      action: "preview",
      kind: "graph.element",
      target: { documentTypeId: "logicGraph", elementKind: "node" },
      oldValue: "step_b",
      newValue: "locked_step",
    });
    const lockPath = path.join(projectRoot, ".visualbridge-transaction.lock");
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      token: "live-owner",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`, "utf8");
    const blockedApply = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: graphPath,
      baseHash: baseline.baseHash,
      operations: [{ type: "graph.updateGraph", graphId: "root", title: "Blocked", properties: {} }],
    });
    assert.equal(blockedApply.status, "conflict");
    assert.equal(blockedApply.reason, "writeInProgress");
    const blockedRefactor = await call(client, "visualbridge_refactor_reference", {
      projectFile,
      action: "apply",
      kind: "graph.element",
      target: { documentTypeId: "logicGraph", elementKind: "node" },
      oldValue: "step_b",
      newValue: "locked_step",
      previewHash: lockedPreview.previewHash,
      baseHashes: lockedPreview.baseHashes,
    });
    assert.equal(blockedRefactor.status, "conflict");
    assert.equal(blockedRefactor.reason, "writeInProgress");
    await unlink(lockPath);
    const interruptedDocument = JSON.parse(before.toString("utf8"));
    interruptedDocument.graphs[0].title = "Interrupted replacement";
    const interrupted = Buffer.from(`${JSON.stringify(interruptedDocument, null, 2)}\n`, "utf8");
    const transactionId = "00000000-0000-4000-8000-000000000003";
    const temporaryPath = `${graphFile}.visualbridge-${transactionId}.tmp`;
    const backupPath = `${graphFile}.visualbridge-${transactionId}.rollback`;
    await writeFile(temporaryPath, interrupted);
    await writeFile(backupPath, before);
    await unlink(graphFile);
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.json"), `${JSON.stringify({
      version: 1,
      transactionId,
      phase: "prepared",
      entries: [{
        path: graphPath,
        absolutePath: graphFile,
        temporaryPath,
        backupPath,
        beforeHash: hash(before),
        afterHash: hash(interrupted),
      }],
    }, null, 2)}\n`, "utf8");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    await once(child, "exit");
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.lock"), `${JSON.stringify({
      version: 1,
      token: "dead-owner",
      pid: deadPid,
      startedAt: new Date(0).toISOString(),
    })}\n`, "utf8");
    const recoveredApply = await call(client, "visualbridge_apply_operations", {
      ...selector,
      path: graphPath,
      baseHash: baseline.baseHash,
      operations: [{ type: "graph.updateGraph", graphId: "root", title: "Recovered", properties: {} }],
    });
    assert.equal(recoveredApply.status, "applied");
    await assertNoActiveTransactionArtifacts(projectRoot);

    const committed = await readFile(graphFile);
    const plannedDocument = JSON.parse(committed.toString("utf8"));
    plannedDocument.graphs[0].title = "Planned";
    const planned = Buffer.from(`${JSON.stringify(plannedDocument, null, 2)}\n`, "utf8");
    const externalDocument = JSON.parse(committed.toString("utf8"));
    externalDocument.graphs[0].title = "External bytes";
    const external = Buffer.from(`${JSON.stringify(externalDocument, null, 2)}\n`, "utf8");
    const unsafeId = "00000000-0000-4000-8000-000000000004";
    const unsafeTemporary = `${graphFile}.visualbridge-${unsafeId}.tmp`;
    const unsafeBackup = `${graphFile}.visualbridge-${unsafeId}.rollback`;
    await writeFile(unsafeBackup, committed);
    await writeFile(unsafeTemporary, planned);
    await writeFile(graphFile, external);
    await writeFile(path.join(projectRoot, ".visualbridge-transaction.json"), `${JSON.stringify({
      version: 1,
      transactionId: unsafeId,
      phase: "prepared",
      entries: [{
        path: graphPath,
        absolutePath: graphFile,
        temporaryPath: unsafeTemporary,
        backupPath: unsafeBackup,
        beforeHash: hash(committed),
        afterHash: hash(planned),
      }],
    }, null, 2)}\n`, "utf8");
    const rejected = await client.callTool({
      name: "visualbridge_apply_operations",
      arguments: {
        ...selector,
        path: graphPath,
        baseHash: recoveredApply.hash,
        operations: [{ type: "graph.updateGraph", graphId: "root", title: "Must not write", properties: {} }],
      },
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(await readFile(graphFile), external);
  });
});

test("MCP stale-lock recovery elects one writer across concurrent processes", async () => {
  await withFixture("GraphSemanticProject", async ({ temporaryRoot, projectRoot, client }) => {
    const second = await startClient(temporaryRoot);
    try {
      const discovery = await call(client, "visualbridge_project", { action: "discover" });
      const projectFile = discovery.projects[0].projectFile;
      const selector = { projectFile, documentTypeId: "logicGraph", editor: "graph" };
      const graphPath = "Graph/SemanticSample.vbgraph";
      const baseline = await call(client, "visualbridge_document", { ...selector, action: "read", path: graphPath });
      const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"]);
      const deadPid = deadOwner.pid;
      await once(deadOwner, "exit");
      await writeFile(path.join(projectRoot, ".visualbridge-transaction.lock"), `${JSON.stringify({
        version: 1,
        token: "dead-concurrent-owner",
        pid: deadPid,
        startedAt: new Date(0).toISOString(),
      })}\n`, "utf8");
      const operation = (title) => ({
        ...selector,
        path: graphPath,
        baseHash: baseline.baseHash,
        operations: [{ type: "graph.updateGraph", graphId: "root", title, properties: {} }],
      });
      const results = await Promise.all([
        call(client, "visualbridge_apply_operations", operation("Concurrent A")),
        call(second.client, "visualbridge_apply_operations", operation("Concurrent B")),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["applied", "conflict"]);
      const current = await call(client, "visualbridge_document", { ...selector, action: "read", path: graphPath });
      assert.ok(["Concurrent A", "Concurrent B"].includes(
        current.document.graphs.find((entry) => entry.id === "root").title,
      ));
      await assertNoActiveTransactionArtifacts(projectRoot);
    } finally {
      await second.client.close().catch(() => undefined);
    }
  });
});

async function assertNoActiveTransactionArtifacts(projectRoot) {
  const recoveryDirectoryName = ".visualbridge-transaction-recovery";
  const entries = await readdir(projectRoot);
  assert.ok(!entries.some((name) => name !== recoveryDirectoryName && name.startsWith(".visualbridge-transaction")));
  try {
    assert.deepEqual(await readdir(path.join(projectRoot, recoveryDirectoryName)), []);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function withFixture(name, action) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-mcp-v2-"));
  const projectRoot = path.join(temporaryRoot, name);
  await cp(path.join(repositoryRoot, "TestData", name), projectRoot, { recursive: true });
  const running = await startClient(temporaryRoot);
  try {
    await action({ temporaryRoot, projectRoot, client: running.client, stderr: running.stderr });
  } catch (error) {
    assert.fail(`${error instanceof Error ? error.stack ?? error.message : String(error)}\nMCP stderr:\n${running.stderr()}`);
  } finally {
    await running.client.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function startClient(workspaceRoot) {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
  environment.VISUALBRIDGE_WORKSPACE = workspaceRoot;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: environment,
    stderr: "pipe",
  });
  let stderrText = "";
  transport.stderr?.on("data", (chunk) => {
    stderrText += chunk.toString();
  });
  const client = new Client({ name: "visualbridge-stdio-test", version: "2.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderrText };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, textContent(result));
  assert.equal(typeof result.structuredContent, "object", textContent(result));
  const envelope = result.structuredContent;
  assert.equal(envelope.contractVersion, 2);
  assert.notEqual(envelope.status, "error");
  assert.equal(typeof envelope.data, "object");
  if (envelope.status !== "ok") {
    assert.equal(Object.hasOwn(envelope.data, "status"), false, "Envelope status must not be duplicated in data.");
  }
  return { ...envelope.data, status: envelope.status === "ok" ? envelope.data.status : envelope.status };
}

function lifecycleApply(projectFile, operation, preview) {
  return {
    action: "apply",
    projectFile,
    operation,
    previewHash: preview.previewHash,
    planPayload: preview.planPayload,
    baseHashes: preview.baseHashes,
    dependencies: preview.dependencies,
  };
}

function textContent(result) {
  return result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
