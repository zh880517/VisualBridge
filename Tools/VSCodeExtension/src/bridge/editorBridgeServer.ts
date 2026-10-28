import * as crypto from "node:crypto";
import * as net from "node:net";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceDocumentIndex } from "../document/workspaceDocumentIndex";
import {
  BRIDGE_CONTRACT_SCHEMA_VERSION,
  BRIDGE_DISCOVERY_DIRECTORY_NAME,
  BRIDGE_DISCOVERY_FORMAT_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  evaluateHello,
  isBridgeErrorCode,
  negotiatePayloads,
  parseBridgeMessage,
  requireBoolean,
  requireOnlyKeys,
  selectBridgeContractHash,
  type BridgeDiscoveryRecord,
  type BridgeErrorCode,
  type BridgeMessage,
  type BridgeWelcomeMessage,
} from "./bridgeProtocol";
import {
  assertDiscoveryRecordRoundTrips,
  touchDiscoveryRecord,
  writeDiscoveryRecordAtomically,
} from "./bridgeDiscovery";
import { BridgeSocket } from "./bridgeSocket";
import { planReconnectGrace, type ReconnectGraceDecision } from "./reconnectGrace";
import {
  EditorBridgeConnectionGate,
  EditorBridgeConnectionSlot,
} from "./editorBridgeConnections";
import { BridgeChannel, BridgePayloadKind } from "./framing";
import {
  DEBUG_CONTRACT_DIRECTORIES_SETTING,
  DebugContractRegistry,
  type DebugContractSnapshot,
  type DebugContractSnapshotSet,
} from "./debugContractRegistry";
import type { DebugFrameRecorder } from "./debugIngress";
import { DebugInstanceManager, type DebugInstanceView } from "./debugInstanceManager";
import {
  debugQueryAvailability,
  debugQueryLocalError,
  resolveDebugQueryClient,
  type DebugQueryClient,
  type DebugQueryConnection,
  type DebugQueryNotice,
  type DebugQueryResult,
} from "./debugQueryClient";
import { DebugChannelSession, type DebugChannel } from "./debugChannel";
import {
  DebugRecordingHost,
  type DebugRecordingSource,
  type EditorBridgeRecordingOptions,
  type EditorBridgeRecordingState,
} from "./debugRecordingHost";
import type { DebugRecordingFooter, DebugRecordingHeader, DebugRecordingEndReason } from "./debugRecordingFormat";
import type { DebugArg } from "./debugMessages";

export const OPEN_DOCUMENT_COMMAND = "visualbridge.openDocument";
export const REVEAL_REFERENCE_COMMAND = "visualbridge.revealReference";

export interface EditorBridgeServerState {
  readonly discoveryDirectory: string;
  readonly recordPath: string;
  readonly windowId: string;
  readonly role: "vscode";
  readonly sessionId: string;
  readonly bootId: string;
  /** 本窗口发布的契约指纹：唯一契约时就是它，多工程时取排序首个；无契约时为空串。 */
  readonly contractHash: string;
  readonly tcpPort: number;
  readonly token: string;
  readonly generation: number;
  readonly projectRoots: readonly string[];
}

/** 契约注册表注入点：测试与宿主可以替换它，服务端只依赖这两个读操作。 */
export interface EditorBridgeContractSource {
  readonly current: DebugContractSnapshotSet;
  load(options: {
    readonly projectRoots: readonly string[];
    readonly supplementalDirectories?: readonly string[];
  }): Promise<DebugContractSnapshotSet>;
}

export interface EditorBridgeServerOptions {
  /** 契约注册表（F1 注入点）；缺省按 Project 根 + 工作区设置自行加载。 */
  readonly contracts?: EditorBridgeContractSource;
  /** 关掉默认的契约自动加载（测试注入固定快照时用）。 */
  readonly autoLoadContracts?: boolean;
  /** 重连宽限期覆盖（附录 A.8 的 `ReconnectGraceMs`）；缺省 15 s。 */
  readonly reconnectGraceMs?: number;
  /** 当前时刻（epoch ms）注入点；缺省 `Date.now`，测试用假时钟验证 14.9 s / 15.1 s 边界。 */
  readonly now?: () => number;
  /**
   * 跨腿录制宿主（E9）：宿主把它同时交给 Runtime 腿，录制才能覆盖两条腿。
   * 缺省（单测直接 new 服务端）时自建一个，行为与 F5 相同。
   */
  readonly recordingHost?: DebugRecordingHost;
}

type BridgeConnection = EditorBridgeConnectionSlot<BridgeSocket>;

/**
 * 调试上报开关的可观测状态（附录 A.2 的通道 0 控制消息 / C.7）。
 *
 * `enabled` 是 welcome 通告值的唯一真源；`available` 表示现在有没有可接收 `debugSetEnabled`
 * 的已握手连接（没有时面板必须按"请求发不出去"回滚）；`connectType` 来自 A.3，
 * `player` 只可能出现在 Runtime 腿。
 */
export interface EditorBridgeDebugReporting {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly connectType: "editor" | "editor-player" | "player";
  readonly endpointId: string | undefined;
  readonly target: string | undefined;
}

/** 调试面变化的原因：`broadcast` = Unity 的 `debugEnabled` 应答；`connection` = 握手/断开。 */
export type EditorBridgeDebugReportingReason = "connection" | "broadcast";

/**
 * 会话录制的状态/入参（F5）现在由跨腿宿主 {@link DebugRecordingHost} 定义；
 * 这里转出以保持既有导入路径不变（E9）。
 */
export type { EditorBridgeRecordingOptions, EditorBridgeRecordingState } from "./debugRecordingHost";

/** 一条连接绑定的调试面状态：指纹决定契约快照，快照决定二进制解码。 */
interface EditorBridgeDebugBinding {
  snapshot: DebugContractSnapshot | undefined;
  /**
   * 本连接的解码/查询会话（F1/F6）：`DebugIngress` 的挂起表、槽位表与 `DebugQueryClient`
   * 都按连接隔离；E9 起 Editor 腿与 Runtime 腿共用同一套 {@link DebugChannelSession}。
   */
  session: DebugChannelSession | undefined;
}

/** 面板查询入口的状态快照（F6）：`available` = **该实例所属连接**的查询客户端已就绪。 */
export interface EditorBridgeDebugQueryState {
  readonly available: boolean;
  readonly pending: number;
  /** 在途上限（C.1 的 8）。 */
  readonly limit: number;
  /** 在途已满：UI 应置灰按钮并提示，而不是发一条必然失败的请求。 */
  readonly busy: boolean;
  readonly notice: DebugQueryNotice | undefined;
}

/**
 * 本地 Editor Bridge 监听方（VS Code Extension Host）。
 *
 * 连接层为统一协议的 6 字节帧（控制通道承载 JSON）。本类负责：
 * - 发布发现记录 v2（原子写 + mtime 心跳），供 Unity Editor 拨号；
 * - 编辑器模式的 hello/welcome 握手（方向层、连接层、token、一对一、载荷协商）；
 * - open/reveal 请求的路由与应答（通道 0；通道 1 只属于调试数据面）。
 *
 * 指纹不一致时保留连接，只把 welcome.payloads 收敛为 ["json"]，并把两侧 hash
 * 写进日志与 UI 状态。监听方指纹来自 {@link DebugContractRegistry}：按 Project 根各自
 * 推导 Unity 的 `ArtifactsRoot` 约定路径，第二个来源是 `visualbridge.debug.contractDirectories`
 * （附录 C.8）。契约产物变化（热更新）后重新加载快照，已握手的连接继续用旧快照（不回溯）。
 *
 * 通道 1 的调试载荷交给该连接绑定的 {@link DebugIngress}：帧校验失败只计数不断连
 * （A.1 的断开由连接层负责），解码落地为 `DebugEnvelope`（C.1）。F2 接上存储与路由。
 *
 * 重连语义（附录 A.3/A.6/A.8）：端点同一时刻只接纳一条**已完成握手且仍然存活**的连接
 * （`runtime.alreadyConnected`）；"存活"按传输层的同步可观测状态判定，不等异步
 * `close` 事件。对端断开或本端关闭后，下一条连接立即取得槽位。`resumed` 由
 * "`resumeSessionId === sessionId` **且** 距上次断开不超过 15 s" 共同决定；宽限到期后
 * 换发新的 `bootId`/`sessionId`（旧会话不再续接），`generation` 每次传输 +1（不参与 `sessionId`）。
 */
export class EditorBridgeServer implements vscode.Disposable {
  private readonly projects: ProjectRegistry;
  private readonly documents: WorkspaceDocumentIndex;
  private readonly output: vscode.LogOutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  // 一对一槽位由连接门同步维护（建立/关闭路径都释放，不依赖异步 close 事件）。
  private readonly connections = new EditorBridgeConnectionGate<BridgeSocket>();

  private tcpServer: net.Server | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private recordPath: string | undefined;
  private windowId: string | undefined;
  private token: string | undefined;
  private tcpPort: number | undefined;
  private bootId = "";
  private sessionId = "";
  private generation = 0;
  private readonly startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  private readonly contracts: EditorBridgeContractSource;
  private readonly autoLoadContracts: boolean;
  private readonly reconnectGraceMs: number | undefined;
  private readonly now: () => number;
  /** 上一次连接被观察到的断开时刻（epoch ms）；宽限判定的起点。 */
  private lastDisconnectedAtMs: number | undefined;
  private readonly debugBindings = new WeakMap<BridgeConnection, EditorBridgeDebugBinding>();
  /** 调试实例存储与路由：一个窗口（会话）一份，记录与实例在重连宽限内保留（C.3）。 */
  private readonly debugManager: DebugInstanceManager;
  /**
   * 调试上报总开关（附录 A.2 的通道 0 控制消息 / C.7）：**唯一**真源。
   *
   * 两个方向共用一个值：`welcome.debugEnabled` 通告它；`debugSetEnabled` 请求 Unity 切换，
   * Unity 用 `debugEnabled` 广播回报结果后这里才更新。面板不做本地乐观更新，
   * 因此这个字段只由「握手时通告」与「广播到达」两处改写。
   */
  private debugReportingEnabled = true;
  /** 最近一次完成握手的拨号方 endpoint（状态栏的 `endpointId`，C.7）。 */
  private lastClientEndpointId: string | undefined;
  private readonly debugReportingListeners = new Set<(reason: EditorBridgeDebugReportingReason) => void>();
  /** 下游 ingest 抛错被隔离的次数（坏记录不得拖垮整帧）。 */
  private debugIngestErrors = 0;
  /**
   * 跨腿录制宿主（E9）：状态机与文件写入都在这里，`startRecording`/`stopRecording` 只是转发。
   * 当前录制**只绑定一个源**（P1-B），源可以是 Editor 腿或 Runtime 腿的连接。
   */
  private readonly recordingHost: DebugRecordingHost;
  /** 每条连接的录制 tap（在 `accept` 建立，稳定对象；只有录制源的帧会进文件）。 */
  private readonly debugRecordTaps = new WeakMap<BridgeConnection, DebugFrameRecorder>();
  /** 每条已握手连接的录制源 id（`accept` 分配，握手后注册到 {@link recordingHost}）。 */
  private readonly debugRecordSourceIds = new WeakMap<BridgeConnection, string>();
  /** 外部腿（当前是 Runtime 桥）提供的查询连接：只增删，不改变 F6 的归属判定。 */
  private readonly externalDebugQuerySources = new Set<() => readonly DebugQueryConnection[]>();
  /** 连接序号：录制源 id 的唯一来源（一条连接一个，不复用）。 */
  private connectionSequence = 0;
  private contractRefreshTimer: NodeJS.Timeout | undefined;
  private contractRefreshing: Promise<void> | undefined;

  public constructor(
    projects: ProjectRegistry,
    documents: WorkspaceDocumentIndex,
    output: vscode.LogOutputChannel,
    options: EditorBridgeServerOptions = {},
  ) {
    this.projects = projects;
    this.documents = documents;
    this.output = output;
    this.contracts = options.contracts ?? new DebugContractRegistry();
    this.autoLoadContracts = options.autoLoadContracts ?? options.contracts === undefined;
    this.reconnectGraceMs = options.reconnectGraceMs;
    this.now = options.now ?? Date.now;
    this.recordingHost = options.recordingHost ?? new DebugRecordingHost({
      now: this.now,
      log: (message) => this.output.appendLine(message),
    });
    this.debugManager = new DebugInstanceManager({
      now: this.now,
      log: (message) => this.output.appendLine(message),
    });
  }

  /** 调试实例存储与路由（F3 面板 / F4 facet 从这里接）。 */
  public get debug(): DebugInstanceManager {
    return this.debugManager;
  }

  /** 当前契约快照集合（E9：Runtime 腿按 welcome 的 `contractHash` 从这里取快照）。 */
  public get contractSnapshots(): DebugContractSnapshotSet {
    return this.contracts.current;
  }

  /**
   * 调试上报开关的可观测状态（F3 面板的唯一来源，附录 C.7）。
   *
   * `connectType` 是 A.3 的监听方拓扑：编辑器腿恒为 `editor`；`player` 只可能来自 Runtime 腿
   * （E5 那条链），面板据它把开关置灰。
   */
  public get debugReporting(): EditorBridgeDebugReporting {
    const active = this.connections.snapshot().some((connection) => connection.helloCompleted && !connection.isTerminated);
    return {
      enabled: this.debugReportingEnabled,
      available: active,
      connectType: "editor",
      endpointId: active ? this.lastClientEndpointId : undefined,
      target: this.tcpPort === undefined ? undefined : `127.0.0.1:${this.tcpPort}`,
    };
  }

  /**
   * 调试面状态变化。`reason` 区分两种语义，面板的处置完全不同：
   * - `broadcast`：Unity 回报的 `debugEnabled`（A.2 的通道 0 控制消息），是服务端应答；
   * - `connection`：握手/断开，所谓值来自 `welcome.debugEnabled`（初值/重连）。
   */
  public onDidChangeDebugReporting(listener: (reason: EditorBridgeDebugReportingReason) => void): vscode.Disposable {
    this.debugReportingListeners.add(listener);
    return { dispose: () => this.debugReportingListeners.delete(listener) };
  }

  /**
   * 发送 `debugSetEnabled`（附录 A.2 的通道 0 控制消息，契约见
   * `Protocol/Schema/visualbridge-editor-bridge.schema.json` 的 `debugSetEnabledMessage`）。
   *
   * **不**等应答也不改本地值：返回值只表示"请求是否发出去了"。服务端结果由 `debugEnabled`
   * 广播回来（{@link EditorBridgeServer.acceptDebugEnabledBroadcast}），面板据此重绘。
   */
  public requestDebugReportingEnabled(enabled: boolean): boolean {
    const connection = this.connections.snapshot().find((candidate) => candidate.helloCompleted && !candidate.isTerminated);
    if (connection === undefined) {
      return false;
    }

    return connection.transport.sendControlJson({ type: "debugSetEnabled", enabled });
  }

  /**
   * 已握手、未终止、查询客户端已就绪的连接（F6 的候选集）。
   *
   * `owns` 直接读该连接**已有的**槽位绑定（`DebugIngress.slotRegistry`），把实例视图里的
   * `instanceSlot/category/instanceId` 与它比对——**不新造**"实例 → 连接"映射。
   */
  private activeDebugQueryConnections(): readonly DebugQueryConnection[] {
    const candidates: DebugQueryConnection[] = [];
    for (const connection of this.connections.snapshot()) {
      if (!connection.helloCompleted || connection.isTerminated) {
        continue;
      }

      const session = this.debugBindings.get(connection)?.session;
      if (session === undefined) {
        continue;
      }

      candidates.push(session.connection);
    }

    // 另一条腿（Runtime 桥）的连接同样参与归属解析：实例在哪条腿上，查询就发到哪条腿。
    for (const source of this.externalDebugQuerySources) {
      try {
        candidates.push(...source());
      } catch (errorValue) {
        this.output.appendLine(`[debug] external debug query source failed: ${String(errorValue)}`);
      }
    }

    return candidates;
  }

  /**
   * 按**实例**解析所属连接的查询客户端（F6 收敛轮 P2-3）。
   *
   * 旧实现取"首个已握手连接"，多 Unity 连接时会把查询发到错误连接（服务端回
   * `runtime.instanceNotFound`），`available` / `busy` 也不按实例算。现在：
   * - 唯一归属 → 该连接；多个归属或没有任何存活连接持有它 → `unresolved`（**不猜**，
   *   即使只剩一条连接也不回退：实例的原连接可能已断）；
   * - 没有已握手连接 → `notConnected`；实例键查不到 → `instanceNotFound`；实例已结束 → `instanceFinished`。
   */
  private resolveDebugQueryRoute(instanceKey: string | undefined):
    | {
      readonly status: "ready";
      readonly queries: DebugQueryClient;
      readonly view: DebugInstanceView | undefined;
      /** 该实例所属腿的当前帧（E9）；缺省回退到共享的实例表当前帧。 */
      readonly frame: (() => number) | undefined;
    }
    | { readonly status: "notConnected" }
    | { readonly status: "instanceNotFound" }
    | { readonly status: "instanceFinished" }
    | { readonly status: "unresolved" } {
    const connections = this.activeDebugQueryConnections();
    if (connections.length === 0) {
      return { status: "notConnected" };
    }

    const view = instanceKey === undefined ? undefined : this.debugManager.instance(instanceKey);
    if (instanceKey !== undefined && view === undefined) {
      return { status: "instanceNotFound" };
    }

    if (view !== undefined && !view.active) {
      // 实例已结束：给"实例已结束"的明确文案，不落到"连接无法确定"。
      return { status: "instanceFinished" };
    }

    const route = resolveDebugQueryClient(view, connections);
    return route.status === "ready"
      ? { status: "ready", queries: route.client, view, frame: route.frame }
      : { status: "unresolved" };
  }

  /**
   * 面板查询入口的状态（F6）：在途条数 / 上限 / 最近提示。
   *
   * 传入实例键时**只反映该实例所属连接**（多连接不混算 pending/busy/available）；
   * 缺省（面板还没选中实例）取第一条已就绪连接。无连接/无法归属时 `available=false`，
   * 面板据此置灰按钮（不是发一条必然失败的请求）。
   */
  public debugQueryState(instanceKey?: string): EditorBridgeDebugQueryState {
    if (instanceKey === undefined) {
      const [first] = this.activeDebugQueryConnections();
      return debugQueryAvailability(first?.client);
    }

    const route = this.resolveDebugQueryRoute(instanceKey);
    return debugQueryAvailability(route.status === "ready" ? route.queries : undefined);
  }

  /**
   * 发起一次调试查询（附录 C.1）：结果以 `kind: "queryResult"` 记录插入时间轴，
   * `frame` 固定为**发起时**的当前帧（P1）。失败 reject `DebugQueryError`，**不重试**。
   *
   * 路由按实例所属连接；多连接无法确定归属时回 `local.noConnection`（不猜、不发错连接）。
   */
  public queryDebug(
    instanceKey: string,
    interfaceId: string,
    method: string,
    args: readonly DebugArg[] = [],
    options: { readonly methodId?: number } = {},
  ): Promise<DebugQueryResult> {
    const route = this.resolveDebugQueryRoute(instanceKey);
    switch (route.status) {
      case "notConnected":
        return Promise.reject(debugQueryLocalError("local.notConnected"));
      case "instanceNotFound":
        return Promise.reject(debugQueryLocalError("local.instanceNotFound"));
      case "instanceFinished":
        // 实例可能在结果前 `Finish`（验收 P1）：明确提示已结束，不重试、不发请求。
        return Promise.reject(debugQueryLocalError("local.instanceFinished"));
      case "unresolved":
        return Promise.reject(debugQueryLocalError("local.noConnection"));
      default:
        // 帧号取**实例所属腿**自己的当前帧（E9）：两条腿并行时，用共享实例表的帧号会把结果
        // 盖到另一条腿的时间轴上（F6 的 P1）。单腿时两者相同。
        return route.queries.query(instanceKey, interfaceId, method, args, {
          frame: route.frame?.() ?? this.debugManager.currentFrame,
          ...(options.methodId === undefined ? {} : { methodId: options.methodId }),
        });
    }
  }

  /** 面板桥接用的查询面（`DebugPanelBridge.debugQuery`）；与上面的方法一一对应。 */
  public get debugQuery(): {
    state(instanceKey?: string): EditorBridgeDebugQueryState;
    query(instanceKey: string, interfaceId: string, method: string, options?: { readonly methodId?: number }): Promise<DebugQueryResult>;
    cancelInstance(instanceKey: string, reason?: "user" | "disconnect"): number;
  } {
    return {
      state: (instanceKey?: string) => this.debugQueryState(instanceKey),
      query: (instanceKey, interfaceId, method, options = {}) => this.queryDebug(instanceKey, interfaceId, method, [], options),
      cancelInstance: (instanceKey, reason = "user") => this.cancelDebugQueries(instanceKey, reason),
    };
  }

  /**
   * 取消某实例的在途查询（面板切换实例时用）：按实例键找到实例 id，再交给**它所属连接**的客户端。
   * 返回取消条数；没有连接/实例无法归属时返回 0（幂等）。
   */
  public cancelDebugQueries(instanceKey: string, reason: "user" | "disconnect" = "user"): number {
    const route = this.resolveDebugQueryRoute(instanceKey);
    if (route.status !== "ready" || route.view === undefined) {
      return 0;
    }

    return route.queries.cancelInstance(route.view.instanceId, reason).length;
  }

  /**
   * 收下 Unity 的 `debugEnabled` 广播（附录 A.2 的通道 0 控制消息）：`{ type: "debugEnabled", enabled: boolean }`。
   *
   * 返回是否认领了这条消息。形状按 schema 严格校验（`additionalProperties:false` + `enabled` 必填布尔）：
   * 缺字段/类型错/多余键都会抛 `BridgeProtocolError`，由调用方统一 `sendErrorAndClose`。
   * 解析器已把 `debugEnabled` 纳入 `BridgeMessage` 联合，这里的二次校验只作纵深防御，
   * 保证该函数独立调用时也不会"看到 type 对就放行"。
   */
  private acceptDebugEnabledBroadcast(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (record.type !== "debugEnabled") {
      return false;
    }

    requireOnlyKeys(record, "$", ["type", "enabled"]);
    const enabled = requireBoolean(record, "enabled", "$.enabled");

    if (enabled !== this.debugReportingEnabled) {
      this.debugReportingEnabled = enabled;
      this.output.appendLine(`[debug] debugEnabled broadcast: reporting=${enabled ? "on" : "off"}`);
    }

    this.notifyDebugReporting("broadcast");
    return true;
  }

  /**
   * 会话录制能力状态（附录 C.6；F3 面板的按钮读它，不再按"未接入"置灰）。
   * `available` 需要一个**已握手**的录制源连接：录制必须绑定到它记录的连接（P1-B），
   * 不能在"还没有源"时先开录。
   *
   * 结束之后继续返回**最近一次**录制的 footer 统计：自动收尾（`sizeLimit`/断连）是
   * fire-and-forget 的，面板的 1 s 轮询要在 recorder 被清掉后仍能读到 `records` /
   * `droppedRecords` / `endedReason`，并且只在 `finalized=true` 后才提示（F5-05）。
   */
  public get recordingState(): EditorBridgeRecordingState {
    // `available` 还要求桥接服务已启动（F5 原语义：单测里未 start 时不能"开路"）。
    const state = this.recordingHost.state;
    return { ...state, available: this.state !== undefined && state.available };
  }

  /**
   * 开始录制：录制宿主固定**第一个可用调试源**（Editor 腿优先，其次 Runtime 腿），
   * 并在**此刻**把契约快照与身份字段写进文件头（C.6 的 P0：不是结束时）。
   *
   * 两条腿的帧都由各自的入站入口（`DebugIngress` 之前）交给同一个录制宿主，
   * 因此不存在"Runtime 腿录制为空"的旁路。
   */
  public async startRecording(
    options: EditorBridgeRecordingOptions,
  ): Promise<DebugRecordingHeader> {
    if (this.state === undefined) {
      throw new Error("The Editor Bridge server has not started.");
    }

    return this.recordingHost.start(options);
  }

  /**
   * 停止录制并写文件尾；没有录制时返回 `undefined`。收尾顺序见 {@link DebugRecordingHost.stop}
   * （F5-05：先写 footer 再清状态，轮询能读到最终统计）。
   */
  public async stopRecording(reason: DebugRecordingEndReason = "disconnect"): Promise<DebugRecordingFooter | undefined> {
    return this.recordingHost.stop(reason);
  }

  /**
   * 注册另一条腿的查询连接（E9）：Runtime 桥把自己的 {@link DebugQueryConnection} 交进来，
   * F6 的归属解析（{@link resolveDebugQueryClient}）自动覆盖两条腿，`debugQueryClient` 本身
   * **没有**任何按腿分支。返回的 disposable 在腿销毁时注销。
   */
  public registerDebugQuerySource(source: () => readonly DebugQueryConnection[]): vscode.Disposable {
    this.externalDebugQuerySources.add(source);
    return { dispose: () => this.externalDebugQuerySources.delete(source) };
  }

  /** 当前注册的跨腿查询源数量（诊断/测试用）。 */
  public get externalDebugQuerySourceCount(): number {
    return this.externalDebugQuerySources.size;
  }

  private notifyDebugReporting(reason: EditorBridgeDebugReportingReason): void {
    for (const listener of [...this.debugReportingListeners]) {
      try {
        listener(reason);
      } catch (errorValue) {
        this.output.appendLine(`[debug] debugReporting listener threw: ${String(errorValue)}`);
      }
    }
  }

  public get state(): EditorBridgeServerState | undefined {
    if (this.windowId === undefined || this.token === undefined || this.tcpPort === undefined || this.recordPath === undefined) {
      return undefined;
    }

    return {
      discoveryDirectory: nodePath.dirname(this.recordPath),
      recordPath: this.recordPath,
      windowId: this.windowId,
      role: "vscode",
      sessionId: this.sessionId,
      bootId: this.bootId,
      contractHash: this.publishedContractHash(),
      tcpPort: this.tcpPort,
      token: this.token,
      generation: this.generation,
      projectRoots: this.currentProjectRoots(),
    };
  }

  public async start(): Promise<void> {
    this.windowId = crypto.randomUUID();
    this.bootId = crypto.randomBytes(16).toString("hex");
    this.sessionId = `${this.windowId}#${this.bootId}`;
    this.token = crypto.randomBytes(24).toString("hex");
    this.generation += 1;

    const discoveryDirectory = nodePath.join(
      process.env.VISUALBRIDGE_TEST_TEMP_DIR !== undefined && process.env.VISUALBRIDGE_TEST_TEMP_DIR.length > 0
        ? process.env.VISUALBRIDGE_TEST_TEMP_DIR
        : nodeOs.tmpdir(),
      BRIDGE_DISCOVERY_DIRECTORY_NAME,
    );
    const recordPath = nodePath.join(discoveryDirectory, `${this.windowId}.json`);

    // 先定位契约，再开始 listen 并发布 discovery：否则首个连接可能落在"指纹还是空串"的
    // 早连接窗口里，被无谓降级成 JSON（A.3 指纹层）。
    await this.refreshContracts();

    const connected = new Promise<void>((resolve, reject) => {
      const tcpServer = net.createServer((socket) => this.accept(socket));
      let settled = false;
      const cleanup = (errorValue: Error) => {
        if (settled) return;
        settled = true;
        tcpServer.close();
        reject(errorValue);
      };
      tcpServer.once("error", cleanup);
      tcpServer.listen(0, "127.0.0.1", () => {
        if (settled) return;
        settled = true;
        this.tcpServer = tcpServer;
        this.tcpPort = (tcpServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
    await connected;

    this.recordPath = recordPath;
    await this.writeDiscoveryRecord();
    this.heartbeat = setInterval(() => {
      void this.touchHeartbeat();
    }, 1000);
    this.disposables.push(
      this.projects.onDidChange(() => {
        void this.writeDiscoveryRecord();
        // Project 增删可能带来新的 Unity 工程根，契约要跟着重新定位（C.8）。
        this.scheduleContractRefresh();
      }),
    );
    this.watchContracts();
    this.output.appendLine(
      `[bridge] listening tcp=127.0.0.1:${this.tcpPort} record=${this.recordPath} session=${this.sessionId} contractHash='${this.publishedContractHash()}'`,
    );
  }

  public dispose(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    if (this.contractRefreshTimer !== undefined) {
      clearTimeout(this.contractRefreshTimer);
      this.contractRefreshTimer = undefined;
    }

    for (const connection of this.connections.snapshot()) {
      // 扩展卸载/关窗：挂起查询按"面板已关闭"取消（与断连文案区分）。
      this.debugBindings.get(connection)?.session?.cancelAll("dispose");
      connection.transport.close();
      this.connections.retire(connection);
    }

    this.tcpServer?.close();
    this.tcpServer = undefined;
    if (this.recordPath !== undefined) {
      const recordPath = this.recordPath;
      this.recordPath = undefined;
      void (async () => {
        try {
          const { promises: fs } = await import("node:fs");
          await fs.unlink(recordPath);
        } catch {
          // 记录可能已被外部删除。
        }
      })();
    }

    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.debugReportingListeners.clear();
    // 面板关闭/扩展卸载也要留下文件尾（C.6）：fire-and-forget，不阻塞宿主退出。
    // **但不能宣称"已收尾"**：宿主进程可能在 write/sync/close 完成前就退出，此时文件没有 footer。
    // 回看把这种文件按"截断"处理（`read.footerFound=false`），预检对无 footer 的文件只做文件大小兜底。
    void this.stopRecording("disconnect").catch((errorValue: unknown) => {
      this.output.appendLine(`[debug] failed to finish the session recording on dispose: ${String(errorValue)}`);
    });
    this.debugManager.dispose();
  }

  private accept(socket: net.Socket): void {
    // 每次传输建立 generation +1（附录 A.3）；sessionId 不受影响。
    this.generation += 1;
    void this.writeDiscoveryRecord();
    let connection: BridgeConnection | undefined;
    /**
     * 本连接专属的录制 tap（P1-B）：帧只在"本连接是当前录制源"时才进录制文件。
     * 通道 0 与通道 1 共用它，保证两类帧的录制顺序与到达顺序一致；`DebugIngress` 也拿这同一个
     * 对象，所以开关录制/换源不需要重建接收门。**Runtime 腿用同一套 tap 机制**
     * （`DebugRecordingHost.noteFrame`），不存在只给 Editor 腿录制旁路。
     */
    const recordTap: DebugFrameRecorder = {
      recordFrame: (channel, payloadKind, payload) => {
        const sourceId = connection === undefined ? undefined : this.debugRecordSourceIds.get(connection);
        if (sourceId === undefined) {
          // 半开连接（或已被拒绝的第二个客户端）发来的帧一律不录，也不影响当前录制。
          return;
        }

        this.recordingHost.noteFrame(sourceId, channel, payloadKind, payload);
      },
    };
    const bridge = new BridgeSocket(socket, {
      onControlPayload: (payload, payloadKind) => {
        // 通道 0 的录制在控制载荷入口：这里还没有 JSON 解码，录制判定只按消息类型过滤
        // （握手/保活/`debugEnabled` 广播不录），业务帧原样入队。`payloadKind` 由连接层带出，
        // 保证写进录制文件的 6 字节帧头与线上逐字节一致。
        recordTap.recordFrame(BridgeChannel.Control, payloadKind, payload);
        if (connection !== undefined) {
          this.handlePayload(connection, payload);
        }
      },
      onDebugFrame: (payloadKind: BridgePayloadKind, payload: Buffer) => {
        // 通道按帧头分派（附录 A.2）：通道 1 的调试载荷交给本连接的接收门。
        // 帧层错误（CRC/长度）已由 BridgeSocket 断开，这里只做解码与计数，绝不断连。
        if (connection !== undefined) {
          this.acceptDebugFrame(connection, payloadKind, payload);
        }
      },
      onClosed: (error) => {
        if (error !== undefined) {
          this.output.appendLine(`[bridge] connection closed: ${error.message}`);
        }

        // 同步释放：BridgeSocket 在 finish() 里同步回调本方法。
        if (connection !== undefined) {
          // 断连：该连接的挂起查询全部取消，并明确提示"连接已断开"（P1，不静默清空）。
          this.debugBindings.get(connection)?.session?.cancelAll("disconnect");
          this.logDebugCounters(connection);
          this.connections.retire(connection);
          // 宽限从这里起算（附录 A.8）：下一条连接在 15 s 内带 resumeSessionId 才能续接。
          this.lastDisconnectedAtMs = this.now();
          // 只有**录制源连接**的关闭才收尾录制（P1-B）：注销录制源时宿主自己判断活跃源；
          // 其它连接（Unity 重连、第二个编辑器、端口探测）的 close 不会截断当前录制。
          const sourceId = this.debugRecordSourceIds.get(connection);
          if (sourceId !== undefined) {
            this.recordingHost.unregisterSource(sourceId);
          }
          // 连接没了 ⇒ 面板的开关变成"发不出去"，必须重绘（C.7 的状态栏）。
          this.lastClientEndpointId = undefined;
          this.notifyDebugReporting("connection");
        }
      },
    }, { log: (message) => this.output.appendLine(message) });

    // 同步占位；accept 会先剔除已终止（对端已断）的连接，避免误拒重连。
    connection = this.connections.accept(bridge);
    // 一条连接一个录制源 id（握手后才注册到录制宿主）：半开连接发帧时宿主还不认识它，
    // 因此不会被录进别人的文件（P1-B），也不会与重连后的新连接混淆。
    this.connectionSequence += 1;
    this.debugRecordSourceIds.set(connection, `editor-${this.connectionSequence}`);
    this.debugRecordTaps.set(connection, recordTap);
  }

  private handlePayload(connection: BridgeConnection, payload: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(payload.toString("utf8"));
    } catch {
      this.sendErrorAndClose(connection, "bridge.invalidJson", "Message is not valid JSON.");
      return;
    }

    // `debugSetEnabled` / `debugEnabled` 已并入 `BridgeMessage`（schema 的两条通道 0 消息），
    // 因此先按统一解析器做形状校验，再按类型分流：
    // - 握手后到达的 `debugEnabled` 是调试面自己的状态广播，认领后不进业务分派；
    // - 其余控制消息（`debugSetEnabled` 出现在错误的监听端、或握手前到达）落回既有的
    //   `bridge.unknownMessageType` / `bridge.missingProperty` 路径并断连，与 E3 的严格语义一致。
    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(value);

      if (connection.helloCompleted && this.acceptDebugEnabledBroadcast(message)) {
        return;
      }
    } catch (errorValue) {
      if (errorValue instanceof BridgeProtocolError) {
        const code = isBridgeErrorCode(errorValue.code) ? errorValue.code : "bridge.invalidMessage";
        this.sendErrorAndClose(connection, code, errorValue.message);
        return;
      }

      throw errorValue;
    }

    if (!connection.helloCompleted) {
      this.handleHello(connection, message);
      return;
    }

    if (message.type !== "open" && message.type !== "reveal") {
      this.sendErrorAndClose(connection, "bridge.unknownMessageType", `Server must not receive '${message.type}' after the handshake.`);
      return;
    }

    void this.handleRequest(connection, message);
  }

  private handleHello(connection: BridgeConnection, message: BridgeMessage): void {
    if (message.type !== "hello") {
      this.sendErrorAndClose(connection, "bridge.unknownMessageType", `Expected a hello message, received '${message.type}'.`);
      return;
    }

    const rejection = evaluateHello(message, {
      role: "vscode",
      token: this.token!,
      hasActiveConnection: this.connections.hasActiveConnection(connection),
      supportsBinary: true,
    });
    if (rejection !== undefined) {
      this.sendErrorAndClose(connection, rejection.code, rejection.detail);
      return;
    }

    // 指纹层：不一致不拒连，只把数据面降级为 JSON（附录 A.3）。
    const selection = selectBridgeContractHash(message.contractHash, this.contracts.current.hashes);
    const payloads = negotiatePayloads(message.payloads, !selection.degraded) ?? ["json"];
    if (selection.degraded) {
      this.output.appendLine(
        `[bridge] contract hash mismatch client='${message.contractHash}' server='${selection.contractHash}'; data plane degrades to JSON.`,
      );
    }

    // 该连接的数据面绑定它自己声明的契约快照（多 Project 工作区里各工程指纹不同）。
    // 会话在握手时就位：面板可以在收到第一条调试帧之前发起查询；接收门从同一个客户端取
    // `isPendingRequest` / `isKnownRequest`（F6 的接线点）。
    const snapshot = this.contracts.current.snapshotForHash(message.contractHash) ?? this.singleContractSnapshot();
    this.debugBindings.set(connection, {
      snapshot,
      session: this.createDebugSession(connection, snapshot),
    });

    // 新连接可能出现在契约产物热更新之后：顺手刷新一次，下一条连接拿到新指纹。
    this.scheduleContractRefresh();

    // 续接判定（附录 A.3/A.8）：命中 resumeSessionId 且仍在 15 s 宽限内才 resumed；
    // 超过宽限则换发新 bootId/sessionId（旧会话数据随新会话作废），绝不无限续接。
    const reconnect = planReconnectGrace({
      sessionId: this.sessionId,
      bootId: this.bootId,
      ...(message.resumeSessionId === undefined ? {} : { resumeSessionId: message.resumeSessionId }),
      ...(this.lastDisconnectedAtMs === undefined ? {} : { disconnectedAtMs: this.lastDisconnectedAtMs }),
      nowMs: this.now(),
      ...(this.reconnectGraceMs === undefined ? {} : { graceMs: this.reconnectGraceMs }),
      nextBootId: () => crypto.randomBytes(16).toString("hex"),
    });
    this.applyReconnectDecision(reconnect);
    if (!reconnect.resumed) {
      // 真断开/新会话才清空实例、记录与游标；15 s 内的可恢复中断原样保留（C.3）。
      this.debugManager.reset();
    } else {
      // C.3：可恢复中断里"没再出现"的旧实例标 `endedAt` + `reconnect`；运行时随后重新 Create
      // 同一个 id 时就会**新建一条实例记录**（旧记录原样保留），不会被误判成重复 Create。
      this.debugManager.reconnect();
    }

    const welcome: BridgeWelcomeMessage = {
      type: "welcome",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      endpointId: this.windowId!,
      sessionId: reconnect.sessionId,
      resumed: reconnect.resumed,
      connectType: "editor",
      generation: this.generation,
      bootId: reconnect.bootId,
      contractHash: selection.contractHash,
      payloads,
      debugEnabled: this.debugReportingEnabled,
      startedAt: this.startedAt,
    };
    this.connections.markHandshaken(connection);
    this.lastClientEndpointId = message.clientEndpointId;
    this.notifyDebugReporting("connection");
    // 录制源在**握手成功后**才注册（P1-B）：半开连接不可录制，Runtime 腿同理由 welcome 触发。
    this.registerRecordingSource(connection, {
      sessionId: reconnect.sessionId,
      bootId: reconnect.bootId,
      contractHash: selection.contractHash,
      contracts: snapshot,
    });
    connection.transport.sendControlJson(welcome);
    this.output.appendLine(
      `[bridge] handshake complete endpoint='${message.clientEndpointId}' session=${welcome.sessionId} resumed=${welcome.resumed} payloads=[${payloads.join(",")}]`,
    );
  }

  /** 宽限到期时把新会话身份落到监听方状态；旧会话的调试绑定随连接关闭已失效。 */
  private applyReconnectDecision(decision: ReconnectGraceDecision): void {
    if (!decision.rotated) {
      return;
    }

    const previous = this.sessionId;
    this.bootId = decision.bootId;
    this.sessionId = decision.sessionId;
    this.output.appendLine(
      `[bridge] reconnect grace expired: session '${previous}' is no longer resumable; issued session '${this.sessionId}'.`,
    );
  }

  private async handleRequest(connection: BridgeConnection, message: BridgeOpenRequestLike): Promise<void> {
    try {
      if (message.type === "open") {
        await this.openDocument(message.documentPath);
      } else {
        await this.revealReference(message.reference);
      }

      connection.transport.sendControlJson({ type: "response", requestId: message.requestId, status: "ok" });
      return;
    } catch (errorValue) {
      const code = errorValue instanceof BridgeProtocolError && isBridgeErrorCode(errorValue.code)
        ? errorValue.code
        : "bridge.internalError";
      if (code === "bridge.internalError") {
        this.output.appendLine(`[bridge] request '${message.requestId}' failed: ${String(errorValue)}`);
      }

      connection.transport.sendControlJson({
        type: "response",
        requestId: message.requestId,
        status: "error",
        error: code,
      });
    }
  }

  private async openDocument(documentPath: string): Promise<void> {
    const matches: vscode.Uri[] = [];
    for (const project of this.projects.projects) {
      const uri = vscode.Uri.joinPath(project.rootUri, ...documentPath.split("/"));
      if (this.projects.resolveDocument(uri) === undefined) {
        continue;
      }

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }

      matches.push(uri);
    }

    if (matches.length === 0) {
      throw new BridgeProtocolError("bridge.documentUnresolved", "$.documentPath", `No project resolves '${documentPath}'.`);
    }

    if (matches.length > 1) {
      throw new BridgeProtocolError("bridge.documentAmbiguous", "$.documentPath", `${matches.length} projects resolve '${documentPath}'.`);
    }

    await vscode.commands.executeCommand(OPEN_DOCUMENT_COMMAND, matches[0]);
  }

  private async revealReference(reference: string | number): Promise<void> {
    let location = this.findReferenceLocation(reference);
    if (location === undefined) {
      const refreshed = await this.documents.refresh();
      if (refreshed.status === "applied") {
        location = this.findReferenceLocation(reference);
      }
    }

    if (location === undefined) {
      throw new BridgeProtocolError("bridge.documentUnresolved", "$.reference", `No reference resolves '${String(reference)}'.`);
    }

    await vscode.commands.executeCommand(REVEAL_REFERENCE_COMMAND, location);
  }

  private findReferenceLocation(reference: string | number): ReferenceLocationLike | undefined {
    const locations: ReferenceLocationLike[] = [];
    const seen = new Set<string>();
    for (const document of this.documents.documents) {
      for (const referenceEntry of document.references) {
        if (referenceEntry.occurrence.value !== reference) {
          continue;
        }

        for (const candidate of referenceEntry.resolution.candidates) {
          const candidateLocation = candidate.location;
          if (candidateLocation === undefined) {
            continue;
          }

          const key = `${candidateLocation.projectId}\u0000${candidateLocation.documentTypeId}\u0000${candidateLocation.path}\u0000${candidateLocation.elementId ?? ""}\u0000${candidateLocation.rowId ?? ""}`;
          if (!seen.has(key)) {
            seen.add(key);
            locations.push(candidateLocation);
          }
        }
      }
    }

    if (locations.length === 0) {
      return undefined;
    }

    if (locations.length > 1) {
      throw new BridgeProtocolError("bridge.documentAmbiguous", "$.reference", `${locations.length} locations resolve '${String(reference)}'.`);
    }

    return locations[0];
  }

  private sendErrorAndClose(connection: BridgeConnection, code: BridgeErrorCode, detail: string): void {
    this.output.appendLine(`[bridge] connection error ${code}: ${detail}`);
    connection.transport.sendControlJson({ type: "error", code, detail });
    // 先让已入队的错误帧写完，再断开发送方向。
    connection.transport.end();
  }

  /**
   * 通道 1 的调试载荷：交给本连接绑定的接收门（槽位表与契约快照都按连接隔离）。
   * 解码出的包络按到达顺序交给 `DebugInstanceManager.ingest`——它负责"先入 store、再路由、最后捕关键帧"。
   */
  private acceptDebugFrame(
    connection: BridgeConnection,
    payloadKind: BridgePayloadKind,
    payload: Buffer,
  ): void {
    let binding = this.debugBindings.get(connection);
    if (binding === undefined) {
      // 握手前收到的通道 1 帧：没有契约绑定，按无契约接收（不静默丢字节）。
      binding = { snapshot: undefined, session: this.createDebugSession(connection, undefined) };
      this.debugBindings.set(connection, binding);
    }

    binding.session ??= this.createDebugSession(connection, binding.snapshot);
    // 帧路径只有这一条：录制 tap → 计数/分流 → 解码 → 实例/查询结算（DebugChannelSession）。
    binding.session.acceptFrame(payloadKind, payload);
  }

  /**
   * 创建一条连接的调试会话（E9）：Editor 腿只提供**连接**与**发送函数**，
   * 解码、实例归属、查询挂起表与录制 tap 都复用与 Runtime 腿相同的
   * {@link DebugChannelSession}。
   */
  private createDebugSession(
    connection: BridgeConnection,
    snapshot: DebugContractSnapshot | undefined,
  ): DebugChannelSession {
    const recorder = this.debugRecordTaps.get(connection);
    const channel: DebugChannel = {
      origin: "editor",
      id: this.debugRecordSourceIds.get(connection) ?? "editor",
      isOpen: () => connection.transport.isOpen,
      sendDebugPayload: (payload) => connection.transport.sendDebugControl(payload),
    };
    return new DebugChannelSession({
      channel,
      manager: this.debugManager,
      ...(snapshot === undefined ? {} : { contracts: snapshot }),
      ...(recorder === undefined ? {} : { recorder }),
      now: this.now,
      log: (message) => this.output.appendLine(message),
      onIngestError: (envelope, errorValue) => {
        this.debugIngestErrors += 1;
        this.output.appendLine(
          `[debug] ingest failed (#${this.debugIngestErrors}) for '${envelope.type}'; the rest of the batch keeps flowing: ${String(errorValue)}`,
        );
      },
    });
  }

  /**
   * 把已握手的 Editor 连接登记为可录制源（E9）：录制宿主按源 id 过滤帧，
   * Runtime 腿在收到 welcome 时走同一套登记。
   */
  private registerRecordingSource(
    connection: BridgeConnection,
    identity: {
      readonly sessionId: string;
      readonly bootId: string;
      readonly contractHash: string;
      readonly contracts: DebugContractSnapshot | undefined;
    },
  ): void {
    const id = this.debugRecordSourceIds.get(connection);
    if (id === undefined) {
      return;
    }

    const source: DebugRecordingSource = {
      id,
      origin: "editor",
      connectType: "editor",
      sessionId: identity.sessionId,
      endpointId: this.windowId ?? "",
      bootId: identity.bootId,
      contractHash: identity.contractHash,
      contracts: identity.contracts,
      isOpen: () => !connection.isTerminated && connection.transport.isOpen,
    };
    this.recordingHost.registerSource(source);
  }

  private logDebugCounters(connection: BridgeConnection): void {
    const ingress = this.debugBindings.get(connection)?.session?.ingress;
    if (ingress === undefined) {
      return;
    }

    const counters = ingress.counters;
    this.output.appendLine(
      `[debug] connection summary frames=${counters.frames} controlFrames=${counters.controlFrames} envelopes=${counters.envelopes} wireBytes=${counters.wireBytes} unknownSlots=${counters.unknownSlots} unknownMethods=${counters.unknownMethods} unknownContractMethods=${counters.unknownContractMethods} oversize=${counters.oversizeFrames} malformed=${counters.malformedMessages}`,
    );
  }

  /** 本窗口对外发布的指纹（状态与 welcome 兜底）；多工程取排序首个（A.3 只允许一个字符串）。 */
  private publishedContractHash(): string {
    return selectBridgeContractHash("", this.contracts.current.hashes).contractHash;
  }

  /** 只有一个契约工程时，即使客户端指纹不匹配也用它解码（比全通用视图更有用）。 */
  private singleContractSnapshot(): DebugContractSnapshot | undefined {
    const snapshots = this.contracts.current.snapshots.filter((snapshot) => !snapshot.empty);
    return snapshots.length === 1 ? snapshots[0] : undefined;
  }

  /** 监听契约产物的出现/变化/删除（Unity 重新生成后无需重启窗口）。 */
  private watchContracts(): void {
    if (!this.autoLoadContracts) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher("**/debug-contracts.json");
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.scheduleContractRefresh()),
      watcher.onDidChange(() => this.scheduleContractRefresh()),
      watcher.onDidDelete(() => this.scheduleContractRefresh()),
    );
  }

  private scheduleContractRefresh(): void {
    if (!this.autoLoadContracts) {
      return;
    }

    if (this.contractRefreshTimer !== undefined) {
      clearTimeout(this.contractRefreshTimer);
    }

    this.contractRefreshTimer = setTimeout(() => {
      this.contractRefreshTimer = undefined;
      void this.refreshContracts();
    }, 100);
  }

  /** 重新按 Project 根定位契约；同一时刻只跑一次加载。 */
  private refreshContracts(): Promise<void> {
    if (!this.autoLoadContracts) {
      return Promise.resolve();
    }

    if (this.contractRefreshing !== undefined) {
      return this.contractRefreshing;
    }

    const projectRoots = this.projects.projects.map((project) => project.rootUri.fsPath);
    const supplementalDirectories = this.contractDirectories();
    this.contractRefreshing = (async () => {
      try {
        const set = await this.contracts.load({ projectRoots, supplementalDirectories });
        for (const warning of set.warnings) {
          this.output.appendLine(`[bridge] contract warning: ${warning.message}`);
        }
      } catch (errorValue) {
        this.output.appendLine(`[bridge] contract load failed: ${String(errorValue)}`);
      } finally {
        this.contractRefreshing = undefined;
      }
    })();
    return this.contractRefreshing;
  }

  /** `visualbridge.debug.contractDirectories`：工作区相对路径，多根工作区逐个解析后去重。 */
  private contractDirectories(): readonly string[] {
    const configured = vscode.workspace
      .getConfiguration()
      .get<readonly string[]>(DEBUG_CONTRACT_DIRECTORIES_SETTING, []);
    if (!Array.isArray(configured) || configured.length === 0) {
      return [];
    }

    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const resolved = new Set<string>();
    for (const entry of configured) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        continue;
      }

      if (nodePath.isAbsolute(entry)) {
        resolved.add(nodePath.normalize(entry));
        continue;
      }

      for (const folder of folders) {
        resolved.add(nodePath.resolve(folder, entry));
      }
    }

    return [...resolved].sort();
  }

  private currentProjectRoots(): readonly string[] {
    return this.projects.projects
      .map((project) => project.rootUri.fsPath.replaceAll("\\", "/"))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  private buildDiscoveryRecord(): BridgeDiscoveryRecord | undefined {
    if (this.windowId === undefined || this.token === undefined || this.tcpPort === undefined) {
      return undefined;
    }

    const projectRoots = this.currentProjectRoots();
    if (projectRoots.length === 0) {
      // 记录格式要求至少一个项目根；工程尚未加载时先不发布，等 onDidChange 重试。
      return undefined;
    }

    return {
      formatVersion: BRIDGE_DISCOVERY_FORMAT_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "vscode",
      tcpPort: this.tcpPort,
      token: this.token,
      pid: process.pid,
      generation: this.generation,
      windowId: this.windowId,
      projectRoots,
    };
  }

  private async writeDiscoveryRecord(): Promise<void> {
    if (this.recordPath === undefined) {
      return;
    }

    const record = this.buildDiscoveryRecord();
    if (record === undefined) {
      return;
    }

    try {
      assertDiscoveryRecordRoundTrips(record);
      await writeDiscoveryRecordAtomically(this.recordPath, record);
    } catch (errorValue) {
      this.output.appendLine(`[bridge] failed to publish discovery record: ${String(errorValue)}`);
    }
  }

  private async touchHeartbeat(): Promise<void> {
    if (this.recordPath === undefined) {
      return;
    }

    try {
      await touchDiscoveryRecord(this.recordPath);
    } catch {
      // 记录被外部删除时按项目状态重写；没有项目根时保持缺失（客户端报 noEndpoint）。
      await this.writeDiscoveryRecord();
    }
  }
}

type BridgeOpenRequestLike =
  | { readonly type: "open"; readonly requestId: string; readonly documentPath: string }
  | { readonly type: "reveal"; readonly requestId: string; readonly reference: string | number };

interface ReferenceLocationLike {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly path: string;
  readonly elementId?: string;
  readonly rowId?: string;
}
