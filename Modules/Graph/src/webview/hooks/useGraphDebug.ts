import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { vscode } from "../runtime";
import { computeGraphDebugView, nextGraphDebugRequestId } from "../debug/GraphDebugPanel";
import type { GraphDebugEvent, GraphDebugExecution } from "../types";

export interface GraphDebugFlash {
  readonly keys: ReadonlySet<string>;
  readonly nodeIds: ReadonlySet<string>;
}

export interface GraphDebugController {
  readonly debugDrawerOpen: boolean;
  readonly setDebugDrawerOpen: Dispatch<SetStateAction<boolean>>;
  readonly debugInstances: readonly GraphDebugExecution[];
  readonly setDebugInstances: Dispatch<SetStateAction<readonly GraphDebugExecution[]>>;
  readonly debugRuntimeConnected: boolean;
  readonly setDebugRuntimeConnected: Dispatch<SetStateAction<boolean>>;
  readonly debugRuntimeInstanceId: string | undefined;
  readonly setDebugRuntimeInstanceId: Dispatch<SetStateAction<string | undefined>>;
  readonly debugExecution: GraphDebugExecution | undefined;
  readonly setDebugExecution: Dispatch<SetStateAction<GraphDebugExecution | undefined>>;
  readonly debugEvents: readonly GraphDebugEvent[];
  readonly setDebugEvents: Dispatch<SetStateAction<readonly GraphDebugEvent[]>>;
  readonly debugStopped: boolean;
  readonly setDebugStopped: Dispatch<SetStateAction<boolean>>;
  readonly debugCursor: number;
  readonly setDebugCursor: Dispatch<SetStateAction<number>>;
  readonly debugFollow: boolean;
  readonly setDebugFollow: Dispatch<SetStateAction<boolean>>;
  readonly debugFlash: GraphDebugFlash | undefined;
  readonly setDebugFlash: Dispatch<SetStateAction<GraphDebugFlash | undefined>>;
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
}

export function useGraphDebug(): GraphDebugController {
  // 执行调试状态（§19.5）：光标仅在回放态有意义，实时态恒等于事件末尾。
  const [debugDrawerOpen, setDebugDrawerOpen] = useState(false);
  const [debugInstances, setDebugInstances] = useState<readonly GraphDebugExecution[]>([]);
  const [debugRuntimeConnected, setDebugRuntimeConnected] = useState(false);
  const [debugRuntimeInstanceId, setDebugRuntimeInstanceId] = useState<string>();
  const [debugExecution, setDebugExecution] = useState<GraphDebugExecution>();
  const [debugEvents, setDebugEvents] = useState<readonly GraphDebugEvent[]>([]);
  const [debugStopped, setDebugStopped] = useState(false);
  const [debugCursor, setDebugCursor] = useState(-1);
  const [debugFollow, setDebugFollow] = useState(true);
  const [debugFlash, setDebugFlash] = useState<GraphDebugFlash>();
  const debugEventsRef = useRef<readonly GraphDebugEvent[]>([]);
  const debugCursorRef = useRef(-1);
  const debugFollowRef = useRef(true);
  const debugFlashTimerRef = useRef<number | undefined>(undefined);

  const postDebugAck = useCallback((mode: "follow" | "replay"): void => {
    const events = debugEventsRef.current;
    const cursor = debugFollowRef.current ? events.length - 1 : debugCursorRef.current;
    vscode.postMessage({
      type: "graphDebugAck",
      eventCount: events.length,
      cursor,
      executingNodeId: computeGraphDebugView(events, cursor).executingNodeId,
      mode,
    });
  }, []);

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

  const requestDebugInstances = useCallback((): void => {
    vscode.postMessage({ type: "requestGraphExecutionInstances", requestId: nextGraphDebugRequestId() });
  }, []);

  const subscribeDebugExecution = useCallback((executionId: string): void => {
    vscode.postMessage({
      type: "subscribeGraphExecution",
      requestId: nextGraphDebugRequestId(),
      executionId,
    });
  }, []);

  const unsubscribeDebugExecution = useCallback((): void => {
    vscode.postMessage({ type: "unsubscribeGraphExecution", requestId: nextGraphDebugRequestId() });
  }, []);

  const enterDebugReplay = useCallback((cursor: number): void => {
    debugFollowRef.current = false;
    debugCursorRef.current = cursor;
    setDebugFollow(false);
    setDebugCursor(cursor);
  }, []);

  const enterDebugFollow = useCallback((): void => {
    debugFollowRef.current = true;
    setDebugFollow(true);
  }, []);

  return {
    debugDrawerOpen,
    setDebugDrawerOpen,
    debugInstances,
    setDebugInstances,
    debugRuntimeConnected,
    setDebugRuntimeConnected,
    debugRuntimeInstanceId,
    setDebugRuntimeInstanceId,
    debugExecution,
    setDebugExecution,
    debugEvents,
    setDebugEvents,
    debugStopped,
    setDebugStopped,
    debugCursor,
    setDebugCursor,
    debugFollow,
    setDebugFollow,
    debugFlash,
    setDebugFlash,
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
  };
}
