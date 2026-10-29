/**
 * 调试面板的状态模型（附录 C.7）：把 F2 的实例表 / store / 游标翻译成**可直接 JSON 序列化**
 * 的面板快照。Webview 只做渲染与转发点击，所有判断都留在这里（宿主可单测、可被宿主测试驱动）。
 *
 * 与 F2 的接力约定（任务书 §四条会被评审重点打的点）逐条落在这里：
 * 1. **暂停只停 UI 刷新**：{@link DebugPanelModel.pause} 只置 `paused`（并让 store 停止发通知），
 *    记录照常 `append`；{@link DebugPanelModel.resume} 从 store 重新读，一条不丢。
 * 2. **时间轴起点用 `recordsFrom().fromPosition`**（不是 `requestedPosition`），
 *    `partial` 一律翻译成"历史未记录"。
 * 3. **`replay()` 不动游标**：{@link DebugPanelModel.replayToLive} 自己把游标移到末尾。
 * 4. 关键帧表 `list()` 返回内部数组：本模型只读 `count()`，不持有 `list()` 的返回值。
 *
 * 帧分组只复用 F2 的 {@link groupRecordsByFrame}（同一份语义：连续同帧号成组、不连续视为两帧、
 * `frame == -1` 自成一组、回退/重复**只按到达顺序**分组、不重排）。
 *
 * 大记录量（评审清单 P1）：时间轴只渲染**游标附近的窗口**（{@link DEBUG_PANEL_WINDOW_RECORDS} 条），
 * 不把 2 万条塞进一条消息；步进仍然交给 store（按整表算，不受窗口影响）。
 */

import {
  groupRecordsByFrame,
  type DebugCursorDirection,
  type DebugCursorGranularity,
  type DebugRecord,
} from "../bridge/debugStore";
import type { DebugClearInstanceResult, DebugInstanceView } from "../bridge/debugInstanceManager";
import type { DebugFacetSnapshot } from "./debugFacetRouter";
import type { DebugEnableState, DebugEnableSwitch } from "./debugEnableSwitch";

/** 时间轴一次最多渲染多少条记录（P1 的 2 万条卡顿对策）。 */
export const DEBUG_PANEL_WINDOW_RECORDS = 500;

/** 参数值 / 原始 JSON 的单值预览上限（P1：`byte[]` 是 base64，必须截断）。 */
export const DEBUG_PANEL_VALUE_PREVIEW_LIMIT = 160;

/** 没有接入模块 facet 时的空快照（面板仍然可用，全部走通用视图）。 */
export const EMPTY_DEBUG_FACET_SNAPSHOT: DebugFacetSnapshot = {
  windows: [],
  pending: 0,
  batches: 0,
  failures: 0,
  batchLimit: 0,
  lateRecords: 0,
  generic: { records: 0, dropped: 0 },
};

/** 面板用到的 manager 子集：单测可以喂一个只实现这些成员的假对象。 */
export interface DebugPanelSource {
  readonly instances: readonly DebugInstanceView[];
  instance(key: string): DebugInstanceView | undefined;
  storeFor(key: string): DebugPanelStoreSource | undefined;
  replay(category: string): unknown;
  /** 实例级清空（**不**在内部重建整个分类，见 `DebugInstanceManager.clearInstance`）。 */
  clearInstance(key: string): DebugClearInstanceResult | undefined;
  select(key: string | undefined): void;
}

/** 面板用到的 store 子集。 */
export interface DebugPanelStoreSource {
  readonly instanceId: string;
  readonly category: string;
  readonly bytes: number;
  readonly recordCount: number;
  readonly earliestPosition: number;
  readonly endPosition: number;
  readonly cursor: { readonly position: number; readonly partial: boolean };
  readonly paused: boolean;
  recordsFrom(position: number): {
    readonly requestedPosition: number;
    readonly fromPosition: number;
    readonly toPosition: number;
    readonly partial: boolean;
    readonly records: readonly DebugRecord[];
  };
  /** 窗口读取：`[from, to)`，不复制到末尾（P2-2）。 */
  recordsBetween(fromPosition: number, toPosition: number): {
    readonly requestedPosition: number;
    readonly fromPosition: number;
    readonly toPosition: number;
    readonly partial: boolean;
    readonly records: readonly DebugRecord[];
  };
  /** O(1) 取一条（不复制数组）：时间轴明细只用它（P2-2）。 */
  recordAtPosition(position: number): DebugRecord | undefined;
  applyCursor(position: number): unknown;
  step(granularity: DebugCursorGranularity, direction: DebugCursorDirection): unknown;
  pause(): void;
  resume(): void;
}

/** 状态栏的两个收帧来源（E10）：四种组合（都无 / 仅 Editor / 仅 Runtime / 两者）都必须可区分。 */
export interface DebugPanelConnectionSources {
  readonly editor: boolean;
  readonly runtime: boolean;
}

/** 宿主注入的 Runtime 腿状态（E10）；缺省 = 未接线，面板退回只读 Editor 腿。 */
export interface DebugPanelRuntimeLeg {
  readonly state: "disconnected" | "connecting" | "connected" | "failed";
  /** 未连接/失败时的可读原因（Unity 未开、端口段无响应等）。 */
  readonly detail?: string;
  readonly endpointId?: string;
  readonly target?: string;
  readonly connectType?: "editor" | "editor-player" | "player";
}

/** 连接信息（状态栏：连接状态、收帧来源、`endpointId`、目标地址、当前帧）。 */
export interface DebugPanelConnection {
  readonly state: "connected" | "disconnected";
  /**
   * 实际收帧来源（E10）：旧实现只读 Editor 腿，只有 Runtime 腿在线时状态栏显示"未连接"而实例行在更新。
   */
  readonly sources: DebugPanelConnectionSources;
  /**
   * "Debug 上报"开关能否发出去：只有 Editor 腿承载 `debugSetEnabled`（Runtime 腿的 ch0 只认 hello/request，
   * 多发一条是连接级错误），因此 Runtime 腿在线不代表开关可点。
   */
  readonly canRequestEnable: boolean;
  /** 未连接时的可读原因（E10：连接失败可重试，不弹模态框）。 */
  readonly detail: string | undefined;
  readonly endpointId: string | undefined;
  readonly target: string | undefined;
  /** A.3 的 `connectType`；`player` 时开关置灰（C.7）。 */
  readonly connectType: "editor" | "editor-player" | "player" | undefined;
  readonly frame: number;
}

export interface DebugPanelConnectionInput {
  /** Editor 腿的 `debugReporting`（只读 Editor 腿的连接状态）。 */
  readonly editor: {
    readonly available: boolean;
    readonly endpointId?: string | undefined;
    readonly target?: string | undefined;
    readonly connectType?: "editor" | "editor-player" | "player" | undefined;
  } | undefined;
  /** Runtime 腿状态（E10 的生产连接触发器）。 */
  readonly runtime: DebugPanelRuntimeLeg | undefined;
  /** 宿主测试的 connectType 覆盖（生产上只能来自 A.3 的 `connectType`）。 */
  readonly connectTypeOverride?: "editor" | "editor-player" | "player";
  readonly frame: number;
}

/**
 * 合并两条腿的连接信息（E10）：状态栏必须反映**实际收帧来源**，不得自相矛盾。
 * 纯函数，单测直接覆盖四种来源组合与失败原因。
 */
export function mergeDebugPanelConnection(input: DebugPanelConnectionInput): DebugPanelConnection {
  const editor = input.editor;
  const editorConnected = editor?.available === true;
  const runtimeConnected = input.runtime?.state === "connected";
  const connected = editorConnected || runtimeConnected;
  const connectType = input.connectTypeOverride
    ?? (editorConnected ? editor?.connectType : runtimeConnected ? input.runtime?.connectType : undefined);
  return {
    state: connected ? "connected" : "disconnected",
    sources: { editor: editorConnected, runtime: runtimeConnected },
    canRequestEnable: editorConnected,
    detail: connected ? undefined : input.runtime?.detail,
    endpointId: editorConnected ? editor?.endpointId : runtimeConnected ? input.runtime?.endpointId : undefined,
    target: editorConnected ? editor?.target : runtimeConnected ? input.runtime?.target : undefined,
    connectType,
    frame: input.frame,
  };
}

/** 实例列表一行。 */
export interface DebugPanelInstanceRow {
  readonly key: string;
  readonly category: string;
  readonly instanceId: string;
  readonly resName: string;
  readonly debugInfo: string;
  /** 该实例已出现过的接口（关键词筛选要匹配 `interface`，C.7）。 */
  readonly interfaces: readonly string[];
  readonly recordCount: number;
  readonly bytes: number;
  readonly frame: number;
  readonly active: boolean;
  readonly endedReason: string | undefined;
  readonly descriptorMissing: boolean;
  readonly historyMissing: boolean;
  readonly selected: boolean;
  /**
   * 数据来源腿（E9）：`editor` = Editor 桥，`runtime` = Runtime 桥，`undefined` = 未标注。
   * 只用于显示（两个 Unity 进程可能同名），不参与协议身份。
   */
  readonly origin: "editor" | "runtime" | undefined;
  /** 同一身份同时出现在两条腿上（保留首条记录，这里显式标冲突）。 */
  readonly originConflict: boolean;
}

/** 参数表格的一行（通用窗口）。 */
export interface DebugPanelArgRow {
  readonly tag: number;
  readonly name: string | undefined;
  readonly type: string | undefined;
  readonly preview: string;
}

/** 当前记录明细（通用窗口：参数表格 + 原始 JSON 视图）。 */
export interface DebugPanelDetail {
  readonly id: number;
  readonly kind: string;
  readonly category: string;
  readonly instanceId: string;
  readonly interfaceId: string;
  readonly method: string;
  readonly frame: number;
  readonly wireBytes: number;
  readonly receivedAt: number;
  readonly contractState: string;
  readonly args: readonly DebugPanelArgRow[];
  /** 契约未命中：只列非默认值（C.2）。 */
  readonly namedOnly: boolean;
  readonly json: string;
  readonly truncated: boolean;
}

/** 时间轴的一条（轻量：明细只在 {@link DebugPanelDetail} 里给）。 */
export interface DebugPanelRecordRow {
  readonly position: number;
  readonly id: number;
  readonly frame: number;
  readonly method: string;
  readonly interfaceId: string;
  readonly instanceId: string;
  readonly kind: string;
  readonly wireBytes: number;
  readonly receivedAt: number;
  /** 是否为一段连续同帧号记录的首条（渲染帧边界）。 */
  readonly frameStart: boolean;
  readonly current: boolean;
}

/** 时间轴快照。 */
export interface DebugPanelTimeline {
  readonly selected: boolean;
  /** 调用方请求的绝对位置（仅诊断）。 */
  readonly requestedPosition: number;
  /** **渲染起点**：`recordsFrom` 的实际起点，不是 `requestedPosition`（F2 约定）。 */
  readonly fromPosition: number;
  readonly toPosition: number;
  readonly cursor: number;
  readonly earliestPosition: number;
  /** 请求位置早于最早可用记录：`fromPosition > requestedPosition`。 */
  readonly partial: boolean;
  /** 淘汰/清空导致历史缺失 ⇒ UI 标"历史未记录"（C.4）。 */
  readonly historyMissing: boolean;
  /** 已渲染窗口的起点与其是否被截断。 */
  readonly windowStart: number;
  readonly windowTruncated: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly groups: readonly DebugPanelFrameGroup[];
  readonly records: readonly DebugPanelRecordRow[];
  readonly detail: DebugPanelDetail | undefined;
}

/** 帧组（按到达顺序；同一帧号不连续就是两组）。 */
export interface DebugPanelFrameGroup {
  readonly frame: number;
  readonly count: number;
  /** 组首条记录在实例内的绝对位置。 */
  readonly position: number;
}

/** 面板快照：Webview 的唯一输入。 */
export interface DebugPanelSnapshot {
  readonly revision: number;
  readonly paused: boolean;
  readonly granularity: DebugCursorGranularity;
  /** "实时"= 跟随末尾；"逐步"= 用户在手动步进。 */
  readonly mode: "live" | "replay";
  readonly filter: string;
  readonly selectedKey: string | undefined;
  readonly enable: DebugEnableState;
  readonly connection: DebugPanelConnection;
  readonly instances: readonly DebugPanelInstanceRow[];
  readonly totalInstances: number;
  readonly timeline: DebugPanelTimeline;
  readonly recording: DebugPanelRecordingState;
  /** 模块 `debug` facet 的类型窗口区域（D.4）：标题/工具条归宿主，内容由模块给。 */
  readonly facets: DebugFacetSnapshot;
  /** 回看中（F5）：Webview 据此显示"返回实时"，并把录制按钮标成"回看模式下不可录制"。 */
  readonly replay?: DebugPanelReplayState;
  /**
   * 查询入口状态（F6）：在途/上限/最近提示。回看模式下 `available=false`（没有传输层）。
   * 缺省时 Webview 按"不可查询"渲染（不显示按钮）。
   */
  readonly query?: DebugPanelQueryState;
  /** 宿主投递诊断：Webview 消息失败计数（P1：不能被吞掉）。 */
  readonly delivery: {
    readonly webviewFailures: number;
  };
  /** 状态栏附加信息。 */
  readonly status: {
    readonly records: number;
    readonly bytes: number;
    readonly keyframes: number;
    readonly frame: number;
  };
}

/** 录制按钮（F5 提供能力；F3 只挂按钮，不实现录制本身）。 */
export interface DebugPanelRecordingState {
  /** F5 是否已接入（未接入时按钮置灰并说明原因，而不是假装能录）。 */
  readonly available: boolean;
  readonly active: boolean;
}

/** 回看状态（F5）：文件身份 + 文件尾统计；`footer` 缺失 = 录制被截断或未正常收尾。 */
export interface DebugPanelReplayState {
  readonly filePath: string;
  readonly records: number | undefined;
  readonly droppedRecords: number | undefined;
  readonly endedReason: string | undefined;
  /**
   * 无法归属的二进制数据帧（F6，冲突三）：录制只含单向帧（没有 `request`），
   * 无法区分 `debug` / `debugResult`；这些帧被计数且**不假装归属**。
   * 缺省/0 表示没有。UI 必须显式提示，不能当没发生。
   */
  readonly unattributableBinaryFrames?: number;
}

/** 查询入口状态（F6）：结果写入时间轴，失败以 `notice` 呈现。 */
export interface DebugPanelQueryState {
  readonly available: boolean;
  readonly pending: number;
  /** C.1 的在途上限（8）。 */
  readonly limit: number;
  readonly busy: boolean;
  readonly notice: DebugPanelQueryNotice | undefined;
}

export interface DebugPanelQueryNotice {
  readonly kind: "info" | "warning" | "error";
  readonly message: string;
}

/**
 * 单个数据源（在线 / 回看）的 UI 视图快照（F5-08）。
 *
 * `paused` / `followIntent` / `interfaces` / `positioned` / `selectedKey` / `filter` /
 * `granularity` 都是"用户在这个数据源上的浏览状态"；在线与回看是两套实例键空间，混用会泄漏。
 * 进入回看前存一份、退出时原样恢复，回看自己的浏览（含单步产生的 `followIntent=false`）随会话丢弃。
 *
 * `filter` / `granularity` 按数据源独立是**产品选择**（P2-6）：回看里按关键词找实例不应该改掉
 * 在线面板的筛选条件；步进粒度同理（回看常用"按帧"，在线常用"按记录"）。所有浏览状态共用
 * 这一份归档，避免出现"哪些字段该带过去"的第二个判定点。
 */
export interface DebugPanelViewState {
  readonly selectedKey: string | undefined;
  readonly paused: boolean;
  readonly followIntent: boolean;
  readonly resumeFollow: boolean;
  readonly filter: string;
  readonly granularity: DebugCursorGranularity;
  readonly interfaces: ReadonlyMap<string, { position: number; count: number; names: ReadonlySet<string> }>;
  readonly positioned: ReadonlySet<string>;
}

export interface DebugPanelModelOptions {
  readonly manager: DebugPanelSource;
  readonly enable: DebugEnableSwitch;
  /** 连接信息（由宿主从 bridge server 取；单测可给常量）。 */
  readonly connection: () => DebugPanelConnection;
  readonly keyframeCount?: (category: string) => number;
  readonly windowRecords?: number;
  /** 录制能力（F5 注入；缺省"未接入"）。 */
  readonly recording?: () => DebugPanelRecordingState;
  readonly onRecordingToggle?: () => void;
  /** 回看状态（F5）：非空时面板显示"返回实时"，录制按钮置灰。 */
  readonly replay?: () => DebugPanelReplayState | undefined;
  /** 查询入口状态（F6）：缺省 = 不可查询（回看或未接线）。 */
  readonly query?: () => DebugPanelQueryState;
  /** 模块 facet 区域快照（F4；缺省空快照 = 全部走通用视图）。 */
  readonly facets?: () => DebugFacetSnapshot;
  /** Webview 消息失败计数（F4 P1；由控制器累计）。 */
  readonly webviewFailures?: () => number;
  readonly onChange?: () => void;
}

export class DebugPanelModel {
  private readonly manager: DebugPanelSource;
  private readonly enable: DebugEnableSwitch;
  private readonly connection: () => DebugPanelConnection;
  private readonly keyframeCount: (category: string) => number;
  private readonly windowRecords: number;
  private readonly recording: () => DebugPanelRecordingState;
  private readonly onRecordingToggle: (() => void) | undefined;
  private readonly replay: (() => DebugPanelReplayState | undefined) | undefined;
  private readonly query: () => DebugPanelQueryState;
  private readonly facets: () => DebugFacetSnapshot;
  private readonly webviewFailures: () => number;
  private readonly onChange: (() => void) | undefined;
  /** 关键词筛选（匹配 instanceId / resName / category / interface / debugInfo，C.7）。 */
  private filterValue = "";
  private selectedKeyValue: string | undefined;
  private granularityValue: DebugCursorGranularity = "record";
  private pausedValue = false;
  /** 用户意图：true = 跟到末尾（实时），false = 在逐步回放里。 */
  private followIntent = true;
  /** 暂停前的跟随意图：恢复时据此决定是否补到末尾。 */
  private resumeFollow = true;
  /** 每个实例已扫描到的位置与已见接口（关键词筛选要匹配 interface）。 */
  private readonly interfaces = new Map<string, { position: number; count: number; names: Set<string> }>();
  /** 已经在面板里定位过的实例（首次选中贴末尾，之后保留各自游标）。 */
  private readonly positioned = new Set<string>();
  /** 进入回看前保存的在线视图快照；非空 = 当前处于"按数据源隔离"的回看视图（F5-08）。 */
  private savedLiveView: DebugPanelViewState | undefined;
  private revisionValue = 0;

  public constructor(options: DebugPanelModelOptions) {
    this.manager = options.manager;
    this.enable = options.enable;
    this.connection = options.connection;
    this.keyframeCount = options.keyframeCount ?? (() => 0);
    this.windowRecords = options.windowRecords ?? DEBUG_PANEL_WINDOW_RECORDS;
    this.recording = options.recording ?? (() => ({ available: false, active: false }));
    this.onRecordingToggle = options.onRecordingToggle;
    this.replay = options.replay;
    this.query = options.query ?? (() => ({ available: false, pending: 0, limit: 0, busy: false, notice: undefined }));
    this.facets = options.facets ?? (() => EMPTY_DEBUG_FACET_SNAPSHOT);
    this.webviewFailures = options.webviewFailures ?? (() => 0);
    this.onChange = options.onChange;
  }

  public get filter(): string {
    return this.filterValue;
  }

  public get selectedKey(): string | undefined {
    return this.selectedKeyValue;
  }

  public get granularity(): DebugCursorGranularity {
    return this.granularityValue;
  }

  public get paused(): boolean {
    return this.pausedValue;
  }

  /** 关键词筛选（纯视图过滤；不动 C.4 的 `filterKey`，见 {@link DebugPanelModel.clear} 的注释）。 */
  public setFilter(filter: string): void {
    if (filter === this.filterValue) {
      return;
    }

    this.filterValue = filter;
    this.touch();
  }

  /**
   * 选实例：游标与 `partial` 属于 store，因此在切换之间**天然各自保留**（F3 验收 1）。
   * 选中实例同时登记到 manager（实例数上限的"受保护"集合，C.4）。
   */
  public selectInstance(key: string | undefined): void {
    const existed = key === undefined ? undefined : this.manager.instance(key);
    this.selectedKeyValue = existed === undefined ? undefined : key;
    this.manager.select(this.selectedKeyValue);
    if (this.selectedKeyValue === undefined) {
      this.touch();
      return;
    }

    // 首次选中：从末尾看起（等价"实时"）。**切回来**：保留它自己的游标——
    // 这是 C.7 验收标准 1（切换实例保持游标）的判据，不能被"选中即回到末尾"覆盖。
    const store = this.manager.storeFor(this.selectedKeyValue);
    const fresh = !this.positioned.has(this.selectedKeyValue);
    if (fresh) {
      this.positioned.add(this.selectedKeyValue);
      if (store !== undefined) {
        store.applyCursor(store.endPosition);
      }
    }

    // 游标本来就在末尾 ⇒ 继续跟随；停在中间 ⇒ 保持逐步（不静默跳到末尾）。
    this.followIntent = fresh || (store !== undefined && store.cursor.position >= store.endPosition);
    this.touch();
  }

  /** 当前是否处于"回看视图"（在线视图已存档，见 {@link enterReplayView}）。 */
  public get replayViewActive(): boolean {
    return this.savedLiveView !== undefined;
  }

  /**
   * 进入回看：先存档在线视图（选中实例/暂停/跟随意图/接口缓存/已定位集合），再清空视图，
   * 让回看从自己的默认实例开始（F5-08）。
   *
   * 不在这里 `resume()` 在线 store：在线如果进入前是暂停的，其 store 仍是暂停的，退出回看时
   * 原样恢复 `paused=true` 才一致；回看是新 manager，本来就没有暂停。
   */
  public enterReplayView(): void {
    if (this.savedLiveView !== undefined) {
      return;
    }

    this.savedLiveView = this.captureViewState();
    this.resetViewState();
  }

  /** 退出回看：丢弃回看视图，恢复进入前的在线视图（选中实例与 `followIntent` 都回来）。 */
  public exitReplayView(): void {
    const saved = this.savedLiveView;
    this.savedLiveView = undefined;
    if (saved === undefined) {
      this.resetViewState();
      return;
    }

    this.applyViewState(saved);
  }

  private captureViewState(): DebugPanelViewState {
    return {
      selectedKey: this.selectedKeyValue,
      paused: this.pausedValue,
      followIntent: this.followIntent,
      resumeFollow: this.resumeFollow,
      filter: this.filterValue,
      granularity: this.granularityValue,
      interfaces: new Map(
        [...this.interfaces].map(([key, entry]) => [
          key,
          { position: entry.position, count: entry.count, names: new Set(entry.names) },
        ]),
      ),
      positioned: new Set(this.positioned),
    };
  }

  private applyViewState(state: DebugPanelViewState): void {
    // 存档里的实例可能已被在线容量淘汰：恢复不存在的选中会让时间轴空转，直接落回未选中。
    this.selectedKeyValue = state.selectedKey !== undefined && this.manager.instance(state.selectedKey) !== undefined
      ? state.selectedKey
      : undefined;
    this.manager.select(this.selectedKeyValue);
    this.pausedValue = state.paused;
    this.followIntent = state.followIntent;
    this.resumeFollow = state.resumeFollow;
    this.filterValue = state.filter;
    this.granularityValue = state.granularity;
    this.interfaces.clear();
    for (const [key, entry] of state.interfaces) {
      this.interfaces.set(key, { position: entry.position, count: entry.count, names: new Set(entry.names) });
    }

    this.positioned.clear();
    for (const key of state.positioned) {
      this.positioned.add(key);
    }

    this.touch();
  }

  private resetViewState(): void {
    this.selectedKeyValue = undefined;
    this.manager.select(undefined);
    this.pausedValue = false;
    this.followIntent = true;
    this.resumeFollow = true;
    // 回看从自己的默认视图开始：不带在线数据源的关键词筛选与步进粒度（P2-6）。
    this.filterValue = "";
    this.granularityValue = "record";
    this.interfaces.clear();
    this.positioned.clear();
    this.touch();
  }

  public setGranularity(granularity: DebugCursorGranularity): void {
    if (granularity === this.granularityValue) {
      return;
    }

    this.granularityValue = granularity;
    this.touch();
  }

  /**
   * 暂停：只停 UI 刷新（C.7 / P0）。记录仍由 manager 写进 store。
   * 返回是否真的切换了状态（幂等）。
   */
  public pause(): boolean {
    if (this.pausedValue) {
      return false;
    }

    this.pausedValue = true;
    this.resumeFollow = this.followIntent;
    // store 层也停发通知：相位与接收侧的节流对齐，恢复时 flush 一次补上。
    for (const key of this.instanceKeys()) {
      this.manager.storeFor(key)?.pause();
    }

    this.touch();
    return true;
  }

  /** 恢复：解除 store 暂停并重新读一次；暂停期间进入 store 的记录一条不少。 */
  public resume(): boolean {
    if (!this.pausedValue) {
      return false;
    }

    this.pausedValue = false;
    for (const key of this.instanceKeys()) {
      this.manager.storeFor(key)?.resume();
    }

    if (this.resumeFollow) {
      this.followIntent = true;
      this.syncCursorToEnd();
    }

    this.touch();
    return true;
  }

  /**
   * 步进（C.7）：按记录一条 / 按帧一整帧（整帧的分组语义在 `DebugStore.step` 里，只有一份实现）。
   * 暂停中不步进（UI 同时禁用按钮）；边界时游标被 store 夹住，快照里 `atStart` / `atEnd` 为真。
   */
  public step(direction: DebugCursorDirection): boolean {
    if (this.pausedValue) {
      return false;
    }

    const store = this.selectedStore();
    if (store === undefined) {
      return false;
    }

    store.step(this.granularityValue, direction);
    this.followIntent = false;
    this.touch();
    return true;
  }

  /**
   * 回到实时：**先**重建分类主消费者状态，**再**自己把游标移到末尾（F2 约定：`replay()` 不动游标）。
   *
   * 顺序不能反：`replay()` 依据"当前可用的关键帧 + 增量"重建消费者；游标是面板时间轴，
   * 两者独立，但界面必须显示"消费者已追平"的位置。
   */
  public replayToLive(): boolean {
    const store = this.selectedStore();
    if (store === undefined) {
      return false;
    }

    this.manager.replay(store.category);
    this.followIntent = true;
    store.applyCursor(store.endPosition);
    this.touch();
    return true;
  }

  /**
   * 清空当前实例的时间轴（C.7）。
   *
   * 边界是**一个实例**：调用 `DebugInstanceManager.clearInstance`，由它决定分类主消费者是否
   * 已经退化成空（`categoryReset`），还是在同分类还有别的实例记录时只标 `categoryStale`。
   * **不在实例级操作里调用分类级 `replay`**（F3 评审转来的 P1：那会重建整个分类并丢掉
   * `partial`）；需要重建分类时由面板的"按分类重建"动作显式发起。
   */
  public clear(): boolean {
    const key = this.selectedKeyValue;
    if (key === undefined) {
      return false;
    }

    const store = this.manager.storeFor(key);
    if (store === undefined) {
      return false;
    }

    this.manager.clearInstance(key);
    this.interfaces.delete(key);
    store.applyCursor(store.endPosition);
    this.followIntent = true;
    this.touch();
    return true;
  }

  /**
   * 转发开关点击（不带乐观更新；结果只反映服务端/最后已知值）。
   *
   * 回看**显式**拒绝（F5-08）：回看会话没有传输层，`debugSetEnabled` 根本发不出去。直接按
   * `replayViewActive` 守卫，而不是依赖"回看时 connection 恰好是 disconnected"这一间接事实——
   * 后者一旦将来给回看合成一个连接状态就会失守。
   */
  public requestEnabled(target: boolean): void {
    if (this.replayViewActive) {
      this.touch();
      return;
    }

    this.enable.request(target);
    this.touch();
  }

  /**
   * 转发"录制"按钮（F5）。回看**显式拒绝**（P2-7）：回看 manager 是只读重放，录制的是"在线
   * 连接"，没有可绑定的源；命令通道（Webview 消息/测试命令）也可能绕过置灰直接调用，所以
   * 守卫必须在这里，而不是只靠 UI 把按钮画灰。
   */
  public requestRecordingToggle(): void {
    if (this.replayViewActive) {
      this.touch();
      return;
    }

    this.onRecordingToggle?.();
    this.touch();
  }

  /** 外部事件（广播 / welcome）触发的重绘。 */
  public touch(): void {
    this.revisionValue += 1;
    this.onChange?.();
  }

  public get revision(): number {
    return this.revisionValue;
  }

  public snapshot(): DebugPanelSnapshot {
    const connection = this.connection();
    this.enable.setMode(connection.connectType === "player" ? "player" : "editor");
    // 没有 Editor 腿的已握手连接 ⇒ 请求发不出去，按钮置灰（连接断了也要把挂起请求结算掉）。
    // 回看同理：没有传输层，显式置灰（不依赖 connection.state 的间接推断，F5-08）。
    // E10：`canRequestEnable` 与"是否收到帧"解耦——Runtime 腿在线时面板有数据，但开关仍不可点。
    this.enable.setAvailable(connection.canRequestEnable && !this.replayViewActive);
    const instances = this.instanceRows();
    const key = this.selectedKeyValue !== undefined && this.manager.instance(this.selectedKeyValue) !== undefined
      ? this.selectedKeyValue
      : undefined;
    if (this.selectedKeyValue !== undefined && key === undefined) {
      // 实例被淘汰成墓碑/消失：不要静默改选中，只把时间轴降级为空。
      this.selectedKeyValue = undefined;
      this.manager.select(undefined);
    }

    const store = key === undefined ? undefined : this.manager.storeFor(key);
    if (store !== undefined && this.followIntent && !this.pausedValue) {
      this.syncCursorToEnd();
    }

    const category = store?.category;
    const historyMissing = key === undefined ? false : (this.manager.instance(key)?.historyMissing ?? false);
    const replay = this.replay?.();
    return {
      revision: this.revisionValue,
      paused: this.pausedValue,
      granularity: this.granularityValue,
      mode: this.followIntent ? "live" : "replay",
      filter: this.filterValue,
      selectedKey: key,
      enable: this.enable.state,
      connection,
      instances,
      totalInstances: this.manager.instances.length,
      timeline: this.buildTimeline(store, historyMissing),
      recording: this.recording(),
      facets: this.facets(),
      delivery: { webviewFailures: this.webviewFailures() },
      status: {
        records: store?.recordCount ?? 0,
        bytes: store?.bytes ?? 0,
        keyframes: category === undefined ? 0 : this.keyframeCount(category),
        frame: connection.frame,
      },
      ...(replay === undefined ? {} : { replay }),
      query: this.query(),
    };
  }

  private buildTimeline(store: DebugPanelStoreSource | undefined, historyMissing: boolean): DebugPanelTimeline {
    if (store === undefined) {
      // 没有 store 不等于"历史完整"：被容量淘汰的墓碑实例仍有 `historyMissing`（C.4），
      // 调用方已经算好，必须原样带出去，不能被 early return 抹成 false。
      return {
        selected: false,
        requestedPosition: 0,
        fromPosition: 0,
        toPosition: 0,
        cursor: 0,
        earliestPosition: 0,
        partial: false,
        historyMissing,
        windowStart: 0,
        windowTruncated: false,
        atStart: true,
        atEnd: true,
        groups: [],
        records: [],
        detail: undefined,
      };
    }

    const cursor = store.cursor.position;
    // 锚点必须同时看 `pausedValue`：暂停只停 UI，store 里仍有新记录到达；若锚点继续贴末尾，
    // 每次快照都会把暂停期间的新记录渲染出来（C.7 的"暂停"就形同虚设）。
    const anchor = this.followIntent && !this.pausedValue ? store.endPosition : cursor;
    // 故意**不**自己夹取请求位置：让 store 的窗口读取去夹，并把 `fromPosition` / `partial`
    // 如实带出来（F2 约定）。自己先 max 一遍会把"历史未记录"抹成 0。
    const requested = Math.max(0, anchor - this.windowRecords);
    // 窗口**两端都夹住**：只读 `[anchor - 500, anchor)`，不复制到末尾（P2-2）。
    const slice = store.recordsBetween(requested, anchor);
    // 只渲染到锚点：逐步模式下不剧透游标之后的记录。
    const visible = slice.records;
    const groups = groupRecordsByFrame(visible);
    const frameStarts = new Set<number>();
    let offset = 0;
    const groupSummaries: DebugPanelFrameGroup[] = [];
    for (const group of groups) {
      const first = group[0];
      if (first !== undefined) {
        frameStarts.add(first.id);
        groupSummaries.push({ frame: first.frame, count: group.length, position: slice.fromPosition + offset });
      }

      offset += group.length;
    }

    const detailRecord = this.recordAt(store, cursor);
    return {
      selected: true,
      requestedPosition: slice.requestedPosition,
      fromPosition: slice.fromPosition,
      toPosition: slice.toPosition,
      cursor,
      earliestPosition: store.earliestPosition,
      partial: slice.partial,
      // "历史未记录"两个来源：请求位置被夹到最早可用（`partial`），或实例本身已被淘汰/清空。
      historyMissing: slice.partial || historyMissing,
      windowStart: slice.fromPosition,
      windowTruncated: slice.fromPosition > 0,
      atStart: cursor <= store.earliestPosition,
      atEnd: cursor >= store.endPosition,
      groups: groupSummaries,
      records: visible.map((record, index) => ({
        position: slice.fromPosition + index,
        id: record.id,
        frame: record.frame,
        method: record.method,
        interfaceId: record.interfaceId,
        instanceId: record.instanceId,
        kind: record.kind,
        wireBytes: record.wireBytes,
        receivedAt: record.receivedAt,
        frameStart: frameStarts.has(record.id),
        current: slice.fromPosition + index === cursor - 1,
      })),
      detail: detailRecord === undefined ? undefined : detailOf(detailRecord),
    };
  }

  /**
   * 游标指向"下一条要应用的记录"，因此游标对应的记录是 `cursor - 1`（0 位置没有记录）。
   * **O(1)**：走 `recordAtPosition`，不再用 `recordsFrom(cursor - 1)` 复制游标到末尾的整段（P2-2）。
   */
  private recordAt(store: DebugPanelStoreSource, cursor: number): DebugRecord | undefined {
    if (cursor <= store.earliestPosition) {
      return undefined;
    }

    return store.recordAtPosition(cursor - 1);
  }

  private syncCursorToEnd(): void {
    const store = this.selectedStore();
    if (store === undefined) {
      return;
    }

    if (store.cursor.position !== store.endPosition) {
      store.applyCursor(store.endPosition);
    }
  }

  private selectedStore(): DebugPanelStoreSource | undefined {
    return this.selectedKeyValue === undefined ? undefined : this.manager.storeFor(this.selectedKeyValue);
  }

  private instanceKeys(): readonly string[] {
    return this.manager.instances.map((view) => view.key);
  }

  private instanceRows(): readonly DebugPanelInstanceRow[] {
    const filter = this.filterValue.trim();
    const needle = filter.length > 0 ? filter.toLowerCase() : undefined;
    const rows: DebugPanelInstanceRow[] = [];
    for (const view of this.manager.instances) {
      const interfaces = this.interfacesOf(view);
      if (needle !== undefined && !matches(needle, [view.instanceId, view.resName, view.category, view.debugInfo, ...interfaces])) {
        continue;
      }

      rows.push({
        key: view.key,
        category: view.category,
        instanceId: view.instanceId,
        resName: view.resName,
        debugInfo: view.debugInfo,
        interfaces,
        recordCount: view.recordCount,
        bytes: view.bytes,
        frame: view.frame,
        active: view.active,
        endedReason: view.endedReason,
        descriptorMissing: view.descriptorMissing,
        historyMissing: view.historyMissing,
        selected: view.key === this.selectedKeyValue,
        origin: view.origin,
        originConflict: view.originConflict,
      });
    }

    return rows;
  }

  /**
   * 该实例已出现过的接口。增量扫描（只读新记录），首见时全量扫描一次——
   * 关键词筛选要匹配 `interface`（C.7），而实例表本身不带这个字段。
   */
  private interfacesOf(view: DebugInstanceView): readonly string[] {
    const entry = this.interfaces.get(view.key);
    const store = this.manager.storeFor(view.key);
    if (store === undefined) {
      return entry === undefined ? [] : [...entry.names].sort();
    }

    const names = entry?.names ?? new Set<string>();
    // 条数没变就不读尾段：`recordsFrom` 会把"从该位置到末尾"整段拷出来，
    // 200 ms 刷新周期里对每个实例做一次全尾读没有意义（记录数是单调的）。
    if (entry !== undefined && entry.count === store.recordCount) {
      return [...names].sort();
    }

    const from = entry === undefined ? store.earliestPosition : entry.position;
    const slice = store.recordsFrom(from);
    for (const record of slice.records) {
      if (record.interfaceId.length > 0) {
        names.add(record.interfaceId);
      }
    }

    this.interfaces.set(view.key, { position: slice.toPosition, count: store.recordCount, names });
    return [...names].sort();
  }
}

/** 一条记录 → 通用窗口的明细（参数表格 + 原始 JSON，`byte[]`/长字符串截断）。 */
export function detailOf(record: DebugRecord): DebugPanelDetail {
  let truncated = false;
  const args: DebugPanelArgRow[] = [];
  const entries: Record<string, unknown>[] = [];
  for (const [tag, arg] of record.args) {
    const preview = previewValue(arg.value);
    truncated = truncated || preview.truncated;
    const name = typeof arg.name === "string" && arg.name.length > 0 ? arg.name : `arg#${tag}`;
    args.push({
      tag,
      name,
      type: typeof arg.type === "string" ? arg.type : undefined,
      preview: preview.text,
    });
    entries.push({ tag, name, type: arg.type, value: preview.truncated ? preview.text : arg.value });
  }

  return {
    id: record.id,
    kind: record.kind,
    category: record.category,
    instanceId: record.instanceId,
    interfaceId: record.interfaceId,
    method: record.method,
    frame: record.frame,
    wireBytes: record.wireBytes,
    receivedAt: record.receivedAt,
    contractState: record.contractState,
    args,
    // 契约缺失时 `named` 为空（C.2）：通用视图据此标注"仅列出非默认值"。
    namedOnly: record.named.size === 0,
    json: safeJson(entries),
    truncated,
  };
}

/** 单值预览：只截断**超长**字符串（`byte[]` 以 base64 到达），不改短值。 */
export function previewValue(value: unknown): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : safeJson(value);
  if (text.length <= DEBUG_PANEL_VALUE_PREVIEW_LIMIT) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, DEBUG_PANEL_VALUE_PREVIEW_LIMIT)}…(共 ${text.length} 字符)`,
    truncated: true,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => (
      typeof item === "string" && item.length > DEBUG_PANEL_VALUE_PREVIEW_LIMIT
        ? `${item.slice(0, DEBUG_PANEL_VALUE_PREVIEW_LIMIT)}…`
        : item
    )) ?? String(value);
  } catch {
    return String(value);
  }
}

function matches(needle: string, haystack: readonly string[]): boolean {
  for (const value of haystack) {
    if (value.toLowerCase().includes(needle)) {
      return true;
    }
  }

  return false;
}
