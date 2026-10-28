import * as net from "net";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  parseRuntimeBridgeDiscoveryRecord,
  parseRuntimeBridgeMessage,
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
import { probeBridgePorts } from "./bridgeProbe";
import { BRIDGE_PROTOCOL_VERSION } from "./bridgeProtocol";
import { BridgePayloadKind } from "./framing";
import { GraphExecutionRecording } from "./graphExecutionRecording";
import { DebugChannelSession, type DebugChannel } from "./debugChannel";
import type { DebugContractSnapshot } from "./debugContractRegistry";
import type { DebugEnvelope } from "./debugIngress";
import type { DebugInstanceManager } from "./debugInstanceManager";
import type { DebugQueryConnection } from "./debugQueryClient";
import type { DebugRecordingConnectType } from "./debugRecordingFormat";
import type { DebugRecordingHost } from "./debugRecordingHost";

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
  /** 拨号方契约指纹（hello.contractHash）；未知时为空串，指纹层降级为 JSON 而已。 */
  readonly contractHash?: string;
  /**
   * 续接用的会话 id。**15 s 宽限由监听方判定**（`planReconnectGrace`，缺省 15 s）；
   * 拨号方只有在持有上一次 welcome 的 `sessionId` 时才填这个字段——生产路径目前不填，
   * 因此每次连接都是新会话，是否 `resumed` 完全由监听方按宽限与 id 匹配决定。
   */
  readonly resumeSessionId?: string;
}

/** 端口段探测连接参数（附录 A.8 的 host/portRangeStart/portRangeEnd/probeTimeoutMs/probeConcurrency）。 */
export interface RuntimeBridgeProbeOptions {
  readonly host?: string;
  /** 显式端口：只连这一个，不扩散到端口段。 */
  readonly port?: number;
  readonly portRangeStart?: number;
  readonly portRangeEnd?: number;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  /** Player 无认证时为空串（不发送 token）。 */
  readonly token: string;
  readonly kind?: "editor-play" | "player";
  readonly contractHash?: string;
  readonly resumeSessionId?: string;
}

export interface RuntimeBridgeConnectionState {
  readonly connected: boolean;
  readonly instanceId?: string;
  readonly kind?: string;
  readonly tcpPort?: number;
  readonly generation?: number;
  readonly sessionId?: string;
  readonly resumed?: boolean;
  readonly lastSnapshotCount?: number;
  readonly lastEventCount?: number;
  readonly subscribedExecutionId?: string;
  /** E9：本连接的 ch1 接收计数（没有调试会话时缺省）。 */
  readonly debugFrames?: number;
  readonly debugEnvelopes?: number;
  readonly debugInstances?: number;
}

/**
 * Runtime 腿的调试接线（E9）：把 ch1 帧接进与 Editor 腿**同一个**实例表/录制宿主。
 *
 * 缺省不提供时行为退回 E1：ch1 帧只记一条日志后丢弃。宿主（`extension.ts`）注入后，
 * Runtime 腿的 `debugCreate` / `debug` / `debugResult` 与 Editor 腿完全同路径落地。
 */
export interface RuntimeBridgeDebugWiring {
  /** 与 Editor 腿共享的实例表（两条腿的实例落在同一个面板里，方案 A）。 */
  readonly manager: DebugInstanceManager;
  /** 按 welcome 的 `contractHash` 取契约快照（决定二进制解码与方法名解析）。 */
  readonly resolveContracts?: (contractHash: string) => DebugContractSnapshot | undefined;
  /** 跨腿录制宿主；缺省 = 不录制（但帧仍然进实例表）。 */
  readonly recording?: DebugRecordingHost;
  /** 下游 ingest 抛错的隔离回调（缺省写日志）。 */
  readonly onIngestError?: (envelope: DebugEnvelope, error: unknown) => void;
}

export interface RuntimeBridgeServiceOptions {
  /** E9：注入调试接线。缺省时 Runtime 腿只保留 E1 的控制面行为。 */
  readonly debug?: RuntimeBridgeDebugWiring;
}

export class RuntimeBridgeService {
  private connection: RuntimeBridgeConnection | undefined;
  private eventListener: ((event: RuntimeBridgeEventMessage) => void) | undefined;
  private recording: GraphExecutionRecording | undefined;
  private readonly debugWiring: RuntimeBridgeDebugWiring | undefined;

  public constructor(
    private readonly output: (message: string) => void,
    options: RuntimeBridgeServiceOptions = {},
  ) {
    this.debugWiring = options.debug;
  }

  /**
   * 当前 Runtime 连接的调试会话（E9）：宿主用它把查询路由接到这条腿上。
   * 没连接/没握手时 `undefined`。
   */
  public get debugSession(): DebugChannelSession | undefined {
    return this.connection?.debugSession;
  }

  /** F6 的候选连接（Runtime 腿）：编辑器腿把它注册进 `debugQuery` 的归属解析。 */
  public get debugQueryConnections(): readonly DebugQueryConnection[] {
    const session = this.debugSession;
    return session === undefined ? [] : [session.connection];
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
    const connection = new RuntimeBridgeConnection(instance, this.output, (event) => this.handleEvent(event), this.debugWiring);
    this.connection = connection;
    try {
      const welcome = await connection.connect(timeoutMs);
      return welcome;
    } catch (errorValue) {
      this.disconnect();
      throw errorValue;
    }
  }

  /**
   * 端口段探测连接（附录 A.8）：并发 8、单口 300 ms，第一个握手成功者胜出。
   * 显式 `port` 时只连该端口。整段都没有可握手端点时抛 `runtime.noEndpoint`
   * （客户端本地错误码；禁用/端口占用/未启动不再区分）。
   */
  public async probeAndConnect(options: RuntimeBridgeProbeOptions): Promise<RuntimeBridgeWelcomeMessage> {
    this.disconnect();
    const attempts: RuntimeBridgeConnection[] = [];
    const outcome = await probeBridgePorts<{ readonly connection: RuntimeBridgeConnection; readonly welcome: RuntimeBridgeWelcomeMessage }>({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { explicitPort: options.port }),
      ...(options.port === undefined ? { portRangeStart: options.portRangeStart, portRangeEnd: options.portRangeEnd } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      attempt: async (target, timeoutMs, signal) => {
        const instance: RuntimeBridgeInstance = {
          recordPath: "",
          instanceId: target.host,
          kind: options.kind ?? "player",
          tcpPort: target.port,
          token: options.token,
          pid: 0,
          generation: 1,
          startedAt: "",
          ...(options.contractHash === undefined ? {} : { contractHash: options.contractHash }),
          ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
        };
        const connection = new RuntimeBridgeConnection(instance, this.output, (event) => this.handleEvent(event), this.debugWiring);
        attempts.push(connection);
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Probe attempt aborted.")), { once: true });
        });
        const welcome = await Promise.race([connection.connect(timeoutMs), aborted]);
        return { connection, welcome };
      },
    });

    for (const candidate of attempts) {
      if (outcome.ok && candidate === outcome.value.connection) {
        continue;
      }

      candidate.dispose();
    }

    if (!outcome.ok) {
      throw new RuntimeBridgeProtocolError(
        "runtime.noEndpoint",
        "$",
        `No runtime bridge endpoint answered the handshake on ${options.host ?? "127.0.0.1"} `
        + `(${options.port === undefined ? `${options.portRangeStart}-${options.portRangeEnd}` : String(options.port)}; `
        + `attempts=${outcome.attempts}${outcome.lastError === undefined ? "" : `; last error: ${outcome.lastError.message}`}).`,
      );
    }

    this.connection = outcome.value.connection;
    return outcome.value.welcome;
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
  private readonly clientEndpointId = `vscode-${randomUUID()}`;
  private welcome: RuntimeBridgeWelcomeMessage | undefined;
  private snapshotCount = 0;
  private subscribedExecutionId: string | undefined;
  private disposed = false;
  private connectionError: Error | undefined;
  private debugSessionValue: DebugChannelSession | undefined;
  private debugSourceId: string | undefined;

  public constructor(
    private readonly instance: RuntimeBridgeInstance,
    private readonly output: (message: string) => void,
    private readonly onEvent: (event: RuntimeBridgeEventMessage) => void,
    private readonly debugWiring: RuntimeBridgeDebugWiring | undefined = undefined,
  ) {
  }

  /** 本连接的调试会话（E9）：welcome 之后创建，断连/重连时销毁重建。 */
  public get debugSession(): DebugChannelSession | undefined {
    return this.debugSessionValue;
  }

  public get state(): RuntimeBridgeConnectionState {
    if (this.welcome === undefined || this.connectionError !== undefined) {
      return { connected: false };
    }

    const counters = this.debugSessionValue?.ingress.counters;
    return {
      connected: !this.disposed,
      instanceId: this.welcome.endpointId,
      kind: this.welcome.connectType,
      tcpPort: this.instance.tcpPort,
      generation: this.welcome.generation,
      sessionId: this.welcome.sessionId,
      resumed: this.welcome.resumed,
      lastSnapshotCount: this.snapshotCount,
      lastEventCount: this.events.length,
      ...(this.subscribedExecutionId === undefined ? {} : { subscribedExecutionId: this.subscribedExecutionId }),
      ...(counters === undefined
        ? {}
        : {
          debugFrames: counters.frames,
          debugEnvelopes: counters.envelopes,
          debugInstances: this.debugWiring?.manager.instances.length ?? 0,
        }),
    };
  }

  /**
   * Player 腿（监听 0.0.0.0、无 token）必须在用户可见处留警告：这是一条
   * 局域网内任何人都能接入的通道（附录 E.3 接受的风险）。输出通道里的警告行
   * 在连接期间持续可见，不是一闪而过的 toast。
   */
  private warnIfPlayerWithoutAuthentication(): void {
    if (this.instance.kind !== "player" || this.instance.token.length > 0) {
      return;
    }

    this.output(
      `WARNING: runtime instance '${this.welcome?.endpointId ?? this.instance.instanceId}' listens on 0.0.0.0:${this.instance.tcpPort} `
      + "without a token - 局域网内无认证，同一网络中的任何人都可以连接并读取快照。",
    );
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
          if (this.debugSessionValue === undefined) {
            // 握手完成前（或宿主未接线）收到的 ch1 帧：没有契约/实例表可落，只记日志。
            this.output(`Runtime bridge ignored a ${payload.length}-byte debug payload (kind ${payloadKind}) before the debug session was ready.`);
            return;
          }

          // E9：Runtime 腿的 ch1 帧与 Editor 腿走**同一个** DebugChannelSession 入口
          // （录制 tap → 计数/分流 → 解码 → 实例/查询结算），没有第二条旁路。
          this.debugSessionValue.acceptFrame(payloadKind, payload);
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

        // hello（附录 A.3，与 Editor 腿同形）：role 标识拨号方，resumeSessionId 请求续接。
        bridge.sendControlJson({
          type: "hello",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          role: "vscode",
          clientEndpointId: this.clientEndpointId,
          ...(this.instance.token.length === 0 ? {} : { token: this.instance.token }),
          contractHash: this.instance.contractHash ?? "",
          payloads: ["json"],
          ...(this.instance.resumeSessionId === undefined ? {} : { resumeSessionId: this.instance.resumeSessionId }),
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
    this.detachDebugSession();
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
        this.warnIfPlayerWithoutAuthentication();
        this.attachDebugSession(message);
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

  /**
   * welcome 之后建立调试会话（E9）：契约按 `welcome.contractHash` 选，发送走本连接的
   * ch1 控制队列，录制源用 `runtime-<sessionId>` 登记到跨腿录制宿主。
   *
   * Runtime 腿**不发送** `debugSetEnabled`（Runtime 服务端在 ch0 只认 hello/request，
   * 多发一条控制消息会被判连接级错误）：上报开关由 Unity 的 `DebugLinkOpened` 决定，
   * `welcome.debugEnabled` 只读。
   */
  private attachDebugSession(welcome: RuntimeBridgeWelcomeMessage): void {
    const wiring = this.debugWiring;
    if (wiring === undefined) {
      return;
    }

    this.detachDebugSession();
    const snapshot = wiring.resolveContracts?.(welcome.contractHash);
    const sourceId = `runtime-${welcome.sessionId}`;
    const recording = wiring.recording;
    const recorder = recording === undefined
      ? undefined
      : {
        recordFrame: (channel: number, payloadKind: BridgePayloadKind, payload: Buffer) => {
          recording.noteFrame(sourceId, channel, payloadKind, payload);
        },
      };
    const channel: DebugChannel = {
      origin: "runtime",
      id: welcome.sessionId,
      isOpen: () => !this.disposed && this.connectionError === undefined
        && this.bridge !== undefined && this.bridge.isOpen && this.welcome !== undefined,

      sendDebugPayload: (payload) => this.bridge !== undefined
        && this.bridge.isOpen
        && this.bridge.sendDebugControl(payload),
    };
    this.debugSessionValue = new DebugChannelSession({
      channel,
      manager: wiring.manager,
      ...(snapshot === undefined ? {} : { contracts: snapshot }),
      ...(recorder === undefined ? {} : { recorder }),
      log: (message) => this.output(message),
      ...(wiring.onIngestError === undefined ? {} : { onIngestError: wiring.onIngestError }),
    });
    this.debugSourceId = sourceId;
    if (recording !== undefined) {
      const connectType: DebugRecordingConnectType = welcome.connectType === "player" ? "player" : "editor-player";
      recording.registerSource({
        id: sourceId,
        origin: "runtime",
        connectType,
        sessionId: welcome.sessionId,
        endpointId: welcome.endpointId,
        bootId: welcome.bootId,
        contractHash: welcome.contractHash,
        contracts: snapshot,
        isOpen: () => !this.disposed && this.connectionError === undefined && this.bridge !== undefined && this.bridge.isOpen,
      });
    }
    this.output(
      `Runtime bridge debug channel attached session=${welcome.sessionId} contract=${welcome.contractHash || "(none)"} debugEnabled=${welcome.debugEnabled}`,
    );
  }

  /** 销毁本连接的调试会话并注销录制源（重连/断连/释放都必须走这里，避免状态泄漏）。 */
  private detachDebugSession(): void {
    const sourceId = this.debugSourceId;
    this.debugSourceId = undefined;
    if (sourceId !== undefined) {
      this.debugWiring?.recording?.unregisterSource(sourceId);
    }

    this.debugSessionValue?.dispose("disconnect");
    this.debugSessionValue = undefined;
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
    this.detachDebugSession();
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
