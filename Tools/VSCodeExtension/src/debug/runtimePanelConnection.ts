/**
 * 面板 Runtime 腿的生产连接触发（E10）。
 *
 * 背景：E9 把 Runtime 桥的 ch1 接进了面板的实例表，但**生产里没有人建立连接**——`runtimeBridge.connect` /
 * `probeAndConnect` 只出现在 `extensionMode !== Production` 的测试命令块里，唯一的真实连接者是 DAP attach。
 * 本模块把"打开图页面 / 调试面板时按需连接"做成一个可重试、永不抛错、永不阻塞 UI 的确保流程。
 *
 * 约束：
 * - **只使用宿主注入的那一个 `RuntimeBridgeService`**（`extension.ts` 的 `runtimeBridge`）：多一个实例就是
 *   多一条抢 Unity 侧 ch1 的连接（Unity 侧 `Bind` 是栈式，但同一时刻只有一条活动 wire）。
 * - 面板/图页面是**观察者**语义：不取租约（租约只属于 DAP），因此与 DAP attach 共用同一连接不会互相踢掉；
 *   DAP 的 `connect` / `disconnect` 仍由 DAP 负责，本模块只在"没人连"时补位，并在失败时给出可读原因。
 * - 连接失败（Unity 未开 / 端口段无响应 / 握手失败）**不抛异常**，只落到 {@link RuntimePanelConnectionStatus}，
 *   面板据此显示"未连接 + 原因"；重试由 {@link RuntimePanelConnection.ensureConnected} 再次调用完成。
 */

import type { RuntimeBridgeConnectionState, RuntimeBridgeInstance, RuntimeBridgeProbeOptions } from "../bridge/runtimeBridgeService";
import type { RuntimeBridgeWelcomeMessage } from "../bridge/runtimeBridgeProtocol";
import { RuntimeBridgeProtocolError } from "../bridge/runtimeBridgeProtocol";

/** 端口段探测默认值（附录 A.8：并发 8、单口 300 ms；Player 监听段 28300–28349）。 */
export const RUNTIME_PANEL_DEFAULT_HOST = "127.0.0.1";
export const RUNTIME_PANEL_DEFAULT_PORT_RANGE_START = 28300;
export const RUNTIME_PANEL_DEFAULT_PORT_RANGE_END = 28349;
export const RUNTIME_PANEL_DEFAULT_PROBE_TIMEOUT_MS = 300;
export const RUNTIME_PANEL_DEFAULT_PROBE_CONCURRENCY = 8;
export const RUNTIME_PANEL_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** 面板/接缝需要的 `RuntimeBridgeService` 子集：单测可以喂一个假对象。 */
export interface RuntimePanelBridge {
  readonly state: RuntimeBridgeConnectionState;
  enumerateInstances(directoryOverride?: string): Promise<RuntimeBridgeInstance[]>;
  connect(instance: RuntimeBridgeInstance, timeoutMs?: number): Promise<RuntimeBridgeWelcomeMessage>;
  probeAndConnect(options: RuntimeBridgeProbeOptions): Promise<RuntimeBridgeWelcomeMessage>;
}

/** 面板状态栏看到的 Runtime 腿状态（`connected` 由服务实例的真实连接状态派生，不是本地缓存）。 */
export interface RuntimePanelConnectionStatus {
  readonly state: "disconnected" | "connecting" | "connected" | "failed";
  /** 未连接/失败时的可读原因（面板状态栏原样显示；`undefined` = 没什么可说的）。 */
  readonly detail?: string;
  readonly endpointId?: string;
  readonly target?: string;
  readonly connectType?: "editor" | "editor-player" | "player";
  readonly debugFrames?: number;
  readonly debugEnvelopes?: number;
}

export interface RuntimePanelProbeConfig {
  readonly host: string;
  readonly portRangeStart: number;
  readonly portRangeEnd: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
}

export interface RuntimePanelConnectionOptions {
  /** 宿主共享的 Runtime 桥（**不得**在这里 new 第二个服务实例）。 */
  readonly service: () => RuntimePanelBridge;
  readonly log?: (message: string) => void;
  /** 发现记录目录覆盖（宿主测试的 `VISUALBRIDGE_TEST_RUNTIME_DIR`；生产缺省用临时目录）。 */
  readonly discoveryDirectory?: string;
  readonly probe?: Partial<RuntimePanelProbeConfig>;
  readonly connectTimeoutMs?: number;
}

/**
 * 单飞（single-flight）的"确保连接"：面板与图页面同时打开也只会发起一次连接尝试。
 *
 * 状态派生规则（面板状态栏的自相矛盾就出在这里，务必保持）：
 * - 服务实例**真的连上了** ⇒ `connected`（哪怕连接不是本模块建立的，例如 DAP attach 的观察连接）；
 * - 尝试在途 ⇒ `connecting`；
 * - 上一次尝试失败且仍未连上 ⇒ `failed` + 原因；
 * - 其余 ⇒ `disconnected`。
 */
export class RuntimePanelConnection {
  private readonly options: RuntimePanelConnectionOptions;
  private pending: Promise<RuntimePanelConnectionStatus> | undefined;
  private connecting = false;
  private failure: string | undefined;
  private disposed = false;
  private readonly probe: RuntimePanelProbeConfig;

  public constructor(options: RuntimePanelConnectionOptions) {
    this.options = options;
    const probe = options.probe ?? {};
    this.probe = {
      host: probe.host ?? RUNTIME_PANEL_DEFAULT_HOST,
      portRangeStart: probe.portRangeStart ?? RUNTIME_PANEL_DEFAULT_PORT_RANGE_START,
      portRangeEnd: probe.portRangeEnd ?? RUNTIME_PANEL_DEFAULT_PORT_RANGE_END,
      timeoutMs: probe.timeoutMs ?? RUNTIME_PANEL_DEFAULT_PROBE_TIMEOUT_MS,
      concurrency: probe.concurrency ?? RUNTIME_PANEL_DEFAULT_PROBE_CONCURRENCY,
    };
  }

  /**
   * 确保存在一条到 Unity Runtime 桥的连接。**永不 reject、永不阻塞调用方**（返回的 Promise 只用于
   * 测试/日志观察，面板打开路径用 `void` 调用）。
   */
  public ensureConnected(reason: string): Promise<RuntimePanelConnectionStatus> {
    if (this.disposed) {
      return Promise.resolve(this.status);
    }

    if (this.options.service().state.connected) {
      // DAP 已经连上了：复用同一条连接，面板直接开始收帧。
      this.failure = undefined;
      return Promise.resolve(this.status);
    }

    if (this.pending !== undefined) {
      return this.pending;
    }

    this.connecting = true;
    this.failure = undefined;
    this.log(`connecting runtime bridge (${reason})`);
    this.pending = this.connectOnce(reason).finally(() => {
      this.connecting = false;
      this.pending = undefined;
    });
    return this.pending;
  }

  /** 面板状态栏的实时状态：`connected` 一律以服务实例为准，避免本地缓存与服务状态分叉。 */
  public get status(): RuntimePanelConnectionStatus {
    const state = this.options.service().state;
    if (state.connected) {
      const connectType = state.kind === "player" || state.kind === "editor-player" ? state.kind : undefined;
      return {
        state: "connected",
        ...(state.instanceId === undefined ? {} : { endpointId: state.instanceId }),
        ...(state.tcpPort === undefined ? {} : { target: `127.0.0.1:${state.tcpPort}` }),
        ...(connectType === undefined ? {} : { connectType }),
        ...(state.debugFrames === undefined ? {} : { debugFrames: state.debugFrames }),
        ...(state.debugEnvelopes === undefined ? {} : { debugEnvelopes: state.debugEnvelopes }),
      };
    }

    if (this.failure !== undefined) {
      // 失败一定发生在尝试结束之后；先于 `connecting` 判断，避免收尾瞬间显示成"正在连接"。
      return { state: "failed", detail: this.failure };
    }

    if (this.connecting) {
      return { state: "connecting", detail: `正在连接 Runtime Bridge（${this.probe.host}）…` };
    }

    return { state: "disconnected" };
  }

  public dispose(): void {
    this.disposed = true;
    this.pending = undefined;
  }

  private async connectOnce(reason: string): Promise<RuntimePanelConnectionStatus> {
    try {
      const instance = await this.findInstance();
      if (instance !== undefined) {
        const welcome = await this.options.service().connect(
          instance,
          this.options.connectTimeoutMs ?? RUNTIME_PANEL_DEFAULT_CONNECT_TIMEOUT_MS,
        );
        this.failure = undefined;
        this.log(
          `connected runtime bridge (${reason}) instance=${welcome.endpointId} kind=${welcome.connectType} `
          + `port=${instance.tcpPort} generation=${welcome.generation}`,
        );
        return this.status;
      }

      // 没有发现记录：按附录 A.8 的端口段探测再试一次（Player 无法被记录发现时的兜底）。
      const welcome = await this.options.service().probeAndConnect({
        host: this.probe.host,
        portRangeStart: this.probe.portRangeStart,
        portRangeEnd: this.probe.portRangeEnd,
        timeoutMs: this.probe.timeoutMs,
        concurrency: this.probe.concurrency,
        token: "",
      });
      this.failure = undefined;
      this.log(
        `connected runtime bridge by probing ${this.probe.host}:${this.probe.portRangeStart}-${this.probe.portRangeEnd} `
        + `(${reason}) instance=${welcome.endpointId} kind=${welcome.connectType} generation=${welcome.generation}`,
      );
      return this.status;
    } catch (errorValue) {
      this.failure = describeFailure(errorValue, this.probe);
      this.log(`runtime bridge connection failed (${reason}): ${this.failure}`);
      return this.status;
    }
  }

  /** 选一条**活着的**发现记录：优先 editor-play（本机 Play），其次 Player；同类取最新。 */
  private async findInstance(): Promise<RuntimeBridgeInstance | undefined> {
    const instances = await this.options.service().enumerateInstances(this.options.discoveryDirectory);
    const live = instances.filter((instance) => instance.staleReason === undefined);
    const candidates = live.length > 0
      ? live
      // 心跳停滞但 pid 仍活着的记录仍值得一试（Editor 域重载期间记录可能短暂冻结）；
      // `deadPid` 是明确的陈旧记录，直接跳过。
      : instances.filter((instance) => instance.staleReason === "runtime.staleRecord");
    if (candidates.length === 0) {
      return undefined;
    }

    return [...candidates].sort(compareInstances)[0];
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function compareInstances(left: RuntimeBridgeInstance, right: RuntimeBridgeInstance): number {
  // editor-play 优先：同一台机器上同时有 Player 时，界面上正在编辑的 Unity 更有可能是目标。
  const leftRank = left.kind === "editor-play" ? 0 : 1;
  const rightRank = right.kind === "editor-play" ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if (left.startedAt !== right.startedAt) {
    return left.startedAt < right.startedAt ? 1 : -1;
  }

  return left.instanceId.localeCompare(right.instanceId);
}

function describeFailure(errorValue: unknown, probe: RuntimePanelProbeConfig): string {
  if (errorValue instanceof RuntimeBridgeProtocolError && errorValue.code === "runtime.noEndpoint") {
    return "未找到 Runtime 端点：Unity 未进入 Play 或 Player 未启动"
      + `（已探测 ${probe.host}:${probe.portRangeStart}-${probe.portRangeEnd}）`;
  }

  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return `连接 Runtime Bridge 失败：${message}`;
}
