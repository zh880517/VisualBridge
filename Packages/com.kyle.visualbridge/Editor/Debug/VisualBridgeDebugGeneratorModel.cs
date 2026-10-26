using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor
{
    /// <summary>参数值在编码器侧的承载种类（决定生成代码显式转换到哪个 PushParam 重载）。</summary>
    internal enum VisualBridgeDebugValueKind
    {
        Bool,
        Int,
        Long,
        Ulong,
        Float,
        Double,
        Enum,
        String,
        ByteArray,
    }

    /// <summary>
    /// 一个调试参数。实例参数（Event）与请求句柄（Query）也在 <see cref="VisualBridgeDebugMethodModel.Parameters"/> 里，
    /// 但不会进入载荷（附录 B.2/B.5）。
    /// </summary>
    internal sealed class VisualBridgeDebugParameterModel
    {
        public VisualBridgeDebugParameterModel(
            string name,
            Type declaredType,
            string contractType,
            ushort tag,
            bool isInstance,
            bool isRequest,
            bool optional,
            VisualBridgeDebugValueKind kind,
            string castType,
            string tsType,
            object defaultValue,
            bool hasDefaultValue)
        {
            Name = name;
            DeclaredType = declaredType;
            ContractType = contractType;
            Tag = tag;
            IsInstance = isInstance;
            IsRequest = isRequest;
            Optional = optional;
            Kind = kind;
            CastType = castType;
            TsType = tsType;
            DefaultValue = defaultValue;
            HasDefaultValue = hasDefaultValue;
        }

        public string Name { get; }

        public Type DeclaredType { get; }

        /// <summary>契约里记录的类型名：基元用关键字，枚举用完整名（与原声明一致）。</summary>
        public string ContractType { get; }

        /// <summary>
        /// 供二进制编码的参数号（附录 B.2/A.4）。未显式标记的参数由生成器按声明顺序自动分配（从 1 起，
        /// 跳过显式占用的号）；实例参数与请求句柄不参与载荷，恒为 0。
        /// </summary>
        public ushort Tag { get; internal set; }

        /// <summary>参数上是否显式写了 <c>[VisualBridgeDebugTag]</c>（显式 0 与未标记要区分开）。</summary>
        public bool HasExplicitTag { get; internal set; }

        public bool IsInstance { get; internal set; }

        public bool IsRequest { get; }

        /// <summary>声明了默认值（C# 可选参数），TS 侧对应 <c>?</c>。</summary>
        public bool Optional { get; }

        public VisualBridgeDebugValueKind Kind { get; }

        /// <summary>PushParam 的显式转换目标类型。B.1.1 要求显式转换，避免 <c>PushParam(null)</c> 的重载歧义。</summary>
        public string CastType { get; }

        public string TsType { get; }

        public object DefaultValue { get; }

        public bool HasDefaultValue { get; }

        /// <summary>参与载荷压入的参数（排除实例参数与请求句柄）。</summary>
        public bool IsPayload => !IsInstance && !IsRequest;
    }

    /// <summary>一个调试方法；<see cref="MethodId"/> 由号分配器在读取 debug-ids.json 后填入。</summary>
    internal sealed class VisualBridgeDebugMethodModel
    {
        public VisualBridgeDebugMethodModel(
            string name,
            IReadOnlyList<VisualBridgeDebugParameterModel> parameters,
            VisualBridgeDebugParameterModel instanceParameter,
            VisualBridgeDebugParameterModel requestParameter,
            VisualBridgeDebugParameterModel resultParameter,
            string resultContractType,
            bool resultIsVoid)
        {
            Name = name;
            Parameters = parameters;
            InstanceParameter = instanceParameter;
            RequestParameter = requestParameter;
            ResultParameter = resultParameter;
            ResultContractType = resultContractType;
            ResultIsVoid = resultIsVoid;
        }

        public string Name { get; }

        public ushort MethodId { get; internal set; }

        /// <summary>按声明顺序的全部参数（含实例参数 / 请求句柄）。</summary>
        public IReadOnlyList<VisualBridgeDebugParameterModel> Parameters { get; }

        /// <summary>Event 的实例参数；Query 为 null。</summary>
        public VisualBridgeDebugParameterModel InstanceParameter { get; }

        /// <summary>Query 的 <c>VisualBridgeDebugRequest</c> 参数；Event 为 null。</summary>
        public VisualBridgeDebugParameterModel RequestParameter { get; }

        /// <summary>Query 的结果参数（名 <c>result</c>）；返回 void 或 Event 为 null。</summary>
        public VisualBridgeDebugParameterModel ResultParameter { get; }

        /// <summary>Query 结果的契约类型（void 时为 <c>"void"</c>；Event 为 <c>"bool"</c>）。</summary>
        public string ResultContractType { get; }

        public bool ResultIsVoid { get; }

        public IEnumerable<VisualBridgeDebugParameterModel> PayloadParameters => Parameters.Where(parameter => parameter.IsPayload);
    }

    /// <summary>一个调试接口（<c>[VisualBridgeDebuger]</c>）。</summary>
    internal sealed class VisualBridgeDebugInterfaceModel
    {
        public VisualBridgeDebugInterfaceModel(
            Type interfaceType,
            string interfaceFullName,
            string category,
            VisualBridgeDebugerKind kind,
            string generatedDirectory,
            string className,
            string generatedNamespace,
            IReadOnlyList<VisualBridgeDebugMethodModel> methods)
        {
            InterfaceType = interfaceType;
            InterfaceFullName = interfaceFullName;
            Category = category;
            Kind = kind;
            GeneratedDirectory = generatedDirectory;
            ClassName = className;
            GeneratedNamespace = generatedNamespace;
            Methods = methods;
        }

        public Type InterfaceType { get; }

        /// <summary>契约标识（完整名，<c>+</c> 归一为 <c>.</c>）。</summary>
        public string InterfaceFullName { get; }

        public string InterfaceName => InterfaceType.Name;

        public string Category { get; }

        public VisualBridgeDebugerKind Kind { get; }

        /// <summary>项目相对的生成目录，统一用 <c>/</c> 分隔。</summary>
        public string GeneratedDirectory { get; }

        /// <summary>接口名去 <c>I</c> 得到的类名（附录 B.5）。</summary>
        public string ClassName { get; }

        public string GeneratedNamespace { get; }

        public IReadOnlyList<VisualBridgeDebugMethodModel> Methods { get; }

        /// <summary>生成代码里对该接口的 C# 引用（带 <c>global::</c>，避免与生成的类名冲突）。</summary>
        public string CSharpReference => "global::" + InterfaceFullName.Replace('+', '.');

        public string KindText => Kind == VisualBridgeDebugerKind.Query ? "query" : "event";
    }

    /// <summary>一个分类：决定 <c>&lt;Category&gt;Category.g.cs</c> 与 <c>&lt;category&gt;.g.ts</c> 的内容。</summary>
    internal sealed class VisualBridgeDebugCategoryModel
    {
        public VisualBridgeDebugCategoryModel(
            string name,
            string typeName,
            string fileBaseName,
            string generatedDirectory,
            IReadOnlyList<VisualBridgeDebugInterfaceModel> interfaces)
        {
            Name = name;
            TypeName = typeName;
            FileBaseName = fileBaseName;
            GeneratedDirectory = generatedDirectory;
            Interfaces = interfaces;
        }

        public string Name { get; }

        /// <summary><c>&lt;Category&gt;Protocol</c> 的类名（附录 B.5 的 <c>GraphProtocol</c>）。</summary>
        public string TypeName { get; }

        /// <summary><c>&lt;Category&gt;Category.g.cs</c> 的文件名主干。</summary>
        public string FileBaseName { get; }

        public string GeneratedDirectory { get; }

        public IReadOnlyList<VisualBridgeDebugInterfaceModel> Interfaces { get; }
    }

    /// <summary>被参数引用的枚举；成员与底层类型变化都会改变 contractHash（附录 B.5）。</summary>
    internal sealed class VisualBridgeDebugEnumModel
    {
        public VisualBridgeDebugEnumModel(
            string fullName,
            string underlyingType,
            string tsName,
            IReadOnlyList<KeyValuePair<string, long>> members)
        {
            FullName = fullName;
            UnderlyingType = underlyingType;
            TsName = tsName;
            Members = members;
        }

        public string FullName { get; }

        /// <summary>底层整型（决定二进制值宽），参与 contractHash。</summary>
        public string UnderlyingType { get; }

        /// <summary>TS 里的标识符（完整名的点与加号归一为下划线）。</summary>
        public string TsName { get; }

        /// <summary>按值、再按名字稳定排序的成员。</summary>
        public IReadOnlyList<KeyValuePair<string, long>> Members { get; }
    }

    /// <summary>一次生成的完整输入模型（分类、接口、方法、枚举）。</summary>
    internal sealed class VisualBridgeDebugDefinitionModel
    {
        public VisualBridgeDebugDefinitionModel(
            IReadOnlyList<VisualBridgeDebugCategoryModel> categories,
            IReadOnlyList<VisualBridgeDebugEnumModel> enums)
        {
            Categories = categories;
            Enums = enums;
        }

        public IReadOnlyList<VisualBridgeDebugCategoryModel> Categories { get; }

        public IReadOnlyList<VisualBridgeDebugEnumModel> Enums { get; }
    }

    /// <summary>
    /// 声明类型到「PushParam 重载 / 契约类型 / TS 类型」的映射（附录 B.2/B.5）。
    /// 生成代码必须显式转换：<c>PushParam(null)</c> 在 string/byte[]/Enum 重载之间有歧义。
    /// </summary>
    internal static class VisualBridgeDebugTypeMapping
    {
        public static bool TryDescribe(
            Type type,
            out VisualBridgeDebugValueKind kind,
            out string contractType,
            out string castType,
            out string tsType)
        {
            if (type == null)
            {
                kind = default;
                contractType = null;
                castType = null;
                tsType = null;
                return false;
            }

            if (type.IsEnum)
            {
                kind = VisualBridgeDebugValueKind.Enum;
                contractType = FullName(type);
                castType = "global::System.Enum";
                tsType = TsEnumName(FullName(type));
                return true;
            }

            if (type == typeof(bool))
            {
                return Describe(VisualBridgeDebugValueKind.Bool, "bool", "bool", "boolean", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(sbyte))
            {
                return Describe(VisualBridgeDebugValueKind.Int, "sbyte", "int", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(byte))
            {
                return Describe(VisualBridgeDebugValueKind.Int, "byte", "int", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(short))
            {
                return Describe(VisualBridgeDebugValueKind.Int, "short", "int", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(ushort))
            {
                return Describe(VisualBridgeDebugValueKind.Int, "ushort", "int", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(int))
            {
                return Describe(VisualBridgeDebugValueKind.Int, "int", "int", "number", out kind, out contractType, out castType, out tsType);
            }

            // uint 超出 int 正区间，宽化到 long 才是无损的；契约里仍记声明类型 uint。
            if (type == typeof(uint))
            {
                return Describe(VisualBridgeDebugValueKind.Long, "uint", "long", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(long))
            {
                return Describe(VisualBridgeDebugValueKind.Long, "long", "long", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(ulong))
            {
                return Describe(VisualBridgeDebugValueKind.Ulong, "ulong", "ulong", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(float))
            {
                return Describe(VisualBridgeDebugValueKind.Float, "float", "float", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(double))
            {
                return Describe(VisualBridgeDebugValueKind.Double, "double", "double", "number", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(string))
            {
                return Describe(VisualBridgeDebugValueKind.String, "string", "string", "string", out kind, out contractType, out castType, out tsType);
            }

            if (type == typeof(byte[]))
            {
                // JSON 降级载荷里 byte[] 以 base64 字符串出现，TS 侧按 string 建模（F1 解码时转换）。
                return Describe(VisualBridgeDebugValueKind.ByteArray, "byte[]", "byte[]", "string", out kind, out contractType, out castType, out tsType);
            }

            kind = default;
            contractType = null;
            castType = null;
            tsType = null;
            return false;
        }

        /// <summary>生成源码里的类型引用：基元用关键字，其余用 <c>global::</c> 完整名。</summary>
        public static string CSharpTypeName(Type type)
        {
            if (type == typeof(bool))
            {
                return "bool";
            }

            if (type == typeof(sbyte))
            {
                return "sbyte";
            }

            if (type == typeof(byte))
            {
                return "byte";
            }

            if (type == typeof(short))
            {
                return "short";
            }

            if (type == typeof(ushort))
            {
                return "ushort";
            }

            if (type == typeof(int))
            {
                return "int";
            }

            if (type == typeof(uint))
            {
                return "uint";
            }

            if (type == typeof(long))
            {
                return "long";
            }

            if (type == typeof(ulong))
            {
                return "ulong";
            }

            if (type == typeof(float))
            {
                return "float";
            }

            if (type == typeof(double))
            {
                return "double";
            }

            if (type == typeof(string))
            {
                return "string";
            }

            if (type == typeof(byte[]))
            {
                return "byte[]";
            }

            return "global::" + FullName(type).Replace('+', '.');
        }

        /// <summary>可选参数的默认值字面量；无法表达成常量时退回 <c>default</c>（C# 7.1 起可用于可选参数）。</summary>
        public static string CSharpDefaultLiteral(VisualBridgeDebugParameterModel parameter)
        {
            var value = parameter.DefaultValue;
            if (!parameter.HasDefaultValue)
            {
                return "default";
            }

            switch (parameter.Kind)
            {
                case VisualBridgeDebugValueKind.Bool:
                    return (bool)value ? "true" : "false";
                case VisualBridgeDebugValueKind.String:
                    return value == null ? "null" : JsonConvert.ToString((string)value);
                case VisualBridgeDebugValueKind.ByteArray:
                    return "null";
                case VisualBridgeDebugValueKind.Enum:
                    // 枚举默认值用底层常量写回（常量表达式），不依赖生成代码里枚举成员的可见名。
                    return "(" + CSharpTypeName(parameter.DeclaredType) + ")"
                        + IntegerLiteral(value, Enum.GetUnderlyingType(parameter.DeclaredType));
                case VisualBridgeDebugValueKind.Float:
                    return FormatSingle(Convert.ToSingle(value, CultureInfo.InvariantCulture));
                case VisualBridgeDebugValueKind.Double:
                    return FormatDouble(Convert.ToDouble(value, CultureInfo.InvariantCulture));
                case VisualBridgeDebugValueKind.Ulong:
                    return IntegerLiteral(value, typeof(ulong));
                case VisualBridgeDebugValueKind.Long:
                    // uint 走 long 重载，但默认值必须是 uint 字面量（0L 对 uint 参数是 CS1750）。
                    return IntegerLiteral(value, parameter.DeclaredType);
                default:
                    return IntegerLiteral(value, typeof(int));
            }
        }

        /// <summary>按目标整型的后缀生成常量字面量：uint→u、ulong→UL、long→L；窄整型用 int 常量。</summary>
        private static string IntegerLiteral(object value, Type type)
        {
            if (type == typeof(uint))
            {
                return Convert.ToUInt32(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture) + "u";
            }

            if (type == typeof(ulong))
            {
                return Convert.ToUInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture) + "UL";
            }

            if (type == typeof(long))
            {
                return Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture) + "L";
            }

            return Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>生成源码里的标识符；C# 保留关键字加 <c>@</c> 前缀（接口参数可以合法地叫 class/@class）。</summary>
        public static string CSharpIdentifier(string name)
        {
            return CSharpKeywords.Contains(name) ? "@" + name : name;
        }

        private static readonly HashSet<string> CSharpKeywords = new HashSet<string>(StringComparer.Ordinal)
        {
            "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class",
            "const", "continue", "decimal", "default", "delegate", "do", "double", "else", "enum", "event",
            "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "goto", "if",
            "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace", "new",
            "null", "object", "operator", "out", "override", "params", "private", "protected", "public",
            "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "stackalloc", "static",
            "string", "struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong",
            "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
        };

        public static string FullName(Type type)
        {
            return (type.FullName ?? type.Name).Replace('+', '.');
        }

        public static string TsEnumName(string fullName)
        {
            return fullName.Replace('.', '_');
        }

        private static bool Describe(
            VisualBridgeDebugValueKind valueKind,
            string contractTypeValue,
            string castTypeValue,
            string tsTypeValue,
            out VisualBridgeDebugValueKind kind,
            out string contractType,
            out string castType,
            out string tsType)
        {
            kind = valueKind;
            contractType = contractTypeValue;
            castType = castTypeValue;
            tsType = tsTypeValue;
            return true;
        }

        private static string FormatSingle(float value)
        {
            if (float.IsNaN(value))
            {
                return "float.NaN";
            }

            if (float.IsPositiveInfinity(value))
            {
                return "float.PositiveInfinity";
            }

            if (float.IsNegativeInfinity(value))
            {
                return "float.NegativeInfinity";
            }

            // 附录 A.4：-0.0 是会被写出的非默认值，字面量必须保留符号（Mono 的 "R" 可能丢负号）。
            if (BitConverter.SingleToInt32Bits(value) == int.MinValue)
            {
                return "-0.0f";
            }

            return value.ToString("R", CultureInfo.InvariantCulture) + "f";
        }

        private static string FormatDouble(double value)
        {
            if (double.IsNaN(value))
            {
                return "double.NaN";
            }

            if (double.IsPositiveInfinity(value))
            {
                return "double.PositiveInfinity";
            }

            if (double.IsNegativeInfinity(value))
            {
                return "double.NegativeInfinity";
            }

            // 附录 A.4：-0.0 是会被写出的非默认值，字面量必须保留符号（Mono 的 "R" 可能丢负号）。
            if (BitConverter.DoubleToInt64Bits(value) == long.MinValue)
            {
                return "-0.0";
            }

            return value.ToString("R", CultureInfo.InvariantCulture);
        }
    }
}
