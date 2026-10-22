using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using VisualBridge.Debug;

namespace VisualBridge.Editor
{
    /// <summary>调试参数的线格式分类。</summary>
    internal enum DebugParamKind
    {
        Unsupported,
        Bool,
        Int32,
        Int64,
        UInt64,
        Single,
        Double,
        String,
        Bytes,
        Enum,
        NarrowInt32,
        NarrowInt64,
    }

    internal sealed class DebugParamModel
    {
        internal DebugParamModel(
            ParameterInfo parameter,
            int position,
            DebugParamKind kind,
            string declaredTypeName,
            string wireTypeName,
            string contractTypeName,
            int tag,
            bool hasExplicitTag)
        {
            Name = parameter.Name ?? string.Empty;
            Parameter = parameter;
            DeclaredType = parameter.ParameterType;
            Position = position;
            Kind = kind;
            DeclaredTypeName = declaredTypeName;
            WireTypeName = wireTypeName;
            ContractTypeName = contractTypeName;
            Tag = tag;
            HasExplicitTag = hasExplicitTag;
        }

        internal ParameterInfo Parameter { get; }

        public string Name { get; }

        public Type DeclaredType { get; }

        public int Position { get; }

        public DebugParamKind Kind { get; }

        public string DeclaredTypeName { get; }

        public string WireTypeName { get; }

        public string ContractTypeName { get; }

        public int Tag { get; }

        public bool HasExplicitTag { get; }

        public bool IsSupported
        {
            get { return Kind != DebugParamKind.Unsupported; }
        }

        public bool IsEnum
        {
            get { return Kind == DebugParamKind.Enum; }
        }

        public bool IsNarrowed
        {
            get
            {
                return Kind == DebugParamKind.NarrowInt32 || Kind == DebugParamKind.NarrowInt64;
            }
        }

        public string WireArgument
        {
            get { return IsNarrowed ? "(" + WireTypeName + ")" + Name : Name; }
        }
    }

    internal sealed class DebugMethodModel
    {
        internal DebugMethodModel(MethodInfo method, IReadOnlyList<DebugParamModel> parameters)
        {
            Method = method;
            Name = method.Name;
            Parameters = parameters;
            ParameterCount = parameters.Count;
            ReturnType = method.ReturnType;
            IsGeneric = method.IsGenericMethodDefinition
                || (method.IsGenericMethod && method.GetGenericArguments().Length != 0);
        }

        internal MethodInfo Method { get; }

        public string Name { get; }

        public IReadOnlyList<DebugParamModel> Parameters { get; }

        public int ParameterCount { get; }

        public Type ReturnType { get; }

        public bool IsGeneric { get; }

        public bool ReturnsVoid
        {
            get { return ReturnType == typeof(void); }
        }

        public DebugParamModel FindParameter(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return null;
            }

            return Parameters.FirstOrDefault(
                parameter => string.Equals(parameter.Name, name, StringComparison.Ordinal));
        }
    }

    internal sealed class DebugContractModel
    {
        internal DebugContractModel(
            Type type,
            VisualBridgeDebugerAttribute attribute,
            IReadOnlyList<DebugMethodModel> methods,
            string generatedDirectory)
        {
            Type = type;
            Namespace = type.Namespace ?? string.Empty;
            InterfaceName = type.Name;
            FullName = (type.FullName ?? type.Name).Replace('+', '.');
            AssemblyName = type.Assembly.GetName().Name ?? string.Empty;
            Category = attribute.Category;
            Version = attribute.Version;
            Kind = attribute.Kind;
            GeneratedDirectory = generatedDirectory;
            InstanceParameter = NormalizeParameterName(attribute.InstanceParameter);
            FrameParameter = NormalizeParameterName(attribute.FrameParameter);
            Methods = methods;
            ClassName = GetStaticClassName(type.Name);
            Stem = GetStem(ClassName);
            FacadeFileName = Stem + "Debuger.g.cs";
            ImplementationClassName = "VisualBridgeGenerated" + Stem + "Debuger";
        }

        internal Type Type { get; }

        public string Namespace { get; }

        public string InterfaceName { get; }

        public string FullName { get; }

        public string AssemblyName { get; }

        public string Category { get; }

        public int Version { get; }

        public VisualBridgeDebugerKind Kind { get; }

        public string GeneratedDirectory { get; }

        public string InstanceParameter { get; }

        public string FrameParameter { get; }

        public IReadOnlyList<DebugMethodModel> Methods { get; }

        public string ClassName { get; }

        /// <summary>去掉 I 前缀与 Debuger 后缀的命名根。</summary>
        public string Stem { get; }

        public string FacadeFileName { get; }

        public string ImplementationClassName { get; }

        public string ImplementationFileName
        {
            get { return ImplementationClassName + ".g.cs"; }
        }

        public string DispatcherClassName
        {
            get { return ImplementationClassName + "Dispatcher"; }
        }

        public string DispatcherFileName
        {
            get { return DispatcherClassName + ".g.cs"; }
        }

        public bool IsQuery
        {
            get { return Kind == VisualBridgeDebugerKind.Query; }
        }

        public string ContractKind
        {
            get { return IsQuery ? "query" : "event"; }
        }

        internal static string NormalizeParameterName(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            return value.Trim();
        }

        internal static string GetStaticClassName(string interfaceName)
        {
            if (interfaceName.Length > 1
                && interfaceName[0] == 'I'
                && char.IsUpper(interfaceName[1]))
            {
                return interfaceName.Substring(1);
            }

            return interfaceName;
        }

        internal static string GetStem(string className)
        {
            const string suffix = "Debuger";
            if (className.Length > suffix.Length
                && className.EndsWith(suffix, StringComparison.Ordinal))
            {
                return className.Substring(0, className.Length - suffix.Length);
            }

            return className;
        }
    }

    internal sealed class DebugModelSet
    {
        internal DebugModelSet(
            IReadOnlyList<DebugContractModel> models,
            IReadOnlyList<string> errors)
        {
            Models = models;
            Errors = errors;
        }

        public IReadOnlyList<DebugContractModel> Models { get; }

        public IReadOnlyList<string> Errors { get; }
    }

    public static partial class VisualBridgeDebugContractCompiler
    {
        internal const string DiagnosticUnsupportedParameterType = "VBDBG001";
        internal const string DiagnosticNonVoidReturn = "VBDBG002";
        internal const string DiagnosticGenericType = "VBDBG003";
        internal const string DiagnosticNestedType = "VBDBG004";
        internal const string DiagnosticOverload = "VBDBG005";
        internal const string DiagnosticTagOrder = "VBDBG006";
        internal const string DiagnosticClassNameConflict = "VBDBG007";
        internal const string DiagnosticNonPublic = "VBDBG008";
        internal const string DiagnosticParameterModifier = "VBDBG009";
        internal const string DiagnosticMethodName = "VBDBG010";
        internal const string DiagnosticGeneratedDirectory = "VBDBG011";
        internal const string DiagnosticMissingGeneratedDirectory = "VBDBG012";
        internal const string DiagnosticInstanceParameter = "VBDBG013";
        internal const string DiagnosticFrameParameter = "VBDBG014";
        internal const string DiagnosticNotDebugInterface = "VBDBG015";
        internal const string DiagnosticInheritedInterface = "VBDBG016";
        internal const string DiagnosticNonMethodMember = "VBDBG017";
        internal const string DiagnosticReservedName = "VBDBG018";
        internal const string DiagnosticInvalidCategory = "VBDBG019";

        private static readonly HashSet<string> s_csharpKeywords = new HashSet<string>(
            new[]
            {
                "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char",
                "checked", "class", "const", "continue", "decimal", "default", "delegate", "do",
                "double", "else", "enum", "event", "explicit", "extern", "false", "finally",
                "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int",
                "interface", "internal", "is", "lock", "long", "namespace", "new", "null",
                "object", "operator", "out", "override", "params", "private", "protected",
                "public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof",
                "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true",
                "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using",
                "virtual", "void", "volatile", "while",
            },
            StringComparer.Ordinal);

        internal static bool IsCSharpKeyword(string value)
        {
            return !string.IsNullOrEmpty(value) && s_csharpKeywords.Contains(value);
        }

        private static readonly char[] s_invalidCategoryCharacters =
        {
            '/', '\\', ':', '*', '?', '"', '<', '>', '|',
        };

        internal static bool IsValidCategory(string category)
        {
            if (string.IsNullOrEmpty(category)
                || string.Equals(category, ".", StringComparison.Ordinal)
                || string.Equals(category, "..", StringComparison.Ordinal))
            {
                return false;
            }

            return category.IndexOfAny(s_invalidCategoryCharacters) < 0;
        }

        private static readonly HashSet<string> s_predefinedAssemblies = new HashSet<string>(
            new[]
            {
                "Assembly-CSharp",
                "Assembly-CSharp-Editor",
                "Assembly-CSharp-firstpass",
                "Assembly-CSharp-Editor-firstpass",
            },
            StringComparer.Ordinal);

        internal static bool IsPredefinedAssembly(string assemblyName)
        {
            return !string.IsNullOrEmpty(assemblyName) && s_predefinedAssemblies.Contains(assemblyName);
        }

        internal static string GetFullTypeName(Type type)
        {
            string fullName = type.FullName;
            return string.IsNullOrEmpty(fullName) ? type.Name : fullName.Replace('+', '.');
        }

        internal static string GetDeclaredTypeName(Type type)
        {
            if (type == typeof(bool)) return "bool";
            if (type == typeof(int)) return "int";
            if (type == typeof(long)) return "long";
            if (type == typeof(ulong)) return "ulong";
            if (type == typeof(float)) return "float";
            if (type == typeof(double)) return "double";
            if (type == typeof(string)) return "string";
            if (type == typeof(byte[])) return "byte[]";
            if (type == typeof(byte)) return "byte";
            if (type == typeof(sbyte)) return "sbyte";
            if (type == typeof(short)) return "short";
            if (type == typeof(ushort)) return "ushort";
            if (type == typeof(char)) return "char";
            if (type == typeof(uint)) return "uint";
            if (type.IsEnum) return "global::" + GetFullTypeName(type);
            return null;
        }

        internal static DebugParamKind GetParamKind(Type type)
        {
            if (type == typeof(bool)) return DebugParamKind.Bool;
            if (type == typeof(int)) return DebugParamKind.Int32;
            if (type == typeof(long)) return DebugParamKind.Int64;
            if (type == typeof(ulong)) return DebugParamKind.UInt64;
            if (type == typeof(float)) return DebugParamKind.Single;
            if (type == typeof(double)) return DebugParamKind.Double;
            if (type == typeof(string)) return DebugParamKind.String;
            if (type == typeof(byte[])) return DebugParamKind.Bytes;
            if (type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(char))
            {
                return DebugParamKind.NarrowInt32;
            }

            if (type == typeof(uint))
            {
                return DebugParamKind.NarrowInt64;
            }

            if (type.IsEnum)
            {
                return DebugParamKind.Enum;
            }

            return DebugParamKind.Unsupported;
        }

        internal static string GetWireTypeName(DebugParamKind kind, Type declaredType)
        {
            switch (kind)
            {
                case DebugParamKind.Bool:
                    return "bool";
                case DebugParamKind.Int32:
                case DebugParamKind.NarrowInt32:
                    return "int";
                case DebugParamKind.Int64:
                case DebugParamKind.NarrowInt64:
                    return "long";
                case DebugParamKind.UInt64:
                    return "ulong";
                case DebugParamKind.Single:
                    return "float";
                case DebugParamKind.Double:
                    return "double";
                case DebugParamKind.String:
                    return "string";
                case DebugParamKind.Bytes:
                    return "byte[]";
                case DebugParamKind.Enum:
                    return "global::" + GetFullTypeName(declaredType);
                default:
                    return null;
            }
        }

        internal static string GetContractTypeName(DebugParamKind kind)
        {
            switch (kind)
            {
                case DebugParamKind.Bool:
                    return "bool";
                case DebugParamKind.Int32:
                case DebugParamKind.NarrowInt32:
                    return "int";
                case DebugParamKind.Int64:
                case DebugParamKind.NarrowInt64:
                    return "long";
                case DebugParamKind.UInt64:
                    return "ulong";
                case DebugParamKind.Single:
                    return "float";
                case DebugParamKind.Double:
                    return "double";
                case DebugParamKind.String:
                    return "string";
                case DebugParamKind.Bytes:
                    return "bytes";
                case DebugParamKind.Enum:
                    return "enum";
                default:
                    return null;
            }
        }

        internal static long GetEnumMemberValue(Type enumType, string name)
        {
            object raw = Enum.Parse(enumType, name);
            try
            {
                return Convert.ToInt64(raw, CultureInfo.InvariantCulture);
            }
            catch (OverflowException)
            {
                return unchecked((long)Convert.ToUInt64(raw, CultureInfo.InvariantCulture));
            }
        }

        internal static string NormalizeGeneratedDirectory(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            string normalized = value.Trim().Replace('\\', '/');
            while (normalized.Length > 1 && normalized.EndsWith("/", StringComparison.Ordinal))
            {
                normalized = normalized.Substring(0, normalized.Length - 1);
            }

            return normalized;
        }

        internal static bool IsValidGeneratedDirectory(string directory)
        {
            if (string.IsNullOrEmpty(directory))
            {
                return false;
            }

            if (directory.StartsWith("/", StringComparison.Ordinal)
                || directory.IndexOf("..", StringComparison.Ordinal) >= 0)
            {
                return false;
            }

            string[] segments = directory.Split('/');
            if (segments.Length < 2 || segments.Any(string.IsNullOrEmpty))
            {
                return false;
            }

            if (!string.Equals(segments[0], "Assets", StringComparison.Ordinal)
                && !string.Equals(segments[0], "Packages", StringComparison.Ordinal))
            {
                return false;
            }

            // Packages 目录至少需要包名一级，避免写入 Packages/ 根。
            return !string.Equals(segments[0], "Packages", StringComparison.Ordinal) || segments.Length >= 3;
        }

        internal static string Diagnostic(string code, string subject, string message)
        {
            return code + ": " + subject + ": " + message;
        }
    }
}
