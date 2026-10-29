/**
 * 调试记录路由（附录 C.5）：每条记录**恰好一个主消费者**聚合，同时**总是**进观察者
 * （{@link GenericDebugConsumer}）；无模块认领 / 模块未加载 / facet 抛错时由观察者兼任主消费者。
 *
 * 职责边界：
 * - 本类只决定"这条记录归谁"，不解析字节（F1）、不存储（`DebugStore`）、不做 UI（F3）。
 * - 消费者以**注册顺序**裁决分类归属（附录 C.5：一个分类至多一个 facet，冲突保留第一个）；
 *   F4 按 `modules` 顺序注册即得该语义。注销后**重新裁决**：下一个认领者可以接位。
 * - 异常隔离：任一消费者抛错只计数、落日志、该分类回退观察者，**不影响其他消费者与后续记录**。
 * - 关键帧快照只取**已注册主消费者**的 `captureState()`（观察者不参与：它的列表可由 store 重建）；
 *   没有认领者时没有"主消费者状态"可快照/回放，相关方法返回 `undefined` / `false`。
 */

import type { DebugRecord } from "./debugStore";

/**
 * 调试消费者（附录 C.5 的接口 + F2 追加的关键帧钩子）。
 *
 * `captureState` / `restoreState` 是**附录 C.5 未定义、F2 追加**的可选扩展（评审 R1 有条件接受）：
 * C.4 的"关键帧 + 增量"需要一份消费者状态的快照，而 C.5 只规定了 `categories`/`accepts`/`consume`。
 * 两者都可选——不实现即退化为"重置 + 从头重放"（结果正确、只是丢掉增量的省算优势），
 * 因此既有消费者不需要改动。正式文档（C.5）的回填属 G2 的文档工作，不在本任务范围内。
 */
/** 消费者被重置的原因：新会话（丢弃旧累积）或从头重放（保留可重放基线）。 */
export type DebugResetReason = "session" | "replay";

export interface DebugConsumer {
  /** 认领的分类（精确匹配）；空数组表示不认领任何分类（观察者）。 */
  readonly categories: readonly string[];
  /** 逐条判定（C.5 的 `accepts`）；主消费者对它认领分类的记录仍有一次否决权。 */
  accepts(record: DebugRecord): boolean;
  consume(record: DebugRecord): void;
  /** 新会话/从头重放前清空自身状态。 */
  reset?(reason?: DebugResetReason): void;
  /** 关键帧快照（C.4 的"从关键帧 + 增量"）；不实现表示该消费者不参与关键帧。 */
  captureState?(): unknown;
  /** 恢复关键帧快照；返回是否成功（`false` 时调用方必须从头重放）。 */
  restoreState?(state: unknown): boolean;
}

export interface DebugRouterStats {
  /** 分发过的记录条数。 */
  readonly records: number;
  /** 主消费者投递次数。 */
  readonly mainDeliveries: number;
  /** 观察者投递次数。 */
  readonly observerDeliveries: number;
  /** 被隔离的消费者异常次数。 */
  readonly errors: number;
  /** 已回退到观察者的分类（facet 抛过错的分类）。 */
  readonly fallbackCategories: readonly string[];
}

export interface DebugRouterOptions {
  /** 观察者；缺省新建一个 {@link GenericDebugConsumer}。 */
  readonly observer?: GenericDebugConsumer;
  readonly log?: (message: string) => void;
}

interface RegisteredConsumer {
  /** 注册序（= 消费者身份令牌）：关键帧据此判断"快照属于哪个消费者"。 */
  readonly id: number;
  readonly consumer: DebugConsumer;
  readonly label: string;
  readonly categories: readonly string[];
}

/** 主消费者变更通知（注册/注销导致某分类换了主人时调用）。 */
export type DebugOwnershipListener = (category: string) => void;

/**
 * 分类 → 主消费者 + 观察者。
 *
 * 观察者是路由器自有的（不属于注册表），因此"无认领时兼任主消费者"是结构性的：
 * 主消费者解析结果要么是注册表里的 facet，要么是观察者本身——此时只投递一次，
 * 不会出现"主 + 观察各一份"的重复。
 */
export class DebugRouter {
  public readonly observer: GenericDebugConsumer;
  private readonly log: (message: string) => void;
  private readonly registered: RegisteredConsumer[] = [];
  private readonly fallback = new Set<string>();
  private registeredCounter = 0;
  private ownershipListener: DebugOwnershipListener | undefined;
  private recordsValue = 0;
  private mainDeliveriesValue = 0;
  private observerDeliveriesValue = 0;
  private errorsValue = 0;

  public constructor(options: DebugRouterOptions = {}) {
    this.observer = options.observer ?? new GenericDebugConsumer();
    this.log = options.log ?? (() => undefined);
  }

  public get stats(): DebugRouterStats {
    return {
      records: this.recordsValue,
      mainDeliveries: this.mainDeliveriesValue,
      observerDeliveries: this.observerDeliveriesValue,
      errors: this.errorsValue,
      fallbackCategories: [...this.fallback].sort(),
    };
  }

  /** 注册一个消费者；返回注销函数。重复认领同一分类时**保留先注册者**并告警。 */
  public register(consumer: DebugConsumer, label?: string): () => void {
    const entry: RegisteredConsumer = {
      id: this.nextConsumerId(),
      consumer,
      label: label ?? (consumer instanceof GenericDebugConsumer ? "generic" : "consumer"),
      categories: [...consumer.categories],
    };
    const before = this.ownerTokensOf(entry.categories);
    this.registered.push(entry);
    for (const category of entry.categories) {
      const existing = this.claim(category);
      if (existing !== undefined && existing !== entry) {
        this.log(
          `[debug] category '${category}' is already owned by '${existing.label}'; '${entry.label}' stays unclaimed (first registration wins).`,
        );
      }
    }

    this.announceOwnershipChange(entry.categories, before);
    return () => {
      const index = this.registered.indexOf(entry);
      if (index < 0) {
        return;
      }

      const previous = this.ownerTokensOf(entry.categories);
      // 注销即让位：后注册的认领者按注册顺序重新裁决（不留永不上位的死认领）。
      this.registered.splice(index, 1);
      for (const category of entry.categories) {
        this.fallback.delete(category);
      }

      this.announceOwnershipChange(entry.categories, previous);
    };
  }

  /**
   * 主消费者变更通知：注册/注销导致某分类换了主人时回调（关键帧归属跟着换，见 debugInstanceManager）。
   * 只在该分类的认领确实变了时才触发。
   */
  public setOwnershipListener(listener: DebugOwnershipListener | undefined): void {
    this.ownershipListener = listener;
  }

  /** 分类主消费者的身份令牌（注册序）；无认领者时 `undefined`。 */
  public ownerToken(category: string): number | undefined {
    return this.claim(category)?.id;
  }

  /** 分类主消费者的显示名（诊断/关键帧归属记录用）。 */
  public ownerLabel(category: string): string | undefined {
    return this.claim(category)?.label;
  }

  /** 分类的认领者（注册顺序第一个）；没有则 `undefined`。 */
  public ownerFor(category: string): DebugConsumer | undefined {
    return this.claim(category)?.consumer;
  }

  /** 该分类当前是否有一个**可回放**的主消费者（注册者且未回退到通用视图）。 */
  public hasOwner(category: string): boolean {
    return this.claim(category) !== undefined && !this.fallback.has(category);
  }

  /**
   * 把一个分类标成"回退到通用视图"（C.5）。
   *
   * 同步抛错的路径（{@link deliverMain}）在路由内部直接调用它；**异步投递**的消费者
   * （F4 的模块 facet 按批投递，见 `debugFacetHost`）也必须能上报同一件事——否则异常发生在
   * `consume()` 返回之后，路由层永远看不到，分类会继续被投给一个已经失败的 facet。
   * 返回 `true` 表示本次调用真的改变了归属。
   */
  public markCategoryFallback(category: string, label: string, reason: string): boolean {
    if (this.fallback.has(category)) {
      return false;
    }

    this.fallback.add(category);
    this.errorsValue += 1;
    this.log(
      `[debug] consumer '${label}' threw for category '${category}'; the category falls back to the generic view: ${reason}`,
    );
    return true;
  }

  /**
   * 分发一条记录：**总是**先给观察者，再给该分类的主消费者（若主消费者就是观察者则只投递一次）。
   * 两次投递各自隔离异常。
   */
  public dispatch(record: DebugRecord): void {
    this.recordsValue += 1;
    const main = this.mainFor(record);
    this.deliverObserver(record);
    if (main !== undefined && main !== this.observer) {
      this.deliverMain(record, main);
    } else {
      // 观察者兼任主消费者：同一次投递同时算作主消费者与观察者。
      this.mainDeliveriesValue += 1;
    }
  }

  /**
   * 只投递给主消费者（重放用）：关键帧回放不能再喂观察者，否则通用视图会重复。
   * 主消费者是观察者时同样只投一次。
   */
  public replayToMain(record: DebugRecord): void {
    const main = this.mainFor(record);
    if (main === undefined || main === this.observer) {
      this.mainDeliveriesValue += 1;
      return;
    }

    this.deliverMain(record, main);
  }

  /**
   * 主消费者的关键帧快照；没有可回放的主消费者、未实现 `captureState` 或快照抛错时返回 `undefined`。
   * 与 {@link restoreMainState} 对称地把异常挡在路由层外：关键帧只是加速手段，快照失败必须
   * 退化成"从头重放"，绝不能把异常抛给 ingest（那会丢整批暂存记录，评审 P2-4）。
   */
  public captureMainState(category: string): unknown {
    const main = this.replayableMain(category);
    if (main === undefined || main.captureState === undefined) {
      return undefined;
    }

    try {
      return main.captureState();
    } catch (errorValue) {
      this.errorsValue += 1;
      this.log(`[debug] consumer '${this.describe(main)}' failed to capture a keyframe: ${String(errorValue)}`);
      return undefined;
    }
  }

  /** 恢复主消费者关键帧；无主消费者 / 未实现 `restoreState` / 快照缺失时返回 `false`（调用方从头重放）。 */
  public restoreMainState(category: string, state: unknown): boolean {
    const main = this.replayableMain(category);
    if (main === undefined || main.restoreState === undefined || state === undefined) {
      return false;
    }

    try {
      return main.restoreState(state);
    } catch (errorValue) {
      this.errorsValue += 1;
      this.log(`[debug] consumer '${this.describe(main)}' failed to restore a keyframe: ${String(errorValue)}`);
      return false;
    }
  }

  /** 只重置主消费者（从头重放）；没有可回放的主消费者时不动观察者。 */
  public resetMain(category: string): boolean {
    const main = this.replayableMain(category);
    if (main === undefined) {
      return false;
    }

    this.resetConsumer(main, "replay");
    return true;
  }

  /** 重置全部消费者（新会话）并清空路由统计。 */
  public reset(): void {
    this.resetConsumer(this.observer, "session");
    for (const entry of this.registered) {
      this.resetConsumer(entry.consumer, "session");
    }

    this.fallback.clear();
    this.recordsValue = 0;
    this.mainDeliveriesValue = 0;
    this.observerDeliveriesValue = 0;
    this.errorsValue = 0;
  }

  /** 注册顺序第一个认领该分类的消费者（不看 fallback）。 */
  private claim(category: string): RegisteredConsumer | undefined {
    return this.registered.find((entry) => entry.categories.includes(category));
  }

  private nextConsumerId(): number {
    this.registeredCounter += 1;
    return this.registeredCounter;
  }

  private ownerTokensOf(categories: readonly string[]): ReadonlyMap<string, number | undefined> {
    const tokens = new Map<string, number | undefined>();
    for (const category of categories) {
      tokens.set(category, this.ownerToken(category));
    }

    return tokens;
  }

  /** 只在认领确实变了时回调（注册一个不改变归属的消费者不该让关键帧失效）。 */
  private announceOwnershipChange(
    categories: readonly string[],
    before: ReadonlyMap<string, number | undefined>,
  ): void {
    if (this.ownershipListener === undefined) {
      return;
    }

    for (const category of categories) {
      if (this.ownerToken(category) !== before.get(category)) {
        this.ownershipListener(category);
      }
    }
  }

  /** 可回放的主消费者：必须是注册者且该分类没回退到通用视图。 */
  private replayableMain(category: string): DebugConsumer | undefined {
    return this.hasOwner(category) ? this.claim(category)?.consumer : undefined;
  }

  private mainConsumer(category: string): DebugConsumer {
    return this.fallback.has(category) ? this.observer : (this.claim(category)?.consumer ?? this.observer);
  }

  /** 主消费者对本条记录的最终归属：facet 抛过错 → 观察者；`accepts` 为假 → 观察者。 */
  private mainFor(record: DebugRecord): DebugConsumer {
    const category = record.category;
    if (this.fallback.has(category)) {
      return this.observer;
    }

    const owner = this.claim(category)?.consumer;
    if (owner === undefined || owner === this.observer) {
      return this.observer;
    }

    try {
      return owner.accepts(record) ? owner : this.observer;
    } catch (errorValue) {
      this.markCategoryFallback(category, this.describe(owner), `accepts() threw: ${String(errorValue)}`);
      return this.observer;
    }
  }

  private deliverObserver(record: DebugRecord): void {
    this.observerDeliveriesValue += 1;
    try {
      this.observer.consume(record);
    } catch (errorValue) {
      this.errorsValue += 1;
      this.log(`[debug] generic observer threw: ${String(errorValue)}`);
    }
  }

  private deliverMain(record: DebugRecord, main: DebugConsumer): void {
    this.mainDeliveriesValue += 1;
    try {
      main.consume(record);
    } catch (errorValue) {
      // 该分类回退通用视图：后续记录不再投给这个 facet，其他分类不受影响（C.5）。
      this.markCategoryFallback(record.category, this.describe(main), String(errorValue));
    }
  }

  private resetConsumer(consumer: DebugConsumer, reason: DebugResetReason): void {
    try {
      consumer.reset?.(reason);
    } catch (errorValue) {
      this.errorsValue += 1;
      this.log(`[debug] consumer '${this.describe(consumer)}' threw from reset(): ${String(errorValue)}`);
    }
  }

  private describe(consumer: DebugConsumer): string {
    const entry = this.registered.find((candidate) => candidate.consumer === consumer);
    return entry?.label ?? (consumer === this.observer ? "generic" : "consumer");
  }
}

export interface GenericDebugConsumerOptions {
  /** 保留的最近记录条数；超出的最旧记录被挤出（总数仍累计）。 */
  readonly maxRecords?: number;
}

/** 通用消费者保留的最近记录条数（面板的通用窗口以 store 为准，这里只做观察者样本）。 */
export const GENERIC_DEBUG_CONSUMER_MAX_RECORDS = 2_000;

/**
 * 通用兜底消费者（附录 C.5）。
 *
 * 它**不认领任何分类**（`categories` 为空）：要么作为观察者收到每条记录的副本，
 * 要么在无 facet 认领时兼任主消费者——两种身份下 `consume` 的行为一致，
 * 都只是"留下一条自己的副本 + 累计计数"。
 */
export class GenericDebugConsumer implements DebugConsumer {
  public readonly categories: readonly string[] = [];
  private readonly maxRecords: number;
  private readonly recordsValue: DebugRecord[] = [];
  private totalValue = 0;
  private droppedValue = 0;

  public constructor(options: GenericDebugConsumerOptions = {}) {
    this.maxRecords = options.maxRecords ?? GENERIC_DEBUG_CONSUMER_MAX_RECORDS;
  }

  /** 观察者接受一切（C.5：通用视图总是收到记录）。 */
  public accepts(): boolean {
    return true;
  }

  public consume(record: DebugRecord): void {
    this.totalValue += 1;
    this.recordsValue.push(record);
    while (this.recordsValue.length > this.maxRecords) {
      this.recordsValue.shift();
      this.droppedValue += 1;
    }
  }

  public reset(): void {
    this.recordsValue.length = 0;
    this.totalValue = 0;
    this.droppedValue = 0;
  }

  /**
   * 保留的最近记录（**与 `DebugStore` 共用同一条记录对象，不是副本**）。
   *
   * 观察者只做展示：记录本身由 store 拥有，任何消费者（包括模块 facet）都不得改写它；
   * 投递给模块的是 `toPublicRecord` 造出来的独立投影（`params` 深拷贝），不是这里的引用。
   */
  public get records(): readonly DebugRecord[] {
    return this.recordsValue;
  }

  /** 累计收到的记录条数（不受保留上限影响）。 */
  public get total(): number {
    return this.totalValue;
  }

  /** 因保留上限被挤出的条数。 */
  public get dropped(): number {
    return this.droppedValue;
  }

  public get lastRecord(): DebugRecord | undefined {
    return this.recordsValue[this.recordsValue.length - 1];
  }

  /** 某个实例的最近记录（面板按实例过滤时用）。 */
  public recordsForInstance(instanceId: string): readonly DebugRecord[] {
    return this.recordsValue.filter((record) => record.instanceId === instanceId);
  }

  /** 某个分类的最近记录。 */
  public recordsForCategory(category: string): readonly DebugRecord[] {
    return this.recordsValue.filter((record) => record.category === category);
  }
}
