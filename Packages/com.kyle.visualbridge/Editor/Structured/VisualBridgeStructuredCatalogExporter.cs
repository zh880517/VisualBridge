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
    public enum VisualBridgeCatalogExportMode
    {
        Generate,
        Check,
    }

    public sealed class VisualBridgeCatalogExportOutput
    {
        internal VisualBridgeCatalogExportOutput(string path, string expectedSha256, string previousSha256, bool changed)
        {
            Path = path;
            ExpectedSha256 = expectedSha256;
            PreviousSha256 = previousSha256;
            Changed = changed;
        }

        public string Path { get; }

        public string ExpectedSha256 { get; }

        public string PreviousSha256 { get; }

        public bool Changed { get; }
    }

    public sealed class VisualBridgeCatalogExportResult
    {
        internal VisualBridgeCatalogExportResult(VisualBridgeCatalogExportMode mode, IReadOnlyList<VisualBridgeCatalogExportOutput> outputs)
        {
            Mode = mode;
            Outputs = outputs;
        }

        public VisualBridgeCatalogExportMode Mode { get; }

        public IReadOnlyList<VisualBridgeCatalogExportOutput> Outputs { get; }

        public bool DriftDetected => Outputs.Any(output => output.Changed);
    }

    public static class VisualBridgeStructuredCatalogExporter
    {
        public const string ProviderId = "unity.csharp";

        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false, true);
        private static readonly Regex ColorPattern = new Regex("^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$", RegexOptions.CultureInvariant);

        public static VisualBridgeCatalogExportResult Export(string unityProjectRoot, VisualBridgeCatalogExportMode mode)
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(unityProjectRoot);
            var plans = profile.CatalogExports
                .Select(export => BuildPlan(profile.ProjectRoot, export))
                .OrderBy(plan => plan.OutputPath, StringComparer.Ordinal)
                .ToArray();
            ValidateAuthoringProjectBindings(profile, plans);

            var outputs = new List<VisualBridgeCatalogExportOutput>(plans.Length);
            foreach (var plan in plans)
            {
                var existingBytes = File.Exists(plan.OutputPath) ? File.ReadAllBytes(plan.OutputPath) : null;
                outputs.Add(new VisualBridgeCatalogExportOutput(
                    plan.OutputPath,
                    plan.ExpectedHash,
                    existingBytes == null ? null : HashBytes(existingBytes),
                    existingBytes == null || !existingBytes.SequenceEqual(plan.Bytes)));
            }

            if (mode == VisualBridgeCatalogExportMode.Generate)
            {
                for (var index = 0; index < plans.Length; index++)
                {
                    if (outputs[index].Changed)
                    {
                        WriteAtomically(plans[index], outputs[index].PreviousSha256);
                    }
                }
            }

            return new VisualBridgeCatalogExportResult(mode, outputs);
        }

        private static ExportPlan BuildPlan(string projectRoot, VisualBridgeResolvedCatalogExport export)
        {
            var catalogAttribute = default(CatalogMetadata);
            var configTypes = new List<JObject>();
            var sourceTypes = new List<JObject>();
            var typeIdentities = new HashSet<string>(StringComparer.Ordinal);

            foreach (var registeredName in export.Types)
            {
                var type = Type.GetType(registeredName, false, false);
                if (type == null)
                {
                    throw Error("catalog.typeNotFound", registeredName, "Registered type could not be resolved.");
                }

                ValidateRootType(type, registeredName);
                var assemblyCatalog = ReadCatalogMetadata(type.Assembly, export.CatalogId);
                if (assemblyCatalog == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, $"Assembly does not declare catalog metadata for '{export.CatalogId}'.");
                }

                if (!string.Equals(assemblyCatalog.Title, export.Title, StringComparison.Ordinal))
                {
                    throw Error("catalog.titleMismatch", registeredName, "Profile and assembly catalog titles differ.");
                }

                catalogAttribute = catalogAttribute ?? assemblyCatalog;
                var configMetadata = ReadConfigMetadata(type);
                if (configMetadata == null)
                {
                    throw Error("catalog.metadataMissing", registeredName, "Type does not declare VisualBridgeStructuredConfig metadata.");
                }

                if (!string.Equals(configMetadata.CatalogId, export.CatalogId, StringComparison.Ordinal))
                {
                    throw Error("catalog.catalogIdMismatch", registeredName, "Type metadata belongs to a different catalog.");
                }

                ValidateIdentifier(configMetadata.Id, registeredName + ".id");
                ValidateNonEmpty(configMetadata.Title, registeredName + ".title");
                ValidateAliases(configMetadata.Id, configMetadata.Aliases, registeredName + ".aliases");
                foreach (var identity in new[] { configMetadata.Id }.Concat(configMetadata.Aliases))
                {
                    if (!typeIdentities.Add(identity))
                    {
                        throw Error("catalog.identityConflict", registeredName, $"Config type identity '{identity}' is already used.");
                    }
                }

                var fields = BuildFields(type, new HashSet<Type>(), registeredName);
                var configType = new JObject
                {
                    ["id"] = configMetadata.Id,
                    ["title"] = configMetadata.Title,
                    ["aliases"] = new JArray(configMetadata.Aliases.OrderBy(value => value, StringComparer.Ordinal)),
                };
                if (configMetadata.Description != null)
                {
                    ValidateNonEmpty(configMetadata.Description, registeredName + ".description");
                    configType["description"] = configMetadata.Description;
                }

                configType["source"] = new JObject
                {
                    ["providerId"] = ProviderId,
                    ["typeName"] = registeredName,
                };
                configType["properties"] = fields;
                configTypes.Add(configType);
                sourceTypes.Add(new JObject
                {
                    ["assemblyQualifiedName"] = registeredName,
                    ["config"] = Canonicalize(configType),
                });
            }

            if (catalogAttribute == null)
            {
                throw Error("catalog.empty", export.CatalogId, "Catalog export has no registered types.");
            }

            configTypes.Sort((left, right) => StringComparer.Ordinal.Compare(left.Value<string>("id"), right.Value<string>("id")));
            sourceTypes.Sort((left, right) =>
            {
                var idComparison = StringComparer.Ordinal.Compare(
                    left["config"]?.Value<string>("id"),
                    right["config"]?.Value<string>("id"));
                return idComparison != 0
                    ? idComparison
                    : StringComparer.Ordinal.Compare(
                        left.Value<string>("assemblyQualifiedName"),
                        right.Value<string>("assemblyQualifiedName"));
            });
            var snapshot = new JObject
            {
                ["formatVersion"] = 1,
                ["providerId"] = ProviderId,
                ["catalogId"] = export.CatalogId,
                ["title"] = export.Title,
                ["types"] = new JArray(sourceTypes),
            };
            var snapshotBytes = Utf8WithoutBom.GetBytes(WriteCompact(Canonicalize(snapshot)));
            var sourceHash = HashBytes(snapshotBytes);
            var catalog = new JObject
            {
                ["formatVersion"] = 1,
                ["catalogId"] = export.CatalogId,
                ["title"] = export.Title,
                ["source"] = new JObject
                {
                    ["status"] = "current",
                    ["providerId"] = ProviderId,
                    ["sourceHash"] = sourceHash,
                },
                ["configTypes"] = new JArray(configTypes),
            };
            VisualBridgeStructuredCatalogValidator.Validate(catalog);
            var bytes = Utf8WithoutBom.GetBytes(WriteIndented(catalog));
            return new ExportPlan(projectRoot, export.OutputPath, bytes, HashBytes(bytes), catalog);
        }

        private static JArray BuildFields(Type type, HashSet<Type> recursionStack, string path)
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

        private static JObject BuildValueDefinition(
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

        private static string ReadConstructorString(CustomAttributeData attribute, int index, string path)
        {
            if (attribute.ConstructorArguments.Count <= index || !(attribute.ConstructorArguments[index].Value is string value))
            {
                throw Error("catalog.invalidMetadata", path, "Expected a string constructor argument.");
            }

            return value;
        }

        private static string[] ReadStringArray(CustomAttributeTypedArgument argument, string path)
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

        private static void ValidateRootType(Type type, string path)
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

        private static void ValidateAliases(string id, IReadOnlyList<string> aliases, string path)
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

        private static void ValidateIdentifier(string value, string path)
        {
            if (string.IsNullOrEmpty(value)
                || value.Length > 128
                || !IsAsciiAlphaNumeric(value[0])
                || value.Any(character => !IsAsciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-'))
            {
                throw Error("catalog.invalidIdentifier", path, "Expected a stable identifier.");
            }
        }

        private static void ValidateNonEmpty(string value, string path)
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

        private static void ValidateAuthoringProjectBindings(VisualBridgeResolvedProfile profile, IReadOnlyList<ExportPlan> plans)
        {
            var project = VisualBridgeAuthoringProjectParser.Parse(profile.AuthoringProjectPath);
            var pathComparer = Path.DirectorySeparatorChar == '\\' ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
            var plansByPath = plans.ToDictionary(plan => Path.GetFullPath(plan.OutputPath), pathComparer);
            var bindings = new Dictionary<ExportPlan, Dictionary<string, List<string>>>();
            var globalIdentities = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var plan in plans)
            {
                var perConfig = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                foreach (var config in ((JArray)plan.Catalog["configTypes"]).Cast<JObject>())
                {
                    var canonicalId = config.Value<string>("id");
                    perConfig.Add(canonicalId, new List<string>());
                    foreach (var identity in new[] { canonicalId }.Concat(((JArray)config["aliases"]).Values<string>()))
                    {
                        if (globalIdentities.TryGetValue(identity, out var owner))
                        {
                            throw Error(
                                "profile.catalogIdentityConflict",
                                plan.OutputPath,
                                $"Config identity '{identity}' is already exported by '{owner}'.");
                        }

                        globalIdentities.Add(identity, plan.OutputPath);
                    }
                }

                bindings.Add(plan, perConfig);
            }

            foreach (var documentType in project.DocumentTypes.Where(value => value.Editor == "structured"))
            {
                foreach (var relativeCatalog in documentType.Catalogs)
                {
                    var catalogPath = VisualBridgeAuthoringProjectParser.ResolveInsideProject(
                        project,
                        relativeCatalog,
                        documentType.Id + ".catalogs");
                    if (!plansByPath.TryGetValue(catalogPath, out var plan))
                    {
                        continue;
                    }

                    var matches = ((JArray)plan.Catalog["configTypes"])
                        .Cast<JObject>()
                        .Where(config => string.Equals(config.Value<string>("id"), documentType.Id, StringComparison.Ordinal)
                            || ((JArray)config["aliases"]).Values<string>().Contains(documentType.Id, StringComparer.Ordinal))
                        .ToArray();
                    if (matches.Length == 0)
                    {
                        throw Error(
                            "profile.catalogDocumentTypeUnbound",
                            documentType.Id,
                            $"Structured Document Type does not resolve to a Config Type in Unity-owned Catalog '{relativeCatalog}'.");
                    }

                    if (matches.Length != 1)
                    {
                        throw Error(
                            "profile.catalogDocumentTypeAmbiguous",
                            documentType.Id,
                            $"Structured Document Type resolves to multiple Config Types in Unity-owned Catalog '{relativeCatalog}'.");
                    }

                    bindings[plan][matches[0].Value<string>("id")].Add(documentType.Id);
                }
            }

            foreach (var plan in plans)
            {
                var relative = MakeRelativePath(project.RootPath, plan.OutputPath);
                if (relative.StartsWith("../", StringComparison.Ordinal)
                    || !project.DocumentTypes.Any(documentType => documentType.Editor == "structured"
                        && documentType.Catalogs.Any(catalog => pathComparer.Equals(
                            VisualBridgeAuthoringProjectParser.ResolveInsideProject(project, catalog, documentType.Id + ".catalogs"),
                            plan.OutputPath))))
                {
                    throw Error("profile.catalogNotDeclared", plan.OutputPath, "Export output is not declared by a Structured Document Type.");
                }

                foreach (var config in bindings[plan])
                {
                    if (config.Value.Count == 0)
                    {
                        throw Error(
                            "profile.configDocumentTypeMissing",
                            config.Key,
                            $"Exported Config Type is not covered by a Structured Document Type that declares Catalog '{relative}'.");
                    }

                    if (config.Value.Count != 1)
                    {
                        throw Error(
                            "profile.configDocumentTypeAmbiguous",
                            config.Key,
                            "Exported Config Type is covered by multiple Structured Document Types: "
                                + string.Join(", ", config.Value.OrderBy(value => value, StringComparer.Ordinal)));
                    }
                }
            }
        }

        private static string MakeRelativePath(string directory, string path)
        {
            var baseUri = new Uri(Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar);
            var pathUri = new Uri(Path.GetFullPath(path));
            return Uri.UnescapeDataString(baseUri.MakeRelativeUri(pathUri).ToString()).Replace('\\', '/');
        }

        private static JToken Canonicalize(JToken value)
        {
            if (value is JObject objectValue)
            {
                var result = new JObject();
                foreach (var property in objectValue.Properties().OrderBy(property => property.Name, StringComparer.Ordinal))
                {
                    result[property.Name] = Canonicalize(property.Value);
                }

                return result;
            }

            if (value is JArray array)
            {
                return new JArray(array.Select(Canonicalize));
            }

            return value.DeepClone();
        }

        private static IEnumerable<JToken> EnumerateTokens(JToken token)
        {
            yield return token;
            if (token is JContainer container)
            {
                foreach (var child in container.Children())
                {
                    foreach (var descendant in EnumerateTokens(child))
                    {
                        yield return descendant;
                    }
                }
            }
        }

        private static bool ContainsTokenType(JToken token, JTokenType type)
        {
            return EnumerateTokens(token).Any(value => value.Type == type);
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        private static string WriteCompact(JToken value)
        {
            return WriteJson(value, Formatting.None, false);
        }

        private static string WriteIndented(JToken value)
        {
            return WriteJson(value, Formatting.Indented, true);
        }

        private static string WriteJson(JToken value, Formatting formatting, bool finalNewline)
        {
            var builder = new StringBuilder();
            using (var stringWriter = new StringWriter(builder, CultureInfo.InvariantCulture) { NewLine = "\n" })
            using (var writer = new JsonTextWriter(stringWriter)
            {
                Formatting = formatting,
                Indentation = 2,
                IndentChar = ' ',
                Culture = CultureInfo.InvariantCulture,
                StringEscapeHandling = StringEscapeHandling.Default,
            })
            {
                value.WriteTo(writer);
                writer.Flush();
            }

            return finalNewline ? builder + "\n" : builder.ToString();
        }

        private static string HashBytes(byte[] bytes)
        {
            using (var sha256 = SHA256.Create())
            {
                return string.Concat(sha256.ComputeHash(bytes).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        private static void WriteAtomically(ExportPlan plan, string baselineHash)
        {
            VisualBridgeIntegrationProfileLoader.RevalidateResolvedProjectPath(plan.ProjectRoot, plan.OutputPath, plan.OutputPath);
            var directory = Path.GetDirectoryName(plan.OutputPath);
            Directory.CreateDirectory(directory);
            VisualBridgeIntegrationProfileLoader.RevalidateResolvedProjectPath(plan.ProjectRoot, plan.OutputPath, plan.OutputPath);
            var temporaryPath = plan.OutputPath + ".visualbridge." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(plan.Bytes, 0, plan.Bytes.Length);
                    stream.Flush(true);
                }

                VisualBridgeIntegrationProfileLoader.RevalidateResolvedProjectPath(plan.ProjectRoot, plan.OutputPath, plan.OutputPath);
                var outputExists = File.Exists(plan.OutputPath);
                var currentHash = outputExists ? HashBytes(File.ReadAllBytes(plan.OutputPath)) : null;
                if (!string.Equals(currentHash, baselineHash, StringComparison.Ordinal))
                {
                    throw Error("catalog.changedBeforeReplace", plan.OutputPath, "Output changed after planning and before atomic replacement.");
                }

                if (outputExists)
                {
                    File.Replace(temporaryPath, plan.OutputPath, null);
                }
                else
                {
                    File.Move(temporaryPath, plan.OutputPath);
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

        private sealed class ExportPlan
        {
            public ExportPlan(string projectRoot, string outputPath, byte[] bytes, string expectedHash, JObject catalog)
            {
                ProjectRoot = projectRoot;
                OutputPath = outputPath;
                Bytes = bytes;
                ExpectedHash = expectedHash;
                Catalog = catalog;
            }

            public string ProjectRoot { get; }

            public string OutputPath { get; }

            public byte[] Bytes { get; }

            public string ExpectedHash { get; }

            public JObject Catalog { get; }
        }

        private sealed class CatalogMetadata
        {
            public string CatalogId { get; set; }
            public string Title { get; set; }
        }

        private sealed class ConfigMetadata
        {
            public string CatalogId { get; set; }
            public string Id { get; set; }
            public string Title { get; set; }
            public string[] Aliases { get; set; } = Array.Empty<string>();
            public string Description { get; set; }
        }

        private sealed class FieldMetadata
        {
            public string Id { get; set; }
            public string Title { get; set; }
            public string[] Aliases { get; set; } = Array.Empty<string>();
            public string Description { get; set; }
            public int Order { get; set; }
            public string DataTypeId { get; set; }
            public string DefaultJson { get; set; }
            public VisualBridgeEditorKind Editor { get; set; }
            public bool ReadOnly { get; set; }
            public bool Integer { get; set; }
            public double Min { get; set; } = double.NaN;
            public double Max { get; set; } = double.NaN;
            public double Step { get; set; } = double.NaN;
            public string ReferenceKind { get; set; }
            public string ReferenceTargetJson { get; set; }
            public bool AllowMissingReference { get; set; }

            public static FieldMetadata ForNestedValue()
            {
                return new FieldMetadata();
            }
        }
    }
}
