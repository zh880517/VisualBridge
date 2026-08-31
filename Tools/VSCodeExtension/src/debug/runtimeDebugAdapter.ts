import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import { RuntimeBridgeDocumentSnapshot, RuntimeBridgeDocumentSource } from "../bridge/runtimeBridgeProtocol";
import { RuntimeBridgeInstance, RuntimeBridgeService } from "../bridge/runtimeBridgeService";

const RUNTIME_THREAD_ID = 1;
const RUNTIME_FRAME_ID = 1;
const MAX_VARIABLES_PER_LEVEL = 500;
const UNSUPPORTED_BREAKPOINT_MESSAGE = "VisualBridge runtime inspection does not support breakpoints.";
const NOT_ATTACHED_MESSAGE = "VisualBridge runtime inspection is not attached.";

/** DAP 只检查会话对外暴露的内部状态（E2E/测试断言用）。 */
export interface RuntimeDebugAdapterState {
  readonly connected: boolean;
  readonly leaseHeld: boolean;
  readonly instanceId: string;
  readonly documents: number;
  readonly topLevelVariables: number;
  readonly driftedDocuments: number;
  readonly driftedDocumentIds: readonly string[];
  readonly unknownSourceDocuments: number;
}

/** 变量树节点的一个子项；children 存在时惰性展开为下一层变量。 */
interface RuntimeVariableChild {
  readonly name: string;
  readonly value: string;
  readonly kind?: string;
  readonly indexedCount?: number;
  readonly children?: () => readonly RuntimeVariableChild[];
}

type DriftState = "true" | "false" | "unknown";

interface DapRequest {
  readonly seq: number;
  readonly type: "request";
  readonly command: string;
  readonly arguments?: Record<string, unknown>;
}

interface DapResponse {
  readonly seq: number;
  readonly type: "response";
  readonly request_seq: number;
  readonly success: boolean;
  readonly command: string;
  readonly message?: string;
  readonly body?: unknown;
}

interface DapEvent {
  readonly seq: number;
  readonly type: "event";
  readonly event: string;
  readonly body?: unknown;
}

/**
 * VisualBridge Runtime 的内联 DAP 只检查适配器（VB-UX-11 冻结范围）。
 * 如实声明能力：不支持断点/单步/pause/continue/evaluate；仅提供
 * 单伪线程、单帧 "Runtime Snapshot"、文档快照变量树与租约生命周期。
 * 一切调试状态来自 Runtime Bridge 协议，不建立第二份事实源。
 */
export class RuntimeDebugAdapter implements vscode.DebugAdapter {
  private readonly sendMessageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private readonly disposedEmitter = new vscode.EventEmitter<void>();
  private readonly variableNodes = new Map<number, () => readonly RuntimeVariableChild[]>();
  private nextSeq = 1;
  private nextNodeId = 1000;
  private attached = false;
  private leaseHeld = false;
  private documentCount = 0;
  private rootVariablesReference = 0;
  private rootChildCount = 0;
  private driftByDocument = new Map<string, DriftState>();
  private sourcePathsByDocument = new Map<string, readonly string[]>();

  public constructor(
    private readonly service: RuntimeBridgeService,
    private readonly instance: RuntimeBridgeInstance,
  ) {
  }

  public readonly onDidSendMessage = this.sendMessageEmitter.event;
  public readonly onDidDispose = this.disposedEmitter.event;

  public getInspectionState(): RuntimeDebugAdapterState {
    let drifted = 0;
    let unknown = 0;
    const driftedDocumentIds: string[] = [];
    for (const [documentId, state] of this.driftByDocument) {
      if (state === "true") {
        drifted += 1;
        driftedDocumentIds.push(documentId);
      } else if (state === "unknown") {
        unknown += 1;
      }
    }

    return {
      connected: this.attached,
      leaseHeld: this.leaseHeld,
      instanceId: this.instance.instanceId,
      documents: this.documentCount,
      topLevelVariables: this.rootChildCount,
      driftedDocuments: drifted,
      driftedDocumentIds,
      unknownSourceDocuments: unknown,
    };
  }

  public handleMessage(message: vscode.DebugProtocolMessage): void {
    if ((message as { readonly type?: unknown }).type !== "request") return;
    const request = message as unknown as DapRequest;
    switch (request.command) {
      case "initialize":
        this.sendResponse(request, true, {});
        break;
      case "attach":
        this.attach(request);
        break;
      case "disconnect":
        this.disconnect(request);
        break;
      case "threads":
        this.sendResponse(request, true, { threads: [{ id: RUNTIME_THREAD_ID, name: "VisualBridge Runtime" }] });
        break;
      case "stackTrace":
        this.sendResponse(request, true, {
          stackFrames: [{ id: RUNTIME_FRAME_ID, name: "Runtime Snapshot" }],
          totalFrames: 1,
        });
        break;
      case "scopes":
        this.scopes(request);
        break;
      case "variables":
        this.variables(request);
        break;
      case "setBreakpoints":
        this.setBreakpoints(request);
        break;
      case "configurationDone":
        this.sendResponse(request, true, {});
        break;
      default:
        this.sendResponse(
          request,
          false,
          undefined,
          `VisualBridge runtime inspection does not support '${request.command}'.`,
        );
        break;
    }
  }

  public dispose(): void {
    this.variableNodes.clear();
    this.sendMessageEmitter.dispose();
    this.disposedEmitter.fire();
    this.disposedEmitter.dispose();
  }

  private attach(request: DapRequest): void {
    void (async () => {
      try {
        const welcome = await this.service.connect(this.instance);
        if (!welcome.capabilities.includes("lease") || !welcome.capabilities.includes("snapshot")) {
          throw new Error(`Runtime instance '${welcome.instanceId}' does not provide the lease and snapshot capabilities.`);
        }

        await this.service.acquireLease();
        const [documents, sources] = await Promise.all([
          this.service.getSnapshot(),
          this.service.getDocumentSources(),
        ]);
        this.leaseHeld = true;
        this.documentCount = documents.length;
        this.driftByDocument = await this.computeDriftStates(documents, sources);
        this.buildRootNode(documents);
        this.attached = true;
        this.sendResponse(request, true, {});
        // 线程状态固定为 stopped（理由 attach），供调用栈/变量视图驱动。
        this.sendEvent("stopped", { reason: "attach", threadId: RUNTIME_THREAD_ID, allThreadsStopped: true });
      } catch (errorValue) {
        this.attached = false;
        this.leaseHeld = false;
        this.service.disconnect();
        this.sendResponse(request, false, undefined, `VisualBridge runtime attach failed: ${(errorValue as Error).message}`);
        this.sendEvent("terminated", {});
      }
    })();
  }

  private disconnect(request: DapRequest): void {
    void (async () => {
      try {
        if (this.leaseHeld) await this.service.releaseLease();
      } catch {
        // 租约释放尽力而为：连接断开时实例侧会自动释放。
      }

      this.leaseHeld = false;
      this.service.disconnect();
      this.attached = false;
      this.documentCount = 0;
      this.rootChildCount = 0;
      this.rootVariablesReference = 0;
      this.driftByDocument.clear();
      this.variableNodes.clear();
      this.sendResponse(request, true, {});
      this.sendEvent("terminated", {});
    })();
  }

  private scopes(request: DapRequest): void {
    if (!this.attached || this.rootVariablesReference === 0) {
      this.sendResponse(request, false, undefined, NOT_ATTACHED_MESSAGE);
      return;
    }

    const frameId = request.arguments?.frameId;
    if (frameId !== RUNTIME_FRAME_ID) {
      this.sendResponse(request, false, undefined, `Unknown stack frame ${String(frameId)}.`);
      return;
    }

    this.sendResponse(request, true, {
      scopes: [{ name: "Runtime Documents", variablesReference: this.rootVariablesReference, expensive: false }],
    });
  }

  private variables(request: DapRequest): void {
    if (!this.attached) {
      this.sendResponse(request, false, undefined, NOT_ATTACHED_MESSAGE);
      return;
    }

    const reference = request.arguments?.variablesReference;
    const childrenFactory = typeof reference === "number" ? this.variableNodes.get(reference) : undefined;
    if (childrenFactory === undefined) {
      this.sendResponse(request, false, undefined, `Unknown variables reference ${String(reference)}.`);
      return;
    }

    const allChildren = childrenFactory();
    const shown = allChildren.length > MAX_VARIABLES_PER_LEVEL
      ? allChildren.slice(0, MAX_VARIABLES_PER_LEVEL)
      : allChildren;
    const variables = shown.map((child) => this.toDapVariable(child));
    if (allChildren.length > shown.length) {
      variables.push({
        name: "__truncated",
        value: `${allChildren.length - shown.length} more entries hidden (showing ${shown.length})`,
        variablesReference: 0,
      });
    }

    this.sendResponse(request, true, { variables });
  }

  private setBreakpoints(request: DapRequest): void {
    const lines = request.arguments?.lines;
    const requested = request.arguments?.breakpoints;
    const rawBreakpoints = Array.isArray(requested)
      ? requested
      : Array.isArray(lines) ? lines.map((line) => ({ line })) : [];
    this.sendResponse(request, true, {
      breakpoints: rawBreakpoints.map(() => ({ verified: false, message: UNSUPPORTED_BREAKPOINT_MESSAGE })),
    });
  }

  private buildRootNode(documents: readonly RuntimeBridgeDocumentSnapshot[]): void {
    this.variableNodes.clear();
    const documentChildren = () => documents.map((document) => this.toDocumentChild(document));
    this.rootVariablesReference = this.allocateNode(documentChildren);
    this.rootChildCount = documents.length;
  }

  private toDocumentChild(document: RuntimeBridgeDocumentSnapshot): RuntimeVariableChild {
    // 文档节点固定附 __sourcePath / __sourceDrifted 两个信息变量，随后是 data 的递归字段。
    return {
      name: document.documentId,
      value: document.kind,
      kind: "class",
      children: () => [
        {
          name: "__sourcePath",
          value: this.sourcePathsByDocument.get(document.documentId)?.join("; ") ?? "(unmapped)",
          kind: "text",
        },
        {
          name: "__sourceDrifted",
          value: this.driftByDocument.get(document.documentId) ?? "unknown",
          kind: "other",
        },
        ...toFieldChildren(document.data),
      ],
    };
  }

  private async computeDriftStates(
    documents: readonly RuntimeBridgeDocumentSnapshot[],
    sources: readonly RuntimeBridgeDocumentSource[],
  ): Promise<Map<string, DriftState>> {
    this.sourcePathsByDocument = new Map();
    for (const source of sources) {
      const existing = this.sourcePathsByDocument.get(source.documentId) ?? [];
      this.sourcePathsByDocument.set(source.documentId, [...existing, source.sourcePath]);
    }

    const unityFolder = vscode.workspace.workspaceFolders
      ?.find((folder) => path.basename(folder.uri.fsPath) === "UnityProject");
    const result = new Map<string, DriftState>();
    for (const document of documents) {
      const documentSources = sources.filter((source) => source.documentId === document.documentId);
      if (documentSources.length === 0 || unityFolder === undefined) {
        result.set(document.documentId, "unknown");
        continue;
      }

      let drifted = false;
      let unresolved = false;
      for (const source of documentSources) {
        const filePath = path.join(unityFolder.uri.fsPath, "VisualBridgeAuthoring", ...source.sourcePath.split("/"));
        try {
          const fs = await import("fs");
          const bytes = await fs.promises.readFile(filePath);
          if (createHash("sha256").update(bytes).digest("hex") !== source.sourceSha256) drifted = true;
        } catch {
          unresolved = true;
        }
      }

      result.set(document.documentId, drifted ? "true" : unresolved ? "unknown" : "false");
    }

    return result;
  }

  private allocateNode(childrenFactory: () => readonly RuntimeVariableChild[]): number {
    this.nextNodeId += 1;
    this.variableNodes.set(this.nextNodeId, childrenFactory);
    return this.nextNodeId;
  }

  private toDapVariable(child: RuntimeVariableChild): Record<string, unknown> {
    const reference = child.children === undefined ? 0 : this.allocateNode(child.children);
    return {
      name: child.name,
      value: child.value,
      variablesReference: reference,
      ...(child.kind === undefined ? {} : { presentationHint: { kind: child.kind } }),
      ...(child.indexedCount === undefined ? {} : { indexedVariables: child.indexedCount }),
    };
  }

  private sendResponse(request: DapRequest, success: boolean, body?: unknown, errorMessage?: string): void {
    const response: DapResponse = {
      seq: this.nextSequence(),
      type: "response",
      request_seq: request.seq,
      success,
      command: request.command,
      ...(errorMessage === undefined ? {} : { message: errorMessage }),
      ...(body === undefined ? {} : { body }),
    };
    this.sendMessageEmitter.fire(response as unknown as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body?: unknown): void {
    const message: DapEvent = {
      seq: this.nextSequence(),
      type: "event",
      event,
      ...(body === undefined ? {} : { body }),
    };
    this.sendMessageEmitter.fire(message as unknown as vscode.DebugProtocolMessage);
  }

  private nextSequence(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }
}

function toFieldChildren(data: Record<string, unknown>): readonly RuntimeVariableChild[] {
  return Object.entries(data).map(([key, value]) => toValueChild(key, value));
}

function toValueChild(name: string, value: unknown): RuntimeVariableChild {
  if (value === null || value === undefined || typeof value !== "object") {
    return { name, value: formatScalar(value), kind: typeof value === "string" ? "text" : "other" };
  }

  if (Array.isArray(value)) {
    return {
      name,
      value: `Array(${value.length})`,
      kind: "other",
      indexedCount: value.length,
      children: () => value.map((entry, index) => toValueChild(String(index), entry)),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return {
    name,
    value: `Object(${entries.length})`,
    kind: "field",
    children: () => entries.map(([key, entry]) => toValueChild(key, entry)),
  };
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return typeof value;
}
