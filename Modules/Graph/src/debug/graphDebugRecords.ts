/**
 * Graph 调试增量的纯投影（G1a）。
 *
 * 放在 `src/debug/` 而不是 Webview 目录，是为了让模块测试（Node，无 DOM）能直接覆盖：
 * 这些函数只做去重、过滤与聚合，不碰 React、`window` 或宿主消息。
 * `queryResult` 不是图执行事件（P0-2/C.2），因此既不进实例聚合，也不进时间轴；
 * 宿主 facet 仍保留该记录，模块 Webview 只展示执行事件。
 */

/** `graphDebugFacet.onRecord` 输出里与投影相关的字段（Webview 类型是其超集）。 */
export interface GraphDebugRecordView {
  readonly seq: number;
  readonly sessionId?: string;
  readonly instanceId: string;
  readonly frame: number;
  readonly eventKind: string;
  readonly recordKind?: "event" | "queryResult";
  readonly nodeId?: string;
  readonly outputIndex?: number;
  readonly value?: string;
}

export interface GraphDebugEventView {
  readonly index: number;
  readonly frameIndex: number;
  readonly kind: string;
  readonly nodeId?: string;
  readonly outputIndex?: number;
  readonly value?: string;
}

export interface GraphDebugInstanceView {
  readonly instanceId: string;
  readonly state: "running" | "stopped";
  readonly currentNodeId: string | null;
  readonly frameIndex: number;
}

export interface GraphDebugHistoryView<T extends GraphDebugRecordView> {
  readonly seq: number;
  readonly update: T;
}

/**
 * 合并增量（纯函数）。
 *
 * `DebugRecord.seq` 是宿主的接收序（单调），所以按 `seq` 去重并升序即可幂等处理
 * "快照 + 重放 + 实时增量"的任意交错；`sessionId` 变化（宿主重连）时整段替换，
 * 因为新会话的 `seq` 从 1 重新开始。查询结果在这里就丢弃：它没有执行语义。
 */
export function mergeGraphDebugRecords<T extends GraphDebugRecordView>(
  current: readonly T[],
  incoming: readonly GraphDebugHistoryView<T>[],
): readonly T[] {
  const currentSession = current.length === 0 ? undefined : current[current.length - 1]?.sessionId;
  const incomingSession = incoming.length === 0 ? undefined : incoming[0]?.update.sessionId;
  const base = currentSession !== undefined && incomingSession !== undefined && currentSession !== incomingSession
    ? []
    : [...current];
  const bySeq = new Map<number, T>();
  for (const record of [...base, ...incoming.map((entry) => entry.update)]) {
    if (record.recordKind === "queryResult" || !Number.isFinite(record.seq)) {
      continue;
    }
    bySeq.set(record.seq, record);
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/**
 * 由增量聚合实例（出现顺序；`currentNodeId`/`frameIndex` 取最近一条带节点的记录）。
 *
 * 查询结果即使带 `nodeId` 也不能改写高亮或让实例"凭空出现"。
 */
export function graphDebugInstances(
  records: readonly GraphDebugRecordView[],
): readonly GraphDebugInstanceView[] {
  const order: string[] = [];
  const currentNode = new Map<string, string>();
  const frames = new Map<string, number>();
  const stopped = new Set<string>();
  for (const record of records) {
    if (record.recordKind === "queryResult") {
      continue;
    }
    if (!order.includes(record.instanceId)) {
      order.push(record.instanceId);
    }
    frames.set(record.instanceId, record.frame);
    if (record.nodeId !== undefined) {
      currentNode.set(record.instanceId, record.nodeId);
    }
    if (record.eventKind === "instanceStopped") {
      stopped.add(record.instanceId);
    }
  }
  return order.map((instanceId) => ({
    instanceId,
    state: stopped.has(instanceId) ? "stopped" : "running",
    currentNodeId: currentNode.get(instanceId) ?? null,
    frameIndex: frames.get(instanceId) ?? 0,
  }));
}

/** 某实例的事件时间轴（查询结果不进时间轴；`index` 按到达序）。 */
export function graphDebugEvents(
  records: readonly GraphDebugRecordView[],
  instanceId: string | undefined,
): readonly GraphDebugEventView[] {
  if (instanceId === undefined) {
    return [];
  }
  const events: GraphDebugEventView[] = [];
  for (const record of records) {
    if (record.instanceId !== instanceId || record.recordKind === "queryResult") {
      continue;
    }
    events.push({
      index: events.length,
      frameIndex: record.frame,
      kind: record.eventKind,
      ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
      ...(record.outputIndex === undefined ? {} : { outputIndex: record.outputIndex }),
      ...(record.value === undefined ? {} : { value: record.value }),
    });
  }
  return events;
}

/**
 * 选择当前视图实例（粘性）。
 *
 * 只有"没有当前实例"或"当前实例已从增量里消失"时才切到最新实例；
 * 已经存在的实例不会被新出现的实例抢走。`preferInstance` 是用户的显式"跟踪"点击。
 */
export function selectGraphDebugInstance(
  instances: readonly { readonly instanceId: string }[],
  current: string | undefined,
  preferInstance?: string,
): string | undefined {
  if (preferInstance !== undefined) {
    return preferInstance;
  }
  if (current !== undefined && instances.some((instance) => instance.instanceId === current)) {
    return current;
  }
  return instances[instances.length - 1]?.instanceId;
}
