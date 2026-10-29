import type { GraphDebugEvent, GraphDebugInstance } from "../types";

const GRAPH_DEBUG_EXECUTING_KINDS = new Set(["nodeStart", "nodeOutput", "dataNode", "edgeValueChanged"]);

/** 从事件前缀（0..cursor）推导当前执行节点与数据边最近值（§19.5 实时态/回放态共用）。 */
export function computeGraphDebugView(
  events: readonly GraphDebugEvent[],
  cursor: number,
): { readonly executingNodeId: string | null; readonly edgeValues: ReadonlyMap<string, string> } {
  const limit = Math.min(cursor, events.length - 1);
  let executingNodeId: string | null = null;
  const edgeValues = new Map<string, string>();
  for (let index = 0; index <= limit; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (GRAPH_DEBUG_EXECUTING_KINDS.has(event.kind) && event.nodeId !== undefined) {
      executingNodeId = event.nodeId;
    }
    if (event.kind === "edgeValueChanged" && event.nodeId !== undefined && event.outputIndex !== undefined) {
      edgeValues.set(`${event.nodeId}:${event.outputIndex}`, event.value ?? "");
    }
  }
  return { executingNodeId, edgeValues };
}

/** 连续同帧切片起点序列（帧级步进单位；到达顺序，不重排）。 */
function graphDebugFrameStarts(events: readonly GraphDebugEvent[]): readonly number[] {
  const starts: number[] = [];
  let index = 0;
  while (index < events.length) {
    starts.push(index);
    const frameIndex = events[index]?.frameIndex;
    index += 1;
    while (index < events.length && events[index]?.frameIndex === frameIndex) {
      index += 1;
    }
  }
  return starts;
}

function graphDebugFramePosition(starts: readonly number[], cursor: number): number {
  let position = -1;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined || start > cursor) {
      break;
    }
    position = index;
  }
  return position;
}

function previousGraphDebugFrameStart(events: readonly GraphDebugEvent[], cursor: number): number | undefined {
  const starts = graphDebugFrameStarts(events);
  const position = graphDebugFramePosition(starts, cursor);
  return position > 0 ? starts[position - 1] : undefined;
}

function nextGraphDebugFrameStart(events: readonly GraphDebugEvent[], cursor: number): number | undefined {
  const starts = graphDebugFrameStarts(events);
  const position = graphDebugFramePosition(starts, cursor);
  return position >= 0 && position + 1 < starts.length ? starts[position + 1] : undefined;
}

export function GraphDebugPanel({
  runtimeConnected,
  runtimeInstanceId,
  instances,
  execution,
  events,
  stopped,
  follow,
  historyTruncated,
  cursor,
  executingNodeId,
  onRefresh,
  onSubscribe,
  onUnsubscribe,
  onCursorChange,
  onFollow,
}: {
  readonly runtimeConnected: boolean;
  readonly runtimeInstanceId?: string | undefined;
  readonly instances: readonly GraphDebugInstance[];
  readonly execution?: GraphDebugInstance | undefined;
  readonly events: readonly GraphDebugEvent[];
  readonly stopped: boolean;
  readonly follow: boolean;
  readonly historyTruncated: boolean;
  readonly cursor: number;
  readonly executingNodeId: string | null;
  readonly onRefresh: () => void;
  readonly onSubscribe: (executionId: string) => void;
  readonly onUnsubscribe: () => void;
  readonly onCursorChange: (cursor: number) => void;
  readonly onFollow: () => void;
}): React.JSX.Element {
  const lastEvent = cursor >= 0 ? events[cursor] : undefined;
  const maxCursor = Math.max(0, events.length - 1);
  const stepTo = (next: number): void => onCursorChange(Math.max(0, Math.min(maxCursor, next)));
  return (
    <section className="graph-debug-panel" aria-label="执行调试">
      <header className="graph-debug-panel-header">
        <span className="graph-debug-panel-title">执行调试</span>
        <span className={`graph-debug-runtime${runtimeConnected ? " connected" : ""}`}>
          {runtimeConnected ? `运行时：${runtimeInstanceId ?? "已连接"}` : "未发现运行时实例"}
        </span>
        <button type="button" className="secondary" onClick={onRefresh}>刷新</button>
      </header>
      {historyTruncated && (
        <div className="graph-debug-stats" role="status">
          <span title="宿主只保留最近一段增量，更早的时间轴已丢弃">历史已截断，仅显示最近增量</span>
        </div>
      )}
      {execution === undefined ? (
        <div className="graph-debug-section">
          <div className="graph-debug-section-title">实例列表</div>
          {instances.length === 0
            ? <div className="graph-debug-empty">当前图暂无执行实例</div>
            : instances.map((instance) => (
              <div key={instance.instanceId} className="graph-debug-instance">
                <span className="graph-debug-instance-key" title={instance.instanceId}>
                  {instance.instanceId}
                </span>
                <span className="graph-debug-instance-state">{instance.state}</span>
                <span className="graph-debug-instance-node" title="当前节点">
                  {instance.currentNodeId ?? "—"}
                </span>
                <span className="graph-debug-instance-frame">帧 {instance.frameIndex}</span>
                <button
                  type="button"
                  className="secondary"
                  disabled={instance.state !== "running"}
                  onClick={() => onSubscribe(instance.instanceId)}
                >
                  跟踪
                </button>
              </div>
            ))}
        </div>
      ) : (
        <div className="graph-debug-section">
          <div className="graph-debug-section-title">
            跟踪中 · {execution.instanceId}
          </div>
          <div className="graph-debug-stats">
            <span title="当前执行节点">当前节点：{executingNodeId ?? "—"}</span>
            <span title="当前事件帧号">帧 {lastEvent?.frameIndex ?? execution.frameIndex}</span>
            <span title="会话事件数">事件 {events.length}</span>
            {stopped && <span className="graph-debug-stopped">实例已停止</span>}
          </div>
          <button type="button" className="danger full" onClick={onUnsubscribe}>停止调试</button>
          {stopped && (
            <div className="graph-debug-switch">
              <span>实例已停止，可切换新实例：</span>
              <div className="graph-debug-instance-list">
                {instances.map((instance) => (
                  <button
                    key={instance.instanceId}
                    type="button"
                    className="secondary"
                    disabled={instance.state !== "running"}
                    onClick={() => onSubscribe(instance.instanceId)}
                  >
                    {instance.instanceId}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {execution !== undefined && events.length > 0 && (
        <div className="graph-debug-section">
          <div className="graph-debug-section-title">
            时间轴 {follow ? "（实时）" : "（回放）"}
          </div>
          <input
            type="range"
            min={0}
            max={maxCursor}
            value={Math.max(0, cursor)}
            aria-label="执行事件时间轴"
            onChange={(event) => onCursorChange(Number(event.target.value))}
          />
          <div className="graph-debug-steps">
            <button
              type="button"
              className="secondary"
              title="上一帧"
              onClick={() => stepTo(previousGraphDebugFrameStart(events, cursor) ?? 0)}
            >
              ⏮上一帧
            </button>
            <button
              type="button"
              className="secondary"
              title="上一事件"
              onClick={() => stepTo(cursor - 1)}
            >
              ◀上一事件
            </button>
            <button
              type="button"
              className="secondary"
              title="下一事件"
              onClick={() => stepTo(cursor + 1)}
            >
              ▶下一事件
            </button>
            <button
              type="button"
              className="secondary"
              title="下一帧"
              onClick={() => stepTo(nextGraphDebugFrameStart(events, cursor) ?? maxCursor)}
            >
              ⏭下一帧
            </button>
            <button
              type="button"
              className="secondary"
              disabled={follow}
              onClick={onFollow}
            >
              回到实时
            </button>
          </div>
          <div className="graph-debug-event">
            {lastEvent === undefined
              ? "暂无事件"
              : `${lastEvent.kind}${lastEvent.nodeId === undefined ? "" : ` · ${lastEvent.nodeId}`} · 帧 ${lastEvent.frameIndex}${lastEvent.value === undefined ? "" : ` · ${lastEvent.value}`}`}
          </div>
        </div>
      )}
    </section>
  );
}
