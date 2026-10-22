using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeGraphCompiler
    {
        // ---- 属性物化（镜像 Entity Compiler 的 JSON 级实现：别名 canonical 化 + defaultValue 物化）----

        private static JObject MaterializeObject(
            JArray definitions,
            JObject value,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
            var json = new JObject();
            var canonical = new Dictionary<string, JObject>(StringComparer.Ordinal);
            var aliases = new Dictionary<string, JObject>(StringComparer.Ordinal);
            foreach (var definition in definitions.Cast<JObject>())
            {
                canonical.Add(definition.Value<string>("id"), definition);
                if (definition["aliases"] is JArray definitionAliases)
                {
                    foreach (var alias in definitionAliases.Values<string>())
                    {
                        aliases.Add(alias, definition);
                    }
                }
            }

            foreach (var property in value.Properties())
            {
                if (canonical.ContainsKey(property.Name) || aliases.ContainsKey(property.Name))
                {
                    continue;
                }

                throw Error("compile.unknownField", sourcePath + "." + property.Name, "Unknown field '" + property.Name + "'.");
            }

            foreach (var definition in definitions.Cast<JObject>().OrderBy(item => item.Value<string>("id"), StringComparer.Ordinal))
            {
                var fieldId = definition.Value<string>("id");
                var matches = new List<JProperty>();
                var canonicalProperty = value.Property(fieldId, StringComparison.Ordinal);
                if (canonicalProperty != null)
                {
                    matches.Add(canonicalProperty);
                }

                if (definition["aliases"] is JArray fieldAliases)
                {
                    matches.AddRange(fieldAliases.Values<string>()
                        .Select(alias => value.Property(alias, StringComparison.Ordinal))
                        .Where(property => property != null));
                }

                if (matches.Count > 1)
                {
                    throw Error(
                        "compile.fieldIdentityConflict",
                        sourcePath + "." + fieldId,
                        "Canonical field ID and aliases must not be present together.");
                }

                var property = matches.SingleOrDefault();
                var usesDefault = inheritedDefault || property == null;
                // 缺失字段用 Catalog defaultValue 物化，origin 记为 metadataDefault（sourcePath 省略）。
                var token = property == null ? definition["defaultValue"].DeepClone() : property.Value;
                var fieldSourcePath = sourcePath + "." + (property == null ? fieldId : property.Name);
                var fieldArtifactPath = artifactPath + "." + fieldId;
                json[fieldId] = MaterializeValue(definition, token, fieldSourcePath, fieldArtifactPath, mappings, usesDefault);
                var mapping = new JObject();
                if (!usesDefault)
                {
                    mapping["sourcePath"] = fieldSourcePath;
                }

                mapping["artifactPath"] = fieldArtifactPath;
                mapping["origin"] = usesDefault ? "metadataDefault" : "document";
                mappings.Add(mapping);
            }

            return json;
        }

        private static JToken MaterializeValue(
            JObject definition,
            JToken token,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
            switch (definition.Value<string>("valueType"))
            {
                case "string":
                    VisualBridgeStructuredCompiler.RequireTokenType(token, JTokenType.String, sourcePath, "a string");
                    RequireEnumOption(definition, token, sourcePath);
                    return token.DeepClone();
                case "boolean":
                    VisualBridgeStructuredCompiler.RequireTokenType(token, JTokenType.Boolean, sourcePath, "a boolean");
                    RequireEnumOption(definition, token, sourcePath);
                    return token.DeepClone();
                case "number":
                    return MaterializeNumber(definition, token, sourcePath);
                case "array":
                    if (!(token is JArray array))
                    {
                        throw Error("compile.typeMismatch", sourcePath, "Expected an array.");
                    }

                    var items = new JArray();
                    var itemDefinition = (JObject)definition["item"];
                    for (var index = 0; index < array.Count; index++)
                    {
                        items.Add(MaterializeValue(
                            itemDefinition,
                            array[index],
                            sourcePath + "[" + index + "]",
                            artifactPath + "[" + index + "]",
                            mappings,
                            inheritedDefault));
                    }

                    return items;
                case "object":
                    if (!(token is JObject objectValue))
                    {
                        throw Error("compile.typeMismatch", sourcePath, "Expected an object.");
                    }

                    return MaterializeObject((JArray)definition["fields"], objectValue, sourcePath, artifactPath, mappings, inheritedDefault);
                default:
                    throw Error("compile.typeMismatch", sourcePath, "Unsupported Catalog valueType.");
            }
        }

        private static JToken MaterializeNumber(JObject definition, JToken token, string sourcePath)
        {
            if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
            {
                throw Error("compile.typeMismatch", sourcePath, "Expected a JSON number.");
            }

            var number = token.Value<double>();
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                throw Error("compile.numberOutOfRange", sourcePath, "Number must be finite.");
            }

            if (IsIntegralDefinition(definition) && token.Type != JTokenType.Integer)
            {
                throw Error("compile.typeMismatch", sourcePath, "Expected an integral JSON number.");
            }

            if (definition["editor"] is JObject editor)
            {
                if (editor["min"] != null && editor["min"].Type != JTokenType.Null && number < editor["min"].Value<double>())
                {
                    throw Error("compile.numberOutOfRange", sourcePath, "Number is below the declared editor minimum.");
                }

                if (editor["max"] != null && editor["max"].Type != JTokenType.Null && number > editor["max"].Value<double>())
                {
                    throw Error("compile.numberOutOfRange", sourcePath, "Number is above the declared editor maximum.");
                }
            }

            RequireEnumOption(definition, token, sourcePath);
            return token.DeepClone();
        }

        private static void RequireEnumOption(JObject definition, JToken token, string sourcePath)
        {
            if (!(definition["editor"] is JObject editor) || !(editor["options"] is JArray options))
            {
                return;
            }

            // select 编辑器（枚举）的值必须命中 options 之一。
            for (var index = 0; index < options.Count; index++)
            {
                if (JToken.DeepEquals(((JObject)options[index])["value"], token))
                {
                    return;
                }
            }

            throw Error("compile.enumValueInvalid", sourcePath, "Value is not one of the declared editor options.");
        }

        private static bool IsIntegralDefinition(JObject definition)
        {
            if (definition["editor"] is JObject editor
                && editor["integer"] != null
                && editor["integer"].Type == JTokenType.Boolean
                && editor["integer"].Value<bool>())
            {
                return true;
            }

            switch (definition.Value<string>("dataTypeId"))
            {
                case "byte":
                case "sbyte":
                case "short":
                case "ushort":
                case "int":
                case "uint":
                    return true;
                default:
                    return false;
            }
        }

        private static void ValidateFieldValue(JToken value, JObject definition, string sourcePath)
        {
            // 动态端口 value 只做值校验（无物化），复用 MaterializeValue 的校验路径。
            MaterializeValue(definition, value, sourcePath, sourcePath, new List<JObject>(), false);
        }

        // ---- Manifest / stale / 解析辅助 ----

        private static VisualBridgeStructuredCompiler.OutputPlan BuildManifest(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IReadOnlyList<VisualBridgeStructuredCompiler.OutputPlan> outputs,
            IReadOnlyDictionary<string, VisualBridgeStructuredCompiler.InputSnapshot> inputs)
        {
            var manifest = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ManifestKind,
                ["projectId"] = project.ProjectId,
                ["inputs"] = new JArray(inputs.Values
                    .Select(input => new JObject
                    {
                        ["path"] = VisualBridgeStructuredCompiler.InputDisplayPath(profile, project, input.Path),
                        ["sha256"] = input.Hash,
                    })
                    .OrderBy(value => value.Value<string>("path"), StringComparer.Ordinal)),
                ["outputs"] = new JArray(outputs.OrderBy(output => output.RelativePath, StringComparer.Ordinal).Select(output => new JObject
                {
                    ["kind"] = output.Kind,
                    ["path"] = output.RelativePath,
                    ["sha256"] = output.Hash,
                })),
            };
            return VisualBridgeStructuredCompiler.CreateOutput(
                profile.CompileOutputRoot,
                ManifestFileName,
                VisualBridgeStructuredCompiler.Serialize(manifest),
                "manifest");
        }

        private static IReadOnlyList<string> ReadPreviousManagedPaths(string outputRoot)
        {
            var manifestPath = Path.Combine(outputRoot, ManifestFileName);
            if (!File.Exists(manifestPath))
            {
                return Array.Empty<string>();
            }

            VisualBridgeStructuredCompiler.RejectOutputAlias(manifestPath);
            var manifest = VisualBridgeIntegrationProfileLoader.ReadStrictObject(manifestPath, "compile.manifestInvalidJson");
            VisualBridgeStructuredCompiler.RequireKeys(manifest, "manifest", new[] { "formatVersion", "kind", "projectId", "inputs", "outputs" });
            if (manifest["formatVersion"].Type != JTokenType.Integer || manifest["formatVersion"].Value<long>() != 1)
            {
                throw Error("compile.manifestInvalid", "manifest.formatVersion", "Expected formatVersion 1.");
            }

            if (manifest["kind"].Type != JTokenType.String || manifest.Value<string>("kind") != ManifestKind)
            {
                throw Error("compile.manifestInvalid", "manifest.kind", "Unexpected manifest kind.");
            }

            if (!(manifest["inputs"] is JArray) || !(manifest["outputs"] is JArray outputs))
            {
                throw Error("compile.manifestInvalid", "manifest", "Expected input and output arrays.");
            }

            var result = new List<string>(outputs.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < outputs.Count; index++)
            {
                if (!(outputs[index] is JObject output))
                {
                    throw Error("compile.manifestInvalid", "manifest.outputs[" + index + "]", "Expected an object.");
                }

                VisualBridgeStructuredCompiler.RequireKeys(output, "manifest.outputs[" + index + "]", new[] { "kind", "path", "sha256" });
                var path = output["path"].Type == JTokenType.String ? output.Value<string>("path") : null;
                VisualBridgeStructuredCompiler.ValidateOutputRelativePath(path, "manifest.outputs[" + index + "].path");
                VisualBridgeStructuredCompiler.RequireHash(output["sha256"], "manifest.outputs[" + index + "].sha256");
                if (!unique.Add(path))
                {
                    throw Error("compile.manifestInvalid", "manifest.outputs[" + index + "].path", "Duplicate managed output path.");
                }

                result.Add(path);
            }

            return result;
        }

        private static void RequireKeys(JObject value, string path, IEnumerable<string> required, IEnumerable<string> optional)
        {
            var requiredSet = new HashSet<string>(required, StringComparer.Ordinal);
            var allowed = new HashSet<string>(requiredSet, StringComparer.Ordinal);
            allowed.UnionWith(optional);
            foreach (var property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw Error("compile.unknownProperty", path + "." + property.Name, "Unknown property '" + property.Name + "'.");
                }
            }

            foreach (var name in requiredSet)
            {
                if (value.Property(name, StringComparison.Ordinal) == null)
                {
                    throw Error("compile.missingProperty", path + "." + name, "Missing property '" + name + "'.");
                }
            }
        }

        private static JArray RequireArray(JToken token, string path)
        {
            if (!(token is JArray value))
            {
                throw Error("compile.typeMismatch", path, "Expected an array.");
            }

            return value;
        }

        private static string RequireString(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("compile.typeMismatch", path, "Expected a string.");
            }

            return token.Value<string>();
        }

        private static string RequireEnum(JToken token, string path, IReadOnlyList<string> values)
        {
            var value = RequireString(token, path);
            if (!values.Contains(value, StringComparer.Ordinal))
            {
                throw Error("compile.typeMismatch", path, "Expected one of [" + string.Join(", ", values) + "].");
            }

            return value;
        }

        private static bool RequireBoolean(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.Boolean)
            {
                throw Error("compile.typeMismatch", path, "Expected a boolean.");
            }

            return token.Value<bool>();
        }

        private static JToken RequireNumber(JToken token, string path)
        {
            if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float))
            {
                throw Error("compile.typeMismatch", path, "Expected a number.");
            }

            var number = token.Value<double>();
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                throw Error("compile.typeMismatch", path, "Expected a finite number.");
            }

            return token;
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }

    }
}
