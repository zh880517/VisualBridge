using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace VisualBridge.Debug
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
        private Thread _writer;
        private bool _running;
        private Action<IReadOnlyList<byte[]>> _sendBatch;
        private Action _onError;

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

        /// <summary>启动写线程；重复调用无副作用。</summary>
        public void StartWriter(Action<IReadOnlyList<byte[]>> sendBatch, Action onError)
        {
            lock (_gate)
            {
                if (_writer != null)
                {
                    return;
                }

                _sendBatch = sendBatch;
                _onError = onError;
                _running = true;
                _writer = new Thread(WriterLoop)
                {
                    IsBackground = true,
                    Name = "VisualBridge.Debug.Writer",
                };
                _writer.Start();
            }
        }

        /// <summary>停止写线程：最多刷新一批，随后清空队列。</summary>
        public void StopWriter(int flushTimeoutMs)
        {
            Thread writer;
            lock (_gate)
            {
                writer = _writer;
                if (writer == null)
                {
                    _items.Clear();
                    return;
                }

                _running = false;
                Monitor.PulseAll(_gate);
            }

            if (writer != Thread.CurrentThread)
            {
                writer.Join(flushTimeoutMs);
            }

            // 写线程可能尚未被调度：由调用线程补发一批，保证 Detach 的冲刷语义。
            var flush = new List<byte[]>(BatchSize);
            Action<IReadOnlyList<byte[]>> sendBatch;
            lock (_gate)
            {
                sendBatch = _sendBatch;
                while (_items.Count > 0 && flush.Count < BatchSize)
                {
                    flush.Add(_items.Dequeue());
                }

                _items.Clear();
                _writer = null;
                _sendBatch = null;
                _onError = null;
            }

            if (flush.Count > 0 && sendBatch != null)
            {
                try
                {
                    sendBatch(flush);
                }
                catch
                {
                    // 冲刷失败按丢弃处理。
                }
            }
        }

        /// <summary>丢弃队列中的全部负载，不补发。</summary>
        public void Clear()
        {
            lock (_gate)
            {
                _items.Clear();
            }
        }

        private void WriterLoop()
        {
            var batch = new List<byte[]>(BatchSize);
            while (true)
            {
                bool stopping;
                lock (_gate)
                {
                    // 已被 StopWriter 解绑的旧线程直接退出，避免与新写线程并存。
                    if (!ReferenceEquals(_writer, Thread.CurrentThread))
                    {
                        return;
                    }

                    while (_running && _items.Count == 0)
                    {
                        Monitor.Wait(_gate, FlushIntervalMs);
                    }

                    if (!ReferenceEquals(_writer, Thread.CurrentThread))
                    {
                        return;
                    }

                    if (!_running && _items.Count == 0)
                    {
                        return;
                    }

                    if (_running && _items.Count < BatchSize)
                    {
                        // 等待最多 100 ms 以凑批；凑满 64 条立即冲刷。
                        long deadline = NowMs() + FlushIntervalMs;
                        while (_running && _items.Count < BatchSize)
                        {
                            long remaining = deadline - NowMs();
                            if (remaining <= 0)
                            {
                                break;
                            }

                            Monitor.Wait(_gate, (int)remaining);
                        }
                    }

                    while (_items.Count > 0 && batch.Count < BatchSize)
                    {
                        batch.Add(_items.Dequeue());
                    }

                    stopping = !_running;
                }

                if (batch.Count > 0)
                {
                    try
                    {
                        Action<IReadOnlyList<byte[]>> sendBatch = _sendBatch;
                        if (sendBatch != null)
                        {
                            sendBatch(batch);
                        }
                    }
                    catch
                    {
                        batch.Clear();
                        FailWriter();
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

        private void FailWriter()
        {
            lock (_gate)
            {
                _items.Clear();
                _running = false;
                _writer = null;
            }

            Action onError = _onError;
            if (onError != null)
            {
                try
                {
                    onError();
                }
                catch
                {
                    // 错误回调不得击穿写线程。
                }
            }
        }

        private static long NowMs()
        {
            return (long)(Stopwatch.GetTimestamp() * (1000.0 / Stopwatch.Frequency));
        }
    }
}
