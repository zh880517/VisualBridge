using System;
using System.Collections.Generic;
using System.Globalization;

namespace VisualBridge.Diagnostics
{
    /// <summary>入站查询请求。</summary>
    public readonly struct VisualBridgeDebugRequest
    {
        private readonly IReadOnlyList<DebugArgValue> _args;

        internal VisualBridgeDebugRequest(DebugMessageHeader header, IReadOnlyList<DebugArgValue> args)
        {
            Category = header.Category;
            Interface = header.Interface;
            Version = header.Version;
            Method = header.Method;
            RequestId = header.RequestId;
            Instance = header.Instance;
            _args = args ?? Array.Empty<DebugArgValue>();
            ArgCount = _args.Count;
        }

        /// <summary>接口类别。</summary>
        public string Category { get; }

        /// <summary>接口全名。</summary>
        public string Interface { get; }

        /// <summary>接口版本。</summary>
        public int Version { get; }

        /// <summary>方法名。</summary>
        public string Method { get; }

        /// <summary>查询请求标识。</summary>
        public string RequestId { get; }

        /// <summary>调试实例标识。</summary>
        public string Instance { get; }

        /// <summary>参数个数。</summary>
        public int ArgCount { get; }

        /// <summary>参数列表（解析后的原始值）。</summary>
        public IReadOnlyList<DebugArgValue> Args
        {
            get { return _args ?? Array.Empty<DebugArgValue>(); }
        }

        /// <summary>
        /// 按 tag 取参数并按目标类型转换。
        /// 线格式不带 tag 时按位置取参（tag 作为下标），参数名/位置由生成代码保证。
        /// </summary>
        public bool TryGetArg<T>(int tag, out T value)
        {
            DebugArgValue arg;
            if (!TryFind(tag, out arg))
            {
                value = default;
                return false;
            }

            return TryConvert(arg.Value, out value);
        }

        /// <summary>按参数名取参数并按目标类型转换。</summary>
        public bool TryGetArg<T>(string name, out T value)
        {
            DebugArgValue arg;
            if (!TryFind(name, out arg))
            {
                value = default;
                return false;
            }

            return TryConvert(arg.Value, out value);
        }

        /// <summary>
        /// 按 tag 取解析后的原始值；找不到返回 null。
        /// 线格式不带 tag 时按位置取参（tag 作为下标），参数名/位置由生成代码保证。
        /// </summary>
        public object GetArg(int tag)
        {
            DebugArgValue arg;
            return TryFind(tag, out arg) ? arg.Value : null;
        }

        private bool TryFind(int tag, out DebugArgValue arg)
        {
            IReadOnlyList<DebugArgValue> args = Args;
            for (int i = 0; i < args.Count; i++)
            {
                if (args[i].Tag == tag)
                {
                    arg = args[i];
                    return true;
                }
            }

            // 线格式不带 tag（解析后均为 0），按位置取参；参数名/位置由生成代码保证。
            if (tag >= 0 && tag < args.Count)
            {
                arg = args[tag];
                return true;
            }

            arg = default;
            return false;
        }

        private bool TryFind(string name, out DebugArgValue arg)
        {
            if (name != null)
            {
                IReadOnlyList<DebugArgValue> args = Args;
                for (int i = 0; i < args.Count; i++)
                {
                    if (string.Equals(args[i].Name, name, StringComparison.Ordinal))
                    {
                        arg = args[i];
                        return true;
                    }
                }
            }

            arg = default;
            return false;
        }

        private static bool TryConvert<T>(object raw, out T value)
        {
            value = default;
            Type target = typeof(T);

            if (target == typeof(string))
            {
                string text;
                if (TryConvertString(raw, out text))
                {
                    value = (T)(object)text;
                    return true;
                }

                return false;
            }

            if (raw == null)
            {
                return false;
            }

            if (target == typeof(bool))
            {
                bool result;
                if (TryConvertBool(raw, out result))
                {
                    value = (T)(object)result;
                    return true;
                }

                return false;
            }

            if (target == typeof(int))
            {
                int result;
                if (TryConvertInt32(raw, out result))
                {
                    value = (T)(object)result;
                    return true;
                }

                return false;
            }

            if (target == typeof(long))
            {
                long result;
                if (TryConvertInt64(raw, out result))
                {
                    value = (T)(object)result;
                    return true;
                }

                return false;
            }

            if (target == typeof(ulong))
            {
                ulong result;
                if (TryConvertUInt64(raw, out result))
                {
                    value = (T)(object)result;
                    return true;
                }

                return false;
            }

            if (target == typeof(float))
            {
                float result;
                if (TryConvertSingle(raw, out result))
                {
                    value = (T)(object)result;
                    return true;
                }

                return false;
            }

            if (target == typeof(double))
            {
                double result;
                if (TryConvertDouble(raw, out result))
                {
                    value = (T)(object)result;
                    return true;
                }

                return false;
            }

            if (target == typeof(byte[]))
            {
                byte[] result;
                if (TryConvertBytes(raw, out result))
                {
                    value = (T)(object)result;
                    return true;
                }

                return false;
            }

            if (target.IsEnum)
            {
                object result;
                if (TryConvertEnum(target, raw, out result))
                {
                    value = (T)result;
                    return true;
                }

                return false;
            }

            return false;
        }

        private static bool TryConvertString(object raw, out string value)
        {
            if (raw == null)
            {
                value = null;
                return true;
            }

            if (raw is string text)
            {
                value = text;
                return true;
            }

            if (raw is bool flag)
            {
                value = flag ? "true" : "false";
                return true;
            }

            if (IsNumeric(raw))
            {
                value = Convert.ToString(raw, CultureInfo.InvariantCulture);
                return true;
            }

            value = null;
            return false;
        }

        private static bool TryConvertBool(object raw, out bool value)
        {
            if (raw is bool flag)
            {
                value = flag;
                return true;
            }

            if (raw is string text
                && bool.TryParse(text, out value))
            {
                return true;
            }

            value = false;
            return false;
        }

        private static bool TryConvertInt32(object raw, out int value)
        {
            value = 0;
            switch (raw)
            {
                case int v:
                    value = v;
                    return true;
                case long v:
                    if (v < int.MinValue || v > int.MaxValue)
                    {
                        return false;
                    }

                    value = (int)v;
                    return true;
                case double v:
                    return TryDoubleToInt32(v, out value);
                default:
                    return false;
            }
        }

        private static bool TryDoubleToInt32(double raw, out int value)
        {
            value = 0;
            if (double.IsNaN(raw) || double.IsInfinity(raw))
            {
                return false;
            }

            if (raw != Math.Truncate(raw) || raw < int.MinValue || raw > int.MaxValue)
            {
                return false;
            }

            value = (int)raw;
            return true;
        }

        private static bool TryConvertInt64(object raw, out long value)
        {
            value = 0;
            switch (raw)
            {
                case sbyte v:
                    value = v;
                    return true;
                case byte v:
                    value = v;
                    return true;
                case short v:
                    value = v;
                    return true;
                case ushort v:
                    value = v;
                    return true;
                case int v:
                    value = v;
                    return true;
                case uint v:
                    value = v;
                    return true;
                case long v:
                    value = v;
                    return true;
                case ulong v:
                    if (v > long.MaxValue)
                    {
                        return false;
                    }

                    value = (long)v;
                    return true;
                case float v:
                    return TryDoubleToInt64(v, out value);
                case double v:
                    return TryDoubleToInt64(v, out value);
                case decimal v:
                    return TryDoubleToInt64((double)v, out value);
                case string v:
                    return long.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
                default:
                    return false;
            }
        }

        private static bool TryDoubleToInt64(double raw, out long value)
        {
            value = 0;
            if (double.IsNaN(raw) || double.IsInfinity(raw))
            {
                return false;
            }

            if (raw != Math.Truncate(raw) || raw < long.MinValue || raw >= 9.2233720368547758E18)
            {
                return false;
            }

            value = (long)raw;
            return true;
        }

        private static bool TryConvertUInt64(object raw, out ulong value)
        {
            value = 0;
            switch (raw)
            {
                case byte v:
                    value = v;
                    return true;
                case ushort v:
                    value = v;
                    return true;
                case uint v:
                    value = v;
                    return true;
                case ulong v:
                    value = v;
                    return true;
                case sbyte v:
                    if (v < 0)
                    {
                        return false;
                    }

                    value = (ulong)v;
                    return true;
                case short v:
                    if (v < 0)
                    {
                        return false;
                    }

                    value = (ulong)v;
                    return true;
                case int v:
                    if (v < 0)
                    {
                        return false;
                    }

                    value = (ulong)v;
                    return true;
                case long v:
                    if (v < 0)
                    {
                        return false;
                    }

                    value = (ulong)v;
                    return true;
                case float v:
                    return TryDoubleToUInt64(v, out value);
                case double v:
                    return TryDoubleToUInt64(v, out value);
                case decimal v:
                    return TryDoubleToUInt64((double)v, out value);
                case string v:
                    return ulong.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
                default:
                    return false;
            }
        }

        private static bool TryDoubleToUInt64(double raw, out ulong value)
        {
            value = 0;
            if (double.IsNaN(raw) || double.IsInfinity(raw) || raw < 0)
            {
                return false;
            }

            if (raw != Math.Truncate(raw) || raw >= 1.8446744073709552E19)
            {
                return false;
            }

            value = (ulong)raw;
            return true;
        }

        private static bool TryConvertSingle(object raw, out float value)
        {
            value = 0;
            if (raw is float single)
            {
                value = single;
                return true;
            }

            double number;
            if (!TryConvertDouble(raw, out number))
            {
                return false;
            }

            value = (float)number;
            return true;
        }

        private static bool TryConvertDouble(object raw, out double value)
        {
            value = 0;
            switch (raw)
            {
                case sbyte v:
                    value = v;
                    return true;
                case byte v:
                    value = v;
                    return true;
                case short v:
                    value = v;
                    return true;
                case ushort v:
                    value = v;
                    return true;
                case int v:
                    value = v;
                    return true;
                case uint v:
                    value = v;
                    return true;
                case long v:
                    value = v;
                    return true;
                case ulong v:
                    value = v;
                    return true;
                case float v:
                    value = v;
                    return true;
                case double v:
                    value = v;
                    return true;
                case decimal v:
                    value = (double)v;
                    return true;
                default:
                    return false;
            }
        }

        private static bool TryConvertBytes(object raw, out byte[] value)
        {
            if (raw is byte[] bytes)
            {
                value = bytes;
                return true;
            }

            if (raw is string text)
            {
                try
                {
                    value = Convert.FromBase64String(text);
                    return true;
                }
                catch (FormatException)
                {
                    value = null;
                    return false;
                }
            }

            value = null;
            return false;
        }

        private static bool TryConvertEnum(Type target, object raw, out object value)
        {
            value = null;
            if (raw is string text)
            {
                try
                {
                    value = Enum.Parse(target, text, false);
                    return true;
                }
                catch (ArgumentException)
                {
                    return false;
                }
                catch (OverflowException)
                {
                    return false;
                }
            }

            long signed;
            if (TryConvertInt64(raw, out signed))
            {
                value = Enum.ToObject(target, signed);
                return true;
            }

            ulong unsigned;
            if (TryConvertUInt64(raw, out unsigned))
            {
                value = Enum.ToObject(target, unsigned);
                return true;
            }

            return false;
        }

        private static bool IsNumeric(object value)
        {
            switch (value)
            {
                case sbyte _:
                case byte _:
                case short _:
                case ushort _:
                case int _:
                case uint _:
                case long _:
                case ulong _:
                case float _:
                case double _:
                case decimal _:
                    return true;
                default:
                    return false;
            }
        }
    }
}
