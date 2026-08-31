using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 严格 JObject 校验器，镜像 visualbridge-table-catalog.schema.json。字段/valueDefinition 校验复用
    /// Structured 校验器的共享实现（列定义剥掉 Table 专属键后等价于共享 field 定义）。
    /// </summary>
    internal static class VisualBridgeTableCatalogValidator
    {
        private static readonly string[] ColumnFieldKeys =
        {
            "id", "title", "aliases", "description", "valueType", "dataTypeId", "defaultValue", "editor", "reference", "fields", "item",
        };

        private static readonly HashSet<string> PrimitiveValueTypes = new HashSet<string>(
            new[] { "string", "number", "boolean" },
            StringComparer.Ordinal);

        private static readonly HashSet<string> DuplicatePolicies = new HashSet<string>(
            new[] { "error", "keepFirst", "keepLast" },
            StringComparer.Ordinal);

        public static void Validate(JObject catalog)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                catalog,
                "$",
                new[] { "formatVersion", "catalogId", "title", "source", "tableTypes" },
                Array.Empty<string>());
            VisualBridgeStructuredCatalogValidator.RequireInteger(catalog["formatVersion"], "$.formatVersion", 1);
            VisualBridgeStructuredCatalogValidator.RequireIdentifier(catalog["catalogId"], "$.catalogId");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(catalog["title"], "$.title");
            VisualBridgeStructuredCatalogValidator.ValidateSource(
                VisualBridgeStructuredCatalogValidator.RequireObject(catalog["source"], "$.source"),
                "$.source");

            var tableTypes = VisualBridgeStructuredCatalogValidator.RequireArray(catalog["tableTypes"], "$.tableTypes", true);
            var identities = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < tableTypes.Count; index++)
            {
                ValidateTableType(
                    VisualBridgeStructuredCatalogValidator.RequireObject(tableTypes[index], $"$.tableTypes[{index}]"),
                    $"$.tableTypes[{index}]",
                    identities);
            }
        }

        private static void ValidateTableType(JObject tableType, string path, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                tableType,
                path,
                new[] { "id", "title", "sheets" },
                new[] { "aliases", "description", "source", "csv" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(tableType["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            if (tableType["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(tableType["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(tableType["title"], path + ".title");
            if (tableType["description"] != null)
            {
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(tableType["description"], path + ".description");
            }

            if (tableType["source"] != null)
            {
                var source = VisualBridgeStructuredCatalogValidator.RequireObject(tableType["source"], path + ".source");
                VisualBridgeStructuredCatalogValidator.RequireKeys(source, path + ".source", new[] { "providerId", "typeName" }, Array.Empty<string>());
                VisualBridgeStructuredCatalogValidator.RequireIdentifier(source["providerId"], path + ".source.providerId");
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(source["typeName"], path + ".source.typeName");
            }

            if (tableType["csv"] != null)
            {
                var csv = VisualBridgeStructuredCatalogValidator.RequireObject(tableType["csv"], path + ".csv");
                VisualBridgeStructuredCatalogValidator.RequireKeys(csv, path + ".csv", new[] { "delimiter" }, Array.Empty<string>());
                RequireSeparator(csv["delimiter"], path + ".csv.delimiter");
            }

            var sheets = VisualBridgeStructuredCatalogValidator.RequireArray(tableType["sheets"], path + ".sheets", true);
            var sheetIdentities = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < sheets.Count; index++)
            {
                ValidateSheet(
                    VisualBridgeStructuredCatalogValidator.RequireObject(sheets[index], $"{path}.sheets[{index}]"),
                    $"{path}.sheets[{index}]",
                    sheetIdentities);
            }
        }

        private static void ValidateSheet(JObject sheet, string path, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                sheet,
                path,
                new[] { "id", "title", "name", "rowDisplayNamePattern", "columns" },
                new[] { "aliases", "nameAliases", "keyColumnId", "partition" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(sheet["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            if (sheet["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(sheet["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(sheet["title"], path + ".title");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(sheet["name"], path + ".name");
            if (sheet["nameAliases"] != null)
            {
                RequireNonEmptyStringArray(sheet["nameAliases"], path + ".nameAliases");
            }

            ValidateRowDisplayNamePattern(sheet["rowDisplayNamePattern"], path + ".rowDisplayNamePattern");
            var columns = ValidateColumns(sheet["columns"], path + ".columns");
            if (sheet["keyColumnId"] != null)
            {
                var keyColumnId = VisualBridgeStructuredCatalogValidator.RequireIdentifier(sheet["keyColumnId"], path + ".keyColumnId");
                RequireKnownColumn(columns, keyColumnId, path + ".keyColumnId");
            }

            if (sheet["partition"] != null)
            {
                ValidatePartition(sheet["partition"], columns, path + ".partition");
            }
        }

        private static IReadOnlyList<JObject> ValidateColumns(JToken token, string path)
        {
            var columns = VisualBridgeStructuredCatalogValidator.RequireArray(token, path, true);
            var fieldClones = new JArray();
            for (var index = 0; index < columns.Count; index++)
            {
                var columnPath = $"{path}[{index}]";
                var column = VisualBridgeStructuredCatalogValidator.RequireObject(columns[index], columnPath);
                VisualBridgeStructuredCatalogValidator.RequireKeys(
                    column,
                    columnPath,
                    new[] { "id", "title", "valueType", "defaultValue", "nameKey", "cellEncoding" },
                    new[] { "aliases", "description", "dataTypeId", "editor", "reference", "fields", "item", "nameKeyAliases" });
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(column["nameKey"], columnPath + ".nameKey");
                if (column["nameKeyAliases"] != null)
                {
                    RequireNonEmptyStringArray(column["nameKeyAliases"], columnPath + ".nameKeyAliases");
                }

                // 剥掉 Table 专属键后复用共享 field 校验（含 value shape / editor / defaultValue 一致性）。
                var fieldClone = new JObject();
                foreach (var name in ColumnFieldKeys)
                {
                    if (column[name] != null)
                    {
                        fieldClone[name] = column[name].DeepClone();
                    }
                }

                fieldClones.Add(fieldClone);
            }

            VisualBridgeStructuredCatalogValidator.ValidateFields(fieldClones, path);

            // nameKey 身份（含 aliases）跨列唯一；cellEncoding 对照列 valueType 校验。
            var nameKeys = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < columns.Count; index++)
            {
                var columnPath = $"{path}[{index}]";
                var column = (JObject)columns[index];
                foreach (var nameKey in ColumnNameKeys(column))
                {
                    if (!nameKeys.Add(nameKey))
                    {
                        throw Error("catalog.identityConflict", columnPath, $"Column name key '{nameKey}' is already used.");
                    }
                }

                ValidateCellEncoding(column["cellEncoding"], column, columnPath + ".cellEncoding");
            }

            return columns.Cast<JObject>().ToList();
        }

        private static IEnumerable<string> ColumnNameKeys(JObject column)
        {
            yield return column.Value<string>("nameKey");
            if (column["nameKeyAliases"] is JArray aliases)
            {
                foreach (var alias in aliases.Values<string>())
                {
                    yield return alias;
                }
            }
        }

        // cellEncoding oneOf 语义对照 tableCatalog.ts readCellEncoding。
        private static void ValidateCellEncoding(JToken token, JObject definition, string path)
        {
            var encoding = VisualBridgeStructuredCatalogValidator.RequireObject(token, path);
            var kind = VisualBridgeStructuredCatalogValidator.RequireString(encoding["kind"], path + ".kind");
            var valueType = definition.Value<string>("valueType");
            switch (kind)
            {
                case "scalar":
                    VisualBridgeStructuredCatalogValidator.RequireKeys(encoding, path, new[] { "kind" }, Array.Empty<string>());
                    if (!PrimitiveValueTypes.Contains(valueType))
                    {
                        throw Error("catalog.incompatibleCellEncoding", path, "Scalar encoding requires a primitive valueType.");
                    }

                    return;
                case "json":
                    VisualBridgeStructuredCatalogValidator.RequireKeys(encoding, path, new[] { "kind" }, Array.Empty<string>());
                    return;
                case "delimited":
                    VisualBridgeStructuredCatalogValidator.RequireKeys(
                        encoding,
                        path,
                        new[] { "kind", "separator" },
                        new[] { "item" });
                    RequireSeparator(encoding["separator"], path + ".separator");
                    if (valueType != "array" && valueType != "object")
                    {
                        throw Error("catalog.incompatibleCellEncoding", path, "Delimited encoding requires an array or object valueType.");
                    }

                    if (encoding["item"] != null)
                    {
                        if (valueType != "array")
                        {
                            throw Error("catalog.unexpectedNestedCellEncoding", path + ".item", "Only array encodings can declare a nested item encoding.");
                        }

                        // 嵌套 item 对照数组元素定义（共享 field 校验已保证 array 定义携带 item）。
                        var itemDefinition = VisualBridgeStructuredCatalogValidator.RequireObject(definition["item"], path + ".item");
                        ValidateCellEncoding(encoding["item"], itemDefinition, path + ".item");
                    }

                    return;
                default:
                    throw Error("catalog.invalidCellEncodingKind", path + ".kind", "Expected scalar, json or delimited.");
            }
        }

        private static void ValidateRowDisplayNamePattern(JToken token, string path)
        {
            var pattern = VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(token, path);
            // 占位符必须形如 {columnId}；除占位符外不得出现裸 '{' 或 '}'，且至少一个占位符。
            var index = 0;
            var placeholderCount = 0;
            while (index < pattern.Length)
            {
                var character = pattern[index];
                if (character == '{')
                {
                    var close = pattern.IndexOf('}', index + 1);
                    if (close < 0 || !IsIdentifier(pattern.Substring(index + 1, close - index - 1)))
                    {
                        break;
                    }

                    placeholderCount++;
                    index = close + 1;
                    continue;
                }

                if (character == '}')
                {
                    break;
                }

                index++;
            }

            if (index < pattern.Length || placeholderCount == 0)
            {
                throw Error("catalog.invalidRowDisplayNamePattern", path, "Row display-name pattern must contain valid '{columnId}' placeholders.");
            }
        }

        private static void ValidatePartition(JToken token, IReadOnlyList<JObject> columns, string path)
        {
            var partition = VisualBridgeStructuredCatalogValidator.RequireObject(token, path);
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                partition,
                path,
                new[] { "namePattern", "deduplicateByColumnId", "duplicatePolicy" },
                Array.Empty<string>());
            var namePattern = VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(partition["namePattern"], path + ".namePattern");
            // 恰一个 {part} 占位符，且不允许其他花括号字符。
            var occurrences = namePattern.Split(new[] { "{part}" }, StringSplitOptions.None).Length - 1;
            var remainder = namePattern.Replace("{part}", string.Empty);
            if (occurrences != 1 || remainder.IndexOf('{') >= 0 || remainder.IndexOf('}') >= 0)
            {
                throw Error("catalog.invalidPartitionPattern", path + ".namePattern", "Partition name pattern must contain exactly one '{part}' placeholder.");
            }

            var deduplicateByColumnId = VisualBridgeStructuredCatalogValidator.RequireIdentifier(
                partition["deduplicateByColumnId"],
                path + ".deduplicateByColumnId");
            RequireKnownColumn(columns, deduplicateByColumnId, path + ".deduplicateByColumnId");
            var duplicatePolicy = VisualBridgeStructuredCatalogValidator.RequireString(partition["duplicatePolicy"], path + ".duplicatePolicy");
            if (!DuplicatePolicies.Contains(duplicatePolicy))
            {
                throw Error("catalog.invalidEnum", path + ".duplicatePolicy", "Expected one of: error, keepFirst, keepLast.");
            }
        }

        private static void RequireKnownColumn(IReadOnlyList<JObject> columns, string identity, string path)
        {
            if (!columns.Any(column => MatchesColumnIdentity(column, identity)))
            {
                throw Error("catalog.invalidReference", path, $"Unknown column '{identity}'.");
            }
        }

        private static bool MatchesColumnIdentity(JObject column, string identity)
        {
            if (string.Equals(column.Value<string>("id"), identity, StringComparison.Ordinal))
            {
                return true;
            }

            return column["aliases"] is JArray aliases && aliases.Values<string>().Contains(identity, StringComparer.Ordinal);
        }

        private static IReadOnlyList<string> RequireNonEmptyStringArray(JToken token, string path)
        {
            var array = VisualBridgeStructuredCatalogValidator.RequireArray(token, path, false);
            var values = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var value = VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(array[index], $"{path}[{index}]");
                if (!unique.Add(value))
                {
                    throw Error("catalog.duplicateString", $"{path}[{index}]", $"Duplicate value '{value}'.");
                }

                values.Add(value);
            }

            return values;
        }

        private static void RequireSeparator(JToken token, string path)
        {
            var value = VisualBridgeStructuredCatalogValidator.RequireString(token, path);
            if (value.Length == 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw Error("catalog.invalidSeparator", path, "Expected a non-empty separator without line breaks.");
            }
        }

        private static bool IsIdentifier(string value)
        {
            if (value.Length == 0 || value.Length > 128 || !IsAsciiAlphaNumeric(value[0]))
            {
                return false;
            }

            return value.All(character => IsAsciiAlphaNumeric(character) || character == '.' || character == '_' || character == '-');
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

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }
    }
}
