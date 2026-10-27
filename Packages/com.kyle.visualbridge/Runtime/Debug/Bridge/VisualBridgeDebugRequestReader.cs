using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VisualBridge.Diagnostics.Bridge
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 入站 <c>request</c>（通道 1，JSON）的解析器（附录 A.2/A.5）：把信封与 <c>args</c> 解成
    /// <see cref="VisualBridgeDebugQueryRequest"/>，交给 <see cref="VisualBridgeDebugQueryRuntime.TryEnqueue"/>。
    /// 本程序集不能引用 Newtonsoft（<c>VisualBridge.Runtime</c> 是 overrideReferences 引用），因此带一个
    /// 只服务该信封的最小 JSON 读取器：对象/数组/字符串/数字/true/false/null，转义与代理对按 RFC 8259。
    /// </summary>
    public static class VisualBridgeDebugRequestReader
    {
        /// <summary>解析 <c>request</c> 信封；失败时 <paramref name="error"/> 说明原因（仅供日志与计数，不回线上）。</summary>
        public static bool TryRead(byte[] payload, out VisualBridgeDebugQueryRequest request, out string error)
        {
            request = null;
            error = null;
            if (payload == null || payload.Length == 0)
            {
                error = "empty-payload";
                return false;
            }

            // UTF-8 解码不会因非法字节抛异常（Encoding.UTF8 默认替换非法序列为 U+FFFD），
            // 因此这里不做异常兜底；真正的格式校验在下面的 JSON 读取器里。
            string text = Encoding.UTF8.GetString(payload);

            object root;
            try
            {
                root = VisualBridgeDebugJsonReader.Parse(text);
            }
            catch (FormatException exception)
            {
                error = "invalid-json: " + exception.Message;
                return false;
            }

            var envelope = root as Dictionary<string, object>;
            if (envelope == null)
            {
                error = "not-an-object";
                return false;
            }

            if (!string.Equals(Text(envelope, "type"), "request", StringComparison.Ordinal))
            {
                error = "not-a-request";
                return false;
            }

            if (!string.Equals(Text(envelope, "action"), "debugQuery", StringComparison.Ordinal))
            {
                error = "unknown-action";
                return false;
            }

            uint requestSeq;
            if (!TryParseRequestId(Text(envelope, "requestId"), out requestSeq) || requestSeq == 0u)
            {
                error = "invalid-request-id";
                return false;
            }

            string instanceId = Text(envelope, "instance");
            if (string.IsNullOrEmpty(instanceId))
            {
                error = "missing-instance";
                return false;
            }

            if (!TryReadArguments(envelope, out var arguments, out error))
            {
                return false;
            }

            // JSON 信封没有 methodId（附录 A.5）：方法号只在二进制信封里，而 D4 的声明表只能按
            // methodId 取（TryGetParameters(methodId)），methodId=0 恒不命中 —— JSON 降级路径下
            // **所有**查询（含无参）都无法分发到生成代码，这是 E6 的前置缺口（见实现说明 risks）。
            request = new VisualBridgeDebugQueryRequest(
                requestSeq,
                Text(envelope, "category"),
                instanceId,
                0,
                0,
                Text(envelope, "iface"),
                Text(envelope, "method"),
                arguments);
            return true;
        }

        private static bool TryReadArguments(Dictionary<string, object> envelope, out List<VisualBridgeDebugQueryArgument> arguments,
            out string error)
        {
            arguments = new List<VisualBridgeDebugQueryArgument>();
            error = null;
            if (!envelope.TryGetValue("args", out var raw) || raw == null)
            {
                return true;
            }

            var items = raw as List<object>;
            if (items == null)
            {
                error = "args-not-an-array";
                return false;
            }

            for (int index = 0; index < items.Count; index++)
            {
                var item = items[index] as Dictionary<string, object>;
                if (item == null)
                {
                    error = "arg-not-an-object";
                    return false;
                }

                if (!item.TryGetValue("tag", out var tagValue) || !(tagValue is double tagNumber))
                {
                    error = "arg-missing-tag";
                    return false;
                }

                // A.5 的 tag 是 u16：1.5 这类非整数不能被静默截断成 1（与 int 参数的 Math.Floor 判定同构）。
                int tag = (int)tagNumber;
                if (tag < 0 || tag > ushort.MaxValue || Math.Floor(tagNumber) != tagNumber)
                {
                    error = "arg-tag-out-of-range";
                    return false;
                }

                object decoded;
                if (!TryDecodeArgument(item, out decoded, out error))
                {
                    return false;
                }

                arguments.Add(new VisualBridgeDebugQueryArgument((ushort)tag, Text(item, "name"), decoded));
            }

            return true;
        }

        /// <summary>按 <c>args[].type</c> 的线上类型名解码（附录 A.4 的 type 码表与 JSON 表示）。</summary>
        private static bool TryDecodeArgument(Dictionary<string, object> item, out object value, out string error)
        {
            value = null;
            error = null;
            string type = Text(item, "type");
            if (type == null)
            {
                error = "arg-missing-type";
                return false;
            }

            item.TryGetValue("value", out var raw);
            switch (type)
            {
                case "bool":
                    if (!(raw is bool))
                    {
                        error = "arg-bool-mismatch";
                        return false;
                    }

                    value = raw;
                    return true;

                case "int":
                    if (!(raw is double intNumber) || intNumber < int.MinValue || intNumber > int.MaxValue
                        || Math.Floor(intNumber) != intNumber)
                    {
                        error = "arg-int-mismatch";
                        return false;
                    }

                    value = (int)intNumber;
                    return true;

                case "long":
                    return TryParseInt64(raw, out value, out error, "arg-long-mismatch");

                case "ulong":
                    return TryParseUInt64(raw, out value, out error, "arg-ulong-mismatch");

                case "float":
                    if (!TryReadDouble(raw, out double floatNumber))
                    {
                        error = "arg-float-mismatch";
                        return false;
                    }

                    value = (float)floatNumber;
                    return true;

                case "double":
                    if (!TryReadDouble(raw, out double doubleNumber))
                    {
                        error = "arg-double-mismatch";
                        return false;
                    }

                    value = doubleNumber;
                    return true;

                case "enum":
                    // A.4：JSON 里枚举写成员名，未命名值写底层十进制字符串；解析成枚举由运行期按声明类型完成。
                    if (!(raw is string))
                    {
                        error = "arg-enum-mismatch";
                        return false;
                    }

                    value = raw;
                    return true;

                case "string":
                    if (raw != null && !(raw is string))
                    {
                        error = "arg-string-mismatch";
                        return false;
                    }

                    value = raw;
                    return true;

                case "byte[]":
                    if (raw is string base64)
                    {
                        try
                        {
                            value = Convert.FromBase64String(base64);
                            return true;
                        }
                        catch (FormatException)
                        {
                            error = "arg-bytes-mismatch";
                            return false;
                        }
                    }

                    if (raw == null)
                    {
                        value = null;
                        return true;
                    }

                    error = "arg-bytes-mismatch";
                    return false;

                default:
                    error = "arg-unknown-type: " + type;
                    return false;
            }
        }

        private static bool TryParseInt64(object raw, out object value, out string error, string mismatch)
        {
            value = null;
            error = null;
            var text = raw as string;
            if (text != null && long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long parsed))
            {
                value = parsed;
                return true;
            }

            error = mismatch;
            return false;
        }

        private static bool TryParseUInt64(object raw, out object value, out string error, string mismatch)
        {
            value = null;
            error = null;
            var text = raw as string;
            if (text != null && ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out ulong parsed))
            {
                value = parsed;
                return true;
            }

            error = mismatch;
            return false;
        }

        /// <summary>number，或 A.4 规定的特值字符串（<c>NaN</c> / <c>Infinity</c> / <c>-Infinity</c>）。</summary>
        private static bool TryReadDouble(object raw, out double value)
        {
            value = 0;
            if (raw is double number)
            {
                value = number;
                return true;
            }

            var text = raw as string;
            if (text == null)
            {
                return false;
            }

            switch (text)
            {
                case "NaN":
                    value = double.NaN;
                    return true;
                case "Infinity":
                    value = double.PositiveInfinity;
                    return true;
                case "-Infinity":
                    value = double.NegativeInfinity;
                    return true;
            }

            return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        private static bool TryParseRequestId(string text, out uint requestSeq)
        {
            requestSeq = 0u;
            if (text == null || !text.StartsWith("req-", StringComparison.Ordinal))
            {
                return false;
            }

            return uint.TryParse(text.Substring(4), NumberStyles.Integer, CultureInfo.InvariantCulture, out requestSeq);
        }

        private static string Text(Dictionary<string, object> container, string key)
        {
            if (container.TryGetValue(key, out var value) && value is string text)
            {
                return text;
            }

            return null;
        }
    }

    /// <summary>
    /// 最小 JSON 读取器（只服务调试入站信封）：对象 → <see cref="Dictionary{TKey,TValue}"/>（ordinal）、
    /// 数组 → <see cref="List{T}"/>、数字 → <see cref="double"/>、字符串/布尔/null 原生。
    /// 非法输入抛 <see cref="FormatException"/>（调用方按 invalidRequest 计数丢弃）。
    /// 嵌套深度上限 <see cref="MaxDepth"/>：递归下降解析深嵌套载荷会爆栈（不可捕获、进程直接死），
    /// 入站载荷来自对端，必须先限深再递归。
    /// </summary>
    internal static class VisualBridgeDebugJsonReader
    {
        /// <summary>嵌套深度上限（信封本身只有 3 层，32 层足够宽松）。</summary>
        internal const int MaxDepth = 32;

        internal static object Parse(string text)
        {
            int index = 0;
            var value = ParseValue(text, ref index, 0);
            SkipWhitespace(text, ref index);
            if (index != text.Length)
            {
                throw new FormatException("Trailing characters at offset " + index + ".");
            }

            return value;
        }

        private static object ParseValue(string text, ref int index, int depth)
        {
            if (depth > MaxDepth)
            {
                throw new FormatException("Nesting deeper than " + MaxDepth + " levels.");
            }

            SkipWhitespace(text, ref index);
            if (index >= text.Length)
            {
                throw new FormatException("Unexpected end of input.");
            }

            char character = text[index];
            switch (character)
            {
                case '{':
                    return ParseObject(text, ref index, depth + 1);
                case '[':
                    return ParseArray(text, ref index, depth + 1);
                case '"':
                    return ParseString(text, ref index);
                case 't':
                    Expect(text, ref index, "true");
                    return true;
                case 'f':
                    Expect(text, ref index, "false");
                    return false;
                case 'n':
                    Expect(text, ref index, "null");
                    return null;
                default:
                    return ParseNumber(text, ref index);
            }
        }

        private static Dictionary<string, object> ParseObject(string text, ref int index, int depth)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            index++; // '{'
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == '}')
            {
                index++;
                return result;
            }

            while (true)
            {
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != '"')
                {
                    throw new FormatException("Expected a property name at offset " + index + ".");
                }

                string key = ParseString(text, ref index);
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != ':')
                {
                    throw new FormatException("Expected ':' at offset " + index + ".");
                }

                index++;
                result[key] = ParseValue(text, ref index, depth);
                SkipWhitespace(text, ref index);
                if (index >= text.Length)
                {
                    throw new FormatException("Unterminated object.");
                }

                if (text[index] == ',')
                {
                    index++;
                    continue;
                }

                if (text[index] == '}')
                {
                    index++;
                    return result;
                }

                throw new FormatException("Expected ',' or '}' at offset " + index + ".");
            }
        }

        private static List<object> ParseArray(string text, ref int index, int depth)
        {
            var result = new List<object>();
            index++; // '['
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == ']')
            {
                index++;
                return result;
            }

            while (true)
            {
                result.Add(ParseValue(text, ref index, depth));
                SkipWhitespace(text, ref index);
                if (index >= text.Length)
                {
                    throw new FormatException("Unterminated array.");
                }

                if (text[index] == ',')
                {
                    index++;
                    continue;
                }

                if (text[index] == ']')
                {
                    index++;
                    return result;
                }

                throw new FormatException("Expected ',' or ']' at offset " + index + ".");
            }
        }

        private static string ParseString(string text, ref int index)
        {
            index++; // '"'
            var builder = new StringBuilder();
            while (true)
            {
                if (index >= text.Length)
                {
                    throw new FormatException("Unterminated string.");
                }

                char character = text[index++];
                if (character == '"')
                {
                    return builder.ToString();
                }

                if (character != '\\')
                {
                    builder.Append(character);
                    continue;
                }

                if (index >= text.Length)
                {
                    throw new FormatException("Unterminated escape sequence.");
                }

                char escape = text[index++];
                switch (escape)
                {
                    case '"':
                    case '\\':
                    case '/':
                        builder.Append(escape);
                        break;
                    case 'b':
                        builder.Append('\b');
                        break;
                    case 'f':
                        builder.Append('\f');
                        break;
                    case 'n':
                        builder.Append('\n');
                        break;
                    case 'r':
                        builder.Append('\r');
                        break;
                    case 't':
                        builder.Append('\t');
                        break;
                    case 'u':
                        if (index + 4 > text.Length)
                        {
                            throw new FormatException("Truncated \\u escape.");
                        }

                        if (!ushort.TryParse(text.Substring(index, 4), NumberStyles.HexNumber,
                                CultureInfo.InvariantCulture, out ushort codeUnit))
                        {
                            throw new FormatException("Invalid \\u escape.");
                        }

                        builder.Append((char)codeUnit);
                        index += 4;
                        break;
                    default:
                        throw new FormatException("Invalid escape '\\" + escape + "'.");
                }
            }
        }

        private static double ParseNumber(string text, ref int index)
        {
            int start = index;
            if (index < text.Length && (text[index] == '-' || text[index] == '+'))
            {
                index++;
            }

            while (index < text.Length)
            {
                char character = text[index];
                if ((character >= '0' && character <= '9') || character == '.' || character == 'e' || character == 'E'
                    || character == '+' || character == '-')
                {
                    index++;
                    continue;
                }

                break;
            }

            if (index == start)
            {
                throw new FormatException("Unexpected character '" + text[start] + "' at offset " + start + ".");
            }

            if (!double.TryParse(text.Substring(start, index - start), NumberStyles.Float, CultureInfo.InvariantCulture,
                    out double value))
            {
                throw new FormatException("Invalid number at offset " + start + ".");
            }

            return value;
        }

        private static void Expect(string text, ref int index, string literal)
        {
            if (index + literal.Length > text.Length
                || string.CompareOrdinal(text, index, literal, 0, literal.Length) != 0)
            {
                throw new FormatException("Expected '" + literal + "' at offset " + index + ".");
            }

            index += literal.Length;
        }

        private static void SkipWhitespace(string text, ref int index)
        {
            while (index < text.Length)
            {
                char character = text[index];
                if (character != ' ' && character != '\t' && character != '\n' && character != '\r')
                {
                    return;
                }

                index++;
            }
        }
    }
#endif
}
