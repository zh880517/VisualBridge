/**
 * 回看 facet 端点的生命周期（G1d 评审补充 2）。
 *
 * `replayFacets` 里"创建 host → 创建桥 → attach → rebuild"这几步在 `DebugPanelController`
 * 眼里是**一个原子回调**：一旦 `rebuild` 抛错，控制器拿不到返回值，也就没有机会 dispose。
 * 而 attach 已经把回看桥设成**活动桥**——不清理就会永久占位：回看功能不可用，且在线增量
 * 永远被 `broadcastDebugFacet` 压制。
 *
 * 因此把"失败回退"收敛到这一个地方：
 * - 成功：返回 `{ snapshot, replayCategory, dispose }`，dispose 顺序固定为
 *   detach（把活动桥切回在线并清/水化窗口）→ 桥释放 → host 释放；
 * - 失败：先做同样的清理（**先 detach 再释放**，保证活动桥回到在线），错误写日志，
 *   然后返回一个**降级端点**（没有任何模块窗口、`replayCategory` 恒 undefined）。
 *   不 rethrow：回看数据本身仍可用（面板的通用视图来自回看 manager），只是模块 facet 区域
 *   回退到"没有窗口"。调用方（`extension.ts`）因此不必再关心失败清理。
 *
 * 本模块不依赖 `vscode`，可直接单测失败回退（评审要求"失败时回退在线桥"有可执行证据）。
 */

import {
  DEBUG_FACET_BATCH_LIMIT,
  type DebugFacetHost,
  type DebugFacetReplayView,
  type DebugFacetSnapshot,
} from "./debugFacetRouter";
import type { DebugFacetWindowBridge } from "./debugFacetWindowBridge";

/** 面板读模块 facet 区域的最小接口（与 `DebugPanelFacets` 结构兼容）。 */
export interface ReplayFacetEndpoint {
  snapshot(): DebugFacetSnapshot;
  replayCategory(category: string): DebugFacetReplayView | undefined;
  dispose(): void;
  /**
   * 初始化失败时的降级标记（G1d 评审补充 2）：回看本身仍可用，只是模块视图为空。
   * 控制器据此给用户一行可见提示；正常端点为 `undefined`。
   */
  readonly degraded?: { readonly reason: string };
}

/** `DebugFacetHost` 里本端点用到的三个方法（单测可用结构替身，不必构造完整 host）。 */
export type ReplayFacetHost = Pick<DebugFacetHost, "snapshot" | "replayCategory" | "dispose">;

export interface ReplayFacetEndpointOptions<TBridge extends { dispose(): void }> {
  readonly host: ReplayFacetHost;
  readonly bridge: TBridge;
  /** 把回看桥设为活动桥（provider 侧同时清窗口）。 */
  readonly attach: (bridge: TBridge) => void;
  /** 解绑并切回在线桥；失败回退与正常 dispose 都走这一条。 */
  readonly detach: (bridge: TBridge) => void;
  /** `host.rebuild(sources)`：失败时必须回退在线桥。 */
  readonly rebuild: () => void;
  readonly log?: (message: string) => void;
}

export function createReplayFacetEndpoint<TBridge extends { dispose(): void }>(
  options: ReplayFacetEndpointOptions<TBridge>,
): ReplayFacetEndpoint {
  const { host, bridge } = options;
  try {
    options.attach(bridge);
    options.rebuild();
  } catch (errorValue) {
    // 清理顺序与正常 dispose 相同：先把活动桥切回在线（清窗口 + 用在线桥水化），再释放。
    release(options, bridge, host);
    const reason = describeError(errorValue);
    options.log?.(
      `[debug] replay facet window failed to start; the module webviews stay on the live bridge: ${reason}`,
    );
    return degradedEndpoint(reason.length > 0 ? reason : "unknown error");
  }

  return {
    snapshot: () => host.snapshot(),
    replayCategory: (category) => host.replayCategory(category),
    dispose: () => release(options, bridge, host),
  };
}

/** 幂等释放：detach 只对当前回看桥生效，重复调用无害。 */
function release<TBridge extends { dispose(): void }>(
  options: ReplayFacetEndpointOptions<TBridge>,
  bridge: TBridge,
  host: ReplayFacetHost,
): void {
  try {
    options.detach(bridge);
  } finally {
    bridge.dispose();
    host.dispose();
  }
}

/** 失败后的降级端点：没有模块窗口，也不接受"按分类重建"；`degraded` 供控制器给用户提示。 */
function degradedEndpoint(reason: string): ReplayFacetEndpoint {
  return {
    degraded: { reason },
    snapshot: () => ({
      windows: [],
      pending: 0,
      batches: 0,
      failures: 0,
      batchLimit: DEBUG_FACET_BATCH_LIMIT,
      lateRecords: 0,
      generic: { records: 0, dropped: 0 },
    }),
    replayCategory: () => undefined,
    dispose: () => undefined,
  };
}

function describeError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
