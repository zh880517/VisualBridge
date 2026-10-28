/**
 * 独立 Debug 面板（附录 C.7）的宿主控制器。
 *
 * 职责边界：
 * - **HTML 只有一个来源**：{@link createModuleWebviewHtml}（C2b 引入，CSP/nonce 不可被改写）；
 * - **资源发布走 `webviewAssets` 的机制**：{@link publishDebugPanelAssets} 用 `unpackModuleWebviews`
 *   按内容哈希落到 `<globalStorage>/debugPanel/<sha256>/`。落地根**不是** `<globalStorage>/modules`，
 *   因为那个目录由模块装载器独占清理（`cleanModuleWebviewDirectories` 会删掉没被任何模块引用的
 *   hash 目录），面板不是模块，放进去会在下次模块重载时被删成空白；
 * - **数据只从 `EditorBridgeServer.debug` 取**（F2），不新建连接、不解析 `graphExecution`；
 * - 开关状态只以 `welcome.debugEnabled` 与 `debugEnabled` 广播为准（{@link DebugEnableSwitch}）。
 *
 * 面板关闭时**保留**模型与已缓存记录（同一 manager 的内存），重开只重绘、不重新拉取。
 */

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { DebugCursorDirection, DebugCursorGranularity } from "../bridge/debugStore";
import type { DebugInstanceManager } from "../bridge/debugInstanceManager";
import type { DebugQueryResult } from "../bridge/debugQueryClient";
import type { EditorBridgeDebugQueryState, EditorBridgeDebugReportingReason } from "../bridge/editorBridgeServer";
import { DebugReplaySession } from "../bridge/debugReplaySession";
import { createModuleWebviewHtml } from "../editor/moduleWebviewHtml";
import { publishDebugPanelAssets } from "./debugPanelAssets";
import type { UnpackedModuleWebview } from "../modules/webviewAssets";
import { DebugEnableSwitch, DEBUG_ENABLE_TIMEOUT_MS, type DebugEnableMode } from "./debugEnableSwitch";
import {
  DebugPanelModel,
  EMPTY_DEBUG_FACET_SNAPSHOT,
  type DebugPanelConnection,
  type DebugPanelQueryNotice,
  type DebugPanelQueryState,
  type DebugPanelRecordingState,
  type DebugPanelReplayState,
  type DebugPanelSnapshot,
  type DebugPanelSource,
} from "./debugPanelState";
import type { DebugFacetReplayView, DebugFacetSnapshot } from "./debugFacetRouter";

export const DEBUG_PANEL_VIEW_TYPE = "visualbridge.debugPanel";
export const DEBUG_PANEL_TITLE = "VisualBridge Debug";

/** 面板可见时的刷新周期：比接收侧的 50 ms 合批宽，又不至于让人眼觉得"卡住"。 */
export const DEBUG_PANEL_REFRESH_MS = 200;

/** 控制器用到的 bridge server 子集（宿主里就是 `EditorBridgeServer`）。 */
export interface DebugPanelBridge {
  readonly debug: DebugInstanceManager;
  readonly debugReporting: {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly connectType: "editor" | "editor-player" | "player" | undefined;
    readonly endpointId: string | undefined;
    readonly target: string | undefined;
  };
  /** 发送 `debugSetEnabled`；`false` = 没有可用连接（请求没出去）。 */
  requestDebugReportingEnabled(enabled: boolean): boolean;
  /**
   * 调试查询（F6）：`state()` 用于按钮置灰与提示，`query()` 发起一次查询并等待结果。
   * 缺省视为未接线（按钮不显示）。
   */
  readonly debugQuery?: {
    /** 传实例键时只反映该实例所属连接（F6 多连接路由）；缺省取当前/首条连接。 */
    state(instanceKey?: string): EditorBridgeDebugQueryState;
    /**
     * `options.methodId` 显式给方法号：工作区没有调试契约（`debug-contracts.json` 的
     * `categories` 为空）时，"方法名 → 方法号"无从解析，只能由调用方给号（C.1 的字段）。
     */
    query(instanceKey: string, interfaceId: string, method: string, options?: { readonly methodId?: number }): Promise<DebugQueryResult>;
    /** 切换实例时取消旧实例的在途查询（"用户取消"文案，区别于断连）。 */
    cancelInstance(instanceKey: string, reason?: "user" | "disconnect"): number;
  };
}

/** 面板呈现的模块 facet 区域（F4；缺省时全部走通用视图）。 */
export interface DebugPanelFacets {
  snapshot(): DebugFacetSnapshot;
  /** 显式分类级重建（"按分类重建"按钮）；返回的 `partial` 会进窗口快照。 */
  replayCategory(category: string): DebugFacetReplayView | undefined;
  /** 回看结束时释放模块消费者（在线 host 由扩展生命周期管理，不需要）。 */
  dispose?(): void;
}

export interface DebugPanelControllerOptions {
  /** `context.globalStorageUri`：面板资源落在它下面的 `debugPanel/`。 */
  readonly storageUri: vscode.Uri;
  readonly bridge: () => DebugPanelBridge | undefined;
  /** 模块 `debug` facet 的类型窗口区域（F4）。 */
  readonly facets?: DebugPanelFacets;
  /**
   * 回看时的模块 facet 区域（F5）：按**回看 manager** 新建，退出回看时释放；
   * 缺省时回看期间没有模块消费者，facet 区域回退通用视图。
   */
  readonly replayFacets?: (session: DebugReplaySession) => DebugPanelFacets;
  /**
   * 录制能力（F5 提供；缺省视为未接入，按钮置灰）。
   */
  readonly recording?: {
    readonly get: () => DebugPanelRecordingState;
    toggle(): void;
  };
  readonly log?: (message: string) => void;
  readonly enableTimeoutMs?: number;
  readonly refreshMs?: number;
}

interface DebugPanelCommandMessage {
  readonly type: "command";
  readonly command: string;
  readonly value?: unknown;
  readonly direction?: unknown;
  readonly key?: unknown;
  /** 查询命令（F6）：Webview 从当前记录明细带出接口/方法。 */
  readonly interfaceId?: unknown;
  readonly method?: unknown;
}

export class DebugPanelController implements vscode.Disposable {
  private readonly options: DebugPanelControllerOptions;
  private readonly model: DebugPanelModel;
  private readonly enable: DebugEnableSwitch;
  /** 在线数据源（`EditorBridgeServer.debug`）；回看时仍然保留，只是不再被读。 */
  private readonly liveManager: DebugInstanceManager;
  /** 面板的数据源代理：在线 manager 与回看 manager 之间切换。 */
  private readonly source: DebugPanelSource;
  private replay: { readonly session: DebugReplaySession; readonly facets: DebugPanelFacets | undefined } | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private assets: Promise<UnpackedModuleWebview> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private disposed = false;
  /** 推给 Webview 的状态消息失败次数（P1：失败不能被吞掉）。 */
  private webviewFailuresValue = 0;
  /** 测试专用：把连接类型钉成指定值（生产上只能来自 A.3 的 `connectType`）。 */
  private modeOverride: DebugEnableMode | undefined;
  /** 最近一次查询动作的提示（F6）：由 Promise 结算写入，覆盖服务端的最近提示。 */
  private queryNoticeValue: DebugPanelQueryNotice | undefined;
  /** 打开次数（宿主测试用它确认"重开"没有重新拉取）。 */
  private openCount = 0;

  public constructor(options: DebugPanelControllerOptions) {
    this.options = options;
    const bridge = options.bridge();
    const manager = bridge?.debug;
    if (manager === undefined) {
      throw new Error("Debug panel requires the Editor Bridge debug manager.");
    }

    this.enable = new DebugEnableSwitch({
      mode: this.currentMode(),
      initialEnabled: bridge?.debugReporting.enabled ?? false,
      timeoutMs: options.enableTimeoutMs ?? DEBUG_ENABLE_TIMEOUT_MS,
      transport: { sendSetEnabled: (enabled) => this.options.bridge()?.requestDebugReportingEnabled(enabled) ?? false },
      onChange: () => this.scheduleRefresh(),
    });
    this.liveManager = manager;
    const current = (): DebugInstanceManager => this.currentManager();
    this.source = {
      get instances() {
        return current().instances;
      },
      instance: (key) => current().instance(key),
      storeFor: (key) => current().storeFor(key),
      replay: (category) => current().replay(category),
      clearInstance: (key) => current().clearInstance(key),
      select: (key) => current().select(key),
    };
    this.model = new DebugPanelModel({
      manager: this.source,
      enable: this.enable,
      connection: () => this.currentConnection(),
      recording: () => this.currentRecordingState(),
      onRecordingToggle: () => this.options.recording?.toggle(),
      replay: () => this.replayState(),
      query: () => this.queryState(),
      keyframeCount: (category) => this.currentManager().keyframes.count(category),
      facets: () => this.currentFacets()?.snapshot() ?? EMPTY_DEBUG_FACET_SNAPSHOT,
      webviewFailures: () => this.webviewFailuresValue,
      onChange: () => this.scheduleRefresh(),
    });
  }

  // ==== 对外（命令与宿主测试） ====

  public get isOpen(): boolean {
    return this.panel !== undefined;
  }

  public get isReady(): boolean {
    return this.ready;
  }

  /** 模块路由 / 加载状态变化后立刻重推一次快照（等刷新周期会让"模块未加载"慢一拍）。 */
  public refreshNow(): void {
    this.sendState();
  }

  public get openCountForTest(): number {
    return this.openCount;
  }

  /** 打开（已打开则显示并重绘；不重建模型，因此已缓存记录不重新拉取）。 */
  public async open(): Promise<DebugPanelSnapshot> {
    if (this.disposed) {
      throw new Error("The debug panel controller is disposed.");
    }

    if (this.panel !== undefined) {
      this.panel.reveal(undefined, false);
      this.ready = true;
      this.startRefresh();
      this.updateTitle();
      this.sendState();
      return this.model.snapshot();
    }

    const assets = await this.ensureAssets();
    const panel = vscode.window.createWebviewPanel(
      DEBUG_PANEL_VIEW_TYPE,
      DEBUG_PANEL_TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [assets.directoryUri],
      },
    );
    this.panel = panel;
    this.openCount += 1;
    panel.webview.html = this.html(panel, assets);
    this.updateTitle();
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.stopRefresh();
    });
    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible) {
        this.startRefresh();
        this.sendState();
      } else {
        this.stopRefresh();
      }
    });
    this.startRefresh();
    return this.model.snapshot();
  }

  /** 关闭面板（模型、游标与缓存保留，重开直接重绘）。 */
  public close(): void {
    // 关闭前必须先把数据源切回在线：若停在回看，`exitReplayView()` 会恢复进入前的
    // `paused=true`，随后 `resume()` 解开的才是**线上** store（P2-3）。
    // 顺序反了（先 resume 再退出回看）会 resume 回看 manager，线上 store 永久停在暂停态，
    // `pendingAppended` 还会无界增长。
    if (this.isReplaying) {
      this.closeRecording();
    }

    const panel = this.panel;
    this.panel = undefined;
    this.ready = false;
    this.stopRefresh();
    panel?.dispose();
    // 暂停状态不能在面板消失后继续压住 store 的通知（那是全局副作用）。
    this.model.resume();
  }

  // ==== 回看（F5） ====

  /** 是否处于回看模式（录制按钮在回看期间不可用）。 */
  public get isReplaying(): boolean {
    return this.replay !== undefined;
  }

  /** 宿主测试的读入口：当前回看会话。 */
  public get replaySessionForTest(): DebugReplaySession | undefined {
    return this.replay?.session;
  }

  /**
   * 打开一个 `.vbdrec` 并把面板切到回看：
   * - 数据源换成回看会话自己的 manager（与在线 manager 完全隔离）；
   * - 合成了 welcome（`resumed:false`、`debugEnabled:true`）与文件内契约快照，不连 Unity；
   * - 未打开面板时顺带打开，回看完 `closeRecording()` 切回在线。
   */
  public async openRecording(filePath: string): Promise<DebugPanelSnapshot> {
    if (this.disposed) {
      throw new Error("The debug panel controller is disposed.");
    }

    const session = await DebugReplaySession.load(filePath);
    this.closeRecording();
    this.replay = {
      session,
      facets: this.options.replayFacets?.(session),
    };
    // 回看有自己的一套实例键空间：存档在线视图（选中/暂停/跟随/接口缓存），回看从默认实例重来。
    this.model.enterReplayView();
    const footer = session.footer;
    this.options.log?.(
      `[debug] replay opened: ${filePath} (${footer?.records ?? "?"} records, endedReason=${footer?.endedReason ?? "none"})`,
    );
    this.updateTitle();
    try {
      const snapshot = await this.open();
      this.sendState();
      return snapshot;
    } catch (errorValue) {
      // 面板资源不可用等失败：不能把数据源留在"打不开的回看"上。
      this.closeRecording();
      throw errorValue;
    }
  }

  /** 退出回看（释放回看 manager 与模块消费者），面板切回在线数据源并恢复进入前的选中/跟随状态。 */
  public closeRecording(): void {
    const replay = this.replay;
    this.replay = undefined;
    if (replay !== undefined) {
      replay.facets?.dispose?.();
      replay.session.dispose();
      this.options.log?.(`[debug] replay closed: ${replay.session.filePath}`);
    }

    // 只有真正退出回看时才恢复在线视图；openRecording 开头的"先关旧的"不会清掉在线选中。
    if (this.model.replayViewActive) {
      this.model.exitReplayView();
    }

    this.updateTitle();
    this.sendState();
  }

  /** 逐条命令入口（Webview 与宿主测试共用）。 */
  public handleCommand(
    command: string,
    payload: {
      value?: unknown;
      direction?: unknown;
      key?: unknown;
      interfaceId?: unknown;
      method?: unknown;
      methodId?: unknown;
    } = {},
  ): DebugPanelSnapshot {
    switch (command) {
      case "select": {
        const nextKey = typeof payload.key === "string" ? payload.key : undefined;
        const previousKey = this.model.selectedKey;
        if (!this.isReplaying && previousKey !== undefined && previousKey !== nextKey) {
          // 切换实例：旧实例的在途查询按"用户取消"结算并提示（P1，与断连文案区分）。
          const cancelled = this.options.bridge()?.debugQuery?.cancelInstance(previousKey, "user") ?? 0;
          if (cancelled > 0) {
            this.queryNoticeValue = { kind: "warning", message: `已取消 ${cancelled} 条属于上一实例的查询。` };
          }
        }

        this.model.selectInstance(nextKey);
        break;
      }
      case "filter":
        this.model.setFilter(typeof payload.value === "string" ? payload.value : "");
        break;
      case "granularity":
        this.model.setGranularity(asGranularity(payload.value));
        break;
      case "togglePause":
        if (this.model.paused) {
          this.model.resume();
        } else {
          this.model.pause();
        }

        break;
      case "clear":
        this.model.clear();
        break;
      case "replayCategory":
        if (typeof payload.value === "string") {
          // 返回值（applied/partial）由宿主写进窗口快照；`undefined` 表示该分类没有可重建的
          // 模块消费者（模块未加载/已回退通用视图），宿主会记日志，面板此时也已禁用该按钮
          // 并给出"重载模块后自动恢复"的提示（F4 返修 P1 a / P2-2），不会假装重建成功。
          this.currentFacets()?.replayCategory(payload.value);
        }

        break;
      case "step":
        this.model.step(asDirection(payload.direction));
        break;
      case "live":
        this.model.replayToLive();
        break;
      case "toggleRecording":
        // 命令通道的显式守卫（P2-7）：回看没有录制源，不能只靠 Webview 把按钮画灰。
        if (this.isReplaying) {
          this.options.log?.("[debug] recording toggle ignored: the panel is showing a replay.");
          break;
        }

        this.model.requestRecordingToggle();
        break;
      case "closeRecording":
        this.closeRecording();
        break;
      case "enable":
        this.model.requestEnabled(payload.value === true);
        break;
      case "query":
        // 异步：先返回当前快照（按钮立即进入"在途"提示），结算后再推一次状态。
        this.runQuery(payload);
        break;
      default:
        this.options.log?.(`[debug] unknown panel command '${command}'`);
        break;
    }

    const snapshot = this.model.snapshot();
    this.sendState();
    return snapshot;
  }

  /** 状态快照（宿主测试的读入口；与推给 Webview 的是同一份）。 */
  public getSnapshot(): DebugPanelSnapshot {
    return this.model.snapshot();
  }

  /**
   * 查询入口状态（F6）：回看没有传输层，固定不可用；在线时以 bridge 的在途/上限/最近提示为准。
   * 最近一次查询动作的提示优先于服务端缓存（它是用户刚点的这条）。
   */
  private queryState(): DebugPanelQueryState {
    const notice = this.queryNoticeValue;
    if (this.isReplaying) {
      return { available: false, pending: 0, limit: 0, busy: false, notice };
    }

    const query = this.options.bridge()?.debugQuery;
    if (query === undefined) {
      return { available: false, pending: 0, limit: 0, busy: false, notice };
    }

    // 按当前选中实例所属的连接取状态：多连接时不把别的连接的 pending/busy 算进来（F6 路由）。
    const state = query.state(this.model.selectedKey);
    return {
      available: state.available,
      pending: state.pending,
      limit: state.limit,
      busy: state.busy,
      notice: notice ?? state.notice,
    };
  }

  /**
   * 发起一次查询（F6）：失败/超时/忙都只变成一条可读提示，**不重试**、不影响接收。
   * 结果由 bridge 以 `kind: "queryResult"` 记录写进时间轴（`frame` 是发起时的帧）。
   */
  private runQuery(payload: { key?: unknown; interfaceId?: unknown; method?: unknown; methodId?: unknown }): void {
    if (this.isReplaying) {
      // 回看没有传输层：即使命令绕过 Webview 的置灰也必须拒绝（不能把历史面板的点击
      // 变成一条发往当前实时连接的查询）。
      this.queryNoticeValue = { kind: "warning", message: "回看模式下不能发起查询：请先返回实时。" };
      this.sendState();
      return;
    }

    const query = this.options.bridge()?.debugQuery;
    const instanceKey = typeof payload.key === "string" ? payload.key : undefined;
    const interfaceId = typeof payload.interfaceId === "string" ? payload.interfaceId : undefined;
    const method = typeof payload.method === "string" ? payload.method : undefined;
    if (query === undefined || instanceKey === undefined || interfaceId === undefined || method === undefined) {
      this.queryNoticeValue = { kind: "error", message: "查询缺少实例/接口/方法，未发出。" };
      this.options.log?.("[debug] query ignored: missing instance/interfaces/method");
      this.sendState();
      return;
    }

    const methodId = typeof payload.methodId === "number" && Number.isInteger(payload.methodId) && payload.methodId > 0
      ? payload.methodId
      : undefined;
    this.queryNoticeValue = { kind: "info", message: `正在查询 ${interfaceId}.${method}…` };
    this.sendState();
    void query.query(instanceKey, interfaceId, method, methodId === undefined ? {} : { methodId }).then(
      (result) => {
        this.queryNoticeValue = result.record === undefined
          ? { kind: "warning", message: "查询已返回，但实例已不在时间轴：结果未插入。" }
          : { kind: "info", message: `查询结果已插入时间轴（帧 ${result.target.frame}）。` };
        this.sendState();
      },
      (errorValue: unknown) => {
        const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
        this.queryNoticeValue = { kind: "error", message };
        this.options.log?.(`[debug] query failed: ${message}`);
        this.sendState();
      },
    );
  }

  public getStateForTest(): DebugPanelSnapshot {
    return this.getSnapshot();
  }

  /** `debugEnabled` 广播（A.5）：唯一能在运行期改写开关的入口。 */
  public applyEnableBroadcast(enabled: boolean): void {
    this.enable.applyBroadcast(enabled);
    this.sendState();
  }

  /** `welcome.debugEnabled`（初值 / 重连）。 */
  public applyWelcome(enabled: boolean): void {
    this.enable.applyWelcome(enabled);
    this.sendState();
  }

  /**
   * bridge server 的调试面变化（{@link EditorBridgeDebugReportingReason}）。
   *
   * - `broadcast`：Unity 对 `debugSetEnabled` 的应答 ⇒ 按服务端值结算挂起请求；
   * - `connection`：握手/断开 ⇒ 值来自 `welcome.debugEnabled`，按初值/重连处理（清掉旧提示，
   *   也把上一个会话遗留的挂起请求作废）。
   *
   * 两条路径都不改"值从哪来"的规则：面板自己永远不产生值。
   */
  public applyBridgeChange(reason: EditorBridgeDebugReportingReason, enabled: boolean): void {
    if (reason === "broadcast") {
      this.enable.applyBroadcast(enabled);
    } else {
      this.enable.applyWelcome(enabled);
      // 连接换代/断开：上一条查询提示属于旧连接，不能继续冒充当前状态。
      this.queryNoticeValue = undefined;
    }

    this.sendState();
  }

  public setModeOverrideForTest(mode: DebugEnableMode | undefined): void {
    this.modeOverride = mode;
    this.enable.setMode(this.currentMode());
    this.sendState();
  }

  /** 测试专用：把等广播的超时压到毫秒级（生产值见 `DEBUG_ENABLE_TIMEOUT_MS`）。 */
  public setEnableTimeoutForTest(timeoutMs: number): void {
    this.enable.setTimeoutForTest(timeoutMs);
    this.sendState();
  }

  /** 测试专用：模拟一次 Webview 状态消息投递失败（验证计数没有被吞掉）。 */
  public noteWebviewFailureForTest(reason = "injected for test"): number {
    this.noteWebviewFailure(reason);
    return this.webviewFailuresValue;
  }

  public dispose(): void {
    this.disposed = true;
    this.stopRefresh();
    // 同 `close()`：先退出回看恢复线上视图，再 resume 线上 store（P2-3）。
    if (this.isReplaying) {
      this.closeRecording();
    }

    this.model.resume();
    this.enable.dispose();
    const panel = this.panel;
    this.panel = undefined;
    panel?.dispose();
  }

  // ==== 内部 ====

  private currentMode(): DebugEnableMode {
    return this.modeOverride ?? (this.options.bridge()?.debugReporting.connectType === "player" ? "player" : "editor");
  }

  private currentManager(): DebugInstanceManager {
    return this.replay?.session.manager ?? this.liveManager;
  }

  private currentFacets(): DebugPanelFacets | undefined {
    return this.replay?.facets ?? this.options.facets;
  }

  /** 回看期间禁止录制（否则会把回看流量再录一遍）；其余情况交给宿主能力位。 */
  private currentRecordingState(): DebugPanelRecordingState {
    if (this.isReplaying) {
      return { available: false, active: false };
    }

    return this.options.recording?.get() ?? { available: false, active: false };
  }

  private replayState(): DebugPanelReplayState | undefined {
    const replay = this.replay;
    if (replay === undefined) {
      return undefined;
    }

    const footer = replay.session.footer;
    return {
      filePath: replay.session.filePath,
      records: footer?.records,
      droppedRecords: footer?.droppedRecords,
      endedReason: footer?.endedReason,
      // 冲突三：回看无法归属的二进制帧是**已知限制**，必须出现在快照里让 UI 说明。
      unattributableBinaryFrames: replay.session.result.ingressCounters.unattributableBinaryFrames,
    };
  }

  private updateTitle(): void {
    if (this.panel === undefined) {
      return;
    }

    this.panel.title =
      this.replay === undefined ? DEBUG_PANEL_TITLE : `${DEBUG_PANEL_TITLE} — 回看 ${basename(this.replay.session.filePath)}`;
  }

  private currentConnection(): DebugPanelConnection {
    const replay = this.replay;
    if (replay !== undefined) {
      // 回看没有实时连接：状态固定 disconnected，但保留文件头里的会话身份，供面板显示。
      return {
        state: "disconnected",
        endpointId: replay.session.header.endpointId,
        target: `回看 ${basename(replay.session.filePath)}`,
        connectType: replay.session.header.connectType,
        frame: replay.session.manager.currentFrame,
      };
    }

    const reporting = this.options.bridge()?.debugReporting;
    // 连接类型只有一个真源（A.3 的 connectType）；`modeOverride` 是宿主测试的注入点，
    // 必须在这里也生效，否则 `snapshot()` 里的 setMode 会把覆盖结果又刷回 editor。
    const connectType = this.modeOverride ?? reporting?.connectType;
    return {
      state: reporting?.available === true ? "connected" : "disconnected",
      endpointId: reporting?.endpointId,
      target: reporting?.target,
      connectType,
      frame: this.options.bridge()?.debug.currentFrame ?? -1,
    };
  }

  private async ensureAssets(): Promise<UnpackedModuleWebview & { readonly directoryUri: vscode.Uri }> {
    this.assets ??= publishDebugPanelAssets(vscode.Uri.joinPath(this.options.storageUri, "debugPanel").fsPath);
    const unpacked = await this.assets;
    return { ...unpacked, directoryUri: vscode.Uri.file(unpacked.directory) };
  }

  private html(panel: vscode.WebviewPanel, assets: UnpackedModuleWebview & { readonly directoryUri: vscode.Uri }): string {
    const scripts = assets.webviews["debugPanel"];
    if (scripts === undefined) {
      throw new Error("Debug panel assets are missing the 'debugPanel' webview.");
    }

    return createModuleWebviewHtml({
      title: DEBUG_PANEL_TITLE,
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(24).toString("base64url"),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.file(scripts.script)).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.file(scripts.style)).toString(),
    });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }

    const record = message as Record<string, unknown>;
    if (record.type === "ready") {
      this.ready = true;
      this.sendState();
      return;
    }

    if (record.type !== "command" || typeof record.command !== "string") {
      return;
    }

    const command = record as unknown as DebugPanelCommandMessage;
    this.handleCommand(command.command, {
      value: command.value,
      direction: command.direction,
      key: command.key,
      interfaceId: command.interfaceId,
      method: command.method,
    });
  }

  private sendState(): void {
    if (this.panel === undefined || !this.ready) {
      return;
    }

    const sent = this.panel.webview.postMessage({ type: "state", state: this.model.snapshot() });
    // P1：Webview 消息失败必须计数并提示，不能 `void` 掉。`postMessage` 返回 Thenable<boolean>，
    // 也可能直接抛（面板正在销毁）；两条路径都记到同一个计数里。
    try {
      void Promise.resolve(sent).then(
        (delivered) => {
          if (delivered === false) {
            this.noteWebviewFailure("postMessage returned false");
          }
        },
        (errorValue: unknown) => this.noteWebviewFailure(String(errorValue)),
      );
    } catch (errorValue) {
      this.noteWebviewFailure(String(errorValue));
    }
  }

  private noteWebviewFailure(reason: string): void {
    this.webviewFailuresValue += 1;
    // 只在前几次与每 100 次落日志：刷新周期 200 ms，持续性失败不能刷屏。
    if (this.webviewFailuresValue <= 3 || this.webviewFailuresValue % 100 === 0) {
      this.options.log?.(`[debug] panel state postMessage failed (${this.webviewFailuresValue}): ${reason}`);
    }
  }

  private startRefresh(): void {
    if (this.refreshTimer !== undefined || this.panel === undefined) {
      return;
    }

    const timer = setInterval(() => this.sendState(), this.options.refreshMs ?? DEBUG_PANEL_REFRESH_MS);
    timer.unref?.();
    this.refreshTimer = timer;
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private scheduleRefresh(): void {
    this.sendState();
  }
}

function asGranularity(value: unknown): DebugCursorGranularity {
  return value === "frame" ? "frame" : "record";
}

/** 供测试与命令层复用的方向归一（`-1` / `1`）。 */
export function asDirection(value: unknown): DebugCursorDirection {
  return value === -1 || value === "-1" ? -1 : 1;
}
