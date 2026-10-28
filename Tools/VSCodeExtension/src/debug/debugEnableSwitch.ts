/**
 * `Debug 上报 [开/关]` 的状态机（附录 C.7 / F3 §评审清单 P0）。
 *
 * 三条不变量，缺一条就是评审 P0：
 * 1. **不做本地乐观更新**：`enabled` 只在两类事件上变化——`welcome.debugEnabled`（初值/重连）
 *    与 Unity 的 `debugEnabled` 广播（A.5）。用户点击只产生一个"挂起请求"，绝不改 `enabled`。
 * 2. 挂起期间再点**不重发**（第一条可能已经到达服务端，重发会让状态来回抖）。
 * 3. 超时或发送失败 ⇒ 清挂起、`enabled` 保持**最后一次服务端值**（因为从未被改写，天然回滚），
 *    只多一个可展示的 `error`。按钮按 `enabled` 重绘，于是回到原状态而不是停在乐观值。
 *
 * Player 模式（C.7）：`canToggle` 为 false 且 {@link DebugEnableSwitch.request} 直接返回
 * `unavailable`——不发 `debugSetEnabled`。
 *
 * 本类不依赖 `vscode`：宿主与单测用同一份逻辑（见 test/unit/debugEnableSwitch.test.ts）。
 */

import { defaultClearTimer, defaultSetTimer } from "../bridge/debugSupport";

/** A.3 的 `connectType`：只有 `player` 是"Player 模式"（`editor-player` 仍在编辑器里）。 */
export type DebugEnableMode = "editor" | "player";

/** 一次点击的结果：`sent` 已发出、`ignored` 挂起中、`unavailable` 不可发（Player/无连接）。 */
export type DebugEnableRequestResult = "sent" | "ignored" | "unavailable";

/** 挂起结束但**没有**收到广播的原因；`enabled` 不受影响。 */
export type DebugEnableError = "timeout" | "sendFailed";

/** 开关状态的服务端来源：初值来自 `welcome`，之后由广播更新（C.7）。 */
export type DebugEnableSource = "welcome" | "broadcast";

/** 面板可渲染的开关状态（纯数据，跨 Webview 边界安全）。 */
export interface DebugEnableState {
  readonly mode: DebugEnableMode;
  readonly enabled: boolean;
  readonly source: DebugEnableSource;
  /** 是否有一次请求在等广播。 */
  readonly pending: boolean;
  /** 挂起请求的目标值（诊断；UI 不得用它渲染开关位置）。 */
  readonly pendingTarget: boolean | undefined;
  /** 上一次请求失败的原因（超时/发送失败）；收到广播后清空。 */
  readonly error: DebugEnableError | undefined;
  /** 现在能否点击：编辑器模式且没有挂起请求。 */
  readonly canToggle: boolean;
  readonly timeoutMs: number;
}

/** 发送侧：只有"是否排进发送队列"这一个结果（服务端应答一律走广播）。 */
export interface DebugEnableTransport {
  /** `false` = 没有可用的连接，请求根本没出去（立即按失败处理）。 */
  sendSetEnabled(enabled: boolean): boolean;
}

export interface DebugEnableSwitchOptions {
  readonly mode: DebugEnableMode;
  /** `welcome.debugEnabled`（C.7 的初值）。 */
  readonly initialEnabled: boolean;
  readonly transport: DebugEnableTransport;
  /** 等广播的上限；超时即回滚（默认 4 s，见 {@link DEBUG_ENABLE_TIMEOUT_MS}）。 */
  readonly timeoutMs?: number;
  readonly setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onChange?: (state: DebugEnableState) => void;
}

/** 默认等待上限：一次本地回环往返在真机上远小于它；超时只影响提示，不影响开关值。 */
export const DEBUG_ENABLE_TIMEOUT_MS = 4_000;

export class DebugEnableSwitch {
  private readonly transport: DebugEnableTransport;
  private readonly setTimer: (callback: () => void, timeoutMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onChange: ((state: DebugEnableState) => void) | undefined;
  private timeoutMs: number;
  private modeValue: DebugEnableMode;
  private enabledValue: boolean;
  /** 是否有一条已握手连接可以承载 `debugSetEnabled`（没有时按钮置灰）。 */
  private availableValue = true;
  private sourceValue: DebugEnableSource = "welcome";
  private pendingTargetValue: boolean | undefined;
  private errorValue: DebugEnableError | undefined;
  private timer: unknown;
  private disposed = false;

  public constructor(options: DebugEnableSwitchOptions) {
    this.modeValue = options.mode;
    this.enabledValue = options.initialEnabled;
    this.transport = options.transport;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.trunc(options.timeoutMs as number)
      : DEBUG_ENABLE_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.onChange = options.onChange;
  }

  public get state(): DebugEnableState {
    return {
      mode: this.modeValue,
      enabled: this.enabledValue,
      source: this.sourceValue,
      pending: this.pendingTargetValue !== undefined,
      pendingTarget: this.pendingTargetValue,
      error: this.errorValue,
      canToggle: this.modeValue === "editor" && this.pendingTargetValue === undefined && this.availableValue,
      timeoutMs: this.timeoutMs,
    };
  }

  /** 当前服务端（或最后已知）值——面板把它同时用于状态栏与按钮位置。 */
  public get enabled(): boolean {
    return this.enabledValue;
  }

  /**
   * 用户点击：只投递请求，不改 `enabled`。
   *
   * Player 模式返回 `unavailable` 且**不发**任何消息（C.7）；挂起中返回 `ignored`。
   */
  public request(target: boolean): DebugEnableRequestResult {
    if (this.modeValue !== "editor") {
      return "unavailable";
    }

    if (this.pendingTargetValue !== undefined) {
      return "ignored";
    }

    if (!this.availableValue) {
      // 没有可承载请求的连接：按"发送失败"回滚（值不动），但按钮本来也是置灰的。
      this.fail("sendFailed");
      return "unavailable";
    }

    if (target === this.enabledValue) {
      // 已经是服务端值：仍然发一次（用户可能想在 Unity 侧重新同步），但不进入挂起等待，
      // 因为没有状态要变更；广播到达时照常更新。
      this.errorValue = undefined;
      if (!this.transport.sendSetEnabled(target)) {
        this.fail("sendFailed");
        return "unavailable";
      }

      return "sent";
    }

    const queued = this.transport.sendSetEnabled(target);
    if (!queued) {
      // 连接已经不在了：不要留下挂起，否则按钮会被锁 4 秒。
      this.fail("sendFailed");
      return "unavailable";
    }

    this.pendingTargetValue = target;
    this.errorValue = undefined;
    this.timer = this.setTimer(() => this.expire(), this.timeoutMs);
    this.emit();
    return "sent";
  }

  /** Unity 的 `debugEnabled` 广播（A.5）：唯一允许改写 `enabled` 的运行期事件。 */
  public applyBroadcast(enabled: boolean): void {
    this.cancelTimer();
    this.pendingTargetValue = undefined;
    this.errorValue = undefined;
    this.sourceValue = "broadcast";
    this.enabledValue = enabled;
    this.emit();
  }

  /** `welcome.debugEnabled`：初值与重连后的权威值；挂起请求作废。 */
  public applyWelcome(enabled: boolean): void {
    this.cancelTimer();
    this.pendingTargetValue = undefined;
    this.errorValue = undefined;
    this.sourceValue = "welcome";
    this.enabledValue = enabled;
    this.emit();
  }

  /** 连接类型变化（A.3）：切到 `player` 时撤销挂起，按钮置灰（C.7）。 */
  public setMode(mode: DebugEnableMode): void {
    if (mode === this.modeValue) {
      return;
    }

    this.modeValue = mode;
    if (mode === "player") {
      this.cancelTimer();
      this.pendingTargetValue = undefined;
    }

    this.emit();
  }

  /**
   * 有没有可承载 `debugSetEnabled` 的连接（C.7 状态栏的"已连接"）。
   *
   * 连接断开时如果还有挂起请求，它的广播永远不会来 ⇒ 当场按发送失败结算，
   * 值保持最后已知的服务端值（不猜、不回滚到点击值）。
   */
  public setAvailable(available: boolean): void {
    if (available === this.availableValue) {
      return;
    }

    this.availableValue = available;
    if (!available && this.pendingTargetValue !== undefined) {
      this.fail("sendFailed");
      return;
    }

    this.emit();
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  /** 测试专用：把等待上限压到毫秒级，让"超时回滚"用例能在宿主里跑完（生产值不变）。 */
  public setTimeoutForTest(timeoutMs: number): void {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      this.timeoutMs = Math.trunc(timeoutMs);
    }
  }

  private expire(): void {
    this.timer = undefined;
    if (this.disposed || this.pendingTargetValue === undefined) {
      return;
    }

    // 超时：**不改 enabled**（它从来没被乐观改写），只清挂起并暴露原因。
    this.pendingTargetValue = undefined;
    this.fail("timeout");
  }

  private fail(reason: DebugEnableError): void {
    this.cancelTimer();
    this.pendingTargetValue = undefined;
    this.errorValue = reason;
    this.emit();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private emit(): void {
    this.onChange?.(this.state);
  }
}
