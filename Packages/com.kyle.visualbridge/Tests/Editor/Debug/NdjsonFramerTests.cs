using System;
using System.Collections.Generic;
using System.Text;
using NUnit.Framework;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor.Tests
{
    public sealed class NdjsonFramerTests
    {
        private readonly NdjsonFramer _framer = new NdjsonFramer();

        private static DebugMessageHeader EventHeader(
            DebugMessageKind kind = DebugMessageKind.Debug,
            string requestId = null,
            long seq = 128,
            long frame = 42)
        {
            return new DebugMessageHeader(
                kind,
                "graph",
                "exec-1",
                1,
                "Game.Debug.IGraphDebuger",
                "NodeStart",
                requestId,
                seq,
                frame);
        }

        private static DebugMessageHeader InstanceHeader(long seq = 129, long frame = -1)
        {
            return new DebugMessageHeader(
                DebugMessageKind.Instance,
                "graph",
                "exec-1",
                1,
                "Game.Debug.IGraphDebuger",
                "NodeStart",
                null,
                seq,
                frame);
        }

        private static byte[] FrameOneArg(DebugValueKind kind, object value)
        {
            var framer = new NdjsonFramer();
            var args = new List<DebugArgValue>
            {
                new DebugArgValue("p", 3, kind, value),
            };
            return framer.Frame(EventHeader(frame: -1), new DebugArgsBody(args));
        }

        [Test]
        public void DebugMessageUsesDocumentedFieldOrder()
        {
            var args = new List<DebugArgValue>
            {
                new DebugArgValue("uid", 0, DebugValueKind.String, "char-42"),
            };

            byte[] frame = _framer.Frame(EventHeader(), new DebugArgsBody(args));
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(
                json,
                Is.EqualTo(
                    "{\"type\":\"debug\",\"seq\":128,\"category\":\"graph\",\"instance\":\"exec-1\"," +
                    "\"interface\":\"Game.Debug.IGraphDebuger\",\"version\":1,\"method\":\"NodeStart\"," +
                    "\"frame\":42,\"args\":[{\"name\":\"uid\",\"value\":\"char-42\"}]}\n"));
            Assert.That(frame[frame.Length - 1], Is.EqualTo((byte)'\n'));
        }

        [Test]
        public void DebugMessageRoundTrips()
        {
            var args = new List<DebugArgValue>
            {
                new DebugArgValue("uid", 0, DebugValueKind.String, "char-42"),
                new DebugArgValue("count", 1, DebugValueKind.Int32, 7),
            };

            byte[] frame = _framer.Frame(EventHeader(), new DebugArgsBody(args));

            Assert.That(
                _framer.TryParse(frame, out int consumed, out DebugMessageHeader header, out IDebugMessageBody body),
                Is.True);
            Assert.That(consumed, Is.EqualTo(frame.Length));
            Assert.That(header.Kind, Is.EqualTo(DebugMessageKind.Debug));
            Assert.That(header.Category, Is.EqualTo("graph"));
            Assert.That(header.Instance, Is.EqualTo("exec-1"));
            Assert.That(header.Version, Is.EqualTo(1));
            Assert.That(header.Interface, Is.EqualTo("Game.Debug.IGraphDebuger"));
            Assert.That(header.Method, Is.EqualTo("NodeStart"));
            Assert.That(header.RequestId, Is.Null);
            Assert.That(header.Seq, Is.EqualTo(128));
            Assert.That(header.Frame, Is.EqualTo(42));

            var parsed = (DebugArgsBody)body;
            Assert.That(parsed.Args.Count, Is.EqualTo(2));
            Assert.That(parsed.Args[0].Name, Is.EqualTo("uid"));
            Assert.That(parsed.Args[0].Kind, Is.EqualTo(DebugValueKind.String));
            Assert.That(parsed.Args[0].Value, Is.EqualTo("char-42"));
            Assert.That(parsed.Args[1].Name, Is.EqualTo("count"));
            Assert.That(parsed.Args[1].Kind, Is.EqualTo(DebugValueKind.Int32));
            Assert.That(parsed.Args[1].Value, Is.EqualTo(7));
        }

        [Test]
        public void DebugResultWritesRequestIdAfterMethodAndOmitsFrame()
        {
            DebugMessageHeader header = EventHeader(DebugMessageKind.DebugResult, "req-17", 7, -1);
            byte[] frame = _framer.Frame(header, new DebugArgsBody(new List<DebugArgValue>()));
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(
                json,
                Is.EqualTo(
                    "{\"type\":\"debugResult\",\"seq\":7,\"category\":\"graph\",\"instance\":\"exec-1\"," +
                    "\"interface\":\"Game.Debug.IGraphDebuger\",\"version\":1,\"method\":\"NodeStart\"," +
                    "\"requestId\":\"req-17\",\"args\":[]}\n"));

            Assert.That(
                _framer.TryParse(frame, out _, out DebugMessageHeader parsed, out IDebugMessageBody body),
                Is.True);
            Assert.That(parsed.Kind, Is.EqualTo(DebugMessageKind.DebugResult));
            Assert.That(parsed.RequestId, Is.EqualTo("req-17"));
            Assert.That(parsed.Frame, Is.EqualTo(-1));
            Assert.That(((DebugArgsBody)body).Args, Is.Empty);
        }

        [Test]
        public void InstanceMessageRoundTrips()
        {
            var body = new DebugInstanceBody(
                "Skill Fire",
                new List<string> { "a", "b" });

            byte[] frame = _framer.Frame(InstanceHeader(), body);
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(
                json,
                Is.EqualTo(
                    "{\"type\":\"debugInstance\",\"seq\":129,\"category\":\"graph\"," +
                    "\"instance\":\"exec-1\",\"label\":\"Skill Fire\",\"keywords\":[\"a\",\"b\"]}\n"));

            Assert.That(
                _framer.TryParse(frame, out int consumed, out DebugMessageHeader header, out IDebugMessageBody parsedBody),
                Is.True);
            Assert.That(consumed, Is.EqualTo(frame.Length));
            Assert.That(header.Kind, Is.EqualTo(DebugMessageKind.Instance));
            Assert.That(header.Category, Is.EqualTo("graph"));
            Assert.That(header.Instance, Is.EqualTo("exec-1"));
            Assert.That(header.Frame, Is.EqualTo(-1));

            var instance = (DebugInstanceBody)parsedBody;
            Assert.That(instance.Label, Is.EqualTo("Skill Fire"));
            Assert.That(instance.Keywords, Is.EqualTo(new[] { "a", "b" }));
        }

        [TestCase(DebugValueKind.Bool, true, "true", DebugValueKind.Bool)]
        [TestCase(DebugValueKind.Int32, 42, "42", DebugValueKind.Int32)]
        [TestCase(DebugValueKind.Double, 1.5, "1.5", DebugValueKind.Double)]
        [TestCase(DebugValueKind.String, "hello", "\"hello\"", DebugValueKind.String)]
        [TestCase(DebugValueKind.Enum, "Fire", "\"Fire\"", DebugValueKind.String)]
        public void ScalarValueRoundTrips(
            DebugValueKind kind,
            object value,
            string jsonValue,
            DebugValueKind parsedKind)
        {
            byte[] frame = FrameOneArg(kind, value);
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(json, Does.Contain("\"value\":" + jsonValue));
            Assert.That(
                _framer.TryParse(frame, out _, out _, out IDebugMessageBody body),
                Is.True);
            DebugArgValue arg = ((DebugArgsBody)body).Args[0];
            Assert.That(arg.Kind, Is.EqualTo(parsedKind));
            Assert.That(arg.Value, Is.EqualTo(value));
        }

        [Test]
        public void Int64ValueIsWrittenAsJsonString()
        {
            const long value = 9007199254740993L;
            byte[] frame = FrameOneArg(DebugValueKind.Int64, value);
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(json, Does.Contain("\"value\":\"9007199254740993\""));
            Assert.That(
                _framer.TryParse(frame, out _, out _, out IDebugMessageBody body),
                Is.True);
            DebugArgValue arg = ((DebugArgsBody)body).Args[0];
            Assert.That(arg.Kind, Is.EqualTo(DebugValueKind.Int64));
            Assert.That(arg.Value, Is.EqualTo(value));
        }

        [Test]
        public void UInt64ValueIsWrittenAsJsonString()
        {
            const ulong value = ulong.MaxValue;
            byte[] frame = FrameOneArg(DebugValueKind.UInt64, value);
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(json, Does.Contain("\"value\":\"18446744073709551615\""));
            Assert.That(
                _framer.TryParse(frame, out _, out _, out IDebugMessageBody body),
                Is.True);
            DebugArgValue arg = ((DebugArgsBody)body).Args[0];
            Assert.That(arg.Kind, Is.EqualTo(DebugValueKind.UInt64));
            Assert.That(arg.Value, Is.EqualTo(value));
        }

        [Test]
        public void SingleValueRoundTripsAsNumber()
        {
            byte[] frame = FrameOneArg(DebugValueKind.Single, 1.5f);
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(json, Does.Contain("\"value\":1.5"));
            Assert.That(
                _framer.TryParse(frame, out _, out _, out IDebugMessageBody body),
                Is.True);
            DebugArgValue arg = ((DebugArgsBody)body).Args[0];
            Assert.That(arg.Kind, Is.EqualTo(DebugValueKind.Double));
            Assert.That(Convert.ToSingle(arg.Value), Is.EqualTo(1.5f));
        }

        [Test]
        public void BytesValueIsWrittenAsBase64()
        {
            byte[] frame = FrameOneArg(DebugValueKind.Bytes, new byte[] { 1, 2, 3 });
            string json = Encoding.UTF8.GetString(frame);

            Assert.That(json, Does.Contain("\"value\":\"AQID\""));
            Assert.That(
                _framer.TryParse(frame, out _, out _, out IDebugMessageBody body),
                Is.True);
            DebugArgValue arg = ((DebugArgsBody)body).Args[0];
            Assert.That(arg.Kind, Is.EqualTo(DebugValueKind.String));
            Assert.That(arg.Value, Is.EqualTo("AQID"));
        }

        [Test]
        public void PartialMessageReturnsFalseWithoutConsuming()
        {
            byte[] frame = _framer.Frame(
                EventHeader(),
                new DebugArgsBody(new List<DebugArgValue>()));
            var partial = new byte[frame.Length - 1];
            Array.Copy(frame, partial, partial.Length);

            Assert.That(
                _framer.TryParse(partial, out int consumed, out DebugMessageHeader header, out IDebugMessageBody body),
                Is.False);
            Assert.That(consumed, Is.EqualTo(0));
            Assert.That(header.Kind, Is.EqualTo(default(DebugMessageKind)));
            Assert.That(body, Is.Null);
        }

        [Test]
        public void OnlyFirstCompleteMessageIsConsumed()
        {
            byte[] first = _framer.Frame(
                EventHeader(seq: 1),
                new DebugArgsBody(new List<DebugArgValue>()));
            byte[] second = _framer.Frame(
                EventHeader(seq: 2),
                new DebugArgsBody(new List<DebugArgValue>()));

            var buffer = new byte[first.Length + second.Length];
            Buffer.BlockCopy(first, 0, buffer, 0, first.Length);
            Buffer.BlockCopy(second, 0, buffer, first.Length, second.Length);

            Assert.That(
                _framer.TryParse(buffer, out int consumed, out DebugMessageHeader header, out _),
                Is.True);
            Assert.That(consumed, Is.EqualTo(first.Length));
            Assert.That(header.Seq, Is.EqualTo(1));

            Assert.That(
                _framer.TryParse(buffer.AsSpan(consumed), out int nextConsumed, out DebugMessageHeader next, out _),
                Is.True);
            Assert.That(nextConsumed, Is.EqualTo(second.Length));
            Assert.That(next.Seq, Is.EqualTo(2));
        }

        [Test]
        public void CrLfAndBlankLinesAreAccepted()
        {
            string line = Encoding.UTF8.GetString(
                _framer.Frame(EventHeader(seq: 5), new DebugArgsBody(new List<DebugArgValue>())));
            line = line.Substring(0, line.Length - 1);

            byte[] buffer = Encoding.UTF8.GetBytes(" \r\n\r\n" + line + "\r\n");

            Assert.That(
                _framer.TryParse(buffer, out int consumed, out DebugMessageHeader header, out _),
                Is.True);
            Assert.That(consumed, Is.EqualTo(buffer.Length));
            Assert.That(header.Seq, Is.EqualTo(5));
        }

        [Test]
        public void FrameRejectsOversizeLine()
        {
            var value = new string('a', NdjsonFramer.MaxLineBytes);
            var args = new List<DebugArgValue>
            {
                new DebugArgValue("p", 0, DebugValueKind.String, value),
            };

            Assert.Throws<VisualBridgeDebugProtocolException>(
                () => _framer.Frame(EventHeader(), new DebugArgsBody(args)));
        }

        [Test]
        public void TryParseRejectsOversizePartialLine()
        {
            var buffer = new byte[NdjsonFramer.MaxLineBytes + 1];
            for (int i = 0; i < buffer.Length; i++)
            {
                buffer[i] = (byte)'a';
            }

            Assert.Throws<VisualBridgeDebugProtocolException>(() =>
            {
                _framer.TryParse(buffer, out _, out _, out _);
            });
        }

        [TestCase("00123")]
        [TestCase(" 42")]
        [TestCase("+7")]
        [TestCase("-0")]
        public void NonCanonicalNumericStringsStayStrings(string text)
        {
            byte[] frame = FrameOneArg(DebugValueKind.String, text);

            Assert.That(
                _framer.TryParse(frame, out _, out _, out IDebugMessageBody body),
                Is.True);
            DebugArgValue arg = ((DebugArgsBody)body).Args[0];
            Assert.That(arg.Kind, Is.EqualTo(DebugValueKind.String));
            Assert.That(arg.Value, Is.EqualTo(text));
        }

        [Test]
        public void TryParseRejectsOversizeLine()
        {
            var buffer = new byte[NdjsonFramer.MaxLineBytes + 2];
            for (int i = 0; i < buffer.Length - 1; i++)
            {
                buffer[i] = (byte)'a';
            }

            buffer[buffer.Length - 1] = (byte)'\n';

            Assert.Throws<VisualBridgeDebugProtocolException>(() =>
            {
                _framer.TryParse(buffer, out _, out _, out _);
            });
        }

        [Test]
        public void UnknownTypeThrowsWithOriginalType()
        {
            byte[] buffer = Encoding.UTF8.GetBytes("{\"type\":\"mystery\"}\n");

            var exception = Assert.Throws<VisualBridgeDebugProtocolException>(() =>
            {
                _framer.TryParse(buffer, out _, out _, out _);
            });

            Assert.That(exception.Message, Does.Contain("mystery"));
        }

        [Test]
        public void InvalidJsonThrowsProtocolException()
        {
            byte[] buffer = Encoding.UTF8.GetBytes("{not json}\n");

            Assert.Throws<VisualBridgeDebugProtocolException>(() =>
            {
                _framer.TryParse(buffer, out _, out _, out _);
            });
        }

        [Test]
        public void MissingOptionalFieldsUseDocumentedDefaults()
        {
            byte[] debug = Encoding.UTF8.GetBytes("{\"type\":\"debug\",\"seq\":9}\n");

            Assert.That(
                _framer.TryParse(debug, out _, out DebugMessageHeader header, out IDebugMessageBody body),
                Is.True);
            Assert.That(header.Instance, Is.EqualTo(string.Empty));
            Assert.That(header.Frame, Is.EqualTo(-1));
            Assert.That(header.Version, Is.EqualTo(0));
            Assert.That(header.Category, Is.Null);
            Assert.That(((DebugArgsBody)body).Args, Is.Empty);

            byte[] instance = Encoding.UTF8.GetBytes("{\"type\":\"debugInstance\"}\n");

            Assert.That(
                _framer.TryParse(instance, out _, out DebugMessageHeader instanceHeader, out IDebugMessageBody instanceBody),
                Is.True);
            Assert.That(instanceHeader.Instance, Is.EqualTo(string.Empty));
            Assert.That(instanceHeader.Frame, Is.EqualTo(-1));

            var parsed = (DebugInstanceBody)instanceBody;
            Assert.That(parsed.Label, Is.EqualTo(string.Empty));
            Assert.That(parsed.Keywords, Is.Empty);
        }

        [Test]
        public void UnknownFieldsAreIgnored()
        {
            byte[] buffer = Encoding.UTF8.GetBytes(
                "{\"type\":\"debug\",\"seq\":3,\"extra\":{\"x\":1},\"args\":[]}\n");

            Assert.That(
                _framer.TryParse(buffer, out _, out DebugMessageHeader header, out IDebugMessageBody body),
                Is.True);
            Assert.That(header.Seq, Is.EqualTo(3));
            Assert.That(((DebugArgsBody)body).Args, Is.Empty);
        }

        [Test]
        public void TagIsReadWhenPresent()
        {
            byte[] buffer = Encoding.UTF8.GetBytes(
                "{\"type\":\"debug\",\"args\":[{\"name\":\"p\",\"tag\":7,\"value\":1}]}\n");

            Assert.That(
                _framer.TryParse(buffer, out _, out _, out IDebugMessageBody body),
                Is.True);
            Assert.That(((DebugArgsBody)body).Args[0].Tag, Is.EqualTo(7));
        }
    }
}
