/**
 * 把模块 `debug` facet 的逐条渲染增量转交给**模块自己的 Webview**（G1a；G1d 补文档作用域）。
 *
 * 数据流（C.2/C.5 + D.4）：
 * `DebugInstanceManager` → `DebugRouter` → `DebugFacetHost`（模块 `onRecord`）→ 本桥 → Graph Webview。
 *
 * 本类只做消息投影与历史保留，不解析调试流、不调用模块代码，也不依赖 `vscode`：
 * - **逐条增量**：`DebugFacetHost.onDidRender` 每产出一条就转发 `debugFacetUpdate`；
 * - **水化**：Webview 晚打开（或 epoch 重载）时由宿主调 `snapshotMessages(target)` 取
 *   `debugFacetSnapshot`，内容是本桥保留的历史增量，`truncated` 标明窗口是否丢过最旧；
 * - **分类级重置**：`debugFacetReset` 后由宿主按目标重新水化（`onSnapshotNeeded`）。模块重载时
 *   宿主 `rebuild` 里的 replay 可能从关键帧开始（只补齐关键帧之后的增量），只用重放会让 Webview
 *   丢掉更早的时间轴；用本桥自己的历史补回去，Webview 再按 `seq` 去重（`update.seq` 单调）。
 *   快照由**宿主**发给具体会话：桥不知道有哪些 Webview 开着，也不该知道（G1d）。
 * - **会话切换**：`update.sessionId` 变化即视为新会话（`seq` 重新从 1 开始），先清历史再通知
 *   Webview 重置，避免旧会话的 `seq` 把新事件当成"已见过"。
 *
 * ## 文档作用域（G1d）
 *
 * 同一编辑器类型可以同时开多个文档（两个 `.vbgraph`），而一个执行实例只属于**一个**文档。
 * 被 G1b 删除的旧执行调试路径按"当前文档"过滤实例；facet 路径必须保持同样的文档作用域。
 *
 * 本桥的投递目标是 {@link DebugFacetWindowTarget}（editor + documentId），而不是 editor：
 * - 增量：`update.documentId`（模块透传的 `InstanceStarted`/`InstanceStopped` 载荷）给出归属；
 *   其余事件靠本桥按 `instanceId` 记住"该实例属于哪个文档"（同一分类、同一会话内有效）；
 * - 快照/resync：同样按 `documentId` 过滤（`snapshotFor`）。两侧用**同一个**
 *   `matchesDebugFacetDocument`，不允许"改了增量广播、快照仍按 editor"。
 * - **身份未知**（facet 记录里没有 `documentId`，例如从中途开始的录制）时按 editor 面投递，
 *   增量与快照都一样；这是与旧路径的已知差异（无法归属的数据宁可全显示，也不静默丢弃）。
 *   快照会按 `update.instanceId` **反查**实例归属：后续记录（如 `InstanceStopped`）学到
 *   documentId 后，早先的无归属条目在快照里会被追溯归属（不用改协议）；实时增量已发出，
 *   无法追溯，见任务报告。
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
 * 这里只有"回执"与"重新同步"两类，宿主按 `category` 定位窗口。
 */
export const DEBUG_FACET_ACK_MESSAGE = "debugFacetAck";
export const DEBUG_FACET_RESYNC_MESSAGE = "debugFacetResync";

/**
 * 一条增量/一份快照要发给谁（G1d）。
 *
 * `documentId` 缺省表示**身份未知**：宿主据此按 editor 面投递（无法作用域时宁可多显示，
 * 也不丢数据）。已知归属的**增量与历史条目**都只投给 `documentId` 相同的 Webview——
 * 增量与快照（含 resync）共用 {@link matchesDebugFacetDocument}，不允许只改一侧。
 */
export interface DebugFacetWindowTarget {
  readonly editor: string;
  readonly documentId?: string;
}

/**
 * 文档匹配规则：增量、快照、resync 与宿主侧"会话 ↔ 目标"过滤**只认这一份**（G1d 评审 P2.1）。
 *
 * 语义：只有"两边都知道身份且不同"才过滤；任一侧 `undefined` 都算匹配。
 * 这意味着身份未知的数据会按 editor 面投给**同 editor 的所有文档**（增量与快照都一样），
 * 是"多显示"而不是"错归属"：未知数据从不会被标成某个已知文档的。见任务报告的已知限制。
 */
export function matchesDebugFacetDocument(
  entryDocumentId: string | undefined,
  targetDocumentId: string | undefined,
): boolean {
  return targetDocumentId === undefined
    || entryDocumentId === undefined
    || entryDocumentId === targetDocumentId;
}

/** 发给 Webview 的快照历史条目（`documentId` 是宿主内部的路由信息，不进消息体）。 */
export interface DebugFacetHistoryEntry {
  readonly seq: number;
  readonly update: JsonValue;
}

/** 本桥保留的一条历史（比消息体多一个文档归属，用于快照/水化的按文档过滤）。 */
interface DebugFacetHistoryRecord extends DebugFacetHistoryEntry {
  readonly documentId?: string;
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
  /** 发到目标 Webview；返回发出数量（测试用，生产忽略）。 */
  readonly broadcast: (target: DebugFacetWindowTarget, message: DebugFacetWindowMessage) => number;
  /**
   * 分类级重建（`reload`/`replay`）之后要求宿主**按目标**重新水化。
   *
   * 为什么快照不在这里广播：按文档过滤后，每个 Webview 该收到的快照内容不同，而桥不知道
   * 有哪些 Webview 开着（也不该知道）。宿主拿到它的会话表后逐会话调用
   * `snapshotMessages({ editor, documentId })`，本桥只负责历史与过滤规则。
   * 参数是本桥实例：宿主据此确认请求来自**活动**桥（在线/回看互不污染）。
   */
  readonly onSnapshotNeeded?: (bridge: DebugFacetWindowBridge) => void;
  readonly log?: (message: string) => void;
  readonly historyLimit?: number;
}

interface CategoryHistory {
  readonly sessionId: string;
  readonly moduleId: string;
  readonly entries: DebugFacetHistoryRecord[];
  /** 该分类里"实例 → 产生它的文档"（G1d；只有带 `documentId` 的记录能写入）。 */
  readonly instanceDocuments: Map<string, string>;
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
    this.acknowledgements.clear();
  }

  /** 一条渲染增量：记录历史并转发（分组内的重复 `seq` 不再转发，防重放重复）。 */
  public render(event: DebugFacetRenderEvent): void {
    if (this.disposed) {
      return;
    }

    this.categoryEditor.set(event.category, event.editor);
    const update = event.update;
    const seq = readNumber(update, "seq");
    if (seq === undefined) {
      // 没有 seq 就无法去重/水化：不猜，按"该 facet 输出不合契约"记日志后丢弃转发。
      // 窗口内容仍由 DebugFacetHost 保留（面板可见），只是模块 Webview 收不到。
      this.options.log?.(`[debug] facet '${event.category}' produced a render update without a numeric seq.`);
      return;
    }

    const sessionId = readString(update, "sessionId");
    const session = sessionId ?? "";
    let history = this.histories.get(event.category);
    if (history === undefined || history.sessionId !== session) {
      // 新会话：先让 Webview 丢掉旧累积，再按旧 `seq` 去重会误丢新事件。
      if (history !== undefined) {
        this.broadcast({ editor: event.editor }, { type: DEBUG_FACET_RESET_MESSAGE, category: event.category });
      }
      history = {
        sessionId: session,
        moduleId: event.moduleId,
        entries: [],
        instanceDocuments: new Map(),
        truncated: false,
      };
      this.histories.set(event.category, history);
    }

    const lastEntry = history.entries[history.entries.length - 1];
    if (lastEntry !== undefined && seq <= lastEntry.seq) {
      return;
    }

    const documentId = this.documentOfUpdate(history, update);
    history.entries.push({
      seq,
      update,
      ...(documentId === undefined ? {} : { documentId }),
    });
    const limit = this.historyLimit();
    while (history.entries.length > limit) {
      history.entries.shift();
      history.truncated = true;
    }

    this.broadcast(
      { editor: event.editor, ...(documentId === undefined ? {} : { documentId }) },
      {
        type: DEBUG_FACET_UPDATE_MESSAGE,
        category: event.category,
        moduleId: event.moduleId,
        update,
      },
    );
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
      this.broadcast({ editor }, { type: DEBUG_FACET_RESET_MESSAGE, category: event.category });
      return;
    }

    // `reset` 是**分类级生命周期信号**（模块重建/显式重放），不是某个文档的数据：
    // 所有该 editor 的 Webview 都必须丢掉本地累积，所以这里按 editor 面广播（不带 documentId）。
    // 随后的快照必须按文档过滤，由宿主逐会话调用 `snapshotMessages`（`onSnapshotNeeded`）。
    this.broadcast({ editor }, { type: DEBUG_FACET_RESET_MESSAGE, category: event.category });
    if (this.histories.has(event.category)) {
      this.options.onSnapshotNeeded?.(this);
    }
  }

  /** 某个 Webview 的水化消息（每个已知分类一条快照；按分类名排序，结果确定）。 */
  public snapshotMessages(target: DebugFacetWindowTarget): readonly DebugFacetWindowMessage[] {
    const messages: DebugFacetWindowMessage[] = [];
    for (const category of [...this.histories.keys()].sort()) {
      if (this.categoryEditor.get(category) !== target.editor) {
        continue;
      }
      const message = this.snapshotFor(target, category);
      if (message !== undefined) {
        messages.push(message);
      }
    }

    return messages;
  }

  /**
   * 已知分类 → 归属 editor（G1d：宿主切换在线/回看时据此清空 Webview 本地累积）。
   * 只读快照，不动历史；顺序按分类名排序，结果确定。
   */
  public knownCategories(): readonly { readonly category: string; readonly editor: string }[] {
    return [...this.categoryEditor.entries()]
      .sort((left, right) => compareText(left[0], right[0]))
      .map(([category, editor]) => ({ category, editor }));
  }

  /**
   * 测试专用：忘掉"分类 → editor"的路由记忆（G1d 评审 P1 的"在线桥从未见过该分类"窗口）。
   *
   * 生产不提供"忘记分类"的语义：这里只清路由记忆，不动历史；历史仍由 `reset("session")` 清。
   * 用途是让宿主用例**脱离套件顺序**构造出"退出回看时只有回看桥知道该分类"的状态——
   * 若 detach 在清窗口之前就把回看桥置空，这个状态会暴露"回看时间轴残留"，该用例必红。
   */
  public forgetCategoriesForTest(): void {
    this.categoryEditor.clear();
  }

  /**
   * 处理模块 Webview 发来的调试 facet 消息。
   *
   * `replies` 由调用方（宿主会话）投回**发起消息的那个 Webview**，不能广播。
   */
  public handleWebviewMessage(
    target: DebugFacetWindowTarget,
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
      this.acknowledgements.set(targetKey(target), {
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
      const snapshot = category.length === 0 ? undefined : this.snapshotFor(target, category);
      return { handled: true, replies: snapshot === undefined ? [] : [snapshot] };
    }

    return { handled: false, replies: [] };
  }

  /** 最近一次回执（宿主测试读；生产只用于诊断）；按目标会话记，同 editor 的不同文档不互相覆盖。 */
  public lastAck(target: DebugFacetWindowTarget): DebugFacetAck | undefined {
    return this.acknowledgements.get(targetKey(target));
  }

  /**
   * 该增量属于哪个文档（G1d）。
   *
   * 两条来源，优先级明确：记录自带的 `documentId`（`InstanceStarted`/`InstanceStopped` 载荷）>
   * 本分类里该 `instanceId` 的最近一次已知归属。都没有就是 `undefined`（身份未知）。
   * 缓存按分类、随会话历史一起丢弃：新会话的 `instanceId` 可能被复用到另一个文档。
   */
  private documentOfUpdate(history: CategoryHistory, update: JsonValue): string | undefined {
    const declared = readString(update, "documentId");
    const instanceId = readString(update, "instanceId");
    if (declared !== undefined && instanceId !== undefined) {
      history.instanceDocuments.set(instanceId, declared);
      return declared;
    }

    if (instanceId === undefined) {
      return declared;
    }

    return history.instanceDocuments.get(instanceId) ?? declared;
  }

  /**
   * 快照条目的**有效**归属（G1d 评审补充 1：无协议变更的追溯归属）。
   *
   * 渲染时记下的 `documentId` 优先；没有就按 `update.instanceId` 反查本分类的实例缓存。
   * 于是"先以无归属进入历史、后来由 `InstanceStopped` 学到归属"的条目，在**快照/resync**
   * 里会被追溯归属，只出现在归属文档中。实时增量已经发出，无法追溯（见文件头与任务报告）。
   */
  private documentOfHistoryEntry(
    history: CategoryHistory,
    entry: DebugFacetHistoryRecord,
  ): string | undefined {
    if (entry.documentId !== undefined) {
      return entry.documentId;
    }

    const instanceId = readString(entry.update, "instanceId");
    return instanceId === undefined ? undefined : history.instanceDocuments.get(instanceId);
  }

  /** 按目标文档过滤后的快照；分类不属于该 editor 或没有历史时为 `undefined`。 */
  private snapshotFor(
    target: DebugFacetWindowTarget,
    category: string,
  ): DebugFacetWindowMessage | undefined {
    const history = this.histories.get(category);
    if (this.categoryEditor.get(category) !== target.editor || history === undefined) {
      return undefined;
    }
    const source = this.options.facets.windowSource(category);
    return {
      type: DEBUG_FACET_SNAPSHOT_MESSAGE,
      category,
      moduleId: history.moduleId,
      state: source === undefined ? "unavailable" : "active",
      truncated: history.truncated,
      updates: history.entries
        .filter((entry) => matchesDebugFacetDocument(
          this.documentOfHistoryEntry(history, entry),
          target.documentId,
        ))
        .map(({ seq, update }) => ({ seq, update })),
    };
  }

  private broadcast(target: DebugFacetWindowTarget, message: DebugFacetWindowMessage): void {
    try {
      this.options.broadcast(target, message);
    } catch (errorValue) {
      this.options.log?.(
        `[debug] failed to post '${message.type}' to '${target.editor}' webview: ${String(errorValue)}`,
      );
    }
  }

  private historyLimit(): number {
    const value = this.options.historyLimit ?? DEBUG_FACET_HISTORY_LIMIT;
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : DEBUG_FACET_HISTORY_LIMIT;
  }
}

/** 回执/快照的会话键：同 editor 的不同文档各记一份。 */
function targetKey(target: DebugFacetWindowTarget): string {
  return `${target.editor}\u0000${target.documentId ?? ""}`;
}

function readString(value: JsonValue, name: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as { readonly [key: string]: unknown })[name];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: JsonValue, name: string): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as { readonly [key: string]: unknown })[name];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
