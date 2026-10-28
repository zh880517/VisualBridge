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
import * as vscode from "vscode";
import type { DebugCursorDirection, DebugCursorGranularity } from "../bridge/debugStore";
import type { DebugInstanceManager } from "../bridge/debugInstanceManager";
import type { EditorBridgeDebugReportingReason } from "../bridge/editorBridgeServer";
import { createModuleWebviewHtml } from "../editor/moduleWebviewHtml";
import { publishDebugPanelAssets } from "./debugPanelAssets";
import type { UnpackedModuleWebview } from "../modules/webviewAssets";
import { DebugEnableSwitch, DEBUG_ENABLE_TIMEOUT_MS, type DebugEnableMode } from "./debugEnableSwitch";
import {
  DebugPanelModel,
  type DebugPanelConnection,
  type DebugPanelRecordingState,
  type DebugPanelSnapshot,
} from "./debugPanelState";

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
}

export interface DebugPanelControllerOptions {
  /** `context.globalStorageUri`：面板资源落在它下面的 `debugPanel/`。 */
  readonly storageUri: vscode.Uri;
  readonly bridge: () => DebugPanelBridge | undefined;
  /** 录制能力（F5 提供；缺省视为未接入，按钮置灰）。 */
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
}

export class DebugPanelController implements vscode.Disposable {
  private readonly options: DebugPanelControllerOptions;
  private readonly model: DebugPanelModel;
  private readonly enable: DebugEnableSwitch;
  private panel: vscode.WebviewPanel | undefined;
  private assets: Promise<UnpackedModuleWebview> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private disposed = false;
  /** 测试专用：把连接类型钉成指定值（生产上只能来自 A.3 的 `connectType`）。 */
  private modeOverride: DebugEnableMode | undefined;
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
    this.model = new DebugPanelModel({
      manager,
      enable: this.enable,
      connection: () => this.currentConnection(),
      recording: () => this.options.recording?.get() ?? { available: false, active: false },
      onRecordingToggle: () => this.options.recording?.toggle(),
      keyframeCount: (category) => manager.keyframes.count(category),
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
    const panel = this.panel;
    this.panel = undefined;
    this.ready = false;
    this.stopRefresh();
    panel?.dispose();
    // 暂停状态不能在面板消失后继续压住 store 的通知（那是全局副作用）。
    this.model.resume();
  }

  /** 逐条命令入口（Webview 与宿主测试共用）。 */
  public handleCommand(command: string, payload: { value?: unknown; direction?: unknown; key?: unknown } = {}): DebugPanelSnapshot {
    switch (command) {
      case "select":
        this.model.selectInstance(typeof payload.key === "string" ? payload.key : undefined);
        break;
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
      case "step":
        this.model.step(asDirection(payload.direction));
        break;
      case "live":
        this.model.replayToLive();
        break;
      case "toggleRecording":
        this.model.requestRecordingToggle();
        break;
      case "enable":
        this.model.requestEnabled(payload.value === true);
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

  public dispose(): void {
    this.disposed = true;
    this.stopRefresh();
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

  private currentConnection(): DebugPanelConnection {
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
    });
  }

  private sendState(): void {
    if (this.panel === undefined || !this.ready) {
      return;
    }

    void this.panel.webview.postMessage({ type: "state", state: this.model.snapshot() });
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
