using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using VisualBridge.Runtime;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeStructuredCatalogExporter
    {
        private static void ValidateDefaultAgainstDefinition(JToken value, JObject definition, string path)
        {
            switch (definition.Value<string>("valueType"))
            {
                case "string":
                    RequireTokenType(value, path, JTokenType.String);
                    return;
                case "boolean":
                    RequireTokenType(value, path, JTokenType.Boolean);
                    return;
                case "number":
                    if (value.Type != JTokenType.Integer && value.Type != JTokenType.Float)
                    {
                        throw Error("catalog.invalidDefault", path, "Expected a JSON number.");
                    }

                    ValidateNumberDefinitionDefault(value, definition.Value<string>("dataTypeId"), path);

                    return;
                case "array":
                    if (!(value is JArray array))
                    {
                        throw Error("catalog.invalidDefault", path, "Expected a JSON array.");
                    }

                    foreach (var item in array)
                    {
                        ValidateDefaultAgainstDefinition(item, (JObject)definition["item"], path + "[]");
                    }

                    return;
                case "object":
                    if (!(value is JObject objectValue))
                    {
                        throw Error("catalog.invalidDefault", path, "Expected a JSON object.");
                    }

                    var fields = ((JArray)definition["fields"]).Cast<JObject>().ToDictionary(field => field.Value<string>("id"), StringComparer.Ordinal);
                    foreach (var property in objectValue.Properties())
                    {
                        if (!fields.TryGetValue(property.Name, out var field))
                        {
                            throw Error("catalog.invalidDefault", path + "." + property.Name, "Unknown object field.");
                        }

                        ValidateDefaultAgainstDefinition(property.Value, field, path + "." + property.Name);
                    }

                    foreach (var field in fields)
                    {
                        if (objectValue.Property(field.Key, StringComparison.Ordinal) == null)
                        {
                            throw Error("catalog.invalidDefault", path + "." + field.Key, "Object default must declare every field.");
                        }
                    }

                    return;
                default:
                    throw Error("catalog.invalidDefinition", path, "Unsupported value type.");
            }
        }

        private static JObject BuildObjectDefault(JArray fields)
        {
            var result = new JObject();
            foreach (var field in fields.Cast<JObject>())
            {
                result[field.Value<string>("id")] = field["defaultValue"].DeepClone();
            }

            return result;
        }

        private static JToken ParseDefault(string json, string path)
        {
            try
            {
                using (var stringReader = new StringReader(json))
                using (var reader = new JsonTextReader(stringReader))
                {
                    reader.DateParseHandling = DateParseHandling.None;
                    reader.FloatParseHandling = FloatParseHandling.Decimal;
                    var token = JToken.Load(reader, new JsonLoadSettings
                    {
                        CommentHandling = CommentHandling.Load,
                        DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error,
                    });
                    if (ContainsTokenType(token, JTokenType.Comment))
                    {
                        throw Error("catalog.invalidJsonMetadata", path, "Comments are not allowed in JSON metadata.");
                    }

                    while (reader.Read())
                    {
                        if (reader.TokenType != JsonToken.Comment)
                        {
                            throw Error("catalog.invalidJsonMetadata", path, "Trailing JSON content is not allowed.");
                        }
                    }

                    RejectNonFiniteNumbers(token, path);
                    return token;
                }
            }
            catch (VisualBridgeIntegrationException)
            {
                throw;
            }
            catch (JsonException exception)
            {
                throw Error("catalog.invalidJsonMetadata", path, exception.Message);
            }
        }

        private static void RejectNonFiniteNumbers(JToken token, string path)
        {
            foreach (var value in EnumerateTokens(token).OfType<JValue>())
            {
                if (value.Type == JTokenType.Float)
                {
                    var number = value.Value<double>();
                    if (double.IsNaN(number) || double.IsInfinity(number))
                    {
                        throw Error("catalog.invalidJsonMetadata", path, "Non-finite numbers are forbidden.");
                    }
                }
            }
        }

        internal static void ValidateRootType(Type type, string path)
        {
            ValidateObjectType(type, path);
            if (type.IsValueType && !type.IsLayoutSequential && !type.IsExplicitLayout)
            {
                throw Error("catalog.typeUnsupported", path, "Struct layout is unsupported.");
            }
        }

        private static void ValidateObjectType(Type type, string path)
        {
            RejectUnsupportedType(type, path);
            if ((!type.IsClass && !type.IsValueType)
                || type.IsEnum
                || type.IsAbstract
                || type.IsInterface
                || type.ContainsGenericParameters
                || type.IsGenericType
                || type.IsPrimitive
                || type == typeof(DateTime)
                || type == typeof(DateTimeOffset)
                || type == typeof(TimeSpan)
                || type == typeof(Guid)
                || type == typeof(decimal))
            {
                throw Error("catalog.typeUnsupported", path, "Expected a concrete non-generic class or struct.");
            }

            if (type.IsClass && type.BaseType != typeof(object))
            {
                throw Error("catalog.polymorphismUnsupported", path, "Class inheritance and polymorphism are not supported in V1.");
            }

            if (type.IsClass && !type.IsSealed)
            {
                throw Error("catalog.polymorphismUnsupported", path, "Catalog object classes must be sealed in V1.");
            }
        }

        private static void RejectUnsupportedType(Type type, string path)
        {
            if (typeof(UnityEngine.Object).IsAssignableFrom(type))
            {
                throw Error("catalog.unityObjectUnsupported", path, "UnityEngine.Object values are unsupported.");
            }

            if (type.Assembly == typeof(UnityEngine.Object).Assembly)
            {
                throw Error("catalog.unityTypeUnsupported", path, "UnityEngine value types, including Vector and Color, are unsupported in V1.");
            }

            if (typeof(IDictionary).IsAssignableFrom(type)
                || (type.IsGenericType && (type.GetGenericTypeDefinition() == typeof(Dictionary<,>)
                    || type.GetGenericTypeDefinition() == typeof(IDictionary<,>)
                    || type.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>)))
                || type.GetInterfaces().Any(interfaceType => interfaceType.IsGenericType
                    && (interfaceType.GetGenericTypeDefinition() == typeof(IDictionary<,>)
                        || interfaceType.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>))))
            {
                throw Error("catalog.dictionaryUnsupported", path, "Dictionaries are unsupported.");
            }

            if (type.IsPointer || type.IsByRef || type == typeof(object))
            {
                throw Error("catalog.typeUnsupported", path, $"Type '{type}' is unsupported.");
            }
        }

        private static bool TryGetListItem(Type type, out Type itemType)
        {
            if (type.IsArray)
            {
                if (type.GetArrayRank() != 1)
                {
                    throw Error("catalog.arrayUnsupported", type.FullName, "Only one-dimensional arrays are supported.");
                }

                itemType = type.GetElementType();
                return true;
            }

            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>))
            {
                itemType = type.GetGenericArguments()[0];
                return true;
            }

            itemType = null;
            return false;
        }

        private static bool IsSupportedNumber(Type type)
        {
            return type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(int)
                || type == typeof(uint)
                || type == typeof(float)
                || type == typeof(double);
        }

        private static bool IsIntegral(Type type)
        {
            return type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(int)
                || type == typeof(uint);
        }

        private static string NumberDataTypeId(Type type)
        {
            if (type == typeof(byte)) return "byte";
            if (type == typeof(sbyte)) return "sbyte";
            if (type == typeof(short)) return "short";
            if (type == typeof(ushort)) return "ushort";
            if (type == typeof(int)) return "int";
            if (type == typeof(uint)) return "uint";
            if (type == typeof(float)) return "float";
            if (type == typeof(double)) return "double";
            throw Error("catalog.typeUnsupported", type.FullName, "Unsupported numeric type.");
        }

        private static JToken NormalizeNumberDefault(Type type, JToken value, string path)
        {
            if (TryGetIntegralBounds(type, out var typeMin, out var typeMax))
            {
                decimal number;
                try
                {
                    number = value.Value<decimal>();
                }
                catch (Exception exception) when (exception is OverflowException || exception is FormatException)
                {
                    throw Error("catalog.invalidDefault", path + ".defaultJson", "Integral default is outside the supported range.");
                }

                if (decimal.Truncate(number) != number || number < (decimal)typeMin || number > (decimal)typeMax)
                {
                    throw Error("catalog.invalidDefault", path + ".defaultJson", $"Default is not a valid {NumberDataTypeId(type)} value.");
                }

                return number >= 0 && type == typeof(uint)
                    ? new JValue((ulong)number)
                    : new JValue((long)number);
            }

            var floating = value.Value<double>();
            RequireFinite(floating, path + ".defaultJson");
            if (type == typeof(float) && (floating > float.MaxValue || floating < -float.MaxValue))
            {
                throw Error("catalog.invalidDefault", path + ".defaultJson", "Default is outside the float range.");
            }

            return value;
        }

        private static void ValidateNumberMetadata(Type type, FieldMetadata metadata, JToken defaultValue, string path)
        {
            if (metadata.Editor != VisualBridgeEditorKind.Auto
                && metadata.Editor != VisualBridgeEditorKind.Number
                && metadata.Editor != VisualBridgeEditorKind.Reference
                && metadata.Editor != VisualBridgeEditorKind.Json)
            {
                throw Error("catalog.invalidEditor", path, $"Editor '{metadata.Editor}' is incompatible with number values.");
            }

            var integral = TryGetIntegralBounds(type, out var typeMin, out var typeMax);
            if (!integral && metadata.Integer)
            {
                throw Error("catalog.invalidEditor", path, "Floating-point fields cannot declare Integer=true.");
            }

            foreach (var bound in new[] { metadata.Min, metadata.Max, metadata.Step })
            {
                if (!double.IsNaN(bound))
                {
                    RequireFinite(bound, path + ".editor");
                    if (integral && Math.Truncate(bound) != bound)
                    {
                        throw Error("catalog.invalidEditor", path, "Integral field ranges and steps must be integral.");
                    }
                }
            }

            if (integral
                && ((!double.IsNaN(metadata.Min) && metadata.Min < typeMin)
                    || (!double.IsNaN(metadata.Max) && metadata.Max > typeMax)))
            {
                throw Error("catalog.invalidEditor", path, "Editor range exceeds the CLR integral type range.");
            }

            var numericDefault = defaultValue.Value<double>();
            if ((!double.IsNaN(metadata.Min) && numericDefault < metadata.Min)
                || (!double.IsNaN(metadata.Max) && numericDefault > metadata.Max))
            {
                throw Error("catalog.invalidDefault", path + ".defaultJson", "Default is outside the declared editor range.");
            }
        }

        private static void ValidateNumberDefinitionDefault(JToken value, string dataTypeId, string path)
        {
            Type type = null;
            switch (dataTypeId)
            {
                case "byte": type = typeof(byte); break;
                case "sbyte": type = typeof(sbyte); break;
                case "short": type = typeof(short); break;
                case "ushort": type = typeof(ushort); break;
                case "int": type = typeof(int); break;
                case "uint": type = typeof(uint); break;
                case "float": type = typeof(float); break;
                case "double": type = typeof(double); break;
            }

            if (type != null)
            {
                NormalizeNumberDefault(type, value, path);
            }
        }

        private static bool TryGetIntegralBounds(Type type, out double min, out double max)
        {
            if (type == typeof(byte)) { min = byte.MinValue; max = byte.MaxValue; return true; }
            if (type == typeof(sbyte)) { min = sbyte.MinValue; max = sbyte.MaxValue; return true; }
            if (type == typeof(short)) { min = short.MinValue; max = short.MaxValue; return true; }
            if (type == typeof(ushort)) { min = ushort.MinValue; max = ushort.MaxValue; return true; }
            if (type == typeof(int)) { min = int.MinValue; max = int.MaxValue; return true; }
            if (type == typeof(uint)) { min = uint.MinValue; max = uint.MaxValue; return true; }
            min = 0;
            max = 0;
            return false;
        }

        private static JValue NumberToken(double value)
        {
            return value >= long.MinValue && value <= long.MaxValue && Math.Truncate(value) == value
                ? new JValue((long)value)
                : new JValue(value);
        }

        private static string RequireDataTypeId(Type type, string path)
        {
            var name = type.FullName;
            ValidateIdentifier(name, path + ".dataTypeId");
            return name;
        }

        private static string EditorKindName(VisualBridgeEditorKind editor)
        {
            switch (editor)
            {
                case VisualBridgeEditorKind.Text: return "text";
                case VisualBridgeEditorKind.Multiline: return "multiline";
                case VisualBridgeEditorKind.Number: return "number";
                case VisualBridgeEditorKind.Checkbox: return "checkbox";
                case VisualBridgeEditorKind.Select: return "select";
                case VisualBridgeEditorKind.Color: return "color";
                case VisualBridgeEditorKind.Reference: return "reference";
                case VisualBridgeEditorKind.Json: return "json";
                default: throw Error("catalog.invalidEditor", "editor", $"Unsupported editor '{editor}'.");
            }
        }

        private static void ValidateExplicitEditor(FieldMetadata metadata, string valueType, string path)
        {
            if (metadata.Editor != VisualBridgeEditorKind.Auto
                || metadata.ReadOnly
                || metadata.Integer
                || !double.IsNaN(metadata.Min)
                || !double.IsNaN(metadata.Max)
                || !double.IsNaN(metadata.Step)
                || metadata.ReferenceKind != null
                || metadata.ReferenceTargetJson != null
                || metadata.AllowMissingReference)
            {
                throw Error("catalog.invalidEditor", path, $"Editor-only metadata is unsupported for {valueType} values in V1.");
            }
        }

        private static void ValidateScalarMetadata(FieldMetadata metadata, string valueType, string path)
        {
            var editor = metadata.Editor;
            var compatible = editor == VisualBridgeEditorKind.Auto
                || editor == VisualBridgeEditorKind.Json
                || (valueType == "string" && (editor == VisualBridgeEditorKind.Text
                    || editor == VisualBridgeEditorKind.Multiline
                    || editor == VisualBridgeEditorKind.Color
                    || editor == VisualBridgeEditorKind.Reference))
                || (valueType == "number" && (editor == VisualBridgeEditorKind.Number || editor == VisualBridgeEditorKind.Reference))
                || (valueType == "boolean" && editor == VisualBridgeEditorKind.Checkbox);
            if (!compatible || editor == VisualBridgeEditorKind.Select)
            {
                throw Error("catalog.invalidEditor", path, $"Editor '{editor}' is incompatible with {valueType} values.");
            }

            var hasRange = !double.IsNaN(metadata.Min) || !double.IsNaN(metadata.Max) || !double.IsNaN(metadata.Step) || metadata.Integer;
            if (hasRange && valueType != "number")
            {
                throw Error("catalog.invalidEditor", path, "Integer/range metadata is supported only for numeric fields.");
            }

            if (hasRange && editor == VisualBridgeEditorKind.Auto)
            {
                throw Error("catalog.invalidEditor", path, "Numeric range metadata requires the Number editor.");
            }
        }

        internal static void ValidateAliases(string id, IReadOnlyList<string> aliases, string path)
        {
            var identities = new HashSet<string>(StringComparer.Ordinal) { id };
            foreach (var alias in aliases)
            {
                ValidateIdentifier(alias, path);
                if (!identities.Add(alias))
                {
                    throw Error("catalog.duplicateAlias", path, $"Duplicate identity '{alias}'.");
                }
            }
        }

        internal static void ValidateIdentifier(string value, string path)
        {
            if (string.IsNullOrEmpty(value)
                || value.Length > 128
                || !IsAsciiAlphaNumeric(value[0])
                || value.Any(character => !IsAsciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-'))
            {
                throw Error("catalog.invalidIdentifier", path, "Expected a stable identifier.");
            }
        }

        internal static void ValidateNonEmpty(string value, string path)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw Error("catalog.invalidString", path, "Expected a non-empty string.");
            }
        }

        private static void RequireFinite(double value, string path)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw Error("catalog.invalidNumber", path, "Expected a finite number.");
            }
        }

        private static void RequireTokenType(JToken token, string path, JTokenType type)
        {
            if (token.Type != type)
            {
                throw Error("catalog.invalidDefault", path + ".defaultJson", $"Expected JSON token type '{type}'.");
            }
        }

    }
}
