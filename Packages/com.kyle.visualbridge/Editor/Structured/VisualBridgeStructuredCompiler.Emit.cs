using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using VisualBridge.Runtime;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public static partial class VisualBridgeStructuredCompiler
    {
        private static IEnumerable<OutputPlan> BuildDocumentOutputs(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            Registry registry,
            RoutedDocument routed,
            byte[] documentBytes,
            string documentHash,
            IReadOnlyDictionary<string, InputSnapshot> inputs)
        {
            var root = VisualBridgeIntegrationProfileLoader.ReadStrictObject(routed.FullPath, "compile.documentInvalidJson");
            RequireDocumentKeys(root, routed.RelativePath);
            if (root["formatVersion"].Type != JTokenType.Integer || root["formatVersion"].Value<long>() != 1)
            {
                throw Error("compile.documentUnsupportedVersion", routed.RelativePath + ".formatVersion", "Expected integer formatVersion 1.");
            }

            var documentId = RequireIdentifier(root["documentId"], routed.RelativePath + ".documentId");
            if (!(root["properties"] is JObject properties))
            {
                throw Error("compile.documentInvalidProperties", routed.RelativePath + ".properties", "Expected an object.");
            }

            var mappings = new List<JObject>();
            var materialized = MaterializeObject(
                routed.Route.Config.Type,
                routed.Route.Config.Fields,
                properties,
                "properties",
                "data",
                mappings,
                false);
            GC.KeepAlive(materialized.Value);

            var catalogInputs = new JArray(routed.Route.Catalogs.Select(catalog => new JObject
            {
                ["catalogId"] = catalog.Root.Value<string>("catalogId"),
                ["path"] = catalog.RelativePath,
                ["sha256"] = catalog.Hash,
            }));
            var artifactRelativePath = "documents/" + project.ProjectId + "/" + routed.Route.DocumentType.Id + "/" + documentId + ".vbcompiled.json";
            var artifact = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ArtifactKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = routed.Route.DocumentType.Id,
                ["documentId"] = documentId,
                ["configTypeId"] = routed.Route.Config.Id,
                ["inputs"] = new JObject
                {
                    ["integrationProfileSha256"] = inputs[profile.ProfilePath].Hash,
                    ["projectSha256"] = inputs[profile.AuthoringProjectPath].Hash,
                    ["document"] = new JObject
                    {
                        ["path"] = routed.RelativePath,
                        ["sha256"] = documentHash,
                    },
                    ["catalogs"] = catalogInputs,
                },
                ["data"] = materialized.Json,
            };
            var artifactBytes = Serialize(artifact);
            var artifactHash = HashBytes(artifactBytes);

            var mappingRelativePath = "mappings/" + project.ProjectId + "/" + routed.Route.DocumentType.Id + "/" + documentId + ".vbsource.json";
            var mapping = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = MappingKind,
                ["projectId"] = project.ProjectId,
                ["documentTypeId"] = routed.Route.DocumentType.Id,
                ["documentId"] = documentId,
                ["configTypeId"] = routed.Route.Config.Id,
                ["inputs"] = new JObject
                {
                    ["integrationProfileSha256"] = inputs[profile.ProfilePath].Hash,
                    ["projectSha256"] = inputs[profile.AuthoringProjectPath].Hash,
                    ["catalogs"] = catalogInputs.DeepClone(),
                },
                ["source"] = new JObject
                {
                    ["path"] = routed.RelativePath,
                    ["sha256"] = documentHash,
                },
                ["artifact"] = new JObject
                {
                    ["path"] = artifactRelativePath,
                    ["sha256"] = artifactHash,
                },
                ["mappings"] = new JArray(mappings.OrderBy(value => value.Value<string>("artifactPath"), StringComparer.Ordinal)),
            };
            var mappingBytes = Serialize(mapping);
            return new[]
            {
                CreateOutput(profile.CompileOutputRoot, artifactRelativePath, artifactBytes, "artifact"),
                CreateOutput(profile.CompileOutputRoot, mappingRelativePath, mappingBytes, "sourceMapping"),
            };
        }

        private static MaterializedValue MaterializeObject(
            Type type,
            IReadOnlyList<FieldDescriptor> fields,
            JObject value,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
#pragma warning disable SYSLIB0050
            var instance = FormatterServices.GetUninitializedObject(type);
#pragma warning restore SYSLIB0050
            var json = new JObject();
            var canonical = new Dictionary<string, FieldDescriptor>(fields.ToDictionary(field => field.Id, StringComparer.Ordinal), StringComparer.Ordinal);
            var aliases = new Dictionary<string, FieldDescriptor>(StringComparer.Ordinal);
            foreach (var field in fields)
            {
                foreach (var alias in field.Aliases)
                {
                    aliases.Add(alias, field);
                }
            }

            foreach (var property in value.Properties())
            {
                if (canonical.ContainsKey(property.Name) || aliases.ContainsKey(property.Name))
                {
                    continue;
                }

                throw Error("compile.unknownField", sourcePath + "." + property.Name, $"Unknown field '{property.Name}'.");
            }

            foreach (var field in fields.OrderBy(field => field.Id, StringComparer.Ordinal))
            {
                var matches = new List<JProperty>();
                var canonicalProperty = value.Property(field.Id, StringComparison.Ordinal);
                if (canonicalProperty != null) matches.Add(canonicalProperty);
                matches.AddRange(field.Aliases
                    .Select(alias => value.Property(alias, StringComparison.Ordinal))
                    .Where(property => property != null));
                if (matches.Count > 1)
                {
                    throw Error(
                        "compile.fieldIdentityConflict",
                        sourcePath + "." + field.Id,
                        "Canonical field ID and aliases must not be present together.");
                }

                var property = matches.SingleOrDefault();
                var usesDefault = inheritedDefault || property == null;
                var token = property == null ? field.DefaultValue.DeepClone() : property.Value;
                var fieldSourcePath = sourcePath + "." + (property == null ? field.Id : property.Name);
                var fieldArtifactPath = artifactPath + "." + field.Id;
                var materialized = MaterializeValue(
                    field.Field.FieldType,
                    field,
                    token,
                    fieldSourcePath,
                    fieldArtifactPath,
                    mappings,
                    usesDefault);
                try
                {
                    field.Field.SetValue(instance, materialized.Value);
                }
                catch (Exception exception)
                {
                    throw Error("compile.fieldAssignmentFailed", fieldSourcePath, exception.Message);
                }

                json[field.Id] = materialized.Json;
                mappings.Add(new JObject
                {
                    ["sourcePath"] = fieldSourcePath,
                    ["artifactPath"] = fieldArtifactPath,
                    ["origin"] = usesDefault ? "metadataDefault" : "document",
                });
            }

            return new MaterializedValue(instance, json);
        }

        private static MaterializedValue MaterializeValue(
            Type type,
            FieldDescriptor descriptor,
            JToken token,
            string sourcePath,
            string artifactPath,
            ICollection<JObject> mappings,
            bool inheritedDefault)
        {
            if (type == typeof(string))
            {
                RequireTokenType(token, JTokenType.String, sourcePath, "string");
                return new MaterializedValue(token.Value<string>(), new JValue(token.Value<string>()));
            }

            if (type == typeof(bool))
            {
                RequireTokenType(token, JTokenType.Boolean, sourcePath, "boolean");
                return new MaterializedValue(token.Value<bool>(), new JValue(token.Value<bool>()));
            }

            if (IsSupportedNumber(type))
            {
                return MaterializeNumber(type, token, sourcePath);
            }

            if (type.IsEnum)
            {
                RequireTokenType(token, JTokenType.String, sourcePath, "enum name string");
                var name = token.Value<string>();
                if (!Enum.GetNames(type).Contains(name, StringComparer.Ordinal))
                {
                    throw Error("compile.enumValueInvalid", sourcePath, $"'{name}' is not a declared member of enum '{type.FullName}'.");
                }

                return new MaterializedValue(Enum.Parse(type, name, false), new JValue(name));
            }

            if (TryGetListItem(type, out var itemType))
            {
                if (!(token is JArray array))
                {
                    throw Error("compile.typeMismatch", sourcePath, "Expected an array.");
                }

                var itemValues = new object[array.Count];
                var jsonItems = new JArray();
                for (var index = 0; index < array.Count; index++)
                {
                    var item = MaterializeValue(
                        itemType,
                        descriptor.Item,
                        array[index],
                        sourcePath + "[" + index + "]",
                        artifactPath + "[" + index + "]",
                        mappings,
                        inheritedDefault);
                    itemValues[index] = item.Value;
                    jsonItems.Add(item.Json);
                }

                object listValue;
                if (type.IsArray)
                {
                    var result = Array.CreateInstance(itemType, itemValues.Length);
                    for (var index = 0; index < itemValues.Length; index++)
                    {
                        result.SetValue(itemValues[index], index);
                    }

                    listValue = result;
                }
                else
                {
                    var result = (IList)Activator.CreateInstance(type);
                    foreach (var itemValue in itemValues)
                    {
                        result.Add(itemValue);
                    }

                    listValue = result;
                }

                return new MaterializedValue(listValue, jsonItems);
            }

            if (!(token is JObject objectValue))
            {
                throw Error("compile.typeMismatch", sourcePath, "Expected an object.");
            }

            return MaterializeObject(type, descriptor.Fields, objectValue, sourcePath, artifactPath, mappings, inheritedDefault);
        }

        private static MaterializedValue MaterializeNumber(Type type, JToken token, string path)
        {
            if (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
            {
                throw Error("compile.typeMismatch", path, "Expected a JSON number.");
            }

            if (IsIntegral(type) && token.Type != JTokenType.Integer)
            {
                throw Error("compile.typeMismatch", path, $"Expected an integral JSON number for '{type.FullName}'.");
            }

            try
            {
                var value = token.Value<decimal>();
                object converted;
                if (type == typeof(byte)) converted = checked((byte)value);
                else if (type == typeof(sbyte)) converted = checked((sbyte)value);
                else if (type == typeof(short)) converted = checked((short)value);
                else if (type == typeof(ushort)) converted = checked((ushort)value);
                else if (type == typeof(int)) converted = checked((int)value);
                else if (type == typeof(uint)) converted = checked((uint)value);
                else if (type == typeof(float))
                {
                    var number = (float)value;
                    if (float.IsNaN(number) || float.IsInfinity(number)) throw new OverflowException();
                    converted = number;
                }
                else if (type == typeof(double))
                {
                    var number = (double)value;
                    if (double.IsNaN(number) || double.IsInfinity(number)) throw new OverflowException();
                    converted = number;
                }
                else throw new InvalidOperationException("Unsupported numeric type.");

                return new MaterializedValue(converted, token.DeepClone());
            }
            catch (Exception exception) when (exception is OverflowException || exception is FormatException || exception is InvalidCastException)
            {
                throw Error("compile.numberOutOfRange", path, $"Number is outside the range of '{type.FullName}'.");
            }
        }

        private static IReadOnlyList<FieldDescriptor> BuildFieldDescriptors(
            Type type,
            JArray definitions,
            HashSet<Type> stack,
            string path)
        {
            if (!stack.Add(type))
            {
                throw Error("compile.typeCycle", path, "Recursive config objects are unsupported.");
            }

            try
            {
                var fields = new List<FieldDescriptor>();
                foreach (var field in type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    var metadata = ReadFieldMetadata(field);
                    if (metadata == null)
                    {
                        continue;
                    }

                    if (field.IsInitOnly || field.IsLiteral)
                    {
                        throw Error("compile.fieldReadOnly", path + "." + field.Name, "Annotated config fields must be writable.");
                    }

                    var matches = definitions.Cast<JObject>()
                        .Where(definition => string.Equals(definition.Value<string>("id"), metadata.Id, StringComparison.Ordinal))
                        .ToArray();
                    if (matches.Length != 1)
                    {
                        throw Error("compile.catalogMetadataMismatch", path + "." + field.Name, "Catalog field does not match C# metadata.");
                    }

                    var descriptor = new FieldDescriptor(field, metadata.Id, metadata.Aliases, matches[0]["defaultValue"].DeepClone());
                    BuildValueDescriptor(descriptor, field.FieldType, matches[0], stack, path + "." + field.Name);
                    fields.Add(descriptor);
                }

                var catalogIds = new HashSet<string>(definitions.Cast<JObject>().Select(value => value.Value<string>("id")), StringComparer.Ordinal);
                var fieldIds = new HashSet<string>(fields.Select(value => value.Id), StringComparer.Ordinal);
                if (!catalogIds.SetEquals(fieldIds))
                {
                    throw Error("compile.catalogMetadataMismatch", path, "Catalog fields differ from registered C# metadata.");
                }

                return fields.OrderBy(value => value.Id, StringComparer.Ordinal).ToArray();
            }
            finally
            {
                stack.Remove(type);
            }
        }

        private static void BuildValueDescriptor(FieldDescriptor descriptor, Type type, JObject definition, HashSet<Type> stack, string path)
        {
            var expectedValueType = definition.Value<string>("valueType");
            if (type == typeof(string)) RequireValueType(expectedValueType, "string", path);
            else if (type == typeof(bool)) RequireValueType(expectedValueType, "boolean", path);
            else if (IsSupportedNumber(type)) RequireValueType(expectedValueType, "number", path);
            else if (type.IsEnum) RequireValueType(expectedValueType, "string", path);
            else if (TryGetListItem(type, out var itemType))
            {
                RequireValueType(expectedValueType, "array", path);
                if (!(definition["item"] is JObject itemDefinition))
                {
                    throw Error("compile.catalogMetadataMismatch", path, "Array Catalog definition is missing item metadata.");
                }

                descriptor.Item = FieldDescriptor.ForValue(itemDefinition["defaultValue"].DeepClone());
                BuildValueDescriptor(descriptor.Item, itemType, itemDefinition, stack, path + "[]");
            }
            else
            {
                RequireValueType(expectedValueType, "object", path);
                if (!(definition["fields"] is JArray fields))
                {
                    throw Error("compile.catalogMetadataMismatch", path, "Object Catalog definition is missing fields.");
                }

                descriptor.Fields = BuildFieldDescriptors(type, fields, stack, path);
            }
        }

        private static ConfigDescriptor ReadConfigDescriptor(Type type, string registeredName, string expectedCatalogId)
        {
            var attributes = type.CustomAttributes
                .Where(attribute => attribute.AttributeType == typeof(VisualBridgeStructuredConfigAttribute))
                .ToArray();
            if (attributes.Length != 1)
            {
                throw Error("compile.configMetadataMissing", registeredName, "Config type must declare exactly one VisualBridgeStructuredConfig attribute.");
            }

            var attribute = attributes[0];
            var catalogId = ReadConstructorString(attribute, 0, registeredName);
            var id = ReadConstructorString(attribute, 1, registeredName);
            var aliases = Array.Empty<string>();
            foreach (var argument in attribute.NamedArguments)
            {
                if (argument.MemberName == nameof(VisualBridgeStructuredConfigAttribute.Aliases))
                {
                    aliases = ReadStringArray(argument.TypedValue, registeredName);
                }
            }

            if (!string.Equals(catalogId, expectedCatalogId, StringComparison.Ordinal))
            {
                throw Error("compile.catalogMetadataMismatch", registeredName, "Config metadata belongs to a different Catalog.");
            }

            RequireIdentifier(new JValue(id), registeredName + ".id");
            foreach (var alias in aliases)
            {
                RequireIdentifier(new JValue(alias), registeredName + ".aliases");
            }

            return new ConfigDescriptor(type, registeredName, catalogId, id, aliases);
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
                throw Error("compile.fieldMetadataDuplicate", field.Name, "Field declares duplicate VisualBridge metadata.");
            }

            var attribute = attributes[0];
            var aliases = Array.Empty<string>();
            foreach (var argument in attribute.NamedArguments)
            {
                if (argument.MemberName == nameof(VisualBridgeFieldAttribute.Aliases))
                {
                    aliases = ReadStringArray(argument.TypedValue, field.Name);
                }
            }

            return new FieldMetadata(
                ReadConstructorString(attribute, 0, field.Name),
                aliases);
        }

        private static string ReadConstructorString(CustomAttributeData attribute, int index, string path)
        {
            if (attribute.ConstructorArguments.Count <= index || !(attribute.ConstructorArguments[index].Value is string value))
            {
                throw Error("compile.invalidMetadata", path, "Expected a string constructor argument.");
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
                throw Error("compile.invalidMetadata", path, "Expected a string array.");
            }

            var result = new string[values.Count];
            for (var index = 0; index < values.Count; index++)
            {
                var item = (CustomAttributeTypedArgument)values[index];
                if (!(item.Value is string value))
                {
                    throw Error("compile.invalidMetadata", path, "Expected a string array.");
                }

                result[index] = value;
            }

            return result;
        }

        private static OutputPlan BuildManifest(
            VisualBridgeResolvedProfile profile,
            VisualBridgeAuthoringProject project,
            IReadOnlyList<OutputPlan> outputs,
            IReadOnlyDictionary<string, InputSnapshot> inputs)
        {
            var manifest = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = ManifestKind,
                ["projectId"] = project.ProjectId,
                ["inputs"] = new JArray(inputs.Values
                    .Select(input => new JObject
                    {
                        ["path"] = InputDisplayPath(profile, project, input.Path),
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
            return CreateOutput(profile.CompileOutputRoot, "manifest.json", Serialize(manifest), "manifest");
        }

    }
}
