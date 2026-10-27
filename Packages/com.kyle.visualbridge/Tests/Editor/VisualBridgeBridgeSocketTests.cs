using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using NUnit.Framework;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// 连接级 socket 封装的 EditMode 用例：同连接双通道分流、CRC 失败即断、
    /// 以及「先回错误帧再断开」的优雅关闭。
    /// </summary>
    public sealed class VisualBridgeBridgeSocketTests
    {
        [Test]
        public void DispatchesControlAndDebugFramesOnOneConnection()
        {
            using (var pair = SocketPair.Create())
            {
                var received = new ConcurrentQueue<string>();
                using (var serverBridge = new VisualBridgeBridgeSocket(
                    pair.ServerStream,
                    payload => received.Enqueue("control:" + Encoding.UTF8.GetString(payload)),
                    (payloadKind, payload) => received.Enqueue("debug:" + payloadKind + ":" + payload.Length),
                    _ => { },
                    null,
                    null))
                using (var clientBridge = new VisualBridgeBridgeSocket(
                    pair.ClientStream,
                    _ => { },
                    (_, __) => { },
                    _ => { },
                    null,
                    null))
                {
                    serverBridge.Start();
                    clientBridge.Start();
                    Assert.That(clientBridge.SendControlJson("{\"type\":\"hello\",\"protocolVersion\":4}"), Is.True);
                    Assert.That(clientBridge.SendDebug(new byte[] { 0, 1, 2, 3 }, VisualBridgePayloadKind.Binary), Is.True);
                    Assert.That(clientBridge.SendDebug(Encoding.UTF8.GetBytes("{\"type\":\"debug\"}"), VisualBridgePayloadKind.Json), Is.True);
                    Assert.That(WaitUntil(() => received.Count == 3), Is.True, "expected three frames");

                    var events = new List<string>(received.ToArray());
                    events.Sort(StringComparer.Ordinal);
                    Assert.That(events, Is.EquivalentTo(new[]
                    {
                        "control:{\"type\":\"hello\",\"protocolVersion\":4}",
                        "debug:Binary:4",
                        "debug:Json:16",
                    }));
                }
            }
        }

        [Test]
        public void ClosesImmediatelyOnACorruptedFrameHeader()
        {
            using (var pair = SocketPair.Create())
            {
                Exception closeError = null;
                var closed = new ManualResetEventSlim(false);
                var received = 0;
                using (var serverBridge = new VisualBridgeBridgeSocket(
                    pair.ServerStream,
                    _ => Interlocked.Increment(ref received),
                    (_, __) => Interlocked.Increment(ref received),
                    error =>
                    {
                        closeError = error;
                        closed.Set();
                    },
                    null,
                    null))
                {
                    serverBridge.Start();
                    var frame = VisualBridgeFraming.EncodeFrame(
                        VisualBridgeChannel.Editor,
                        VisualBridgePayloadKind.Json,
                        Encoding.UTF8.GetBytes("{}"));
                    var corrupted = (byte[])frame.Clone();
                    corrupted[4] ^= 0xFF;
                    pair.ClientStream.Write(corrupted, 0, corrupted.Length);
                    pair.ClientStream.Write(frame, 0, frame.Length);
                    pair.ClientStream.Flush();

                    Assert.That(closed.Wait(3000), Is.True, "connection must close on a bad frame header");
                    Assert.That(closeError, Is.InstanceOf<VisualBridgeFrameException>());
                    Assert.That(((VisualBridgeFrameException)closeError).Code, Is.EqualTo(VisualBridgeFrameErrorCode.InvalidCrc));
                    Assert.That(received, Is.Zero, "CRC 失败后不得投递任何帧");
                }
            }
        }

        [Test]
        public void GracefulCloseFlushesTheQueuedErrorFrameBeforeDisconnecting()
        {
            using (var pair = SocketPair.Create())
            {
                var received = new ConcurrentQueue<string>();
                using (var serverBridge = new VisualBridgeBridgeSocket(
                    pair.ServerStream,
                    _ => { },
                    (_, __) => { },
                    _ => { },
                    null,
                    null))
                using (var clientBridge = new VisualBridgeBridgeSocket(
                    pair.ClientStream,
                    payload => received.Enqueue(Encoding.UTF8.GetString(payload)),
                    (_, __) => { },
                    _ => { },
                    null,
                    null))
                {
                    serverBridge.Start();
                    clientBridge.Start();
                    Assert.That(serverBridge.SendControlJson("{\"type\":\"error\",\"code\":\"bridge.invalidToken\"}"), Is.True);
                    serverBridge.CloseGracefully(1000);
                    Assert.That(WaitUntil(() => received.Count == 1), Is.True, "the error frame must be delivered before close");
                    received.TryDequeue(out var payload);
                    Assert.That(payload, Does.Contain("bridge.invalidToken"));
                }
            }
        }

        [Test]
        public void ClosesWhenTheControlQueueFillsInsteadOfDroppingControlMessages()
        {
            var closeErrors = new System.Collections.Generic.List<Exception>();
            using (var stream = new BlockingStream())
            using (var bridge = new VisualBridgeBridgeSocket(
                stream,
                _ => { },
                (_, __) => { },
                error => closeErrors.Add(error),
                null,
                null))
            {
                bridge.Start();
                // 第一条被写线程取走并阻塞在 Write 上，后续 256 条填满控制队列。
                Assert.That(bridge.SendControlJson("{\"index\":0}"), Is.True);
                Assert.That(stream.WaitForWrite(3000), Is.True, "the writer must be blocked on the first frame");

                for (var index = 1; index <= 256; index++)
                {
                    Assert.That(bridge.SendControlJson("{\"index\":" + index + "}"), Is.True, "control " + index);
                }

                Assert.That(bridge.SendControlJson("{\"index\":257}"), Is.False, "a full control queue must close the connection");
                Assert.That(bridge.IsOpen, Is.False);
                Assert.That(bridge.SendCounters.ControlEnqueued, Is.EqualTo(257));
                // 队列满不只是"返回 false"：onClosed 必须真的被调用一次并说明原因。
                Assert.That(WaitUntil(() => closeErrors.Count == 1), Is.True, "the close must be reported exactly once");
                Assert.That(closeErrors[0].Message, Does.Contain("Control queue is full"));
            }
        }

        [Test]
        public void SendsPingWhenIdleAndStaysOpenWhileHeartbeatsArrive()
        {
            using (var pair = SocketPair.Create())
            using (var bridge = new VisualBridgeBridgeSocket(
                pair.ClientStream,
                _ => { },
                (_, __) => { },
                _ => { },
                null,
                null,
                new VisualBridgeHeartbeatOptions { IntervalMs = 60, IdleTimeoutMs = 2000 }))
            {
                bridge.Start();

                // 对端什么都不发：写线程必须在空闲一个心跳间隔后自己入队 ping。
                var reader = new VisualBridgeFrameReader();
                var pingSeen = false;
                var buffer = new byte[4096];
                pair.ServerStream.ReadTimeout = 3000;
                var deadline = DateTime.UtcNow.AddSeconds(3);
                while (!pingSeen && DateTime.UtcNow < deadline)
                {
                    int read;
                    try
                    {
                        read = pair.ServerStream.Read(buffer, 0, buffer.Length);
                    }
                    catch (IOException)
                    {
                        break;
                    }

                    if (read <= 0)
                    {
                        break;
                    }

                    var chunk = new byte[read];
                    Array.Copy(buffer, chunk, read);
                    reader.Append(chunk, 0, chunk.Length);
                    while (reader.TryReadFrame(out var frame))
                    {
                        if (VisualBridgePingPayload.IsPing(frame.Payload))
                        {
                            pingSeen = true;
                        }
                    }
                }

                Assert.That(pingSeen, Is.True, "An idle connection must emit a ping after the heartbeat interval.");
                Assert.That(bridge.IsOpen, Is.True, "Heartbeats keep an otherwise idle connection alive.");
            }
        }

        [Test]
        public void ClosesWhenNoInboundBytesArriveWithinTheIdleTimeout()
        {
            using (var pair = SocketPair.Create())
            {
                Exception closeError = null;
                var closed = new ManualResetEventSlim(false);
                using (var bridge = new VisualBridgeBridgeSocket(
                    pair.ClientStream,
                    _ => { },
                    (_, __) => { },
                    error =>
                    {
                        closeError = error;
                        closed.Set();
                    },
                    null,
                    null,
                    // 心跳间隔远大于判死阈值：这条连接只会静默，然后被空闲超时断开。
                    new VisualBridgeHeartbeatOptions { IntervalMs = 5000, IdleTimeoutMs = 150 }))
                {
                    bridge.Start();
                    Assert.That(closed.Wait(5000), Is.True, "An idle connection must be closed by the idle timeout.");
                    Assert.That(bridge.IsOpen, Is.False);
                    Assert.That(closeError, Is.Not.Null);
                    Assert.That(closeError.Message, Does.Contain("idle timeout"));
                }
            }
        }

        private static bool WaitUntil(Func<bool> predicate, int timeoutMs = 3000)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                if (predicate())
                {
                    return true;
                }

                Thread.Sleep(10);
            }

            return predicate();
        }

        /// <summary>读写都会阻塞到 Close 的流：用于制造写线程背压、填满控制队列。</summary>
        private sealed class BlockingStream : Stream
        {
            private readonly ManualResetEventSlim released = new ManualResetEventSlim(false);
            private readonly ManualResetEventSlim writeEntered = new ManualResetEventSlim(false);
            private volatile bool disposed;

            public bool WaitForWrite(int timeoutMs)
            {
                return writeEntered.Wait(timeoutMs);
            }

            public override bool CanRead => true;

            public override bool CanSeek => false;

            public override bool CanWrite => true;

            public override long Length => throw new NotSupportedException();

            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public override void Flush()
            {
            }

            public override int Read(byte[] buffer, int offset, int count)
            {
                released.Wait();
                if (disposed)
                {
                    throw new ObjectDisposedException(nameof(BlockingStream));
                }

                return 0;
            }

            public override void Write(byte[] buffer, int offset, int count)
            {
                writeEntered.Set();
                released.Wait();
                if (disposed)
                {
                    throw new ObjectDisposedException(nameof(BlockingStream));
                }
            }

            public override long Seek(long offset, SeekOrigin origin)
            {
                throw new NotSupportedException();
            }

            public override void SetLength(long value)
            {
                throw new NotSupportedException();
            }

            protected override void Dispose(bool disposing)
            {
                disposed = true;
                released.Set();
                base.Dispose(disposing);
            }
        }

        private sealed class SocketPair : IDisposable
        {
            private readonly TcpListener listener;
            private readonly TcpClient serverClient;

            private SocketPair(TcpListener listener, TcpClient serverClient, TcpClient client)
            {
                this.listener = listener;
                this.serverClient = serverClient;
                Client = client;
            }

            public TcpClient Client { get; }

            public NetworkStream ServerStream => serverClient.GetStream();

            public NetworkStream ClientStream => Client.GetStream();

            public static SocketPair Create()
            {
                var listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                var client = new TcpClient();
                try
                {
                    var port = ((IPEndPoint)listener.LocalEndpoint).Port;
                    var async = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!async.AsyncWaitHandle.WaitOne(5000))
                    {
                        throw new TimeoutException("TCP connect timed out.");
                    }

                    client.EndConnect(async);
                    var serverClient = listener.AcceptTcpClient();
                    return new SocketPair(listener, serverClient, client);
                }
                catch
                {
                    client.Dispose();
                    listener.Stop();
                    throw;
                }
            }

            public void Dispose()
            {
                try
                {
                    Client.Dispose();
                    serverClient.Dispose();
                }
                finally
                {
                    listener.Stop();
                }
            }
        }
    }
}
