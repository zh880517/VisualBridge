using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    internal static class VisualBridgeStructuredCatalogValidator
    {
        private static readonly HashSet<string> ValueTypes = new HashSet<string>(
            new[] { "string", "number", "boolean", "object", "array", "json" },
            StringComparer.Ordinal);

        private static readonly HashSet<string> EditorKinds = new HashSet<string>(
            new[] { "text", "multiline", "number", "checkbox", "select", "color", "reference", "json" },
            StringComparer.Ordinal);

        public static void Validate(JObject catalog)
        {
            RequireKeys(catalog, "$", new[] { "formatVersion", "catalogId", "title", "source", "configTypes" }, Array.Empty<string>());
            RequireInteger(catalog["formatVersion"], "$.formatVersion", 1);
            RequireIdentifier(catalog["catalogId"], "$.catalogId");
            RequireNonEmptyString(catalog["title"], "$.title");
            ValidateSource(RequireObject(catalog["source"], "$.source"), "$.source");
            var configTypes = RequireArray(catalog["configTypes"], "$.configTypes", true);
            var identities = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < configTypes.Count; index++)
            {
                ValidateConfigType(RequireObject(configTypes[index], $"$.configTypes[{index}]"), $"$.configTypes[{index}]", identities);
            }
        }

        internal static void ValidateSource(JObject source, string path)
        {
            var status = RequireString(source["status"], path + ".status");
            switch (status)
            {
                case "unknown":
                    RequireKeys(source, path, new[] { "status" }, Array.Empty<string>());
                    return;
                case "current":
                    RequireKeys(source, path, new[] { "status", "providerId", "sourceHash" }, Array.Empty<string>());
                    RequireIdentifier(source["providerId"], path + ".providerId");
                    RequireHash(source["sourceHash"], path + ".sourceHash");
                    return;
                case "stale":
                    RequireKeys(source, path, new[] { "status", "providerId", "sourceHash", "currentSourceHash" }, Array.Empty<string>());
                    RequireIdentifier(source["providerId"], path + ".providerId");
                    var sourceHash = RequireHash(source["sourceHash"], path + ".sourceHash");
                    var currentHash = RequireHash(source["currentSourceHash"], path + ".currentSourceHash");
                    if (sourceHash == currentHash)
                    {
                        throw Error("catalog.invalidSource", path + ".currentSourceHash", "Stale hashes must differ.");
                    }

                    return;
                default:
                    throw Error("catalog.invalidSource", path + ".status", "Unknown source status.");
            }
        }

        private static void ValidateConfigType(JObject configType, string path, HashSet<string> identities)
        {
            RequireKeys(
                configType,
                path,
                new[] { "id", "title", "aliases", "properties" },
                new[] { "description", "source" });
            var id = RequireIdentifier(configType["id"], path + ".id");
            RequireNonEmptyString(configType["title"], path + ".title");
            AddIdentity(identities, id, path + ".id");
            foreach (var alias in RequireIdentifierArray(configType["aliases"], path + ".aliases"))
            {
                AddIdentity(identities, alias, path + ".aliases");
            }

            if (configType["description"] != null)
            {
                RequireNonEmptyString(configType["description"], path + ".description");
            }

            if (configType["source"] != null)
            {
                var source = RequireObject(configType["source"], path + ".source");
                RequireKeys(source, path + ".source", new[] { "providerId", "typeName" }, Array.Empty<string>());
                RequireIdentifier(source["providerId"], path + ".source.providerId");
                RequireNonEmptyString(source["typeName"], path + ".source.typeName");
            }

            var fields = RequireArray(configType["properties"], path + ".properties", false);
            ValidateFields(fields, path + ".properties");
        }

        internal static void ValidateFields(JArray fields, string path)
        {
            var identities = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < fields.Count; index++)
            {
                var fieldPath = $"{path}[{index}]";
                var field = RequireObject(fields[index], fieldPath);
                RequireKeys(
                    field,
                    fieldPath,
                    new[] { "id", "title", "valueType", "defaultValue" },
                    new[] { "aliases", "description", "dataTypeId", "editor", "reference", "fields", "item" });
                var id = RequireIdentifier(field["id"], fieldPath + ".id");
                AddIdentity(identities, id, fieldPath + ".id");
                RequireNonEmptyString(field["title"], fieldPath + ".title");
                if (field["aliases"] != null)
                {
                    foreach (var alias in RequireIdentifierArray(field["aliases"], fieldPath + ".aliases"))
                    {
                        AddIdentity(identities, alias, fieldPath + ".aliases");
                    }
                }

                if (field["description"] != null)
                {
                    RequireNonEmptyString(field["description"], fieldPath + ".description");
                }

                ValidateValueDefinition(field, fieldPath);
            }
        }

        internal static void ValidateValueDefinition(JObject definition, string path)
        {
            var valueType = RequireString(definition["valueType"], path + ".valueType");
            if (!ValueTypes.Contains(valueType))
            {
                throw Error("catalog.invalidValueType", path + ".valueType", "Unknown valueType.");
            }

            if (definition["defaultValue"] == null)
            {
                throw Error("catalog.missingProperty", path + ".defaultValue", "Missing defaultValue.");
            }

            ValidateFiniteJson(definition["defaultValue"], path + ".defaultValue");
            if (definition["dataTypeId"] != null)
            {
                RequireIdentifier(definition["dataTypeId"], path + ".dataTypeId");
            }

            JObject editor = null;
            if (definition["editor"] != null)
            {
                editor = RequireObject(definition["editor"], path + ".editor");
                ValidateEditor(editor, valueType, definition["defaultValue"], path + ".editor");
            }

            JObject reference = null;
            if (definition["reference"] != null)
            {
                reference = RequireObject(definition["reference"], path + ".reference");
                ValidateReference(reference, valueType, path + ".reference");
            }

            if (editor != null
                && string.Equals(editor.Value<string>("kind"), "reference", StringComparison.Ordinal)
                && reference == null)
            {
                throw Error("catalog.invalidReference", path + ".editor", "Reference editor requires reference metadata.");
            }

            if (valueType == "object")
            {
                if (definition["item"] != null)
                {
                    throw Error("catalog.invalidValueShape", path + ".item", "Object values cannot declare item.");
                }

                var fields = RequireArray(definition["fields"], path + ".fields", false);
                ValidateFields(fields, path + ".fields");
            }
            else if (valueType == "array")
            {
                if (definition["fields"] != null)
                {
                    throw Error("catalog.invalidValueShape", path + ".fields", "Array values cannot declare fields.");
                }

                var item = RequireObject(definition["item"], path + ".item");
                RequireKeys(
                    item,
                    path + ".item",
                    new[] { "valueType", "defaultValue" },
                    new[] { "dataTypeId", "editor", "reference", "fields", "item" });
                ValidateValueDefinition(item, path + ".item");
            }
            else if (definition["fields"] != null || definition["item"] != null)
            {
                throw Error("catalog.invalidValueShape", path, "Scalar values cannot declare fields or item.");
            }

            ValidateValueAgainstDefinition(definition["defaultValue"], definition, path + ".defaultValue");
        }

        private static void ValidateEditor(JObject editor, string valueType, JToken defaultValue, string path)
        {
            RequireKeys(
                editor,
                path,
                new[] { "kind" },
                new[] { "readOnly", "integer", "min", "max", "step", "options" });
            var kind = RequireString(editor["kind"], path + ".kind");
            if (!EditorKinds.Contains(kind))
            {
                throw Error("catalog.invalidEditor", path + ".kind", "Unknown editor kind.");
            }

            RequireOptionalBoolean(editor["readOnly"], path + ".readOnly");
            RequireOptionalBoolean(editor["integer"], path + ".integer");
            var min = RequireOptionalNumber(editor["min"], path + ".min");
            var max = RequireOptionalNumber(editor["max"], path + ".max");
            var step = RequireOptionalNumber(editor["step"], path + ".step");
            if (min.HasValue && max.HasValue && min.Value > max.Value)
            {
                throw Error("catalog.invalidEditor", path, "Min cannot exceed max.");
            }

            if (step.HasValue && step.Value <= 0)
            {
                throw Error("catalog.invalidEditor", path + ".step", "Step must be greater than zero.");
            }

            var integer = editor["integer"] != null && editor["integer"].Value<bool>();
            if ((integer && valueType != "number")
                || ((min.HasValue || max.HasValue || step.HasValue) && valueType != "number"))
            {
                throw Error("catalog.invalidEditor", path, "Numeric editor constraints require valueType 'number'.");
            }

            if ((min.HasValue || max.HasValue || step.HasValue || integer) && kind != "number")
            {
                throw Error("catalog.invalidEditor", path, "Numeric editor constraints are only valid for the number editor.");
            }

            var compatible = kind == "select"
                || kind == "json"
                || ((kind == "text" || kind == "multiline" || kind == "color") && valueType == "string")
                || (kind == "reference" && (valueType == "string" || valueType == "number"))
                || (kind == "number" && valueType == "number")
                || (kind == "checkbox" && valueType == "boolean");
            if (!compatible)
            {
                throw Error("catalog.invalidEditor", path + ".kind", "Editor is incompatible with valueType.");
            }

            if (kind == "select")
            {
                if (valueType != "string" && valueType != "number" && valueType != "boolean")
                {
                    throw Error("catalog.invalidEditor", path + ".kind", "Select editor requires a scalar string, number, or boolean value.");
                }

                var options = RequireArray(editor["options"], path + ".options", true);
                var optionValues = new List<JToken>();
                for (var index = 0; index < options.Count; index++)
                {
                    var optionToken = options[index];
                    var option = RequireObject(optionToken, path + ".options");
                    RequireKeys(option, path + ".options", new[] { "title", "value" }, Array.Empty<string>());
                    RequireNonEmptyString(option["title"], path + ".options.title");
                    ValidateFiniteJson(option["value"], path + ".options.value");
                    ValidateScalarToken(option["value"], valueType, path + $".options[{index}].value");
                    if (optionValues.Any(existing => JToken.DeepEquals(existing, option["value"])))
                    {
                        throw Error("catalog.invalidEditor", path + $".options[{index}].value", "Select option values must be unique.");
                    }

                    optionValues.Add(option["value"]);
                }

                if (!optionValues.Any(value => JToken.DeepEquals(value, defaultValue)))
                {
                    throw Error("catalog.invalidEditor", path + ".options", "Select options must contain defaultValue.");
                }
            }
            else if (editor["options"] != null)
            {
                throw Error("catalog.invalidEditor", path + ".options", "Only Select editors may declare options.");
            }
        }

        private static void ValidateValueAgainstDefinition(JToken value, JObject definition, string path)
        {
            var valueType = definition.Value<string>("valueType");
            switch (valueType)
            {
                case "string":
                case "number":
                case "boolean":
                    ValidateScalarToken(value, valueType, path);
                    break;
                case "object":
                    if (!(value is JObject objectValue))
                    {
                        throw Error("catalog.invalidDefault", path, "Expected an object defaultValue.");
                    }

                    var fields = ((JArray)definition["fields"]).Cast<JObject>().ToDictionary(field => field.Value<string>("id"), StringComparer.Ordinal);
                    foreach (var property in objectValue.Properties())
                    {
                        if (!fields.TryGetValue(property.Name, out var field))
                        {
                            throw Error("catalog.invalidDefault", path + "." + property.Name, "Unknown object default field.");
                        }

                        ValidateValueAgainstDefinition(property.Value, field, path + "." + property.Name);
                    }

                    foreach (var field in fields)
                    {
                        if (objectValue.Property(field.Key, StringComparison.Ordinal) == null)
                        {
                            throw Error("catalog.invalidDefault", path + "." + field.Key, "Object defaultValue must declare every field.");
                        }
                    }

                    break;
                case "array":
                    if (!(value is JArray array))
                    {
                        throw Error("catalog.invalidDefault", path, "Expected an array defaultValue.");
                    }

                    var item = (JObject)definition["item"];
                    for (var index = 0; index < array.Count; index++)
                    {
                        ValidateValueAgainstDefinition(array[index], item, path + $"[{index}]");
                    }

                    break;
                case "json":
                    ValidateFiniteJson(value, path);
                    break;
                default:
                    throw Error("catalog.invalidValueType", path, "Unknown valueType.");
            }

            if (definition["editor"] is JObject editor && valueType == "number")
            {
                var number = value.Value<double>();
                if (editor["integer"] != null && editor["integer"].Value<bool>() && value.Type != JTokenType.Integer)
                {
                    throw Error("catalog.invalidDefault", path, "Integer editor requires an integral defaultValue.");
                }

                var min = RequireOptionalNumber(editor["min"], path + ".editor.min");
                var max = RequireOptionalNumber(editor["max"], path + ".editor.max");
                if ((min.HasValue && number < min.Value) || (max.HasValue && number > max.Value))
                {
                    throw Error("catalog.invalidDefault", path, "Numeric defaultValue is outside editor min/max bounds.");
                }
            }
        }

        private static void ValidateScalarToken(JToken value, string valueType, string path)
        {
            var valid = valueType == "string" && value.Type == JTokenType.String
                || valueType == "boolean" && value.Type == JTokenType.Boolean
                || valueType == "number" && (value.Type == JTokenType.Integer || value.Type == JTokenType.Float);
            if (!valid)
            {
                throw Error("catalog.invalidDefault", path, $"Value does not match valueType '{valueType}'.");
            }

            ValidateFiniteJson(value, path);
        }

        private static void ValidateReference(JObject reference, string valueType, string path)
        {
            RequireKeys(reference, path, new[] { "kind", "target" }, new[] { "allowMissing" });
            if (valueType != "string" && valueType != "number")
            {
                throw Error("catalog.invalidReference", path, "References require a string or number value.");
            }

            RequireIdentifier(reference["kind"], path + ".kind");
            RequireObject(reference["target"], path + ".target");
            ValidateFiniteJson(reference["target"], path + ".target");
            RequireOptionalBoolean(reference["allowMissing"], path + ".allowMissing");
        }

        internal static void RequireKeys(JObject value, string path, IEnumerable<string> required, IEnumerable<string> optional)
        {
            var requiredSet = new HashSet<string>(required, StringComparer.Ordinal);
            var allowed = new HashSet<string>(requiredSet, StringComparer.Ordinal);
            allowed.UnionWith(optional);
            foreach (var property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw Error("catalog.unknownProperty", path + "." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var name in requiredSet)
            {
                if (value.Property(name, StringComparison.Ordinal) == null)
                {
                    throw Error("catalog.missingProperty", path + "." + name, $"Missing property '{name}'.");
                }
            }
        }

        internal static JObject RequireObject(JToken token, string path)
        {
            if (!(token is JObject value))
            {
                throw Error("catalog.invalidObject", path, "Expected an object.");
            }

            return value;
        }

        internal static JArray RequireArray(JToken token, string path, bool requireNonEmpty)
        {
            if (!(token is JArray value) || (requireNonEmpty && value.Count == 0))
            {
                throw Error("catalog.invalidArray", path, requireNonEmpty ? "Expected a non-empty array." : "Expected an array.");
            }

            return value;
        }

        internal static string RequireString(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("catalog.invalidString", path, "Expected a string.");
            }

            return token.Value<string>();
        }

        internal static string RequireNonEmptyString(JToken token, string path)
        {
            var value = RequireString(token, path);
            if (string.IsNullOrWhiteSpace(value))
            {
                throw Error("catalog.invalidString", path, "Expected a non-empty string.");
            }

            return value;
        }

        internal static string RequireIdentifier(JToken token, string path)
        {
            var value = RequireString(token, path);
            if (value.Length == 0
                || value.Length > 128
                || !IsAsciiAlphaNumeric(value[0])
                || value.Any(character => !IsAsciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-'))
            {
                throw Error("catalog.invalidIdentifier", path, "Expected a stable identifier.");
            }

            return value;
        }

        internal static IReadOnlyList<string> RequireIdentifierArray(JToken token, string path)
        {
            var array = RequireArray(token, path, false);
            var values = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var value = RequireIdentifier(array[index], $"{path}[{index}]");
                if (!unique.Add(value))
                {
                    throw Error("catalog.duplicateIdentifier", $"{path}[{index}]", $"Duplicate identifier '{value}'.");
                }

                values.Add(value);
            }

            return values;
        }

        internal static void RequireInteger(JToken token, string path, int expected)
        {
            if (token == null || token.Type != JTokenType.Integer || token.Value<int>() != expected)
            {
                throw Error("catalog.unsupportedVersion", path, $"Expected integer {expected}.");
            }
        }

        private static string RequireHash(JToken token, string path)
        {
            var value = RequireString(token, path);
            if (value.Length != 64 || value.Any(character => !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))))
            {
                throw Error("catalog.invalidHash", path, "Expected a lowercase SHA-256 hash.");
            }

            return value;
        }

        private static void RequireOptionalBoolean(JToken token, string path)
        {
            if (token != null && token.Type != JTokenType.Boolean)
            {
                throw Error("catalog.invalidBoolean", path, "Expected a boolean.");
            }
        }

        private static double? RequireOptionalNumber(JToken token, string path)
        {
            if (token == null)
            {
                return null;
            }

            if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
            {
                throw Error("catalog.invalidNumber", path, "Expected a number.");
            }

            var value = token.Value<double>();
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw Error("catalog.invalidNumber", path, "Expected a finite number.");
            }

            return value;
        }

        private static void ValidateFiniteJson(JToken token, string path)
        {
            if (token == null)
            {
                throw Error("catalog.invalidJson", path, "Expected a JSON value.");
            }

            if (token.Type == JTokenType.Undefined
                || token.Type == JTokenType.Comment
                || token.Type == JTokenType.Raw
                || token.Type == JTokenType.Date
                || token.Type == JTokenType.Bytes
                || token.Type == JTokenType.Guid
                || token.Type == JTokenType.Uri
                || token.Type == JTokenType.TimeSpan)
            {
                throw Error("catalog.invalidJson", path, "Expected a finite JSON value.");
            }

            if (token.Type == JTokenType.Float)
            {
                var number = token.Value<double>();
                if (double.IsNaN(number) || double.IsInfinity(number))
                {
                    throw Error("catalog.invalidJson", path, "Non-finite numbers are forbidden.");
                }
            }

            if (token is JContainer container)
            {
                foreach (var child in container.Children())
                {
                    ValidateFiniteJson(child is JProperty property ? property.Value : child, path);
                }
            }
        }

        private static void AddIdentity(HashSet<string> identities, string identity, string path)
        {
            if (!identities.Add(identity))
            {
                throw Error("catalog.identityConflict", path, $"Identity '{identity}' is already used.");
            }
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        internal static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }
    }
}
