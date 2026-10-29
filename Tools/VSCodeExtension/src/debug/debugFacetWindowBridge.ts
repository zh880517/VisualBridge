/**
 * 把模块 `debug` facet 的逐条渲染增量转交给**模块自己的 Webview**（G1a）。
 *
 * 数据流（C.2/C.5 + D.4）：
 * `DebugInstanceManager` → `DebugRouter` → `DebugFacetHost`（模块 `onRecord`）→ 本桥 → Graph Webview。
 *
 * 本类只做消息投影与历史保留，不解析调试流、不调用模块代码，也不依赖 `vscode`：
 * - **逐条增量**：`DebugFacetHost.onDidRender` 每产出一条就转发 `debugFacetUpdate`；
 * - **水化**：Webview 晚打开（或 epoch 重载）时发 `debugFacetSnapshot`，内容是本桥保留的
 *   历史增量，`truncated` 标明窗口是否丢过最旧；
 * - **分类级重置**：`debugFacetReset` 后立即补一份快照。模块重载时宿主 `rebuild` 里的
 *   replay 可能从关键帧开始（只补齐关键帧之后的增量），只用重放会让 Webview 丢掉更早的
 *   时间轴；用本桥自己的历史补回去，Webview 再按 `seq` 去重（`update.seq` 单调）。
 * - **会话切换**：`update.sessionId` 变化即视为新会话（`seq` 重新从 1 开始），先清历史再通知
 *   Webview 重置，避免旧会话的 `seq` 把新事件当成"已见过"。
 *
 * 历史上限与 `DebugFacetHost` 的保留窗口同源（`historyLimit`），两者都取
 * `DEBUG_FACET_HISTORY_LIMIT`；本桥多存一份是因为 `consumer.reset()` 会清空 facet 侧历史，
 * 而 Webview 在"重置 + 重放"过程中仍需要旧时间轴。
 */

import type { JsonValue } from "@visualbridge/module-sdk";
import {
  DEBUG_FACET_HISTORY_LIMIT,
  type DebugFacetRenderEvent,
  type DebugFacetResetEvent,
} from "./debugFacetRouter";

/** 宿主 → 模块 Webview 的调试 facet 消息类型（与 Graph Webview 的 `HostMessage` 对齐）。 */
export const DEBUG_FACET_UPDATE_MESSAGE = "debugFacetUpdate";
export const DEBUG_FACET_SNAPSHOT_MESSAGE = "debugFacetSnapshot";
export const DEBUG_FACET_RESET_MESSAGE = "debugFacetReset";

/**
 * 模块 Webview → 宿主的调试 facet 消息类型。
 *
 * 与旧 `graphExecution*` 无关：这里只有"回执"与"重新同步"两类，宿主按 `category` 定位窗口。
 */
export const DEBUG_FACET_ACK_MESSAGE = "debugFacetAck";
export const DEBUG_FACET_RESYNC_MESSAGE = "debugFacetResync";

export interface DebugFacetHistoryEntry {
  readonly seq: number;
  readonly update: JsonValue;
}

export type DebugFacetWindowMessage =
  | {
      readonly type: typeof DEBUG_FACET_UPDATE_MESSAGE;
      readonly category: string;
      readonly moduleId: string;
      readonly update: JsonValue;
    }
  | {
      readonly type: typeof DEBUG_FACET_SNAPSHOT_MESSAGE;
      readonly category: string;
      readonly moduleId: string;
      readonly state: "active" | "unavailable";
      readonly truncated: boolean;
      readonly updates: readonly DebugFacetHistoryEntry[];
    }
  | {
      readonly type: typeof DEBUG_FACET_RESET_MESSAGE;
      readonly category: string;
    };

/** Webview 回执（宿主测试据此断言"渲染增量的内容与顺序"）。 */
export interface DebugFacetAck {
  readonly category: string;
  readonly state: "follow" | "replay";
  readonly eventCount: number;
  readonly cursor: number;
  readonly executingNodeId: string | null;
  readonly instanceId?: string;
  /** 当前实例数（诊断/宿主用例断言"查询结果不得新增实例"）。 */
  readonly instanceCount?: number;
  /** 当前实例的聚合节点（诊断/宿主用例断言查询结果不得推进高亮）。 */
  readonly currentNodeId?: string | null;
  readonly frameIndex?: number;
  /** Webview 收到的增量批次数（宿主用例的"查询结果已处理"屏障）。 */
  readonly updateCount?: number;
}

export interface DebugFacetWindowSource {
  onDidRender(listener: (event: DebugFacetRenderEvent) => void): () => void;
  onDidReset(listener: (event: DebugFacetResetEvent) => void): () => void;
  windowSource(category: string): { readonly moduleId: string; readonly editor: string } | undefined;
}

export interface DebugFacetWindowBridgeOptions {
  readonly facets: DebugFacetWindowSource;
  /** 发到该 editor 的所有已打开 Webview；返回发出数量（测试用，生产忽略）。 */
  readonly broadcast: (editor: string, message: DebugFacetWindowMessage) => number;
  readonly log?: (message: string) => void;
  readonly historyLimit?: number;
}

interface CategoryHistory {
  readonly sessionId: string;
  readonly moduleId: string;
  readonly entries: DebugFacetHistoryEntry[];
  truncated: boolean;
}

export class DebugFacetWindowBridge {
  private readonly options: DebugFacetWindowBridgeOptions;
  private readonly histories = new Map<string, CategoryHistory>();
  private readonly categoryEditor = new Map<string, string>();
  private readonly acknowledgements = new Map<string, DebugFacetAck>();
  private readonly unsubscribe: (() => void)[] = [];
  private disposed = false;

  public constructor(options: DebugFacetWindowBridgeOptions) {
    this.options = options;
    this.unsubscribe.push(this.options.facets.onDidRender((event) => this.render(event)));
    this.unsubscribe.push(this.options.facets.onDidReset((event) => this.reset(event)));
  }

  public dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      unsubscribe();
    }
    this.histories.clear();
    this.categoryEditor.clear();
  }

  /** 一条渲染增量：记录历史并转发（分组内的重复 `seq` 不再转发，防重放重复）。 */
  public render(event: DebugFacetRenderEvent): void {
    if (this.disposed) {
      return;
    }

    this.categoryEditor.set(event.category, event.editor);
    const update = event.update;
    const seq = typeof update === "object" && update !== null && !Array.isArray(update)
      ? (update as { readonly seq?: unknown }).seq
      : undefined;
    const sessionId = typeof update === "object" && update !== null && !Array.isArray(update)
      ? (update as { readonly sessionId?: unknown }).sessionId
      : undefined;
    if (typeof seq !== "number" || !Number.isFinite(seq)) {
      // 没有 seq 就无法去重/水化：不猜，按"该 facet 输出不合契约"记日志后丢弃转发。
      // 窗口内容仍由 DebugFacetHost 保留（面板可见），只是模块 Webview 收不到。
      this.options.log?.(`[debug] facet '${event.category}' produced a render update without a numeric seq.`);
      return;
    }

    const session = typeof sessionId === "string" ? sessionId : "";
    let history = this.histories.get(event.category);
    if (history === undefined || history.sessionId !== session) {
      // 新会话：先让 Webview 丢掉旧累积，再按旧 `seq` 去重会误丢新事件。
      if (history !== undefined) {
        this.broadcast(event.editor, { type: DEBUG_FACET_RESET_MESSAGE, category: event.category });
      }
      history = { sessionId: session, moduleId: event.moduleId, entries: [], truncated: false };
      this.histories.set(event.category, history);
    }

    const lastEntry = history.entries[history.entries.length - 1];
    if (lastEntry !== undefined && seq <= lastEntry.seq) {
      return;
    }

    history.entries.push({ seq, update });
    const limit = this.historyLimit();
    while (history.entries.length > limit) {
      history.entries.shift();
      history.truncated = true;
    }

    this.broadcast(event.editor, {
      type: DEBUG_FACET_UPDATE_MESSAGE,
      category: event.category,
      moduleId: event.moduleId,
      update,
    });
  }

  /** 分类级重置：模块重载保留历史回填；会话作废则清空（C.3）。 */
  public reset(event: DebugFacetResetEvent): void {
    if (this.disposed) {
      return;
    }

    if (event.editor.length > 0) {
      this.categoryEditor.set(event.category, event.editor);
    }
    const editor = this.categoryEditor.get(event.category);
    if (editor === undefined) {
      return;
    }

    if (event.reason === "session") {
      // 新会话的 `seq` 从 1 重新开始；旧时间轴继续留着会把上一会话的事件展示成当前执行。
      this.histories.delete(event.category);
      this.broadcast(editor, { type: DEBUG_FACET_RESET_MESSAGE, category: event.category });
      return;
    }

    this.broadcast(editor, { type: DEBUG_FACET_RESET_MESSAGE, category: event.category });
    this.broadcastSnapshot(editor, event.category);
  }

  /** 某个 editor 的 Webview 水化消息（每个已知分类一条快照；按分类名排序，结果确定）。 */
  public snapshotMessages(editor: string): readonly DebugFacetWindowMessage[] {
    const messages: DebugFacetWindowMessage[] = [];
    for (const category of [...this.histories.keys()].sort()) {
      if (this.categoryEditor.get(category) !== editor) {
        continue;
      }
      const message = this.snapshotFor(editor, category);
      if (message !== undefined) {
        messages.push(message);
      }
    }

    return messages;
  }

  /**
   * 处理模块 Webview 发来的调试 facet 消息。
   *
   * `replies` 由调用方（宿主会话）投回**发起消息的那个 Webview**，不能广播。
   */
  public handleWebviewMessage(
    editor: string,
    message: Readonly<Record<string, unknown>>,
  ): { readonly handled: boolean; readonly replies: readonly DebugFacetWindowMessage[] } {
    if (this.disposed) {
      return { handled: false, replies: [] };
    }

    if (message.type === DEBUG_FACET_ACK_MESSAGE) {
      const category = typeof message.category === "string" ? message.category : "";
      if (category.length === 0 || typeof message.eventCount !== "number" || typeof message.cursor !== "number") {
        return { handled: true, replies: [] };
      }
      this.acknowledgements.set(editor, {
        category,
        state: message.state === "replay" ? "replay" : "follow",
        eventCount: message.eventCount,
        cursor: message.cursor,
        executingNodeId: typeof message.executingNodeId === "string" ? message.executingNodeId : null,
        ...(typeof message.instanceId === "string" ? { instanceId: message.instanceId } : {}),
        ...(typeof message.instanceCount === "number" ? { instanceCount: message.instanceCount } : {}),
        ...(typeof message.currentNodeId === "string" || message.currentNodeId === null
          ? { currentNodeId: message.currentNodeId }
          : {}),
        ...(typeof message.frameIndex === "number" ? { frameIndex: message.frameIndex } : {}),
        ...(typeof message.updateCount === "number" ? { updateCount: message.updateCount } : {}),
      });
      return { handled: true, replies: [] };
    }

    if (message.type === DEBUG_FACET_RESYNC_MESSAGE) {
      const category = typeof message.category === "string" ? message.category : "";
      const snapshot = category.length === 0 ? undefined : this.snapshotFor(editor, category);
      return { handled: true, replies: snapshot === undefined ? [] : [snapshot] };
    }

    return { handled: false, replies: [] };
  }

  /** 最近一次回执（宿主测试读；生产只用于诊断）。 */
  public lastAck(editor: string): DebugFacetAck | undefined {
    return this.acknowledgements.get(editor);
  }

  private snapshotFor(editor: string, category: string): DebugFacetWindowMessage | undefined {
    const history = this.histories.get(category);
    const owner = this.categoryEditor.get(category);
    if (owner !== editor || history === undefined) {
      return undefined;
    }
    const source = this.options.facets.windowSource(category);
    return {
      type: DEBUG_FACET_SNAPSHOT_MESSAGE,
      category,
      moduleId: history.moduleId,
      state: source === undefined ? "unavailable" : "active",
      truncated: history.truncated,
      updates: [...history.entries],
    };
  }

  private broadcastSnapshot(editor: string, category: string): void {
    const snapshot = this.snapshotFor(editor, category);
    if (snapshot !== undefined) {
      this.broadcast(editor, snapshot);
    }
  }

  private broadcast(editor: string, message: DebugFacetWindowMessage): void {
    try {
      this.options.broadcast(editor, message);
    } catch (errorValue) {
      this.options.log?.(`[debug] failed to post '${message.type}' to '${editor}' webview: ${String(errorValue)}`);
    }
  }

  private historyLimit(): number {
    const value = this.options.historyLimit ?? DEBUG_FACET_HISTORY_LIMIT;
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : DEBUG_FACET_HISTORY_LIMIT;
  }
}
