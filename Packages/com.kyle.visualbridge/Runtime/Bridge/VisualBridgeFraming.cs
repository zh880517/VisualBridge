using System;

namespace VisualBridge.Runtime
{
    /// <summary>通道 0 = 控制/编辑器（JSON）；通道 1 = 调试（JSON 或二进制）。</summary>
    public enum VisualBridgeChannel : byte
    {
        Editor = 0,
        Debug = 1,
    }

    /// <summary>载荷类型 0 = 二进制；1 = JSON。</summary>
    public enum VisualBridgePayloadKind : byte
    {
        Binary = 0,
        Json = 1,
    }

    /// <summary>帧层协议错误分类；出现即断开，绝不重同步。</summary>
    public enum VisualBridgeFrameErrorCode
    {
        InvalidCrc,
        PayloadTooLarge,
        InvalidChannel,
        InvalidPayloadKind,
        Truncated,
    }

    /// <summary>帧层协议错误：CRC 或长度非法、对端在帧中间关闭等。</summary>
    public sealed class VisualBridgeFrameException : Exception
    {
        public VisualBridgeFrameException(VisualBridgeFrameErrorCode code, string message)
            : base(message)
        {
            Code = code;
        }

        public VisualBridgeFrameErrorCode Code { get; }
    }

    /// <summary>一个完整帧（帧头已校验）。</summary>
    public sealed class VisualBridgeFrame
    {
        public VisualBridgeChannel Channel { get; internal set; }

        public VisualBridgePayloadKind PayloadKind { get; internal set; }

        public byte[] Payload { get; internal set; }
    }

    /// <summary>
    /// 统一协议连接层的成帧：6 字节帧头 + 载荷。
    /// 帧头 = u32（channel(1) | payloadKind(2) | payloadLength(29)，大端）
    ///        + u16 CRC-16/CCITT-FALSE（大端，只覆盖前 4 字节）。
    /// 与 TS 侧 <c>framing.ts</c> 保持逐字节一致。
    /// </summary>
    public static class VisualBridgeFraming
    {
        public const int HeaderBytes = 6;
        public const int MaxMessageBytes = 1024 * 1024;
        public const uint MaxPayloadLength = 0x1FFFFFFF;

        private const ushort CrcPolynomial = 0x1021;
        private const ushort CrcInitial = 0xFFFF;
        private const int PayloadKindShift = 29;
        private const int ChannelShift = 31;

        private static readonly ushort[] CrcTable = BuildCrcTable();

        /// <summary>CRC-16/CCITT-FALSE：poly 0x1021、init 0xFFFF、不反射、xorout 0。</summary>
        public static ushort ComputeCrc16(byte[] buffer, int offset, int count)
        {
            if (buffer == null)
            {
                throw new ArgumentNullException(nameof(buffer));
            }

            var crc = CrcInitial;
            for (var index = offset; index < offset + count; index++)
            {
                crc = (ushort)(CrcTable[((crc >> 8) ^ buffer[index]) & 0xFF] ^ (crc << 8));
            }

            return crc;
        }

        /// <summary>编码 6 字节帧头（含 CRC）；入参在写线上前先做范围校验。</summary>
        public static byte[] EncodeHeader(VisualBridgeChannel channel, VisualBridgePayloadKind payloadKind, int payloadLength)
        {
            ValidateChannel(channel);
            ValidatePayloadKind(payloadKind);
            if (payloadLength < 0 || payloadLength > MaxPayloadLength)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.PayloadTooLarge,
                    "Payload length " + payloadLength + " does not fit the 29-bit header field.");
            }

            if (payloadLength > MaxMessageBytes)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.PayloadTooLarge,
                    "Payload length " + payloadLength + " exceeds the " + MaxMessageBytes + "-byte limit.");
            }

            var header = new byte[HeaderBytes];
            var word = ((uint)channel << ChannelShift) | ((uint)payloadKind << PayloadKindShift) | (uint)payloadLength;
            header[0] = (byte)(word >> 24);
            header[1] = (byte)(word >> 16);
            header[2] = (byte)(word >> 8);
            header[3] = (byte)word;
            var crc = ComputeCrc16(header, 0, 4);
            header[4] = (byte)(crc >> 8);
            header[5] = (byte)crc;
            return header;
        }

        /// <summary>编码完整帧（帧头 + 载荷）。</summary>
        public static byte[] EncodeFrame(VisualBridgeChannel channel, VisualBridgePayloadKind payloadKind, byte[] payload)
        {
            var body = payload ?? Array.Empty<byte>();
            var header = EncodeHeader(channel, payloadKind, body.Length);
            var frame = new byte[HeaderBytes + body.Length];
            Buffer.BlockCopy(header, 0, frame, 0, HeaderBytes);
            if (body.Length > 0)
            {
                Buffer.BlockCopy(body, 0, frame, HeaderBytes, body.Length);
            }

            return frame;
        }

        /// <summary>校验并解码偏移处的 6 字节帧头（CRC 先于长度校验）。</summary>
        public static void DecodeHeader(
            byte[] buffer,
            int offset,
            out VisualBridgeChannel channel,
            out VisualBridgePayloadKind payloadKind,
            out int payloadLength)
        {
            if (buffer == null)
            {
                throw new ArgumentNullException(nameof(buffer));
            }

            if (offset < 0 || offset + HeaderBytes > buffer.Length)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.Truncated,
                    "Frame header must be " + HeaderBytes + " bytes.");
            }

            var expected = (ushort)((buffer[offset + 4] << 8) | buffer[offset + 5]);
            var actual = ComputeCrc16(buffer, offset, 4);
            if (actual != expected)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.InvalidCrc,
                    "Frame header CRC mismatch: expected 0x" + expected.ToString("X4") + ", computed 0x" + actual.ToString("X4") + ".");
            }

            var word = ((uint)buffer[offset] << 24)
                | ((uint)buffer[offset + 1] << 16)
                | ((uint)buffer[offset + 2] << 8)
                | buffer[offset + 3];
            var channelValue = (byte)(word >> ChannelShift);
            var payloadKindValue = (byte)((word >> PayloadKindShift) & 0x3);
            var length = (int)(word & MaxPayloadLength);
            if (channelValue != (byte)VisualBridgeChannel.Editor && channelValue != (byte)VisualBridgeChannel.Debug)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.InvalidChannel,
                    "Unknown channel " + channelValue + ".");
            }

            if (payloadKindValue != (byte)VisualBridgePayloadKind.Binary && payloadKindValue != (byte)VisualBridgePayloadKind.Json)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.InvalidPayloadKind,
                    "Unknown payload kind " + payloadKindValue + ".");
            }

            if (length > MaxMessageBytes)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.PayloadTooLarge,
                    "Payload length " + length + " exceeds the " + MaxMessageBytes + "-byte limit.");
            }

            channel = (VisualBridgeChannel)channelValue;
            payloadKind = (VisualBridgePayloadKind)payloadKindValue;
            payloadLength = length;
        }

        private static void ValidateChannel(VisualBridgeChannel channel)
        {
            if (channel != VisualBridgeChannel.Editor && channel != VisualBridgeChannel.Debug)
            {
                throw new VisualBridgeFrameException(VisualBridgeFrameErrorCode.InvalidChannel, "Unknown channel " + (byte)channel + ".");
            }
        }

        private static void ValidatePayloadKind(VisualBridgePayloadKind payloadKind)
        {
            if (payloadKind != VisualBridgePayloadKind.Binary && payloadKind != VisualBridgePayloadKind.Json)
            {
                throw new VisualBridgeFrameException(
                    VisualBridgeFrameErrorCode.InvalidPayloadKind,
                    "Unknown payload kind " + (byte)payloadKind + ".");
            }
        }

        private static ushort[] BuildCrcTable()
        {
            var table = new ushort[256];
            for (var index = 0; index < table.Length; index++)
            {
                var value = index << 8;
                for (var bit = 0; bit < 8; bit++)
                {
                    value = (value & 0x8000) != 0
                        ? ((value << 1) ^ CrcPolynomial) & 0xFFFF
                        : (value << 1) & 0xFFFF;
                }

                table[index] = (ushort)value;
            }

            return table;
        }
    }

    /// <summary>
    /// 增量帧解码器：允许任意字节切分，只在读满帧头并校验通过后读取载荷。
    /// 任一步失败即抛 <see cref="VisualBridgeFrameException"/>；调用方必须断开。
    /// </summary>
    public sealed class VisualBridgeFrameReader
    {
        private const int InitialCapacity = 1024;

        private byte[] buffer = new byte[InitialCapacity];
        private int length;

        /// <summary>尚未成帧的残留字节数（EOF 时非零表示长度与实际不符）。</summary>
        public int BufferedByteCount => length;

        public void Append(byte[] source, int offset, int count)
        {
            if (source == null)
            {
                throw new ArgumentNullException(nameof(source));
            }

            if (count <= 0)
            {
                return;
            }

            EnsureCapacity(length + count);
            Buffer.BlockCopy(source, offset, buffer, length, count);
            length += count;
        }

        /// <summary>尝试读出一个完整帧；数据不足返回 false，协议错误抛异常。</summary>
        public bool TryReadFrame(out VisualBridgeFrame frame)
        {
            frame = null;
            if (length < VisualBridgeFraming.HeaderBytes)
            {
                return false;
            }

            VisualBridgeFraming.DecodeHeader(
                buffer,
                0,
                out var channel,
                out var payloadKind,
                out var payloadLength);
            var frameLength = VisualBridgeFraming.HeaderBytes + payloadLength;
            if (length < frameLength)
            {
                return false;
            }

            var payload = payloadLength == 0 ? Array.Empty<byte>() : new byte[payloadLength];
            if (payloadLength > 0)
            {
                Buffer.BlockCopy(buffer, VisualBridgeFraming.HeaderBytes, payload, 0, payloadLength);
            }

            length -= frameLength;
            if (length > 0)
            {
                Buffer.BlockCopy(buffer, frameLength, buffer, 0, length);
            }

            frame = new VisualBridgeFrame
            {
                Channel = channel,
                PayloadKind = payloadKind,
                Payload = payload,
            };
            return true;
        }

        /// <summary>丢弃未成帧的残留字节（连接失败路径）。</summary>
        public void DiscardPending()
        {
            length = 0;
        }

        private void EnsureCapacity(int required)
        {
            if (buffer.Length >= required)
            {
                return;
            }

            var capacity = buffer.Length;
            while (capacity < required)
            {
                capacity *= 2;
            }

            Array.Resize(ref buffer, capacity);
        }
    }
}
