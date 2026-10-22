using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    public static partial class VisualBridgeRuntimeBridgeValidator
    {
        internal static VisualBridgeRuntimeDocumentSnapshot ValidateDocumentSnapshot(JObject value, string path)
        {
            RequireOnlyKeys(value, path, "documentTypeId", "documentId", "kind", "data");
            var documentTypeId = RequireString(value, "documentTypeId", path + ".documentTypeId");
            if (!StableIdPattern.IsMatch(documentTypeId))
            {
                throw Error("runtime.invalidMessage", path + ".documentTypeId", "Expected a stable document type identifier.");
            }

            var documentId = RequireString(value, "documentId", path + ".documentId");
            if (!StableIdPattern.IsMatch(documentId))
            {
                throw Error("runtime.invalidMessage", path + ".documentId", "Expected a document identifier.");
            }

            var kind = RequireString(value, "kind", path + ".kind");
            if (!CompiledKindPattern.IsMatch(kind))
            {
                throw Error("runtime.invalidMessage", path + ".kind", "Expected a compiled artifact kind.");
            }

            if (!(value["data"] is JObject data))
            {
                throw Error("runtime.invalidMessage", path + ".data", "Expected an object payload.");
            }

            return new VisualBridgeRuntimeDocumentSnapshot
            {
                DocumentTypeId = documentTypeId,
                DocumentId = documentId,
                Kind = kind,
                Data = data,
            };
        }

        internal static VisualBridgeRuntimeDocumentSource ValidateDocumentSource(JObject value, string path)
        {
            RequireOnlyKeys(value, path, "documentTypeId", "documentId", "sourcePath", "sourceSha256");
            var documentTypeId = RequireString(value, "documentTypeId", path + ".documentTypeId");
            if (!StableIdPattern.IsMatch(documentTypeId))
            {
                throw Error("runtime.invalidMessage", path + ".documentTypeId", "Expected a stable document type identifier.");
            }

            var documentId = RequireString(value, "documentId", path + ".documentId");
            if (!StableIdPattern.IsMatch(documentId))
            {
                throw Error("runtime.invalidMessage", path + ".documentId", "Expected a document identifier.");
            }

            var sourcePath = RequireString(value, "sourcePath", path + ".sourcePath");
            if (sourcePath.Length > 1024 || !NormalizedPathPattern.IsMatch(sourcePath))
            {
                throw Error("runtime.invalidMessage", path + ".sourcePath", "Expected a normalized relative source path.");
            }

            var sourceSha256 = RequireString(value, "sourceSha256", path + ".sourceSha256");
            if (!Sha256Pattern.IsMatch(sourceSha256))
            {
                throw Error("runtime.invalidMessage", path + ".sourceSha256", "Expected a lowercase 64-hex SHA-256 digest.");
            }

            return new VisualBridgeRuntimeDocumentSource
            {
                DocumentTypeId = documentTypeId,
                DocumentId = documentId,
                SourcePath = sourcePath,
                SourceSha256 = sourceSha256,
            };
        }
        private static IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> ValidateDocuments(JToken token, string path)
        {
            if (!(token is JArray documentsArray))
            {
                throw Error("runtime.invalidMessage", path, "Expected a documents array.");
            }

            var documents = new List<VisualBridgeRuntimeDocumentSnapshot>(documentsArray.Count);
            for (var index = 0; index < documentsArray.Count; index++)
            {
                if (!(documentsArray[index] is JObject document))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected a document snapshot object.");
                }

                documents.Add(ValidateDocumentSnapshot(document, $"{path}[{index}]"));
            }

            return documents;
        }

        private static IReadOnlyList<VisualBridgeRuntimeDocumentSource> ValidateSources(JToken token, string path)
        {
            if (!(token is JArray sourcesArray))
            {
                throw Error("runtime.invalidMessage", path, "Expected a sources array.");
            }

            var sources = new List<VisualBridgeRuntimeDocumentSource>(sourcesArray.Count);
            for (var index = 0; index < sourcesArray.Count; index++)
            {
                if (!(sourcesArray[index] is JObject source))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected a document source object.");
                }

                sources.Add(ValidateDocumentSource(source, $"{path}[{index}]"));
            }

            return sources;
        }

    }
}
