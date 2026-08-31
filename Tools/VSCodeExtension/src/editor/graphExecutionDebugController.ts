import { RuntimeBridgeService } from "../bridge/runtimeBridgeService";
import { GraphExecutionRecording, type RecordedGraphExecutionEvent } from "../bridge/graphExecutionRecording";

/** 供测试命令轮询的调试控制器状态（§19.5 页面交互）。 */
export interface GraphExecutionDebugTestState {
  readonly runtimeConnected: boolean;
  readonly runtimeInstanceId?: string;
  readonly subscribedExecutionId?: string;
  readonly totalEvents: number;
  readonly stopped: boolean;
  readonly instanceCount: number;
  readonly instanceIds: readonly string[];
  readonly lastWebviewAck?: {
    readonly eventCount: number;
    readonly cursor: number;
    readonly executingNodeId: string | null;
    readonly mode: "follow" | "replay";
  };
}

export interface GraphExecutionDebugControllerOptions {
  readonly postMessage: (message: unknown) => Promise<boolean>;
  readonly getDocumentId: () => string | undefined;
  readonly output: (line: string) => void;
}

interface DebugWebviewMessage {
  readonly type?: unknown;
  readonly requestId?: unknown;
  readonly executionId?: unknown;
  readonly eventCount?: unknown;
  readonly cursor?: unknown;
  readonly executingNodeId?: unknown;
  readonly mode?: unknown;
}

/**
 * Graph 编辑器会话专属的执行调试控制器（§19.5）：持有独立于 DAP 检查
 * 会话的 RuntimeBridgeService 连接（观察者语义不占租约，可并行观察），
 * 负责 Runtime 实例发现/自动连接、执行实例订阅与增量事件转发到 Webview。
 */
export class GraphExecutionDebugController {
  private readonly service: RuntimeBridgeService;
  private sentEventCount = 0;
  private subscribedExecutionId: string | undefined;
  // 订阅回复送达 Webview 后才转发事件：Webview 依据回复重置本地累计，乱序会丢开流标记。
  private subscribeAnnounced = false;
  private instanceIds: readonly string[] = [];
  private lastWebviewAck: GraphExecutionDebugTestState["lastWebviewAck"];
  private disposed = false;

  public constructor(private readonly options: GraphExecutionDebugControllerOptions) {
    // 独立连接是冻结设计属性：与 DAP/MCP 客户端互不影响。
    this.service = new RuntimeBridgeService((message) => options.output(message));
    this.service.setEventListener((event) => this.handleRuntimeEvent(event));
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.service.setEventListener(undefined);
    this.service.disconnect();
  }

  public get testState(): GraphExecutionDebugTestState {
    const state = this.service.state;
    const recording = this.service.activeRecording;
    return {
      runtimeConnected: state.connected,
      ...(state.instanceId === undefined ? {} : { runtimeInstanceId: state.instanceId }),
      ...(this.subscribedExecutionId === undefined ? {} : { subscribedExecutionId: this.subscribedExecutionId }),
      totalEvents: recording?.recordedEvents.length ?? 0,
      stopped: recording?.isStopped ?? false,
      instanceCount: this.instanceIds.length,
      instanceIds: this.instanceIds,
      ...(this.lastWebviewAck === undefined ? {} : { lastWebviewAck: this.lastWebviewAck }),
    };
  }

  public async handleWebviewMessage(message: DebugWebviewMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (message.type === "graphDebugAck") {
      if (typeof message.eventCount === "number" && typeof message.cursor === "number") {
        this.lastWebviewAck = {
          eventCount: message.eventCount,
          cursor: message.cursor,
          executingNodeId: typeof message.executingNodeId === "string" ? message.executingNodeId : null,
          mode: message.mode === "replay" ? "replay" : "follow",
        };
      }
      return;
    }
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (message.type === "requestGraphExecutionInstances") {
      await this.listInstances(requestId);
      return;
    }
    if (message.type === "subscribeGraphExecution") {
      await this.subscribe(requestId, typeof message.executionId === "string" ? message.executionId : "");
      return;
    }
    if (message.type === "unsubscribeGraphExecution") {
      await this.unsubscribe(requestId);
      return;
    }
    if (message.type === "requestGraphExecutionDebugState") {
      await this.sendDebugState(requestId);
    }
  }

  private async listInstances(requestId: string): Promise<void> {
    try {
      await this.ensureConnected();
      const state = this.service.state;
      if (!state.connected) {
        this.instanceIds = [];
        await this.options.postMessage({
          type: "graphExecutionInstances",
          requestId,
          executions: [],
          runtimeConnected: false,
        });
        return;
      }
      const documentId = this.options.getDocumentId();
      const executions = await this.service.getGraphExecutionInstances(documentId);
      this.instanceIds = executions.map((execution) => execution.executionId);
      await this.options.postMessage({
        type: "graphExecutionInstances",
        requestId,
        executions,
        runtimeConnected: true,
        ...(state.instanceId === undefined ? {} : { runtimeInstanceId: state.instanceId }),
      });
    } catch (errorValue) {
      this.instanceIds = [];
      this.options.output(`实例枚举失败：${formatError(errorValue)}`);
      await this.options.postMessage({
        type: "graphExecutionInstances",
        requestId,
        executions: [],
        runtimeConnected: false,
      });
    }
  }

  private async subscribe(requestId: string, executionId: string): Promise<void> {
    if (executionId.length === 0) {
      await this.options.postMessage({
        type: "graphExecutionSubscribed",
        requestId,
        ok: false,
        error: "缺少执行实例 ID。",
      });
      return;
    }
    try {
      await this.ensureConnected();
      if (this.subscribedExecutionId !== undefined && this.subscribedExecutionId !== executionId) {
        await this.service.unsubscribeGraphExecution();
      }
      // 计数先于订阅请求归零：服务端紧随 ok 推送的合成开流标记不会漏发或重发。
      this.subscribedExecutionId = executionId;
      this.sentEventCount = 0;
      // 订阅回复先于事件推送送达 Webview（Webview 收到回复会重置本地累计）。
      this.subscribeAnnounced = false;
      try {
        const recording = await this.service.subscribeGraphExecution(executionId);
        await this.options.postMessage({
          type: "graphExecutionSubscribed",
          requestId,
          ok: true,
          execution: recording.execution,
        });
        this.subscribeAnnounced = true;
        await this.pushRecordingDelta(recording);
      } catch (subscribeError) {
        this.subscribedExecutionId = undefined;
        this.sentEventCount = 0;
        this.subscribeAnnounced = false;
        throw subscribeError;
      }
    } catch (errorValue) {
      await this.options.postMessage({
        type: "graphExecutionSubscribed",
        requestId,
        ok: false,
        error: formatError(errorValue),
      });
    }
  }

  private async unsubscribe(requestId: string): Promise<void> {
    try {
      await this.service.unsubscribeGraphExecution();
    } catch (errorValue) {
      this.options.output(`退订失败：${formatError(errorValue)}`);
    }
    // 退订即断开本控制器的 Runtime 连接：释放资源，重订阅时重新自动连接。
    this.service.disconnect();
    this.subscribedExecutionId = undefined;
    this.sentEventCount = 0;
    this.subscribeAnnounced = false;
    this.instanceIds = [];
    await this.options.postMessage({ type: "graphExecutionUnsubscribed", requestId });
  }

  private async sendDebugState(requestId: string): Promise<void> {
    // Webview 在 epoch 重置后全量再水化；随后恢复增量推送。
    const recording = this.service.activeRecording;
    if (this.subscribedExecutionId === undefined || recording === undefined) {
      await this.options.postMessage({
        type: "graphExecutionDebugState",
        requestId,
        subscribed: false,
        events: [],
        stopped: false,
      });
      return;
    }
    this.sentEventCount = recording.recordedEvents.length;
    this.subscribeAnnounced = true;
    await this.options.postMessage({
      type: "graphExecutionDebugState",
      requestId,
      subscribed: true,
      execution: recording.execution,
      events: [...recording.recordedEvents],
      stopped: recording.isStopped,
    });
  }

  private handleRuntimeEvent(event: { readonly event: string }): void {
    if (event.event !== "graphExecution" || this.disposed) {
      return;
    }
    const recording = this.service.activeRecording;
    if (recording === undefined || this.subscribedExecutionId === undefined || !this.subscribeAnnounced) {
      return;
    }
    void this.pushRecordingDelta(recording);
  }

  /** 把记录中尚未推送的事件增量转发给 Webview（含 instanceStopped 收尾）。 */
  private async pushRecordingDelta(recording: GraphExecutionRecording): Promise<void> {
    if (recording.recordedEvents.length > this.sentEventCount) {
      const events: readonly RecordedGraphExecutionEvent[] = recording.recordedEvents.slice(this.sentEventCount);
      this.sentEventCount = recording.recordedEvents.length;
      await this.options.postMessage({
        type: "graphExecutionEvents",
        events,
        totalEvents: this.sentEventCount,
        stopped: recording.isStopped,
      });
    }
    if (recording.isStopped) {
      await this.options.postMessage({
        type: "graphExecutionStopped",
        executionId: recording.executionId,
        totalEvents: this.sentEventCount,
      });
    }
  }

  /** 发现目录存在且当前连接实例仍新鲜时复用连接；否则自动连接首个非陈旧实例。 */
  private async ensureConnected(): Promise<void> {
    const instances = await this.service.enumerateInstances(process.env.VISUALBRIDGE_TEST_RUNTIME_DIR);
    const fresh = instances.filter((instance) => instance.staleReason === undefined);
    const current = this.service.state;
    if (current.connected
      && current.instanceId !== undefined
      && fresh.some((instance) => instance.instanceId === current.instanceId)) {
      return;
    }
    this.service.disconnect();
    this.subscribedExecutionId = undefined;
    this.sentEventCount = 0;
    this.subscribeAnnounced = false;
    const target = fresh[0];
    if (target === undefined) {
      return;
    }
    await this.service.connect(target);
  }
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
