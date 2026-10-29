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
  RuntimeBridgeLeaseRequest,
  RuntimeBridgeResponseMessage,
  RuntimeBridgeSourcesRequest,
  RuntimeBridgeEventMessage,
  RuntimeBridgeProtocolError,
  RuntimeBridgeSnapshotRequest,
  RuntimeBridgeWelcomeMessage,
} from "./runtimeBridgeProtocol";
import { BridgeSocket } from "./bridgeSocket";
import { probeBridgePorts } from "./bridgeProbe";
import { BRIDGE_PROTOCOL_VERSION } from "./bridgeProtocol";
import { BridgePayloadKind } from "./framing";
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
  /** E9：本连接的 ch1 接收计数（没有调试会话时缺省）。 */
  readonly debugFrames?: number;
  readonly debugEnvelopes?: number;
  readonly debugInstances?: number;
  /**
   * F8-§8-6 的可解释等式两侧（与 `debugFrames` 同一快照）：
   * `debugFrames === debugDataFrames + debugControlFrames`——ingress 收下的每一帧都恰好解出
   * 一条包络，且只属于一侧：
   * - 数据类 = **只有** `debug`（数据通道上唯一会产出时间轴记录的入站类型）；
   * - 控制类 = `debugCreate`、`debugFinish`、`debugFrame`、`debugResult`、`response`
   *   （结果与应答虽走数据通道，却不进事件流，交给查询客户端结算——C.1）。
   * 等式不成立 = 有帧被静默丢掉（畸形/超长帧），"至少一条记录"这类弱断言看不出来。
   */
  readonly debugDataFrames?: number;
  readonly debugControlFrames?: number;
  /**
   * F8-§8-6：`ingest` 真正落进时间轴的记录数（`storedRecords <= debugDataFrames`：记录先于
   * Create 会先暂存）。**不含** `queryResult`：查询结果记录由 `DebugQueryClient` 直接追加。
   */
  readonly debugStoredRecords?: number;
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
  private readonly debugWiring: RuntimeBridgeDebugWiring | undefined;
  /** 当前连接对应的 welcome 与实例（探测复用已有连接时原样返回，不再重建一条连接）。 */
  private connectedInstance: RuntimeBridgeInstance | undefined;
  private connectedWelcome: RuntimeBridgeWelcomeMessage | undefined;

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
      this.connectedInstance = instance;
      this.connectedWelcome = welcome;
      return welcome;
    } catch (errorValue) {
      this.disconnect();
      throw errorValue;
    }
  }

  /**
   * 端口段探测连接（附录 A.8）：并发 8、单口 300 ms。
   *
   * **E11 §1：探活不建调试 link。** 探测分成两步：
   * 1. **端口探活**：对候选端口只做 TCP 连接后立即关闭，**不发 hello**。Unity 侧的
   *    `DebugLinkOpened` 只在握手成功（welcome 已写）之后才触发，所以这一步**不会**产生
   *    `debug link stacked/closed`，也就不会 `Bind`/`Detach` 掉正在跑的调试会话。
   *    整段都没有可连端口时直接抛 `runtime.noEndpoint`，**不动**现有连接（旧实现先 `disconnect()`
   *    再探测，一次失败的探测会顺手掐掉面板的健康连接）。
   * 2. **唯一一条真连接**：对可连端口（按端口号）逐个做一次完整握手，第一个成功者被采纳。
   *    落选端口不会再建链，因此不会出现"探测建立了一条 link 又立刻关闭"。
   *
   * 如果现有连接已经指向同一端点且 token 一致，直接复用（返回原 welcome）：探测不产生任何新连接。
   * 显式 `port` 时只探该端口。
   */
  public async probeAndConnect(options: RuntimeBridgeProbeOptions): Promise<RuntimeBridgeWelcomeMessage> {
    const host = options.host ?? "127.0.0.1";
    const timeoutMs = options.timeoutMs ?? 300;

    // 已经连着同一端点且 token 一致：直接复用（返回原 welcome）。探测连一次 TCP 都不做，
    // 是对"探测不得影响会话"最强的保证。
    const reused = this.reusableProbeConnection(options);
    if (reused !== undefined) {
      this.output(`[runtime-probe] already attached to the live endpoint on port ${this.connectedInstance?.tcpPort ?? -1}; reusing it.`);
      return reused;
    }

    const alivePorts: number[] = [];
    const liveness = await probeBridgePorts<number>({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { explicitPort: options.port }),
      ...(options.port === undefined ? { portRangeStart: options.portRangeStart, portRangeEnd: options.portRangeEnd } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      // 探活要"可连端口的全集"：第一个可连的端口不一定是 VisualBridge 端点（同段里可能还有别的服务）。
      stopOnFirstSuccess: false,
      attempt: async (target, attemptTimeoutMs, signal) => {
        await probeTcpLiveness(target.host, target.port, attemptTimeoutMs, signal);
        alivePorts.push(target.port);
        return target.port;
      },
    });

    const portRangeText = options.port === undefined
      ? `${options.portRangeStart}-${options.portRangeEnd}`
      : String(options.port);
    this.output(
      `[runtime-probe] TCP liveness only on ${host}:${portRangeText}; `
      + `${alivePorts.length} port(s) answered (attempts=${liveness.attempts}); no debug link was created.`,
    );

    if (!liveness.ok) {
      throw new RuntimeBridgeProtocolError(
        "runtime.noEndpoint",
        "$",
        `No runtime bridge endpoint answered the handshake on ${host} (${portRangeText}; `
        + `attempts=${liveness.attempts}${liveness.lastError === undefined ? "" : `; last error: ${liveness.lastError.message}`}).`,
      );
    }

    if (alivePorts.length === 0) {
      throw new RuntimeBridgeProtocolError(
        "runtime.noEndpoint",
        "$",
        `No runtime bridge endpoint answered the handshake on ${host} (${portRangeText}; `
        + `attempts=${liveness.attempts}).`,
      );
    }

    alivePorts.sort((left, right) => left - right);

    // 已连接端点的 token 与本次探测不同 ⇒ 这个端口一定拒绝本次 hello（服务端逐字比较 token），
    // 它不再是"可握手候选"。剔除后没有候选就直接报错，**不碰现有连接**：探测不得影响会话。
    const connectedPort = this.connection !== undefined && this.connection.state.connected === true
      && this.connectedInstance !== undefined
      ? this.connectedInstance.tcpPort
      : undefined;
    const authenticatedMismatch = connectedPort !== undefined
      && this.connectedInstance !== undefined
      && this.connectedInstance.token.length > 0
      && this.connectedInstance.token !== options.token
      ? connectedPort
      : undefined;
    const candidates = authenticatedMismatch === undefined
      ? alivePorts
      : alivePorts.filter((port) => port !== authenticatedMismatch);

    if (candidates.length === 0) {
      throw new RuntimeBridgeProtocolError(
        "runtime.noEndpoint",
        "$",
        `No runtime bridge endpoint answered the handshake on ${host} (${portRangeText}; `
        + `attempts=${liveness.attempts}; last error: the only live endpoint is already attached with a different token).`,
      );
    }

    // 探活阶段的 TCP 连接**不发 hello**，它们不会变成 debug link；但下面的候选会真的握手：
    // 成功的那条被采纳，失败的候选留下一条"只连过、没握手"的短连接（不 Bind、不进会话）。
    // 先释放旧连接：新连接若在旧连接仍绑定时 `Bind`，传输层会把它压栈（代次不变），
    // 会话层看不到换代 ⇒ 不会重置也不会重放槽位，活动 wire 上没有已存在实例的槽位。
    // **已知代价（刻意取舍）**：若所有候选的 handshake 都失败，旧连接也已经断开；旧实现
    // 无论如何都会先断开，这里没有更差，但也不承诺"换链失败仍保留旧连接"。
    this.disconnect();

    const lastErrors: string[] = [];
    for (const port of candidates) {
      const instance: RuntimeBridgeInstance = {
        recordPath: "",
        instanceId: host,
        kind: options.kind ?? "player",
        tcpPort: port,
        token: options.token,
        pid: 0,
        generation: 1,
        startedAt: "",
        ...(options.contractHash === undefined ? {} : { contractHash: options.contractHash }),
        ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
      };
      const connection = new RuntimeBridgeConnection(instance, this.output, (event) => this.handleEvent(event), this.debugWiring);
      try {
        const welcome = await connection.connect(timeoutMs);
        this.connection = connection;
        this.connectedInstance = instance;
        this.connectedWelcome = welcome;
        return welcome;
      } catch (errorValue) {
        connection.dispose();
        lastErrors.push(`${port}: ${(errorValue as Error).message}`);
      }
    }

    throw new RuntimeBridgeProtocolError(
      "runtime.noEndpoint",
      "$",
      `No runtime bridge endpoint answered the handshake on ${host} (${portRangeText}; `
      + `attempts=${liveness.attempts}`
      + `${lastErrors.length === 0 ? "" : `; last error: ${lastErrors[lastErrors.length - 1]}`}).`,
    );
  }

  /**
   * 探测复用判定：现有连接已经指向本次探测范围内的同一端点，且 token 一致 ⇒ 直接返回原 welcome。
   * 复用不改变会话（不 Disconnect / 不重连 / 连探活都不做），是"探测不得影响会话"的最强形态。
   * `RuntimeBridgeConnection.connect` 固定拨 127.0.0.1，所以非本机 host 不复用。
   */
  private reusableProbeConnection(options: RuntimeBridgeProbeOptions): RuntimeBridgeWelcomeMessage | undefined {
    const instance = this.connectedInstance;
    const welcome = this.connectedWelcome;
    if (instance === undefined || welcome === undefined || this.connection === undefined) {
      return undefined;
    }

    if (this.connection.state.connected !== true || (options.host ?? "127.0.0.1") !== "127.0.0.1") {
      return undefined;
    }

    if (instance.token !== options.token) {
      return undefined;
    }

    const inRange = options.port !== undefined
      ? instance.tcpPort === options.port
      : options.portRangeStart !== undefined
        && options.portRangeEnd !== undefined
        && instance.tcpPort >= options.portRangeStart
        && instance.tcpPort <= options.portRangeEnd;
    return inRange ? welcome : undefined;
  }

  public disconnect(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.connectedInstance = undefined;
    this.connectedWelcome = undefined;
  }



  public setEventListener(listener: ((event: RuntimeBridgeEventMessage) => void) | undefined): void {
    this.eventListener = listener === undefined ? undefined : listener;
  }

  private handleEvent(event: RuntimeBridgeEventMessage): void {
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
      ...(counters === undefined
        ? {}
        : {
          debugFrames: counters.frames,
          debugEnvelopes: counters.envelopes,
          debugInstances: this.debugWiring?.manager.instances.length ?? 0,
          // F8-§8-6：可解释等式 `frames = controlEnvelopes + dataEnvelopes` 需要两侧的来源计数，
          // 外加"真正落进时间轴的记录数"（`storedRecords <= dataEnvelopes`）。
          // 三者取自同一次 `DebugChannelSession.recordCounters`，因此可以在同一快照里做等式断言，
          // 而不是"至少 1 条"这种弱断言。
          ...(this.debugSessionValue === undefined
            ? {}
            : {
              debugDataFrames: this.debugSessionValue.recordCounters.dataEnvelopes,
              debugControlFrames: this.debugSessionValue.recordCounters.controlEnvelopes,
              debugStoredRecords: this.debugSessionValue.recordCounters.storedRecords,
            }),
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
        onControlPayload: (payload) => {
          // **已知差异（F8-§8-5）**：Editor 腿在控制载荷入口先调录制 tap（录 ch0），再解业务消息；
          // Runtime 腿这里是 VS Code **拨号方**，ch0 只有 hello/welcome/ping/pong 这类握手保活，
          // 没有 Unity→VS Code 的调试控制帧（`debugCreate`/`debugFinish`/`debugFrame` 都走 ch1，
          // 由下面 `onDebugFrame` 录）。所以 Runtime 腿的录制文件里没有 ch0 帧：
          // - 不会丢调试信息（调试控制帧本来就在 ch1）；
          // - 回看时 `controlFrames=0`，帧分组靠录制头里的 `connectType`（`editor` vs `runtime`）区分来源腿，
          //   面板的"来源"列直接显示它（§8-2/§8-4）。
          // 不在这里硬凑一条 ch0 录制旁路：那会把握手帧写进数据面，反而污染回看。
          this.handlePayload(payload);
        },
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

  private nextRequestId(): string {
    return `req-${randomUUID().slice(0, 8)}`;
  }

  private request(payload: RuntimeBridgeSnapshotRequest | RuntimeBridgeLeaseRequest | RuntimeBridgeSourcesRequest): Promise<RuntimeBridgeResponseMessage> {
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

/**
 * 端口探活（E11 §1）：只建立 TCP 连接再立即关闭，**一个字节都不写**。
 *
 * Unity 侧在 `AcceptTcpClient` 后就创建了 link 对象，但 `DebugLinkOpened`（宿主 `Bind`/`Attach`
 * 的唯一入口）只在**握手成功、welcome 已写**之后触发；未握手的连接关闭时 `Closed` 事件没有订阅者。
 * 因此探活对调试会话是完全透明的：不产生 stacked/closed，不 Bind，不 Detach。
 */
function probeTcpLiveness(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const socket = net.connect({ host, port });
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onAbort = (): void => finish(new Error(`TCP liveness probe of ${host}:${port} was aborted.`));
    timer = setTimeout(
      () => finish(new Error(`TCP liveness probe of ${host}:${port} timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}
