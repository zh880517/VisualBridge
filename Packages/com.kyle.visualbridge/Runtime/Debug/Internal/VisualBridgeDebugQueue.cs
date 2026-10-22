using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
namespace VisualBridge.Diagnostics
{
    /// <summary>有界发送队列与后台写线程。</summary>
    internal sealed class VisualBridgeDebugQueue
    {
        /// <summary>默认队列容量。</summary>
        public const int DefaultCapacity = 16384;

        private const int BatchSize = 64;
        private const int FlushIntervalMs = 100;

        private readonly object _gate = new object();
        private readonly Queue<byte[]> _items;
        private readonly int _capacity;
        private readonly VisualBridgeDebugCounters _counters;

        private long _seq;
        private int _generation;
        private WriterState _writerState;

        public VisualBridgeDebugQueue(VisualBridgeDebugCounters counters, int capacity = DefaultCapacity)
        {
            _counters = counters ?? throw new ArgumentNullException(nameof(counters));
            _capacity = capacity > 0 ? capacity : DefaultCapacity;
            _items = new Queue<byte[]>(Math.Min(_capacity, 1024));
        }

        /// <summary>
        /// 在入队锁内分配 Seq 并成帧入队；成帧失败不消耗 Seq。
        /// 队列满时丢弃最旧的负载。
        /// </summary>
        public long Enqueue(Func<long, byte[]> frameFactory)
        {
            if (frameFactory == null)
            {
                throw new ArgumentNullException(nameof(frameFactory));
            }

            lock (_gate)
            {
                long seq = _seq + 1;
                byte[] payload = frameFactory(seq);
                if (payload == null)
                {
                    throw new InvalidOperationException("成帧器返回了空负载。");
                }

                _seq = seq;
                if (_items.Count >= _capacity)
                {
                    _items.Dequeue();
                    Interlocked.Increment(ref _counters.droppedQueue);
                }

                _items.Enqueue(payload);
                Monitor.Pulse(_gate);
                return seq;
            }
        }

        /// <summary>启动写线程；已有写线程时不重复启动并返回 false。</summary>
        public bool StartWriter(Action<IReadOnlyList<byte[]>> sendBatch, Action onError)
        {
            lock (_gate)
            {
                if (_writerState != null)
                {
                    return false;
                }

                // 每次启动都开启新代际，写线程、回调与清理动作全部绑定该代际。
                _generation++;
                var state = new WriterState(_generation, sendBatch, onError);
                var thread = new Thread(() => WriterLoop(state))
                {
                    IsBackground = true,
                    Name = "VisualBridge.Debug.Writer",
                };
                state.Thread = thread;
                _writerState = state;
                thread.Start();
                return true;
            }
        }

        /// <summary>
        /// 停止写线程并在超时预算内尽量冲刷队列。
        /// 先递增代际：即使旧写线程仍阻塞在 SendBatch 中，其后续清理与回调也会被忽略。
        /// </summary>
        public void StopWriter(int flushTimeoutMs)
        {
            WriterState state;
            lock (_gate)
            {
                state = _writerState;
                if (state != null)
                {
                    _generation++;
                    state.Running = false;
                    _writerState = null;
                    Monitor.PulseAll(_gate);
                }
            }

            if (state == null)
            {
                DropRemaining();
                return;
            }

            if (state.Thread != null && state.Thread != Thread.CurrentThread)
            {
                // Join 超时只表示线程尚未退出，不能据此假装它已经结束。
                state.Thread.Join(flushTimeoutMs);
            }

            FlushRemaining(state, flushTimeoutMs);
        }

        /// <summary>丢弃队列中的全部负载，不补发。</summary>
        public void Clear()
        {
            lock (_gate)
            {
                _items.Clear();
            }
        }

        /// <summary>在超时预算内循环冲刷至队列为空，超时或发送失败的部分计入 droppedQueue。</summary>
        private void FlushRemaining(WriterState state, int timeoutMs)
        {
            List<byte[]> pending;
            lock (_gate)
            {
                pending = TakeAllLocked();
            }

            if (pending == null)
            {
                return;
            }

            Action<IReadOnlyList<byte[]>> sendBatch = state.SendBatch;
            if (sendBatch == null)
            {
                Interlocked.Add(ref _counters.droppedQueue, pending.Count);
                return;
            }

            long deadline = NowMs() + Math.Max(0, timeoutMs);
            var batch = new List<byte[]>(BatchSize);
            int index = 0;
            while (index < pending.Count)
            {
                batch.Clear();
                while (batch.Count < BatchSize && index < pending.Count)
                {
                    batch.Add(pending[index++]);
                }

                try
                {
                    sendBatch(batch);
                }
                catch
                {
                    // 本批及其后的负载都无法发送，按丢弃计数。
                    break;
                }

                if (index < pending.Count && NowMs() >= deadline)
                {
                    break;
                }
            }

            int remaining = pending.Count - index;
            if (remaining > 0)
            {
                Interlocked.Add(ref _counters.droppedQueue, remaining);
            }
        }

        /// <summary>取出全部剩余负载；为空返回 null。</summary>
        private List<byte[]> TakeAllLocked()
        {
            if (_items.Count == 0)
            {
                return null;
            }

            var pending = new List<byte[]>(_items);
            _items.Clear();
            return pending;
        }

        private void DropRemaining()
        {
            List<byte[]> pending;
            lock (_gate)
            {
                pending = TakeAllLocked();
            }

            if (pending != null)
            {
                Interlocked.Add(ref _counters.droppedQueue, pending.Count);
            }
        }

        private void WriterLoop(WriterState state)
        {
            var batch = new List<byte[]>(BatchSize);
            while (true)
            {
                bool stopping;
                lock (_gate)
                {
                    // 代际不匹配说明该线程已过期，绝不能触碰队列或新代际状态。
                    if (!ReferenceEquals(_writerState, state))
                    {
                        return;
                    }

                    while (state.Running && _items.Count == 0)
                    {
                        Monitor.Wait(_gate, FlushIntervalMs);
                        if (!ReferenceEquals(_writerState, state))
                        {
                            return;
                        }
                    }

                    if (!state.Running && _items.Count == 0)
                    {
                        return;
                    }

                    if (state.Running && _items.Count < BatchSize)
                    {
                        // 等待最多 100 ms 以凑批；凑满 64 条立即冲刷。
                        long deadline = NowMs() + FlushIntervalMs;
                        while (state.Running && _items.Count < BatchSize)
                        {
                            long remaining = deadline - NowMs();
                            if (remaining <= 0)
                            {
                                break;
                            }

                            Monitor.Wait(_gate, (int)remaining);
                            if (!ReferenceEquals(_writerState, state))
                            {
                                return;
                            }
                        }
                    }

                    while (_items.Count > 0 && batch.Count < BatchSize)
                    {
                        batch.Add(_items.Dequeue());
                    }

                    stopping = !state.Running;
                }

                if (batch.Count > 0)
                {
                    try
                    {
                        Action<IReadOnlyList<byte[]>> sendBatch = state.SendBatch;
                        if (sendBatch != null)
                        {
                            sendBatch(batch);
                        }
                    }
                    catch
                    {
                        batch.Clear();
                        FailWriter(state);
                        return;
                    }
                }

                batch.Clear();

                if (stopping)
                {
                    return;
                }
            }
        }

        private void FailWriter(WriterState state)
        {
            Action onError;
            lock (_gate)
            {
                // 旧代际的失败不得清空新连接的队列，也不得停止新写线程。
                if (!ReferenceEquals(_writerState, state))
                {
                    return;
                }

                _generation++;
                state.Running = false;
                _writerState = null;
                List<byte[]> pending = TakeAllLocked();
                if (pending != null)
                {
                    Interlocked.Add(ref _counters.droppedQueue, pending.Count);
                }

                onError = state.OnError;
            }

            if (onError == null)
            {
                return;
            }

            try
            {
                onError();
            }
            catch
            {
                // 错误回调不得击穿写线程。
            }
        }

        private static long NowMs()
        {
            return (long)(Stopwatch.GetTimestamp() * (1000.0 / Stopwatch.Frequency));
        }

        /// <summary>一次写线程启动对应的代际状态。</summary>
        private sealed class WriterState
        {
            public WriterState(int generation, Action<IReadOnlyList<byte[]>> sendBatch, Action onError)
            {
                Generation = generation;
                SendBatch = sendBatch;
                OnError = onError;
                Running = true;
            }

            public int Generation { get; }

            public Action<IReadOnlyList<byte[]>> SendBatch { get; }

            public Action OnError { get; }

            public Thread Thread { get; set; }

            public bool Running { get; set; }
        }
    }
}
#endif
