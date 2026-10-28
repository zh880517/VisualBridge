/**
 * 分类关键帧注册表（附录 C.4 的"关键帧 + 增量"）。
 *
 * **关键帧属于谁**：快照是**该分类主消费者**的不透明状态（C.5：一条记录恰好一个主消费者，
 * 消费者按 `category` 聚合），不是某个实例的时间轴。因此"这条关键帧对谁有效"由消费者身份
 * 决定——它对整个分类有效，与捕获它的实例无关（实例只是触发者，用于诊断）。
 *
 * **增量怎么裁**：用**全局应用序** `DebugRecord.arrivalSeq`，不是实例内 `position`。
 * 同分类的多个实例交错记录时，关键帧之后的增量可能来自任何一个实例，只按"同一实例的后续记录"
 * 补投会漏掉别的实例（F2 评审 P1-2）。`arrivalSeq` 由 {@link DebugStore.append} 在**写入瞬间**
 * 分配（全局分配器由 manager 注入），因此"分配序 == 应用序"；被暂存到 `Create` 之后才应用的记录
 * 拿到的是它被应用时的序号，永远不会落在关键帧之前（评审第三轮 P1）。
 *
 * **数字口径**（任务书要求不得改）：触发仍是每实例 1 MB / 2000 条（在 `DebugStore` 里计），
 * 上限 64 个按**分类**计——快照是分类级的，若按实例记，同一份分类状态会被复制 N 份。
 */

/** 一个分类级关键帧。 */
export interface DebugKeyframe {
  readonly id: number;
  readonly category: string;
  /**
   * 快照所属主消费者的身份令牌（`DebugRouter.ownerToken` = 注册序）。
   * 换主消费者后旧快照不得再被 restore（否则会把旧 facet 的状态灌进新 facet），
   * 与 `filterKey` 变更同等对待（评审 P2-5）。
   */
  readonly consumerToken: number | undefined;
  /** 消费者显示名（诊断用；身份判定只看 `consumerToken`）。 */
  readonly consumerLabel: string;
  /** 过滤条件指纹：不同 `filterKey` 的关键帧不得混用（C.4）。 */
  readonly filterKey: string;
  /** 触发它的实例（仅用于诊断，不参与有效性判定）。 */
  readonly instanceKey: string;
  readonly instanceId: string;
  /** 触发时该实例的绝对位置（诊断用）。 */
  readonly position: number;
  /** 捕获时的**全局**应用序：重放只补 `arrivalSeq` 更大的记录（跨实例）。 */
  readonly arrivalSeq: number;
  /** 触发时该实例的累计字节数（诊断用，不参与容量记账）。 */
  readonly bytes: number;
  /** 分类主消费者的快照；`undefined` 表示该消费者不支持快照（只能从头重放）。 */
  readonly state: unknown;
}

/** 每个分类最多保留 64 个关键帧（C.4 的"每实例最多 64 个"，口径见文件头）。 */
export const DEBUG_KEYFRAME_MAX_PER_CATEGORY = 64;

/**
 * 有界的关键帧表：按分类各留最近 N 个，超出淘汰最旧。
 *
 * 不主动清理"已失效"的关键帧（增量出现空洞后它自然选不中）：`latest()` 用
 * `minArrivalSeq` 把已淘汰记录之后的基线挡掉，避免把状态重放到比基线更早处。
 */
export class DebugKeyframeRegistry {
  private readonly maxPerCategory: number;
  private readonly byCategory = new Map<string, DebugKeyframe[]>();
  private nextId = 0;

  public constructor(maxPerCategory: number = DEBUG_KEYFRAME_MAX_PER_CATEGORY) {
    this.maxPerCategory = maxPerCategory > 0 ? Math.trunc(maxPerCategory) : DEBUG_KEYFRAME_MAX_PER_CATEGORY;
  }

  /** 记一个关键帧；同一分类超过上限时淘汰最旧（按捕获顺序）。 */
  public capture(input: Omit<DebugKeyframe, "id">): DebugKeyframe {
    this.nextId += 1;
    const keyframe: DebugKeyframe = { id: this.nextId, ...input };
    const list = this.byCategory.get(keyframe.category) ?? [];
    list.push(keyframe);
    while (list.length > this.maxPerCategory) {
      list.shift();
    }

    this.byCategory.set(keyframe.category, list);
    return keyframe;
  }

  /**
   * 该分类最新可用的关键帧，三个条件必须同时成立：
   * - `filterKey` 一致（C.4：过滤变了旧基线不可用）；
   * - `consumerToken` 一致（换主消费者后旧快照不许 cross-restore，评审 P2-5）；
   * - `arrivalSeq >= minArrivalSeq`（= 该分类已淘汰记录的最大应用序；更小说明增量有洞）。
   */
  public latest(
    category: string,
    filterKey: string,
    minArrivalSeq: number,
    consumerToken: number | undefined,
  ): DebugKeyframe | undefined {
    const list = this.byCategory.get(category);
    if (list === undefined) {
      return undefined;
    }

    for (let index = list.length - 1; index >= 0; index -= 1) {
      const keyframe = list[index];
      if (
        keyframe !== undefined
        && keyframe.filterKey === filterKey
        && keyframe.consumerToken === consumerToken
        && keyframe.arrivalSeq >= minArrivalSeq
      ) {
        return keyframe;
      }
    }

    return undefined;
  }

  public list(category: string): readonly DebugKeyframe[] {
    return this.byCategory.get(category) ?? [];
  }

  public count(category: string): number {
    return this.byCategory.get(category)?.length ?? 0;
  }

  public get size(): number {
    let total = 0;
    for (const list of this.byCategory.values()) {
      total += list.length;
    }

    return total;
  }

  /** 清空（全部或某个分类）；过滤条件变化时调用（C.4：不同 filterKey 的关键帧不得混用）。 */
  public clear(category?: string): void {
    if (category === undefined) {
      this.byCategory.clear();
    } else {
      this.byCategory.delete(category);
    }
  }

  /** 新会话：连 id 一起重置。 */
  public reset(): void {
    this.byCategory.clear();
    this.nextId = 0;
  }
}
