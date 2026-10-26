using System;
using System.Globalization;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 请求参数解码（附录 B.6）：按生成代码给出的声明表（tag → 声明顺序 + CLR 类型）把
    /// 信封 args 重排成业务方法的参数数组；缺省 tag 用该类型的默认值补齐。
    /// 这里不做线格式解析：值已由传输层解成 CLR 值（E4/E6），只做枚举与数值的容错收窄。
    /// </summary>
    internal static class VisualBridgeDebugRequestArguments
    {
        /// <summary>解码请求参数；失败时 <paramref name="error"/> 说明原因，供失败应答的 detail。</summary>
        internal static bool TryDecode(VisualBridgeDebugRequestRegistration registration,
            VisualBridgeDebugQueryRequest request, out object[] parameters, out string error)
        {
            parameters = null;
            error = null;
            if (registration == null)
            {
                error = "handler-unregistered";
                return false;
            }

            if (!registration.TryGetParameters(request.MethodId, out var names, out var tags, out var types))
            {
                // 没有声明表就无法按契约解码；只有无载荷参数的请求还能照常分发。
                if (request.Arguments != null && request.Arguments.Count != 0)
                {
                    error = "method-unknown: " + request.MethodId.ToString(CultureInfo.InvariantCulture);
                    return false;
                }

                parameters = new object[0];
                return true;
            }

            var values = new object[types.Length];
            for (int index = 0; index < types.Length; index++)
            {
                values[index] = DefaultValue(types[index]);
            }

            var arguments = request.Arguments;
            if (arguments != null)
            {
                for (int index = 0; index < arguments.Count; index++)
                {
                    var argument = arguments[index];
                    int target = IndexOfTag(tags, argument.Tag);
                    if (target < 0)
                    {
                        error = "unknown-tag: " + argument.Tag.ToString(CultureInfo.InvariantCulture);
                        return false;
                    }

                    if (!TryConvert(argument.Value, types[target], out values[target]))
                    {
                        error = "type-mismatch: " + names[target];
                        return false;
                    }
                }
            }

            parameters = values;
            return true;
        }

        private static int IndexOfTag(ushort[] tags, ushort tag)
        {
            for (int index = 0; index < tags.Length; index++)
            {
                if (tags[index] == tag)
                {
                    return index;
                }
            }

            return -1;
        }

        /// <summary>缺省参数用声明类型的默认值：值类型 default(T)，引用类型 null。</summary>
        private static object DefaultValue(Type type)
        {
            return type.IsValueType ? Activator.CreateInstance(type) : null;
        }

        /// <summary>
        /// 把线上解出来的值收窄到声明类型：同类型直接用；枚举接受底层整型；其余走 IConvertible
        /// （uint→long、short→int 等由这份容错兜底，生成代码仍按 A.4 显式收窄）。
        /// </summary>
        private static bool TryConvert(object value, Type target, out object converted)
        {
            converted = null;
            if (target == null)
            {
                return false;
            }

            if (value == null)
            {
                return !target.IsValueType;
            }

            if (target.IsInstanceOfType(value))
            {
                converted = value;
                return true;
            }

            if (target.IsEnum)
            {
                if (value is string)
                {
                    return false;
                }

                try
                {
                    converted = Enum.ToObject(target, value);
                    return true;
                }
                catch (Exception)
                {
                    return false;
                }
            }

            if (value is IConvertible && typeof(IConvertible).IsAssignableFrom(target))
            {
                try
                {
                    converted = Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
                    return true;
                }
                catch (Exception)
                {
                    return false;
                }
            }

            return false;
        }
    }
#endif
}
