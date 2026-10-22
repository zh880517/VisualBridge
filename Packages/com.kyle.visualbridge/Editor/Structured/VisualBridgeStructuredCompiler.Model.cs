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
        private sealed class Registry
        {
            public Registry(IReadOnlyDictionary<string, RouteDescriptor> routes, IReadOnlyList<CatalogDescriptor> catalogs)
            {
                Routes = routes;
                Catalogs = catalogs;
            }

            public IReadOnlyDictionary<string, RouteDescriptor> Routes { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }
        }

        private sealed class RouteDescriptor
        {
            public RouteDescriptor(
                VisualBridgeAuthoringDocumentType documentType,
                ConfigDescriptor config,
                IReadOnlyList<CatalogDescriptor> catalogs)
            {
                DocumentType = documentType;
                Config = config;
                Catalogs = catalogs;
            }

            public VisualBridgeAuthoringDocumentType DocumentType { get; }

            public ConfigDescriptor Config { get; }

            public IReadOnlyList<CatalogDescriptor> Catalogs { get; }
        }

        private sealed class CatalogDescriptor
        {
            public CatalogDescriptor(string relativePath, string fullPath, string hash, JObject root)
            {
                RelativePath = relativePath;
                FullPath = fullPath;
                Hash = hash;
                Root = root;
            }

            public string RelativePath { get; }
            public string FullPath { get; }
            public string Hash { get; }
            public JObject Root { get; }
        }

        private sealed class ConfigDescriptor
        {
            public ConfigDescriptor(Type type, string registeredName, string catalogId, string id, IReadOnlyList<string> aliases)
            {
                Type = type;
                RegisteredName = registeredName;
                CatalogId = catalogId;
                Id = id;
                Aliases = aliases;
            }

            public Type Type { get; }
            public string RegisteredName { get; }
            public string CatalogId { get; }
            public string Id { get; }
            public IReadOnlyList<string> Aliases { get; }
            public IReadOnlyList<FieldDescriptor> Fields { get; set; }
        }

        private sealed class FieldDescriptor
        {
            public FieldDescriptor(FieldInfo field, string id, IReadOnlyList<string> aliases, JToken defaultValue)
            {
                Field = field;
                Id = id;
                Aliases = aliases;
                DefaultValue = defaultValue;
                Fields = Array.Empty<FieldDescriptor>();
            }

            private FieldDescriptor(JToken defaultValue)
            {
                Aliases = Array.Empty<string>();
                DefaultValue = defaultValue;
                Fields = Array.Empty<FieldDescriptor>();
            }

            public FieldInfo Field { get; }
            public string Id { get; }
            public IReadOnlyList<string> Aliases { get; }
            public JToken DefaultValue { get; }
            public IReadOnlyList<FieldDescriptor> Fields { get; set; }
            public FieldDescriptor Item { get; set; }

            public static FieldDescriptor ForValue(JToken defaultValue)
            {
                return new FieldDescriptor(defaultValue);
            }
        }

        private sealed class FieldMetadata
        {
            public FieldMetadata(string id, IReadOnlyList<string> aliases)
            {
                Id = id;
                Aliases = aliases;
            }

            public string Id { get; }
            public IReadOnlyList<string> Aliases { get; }
        }

        private sealed class RoutedDocument
        {
            public RoutedDocument(string fullPath, string relativePath, RouteDescriptor route)
            {
                FullPath = fullPath;
                RelativePath = relativePath;
                Route = route;
            }

            public string FullPath { get; }
            public string RelativePath { get; }
            public RouteDescriptor Route { get; }
        }

        private sealed class MaterializedValue
        {
            public MaterializedValue(object value, JToken json)
            {
                Value = value;
                Json = json;
            }

            public object Value { get; }
            public JToken Json { get; }
        }

        internal sealed class InputSnapshot
        {
            public InputSnapshot(string path, byte[] bytes, string hash)
            {
                Path = path;
                Bytes = bytes;
                Hash = hash;
            }

            public string Path { get; }
            public byte[] Bytes { get; }
            public string Hash { get; }
        }

        internal sealed class OutputPlan
        {
            public OutputPlan(string relativePath, string fullPath, byte[] bytes, string hash, string kind)
            {
                RelativePath = relativePath;
                FullPath = fullPath;
                Bytes = bytes;
                Hash = hash;
                Kind = kind;
            }

            public string RelativePath { get; }
            public string FullPath { get; }
            public byte[] Bytes { get; }
            public string Hash { get; }
            public string Kind { get; }
        }

        private sealed class OutputFileState
        {
            public OutputFileState(bool exists, string identity, string hash)
            {
                Exists = exists;
                Identity = identity;
                Hash = hash;
            }

            public bool Exists { get; }
            public string Identity { get; }
            public string Hash { get; }
        }

        private sealed class TransactionFile
        {
            public TransactionFile(string path, byte[] bytes, string baselineHash, bool changed)
            {
                Path = path;
                Bytes = bytes;
                BaselineHash = baselineHash;
                Changed = changed;
            }

            public string Path { get; }
            public byte[] Bytes { get; }
            public string BaselineHash { get; }
            public bool Changed { get; }
            public bool BaselineExists { get; set; }
            public string BaselineIdentity { get; set; }
            public string TemporaryPath { get; set; }
            public string BackupPath { get; set; }
            public bool Applied { get; set; }
            public bool Created { get; set; }
            public int TransactionIndex { get; set; }
        }
    }
}
