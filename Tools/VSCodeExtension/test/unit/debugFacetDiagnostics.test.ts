/**
 * facet 诊断码权威清单的覆盖用例（F4 返修 P1）。
 *
 * 两个方向都要证明，且都不能只靠"类型看起来对"：
 * 1. 清单里的每个码都有**发射点**：`TRIGGERS` 是显式的"码 → 触发方式"表，键类型是
 *    `Record<DebugFacetErrorCode, ...>`——新增一个码而没写触发方式会直接编译失败；
 *    用例再实际跑一遍，断言该码真的出现在窗口诊断里（防止"登记了但没人发射"）。
 * 2. 每个发射点用的码都在清单里：`DebugFacetDiagnostic.code` 的类型从清单派生，所有内部
 *    发射点都被 `assertDebugFacetCode` 收口；这里再验证运行期断言确实会拒绝未登记码
 *    （防 `as` 绕过类型系统）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { DebugFacet, EditorContext, JsonObject } from "@visualbridge/module-sdk";
import { DebugRouter } from "../../src/bridge/debugRouter";
import type { DebugFacetSource } from "../../src/debug/debugFacetRouter";
import { DebugFacetHost } from "../../src/debug/debugFacetRouter";
import {
  DEBUG_FACET_ERROR_CODES,
  assertDebugFacetCode,
  isDebugFacetErrorCode,
  type DebugFacetErrorCode,
} from "../../src/debug/debugFacetDiagnostics";
import { createInstance, createManager, ingestEvents } from "./debugPanelFixture";

function context(): EditorContext<unknown> {
  return {
    project: { projectId: "p", moduleId: "m", documentTypes: [], options: undefined },
    documentType: { id: "logicGraph", editor: "graph", include: [], exclude: [], catalogs: [] },
    registry: undefined,
    catalogs: { get: () => undefined },
    log: () => undefined,
  };
}

function source(moduleId: string, moduleIndex: number, facet: DebugFacet): DebugFacetSource {
  return {
    moduleId,
    moduleIndex,
    editor: "graph",
    facet,
    context: context(),
    path: `modules[${moduleIndex}].editors[0].debug`,
  };
}

function okFacet(category: string): DebugFacet {
  return {
    categories: [category],
    onRecord: () => ({ ok: true }),
  };
}

function windowCodes(host: DebugFacetHost): readonly string[] {
  return host.snapshot().windows.flatMap((window) => window.diagnostics.map((diagnostic) => diagnostic.code));
}

/** 跑一个单 facet 的 host，返回窗口里实际出现的诊断码。 */
function runFacet(facet: DebugFacet, options: { readonly fault?: boolean } = {}): readonly string[] {
  const router = new DebugRouter();
  const manager = createManager({ router });
  const host = new DebugFacetHost({
    router,
    knownCategories: () => ["graph"],
    sessionId: () => "window#boot",
  });
  host.rebuild([source("m", 0, facet)]);
  if (options.fault === true) {
    host.setFaultInjectionForTest("graph");
  }

  createInstance(manager, "graph", "hero");
  ingestEvents(manager, [{ frame: 1, instance: "hero" }]);
  host.flushForTest();
  return windowCodes(host);
}

/** 两个模块认领同一分类（`module.editorConflict` 的发射点）。 */
function runConflict(): readonly string[] {
  const router = new DebugRouter();
  const host = new DebugFacetHost({ router, knownCategories: () => ["graph"] });
  host.rebuild([source("first", 0, okFacet("graph")), source("second", 1, okFacet("graph"))]);
  return windowCodes(host);
}

/**
 * 码 → 触发方式。键类型强制全量：清单新增码时这里不补就编译失败，用例便无法"静默漏一个码"。
 */
const TRIGGERS: Record<DebugFacetErrorCode, () => readonly string[]> = {
  "module.callFailed": () => runFacet(okFacet("graph"), { fault: true }),
  "module.registrationInvalid": () => runFacet({
    categories: ["graph"],
    onRecord: () => [] as unknown as JsonObject,
  }),
  "module.editorConflict": () => runConflict(),
  "module.renderTooLarge": () => runFacet({
    categories: ["graph"],
    onRecord: () => ({ blob: "x".repeat(200_000) }),
  }),
};

test("the facet diagnostic code list is a unique, closed set", () => {
  // 清单是契约：数量变化必须是有意为之（同时会强制补 TRIGGERS 与发射点）。
  assert.equal(DEBUG_FACET_ERROR_CODES.length, 4);
  assert.equal(new Set(DEBUG_FACET_ERROR_CODES).size, DEBUG_FACET_ERROR_CODES.length, "清单不得有重复码");
  for (const code of DEBUG_FACET_ERROR_CODES) {
    assert.equal(isDebugFacetErrorCode(code), true);
  }
});

test("every registered facet diagnostic code has an emission point", () => {
  for (const code of DEBUG_FACET_ERROR_CODES) {
    const observed = TRIGGERS[code]();
    assert.ok(
      observed.includes(code),
      `registered code '${code}' has no emission point: triggers produced [${observed.join(", ")}]`,
    );
  }
});

test("every emitted facet diagnostic code is registered", () => {
  const observed = new Set(DEBUG_FACET_ERROR_CODES.flatMap((code) => [...TRIGGERS[code]()]));
  for (const code of observed) {
    assert.ok(isDebugFacetErrorCode(code), `'${code}' is emitted but absent from DEBUG_FACET_ERROR_CODES`);
  }
});

test("the runtime guard rejects an unregistered code cast past the type system", () => {
  assert.throws(
    () => assertDebugFacetCode("module.notRegistered"),
    /Unregistered debug facet diagnostic code/u,
  );
  assert.equal(assertDebugFacetCode("module.renderTooLarge"), "module.renderTooLarge");
});
