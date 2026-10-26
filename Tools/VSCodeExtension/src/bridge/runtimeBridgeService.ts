import * as net from "net";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  parseRuntimeBridgeDiscoveryRecord,
  parseRuntimeBridgeMessage,
  RUNTIME_BRIDGE_CAPABILITIES,
  RUNTIME_BRIDGE_DISCOVERY_DIRECTORY,
  RuntimeBridgeDocumentSnapshot,
  RuntimeBridgeDocumentSource,
  RuntimeBridgeGraphExecutionInstance,
  RuntimeBridgeLeaseRequest,
  RuntimeBridgeResponseMessage,
  RuntimeBridgeSourcesRequest,
  RuntimeBridgeEventMessage,
  RuntimeBridgeProtocolError,
  RuntimeBridgeSnapshotRequest,
  RuntimeBridgeGraphExecutionInstancesRequest,
  RuntimeBridgeGraphExecutionSubscriptionRequest,
  RuntimeBridgeGraphExecutionSnapshotRequest,
  RuntimeBridgeWelcomeMessage,
} from "./runtimeBridgeProtocol";
import { BridgeSocket } from "./bridgeSocket";
import { BRIDGE_PROTOCOL_VERSION } from "./bridgeProtocol";
import { BridgePayloadKind } from "./framing";
import { GraphExecutionRecording } from "./graphExecutionRecording";

export interface RuntimeBridgeInstance {
  readonly recordPath: string;
  readonly instanceId: string;
  readonly kind: "editor-play" | "player";
  readonly tcpPort: number;
  readonly token: string;
  readonly pid: number;
  readonly generation: number;
  readonly startedAt: string;
  readonly staleReason?: string;
}

export interface RuntimeBridgeConnectionState {
  readonly connected: boolean;
  readonly instanceId?: string;
  readonly kind?: string;
  readonly generation?: number;
  readonly lastSnapshotCount?: number;
  readonly lastEventCount?: number;
  readonly subscribedExecutionId?: string;
}

export class RuntimeBridgeService {
  private connection: RuntimeBridgeConnection | undefined;
  private eventListener: ((event: RuntimeBridgeEventMessage) => void) | undefined;
  private recording: GraphExecutionRecording | undefined;

  public constructor(private readonly output: (message: string) => void) {
  }

  public get state(): RuntimeBridgeConnectionState {
    return this.connection?.state ?? { connected: false };
  }

  public async enumerateInstances(directoryOverride?: string): Promise<RuntimeBridgeInstance[]> {
    const directory = directoryOverride
      ?? path.join(os.tmpdir(), RUNTIME_BRIDGE_DISCOVERY_DIRECTORY);
    let entries: readonly string[];
    try {
      entries = await (await import("fs")).promises.readdir(directory);
    } catch {
      return [];
    }

    const instances: RuntimeBridgeInstance[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const recordPath = path.join(directory, entry);
      let text: string;
      let stats: { readonly mtimeMs: number };
      try {
        const fs = await import("fs");
        text = await fs.promises.readFile(recordPath, "utf8");
        stats = await fs.promises.stat(recordPath);
      } catch {
        continue;
      }

      try {
        const record = parseRuntimeBridgeDiscoveryRecord(JSON.parse(text));
        const ageMs = Date.now() - stats.mtimeMs;
        let staleReason: string | undefined;
        if (ageMs > 5000) staleReason = "runtime.staleRecord";
        else if (!processExists(record.pid)) staleReason = "runtime.deadPid";
        instances.push({
          recordPath,
          instanceId: record.instanceId,
          kind: record.kind,
          tcpPort: record.tcpPort,
          token: record.token,
          pid: record.pid,
          generation: record.generation,
          startedAt: record.startedAt,
          ...(staleReason === undefined ? {} : { staleReason }),
        });
      } catch (errorValue) {
        this.output(`Skipping invalid runtime discovery record ${recordPath}: ${(errorValue as Error).message}`);
      }
    }

    return instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  }

  public async connect(instance: RuntimeBridgeInstance, timeoutMs = 5000): Promise<RuntimeBridgeWelcomeMessage> {
    this.disconnect();
    const connection = new RuntimeBridgeConnection(instance, this.output, (event) => this.handleEvent(event));
    this.connection = connection;
    try {
      const welcome = await connection.connect(timeoutMs);
      return welcome;
    } catch (errorValue) {
      this.disconnect();
      throw errorValue;
    }
  }

  public disconnect(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.recording = undefined;
  }



  public setEventListener(listener: ((event: RuntimeBridgeEventMessage) => void) | undefined): void {
    this.eventListener = listener === undefined ? undefined : listener;
  }

  /** 当前执行订阅的会话记录（未订阅时为 undefined；记录随退订从服务摘除，引用归会话持有方）。 */
  public get activeRecording(): GraphExecutionRecording | undefined {
    return this.recording;
  }

  private handleEvent(event: RuntimeBridgeEventMessage): void {
    if (event.event === "graphExecution") {
      this.recording?.append(event.executionEvents);
    }

    this.eventListener?.(event);
  }

  public async getSnapshot(documentTypeIds?: readonly string[]): Promise<readonly RuntimeBridgeDocumentSnapshot[]> {
    if (this.connection === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    return this.connection.getSnapshot(documentTypeIds);
  }

  public async acquireLease(): Promise<void> {
    if (this.connection === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    return this.connection.acquireLease();
  }

  public async releaseLease(): Promise<void> {
    if (this.connection === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    return this.connection.releaseLease();
  }

  public async getDocumentSources(): Promise<readonly RuntimeBridgeDocumentSource[]> {
    if (this.connection === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    return this.connection.getDocumentSources();
  }

  public async getGraphExecutionInstances(documentId?: string): Promise<readonly RuntimeBridgeGraphExecutionInstance[]> {
    if (this.connection === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    return this.connection.getGraphExecutionInstances(documentId);
  }

  /**
   * 订阅单个执行实例并开始会话记录（§19.5）：记录对象在发送订阅请求前挂上，
   * 服务端紧随 ok 推送的合成 instanceStarted 开流标记不会丢失。
   */
  public async subscribeGraphExecution(executionId: string): Promise<GraphExecutionRecording> {
    if (this.connection === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    const snapshot = await this.connection.getGraphExecutionSnapshot(executionId);
    const recording = new GraphExecutionRecording(snapshot);
    this.recording = recording;
    try {
      await this.connection.subscribeGraphExecution(executionId);
    } catch (errorValue) {
      this.recording = undefined;
      throw errorValue;
    }

    return recording;
  }

  /** 退订当前实例（幂等）；服务端随即停录，记录引用归会话持有方处置。 */
  public async unsubscribeGraphExecution(): Promise<void> {
    const executionId = this.recording?.executionId;
    if (this.connection !== undefined && executionId !== undefined) {
      await this.connection.unsubscribeGraphExecution(executionId);
    }

    this.recording = undefined;
  }

  public async getGraphExecutionSnapshot(executionId: string): Promise<RuntimeBridgeGraphExecutionInstance> {
    if (this.connection === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    return this.connection.getGraphExecutionSnapshot(executionId);
  }
}

interface PendingRequest {
  readonly resolve: (response: RuntimeBridgeResponseMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface Handshake {
  readonly resolve: (welcome: RuntimeBridgeWelcomeMessage) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export class RuntimeBridgeConnection {
  private bridge: BridgeSocket | undefined;
  private pending = new Map<string, PendingRequest>();
  private handshake: Handshake | undefined;
  private readonly events: RuntimeBridgeEventMessage[] = [];
  private welcome: RuntimeBridgeWelcomeMessage | undefined;
  private snapshotCount = 0;
  private subscribedExecutionId: string | undefined;
  private disposed = false;
  private connectionError: Error | undefined;

  public constructor(
    private readonly instance: RuntimeBridgeInstance,
    private readonly output: (message: string) => void,
    private readonly onEvent: (event: RuntimeBridgeEventMessage) => void,
  ) {
  }

  public get state(): RuntimeBridgeConnectionState {
    if (this.welcome === undefined || this.connectionError !== undefined) {
      return { connected: false };
    }

    return {
      connected: !this.disposed,
      instanceId: this.welcome.instanceId,
      kind: this.welcome.kind,
      generation: this.welcome.generation,
      lastSnapshotCount: this.snapshotCount,
      lastEventCount: this.events.length,
      ...(this.subscribedExecutionId === undefined ? {} : { subscribedExecutionId: this.subscribedExecutionId }),
    };
  }

  public connect(timeoutMs: number): Promise<RuntimeBridgeWelcomeMessage> {
    return new Promise<RuntimeBridgeWelcomeMessage>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: this.instance.tcpPort });
      this.disposed = false;
      this.welcome = undefined;
      this.connectionError = undefined;

      const handshake: Handshake = { resolve, reject, timer: undefined };
      this.handshake = handshake;
      handshake.timer = setTimeout(() => {
        this.finishHandshake(undefined, new Error("Runtime bridge connect timed out."));
      }, timeoutMs);

      const bridge = new BridgeSocket(socket, {
        onControlPayload: (payload) => this.handlePayload(payload),
        onDebugFrame: (payloadKind: BridgePayloadKind, payload: Buffer) => {
          // E1 只搭传输：Runtime 通道现阶段的业务消息全部走控制通道，调试通道留给 E4。
          this.output(`Runtime bridge ignored a ${payload.length}-byte debug payload (kind ${payloadKind}).`);
        },
        onClosed: (error) => {
          const failure = error ?? new Error(this.handshake === undefined
            ? "Runtime bridge connection closed."
            : "Runtime bridge connection closed before welcome.");
          if (this.handshake !== undefined) this.finishHandshake(undefined, failure);
          else this.invalidate(failure);
        },
      }, { log: (message) => this.output(message) });
      this.bridge = bridge;

      socket.on("connect", () => {
        if (!bridge.isOpen) {
          return;
        }

        bridge.sendControlJson({
          type: "hello",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          coreVersion: 1,
          token: this.instance.token,
          clientInstanceId: randomUUID(),
          capabilities: [...RUNTIME_BRIDGE_CAPABILITIES],
        });
      });
    });
  }

  public async getSnapshot(documentTypeIds?: readonly string[]): Promise<readonly RuntimeBridgeDocumentSnapshot[]> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "getSnapshot",
      ...(documentTypeIds === undefined ? {} : { documentTypeIds: [...documentTypeIds] }),
    });
    if (response.status !== "ok" || response.documents === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Snapshot response did not carry documents.");
    }

    this.snapshotCount += 1;
    return response.documents;
  }

  public async acquireLease(): Promise<void> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "acquireLease",
    });
    if (response.status !== "ok") {
      throw new RuntimeBridgeProtocolError(response.error, "$", response.detail ?? "Lease acquisition failed.");
    }
  }

  public async releaseLease(): Promise<void> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "releaseLease",
    });
    if (response.status !== "ok") {
      throw new RuntimeBridgeProtocolError(response.error, "$", response.detail ?? "Lease release failed.");
    }
  }

  public async getDocumentSources(): Promise<readonly RuntimeBridgeDocumentSource[]> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "getDocumentSources",
    });
    if (response.status !== "ok" || response.sources === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Sources response did not carry sources.");
    }

    return response.sources;
  }

  public async getGraphExecutionInstances(documentId?: string): Promise<readonly RuntimeBridgeGraphExecutionInstance[]> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "getGraphExecutionInstances",
      ...(documentId === undefined ? {} : { documentId }),
    });
    if (response.status !== "ok" || response.executions === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Execution instances response did not carry executions.");
    }

    return response.executions;
  }

  public async subscribeGraphExecution(executionId: string): Promise<void> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "subscribeGraphExecution",
      executionId,
    });
    if (response.status !== "ok") {
      throw new RuntimeBridgeProtocolError(response.error, "$", response.detail ?? "Graph execution subscription failed.");
    }

    this.subscribedExecutionId = executionId;
  }

  public async unsubscribeGraphExecution(executionId: string): Promise<void> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "unsubscribeGraphExecution",
      executionId,
    });
    if (response.status !== "ok") {
      throw new RuntimeBridgeProtocolError(response.error, "$", response.detail ?? "Graph execution unsubscription failed.");
    }

    if (this.subscribedExecutionId === executionId) {
      this.subscribedExecutionId = undefined;
    }
  }

  public async getGraphExecutionSnapshot(executionId: string): Promise<RuntimeBridgeGraphExecutionInstance> {
    const response = await this.request({
      type: "request",
      requestId: this.nextRequestId(),
      action: "getGraphExecutionSnapshot",
      executionId,
    });
    if (response.status !== "ok" || response.execution === undefined) {
      throw new RuntimeBridgeProtocolError(
        response.status === "error" ? response.error : "runtime.invalidMessage",
        "$",
        response.status === "error" ? response.detail ?? "Graph execution snapshot failed." : "Snapshot response did not carry an execution.",
      );
    }

    return response.execution;
  }

  private nextRequestId(): string {
    return `req-${randomUUID().slice(0, 8)}`;
  }

  private request(payload: RuntimeBridgeSnapshotRequest | RuntimeBridgeLeaseRequest | RuntimeBridgeSourcesRequest | RuntimeBridgeGraphExecutionInstancesRequest | RuntimeBridgeGraphExecutionSubscriptionRequest | RuntimeBridgeGraphExecutionSnapshotRequest): Promise<RuntimeBridgeResponseMessage> {
    if (this.welcome === undefined || this.connectionError !== undefined
      || this.bridge === undefined || !this.bridge.isOpen) {
      return Promise.reject(new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected."));
    }

    const requestId = payload.requestId;
    return new Promise<RuntimeBridgeResponseMessage>((resolve, reject) => {
      let settled = false;
      const settle = (error: Error | undefined, response?: RuntimeBridgeResponseMessage): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (error === undefined && response !== undefined) resolve(response);
        else reject(error ?? new Error("Runtime bridge request failed."));
      };
      const timer = setTimeout(() => {
        settle(new Error("Runtime bridge request timed out."));
      }, 10_000);

      // 先登记等待器再写请求：任何响应都按 requestId 交给对应等待者，
      // 事件与其他请求的响应不会导致本次请求被重发。
      this.pending.set(requestId, {
        resolve: (response) => settle(undefined, response),
        reject: (error) => settle(error),
        timer,
      });
      try {
        if (!this.bridge?.sendControlJson(payload)) {
          settle(new Error("Runtime bridge write failed."));
        }
      } catch (errorValue) {
        settle(errorValue instanceof Error ? errorValue : new Error(String(errorValue)));
      }
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.invalidate(new Error("Runtime bridge connection disposed."));
    this.bridge?.close();
    this.bridge = undefined;
  }

  private handlePayload(payload: Buffer): void {
    let message: ReturnType<typeof parseRuntimeBridgeMessage>;
    try {
      message = parseRuntimeBridgeMessage(JSON.parse(payload.toString("utf8")));
    } catch (errorValue) {
      this.output(`Runtime bridge received an unparseable payload: ${(errorValue as Error).message}`);
      if (this.handshake !== undefined) this.finishHandshake(undefined, errorValue as Error);
      else this.invalidate(errorValue as Error);
      return;
    }

    if (this.handshake !== undefined) {
      if (message.type === "welcome") {
        this.welcome = message;
        this.finishHandshake(message, undefined);
      } else {
        const detail = message.type === "error" ? message.detail ?? message.code : `Expected a welcome message, received '${message.type}'.`;
        this.finishHandshake(undefined, new Error(detail));
      }

      return;
    }

    if (message.type === "response") {
      const waiter = this.pending.get(message.requestId);
      if (waiter === undefined) {
        // 超时后的迟到响应：记录后丢弃，不影响后续请求。
        this.output(`Runtime bridge dropped a response for unknown requestId '${message.requestId}'.`);
        return;
      }

      this.pending.delete(message.requestId);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    if (message.type === "error") {
      this.output(`Runtime bridge connection-level error: ${message.code}${message.detail === undefined ? "" : ` (${message.detail})`}`);
      this.rejectPending(new RuntimeBridgeProtocolError(message.code, "$", message.detail ?? "Runtime bridge reported an error."));
      return;
    }

    if (message.type === "event") {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: ReturnType<typeof parseRuntimeBridgeMessage>): void {
    if (message.type === "event") {
      this.events.push(message);
      this.onEvent(message);
    }
  }

  private finishHandshake(welcome: RuntimeBridgeWelcomeMessage | undefined, error: Error | undefined): void {
    const handshake = this.handshake;
    if (handshake === undefined) return;
    this.handshake = undefined;
    if (handshake.timer !== undefined) clearTimeout(handshake.timer);
    if (error === undefined && welcome !== undefined) {
      handshake.resolve(welcome);
      return;
    }

    this.welcome = undefined;
    this.connectionError = error ?? new Error("Runtime bridge connection failed.");
    this.rejectPending(this.connectionError);
    this.bridge?.close();
    handshake.reject(this.connectionError);
  }

  /** 连接失效：拒绝所有等待者并销毁 socket；握手后的 close/error 也走这里。 */
  private invalidate(error: Error): void {
    if (this.handshake !== undefined) {
      this.finishHandshake(undefined, error);
      return;
    }

    if (this.connectionError === undefined) this.connectionError = error;
    this.welcome = undefined;
    this.rejectPending(this.connectionError);
    this.bridge?.close();
  }

  private rejectPending(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (errorValue) {
    return (errorValue as NodeJS.ErrnoException).code === "EPERM";
  }
}
