using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using NUnit.Framework;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// E4 调试消息与筛选用例：七种消息的 JSON/二进制线格式、槽位路由与失效、入队前筛选
    /// （不编码、不入队、计数）、dropped 聚合与节流、未知方法/未知槽位不断连、1 MB 上限。
    /// 线格式与 TS 侧 `test/unit/debugMessages.test.ts` 共用同一组 fixture（同一批字符串与十六进制）。
    /// E6 补充查询往返：入站 JSON `request` 的 `methodId` 必填校验与失败原因，以及
    /// 「JSON request → 真实 transport → D4 队列/泵 → `debugResult`」在 JSON 与二进制两种结果编码下
    /// 的 `requestId` 映射（`"req-12"` ↔ `u32 12`）与业务拒绝应答码 `runtime.queryRejected`。
    /// </summary>
    public sealed class VisualBridgeDebugTransportTests
    {
        private const string Category = "graph";
        private const string InterfaceId = "IGraphDebuger";
        private const string MethodName = "NodeStart";
        private const ushort MethodId = 10;
        private const ushort InstanceSlot = 1;
        private const string InstanceId = "hero";

        /// <summary>与 TS 侧 `test/unit/debugMessages.test.ts` 共用的 dropped 线格式字面量（含键顺序）。</summary>
        private const string DroppedJsonFixture = "{\"type\":\"dropped\",\"filteredByServer\":1,"
            + "\"unknownMethod\":1,\"unknownSlot\":1,\"invalidRequest\":1,\"encodeFailed\":0,"
            + "\"oversize\":0,\"queueOverflow\":5}";

        /// <summary>
        /// 与 TS 侧 `test/unit/debugMessages.test.ts` 共用的 request 信封（A.5 键序，含 E6 补的 `methodId`）。
        /// 两侧必须逐字节一致：键顺序是协议的一部分（fixture 比对即键序比对）。
        /// </summary>
        private const string RequestJsonFixture = "{\"type\":\"request\",\"requestId\":\"req-12\","
            + "\"action\":\"debugQuery\",\"category\":\"graph\",\"instance\":\"hero\","
            + "\"iface\":\"IGraphDebuger\",\"method\":\"IsVisible\",\"methodId\":10,"
            + "\"args\":[{\"tag\":1,\"name\":\"nodeId\",\"type\":\"int\",\"value\":3}]}";

        [SetUp]
        public void SetUp()
        {
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
        }

        [TearDown]
        public void TearDown()
        {
            // 处理器注册是静态接线（B.6.1），不随会话重置：用例自己收干净，避免串到别的用例。
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null);
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
        }

        // ---------- 线格式 fixture（JSON 文本 / 二进制十六进制） ----------

        [Test]
        public void DebugCreateMatchesJsonFixture()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);

            transport.SendCreate("hero", "graph", "R", string.Empty, InstanceSlot);

            Assert.AreEqual(1, wire.Controls.Count);
            Assert.AreEqual("{\"type\":\"debugCreate\",\"category\":\"graph\",\"instance\":\"hero\","
                + "\"instanceSlot\":1,\"resName\":\"R\",\"debugInfo\":\"\"}", Text(wire.Controls[0]));
            Assert.AreEqual(VisualBridgeDebugPayloadFormat.Json, wire.ControlFormats[0]);
        }

        [Test]
        public void DebugCreateMatchesBinaryFixture()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, VisualBridgeDebugPayloadFormat.Binary);

            transport.SendCreate("hero", "graph", "R", string.Empty, InstanceSlot);

            // u16 methodId=1 + u16 slot=1 + tag0 category / tag1 instanceId / tag2 resName（空串按稀疏规则不写）
            Assert.AreEqual(
                "00010001" + "00000800056772617068" + "0001080004" + "6865726f" + "0002080001" + "52",
                Hex(wire.Controls[0]));
            Assert.AreEqual(VisualBridgeDebugPayloadFormat.Binary, wire.ControlFormats[0]);
        }

        [Test]
        public void DebugFinishMatchesFixturesAndInvalidatesSlot()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            transport.SendFinish(InstanceId, InstanceSlot);

            Assert.AreEqual(2, wire.Controls.Count);
            Assert.AreEqual("{\"type\":\"debugFinish\",\"category\":\"graph\",\"instance\":\"hero\"}",
                Text(wire.Controls[1]));
            // 槽位映射在 debugFinish 后立即失效（附录 A.9）：同一槽位的数据消息按未知槽位丢弃。
            Assert.IsFalse(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            Assert.AreEqual(0, wire.Datas.Count);
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownSlot);
        }

        [Test]
        public void DebugFinishBinaryMatchesFixture()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, VisualBridgeDebugPayloadFormat.Binary);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            transport.SendFinish(InstanceId, InstanceSlot);

            Assert.AreEqual("00020001" + "0000080004" + "6865726f", Hex(wire.Controls[1]));
        }

        [Test]
        public void DroppedMatchesTheSharedJsonFixture()
        {
            var wire = new FakeWire { OverflowDroppedMessages = 5 };
            var transport = CreateTransport(wire, VisualBridgeDebugPayloadFormat.Json, droppedReportIntervalMs: 0);
            transport.SetFilter(new[] { "visualbridge.entity" }, null);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId); // 筛选
            transport.TryAdmitEvent(99, InstanceId, Category, MethodId); // 未知槽位
            transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, 5); // 未知方法
            wire.RaiseFrameReceived(VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes("{")); // 畸形入站
            transport.FlushDropped();

            // 全串 + 键顺序断言；TS 侧 test/unit/debugMessages.test.ts 用同一字面量。
            Assert.AreEqual(DroppedJsonFixture, FindLastControl(wire, "{\"type\":\"dropped\""));
        }

        [Test]
        public void QueueOverflowOnlyChangeIsReportedOnTick()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            Assert.AreEqual(0, CountControls(wire, "{\"type\":\"dropped\""));

            // 队列淘汰由发送侧计数，不经过传输层的丢弃路径：节拍必须能报出来（不被脏标记挡住）。
            wire.OverflowDroppedMessages = 7;
            wire.RaiseTick();

            var dropped = FindLastControl(wire, "{\"type\":\"dropped\"");
            Assert.IsNotNull(dropped);
            StringAssert.Contains("\"queueOverflow\":7", dropped);
            StringAssert.Contains("\"filteredByServer\":0", dropped);
        }

        [Test]
        public void DeeplyNestedInboundJsonIsRejectedWithoutClosing()
        {
            var wire = new FakeWire { OverflowDroppedMessages = 0 };
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            var deep = new StringBuilder();
            for (int index = 0; index < 200; index++)
            {
                deep.Append('[');
            }

            for (int index = 0; index < 200; index++)
            {
                deep.Append(']');
            }

            Assert.DoesNotThrow(() => wire.RaiseFrameReceived(VisualBridgePayloadKind.Json,
                Encoding.UTF8.GetBytes(deep.ToString())));
            Assert.AreEqual(1, transport.GetDroppedSnapshot().InvalidRequest);
            Assert.IsTrue(wire.IsOpen);

            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(Encoding.UTF8.GetBytes(deep.ToString()), out _,
                out string error));
            StringAssert.StartsWith("invalid-json", error);
        }

        [Test]
        public void DebugFinishWithoutKnownSlotOmitsCategory()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);

            transport.SendFinish("ghost", 42);

            Assert.AreEqual(1, wire.Controls.Count);
            Assert.AreEqual("{\"type\":\"debugFinish\",\"instance\":\"ghost\"}", Text(wire.Controls[0]));
        }

        [Test]
        public void AttachAfterBindFlushesPendingCreateAndFrame()
        {
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor,
                droppedReportIntervalMs: 0);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport); // 先 Install（此时未绑定连接）
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());

            // Create 早于连接：描述进待发队列，不写线上。
            Assert.IsTrue(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty));
            Assert.AreEqual(0, wire.Controls.Count);

            // 连接建立后 Attach：A.5 要求立即 flush 当前帧与待发描述，不再需要业务再 Create 一次。
            transport.Bind(wire);
            VisualBridgeDebug.Attach();

            // 附录 A.5 只规定"连接建立时先 flush 待发项""连接建立后先发一条当前值"，未规定 frame 与 create
            // 的相对顺序；本断言按实测顺序（`RefreshConnectionLocked` 先发帧再 flush）记录，两者都是任何数据消息之前的控制消息。
            Assert.AreEqual(2, wire.Controls.Count);
            Assert.AreEqual("{\"type\":\"debugFrame\",\"frame\":7}", Text(wire.Controls[0]));
            Assert.AreEqual("{\"type\":\"debugCreate\",\"category\":\"graph\",\"instance\":\"hero\","
                + "\"instanceSlot\":1,\"resName\":\"R\",\"debugInfo\":\"\"}", Text(wire.Controls[1]));
        }

        [Test]
        public void RealSocketSendsChannelOneControlInOrder()
        {
            var stream = new CaptureStream(10);
            var socket = new VisualBridgeBridgeSocket(stream, _ => { }, (_, __) => { }, _ => { }, null, null);
            socket.Start();
            var transport = new VisualBridgeDebugTransport(ConnectType.EditorPlayer,
                droppedReportIntervalMs: 0);
            try
            {
                // 通道 0 的 welcome 先写出，随后是通道 1 的控制类消息与数据消息。
                Assert.IsTrue(socket.SendControlJson("{\"type\":\"welcome\"}"));
                var link = new VisualBridgeRuntimeDebugLink(socket, 1L, null);
                transport.Bind(new VisualBridgeRuntimeDebugWire(link));
                VisualBridgeDebug.SetFrame(7);
                VisualBridgeDebugBridge.Install(transport);
                VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
                Assert.IsTrue(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty));
                Assert.IsTrue(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName));
                VisualBridgeDebug.PushParam("hp", 1, 5);
                Assert.IsTrue(VisualBridgeDebug.End());

                var frames = ReadFrames(stream, 4);
                Assert.AreEqual(4, frames.Count, "expected welcome + debugFrame + debugCreate + debug");
                Assert.AreEqual(VisualBridgeChannel.Editor, frames[0].Channel);
                StringAssert.Contains("welcome", Text(frames[0].Payload));
                // 通道 1 的控制类消息：帧头 channel=1，而不是 0。
                Assert.AreEqual(VisualBridgeChannel.Debug, frames[1].Channel);
                StringAssert.Contains("debugFrame", Text(frames[1].Payload));
                Assert.AreEqual(VisualBridgeChannel.Debug, frames[2].Channel);
                StringAssert.Contains("debugCreate", Text(frames[2].Payload));
                Assert.AreEqual(VisualBridgeChannel.Debug, frames[3].Channel);
                StringAssert.Contains("\"type\":\"debug\"", Text(frames[3].Payload));
                Assert.AreEqual(VisualBridgePayloadKind.Json, frames[2].PayloadKind);

                // 写出统计按队列类别：三条控制队列消息 + 一条数据消息。
                var counters = socket.SendCounters;
                Assert.AreEqual(3, counters.WrittenControl);
                Assert.AreEqual(1, counters.WrittenDebug);
            }
            finally
            {
                socket.Dispose();
                VisualBridgeDebugBridge.Uninstall();
            }
        }

        private static VisualBridgeDebugTransport CreateTransport(FakeWire wire,
            VisualBridgeDebugPayloadFormat format = VisualBridgeDebugPayloadFormat.Json,
            int droppedReportIntervalMs = VisualBridgeDebugTransport.DroppedReportIntervalMs)
        {
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, format,
                droppedReportIntervalMs: droppedReportIntervalMs);
            transport.Bind(wire);
            return transport;
        }

        /// <summary>
        /// 查询往返的公共接线（E6）：真实 transport + 与线格式一致的编码器 + 一个等价于生成 Dispatcher
        /// 的处理器（同一签名，同样用 7 参句柄携带归属），并创建一个已绑定的实例。
        /// </summary>
        private static void ConfigureQueryRoundTrip(VisualBridgeDebugTransport transport, bool binary = false)
        {
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(binary
                ? new VisualBridgeDebugBinaryEncoder()
                : new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId,
                new VisualBridgeDebugRequestDispatcher(DispatchIsVisible),
                new VisualBridgeDebugRequestParameterDecoder(DecodeIsVisible));
            Assert.IsTrue(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty));
        }

        private static bool DispatchIsVisible(ushort methodId, string instanceId, ushort instanceSlot,
            uint requestSeq, object[] parameters)
        {
            if (methodId != MethodId || parameters == null || parameters.Length != 1)
            {
                return false;
            }

            var request = new VisualBridgeDebugRequest(instanceId, instanceSlot, methodId, requestSeq,
                Category, InterfaceId, "IsVisible");
            if (!VisualBridgeDebug.StartResult(request))
            {
                return false;
            }

            VisualBridgeDebug.PushParam("visible", 1, (int)parameters[0] > 0);
            return VisualBridgeDebug.End();
        }

        private static bool DecodeIsVisible(ushort methodId, out string[] names, out ushort[] tags, out Type[] types)
        {
            if (methodId != MethodId)
            {
                names = null;
                tags = null;
                types = null;
                return false;
            }

            names = new[] { "nodeId" };
            tags = new[] { (ushort)1 };
            types = new[] { typeof(int) };
            return true;
        }

        [Test]
        public void QueryFailureResponseMatchesJsonFixture()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);

            transport.SendQueryError(12u, "runtime.queryBusy", "queue full");

            Assert.AreEqual(1, wire.Controls.Count);
            Assert.AreEqual("{\"type\":\"response\",\"requestId\":\"req-12\",\"ok\":false,"
                + "\"code\":\"runtime.queryBusy\",\"detail\":\"queue full\"}", Text(wire.Controls[0]));
        }

        [Test]
        public void BusinessRejectionMatchesJsonFixtureWithQueryRejectedCode()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);

            // 业务拒绝的公开码（附录 A.6，E6 登记）：code 恒 runtime.queryRejected，原因在 detail。
            transport.SendReject(12u, "handler-returned-false");

            Assert.AreEqual(1, wire.Controls.Count);
            Assert.AreEqual("{\"type\":\"response\",\"requestId\":\"req-12\",\"ok\":false,"
                + "\"code\":\"runtime.queryRejected\",\"detail\":\"handler-returned-false\"}",
                Text(wire.Controls[0]));
        }

        [Test]
        public void DebugFrameAndEventMessagesReachTheWireUnchanged()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            var encoder = new VisualBridgeDebugJsonEncoder();
            encoder.Begin(VisualBridgeDebugMessageKind.Debug, InstanceId, Category, InterfaceId, MethodName,
                MethodId, InstanceSlot, 0u);
            encoder.PushParam("hp", 1, 5);
            transport.SendControl(FrameMessage(7));
            transport.SendEvent(InstanceSlot, MethodId, Category, InterfaceId, MethodName, 7, encoder.End());

            Assert.AreEqual("{\"type\":\"debugFrame\",\"frame\":7}", Text(wire.Controls[1]));
            Assert.AreEqual(1, wire.Datas.Count);
            Assert.AreEqual("{\"type\":\"debug\",\"category\":\"graph\",\"instance\":\"hero\","
                + "\"iface\":\"IGraphDebuger\",\"method\":\"NodeStart\",\"args\":[{\"tag\":1,\"name\":\"hp\","
                + "\"type\":\"int\",\"value\":5}]}", Text(wire.Datas[0]));
        }

        [Test]
        public void DebugResultBinaryMatchesFixture()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, VisualBridgeDebugPayloadFormat.Binary);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            var encoder = new VisualBridgeDebugBinaryEncoder();
            encoder.Begin(VisualBridgeDebugMessageKind.DebugResult, InstanceId, Category, InterfaceId, MethodName,
                MethodId, InstanceSlot, 12u);
            encoder.PushParam("hp", 1, 5);
            transport.SendResult(12u, encoder.End());

            // u16 methodId=10 + u16 slot=1 + u32 requestId=12 + 参数区（tag1 int 5）
            Assert.AreEqual("000a0001" + "0000000c" + "0001" + "02" + "00000005", Hex(wire.Datas[0]));
        }

        // ---------- 筛选 ----------

        [Test]
        public void MissingOrEmptyFilterMeansEverything()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            transport.SetFilter(null, null);
            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            transport.SetFilter(Array.Empty<string>(), Array.Empty<string>());
            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            Assert.AreEqual(0, transport.GetDroppedSnapshot().FilteredByServer);
        }

        [Test]
        public void CategoryAndInstanceFiltersCombineWithAnd()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            transport.SendCreate("boss", Category, "B", string.Empty, 2);

            transport.SetFilter(new[] { Category }, new[] { "boss" });

            Assert.IsFalse(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            Assert.IsTrue(transport.TryAdmitEvent(2, "boss", Category, MethodId));
            Assert.AreEqual(1, transport.GetDroppedSnapshot().FilteredByServer);

            transport.SetFilter(new[] { "visualbridge.entity" }, null);
            Assert.IsFalse(transport.TryAdmitEvent(2, "boss", Category, MethodId));
            Assert.AreEqual(2, transport.GetDroppedSnapshot().FilteredByServer);
        }

        [Test]
        public void FilteredEventIsNotEncodedAndNotQueued()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            var encoder = new CountingEncoder();
            VisualBridgeDebug.SetFrame(7);
            transport.Bind(wire);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(encoder);
            transport.SetFilter(new[] { "visualbridge.entity" }, null);

            Assert.IsTrue(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty));
            int creates = CountControls(wire, "{\"type\":\"debugCreate\"");
            Assert.IsFalse(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName));
            VisualBridgeDebug.PushParam("hp", 1, 5);
            Assert.IsFalse(VisualBridgeDebug.End());

            // 未编码（Begin 未被调用）、未入队（无数据消息），只累加 filteredByServer。
            Assert.AreEqual(0, encoder.BeginCalls);
            Assert.AreEqual(0, wire.Datas.Count);
            Assert.AreEqual(creates, CountControls(wire, "{\"type\":\"debugCreate\""));
            Assert.AreEqual(1, transport.GetDroppedSnapshot().FilteredByServer);
        }

        [Test]
        public void DebugFrameIsNotFilteredAndEmptyFrameProducesNoFrameMessage()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            VisualBridgeDebug.SetFrame(7);
            transport.Bind(wire);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.SetFrame(7);

            Assert.IsTrue(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty));
            transport.SetFilter(new[] { "visualbridge.entity" }, null);
            Assert.IsFalse(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName));

            // 连接建立时的当前帧恰好一条；筛选掉的事件不产生 debugFrame（空帧不发）。
            Assert.AreEqual(1, CountControls(wire, "{\"type\":\"debugFrame\""));
            Assert.AreEqual(7, FrameFrom(wire));

            transport.SetFilter(null, null);
            Assert.IsTrue(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName));
            VisualBridgeDebug.PushParam("hp", 1, 5);
            Assert.IsTrue(VisualBridgeDebug.End());
            // 同一帧的后续数据不重发 debugFrame。
            Assert.AreEqual(1, CountControls(wire, "{\"type\":\"debugFrame\""));
            Assert.AreEqual(1, wire.Datas.Count);
        }

        // ---------- 未知方法 / 未知槽位 ----------

        [Test]
        public void UnknownSlotIsDroppedAndCountedWithoutThrowing()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            var encoder = new VisualBridgeDebugJsonEncoder();
            encoder.Begin(VisualBridgeDebugMessageKind.Debug, InstanceId, Category, InterfaceId, MethodName,
                MethodId, 99, 0u);
            encoder.PushParam("hp", 1, 5);

            Assert.DoesNotThrow(() => transport.SendEvent(99, MethodId, Category, InterfaceId, MethodName, 7,
                encoder.End()));
            Assert.AreEqual(0, wire.Datas.Count);
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownSlot);
            Assert.IsTrue(wire.IsOpen);
        }

        [Test]
        public void ReservedMethodIdIsDroppedAndCounted()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            var encoder = new VisualBridgeDebugJsonEncoder();
            encoder.Begin(VisualBridgeDebugMessageKind.Debug, InstanceId, Category, InterfaceId, MethodName, 5,
                InstanceSlot, 0u);
            encoder.PushParam("hp", 1, 5);

            transport.SendEvent(InstanceSlot, 5, Category, InterfaceId, MethodName, 7, encoder.End());

            Assert.AreEqual(0, wire.Datas.Count);
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownMethod);
        }

        [Test]
        public void InboundBinaryFrameIsCountedInsteadOfDisconnecting()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            // 通道 1 的入站只有 JSON request：二进制按槽位/方法号归类后丢弃。
            wire.RaiseFrameReceived(VisualBridgePayloadKind.Binary, new byte[] { 0x00, 0x0a, 0x00, 0x63 });
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownSlot);
            wire.RaiseFrameReceived(VisualBridgePayloadKind.Binary, new byte[] { 0x00, 0x05, 0x00, 0x01 });
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownMethod);
            wire.RaiseFrameReceived(VisualBridgePayloadKind.Binary, new byte[] { 0x01 });
            Assert.AreEqual(1, transport.GetDroppedSnapshot().InvalidRequest);
            Assert.IsTrue(wire.IsOpen);
        }

        [Test]
        public void InboundRequestIsParsedIntoAQueryRequest()
        {
            byte[] payload = Encoding.UTF8.GetBytes("{\"type\":\"request\",\"requestId\":\"req-12\","
                + "\"action\":\"debugQuery\",\"category\":\"graph\",\"instance\":\"hero\","
                + "\"iface\":\"IGraphDebuger\",\"method\":\"Query\",\"methodId\":10,"
                + "\"args\":[{\"tag\":1,\"name\":\"hp\","
                + "\"type\":\"int\",\"value\":5},{\"tag\":2,\"name\":\"mode\",\"type\":\"enum\","
                + "\"value\":\"Fast\"},{\"tag\":3,\"name\":\"blob\",\"type\":\"byte[]\",\"value\":\"AQID\"}]}");

            Assert.IsTrue(VisualBridgeDebugRequestReader.TryRead(payload, out var request, out string error), error);
            Assert.AreEqual(12u, request.RequestSeq);
            Assert.AreEqual("graph", request.Category);
            Assert.AreEqual("hero", request.InstanceId);
            Assert.AreEqual("IGraphDebuger", request.InterfaceId);
            Assert.AreEqual("Query", request.Method);
            Assert.AreEqual((ushort)10, request.MethodId, "JSON 信封的 methodId 必须落到请求上（E6 的分发依据）");
            Assert.AreEqual(3, request.Arguments.Count);
            Assert.AreEqual(5, request.Arguments[0].Value);
            Assert.AreEqual("Fast", request.Arguments[1].Value);
            Assert.AreEqual(new byte[] { 1, 2, 3 }, request.Arguments[2].Value);

            // 键序也是协议的一部分：TS 侧用同一个字面量比对 `encodeDebugRequest` 的字节（唯一的生产路径），
            // C# 侧只解析、不生产，所以这里显式锁一次顺序，防止有人手改 fixture 时静默漂移。
            AssertKeyOrder(Encoding.UTF8.GetString(payload),
                "\"type\":\"request\"", "\"requestId\":\"req-12\"", "\"action\":\"debugQuery\"",
                "\"category\":\"graph\"", "\"instance\":\"hero\"", "\"iface\":\"IGraphDebuger\"",
                "\"method\":\"Query\"", "\"methodId\":10", "\"args\":[");
        }

        /// <summary>断言这些片段在文本里按给定顺序出现（信封键序的显式守卫）。</summary>
        private static void AssertKeyOrder(string text, params string[] fragments)
        {
            int offset = 0;
            foreach (var fragment in fragments)
            {
                int index = text.IndexOf(fragment, offset, StringComparison.Ordinal);
                Assert.GreaterOrEqual(index, offset, "信封键序漂移：" + fragment + " 不在预期位置（" + text + "）");
                offset = index + fragment.Length;
            }
        }

        [Test]
        public void JsonRequestRoundTripsToAJsonDebugResult()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            ConfigureQueryRoundTrip(transport);

            wire.RaiseFrameReceived(VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes(RequestJsonFixture));
            Assert.AreEqual(1, VisualBridgeDebugQueryRuntime.Pump(), "JSON request 必须真的分发到业务实现");

            Assert.AreEqual(1, wire.Datas.Count);
            Assert.AreEqual(
                "{\"type\":\"debugResult\",\"category\":\"graph\",\"instance\":\"hero\","
                + "\"iface\":\"IGraphDebuger\",\"method\":\"IsVisible\",\"requestId\":\"req-12\","
                + "\"args\":[{\"tag\":1,\"name\":\"visible\",\"type\":\"bool\",\"value\":true}]}",
                Text(wire.Datas[0]));
        }

        [Test]
        public void JsonRequestRoundTripsToABinaryDebugResultWithTheSameRequestNumber()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, VisualBridgeDebugPayloadFormat.Binary, droppedReportIntervalMs: 0);
            ConfigureQueryRoundTrip(transport, binary: true);

            wire.RaiseFrameReceived(VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes(RequestJsonFixture));
            Assert.AreEqual(1, VisualBridgeDebugQueryRuntime.Pump());

            // 同一请求号的两侧映射：JSON 是 "req-12"，二进制是载荷头之后的 u32 0x0000000c。
            Assert.AreEqual(1, wire.Datas.Count);
            Assert.AreEqual("000a0001" + "0000000c" + "0001" + "01" + "01", Hex(wire.Datas[0]));
        }

        [Test]
        public void NonIntegerArgumentTagIsRejectedWithoutDisconnecting()
        {
            byte[] payload = Encoding.UTF8.GetBytes("{\"type\":\"request\",\"requestId\":\"req-12\","
                + "\"action\":\"debugQuery\",\"category\":\"graph\",\"instance\":\"hero\","
                + "\"iface\":\"IGraphDebuger\",\"method\":\"Query\",\"methodId\":12,"
                + "\"args\":[{\"tag\":1.5,\"name\":\"hp\",\"type\":\"int\",\"value\":5}]}");

            // A.5 的 tag 是 u16：1.5 不能被静默截断成 1。
            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(payload, out _, out string error));
            Assert.AreEqual("arg-tag-out-of-range", error);

            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            wire.RaiseFrameReceived(VisualBridgePayloadKind.Json, payload);

            // 只累加 invalidRequest 这一项，连接不断。
            var snapshot = transport.GetDroppedSnapshot();
            Assert.AreEqual(1, snapshot.InvalidRequest);
            Assert.AreEqual(0, snapshot.FilteredByServer);
            Assert.AreEqual(0, snapshot.UnknownMethod);
            Assert.AreEqual(0, snapshot.UnknownSlot);
            Assert.AreEqual(0, snapshot.EncodeFailed);
            Assert.AreEqual(0, snapshot.Oversize);
            Assert.AreEqual(0, snapshot.QueueOverflow);
            Assert.IsTrue(wire.IsOpen);
        }

        [Test]
        public void InvalidRequestPayloadsAreRejectedWithReasons()
        {
            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(Encoding.UTF8.GetBytes("{"), out _, out string error));
            StringAssert.StartsWith("invalid-json", error);

            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(
                Encoding.UTF8.GetBytes("{\"type\":\"debug\",\"instance\":\"hero\"}"), out _, out error));
            Assert.AreEqual("not-a-request", error);

            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(
                Encoding.UTF8.GetBytes("{\"type\":\"request\",\"requestId\":\"x\",\"action\":\"debugQuery\","
                    + "\"instance\":\"hero\"}"), out _, out error));
            Assert.AreEqual("invalid-request-id", error);

            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(
                Encoding.UTF8.GetBytes("{\"type\":\"request\",\"requestId\":\"req-1\",\"action\":\"debugQuery\"}"),
                out _, out error));
            Assert.AreEqual("missing-instance", error);

            // E6：JSON 信封必须带 u16 方法号（A.5），否则服务端无从分发。
            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(
                Encoding.UTF8.GetBytes("{\"type\":\"request\",\"requestId\":\"req-1\",\"action\":\"debugQuery\","
                    + "\"instance\":\"hero\"}"), out _, out error));
            Assert.AreEqual("missing-method-id", error);

            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(
                Encoding.UTF8.GetBytes("{\"type\":\"request\",\"requestId\":\"req-1\",\"action\":\"debugQuery\","
                    + "\"instance\":\"hero\",\"methodId\":1}"), out _, out error));
            Assert.AreEqual("invalid-method-id", error, "1/2 是 Create/Finish，3–9 预留，都不是分类方法号");

            Assert.IsFalse(VisualBridgeDebugRequestReader.TryRead(
                Encoding.UTF8.GetBytes("{\"type\":\"request\",\"requestId\":\"req-1\",\"action\":\"debugQuery\","
                    + "\"instance\":\"hero\",\"methodId\":10.5}"), out _, out error));
            Assert.AreEqual("invalid-method-id", error, "methodId 是 u16，不得静默截断小数");
        }

        // ---------- dropped 聚合 ----------

        [Test]
        public void DroppedIsCumulativeAndSkipsUnchangedSnapshots()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            transport.SetFilter(new[] { "visualbridge.entity" }, null);

            transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId);
            int first = CountControls(wire, "{\"type\":\"dropped\"");
            Assert.AreEqual(1, first);

            transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId);
            Assert.AreEqual(2, CountControls(wire, "{\"type\":\"dropped\""));

            // 计数无变化时不重复上报。
            transport.FlushDropped();
            Assert.AreEqual(2, CountControls(wire, "{\"type\":\"dropped\""));
            StringAssert.Contains("\"filteredByServer\":2", FindLastControl(wire, "{\"type\":\"dropped\""));
        }

        [Test]
        public void DroppedIsThrottledToProtectTheControlQueue()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 100);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            transport.SetFilter(new[] { "visualbridge.entity" }, null);

            // 第一次丢弃触发上报并开启节流窗口，之后的增量必须被压住。
            transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId);
            Assert.AreEqual(1, CountControls(wire, "{\"type\":\"dropped\""));
            for (int index = 0; index < 9; index++)
            {
                transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId);
            }

            // 节流窗口内的 9 次丢弃不打爆控制队列（一条 dropped 都不多发）。
            Assert.AreEqual(1, CountControls(wire, "{\"type\":\"dropped\""));
            System.Threading.Thread.Sleep(150);
            wire.RaiseTick();
            Assert.AreEqual(2, CountControls(wire, "{\"type\":\"dropped\""));
            StringAssert.Contains("\"filteredByServer\":10", FindLastControl(wire, "{\"type\":\"dropped\""));

            // 计数无变化时下一次节拍不重发：先睡过 100 ms 节流窗口，确保断言打到快照比较而不是节流。
            System.Threading.Thread.Sleep(150);
            wire.RaiseTick();
            Assert.AreEqual(2, CountControls(wire, "{\"type\":\"dropped\""));
        }

        [Test]
        public void OversizeMessageIsRejectedAndCounted()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            var payload = new byte[VisualBridgeDebugPayloadLimits.MaxMessageBytes + 1];
            var message = new VisualBridgeDebugEncodedMessage(VisualBridgeDebugPayloadFormat.Json,
                VisualBridgeDebugTargetQueue.Data, payload);

            transport.SendEvent(InstanceSlot, MethodId, Category, InterfaceId, MethodName, 7, message);

            Assert.AreEqual(0, wire.Datas.Count);
            var snapshot = transport.GetDroppedSnapshot();
            Assert.AreEqual(1, snapshot.EncodeFailed);
            Assert.AreEqual(1, snapshot.Oversize);
        }

        [Test]
        public void BindingANewConnectionStartsFreshButUnbindingRestoresThePreviousConnection()
        {
            var wire = new FakeWire();
            var transport = CreateTransport(wire, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            transport.TryAdmitEvent(99, InstanceId, Category, MethodId);
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownSlot);

            var next = new FakeWire();
            transport.Bind(next);

            // 新连接：槽位映射作废（属上一条连接），计数从零开始。
            Assert.AreEqual(0, transport.GetDroppedSnapshot().UnknownSlot);
            Assert.IsFalse(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownSlot);

            // E10 栈语义：临时连接断开后回到上一条**仍然存活**的连接，而不是整体断连。
            next.RaiseClosed();
            Assert.IsTrue(transport.IsConnected);
            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            Assert.AreEqual(1, transport.GetDroppedSnapshot().UnknownSlot, "计数随绑定存档一起恢复");
        }

        /// <summary>
        /// E10 P1 的验收用例：A 绑定 → B 绑定 → B 解绑 ⇒ A 重新收到帧（并且状态是 A 自己的）。
        /// 红态：旧实现（最后一次绑定者胜出，B 断开即 Unbind）下 A 永远不会再收到消息，
        /// 且 `IsConnected` 变 false、槽位表为空。
        /// </summary>
        [Test]
        public void ABindThenBBindThenBUnbindRestoresAForFramesAndSlots()
        {
            var a = new FakeWire { Generation = 5L };
            var transport = CreateTransport(a, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            int aBefore = a.Controls.Count;
            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));

            var b = new FakeWire { Generation = 9L };
            transport.Bind(b);
            Assert.AreEqual(5L, transport.ConnectionGeneration, "代次锚定会话所属者：临时连接压栈不改变会话代次");
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            Assert.AreEqual(1, b.Controls.Count, "活动连接是 B：消息只走 B");
            Assert.AreEqual(aBefore, a.Controls.Count, "被压栈的 A 不再收到消息");

            b.RaiseClosed();

            Assert.IsTrue(transport.IsConnected, "B 断开后 A 仍然可用");
            Assert.AreEqual(5L, transport.ConnectionGeneration, "回到 A 的代次");
            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId),
                "A 的槽位表随绑定存档恢复");
            transport.SendCreate(InstanceId, Category, "R", string.Empty, (ushort)(InstanceSlot + 1));
            Assert.AreEqual(aBefore + 1, a.Controls.Count, "A 重新收到控制消息（帧/描述）");
            Assert.AreEqual(1, b.Controls.Count, "B 已断开，不再收消息");
        }

        /// <summary>
        /// A 绑定 → B 绑定 → A 断开（仍被压栈）→ B 断开：栈里没有存活连接，整体断连并清空状态。
        /// 红态：旧实现在 B 断开时同样 Unbind，因此这条只保护"出栈时跳过死连接"的分支。
        /// </summary>
        [Test]
        public void UnbindingSkipsDeadConnectionsAndResetsWhenNoneAreAlive()
        {
            var a = new FakeWire();
            var transport = CreateTransport(a, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            var b = new FakeWire();
            transport.Bind(b);
            a.RaiseClosed();
            Assert.IsTrue(transport.IsConnected, "A 已断开但 B 仍活动");

            b.RaiseClosed();
            Assert.IsFalse(transport.IsConnected);
            Assert.AreEqual(0L, transport.ConnectionGeneration);
            Assert.IsFalse(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
        }

        /// <summary>
        /// 被压栈的 wire 不能把入站帧/节拍带进活动连接（E10 源校验）：退订与回调存在竞争，
        /// 被压栈连接在途的一次回调仍可能落到传输层，必须整帧丢弃（不进解析、不回包）；
        /// 它的节拍也不能刷新活动连接的 dropped 上报。
        /// 红态（去掉 <c>OnFrameReceived</c>/<c>OnWireTick</c> 的源校验）：下面的断言会看到非法请求计数或多余控制帧。
        /// </summary>
        [Test]
        public void ABuriedWireCannotInjectInboundFramesOrTicks()
        {
            var a = new FakeWire();
            var transport = CreateTransport(a, droppedReportIntervalMs: 0);
            // 退订前抓一份订阅者快照：模拟"退订之后仍有一次在途回调"（真实 socket 读线程会这样竞争）。
            a.CaptureSubscribers();
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);

            var b = new FakeWire();
            transport.Bind(b);
            int aControls = a.Controls.Count;
            int bControls = b.Controls.Count;

            // 入站帧：被压栈的 A 的在途回调必须整帧丢弃（不进解析、不计数、不回包）。
            a.RaiseStaleFrame(VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes("{not json"));
            Assert.AreEqual(0, transport.GetDroppedSnapshot().InvalidRequest,
                "被压栈连接的入站帧必须被丢弃，不能进入解析");
            Assert.AreEqual(bControls, b.Controls.Count, "丢弃入站帧也不能给活动连接回包");
            Assert.AreEqual(aControls, a.Controls.Count, "被压栈连接不会收到任何回包");

            // 节拍：A 的在途 tick 不能触发活动连接 B 的 dropped 上报（用 B 自己的 overflow 计数制造快照变化）。
            b.OverflowDroppedMessages = 5;
            a.RaiseStaleTick();
            Assert.AreEqual(bControls, b.Controls.Count, "被压栈连接的节拍不能刷新活动连接的上报");
            b.RaiseTick();
            Assert.AreEqual(bControls + 1, b.Controls.Count, "活动连接的节拍照常上报");
            StringAssert.Contains("\"queueOverflow\":5", Text(b.Controls[b.Controls.Count - 1]));

            // 同样的入站帧经活动连接进来才算数：证明上面的 0 是"被源校验挡住"，不是路径没接上。
            b.RaiseFrameReceived(VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes("{not json"));
            Assert.AreEqual(1, transport.GetDroppedSnapshot().InvalidRequest);
        }

        /// <summary>
        /// 同一条活动 wire 重复 <c>Bind</c> 必须幂等（E10）：不清槽位、不重复订阅事件。
        /// 红态（把幂等判断去掉）：重复订阅会让一次 tick 发两条 dropped 上报。
        /// </summary>
        [Test]
        public void RebindingTheActiveWireIsIdempotent()
        {
            var a = new FakeWire();
            var transport = CreateTransport(a, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId));
            int controlsBefore = a.Controls.Count;

            transport.Bind(a);

            Assert.IsTrue(transport.IsConnected);
            Assert.AreEqual(1L, transport.ConnectionGeneration);
            Assert.IsTrue(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId),
                "重复 Bind 不能清掉活动连接的槽位表");
            Assert.AreEqual(controlsBefore, a.Controls.Count, "准入帧不发控制消息");
            Assert.AreEqual(0, transport.GetDroppedSnapshot().UnknownSlot);

            // 一次 tick 只允许一条 dropped 上报：重复订阅会发两条。
            a.OverflowDroppedMessages = 3;
            a.RaiseTick();
            Assert.AreEqual(controlsBefore + 1, a.Controls.Count, "重复 Bind 会让 tick 处理器挂两次");
            StringAssert.Contains("\"queueOverflow\":3", Text(a.Controls[a.Controls.Count - 1]));
        }

        /// <summary>
        /// 显式 <c>Unbind()</c> 必须清空**整栈**（E10）：槽位/计数/代次归零，所有 wire 摘掉且不再被恢复。
        /// 红态（只弹栈顶）：B 断开后 A 会被恢复，<c>IsConnected</c> 与槽位断言失败。
        /// </summary>
        [Test]
        public void ExplicitUnbindClearsTheWholeStack()
        {
            var a = new FakeWire();
            var transport = CreateTransport(a, droppedReportIntervalMs: 0);
            transport.SendCreate(InstanceId, Category, "R", string.Empty, InstanceSlot);
            var b = new FakeWire();
            var c = new FakeWire();
            transport.Bind(b);
            transport.Bind(c);
            int aControls = a.Controls.Count;
            int bControls = b.Controls.Count;
            int cControls = c.Controls.Count;

            transport.Unbind();

            Assert.IsFalse(transport.IsConnected);
            Assert.AreEqual(0L, transport.ConnectionGeneration);
            Assert.IsFalse(transport.TryAdmitEvent(InstanceSlot, InstanceId, Category, MethodId),
                "Unbind 必须清空槽位表");
            Assert.IsFalse(transport.SendCreate(InstanceId, Category, "R", string.Empty, (ushort)(InstanceSlot + 1)),
                "Unbind 之后没有可写连接");

            // 三条连接都摘掉了：再关闭它们不会恢复任何状态，也不会重复结算。
            a.RaiseClosed();
            b.RaiseClosed();
            c.RaiseClosed();
            Assert.IsFalse(transport.IsConnected);
            Assert.AreEqual(aControls, a.Controls.Count);
            Assert.AreEqual(bControls, b.Controls.Count);
            Assert.AreEqual(cControls, c.Controls.Count);
        }

        /// <summary>
        /// 先连者（会话所属者）断开不能改变会话代次（E10）。若代次切到后连者，下一次
        /// <c>RefreshConnectionLocked</c> 会把仍连着的面板当成「没观察到断连的重连」→ 整个会话被重置
        /// （面板连着却看不到任何实例）——与 P0 是同一个用户可见症状，只是触发顺序相反。
        /// 退订竞争窗口：<c>Bind</c> 先加栈、后 <c>Unsubscribe</c>，先连者的读线程可能在这条缝里送来
        /// <c>Closed</c>；用例重放那次在途回调来稳定复现（不依赖"事件不再触发"）。
        /// 红态（代次锚定当前栈底）：栈底换成 B，代次 5→9，<c>Finish</c> 因会话被重置而失败。
        /// </summary>
        [Test]
        public void ClosingTheOwnerConnectionKeepsTheGenerationAndTheSessionUsable()
        {
            var a = new FakeWire { Generation = 5L };
            var transport = CreateTransport(a, droppedReportIntervalMs: 0);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            Assert.IsTrue(VisualBridgeDebug.Create("owner-gen-a", Category, "R", string.Empty));
            a.CaptureSubscribers();

            var b = new FakeWire { Generation = 9L };
            transport.Bind(b);
            VisualBridgeDebugBridge.Attach();
            int bControls = b.Controls.Count;

            // 先连者断开：B 仍在、仍是活动连接。
            a.RaiseStaleClosed();

            Assert.IsTrue(transport.IsConnected, "B 仍在，传输层必须仍然连接");
            var generationAfter = transport.ConnectionGeneration;
            var attachedAfter = VisualBridgeDebugSession.IsAttachedAndConnected;
            var ownerInstanceSurvived = VisualBridgeDebug.Finish("owner-gen-a");
            Assert.IsTrue(generationAfter == 5L && attachedAfter && ownerInstanceSurvived,
                $"先连者断开后：generation={generationAfter}（期望 5）、attached={attachedAfter}（期望 True）、"
                + $"会话实例仍在={ownerInstanceSurvived}（期望 True）—— 代次若换给后连者，"
                + "会话层会把面板当成新会话并重置整个实例表（面板连着却看不到数据）");
            Assert.IsTrue(VisualBridgeDebug.Create("owner-gen-b", Category, "R", string.Empty));
            Assert.Greater(b.Controls.Count, bControls, "B 必须继续收到新消息");
        }

        private static VisualBridgeDebugEncodedMessage FrameMessage(long frame)
        {
            return new VisualBridgeDebugEncodedMessage(VisualBridgeDebugPayloadFormat.Json,
                VisualBridgeDebugTargetQueue.Control,
                Encoding.UTF8.GetBytes("{\"type\":\"debugFrame\",\"frame\":"
                    + frame.ToString(CultureInfo.InvariantCulture) + "}"));
        }

        private static string Text(byte[] payload)
        {
            return Encoding.UTF8.GetString(payload);
        }

        private static string Hex(byte[] payload)
        {
            var builder = new StringBuilder(payload.Length * 2);
            foreach (var value in payload)
            {
                builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            }

            return builder.ToString();
        }

        private static int CountControls(FakeWire wire, string prefix)
        {
            int count = 0;
            foreach (var payload in wire.Controls)
            {
                if (Text(payload).StartsWith(prefix, StringComparison.Ordinal))
                {
                    count++;
                }
            }

            return count;
        }

        private static string FindLastControl(FakeWire wire, string prefix)
        {
            for (int index = wire.Controls.Count - 1; index >= 0; index--)
            {
                var text = Text(wire.Controls[index]);
                if (text.StartsWith(prefix, StringComparison.Ordinal))
                {
                    return text;
                }
            }

            return null;
        }

        private static long FrameFrom(FakeWire wire)
        {
            var text = FindLastControl(wire, "{\"type\":\"debugFrame\"");
            Assert.IsNotNull(text);
            int start = text.IndexOf("\"frame\":", StringComparison.Ordinal) + "\"frame\":".Length;
            return long.Parse(text.Substring(start, text.Length - start - 1), CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// 真实 socket 用例的环回流：写入按 <c>writeDelayMs</c> 变慢（模拟慢写/背压），读端阻塞到测试收尾
        /// （返回 0 会被连接层当成帧边界处关闭）。捕获的字节由 <see cref="ReadFrames"/> 逐帧解出。
        /// </summary>
        private sealed class CaptureStream : Stream
        {
            private readonly MemoryStream captured = new MemoryStream();
            private readonly object captureGate = new object();
            private readonly int writeDelayMs;
            private readonly ManualResetEventSlim finished = new ManualResetEventSlim(false);

            public CaptureStream(int writeDelayMs)
            {
                this.writeDelayMs = writeDelayMs;
            }

            public override bool CanRead => true;

            public override bool CanSeek => false;

            public override bool CanWrite => true;

            public override long Length => 0L;

            public override long Position
            {
                get => 0L;
                set { }
            }

            public override void Write(byte[] buffer, int offset, int count)
            {
                if (writeDelayMs > 0)
                {
                    System.Threading.Thread.Sleep(writeDelayMs);
                }

                lock (captureGate)
                {
                    captured.Write(buffer, offset, count);
                }
            }

            public override int Read(byte[] buffer, int offset, int count)
            {
                while (!finished.IsSet)
                {
                    System.Threading.Thread.Sleep(5);
                }

                return 0;
            }

            public byte[] Snapshot()
            {
                lock (captureGate)
                {
                    return captured.ToArray();
                }
            }

            public override void Flush()
            {
            }

            public override long Seek(long offset, SeekOrigin origin)
            {
                return 0L;
            }

            public override void SetLength(long value)
            {
            }

            protected override void Dispose(bool disposing)
            {
                finished.Set();
                base.Dispose(disposing);
            }
        }

        private static List<VisualBridgeFrame> ReadFrames(CaptureStream stream, int count)
        {
            var reader = new VisualBridgeFrameReader();
            var frames = new List<VisualBridgeFrame>();
            int consumed = 0;
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (frames.Count < count && DateTime.UtcNow < deadline)
            {
                var bytes = stream.Snapshot();
                if (bytes.Length > consumed)
                {
                    reader.Append(bytes, consumed, bytes.Length - consumed);
                    consumed = bytes.Length;
                    while (reader.TryReadFrame(out var frame))
                    {
                        frames.Add(frame);
                    }

                    continue;
                }

                System.Threading.Thread.Sleep(10);
            }

            return frames;
        }

        /// <summary>假连接：记录控制/数据消息与格式，可手工触发入站帧、节拍与断开。</summary>
        private sealed class FakeWire : IVisualBridgeDebugWire
        {
            public bool IsOpen { get; private set; } = true;

            public long Generation { get; set; } = 1L;

            public long OverflowDroppedMessages { get; set; }

            public List<byte[]> Controls { get; } = new List<byte[]>();

            public List<VisualBridgeDebugPayloadFormat> ControlFormats { get; } =
                new List<VisualBridgeDebugPayloadFormat>();

            public List<byte[]> Datas { get; } = new List<byte[]>();

            public event Action<VisualBridgePayloadKind, byte[]> FrameReceived;

            public event Action Closed;

            public event Action Tick;

            public bool SendControl(byte[] payload, VisualBridgeDebugPayloadFormat format)
            {
                Controls.Add(payload);
                ControlFormats.Add(format);
                return true;
            }

            public bool SendDebug(byte[] payload, VisualBridgeDebugPayloadFormat format)
            {
                Datas.Add(payload);
                return true;
            }

            public void RaiseFrameReceived(VisualBridgePayloadKind payloadKind, byte[] payload)
            {
                FrameReceived?.Invoke(payloadKind, payload);
            }

            public void RaiseTick()
            {
                Tick?.Invoke();
            }

            public void RaiseClosed()
            {
                IsOpen = false;
                Closed?.Invoke();
            }

            private Action<VisualBridgePayloadKind, byte[]> staleFrameReceived;
            private Action staleTick;
            private Action staleClosed;

            /// <summary>
            /// 抓一份当前订阅者快照：退订只摘委托，真实读线程可能已经把一次回调排在路上。
            /// 用例用它在"被压栈之后"重放这次在途回调，验证传输层的源校验（而不是依赖事件不再触发）。
            /// </summary>
            public void CaptureSubscribers()
            {
                staleFrameReceived = FrameReceived;
                staleTick = Tick;
                staleClosed = Closed;
            }

            public void RaiseStaleFrame(VisualBridgePayloadKind payloadKind, byte[] payload)
            {
                staleFrameReceived?.Invoke(payloadKind, payload);
            }

            public void RaiseStaleTick()
            {
                staleTick?.Invoke();
            }

            /// <summary>重放被压栈连接在途的 Closed（退订竞争窗口）：连接真的断了，但事件已不在订阅表里。</summary>
            public void RaiseStaleClosed()
            {
                IsOpen = false;
                staleClosed?.Invoke();
            }
        }

        /// <summary>计数编码器：只统计 Begin 次数，编码仍交给 JSON 编码器。</summary>
        private sealed class CountingEncoder : IDebugMessageEncoder
        {
            private readonly VisualBridgeDebugJsonEncoder inner = new VisualBridgeDebugJsonEncoder();

            public int BeginCalls { get; private set; }

            public void Begin(VisualBridgeDebugMessageKind kind, string instanceId, string category, string iface,
                string method, ushort methodId, ushort instanceSlot, uint requestId)
            {
                BeginCalls++;
                inner.Begin(kind, instanceId, category, iface, method, methodId, instanceSlot, requestId);
            }

            public void PushParam(string name, ushort tag, object value)
            {
                inner.PushParam(name, tag, value);
            }

            public VisualBridgeDebugEncodedMessage End()
            {
                return inner.End();
            }
        }
    }
}
