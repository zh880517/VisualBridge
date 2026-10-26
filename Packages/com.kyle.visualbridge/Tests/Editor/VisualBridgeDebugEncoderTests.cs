using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// D3 编码器与帧边界用例：九种类型往返、稀疏默认值、收窄值、枚举两种表示、byte[] 原样、
    /// 1 MB 丢弃、debugFrame 只在「变化且发数据」时产生、缺中间 tag 的契约推进读取。
    /// 两种编码器跑同一批语义用例；JSON 只额外断言 name/类型名，二进制只额外断言 tag/类型码。
    /// </summary>
    public sealed class VisualBridgeDebugEncoderTests
    {
        private const string Category = "graph";
        private const string InterfaceId = "IGraphDebuger";
        private const string MethodName = "NodeStart";
        private const ushort MethodId = 10;
        private const ushort InstanceSlot = 1;

        [SetUp]
        public void SetUp()
        {
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null);
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
            VisualBridgeDebugDiagnostics.Reset();
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null);
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
        }

        [Test]
        public void WireTypeCodesMatchAppendixA4()
        {
            // 附录 A.4 的 type 码表是跨语言契约：改动会直接破坏 TS 解码器。
            Assert.That((byte)VisualBridgeDebugWireType.Bool, Is.EqualTo(1));
            Assert.That((byte)VisualBridgeDebugWireType.Int, Is.EqualTo(2));
            Assert.That((byte)VisualBridgeDebugWireType.Long, Is.EqualTo(3));
            Assert.That((byte)VisualBridgeDebugWireType.Ulong, Is.EqualTo(4));
            Assert.That((byte)VisualBridgeDebugWireType.Float, Is.EqualTo(5));
            Assert.That((byte)VisualBridgeDebugWireType.Double, Is.EqualTo(6));
            Assert.That((byte)VisualBridgeDebugWireType.Enum, Is.EqualTo(7));
            Assert.That((byte)VisualBridgeDebugWireType.String, Is.EqualTo(8));
            Assert.That((byte)VisualBridgeDebugWireType.ByteArray, Is.EqualTo(9));
        }

        [Test]
        public void JsonEncoderWritesAllNineTypesWithNameAndWireType()
        {
            var message = EncodeJson(encoder =>
            {
                // 故意乱序压入：编码器必须按 tag 升序输出。
                encoder.PushParam("bytes", 9, new byte[] { 1, 2, 3 });
                encoder.PushParam("text", 8, "文本\u0001\n\"x\"\\😀");
                encoder.PushParam("kind", 7, SampleEnum.Second);
                encoder.PushParam("double", 6, -2.25d);
                encoder.PushParam("float", 5, 1.5f);
                encoder.PushParam("ulong", 4, ulong.MaxValue);
                encoder.PushParam("long", 3, -9007199254740993L);
                encoder.PushParam("int", 2, -7);
                encoder.PushParam("bool", 1, true);
            });

            Assert.That(message.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            Assert.That(message.Format, Is.EqualTo(VisualBridgeDebugPayloadFormat.Json));
            Assert.That(message.TargetQueue, Is.EqualTo(VisualBridgeDebugTargetQueue.Data));

            var json = ParseJson(message);
            Assert.That((string)json["type"], Is.EqualTo("debug"));
            Assert.That((string)json["category"], Is.EqualTo(Category));
            Assert.That((string)json["instance"], Is.EqualTo("inst-1"));
            Assert.That((string)json["iface"], Is.EqualTo(InterfaceId));
            Assert.That((string)json["method"], Is.EqualTo(MethodName));
            Assert.That(json["requestId"], Is.Null);

            var args = (JArray)json["args"];
            Assert.That(args.Count, Is.EqualTo(9));
            for (int index = 0; index < args.Count; index++)
            {
                Assert.That((int)args[index]["tag"], Is.EqualTo(index + 1));
            }

            Assert.That((string)args[0]["name"], Is.EqualTo("bool"));
            Assert.That((string)args[0]["type"], Is.EqualTo("bool"));
            Assert.That((bool)args[0]["value"], Is.True);

            Assert.That((string)args[1]["type"], Is.EqualTo("int"));
            Assert.That((int)args[1]["value"], Is.EqualTo(-7));

            Assert.That((string)args[2]["type"], Is.EqualTo("long"));
            Assert.That(args[2]["value"].Type, Is.EqualTo(JTokenType.String));
            Assert.That((string)args[2]["value"], Is.EqualTo("-9007199254740993"));

            Assert.That((string)args[3]["type"], Is.EqualTo("ulong"));
            Assert.That(args[3]["value"].Type, Is.EqualTo(JTokenType.String));
            Assert.That((string)args[3]["value"], Is.EqualTo("18446744073709551615"));

            Assert.That((string)args[4]["type"], Is.EqualTo("float"));
            Assert.That((double)args[4]["value"], Is.EqualTo(1.5d).Within(0.0001d));

            Assert.That((string)args[5]["type"], Is.EqualTo("double"));
            Assert.That((double)args[5]["value"], Is.EqualTo(-2.25d).Within(0.0001d));

            Assert.That((string)args[6]["type"], Is.EqualTo("enum"));
            Assert.That((string)args[6]["value"], Is.EqualTo("Second"));

            Assert.That((string)args[7]["type"], Is.EqualTo("string"));
            Assert.That((string)args[7]["value"], Is.EqualTo("文本\u0001\n\"x\"\\😀"));

            Assert.That((string)args[8]["type"], Is.EqualTo("byte[]"));
            Assert.That(Convert.FromBase64String((string)args[8]["value"]), Is.EqualTo(new byte[] { 1, 2, 3 }));
        }

        [Test]
        public void BinaryEncoderWritesAllNineTypesWithTagAndTypeCode()
        {
            var message = EncodeBinary(encoder =>
            {
                encoder.PushParam("bytes", 9, new byte[] { 1, 2, 3 });
                encoder.PushParam("text", 8, "文本\u0001\n\"x\"\\😀");
                encoder.PushParam("kind", 7, SampleEnum.Second);
                encoder.PushParam("double", 6, -2.25d);
                encoder.PushParam("float", 5, 1.5f);
                encoder.PushParam("ulong", 4, ulong.MaxValue);
                encoder.PushParam("long", 3, -9007199254740993L);
                encoder.PushParam("int", 2, -7);
                encoder.PushParam("bool", 1, true);
            });

            Assert.That(message.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            Assert.That(message.Format, Is.EqualTo(VisualBridgeDebugPayloadFormat.Binary));
            Assert.That(message.TargetQueue, Is.EqualTo(VisualBridgeDebugTargetQueue.Data));

            var payload = message.Payload.ToArray();
            var parameters = ReadBinary(payload, false, out ushort methodId, out ushort slot, out uint requestId);
            Assert.That(methodId, Is.EqualTo(MethodId));
            Assert.That(slot, Is.EqualTo(InstanceSlot));
            Assert.That(requestId, Is.EqualTo(0u));
            Assert.That(parameters.Count, Is.EqualTo(9));
            for (int index = 0; index < parameters.Count; index++)
            {
                Assert.That(parameters[index].Tag, Is.EqualTo(index + 1));
            }

            Assert.That(parameters[0].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.Bool));
            Assert.That((bool)parameters[0].Value, Is.True);
            Assert.That(parameters[1].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.Int));
            Assert.That((int)parameters[1].Value, Is.EqualTo(-7));
            Assert.That(parameters[2].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.Long));
            Assert.That((long)parameters[2].Value, Is.EqualTo(-9007199254740993L));
            Assert.That(parameters[3].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.Ulong));
            Assert.That((ulong)parameters[3].Value, Is.EqualTo(ulong.MaxValue));
            Assert.That(parameters[4].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.Float));
            Assert.That((float)parameters[4].Value, Is.EqualTo(1.5f));
            Assert.That(parameters[5].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.Double));
            Assert.That((double)parameters[5].Value, Is.EqualTo(-2.25d));
            Assert.That(parameters[6].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.Enum));
            Assert.That((ulong)parameters[6].Value, Is.EqualTo(2UL));
            Assert.That(parameters[7].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.String));
            Assert.That((string)parameters[7].Value, Is.EqualTo("文本\u0001\n\"x\"\\😀"));
            Assert.That(parameters[8].Type, Is.EqualTo((byte)VisualBridgeDebugWireType.ByteArray));
            Assert.That((byte[])parameters[8].Value, Is.EqualTo(new byte[] { 1, 2, 3 }));
        }

        [Test]
        public void BothEncodersProduceTheSameTagSequence()
        {
            void Push(IDebugMessageEncoder encoder)
            {
                encoder.PushParam("third", 3, "c");
                encoder.PushParam("first", 1, 1);
                encoder.PushParam("second", 2, 2.5f);
            }

            var jsonArgs = (JArray)ParseJson(EncodeJson(Push))["args"];
            var binaryParams = ReadBinary(EncodeBinary(Push).Payload.ToArray(), false, out _, out _, out _);

            Assert.That(jsonArgs.Count, Is.EqualTo(binaryParams.Count));
            for (int index = 0; index < jsonArgs.Count; index++)
            {
                Assert.That((int)jsonArgs[index]["tag"], Is.EqualTo(binaryParams[index].Tag));
            }

            // name 只在 JSON 里出现；二进制参数区只有 tag/type/value（附录 A.4）。
            Assert.That((string)jsonArgs[0]["name"], Is.EqualTo("first"));
            Assert.That(binaryParams[0].Tag, Is.EqualTo((ushort)1));
        }

        [Test]
        public void DefaultValuesAreOmittedByBothEncoders()
        {
            void Push(IDebugMessageEncoder encoder)
            {
                encoder.PushParam("b", 1, false);
                encoder.PushParam("i", 2, 0);
                encoder.PushParam("l", 3, 0L);
                encoder.PushParam("ul", 4, 0UL);
                encoder.PushParam("f", 5, 0f);
                encoder.PushParam("d", 6, 0d);
                encoder.PushParam("e", 7, SampleEnum.None);
                encoder.PushParam("s", 8, (string)null);
                encoder.PushParam("s2", 9, string.Empty);
                encoder.PushParam("bytes", 10, (byte[])null);
                encoder.PushParam("bytes2", 11, Array.Empty<byte>());
                encoder.PushParam("kept", 12, 1);
            }

            var json = ParseJson(EncodeJson(Push));
            var jsonArgs = (JArray)json["args"];
            Assert.That(jsonArgs.Count, Is.EqualTo(1));
            Assert.That((int)jsonArgs[0]["tag"], Is.EqualTo(12));
            Assert.That((string)jsonArgs[0]["name"], Is.EqualTo("kept"));

            var binaryParams = ReadBinary(EncodeBinary(Push).Payload.ToArray(), false, out _, out _, out _);
            Assert.That(binaryParams.Count, Is.EqualTo(1));
            Assert.That(binaryParams[0].Tag, Is.EqualTo((ushort)12));
            Assert.That((int)binaryParams[0].Value, Is.EqualTo(1));
        }

        [Test]
        public void NegativeZeroIsWrittenByBothEncoders()
        {
            void Push(IDebugMessageEncoder encoder)
            {
                // +0.0 是默认值，必须不占字节；-0.0 必须按字面量写出。
                encoder.PushParam("fzero", 1, 0.0f);
                encoder.PushParam("dzero", 2, 0.0d);
                encoder.PushParam("fnegative", 3, -0.0f);
                encoder.PushParam("dnegative", 4, -0.0d);
            }

            // Unity 6000.3.10f1 自带 Mono 6.13 的 double/float.Parse 对 "-0.0" 返回 +0（dbits=0），
            // 因此 JObject.Parse 不能作为负零 oracle；取值断言直接看原始 JSON 文本。
            // 线上格式仍按 A.4 写 "-0.0"，不是把编码器改成 0/-0。
            var jsonMessage = EncodeJson(Push);
            Assert.That(jsonMessage.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            string json = ReadRawJson(jsonMessage);
            Assert.That(json, Does.Not.Contain("\"name\":\"fzero\""), "+0.0f 不应出现在线上载荷");
            Assert.That(json, Does.Not.Contain("\"name\":\"dzero\""), "+0.0d 不应出现在线上载荷");
            Assert.That(json, Does.Contain(
                "\"tag\":3,\"name\":\"fnegative\",\"type\":\"float\",\"value\":-0.0"));
            Assert.That(json, Does.Contain(
                "\"tag\":4,\"name\":\"dnegative\",\"type\":\"double\",\"value\":-0.0"));

            // JObject.Parse 只用于结构断言（数量/tag/name/type），不读取负零的数值。
            var args = (JArray)JObject.Parse(json)["args"];
            Assert.That(args.Count, Is.EqualTo(2));
            Assert.That((int)args[0]["tag"], Is.EqualTo(3));
            Assert.That((string)args[0]["name"], Is.EqualTo("fnegative"));
            Assert.That((string)args[0]["type"], Is.EqualTo("float"));
            Assert.That((int)args[1]["tag"], Is.EqualTo(4));
            Assert.That((string)args[1]["name"], Is.EqualTo("dnegative"));
            Assert.That((string)args[1]["type"], Is.EqualTo("double"));

            // 二进制不经过 JSON 解析，仍按 IEEE754 位模式断言符号位；同时验证 +0.0 被跳过。
            var binaryMessage = EncodeBinary(Push);
            Assert.That(binaryMessage.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            var binaryParams = ReadBinary(binaryMessage.Payload.ToArray(), false, out _, out _, out _);
            Assert.That(binaryParams.Count, Is.EqualTo(2));
            Assert.That(binaryParams[0].Tag, Is.EqualTo((ushort)3));
            Assert.That(BitConverter.SingleToInt32Bits((float)binaryParams[0].Value),
                Is.EqualTo(unchecked((int)0x80000000)));
            Assert.That(binaryParams[1].Tag, Is.EqualTo((ushort)4));
            Assert.That(BitConverter.DoubleToInt64Bits((double)binaryParams[1].Value),
                Is.EqualTo(unchecked((long)0x8000000000000000)));
        }

        [Test]
        public void SpecialFloatsUseStringsInJsonAndBitsInBinary()
        {
            void Push(IDebugMessageEncoder encoder)
            {
                encoder.PushParam("nan", 1, float.NaN);
                encoder.PushParam("pos", 2, double.PositiveInfinity);
                encoder.PushParam("neg", 3, float.NegativeInfinity);
            }

            // NaN/±Infinity 在 JSON 里是字符串；取值仍按原始文本断言，结构只用 JObject 查 tag/name/type。
            var jsonMessage = EncodeJson(Push);
            Assert.That(jsonMessage.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            string json = ReadRawJson(jsonMessage);
            Assert.That(json, Does.Contain(
                "\"tag\":1,\"name\":\"nan\",\"type\":\"float\",\"value\":\"NaN\""));
            Assert.That(json, Does.Contain(
                "\"tag\":2,\"name\":\"pos\",\"type\":\"double\",\"value\":\"Infinity\""));
            Assert.That(json, Does.Contain(
                "\"tag\":3,\"name\":\"neg\",\"type\":\"float\",\"value\":\"-Infinity\""));

            var args = (JArray)JObject.Parse(json)["args"];
            Assert.That(args.Count, Is.EqualTo(3));
            Assert.That((int)args[0]["tag"], Is.EqualTo(1));
            Assert.That((string)args[0]["name"], Is.EqualTo("nan"));
            Assert.That((string)args[0]["type"], Is.EqualTo("float"));
            Assert.That((int)args[1]["tag"], Is.EqualTo(2));
            Assert.That((string)args[1]["name"], Is.EqualTo("pos"));
            Assert.That((string)args[1]["type"], Is.EqualTo("double"));
            Assert.That((int)args[2]["tag"], Is.EqualTo(3));
            Assert.That((string)args[2]["name"], Is.EqualTo("neg"));
            Assert.That((string)args[2]["type"], Is.EqualTo("float"));

            var binaryMessage = EncodeBinary(Push);
            Assert.That(binaryMessage.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            var binaryParams = ReadBinary(binaryMessage.Payload.ToArray(), false, out _, out _, out _);
            Assert.That(float.IsNaN((float)binaryParams[0].Value), Is.True);
            Assert.That(double.IsPositiveInfinity((double)binaryParams[1].Value), Is.True);
            Assert.That(float.IsNegativeInfinity((float)binaryParams[2].Value), Is.True);
        }

        [Test]
        public void NarrowedValuesArriveAsLongAndInt()
        {
            // 生成代码把 uint 显式转 long、short 显式转 int（附录 B.2）；编码器只认九种装箱类型。
            var transport = InstallTransport();
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, MethodId, InterfaceId, MethodName), Is.True);

            uint unsigned = uint.MaxValue;
            short signed = short.MinValue;
            VisualBridgeDebug.PushParam("u", 1, (long)unsigned);
            VisualBridgeDebug.PushParam("s", 2, (int)signed);
            Assert.That(VisualBridgeDebug.End(), Is.True);

            var args = (JArray)ParseJson(transport.Events[0].Message)["args"];
            Assert.That((string)args[0]["value"], Is.EqualTo("4294967295"));
            Assert.That((int)args[1]["value"], Is.EqualTo((int)short.MinValue));
        }

        [Test]
        public void EnumUsesNameInJsonAndUnderlyingWidthInBinary()
        {
            void Push(IDebugMessageEncoder encoder)
            {
                encoder.PushParam("signed", 1, NegativeEnum.Minus);
                encoder.PushParam("wide", 2, WideEnum.Big);
            }

            var jsonArgs = (JArray)ParseJson(EncodeJson(Push))["args"];
            Assert.That((string)jsonArgs[0]["value"], Is.EqualTo("Minus"));
            Assert.That((string)jsonArgs[1]["value"], Is.EqualTo("Big"));

            // short 底层：-2 → 0xFFFE（2 字节）；ulong 底层：8 字节大端。
            var payload = EncodeBinary(Push).Payload.ToArray();
            int offset = 4;
            Assert.That(ReadU16(payload, ref offset), Is.EqualTo((ushort)1));
            Assert.That(payload[offset++], Is.EqualTo((byte)VisualBridgeDebugWireType.Enum));
            Assert.That(ReadU16(payload, ref offset), Is.EqualTo((ushort)0xFFFE));
            Assert.That(ReadU16(payload, ref offset), Is.EqualTo((ushort)2));
            Assert.That(payload[offset++], Is.EqualTo((byte)VisualBridgeDebugWireType.Enum));
            Assert.That(ReadU64(payload, ref offset), Is.EqualTo(ulong.MaxValue));
            Assert.That(offset, Is.EqualTo(payload.Length));
        }

        [Test]
        public void ByteArrayIsWrittenVerbatim()
        {
            var bytes = new byte[] { 0, 1, 2, 127, 128, 255 };
            var payload = EncodeBinary(encoder => encoder.PushParam("bytes", 1, bytes)).Payload.ToArray();

            int offset = 4;
            Assert.That(ReadU16(payload, ref offset), Is.EqualTo((ushort)1));
            Assert.That(payload[offset++], Is.EqualTo((byte)VisualBridgeDebugWireType.ByteArray));
            uint length = ReadU32(payload, ref offset);
            Assert.That(length, Is.EqualTo((uint)bytes.Length));
            Assert.That(payload.AsSpan(offset, (int)length).ToArray(), Is.EqualTo(bytes));
            Assert.That(offset + (int)length, Is.EqualTo(payload.Length));
        }

        [Test]
        public void BinaryPayloadStartsWithMethodSlotAndOnlyResultCarriesRequestId()
        {
            var eventPayload = EncodeBinary(_ => { }).Payload.ToArray();
            Assert.That(eventPayload.Length, Is.EqualTo(4));
            int offset = 0;
            Assert.That(ReadU16(eventPayload, ref offset), Is.EqualTo(MethodId));
            Assert.That(ReadU16(eventPayload, ref offset), Is.EqualTo(InstanceSlot));

            var resultPayload = EncodeBinary(_ => { }, VisualBridgeDebugMessageKind.DebugResult, 3u)
                .Payload.ToArray();
            Assert.That(resultPayload.Length, Is.EqualTo(8));
            offset = 0;
            Assert.That(ReadU16(resultPayload, ref offset), Is.EqualTo(MethodId));
            Assert.That(ReadU16(resultPayload, ref offset), Is.EqualTo(InstanceSlot));
            Assert.That(ReadU32(resultPayload, ref offset), Is.EqualTo(3u));
        }

        [Test]
        public void JsonResultOmitsUnknownTargetAndKeepsRequestId()
        {
            var transport = InstallTransport();
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            // 4 参句柄不携带归属（手写处理器路径）：按附录 A.5 省略 iface/method，消费端按 requestId 兜底。
            // 生产路径是生成 Dispatcher 的 7 参句柄（见下一个用例），运行期不再反射补齐归属。
            var request = new VisualBridgeDebugRequest("inst-1", InstanceSlot, MethodId, 3u);
            Assert.That(VisualBridgeDebug.StartResult(request), Is.True);
            VisualBridgeDebug.PushParam("value", 1, 42);
            Assert.That(VisualBridgeDebug.End(), Is.True);

            var json = ParseJson(transport.Results[0].Message);
            Assert.That((string)json["type"], Is.EqualTo("debugResult"));
            // B.6：JSON 的请求号是 "req-<n>" 字符串，不是裸整数。
            Assert.That((string)json["requestId"], Is.EqualTo("req-3"));
            Assert.That((string)json["instance"], Is.EqualTo("inst-1"));
            Assert.That((string)json["category"], Is.EqualTo(Category));
            Assert.That(json["iface"], Is.Null, "归属未知时按 A.5 省略 iface，消费端按 requestId 兜底");
            Assert.That(json["method"], Is.Null, "归属未知时按 A.5 省略 method，消费端按 requestId 兜底");
        }

        [Test]
        public void ExplicitRequestHandleTargetIsUsedByJsonResult()
        {
            var transport = InstallTransport();
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            // D4 的查询运行期可直接用 7 参句柄携带信封里的归属，无需反查。
            var request = new VisualBridgeDebugRequest("inst-1", InstanceSlot, MethodId, 4u,
                "explicit-category", "IExplicitDebuger", "ExplicitMethod");
            Assert.That(VisualBridgeDebug.StartResult(request), Is.True);
            VisualBridgeDebug.PushParam("value", 1, 42);
            Assert.That(VisualBridgeDebug.End(), Is.True);

            var json = ParseJson(transport.Results[0].Message);
            Assert.That((string)json["requestId"], Is.EqualTo("req-4"));
            Assert.That((string)json["category"], Is.EqualTo("explicit-category"));
            Assert.That((string)json["iface"], Is.EqualTo("IExplicitDebuger"));
            Assert.That((string)json["method"], Is.EqualTo("ExplicitMethod"));
        }

        [Test]
        public void BinaryResultCarriesRequestIdInHeader()
        {
            var transport = InstallTransport();
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugBinaryEncoder());
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            var request = new VisualBridgeDebugRequest("inst-1", InstanceSlot, MethodId, 7u);
            Assert.That(VisualBridgeDebug.StartResult(request), Is.True);
            VisualBridgeDebug.PushParam("value", 1, 42);
            Assert.That(VisualBridgeDebug.End(), Is.True);

            var parameters = ReadBinary(transport.Results[0].Message.Payload.ToArray(), true, out ushort methodId,
                out ushort slot, out uint requestId);
            Assert.That(methodId, Is.EqualTo(MethodId));
            Assert.That(slot, Is.EqualTo(InstanceSlot));
            Assert.That(requestId, Is.EqualTo(7u));
            Assert.That(parameters.Count, Is.EqualTo(1));
            Assert.That((int)parameters[0].Value, Is.EqualTo(42));
        }

        [Test]
        public void OversizeMessageIsDroppedCountedAndDoesNotBlockTheNextMessage()
        {
            var transport = InstallTransport();
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugBinaryEncoder());
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            Assert.That(VisualBridgeDebug.Start("inst-1", Category, MethodId, InterfaceId, MethodName), Is.True);
            VisualBridgeDebug.PushParam("big", 1, new byte[VisualBridgeDebugPayloadLimits.MaxMessageBytes + 1]);
            Assert.That(VisualBridgeDebug.End(), Is.False);
            Assert.That(transport.Events.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(1L));
            Assert.That(VisualBridgeDebugSession.DroppedOversizeMessages, Is.EqualTo(1L));
            // E4 的读取入口（VisualBridge.Debug 程序集，编辑器/运行时宿主都可引用）。
            Assert.That(VisualBridgeDebugMetrics.GetSnapshot().DroppedOversizeMessages, Is.EqualTo(1L));
            Assert.That(VisualBridgeDebugBridge.GetDiagnostics().DroppedOversizeMessages, Is.EqualTo(1L));

            // 后续消息不被阻塞。
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, MethodId, InterfaceId, MethodName), Is.True);
            VisualBridgeDebug.PushParam("value", 1, 1);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(transport.Events.Count, Is.EqualTo(1));
            Assert.That(VisualBridgeDebugSession.DroppedOversizeMessages, Is.EqualTo(1L));
        }

        [Test]
        public void OversizeJsonValuesAreDroppedBeforeBase64OrEscapeExpansion()
        {
            // 大 byte[] 不能在丢弃前先转出 base64；超长字符串也不能先扫描/构造转义结果。
            var bytesEncoder = new VisualBridgeDebugJsonEncoder();
            bytesEncoder.Begin(VisualBridgeDebugMessageKind.Debug, "inst-1", Category, InterfaceId, MethodName,
                MethodId, InstanceSlot, 0u);
            bytesEncoder.PushParam("bytes", 1, new byte[VisualBridgeDebugPayloadLimits.MaxMessageBytes + 1]);
            var bytesMessage = bytesEncoder.End();
            Assert.That(bytesMessage.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.TooLarge));
            Assert.That(bytesMessage.Payload.IsEmpty, Is.True);

            var textEncoder = new VisualBridgeDebugJsonEncoder();
            textEncoder.Begin(VisualBridgeDebugMessageKind.Debug, "inst-1", Category, InterfaceId, MethodName,
                MethodId, InstanceSlot, 0u);
            textEncoder.PushParam("text", 1, new string('a', VisualBridgeDebugPayloadLimits.MaxMessageBytes + 1));
            var textMessage = textEncoder.End();
            Assert.That(textMessage.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.TooLarge));
            Assert.That(textMessage.Payload.IsEmpty, Is.True);
        }

        [Test]
        public void BinaryStringLongerThanUshortIsRejectedWhileJsonAcceptsIt()
        {
            string value = new string('a', ushort.MaxValue + 1);

            var binary = EncodeBinary(encoder => encoder.PushParam("text", 1, value));
            Assert.That(binary.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.LengthOverflow));
            Assert.That(binary.Payload.IsEmpty, Is.True);

            var json = EncodeJson(encoder => encoder.PushParam("text", 1, value));
            Assert.That(json.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            Assert.That((string)((JArray)ParseJson(json)["args"])[0]["value"], Is.EqualTo(value));
        }

        [Test]
        public void ExactOneMegabyteBinaryPayloadIsAccepted()
        {
            // 4 字节头 + 3 字节 tag/type + 4 字节长度 + N 字节数据 = 1 MB。
            int byteCount = VisualBridgeDebugPayloadLimits.MaxMessageBytes - 11;
            var message = EncodeBinary(encoder => encoder.PushParam("bytes", 1, new byte[byteCount]));
            Assert.That(message.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.Ok));
            Assert.That(message.Payload.Length, Is.EqualTo(VisualBridgeDebugPayloadLimits.MaxMessageBytes));

            var overflow = EncodeBinary(encoder => encoder.PushParam("bytes", 1, new byte[byteCount + 1]));
            Assert.That(overflow.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.TooLarge));
        }

        [Test]
        public void EncoderRejectsRuntimeTypesOutsideTheNineDeclaredTypes()
        {
            // uint/short 必须在生成代码里先转成 long/int；编码器不做 object 数值转换。
            var json = EncodeJson(encoder =>
            {
                encoder.PushParam("short", 1, (object)(short)1);
                encoder.PushParam("kept", 2, 2);
            });
            Assert.That(json.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.UnsupportedValue));

            var binary = EncodeBinary(encoder =>
            {
                encoder.PushParam("uint", 1, (object)1u);
                encoder.PushParam("kept", 2, 2);
            });
            Assert.That(binary.Status, Is.EqualTo(VisualBridgeDebugEncodeStatus.UnsupportedValue));
        }

        [Test]
        public void FrameIsOnlySentWhenTheValueChangesAndDataIsAboutToBeSent()
        {
            var transport = InstallTransport();
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());

            // 连接建立后先发当前帧（-1 = 无帧），Create/Finish 不参与帧分组。
            Assert.That(transport.ControlFrames, Is.EqualTo(new long[] { -1L }));
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(1));

            VisualBridgeDebug.SetFrame(5);
            // SetFrame 本身不发消息，只在有数据要发时才补 debugFrame。
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(1));

            SendEvent();
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(2));
            Assert.That(transport.ControlFrames[1], Is.EqualTo(5L));
            Assert.That(transport.Log, Is.EqualTo(new[] { "control:-1", "control:5", "event:10" }));

            // 帧值没变：下一条数据不再产生 debugFrame。
            SendEvent();
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(2));

            // 值变化：补一条；允许回退与重复（-1 也可以再次写出）。
            VisualBridgeDebug.SetFrame(6);
            SendEvent();
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(3));
            Assert.That(transport.ControlFrames[2], Is.EqualTo(6L));

            VisualBridgeDebug.SetFrame(5);
            SendEvent();
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(4));
            Assert.That(transport.ControlFrames[3], Is.EqualTo(5L));

            VisualBridgeDebug.SetFrame(-1);
            SendEvent();
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(5));
            Assert.That(transport.ControlFrames[4], Is.EqualTo(-1L));

            SendEvent();
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(5));

            // Create/Finish 不产生帧通知。
            Assert.That(VisualBridgeDebug.Create("inst-2", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Finish("inst-2"), Is.True);
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(5));
        }

        [Test]
        public void ConnectionEstablishmentAndReconnectSendTheCurrentFrameAgain()
        {
            var transport = InstallTransport(false);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.SetFrame(42);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(0));

            transport.SetConnected(true);
            VisualBridgeDebug.Attach();
            Assert.That(transport.ControlFrames, Is.EqualTo(new long[] { 42L }));
            Assert.That(transport.Creates.Count, Is.EqualTo(1));

            // 同一连接里当前帧已发过：随后的数据不再补帧。
            SendEvent();
            Assert.That(transport.ControlFrames.Count, Is.EqualTo(1));

            // 静默重连（代次变化）后重新发当前帧。
            transport.SetConnected(false);
            transport.SetConnected(true);
            VisualBridgeDebug.Attach();
            Assert.That(transport.ControlFrames, Is.EqualTo(new long[] { 42L, 42L }));
        }

        [Test]
        public void DebugFrameControlMessageIsCompleteJsonAndOrderedBeforeData()
        {
            var transport = InstallTransport();
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            VisualBridgeDebug.SetFrame(9);
            SendEvent();

            Assert.That(transport.Controls.Count, Is.EqualTo(2));
            var frameMessage = transport.Controls[1];
            Assert.That(frameMessage.Format, Is.EqualTo(VisualBridgeDebugPayloadFormat.Json));
            Assert.That(frameMessage.TargetQueue, Is.EqualTo(VisualBridgeDebugTargetQueue.Control));
            var json = ParseJson(frameMessage);
            Assert.That((string)json["type"], Is.EqualTo("debugFrame"));
            Assert.That((int)json["frame"], Is.EqualTo(9));
            Assert.That(transport.Log, Is.EqualTo(new[] { "control:-1", "control:9", "event:10" }));
        }

        [Test]
        public void SparseEncoderEmitsAscendingTagsWithReferenceContractReader()
        {
            // 本用例验证的是编码器：只写非默认 tag、按 tag 升序输出。
            // ReadByContract 只是参考读取器示例，说明读取端可按契约声明 [1,2,3] 推进、缺中间 tag 取默认值；
            // 真正的解码端用例归 E4 / F1。
            var payload = EncodeBinary(encoder =>
            {
                encoder.PushParam("first", 1, 11);
                encoder.PushParam("third", 3, "c");
            }).Payload.ToArray();

            var values = ReadByContract(payload, new[]
            {
                (Tag: (ushort)1, Type: (byte)VisualBridgeDebugWireType.Int),
                (Tag: (ushort)2, Type: (byte)VisualBridgeDebugWireType.String),
                (Tag: (ushort)3, Type: (byte)VisualBridgeDebugWireType.String),
            });

            Assert.That(values.Count, Is.EqualTo(3));
            Assert.That(values[1], Is.EqualTo(11));
            Assert.That(values[2], Is.Null); // 缺中间 tag：默认值（"" 的模型由契约决定，这里只断言没有线上值）
            Assert.That(values[3], Is.EqualTo("c"));
        }

        [Test]
        public void SetEncoderSwapsImplementationsWithoutTouchingCallSites()
        {
            var transport = InstallTransport();
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            SendEvent();
            Assert.That(transport.Events[0].Message.Format, Is.EqualTo(VisualBridgeDebugPayloadFormat.Json));
            Assert.That(((JArray)ParseJson(transport.Events[0].Message)["args"]).Count, Is.EqualTo(2));

            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugBinaryEncoder());
            SendEvent();
            Assert.That(transport.Events[1].Message.Format, Is.EqualTo(VisualBridgeDebugPayloadFormat.Binary));
            var parameters = ReadBinary(transport.Events[1].Message.Payload.ToArray(), false, out _, out _, out _);
            Assert.That(parameters.Count, Is.EqualTo(2));
            Assert.That(parameters[0].Tag, Is.EqualTo((ushort)1));
            Assert.That(parameters[1].Tag, Is.EqualTo((ushort)2));
        }

        private static void SendEvent()
        {
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, MethodId, InterfaceId, MethodName), Is.True);
            VisualBridgeDebug.PushParam("first", 1, 11);
            VisualBridgeDebug.PushParam("second", 2, 22);
            Assert.That(VisualBridgeDebug.End(), Is.True);
        }

        private static VisualBridgeDebugEncodedMessage EncodeJson(
            Action<IDebugMessageEncoder> push,
            VisualBridgeDebugMessageKind kind = VisualBridgeDebugMessageKind.Debug,
            uint requestId = 0u)
        {
            IDebugMessageEncoder encoder = new VisualBridgeDebugJsonEncoder();
            encoder.Begin(kind, "inst-1", Category, InterfaceId, MethodName, MethodId, InstanceSlot, requestId);
            push(encoder);
            return encoder.End();
        }

        private static VisualBridgeDebugEncodedMessage EncodeBinary(
            Action<IDebugMessageEncoder> push,
            VisualBridgeDebugMessageKind kind = VisualBridgeDebugMessageKind.Debug,
            uint requestId = 0u)
        {
            IDebugMessageEncoder encoder = new VisualBridgeDebugBinaryEncoder();
            encoder.Begin(kind, "inst-1", Category, InterfaceId, MethodName, MethodId, InstanceSlot, requestId);
            push(encoder);
            return encoder.End();
        }

        private static FakeTransport InstallTransport()
        {
            return InstallTransport(true);
        }

        private static FakeTransport InstallTransport(bool connected)
        {
            var transport = new FakeTransport(connected);
            VisualBridgeDebugBridge.Install(transport);
            return transport;
        }

        private static JObject ParseJson(VisualBridgeDebugEncodedMessage message)
        {
            return JObject.Parse(Encoding.UTF8.GetString(message.Payload.ToArray()));
        }

        /// <summary>
        /// 直接读取原始 JSON 文本。Unity 6000.3.10f1 自带 Mono 6.13 的 double/float.Parse 对 "-0.0"
        /// 返回 +0（dbits=0），JObject.Parse 不能作为负零 oracle，因此 -0.0 的取值断言走原始文本。
        /// </summary>
        private static string ReadRawJson(VisualBridgeDebugEncodedMessage message)
        {
            return Encoding.UTF8.GetString(message.Payload.ToArray());
        }

        private static List<(ushort Tag, byte Type, object Value)> ReadBinary(byte[] payload, bool result,
            out ushort methodId, out ushort slot, out uint requestId, int enumWidth = 4)
        {
            int offset = 0;
            methodId = ReadU16(payload, ref offset);
            slot = ReadU16(payload, ref offset);
            requestId = result ? ReadU32(payload, ref offset) : 0u;

            var parameters = new List<(ushort, byte, object)>();
            while (offset < payload.Length)
            {
                ushort tag = ReadU16(payload, ref offset);
                byte type = payload[offset++];
                object value = ReadValue(payload, ref offset, type, enumWidth);
                parameters.Add((tag, type, value));
            }

            return parameters;
        }

        /// <summary>按契约声明顺序读取稀疏参数区：只在下一个 tag 等于期望 tag 时消费线上值。</summary>
        private static Dictionary<ushort, object> ReadByContract(byte[] payload,
            (ushort Tag, byte Type)[] contract)
        {
            int offset = 4; // event：methodId + instanceSlot
            ushort nextTag = offset < payload.Length ? ReadU16(payload, ref offset) : ushort.MaxValue;
            byte nextType = 0;
            var values = new Dictionary<ushort, object>();
            foreach (var entry in contract)
            {
                if (nextTag == entry.Tag)
                {
                    nextType = payload[offset++];
                    Assert.That(nextType, Is.EqualTo(entry.Type));
                    values[entry.Tag] = ReadValue(payload, ref offset, nextType, 4);
                    nextTag = offset < payload.Length ? ReadU16(payload, ref offset) : ushort.MaxValue;
                }
                else
                {
                    Assert.That(nextTag > entry.Tag || nextTag == ushort.MaxValue, Is.True,
                        "载荷里的 tag 必须按升序出现，读取端才能按契约推进。");
                    values[entry.Tag] = null;
                }
            }

            Assert.That(offset, Is.EqualTo(payload.Length));
            return values;
        }

        private static object ReadValue(byte[] payload, ref int offset, byte type, int enumWidth)
        {
            switch (type)
            {
                case (byte)VisualBridgeDebugWireType.Bool:
                    return payload[offset++] != 0;
                case (byte)VisualBridgeDebugWireType.Int:
                    return ReadI32(payload, ref offset);
                case (byte)VisualBridgeDebugWireType.Long:
                    return ReadI64(payload, ref offset);
                case (byte)VisualBridgeDebugWireType.Ulong:
                    return ReadU64(payload, ref offset);
                case (byte)VisualBridgeDebugWireType.Float:
                    return BitConverter.Int32BitsToSingle(ReadI32(payload, ref offset));
                case (byte)VisualBridgeDebugWireType.Double:
                    return BitConverter.Int64BitsToDouble(ReadI64(payload, ref offset));
                case (byte)VisualBridgeDebugWireType.Enum:
                    if (enumWidth == 1)
                    {
                        return (ulong)payload[offset++];
                    }

                    if (enumWidth == 2)
                    {
                        return (ulong)ReadU16(payload, ref offset);
                    }

                    if (enumWidth == 4)
                    {
                        return (ulong)ReadU32(payload, ref offset);
                    }

                    return ReadU64(payload, ref offset);
                case (byte)VisualBridgeDebugWireType.String:
                    ushort length = ReadU16(payload, ref offset);
                    string text = Encoding.UTF8.GetString(payload, offset, length);
                    offset += length;
                    return text;
                case (byte)VisualBridgeDebugWireType.ByteArray:
                    uint byteCount = ReadU32(payload, ref offset);
                    var bytes = new byte[byteCount];
                    Buffer.BlockCopy(payload, offset, bytes, 0, (int)byteCount);
                    offset += (int)byteCount;
                    return bytes;
                default:
                    throw new AssertionException("未知的 type 码：" + type.ToString(CultureInfo.InvariantCulture));
            }
        }

        private static ushort ReadU16(byte[] payload, ref int offset)
        {
            ushort value = (ushort)((payload[offset] << 8) | payload[offset + 1]);
            offset += 2;
            return value;
        }

        private static uint ReadU32(byte[] payload, ref int offset)
        {
            uint value = ((uint)payload[offset] << 24)
                | ((uint)payload[offset + 1] << 16)
                | ((uint)payload[offset + 2] << 8)
                | payload[offset + 3];
            offset += 4;
            return value;
        }

        private static ulong ReadU64(byte[] payload, ref int offset)
        {
            ulong value = ((ulong)payload[offset] << 56)
                | ((ulong)payload[offset + 1] << 48)
                | ((ulong)payload[offset + 2] << 40)
                | ((ulong)payload[offset + 3] << 32)
                | ((ulong)payload[offset + 4] << 24)
                | ((ulong)payload[offset + 5] << 16)
                | ((ulong)payload[offset + 6] << 8)
                | payload[offset + 7];
            offset += 8;
            return value;
        }

        private static int ReadI32(byte[] payload, ref int offset)
        {
            return unchecked((int)ReadU32(payload, ref offset));
        }

        private static long ReadI64(byte[] payload, ref int offset)
        {
            return unchecked((long)ReadU64(payload, ref offset));
        }

        private enum SampleEnum
        {
            None = 0,
            Second = 2,
        }

        private enum NegativeEnum : short
        {
            None = 0,
            Minus = -2,
        }

        private enum WideEnum : ulong
        {
            None = 0,
            Big = ulong.MaxValue,
        }

        /// <summary>假传输：记录事件/结果/控制消息与统一时序日志，用来断言 debugFrame 先于数据写出。</summary>
        private sealed class FakeTransport : IVisualBridgeDebugTransport
        {
            private bool _connected;
            private long _generation;

            public FakeTransport(bool connected)
            {
                _connected = connected;
            }

            public bool IsConnected
            {
                get { return _connected; }
            }

            public ConnectType ConnectType
            {
                get { return VisualBridge.Diagnostics.ConnectType.Editor; }
            }

            public long ConnectionGeneration
            {
                get { return _generation; }
            }

            public List<(string InstanceId, string Category, string ResName, string DebugInfo, ushort Slot)> Creates
            {
                get;
            } = new List<(string, string, string, string, ushort)>();

            public List<(string InstanceId, ushort Slot)> Finishes { get; } = new List<(string, ushort)>();

            public List<(ushort Slot, ushort MethodId, string Category, string Iface, string Method, long Frame,
                VisualBridgeDebugEncodedMessage Message)> Events
            {
                get;
            } = new List<(ushort, ushort, string, string, string, long, VisualBridgeDebugEncodedMessage)>();

            public List<(uint RequestSeq, VisualBridgeDebugEncodedMessage Message)> Results
            {
                get;
            } = new List<(uint, VisualBridgeDebugEncodedMessage)>();

            public List<(uint RequestSeq, string Reason)> Rejects { get; } = new List<(uint, string)>();

            /// <summary>查询运行期产生的失败应答（附录 A.6 错误码 + detail）。</summary>
            public List<(uint RequestSeq, string Code, string Detail)> QueryErrors { get; } =
                new List<(uint, string, string)>();

            public List<VisualBridgeDebugEncodedMessage> Controls { get; } =
                new List<VisualBridgeDebugEncodedMessage>();

            public List<string> Log { get; } = new List<string>();

            public List<long> ControlFrames
            {
                get
                {
                    var frames = new List<long>();
                    foreach (var message in Controls)
                    {
                        frames.Add((long)JObject.Parse(Encoding.UTF8.GetString(message.Payload.ToArray()))["frame"]);
                    }

                    return frames;
                }
            }

            public void SetConnected(bool connected)
            {
                _connected = connected;
                if (connected)
                {
                    _generation++;
                }
            }

            public void SendCreate(string instanceId, string category, string resName, string debugInfo,
                ushort instanceSlot)
            {
                EnsureConnected();
                Creates.Add((instanceId, category, resName, debugInfo, instanceSlot));
            }

            public void SendFinish(string instanceId, ushort instanceSlot)
            {
                EnsureConnected();
                Finishes.Add((instanceId, instanceSlot));
            }

            public void SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method,
                long frame, VisualBridgeDebugEncodedMessage message)
            {
                EnsureConnected();
                Events.Add((instanceSlot, methodId, category, iface, method, frame, message));
                Log.Add("event:" + methodId.ToString(CultureInfo.InvariantCulture));
            }

            public void SendResult(uint requestSeq, VisualBridgeDebugEncodedMessage message)
            {
                EnsureConnected();
                Results.Add((requestSeq, message));
                Log.Add("result:" + requestSeq.ToString(CultureInfo.InvariantCulture));
            }

            public void SendControl(VisualBridgeDebugEncodedMessage message)
            {
                EnsureConnected();
                Controls.Add(message);
                var json = JObject.Parse(Encoding.UTF8.GetString(message.Payload.ToArray()));
                Log.Add("control:" + ((long)json["frame"]).ToString(CultureInfo.InvariantCulture));
            }

            public void SendReject(uint requestSeq, string reason)
            {
                EnsureConnected();
                Rejects.Add((requestSeq, reason));
            }

            public void SendQueryError(uint requestSeq, string code, string detail)
            {
                EnsureConnected();
                QueryErrors.Add((requestSeq, code, detail));
            }

            private void EnsureConnected()
            {
                if (!_connected)
                {
                    throw new InvalidOperationException("FakeTransport 已断开，不应收到消息。");
                }
            }
        }
    }
}
