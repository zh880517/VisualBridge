import assert from "node:assert/strict";
import test from "node:test";
import {
  containsLifecycleGuardedRemoval,
  containsReferenceRefactorGuardedRename,
  lifecycleDeleteTarget,
} from "../../src/document/lifecycleOperationGuard";

test("guards stable-target removal operations", () => {
  assert.equal(containsLifecycleGuardedRemoval("entity", [{ type: "entity.removeComponent" }]), true);
  assert.equal(containsLifecycleGuardedRemoval("graph", [{ type: "graph.removeNode" }]), true);
  assert.equal(containsLifecycleGuardedRemoval("graph", [{ type: "graph.removeInterfacePort" }]), true);
  assert.equal(containsLifecycleGuardedRemoval("graph", [{ type: "graph.removeDynamicPort" }]), true);
  assert.equal(containsLifecycleGuardedRemoval("table", [{ type: "table.removeRow" }]), true);
});

test("keeps ordinary structural operations available", () => {
  assert.equal(containsLifecycleGuardedRemoval("graph", [{ type: "graph.removeEdge" }]), false);
  assert.equal(containsLifecycleGuardedRemoval("entity", [{ type: "entity.moveComponent" }]), false);
  assert.equal(containsLifecycleGuardedRemoval("structured", [{ type: "structured.setField" }]), false);
  assert.equal(containsLifecycleGuardedRemoval("table", { type: "table.removeRow" }), false);
});

test("maps editor removals to structured lifecycle targets", () => {
  assert.deepEqual(
    lifecycleDeleteTarget("entity", [{ type: "entity.removeComponent", componentId: "move" }]),
    { kind: "entity.component", componentId: "move" },
  );
  assert.deepEqual(
    lifecycleDeleteTarget("graph", [{ type: "graph.removeNode", graphId: "root", nodeId: "move" }]),
    { kind: "graph.element", graphId: "root", elementKind: "node", elementId: "move" },
  );
  assert.deepEqual(
    lifecycleDeleteTarget("graph", [{
      type: "graph.removeDynamicPort",
      graphId: "root",
      nodeId: "list",
      portId: "item-2",
    }]),
    {
      kind: "graph.element",
      graphId: "root",
      elementKind: "dynamicPort",
      elementId: "item-2",
      nodeId: "list",
    },
  );
  assert.deepEqual(
    lifecycleDeleteTarget("table", [{ type: "table.removeRow", sheetId: "skills", rowId: "1001" }]),
    { kind: "table.row", sheetId: "skills", rowId: "1001" },
  );
});

test("rejects ambiguous or incomplete lifecycle removals", () => {
  assert.equal(lifecycleDeleteTarget("entity", [
    { type: "entity.removeComponent", componentId: "move" },
    { type: "entity.removeComponent", componentId: "health" },
  ]), undefined);
  assert.equal(lifecycleDeleteTarget("graph", [{ type: "graph.removeNode", nodeId: "move" }]), undefined);
  assert.equal(lifecycleDeleteTarget("table", [{ type: "table.removeRow", sheetId: "skills" }]), undefined);
});

test("rejects mixed batches instead of dropping ordinary operations", () => {
  const entityBatch = [
    { type: "entity.setProperty", propertyId: "level", value: 2 },
    { type: "entity.removeComponent", componentId: "move" },
  ];
  assert.equal(containsLifecycleGuardedRemoval("entity", entityBatch), true);
  assert.equal(lifecycleDeleteTarget("entity", entityBatch), undefined);

  const graphBatch = [
    { type: "graph.removeNode", graphId: "root", nodeId: "move" },
    { type: "graph.removeEdge", graphId: "root", edgeId: "edge-1" },
  ];
  assert.equal(containsLifecycleGuardedRemoval("graph", graphBatch), true);
  assert.equal(lifecycleDeleteTarget("graph", graphBatch), undefined);
});

test("guards direct stable identity renames including mixed batches", () => {
  assert.equal(containsReferenceRefactorGuardedRename("entity", [{
    type: "entity.renameComponent",
    componentId: "move",
    newComponentId: "movement",
  }]), true);
  assert.equal(containsReferenceRefactorGuardedRename("graph", [{
    type: "graph.renameElement",
    graphId: "root",
    elementKind: "node",
    elementId: "move",
    newElementId: "movement",
  }, {
    type: "graph.removeEdge",
    graphId: "root",
    edgeId: "edge-1",
  }]), true);
  assert.equal(containsReferenceRefactorGuardedRename("entity", [{ type: "entity.moveComponent" }]), false);
  assert.equal(containsReferenceRefactorGuardedRename("structured", [{ type: "entity.renameComponent" }]), false);
});
