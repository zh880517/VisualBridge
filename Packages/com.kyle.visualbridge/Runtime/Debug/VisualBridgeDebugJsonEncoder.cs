using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// JSON 降级编码器（附录 A.5/B.4）：产出一条完整的 debug / debugResult JSON 载荷。
    /// 值表示与二进制共用同一份默认值规则：long/ulong 用字符串、enum 用成员名、byte[] 用 base64；
    /// 载荷超过 1 MB 时返回 TooLarge，且不会为大字符串/大字节数组先分配转码结果。
    /// </summary>
    public sealed class VisualBridgeDebugJsonEncoder : IDebugMessageEncoder
    {
        private readonly List<JsonParam> _parameters = new List<JsonParam>();
        private readonly StringBuilder _builder = new StringBuilder(256);

        private VisualBridgeDebugMessageKind _kind;
        private string _instanceId;
        private string _category;
        private string _iface;
        private string _method;
        private uint _requestId;
        private int _length;
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
            _instanceId = instanceId ?? string.Empty;
            _category = category;
            _iface = iface;
            _method = method;
            _requestId = requestId;
            _parameters.Clear();
            _builder.Clear();
            _length = 0;
            _begun = true;
            _status = VisualBridgeDebugEncodeStatus.Ok;
        }

        public void PushParam(string name, ushort tag, object value)
        {
            if (_status != VisualBridgeDebugEncodeStatus.Ok || !_begun)
            {
                return;
            }

            // 稀疏编码：默认值不占字节（门面层已经跳过，这里再防御一次直接调用编码器的场景）。
            if (VisualBridgeDebugParamTypes.IsDefault(value))
            {
                return;
            }

            if (!VisualBridgeDebugParamTypes.TryGetWireType(value, out var type))
            {
                _status = VisualBridgeDebugEncodeStatus.UnsupportedValue;
                return;
            }

            // 1 MB 上限的提前判定：避免超大 byte[] 转 base64、超长字符串扫描转义后再丢弃。
            if (type == VisualBridgeDebugWireType.ByteArray
                && ((byte[])value).Length > VisualBridgeDebugPayloadLimits.MaxMessageBytes)
            {
                _status = VisualBridgeDebugEncodeStatus.TooLarge;
                return;
            }

            if (type == VisualBridgeDebugWireType.String
                && ((string)value).Length > VisualBridgeDebugPayloadLimits.MaxMessageBytes)
            {
                _status = VisualBridgeDebugEncodeStatus.TooLarge;
                return;
            }

            _parameters.Add(new JsonParam(name ?? string.Empty, tag, type, value));
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

            // 按 tag 升序写出，与二进制参数区保持一致；JSON 的 args 顺序不是语义，但确定性输出便于比对。
            _parameters.Sort(static (left, right) => left.Tag.CompareTo(right.Tag));

            if (!TryBuild())
            {
                return Dropped(_status == VisualBridgeDebugEncodeStatus.Ok
                    ? VisualBridgeDebugEncodeStatus.TooLarge
                    : _status);
            }

            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Json,
                VisualBridgeDebugTargetQueue.Data,
                Encoding.UTF8.GetBytes(_builder.ToString()));
        }

        private bool TryBuild()
        {
            if (!TryAppendRaw("{\"type\":"))
            {
                return false;
            }

            if (!TryAppendJsonString(_kind == VisualBridgeDebugMessageKind.DebugResult ? "debugResult" : "debug"))
            {
                return false;
            }

            if (!TryAppendOptionalField("category", _category)
                || !TryAppendOptionalField("instance", _instanceId)
                || !TryAppendOptionalField("iface", _iface)
                || !TryAppendOptionalField("method", _method))
            {
                return false;
            }

            if (_kind == VisualBridgeDebugMessageKind.DebugResult)
            {
                // B.6 / A.5：JSON 的请求号是 "req-<n>"，二进制才是 u32；两侧语义一致。
                if (!TryAppendRaw(",\"requestId\":")
                    || !TryAppendJsonString("req-" + _requestId.ToString(CultureInfo.InvariantCulture)))
                {
                    return false;
                }
            }

            if (!TryAppendRaw(",\"args\":["))
            {
                return false;
            }

            for (int index = 0; index < _parameters.Count; index++)
            {
                if (index != 0 && !TryAppendRaw(","))
                {
                    return false;
                }

                var parameter = _parameters[index];
                if (!TryAppendRaw("{\"tag\":") || !TryAppendRaw(parameter.Tag.ToString(CultureInfo.InvariantCulture))
                    || !TryAppendRaw(",\"name\":") || !TryAppendJsonString(parameter.Name)
                    || !TryAppendRaw(",\"type\":") || !TryAppendJsonString(VisualBridgeDebugParamTypes.GetWireTypeName(parameter.Type))
                    || !TryAppendRaw(",\"value\":") || !TryAppendValue(parameter)
                    || !TryAppendRaw("}"))
                {
                    return false;
                }
            }

            return TryAppendRaw("]}");
        }

        private bool TryAppendOptionalField(string name, string value)
        {
            if (value == null)
            {
                return true;
            }

            return TryAppendRaw(",\"" + name + "\":") && TryAppendJsonString(value);
        }

        private bool TryAppendValue(JsonParam parameter)
        {
            switch (parameter.Type)
            {
                case VisualBridgeDebugWireType.Bool:
                    return TryAppendRaw((bool)parameter.Value ? "true" : "false");

                case VisualBridgeDebugWireType.Int:
                    return TryAppendRaw(((int)parameter.Value).ToString(CultureInfo.InvariantCulture));

                // long/ulong 超出 JS 安全整数范围，JSON 里统一用字符串（附录 A.4 的 JSON 表示）。
                case VisualBridgeDebugWireType.Long:
                    return TryAppendJsonString(((long)parameter.Value).ToString(CultureInfo.InvariantCulture));

                case VisualBridgeDebugWireType.Ulong:
                    return TryAppendJsonString(((ulong)parameter.Value).ToString(CultureInfo.InvariantCulture));

                case VisualBridgeDebugWireType.Float:
                    return TryAppendFloat((float)parameter.Value);

                case VisualBridgeDebugWireType.Double:
                    return TryAppendDouble((double)parameter.Value);

                case VisualBridgeDebugWireType.Enum:
                    return TryAppendEnum((Enum)parameter.Value);

                case VisualBridgeDebugWireType.String:
                    return TryAppendJsonString((string)parameter.Value);

                case VisualBridgeDebugWireType.ByteArray:
                    return TryAppendByteArray((byte[])parameter.Value);

                default:
                    _status = VisualBridgeDebugEncodeStatus.UnsupportedValue;
                    return false;
            }
        }

        private bool TryAppendFloat(float value)
        {
            if (float.IsNaN(value))
            {
                return TryAppendJsonString("NaN");
            }

            if (float.IsPositiveInfinity(value))
            {
                return TryAppendJsonString("Infinity");
            }

            if (float.IsNegativeInfinity(value))
            {
                return TryAppendJsonString("-Infinity");
            }

            // -0.0 必须与 +0.0 区分（附录 A.4）：显式写带小数点的 -0.0，避免 JSON 解析器把它当整数 0。
            if (BitConverter.SingleToInt32Bits(value) == unchecked((int)0x80000000))
            {
                return TryAppendRaw("-0.0");
            }

            return TryAppendRaw(value.ToString("R", CultureInfo.InvariantCulture));
        }

        private bool TryAppendDouble(double value)
        {
            if (double.IsNaN(value))
            {
                return TryAppendJsonString("NaN");
            }

            if (double.IsPositiveInfinity(value))
            {
                return TryAppendJsonString("Infinity");
            }

            if (double.IsNegativeInfinity(value))
            {
                return TryAppendJsonString("-Infinity");
            }

            if (BitConverter.DoubleToInt64Bits(value) == unchecked((long)0x8000000000000000))
            {
                return TryAppendRaw("-0.0");
            }

            return TryAppendRaw(value.ToString("R", CultureInfo.InvariantCulture));
        }

        private bool TryAppendEnum(Enum value)
        {
            string name = Enum.GetName(value.GetType(), value);
            if (name != null)
            {
                return TryAppendJsonString(name);
            }

            // 未命名的枚举值（含 flags 组合）：用底层十进制字符串，接收端可按契约回退。
            string raw = VisualBridgeDebugParamTypes.IsSignedEnum(value)
                ? Convert.ToInt64(value).ToString(CultureInfo.InvariantCulture)
                : Convert.ToUInt64(value).ToString(CultureInfo.InvariantCulture);
            return TryAppendJsonString(raw);
        }

        private bool TryAppendByteArray(byte[] value)
        {
            long base64Length = 4L * ((value.Length + 2L) / 3L);
            // 先按预算判断再转码，避免为大数组先分配 base64 字符串再丢弃（附录 B.2.1）。
            if (_length + base64Length + 2L > VisualBridgeDebugPayloadLimits.MaxMessageBytes)
            {
                _status = VisualBridgeDebugEncodeStatus.TooLarge;
                return false;
            }

            return TryAppendRaw("\"" + Convert.ToBase64String(value) + "\"");
        }

        private bool TryAppendJsonString(string value)
        {
            if (value == null)
            {
                return TryAppendRaw("null");
            }

            int escapedBytes = GetEscapedByteCount(value);
            if (_length + escapedBytes + 2 > VisualBridgeDebugPayloadLimits.MaxMessageBytes)
            {
                _status = VisualBridgeDebugEncodeStatus.TooLarge;
                return false;
            }

            _builder.Append('"');
            _length += 1;
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                switch (character)
                {
                    case '"':
                        _builder.Append("\\\"");
                        _length += 2;
                        break;
                    case '\\':
                        _builder.Append("\\\\");
                        _length += 2;
                        break;
                    case '\b':
                        _builder.Append("\\b");
                        _length += 2;
                        break;
                    case '\f':
                        _builder.Append("\\f");
                        _length += 2;
                        break;
                    case '\n':
                        _builder.Append("\\n");
                        _length += 2;
                        break;
                    case '\r':
                        _builder.Append("\\r");
                        _length += 2;
                        break;
                    case '\t':
                        _builder.Append("\\t");
                        _length += 2;
                        break;
                    default:
                        if (character < 0x20)
                        {
                            _builder.Append("\\u");
                            _builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                            _length += 6;
                        }
                        else if (char.IsHighSurrogate(character) && index + 1 < value.Length
                            && char.IsLowSurrogate(value[index + 1]))
                        {
                            // 代理对必须整体写出，UTF-8 占 4 字节。
                            _builder.Append(character);
                            _builder.Append(value[index + 1]);
                            _length += 4;
                            index++;
                        }
                        else
                        {
                            _builder.Append(character);
                            _length += character < 0x80 ? 1 : character < 0x800 ? 2 : 3;
                        }

                        break;
                }
            }

            _builder.Append('"');
            _length += 1;
            return true;
        }

        private bool TryAppendRaw(string value)
        {
            if (_length + value.Length > VisualBridgeDebugPayloadLimits.MaxMessageBytes)
            {
                _status = VisualBridgeDebugEncodeStatus.TooLarge;
                return false;
            }

            _builder.Append(value);
            _length += value.Length;
            return true;
        }

        /// <summary>JSON 转义后的 UTF-8 字节数；控制字符按 \\u00XX 计 6 字节。</summary>
        private static int GetEscapedByteCount(string value)
        {
            int bytes = Encoding.UTF8.GetByteCount(value);
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (character == '"' || character == '\\')
                {
                    bytes += 1;
                }
                else if (character < 0x20)
                {
                    bytes += character == '\b' || character == '\f' || character == '\n'
                        || character == '\r' || character == '\t'
                        ? 1
                        : 5;
                }
            }

            return bytes;
        }

        private static VisualBridgeDebugEncodedMessage Dropped(VisualBridgeDebugEncodeStatus status)
        {
            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Json,
                VisualBridgeDebugTargetQueue.Data,
                ReadOnlyMemory<byte>.Empty,
                status);
        }

        private readonly struct JsonParam
        {
            internal JsonParam(string name, ushort tag, VisualBridgeDebugWireType type, object value)
            {
                Name = name;
                Tag = tag;
                Type = type;
                Value = value;
            }

            internal string Name { get; }

            internal ushort Tag { get; }

            internal VisualBridgeDebugWireType Type { get; }

            internal object Value { get; }
        }
    }
#endif
}
