using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Debug
{
    /// <summary>NDJSON 成帧器：一条消息一行 UTF-8 JSON。</summary>
    public sealed class NdjsonFramer : IDebugFramer
    {
        /// <summary>单行最大字节数（不含换行）。</summary>
        public const int MaxLineBytes = 1_048_576;

        /// <summary>将消息编码为以 \n 结尾的一行 UTF-8 JSON。</summary>
        public byte[] Frame(in DebugMessageHeader header, IDebugMessageBody body)
        {
            string json = BuildJson(header, body);
            int byteCount = Encoding.UTF8.GetByteCount(json);
            if (byteCount > MaxLineBytes)
            {
                throw new VisualBridgeDebugProtocolException(
                    $"调试消息超过 {MaxLineBytes} 字节上限：{byteCount}。");
            }

            var result = new byte[byteCount + 1];
            Encoding.UTF8.GetBytes(json, 0, json.Length, result, 0);
            result[byteCount] = (byte)'\n';
            return result;
        }

        /// <summary>从缓冲区解析一条完整消息；半包返回 false。</summary>
        public bool TryParse(
            ReadOnlySpan<byte> buffer,
            out int consumed,
            out DebugMessageHeader header,
            out IDebugMessageBody body)
        {
            consumed = 0;
            header = default;
            body = null;

            int offset = 0;
            while (true)
            {
                int newline = buffer.Slice(offset).IndexOf((byte)'\n');
                if (newline < 0)
                {
                    // 没有完整行：不消费半包，已跳过的空白行计入 consumed。
                    consumed = offset;
                    return false;
                }

                int lineEnd = offset + newline;
                int lineLength = lineEnd - offset;
                if (lineLength > 0 && buffer[lineEnd - 1] == (byte)'\r')
                {
                    lineLength--;
                }

                int next = lineEnd + 1;
                ReadOnlySpan<byte> line = buffer.Slice(offset, lineLength);
                if (IsBlank(line))
                {
                    offset = next;
                    consumed = offset;
                    continue;
                }

                if (lineLength > MaxLineBytes)
                {
                    throw new VisualBridgeDebugProtocolException(
                        $"调试消息超过 {MaxLineBytes} 字节上限：{lineLength}。");
                }

                string json = Encoding.UTF8.GetString(line);
                header = ParseMessage(json, out body);
                consumed = next;
                return true;
            }
        }

        private static bool IsBlank(ReadOnlySpan<byte> line)
        {
            for (int i = 0; i < line.Length; i++)
            {
                byte value = line[i];
                if (value != (byte)' ' && value != (byte)'\t' && value != (byte)'\r')
                {
                    return false;
                }
            }

            return true;
        }

        private static string BuildJson(in DebugMessageHeader header, IDebugMessageBody body)
        {
            var writer = new StringWriter(CultureInfo.InvariantCulture);
            using (var json = new JsonTextWriter(writer))
            {
                json.Formatting = Formatting.None;
                json.WriteStartObject();

                switch (header.Kind)
                {
                    case DebugMessageKind.Debug:
                    case DebugMessageKind.DebugResult:
                        WriteArgsMessage(json, header, body);
                        break;
                    case DebugMessageKind.Instance:
                        WriteInstanceMessage(json, header, body);
                        break;
                    default:
                        throw new VisualBridgeDebugProtocolException(
                            $"未知调试消息类型：{header.Kind}。");
                }

                json.WriteEndObject();
            }

            return writer.ToString();
        }

        private static void WriteArgsMessage(JsonWriter json, in DebugMessageHeader header, IDebugMessageBody body)
        {
            if (!(body is DebugArgsBody argsBody))
            {
                throw new VisualBridgeDebugProtocolException("调试消息体与消息类型不匹配。");
            }

            WriteProperty(json, "type", header.Kind == DebugMessageKind.Debug ? "debug" : "debugResult");
            WriteProperty(json, "seq", header.Seq);
            WriteProperty(json, "category", header.Category);
            WriteProperty(json, "instance", header.Instance);
            WriteProperty(json, "interface", header.Interface);
            WriteProperty(json, "version", header.Version);
            WriteProperty(json, "method", header.Method);

            if (header.Kind == DebugMessageKind.DebugResult)
            {
                WriteProperty(json, "requestId", header.RequestId);
            }

            if (header.Frame >= 0)
            {
                WriteProperty(json, "frame", header.Frame);
            }

            json.WritePropertyName("args");
            json.WriteStartArray();
            IReadOnlyList<DebugArgValue> args = argsBody.Args;
            for (int i = 0; i < args.Count; i++)
            {
                WriteArg(json, args[i]);
            }

            json.WriteEndArray();
        }

        private static void WriteInstanceMessage(JsonWriter json, in DebugMessageHeader header, IDebugMessageBody body)
        {
            if (!(body is DebugInstanceBody instanceBody))
            {
                throw new VisualBridgeDebugProtocolException("调试消息体与消息类型不匹配。");
            }

            WriteProperty(json, "type", "debugInstance");
            WriteProperty(json, "seq", header.Seq);
            WriteProperty(json, "category", header.Category);
            WriteProperty(json, "instance", header.Instance);
            WriteProperty(json, "label", instanceBody.Label);

            json.WritePropertyName("keywords");
            json.WriteStartArray();
            IReadOnlyList<string> keywords = instanceBody.Keywords;
            for (int i = 0; i < keywords.Count; i++)
            {
                json.WriteValue(keywords[i]);
            }

            json.WriteEndArray();
        }

        private static void WriteProperty(JsonWriter json, string name, string value)
        {
            json.WritePropertyName(name);
            json.WriteValue(value);
        }

        private static void WriteProperty(JsonWriter json, string name, long value)
        {
            json.WritePropertyName(name);
            json.WriteValue(value);
        }

        private static void WriteProperty(JsonWriter json, string name, int value)
        {
            json.WritePropertyName(name);
            json.WriteValue(value);
        }

        private static void WriteArg(JsonWriter json, DebugArgValue arg)
        {
            json.WriteStartObject();
            json.WritePropertyName("name");
            json.WriteValue(arg.Name);
            json.WritePropertyName("value");

            object value = arg.Value;
            if (value == null)
            {
                json.WriteNull();
            }
            else
            {
                WriteArgValue(json, arg.Kind, value);
            }

            json.WriteEndObject();
        }

        private static void WriteArgValue(JsonWriter json, DebugValueKind kind, object value)
        {
            switch (kind)
            {
                case DebugValueKind.Bool:
                    json.WriteValue(Convert.ToBoolean(value, CultureInfo.InvariantCulture));
                    break;
                case DebugValueKind.Int32:
                    json.WriteValue(Convert.ToInt32(value, CultureInfo.InvariantCulture));
                    break;
                case DebugValueKind.Int64:
                    json.WriteValue(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                    break;
                case DebugValueKind.UInt64:
                    json.WriteValue(Convert.ToUInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                    break;
                case DebugValueKind.Single:
                    json.WriteValue(Convert.ToSingle(value, CultureInfo.InvariantCulture));
                    break;
                case DebugValueKind.Double:
                    json.WriteValue(Convert.ToDouble(value, CultureInfo.InvariantCulture));
                    break;
                case DebugValueKind.String:
                    json.WriteValue(Convert.ToString(value, CultureInfo.InvariantCulture));
                    break;
                case DebugValueKind.Bytes:
                    if (value is byte[] bytes)
                    {
                        json.WriteValue(Convert.ToBase64String(bytes));
                    }
                    else
                    {
                        throw new VisualBridgeDebugProtocolException("字节参数的值必须是 byte[]。");
                    }

                    break;
                case DebugValueKind.Enum:
                    if (value is Enum enumValue)
                    {
                        json.WriteValue(enumValue.ToString());
                    }
                    else
                    {
                        json.WriteValue(Convert.ToString(value, CultureInfo.InvariantCulture));
                    }

                    break;
                default:
                    throw new VisualBridgeDebugProtocolException($"未知调试参数类型：{kind}。");
            }
        }

        private static DebugMessageHeader ParseMessage(string json, out IDebugMessageBody body)
        {
            JObject root;
            try
            {
                root = JObject.Parse(json);
            }
            catch (JsonException exception)
            {
                throw new VisualBridgeDebugProtocolException("无法解析调试消息。", exception);
            }

            JToken typeToken = root["type"];
            string type = ReadRawString(typeToken);
            switch (type)
            {
                case "debug":
                    return ParseArgsMessage(root, DebugMessageKind.Debug, out body);
                case "debugResult":
                    return ParseArgsMessage(root, DebugMessageKind.DebugResult, out body);
                case "debugInstance":
                    return ParseInstanceMessage(root, out body);
                default:
                    throw new VisualBridgeDebugProtocolException(
                        $"未知调试消息类型：{type ?? "<null>"}。");
            }
        }

        private static DebugMessageHeader ParseArgsMessage(JObject root, DebugMessageKind kind, out IDebugMessageBody body)
        {
            var args = new List<DebugArgValue>();
            JToken argsToken = root["args"];
            if (argsToken != null && argsToken.Type != JTokenType.Null)
            {
                if (argsToken.Type != JTokenType.Array)
                {
                    throw new VisualBridgeDebugProtocolException("调试消息的 args 必须是数组。");
                }

                foreach (JToken item in (JArray)argsToken)
                {
                    if (item.Type != JTokenType.Object)
                    {
                        throw new VisualBridgeDebugProtocolException("调试消息的参数项必须是对象。");
                    }

                    var arg = (JObject)item;
                    string name = ReadString(arg, "name");
                    int tag = ReadInt32(arg, "tag", 0);
                    args.Add(ParseArgValue(name, tag, arg["value"]));
                }
            }

            body = new DebugArgsBody(args);
            return ReadHeader(root, kind);
        }

        private static DebugMessageHeader ParseInstanceMessage(JObject root, out IDebugMessageBody body)
        {
            var keywords = new List<string>();
            JToken keywordsToken = root["keywords"];
            if (keywordsToken != null && keywordsToken.Type != JTokenType.Null)
            {
                if (keywordsToken.Type != JTokenType.Array)
                {
                    throw new VisualBridgeDebugProtocolException("调试实例的 keywords 必须是数组。");
                }

                foreach (JToken item in (JArray)keywordsToken)
                {
                    if (item.Type == JTokenType.Null)
                    {
                        keywords.Add(null);
                    }
                    else if (item.Type == JTokenType.String)
                    {
                        keywords.Add((string)item);
                    }
                    else
                    {
                        throw new VisualBridgeDebugProtocolException("调试实例的关键词必须是字符串。");
                    }
                }
            }

            string label = ReadString(root, "label") ?? string.Empty;
            body = new DebugInstanceBody(label, keywords);
            return ReadHeader(root, DebugMessageKind.Instance);
        }

        private static DebugMessageHeader ReadHeader(JObject root, DebugMessageKind kind)
        {
            string category = ReadString(root, "category");
            string instance = ReadString(root, "instance") ?? string.Empty;
            int version = ReadInt32(root, "version", 0);
            string iface = ReadString(root, "interface");
            string method = ReadString(root, "method");
            string requestId = ReadString(root, "requestId");
            long seq = ReadInt64(root, "seq", 0);
            long frame = ReadInt64(root, "frame", -1);

            return new DebugMessageHeader(
                kind,
                category,
                instance,
                version,
                iface,
                method,
                requestId,
                seq,
                frame);
        }

        private static DebugArgValue ParseArgValue(string name, int tag, JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Undefined)
            {
                return new DebugArgValue(name, tag, DebugValueKind.String, null);
            }

            switch (token.Type)
            {
                case JTokenType.Boolean:
                    return new DebugArgValue(name, tag, DebugValueKind.Bool, (bool)token);
                case JTokenType.Integer:
                {
                    long value = token.Value<long>();
                    if (value >= int.MinValue && value <= int.MaxValue)
                    {
                        return new DebugArgValue(name, tag, DebugValueKind.Int32, (int)value);
                    }

                    return new DebugArgValue(name, tag, DebugValueKind.Int64, value);
                }

                case JTokenType.Float:
                    return new DebugArgValue(name, tag, DebugValueKind.Double, token.Value<double>());
                case JTokenType.String:
                {
                    string text = (string)token;
                    if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long int64))
                    {
                        return new DebugArgValue(name, tag, DebugValueKind.Int64, int64);
                    }

                    if (ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out ulong uint64))
                    {
                        return new DebugArgValue(name, tag, DebugValueKind.UInt64, uint64);
                    }

                    return new DebugArgValue(name, tag, DebugValueKind.String, text);
                }

                default:
                    throw new VisualBridgeDebugProtocolException(
                        $"不支持的调试参数值类型：{token.Type}。");
            }
        }

        private static string ReadRawString(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null)
            {
                return null;
            }

            return token.Type == JTokenType.String ? (string)token : token.ToString();
        }

        private static string ReadString(JObject root, string name)
        {
            return ReadRawString(root[name]);
        }

        private static int ReadInt32(JObject root, string name, int fallback)
        {
            JToken token = root[name];
            if (token == null || token.Type == JTokenType.Null)
            {
                return fallback;
            }

            try
            {
                return token.Value<int>();
            }
            catch (Exception exception)
            {
                throw new VisualBridgeDebugProtocolException(
                    $"调试消息字段 {name} 格式错误。", exception);
            }
        }

        private static long ReadInt64(JObject root, string name, long fallback)
        {
            JToken token = root[name];
            if (token == null || token.Type == JTokenType.Null)
            {
                return fallback;
            }

            try
            {
                return token.Value<long>();
            }
            catch (Exception exception)
            {
                throw new VisualBridgeDebugProtocolException(
                    $"调试消息字段 {name} 格式错误。", exception);
            }
        }
    }
}
