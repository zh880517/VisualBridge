using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    internal sealed class VisualBridgeAuthoringProject
    {
        public VisualBridgeAuthoringProject(
            string rootPath,
            string projectId,
            IReadOnlyList<string> documentRoots,
            IReadOnlyList<VisualBridgeAuthoringModule> modules,
            IReadOnlyList<VisualBridgeAuthoringDocumentType> documentTypes)
        {
            RootPath = rootPath;
            ProjectId = projectId;
            DocumentRoots = documentRoots;
            Modules = modules;
            DocumentTypes = documentTypes;
        }

        public string RootPath { get; }

        public string ProjectId { get; }

        public IReadOnlyList<string> DocumentRoots { get; }

        // 只做结构校验；documentTypes[].editor 与已加载模块的一致性校验延后到模块装载。
        public IReadOnlyList<VisualBridgeAuthoringModule> Modules { get; }

        public IReadOnlyList<VisualBridgeAuthoringDocumentType> DocumentTypes { get; }
    }

    // Project File v2 的模块条目。options 归模块所有，域配置（如 Table 行布局）从这里读取。
    internal sealed class VisualBridgeAuthoringModule
    {
        public VisualBridgeAuthoringModule(string id, string entry, JObject options, string hash)
        {
            Id = id;
            Entry = entry;
            Options = options;
            Hash = hash;
        }

        public string Id { get; }

        public string Entry { get; }

        public JObject Options { get; }

        // 可选的 'sha256:<hex>'。解析器只校验格式，声明值是否与 bundle 字节一致由模块加载比对。
        public string Hash { get; }
    }

    internal sealed class VisualBridgeAuthoringDocumentType
    {
        public VisualBridgeAuthoringDocumentType(
            string id,
            string editor,
            IReadOnlyList<string> include,
            IReadOnlyList<string> exclude,
            IReadOnlyList<string> catalogs)
        {
            Id = id;
            Editor = editor;
            Include = include;
            Exclude = exclude;
            Catalogs = catalogs;
        }

        public string Id { get; }

        public string Editor { get; }

        public IReadOnlyList<string> Include { get; }

        public IReadOnlyList<string> Exclude { get; }

        public IReadOnlyList<string> Catalogs { get; }
    }

    internal static class VisualBridgeAuthoringProjectParser
    {
        internal const string ModuleEntrySuffix = ".vbmodule.js";

        // 与 Core/Protocol Schema 同构：sha256 后接 64 位小写十六进制。
        // 用 \A...\z 而不是 ^...$：.NET 的 '$' 允许末尾换行，会让 "sha256:<hex>\n" 通过。
        private static readonly Regex ModuleHashPattern = new Regex(
            @"\Asha256:[0-9a-f]{64}\z",
            RegexOptions.CultureInvariant);

        private static readonly char[] ForbiddenGlobCharacters = { '?', '[', ']', '{', '}', '(', ')', '!' };

        public static VisualBridgeAuthoringProject Parse(string projectPath)
        {
            var root = VisualBridgeIntegrationProfileLoader.ReadStrictObject(projectPath, "compile.projectInvalidJson");
            // 先版本后结构：v1 文件的主要失败原因是版本，必须报出 unsupportedVersion 与迁移要点，
            // 不能被「未知的 tableLayout」或「缺 modules」抢先（与 Core 的解析顺序对齐）。
            RequireVersion(root["formatVersion"], "$.formatVersion");
            RequireKeys(
                root,
                "$",
                new[] { "formatVersion", "projectId", "documentRoots", "modules", "documentTypes" },
                new[] { "providers" });
            var projectId = RequireIdentifier(root["projectId"], "$.projectId");
            var documentRoots = ReadRelativePaths(root["documentRoots"], "$.documentRoots", true, true);
            var modules = ReadModules(root["modules"]);
            var documentTypes = ReadDocumentTypes(root["documentTypes"]);

            if (root["providers"] != null)
            {
                ValidateProviders(root["providers"], documentTypes);
            }

            return new VisualBridgeAuthoringProject(
                Path.GetDirectoryName(Path.GetFullPath(projectPath)),
                projectId,
                documentRoots,
                modules,
                documentTypes);
        }

        public static string ResolveInsideProject(VisualBridgeAuthoringProject project, string relativePath, string jsonPath)
        {
            ValidateRelativePath(relativePath, jsonPath, false);
            var root = Path.GetFullPath(project.RootPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var candidate = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!IsInside(root, candidate))
            {
                throw Error("compile.pathOutsideProject", jsonPath, "Resolved path leaves the Authoring Project root.");
            }

            RejectReparsePoints(root, relativePath, jsonPath);
            return candidate;
        }

        public static bool Matches(VisualBridgeAuthoringDocumentType documentType, string relativePath)
        {
            return documentType.Include.Any(pattern => MatchesGlob(pattern, relativePath))
                && !documentType.Exclude.Any(pattern => MatchesGlob(pattern, relativePath));
        }

        public static bool IsInsideDocumentRoots(VisualBridgeAuthoringProject project, string relativePath)
        {
            return project.DocumentRoots.Any(root => root == "."
                || string.Equals(relativePath, root, StringComparison.Ordinal)
                || relativePath.StartsWith(root + "/", StringComparison.Ordinal));
        }

        public static bool MatchesGlob(string pattern, string relativePath)
        {
            var patternSegments = pattern.Split('/');
            var pathSegments = relativePath.Split('/');
            var memo = new Dictionary<long, bool>();
            return MatchSegments(patternSegments, 0, pathSegments, 0, memo);
        }

        private static IReadOnlyList<VisualBridgeAuthoringModule> ReadModules(JToken token)
        {
            if (!(token is JArray array))
            {
                throw Error("compile.projectInvalidModules", "$.modules", "Expected an array.");
            }

            var result = new List<VisualBridgeAuthoringModule>(array.Count);
            var ids = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var path = $"$.modules[{index}]";
                if (!(array[index] is JObject value))
                {
                    throw Error("compile.projectInvalidModule", path, "Expected an object.");
                }

                RequireKeys(value, path, new[] { "id", "entry" }, new[] { "options", "hash" });
                var id = RequireIdentifier(value["id"], path + ".id");
                if (!ids.Add(id))
                {
                    throw Error("compile.projectDuplicateModule", path + ".id", $"Duplicate module ID '{id}'.");
                }

                var entry = RequireString(value["entry"], path + ".entry");
                ValidateRelativePath(entry, path + ".entry", false);
                if (!entry.EndsWith(ModuleEntrySuffix, StringComparison.Ordinal))
                {
                    throw Error(
                        "compile.projectInvalidModule",
                        path + ".entry",
                        $"Module entry must end with '{ModuleEntrySuffix}'.");
                }

                JObject options = null;
                if (value["options"] != null)
                {
                    if (!(value["options"] is JObject optionsValue))
                    {
                        throw Error("compile.projectInvalidModule", path + ".options", "Expected an object.");
                    }

                    options = optionsValue;
                }

                string hash = null;
                if (value["hash"] != null)
                {
                    hash = RequireString(value["hash"], path + ".hash");
                    if (!ModuleHashPattern.IsMatch(hash))
                    {
                        throw Error(
                            "compile.projectInvalidModuleHash",
                            path + ".hash",
                            "Expected a module hash of the form 'sha256:<lowercase hex>'.");
                    }
                }

                result.Add(new VisualBridgeAuthoringModule(id, entry, options, hash));
            }

            return result;
        }

        private static IReadOnlyList<VisualBridgeAuthoringDocumentType> ReadDocumentTypes(JToken token)
        {
            if (!(token is JArray array))
            {
                throw Error("compile.projectInvalidDocumentTypes", "$.documentTypes", "Expected an array.");
            }

            var result = new List<VisualBridgeAuthoringDocumentType>(array.Count);
            var ids = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var path = $"$.documentTypes[{index}]";
                if (!(array[index] is JObject value))
                {
                    throw Error("compile.projectInvalidDocumentType", path, "Expected an object.");
                }

                RequireKeys(value, path, new[] { "id", "editor", "include" }, new[] { "exclude", "catalogs" });
                var id = RequireIdentifier(value["id"], path + ".id");
                if (!ids.Add(id))
                {
                    throw Error("compile.projectDuplicateDocumentType", path + ".id", $"Duplicate Document Type ID '{id}'.");
                }

                var editor = RequireIdentifier(value["editor"], path + ".editor");
                var include = ReadGlobs(value["include"], path + ".include", true);
                var exclude = value["exclude"] == null
                    ? Array.Empty<string>()
                    : ReadGlobs(value["exclude"], path + ".exclude", false);
                var catalogs = value["catalogs"] == null
                    ? Array.Empty<string>()
                    : ReadRelativePaths(value["catalogs"], path + ".catalogs", false, false).ToArray();
                result.Add(new VisualBridgeAuthoringDocumentType(id, editor, include, exclude, catalogs));
            }

            return result;
        }

        private static IReadOnlyList<string> ReadGlobs(JToken token, string path, bool requireNonEmpty)
        {
            if (!(token is JArray array) || (requireNonEmpty && array.Count == 0))
            {
                throw Error("compile.projectInvalidGlob", path, requireNonEmpty ? "Expected a non-empty array." : "Expected an array.");
            }

            var result = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var itemPath = $"{path}[{index}]";
                if (array[index].Type != JTokenType.String)
                {
                    throw Error("compile.projectInvalidGlob", itemPath, "Expected a string.");
                }

                var glob = array[index].Value<string>();
                ValidateGlob(glob, itemPath);
                if (!unique.Add(glob))
                {
                    throw Error("compile.projectDuplicateGlob", itemPath, $"Duplicate glob '{glob}'.");
                }

                result.Add(glob);
            }

            return result;
        }

        private static IReadOnlyList<string> ReadRelativePaths(JToken token, string path, bool requireNonEmpty, bool allowRoot)
        {
            if (!(token is JArray array) || (requireNonEmpty && array.Count == 0))
            {
                throw Error("compile.projectInvalidPath", path, requireNonEmpty ? "Expected a non-empty array." : "Expected an array.");
            }

            var result = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var itemPath = $"{path}[{index}]";
                if (array[index].Type != JTokenType.String)
                {
                    throw Error("compile.projectInvalidPath", itemPath, "Expected a string.");
                }

                var value = array[index].Value<string>();
                ValidateRelativePath(value, itemPath, allowRoot);
                if (!unique.Add(value))
                {
                    throw Error("compile.projectDuplicatePath", itemPath, $"Duplicate path '{value}'.");
                }

                result.Add(value);
            }

            return result;
        }

        private static void ValidateProviders(JToken token, IReadOnlyList<VisualBridgeAuthoringDocumentType> documentTypes)
        {
            if (!(token is JArray array) || array.Count == 0)
            {
                throw Error("compile.projectInvalidProviders", "$.providers", "Expected a non-empty array.");
            }

            var providerIds = new HashSet<string>(StringComparer.Ordinal);
            var referenceKinds = new HashSet<string>(
                new[] { "document", "entity.component", "graph.element", "table.row" },
                StringComparer.Ordinal);
            var documentTypeIds = new HashSet<string>(documentTypes.Select(value => value.Id), StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var path = $"$.providers[{index}]";
                if (!(array[index] is JObject provider))
                {
                    throw Error("compile.projectInvalidProvider", path, "Expected an object.");
                }

                RequireKeys(provider, path, new[] { "id", "entry", "args", "capabilities" }, Array.Empty<string>());
                var id = RequireIdentifier(provider["id"], path + ".id");
                if (!providerIds.Add(id))
                {
                    throw Error("compile.projectDuplicateProvider", path + ".id", $"Duplicate provider ID '{id}'.");
                }

                var entry = RequireString(provider["entry"], path + ".entry");
                ValidateRelativePath(entry, path + ".entry", false);
                if (!entry.EndsWith(".mjs", StringComparison.Ordinal))
                {
                    throw Error("compile.projectInvalidProvider", path + ".entry", "Provider entry must end with '.mjs'.");
                }

                if (!(provider["args"] is JArray args) || args.Any(value => value.Type != JTokenType.String))
                {
                    throw Error("compile.projectInvalidProvider", path + ".args", "Expected a string array.");
                }

                foreach (var referenceKind in ValidateProviderCapabilities(provider["capabilities"], path + ".capabilities", documentTypeIds))
                {
                    if (!referenceKinds.Add(referenceKind))
                    {
                        throw Error(
                            "compile.projectReferenceKindConflict",
                            path + ".capabilities.reference.kinds",
                            $"Reference kind '{referenceKind}' conflicts with a built-in or another Project Provider.");
                    }
                }
            }
        }

        private static IReadOnlyList<string> ValidateProviderCapabilities(JToken token, string path, HashSet<string> documentTypeIds)
        {
            if (!(token is JObject value))
            {
                throw Error("compile.projectInvalidCapabilities", path, "Expected an object.");
            }

            RequireKeys(value, path, Array.Empty<string>(), new[] { "reference", "validator" });
            if (value["reference"] == null && value["validator"] == null)
            {
                throw Error("compile.projectInvalidCapabilities", path, "At least one capability is required.");
            }

            var referenceKinds = Array.Empty<string>();
            if (value["reference"] != null)
            {
                if (!(value["reference"] is JObject reference))
                {
                    throw Error("compile.projectInvalidCapabilities", path + ".reference", "Expected an object.");
                }

                RequireKeys(reference, path + ".reference", new[] { "kinds" }, Array.Empty<string>());
                referenceKinds = ReadIdentifiers(reference["kinds"], path + ".reference.kinds").ToArray();
            }

            if (value["validator"] != null)
            {
                if (!(value["validator"] is JObject validator))
                {
                    throw Error("compile.projectInvalidCapabilities", path + ".validator", "Expected an object.");
                }

                RequireKeys(validator, path + ".validator", new[] { "documentTypes" }, Array.Empty<string>());
                foreach (var documentTypeId in ReadIdentifiers(validator["documentTypes"], path + ".validator.documentTypes"))
                {
                    if (!documentTypeIds.Contains(documentTypeId))
                    {
                        throw Error("compile.projectUnknownDocumentType", path + ".validator.documentTypes", $"Unknown Document Type ID '{documentTypeId}'.");
                    }
                }
            }

            return referenceKinds;
        }

        private static IReadOnlyList<string> ReadIdentifiers(JToken token, string path)
        {
            if (!(token is JArray array) || array.Count == 0)
            {
                throw Error("compile.projectInvalidIdentifier", path, "Expected a non-empty array.");
            }

            var result = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                var value = RequireIdentifier(array[index], $"{path}[{index}]");
                if (!unique.Add(value))
                {
                    throw Error("compile.projectDuplicateIdentifier", $"{path}[{index}]", $"Duplicate identifier '{value}'.");
                }

                result.Add(value);
            }

            return result;
        }

        private static void ValidateGlob(string value, string path)
        {
            if (!string.Equals(value, value.Trim(), StringComparison.Ordinal))
            {
                throw Error("compile.projectInvalidGlob", path, "Leading and trailing whitespace is forbidden.");
            }

            ValidateRelativePath(value, path, false);
            if (value.IndexOfAny(ForbiddenGlobCharacters) >= 0)
            {
                throw Error("compile.projectInvalidGlob", path, "Unsupported glob syntax.");
            }

            foreach (var segment in value.Split('/'))
            {
                var stars = segment.Count(character => character == '*');
                if (stars > 1 && !string.Equals(segment, "**", StringComparison.Ordinal))
                {
                    throw Error("compile.projectInvalidGlob", path, "A segment supports at most one '*'; '**' must be a whole segment.");
                }

                if (stars == 2 && !string.Equals(segment, "**", StringComparison.Ordinal))
                {
                    throw Error("compile.projectInvalidGlob", path, "'**' must be a whole segment.");
                }
            }
        }

        private static void ValidateRelativePath(string value, string path, bool allowRoot)
        {
            if (allowRoot && string.Equals(value, ".", StringComparison.Ordinal))
            {
                return;
            }

            if (string.IsNullOrWhiteSpace(value)
                || value.StartsWith("/", StringComparison.Ordinal)
                || value.Contains("\\")
                || value.Contains("//")
                || (value.Length >= 3 && char.IsLetter(value[0]) && value[1] == ':' && value[2] == '/')
                || value.Any(char.IsControl))
            {
                throw Error("compile.projectInvalidPath", path, "Expected a normalized project-relative forward-slash path.");
            }

            if (value.Split('/').Any(segment => segment.Length == 0 || segment == "." || segment == ".."))
            {
                throw Error("compile.projectInvalidPath", path, "Dot and empty path segments are forbidden.");
            }
        }

        private static bool MatchSegments(
            string[] pattern,
            int patternIndex,
            string[] path,
            int pathIndex,
            IDictionary<long, bool> memo)
        {
            var key = ((long)patternIndex << 32) | (uint)pathIndex;
            if (memo.TryGetValue(key, out var cached))
            {
                return cached;
            }

            bool result;
            if (patternIndex == pattern.Length)
            {
                result = pathIndex == path.Length;
            }
            else if (pattern[patternIndex] == "**")
            {
                result = MatchSegments(pattern, patternIndex + 1, path, pathIndex, memo)
                    || (pathIndex < path.Length && MatchSegments(pattern, patternIndex, path, pathIndex + 1, memo));
            }
            else
            {
                result = pathIndex < path.Length
                    && MatchSegment(pattern[patternIndex], path[pathIndex])
                    && MatchSegments(pattern, patternIndex + 1, path, pathIndex + 1, memo);
            }

            memo[key] = result;
            return result;
        }

        private static bool MatchSegment(string pattern, string value)
        {
            var star = pattern.IndexOf('*');
            if (star < 0)
            {
                return string.Equals(pattern, value, StringComparison.Ordinal);
            }

            var prefix = pattern.Substring(0, star);
            var suffix = pattern.Substring(star + 1);
            return value.Length >= prefix.Length + suffix.Length
                && value.StartsWith(prefix, StringComparison.Ordinal)
                && value.EndsWith(suffix, StringComparison.Ordinal);
        }

        private static void RequireKeys(JObject value, string path, IEnumerable<string> required, IEnumerable<string> optional)
        {
            var requiredSet = new HashSet<string>(required, StringComparer.Ordinal);
            var allowed = new HashSet<string>(requiredSet.Concat(optional), StringComparer.Ordinal);
            foreach (var property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw Error("compile.projectUnknownProperty", path + "." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var property in requiredSet)
            {
                if (value.Property(property, StringComparison.Ordinal) == null)
                {
                    throw Error("compile.projectMissingProperty", path + "." + property, $"Missing property '{property}'.");
                }
            }
        }

        private static void RequireVersion(JToken token, string path)
        {
            if (!TryReadFormatVersion(token, out var version) || version != 2)
            {
                throw Error(
                    "compile.projectUnsupportedVersion",
                    path,
                    "Expected integer formatVersion 2. Projects using formatVersion 1 must add the required 'modules' array "
                    + "and move the top-level 'tableLayout' into the 'visualbridge.table' module's 'options.tableLayout'.");
            }
        }

        // Core 侧经 JSON.parse 后无法区分 2 与 2.0（JS 只有 number），因此 Newtonsoft 解析出的
        // 整值浮点（如 2.0）也必须接受，避免同一文件在两侧得到不同的 formatVersion 结论。
        private static bool TryReadFormatVersion(JToken token, out long version)
        {
            version = 0;
            if (token == null)
            {
                return false;
            }

            if (token.Type == JTokenType.Integer)
            {
                try
                {
                    version = token.Value<long>();
                    return true;
                }
                catch (OverflowException)
                {
                    return false;
                }
            }

            if (token.Type != JTokenType.Float)
            {
                return false;
            }

            var value = token.Value<double>();
            if (!double.IsFinite(value) || value != Math.Truncate(value) || value < long.MinValue || value > long.MaxValue)
            {
                return false;
            }

            version = (long)value;
            return true;
        }

        private static string RequireIdentifier(JToken token, string path)
        {
            var value = RequireString(token, path);
            if (value.Length > 128
                || value.Length == 0
                || !IsAsciiAlphaNumeric(value[0])
                || value.Any(character => !IsAsciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-'))
            {
                throw Error("compile.projectInvalidIdentifier", path, "Expected a stable identifier.");
            }

            return value;
        }

        private static string RequireString(JToken token, string path)
        {
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("compile.projectInvalidString", path, "Expected a string.");
            }

            return token.Value<string>();
        }

        private static bool IsInside(string root, string candidate)
        {
            var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            return string.Equals(root, candidate, comparison)
                || candidate.StartsWith(root + Path.DirectorySeparatorChar, comparison);
        }

        private static void RejectReparsePoints(string root, string relativePath, string jsonPath)
        {
            var current = root;
            foreach (var segment in relativePath.Split('/'))
            {
                current = Path.Combine(current, segment);
                try
                {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    {
                        throw Error("compile.pathAliasForbidden", jsonPath, $"Internal symlink or junction segment '{segment}' is forbidden.");
                    }
                }
                catch (FileNotFoundException)
                {
                    return;
                }
                catch (DirectoryNotFoundException)
                {
                    return;
                }
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
