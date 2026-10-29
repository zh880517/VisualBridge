import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { vscode } from "../runtime";
import { computeGraphDebugView } from "../debug/GraphDebugPanel";
import {
  graphDebugEvents,
  graphDebugInstances,
  mergeGraphDebugRecords,
  selectGraphDebugInstance,
} from "../../debug/graphDebugRecords";
import type {
  DebugFacetHistoryEntry,
  GraphDebugEvent,
  GraphDebugFacetRecord,
  GraphDebugInstance,
} from "../types";

export { graphDebugEvents, graphDebugInstances, mergeGraphDebugRecords } from "../../debug/graphDebugRecords";

export interface GraphDebugFlash {
  readonly keys: ReadonlySet<string>;
  readonly nodeIds: ReadonlySet<string>;
}

/** Graph 调试窗口的取数入口（G1a：只消费 facet 渲染增量，不再发 `graphExecution*` 消息）。 */
export interface GraphDebugController {
  readonly debugDrawerOpen: boolean;
  readonly setDebugDrawerOpen: Dispatch<SetStateAction<boolean>>;
  readonly debugInstances: readonly GraphDebugInstance[];
  readonly debugRuntimeConnected: boolean;
  readonly debugRuntimeInstanceId: string | undefined;
  readonly debugExecution: GraphDebugInstance | undefined;
  readonly debugEvents: readonly GraphDebugEvent[];
  readonly debugStopped: boolean;
  readonly debugCursor: number;
  readonly debugFollow: boolean;
  readonly debugHistoryTruncated: boolean;
  readonly debugFlash: GraphDebugFlash | undefined;
  readonly debugEventsRef: RefObject<readonly GraphDebugEvent[]>;
  readonly debugCursorRef: RefObject<number>;
  readonly debugFollowRef: RefObject<boolean>;
  readonly debugFlashTimerRef: RefObject<number | undefined>;
  readonly postDebugAck: (mode: "follow" | "replay") => void;
  readonly applyDebugFlash: (events: readonly GraphDebugEvent[]) => void;
  readonly requestDebugInstances: () => void;
  readonly subscribeDebugExecution: (executionId: string) => void;
  readonly unsubscribeDebugExecution: () => void;
  readonly enterDebugReplay: (cursor: number) => void;
  readonly enterDebugFollow: () => void;
  readonly applyDebugFacetUpdates: (updates: readonly DebugFacetHistoryEntry[]) => void;
  readonly applyDebugFacetSnapshot: (
    updates: readonly DebugFacetHistoryEntry[],
    state: "active" | "unavailable",
    truncated: boolean,
  ) => void;
  readonly applyDebugFacetReset: () => void;

  // ==== 旧 `graphExecution*` 路径（G1b 与旧消息一起删除）====
  // 旧路径与上面的 facet 状态**互相隔离**：它只维护"要回给宿主的执行事件累计"，
  // 不 setState、不参与渲染，所以不会覆盖 facet 派生出来的实例/事件/光标。
  /** epoch 重置后主动请求旧路径的执行调试状态（5d8d3e7 的 ready 后水化）。 */
  readonly requestLegacyExecutionState: () => void;
  readonly applyLegacyExecutionSubscribed: (ok: boolean) => void;
  readonly applyLegacyExecutionUnsubscribed: () => void;
  readonly applyLegacyExecutionEvents: (events: readonly GraphDebugEvent[]) => void;
  readonly applyLegacyExecutionStopped: () => void;
  readonly applyLegacyExecutionState: (subscribed: boolean, events: readonly GraphDebugEvent[]) => void;
}

let legacyRequestIdCounter = 0;

/** 旧 `graphExecution*` 请求的 requestId（5d8d3e7 由 `GraphDebugPanel` 提供同名工具）。 */
function nextLegacyRequestId(): string {
  return `graph-debug-${++legacyRequestIdCounter}`;
}

export function useGraphDebug(): GraphDebugController {
  // 执行调试状态（§19.5）：光标仅在回放态有意义，实时态恒等于事件末尾。
  const [debugDrawerOpen, setDebugDrawerOpen] = useState(false);
  const [debugInstances, setDebugInstances] = useState<readonly GraphDebugInstance[]>([]);
  const [debugRuntimeConnected, setDebugRuntimeConnected] = useState(false);
  const [debugRuntimeInstanceId, setDebugRuntimeInstanceId] = useState<string>();
  const [debugExecution, setDebugExecution] = useState<GraphDebugInstance>();
  const [debugEvents, setDebugEvents] = useState<readonly GraphDebugEvent[]>([]);
  const [debugStopped, setDebugStopped] = useState(false);
  const [debugCursor, setDebugCursor] = useState(-1);
  const [debugFollow, setDebugFollow] = useState(true);
  const [debugFlash, setDebugFlash] = useState<GraphDebugFlash>();
  const [debugHistoryTruncated, setDebugHistoryTruncated] = useState(false);
  const debugInstancesRef = useRef<readonly GraphDebugInstance[]>([]);
  const debugExecutionRef = useRef<GraphDebugInstance | undefined>(undefined);
  const debugEventsRef = useRef<readonly GraphDebugEvent[]>([]);
  const debugCursorRef = useRef(-1);
  const debugFollowRef = useRef(true);
  const debugFlashTimerRef = useRef<number | undefined>(undefined);
  const updateCountRef = useRef(0);
  const recordsRef = useRef<readonly GraphDebugFacetRecord[]>([]);
  const sessionRef = useRef<string | undefined>(undefined);

  // 旧 `graphExecution*` 路径只维护"回执所需的事件累计"（G1b 删除）。
  // 实例表/执行描述/停止标志/运行时连接都不留副本：自 G1a 起没有消费者，
  // 面板的展示态全部来自上面的 facet 记录；留一份没人读的状态只会假装有功能。
  const legacyEventsRef = useRef<readonly GraphDebugEvent[]>([]);

  const postAckWith = useCallback((
    mode: "follow" | "replay",
    events: readonly GraphDebugEvent[],
    cursor: number,
    instanceId: string | undefined,
  ): void => {
    const execution = debugExecutionRef.current;
    vscode.postMessage({
      type: "debugFacetAck",
      category: "graph",
      state: mode,
      eventCount: events.length,
      cursor,
      executingNodeId: computeGraphDebugView(events, cursor).executingNodeId,
      instanceCount: debugInstancesRef.current.length,
      currentNodeId: execution?.currentNodeId ?? null,
      frameIndex: execution?.frameIndex ?? 0,
      updateCount: updateCountRef.current,
      ...(instanceId === undefined ? {} : { instanceId }),
    });
  }, []);

  const postDebugAck = useCallback((mode: "follow" | "replay"): void => {
    const events = debugEventsRef.current;
    const cursor = debugFollowRef.current ? events.length - 1 : debugCursorRef.current;
    postAckWith(mode, events, cursor, debugExecutionRef.current?.instanceId);
  }, [postAckWith]);

  // ==== 旧 `graphExecution*` 消费（G1b 删除）====
  /**
   * 旧路径回执。
   *
   * `eventCount` 是**刚刚真实合并进 `legacyEventsRef` 的累计条数**，`executingNodeId` 由这批
   * 事件的前缀推导（`computeGraphDebugView`）：两者都不是占位值，宿主断言的计数与高亮
   * 取决于 Webview 是否真的消费了事件。
   *
   * 光标恒为末尾、模式恒为 `"follow"`：G1a 之后旧路径**不再与 facet 共享 follow 状态**——
   * `enterDebugReplay`(:343，接在 `GraphEditorView` 时间轴的 `onCursorChange` 上) 只写 facet 的
   * `debugFollowRef`，旧路径自身没有 replay 入口，所以这里直接写常量，而不是维护一份
   * 只读不写的状态机。
   *
   * ⚠️ 已知且被接受的静默风险：若 G1b 之前有人重新给旧路径接 replay 入口，ack 会继续报
   * `"follow"` 而**不会报错**；唯一防线就是这段注释。
   */
  const postLegacyExecutionAck = useCallback((): void => {
    const events = legacyEventsRef.current;
    const cursor = events.length - 1;
    vscode.postMessage({
      type: "graphDebugAck",
      eventCount: events.length,
      cursor,
      executingNodeId: computeGraphDebugView(events, cursor).executingNodeId,
      mode: "follow",
    });
  }, []);

  const requestLegacyExecutionState = useCallback((): void => {
    // 只请求状态、不主动连接运行时：旧实现同样在 ready 后走这条水化。
    vscode.postMessage({ type: "requestGraphExecutionDebugState", requestId: nextLegacyRequestId() });
  }, []);

  const applyLegacyExecutionSubscribed = useCallback((ok: boolean): void => {
    if (!ok) {
      // 失败时保持累计不变（5d8d3e7 只写 status，提示由桥接层负责）。
      return;
    }
    // 重新订阅 = 新录制：不复位会让旧事件累加，宿主那条"重订阅后 eventCount<=5"的断言即红。
    legacyEventsRef.current = [];
  }, []);

  const applyLegacyExecutionUnsubscribed = useCallback((): void => {
    legacyEventsRef.current = [];
  }, []);

  const applyLegacyExecutionEvents = useCallback((events: readonly GraphDebugEvent[]): void => {
    legacyEventsRef.current = [...legacyEventsRef.current, ...events];
    postLegacyExecutionAck();
  }, [postLegacyExecutionAck]);

  const applyLegacyExecutionStopped = useCallback((): void => {
    // 旧实现在这里把光标钉到记录末尾再回执；光标本来就取末尾，故只需补一条回执。
    postLegacyExecutionAck();
  }, [postLegacyExecutionAck]);

  const applyLegacyExecutionState = useCallback((
    subscribed: boolean,
    events: readonly GraphDebugEvent[],
  ): void => {
    legacyEventsRef.current = subscribed ? events : [];
    postLegacyExecutionAck();
  }, [postLegacyExecutionAck]);

  // 实时态边流光：最近一批 nodeOutput/edgeValueChanged 事件在短窗口内点亮对应边。
  const applyDebugFlash = useCallback((events: readonly GraphDebugEvent[]): void => {
    const keys = new Set<string>();
    const nodeIds = new Set<string>();
    for (const event of events) {
      if ((event.kind === "nodeOutput" || event.kind === "edgeValueChanged") && event.nodeId !== undefined) {
        nodeIds.add(event.nodeId);
        if (event.outputIndex !== undefined) {
          keys.add(`${event.nodeId}:${event.outputIndex}`);
        }
      }
    }
    if (keys.size === 0 && nodeIds.size === 0) {
      return;
    }
    setDebugFlash({ keys, nodeIds });
    if (debugFlashTimerRef.current !== undefined) {
      window.clearTimeout(debugFlashTimerRef.current);
    }
    debugFlashTimerRef.current = window.setTimeout(() => {
      setDebugFlash(undefined);
      debugFlashTimerRef.current = undefined;
    }, 600);
  }, []);

  /** 把"记录 → 实例/事件/光标/高亮"一次性推进，避免 React 批处理期间回执读到旧值。 */
  const publishRecords = useCallback((
    nextRecords: readonly GraphDebugFacetRecord[],
    options: { readonly flash: readonly GraphDebugEvent[] | undefined; readonly preferInstance?: string },
  ): void => {
    recordsRef.current = nextRecords;
    const instances = graphDebugInstances(nextRecords);
    debugInstancesRef.current = instances;
    setDebugInstances(instances);

    let selected = selectGraphDebugInstance(
      instances,
      debugExecutionRef.current?.instanceId,
      options.preferInstance,
    );
    if (selected === undefined || !instances.some((instance) => instance.instanceId === selected)) {
      // 选择已经消失（截断/会话替换）时才回到最新实例；否则保持粘性。
      selected = instances[instances.length - 1]?.instanceId;
    }
    const execution = instances.find((instance) => instance.instanceId === selected);
    debugExecutionRef.current = execution;
    setDebugExecution(execution);

    const events = graphDebugEvents(nextRecords, selected);
    debugEventsRef.current = events;
    setDebugEvents(events);
    setDebugStopped(execution?.state === "stopped");

    const sessionId = nextRecords[0]?.sessionId;
    sessionRef.current = sessionId;
    setDebugRuntimeConnected(instances.length > 0);
    setDebugRuntimeInstanceId(sessionId);

    if (debugFollowRef.current) {
      debugCursorRef.current = events.length - 1;
      setDebugCursor(debugCursorRef.current);
      if (options.flash !== undefined) {
        applyDebugFlash(options.flash);
      }
    } else {
      debugCursorRef.current = Math.max(0, Math.min(debugCursorRef.current, events.length - 1));
      setDebugCursor(debugCursorRef.current);
    }

    postAckWith(debugFollowRef.current ? "follow" : "replay", events, debugCursorRef.current, selected);
  }, [applyDebugFlash, postAckWith]);

  const applyDebugFacetUpdates = useCallback((updates: readonly DebugFacetHistoryEntry[]): void => {
    if (updates.length === 0) return;
    updateCountRef.current += 1;
    const next = mergeGraphDebugRecords(recordsRef.current, updates);
    const flash: GraphDebugEvent[] = [];
    for (const entry of updates) {
      const record = entry.update;
      if (record.recordKind === "queryResult") continue;
      flash.push({
        index: flash.length,
        frameIndex: record.frame,
        kind: record.eventKind,
        ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
        ...(record.outputIndex === undefined ? {} : { outputIndex: record.outputIndex }),
        ...(record.value === undefined ? {} : { value: record.value }),
      });
    }
    publishRecords(next, { flash });
  }, [publishRecords]);

  const applyDebugFacetSnapshot = useCallback((
    updates: readonly DebugFacetHistoryEntry[],
    state: "active" | "unavailable",
    truncated: boolean,
  ): void => {
    const next = mergeGraphDebugRecords([], updates);
    setDebugHistoryTruncated(truncated);
    publishRecords(next, { flash: undefined });
    if (state === "unavailable" && next.length === 0) {
      setDebugRuntimeConnected(false);
    }
  }, [publishRecords]);

  const applyDebugFacetReset = useCallback((): void => {
    recordsRef.current = [];
    debugEventsRef.current = [];
    debugCursorRef.current = -1;
    debugFollowRef.current = true;
    updateCountRef.current = 0;
    setDebugHistoryTruncated(false);
    setDebugEvents([]);
    setDebugInstances([]);
    setDebugExecution(undefined);
    debugExecutionRef.current = undefined;
    setDebugCursor(-1);
    setDebugFollow(true);
    setDebugStopped(false);
    setDebugFlash(undefined);
    setDebugRuntimeConnected(false);
  }, []);

  const requestDebugInstances = useCallback((): void => {
    vscode.postMessage({ type: "debugFacetResync", category: "graph" });
  }, []);

  const subscribeDebugExecution = useCallback((executionId: string): void => {
    const instances = debugInstancesRef.current;
    const found = instances.some((instance) => instance.instanceId === executionId);
    if (!found) {
      publishRecords(recordsRef.current, { flash: undefined });
      return;
    }
    debugFollowRef.current = true;
    publishRecords(recordsRef.current, { flash: undefined, preferInstance: executionId });
  }, [publishRecords]);

  const unsubscribeDebugExecution = useCallback((): void => {
    debugExecutionRef.current = undefined;
    debugEventsRef.current = [];
    debugCursorRef.current = -1;
    debugFollowRef.current = true;
    setDebugExecution(undefined);
    setDebugEvents([]);
    setDebugCursor(-1);
    setDebugFollow(true);
    setDebugStopped(false);
    setDebugFlash(undefined);
    postAckWith("follow", [], -1, undefined);
  }, [postAckWith]);

  const enterDebugReplay = useCallback((cursor: number): void => {
    debugFollowRef.current = false;
    debugCursorRef.current = cursor;
    setDebugFollow(false);
    setDebugCursor(cursor);
    postAckWith("replay", debugEventsRef.current, cursor, debugExecutionRef.current?.instanceId);
  }, [postAckWith]);

  const enterDebugFollow = useCallback((): void => {
    debugFollowRef.current = true;
    debugCursorRef.current = debugEventsRef.current.length - 1;
    setDebugFollow(true);
    setDebugCursor(debugCursorRef.current);
    postAckWith("follow", debugEventsRef.current, debugCursorRef.current, debugExecutionRef.current?.instanceId);
  }, [postAckWith]);

  return {
    debugDrawerOpen,
    setDebugDrawerOpen,
    debugInstances,
    debugRuntimeConnected,
    debugRuntimeInstanceId,
    debugExecution,
    debugEvents,
    debugStopped,
    debugCursor,
    debugFollow,
    debugHistoryTruncated,
    debugFlash,
    debugEventsRef,
    debugCursorRef,
    debugFollowRef,
    debugFlashTimerRef,
    postDebugAck,
    applyDebugFlash,
    requestDebugInstances,
    subscribeDebugExecution,
    unsubscribeDebugExecution,
    enterDebugReplay,
    enterDebugFollow,
    applyDebugFacetUpdates,
    applyDebugFacetSnapshot,
    applyDebugFacetReset,
    requestLegacyExecutionState,
    applyLegacyExecutionSubscribed,
    applyLegacyExecutionUnsubscribed,
    applyLegacyExecutionEvents,
    applyLegacyExecutionStopped,
    applyLegacyExecutionState,
  };
}
