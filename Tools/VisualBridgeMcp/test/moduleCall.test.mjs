/**
 * `module.callFailed` 的发射点（附录 D.2 / D.3.1）。
 *
 * 模块提供的代码抛错是**模块缺陷**：必须报 `module.callFailed` 并带上模块 id 与原始 message，
 * 不能落到宿主 `internal`（否则"第三方模块有 bug"会被误报成"VisualBridge 有 bug"）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { callModuleCode, callModuleCodeAsync } from "../dist/moduleCall.js";
import { VisualBridgeMcpError } from "../dist/projectWorkspace.js";

test("maps a thrown module error to module.callFailed carrying the module id and message", () => {
  assert.throws(
    () => callModuleCode("visualbridge.graph", "guardOperations", () => {
      throw new Error("boom");
    }),
    (errorValue) => {
      assert.equal(errorValue.name, "VisualBridgeMcpError");
      assert.equal(errorValue.code, "module.callFailed");
      assert.match(errorValue.message, /visualbridge\.graph/);
      assert.match(errorValue.message, /guardOperations/);
      assert.match(errorValue.message, /boom/);
      assert.deepEqual(errorValue.details, {
        moduleId: "visualbridge.graph",
        operation: "guardOperations",
        message: "boom",
      });
      return true;
    },
  );
});

test("keeps a host error code instead of downgrading it to a module defect", () => {
  const hostError = new VisualBridgeMcpError("request.invalidSelector", "bad selector");
  assert.throws(
    () => callModuleCode("visualbridge.table", "queryDocument", () => {
      throw hostError;
    }),
    (errorValue) => errorValue === hostError,
  );
});

test("maps a rejected async module promise", async () => {
  await assert.rejects(
    callModuleCodeAsync("visualbridge.entity", "renderSources", async () => {
      throw new Error("render exploded");
    }),
    (errorValue) => {
      assert.equal(errorValue.code, "module.callFailed");
      assert.match(errorValue.message, /visualbridge\.entity/);
      assert.match(errorValue.message, /render exploded/);
      assert.equal(errorValue.details.operation, "renderSources");
      return true;
    },
  );
});

test("stringifies a non-Error throw without losing the module identity", () => {
  assert.throws(
    () => callModuleCode("visualbridge.structured", "validateTransition", () => {
      throw "plain string failure";
    }),
    (errorValue) => {
      assert.equal(errorValue.code, "module.callFailed");
      assert.match(errorValue.message, /plain string failure/);
      assert.equal(errorValue.details.moduleId, "visualbridge.structured");
      return true;
    },
  );
});
