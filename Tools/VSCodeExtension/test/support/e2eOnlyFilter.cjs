"use strict";

/**
 * `VISUALBRIDGE_RUNTIME_E2E_ONLY` 的单用例过滤与**执行计数**。
 *
 * 为什么单独成模块（G1c2）：过滤串不命中任何用例时，套件里每条用例都打印 `SKIP` 然后整体
 * `exit 0` —— 门禁看上去跑过，实际**一例都没执行**，这是新的假绿入口。守卫必须能被单测直接
 * 钉住（`e2eOnlyFilter.test.mjs` 里就有一条"不命中 ⇒ 抛错"的用例），所以计数与判定放在这里，
 * 运行时套件只负责打 PASS/FAIL/SKIP、并在收尾调用 {@link createE2EOnlyFilter} 返回对象的
 * `assertExecuted()`。
 *
 * 过滤语义保持原样：空串/未设置 ⇒ 全部执行；非空 ⇒ 只执行名字**包含**该子串的用例。
 */

/**
 * @param {string | undefined} onlyFilter `VISUALBRIDGE_RUNTIME_E2E_ONLY` 的原始值。
 * @returns {{
 *   filter: string,
 *   executed: number,
 *   skipped: number,
 *   selected: (name: string) => boolean,
 *   recordExecuted: () => void,
 *   recordSkipped: () => void,
 *   summary: () => string,
 *   assertExecuted: () => void,
 * }}
 */
function createE2EOnlyFilter(onlyFilter) {
  const filter = onlyFilter ?? "";
  let executed = 0;
  let skipped = 0;

  return {
    filter,
    get executed() {
      return executed;
    },
    get skipped() {
      return skipped;
    },
    /** 该用例是否要在本轮执行（空过滤串时恒为 true）。 */
    selected(name) {
      return filter.length === 0 || name.includes(filter);
    },
    recordExecuted() {
      executed += 1;
    },
    recordSkipped() {
      skipped += 1;
    },
    /** 一行摘要：实际执行数必须出现在产物里，否则"跑了几条"只能靠数 PASS/FAIL 行。 */
    summary() {
      const scope = filter.length === 0
        ? ""
        : ` (VISUALBRIDGE_RUNTIME_E2E_ONLY=${JSON.stringify(filter)})`;
      return `[runtime-e2e] cases: executed=${executed} skipped=${skipped}${scope}`;
    },
    /**
     * 过滤守卫：**执行数为 0 ⇒ 抛错**（进程非零退出）。
     *
     * 不设过滤串时用例是固定清单，执行数为 0 只可能来自"清单被删空"——那同样该红。
     */
    assertExecuted() {
      if (executed > 0) {
        return;
      }

      throw new Error(
        `No runtime E2E case matched VISUALBRIDGE_RUNTIME_E2E_ONLY=${JSON.stringify(filter)}: `
        + "the filter selected no case, so this run would otherwise pass without executing anything "
        + "(filter 未命中任何用例). Clear the variable to run the whole suite, "
        + "or set it to a substring of an existing case name.",
      );
    },
  };
}

module.exports = { createE2EOnlyFilter };
