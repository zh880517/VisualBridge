using System;
using System.Collections.Generic;
using System.Text;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 二进制编码器（附录 A.4/B.4）：
    /// 方法号 u16 + 槽位 u16 + [请求号 u32，仅 debugResult] + 参数区（tag u16 + type u8 + value，按 tag 升序）。
    /// 参数区稀疏（默认值不写）；多字节整数一律大端（网络序）；string 用 u16 长度、byte[] 用 u32 长度。
    /// 超过 1 MB 时返回 TooLarge，且不会先分配完整载荷再丢弃。
    /// </summary>
    public sealed class VisualBridgeDebugBinaryEncoder : IDebugMessageEncoder
    {
        private readonly List<BinaryParam> _parameters = new List<BinaryParam>();

        private VisualBridgeDebugMessageKind _kind;
        private ushort _methodId;
        private ushort _instanceSlot;
        private uint _requestId;
        private bool _begun;
        private VisualBridgeDebugEncodeStatus _status;

        public void Begin(
            VisualBridgeDebugMessageKind kind,
            string instanceId,
            string category,
            string iface,
            string method,
            ushort methodId,
            ushort instanceSlot,
            uint requestId)
        {
            _kind = kind;
            _methodId = methodId;
            _instanceSlot = instanceSlot;
            _requestId = requestId;
            _parameters.Clear();
            _begun = true;
            _status = VisualBridgeDebugEncodeStatus.Ok;
        }

        public void PushParam(string name, ushort tag, object value)
        {
            if (_status != VisualBridgeDebugEncodeStatus.Ok || !_begun)
            {
                return;
            }

            // 稀疏编码：默认值不写（门面层已经跳过，这里再防御一次直接调用编码器的场景）。
            if (VisualBridgeDebugParamTypes.IsDefault(value))
            {
                return;
            }

            if (!VisualBridgeDebugParamTypes.TryGetWireType(value, out var type))
            {
                _status = VisualBridgeDebugEncodeStatus.UnsupportedValue;
                return;
            }

            if (type == VisualBridgeDebugWireType.String)
            {
                // 二进制 string 的长度字段是 u16，无法表达超过 65535 字节的 UTF-8 串。
                if (Encoding.UTF8.GetByteCount((string)value) > VisualBridgeDebugPayloadLimits.MaxStringBytes)
                {
                    _status = VisualBridgeDebugEncodeStatus.LengthOverflow;
                    return;
                }
            }
            else if (type == VisualBridgeDebugWireType.Enum)
            {
                if (!VisualBridgeDebugParamTypes.TryGetEnumUnderlyingSize((Enum)value, out _))
                {
                    _status = VisualBridgeDebugEncodeStatus.UnsupportedValue;
                    return;
                }
            }
            else if (type == VisualBridgeDebugWireType.ByteArray
                && ((byte[])value).Length > VisualBridgeDebugPayloadLimits.MaxMessageBytes)
            {
                // 连长度都装不进 1 MB：不必等到 End 再计算（也避免超大数组的加法溢出）。
                _status = VisualBridgeDebugEncodeStatus.TooLarge;
                return;
            }

            _parameters.Add(new BinaryParam(tag, type, value));
        }

        public VisualBridgeDebugEncodedMessage End()
        {
            if (!_begun)
            {
                return Dropped(VisualBridgeDebugEncodeStatus.UnsupportedValue);
            }

            _begun = false;
            if (_status != VisualBridgeDebugEncodeStatus.Ok)
            {
                return Dropped(_status);
            }

            _parameters.Sort(static (left, right) => left.Tag.CompareTo(right.Tag));

            int size = 4 + (_kind == VisualBridgeDebugMessageKind.DebugResult ? 4 : 0);
            for (int index = 0; index < _parameters.Count; index++)
            {
                var parameter = _parameters[index];
                if (!TryGetValueSize(parameter, out long valueSize))
                {
                    _status = VisualBridgeDebugEncodeStatus.UnsupportedValue;
                    return Dropped(_status);
                }

                size += (int)(3 + valueSize);
                if (size > VisualBridgeDebugPayloadLimits.MaxMessageBytes)
                {
                    return Dropped(VisualBridgeDebugEncodeStatus.TooLarge);
                }
            }

            var payload = new byte[size];
            int offset = 0;
            WriteUInt16BigEndian(payload, ref offset, _methodId);
            WriteUInt16BigEndian(payload, ref offset, _instanceSlot);
            if (_kind == VisualBridgeDebugMessageKind.DebugResult)
            {
                WriteUInt32BigEndian(payload, ref offset, _requestId);
            }

            for (int index = 0; index < _parameters.Count; index++)
            {
                WriteParam(payload, ref offset, _parameters[index]);
            }

            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Binary,
                VisualBridgeDebugTargetQueue.Data,
                payload);
        }

        private static bool TryGetValueSize(BinaryParam parameter, out long size)
        {
            switch (parameter.Type)
            {
                case VisualBridgeDebugWireType.Bool:
                    size = 1;
                    return true;
                case VisualBridgeDebugWireType.Int:
                case VisualBridgeDebugWireType.Float:
                    size = 4;
                    return true;
                case VisualBridgeDebugWireType.Long:
                case VisualBridgeDebugWireType.Ulong:
                case VisualBridgeDebugWireType.Double:
                    size = 8;
                    return true;
                case VisualBridgeDebugWireType.Enum:
                    if (!VisualBridgeDebugParamTypes.TryGetEnumUnderlyingSize((Enum)parameter.Value, out int enumSize))
                    {
                        size = 0;
                        return false;
                    }

                    size = enumSize;
                    return true;
                case VisualBridgeDebugWireType.String:
                    long stringBytes = Encoding.UTF8.GetByteCount((string)parameter.Value);
                    if (stringBytes > VisualBridgeDebugPayloadLimits.MaxStringBytes)
                    {
                        size = 0;
                        return false;
                    }

                    size = 2 + stringBytes;
                    return true;
                case VisualBridgeDebugWireType.ByteArray:
                    size = 4L + ((byte[])parameter.Value).Length;
                    return true;
                default:
                    size = 0;
                    return false;
            }
        }

        private static void WriteParam(byte[] payload, ref int offset, BinaryParam parameter)
        {
            WriteUInt16BigEndian(payload, ref offset, parameter.Tag);
            payload[offset++] = (byte)parameter.Type;
            switch (parameter.Type)
            {
                case VisualBridgeDebugWireType.Bool:
                    payload[offset++] = (byte)((bool)parameter.Value ? 1 : 0);
                    break;
                case VisualBridgeDebugWireType.Int:
                    WriteInt32BigEndian(payload, ref offset, (int)parameter.Value);
                    break;
                case VisualBridgeDebugWireType.Long:
                    WriteInt64BigEndian(payload, ref offset, (long)parameter.Value);
                    break;
                case VisualBridgeDebugWireType.Ulong:
                    WriteUInt64BigEndian(payload, ref offset, (ulong)parameter.Value);
                    break;
                case VisualBridgeDebugWireType.Float:
                    WriteUInt32BigEndian(payload, ref offset,
                        unchecked((uint)BitConverter.SingleToInt32Bits((float)parameter.Value)));
                    break;
                case VisualBridgeDebugWireType.Double:
                    WriteUInt64BigEndian(payload, ref offset,
                        unchecked((ulong)BitConverter.DoubleToInt64Bits((double)parameter.Value)));
                    break;
                case VisualBridgeDebugWireType.Enum:
                    WriteEnum(payload, ref offset, (Enum)parameter.Value);
                    break;
                case VisualBridgeDebugWireType.String:
                    WriteString(payload, ref offset, (string)parameter.Value);
                    break;
                case VisualBridgeDebugWireType.ByteArray:
                    WriteByteArray(payload, ref offset, (byte[])parameter.Value);
                    break;
            }
        }

        private static void WriteEnum(byte[] payload, ref int offset, Enum value)
        {
            VisualBridgeDebugParamTypes.TryGetEnumUnderlyingSize(value, out int size);
            if (VisualBridgeDebugParamTypes.IsSignedEnum(value))
            {
                WriteSignedBigEndian(payload, ref offset, Convert.ToInt64(value), size);
            }
            else
            {
                WriteUnsignedBigEndian(payload, ref offset, Convert.ToUInt64(value), size);
            }
        }

        private static void WriteString(byte[] payload, ref int offset, string value)
        {
            int bytes = Encoding.UTF8.GetByteCount(value);
            WriteUInt16BigEndian(payload, ref offset, (ushort)bytes);
            if (bytes != 0)
            {
                Encoding.UTF8.GetBytes(value, 0, value.Length, payload, offset);
                offset += bytes;
            }
        }

        private static void WriteByteArray(byte[] payload, ref int offset, byte[] value)
        {
            WriteUInt32BigEndian(payload, ref offset, (uint)value.Length);
            if (value.Length != 0)
            {
                Buffer.BlockCopy(value, 0, payload, offset, value.Length);
                offset += value.Length;
            }
        }

        private static void WriteSignedBigEndian(byte[] payload, ref int offset, long value, int width)
        {
            for (int shift = (width - 1) * 8; shift >= 0; shift -= 8)
            {
                payload[offset++] = (byte)(value >> shift);
            }
        }

        private static void WriteUnsignedBigEndian(byte[] payload, ref int offset, ulong value, int width)
        {
            for (int shift = (width - 1) * 8; shift >= 0; shift -= 8)
            {
                payload[offset++] = (byte)(value >> shift);
            }
        }

        private static void WriteInt32BigEndian(byte[] payload, ref int offset, int value)
        {
            WriteUnsignedBigEndian(payload, ref offset, unchecked((uint)value), 4);
        }

        private static void WriteInt64BigEndian(byte[] payload, ref int offset, long value)
        {
            WriteUnsignedBigEndian(payload, ref offset, unchecked((ulong)value), 8);
        }

        private static void WriteUInt16BigEndian(byte[] payload, ref int offset, ushort value)
        {
            payload[offset++] = (byte)(value >> 8);
            payload[offset++] = (byte)value;
        }

        private static void WriteUInt32BigEndian(byte[] payload, ref int offset, uint value)
        {
            payload[offset++] = (byte)(value >> 24);
            payload[offset++] = (byte)(value >> 16);
            payload[offset++] = (byte)(value >> 8);
            payload[offset++] = (byte)value;
        }

        private static void WriteUInt64BigEndian(byte[] payload, ref int offset, ulong value)
        {
            for (int shift = 56; shift >= 0; shift -= 8)
            {
                payload[offset++] = (byte)(value >> shift);
            }
        }

        private static VisualBridgeDebugEncodedMessage Dropped(VisualBridgeDebugEncodeStatus status)
        {
            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Binary,
                VisualBridgeDebugTargetQueue.Data,
                ReadOnlyMemory<byte>.Empty,
                status);
        }

        private readonly struct BinaryParam
        {
            internal BinaryParam(ushort tag, VisualBridgeDebugWireType type, object value)
            {
                Tag = tag;
                Type = type;
                Value = value;
            }

            internal ushort Tag { get; }

            internal VisualBridgeDebugWireType Type { get; }

            internal object Value { get; }
        }
    }
#endif
}
