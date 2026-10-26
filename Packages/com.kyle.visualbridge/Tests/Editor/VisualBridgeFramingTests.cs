using System;
using System.Collections.Generic;
using System.Text;
using NUnit.Framework;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// 统一协议成帧的 EditMode 用例：CRC、帧头字节序、固定跨语言 fixture、
    /// 增量解码与「失败即断」错误分类。
    /// </summary>
    public sealed class VisualBridgeFramingTests
    {
        /// <summary>
        /// 跨语言固定 fixture：TS 侧 `framing.test.ts` 断言同一组十六进制字节。
        /// 帧 1 控制/JSON、帧 2 调试/二进制、帧 3 调试/JSON、帧 4 控制/空载荷。
        /// </summary>
        private static readonly (VisualBridgeChannel Channel, VisualBridgePayloadKind Kind, byte[] Payload, string Hex)[] Fixture =
        {
            (
                VisualBridgeChannel.Editor,
                VisualBridgePayloadKind.Json,
                Encoding.UTF8.GetBytes("{\"type\":\"hello\",\"protocolVersion\":4}"),
                "20000024D7687B2274797065223A2268656C6C6F222C2270726F746F636F6C56657273696F6E223A347D"),
            (
                VisualBridgeChannel.Debug,
                VisualBridgePayloadKind.Binary,
                new byte[] { 0, 1, 2, 3, 4, 5, 6, 7 },
                "80000008D8F00001020304050607"),
            (
                VisualBridgeChannel.Debug,
                VisualBridgePayloadKind.Json,
                Encoding.UTF8.GetBytes("{\"type\":\"debug\"}"),
                "A00000107C877B2274797065223A226465627567227D"),
            (
                VisualBridgeChannel.Editor,
                VisualBridgePayloadKind.Json,
                Array.Empty<byte>(),
                "20000000B38E"),
        };

        [Test]
        public void Crc16CcittFalseMatchesPublishedCheckVector()
        {
            var bytes = Encoding.UTF8.GetBytes("123456789");
            Assert.That(VisualBridgeFraming.ComputeCrc16(bytes, 0, bytes.Length), Is.EqualTo((ushort)0x29B1));
        }

        [Test]
        public void FixedFixtureEncodesToSharedCrossLanguageBytes()
        {
            foreach (var entry in Fixture)
            {
                var frame = VisualBridgeFraming.EncodeFrame(entry.Channel, entry.Kind, entry.Payload);
                Assert.That(ToHex(frame), Is.EqualTo(entry.Hex));

                var header = VisualBridgeFraming.EncodeHeader(entry.Channel, entry.Kind, entry.Payload.Length);
                Assert.That(ToHex(header), Is.EqualTo(entry.Hex.Substring(0, VisualBridgeFraming.HeaderBytes * 2)));
            }
        }

        [Test]
        public void FrameReaderReassemblesFixtureAcrossEveryTwoChunkSplit()
        {
            var stream = BuildFixtureStream();
            for (var split = 1; split < stream.Length; split++)
            {
                var reader = new VisualBridgeFrameReader();
                reader.Append(stream, 0, split);
                var frames = new List<VisualBridgeFrame>();
                while (reader.TryReadFrame(out var frame))
                {
                    frames.Add(frame);
                }

                reader.Append(stream, split, stream.Length - split);
                while (reader.TryReadFrame(out var frame))
                {
                    frames.Add(frame);
                }

                Assert.That(frames.Count, Is.EqualTo(Fixture.Length), "split " + split);
                for (var index = 0; index < frames.Count; index++)
                {
                    Assert.That(frames[index].Channel, Is.EqualTo(Fixture[index].Channel), "split " + split + " frame " + index);
                    Assert.That(frames[index].PayloadKind, Is.EqualTo(Fixture[index].Kind), "split " + split + " frame " + index);
                    Assert.That(frames[index].Payload, Is.EqualTo(Fixture[index].Payload), "split " + split + " frame " + index);
                }
            }
        }

        [Test]
        public void FrameReaderWaitsForTheFullDeclaredPayload()
        {
            var reader = new VisualBridgeFrameReader();
            var frame = VisualBridgeFraming.EncodeFrame(
                VisualBridgeChannel.Debug, VisualBridgePayloadKind.Binary, new byte[] { 1, 2, 3, 4 });
            reader.Append(frame, 0, VisualBridgeFraming.HeaderBytes);
            Assert.That(reader.TryReadFrame(out _), Is.False);
            Assert.That(reader.BufferedByteCount, Is.EqualTo(VisualBridgeFraming.HeaderBytes));

            reader.Append(frame, VisualBridgeFraming.HeaderBytes, frame.Length - VisualBridgeFraming.HeaderBytes - 1);
            Assert.That(reader.TryReadFrame(out _), Is.False);

            reader.Append(frame, frame.Length - 1, 1);
            Assert.That(reader.TryReadFrame(out var decoded), Is.True);
            Assert.That(decoded.Payload, Is.EqualTo(new byte[] { 1, 2, 3, 4 }));
        }

        [Test]
        public void CorruptedHeaderCrcFailsTheConnectionWithoutResync()
        {
            var stream = BuildFixtureStream();
            stream[4] ^= 0xFF;
            var reader = new VisualBridgeFrameReader();
            reader.Append(stream, 0, stream.Length);

            var exception = Assert.Throws<VisualBridgeFrameException>(() => reader.TryReadFrame(out _));
            Assert.That(exception.Code, Is.EqualTo(VisualBridgeFrameErrorCode.InvalidCrc));
        }

        [Test]
        public void PayloadLengthAboveOneMegabyteIsRejectedBeforeReading()
        {
            var header = BuildHeader(VisualBridgeChannel.Debug, VisualBridgePayloadKind.Binary, VisualBridgeFraming.MaxMessageBytes + 1);
            Assert.That(ToHex(header), Is.EqualTo("801000010ABA"), "fixture guard: header bytes");

            var reader = new VisualBridgeFrameReader();
            reader.Append(header, 0, header.Length);
            var exception = Assert.Throws<VisualBridgeFrameException>(() => reader.TryReadFrame(out _));
            Assert.That(exception.Code, Is.EqualTo(VisualBridgeFrameErrorCode.PayloadTooLarge));

            Assert.Throws<VisualBridgeFrameException>(() => VisualBridgeFraming.EncodeHeader(
                VisualBridgeChannel.Editor, VisualBridgePayloadKind.Json, VisualBridgeFraming.MaxMessageBytes + 1));
        }

        [Test]
        public void UnregisteredPayloadKindIsRejected()
        {
            var header = BuildHeader(VisualBridgeChannel.Debug, (VisualBridgePayloadKind)2, 4);
            var exception = Assert.Throws<VisualBridgeFrameException>(() => VisualBridgeFraming.DecodeHeader(
                header, 0, out _, out _, out _));
            Assert.That(exception.Code, Is.EqualTo(VisualBridgeFrameErrorCode.InvalidPayloadKind));
        }

        [Test]
        public void IncompleteTrailingFrameIsReportedAsTruncated()
        {
            var reader = new VisualBridgeFrameReader();
            var frame = VisualBridgeFraming.EncodeFrame(
                VisualBridgeChannel.Editor, VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes("{\"a\":1}"));
            reader.Append(frame, 0, frame.Length - 2);
            Assert.That(reader.TryReadFrame(out _), Is.False);
            Assert.That(reader.BufferedByteCount, Is.EqualTo(frame.Length - 2));
            reader.DiscardPending();
            Assert.That(reader.BufferedByteCount, Is.Zero);
        }

        private static byte[] BuildFixtureStream()
        {
            var frames = new List<byte>();
            foreach (var entry in Fixture)
            {
                frames.AddRange(VisualBridgeFraming.EncodeFrame(entry.Channel, entry.Kind, entry.Payload));
            }

            return frames.ToArray();
        }

        private static byte[] BuildHeader(VisualBridgeChannel channel, VisualBridgePayloadKind kind, int payloadLength)
        {
            var header = new byte[VisualBridgeFraming.HeaderBytes];
            var word = ((uint)channel << 31) | ((uint)kind << 29) | (uint)payloadLength;
            header[0] = (byte)(word >> 24);
            header[1] = (byte)(word >> 16);
            header[2] = (byte)(word >> 8);
            header[3] = (byte)word;
            RewriteCrc(header);
            return header;
        }

        private static void RewriteCrc(byte[] header)
        {
            var crc = VisualBridgeFraming.ComputeCrc16(header, 0, 4);
            header[4] = (byte)(crc >> 8);
            header[5] = (byte)crc;
        }

        private static string ToHex(byte[] bytes)
        {
            return BitConverter.ToString(bytes).Replace("-", string.Empty);
        }
    }
}
