using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// 连接级 socket 封装：帧解码 + 通道分流 + 双队列单写序列。
    /// 与 TS 侧 <c>BridgeSocket</c> 保持同一语义：
    /// - 接收帧头 CRC/长度非法立即断开，不重同步；
    /// - 发送由独立写线程按序号写出，控制消息带数据队列尾序号屏障；
    /// - 控制队列满时断开而不是丢弃控制消息。
    /// 读线程与写线程都是后台线程；<see cref="Close"/> 会关闭流以打断阻塞的读写。
    /// </summary>
    public sealed class VisualBridgeBridgeSocket : IDisposable
    {
        private readonly Stream stream;
        private readonly VisualBridgeSendQueues queues;
        private readonly VisualBridgeFrameReader reader = new VisualBridgeFrameReader();
        private readonly Action<byte[]> onControlPayload;
        private readonly Action<VisualBridgePayloadKind, byte[]> onDebugFrame;
        private readonly Action<Exception> onClosed;
        private readonly Action<string> log;
        private readonly VisualBridgeHeartbeatOptions heartbeat;
        private readonly Thread readerThread;
        private readonly Thread writerThread;
        private readonly object writerSignal = new object();
        private readonly object lifecycleGate = new object();
        private readonly ManualResetEventSlim closedEvent = new ManualResetEventSlim(false);

        private volatile bool stopping;
        private volatile bool gracefulRequested;
        private bool closeNotified;
        private bool disposed;
        private bool started;
        private long lastInboundTicks;
        private long lastOutboundTicks;

        public VisualBridgeBridgeSocket(
            Stream stream,
            Action<byte[]> onControlPayload,
            Action<VisualBridgePayloadKind, byte[]> onDebugFrame,
            Action<Exception> onClosed,
            VisualBridgeSendLimits limits = null,
            Action<string> log = null,
            VisualBridgeHeartbeatOptions heartbeat = null)
        {
            this.stream = stream ?? throw new ArgumentNullException(nameof(stream));
            this.onControlPayload = onControlPayload ?? (_ => { });
            this.onDebugFrame = onDebugFrame ?? ((_, __) => { });
            this.onClosed = onClosed ?? (_ => { });
            this.log = log;
            this.heartbeat = heartbeat ?? VisualBridgeHeartbeatOptions.Default();
            var now = NowMilliseconds();
            lastInboundTicks = now;
            lastOutboundTicks = now;
            queues = new VisualBridgeSendQueues(limits);
            readerThread = new Thread(ReadLoop)
            {
                IsBackground = true,
                Name = "visualbridge-bridge-reader",
            };
            writerThread = new Thread(WriteLoop)
            {
                IsBackground = true,
                Name = "visualbridge-bridge-writer",
            };
        }

        /// <summary>
        /// 启动读写线程。调用方必须先发布持有本 socket 的连接对象再启动，
        /// 否则首帧回调可能早于连接状态就绪。
        /// </summary>
        public void Start()
        {
            lock (lifecycleGate)
            {
                if (started || stopping || disposed)
                {
                    return;
                }

                started = true;
            }

            readerThread.Start();
            writerThread.Start();
        }

        public bool IsOpen => !stopping;

        public VisualBridgeSendCounters SendCounters => queues.SnapshotCounters();

        /// <summary>
        /// 控制队列消息（不淘汰）；<paramref name="channel"/> 决定帧头通道位，默认通道 0。
        /// 通道 1 的控制类消息（debugCreate/debugFinish/debugFrame/dropped/response）用
        /// <see cref="SendDebugControl"/>，两者共用同一条控制队列与屏障语义。
        /// </summary>
        public bool SendControl(byte[] payload, VisualBridgePayloadKind payloadKind = VisualBridgePayloadKind.Json,
            VisualBridgeChannel channel = VisualBridgeChannel.Editor)
        {
            return Enqueue(() => queues.TryEnqueueControl(payload, out _, payloadKind, channel), "control");
        }

        public bool SendControlJson(string json)
        {
            return SendControl(Encoding.UTF8.GetBytes(json ?? string.Empty));
        }

        /// <summary>通道 1 的控制类消息：走控制队列（不淘汰）但帧头通道位是 1（附录 A.2/A.9）。</summary>
        public bool SendDebugControl(byte[] payload,
            VisualBridgePayloadKind payloadKind = VisualBridgePayloadKind.Json)
        {
            return SendControl(payload, payloadKind, VisualBridgeChannel.Debug);
        }

        public bool SendDebug(byte[] payload, VisualBridgePayloadKind payloadKind)
        {
            return Enqueue(() => queues.TryEnqueueDebug(payload, out _, payloadKind), "debug");
        }

        /// <summary>立即断开（丢弃未写出的队列内容）。</summary>
        public void Close()
        {
            HandleConnectionEnd(null);
        }

        /// <summary>
        /// 优雅关闭：不再接受新消息，写完已入队内容后关闭；用于「先回错误帧再断开」。
        /// </summary>
        public void CloseGracefully(int timeoutMs = 500)
        {
            if (stopping)
            {
                return;
            }

            gracefulRequested = true;
            queues.StopAccepting();
            PulseWriter();
            try
            {
                closedEvent.Wait(timeoutMs);
            }
            catch (ObjectDisposedException)
            {
                // 并发 Dispose 已经收尾。
            }

            Close();
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            Close();
            JoinThread(readerThread);
            JoinThread(writerThread);
            try
            {
                closedEvent.Dispose();
            }
            catch (ObjectDisposedException)
            {
                // 已由并发路径释放。
            }
        }

        private bool Enqueue(Func<VisualBridgeEnqueueStatus> enqueue, string channelName)
        {
            if (stopping)
            {
                return false;
            }

            var status = enqueue();
            if (status == VisualBridgeEnqueueStatus.Ok)
            {
                PulseWriter();
                return true;
            }

            if (status == VisualBridgeEnqueueStatus.MessageTooLarge)
            {
                log?.Invoke("[bridge] " + channelName + " message rejected: exceeds the maximum message size.");
                return false;
            }

            if (status == VisualBridgeEnqueueStatus.ControlQueueFull)
            {
                log?.Invoke("[bridge] control queue is full; closing the connection instead of dropping control messages.");
                HandleConnectionEnd(new InvalidOperationException("Control queue is full."));
                return false;
            }

            return false;
        }

        private void ReadLoop()
        {
            var buffer = new byte[8192];
            while (!stopping)
            {
                int read;
                try
                {
                    read = stream.Read(buffer, 0, buffer.Length);
                }
                catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
                {
                    if (!stopping)
                    {
                        HandleConnectionEnd(null);
                    }

                    return;
                }

                if (read == 0)
                {
                    // 帧边界处关闭属正常；帧中间关闭说明长度与实际不符。
                    if (reader.BufferedByteCount > 0)
                    {
                        HandleConnectionEnd(new VisualBridgeFrameException(
                            VisualBridgeFrameErrorCode.Truncated,
                            "Connection closed with " + reader.BufferedByteCount + " pending byte(s) of an incomplete frame."));
                    }
                    else
                    {
                        HandleConnectionEnd(null);
                    }

                    return;
                }

                // 任意入站字节都算活动（附录 A.9：30 s 无入站字节才断开）。
                Volatile.Write(ref lastInboundTicks, NowMilliseconds());
                reader.Append(buffer, 0, read);
                while (!stopping)
                {
                    VisualBridgeFrame frame;
                    try
                    {
                        if (!reader.TryReadFrame(out frame))
                        {
                            break;
                        }
                    }
                    catch (VisualBridgeFrameException exception)
                    {
                        log?.Invoke("[bridge] framing error: " + exception.Message);
                        HandleConnectionEnd(exception);
                        return;
                    }

                    try
                    {
                        if (frame.Channel == VisualBridgeChannel.Editor
                            && frame.PayloadKind == VisualBridgePayloadKind.Json
                            && VisualBridgePingPayload.IsPing(frame.Payload))
                        {
                            // 保活消息在连接层消化：回 pong，不分发给握手/业务（附录 A.2/A.9）。
                            SendControl(VisualBridgePingPayload.Pong);
                        }
                        else if (frame.Channel == VisualBridgeChannel.Editor
                            && frame.PayloadKind == VisualBridgePayloadKind.Json
                            && VisualBridgePingPayload.IsPong(frame.Payload))
                        {
                            // pong 只用于刷新入站空闲计时，已在读循环入口刷新。
                        }
                        else if (frame.Channel == VisualBridgeChannel.Editor)
                        {
                            onControlPayload(frame.Payload);
                        }
                        else
                        {
                            onDebugFrame(frame.PayloadKind, frame.Payload);
                        }
                    }
                    catch (Exception exception)
                    {
                        // 业务处理抛错等同于连接不可继续。
                        HandleConnectionEnd(exception);
                        return;
                    }
                }
            }
        }

        private void WriteLoop()
        {
            while (true)
            {
                if (queues.TryDequeue(out var message))
                {
                    try
                    {
                        var frame = VisualBridgeFraming.EncodeFrame(message.Channel, message.PayloadKind, message.Payload);
                        stream.Write(frame, 0, frame.Length);
                        stream.Flush();
                        Volatile.Write(ref lastOutboundTicks, NowMilliseconds());
                        continue;
                    }
                    catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
                    {
                        HandleConnectionEnd(exception);
                        return;
                    }
                }

                if (stopping)
                {
                    return;
                }

                if (gracefulRequested
                    && queues.ControlPendingCount == 0
                    && queues.DataPendingCount == 0)
                {
                    HandleConnectionEnd(null);
                    return;
                }

                if (MaintainHeartbeat())
                {
                    return;
                }

                lock (writerSignal)
                {
                    Monitor.Wait(writerSignal, heartbeat.Disabled ? 100 : heartbeat.PollMilliseconds);
                }
            }
        }

        /// <summary>
        /// 写线程的保活判定（附录 A.9）：空闲超心跳间隔就入队 ping；超过空闲上限直接断开。
        /// 返回 true 表示连接已被判定死亡，调用方应结束写循环。
        /// </summary>
        private bool MaintainHeartbeat()
        {
            if (heartbeat.Disabled)
            {
                return false;
            }

            var now = NowMilliseconds();
            var idleMs = now - Volatile.Read(ref lastInboundTicks);
            if (heartbeat.IdleTimeoutMs > 0 && idleMs > heartbeat.IdleTimeoutMs)
            {
                HandleConnectionEnd(new TimeoutException(
                    "No inbound bytes for " + idleMs.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + " ms (idle timeout " + heartbeat.IdleTimeoutMs + " ms)."));
                return true;
            }

            if (now - Volatile.Read(ref lastOutboundTicks) < heartbeat.IntervalMs)
            {
                return false;
            }

            if (queues.ControlPendingCount > 0 || queues.DataPendingCount > 0)
            {
                // 已经积压：等这些消息写出后 lastOutboundTicks 会前进，不必再塞 ping。
                return false;
            }

            queues.TryEnqueueControl(VisualBridgePingPayload.Ping, out _, VisualBridgePayloadKind.Json,
                VisualBridgeChannel.Editor);
            Volatile.Write(ref lastOutboundTicks, now);
            return false;
        }

        private void PulseWriter()
        {
            lock (writerSignal)
            {
                Monitor.PulseAll(writerSignal);
            }
        }

        /// <summary>
        /// 单调毫秒时钟。Unity 的 .NET Standard 2.1 profile 没有 <c>Environment.TickCount64</c>，
        /// 这里用 Stopwatch（开机起单调递增，不受系统时间调整影响）。
        /// </summary>
        private static long NowMilliseconds()
        {
            return Stopwatch.GetTimestamp() / (Stopwatch.Frequency / 1000L);
        }

        private void HandleConnectionEnd(Exception error)
        {
            lock (lifecycleGate)
            {
                if (stopping)
                {
                    return;
                }

                stopping = true;
            }

            queues.Close();
            try
            {
                stream.Dispose();
            }
            catch (IOException)
            {
                // 流可能已被对端拆除。
            }
            catch (ObjectDisposedException)
            {
                // 已关闭。
            }
            catch (SocketException)
            {
                // 套接字已断开。
            }

            PulseWriter();
            NotifyClosed(error);
            closedEvent.Set();
        }

        private void NotifyClosed(Exception error)
        {
            lock (lifecycleGate)
            {
                if (closeNotified)
                {
                    return;
                }

                closeNotified = true;
            }

            try
            {
                onClosed(error);
            }
            catch (Exception exception)
            {
                log?.Invoke("[bridge] close handler failed: " + exception.Message);
            }
        }

        private static void JoinThread(Thread thread)
        {
            if (thread == Thread.CurrentThread || !thread.IsAlive)
            {
                return;
            }

            thread.Join(2000);
        }
    }
}
