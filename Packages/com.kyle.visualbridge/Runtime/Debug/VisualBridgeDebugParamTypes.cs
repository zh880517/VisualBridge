using System;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 参数区的线上类型码（附录 A.4 的 type 码表）：0 保留，1–9 对应九种声明类型。
    /// 枚举只占一个码，宽度由 debug-contracts.json 的 underlyingType 决定。
    /// </summary>
    internal enum VisualBridgeDebugWireType : byte
    {
        Bool = 1,
        Int = 2,
        Long = 3,
        Ulong = 4,
        Float = 5,
        Double = 6,
        Enum = 7,
        String = 8,
        ByteArray = 9,
    }

    /// <summary>
    /// 九种参数类型的运行时识别与默认值判定（附录 A.4）。
    /// 编码器只接受这九种装箱值：uint→long、short→int 等收窄必须由生成代码显式转换，
    /// 这里绝不调用 Convert 把任意 object 转成某个数值类型。
    /// </summary>
    internal static class VisualBridgeDebugParamTypes
    {
        internal static bool TryGetWireType(object value, out VisualBridgeDebugWireType type)
        {
            if (value is bool)
            {
                type = VisualBridgeDebugWireType.Bool;
                return true;
            }

            if (value is int)
            {
                type = VisualBridgeDebugWireType.Int;
                return true;
            }

            if (value is long)
            {
                type = VisualBridgeDebugWireType.Long;
                return true;
            }

            if (value is ulong)
            {
                type = VisualBridgeDebugWireType.Ulong;
                return true;
            }

            if (value is float)
            {
                type = VisualBridgeDebugWireType.Float;
                return true;
            }

            if (value is double)
            {
                type = VisualBridgeDebugWireType.Double;
                return true;
            }

            if (value is Enum)
            {
                type = VisualBridgeDebugWireType.Enum;
                return true;
            }

            if (value is string)
            {
                type = VisualBridgeDebugWireType.String;
                return true;
            }

            if (value is byte[])
            {
                type = VisualBridgeDebugWireType.ByteArray;
                return true;
            }

            type = default;
            return false;
        }

        /// <summary>默认值不进入载荷（附录 A.4）：float/double 按位判断，-0.0 不是默认值。</summary>
        internal static bool IsDefault(object value)
        {
            if (value == null)
            {
                return true;
            }

            switch (value)
            {
                case bool boolValue:
                    return !boolValue;
                case int intValue:
                    return intValue == 0;
                case long longValue:
                    return longValue == 0L;
                case ulong ulongValue:
                    return ulongValue == 0UL;
                case float floatValue:
                    return BitConverter.SingleToInt32Bits(floatValue) == 0;
                case double doubleValue:
                    return BitConverter.DoubleToInt64Bits(doubleValue) == 0L;
                case string stringValue:
                    return stringValue.Length == 0;
                case byte[] bytesValue:
                    return bytesValue.Length == 0;
                case Enum enumValue:
                    return IsDefaultEnum(enumValue);
                default:
                    return false;
            }
        }

        /// <summary>枚举的线上宽度 = 底层整型宽度（1/2/4/8 字节）。</summary>
        internal static bool TryGetEnumUnderlyingSize(Enum value, out int size)
        {
            switch (Type.GetTypeCode(Enum.GetUnderlyingType(value.GetType())))
            {
                case TypeCode.SByte:
                case TypeCode.Byte:
                    size = 1;
                    return true;
                case TypeCode.Int16:
                case TypeCode.UInt16:
                    size = 2;
                    return true;
                case TypeCode.Int32:
                case TypeCode.UInt32:
                    size = 4;
                    return true;
                case TypeCode.Int64:
                case TypeCode.UInt64:
                    size = 8;
                    return true;
                default:
                    size = 0;
                    return false;
            }
        }

        internal static bool IsSignedEnum(Enum value)
        {
            switch (Type.GetTypeCode(Enum.GetUnderlyingType(value.GetType())))
            {
                case TypeCode.SByte:
                case TypeCode.Int16:
                case TypeCode.Int32:
                case TypeCode.Int64:
                    return true;
                default:
                    return false;
            }
        }

        internal static string GetWireTypeName(VisualBridgeDebugWireType type)
        {
            switch (type)
            {
                case VisualBridgeDebugWireType.Bool:
                    return "bool";
                case VisualBridgeDebugWireType.Int:
                    return "int";
                case VisualBridgeDebugWireType.Long:
                    return "long";
                case VisualBridgeDebugWireType.Ulong:
                    return "ulong";
                case VisualBridgeDebugWireType.Float:
                    return "float";
                case VisualBridgeDebugWireType.Double:
                    return "double";
                case VisualBridgeDebugWireType.Enum:
                    return "enum";
                case VisualBridgeDebugWireType.String:
                    return "string";
                case VisualBridgeDebugWireType.ByteArray:
                    return "byte[]";
                default:
                    return "unknown";
            }
        }

        private static bool IsDefaultEnum(Enum value)
        {
            if (IsSignedEnum(value))
            {
                return Convert.ToInt64(value) == 0L;
            }

            return Convert.ToUInt64(value) == 0UL;
        }
    }
#endif
}
