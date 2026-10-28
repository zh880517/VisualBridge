import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBUG_KEYFRAME_MAX_PER_CATEGORY,
  DebugKeyframeRegistry,
  type DebugKeyframe,
} from "../../src/bridge/debugKeyframe";

const HERO = 1;

function capture(
  registry: DebugKeyframeRegistry,
  arrivalSeq: number,
  options: {
    readonly category?: string;
    readonly filterKey?: string;
    readonly state?: unknown;
    readonly consumerToken?: number | undefined;
  } = {},
): DebugKeyframe {
  return registry.capture({
    category: options.category ?? "graph",
    consumerToken: "consumerToken" in options ? options.consumerToken : HERO,
    consumerLabel: "graph",
    filterKey: options.filterKey ?? "",
    instanceKey: "graph\u0000hero",
    instanceId: "hero",
    position: arrivalSeq,
    arrivalSeq,
    bytes: 10,
    state: options.state ?? [`state@${arrivalSeq}`],
  });
}

test("the per-category keyframe cap is 64 and drops the oldest", () => {
  assert.equal(DEBUG_KEYFRAME_MAX_PER_CATEGORY, 64);
  const registry = new DebugKeyframeRegistry();
  for (let seq = 1; seq <= 65; seq += 1) {
    capture(registry, seq);
  }

  assert.equal(registry.count("graph"), 64);
  assert.deepEqual(
    registry.list("graph").map((keyframe) => keyframe.arrivalSeq),
    Array.from({ length: 64 }, (_unused, index) => index + 2),
    "the 65th capture evicts arrivalSeq 1",
  );
  assert.equal(registry.size, 64);
});

test("a keyframe is only valid for the filter key that captured it", () => {
  const registry = new DebugKeyframeRegistry();
  capture(registry, 5, { filterKey: "mode=slow" });

  assert.equal(registry.latest("graph", "mode=slow", 0, HERO)?.arrivalSeq, 5);
  assert.equal(registry.latest("graph", "mode=fast", 0, HERO), undefined, "C.4: filter change invalidates the baseline");
  assert.equal(registry.latest("other", "mode=slow", 0, HERO), undefined, "keyframes are per category");
});

test("a keyframe is only valid for the consumer that captured it", () => {
  const registry = new DebugKeyframeRegistry();
  capture(registry, 8, { consumerToken: HERO });

  assert.equal(registry.latest("graph", "", 0, HERO)?.arrivalSeq, 8);
  assert.equal(
    registry.latest("graph", "", 0, 2),
    undefined,
    "another main consumer must not restore a snapshot taken by the previous one (P2-5)",
  );
  assert.equal(registry.latest("graph", "", 0, undefined), undefined, "no owner means no usable keyframe either");
});

test("a keyframe behind the evicted floor is refused", () => {
  const registry = new DebugKeyframeRegistry();
  capture(registry, 3);
  capture(registry, 7);

  assert.equal(registry.latest("graph", "", 3, HERO)?.arrivalSeq, 7, "the newest usable keyframe wins");
  assert.equal(registry.latest("graph", "", 0, HERO)?.arrivalSeq, 7);
  assert.equal(
    registry.latest("graph", "", 8, HERO),
    undefined,
    "a keyframe at or behind the evicted floor cannot be used: its increment would have a hole",
  );
});

test("an unusable newest keyframe falls back to an older usable one", () => {
  const registry = new DebugKeyframeRegistry();
  // 最新的那条属于**别的 filterKey**：回退循环必须跳过它去选可用的旧基线。
  // （上一轮这条用例的最新项直接命中，循环一次都没跑，是假绿。）
  capture(registry, 6);
  capture(registry, 9, { filterKey: "old" });

  const usable = registry.latest("graph", "", 0, HERO);
  assert.equal(usable?.arrivalSeq, 6, "the newest keyframe is unusable, so the older one must be selected");

  // 同一个构造下把淘汰线抬到 7：旧基线也落在线下 ⇒ 没有可用基线。
  assert.equal(registry.latest("graph", "", 7, HERO), undefined, "above every usable keyframe there is no baseline");

  // 反向证明上面的断言确实在考"回退"：把 filterKey 换成匹配的之后，最新项立刻变成答案。
  capture(registry, 12);
  assert.equal(registry.latest("graph", "", 0, HERO)?.arrivalSeq, 12);
});

test("clear(category) and reset drop the stored keyframes", () => {
  const registry = new DebugKeyframeRegistry();
  capture(registry, 1, { category: "graph" });
  capture(registry, 2, { category: "entity" });

  registry.clear("graph");
  assert.equal(registry.count("graph"), 0);
  assert.equal(registry.count("entity"), 1);

  registry.reset();
  assert.equal(registry.size, 0);
  assert.equal(registry.list("entity").length, 0);
});
