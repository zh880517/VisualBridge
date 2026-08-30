import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  compareUtf16CodeUnits,
  PROJECT_PROVIDER_PROTOCOL_VERSION,
  parseProjectProviderHostMessage,
  parseProjectProviderResponse,
  type ProjectProviderCapabilities,
  type ProjectProviderDefinition,
  type ProjectProviderMethod,
  type ProjectProviderRequestId,
} from "@visualbridge/core";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_CANCELLATION_GRACE_MS = 500;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_STABLE_AFTER_MS = 60_000;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_LINE_BYTES = 16 * 1024;

export type ProjectProviderRuntimeState =
  | "stopped"
  | "starting"
  | "ready"
  | "backoff"
  | "quarantined"
  | "disposed";

export type ProjectProviderSourceManifestEntry = {
  readonly path: string;
  readonly hash: string;
  readonly expectedAbsent?: never;
} | {
  readonly path: string;
  readonly hash?: never;
  readonly expectedAbsent: true;
};

export interface ProjectProviderInvocationOptions {
  /** Re-captured before and after every Provider interaction; the caller owns source-set discovery. */
  readonly captureSourceManifest: () => Promise<readonly ProjectProviderSourceManifestEntry[]>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ProjectProviderLogEvent {
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warning" | "error";
  readonly event: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly state: ProjectProviderRuntimeState;
  readonly message?: string;
  readonly pid?: number;
  readonly method?: string;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly details?: unknown;
}

export type ProjectProviderLogSink = (event: ProjectProviderLogEvent) => void;

export interface ProjectProviderRuntimeOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly projectHash: string;
  readonly definition: ProjectProviderDefinition;
  /** Exact absolute entry paths authorized by the host policy. */
  readonly allowedEntryPaths: readonly string[];
  readonly log?: ProjectProviderLogSink;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly cancellationGraceMs?: number;
  readonly restart?: {
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly maxAttempts?: number;
    readonly stableAfterMs?: number;
  };
}

export interface ProjectProviderProjectChange {
  readonly projectId: string;
  readonly projectHash: string;
  readonly documentSetHash: string;
  readonly revision: number;
}

export class ProjectProviderRuntimeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectProviderRuntimeError";
  }
}

export class ProjectProviderExternalModificationError extends ProjectProviderRuntimeError {
  public constructor(
    public readonly changedPaths: readonly string[],
    underlyingError?: unknown,
  ) {
    super(
      "provider.externalModification",
      `Project Provider modified Authoring source(s) outside the VisualBridge transaction boundary: ${changedPaths.join(", ")}.`,
      {
        changedPaths,
        ...(underlyingError === undefined ? {} : { underlyingError: describeError(underlyingError) }),
      },
      underlyingError instanceof Error ? { cause: underlyingError } : undefined,
    );
    this.name = "ProjectProviderExternalModificationError";
  }
}

interface PendingRequest {
  readonly id: ProjectProviderRequestId;
  readonly method: ProjectProviderMethod;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly abortSignal?: AbortSignal;
  readonly abortListener?: () => void;
}

interface CancelledRequest {
  readonly timer?: NodeJS.Timeout;
  readonly settle: () => void;
}

interface ManifestSnapshot {
  readonly entries: readonly ProjectProviderSourceManifestEntry[];
  readonly hashes: ReadonlyMap<string, string | undefined>;
}

export class ProjectProviderRuntime implements AsyncDisposable {
  private stateValue: ProjectProviderRuntimeState = "stopped";
  private readonly pending = new Map<ProjectProviderRequestId, PendingRequest>();
  private readonly cancelled = new Map<ProjectProviderRequestId, CancelledRequest>();
  private readonly settlements = new Set<Promise<void>>();
  private processValue: ChildProcessWithoutNullStreams | undefined;
  private processGeneration = 0;
  private expectedExitGeneration: number | undefined;
  private nextRequestId = 1;
  private startPromise: Promise<void> | undefined;
  private restartAttempts = 0;
  private restartNotBefore = 0;
  private readySince = 0;
  private capabilitiesValue: ProjectProviderCapabilities | undefined;
  private projectHashValue: string;
  private latestManifestCapture: ProjectProviderInvocationOptions["captureSourceManifest"] | undefined;
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrBuffer = "";

  private constructor(
    private readonly projectRoot: string,
    private readonly entryPath: string,
    private readonly options: ProjectProviderRuntimeOptions,
  ) {
    this.projectHashValue = options.projectHash;
  }

  public static async create(options: ProjectProviderRuntimeOptions): Promise<ProjectProviderRuntime> {
    const projectRoot = await resolveProjectRoot(options.projectRoot);
    const entryPath = await resolveProviderEntry(projectRoot, options.definition.entry);
    await assertAllowedEntry(entryPath, options.allowedEntryPaths);
    validatePositiveTimeout(options.initializeTimeoutMs, "initializeTimeoutMs");
    validatePositiveTimeout(options.requestTimeoutMs, "requestTimeoutMs");
    validatePositiveTimeout(options.shutdownTimeoutMs, "shutdownTimeoutMs");
    validatePositiveTimeout(options.cancellationGraceMs, "cancellationGraceMs");
    validateRestartOptions(options.restart);
    return new ProjectProviderRuntime(projectRoot, entryPath, options);
  }

  public get state(): ProjectProviderRuntimeState {
    return this.stateValue;
  }

  public get capabilities(): ProjectProviderCapabilities | undefined {
    return this.capabilitiesValue;
  }

  public get generation(): number {
    return this.processGeneration;
  }

  public async captureEntryHash(): Promise<string> {
    return createHash("sha256").update(await readFile(this.entryPath)).digest("hex");
  }

  public async start(invocation: ProjectProviderInvocationOptions): Promise<ProjectProviderCapabilities> {
    await this.guarded(invocation.captureSourceManifest, () => this.ensureReady(invocation.signal));
    return this.capabilitiesValue!;
  }

  public async request(
    method: ProjectProviderMethod,
    params: unknown,
    invocation: ProjectProviderInvocationOptions,
  ): Promise<unknown> {
    if (method === "initialize" || method === "capabilities" || method === "shutdown") {
      throw new ProjectProviderRuntimeError(
        "provider.reservedMethod",
        `Project Provider method '${method}' is managed by the Node Host runtime.`,
      );
    }
    return this.guarded(invocation.captureSourceManifest, async () => {
      await this.ensureReady(invocation.signal);
      return this.sendRequest(
        method,
        params,
        invocation.timeoutMs ?? this.requestTimeoutMs,
        invocation.signal,
      );
    });
  }

  public async projectChanged(
    change: ProjectProviderProjectChange,
    invocation: ProjectProviderInvocationOptions,
  ): Promise<void> {
    if (change.projectId !== this.options.projectId) {
      throw new ProjectProviderRuntimeError(
        "provider.projectMismatch",
        `Project change '${change.projectId}' does not match '${this.options.projectId}'.`,
      );
    }
    await this.guarded(invocation.captureSourceManifest, async () => {
      await this.ensureReady(invocation.signal);
      this.sendNotification("projectChanged", change);
      await yieldEventLoop();
      this.projectHashValue = change.projectHash;
    });
  }

  public async dispose(): Promise<void> {
    if (this.stateValue === "disposed") return;
    const processValue = this.processValue;
    const generation = this.processGeneration;
    const captureManifest = this.latestManifestCapture;
    let disposeError: unknown;
    try {
      const shutdown = async (): Promise<void> => {
        if (processValue !== undefined && processValue === this.processValue && this.stateValue === "ready") {
          await this.sendRequest("shutdown", {}, this.shutdownTimeoutMs).catch((errorValue: unknown) => {
            disposeError = errorValue;
          });
        }
      };
      if (captureManifest === undefined) {
        await shutdown();
      } else {
        await this.guarded(captureManifest, shutdown);
      }
    } catch (errorValue) {
      disposeError = errorValue;
    } finally {
      this.stateValue = "disposed";
      this.expectedExitGeneration = generation;
      this.rejectAll(new ProjectProviderRuntimeError("provider.disposed", "Project Provider runtime was disposed."));
      await this.terminateChild(processValue, generation);
      this.log("info", "provider.disposed");
    }
    if (disposeError !== undefined) throw disposeError;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private get initializeTimeoutMs(): number {
    return this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private get shutdownTimeoutMs(): number {
    return this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  private get cancellationGraceMs(): number {
    return this.options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS;
  }

  private async ensureReady(signal?: AbortSignal): Promise<void> {
    this.throwIfUnavailable();
    if (this.stateValue === "ready" && this.processValue !== undefined) return;
    if (this.startPromise !== undefined) return abortable(this.startPromise, signal);

    const starting = this.startProcess(signal);
    this.startPromise = starting;
    const clearStarting = (): void => {
      if (this.startPromise === starting) this.startPromise = undefined;
    };
    void starting.then(clearStarting, clearStarting);
    return abortable(starting, signal);
  }

  private async startProcess(signal?: AbortSignal): Promise<void> {
    this.throwIfUnavailable();
    const delayMs = Math.max(0, this.restartNotBefore - Date.now());
    if (delayMs > 0) {
      this.stateValue = "backoff";
      this.log("warning", "provider.restartBackoff", {
        attempt: this.restartAttempts,
        delayMs,
      });
      await delay(delayMs, signal);
    }
    this.throwIfUnavailable();
    if (signal?.aborted === true) throw cancelledError();

    this.stateValue = "starting";
    const generation = ++this.processGeneration;
    this.expectedExitGeneration = undefined;
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stderrDecoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    const child = spawn(process.execPath, [this.entryPath, ...this.options.definition.args], {
      cwd: this.projectRoot,
      env: sanitizedEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.processValue = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(generation, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(generation, chunk));
    child.once("error", (errorValue) => this.onProcessFault(generation, errorValue));
    child.once("exit", (code, signalValue) => this.onProcessExit(generation, code, signalValue));
    this.log("info", "provider.spawned", child.pid === undefined ? {} : { pid: child.pid });

    try {
      await this.sendRequest(
        "initialize",
        {
          protocolVersion: PROJECT_PROVIDER_PROTOCOL_VERSION,
          providerId: this.options.definition.id,
          project: { projectId: this.options.projectId, projectHash: this.projectHashValue },
        },
        this.initializeTimeoutMs,
        signal,
      );
      const result = await this.sendRequest(
        "capabilities",
        {},
        this.initializeTimeoutMs,
        signal,
      );
      const capabilities = readCapabilitiesResult(result);
      assertCapabilitiesAllowed(this.options.definition.capabilities, capabilities);
      this.capabilitiesValue = capabilities;
      this.readySince = Date.now();
      this.stateValue = "ready";
      this.log("info", "provider.ready", child.pid === undefined ? {} : { pid: child.pid });
    } catch (errorValue) {
      const fault = errorValue instanceof ProjectProviderRuntimeError
        ? errorValue
        : new ProjectProviderRuntimeError(
          "provider.initializeFailed",
          `Project Provider initialization failed: ${describeError(errorValue)}.`,
          undefined,
          errorValue instanceof Error ? { cause: errorValue } : undefined,
        );
      this.rejectAll(fault);
      await this.faultProcess(generation, fault);
      throw fault;
    }
  }

  private sendRequest(
    method: ProjectProviderMethod,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.processValue;
    if (child === undefined || child.stdin.destroyed) {
      return Promise.reject(new ProjectProviderRuntimeError(
        "provider.unavailable",
        `Project Provider '${this.options.definition.id}' is not running.`,
      ));
    }
    if (signal?.aborted === true) return Promise.reject(cancelledError());
    const id = this.nextRequestId++;
    const request = parseHostMessage({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const errorValue = new ProjectProviderRuntimeError(
          "provider.timeout",
          `Project Provider method '${method}' timed out after ${timeoutMs} ms.`,
          { method, timeoutMs },
        );
        this.cancelPending(id, errorValue, true);
        this.log("error", "provider.requestTimeout", { method, details: { timeoutMs } });
      }, timeoutMs);
      const abortListener = signal === undefined ? undefined : () => {
        this.cancelPending(id, cancelledError(), false);
      };
      const pending: PendingRequest = {
        id,
        method,
        resolve,
        reject,
        timer,
        ...(signal === undefined ? {} : { abortSignal: signal }),
        ...(abortListener === undefined ? {} : { abortListener }),
      };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", abortListener!, { once: true });
      child.stdin.write(`${JSON.stringify(request)}\n`, (errorValue) => {
        if (errorValue !== null && errorValue !== undefined) {
          this.finishPending(id, undefined, new ProjectProviderRuntimeError(
            "provider.writeFailed",
            `Unable to write Project Provider request '${method}': ${errorValue.message}.`,
            undefined,
            { cause: errorValue },
          ));
        }
      });
    });
  }

  private sendNotification(method: "projectChanged", params: unknown): void {
    const child = this.processValue;
    if (child === undefined || child.stdin.destroyed) {
      throw new ProjectProviderRuntimeError(
        "provider.unavailable",
        `Project Provider '${this.options.definition.id}' is not running.`,
      );
    }
    const notification = parseHostMessage({ jsonrpc: "2.0", method, params });
    child.stdin.write(`${JSON.stringify(notification)}\n`);
  }

  private onStdout(generation: number, chunk: Buffer): void {
    if (generation !== this.processGeneration) return;
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_PROTOCOL_LINE_BYTES && !this.stdoutBuffer.includes("\n")) {
      void this.faultProcess(generation, new ProjectProviderRuntimeError(
        "provider.messageTooLarge",
        `Project Provider stdout exceeded ${MAX_PROTOCOL_LINE_BYTES} bytes without a newline.`,
      ));
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.onProtocolLine(generation, line);
      if (generation !== this.processGeneration) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onProtocolLine(generation: number, line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      void this.faultProcess(generation, new ProjectProviderRuntimeError(
        "provider.messageTooLarge",
        `Project Provider response exceeded ${MAX_PROTOCOL_LINE_BYTES} bytes.`,
      ));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (errorValue) {
      void this.faultProcess(generation, new ProjectProviderRuntimeError(
        "provider.invalidJson",
        `Project Provider emitted invalid JSON on stdout: ${describeError(errorValue)}.`,
      ));
      return;
    }
    const id = readResponseId(value);
    if (id === undefined) {
      void this.faultProcess(generation, new ProjectProviderRuntimeError(
        "provider.invalidResponse",
        "Project Provider emitted a response without a valid request id.",
      ));
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      const cancelled = this.cancelled.get(id);
      if (cancelled !== undefined) {
        if (cancelled.timer !== undefined) clearTimeout(cancelled.timer);
        this.cancelled.delete(id);
        cancelled.settle();
        return;
      }
      void this.faultProcess(generation, new ProjectProviderRuntimeError(
        "provider.unknownResponse",
        `Project Provider responded to unknown request id '${String(id)}'.`,
      ));
      return;
    }
    const parsed = parseProjectProviderResponse(value, pending.method);
    if (!parsed.success) {
      void this.faultProcess(generation, new ProjectProviderRuntimeError(
        "provider.invalidResponse",
        `Project Provider returned an invalid '${pending.method}' response: ${formatIssues(parsed.issues)}.`,
        { method: pending.method, issues: parsed.issues },
      ));
      return;
    }
    if (parsed.value.id !== id) {
      void this.faultProcess(generation, new ProjectProviderRuntimeError(
        "provider.invalidResponseId",
        `Project Provider response id '${String(parsed.value.id)}' does not match '${String(id)}'.`,
      ));
      return;
    }
    if ("error" in parsed.value) {
      this.finishPending(id, undefined, new ProjectProviderRuntimeError(
        "provider.remoteError",
        `Project Provider method '${pending.method}' failed: ${parsed.value.error.message}`,
        { method: pending.method, error: parsed.value.error },
      ));
      return;
    }
    const result = readResponseResult(parsed.value);
    this.finishPending(id, result);
  }

  private onStderr(generation: number, chunk: Buffer): void {
    if (generation !== this.processGeneration) return;
    this.stderrBuffer += this.stderrDecoder.write(chunk);
    let newline = this.stderrBuffer.indexOf("\n");
    while (newline >= 0) {
      this.emitStderr(this.stderrBuffer.slice(0, newline).replace(/\r$/, ""));
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      newline = this.stderrBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stderrBuffer, "utf8") > MAX_STDERR_LINE_BYTES) {
      this.emitStderr(`${truncateUtf8(this.stderrBuffer, MAX_STDERR_LINE_BYTES)}… [truncated]`);
      this.stderrBuffer = "";
      this.stderrDecoder = new StringDecoder("utf8");
    }
  }

  private emitStderr(message: string): void {
    if (message.length === 0) return;
    this.log("info", "provider.stderr", { message: truncateUtf8(message, MAX_STDERR_LINE_BYTES) });
  }

  private onProcessFault(generation: number, errorValue: Error): void {
    if (generation !== this.processGeneration) return;
    void this.faultProcess(generation, new ProjectProviderRuntimeError(
      "provider.crashed",
      `Project Provider process failed: ${errorValue.message}.`,
      undefined,
      { cause: errorValue },
    ));
  }

  private onProcessExit(generation: number, code: number | null, signalValue: NodeJS.Signals | null): void {
    if (generation !== this.processGeneration) return;
    if (this.stderrBuffer.length > 0) {
      this.emitStderr(this.stderrBuffer);
      this.stderrBuffer = "";
    }
    const expected = this.expectedExitGeneration === generation || this.stateValue === "disposed";
    this.processValue = undefined;
    this.capabilitiesValue = undefined;
    if (expected) return;
    const errorValue = new ProjectProviderRuntimeError(
      "provider.crashed",
      `Project Provider exited unexpectedly (code=${String(code)}, signal=${String(signalValue)}).`,
      { code, signal: signalValue },
    );
    this.rejectAll(errorValue);
    this.recordCrash(errorValue);
  }

  private faultProcess(generation: number, errorValue: ProjectProviderRuntimeError): Promise<void> {
    const settlement = this.faultProcessCore(generation, errorValue);
    this.trackSettlement(settlement);
    return settlement;
  }

  private async faultProcessCore(generation: number, errorValue: ProjectProviderRuntimeError): Promise<void> {
    if (generation !== this.processGeneration) return;
    const child = this.processValue;
    const shouldRecordCrash = child !== undefined || (this.stateValue !== "backoff" && this.stateValue !== "quarantined");
    this.rejectAll(errorValue);
    this.expectedExitGeneration = generation;
    this.processValue = undefined;
    this.capabilitiesValue = undefined;
    await this.terminateChild(child, generation);
    if (shouldRecordCrash && this.stateValue !== "disposed" && this.stateValue !== "quarantined") {
      this.recordCrash(errorValue);
    }
  }

  private recordCrash(errorValue: ProjectProviderRuntimeError): void {
    if (this.readySince > 0 && Date.now() - this.readySince >= this.stableAfterMs) {
      this.restartAttempts = 0;
    }
    this.readySince = 0;
    this.restartAttempts += 1;
    if (this.restartAttempts > this.maxRestartAttempts) {
      this.stateValue = "quarantined";
      this.log("error", "provider.quarantined", {
        attempt: this.restartAttempts,
        message: errorValue.message,
      });
      return;
    }
    const delayMs = Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * (2 ** Math.max(0, this.restartAttempts - 1)),
    );
    this.restartNotBefore = Date.now() + delayMs;
    this.stateValue = "backoff";
    this.log("warning", "provider.crashed", {
      attempt: this.restartAttempts,
      delayMs,
      message: errorValue.message,
    });
  }

  private cancelPending(id: ProjectProviderRequestId, errorValue: ProjectProviderRuntimeError, killAfterGrace: boolean): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.cleanupPending(pending);
    this.pending.delete(id);
    pending.reject(errorValue);
    this.writeCancellation(id);
    const generation = this.processGeneration;
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    this.trackSettlement(settlement);
    const timer = setTimeout(() => {
      this.cancelled.delete(id);
      const stopping = killAfterGrace
        ? this.faultProcess(generation, new ProjectProviderRuntimeError(
          "provider.unresponsive",
          `Project Provider did not settle cancelled request '${String(id)}'.`,
        ))
        : this.stopAfterCancellation(generation);
      void stopping.then(settle, settle);
    }, this.cancellationGraceMs);
    this.cancelled.set(id, { timer, settle });
  }

  private writeCancellation(id: ProjectProviderRequestId): void {
    const child = this.processValue;
    if (child === undefined || child.stdin.destroyed) return;
    const notification = parseHostMessage({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
    child.stdin.write(`${JSON.stringify(notification)}\n`);
  }

  private finishPending(id: ProjectProviderRequestId, result?: unknown, errorValue?: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.cleanupPending(pending);
    if (errorValue === undefined) pending.resolve(result);
    else pending.reject(errorValue);
  }

  private cleanupPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.abortSignal !== undefined && pending.abortListener !== undefined) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    }
  }

  private rejectAll(errorValue: unknown): void {
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(errorValue);
    }
    this.pending.clear();
    for (const cancelled of this.cancelled.values()) {
      if (cancelled.timer !== undefined) clearTimeout(cancelled.timer);
      cancelled.settle();
    }
    this.cancelled.clear();
  }

  private async terminateChild(
    child: ChildProcessWithoutNullStreams | undefined,
    generation: number,
  ): Promise<void> {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const exited = await waitForExit(child, this.shutdownTimeoutMs);
    if (!exited && generation === this.processGeneration) child.kill("SIGKILL");
  }

  private async guarded<T>(
    captureSourceManifest: ProjectProviderInvocationOptions["captureSourceManifest"],
    action: () => Promise<T>,
  ): Promise<T> {
    const before = await this.captureManifest(await captureSourceManifest());
    this.latestManifestCapture = captureSourceManifest;
    let result: T | undefined;
    let actionError: unknown;
    try {
      result = await action();
    } catch (errorValue) {
      actionError = errorValue;
    }
    await this.waitForSettlements();
    let changedPaths: readonly string[];
    try {
      const after = await this.captureManifest(await captureSourceManifest());
      changedPaths = compareManifestSnapshots(before, after);
    } catch (errorValue) {
      changedPaths = manifestFailurePaths(errorValue);
    }
    if (changedPaths.length > 0) {
      this.stateValue = "quarantined";
      const errorValue = new ProjectProviderExternalModificationError(changedPaths, actionError);
      this.log("error", "provider.externalModification", {
        message: errorValue.message,
        details: { changedPaths },
      });
      this.rejectAll(errorValue);
      const child = this.processValue;
      const generation = this.processGeneration;
      this.expectedExitGeneration = generation;
      this.processValue = undefined;
      await this.terminateChild(child, generation);
      throw errorValue;
    }
    if (actionError !== undefined) throw actionError;
    return result!;
  }

  private async stopAfterCancellation(generation: number): Promise<void> {
    if (generation !== this.processGeneration) return;
    const child = this.processValue;
    this.expectedExitGeneration = generation;
    this.processValue = undefined;
    this.capabilitiesValue = undefined;
    this.rejectAll(cancelledError());
    await this.terminateChild(child, generation);
    if (this.stateValue !== "disposed" && this.stateValue !== "quarantined") {
      this.stateValue = "stopped";
      this.restartNotBefore = 0;
    }
  }

  private trackSettlement(settlement: Promise<void>): void {
    this.settlements.add(settlement);
    const remove = (): void => { this.settlements.delete(settlement); };
    void settlement.then(remove, remove);
  }

  private async waitForSettlements(): Promise<void> {
    while (this.settlements.size > 0) {
      await Promise.allSettled([...this.settlements]);
    }
  }

  private async captureManifest(
    manifest: readonly ProjectProviderSourceManifestEntry[],
  ): Promise<ManifestSnapshot> {
    if (manifest.length === 0) {
      throw new ProjectProviderRuntimeError(
        "provider.emptySourceManifest",
        "Project Provider source manifest must contain the Project marker and complete Authoring source set.",
      );
    }
    const entries = [...manifest].sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    const seen = new Set<string>();
    const hashes = new Map<string, string | undefined>();
    for (const entry of entries) {
      validateLogicalPath(entry.path, "Authoring source");
      const identity = pathIdentity(entry.path);
      if (seen.has(identity)) {
        throw new ProjectProviderRuntimeError(
          "provider.duplicateSource",
          `Authoring source manifest contains duplicate path '${entry.path}'.`,
        );
      }
      seen.add(identity);
      if (entry.expectedAbsent !== true && !/^[a-f0-9]{64}$/.test(entry.hash)) {
        throw new ProjectProviderRuntimeError(
          "provider.invalidSourceHash",
          `Authoring source '${entry.path}' must use a lowercase SHA-256 hash.`,
          { path: entry.path },
        );
      }
      const actualHash = await this.readSourceHash(entry.path);
      const expectedHash = entry.expectedAbsent === true ? undefined : entry.hash;
      if (actualHash !== expectedHash) {
        throw new ProjectProviderRuntimeError(
          "provider.sourceManifestMismatch",
          `Authoring source '${entry.path}' changed before the Project Provider request.`,
          { path: entry.path, expectedHash, actualHash },
        );
      }
      hashes.set(entry.path, actualHash);
    }
    return { entries, hashes };
  }

  private async readSourceHash(logicalPath: string): Promise<string | undefined> {
    const absolutePath = path.resolve(this.projectRoot, ...logicalPath.split("/"));
    ensureInside(this.projectRoot, absolutePath, logicalPath);
    const resolvedParent = await realpath(path.dirname(absolutePath));
    ensureInside(this.projectRoot, resolvedParent, logicalPath);
    const physicalPath = path.join(resolvedParent, path.basename(absolutePath));
    if (pathIdentity(physicalPath) !== pathIdentity(absolutePath)) {
      throw new ProjectProviderRuntimeError(
        "provider.sourcePathAlias",
        `Authoring source '${logicalPath}' resolves through a path alias.`,
      );
    }
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(absolutePath);
    } catch (errorValue) {
      if (isNodeError(errorValue, "ENOENT")) return undefined;
      throw errorValue;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new ProjectProviderRuntimeError(
        "provider.sourcePathAlias",
        `Authoring source '${logicalPath}' is not a regular physical file.`,
      );
    }
    const resolved = await realpath(absolutePath);
    if (pathIdentity(resolved) !== pathIdentity(absolutePath)) {
      throw new ProjectProviderRuntimeError(
        "provider.sourcePathAlias",
        `Authoring source '${logicalPath}' resolves through a path alias.`,
      );
    }
    return hashBytes(await readFile(resolved));
  }

  private throwIfUnavailable(): void {
    if (this.stateValue === "disposed") {
      throw new ProjectProviderRuntimeError("provider.disposed", "Project Provider runtime was disposed.");
    }
    if (this.stateValue === "quarantined") {
      throw new ProjectProviderRuntimeError(
        "provider.quarantined",
        `Project Provider '${this.options.definition.id}' is quarantined after repeated failure or external modification.`,
      );
    }
  }

  private get initialBackoffMs(): number {
    return this.options.restart?.initialDelayMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  }

  private get maxBackoffMs(): number {
    return this.options.restart?.maxDelayMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  private get maxRestartAttempts(): number {
    return this.options.restart?.maxAttempts ?? DEFAULT_MAX_RESTARTS;
  }

  private get stableAfterMs(): number {
    return this.options.restart?.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
  }

  private log(
    level: ProjectProviderLogEvent["level"],
    event: string,
    fields: Partial<Omit<ProjectProviderLogEvent, "timestamp" | "level" | "event" | "projectId" | "providerId" | "state">> = {},
  ): void {
    this.options.log?.({
      timestamp: new Date().toISOString(),
      level,
      event,
      projectId: this.options.projectId,
      providerId: this.options.definition.id,
      state: this.stateValue,
      ...fields,
    });
  }
}

async function resolveProjectRoot(projectRoot: string): Promise<string> {
  const resolved = await realpath(path.resolve(projectRoot));
  const entry = await lstat(resolved);
  if (!entry.isDirectory()) {
    throw new ProjectProviderRuntimeError("provider.invalidProjectRoot", "Project root must be a physical directory.");
  }
  return resolved;
}

async function resolveProviderEntry(projectRoot: string, relativeEntry: string): Promise<string> {
  validateLogicalPath(relativeEntry, "Project Provider entry");
  if (path.extname(relativeEntry).toLowerCase() !== ".mjs") {
    throw new ProjectProviderRuntimeError(
      "provider.invalidEntry",
      "Project Provider V2 entry must be a project-relative '.mjs' file.",
    );
  }
  const candidate = path.resolve(projectRoot, ...relativeEntry.split("/"));
  ensureInside(projectRoot, candidate, relativeEntry);
  const entry = await lstat(candidate).catch((errorValue: unknown) => {
    throw new ProjectProviderRuntimeError(
      "provider.entryUnavailable",
      `Project Provider entry '${relativeEntry}' is unavailable: ${describeError(errorValue)}.`,
      undefined,
      errorValue instanceof Error ? { cause: errorValue } : undefined,
    );
  });
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ProjectProviderRuntimeError(
      "provider.entryAlias",
      `Project Provider entry '${relativeEntry}' must be a regular physical file, not a symlink or directory.`,
    );
  }
  const resolved = await realpath(candidate);
  ensureInside(projectRoot, resolved, relativeEntry);
  if (pathIdentity(candidate) !== pathIdentity(resolved)) {
    throw new ProjectProviderRuntimeError(
      "provider.entryAlias",
      `Project Provider entry '${relativeEntry}' resolves through a path alias.`,
    );
  }
  return resolved;
}

async function assertAllowedEntry(entryPath: string, allowedEntryPaths: readonly string[]): Promise<void> {
  if (allowedEntryPaths.length === 0) {
    throw new ProjectProviderRuntimeError(
      "provider.entryNotAllowed",
      "Project Provider entry is not authorized by the host allowlist.",
    );
  }
  for (const allowedPath of allowedEntryPaths) {
    if (!path.isAbsolute(allowedPath)) {
      throw new ProjectProviderRuntimeError(
        "provider.invalidAllowlist",
        "Project Provider allowlist entries must be exact absolute paths.",
      );
    }
    let resolved: string;
    try {
      resolved = await realpath(allowedPath);
    } catch {
      continue;
    }
    if (pathIdentity(path.resolve(allowedPath)) !== pathIdentity(resolved)) {
      throw new ProjectProviderRuntimeError(
        "provider.invalidAllowlist",
        `Project Provider allowlist entry '${allowedPath}' resolves through a path alias.`,
      );
    }
    if (pathIdentity(resolved) === pathIdentity(entryPath)) return;
  }
  throw new ProjectProviderRuntimeError(
    "provider.entryNotAllowed",
    `Project Provider entry '${entryPath}' is not authorized by the host allowlist.`,
  );
}

function parseHostMessage(value: unknown): unknown {
  const parsed = parseProjectProviderHostMessage(value);
  if (!parsed.success) {
    throw new ProjectProviderRuntimeError(
      "provider.invalidHostRequest",
      `Node Host constructed an invalid Project Provider message: ${formatIssues(parsed.issues)}.`,
      { issues: parsed.issues },
    );
  }
  return parsed.value;
}

function readCapabilitiesResult(value: unknown): ProjectProviderCapabilities {
  if (!isRecord(value) || !isRecord(value.capabilities)) {
    throw new ProjectProviderRuntimeError(
      "provider.invalidCapabilities",
      "Project Provider capabilities response did not contain capabilities.",
    );
  }
  return value.capabilities as unknown as ProjectProviderCapabilities;
}

function assertCapabilitiesAllowed(
  declared: ProjectProviderCapabilities,
  actual: ProjectProviderCapabilities,
): void {
  const undeclaredKinds = actual.reference?.kinds.filter((kind) => !declared.reference?.kinds.includes(kind)) ?? [];
  const undeclaredDocumentTypes = actual.validator?.documentTypes
    .filter((documentType) => !declared.validator?.documentTypes.includes(documentType)) ?? [];
  if (undeclaredKinds.length > 0 || undeclaredDocumentTypes.length > 0) {
    throw new ProjectProviderRuntimeError(
      "provider.capabilityMismatch",
      "Project Provider runtime capabilities exceed the capabilities authorized by the Project declaration.",
      { declared, actual, undeclaredKinds, undeclaredDocumentTypes },
    );
  }
}

function readResponseId(value: unknown): ProjectProviderRequestId | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.id === "string" || typeof value.id === "number"
    ? value.id as ProjectProviderRequestId
    : undefined;
}

function readResponseResult(value: unknown): unknown {
  return isRecord(value) && "result" in value ? value.result : undefined;
}

function validateLogicalPath(value: string, label: string): void {
  if (
    value.length === 0
    || value.includes("\\")
    || value.includes(":")
    || value.startsWith("/")
    || path.isAbsolute(value)
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ProjectProviderRuntimeError(
      "provider.invalidPath",
      `${label} must be a normalized project-relative path using '/' separators.`,
    );
  }
}

function ensureInside(root: string, candidate: string, displayPath: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectProviderRuntimeError(
      "provider.pathOutsideProject",
      `Project Provider path '${displayPath}' leaves the Project root.`,
    );
  }
}

function validatePositiveTimeout(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new ProjectProviderRuntimeError("provider.invalidOptions", `${label} must be a positive finite number.`);
  }
}

function validateRestartOptions(value: ProjectProviderRuntimeOptions["restart"]): void {
  validatePositiveTimeout(value?.initialDelayMs, "restart.initialDelayMs");
  validatePositiveTimeout(value?.maxDelayMs, "restart.maxDelayMs");
  validatePositiveTimeout(value?.stableAfterMs, "restart.stableAfterMs");
  if (value?.maxAttempts !== undefined && (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 0)) {
    throw new ProjectProviderRuntimeError(
      "provider.invalidOptions",
      "restart.maxAttempts must be a non-negative integer.",
    );
  }
  if (
    value?.initialDelayMs !== undefined
    && value.maxDelayMs !== undefined
    && value.maxDelayMs < value.initialDelayMs
  ) {
    throw new ProjectProviderRuntimeError(
      "provider.invalidOptions",
      "restart.maxDelayMs must be greater than or equal to restart.initialDelayMs.",
    );
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowedNames = process.platform === "win32"
    ? ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "PATHEXT"]
    : ["HOME", "TMPDIR", "PATH", "LANG", "LC_ALL"];
  const environment = Object.fromEntries(allowedNames.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  if (process.versions.electron !== undefined) {
    environment.ELECTRON_RUN_AS_NODE = "1";
  }
  return environment;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareManifestSnapshots(
  before: ManifestSnapshot,
  after: ManifestSnapshot,
): readonly string[] {
  const paths = new Set([...before.hashes.keys(), ...after.hashes.keys()]);
  return [...paths]
    .filter((sourcePath) => before.hashes.get(sourcePath) !== after.hashes.get(sourcePath)
      || !before.hashes.has(sourcePath)
      || !after.hashes.has(sourcePath))
    .sort(compareUtf16CodeUnits);
}

function manifestFailurePaths(errorValue: unknown): readonly string[] {
  if (errorValue instanceof ProjectProviderRuntimeError && isRecord(errorValue.details)) {
    const sourcePath = errorValue.details.path;
    if (typeof sourcePath === "string") return [sourcePath];
  }
  return ["<source-manifest>"];
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function formatIssues(issues: readonly { readonly path: string; readonly message: string }[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function describeError(errorValue: unknown): string {
  return errorValue instanceof Error ? `${errorValue.name}: ${errorValue.message}` : String(errorValue);
}

function cancelledError(): ProjectProviderRuntimeError {
  return new ProjectProviderRuntimeError("provider.cancelled", "Project Provider request was cancelled.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(errorValue: unknown, code: string): errorValue is NodeJS.ErrnoException {
  return errorValue instanceof Error && "code" in errorValue && errorValue.code === code;
}

function truncateUtf8(value: string, byteLimit: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= byteLimit ? value : bytes.subarray(0, byteLimit).toString("utf8");
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw cancelledError();
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      if (listener !== undefined) signal?.removeEventListener("abort", listener);
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, milliseconds);
    const listener = signal === undefined ? undefined : () => {
      clearTimeout(timer);
      finish();
      reject(cancelledError());
    };
    signal?.addEventListener("abort", listener!, { once: true });
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let listening = false;
    const cleanup = (): void => {
      if (listening) signal.removeEventListener("abort", onAbort);
      listening = false;
    };
    const onAbort = (): void => {
      cleanup();
      reject(cancelledError());
    };
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (errorValue: unknown) => {
        cleanup();
        reject(errorValue);
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    listening = true;
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
