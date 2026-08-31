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
  RuntimeBridgeErrorMessage,
  RuntimeBridgeEventMessage,
  RuntimeBridgeLeaseRequest,
  RuntimeBridgeProtocolError,
  RuntimeBridgeResponseMessage,
  RuntimeBridgeSnapshotRequest,
  RuntimeBridgeSourcesRequest,
  RuntimeBridgeWelcomeMessage,
  serializeRuntimeBridgeMessage,
} from "./runtimeBridgeProtocol";

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
}

export class RuntimeBridgeService {
  private connection: RuntimeBridgeConnection | undefined;
  private eventListener: ((event: RuntimeBridgeEventMessage) => void) | undefined;

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
    const connection = new RuntimeBridgeConnection(instance, this.output, (event) => this.eventListener?.(event));
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
  }



  public setEventListener(listener: ((event: RuntimeBridgeEventMessage) => void) | undefined): void {
    this.eventListener = listener === undefined ? undefined : listener;
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

class RuntimeBridgeConnection {
  private socket: net.Socket | undefined;
  private lineBuffer = "";
  private pendingLines: string[] = [];
  private lineWaiters: ((line: string) => void)[] = [];
  private readonly events: RuntimeBridgeEventMessage[] = [];
  private welcome: RuntimeBridgeWelcomeMessage | undefined;
  private snapshotCount = 0;
  private disposed = false;

  public constructor(
    private readonly instance: RuntimeBridgeInstance,
    private readonly output: (message: string) => void,
    private readonly onEvent: (event: RuntimeBridgeEventMessage) => void,
  ) {
  }

  public get state(): RuntimeBridgeConnectionState {
    if (this.welcome === undefined) {
      return { connected: false };
    }

    return {
      connected: !this.disposed,
      instanceId: this.welcome.instanceId,
      kind: this.welcome.kind,
      generation: this.welcome.generation,
      lastSnapshotCount: this.snapshotCount,
      lastEventCount: this.events.length,
    };
  }

  public connect(timeoutMs: number): Promise<RuntimeBridgeWelcomeMessage> {
    return new Promise<RuntimeBridgeWelcomeMessage>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: this.instance.tcpPort });
      this.socket = socket;
      let settled = false;
      const onError = (errorValue: Error): void => finish(errorValue, undefined);
      const onClose = (): void => finish(new Error("Runtime bridge connection closed before welcome."), undefined);
      const finish = (errorValue: Error | undefined, welcome: RuntimeBridgeWelcomeMessage | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (errorValue === undefined && welcome !== undefined) {
          // 握手成功：data 监听保留，供后续请求/响应与事件使用。
          resolve(welcome);
        } else {
          socket.destroy();
          reject(errorValue ?? new Error("Runtime bridge connection failed."));
        }
      };
      const timer = setTimeout(() => finish(new Error("Runtime bridge connect timed out."), undefined), timeoutMs);
      socket.on("error", onError);
      socket.on("connect", () => {
        socket.write(serializeRuntimeBridgeMessage({
          type: "hello",
          protocolVersion: 1,
          coreVersion: 1,
          token: this.instance.token,
          clientInstanceId: randomUUID(),
          capabilities: [...RUNTIME_BRIDGE_CAPABILITIES],
        }));
      });
      socket.on("data", (chunk) => {
        this.lineBuffer += chunk.toString("utf8");
        let newlineIndex = this.lineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = this.lineBuffer.slice(0, newlineIndex);
          this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
          this.handleLine(line, finish);
          newlineIndex = this.lineBuffer.indexOf("\n");
        }
      });
      socket.on("close", onClose);
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

  private async request(payload: RuntimeBridgeSnapshotRequest | RuntimeBridgeLeaseRequest | RuntimeBridgeSourcesRequest): Promise<RuntimeBridgeResponseMessage> {
    if (this.welcome === undefined) {
      throw new RuntimeBridgeProtocolError("runtime.invalidMessage", "$", "Runtime bridge is not connected.");
    }

    // 先注册行等待器再写请求，避免响应在等待器就位前到达被丢弃。
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const linePromise = this.waitForLine(deadline);
      this.socket?.write(serializeRuntimeBridgeMessage(payload));
      const line = await linePromise;
      const message = parseRuntimeBridgeMessage(JSON.parse(line));
      if (message.type === "response" && message.requestId === payload.requestId) {
        return message;
      }

      if (message.type === "error") {
        throw new RuntimeBridgeProtocolError(message.code, "$", message.detail ?? "Runtime bridge reported an error.");
      }

      this.handleMessage(message);
    }

    throw new Error("Runtime bridge request timed out.");
  }

  public dispose(): void {
    this.disposed = true;
    this.socket?.destroy();
    this.socket = undefined;
    for (const waiter of this.lineWaiters.splice(0)) {
      waiter("");
    }
  }

  private handleLine(line: string, finish?: (errorValue: Error | undefined, welcome: RuntimeBridgeWelcomeMessage | undefined) => void): void {
    if (line.trim().length === 0) return;
    let message: ReturnType<typeof parseRuntimeBridgeMessage>;
    try {
      message = parseRuntimeBridgeMessage(JSON.parse(line));
    } catch (errorValue) {
      this.output(`Runtime bridge received an unparseable line: ${(errorValue as Error).message}`);
      finish?.(errorValue as Error, undefined);
      return;
    }

    if (this.welcome === undefined) {
      if (message.type === "welcome") {
        this.welcome = message;
        finish?.(undefined, message);
      } else {
        const detail = message.type === "error" ? message.detail ?? message.code : `Expected a welcome message, received '${message.type}'.`;
        finish?.(new Error(detail), undefined);
      }

      return;
    }

    const waiter = this.lineWaiters.shift();
    if (waiter !== undefined) {
      waiter(line);
      return;
    }

    this.handleMessage(message);
  }

  private handleMessage(message: ReturnType<typeof parseRuntimeBridgeMessage>): void {
    if (message.type === "event") {
      this.events.push(message);
      this.onEvent(message);
    } else if (message.type === "error") {
      this.output(`Runtime bridge connection-level error: ${message.code}${message.detail === undefined ? "" : ` (${message.detail})`}`);
    }
  }

  private waitForLine(deadline: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.lineWaiters.indexOf(waiter);
        if (index >= 0) this.lineWaiters.splice(index, 1);
        reject(new Error("Runtime bridge response timed out."));
      }, Math.max(1, deadline - Date.now()));
      const waiter = (line: string) => {
        clearTimeout(timer);
        if (line.length === 0) reject(new Error("Runtime bridge connection closed."));
        else resolve(line);
      };

      this.lineWaiters.push(waiter);
    });
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
