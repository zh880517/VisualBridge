/**
 * 面板查询提示的状态机（F8-§5）。
 *
 * 旧实现是一个**单槽**（`queryNoticeValue`）：并发两条查询时后发的那条覆盖前一条，
 * 任何一条完成都清掉整个槽位，于是"哪条查询发出了/回来了"只能靠时间窗口猜；更糟的是
 * 服务端在途期间给出的提示（超时/失败/晚到）会被本地"正在查询…"无限期盖住。
 *
 * 现在：
 * - 每条查询一条**独立**提示，按 `requestId` 绑定（`onIssued` 在请求入表后同步回调）；
 * - 完成时**只清自己那条**（另一条在途提示照常显示）；
 * - 本地提示只有在**比服务端最近提示更新**时才盖住它——服务端一给出新提示（结算/错误/晚到），
 *   本地那条立刻让位，"正在查询"不会变成永久遮蔽。
 *
 * 纯模块：时钟由调用方给（`at`），不依赖 vscode / DOM，单测可精确控制完成顺序。
 */

import type { DebugQueryNotice } from "../bridge/debugQueryClient";

/** 一条本地提示（在途"正在查询"或一次性的本地结果）。 */
export interface DebugPanelLocalQueryNotice {
  /** 面板分配的本地 token（在途条目的清理键）。 */
  readonly token: string;
  /** 绑定到的请求号（`onIssued` 到达之前为空）。 */
  readonly requestId?: string;
  readonly notice: DebugQueryNotice;
  /** 产生时刻（调用方给的毫秒值，与 `serverNoticeAt` 同一时钟）。 */
  readonly at: number;
}

export class DebugPanelQueryNotices {
  private readonly pending = new Map<string, DebugPanelLocalQueryNotice>();
  private oneShot: DebugPanelLocalQueryNotice | undefined;
  private sequence = 0;

  /** 记一条"正在查询…"（返回 token，完成时用它只清这一条）。 */
  public begin(message: string, at: number): string {
    this.sequence += 1;
    const token = `local-${this.sequence}`;
    this.pending.set(token, {
      token,
      notice: { kind: "info", message },
      at,
    });
    return token;
  }

  /** 请求号入表后的同步回调：把在途提示绑到具体 `requestId`。 */
  public bind(token: string, requestId: string): void {
    const entry = this.pending.get(token);
    if (entry === undefined) {
      return;
    }

    this.pending.set(token, { ...entry, requestId });
  }

  /** 完成一条（按 token）：只清它，其余在途提示不受影响。 */
  public complete(token: string): void {
    this.pending.delete(token);
  }

  /**
   * 完成一条（按 `requestId`）：**服务端先结算**（客户端已 publish 出带 `requestId` 的提示）、
   * Promise 稍后才 settle 时用（`debugPanelController.queryState` 在观察到新服务端提示时调用）。
   * 找不到对应在途提示就什么都不做（幂等）。
   */
  public completeRequest(requestId: string): void {
    for (const [token, entry] of [...this.pending]) {
      if (entry.requestId === requestId) {
        this.pending.delete(token);
      }
    }
  }

  /** 记一条一次性本地结果（回看拒绝、路由层拒绝、结果已插入/未插入等）。 */
  public record(notice: DebugQueryNotice, at: number): void {
    this.sequence += 1;
    this.oneShot = { token: `local-${this.sequence}`, notice, at };
  }

  /** 连接换代/断开：旧连接的提示不能继续冒充当前状态。 */
  public reset(): void {
    this.pending.clear();
    this.oneShot = undefined;
  }

  /** 在途条数（诊断/测试）。 */
  public get pendingCount(): number {
    return this.pending.size;
  }

  /** 当前在途提示（按产生顺序，诊断/测试用）。 */
  public get pendingNotices(): readonly DebugPanelLocalQueryNotice[] {
    return [...this.pending.values()].sort((left, right) => left.at - right.at);
  }

  /** 最近一条本地提示（在途或一次性）；`undefined` = 本地没有任何提示。 */
  public get newest(): DebugPanelLocalQueryNotice | undefined {
    let newest = this.oneShot;
    for (const entry of this.pending.values()) {
      if (newest === undefined || entry.at >= newest.at) {
        newest = entry;
      }
    }

    return newest;
  }

  /**
   * 面板此刻该显示哪条。
   *
   * `serverNoticeAt` 是**服务端最近提示出现的时刻**（调用方按对象身份变化打点）。
   * 规则：本地提示更新（或服务端根本没提示）才盖住服务端；否则让位给服务端。
   */
  public select(
    serverNotice: DebugQueryNotice | undefined,
    serverNoticeAt: number,
  ): DebugQueryNotice | undefined {
    const local = this.newest;
    if (local === undefined) {
      return serverNotice;
    }

    if (serverNotice === undefined || local.at >= serverNoticeAt) {
      return local.notice;
    }

    return serverNotice;
  }
}
