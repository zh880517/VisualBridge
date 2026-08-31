import {
  RuntimeBridgeGraphExecutionEvent,
  RuntimeBridgeGraphExecutionEventKind,
  RuntimeBridgeGraphExecutionInstance,
} from "./runtimeBridgeProtocol";

/** 会话内留存的执行事件（含事件级序号，供回放步进定位）。 */
export interface RecordedGraphExecutionEvent {
  readonly index: number;
  readonly frameIndex: number;
  readonly kind: RuntimeBridgeGraphExecutionEventKind;
  readonly nodeId?: string;
  readonly outputIndex?: number;
  readonly value?: string;
}

/** 连续同帧事件的切片（帧级步进单位；切片内保持事件原始顺序）。 */
export interface GraphExecutionFrameSlice {
  readonly frameIndex: number;
  readonly startIndex: number;
  readonly endIndexExclusive: number;
}

/**
 * 单执行实例的会话记录（§19.5）：订阅开始留存、instanceStopped 收尾，
 * 全程内存不落盘。记录以到达顺序为准（批量冲刷不要求同帧送达，
 * 帧号也不保证单调——切片按「连续同帧」归并，不重排）。
 */
export class GraphExecutionRecording {
  private readonly events: RecordedGraphExecutionEvent[] = [];
  private stopped = false;

  public constructor(public readonly execution: RuntimeBridgeGraphExecutionInstance) {
  }

  public get executionId(): string {
    return this.execution.executionId;
  }

  public get isStopped(): boolean {
    return this.stopped;
  }

  public get recordedEvents(): readonly RecordedGraphExecutionEvent[] {
    return this.events;
  }

  /** 追加一批事件；按实例 ID 分流（防御混流），instanceStopped 即收尾。 */
  public append(events: readonly RuntimeBridgeGraphExecutionEvent[]): void {
    if (this.stopped) {
      return;
    }

    for (const event of events) {
      if (event.executionId !== this.execution.executionId) {
        continue;
      }

      this.events.push({
        index: this.events.length,
        frameIndex: event.frameIndex,
        kind: event.kind,
        ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
        ...(event.outputIndex === undefined ? {} : { outputIndex: event.outputIndex }),
        ...(event.value === undefined ? {} : { value: event.value }),
      });
      if (event.kind === "instanceStopped") {
        this.stopped = true;
        return;
      }
    }
  }

  public eventAt(index: number): RecordedGraphExecutionEvent | undefined {
    return index >= 0 && index < this.events.length ? this.events[index] : undefined;
  }

  /** 连续同帧归并的切片序列（到达顺序）。 */
  public frameSlices(): readonly GraphExecutionFrameSlice[] {
    const slices: GraphExecutionFrameSlice[] = [];
    let index = 0;
    while (index < this.events.length) {
      const first = this.events[index];
      if (first === undefined) {
        break;
      }

      const frameIndex = first.frameIndex;
      let end = index + 1;
      while (end < this.events.length && this.events[end]?.frameIndex === frameIndex) {
        end += 1;
      }

      slices.push({ frameIndex, startIndex: index, endIndexExclusive: end });
      index = end;
    }

    return slices;
  }

  /** 事件所属切片；越界返回 undefined。 */
  public sliceForEvent(index: number): GraphExecutionFrameSlice | undefined {
    if (index < 0 || index >= this.events.length) {
      return undefined;
    }

    for (const slice of this.frameSlices()) {
      if (index >= slice.startIndex && index < slice.endIndexExclusive) {
        return slice;
      }
    }

    return undefined;
  }

  /** 下一帧切片起点（帧级前进步进）；已在最后一片时返回 undefined。 */
  public nextFrameStart(index: number): number | undefined {
    return this.neighborFrameStart(index, 1);
  }

  /** 上一帧切片起点（帧级后退步进）；已在第一片时返回 undefined。 */
  public previousFrameStart(index: number): number | undefined {
    return this.neighborFrameStart(index, -1);
  }

  private neighborFrameStart(index: number, offset: number): number | undefined {
    const slices = this.frameSlices();
    for (let position = 0; position < slices.length; position += 1) {
      const slice = slices[position];
      if (slice === undefined || index < slice.startIndex || index >= slice.endIndexExclusive) {
        continue;
      }

      const neighborPosition = position + offset;
      if (neighborPosition < 0 || neighborPosition >= slices.length) {
        return undefined;
      }

      return slices[neighborPosition]?.startIndex;
    }

    return undefined;
  }
}
