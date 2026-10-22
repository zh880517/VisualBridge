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
        internal static JArray BuildFields(Type type, HashSet<Type> recursionStack, string path)
        {
            if (!recursionStack.Add(type))
            {
                throw Error("catalog.cycleUnsupported", path, $"Recursive object type '{type.FullName}' is not supported.");
            }

            try
            {
                foreach (var staticField in type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (ReadFieldMetadata(staticField) != null)
                    {
                        throw Error("catalog.staticFieldUnsupported", path + "." + staticField.Name, "Annotated static fields are unsupported.");
                    }
                }

                var fieldPlans = type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                    .Select(field => new { Field = field, Metadata = ReadFieldMetadata(field) })
                    .Where(entry => entry.Metadata != null)
                    .OrderBy(entry => entry.Metadata.Order)
                    .ThenBy(entry => entry.Metadata.Id, StringComparer.Ordinal)
                    .ToArray();
                var identities = new HashSet<string>(StringComparer.Ordinal);
                var result = new JArray();
                foreach (var entry in fieldPlans)
                {
                    var fieldPath = path + "." + entry.Field.Name;
                    ValidateIdentifier(entry.Metadata.Id, fieldPath + ".id");
                    ValidateNonEmpty(entry.Metadata.Title, fieldPath + ".title");
                    ValidateAliases(entry.Metadata.Id, entry.Metadata.Aliases, fieldPath + ".aliases");
                    foreach (var identity in new[] { entry.Metadata.Id }.Concat(entry.Metadata.Aliases))
                    {
                        if (!identities.Add(identity))
                        {
                            throw Error("catalog.identityConflict", fieldPath, $"Field identity '{identity}' is already used by a sibling field.");
                        }
                    }

                    var definition = BuildValueDefinition(entry.Field.FieldType, entry.Metadata, recursionStack, fieldPath, true);
                    var field = new JObject
                    {
                        ["id"] = entry.Metadata.Id,
                        ["title"] = entry.Metadata.Title,
                        ["aliases"] = new JArray(entry.Metadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                    };
                    if (entry.Metadata.Description != null)
                    {
                        ValidateNonEmpty(entry.Metadata.Description, fieldPath + ".description");
                        field["description"] = entry.Metadata.Description;
                    }

                    foreach (var property in definition.Properties())
                    {
                        field.Add(property.Name, property.Value);
                    }

                    result.Add(field);
                }

                return result;
            }
            finally
            {
                recursionStack.Remove(type);
            }
        }

        internal static JObject BuildValueDefinition(
            Type type,
            FieldMetadata metadata,
            HashSet<Type> recursionStack,
            string path,
            bool includeFieldEditor)
        {
            RejectUnsupportedType(type, path);
            JObject definition;
            JToken defaultValue;
            if (type == typeof(string))
            {
                definition = ScalarDefinition("string", metadata.DataTypeId ?? "string");
                defaultValue = metadata.DefaultJson == null ? new JValue(string.Empty) : ParseDefault(metadata.DefaultJson, path);
                RequireTokenType(defaultValue, path, JTokenType.String);
                ValidateScalarMetadata(metadata, "string", path);
                if (metadata.Editor == VisualBridgeEditorKind.Color && !ColorPattern.IsMatch(defaultValue.Value<string>()))
                {
                    throw Error("catalog.invalidColorDefault", path + ".defaultJson", "Color defaults must use #RRGGBB or #RRGGBBAA.");
                }
            }
            else if (type == typeof(bool))
            {
                definition = ScalarDefinition("boolean", metadata.DataTypeId ?? "bool");
                defaultValue = metadata.DefaultJson == null ? new JValue(false) : ParseDefault(metadata.DefaultJson, path);
                RequireTokenType(defaultValue, path, JTokenType.Boolean);
                ValidateScalarMetadata(metadata, "boolean", path);
            }
            else if (IsSupportedNumber(type))
            {
                definition = ScalarDefinition("number", metadata.DataTypeId ?? NumberDataTypeId(type));
                defaultValue = metadata.DefaultJson == null ? new JValue(0) : ParseDefault(metadata.DefaultJson, path);
                if (defaultValue.Type != JTokenType.Integer && defaultValue.Type != JTokenType.Float)
                {
                    throw Error("catalog.invalidDefault", path + ".defaultJson", "Expected a JSON number.");
                }

                defaultValue = NormalizeNumberDefault(type, defaultValue, path);
                ValidateNumberMetadata(type, metadata, defaultValue, path);
            }
            else if (type.IsEnum)
            {
                var names = Enum.GetNames(type).OrderBy(value => value, StringComparer.Ordinal).ToArray();
                if (names.Length == 0)
                {
                    throw Error("catalog.enumUnsupported", path, "Enums without named values are unsupported.");
                }

                definition = ScalarDefinition("string", metadata.DataTypeId ?? RequireDataTypeId(type, path));
                if (metadata.DefaultJson == null)
                {
                    throw Error("catalog.enumDefaultRequired", path + ".defaultJson", "Enum fields require an explicit DefaultJson in V1.");
                }

                defaultValue = ParseDefault(metadata.DefaultJson, path);
                RequireTokenType(defaultValue, path, JTokenType.String);
                if (!names.Contains(defaultValue.Value<string>(), StringComparer.Ordinal))
                {
                    throw Error("catalog.invalidDefault", path + ".defaultJson", "Enum default must name a declared enum member.");
                }

                if (metadata.Editor != VisualBridgeEditorKind.Auto && metadata.Editor != VisualBridgeEditorKind.Select)
                {
                    throw Error("catalog.invalidEditor", path, "Enums support only Auto or Select editors.");
                }

                if (metadata.Integer
                    || !double.IsNaN(metadata.Min)
                    || !double.IsNaN(metadata.Max)
                    || !double.IsNaN(metadata.Step)
                    || metadata.ReferenceKind != null
                    || metadata.ReferenceTargetJson != null
                    || metadata.AllowMissingReference)
                {
                    throw Error("catalog.invalidMetadata", path, "Enum fields do not support numeric or reference metadata in V1.");
                }

                definition["editor"] = BuildEditor(metadata, "select", false, names.Select(name => new JObject
                {
                    ["title"] = name,
                    ["value"] = name,
                }));
            }
            else if (TryGetListItem(type, out var itemType))
            {
                var itemMetadata = FieldMetadata.ForNestedValue();
                var item = BuildValueDefinition(itemType, itemMetadata, recursionStack, path + "[]", false);
                definition = new JObject
                {
                    ["valueType"] = "array",
                    ["dataTypeId"] = metadata.DataTypeId ?? "array",
                };
                defaultValue = metadata.DefaultJson == null ? new JArray() : ParseDefault(metadata.DefaultJson, path);
                if (!(defaultValue is JArray defaultArray))
                {
                    throw Error("catalog.invalidDefault", path + ".defaultJson", "Expected a JSON array.");
                }

                foreach (var itemValue in defaultArray)
                {
                    ValidateDefaultAgainstDefinition(itemValue, item, path + ".defaultJson[]");
                }

                definition["defaultValue"] = Canonicalize(defaultValue);
                definition["item"] = item;
                ValidateExplicitEditor(metadata, "array", path);
                return definition;
            }
            else
            {
                ValidateObjectType(type, path);
                var fields = BuildFields(type, recursionStack, path);
                definition = new JObject
                {
                    ["valueType"] = "object",
                    ["dataTypeId"] = metadata.DataTypeId ?? RequireDataTypeId(type, path),
                };
                defaultValue = metadata.DefaultJson == null ? BuildObjectDefault(fields) : ParseDefault(metadata.DefaultJson, path);
                if (!(defaultValue is JObject))
                {
                    throw Error("catalog.invalidDefault", path + ".defaultJson", "Expected a JSON object.");
                }

                var shape = new JObject
                {
                    ["valueType"] = "object",
                    ["fields"] = fields,
                };
                ValidateDefaultAgainstDefinition(defaultValue, shape, path + ".defaultJson");
                definition["defaultValue"] = Canonicalize(defaultValue);
                definition["fields"] = fields;
                ValidateExplicitEditor(metadata, "object", path);
                return definition;
            }

            definition["defaultValue"] = Canonicalize(defaultValue);
            var enumEditor = definition.Property("editor", StringComparison.Ordinal);
            if (enumEditor != null)
            {
                var editorValue = enumEditor.Value;
                enumEditor.Remove();
                definition.Add("editor", editorValue);
            }

            if (includeFieldEditor && type.IsEnum == false && metadata.Editor != VisualBridgeEditorKind.Auto)
            {
                definition["editor"] = BuildEditor(metadata, EditorKindName(metadata.Editor), IsIntegral(type), null);
            }

            if (IsSupportedNumber(type)
                && (metadata.Editor == VisualBridgeEditorKind.Auto || metadata.Editor == VisualBridgeEditorKind.Number))
            {
                definition["editor"] = BuildNumberEditor(type, metadata);
            }
            else if (includeFieldEditor
                && metadata.Editor == VisualBridgeEditorKind.Auto
                && metadata.ReadOnly
                && type == typeof(string))
            {
                definition["editor"] = BuildEditor(metadata, "text", false, null);
            }
            else if (includeFieldEditor
                && metadata.Editor == VisualBridgeEditorKind.Auto
                && metadata.ReadOnly
                && type == typeof(bool))
            {
                definition["editor"] = BuildEditor(metadata, "checkbox", false, null);
            }

            if (includeFieldEditor)
            {
                AddReference(definition, metadata, path);
            }

            return definition;
        }

        private static JObject ScalarDefinition(string valueType, string dataTypeId)
        {
            ValidateIdentifier(dataTypeId, "dataTypeId");
            return new JObject
            {
                ["valueType"] = valueType,
                ["dataTypeId"] = dataTypeId,
            };
        }

        private static JObject BuildEditor(FieldMetadata metadata, string kind, bool inferredInteger, IEnumerable<JObject> options)
        {
            var editor = new JObject
            {
                ["kind"] = kind,
                ["readOnly"] = metadata.ReadOnly,
                ["integer"] = metadata.Integer || inferredInteger,
            };
            if (!double.IsNaN(metadata.Min))
            {
                RequireFinite(metadata.Min, "editor.min");
                editor["min"] = NumberToken(metadata.Min);
            }

            if (!double.IsNaN(metadata.Max))
            {
                RequireFinite(metadata.Max, "editor.max");
                editor["max"] = NumberToken(metadata.Max);
            }

            if (!double.IsNaN(metadata.Step))
            {
                RequireFinite(metadata.Step, "editor.step");
                if (metadata.Step <= 0)
                {
                    throw Error("catalog.invalidEditor", "editor.step", "Step must be greater than zero.");
                }

                editor["step"] = NumberToken(metadata.Step);
            }

            if (!double.IsNaN(metadata.Min) && !double.IsNaN(metadata.Max) && metadata.Min > metadata.Max)
            {
                throw Error("catalog.invalidEditor", "editor", "Min must not exceed max.");
            }

            if (options != null)
            {
                editor["options"] = new JArray(options);
            }

            return editor;
        }

        private static JObject BuildNumberEditor(Type type, FieldMetadata metadata)
        {
            var editor = BuildEditor(metadata, "number", IsIntegral(type), null);
            if (TryGetIntegralBounds(type, out var typeMin, out var typeMax))
            {
                if (editor["min"] == null)
                {
                    editor["min"] = NumberToken(typeMin);
                }

                if (editor["max"] == null)
                {
                    editor["max"] = NumberToken(typeMax);
                }
            }

            return OrderEditor(editor);
        }

        private static JObject OrderEditor(JObject editor)
        {
            var result = new JObject();
            foreach (var name in new[] { "kind", "readOnly", "integer", "min", "max", "step", "options" })
            {
                var property = editor.Property(name, StringComparison.Ordinal);
                if (property != null)
                {
                    result[name] = property.Value.DeepClone();
                }
            }

            return result;
        }

        private static void AddReference(JObject definition, FieldMetadata metadata, string path)
        {
            var hasKind = metadata.ReferenceKind != null;
            var hasTarget = metadata.ReferenceTargetJson != null;
            var hasEditor = metadata.Editor == VisualBridgeEditorKind.Reference;
            if (hasKind != hasTarget || hasEditor != (hasKind && hasTarget) || (metadata.AllowMissingReference && !hasKind))
            {
                throw Error("catalog.invalidReference", path, "Reference editor, kind and target metadata must be declared together; AllowMissing requires that complete reference metadata.");
            }

            if (!hasKind)
            {
                return;
            }

            ValidateIdentifier(metadata.ReferenceKind, path + ".referenceKind");
            var target = ParseDefault(metadata.ReferenceTargetJson, path + ".referenceTargetJson");
            if (!(target is JObject))
            {
                throw Error("catalog.invalidReference", path + ".referenceTargetJson", "Reference target must be a JSON object.");
            }

            var reference = new JObject
            {
                ["kind"] = metadata.ReferenceKind,
                ["target"] = Canonicalize(target),
            };
            if (metadata.AllowMissingReference)
            {
                reference["allowMissing"] = true;
            }

            definition["reference"] = reference;
        }

        private static FieldMetadata ReadFieldMetadata(FieldInfo field)
        {
            var attributes = field.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeFieldAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", field.Name, "Field declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new FieldMetadata
            {
                Id = ReadConstructorString(attribute, 0, field.Name),
                Title = ReadConstructorString(attribute, 1, field.Name),
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgeFieldAttribute.Aliases): result.Aliases = ReadStringArray(argument.TypedValue, field.Name); break;
                    case nameof(VisualBridgeFieldAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeFieldAttribute.Order): result.Order = (int)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeFieldAttribute.DataTypeId): result.DataTypeId = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeFieldAttribute.DefaultJson): result.DefaultJson = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeFieldAttribute.Editor): result.Editor = (VisualBridgeEditorKind)(int)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeFieldAttribute.ReadOnly): result.ReadOnly = (bool)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeFieldAttribute.Integer): result.Integer = (bool)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeFieldAttribute.Min): result.Min = (double)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeFieldAttribute.Max): result.Max = (double)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeFieldAttribute.Step): result.Step = (double)argument.TypedValue.Value; break;
                    case nameof(VisualBridgeFieldAttribute.ReferenceKind): result.ReferenceKind = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeFieldAttribute.ReferenceTargetJson): result.ReferenceTargetJson = argument.TypedValue.Value as string; break;
                    case nameof(VisualBridgeFieldAttribute.AllowMissingReference): result.AllowMissingReference = (bool)argument.TypedValue.Value; break;
                    default: throw Error("catalog.unknownMetadata", field.Name, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static ConfigMetadata ReadConfigMetadata(Type type)
        {
            var attributes = type.CustomAttributes.Where(attribute => attribute.AttributeType == typeof(VisualBridgeStructuredConfigAttribute)).ToArray();
            if (attributes.Length == 0)
            {
                return null;
            }

            if (attributes.Length != 1)
            {
                throw Error("catalog.duplicateMetadata", type.FullName, "Type declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var result = new ConfigMetadata
            {
                CatalogId = ReadConstructorString(attribute, 0, type.FullName),
                Id = ReadConstructorString(attribute, 1, type.FullName),
                Title = ReadConstructorString(attribute, 2, type.FullName),
            };
            foreach (var argument in attribute.NamedArguments)
            {
                switch (argument.MemberName)
                {
                    case nameof(VisualBridgeStructuredConfigAttribute.Aliases): result.Aliases = ReadStringArray(argument.TypedValue, type.FullName); break;
                    case nameof(VisualBridgeStructuredConfigAttribute.Description): result.Description = argument.TypedValue.Value as string; break;
                    default: throw Error("catalog.unknownMetadata", type.FullName, $"Unknown metadata member '{argument.MemberName}'.");
                }
            }

            return result;
        }

        private static CatalogMetadata ReadCatalogMetadata(Assembly assembly, string catalogId)
        {
            var matches = new List<CatalogMetadata>();
            foreach (var attribute in assembly.CustomAttributes.Where(value => value.AttributeType == typeof(VisualBridgeStructuredCatalogAttribute)))
            {
                var metadata = new CatalogMetadata
                {
                    CatalogId = ReadConstructorString(attribute, 0, assembly.FullName),
                    Title = ReadConstructorString(attribute, 1, assembly.FullName),
                };
                if (metadata.CatalogId == catalogId)
                {
                    matches.Add(metadata);
                }
            }

            if (matches.Count > 1)
            {
                throw Error("catalog.duplicateMetadata", assembly.FullName, $"Assembly declares catalog '{catalogId}' more than once.");
            }

            return matches.SingleOrDefault();
        }

        internal static string ReadConstructorString(CustomAttributeData attribute, int index, string path)
        {
            if (attribute.ConstructorArguments.Count <= index || !(attribute.ConstructorArguments[index].Value is string value))
            {
                throw Error("catalog.invalidMetadata", path, "Expected a string constructor argument.");
            }

            return value;
        }

        internal static string[] ReadStringArray(CustomAttributeTypedArgument argument, string path)
        {
            if (argument.Value == null)
            {
                return Array.Empty<string>();
            }

            if (!(argument.Value is IList values))
            {
                throw Error("catalog.invalidMetadata", path, "Expected a string array.");
            }

            var result = new string[values.Count];
            for (var index = 0; index < values.Count; index++)
            {
                var item = (CustomAttributeTypedArgument)values[index];
                if (!(item.Value is string text))
                {
                    throw Error("catalog.invalidMetadata", path, "Expected a string array.");
                }

                result[index] = text;
            }

            return result;
        }

    }
}
