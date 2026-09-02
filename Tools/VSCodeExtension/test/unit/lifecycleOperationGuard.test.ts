import assert from "node:assert/strict";
import test from "node:test";
import {
  containsReferenceRefactorGuardedRename,
} from "../../src/document/lifecycleOperationGuard";

test("element removals stay ordinary per-file operations", () => {
  // 元素级删除守卫已整体移除：这些操作都是普通单文件 Operation，
  // 不依赖引用方文件的保存状态。
  assert.equal(typeof containsReferenceRefactorGuardedRename, "function");
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
  assert.equal(containsReferenceRefactorGuardedRename("entity", [{ type: "entity.removeComponent" }]), false);
  assert.equal(containsReferenceRefactorGuardedRename("entity", [{ type: "entity.moveComponent" }]), false);
  assert.equal(containsReferenceRefactorGuardedRename("graph", [{ type: "graph.removeNode" }]), false);
  assert.equal(containsReferenceRefactorGuardedRename("table", [{ type: "table.removeRow" }]), false);
  assert.equal(containsReferenceRefactorGuardedRename("structured", [{ type: "entity.renameComponent" }]), false);
});
