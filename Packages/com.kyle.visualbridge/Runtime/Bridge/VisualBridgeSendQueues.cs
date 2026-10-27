using System;
using System.Collections.Generic;

namespace VisualBridge.Runtime
{
    /// <summary>发送侧容量上限；与附录 A.9 的 256 / 16 MB / 65536 / 1 MB 一致。</summary>
    public sealed class VisualBridgeSendLimits
    {
        public int ControlCapacity { get; set; } = 256;

        public long DataCapacityBytes { get; set; } = 16L * 1024 * 1024;

        public int DataCapacityMessages { get; set; } = 65536;

        public int MaxMessageBytes { get; set; } = VisualBridgeFraming.MaxMessageBytes;

        public static VisualBridgeSendLimits Default()
        {
            return new VisualBridgeSendLimits();
        }
    }

    public enum VisualBridgeEnqueueStatus
    {
        Ok = 0,
        MessageTooLarge,
        ControlQueueFull,
        Closed,
    }

    /// <summary>消息来自哪条队列（与线上通道位无关：通道 1 的控制类消息也走控制队列）。</summary>
    public enum VisualBridgeSendQueueKind
    {
        Control = 0,
        Data = 1,
    }

    /// <summary>一条已入队、等待写出的消息。</summary>
    public sealed class VisualBridgeQueuedMessage
    {
        public long Sequence { get; internal set; }

        public VisualBridgeChannel Channel { get; internal set; }

        public VisualBridgePayloadKind PayloadKind { get; internal set; }

        public byte[] Payload { get; internal set; }

        /// <summary>队列类别；写出统计按它计数，不能用通道位推断（附录 A.2 的通道 1 也有控制类消息）。</summary>
        public VisualBridgeSendQueueKind Queue { get; internal set; }

        /// <summary>仅控制消息：入队时的数据队列尾序号（0 表示此前无数据消息）。</summary>
        public long Barrier { get; internal set; }
    }

    /// <summary>发送计数快照（丢弃、拒绝与写出统计）。</summary>
    public sealed class VisualBridgeSendCounters
    {
        public long ControlEnqueued { get; internal set; }

        public long DebugEnqueued { get; internal set; }

        public long DebugDroppedMessages { get; internal set; }

        public long DebugDroppedBytes { get; internal set; }

        public long RejectedTooLarge { get; internal set; }

        public long WrittenMessages { get; internal set; }

        public long WrittenBytes { get; internal set; }

        public long WrittenControl { get; internal set; }

        public long WrittenDebug { get; internal set; }
    }

    /// <summary>
    /// 发送侧两条队列与单一写序列：每条消息入队取单调序号，写线程按序号写出；
    /// 控制消息携带数据队列尾序号屏障，屏障之前的数据消息必须先写出。
    /// 所有公开成员线程安全（内部加锁）。
    /// </summary>
    public sealed class VisualBridgeSendQueues
    {
        private readonly object gate = new object();
        private readonly VisualBridgeSendLimits limits;
        private readonly Queue<VisualBridgeQueuedMessage> controlQueue = new Queue<VisualBridgeQueuedMessage>();
        private readonly Queue<VisualBridgeQueuedMessage> dataQueue = new Queue<VisualBridgeQueuedMessage>();
        private readonly VisualBridgeSendCounters counters = new VisualBridgeSendCounters();

        private long nextSequence = 1;
        private long lastDataSequence;
        private long dataBytes;
        private bool accepting = true;
        private bool closed;

        public VisualBridgeSendQueues(VisualBridgeSendLimits limits = null)
        {
            this.limits = limits ?? VisualBridgeSendLimits.Default();
        }

        public bool IsClosed
        {
            get
            {
                lock (gate)
                {
                    return closed;
                }
            }
        }

        public int ControlPendingCount
        {
            get
            {
                lock (gate)
                {
                    return controlQueue.Count;
                }
            }
        }

        public int DataPendingCount
        {
            get
            {
                lock (gate)
                {
                    return dataQueue.Count;
                }
            }
        }

        public long DataPendingBytes
        {
            get
            {
                lock (gate)
                {
                    return dataBytes;
                }
            }
        }

        public VisualBridgeSendCounters SnapshotCounters()
        {
            lock (gate)
            {
                return new VisualBridgeSendCounters
                {
                    ControlEnqueued = counters.ControlEnqueued,
                    DebugEnqueued = counters.DebugEnqueued,
                    DebugDroppedMessages = counters.DebugDroppedMessages,
                    DebugDroppedBytes = counters.DebugDroppedBytes,
                    RejectedTooLarge = counters.RejectedTooLarge,
                    WrittenMessages = counters.WrittenMessages,
                    WrittenBytes = counters.WrittenBytes,
                    WrittenControl = counters.WrittenControl,
                    WrittenDebug = counters.WrittenDebug,
                };
            }
        }

        /// <summary>
        /// 控制消息入队；满 256 条返回 <see cref="VisualBridgeEnqueueStatus.ControlQueueFull"/>，调用方必须断开。
        /// <paramref name="channel"/> 决定帧头的通道位（附录 A.2：<c>debugCreate</c>/<c>debugFinish</c>/<c>debugFrame</c>/
        /// <c>dropped</c>/通道 1 的 <c>response</c> 都是通道 1 上的控制类消息），与「走哪条队列」互不绑定。
        /// </summary>
        public VisualBridgeEnqueueStatus TryEnqueueControl(
            byte[] payload,
            out long sequence,
            VisualBridgePayloadKind payloadKind = VisualBridgePayloadKind.Json,
            VisualBridgeChannel channel = VisualBridgeChannel.Editor)
        {
            sequence = 0;
            var body = payload ?? Array.Empty<byte>();
            lock (gate)
            {
                if (!accepting)
                {
                    return VisualBridgeEnqueueStatus.Closed;
                }

                if (!AcceptableSize(body))
                {
                    counters.RejectedTooLarge += 1;
                    return VisualBridgeEnqueueStatus.MessageTooLarge;
                }

                if (controlQueue.Count >= limits.ControlCapacity)
                {
                    return VisualBridgeEnqueueStatus.ControlQueueFull;
                }

                sequence = nextSequence++;
                controlQueue.Enqueue(new VisualBridgeQueuedMessage
                {
                    Sequence = sequence,
                    Channel = channel,
                    PayloadKind = payloadKind,
                    Payload = body,
                    Queue = VisualBridgeSendQueueKind.Control,
                    Barrier = lastDataSequence,
                });
                counters.ControlEnqueued += 1;
                return VisualBridgeEnqueueStatus.Ok;
            }
        }

        /// <summary>数据消息入队；超过任一容量上限时先淘汰最旧的数据消息。</summary>
        public VisualBridgeEnqueueStatus TryEnqueueDebug(
            byte[] payload,
            out long sequence,
            VisualBridgePayloadKind payloadKind)
        {
            sequence = 0;
            var body = payload ?? Array.Empty<byte>();
            lock (gate)
            {
                if (!accepting)
                {
                    return VisualBridgeEnqueueStatus.Closed;
                }

                if (!AcceptableSize(body) || body.Length > limits.DataCapacityBytes)
                {
                    counters.RejectedTooLarge += 1;
                    return VisualBridgeEnqueueStatus.MessageTooLarge;
                }

                while (dataQueue.Count > 0
                    && (dataQueue.Count + 1 > limits.DataCapacityMessages
                        || dataBytes + body.Length > limits.DataCapacityBytes))
                {
                    EvictOldestDebug();
                }

                sequence = nextSequence++;
                lastDataSequence = sequence;
                dataQueue.Enqueue(new VisualBridgeQueuedMessage
                {
                    Sequence = sequence,
                    Channel = VisualBridgeChannel.Debug,
                    PayloadKind = payloadKind,
                    Payload = body,
                    Queue = VisualBridgeSendQueueKind.Data,
                    Barrier = 0,
                });
                dataBytes += body.Length;
                counters.DebugEnqueued += 1;
                return VisualBridgeEnqueueStatus.Ok;
            }
        }

        /// <summary>
        /// 取下一个可写消息：按序号递增；控制消息只有在
        /// 「序号不大于其屏障」的数据消息全部写出后才可写。
        /// </summary>
        public bool TryDequeue(out VisualBridgeQueuedMessage message)
        {
            message = null;
            lock (gate)
            {
                if (closed)
                {
                    return false;
                }

                var hasControl = controlQueue.Count > 0;
                var hasData = dataQueue.Count > 0;
                if (hasControl && hasData)
                {
                    var control = controlQueue.Peek();
                    var data = dataQueue.Peek();
                    // 屏障未满足时先写数据；否则按序号取较小者。
                    message = data.Sequence <= control.Barrier || data.Sequence < control.Sequence
                        ? DequeueData()
                        : DequeueControl();
                }
                else if (hasControl)
                {
                    message = DequeueControl();
                }
                else if (hasData)
                {
                    message = DequeueData();
                }

                if (message == null)
                {
                    return false;
                }

                counters.WrittenMessages += 1;
                counters.WrittenBytes += message.Payload.Length;
                // 统计按队列类别：通道 1 的 debugCreate/debugFinish/debugFrame/dropped 走控制队列，
                // 不能用 Channel 推断（附录 A.2）。
                if (message.Queue == VisualBridgeSendQueueKind.Control)
                {
                    counters.WrittenControl += 1;
                }
                else
                {
                    counters.WrittenDebug += 1;
                }

                return true;
            }
        }

        /// <summary>停止接受新消息，但已入队内容仍可写出（优雅关闭）。</summary>
        public void StopAccepting()
        {
            lock (gate)
            {
                accepting = false;
            }
        }

        /// <summary>关闭后不再接受入队，也不再有可写消息；已入队内容被丢弃。</summary>
        public void Close()
        {
            lock (gate)
            {
                accepting = false;
                closed = true;
                controlQueue.Clear();
                dataQueue.Clear();
                dataBytes = 0;
            }
        }

        private bool AcceptableSize(byte[] payload)
        {
            return payload.Length <= limits.MaxMessageBytes;
        }

        private VisualBridgeQueuedMessage DequeueControl()
        {
            return controlQueue.Dequeue();
        }

        private VisualBridgeQueuedMessage DequeueData()
        {
            var message = dataQueue.Dequeue();
            dataBytes -= message.Payload.Length;
            return message;
        }

        private void EvictOldestDebug()
        {
            var dropped = DequeueData();
            counters.DebugDroppedMessages += 1;
            counters.DebugDroppedBytes += dropped.Payload.Length;
        }
    }
}
