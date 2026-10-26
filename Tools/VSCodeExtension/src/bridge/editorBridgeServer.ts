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
  shouldDegradeToJson,
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
import type { BridgePayloadKind } from "./framing";

export const OPEN_DOCUMENT_COMMAND = "visualbridge.openDocument";
export const REVEAL_REFERENCE_COMMAND = "visualbridge.revealReference";

export interface EditorBridgeServerState {
  readonly discoveryDirectory: string;
  readonly recordPath: string;
  readonly windowId: string;
  readonly role: "vscode";
  readonly sessionId: string;
  readonly bootId: string;
  readonly contractHash: string;
  readonly tcpPort: number;
  readonly token: string;
  readonly generation: number;
  readonly projectRoots: readonly string[];
}

interface BridgeConnection {
  readonly bridge: BridgeSocket;
  helloCompleted: boolean;
}

/**
 * 本地 Editor Bridge 监听方（VS Code Extension Host）。
 *
 * 连接层为统一协议的 6 字节帧（控制通道承载 JSON）。本类负责：
 * - 发布发现记录 v2（原子写 + mtime 心跳），供 Unity Editor 拨号；
 * - 编辑器模式的 hello/welcome 握手（方向层、连接层、token、一对一、载荷协商）；
 * - open/reveal 请求的路由与应答。
 *
 * 指纹不一致时保留连接，只把 welcome.payloads 收敛为 ["json"]，并把两侧 hash
 * 写进日志与 UI 状态（E2 的 VS Code 侧尚无契约注册表，服务端指纹暂时为空串）。
 */
export class EditorBridgeServer implements vscode.Disposable {
  private readonly projects: ProjectRegistry;
  private readonly documents: WorkspaceDocumentIndex;
  private readonly output: vscode.LogOutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly connections = new Set<BridgeConnection>();

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
  // F1 接入契约注册表前，VS Code 侧没有可发布的调试契约指纹。
  private readonly contractHash = "";

  public constructor(
    projects: ProjectRegistry,
    documents: WorkspaceDocumentIndex,
    output: vscode.LogOutputChannel,
  ) {
    this.projects = projects;
    this.documents = documents;
    this.output = output;
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
      contractHash: this.contractHash,
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
      }),
    );
    this.output.appendLine(
      `[bridge] listening tcp=127.0.0.1:${this.tcpPort} record=${this.recordPath} session=${this.sessionId}`,
    );
  }

  public dispose(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    for (const connection of [...this.connections]) {
      connection.bridge.close();
    }

    this.connections.clear();
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
        // 编辑器通道当前的业务消息全部走控制通道；调试载荷由 E4 接入。
        this.output.appendLine(`[bridge] ignoring a ${payload.length}-byte debug payload (kind ${payloadKind}) on the editor connection.`);
      },
      onClosed: (error) => {
        if (error !== undefined) {
          this.output.appendLine(`[bridge] connection closed: ${error.message}`);
        }

        if (connection !== undefined) {
          this.connections.delete(connection);
        }
      },
    }, { log: (message) => this.output.appendLine(message) });

    connection = { bridge, helloCompleted: false };
    this.connections.add(connection);
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
      hasActiveConnection: this.hasActiveConnection(connection),
      supportsBinary: true,
    });
    if (rejection !== undefined) {
      this.sendErrorAndClose(connection, rejection.code, rejection.detail);
      return;
    }

    // 指纹层：不一致不拒连，只把数据面降级为 JSON（附录 A.3）。
    const degradeToJson = shouldDegradeToJson(message.contractHash, this.contractHash);
    const payloads = negotiatePayloads(message.payloads, !degradeToJson) ?? ["json"];
    if (degradeToJson) {
      this.output.appendLine(
        `[bridge] contract hash mismatch client='${message.contractHash}' server='${this.contractHash}'; data plane degrades to JSON.`,
      );
    }

    const welcome: BridgeWelcomeMessage = {
      type: "welcome",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      endpointId: this.windowId!,
      sessionId: this.sessionId,
      resumed: message.resumeSessionId !== undefined && message.resumeSessionId === this.sessionId,
      connectType: "editor",
      generation: this.generation,
      bootId: this.bootId,
      contractHash: this.contractHash,
      payloads,
      debugEnabled: true,
      startedAt: this.startedAt,
    };
    connection.helloCompleted = true;
    connection.bridge.sendControlJson(welcome);
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

      connection.bridge.sendControlJson({ type: "response", requestId: message.requestId, status: "ok" });
      return;
    } catch (errorValue) {
      const code = errorValue instanceof BridgeProtocolError && isBridgeErrorCode(errorValue.code)
        ? errorValue.code
        : "bridge.internalError";
      if (code === "bridge.internalError") {
        this.output.appendLine(`[bridge] request '${message.requestId}' failed: ${String(errorValue)}`);
      }

      connection.bridge.sendControlJson({
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

  /** 一对一约束：同端点上除自己以外已有完成握手的连接时拒绝新连接。 */
  private hasActiveConnection(current: BridgeConnection): boolean {
    for (const connection of this.connections) {
      if (connection !== current && connection.helloCompleted) {
        return true;
      }
    }

    return false;
  }

  private sendErrorAndClose(connection: BridgeConnection, code: BridgeErrorCode, detail: string): void {
    this.output.appendLine(`[bridge] connection error ${code}: ${detail}`);
    connection.bridge.sendControlJson({ type: "error", code, detail });
    // 先让已入队的错误帧写完，再断开发送方向。
    connection.bridge.end();
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
