/**
 * 面板的录制入口（F5 的 UI 侧）：
 * - 选择保存路径（默认 `<globalStorage>/recordings/…vbdrec`）；
 * - 调 `EditorBridgeServer.startRecording/stopRecording`（真正写文件的是 `DebugSessionRecorder`）；
 * - 录制期间每秒看一次服务端状态，`sizeLimit`/`disconnect` 自动收尾时也能给出提示。
 *
 * 这里**不碰**录制文件格式，也不做任何解码：所有"录什么"的决定都在 bridge 层。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { DebugRecordingHeader } from "../bridge/debugRecordingFormat";
import type {
  EditorBridgeRecordingOptions,
  EditorBridgeRecordingState,
} from "../bridge/editorBridgeServer";
import type { DebugPanelRecordingState } from "./debugPanelState";
import {
  DebugRecordingMonitor,
  type DebugRecordingStopSummary,
} from "./debugRecordingMonitor";

/** 控制器用到的 bridge server 录制子集（宿主里就是 `EditorBridgeServer`）。 */
export interface DebugRecordingBridge {
  readonly recordingState: EditorBridgeRecordingState;
  startRecording(options: EditorBridgeRecordingOptions): Promise<DebugRecordingHeader>;
  stopRecording(): Promise<DebugRecordingStopSummary | undefined>;
}

export interface DebugRecordingServiceOptions {
  /** `context.globalStorageUri`：默认录制目录是它下面的 `recordings/`。 */
  readonly storageUri: vscode.Uri;
  readonly bridge: () => DebugRecordingBridge | undefined;
  /** 选择保存路径（测试注入）；返回 `undefined` = 用户取消。 */
  readonly chooseSavePath?: (defaultPath: string) => Promise<string | undefined>;
  /** 录制结束（手动或自动，文件已 finalize）后回调；宿主用它提示"打开回看"。 */
  readonly onStopped?: (filePath: string, summary: DebugRecordingStopSummary | undefined) => void;
  /** 收尾失败（footer 没写成）：宿主可覆盖提示；缺省弹错误消息且**不**提示"已保存"。 */
  readonly onFailed?: (filePath: string, message: string) => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** 单个文件上限（缺省用 bridge 层默认值 128 MB）。 */
  readonly maxFileBytes?: number;
  /** 自动收尾的轮询周期（缺省 1 s；测试可注入）。 */
  readonly monitorMs?: number;
}

export class DebugRecordingService implements vscode.Disposable {
  private readonly options: DebugRecordingServiceOptions;
  private readonly now: () => number;
  private readonly monitor: DebugRecordingMonitor;
  private lastFilePath: string | undefined;
  private busy = false;
  private disposed = false;

  public constructor(options: DebugRecordingServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.monitor = new DebugRecordingMonitor({
      bridge: () => {
        const bridge = this.options.bridge();
        return bridge === undefined ? undefined : { recordingState: bridge.recordingState };
      },
      ...(options.monitorMs === undefined ? {} : { pollMs: options.monitorMs }),
      onStopped: (filePath, summary) => {
        this.options.log?.(
          `[debug] recording ended by the bridge: ${filePath} (${summary?.endedReason ?? "unknown"}, ${summary?.records ?? 0} records)`,
        );
        this.options.onStopped?.(filePath, summary);
      },
      onFailed: (filePath, message) => {
        // footer 没写成功 ⇒ 不能提示"已保存"（P2-4）。
        this.options.log?.(`[debug] recording failed to finalize: ${filePath}: ${message}`);
        if (this.options.onFailed !== undefined) {
          this.options.onFailed(filePath, message);
          return;
        }

        void vscode.window.showErrorMessage(
          `调试录制结束但文件尾写入失败，不能打开回看：${path.basename(filePath)}（${message}）`,
        );
      },
    });
  }

  /** 面板按钮的状态：能力位 + 是否在录。 */
  public get state(): DebugPanelRecordingState {
    const bridge = this.options.bridge();
    return {
      available: bridge?.recordingState.available === true,
      active: bridge?.recordingState.active === true,
    };
  }

  /** 最近一次开始录制的文件（停止后仍保留，供"打开回看"使用）。 */
  public get lastFile(): string | undefined {
    return this.lastFilePath;
  }

  /** 面板"录制/停止"按钮的入口。 */
  public async toggle(): Promise<void> {
    if (this.state.active) {
      await this.stop();
      return;
    }

    await this.start();
  }

  /** 开始录制；返回目标文件路径（用户取消或能力不可用返回 `undefined`）。 */
  public async start(): Promise<string | undefined> {
    if (this.disposed) {
      return undefined;
    }

    const bridge = this.options.bridge();
    if (bridge === undefined || !bridge.recordingState.available) {
      void vscode.window.showWarningMessage(
        "Debug 录制不可用：请先让 Unity 以编辑器模式连接到 Editor Bridge（录制绑定到这条连接）。",
      );
      return undefined;
    }

    if (bridge.recordingState.active) {
      return bridge.recordingState.filePath;
    }

    if (this.busy) {
      return undefined;
    }

    this.busy = true;
    try {
      const defaultPath = await this.defaultPath();
      const chosen = await this.choosePath(defaultPath);
      if (chosen === undefined) {
        return undefined;
      }

      if (path.resolve(chosen) === path.resolve(defaultPath)) {
        await fs.mkdir(path.dirname(chosen), { recursive: true });
      }

      await bridge.startRecording({
        filePath: chosen,
        ...(this.options.maxFileBytes === undefined ? {} : { maxFileBytes: this.options.maxFileBytes }),
      });
      this.lastFilePath = chosen;
      this.monitor.start(chosen);
      this.options.log?.(`[debug] recording started: ${chosen}`);
      void vscode.window.showInformationMessage(`开始录制调试会话：${path.basename(chosen)}`);
      return chosen;
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      this.options.log?.(`[debug] recording failed to start: ${message}`);
      void vscode.window.showErrorMessage(`无法开始录制：${message}`);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  /** 停止录制并写文件尾；没有在录时返回 `undefined`。 */
  public async stop(): Promise<DebugRecordingStopSummary | undefined> {
    const bridge = this.options.bridge();
    if (bridge === undefined || !bridge.recordingState.active) {
      this.monitor.stop();
      return undefined;
    }

    // 手动停止由这里负责提示；先撤掉自动轮询，避免两边对同一次收尾各发一条 toast。
    this.monitor.stop();
    try {
      const footer = await bridge.stopRecording();
      const filePath = this.lastFilePath ?? bridge.recordingState.filePath;
      this.options.log?.(`[debug] recording stopped: ${filePath ?? "?"} (${footer?.records ?? 0} records)`);
      if (filePath !== undefined) {
        this.options.onStopped?.(filePath, footer);
      }

      return footer;
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      this.options.log?.(`[debug] recording failed to stop: ${message}`);
      void vscode.window.showErrorMessage(`无法停止录制：${message}`);
      return undefined;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.monitor.dispose();
  }

  // ==== 内部 ====

  private async defaultPath(): Promise<string> {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/gu, "-");
    return path.join(this.options.storageUri.fsPath, "recordings", `visualbridge-${stamp}.vbdrec`);
  }

  private async choosePath(defaultPath: string): Promise<string | undefined> {
    if (this.options.chooseSavePath !== undefined) {
      return this.options.chooseSavePath(defaultPath);
    }

    const picked = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { "VisualBridge Debug Recording": ["vbdrec"] },
      saveLabel: "开始录制",
    });
    return picked?.fsPath;
  }
}
