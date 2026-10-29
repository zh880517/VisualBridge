import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test, { after } from "node:test";
import { DebugInstanceManager } from "../../src/bridge/debugInstanceManager";
import type { DebugQueryNotice, DebugQueryResult } from "../../src/bridge/debugQueryClient";

/**
 * **控制器级**的并发查询提示用例（F8-§5 必修二）。
 *
 * `debugPanelQueryNotices.test.ts` 只证明状态机本身正确；把 `debugPanelController` 的接线改回
 * 单槽（`begin`/`bind`/`complete` 不用、只 `record`）时那组用例**全绿**，说明接线没有被锁住。
 * 这里用真实的 `DebugPanelController`（无 Webview，`sendState()` 自动 no-op）跑两条并发查询，
 * 断言：①两条"正在查询"各自绑到自己的 `requestId`；②先完成者只撤自己那条，后发请求的在途
 * 提示仍在；③服务端就某条请求给出新提示时，旧的本地提示不能压住它。
 *
 * `debugPanelController` 在模块顶层 `require("vscode")`，所以先替换 `Module._load` 再动态 import。
 * **`_load` 是进程级补丁，必须在 `after()` 里还原**（F8 评审二轮必修一）：现在只是因为
 * `node --test` 每个文件一个子进程才没出事，单进程跑（`--test-concurrency=1` 或别的跑法）就会
 * 把 stub 留给后续文件。还原用身份判定，别人后装的补丁不动。
 */

const vscodeStub = {
  window: {
    createWebviewPanel: () => {
      throw new Error("the controller test must not open a webview panel");
    },
  },
  Uri: {
    joinPath: (base: { readonly fsPath: string }, ...segments: string[]) => ({
      fsPath: [base.fsPath, ...segments].join("/"),
    }),
    file: (value: string) => ({ fsPath: value }),
  },
  ViewColumn: { Beside: 2 },
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

type ControllerModule = typeof import("../../src/debug/debugPanelController.js");

async function loadControllerModule(): Promise<ControllerModule> {
  return import("../../src/debug/debugPanelController.js");
}

interface IssuedQuery {
  readonly requestId: string;
  readonly method: string;
  resolve(): void;
  fail(message: string): void;
}

function createHarness(): {
  readonly bridge: Record<string, unknown>;
  readonly issued: IssuedQuery[];
  publishServerNotice(notice: DebugQueryNotice): void;
} {
  const manager = new DebugInstanceManager({ now: () => 0 });
  const issued: IssuedQuery[] = [];
  let serverNotice: DebugQueryNotice | undefined;
  let sequence = 0;

  const bridge = {
    debug: manager,
    debugReporting: { enabled: false, connectType: "editor", state: "connected" },
    requestDebugReportingEnabled: () => false,
    debugQuery: {
      state: () => ({
        available: true,
        pending: issued.length,
        limit: 8,
        busy: false,
        notice: serverNotice,
      }),
      query: (
        _instanceKey: string,
        _interfaceId: string,
        method: string,
        options?: { readonly onIssued?: (requestId: string) => void },
      ): Promise<DebugQueryResult> => {
        sequence += 1;
        const requestId = `req-${sequence}`;
        // 请求号入表后同步回调，与生产路径（`DebugQueryClient.query`）一致。
        options?.onIssued?.(requestId);
        let settle: (value: DebugQueryResult) => void = () => undefined;
        let reject: (error: unknown) => void = () => undefined;
        const promise = new Promise<DebugQueryResult>((resolve, rejectValue) => {
          settle = resolve;
          reject = rejectValue;
        });
        issued.push({
          requestId,
          method,
          resolve: () => settle({
            target: { frame: 7 },
            // record !== undefined ⇒ 面板给"结果已插入"提示（另一分支是"实例已不在时间轴"）。
            record: { kind: "queryResult" },
          } as unknown as DebugQueryResult),
          fail: (message: string) => reject(new Error(message)),
        });
        return promise;
      },
      cancelInstance: () => 0,
    },
  };

  return {
    bridge,
    issued,
    publishServerNotice: (notice: DebugQueryNotice) => {
      serverNotice = notice;
    },
  };
}

const flush = async (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

test("two concurrent queries keep their own in-flight notice until their own settlement (F8-§5)", async () => {
  const { DebugPanelController } = await loadControllerModule();
  const harness = createHarness();
  const controller = new DebugPanelController({
    storageUri: { fsPath: "C:/tmp/vb-f8" } as never,
    bridge: () => harness.bridge as never,
  });

  try {
    // ① 两条"正在查询"先后出现，各自绑到自己的 requestId。
    const first = controller.handleCommand("query", { key: "graph/hero", interfaceId: "IDebug", method: "A" });
    assert.equal(first.query?.notice?.message, "正在查询 IDebug.A…");

    const second = controller.handleCommand("query", { key: "graph/hero", interfaceId: "IDebug", method: "B" });
    assert.equal(second.query?.notice?.message, "正在查询 IDebug.B…", "后发的查询成为最新提示");
    assert.deepEqual(
      controller.getQueryNoticesForTest(),
      { pending: 2, requestIds: ["req-1", "req-2"] },
      "两条在途提示必须各自存在并各自绑到自己的 requestId（单槽实现只会有 1 条、且只有最后一个号）",
    );

    // ② 先完成者（A）只撤自己那条：B 的"正在查询"必须仍然在途。
    harness.issued[0]?.resolve();
    await flush();
    assert.deepEqual(
      controller.getQueryNoticesForTest(),
      { pending: 1, requestIds: ["req-2"] },
      "先完成的 A 不得把仍在途的 B 一起清掉（单槽实现会把整个槽位清空）",
    );
    assert.equal(
      controller.getStateForTest().query?.notice?.message,
      "查询结果已插入时间轴（帧 7）。",
      "A 的结算提示成为最新一条",
    );

    // ③ 服务端就 B 给出新提示：B 的本地"正在查询"立刻退休，服务端提示不得被本地提示压住。
    harness.publishServerNotice({
      kind: "error",
      message: "查询失败（runtime.queryTimeout）：8 s 内没有结果。",
      requestId: "req-2",
    });
    const state = controller.getStateForTest();
    assert.equal(
      state.query?.notice?.message,
      "查询失败（runtime.queryTimeout）：8 s 内没有结果。",
      "服务端的新提示必须显示（按 requestId 退休对应的本地提示，而不是按毫秒时间戳赌）",
    );
    assert.deepEqual(
      controller.getQueryNoticesForTest(),
      { pending: 0, requestIds: [] },
      "服务端结算过的请求，其本地在途提示必须已经退休",
    );

    // B 的 Promise 稍后 settle：不得再写一条"正在查询"或复活已退休的条目。
    harness.issued[1]?.resolve();
    await flush();
    assert.deepEqual(controller.getQueryNoticesForTest(), { pending: 0, requestIds: [] });
  } finally {
    controller.dispose();
  }
});
