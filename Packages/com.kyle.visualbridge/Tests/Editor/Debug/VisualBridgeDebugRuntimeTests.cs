using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using NUnit.Framework;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeDebugRuntimeTests
    {
        private const string TestInterface = "Game.Debug.ITestDebuger";

        private static readonly NdjsonFramer Framer = new NdjsonFramer();

        private enum TestKind
        {
            First = 0,
            Second = 1,
        }

        private sealed class FakeTransport : IDebugTransport
        {
            private readonly object _gate = new object();
            private readonly List<byte[]> _sent = new List<byte[]>();
            private int _batchCount;

            public bool IsConnected { get; private set; } = true;

            public event Action<bool> ConnectionChanged;

            public bool Disposed { get; private set; }

            /// <summary>为 true 时 SendBatch 抛异常，用于模拟写失败。</summary>
            public volatile bool ThrowOnBatch;

            public int SentCount
            {
                get
                {
                    lock (_gate)
                    {
                        return _sent.Count;
                    }
                }
            }

            public int BatchCount
            {
                get
                {
                    lock (_gate)
                    {
                        return _batchCount;
                    }
                }
            }

            public IReadOnlyList<byte[]> Snapshot()
            {
                lock (_gate)
                {
                    return _sent.ToArray();
                }
            }

            public void Send(byte[] payload)
            {
                lock (_gate)
                {
                    _sent.Add(payload);
                }
            }

            public void SendBatch(IReadOnlyList<byte[]> payloads)
            {
                if (ThrowOnBatch)
                {
                    throw new InvalidOperationException("模拟写失败");
                }

                lock (_gate)
                {
                    for (int i = 0; i < payloads.Count; i++)
                    {
                        _sent.Add(payloads[i]);
                    }

                    _batchCount++;
                }
            }

            public void SetConnected(bool connected)
            {
                IsConnected = connected;
                Action<bool> handler = ConnectionChanged;
                if (handler != null)
                {
                    handler(connected);
                }
            }

            public void Dispose()
            {
                Disposed = true;
                IsConnected = false;
            }
        }

        [SetUp]
        public void SetUp()
        {
            VisualBridgeDebug.Detach();
            VisualBridgeDebug.SetFramer(null);
            VisualBridgeDebug.Counters.Reset();
            VisualBridgeDebug.UnregisterRequestHandler(TestInterface);
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeDebug.Detach();
            VisualBridgeDebug.UnregisterRequestHandler(TestInterface);
            VisualBridgeDebug.SetFramer(null);
        }

        [Test]
        public void CallsWithoutAttachSendNothing()
        {
            var transport = new FakeTransport();

            VisualBridgeDebug.Start("graph", 1, TestInterface, "NodeStart", "inst-1", null, 3);
            VisualBridgeDebug.PushParam("a", 0, 1);
            VisualBridgeDebug.End();
            VisualBridgeDebug.DescribeInstance("graph", "inst-1", "label", "a");
            Thread.Sleep(150);

            Assert.That(VisualBridgeDebug.isConnected, Is.False);
            Assert.That(transport.SentCount, Is.EqualTo(0));
            Assert.That(VisualBridgeDebug.Counters.malformed, Is.EqualTo(0));
            Assert.That(VisualBridgeDebug.Counters.filtered, Is.EqualTo(0));
        }

        [Test]
        public void AttachedMessageRoundTrips()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);
            Assert.That(VisualBridgeDebug.isConnected, Is.True);

            VisualBridgeDebug.Start("graph", 1, TestInterface, "NodeStart", "inst-1", null, 42);
            VisualBridgeDebug.PushParam("flag", 0, true);
            VisualBridgeDebug.PushParam("i", 1, 7);
            VisualBridgeDebug.PushParam("l", 2, 9007199254740993L);
            VisualBridgeDebug.PushParam("u", 3, ulong.MaxValue);
            VisualBridgeDebug.PushParam("f", 4, 1.5f);
            VisualBridgeDebug.PushParam("d", 5, 2.25);
            VisualBridgeDebug.PushParam("e", 6, TestKind.Second);
            VisualBridgeDebug.PushParam("s", 7, "hello");
            VisualBridgeDebug.PushParam("b", 8, new byte[] { 1, 2, 3 });
            VisualBridgeDebug.End();

            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            DebugMessageHeader header = ParseSingle(transport.Snapshot()[0], out args);

            Assert.That(header.Kind, Is.EqualTo(DebugMessageKind.Debug));
            Assert.That(header.Category, Is.EqualTo("graph"));
            Assert.That(header.Instance, Is.EqualTo("inst-1"));
            Assert.That(header.Version, Is.EqualTo(1));
            Assert.That(header.Interface, Is.EqualTo(TestInterface));
            Assert.That(header.Method, Is.EqualTo("NodeStart"));
            Assert.That(header.RequestId, Is.Null);
            Assert.That(header.Frame, Is.EqualTo(42));
            Assert.That(header.Seq, Is.GreaterThanOrEqualTo(1));

            Assert.That(args.Count, Is.EqualTo(9));
            Assert.That(args[0].Value, Is.EqualTo(true));
            Assert.That(args[1].Value, Is.EqualTo(7));
            Assert.That(args[2].Value, Is.EqualTo(9007199254740993L));
            Assert.That(args[3].Value, Is.EqualTo(ulong.MaxValue));
            Assert.That(Convert.ToSingle(args[4].Value), Is.EqualTo(1.5f));
            Assert.That(args[5].Value, Is.EqualTo(2.25));
            Assert.That(args[6].Value, Is.EqualTo("Second"));
            Assert.That(args[7].Value, Is.EqualTo("hello"));
            Assert.That(args[8].Value, Is.EqualTo("AQID"));
        }

        [Test]
        public void QueryResultCarriesRequestIdAndKind()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            VisualBridgeDebug.Start("graph", 1, TestInterface, "GetSnapshot", "inst-1", "req-7");
            VisualBridgeDebug.PushParam("snapshot", 0, "payload");
            VisualBridgeDebug.End();

            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            DebugMessageHeader header = ParseSingle(transport.Snapshot()[0], out args);

            Assert.That(header.Kind, Is.EqualTo(DebugMessageKind.DebugResult));
            Assert.That(header.RequestId, Is.EqualTo("req-7"));
            Assert.That(header.Frame, Is.EqualTo(-1));
            Assert.That(args[0].Value, Is.EqualTo("payload"));
        }

        [Test]
        public void QueueSeqStartsAtOne()
        {
            var queue = new VisualBridgeDebugQueue(new VisualBridgeDebugCounters(), 4);

            Assert.That(queue.Enqueue(seq => new[] { (byte)seq }), Is.EqualTo(1));
            Assert.That(queue.Enqueue(seq => new[] { (byte)seq }), Is.EqualTo(2));
        }

        [Test]
        public void QueueDropsOldestWhenFull()
        {
            var counters = new VisualBridgeDebugCounters();
            var queue = new VisualBridgeDebugQueue(counters, 2);

            queue.Enqueue(seq => new[] { (byte)seq });
            queue.Enqueue(seq => new[] { (byte)seq });
            queue.Enqueue(seq => new[] { (byte)seq });

            Assert.That(counters.droppedQueue, Is.EqualTo(1));
        }

        [Test]
        public void SeqIsMonotonicAcrossMessages()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            for (int i = 0; i < 3; i++)
            {
                VisualBridgeDebug.Start("graph", 1, TestInterface, "NodeStart", "inst-1");
                VisualBridgeDebug.PushParam("i", 0, i);
                VisualBridgeDebug.End();
            }

            WaitFor(transport, 3);
            IReadOnlyList<byte[]> sent = transport.Snapshot();
            Assert.That(sent.Count, Is.EqualTo(3));

            long previous = -1;
            for (int i = 0; i < sent.Count; i++)
            {
                IReadOnlyList<DebugArgValue> ignored;
                DebugMessageHeader header = ParseSingle(sent[i], out ignored);
                Assert.That(header.Seq, Is.GreaterThanOrEqualTo(1));
                if (i == 0)
                {
                    previous = header.Seq;
                    continue;
                }

                Assert.That(header.Seq, Is.EqualTo(previous + 1));
                previous = header.Seq;
            }
        }

        [Test]
        public void ConcurrentBuildsAreIsolated()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            var first = new Thread(() => SendOne("ThreadA", "a", 40));
            var second = new Thread(() => SendOne("ThreadB", "b", 40));
            first.Start();
            second.Start();
            Assert.That(first.Join(5000), Is.True);
            Assert.That(second.Join(5000), Is.True);

            WaitFor(transport, 2);
            IReadOnlyList<byte[]> sent = transport.Snapshot();
            Assert.That(sent.Count, Is.EqualTo(2));

            var seqs = new HashSet<long>();
            for (int i = 0; i < sent.Count; i++)
            {
                IReadOnlyList<DebugArgValue> args;
                DebugMessageHeader header = ParseSingle(sent[i], out args);
                Assert.That(header.Method, Is.EqualTo("ThreadA").Or.EqualTo("ThreadB"));
                Assert.That(args.Count, Is.EqualTo(40));
                Assert.That(args[0].Name, Is.EqualTo(header.Method == "ThreadA" ? "a0" : "b0"));
                for (int j = 0; j < args.Count; j++)
                {
                    Assert.That(args[j].Name, Is.EqualTo(args[0].Name.Substring(0, 1) + j));
                }

                seqs.Add(header.Seq);
            }

            Assert.That(seqs.Count, Is.EqualTo(2));
        }

        [Test]
        public void ReStartWithoutEndCountsMalformedAndKeepsSecondMessage()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            VisualBridgeDebug.Start("graph", 1, TestInterface, "First", "inst-1");
            VisualBridgeDebug.PushParam("x", 0, 1);
#if UNITY_EDITOR
            UnityEngine.TestTools.LogAssert.Expect(
                UnityEngine.LogType.Error,
                new System.Text.RegularExpressions.Regex("上一条调试消息尚未 End"));
#endif
            VisualBridgeDebug.Start("graph", 1, TestInterface, "Second", "inst-1");
            VisualBridgeDebug.PushParam("y", 0, 2);
            VisualBridgeDebug.End();

            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            DebugMessageHeader header = ParseSingle(transport.Snapshot()[0], out args);

            Assert.That(header.Method, Is.EqualTo("Second"));
            Assert.That(args.Count, Is.EqualTo(1));
            Assert.That(args[0].Name, Is.EqualTo("y"));
            Assert.That(args[0].Value, Is.EqualTo(2));
            Assert.That(VisualBridgeDebug.Counters.malformed, Is.EqualTo(1));
        }

        [Test]
        public void PushWithoutStartIsIgnoredAndCounted()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            VisualBridgeDebug.PushParam("x", 0, 1);
            VisualBridgeDebug.End();
            Thread.Sleep(150);

            Assert.That(transport.SentCount, Is.EqualTo(0));
            Assert.That(VisualBridgeDebug.Counters.filtered, Is.EqualTo(2));
        }

        [Test]
        public void DescribeInstanceSendsMetadataAndTruncates()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            var keywords = new string[20];
            for (int i = 0; i < keywords.Length; i++)
            {
                keywords[i] = new string((char)('a' + i), 80);
            }

            VisualBridgeDebug.DescribeInstance("graph", "inst-1", "Graph Exec", keywords);
            VisualBridgeDebug.DescribeInstance("graph", string.Empty, "ignored");

            WaitFor(transport, 1);
            Thread.Sleep(150);
            IReadOnlyList<byte[]> sent = transport.Snapshot();
            Assert.That(sent.Count, Is.EqualTo(1));

            Assert.That(
                Framer.TryParse(sent[0], out _, out DebugMessageHeader header, out IDebugMessageBody body),
                Is.True);
            var instance = (DebugInstanceBody)body;
            Assert.That(header.Kind, Is.EqualTo(DebugMessageKind.Instance));
            Assert.That(header.Category, Is.EqualTo("graph"));
            Assert.That(header.Instance, Is.EqualTo("inst-1"));
            Assert.That(instance.Label, Is.EqualTo("Graph Exec"));
            Assert.That(instance.Keywords.Count, Is.EqualTo(16));
            Assert.That(instance.Keywords[0].Length, Is.EqualTo(64));
        }

        [Test]
        public void RegisteredHandlerReceivesRequest()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            int calls = 0;
            VisualBridgeDebugRequest captured = default;
            VisualBridgeDebug.RegisterRequestHandler(TestInterface, request =>
            {
                calls++;
                captured = request;
            });

            VisualBridgeDebug.OnRequest(MakeRequest("GetSnapshot", "req-1", new[]
            {
                new DebugArgValue("uid", 0, DebugValueKind.String, "abc"),
            }));

            Assert.That(calls, Is.EqualTo(1));
            Assert.That(captured.Interface, Is.EqualTo(TestInterface));
            Assert.That(captured.Method, Is.EqualTo("GetSnapshot"));
            Assert.That(captured.RequestId, Is.EqualTo("req-1"));
            string uid;
            Assert.That(captured.TryGetArg(0, out uid), Is.True);
            Assert.That(uid, Is.EqualTo("abc"));
            Thread.Sleep(150);
            Assert.That(transport.SentCount, Is.EqualTo(0));
        }

        [Test]
        public void UnregisterRemovesHandler()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            int calls = 0;
            VisualBridgeDebug.RegisterRequestHandler(TestInterface, request => calls++);
            VisualBridgeDebug.UnregisterRequestHandler(TestInterface);

            VisualBridgeDebug.OnRequest(MakeRequest("GetSnapshot", "req-removed", Array.Empty<DebugArgValue>()));

            Assert.That(calls, Is.EqualTo(0));
            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            ParseSingle(transport.Snapshot()[0], out args);
            Assert.That(args[0].Value, Is.EqualTo("unregistered"));
        }

        [Test]
        public void DuplicateRegistrationUsesLastHandler()
        {
            int first = 0;
            int second = 0;
            VisualBridgeDebug.RegisterRequestHandler(TestInterface, request => first++);
            VisualBridgeDebug.RegisterRequestHandler(TestInterface, request => second++);

            VisualBridgeDebug.OnRequest(MakeRequest("GetSnapshot", null, Array.Empty<DebugArgValue>()));

            Assert.That(first, Is.EqualTo(0));
            Assert.That(second, Is.EqualTo(1));
        }

        [Test]
        public void UnregisteredRequestSendsResult()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            VisualBridgeDebug.OnRequest(MakeRequest("GetSnapshot", "req-9", new[]
            {
                new DebugArgValue("uid", 0, DebugValueKind.String, "abc"),
            }));

            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            DebugMessageHeader header = ParseSingle(transport.Snapshot()[0], out args);

            Assert.That(header.Kind, Is.EqualTo(DebugMessageKind.DebugResult));
            Assert.That(header.RequestId, Is.EqualTo("req-9"));
            Assert.That(header.Category, Is.EqualTo("graph"));
            Assert.That(header.Instance, Is.EqualTo("inst-1"));
            Assert.That(header.Interface, Is.EqualTo(TestInterface));
            Assert.That(header.Method, Is.EqualTo("GetSnapshot"));
            Assert.That(args.Count, Is.EqualTo(1));
            Assert.That(args[0].Value, Is.EqualTo("unregistered"));
        }

        [Test]
        public void OnRequestArgumentErrorSendsResult()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            VisualBridgeDebug.OnRequestArgumentError(MakeRequest("GetSnapshot", "req-arg", Array.Empty<DebugArgValue>()));

            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            DebugMessageHeader header = ParseSingle(transport.Snapshot()[0], out args);

            Assert.That(header.Kind, Is.EqualTo(DebugMessageKind.DebugResult));
            Assert.That(header.RequestId, Is.EqualTo("req-arg"));
            Assert.That(args.Count, Is.EqualTo(1));
            Assert.That(args[0].Value, Is.EqualTo("invalidArgument"));
        }

        [Test]
        public void HandlerExceptionIsCountedAndReported()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);
            VisualBridgeDebug.RegisterRequestHandler(TestInterface, request =>
            {
                throw new InvalidOperationException("boom");
            });

            Assert.DoesNotThrow(() =>
            {
                VisualBridgeDebug.OnRequest(MakeRequest("GetSnapshot", "req-boom", Array.Empty<DebugArgValue>()));
            });

            Assert.That(VisualBridgeDebug.Counters.handlerErrors, Is.EqualTo(1));
            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            ParseSingle(transport.Snapshot()[0], out args);
            Assert.That(args[0].Value, Is.EqualTo("handlerError"));
        }

        [Test]
        public void TryGetArgConvertsByTargetType()
        {
            var request = MakeRequest("GetSnapshot", "req-conv", new[]
            {
                new DebugArgValue("flag", 0, DebugValueKind.Bool, true),
                new DebugArgValue("flagText", 1, DebugValueKind.String, "false"),
                new DebugArgValue("i", 2, DebugValueKind.Int64, 42L),
                new DebugArgValue("d", 3, DebugValueKind.Double, 3.0),
                new DebugArgValue("l", 4, DebugValueKind.String, "9007199254740993"),
                new DebugArgValue("u", 5, DebugValueKind.String, "18446744073709551615"),
                new DebugArgValue("f", 6, DebugValueKind.Double, 1.5),
                new DebugArgValue("s", 7, DebugValueKind.Int32, 42),
                new DebugArgValue("bytes", 8, DebugValueKind.String, "AQID"),
                new DebugArgValue("kind", 9, DebugValueKind.String, "Second"),
                new DebugArgValue("kindInt", 10, DebugValueKind.Int32, 1),
                new DebugArgValue("badInt", 11, DebugValueKind.Double, 3.5),
            });

            bool flag;
            Assert.That(request.TryGetArg(0, out flag), Is.True);
            Assert.That(flag, Is.True);

            bool flagText;
            Assert.That(request.TryGetArg(1, out flagText), Is.True);
            Assert.That(flagText, Is.False);

            int i;
            Assert.That(request.TryGetArg(2, out i), Is.True);
            Assert.That(i, Is.EqualTo(42));

            int d;
            Assert.That(request.TryGetArg(3, out d), Is.True);
            Assert.That(d, Is.EqualTo(3));

            int badInt;
            Assert.That(request.TryGetArg(11, out badInt), Is.False);
            Assert.That(badInt, Is.EqualTo(0));

            long l;
            Assert.That(request.TryGetArg(4, out l), Is.True);
            Assert.That(l, Is.EqualTo(9007199254740993L));

            ulong u;
            Assert.That(request.TryGetArg(5, out u), Is.True);
            Assert.That(u, Is.EqualTo(ulong.MaxValue));

            float f;
            Assert.That(request.TryGetArg(6, out f), Is.True);
            Assert.That(f, Is.EqualTo(1.5f));

            string s;
            Assert.That(request.TryGetArg(7, out s), Is.True);
            Assert.That(s, Is.EqualTo("42"));

            string byName;
            Assert.That(request.TryGetArg("l", out byName), Is.True);
            Assert.That(byName, Is.EqualTo("9007199254740993"));

            byte[] bytes;
            Assert.That(request.TryGetArg(8, out bytes), Is.True);
            Assert.That(bytes, Is.EqualTo(new byte[] { 1, 2, 3 }));

            TestKind kind;
            Assert.That(request.TryGetArg(9, out kind), Is.True);
            Assert.That(kind, Is.EqualTo(TestKind.Second));

            TestKind kindInt;
            Assert.That(request.TryGetArg(10, out kindInt), Is.True);
            Assert.That(kindInt, Is.EqualTo(TestKind.Second));

            bool fromInt;
            Assert.That(request.TryGetArg(2, out fromInt), Is.False);

            Guid unsupported;
            Assert.That(request.TryGetArg(0, out unsupported), Is.False);

            Assert.That(request.GetArg(7), Is.EqualTo(42));
            Assert.That(request.GetArg(99), Is.Null);
        }

        [Test]
        public void TryGetArgFallsBackToIndexWhenTagMissing()
        {
            var request = MakeRequest("GetSnapshot", "req-tag", new[]
            {
                new DebugArgValue("uid", 0, DebugValueKind.String, "abc"),
                new DebugArgValue("requestId", 0, DebugValueKind.String, "r-1"),
            });

            string second;
            Assert.That(request.TryGetArg(1, out second), Is.True);
            Assert.That(second, Is.EqualTo("r-1"));
        }

        [Test]
        public void DetachIsIdempotentAndStopsSending()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            VisualBridgeDebug.Detach();
            VisualBridgeDebug.Detach();

            Assert.That(VisualBridgeDebug.isConnected, Is.False);
            Assert.That(transport.Disposed, Is.True);

            VisualBridgeDebug.Start("graph", 1, TestInterface, "NodeStart");
            VisualBridgeDebug.PushParam("x", 0, 1);
            VisualBridgeDebug.End();
            Thread.Sleep(150);

            Assert.That(transport.SentCount, Is.EqualTo(0));
        }

        [Test]
        public void DetachFlushesQueuedMessages()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            VisualBridgeDebug.Start("graph", 1, TestInterface, "NodeStart");
            VisualBridgeDebug.PushParam("x", 0, 1);
            VisualBridgeDebug.End();

            VisualBridgeDebug.Detach();

            Assert.That(transport.SentCount, Is.EqualTo(1));
        }

        [Test]
        public void DetachFlushesMoreThanOneBatch()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            for (int i = 0; i < 130; i++)
            {
                VisualBridgeDebug.Start("graph", 1, TestInterface, "NodeStart");
                VisualBridgeDebug.PushParam("i", 0, i);
                VisualBridgeDebug.End();
            }

            VisualBridgeDebug.Detach();

            Assert.That(transport.SentCount, Is.EqualTo(130));
            Assert.That(VisualBridgeDebug.Counters.droppedQueue, Is.EqualTo(0));
        }

        [Test]
        public void WriteFailureThenReconnectResumesSending()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            transport.ThrowOnBatch = true;
            VisualBridgeDebug.Start("graph", 1, TestInterface, "BeforeFailure");
            VisualBridgeDebug.PushParam("x", 0, 1);
            VisualBridgeDebug.End();

            WaitUntil(() => !VisualBridgeDebug.isConnected);
            transport.ThrowOnBatch = false;

            transport.SetConnected(false);
            Assert.That(VisualBridgeDebug.isConnected, Is.False);
            transport.SetConnected(true);
            Assert.That(VisualBridgeDebug.isConnected, Is.True);

            VisualBridgeDebug.Start("graph", 1, TestInterface, "AfterReconnect");
            VisualBridgeDebug.PushParam("y", 0, 2);
            VisualBridgeDebug.End();

            WaitFor(transport, 1);
            IReadOnlyList<DebugArgValue> args;
            DebugMessageHeader header = ParseSingle(transport.Snapshot()[0], out args);

            Assert.That(header.Method, Is.EqualTo("AfterReconnect"));
            Assert.That(args[0].Value, Is.EqualTo(2));
        }

        [Test]
        public void OldWriterFailureDoesNotAffectNewConnection()
        {
            var counters = new VisualBridgeDebugCounters();
            var queue = new VisualBridgeDebugQueue(counters, 32);
            var second = new FakeTransport();
            int errors = 0;

            using (var entered = new ManualResetEventSlim(false))
            using (var release = new ManualResetEventSlim(false))
            {
                queue.StartWriter(
                    batch =>
                    {
                        entered.Set();
                        release.Wait(5000);
                        throw new InvalidOperationException("旧代际写失败");
                    },
                    () => Interlocked.Increment(ref errors));

                queue.Enqueue(seq => new[] { (byte)1 });
                Assert.That(entered.Wait(3000), Is.True);

                // 旧写线程阻塞在 SendBatch 中，StopWriter 只能超时返回。
                queue.StopWriter(50);

                queue.StartWriter(batch => second.SendBatch(batch), () => Interlocked.Increment(ref errors));
                queue.Enqueue(seq => new[] { (byte)2 });
                WaitFor(second, 1);

                // 旧代际随后失败：不得清空新队列、停止新写线程或触发错误回调。
                release.Set();
                Thread.Sleep(200);

                Assert.That(errors, Is.EqualTo(0));
                Assert.That(second.SentCount, Is.EqualTo(1));

                queue.Enqueue(seq => new[] { (byte)3 });
                WaitFor(second, 2);
                Assert.That(second.Snapshot()[1][0], Is.EqualTo((byte)3));
            }
        }

        [Test]
        public void DisconnectClearsPendingMessages()
        {
            var transport = new FakeTransport();
            VisualBridgeDebug.Attach(transport);

            transport.SetConnected(false);
            Assert.That(VisualBridgeDebug.isConnected, Is.False);

            VisualBridgeDebug.Start("graph", 1, TestInterface, "NodeStart");
            VisualBridgeDebug.PushParam("x", 0, 1);
            VisualBridgeDebug.End();
            Thread.Sleep(150);

            Assert.That(transport.SentCount, Is.EqualTo(0));
        }

        [Test]
        public void NullTransportNeverConnects()
        {
            var transport = new NullDebugTransport();
            transport.Send(new byte[] { 1 });
            transport.SendBatch(new List<byte[]> { new byte[] { 1 } });
            transport.Dispose();

            Assert.That(transport.IsConnected, Is.False);
        }

        private static void SendOne(string method, string prefix, int count)
        {
            VisualBridgeDebug.Start("graph", 1, TestInterface, method, "inst-1", null, 9);
            for (int i = 0; i < count; i++)
            {
                VisualBridgeDebug.PushParam(prefix + i, i, i);
            }

            VisualBridgeDebug.End();
        }

        private static VisualBridgeDebugRequest MakeRequest(
            string method,
            string requestId,
            IReadOnlyList<DebugArgValue> args)
        {
            var header = new DebugMessageHeader(
                DebugMessageKind.Debug,
                "graph",
                "inst-1",
                1,
                TestInterface,
                method,
                requestId,
                7,
                -1);
            return new VisualBridgeDebugRequest(header, args);
        }

        private static DebugMessageHeader ParseSingle(byte[] payload, out IReadOnlyList<DebugArgValue> args)
        {
            bool parsed = Framer.TryParse(
                payload,
                out int consumed,
                out DebugMessageHeader header,
                out IDebugMessageBody body);
            Assert.That(parsed, Is.True);
            Assert.That(consumed, Is.EqualTo(payload.Length));
            args = ((DebugArgsBody)body).Args;
            return header;
        }

        private static void WaitUntil(Func<bool> condition)
        {
            const int stepMs = 10;
            const int timeoutMs = 3000;
            int waited = 0;
            while (!condition() && waited < timeoutMs)
            {
                Thread.Sleep(stepMs);
                waited += stepMs;
            }

            Assert.That(condition(), Is.True);
        }

        private static void WaitFor(FakeTransport transport, int count)
        {
            const int stepMs = 10;
            const int timeoutMs = 3000;
            int waited = 0;
            while (transport.SentCount < count && waited < timeoutMs)
            {
                Thread.Sleep(stepMs);
                waited += stepMs;
            }

            Assert.That(transport.SentCount, Is.GreaterThanOrEqualTo(count));
        }
    }
}
