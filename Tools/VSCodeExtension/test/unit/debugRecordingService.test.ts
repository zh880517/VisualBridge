import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import type { EditorBridgeRecordingState } from "../../src/bridge/editorBridgeServer";
import type { DebugRecordingStopSummary } from "../../src/debug/debugRecordingMonitor";

/**
 * 面板录制入口（F8-§7-d / §8-2）。
 *
 * `debugRecordingService` 顶层 `require("vscode")`：与 `editorBridgeServer.test.ts` 一样，在
 * require 之前换成最小 stub（本用例只用到 `window.show*Message` 与 `Uri.file`）。
 *
 * **`Module._load` 是进程级补丁，必须在 `after()` 里还原**（F8 评审二轮必修一）：`node --test`
 * 每个文件一个子进程时才恰好没出事，单进程跑会把 stub 留给后续文件。还原用身份判定
 * （当前值仍是本文件装的那个才写回），别人后装的补丁不动。
 */

const shown: string[] = [];
const vscodeStub = {
  window: {
    showErrorMessage: async (message: string): Promise<undefined> => {
      shown.push(`error:${message}`);
      return undefined;
    },
    showWarningMessage: async (message: string): Promise<undefined> => {
      shown.push(`warning:${message}`);
      return undefined;
    },
    showInformationMessage: async (message: string): Promise<undefined> => {
      shown.push(`info:${message}`);
      return undefined;
    },
    showSaveDialog: async (): Promise<undefined> => undefined,
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
};

type ModuleLoader = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
const moduleNamespace = nodeModule as unknown as {
  readonly default?: { _load: ModuleLoader };
  readonly _load?: ModuleLoader;
};
const moduleApi = moduleNamespace.default ?? (moduleNamespace as { _load: ModuleLoader });
const originalLoad = moduleApi._load;
/** 本文件装的补丁（具名保存，`after()` 靠它做身份判定，见文件头）。 */
const patchedLoad: ModuleLoader = function load(request, parent, isMain) {
  return request === "vscode" ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};
moduleApi._load = patchedLoad;

after(() => {
  // 别人后装的补丁不动（只撤销自己的那一层）。
  if (moduleApi._load === patchedLoad) {
    moduleApi._load = originalLoad;
  }
});

type ServiceModule = typeof import("../../src/debug/debugRecordingService");

async function loadServiceModule(): Promise<ServiceModule> {
  return import("../../src/debug/debugRecordingService.js");
}

const RECORDING_PATH = path.join("C:", "recordings", "visualbridge-test.vbdrec");
const OTHER_PATH = path.join("C:", "recordings", "chosen-by-the-user.vbdrec");

function baseState(overrides: Partial<EditorBridgeRecordingState> = {}): EditorBridgeRecordingState {
  return {
    available: true,
    active: false,
    filePath: RECORDING_PATH,
    startedAt: "2026-01-01T00:00:00.000Z",
    records: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    endedReason: undefined,
    endedAt: undefined,
    finalized: false,
    deliverable: false,
    failure: undefined,
    origin: "editor",
    ...overrides,
  } as EditorBridgeRecordingState;
}

interface Harness {
  readonly service: InstanceType<ServiceModule["DebugRecordingService"]>;
  readonly setState: (state: EditorBridgeRecordingState) => void;
  readonly stopped: { filePath: string; summary: DebugRecordingStopSummary | undefined }[];
  readonly failed: { filePath: string; message: string }[];
  readonly disposed: () => void;
}

async function startRecordingService(): Promise<Harness> {
  const { DebugRecordingService } = await loadServiceModule();
  let state = baseState();
  const stopped: { filePath: string; summary: DebugRecordingStopSummary | undefined }[] = [];
  const failed: { filePath: string; message: string }[] = [];
  const service = new DebugRecordingService({
    storageUri: { fsPath: path.join("C:", "storage") } as never,
    bridge: () => ({
      recordingState: state,
      startRecording: async () => {
        // bridge 侧开录成功：状态变为"录制中"（真实实现由 EditorBridgeServer 改）。
        state = baseState({ active: true, filePath: OTHER_PATH, startedAt: "2026-01-01T00:00:00.000Z" });
        return {} as never;
      },
      stopRecording: async () => undefined,
    }),
    chooseSavePath: async () => OTHER_PATH,
    // 1 分钟轮询：本用例要让"自动收尾落在两次轮询之间"由状态变化精确控制，而不是靠计时。
    monitorMs: 60_000,
    onStopped: (filePath, summary) => {
      stopped.push({ filePath, summary });
    },
    onFailed: (filePath, message) => {
      failed.push({ filePath, message });
    },
    log: () => undefined,
  });
  await service.start();
  return {
    service,
    setState: (next) => {
      state = next;
    },
    stopped,
    failed,
    disposed: () => service.dispose(),
  };
}

test("a manual stop inside the auto-finish window still reports the finished recording (F8-§7-d)", async () => {
  const harness = await startRecordingService();
  try {
    assert.equal(harness.service.state.active, true, "刚开录");

    // 自动收尾（sizeLimit）在两次轮询之间完成：bridge 侧 active 已为 false、文件已 finalize。
    harness.setState(baseState({
      filePath: OTHER_PATH,
      active: false,
      finalized: true,
      deliverable: true,
      endedReason: "sizeLimit",
      endedAt: "2026-01-01T00:00:10.000Z",
      records: 7,
      droppedRecords: 1,
      droppedBytes: 9,
    }));

    const summary = await harness.service.stop();
    assert.deepEqual(summary, { records: 7, droppedRecords: 1, droppedBytes: 9, endedReason: "sizeLimit" });
    assert.deepEqual(harness.stopped, [{ filePath: OTHER_PATH, summary }], "手动停止必须显式交付这一次收尾");
    assert.equal(harness.failed.length, 0);

    // 再点一次不能重复 toast（监视器已交付过，不再"欠一条"）。
    assert.equal(await harness.service.stop(), undefined);
    assert.equal(harness.stopped.length, 1, "重复停止不得重复提示");
  } finally {
    harness.disposed();
  }
});

test("a manual stop inside a failed auto-finish reports the failure instead of claiming success (F8-§7-d)", async () => {
  const harness = await startRecordingService();
  try {
    harness.setState(baseState({
      filePath: OTHER_PATH,
      active: false,
      finalized: true,
      deliverable: false,
      failure: "footer write failed",
      endedReason: undefined,
    }));

    assert.equal(await harness.service.stop(), undefined);
    assert.equal(harness.stopped.length, 0, "footer 没写成 ⇒ 绝不能提示已保存");
    assert.deepEqual(harness.failed, [{ filePath: OTHER_PATH, message: "footer write failed" }]);
  } finally {
    harness.disposed();
  }
});

test("the panel recording state carries the recorded leg (F8-§8-2)", async () => {
  const harness = await startRecordingService();
  try {
    assert.equal(harness.service.state.origin, "editor");

    harness.setState(baseState({ origin: "runtime", active: false }));
    assert.equal(harness.service.state.origin, "runtime", "Runtime 腿的录制必须标成 runtime（内容只有 ch1）");

    const withoutOrigin = { ...baseState({ available: false, active: false }) } as Record<string, unknown>;
    delete withoutOrigin.origin;
    harness.setState(withoutOrigin as unknown as EditorBridgeRecordingState);
    assert.equal(harness.service.state.origin, undefined, "没有来源时不要编造一条腿");
    assert.equal(harness.service.state.available, false);
  } finally {
    harness.disposed();
  }
});
