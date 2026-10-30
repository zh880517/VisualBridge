import assert from "node:assert/strict";
import test from "node:test";
import e2eOnlyFilter from "./e2eOnlyFilter.cjs";

const { createE2EOnlyFilter } = e2eOnlyFilter;

const CASE_NAMES = [
  "activates VisualBridge and discovers the runtime instance",
  "ingests real graph execution facts through the generated graph debug contract (G1c)",
  "completes a real debug query roundtrip on the runtime leg (E9)",
];

test("runs every case when the filter is unset or empty", () => {
  for (const value of [undefined, ""]) {
    const filter = createE2EOnlyFilter(value);
    for (const name of CASE_NAMES) {
      assert.equal(filter.selected(name), true, `filter=${JSON.stringify(value)} 必须选中全部用例`);
      filter.recordExecuted();
    }

    assert.equal(filter.executed, CASE_NAMES.length);
    assert.equal(filter.skipped, 0);
    assert.equal(filter.assertExecuted(), undefined, "执行数 > 0 时守卫必须放行");
    assert.match(filter.summary(), /executed=3 skipped=0$/u);
  }
});

test("runs only the matching cases and reports the real execution count", () => {
  const filter = createE2EOnlyFilter("graph execution facts");
  for (const name of CASE_NAMES) {
    if (filter.selected(name)) {
      filter.recordExecuted();
    } else {
      filter.recordSkipped();
    }
  }

  assert.equal(filter.executed, 1, "只有一条用例的名字包含过滤串");
  assert.equal(filter.skipped, 2);
  assert.equal(
    filter.summary(),
    '[runtime-e2e] cases: executed=1 skipped=2 (VISUALBRIDGE_RUNTIME_E2E_ONLY="graph execution facts")',
  );
  assert.equal(filter.assertExecuted(), undefined);
});

// 这是守卫的**红态**：过滤串不命中任何用例时，旧实现会把 13 条（现 12 条）全部 SKIP 后 `exit 0`，
// 于是"跑过一次 ONLY"可以冒充一次真实门禁。删掉/取消 `assertExecuted()` 的抛错，这条用例立刻红。
test("fails the run when the filter matches no case", () => {
  const filter = createE2EOnlyFilter("__no_such_case__");
  for (const name of CASE_NAMES) {
    assert.equal(filter.selected(name), false);
    filter.recordSkipped();
  }

  assert.equal(filter.executed, 0);
  assert.equal(filter.skipped, CASE_NAMES.length);
  assert.match(filter.summary(), /executed=0/u);
  assert.throws(
    () => filter.assertExecuted(),
    (error) => {
      assert.match(String(error?.message), /filter 未命中任何用例/u);
      assert.match(String(error?.message), /__no_such_case__/u);
      return true;
    },
    "执行数为 0 时必须抛错，让门禁以非零退出",
  );
});
