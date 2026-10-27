/**
 * 编辑器通道的一对一连接门（附录 A.6 `runtime.alreadyConnected`）。
 *
 * 竞态来源：传输层的关闭通知（`close` 事件）是**异步投递**的，而对端 FIN 与新连接
 * 首包可能落在同一轮事件循环里。只在关闭回调里释放占位，会让刚断开的连接继续占用
 * 端点并把重连方误判为"已有连接"（实测 1500 次重连中约 0.5% 命中）。
 *
 * 因此这里把状态维护改成同步、确定性的三条：
 * - 占位在 {@link accept} 里同步取得；
 * - 释放既发生在关闭回调（{@link retire}），也在每次判定前按传输层的同步可观测状态
 *   剔除已终止连接（{@link prune}）——不依赖事件先后；
 * - 只有**完成握手**的连接才占用槽位，未握手的探测连接永不阻塞后来者。
 *
 * 重连语义：对端断开（FIN/销毁）后下一条连接立即取得槽位，`sessionId` 的续接
 * 由握手里的 `resumeSessionId` 决定（附录 A.3），与本门无关。真正的并发第二个客户端
 * 仍然被拒，因为它的传输层尚未终止。
 */

/** 门只需要传输层的同步可用性；`BridgeSocket` 满足本接口。 */
export interface EditorBridgeTransport {
  /** 传输已不可用（本端已关闭，或对端 FIN/销毁已同步可见）。 */
  readonly isTerminated: boolean;
}

export class EditorBridgeConnectionSlot<TTransport extends EditorBridgeTransport = EditorBridgeTransport> {
  private handshakeCompleted = false;

  public constructor(public readonly transport: TTransport) {
  }

  /** 是否已完成 hello/welcome 握手；只有握手完成的连接占用一对一槽位。 */
  public get helloCompleted(): boolean {
    return this.handshakeCompleted;
  }

  /** 只由 {@link EditorBridgeConnectionGate} 在握手成功时调用。 */
  public markHandshakeCompleted(): void {
    this.handshakeCompleted = true;
  }

  /** 传输层是否已终止（转发给传输实现）。 */
  public get isTerminated(): boolean {
    return this.transport.isTerminated;
  }
}

export class EditorBridgeConnectionGate<TTransport extends EditorBridgeTransport = EditorBridgeTransport> {
  private readonly connections = new Set<EditorBridgeConnectionSlot<TTransport>>();

  /** 当前登记（含未握手、含已终止但尚未剔除）的连接数，供诊断与测试断言。 */
  public get size(): number {
    return this.connections.size;
  }

  /** 当前登记的连接快照（只读副本），供遍历关闭/释放。 */
  public snapshot(): readonly EditorBridgeConnectionSlot<TTransport>[] {
    return [...this.connections];
  }

  /** 同步占位：先剔除已终止连接，再登记新连接。 */
  public accept(transport: TTransport): EditorBridgeConnectionSlot<TTransport> {
    this.prune();
    const connection = new EditorBridgeConnectionSlot(transport);
    this.connections.add(connection);
    return connection;
  }

  /** 握手成功：从此该连接占用一对一槽位。 */
  public markHandshaken(connection: EditorBridgeConnectionSlot<TTransport>): void {
    connection.markHandshakeCompleted();
  }

  /** 同步释放（幂等）；关闭回调、本端主动断开与 dispose 都走这里。 */
  public retire(connection: EditorBridgeConnectionSlot<TTransport>): boolean {
    return this.connections.delete(connection);
  }

  /**
   * 是否存在**另一条**已完成握手且仍然存活的连接。
   * 判定前先剔除已终止连接，因此"对端已断、close 事件未派发"不会误拒重连。
   */
  public hasActiveConnection(current: EditorBridgeConnectionSlot<TTransport>): boolean {
    this.prune();
    for (const connection of this.connections) {
      if (connection !== current && connection.helloCompleted) {
        return true;
      }
    }

    return false;
  }

  /** 剔除全部已终止连接，返回剔除条数。 */
  public prune(): number {
    let removed = 0;
    for (const connection of [...this.connections]) {
      if (connection.isTerminated) {
        this.connections.delete(connection);
        removed += 1;
      }
    }

    return removed;
  }
}
