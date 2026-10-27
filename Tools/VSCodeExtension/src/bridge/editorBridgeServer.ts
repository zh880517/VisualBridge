import * as crypto from "node:crypto";
import * as net from "node:net";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceDocumentIndex } from "../document/workspaceDocumentIndex";
import {
  BRIDGE_DISCOVERY_DIRECTORY_NAME,
  BRIDGE_DISCOVERY_FORMAT_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  evaluateHello,
  isBridgeErrorCode,
  negotiatePayloads,
  parseBridgeMessage,
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
import {
  EditorBridgeConnectionGate,
  EditorBridgeConnectionSlot,
} from "./editorBridgeConnections";
import { BridgeChannel, type BridgePayloadKind } from "./framing";
import {
  DEBUG_CONTRACT_DIRECTORIES_SETTING,
  DebugContractRegistry,
  type DebugContractSnapshot,
  type DebugContractSnapshotSet,
} from "./debugContractRegistry";
import { DebugIngress } from "./debugIngress";

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
}

type BridgeConnection = EditorBridgeConnectionSlot<BridgeSocket>;

/** 一条连接绑定的调试面状态：指纹决定契约快照，快照决定二进制解码。 */
interface EditorBridgeDebugBinding {
  snapshot: DebugContractSnapshot | undefined;
  ingress: DebugIngress | undefined;
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
 * 重连语义（附录 A.3/A.6）：端点同一时刻只接纳一条**已完成握手且仍然存活**的连接
 * （`runtime.alreadyConnected`）；"存活"按传输层的同步可观测状态判定，不等异步
 * `close` 事件。对端断开或本端关闭后，下一条连接立即取得槽位，`resumed` 只由
 * `resumeSessionId === sessionId` 决定，`generation` 每次传输 +1（不参与 `sessionId`）。
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
  private readonly debugBindings = new WeakMap<BridgeConnection, EditorBridgeDebugBinding>();
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
  }

  private accept(socket: net.Socket): void {
    // 每次传输建立 generation +1（附录 A.3）；sessionId 不受影响。
    this.generation += 1;
    void this.writeDiscoveryRecord();
    let connection: BridgeConnection | undefined;
    const bridge = new BridgeSocket(socket, {
      onControlPayload: (payload) => {
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
          this.logDebugCounters(connection);
          this.connections.retire(connection);
        }
      },
    }, { log: (message) => this.output.appendLine(message) });

    // 同步占位；accept 会先剔除已终止（对端已断）的连接，避免误拒重连。
    connection = this.connections.accept(bridge);
  }

  private handlePayload(connection: BridgeConnection, payload: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(payload.toString("utf8"));
    } catch {
      this.sendErrorAndClose(connection, "bridge.invalidJson", "Message is not valid JSON.");
      return;
    }

    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(value);
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
    this.debugBindings.set(connection, {
      snapshot: this.contracts.current.snapshotForHash(message.contractHash) ?? this.singleContractSnapshot(),
      ingress: undefined,
    });

    // 新连接可能出现在契约产物热更新之后：顺手刷新一次，下一条连接拿到新指纹。
    this.scheduleContractRefresh();

    const welcome: BridgeWelcomeMessage = {
      type: "welcome",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      endpointId: this.windowId!,
      sessionId: this.sessionId,
      resumed: message.resumeSessionId !== undefined && message.resumeSessionId === this.sessionId,
      connectType: "editor",
      generation: this.generation,
      bootId: this.bootId,
      contractHash: selection.contractHash,
      payloads,
      debugEnabled: true,
      startedAt: this.startedAt,
    };
    this.connections.markHandshaken(connection);
    connection.transport.sendControlJson(welcome);
    this.output.appendLine(
      `[bridge] handshake complete endpoint='${message.clientEndpointId}' session=${welcome.sessionId} resumed=${welcome.resumed} payloads=[${payloads.join(",")}]`,
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
   * 解码结果暂存日志——存储与路由由 F2 接在 `DebugIngress` 下游。
   */
  private acceptDebugFrame(connection: BridgeConnection, payloadKind: BridgePayloadKind, payload: Buffer): void {
    const binding = this.debugBindings.get(connection);
    if (binding === undefined) {
      // 握手前收到的通道 1 帧：没有契约绑定，按无契约接收（不静默丢字节）。
      this.debugBindings.set(connection, { snapshot: undefined, ingress: undefined });
      this.acceptDebugFrame(connection, payloadKind, payload);
      return;
    }

    binding.ingress ??= new DebugIngress({
      ...(binding.snapshot === undefined ? {} : { contracts: binding.snapshot }),
      log: (message) => this.output.appendLine(message),
    });
    binding.ingress.acceptFrame({ channel: BridgeChannel.Debug, payloadKind, payload });
  }

  private logDebugCounters(connection: BridgeConnection): void {
    const binding = this.debugBindings.get(connection);
    if (binding?.ingress === undefined) {
      return;
    }

    const counters = binding.ingress.counters;
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
