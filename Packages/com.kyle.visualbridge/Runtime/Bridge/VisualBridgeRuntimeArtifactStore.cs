using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// 确定性枚举并加载编译产物目录（Editor Play 模式为
    /// &lt;project&gt;/Library/VisualBridge/Compiled，Player 为
    /// &lt;StreamingAssets&gt;/VisualBridge/Compiled——路径解析由调用方完成）。
    /// 快照按 manifest 的 artifact 输出收集并附带每文档的 Authoring 源映射
    /// （DocumentSources），digest 覆盖 manifest 与 documents 树的全部产物文件，
    /// 用于 1 秒轮询的变更检测。
    /// </summary>
    public static class VisualBridgeRuntimeArtifactStore
    {
        public const int CompiledFormatVersion = 1;

        /// <summary>四域 manifest 固定文件名；缺失的域直接跳过。</summary>
        public static readonly string[] ManifestFileNames =
        {
            "manifest.json",
            "manifest.entity.json",
            "manifest.table.json",
            "manifest.graph.json",
        };

        private const string DocumentsDirectoryName = "documents";
        private const string MappingsDirectoryName = "mappings";
        private const string ArtifactFileExtension = ".vbcompiled.json";
        private const string SourceMappingFileExtension = ".vbsource.json";

        /// <summary>manifest 输出条目（kind 固定为 artifact 或 sourceMapping）。</summary>
        private sealed class ManifestOutput
        {
            public string Kind;

            public string Path;
        }

        /// <summary>
        /// 加载全部编译产物。table 产物用 tableTypeId 充当 DocumentTypeId 与
        /// DocumentId（表格编译产物没有独立 documentId 字段），其余域用
        /// documentTypeId/documentId；输出按 documentTypeId → documentId 排序。
        /// </summary>
        public static IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> Snapshot(string artifactsRoot)
        {
            var snapshots = new List<VisualBridgeRuntimeDocumentSnapshot>();
            if (string.IsNullOrEmpty(artifactsRoot) || !Directory.Exists(artifactsRoot))
            {
                return snapshots;
            }

            var sourceMappings = ReadSourceMappingIndex(artifactsRoot);
            var visited = new HashSet<string>(StringComparer.Ordinal);
            foreach (var relativePath in EnumerateManifestArtifactPaths(artifactsRoot))
            {
                if (!visited.Add(relativePath))
                {
                    continue;
                }

                snapshots.Add(LoadArtifact(artifactsRoot, relativePath, sourceMappings));
            }

            snapshots.Sort((left, right) =>
            {
                var byType = string.CompareOrdinal(left.DocumentTypeId, right.DocumentTypeId);
                return byType != 0 ? byType : string.CompareOrdinal(left.DocumentId, right.DocumentId);
            });
            return snapshots;
        }

        /// <summary>
        /// 全部运行中文档的 Authoring 源映射（getDocumentSources 的数据源）：
        /// 非 table 域每文档一条（产物 inputs.document），table 域每个源文件一条
        /// （.vbsource.json 的 sources 数组，身份仍为 tableTypeId）。
        /// </summary>
        public static IReadOnlyList<VisualBridgeRuntimeDocumentSource> DocumentSources(string artifactsRoot)
        {
            var sources = new List<VisualBridgeRuntimeDocumentSource>();
            foreach (var snapshot in Snapshot(artifactsRoot))
            {
                sources.AddRange(snapshot.Sources ?? Array.Empty<VisualBridgeRuntimeDocumentSource>());
            }

            return sources;
        }

        /// <summary>
        /// 全部产物（manifest + documents 树下的 *.vbcompiled.json）的确定性
        /// SHA-256：按相对路径排序后对「路径 + 内容哈希」序列做摘要。轮询
        /// 线程比较该值检测产物目录变化（含未登记进 manifest 的新文件）。
        /// </summary>
        public static string ComputeDigest(string artifactsRoot)
        {
            if (string.IsNullOrEmpty(artifactsRoot) || !Directory.Exists(artifactsRoot))
            {
                return string.Empty;
            }

            var entries = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (var manifestName in ManifestFileNames)
            {
                var manifestPath = Path.Combine(artifactsRoot, manifestName);
                if (File.Exists(manifestPath))
                {
                    entries[manifestName] = HashFile(manifestPath);
                }
            }

            var documentsRoot = Path.Combine(artifactsRoot, DocumentsDirectoryName);
            if (Directory.Exists(documentsRoot))
            {
                foreach (var file in Directory.EnumerateFiles(documentsRoot, "*" + ArtifactFileExtension, SearchOption.AllDirectories))
                {
                    entries[ToRelativePath(artifactsRoot, file)] = HashFile(file);
                }
            }

            using (var sha = SHA256.Create())
            {
                foreach (var pair in entries)
                {
                    sha.TransformBlock(Encoding.UTF8.GetBytes(pair.Key), 0, pair.Key.Length, null, 0);
                    var separator = Encoding.UTF8.GetBytes("\n");
                    sha.TransformBlock(separator, 0, separator.Length, null, 0);
                    var hash = Encoding.UTF8.GetBytes(pair.Value);
                    sha.TransformBlock(hash, 0, hash.Length, null, 0);
                    sha.TransformBlock(separator, 0, separator.Length, null, 0);
                }

                sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                return ToHex(sha.Hash);
            }
        }

        /// <summary>按 documentTypeId 过滤快照（null/空过滤器返回全部）。</summary>
        public static IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> FilterSnapshot(
            IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> snapshots, IReadOnlyList<string> documentTypeIds)
        {
            if (documentTypeIds == null || documentTypeIds.Count == 0)
            {
                return snapshots;
            }

            var wanted = new HashSet<string>(documentTypeIds, StringComparer.Ordinal);
            return snapshots.Where(snapshot => wanted.Contains(snapshot.DocumentTypeId)).ToList();
        }

        /// <summary>收集各 manifest 中 kind 为 artifact 的 documents/ 相对路径（排序确定）。</summary>
        private static IEnumerable<string> EnumerateManifestArtifactPaths(string artifactsRoot)
        {
            var paths = new List<string>();
            foreach (var manifestName in ManifestFileNames)
            {
                var manifestPath = Path.Combine(artifactsRoot, manifestName);
                if (!File.Exists(manifestPath))
                {
                    continue;
                }

                foreach (var output in ReadManifestOutputs(manifestPath, manifestName))
                {
                    if (output.Kind == "artifact")
                    {
                        paths.Add(output.Path);
                    }
                }
            }

            paths.Sort(StringComparer.Ordinal);
            return paths;
        }

        /// <summary>
        /// sourceMapping 产物索引：artifact 相对路径 → mappings/ 产物相对路径。
        /// table 产物的 Authoring 源清单（inputs 无单一 document）登记在
        /// .vbsource.json 的 sources 数组里。
        /// </summary>
        private static Dictionary<string, string> ReadSourceMappingIndex(string artifactsRoot)
        {
            var index = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var manifestName in ManifestFileNames)
            {
                var manifestPath = Path.Combine(artifactsRoot, manifestName);
                if (!File.Exists(manifestPath))
                {
                    continue;
                }

                foreach (var output in ReadManifestOutputs(manifestPath, manifestName))
                {
                    if (output.Kind != "sourceMapping")
                    {
                        continue;
                    }

                    var mappingPath = Path.Combine(artifactsRoot, output.Path);
                    if (!File.Exists(mappingPath))
                    {
                        throw VisualBridgeRuntimeBridgeValidator.Error(
                            "runtime.invalidMessage", "$", $"Source mapping '{output.Path}' listed by a manifest does not exist.");
                    }

                    var mappingRoot = VisualBridgeRuntimeBridgeValidator.ParseObject(File.ReadAllText(mappingPath), "runtime.invalidJson");
                    var artifactPath = mappingRoot["artifact"]?["path"]?.Value<string>();
                    if (string.IsNullOrEmpty(artifactPath))
                    {
                        throw VisualBridgeRuntimeBridgeValidator.Error(
                            "runtime.invalidMessage", "$.artifact.path", $"Source mapping '{output.Path}' must reference its compiled artifact.");
                    }

                    index.TryAdd(artifactPath, output.Path);
                }
            }

            return index;
        }

        private static IEnumerable<ManifestOutput> ReadManifestOutputs(string manifestPath, string manifestName)
        {
            var root = VisualBridgeRuntimeBridgeValidator.ParseObject(File.ReadAllText(manifestPath), "runtime.invalidJson");
            var formatVersion = root["formatVersion"];
            if (formatVersion == null || formatVersion.Type != JTokenType.Integer || formatVersion.Value<int>() != CompiledFormatVersion)
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.formatVersion", $"Manifest '{manifestName}' must declare formatVersion {CompiledFormatVersion}.");
            }

            if (!(root["outputs"] is JArray outputs))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.outputs", $"Manifest '{manifestName}' must declare an outputs array.");
            }

            foreach (var output in outputs)
            {
                if (!(output is JObject entry))
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error(
                        "runtime.invalidMessage", "$.outputs[]", $"Manifest '{manifestName}' has a malformed output entry.");
                }

                var kind = entry["kind"]?.Value<string>();
                var path = entry["path"]?.Value<string>();
                if (kind != "artifact" && kind != "sourceMapping")
                {
                    continue;
                }

                if (string.IsNullOrEmpty(path))
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error(
                        "runtime.invalidMessage", "$.outputs[].path", $"Manifest '{manifestName}' declares an output without a path.");
                }

                // 只接受产物目录内的注册相对路径，拒绝越界路径。
                if (path.Contains("..") || Path.IsPathRooted(path))
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error(
                        "runtime.invalidMessage", "$.outputs[].path", $"Manifest '{manifestName}' declares an unexpected output path '{path}'.");
                }

                if (kind == "artifact")
                {
                    if (!path.StartsWith(DocumentsDirectoryName + "/", StringComparison.Ordinal)
                        || !path.EndsWith(ArtifactFileExtension, StringComparison.Ordinal))
                    {
                        throw VisualBridgeRuntimeBridgeValidator.Error(
                            "runtime.invalidMessage", "$.outputs[].path", $"Manifest '{manifestName}' declares an unexpected artifact path '{path}'.");
                    }
                }
                else if (!path.StartsWith(MappingsDirectoryName + "/", StringComparison.Ordinal)
                    || !path.EndsWith(SourceMappingFileExtension, StringComparison.Ordinal))
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error(
                        "runtime.invalidMessage", "$.outputs[].path", $"Manifest '{manifestName}' declares an unexpected source mapping path '{path}'.");
                }

                yield return new ManifestOutput { Kind = kind, Path = path.Replace('\\', '/') };
            }
        }

        private static VisualBridgeRuntimeDocumentSnapshot LoadArtifact(
            string artifactsRoot, string relativePath, Dictionary<string, string> sourceMappings)
        {
            var absolutePath = Path.Combine(artifactsRoot, relativePath);
            if (!File.Exists(absolutePath))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$", $"Compiled artifact '{relativePath}' listed by a manifest does not exist.");
            }

            var root = VisualBridgeRuntimeBridgeValidator.ParseObject(File.ReadAllText(absolutePath), "runtime.invalidJson");
            var formatVersion = root["formatVersion"];
            if (formatVersion == null || formatVersion.Type != JTokenType.Integer || formatVersion.Value<int>() != CompiledFormatVersion)
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.formatVersion", $"Artifact '{relativePath}' must declare formatVersion {CompiledFormatVersion}.");
            }

            var kind = root["kind"]?.Value<string>();
            if (kind == null || !IsCompiledKind(kind))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.kind", $"Artifact '{relativePath}' does not declare a compiled artifact kind.");
            }

            var projectId = root["projectId"]?.Value<string>();
            if (string.IsNullOrEmpty(projectId))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.projectId", $"Artifact '{relativePath}' must declare a projectId.");
            }

            if (!(root["data"] is JObject data))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.data", $"Artifact '{relativePath}' must declare an object data payload.");
            }

            // table 产物身份是 tableTypeId（无 documentId 字段）；其余域要求 documentTypeId + documentId。
            if (kind == "visualbridge.table.compiled")
            {
                var tableTypeId = root["tableTypeId"]?.Value<string>();
                if (string.IsNullOrEmpty(tableTypeId))
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error(
                        "runtime.invalidMessage", "$.tableTypeId", $"Table artifact '{relativePath}' must declare a tableTypeId.");
                }

                return new VisualBridgeRuntimeDocumentSnapshot
                {
                    DocumentTypeId = tableTypeId,
                    DocumentId = tableTypeId,
                    Kind = kind,
                    Data = data,
                    Sources = ReadTableSources(artifactsRoot, relativePath, sourceMappings, tableTypeId),
                };
            }

            var documentTypeId = root["documentTypeId"]?.Value<string>();
            var documentId = root["documentId"]?.Value<string>();
            if (string.IsNullOrEmpty(documentTypeId) || string.IsNullOrEmpty(documentId))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.documentTypeId",
                    $"Artifact '{relativePath}' must declare documentTypeId and documentId.");
            }

            return new VisualBridgeRuntimeDocumentSnapshot
            {
                DocumentTypeId = documentTypeId,
                DocumentId = documentId,
                Kind = kind,
                Data = data,
                Sources = new[] { ReadDocumentInput(root, relativePath, documentTypeId, documentId) },
            };
        }

        /// <summary>非 table 产物：单一 Authoring 源来自产物 inputs.document（冻结产物格式）。</summary>
        private static VisualBridgeRuntimeDocumentSource ReadDocumentInput(
            JObject root, string relativePath, string documentTypeId, string documentId)
        {
            var sourcePath = root["inputs"]?["document"]?["path"]?.Value<string>();
            var sourceSha256 = root["inputs"]?["document"]?["sha256"]?.Value<string>();
            if (string.IsNullOrEmpty(sourcePath) || !IsSha256Digest(sourceSha256))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.inputs.document",
                    $"Artifact '{relativePath}' must declare inputs.document.path and a 64-hex inputs.document.sha256.");
            }

            return new VisualBridgeRuntimeDocumentSource
            {
                DocumentTypeId = documentTypeId,
                DocumentId = documentId,
                SourcePath = sourcePath,
                SourceSha256 = sourceSha256,
            };
        }

        /// <summary>
        /// table 产物：Authoring 源来自同名 .vbsource.json 的 sources 数组
        /// （每源文件一条映射，身份均为 tableTypeId）；无源文件时不产生条目。
        /// </summary>
        private static IReadOnlyList<VisualBridgeRuntimeDocumentSource> ReadTableSources(
            string artifactsRoot, string relativePath, Dictionary<string, string> sourceMappings, string tableTypeId)
        {
            if (!sourceMappings.TryGetValue(relativePath, out var mappingRelativePath))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$",
                    $"Table artifact '{relativePath}' has no registered source mapping output.");
            }

            var mappingRoot = VisualBridgeRuntimeBridgeValidator.ParseObject(
                File.ReadAllText(Path.Combine(artifactsRoot, mappingRelativePath)), "runtime.invalidJson");
            var formatVersion = mappingRoot["formatVersion"];
            if (formatVersion == null || formatVersion.Type != JTokenType.Integer || formatVersion.Value<int>() != CompiledFormatVersion)
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.formatVersion",
                    $"Source mapping '{mappingRelativePath}' must declare formatVersion {CompiledFormatVersion}.");
            }

            if (!(mappingRoot["sources"] is JArray entries))
            {
                throw VisualBridgeRuntimeBridgeValidator.Error(
                    "runtime.invalidMessage", "$.sources",
                    $"Source mapping '{mappingRelativePath}' must declare a sources array.");
            }

            var sources = new List<VisualBridgeRuntimeDocumentSource>(entries.Count);
            foreach (var entry in entries)
            {
                if (!(entry is JObject source))
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error(
                        "runtime.invalidMessage", "$.sources[]",
                        $"Source mapping '{mappingRelativePath}' has a malformed source entry.");
                }

                var path = source["path"]?.Value<string>();
                var sha256 = source["sha256"]?.Value<string>();
                if (string.IsNullOrEmpty(path) || !IsSha256Digest(sha256))
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error(
                        "runtime.invalidMessage", "$.sources[]",
                        $"Source mapping '{mappingRelativePath}' has a source entry without path or a 64-hex sha256.");
                }

                sources.Add(new VisualBridgeRuntimeDocumentSource
                {
                    DocumentTypeId = tableTypeId,
                    DocumentId = tableTypeId,
                    SourcePath = path,
                    SourceSha256 = sha256,
                });
            }

            return sources;
        }

        private static bool IsSha256Digest(string value)
        {
            if (value == null || value.Length != 64)
            {
                return false;
            }

            foreach (var character in value)
            {
                if ((character < '0' || character > '9') && (character < 'a' || character > 'f'))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsCompiledKind(string kind)
        {
            return kind == "visualbridge.structured.compiled"
                || kind == "visualbridge.entity.compiled"
                || kind == "visualbridge.table.compiled"
                || kind == "visualbridge.graph.compiled";
        }

        private static string HashFile(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
            {
                return ToHex(sha.ComputeHash(stream));
            }
        }

        private static string ToRelativePath(string root, string file)
        {
            return ToForwardSlashes(Path.GetFullPath(file).Substring(Path.GetFullPath(root).Length).TrimStart('/', '\\'));
        }

        private static string ToForwardSlashes(string value)
        {
            return value.Replace('\\', '/');
        }

        private static string ToHex(byte[] hash)
        {
            var builder = new StringBuilder(hash.Length * 2);
            foreach (var value in hash)
            {
                builder.Append(value.ToString("x2"));
            }

            return builder.ToString();
        }
    }
}
