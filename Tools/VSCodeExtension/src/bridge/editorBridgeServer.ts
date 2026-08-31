import * as crypto from "node:crypto";
import * as net from "node:net";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { ProjectRegistry } from "../project/projectRegistry";
import type { WorkspaceDocumentIndex } from "../document/workspaceDocumentIndex";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_DISCOVERY_FORMAT_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  BridgeProtocolError,
  isBridgeErrorCode,
  parseBridgeMessage,
  serializeMessage,
  type BridgeErrorMessage,
  type BridgeMessage,
  type BridgeWelcomeMessage,
} from "./bridgeProtocol";

export const BRIDGE_DISCOVERY_DIRECTORY_NAME = "visualbridge-bridge";
export const OPEN_DOCUMENT_COMMAND = "visualbridge.openDocument";
export const REVEAL_REFERENCE_COMMAND = "visualbridge.revealReference";

export interface EditorBridgeServerState {
  readonly discoveryDirectory: string;
  readonly recordPath: string;
  readonly windowId: string;
  readonly pipePath: string;
  readonly tcpPort: number;
  readonly token: string;
  readonly generation: number;
  readonly projectRoots: readonly string[];
}

interface BridgeConnection {
  readonly socket: net.Socket;
  helloCompleted: boolean;
  authenticated: boolean;
  buffer: string;
}

/**
 * Local Editor Bridge server. Listens on a Windows named pipe and a loopback TCP
 * port, publishes a per-window discovery record with a heartbeat, authenticates
 * Unity Editor clients with a per-window token, and answers open/reveal requests
 * by routing them through the Project Registry and the document index.
 */
export class EditorBridgeServer implements vscode.Disposable {
  private readonly projects: ProjectRegistry;
  private readonly documents: WorkspaceDocumentIndex;
  private readonly output: vscode.LogOutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly connections = new Set<BridgeConnection>();

  private pipeServer: net.Server | undefined;
  private tcpServer: net.Server | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private recordPath: string | undefined;
  private windowId: string | undefined;
  private token: string | undefined;
  private pipePath: string | undefined;
  private tcpPort: number | undefined;
  private generation = 0;

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
    if (this.windowId === undefined || this.token === undefined || this.pipePath === undefined || this.tcpPort === undefined || this.recordPath === undefined) {
      return undefined;
    }

    return {
      discoveryDirectory: nodePath.dirname(this.recordPath),
      recordPath: this.recordPath,
      windowId: this.windowId,
      pipePath: this.pipePath,
      tcpPort: this.tcpPort,
      token: this.token,
      generation: this.generation,
      projectRoots: this.currentProjectRoots(),
    };
  }

  public async start(): Promise<void> {
    this.windowId = crypto.randomUUID();
    this.token = crypto.randomBytes(24).toString("hex");
    this.generation += 1;
    this.pipePath = `\\\\.\\pipe\\visualbridge-bridge-${this.windowId}`;

    const discoveryDirectory = nodePath.join(
      process.env.VISUALBRIDGE_TEST_TEMP_DIR !== undefined && process.env.VISUALBRIDGE_TEST_TEMP_DIR.length > 0
        ? process.env.VISUALBRIDGE_TEST_TEMP_DIR
        : nodeOs.tmpdir(),
      BRIDGE_DISCOVERY_DIRECTORY_NAME,
    );
    const recordPath = nodePath.join(discoveryDirectory, `${this.windowId}.json`);

    const connected = new Promise<void>((resolve, reject) => {
      const pipeServer = net.createServer((socket) => this.accept(socket));
      const tcpServer = net.createServer((socket) => this.accept(socket));
      let settled = false;
      const cleanup = (errorValue: Error) => {
        if (settled) return;
        settled = true;
        pipeServer.close();
        tcpServer.close();
        reject(errorValue);
      };
      pipeServer.once("error", cleanup);
      tcpServer.once("error", cleanup);
      pipeServer.listen(this.pipePath!, () => {
        tcpServer.listen(0, "127.0.0.1", () => {
          if (settled) return;
          settled = true;
          this.pipeServer = pipeServer;
          this.tcpServer = tcpServer;
          this.tcpPort = (tcpServer.address() as net.AddressInfo).port;
          resolve();
        });
      });
    });
    await connected;

    this.recordPath = recordPath;
    await this.writeDiscoveryRecord();
    this.heartbeat = setInterval(() => {
      void this.touchDiscoveryRecord();
    }, 1000);
    this.disposables.push(
      this.projects.onDidChange(() => {
        void this.writeDiscoveryRecord();
      }),
    );
    this.output.appendLine(
      `[bridge] listening pipe=${this.pipePath} tcp=127.0.0.1:${this.tcpPort} record=${this.recordPath}`,
    );
  }

  public dispose(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    for (const connection of [...this.connections]) {
      connection.socket.destroy();
    }

    this.connections.clear();
    this.pipeServer?.close();
    this.tcpServer?.close();
    this.pipeServer = undefined;
    this.tcpServer = undefined;
    if (this.recordPath !== undefined) {
      void vscode.workspace.fs.delete(vscode.Uri.file(this.recordPath))
        .then(() => undefined, () => undefined);
      this.recordPath = undefined;
    }

    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private accept(socket: net.Socket): void {
    const connection: BridgeConnection = { socket, helloCompleted: false, authenticated: false, buffer: "" };
    this.connections.add(connection);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      connection.buffer += chunk;
      let newline = connection.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        if (line.trim().length > 0) {
          try {
            this.handleLine(connection, line);
          } catch (errorValue) {
            this.reportInternalError(connection, errorValue);
            return;
          }
        }

        newline = connection.buffer.indexOf("\n");
      }
    });
    const finish = () => {
      this.connections.delete(connection);
    };
    socket.on("close", finish);
    socket.on("error", () => {
      this.connections.delete(connection);
    });
  }

  private handleLine(connection: BridgeConnection, line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.sendErrorAndClose(connection, "bridge.invalidJson", "Message is not valid JSON.");
      return;
    }

    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(value);
    } catch (errorValue) {
      if (errorValue instanceof BridgeProtocolError) {
        this.sendErrorAndClose(connection, isBridgeErrorCode(errorValue.code) ? errorValue.code : "bridge.invalidMessage", errorValue.message);
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

    if (message.token !== this.token) {
      this.sendErrorAndClose(connection, "bridge.invalidToken", "Authentication token rejected.");
      return;
    }

    if (message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      this.sendErrorAndClose(connection, "bridge.protocolVersionMismatch", `Server speaks protocol version ${BRIDGE_PROTOCOL_VERSION}.`);
      return;
    }

    const welcome: BridgeWelcomeMessage = {
      type: "welcome",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      windowId: this.windowId!,
      serverGeneration: this.generation,
      capabilities: [...BRIDGE_CAPABILITIES],
    };
    connection.helloCompleted = true;
    connection.authenticated = true;
    connection.socket.write(serializeMessage(welcome));
  }

  private async handleRequest(connection: BridgeConnection, message: BridgeOpenRequestLike): Promise<void> {
    try {
      if (message.type === "open") {
        await this.openDocument(message.documentPath);
      } else {
        await this.revealReference(message.reference);
      }

      connection.socket.write(serializeMessage({ type: "response", requestId: message.requestId, status: "ok" }));
      return;
    } catch (errorValue) {
      const code = errorValue instanceof BridgeProtocolError && isBridgeErrorCode(errorValue.code)
        ? errorValue.code
        : "bridge.internalError";
      if (code === "bridge.internalError") {
        this.output.appendLine(`[bridge] request '${message.requestId}' failed: ${String(errorValue)}`);
      }

      connection.socket.write(serializeMessage({
        type: "response",
        requestId: message.requestId,
        status: "error",
        error: code,
      }));
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

  private sendErrorAndClose(connection: BridgeConnection, code: BridgeErrorMessage["code"], detail: string): void {
    this.output.appendLine(`[bridge] connection error ${code}: ${detail}`);
    connection.socket.write(serializeMessage({ type: "error", code, detail }));
    connection.socket.end();
    this.connections.delete(connection);
  }

  private reportInternalError(connection: BridgeConnection, errorValue: unknown): void {
    this.output.appendLine(`[bridge] internal error while processing a message: ${String(errorValue)}`);
    connection.socket.write(serializeMessage({ type: "error", code: "bridge.internalError" }));
    connection.socket.end();
    this.connections.delete(connection);
  }

  private currentProjectRoots(): readonly string[] {
    return this.projects.projects
      .map((project) => project.rootUri.fsPath.replaceAll("\\", "/"))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  private async writeDiscoveryRecord(): Promise<void> {
    if (this.recordPath === undefined || this.windowId === undefined || this.token === undefined || this.pipePath === undefined || this.tcpPort === undefined) {
      return;
    }

    const record = {
      formatVersion: BRIDGE_DISCOVERY_FORMAT_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      windowId: this.windowId,
      capabilities: [...BRIDGE_CAPABILITIES],
      projectRoots: this.currentProjectRoots(),
      pipePath: this.pipePath,
      tcpPort: this.tcpPort,
      token: this.token,
      pid: process.pid,
      generation: this.generation,
      startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(nodePath.dirname(this.recordPath)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(this.recordPath), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    } catch (errorValue) {
      this.output.appendLine(`[bridge] failed to publish discovery record: ${String(errorValue)}`);
    }
  }

  private async touchDiscoveryRecord(): Promise<void> {
    if (this.recordPath === undefined) {
      return;
    }

    try {
      const uri = vscode.Uri.file(this.recordPath);
      const current = await vscode.workspace.fs.readFile(uri);
      await vscode.workspace.fs.writeFile(uri, current);
    } catch {
      // The record was removed externally; the next project change rewrites it.
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
