/**
 * 模块 `debug` facet 的宿主路由（F4 / 附录 D.4、C.5）。
 *
 * 职责边界：
 * - **宿主拥有数据面**：`DebugInstanceManager` 已经把字节解码成内部 `DebugRecord`；这里只把它
 *   投影成公开契约的 `DebugRecord`（SDK/D.4 的 `seq`/`sessionId`/`params`/`at`），模块拿不到
 *   原始字节。
 * - **复用既有路由**：把每个 facet 包装成 `DebugConsumer` 注册进 F2 的 `DebugRouter`，
 *   不另建"分类 → 消费者"表。分类冲突的裁决仍由 `DebugRouter`（注册序第一个）+ ModuleLoader
 *   的 `module.editorConflict` 负责。
 * - **异常隔离**：`onRecord` 在**异步批投递**里抛错时，路由层看不到（`consume()` 已返回），
 *   因此由本类调用 `DebugRouter.markCategoryFallback` 上报；该分类立即改投通用视图。
 * - **dispose 后立即失效**：`rebuild`/`dispose` 先注销消费者并取消待投批次，之后不会再有
 *   `onRecord` 调用。这一点不能只靠"结果仍然正确"证明：若路由未失效，抛错会被回退机制
 *   吃成一次正常降级，生命周期缺陷会被伪装成正常降级（F4 追加验收 A）。
 *
 * 批量上限（P1）：`DEBUG_FACET_BATCH_LIMIT` 条/批，批与批之间交还事件循环（`setTimeout(0)`），
 * 因此单帧内的模块代码调用次数有界；超限**不丢记录**（队列保留、下一批继续），也不做背压
 * （宿主已经收下并存储了记录，丢弃会破坏"记录不丢"）。
 */

import { cloneJsonValue, isJsonValue } from "@visualbridge/core";
import type {
  DebugFacet,
  DebugRecord as PublicDebugRecord,
  DebugRenderUpdate,
  EditorContext,
  JsonValue,
  ModuleLogFunction,
} from "@visualbridge/module-sdk";
import type { DebugCategoryReplayResult } from "../bridge/debugInstanceManager";
import type { DebugConsumer, DebugResetReason, DebugRouter } from "../bridge/debugRouter";
import type { DebugRecord as HostDebugRecord } from "../bridge/debugStore";
import { assertDebugFacetCode, type DebugFacetErrorCode } from "./debugFacetDiagnostics";

/**
 * 每批最多投递给模块多少条记录（F4 P1）。
 *
 * 依据：
 * - 面板一次渲染的时间轴窗口是 `DEBUG_PANEL_WINDOW_RECORDS = 500` 条（`debugPanelState.ts`），
 *   面板刷新周期 200 ms；一批 100 条 = 一个窗口的 1/5，留在同一帧预算内。
 * - 接收侧本来就有 50 ms 的批通知窗口；`DebugStore` 的 20000 条上限说明"整批同步处理"
 *   （例如回放）才是卡顿来源，而不是单条。
 * - **手工观测，不是用例断言**：开发时用一个做少量 JSON 组装的 facet 处理 100 条约
 *   0.1–0.5 ms（默认 Node 单线程）。`debugFacetRouter.test.ts` **没有**任何计时断言
 *   （这里不写"实测"来冒充门禁：计时断言对机器噪声敏感，故意不加，以免制造不稳定门禁）。
 *   该数字只用于选 100：它远小于 60 Hz 一帧 16.7 ms；即便模块代码慢 30 倍，一批仍在一帧内，
 *   而两批之间强制让出事件循环。
 *
 * 选 100 而不是更大：上限的意义是"单次任务有界"，不是吞吐；分批的固定开销（一个定时器）
 * 相对于 100 次模块调用可以忽略。
 */
export const DEBUG_FACET_BATCH_LIMIT = 100;

/**
 * 单个渲染增量的输出上限（UTF-8 字节，F4 返修 P2-6）。
 *
 * 依据：面板每 200 ms 全量 `postMessage` 一次快照，`content` 是其中**唯一由模块决定大小**的字段；
 * 5 次/秒 × 64 KiB ≈ 320 KiB/s，与一条 Webview 状态消息的量级相符，也给通用窗口的时间轴
 * （500 条记录 / 次）留足余额。超过它不是"视图大了点"，而是模块把原始数据塞进了渲染增量
 * （D.4：模块只返回渲染增量、拿不到原始字节），按契约违例处理：计数、可定位诊断、该分类回退
 * 通用视图——记录仍在 store 与通用视图里，不会丢。
 */
export const DEBUG_FACET_CONTENT_MAX_BYTES = 64 * 1024;

/** 一个已装载模块的 debug facet + 它需要的宿主上下文。 */
export interface DebugFacetSource {
  readonly moduleId: string;
  /** Project File 中 `modules` 的下标（诊断路径 `modules[i]...` 用）。 */
  readonly moduleIndex: number;
  readonly editor: string;
  readonly facet: DebugFacet;
  readonly context: EditorContext<unknown>;
  /** 可定位的 JSON Pointer，例如 `modules[0].editors[1].debug`。 */
  readonly path: string;
}

/**
 * facet 诊断码（取值域见 `debugFacetDiagnostics.ts` 的 `DEBUG_FACET_ERROR_CODES`）。
 *
 * 别名而不是本地联合：清单是唯一真源，新增码只改清单；本地再写一遍字面量就会漂移
 * （F4 返修 P1 的教训：`module.renderTooLarge` 曾只活在这个联合里）。
 */
export type DebugFacetDiagnosticCode = DebugFacetErrorCode;

export interface DebugFacetDiagnostic {
  readonly code: DebugFacetDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  /** 定位：`modules[i].editors[j].debug`（或 `...debug.categories[k]`）。 */
  readonly path: string;
}

/**
 * 一条已投递给模块、并成功产出的渲染增量（G1a）。
 *
 * 与窗口快照的 `content`（只保留最后一条）不同，这里逐条保留，供模块自己的 Webview
 * （Graph 执行调试窗口）消费：宿主拥有数据面，模块 Webview 只消费增量，不解析调试流。
 */
export interface DebugFacetRenderEvent {
  readonly category: string;
  readonly moduleId: string;
  readonly editor: string;
  /** `onRecord` 的返回值（已做 JSON 收口与大小校验）。 */
  readonly update: JsonValue;
}

/** 分类级重建/清空：模块 Webview 必须丢掉本地累积状态，随后会收到重放的增量。 */
export interface DebugFacetResetEvent {
  readonly category: string;
  readonly moduleId: string;
  readonly editor: string;
  /**
   * `reload`：模块重载/重新授权，facet 侧历史被清空但执行仍在，桥要补回自己保留的时间轴；
   * `replay`：从头重放，同样保留；`session`：调试会话作废，旧时间轴必须一起清掉（C.3）。
   */
  readonly reason: "reload" | DebugResetReason;
}

/**
 * 每个分类保留多少条历史渲染增量（G1a）。
 *
 * 与 C.4 的每实例 20000 条上限同量级但不相等：增量只是时间轴投影（每条几十字节），
 * 保留窗口用于"Webview 晚打开/重载后水化"，超出部分标 `truncated`。选 5000 是 20000 的 1/4：
 * 一次水化约 1–2 MB，远低于 `DEBUG_FACET_CONTENT_MAX_BYTES` × 单批的宿主预算，
 * 同时覆盖常见的单次执行长度；更长的执行仍能从当前时刻继续追加。
 */
export const DEBUG_FACET_HISTORY_LIMIT = 5000;

/** 一次显式分类级重建的结果（`partial` 必须展示，不能被吞掉）。 */
export interface DebugFacetReplayView {
  readonly fromKeyframe: boolean;
  readonly keyframeId: number | undefined;
  readonly applied: number;
  readonly partial: boolean;
}

export interface DebugFacetWindow {
  readonly category: string;
  /** 窗口状态：模块在消费 / 已回退通用视图 / 没有模块认领。 */
  readonly state: "active" | "fallback" | "unavailable";
  /** **宿主所有**的标题（模块只提供内容与建议标题）。 */
  readonly title: string;
  /** 模块在 D.4 里声明的建议标题（`windowTitle`）；只展示，不决定窗口结构。 */
  readonly moduleTitle: string | undefined;
  readonly moduleId: string | undefined;
  readonly editor: string | undefined;
  readonly path: string | undefined;
  /** 宿主给用户的提示（"模块未加载"/回退原因等）。 */
  readonly message: string | undefined;
  /** 宿主所有的工具条动作 id（渲染与命令由宿主决定）。 */
  readonly toolbar: readonly string[];
  readonly records: number;
  readonly batches: number;
  readonly pending: number;
  readonly content: JsonValue | undefined;
  readonly updatedAt: number | undefined;
  /** 实例级清空之后尚未做分类级重建（见 `DebugInstanceManager.clearInstance`）。 */
  readonly stale: boolean;
  /**
   * "按分类重建"是否真的能改变什么（F4 返修 P1、P2-1）。
   *
   * 只有该分类**有活动的主消费者**（`state === "active"`）**且仍有可见/待投记录**时才为真：
   * - 回退 `fallback` 与未加载 `unavailable` 时 `replayCategory` 必然返回 `undefined`
   *   （`DebugRouter.hasOwner` 为假）；
   * - 实例全被淘汰只剩墓碑时，`manager.replay` 因 `stores.length === 0` 返回 `undefined`
   *   （P2-1），按钮不能只因为 `state === "active"` 就可用。
   *
   * 面板的按钮可用性、元信息与提示文案**全部**由它驱动，避免"按钮禁用、提示却让用户去点"。
   */
  readonly rebuildable: boolean;
  readonly diagnostics: readonly DebugFacetDiagnostic[];
  /** 最近一次显式分类级重建的结果。 */
  readonly replay: DebugFacetReplayView | undefined;
}

export interface DebugFacetSnapshot {
  readonly windows: readonly DebugFacetWindow[];
  /** 还没投给模块的记录数（跨分类）。 */
  readonly pending: number;
  readonly batches: number;
  readonly failures: number;
  readonly batchLimit: number;
  /**
   * 已注销的 facet 消费者在注销之后又被投递的次数（必须恒为 0）。
   *
   * 验收 A 用它把"生命周期失效"与"onRecord 抛错被正常降级"区分开：只断言"结果仍正确"无法
   * 证明记录没有继续喂给已经销毁的模块。
   */
  readonly lateRecords: number;
  /** 观察者（`GenericDebugConsumer`）的计数：与 facet 的"双向断言"用。 */
  readonly generic: {
    readonly records: number;
    readonly dropped: number;
  };
}

export interface DebugFacetHostOptions {
  readonly router: DebugRouter;
  /** 分类级重建（真实宿主接 `DebugInstanceManager.replay`；省略表示不支持）。 */
  readonly replay?: (category: string) => DebugCategoryReplayResult | undefined;
  /** 当前有记录的分类（窗口即使没模块认领也要显示"模块未加载"）。 */
  readonly knownCategories?: () => readonly string[];
  /** 实例级清空后的陈旧标记（真实宿主接 `DebugInstanceManager.isCategoryStale`）。 */
  readonly isCategoryStale?: (category: string) => boolean;
  /**
   * 该分类是否还有 `replay()` 可用的数据源（F4 返修 P2-1）。
   *
   * 真实宿主接 `DebugInstanceManager.hasReplayableCategoryRecords`：分类实例全被淘汰、
   * 只剩墓碑时该方法为假，`replay()` 也因 `stores.length === 0` 返回 `undefined`。省略表示
   * 宿主不提供（测试/嵌入方），按"有"处理，保持 `rebuildable` 只由 `state` 与 `replay` 决定。
   */
  readonly hasReplayableRecords?: (category: string) => boolean;
  /** 公开契约里的 `sessionId`（宿主 bridge 会话）；缺省空串。 */
  readonly sessionId?: () => string;
  readonly log?: (message: string) => void;
  readonly batchLimit?: number;
  /** 每投递一批回调一次（测试断言"每批 ≤ 上限"与批次数；生产可接诊断）。 */
  readonly onBatch?: (category: string, size: number) => void;
  /** 每条成功产出的渲染增量（G1a：转发给模块 Webview）。 */
  readonly onRender?: (event: DebugFacetRenderEvent) => void;
  /** 分类级重置（重建/清空；G1a：模块 Webview 丢掉本地累积）。 */
  readonly onReset?: (event: DebugFacetResetEvent) => void;
  /** 历史增量保留上限；缺省 {@link DEBUG_FACET_HISTORY_LIMIT}。 */
  readonly historyLimit?: number;
  readonly setTimer?: (callback: () => void) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

/** `ManualTimer` 形状的注入点，单测不等真实时间。 */
const defaultSetTimer = (callback: () => void): unknown => {
  const handle = setTimeout(callback, 0);
  (handle as { unref?: () => void }).unref?.();
  return handle;
};

const defaultClearTimer = (handle: unknown): void => {
  clearTimeout(handle as NodeJS.Timeout);
};

interface FacetConsumerOptions {
  readonly batchLimit: number;
  /** 历史增量保留上限（G1a）。 */
  readonly historyLimit: number;
  readonly sessionId: () => string;
  readonly now: () => number;
  readonly setTimer: (callback: () => void) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly onFailure: (category: string, diagnostic: DebugFacetDiagnostic) => void;
  readonly shouldThrowForTest: (record: HostDebugRecord) => boolean;
  readonly onBatch: (category: string, size: number) => void;
  /** 每条成功渲染的增量（G1a）。 */
  readonly onRender: (event: DebugFacetRenderEvent) => void;
  /** 分类级重置（G1a）。 */
  readonly onReset: (event: DebugFacetResetEvent) => void;
  /** 注销后仍被投递（只用于验收 A 的"没调用已销毁模块"断言）。 */
  readonly onLateRecord: () => void;
}

/**
 * 一个模块 facet 的路由适配器。
 *
 * `consume()` 只入队（不阻塞 `dispatch`），由定时器按 {@link DEBUG_FACET_BATCH_LIMIT} 分批
 * 调用 `onRecord`；批与批之间让出事件循环，因此单帧内的模块代码量有界。
 */
class ModuleDebugFacetConsumer implements DebugConsumer {
  public readonly categories: readonly string[];
  private readonly options: FacetConsumerOptions;
  private readonly source: DebugFacetSource;
  private pendingRecords: HostDebugRecord[] = [];
  private timer: unknown;
  private disposed = false;
  private contentValue: JsonValue | undefined;
  private updatedAtValue: number | undefined;
  /** 逐条渲染增量（G1a，供模块 Webview 水化；超出上限丢最旧）。 */
  private historyValue: { readonly seq: number; readonly update: JsonValue }[] = [];
  private historyTruncatedValue = false;
  private deliveredValue = 0;
  private batchesValue = 0;
  private failureValue: DebugFacetDiagnostic | undefined;

  public constructor(source: DebugFacetSource, options: FacetConsumerOptions) {
    this.source = source;
    this.categories = [...source.facet.categories];
    this.options = options;
  }

  public accepts(): boolean {
    return true;
  }

  public consume(record: HostDebugRecord): void {
    if (this.disposed) {
      this.options.onLateRecord();
      return;
    }

    if (this.failureValue !== undefined) {
      return;
    }

    this.pendingRecords.push(record);
    this.schedule();
  }

  /** 从头重放前清空自身状态（D.4 没有 facet 级 reset，宿主按"重建消费者"处理）。 */
  public reset(reason: DebugResetReason = "session"): void {
    this.cancelTimer();
    this.pendingRecords = [];
    this.contentValue = undefined;
    this.updatedAtValue = undefined;
    this.historyValue = [];
    this.historyTruncatedValue = false;
    this.deliveredValue = 0;
    this.batchesValue = 0;
    this.failureValue = undefined;
    for (const category of this.categories) {
      this.options.onReset(this.resetEventFor(category, reason));
    }
  }

  /**
   * 关键帧快照：队列里还有没投给模块的记录时返回 `undefined`。
   *
   * 关键帧只属于"当前主消费者看过全部分类记录"的状态（C.4）；返回半截状态会得到
   * `partial=false` 却缺记录的假基线。
   */
  public captureState(): unknown {
    if (this.pendingRecords.length > 0 || this.failureValue !== undefined) {
      return undefined;
    }

    return {
      content: this.contentValue,
      delivered: this.deliveredValue,
      batches: this.batchesValue,
      updatedAt: this.updatedAtValue,
    };
  }

  public restoreState(state: unknown): boolean {
    if (typeof state !== "object" || state === null) {
      return false;
    }

    const snapshot = state as {
      readonly content?: JsonValue;
      readonly delivered?: number;
      readonly batches?: number;
      readonly updatedAt?: number;
    };
    this.cancelTimer();
    this.pendingRecords = [];
    this.contentValue = snapshot.content;
    this.deliveredValue = snapshot.delivered ?? 0;
    this.batchesValue = snapshot.batches ?? 0;
    this.updatedAtValue = snapshot.updatedAt;
    this.failureValue = undefined;
    return true;
  }

  /** 注销：取消待投批次并丢弃队列（记录仍已在 store 与观察者里，不会丢）。 */
  public dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.pendingRecords = [];
  }

  public get records(): number {
    return this.deliveredValue;
  }

  public get batches(): number {
    return this.batchesValue;
  }

  public get pending(): number {
    return this.pendingRecords.length;
  }

  public get content(): JsonValue | undefined {
    return this.contentValue;
  }

  public get updatedAt(): number | undefined {
    return this.updatedAtValue;
  }

  /** 逐条增量（升序 `seq`）；返回浅拷贝数组，调用方改不动内部结构。 */
  public get history(): readonly { readonly seq: number; readonly update: JsonValue }[] {
    return [...this.historyValue];
  }

  /** 历史窗口是否丢过最旧增量（水化时必须标注 `truncated`）。 */
  public get historyTruncated(): boolean {
    return this.historyTruncatedValue;
  }

  public get failure(): DebugFacetDiagnostic | undefined {
    return this.failureValue;
  }

  public get sourceRef(): DebugFacetSource {
    return this.source;
  }

  /** 立即排空（单测与宿主测试的读入口；生产路径由定时器驱动）。 */
  public flushNow(): void {
    this.cancelTimer();
    while (!this.disposed && this.pendingRecords.length > 0 && this.failureValue === undefined) {
      this.flushBatch();
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.disposed) {
      return;
    }

    this.timer = this.options.setTimer(() => {
      this.timer = undefined;
      this.flushBatch();
      if (this.pendingRecords.length > 0 && this.failureValue === undefined) {
        this.schedule();
      }
    });
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.options.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private flushBatch(): void {
    if (this.disposed || this.failureValue !== undefined) {
      this.pendingRecords = [];
      return;
    }

    const batch = this.pendingRecords.splice(0, this.options.batchLimit);
    if (batch.length === 0) {
      return;
    }

    this.batchesValue += 1;
    this.options.onBatch(batch[0]?.category ?? "", batch.length);
    for (const record of batch) {
      let update: DebugRenderUpdate | undefined;
      try {
        update = this.options.shouldThrowForTest(record)
          ? throwInjectedFailure()
          : this.source.facet.onRecord(toPublicRecord(record, this.options.sessionId()), this.source.context);
      } catch (errorValue) {
        this.fail(record, "module.callFailed", `onRecord() failed: ${describeError(errorValue)}.`);
        // facet 已失败：后续记录由路由改投观察者（记录已在 store/观察者里，不会丢）。
        this.pendingRecords = [];
        return;
      }

      this.deliveredValue += 1;
      if (update !== undefined) {
        const rendered = toRenderUpdate(update);
        if (!rendered.ok) {
          this.fail(
            record,
            rendered.reason === "tooLarge" ? "module.renderTooLarge" : "module.registrationInvalid",
            rendered.reason === "tooLarge"
              ? `onRecord() returned a ${rendered.bytes} byte render update, above the ${DEBUG_FACET_CONTENT_MAX_BYTES} byte output limit.`
              : "onRecord() returned a value that is not a JSON object.",
          );
          this.pendingRecords = [];
          return;
        }

        this.contentValue = rendered.value;
        this.updatedAtValue = this.options.now();
        this.pushHistory(record.arrivalSeq, rendered.value);
        this.options.onRender({
          category: record.category,
          moduleId: this.source.moduleId,
          editor: this.source.editor,
          update: rendered.value,
        });
      }
    }
  }

  /** 追加一条历史增量；超过上限丢最旧并标记 `truncated`。 */
  private pushHistory(seq: number, update: JsonValue): void {
    this.historyValue.push({ seq, update });
    while (this.historyValue.length > this.options.historyLimit) {
      this.historyValue.shift();
      this.historyTruncatedValue = true;
    }
  }

  private resetEventFor(category: string, reason: DebugResetReason): DebugFacetResetEvent {
    return {
      category,
      moduleId: this.source.moduleId,
      editor: this.source.editor,
      reason,
    };
  }

  private fail(record: HostDebugRecord, code: DebugFacetDiagnosticCode, detail: string): void {
    // 失败后窗口会切成 `fallback`（面板显示"已回退通用视图"）；旧内容必须同时清掉，
    // 否则徽标与失败前的模块内容会同屏，等于把"已回退"说成半真（F4 返修 P2-4）。
    // 选"在源头清空"而不是让 Webview 只看 `state === "active"`：快照是 public 契约，
    // `content` 在非 active 状态就不该有值，任何消费方（面板、测试、诊断导出）都一致。
    this.contentValue = undefined;
    this.updatedAtValue = undefined;
    const diagnostic: DebugFacetDiagnostic = {
      code: assertDebugFacetCode(code),
      severity: "error",
      message: `[${this.source.moduleId}/${this.source.editor}] category '${record.category}' record #${record.arrivalSeq}: ${detail}`,
      path: this.source.path,
    };
    this.failureValue = diagnostic;
    this.options.onFailure(record.category, diagnostic);
  }
}

/**
 * 模块调试 facet 的宿主：维护"分类 → facet 消费者"的注册、批量投递与窗口快照。
 *
 * 注册顺序就是 `sources` 的顺序（扩展侧按 Project → `modules` 数组顺序传入），也就是
 * 附录 C.5 的冲突裁决顺序；后登记者不会拿到记录。
 */
export class DebugFacetHost {
  private readonly options: DebugFacetHostOptions;
  private readonly consumers = new Map<string, ModuleDebugFacetConsumer>();
  private readonly conflicts = new Map<string, DebugFacetDiagnostic>();
  private readonly lastReplay = new Map<string, DebugFacetReplayView>();
  private readonly unregister: (() => void)[] = [];
  private readonly renderListeners = new Set<(event: DebugFacetRenderEvent) => void>();
  private readonly resetListeners = new Set<(event: DebugFacetResetEvent) => void>();
  private sourcesValue: readonly DebugFacetSource[] = [];
  private faultCategory: string | undefined;
  private totalFailures = 0;
  private lateRecordsValue = 0;

  public constructor(options: DebugFacetHostOptions) {
    this.options = options;
  }

  /** 订阅逐条渲染增量（G1a）；返回注销函数。监听器抛错只记日志，不影响投递。 */
  public onDidRender(listener: (event: DebugFacetRenderEvent) => void): () => void {
    this.renderListeners.add(listener);
    return () => {
      this.renderListeners.delete(listener);
    };
  }

  /** 订阅分类级重置（G1a）；返回注销函数。 */
  public onDidReset(listener: (event: DebugFacetResetEvent) => void): () => void {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }

  /** 某分类当前保留的历史增量（水化用）；没有消费者时为空数组。 */
  public updatesFor(category: string): readonly { readonly seq: number; readonly update: JsonValue }[] {
    return this.consumers.get(category)?.history ?? [];
  }

  /** 该分类的历史窗口是否已丢过最旧增量。 */
  public isHistoryTruncated(category: string): boolean {
    return this.consumers.get(category)?.historyTruncated ?? false;
  }

  /** 分类 → 归属信息（水化消息的 `moduleId` / `editor`）；没有消费者时 `undefined`。 */
  public windowSource(category: string): { readonly moduleId: string; readonly editor: string } | undefined {
    const source = this.consumers.get(category)?.sourceRef;
    return source === undefined ? undefined : { moduleId: source.moduleId, editor: source.editor };
  }

  /**
   * 重建分类路由（模块加载状态 / Project 变化时调用）。
   *
   * 顺序固定：**先**注销旧消费者（旧 facet 立即失效，不再收到任何记录），**再**按顺序注册新的，
   * 最后对已有的分类记录做一次分类级重建（新 facet 注册前看不到历史，C.4/F2 的已知语义）。
   */
  public rebuild(sources: readonly DebugFacetSource[]): void {
    const categories = new Set<string>();
    for (const consumer of this.consumers.values()) {
      for (const category of consumer.categories) {
        categories.add(category);
      }
    }

    // 先通知模块 Webview"本地累积失效"，再注销/重建消费者；随后 replay 会重放增量。
    // 顺序不能反：若先重放，Webview 会在清空时把刚收到的重放一起丢掉。
    for (const category of categories) {
      this.emitReset(this.consumerResetEvent(category));
    }

    this.dropConsumers();
    this.sourcesValue = [...sources];
    this.conflicts.clear();
    this.consumers.clear();

    for (const source of sources) {
      const consumer = new ModuleDebugFacetConsumer(source, {
        batchLimit: this.batchLimit(),
        historyLimit: this.historyLimit(),
        sessionId: this.options.sessionId ?? (() => ""),
        now: this.options.now ?? (() => Date.now()),
        setTimer: this.options.setTimer ?? defaultSetTimer,
        clearTimer: this.options.clearTimer ?? defaultClearTimer,
        onFailure: (category, diagnostic) => this.handleFailure(category, diagnostic),
        shouldThrowForTest: (record) => this.faultCategory !== undefined && record.category === this.faultCategory,
        onBatch: (category, size) => this.options.onBatch?.(category, size),
        onRender: (event) => this.emitRender(event),
        onReset: (event) => this.emitReset(event),
        onLateRecord: () => {
          this.lateRecordsValue += 1;
        },
      });
      for (const category of consumer.categories) {
        // 同一分类只记第一个消费者：`DebugRouter` 也按注册序裁决，这里保持同一语义。
        if (!this.consumers.has(category)) {
          this.consumers.set(category, consumer);
        }
      }

      this.unregister.push(this.options.router.register(consumer, `module:${source.moduleId}/${source.editor}`));
    }

    // 宿主侧兜底：加载器通常已停用冲突模块（`module.editorConflict`），但宿主不能假设这一点。
    for (const source of sources) {
      for (const [categoryIndex, category] of source.facet.categories.entries()) {
        const consumer = this.consumers.get(category);
        // 比的是"这个消费者是否由**本 source** 创建"，不能比 facet 对象：同一模块可以把
        // **同一个 facet 对象**挂在两个 editor 上（`facet !== facet` 恒 false，旧实现对此失明，
        // 第二处被静默丢弃），也不能只比 owner（同一分类的第二个 source 拿到的是第一个 source
        // 的 consumer，`router.ownerFor` 也确实是它）。
        if (consumer === undefined || consumer.sourceRef !== source
          || this.options.router.ownerFor(category) !== consumer) {
          const owner = this.options.router.ownerLabel(category);
          const diagnostic: DebugFacetDiagnostic = {
            code: assertDebugFacetCode("module.editorConflict"),
            severity: "warning",
            message: `Debug category '${category}' is already provided by '${owner ?? "another consumer"}'; '${source.moduleId}' stays unclaimed.`,
            path: `${source.path}.categories[${categoryIndex}]`,
          };
          this.conflicts.set(category, diagnostic);
        }
      }
    }

    // 模块加载变化（Trust 授予、重载）后，已有的分类记录要补投给新 facet；否则窗口永远缺历史。
    const replay = this.options.replay;
    if (replay !== undefined) {
      const known = new Set<string>([...categories, ...(this.options.knownCategories?.() ?? [])]);
      for (const category of known) {
        if (this.consumers.has(category)) {
          replay(category);
        }
      }
    }

    for (const source of sources) {
      for (const category of source.facet.categories) {
        if (this.options.router.ownerFor(category) !== this.consumers.get(category)) {
          this.options.log?.(
            `[debug] debug facet '${source.moduleId}' did not claim category '${category}' (first registration wins).`,
          );
        }
      }
    }
  }

  /**
   * 显式分类级重建（面板的"按分类重建"动作；`partial` 原样保留给 UI）。
   *
   * 只在**该分类有活动主消费者**时才可能返回结果：`unavailable`（模块未加载/未声明该分类）与
   * `fallback`（`onRecord` 失败后改投通用视图）时底层 `DebugInstanceManager.replay` 直接返回
   * `undefined`——宿主没有"可以重建的模块状态"，这里也不会假装重建了消费者（P2-2）。
   * 这不是静默的 no-op：窗口快照的 `rebuildable` 为假，面板据此禁用按钮，并把下一步写成
   * "重载模块（或重新授权）后会自动恢复"——`rebuild()` 会为新的 facet 重放已有分类记录。
   */
  public replayCategory(category: string): DebugFacetReplayView | undefined {
    const result = this.options.replay?.(category);
    if (result === undefined) {
      this.options.log?.(`[debug] category '${category}' has no active module consumer (or no records); nothing to rebuild.`);
      return undefined;
    }

    const view: DebugFacetReplayView = {
      fromKeyframe: result.fromKeyframe,
      keyframeId: result.keyframeId,
      applied: result.applied,
      partial: result.partial,
    };
    this.lastReplay.set(category, view);
    return view;
  }

  /** 待投记录立即排空（宿主测试/诊断用；生产由定时器驱动）。 */
  public flushForTest(): void {
    for (const consumer of this.consumers.values()) {
      consumer.flushNow();
    }
  }

  /** 测试专用：让指定分类的下一条 `onRecord` 抛错（生产不启用）。 */
  public setFaultInjectionForTest(category: string | undefined): void {
    this.faultCategory = category;
  }

  /** 测试专用：用当前 sources 重新注册（清掉 fallback 与失败状态）。 */
  public reloadForTest(): void {
    this.rebuild(this.sourcesValue);
  }

  /**
   * 当前路由的只读摘要（诊断 / 宿主测试定位用）。
   *
   * 暴露 `project.options` 只为证明"模块重载后拿到的是新的 `modules[i].options`"（F4 验收 ⑤）；
   * 真实的记录投递仍然只给 `onRecord`，不把宿主内部状态塞进 `DebugRecord`。
   */
  public routeSummaryForTest(): readonly {
    readonly moduleId: string;
    readonly editor: string;
    readonly path: string;
    readonly categories: readonly string[];
    readonly options: JsonValue | undefined;
  }[] {
    return this.sourcesValue.map((source) => ({
      moduleId: source.moduleId,
      editor: source.editor,
      path: source.path,
      categories: [...source.facet.categories],
      options: source.context.project.options,
    }));
  }

  public dispose(): void {
    this.dropConsumers();
    this.consumers.clear();
  }

  /** 归一后的每批上限（`0`/负数会让 `flushNow` 自旋，见 `normalizeBatchLimit`）。 */
  private batchLimit(): number {
    return normalizeBatchLimit(this.options.batchLimit);
  }

  /** 归一后的历史增量上限。 */
  private historyLimit(): number {
    return normalizeHistoryLimit(this.options.historyLimit);
  }

  private consumerResetEvent(category: string): DebugFacetResetEvent {
    const source = this.consumers.get(category)?.sourceRef;
    return {
      category,
      moduleId: source?.moduleId ?? "",
      editor: source?.editor ?? "",
      reason: "reload",
    };
  }

  private emitRender(event: DebugFacetRenderEvent): void {
    if (this.options.onRender !== undefined) {
      this.callSafely(() => this.options.onRender?.(event), "onRender");
    }
    for (const listener of [...this.renderListeners]) {
      this.callSafely(() => listener(event), "onDidRender listener");
    }
  }

  private emitReset(event: DebugFacetResetEvent): void {
    if (this.options.onReset !== undefined) {
      this.callSafely(() => this.options.onReset?.(event), "onReset");
    }
    for (const listener of [...this.resetListeners]) {
      this.callSafely(() => listener(event), "onDidReset listener");
    }
  }

  /** 订阅方（扩展的 Webview 转发）出错不能影响调试投递与记录保存。 */
  private callSafely(action: () => void, label: string): void {
    try {
      action();
    } catch (errorValue) {
      this.options.log?.(`[debug] ${label} failed: ${String(errorValue)}`);
    }
  }

  public snapshot(): DebugFacetSnapshot {
    const router = this.options.router;
    const categories = new Set<string>();
    for (const category of this.consumers.keys()) categories.add(category);
    for (const category of this.options.knownCategories?.() ?? []) categories.add(category);

    const windows: DebugFacetWindow[] = [];
    for (const category of [...categories].sort(compareText)) {
      windows.push(this.windowFor(category));
    }

    let pending = 0;
    let batches = 0;
    for (const consumer of new Set(this.consumers.values())) {
      pending += consumer.pending;
      batches += consumer.batches;
    }

    return {
      windows,
      pending,
      batches,
      failures: this.totalFailures,
      batchLimit: this.batchLimit(),
      lateRecords: this.lateRecordsValue,
      generic: {
        records: router.observer.total,
        dropped: router.observer.dropped,
      },
    };
  }

  private windowFor(category: string): DebugFacetWindow {
    const consumer = this.consumers.get(category);
    const source = consumer?.sourceRef;
    const owner = this.options.router.ownerFor(category);
    const fallback = this.options.router.stats.fallbackCategories.includes(category);
    const diagnostics: DebugFacetDiagnostic[] = [];
    const failure = consumer?.failure;
    if (failure !== undefined) diagnostics.push(failure);
    const conflict = this.conflicts.get(category);
    if (conflict !== undefined) diagnostics.push(conflict);

    let state: DebugFacetWindow["state"] = "unavailable";
    let message: string | undefined;
    if (consumer !== undefined && !fallback && owner !== undefined && owner === consumer) {
      state = "active";
    } else if (fallback) {
      state = "fallback";
      message = "模块的 onRecord 失败，该分类已回退到通用视图（记录仍在通用窗口里）。";
    } else if (this.sourcesValue.length === 0) {
      state = "unavailable";
      message = "模块未加载，该分类回退到通用视图。";
    } else {
      state = "unavailable";
      message = "没有已加载模块声明该调试分类（模块未加载或未声明），已回退到通用视图。";
    }

    if (conflict !== undefined && state === "active") {
      message = `同一分类冲突：${conflict.message}`;
    }

    // 单一判据：按钮能不能点、元信息说什么、提示让用户做什么，都由这一个布尔值决定。
    //
    // F4 返修 P2-1：`state === "active"` 只说明"消费者注册着且没回退"，不说明**还有东西可重建**。
    // 分类实例全被淘汰、只剩墓碑时 `manager.replay` 因 `stores.length === 0` 返回 `undefined`，
    // 旧判据会把按钮留在可用态（点了没反应）。第三个条件由 `hasReplayableRecords` 提供：
    // 真实宿主接 `DebugInstanceManager.hasReplayableCategoryRecords`（该分类的可见记录或
    // 记录先于 Create 的暂存批次），与 `replay()` 的数据源同源，不在快照层另造一套判定。
    // 不用 `consumer.pending` 当判据：它是已入队记录而非"store 还在"，分类 store 已被淘汰
    // 时 pending 照样可能大于 0——那正是本项要消除的"点了没反应"。
    const rebuildable = state === "active"
      && this.options.replay !== undefined
      && (this.options.hasReplayableRecords?.(category) ?? true);

    return {
      category,
      state,
      title: `调试分类 · ${category}`,
      moduleTitle: source?.facet.windowTitle,
      moduleId: source?.moduleId,
      editor: source?.editor,
      path: source?.path,
      message,
      toolbar: ["replayCategory"],
      records: consumer?.records ?? 0,
      batches: consumer?.batches ?? 0,
      pending: consumer?.pending ?? 0,
      content: consumer?.content,
      updatedAt: consumer?.updatedAt,
      stale: this.options.isCategoryStale?.(category) ?? false,
      rebuildable,
      diagnostics,
      replay: this.lastReplay.get(category),
    };
  }

  private handleFailure(category: string, diagnostic: DebugFacetDiagnostic): void {
    this.totalFailures += 1;
    this.options.log?.(`[debug] ${diagnostic.message}`);
    // 同步抛错的路径由 `DebugRouter.deliverMain` 处理；这里是**异步批投递**的上报入口，
    // 必须走同一个 fallback 状态（不能只记一个本地失败标记）。
    this.options.router.markCategoryFallback(category, diagnostic.path, diagnostic.message);
  }

  private dropConsumers(): void {
    for (const unregister of this.unregister.splice(0)) {
      unregister();
    }

    for (const consumer of new Set(this.consumers.values())) {
      consumer.dispose();
    }
  }
}

/**
 * 内部记录 → 公开 `DebugRecord`（D.4）。
 *
 * - `seq` 用全局应用序 `arrivalSeq`（跨实例唯一、与关键帧回放的增量过滤同源）；
 * - `params` 优先用契约补齐后的 `named`，缺契约时退回 `args`（键为 `name` 或 `arg#tag`）；
 * - `at` 用接收时间；`sessionId` 由宿主 bridge 会话提供；
 * - `kind` 原样带出（`event` / `queryResult`，G1a/P0-2）：查询结果与调试事件共用时间轴，
 *   模块侧要能区分。字段在 SDK 里是**可选**的，因此这是 additive 追加，不破坏既有 facet。
 *
 * `params` 是**每次调用新造的独立对象**，嵌套 JSON 值也会深拷贝（P2-5）：模块拿到的记录与
 * store/通用视图不共享任何可变引用，改自己的副本不会污染宿主。深拷贝复用 Core 的
 * `cloneJsonValue`（见下方 `toJsonValue` 的语义说明），不再维护第二份实现。
 */
export function toPublicRecord(record: HostDebugRecord, sessionId: string): PublicDebugRecord {
  const params: Record<string, JsonValue> = {};
  if (record.named.size > 0) {
    for (const [name, arg] of record.named) {
      params[name] = toJsonValue(arg.value);
    }
  } else {
    for (const [tag, arg] of record.args) {
      params[arg.name ?? `arg#${tag}`] = toJsonValue(arg.value);
    }
  }

  return {
    seq: record.arrivalSeq,
    sessionId,
    instanceId: record.instanceId,
    category: record.category,
    frame: record.frame,
    method: record.method,
    params,
    wireBytes: record.wireBytes,
    at: record.receivedAt,
    kind: record.kind,
  };
}

/**
 * 嵌套 JSON 值深拷贝（F4 返修 P2-5）：直接复用 Core 的 `cloneJsonValue`，不再自实现。
 *
 * 语义判定：Core 的实现是 `JSON.parse(JSON.stringify(value))`，宿主旧实现是结构递归。
 * 输入已经过 `isJsonValue` 收口——只可能是 JSON 域的值（无 `undefined`/函数/循环引用/
 * `NaN`/`Infinity`），因此两者对**契约内的值域**等价：都产出新的普通对象/数组、不共享嵌套
 * 引用、不保留原型。唯一可观察差异是 `-0`（JSON 往返会变成 `0`），但 JSON 本身不区分 -0，
 * 面板对快照的序列化同样输出 `0`，不构成契约差异。
 *
 * 成本上界（未单独计时，只给推导）：单条记录的 `params` 来自线上包络，`wireBytes` 是实际
 * payload 字节数，受 `MAX_MESSAGE_BYTES`（1 MiB，`bridge/framing.ts`）约束；JSON 往返的
 * 瞬时内存/时间是该体积的常数倍（≤ 2×）。每批默认最多 `DEBUG_FACET_BATCH_LIMIT = 100` 条
 * （`batchLimit` 可注入），故单批深拷贝上界约 `100 × 1 MiB × 常数`，实际远低于此（单条参数
 * 通常几十字节）。这里不写"实测毫秒"：没有计时断言，就不把观测写成保证。
 */
function toJsonValue(value: unknown): JsonValue {
  if (isJsonValue(value)) {
    return cloneJsonValue(value);
  }

  // 非 JSON 值（例如 `undefined`/函数）在公开契约里不能出现：降级成字符串，不丢参数键。
  return String(value);
}

/**
 * 渲染增量按 JSON 对象收口，并且有**输出上限**（F4 返修 P2-6）：非对象/不可序列化一律视为
 * 契约违例（计数并回退）；超过 {@link DEBUG_FACET_CONTENT_MAX_BYTES} 的按"模块把原始数据塞进
 * 视图"处理——单独的诊断码，面板可见，而不是让每次快照都拖着几十 MB `postMessage`。
 */
type RenderUpdateResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: "invalid" | "tooLarge"; readonly bytes: number };

function toRenderUpdate(update: DebugRenderUpdate): RenderUpdateResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(update);
  } catch {
    return { ok: false, reason: "invalid", bytes: 0 };
  }

  if (serialized === undefined) {
    return { ok: false, reason: "invalid", bytes: 0 };
  }

  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > DEBUG_FACET_CONTENT_MAX_BYTES) {
    return { ok: false, reason: "tooLarge", bytes };
  }

  let cloned: unknown;
  try {
    cloned = JSON.parse(serialized);
  } catch {
    return { ok: false, reason: "invalid", bytes };
  }

  return typeof cloned === "object" && cloned !== null && !Array.isArray(cloned) && isJsonValue(cloned)
    ? { ok: true, value: cloned }
    : { ok: false, reason: "invalid", bytes };
}

function describeError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

/** 仅供测试注入：抛一个可识别的错误（不进入生产路径）。 */
function throwInjectedFailure(): never {
  throw new Error("injected debug facet failure");
}

/**
 * 每批上限归一（F4 返修 P2-3）：整数、至少 1。
 *
 * `0`/负数没有意义（等于"永不投递"），却会让 `flushNow` 的 `while` 永远拿不到非空批次而**自旋**、
 * 也让定时器链无限重排却不推进。取 1 而不是"报个诊断再回退 100"：语义最小、行为可预测
 * （每批一条 = 不分批），而且不会把调用方给出的数字静默换成另一个。
 * 非有限值（`NaN`/`Infinity`）回退到默认上限。
 */
function normalizeBatchLimit(limit: number | undefined): number {
  const value = limit ?? DEBUG_FACET_BATCH_LIMIT;
  if (!Number.isFinite(value)) {
    return DEBUG_FACET_BATCH_LIMIT;
  }

  return Math.max(1, Math.floor(value));
}

/** 历史增量上限归一：至少 1，非有限值回退默认。 */
function normalizeHistoryLimit(limit: number | undefined): number {
  const value = limit ?? DEBUG_FACET_HISTORY_LIMIT;
  if (!Number.isFinite(value)) {
    return DEBUG_FACET_HISTORY_LIMIT;
  }

  return Math.max(1, Math.floor(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 供扩展侧构造 facet context 时复用：模块日志出口。 */
export type DebugFacetLogger = ModuleLogFunction;
