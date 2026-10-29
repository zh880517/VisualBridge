/**
 * F3 面板单测的合成数据（不是测试文件：文件名不带 `.test`，runner 不会执行它）。
 *
 * 记录一律走 F2 的 `DebugInstanceManager.ingest`（真实路径），不手工拼 `DebugRecord`：
 * 面板的输入是 manager 的状态，绕开 ingest 会把"先入 store、再路由"的顺序也一起绕开。
 */

import type { DebugEnvelope } from "../../src/bridge/debugIngress";
import { BridgePayloadKind } from "../../src/bridge/framing";
import { DebugInstanceManager, debugInstanceKey } from "../../src/bridge/debugInstanceManager";
import type { DebugConsumer, DebugRouter } from "../../src/bridge/debugRouter";
import { DebugEnableSwitch, type DebugEnableTransport } from "../../src/debug/debugEnableSwitch";
import { DebugPanelModel, type DebugPanelConnection, type DebugPanelQueryState, type DebugPanelReplayState } from "../../src/debug/debugPanelState";

export const EDITOR_CONNECTION: DebugPanelConnection = {
  state: "connected",
  sources: { editor: true, runtime: false },
  canRequestEnable: true,
  detail: undefined,
  endpointId: "unity-1",
  target: "127.0.0.1:4040",
  connectType: "editor",
  frame: 7,
};

export function createManager(options: {
  readonly router?: DebugRouter;
  readonly maxRecords?: number;
  /** 实例数上限：压到 1 就能用第二个 `Create` 把第一个实例挤成墓碑。 */
  readonly maxInstances?: number;
  /** 全局字节上限：压小后一次 append 就能淘汰**别的**分类的最后一条记录（P2-2）。 */
  readonly maxBytesGlobal?: number;
  /** 关键帧触发间隔（条）：设 1 让每条记录都触发捕获（P2-2 的空状态关键帧）。 */
  readonly keyframeIntervalRecords?: number;
} = {}): DebugInstanceManager {
  return new DebugInstanceManager({
    ...(options.router === undefined ? {} : { router: options.router }),
    limits: {
      ...(options.maxRecords === undefined ? {} : { maxRecordsPerInstance: options.maxRecords }),
      ...(options.maxInstances === undefined ? {} : { maxInstances: options.maxInstances }),
      ...(options.maxBytesGlobal === undefined ? {} : { maxBytesGlobal: options.maxBytesGlobal }),
      ...(options.keyframeIntervalRecords === undefined ? {} : { keyframeIntervalRecords: options.keyframeIntervalRecords }),
    },
    now: () => 1_000,
  });
}

export function createInstance(
  manager: DebugInstanceManager,
  category: string,
  instance: string,
  extra: { readonly resName?: string; readonly debugInfo?: string; readonly slot?: number } = {},
): void {
  manager.ingest({
    type: "debugCreate",
    frame: -1,
    wireBytes: 10,
    payloadKind: BridgePayloadKind.Json,
    category,
    instance,
    instanceSlot: extra.slot ?? 1,
    resName: extra.resName ?? `${instance}-res`,
    debugInfo: extra.debugInfo ?? "",
  });
}

export function setFrame(manager: DebugInstanceManager, frame: number): void {
  manager.ingest({
    type: "debugFrame",
    frame,
    wireBytes: 4,
    payloadKind: BridgePayloadKind.Json,
  });
}

export interface EventInput {
  readonly category?: string;
  readonly instance?: string;
  readonly frame: number;
  readonly interfaceId?: string;
  readonly method?: string;
  readonly tag?: number;
  readonly value?: unknown;
  readonly wireBytes?: number;
}

/** 一条 `debug` 事件（帧号由入参固定，管理器不按帧号排序，正好用来构造乱序到达）。 */
export function eventEnvelope(input: EventInput): DebugEnvelope {
  const tag = input.tag ?? 1;
  return {
    type: "debug",
    frame: input.frame,
    wireBytes: input.wireBytes ?? 24,
    payloadKind: BridgePayloadKind.Json,
    category: input.category ?? "graph",
    instance: input.instance ?? "hero",
    interfaceId: input.interfaceId ?? "IGraphDebuger",
    method: input.method ?? "NodeStarted",
    methodId: 10,
    instanceSlot: 1,
    args: [{ tag, name: "nodeId", type: "string", value: input.value ?? `node-${input.frame}` }],
    contractState: "unknown-interface",
  };
}

/** 连续投递若干事件，返回实际落进 store 的条数。 */
export function ingestEvents(manager: DebugInstanceManager, inputs: readonly EventInput[]): number {
  let applied = 0;
  for (const input of inputs) {
    applied += manager.ingest(eventEnvelope(input)).length;
  }

  return applied;
}

/** 记录一切投递的假消费者（用来证明 `replay()` 真的被调用了）。 */
export class RecordingConsumer implements DebugConsumer {
  public readonly categories: readonly string[];
  public readonly records: number[] = [];
  public resets = 0;

  public constructor(category: string) {
    this.categories = [category];
  }

  public accepts(): boolean {
    return true;
  }

  public consume(record: { readonly arrivalSeq: number }): void {
    this.records.push(record.arrivalSeq);
  }

  public reset(): void {
    this.resets += 1;
  }
}

/** 可编程的发送器：按脚本返回"是否发出"，并记录每次请求。 */
export class FakeTransport implements DebugEnableTransport {
  public readonly sent: boolean[] = [];
  public answer = true;

  public sendSetEnabled(enabled: boolean): boolean {
    this.sent.push(enabled);
    return this.answer;
  }
}

/** 手动推进的定时器：单测不等真实时间，超时分支可精确触发。 */
export class ManualTimer {
  private handle = 0;
  private readonly callbacks = new Map<number, () => void>();

  public readonly set = (callback: () => void): unknown => {
    this.handle += 1;
    this.callbacks.set(this.handle, callback);
    return this.handle;
  };

  public readonly clear = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
  };

  public get pending(): number {
    return this.callbacks.size;
  }

  /** 触发全部未取消的定时器（模拟"超时"）。 */
  public fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

export function createEnableSwitch(options: {
  readonly transport?: FakeTransport;
  readonly initialEnabled?: boolean;
  readonly mode?: "editor" | "player";
  readonly timer?: ManualTimer;
} = {}): { readonly enable: DebugEnableSwitch; readonly transport: FakeTransport; readonly timer: ManualTimer } {
  const transport = options.transport ?? new FakeTransport();
  const timer = options.timer ?? new ManualTimer();
  const enable = new DebugEnableSwitch({
    mode: options.mode ?? "editor",
    initialEnabled: options.initialEnabled ?? true,
    transport,
    timeoutMs: 10,
    setTimer: (callback) => timer.set(callback),
    clearTimer: (handle) => timer.clear(handle),
  });
  return { enable, transport, timer };
}

export function createModel(options: {
  readonly manager?: DebugInstanceManager;
  readonly enable?: DebugEnableSwitch;
  readonly connection?: DebugPanelConnection;
  readonly windowRecords?: number;
  readonly replay?: () => DebugPanelReplayState | undefined;
  readonly query?: () => DebugPanelQueryState;
  readonly onRecordingToggle?: () => void;
} = {}): {
  readonly model: DebugPanelModel;
  readonly manager: DebugInstanceManager;
  readonly enable: DebugEnableSwitch;
  readonly transport: FakeTransport;
  readonly timer: ManualTimer;
} {
  const manager = options.manager ?? createManager();
  const created = options.enable === undefined
    ? createEnableSwitch()
    : { enable: options.enable, transport: new FakeTransport(), timer: new ManualTimer() };
  const model = new DebugPanelModel({
    manager,
    enable: created.enable,
    connection: () => options.connection ?? EDITOR_CONNECTION,
    ...(options.windowRecords === undefined ? {} : { windowRecords: options.windowRecords }),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.onRecordingToggle === undefined ? {} : { onRecordingToggle: options.onRecordingToggle }),
    keyframeCount: (category) => manager.keyframes.count(category),
  });
  return { model, manager, enable: created.enable, transport: created.transport, timer: created.timer };
}

export function instanceKeyOf(category: string, instance: string): string {
  return debugInstanceKey(category, instance);
}
