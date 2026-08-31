using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using VisualBridge.Protocol.Generated.VisualBridgeUnityIntegrationProfile;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public sealed class VisualBridgeIntegrationException : Exception
    {
        public VisualBridgeIntegrationException(string code, string path, string message)
            : base($"{code} at {path}: {message}")
        {
            Code = code;
            JsonPath = path;
        }

        public string Code { get; }

        public string JsonPath { get; }
    }

    public sealed class VisualBridgeResolvedProfile
    {
        internal VisualBridgeResolvedProfile(
            string projectRoot,
            string profilePath,
            string authoringProjectPath,
            string compileOutputRoot,
            IReadOnlyList<VisualBridgeResolvedCatalogExport> catalogExports)
        {
            ProjectRoot = projectRoot;
            ProfilePath = profilePath;
            AuthoringProjectPath = authoringProjectPath;
            CompileOutputRoot = compileOutputRoot;
            CatalogExports = catalogExports;
        }

        public string ProjectRoot { get; }

        public string ProfilePath { get; }

        public string AuthoringProjectPath { get; }

        public string CompileOutputRoot { get; }

        public IReadOnlyList<VisualBridgeResolvedCatalogExport> CatalogExports { get; }
    }

    public sealed class VisualBridgeResolvedCatalogExport
    {
        internal VisualBridgeResolvedCatalogExport(string catalogId, string title, string outputPath, IReadOnlyList<string> types)
        {
            CatalogId = catalogId;
            Title = title;
            OutputPath = outputPath;
            Types = types;
        }

        public string CatalogId { get; }

        public string Title { get; }

        public string OutputPath { get; }

        public IReadOnlyList<string> Types { get; }
    }

    public static class VisualBridgeIntegrationProfileLoader
    {
        public const int FormatVersion = 1;
        public const string ProfileRelativePath = "ProjectSettings/VisualBridgeIntegration.json";

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly StringComparer PathComparer = Path.DirectorySeparatorChar == '\\'
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;

        public static VisualBridgeResolvedProfile Load(string unityProjectRoot)
        {
            if (string.IsNullOrWhiteSpace(unityProjectRoot))
            {
                throw Error("profile.invalidProjectRoot", "$", "Unity project root is required.");
            }

            var projectRoot = Path.GetFullPath(unityProjectRoot);
            if (!Directory.Exists(projectRoot))
            {
                throw Error("profile.projectRootNotFound", "$", "Unity project root does not exist.");
            }

            var profilePath = ResolveProjectPath(projectRoot, ProfileRelativePath, "$");
            if (!File.Exists(profilePath))
            {
                throw Error("profile.notFound", "$", $"Expected '{ProfileRelativePath}'.");
            }

            var root = ReadStrictObject(profilePath, "profile.invalidJson");
            RequireOnlyKeys(root, "$", "formatVersion", "authoringProject", "catalogExports", "compileOutputRoot");
            var formatVersion = RequireInteger(root, "formatVersion", "$.formatVersion");
            if (formatVersion != FormatVersion)
            {
                throw Error("profile.unsupportedVersion", "$.formatVersion", $"Expected formatVersion {FormatVersion}.");
            }

            var authoringRelative = RequireString(root, "authoringProject", "$.authoringProject");
            var authoringProjectPath = ResolveProjectPath(projectRoot, authoringRelative, "$.authoringProject");
            if (!File.Exists(authoringProjectPath))
            {
                throw Error("profile.authoringProjectNotFound", "$.authoringProject", "Authoring project file does not exist.");
            }

            var compileRelative = RequireString(root, "compileOutputRoot", "$.compileOutputRoot");
            var compileOutputRoot = ResolveProjectPath(projectRoot, compileRelative, "$.compileOutputRoot");
            var exportsToken = root["catalogExports"];
            if (!(exportsToken is JArray exportsArray) || exportsArray.Count == 0)
            {
                throw Error("profile.invalidCatalogExports", "$.catalogExports", "Expected a non-empty array.");
            }

            var catalogIds = new HashSet<string>(StringComparer.Ordinal);
            var outputPaths = new HashSet<string>(PathComparer);
            var physicalOutputs = new HashSet<string>(StringComparer.Ordinal);
            var exports = new List<VisualBridgeResolvedCatalogExport>(exportsArray.Count);
            for (var index = 0; index < exportsArray.Count; index++)
            {
                var path = $"$.catalogExports[{index}]";
                if (!(exportsArray[index] is JObject exportObject))
                {
                    throw Error("profile.invalidCatalogExport", path, "Expected an object.");
                }

                RequireOnlyKeys(exportObject, path, "catalogId", "title", "output", "types");
                var catalogId = RequireIdentifier(exportObject, "catalogId", path + ".catalogId");
                var title = RequireNonEmptyString(exportObject, "title", path + ".title");
                var outputRelative = RequireString(exportObject, "output", path + ".output");
                var outputPath = ResolveProjectPath(projectRoot, outputRelative, path + ".output");
                if (!outputRelative.EndsWith(".vbstructuredcatalog", StringComparison.Ordinal)
                    && !outputRelative.EndsWith(".vbentitycatalog", StringComparison.Ordinal)
                    && !outputRelative.EndsWith(".vbgraphcatalog", StringComparison.Ordinal))
                {
                    throw Error("profile.invalidCatalogOutput", path + ".output", "Catalog output must end with '.vbstructuredcatalog', '.vbentitycatalog' or '.vbgraphcatalog'.");
                }

                if (!catalogIds.Add(catalogId))
                {
                    throw Error("profile.duplicateCatalogId", path + ".catalogId", $"Duplicate catalog ID '{catalogId}'.");
                }

                if (!outputPaths.Add(outputPath))
                {
                    throw Error("profile.duplicateOutput", path + ".output", "Catalog outputs must be unique after canonical resolution.");
                }

                var physicalIdentity = TryGetPhysicalFileIdentity(outputPath, path + ".output");
                if (physicalIdentity != null && !physicalOutputs.Add(physicalIdentity))
                {
                    throw Error("profile.duplicatePhysicalOutput", path + ".output", "Catalog outputs resolve to the same existing physical file.");
                }

                var types = ReadTypes(exportObject["types"], path + ".types");
                exports.Add(new VisualBridgeResolvedCatalogExport(catalogId, title, outputPath, types));
            }

            return new VisualBridgeResolvedProfile(
                projectRoot,
                profilePath,
                authoringProjectPath,
                compileOutputRoot,
                exports);
        }

        internal static JObject ReadStrictObject(string path, string errorCode)
        {
            string text;
            try
            {
                text = StrictUtf8.GetString(File.ReadAllBytes(path));
            }
            catch (DecoderFallbackException exception)
            {
                throw Error(errorCode, "$", $"File is not valid UTF-8: {exception.Message}");
            }

            try
            {
                using (var stringReader = new StringReader(text))
                using (var reader = new JsonTextReader(stringReader))
                {
                    reader.DateParseHandling = DateParseHandling.None;
                    reader.FloatParseHandling = FloatParseHandling.Decimal;
                    var value = JToken.Load(reader, new JsonLoadSettings
                    {
                        CommentHandling = CommentHandling.Load,
                        DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error,
                        LineInfoHandling = LineInfoHandling.Load,
                    });
                    if (!(value is JObject root))
                    {
                        throw Error(errorCode, "$", "Expected a JSON object.");
                    }

                    if (ContainsTokenType(root, JTokenType.Comment))
                    {
                        throw Error(errorCode, "$", "Comments are not allowed.");
                    }

                    while (reader.Read())
                    {
                        if (reader.TokenType != JsonToken.Comment)
                        {
                            throw Error(errorCode, "$", "Trailing JSON content is not allowed.");
                        }
                    }

                    return root;
                }
            }
            catch (VisualBridgeIntegrationException)
            {
                throw;
            }
            catch (JsonException exception)
            {
                throw Error(errorCode, "$", exception.Message);
            }
        }

        internal static string ResolveProjectPath(string projectRoot, string relativePath, string jsonPath)
        {
            if (string.IsNullOrWhiteSpace(relativePath)
                || relativePath.StartsWith("/", StringComparison.Ordinal)
                || relativePath.Contains(":")
                || relativePath.Contains("\\")
                || relativePath.Contains("//")
                || (relativePath.Length >= 3 && char.IsLetter(relativePath[0]) && relativePath[1] == ':' && relativePath[2] == '/'))
            {
                throw Error("profile.invalidPath", jsonPath, "Expected a normalized project-relative forward-slash path.");
            }

            var segments = relativePath.Split('/');
            if (segments.Any(segment => segment.Length == 0 || segment == "." || segment == ".."))
            {
                throw Error("profile.invalidPath", jsonPath, "Dot and empty path segments are forbidden.");
            }

            var canonicalRoot = Path.GetFullPath(projectRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var candidate = Path.GetFullPath(Path.Combine(canonicalRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            RevalidateResolvedProjectPath(canonicalRoot, candidate, jsonPath);
            return candidate;
        }

        internal static void RevalidateResolvedProjectPath(string projectRoot, string resolvedPath, string jsonPath)
        {
            var canonicalRoot = Path.GetFullPath(projectRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var candidate = Path.GetFullPath(resolvedPath);
            var rootPrefix = canonicalRoot + Path.DirectorySeparatorChar;
            if (!candidate.StartsWith(rootPrefix, PathComparer == StringComparer.OrdinalIgnoreCase
                    ? StringComparison.OrdinalIgnoreCase
                    : StringComparison.Ordinal))
            {
                throw Error("profile.pathOutsideProject", jsonPath, "Resolved path leaves the Unity project root.");
            }

            var relative = candidate.Substring(rootPrefix.Length);
            var resolvedSegments = relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            var current = canonicalRoot;
            foreach (var segment in resolvedSegments)
            {
                current = Path.Combine(current, segment);
                try
                {
                    var attributes = File.GetAttributes(current);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        throw Error("profile.symlinkForbidden", jsonPath, $"Internal symlink or junction segment '{segment}' is forbidden.");
                    }
                }
                catch (FileNotFoundException)
                {
                    // 输出路径尚未创建是合法的；已存在的祖先段此前均已校验。
                }
                catch (DirectoryNotFoundException)
                {
                    // 输出路径尚未创建是合法的；已存在的祖先段此前均已校验。
                }
            }

        }

        internal static void RequireOnlyKeys(JObject value, string path, params string[] allowed)
        {
            var allowedSet = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (var property in value.Properties())
            {
                if (!allowedSet.Contains(property.Name))
                {
                    throw Error("profile.unknownProperty", path + "." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var required in allowed)
            {
                if (value.Property(required, StringComparison.Ordinal) == null)
                {
                    throw Error("profile.missingProperty", path + "." + required, $"Missing property '{required}'.");
                }
            }
        }

        internal static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return new VisualBridgeIntegrationException(code, path, message);
        }

        private static int RequireInteger(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null || token.Type != JTokenType.Integer)
            {
                throw Error("profile.invalidInteger", path, "Expected an integer.");
            }

            try
            {
                return token.Value<int>();
            }
            catch (Exception exception) when (exception is OverflowException || exception is FormatException)
            {
                throw Error("profile.invalidInteger", path, "Integer is outside the supported range.");
            }
        }

        private static string RequireIdentifier(JObject value, string property, string path)
        {
            var result = RequireString(value, property, path);
            if (result.Length > 128 || !IsAsciiAlphaNumeric(result[0]) || result.Any(character => !IsAsciiAlphaNumeric(character) && character != '.' && character != '_' && character != '-'))
            {
                throw Error("profile.invalidIdentifier", path, "Expected a stable identifier.");
            }

            return result;
        }

        private static string RequireNonEmptyString(JObject value, string property, string path)
        {
            var result = RequireString(value, property, path);
            if (string.IsNullOrWhiteSpace(result))
            {
                throw Error("profile.invalidString", path, "Expected a non-empty string.");
            }

            return result;
        }

        private static string RequireString(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("profile.invalidString", path, "Expected a string.");
            }

            return token.Value<string>();
        }

        private static IReadOnlyList<string> ReadTypes(JToken token, string path)
        {
            if (!(token is JArray array) || array.Count == 0)
            {
                throw Error("profile.invalidTypes", path, "Expected a non-empty array.");
            }

            var types = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String)
                {
                    throw Error("profile.invalidType", $"{path}[{index}]", "Expected an assembly-qualified type name string.");
                }

                var name = array[index].Value<string>();
                var commaIndex = name.IndexOf(',');
                if (string.IsNullOrWhiteSpace(name)
                    || !string.Equals(name, name.Trim(), StringComparison.Ordinal)
                    || commaIndex <= 0
                    || string.IsNullOrWhiteSpace(name.Substring(0, commaIndex))
                    || string.IsNullOrWhiteSpace(name.Substring(commaIndex + 1))
                    || name.Any(char.IsControl))
                {
                    throw Error("profile.invalidType", $"{path}[{index}]", "Expected an assembly-qualified type name.");
                }

                if (!unique.Add(name))
                {
                    throw Error("profile.duplicateType", $"{path}[{index}]", $"Duplicate type '{name}'.");
                }

                types.Add(name);
            }

            return types;
        }

        private static bool ContainsTokenType(JToken token, JTokenType type)
        {
            if (token.Type == type)
            {
                return true;
            }

            return token is JContainer container && container.Children().Any(child => ContainsTokenType(child, type));
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        private static string TryGetPhysicalFileIdentity(string path, string jsonPath)
        {
            if (!File.Exists(path) || Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                return null;
            }

            var handle = CreateFile(
                path,
                0,
                FileShareRead | FileShareWrite | FileShareDelete,
                IntPtr.Zero,
                OpenExisting,
                0,
                IntPtr.Zero);
            if (handle == InvalidHandleValue)
            {
                throw Error("profile.physicalIdentityUnavailable", jsonPath, $"Cannot inspect output file identity (Win32 {Marshal.GetLastWin32Error()}).");
            }

            try
            {
                if (!GetFileInformationByHandle(handle, out var information))
                {
                    throw Error("profile.physicalIdentityUnavailable", jsonPath, $"Cannot inspect output file identity (Win32 {Marshal.GetLastWin32Error()}).");
                }

                return information.VolumeSerialNumber.ToString("x8")
                    + ":"
                    + information.FileIndexHigh.ToString("x8")
                    + information.FileIndexLow.ToString("x8");
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint FileShareDelete = 0x00000004;
        private const uint OpenExisting = 3;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public uint CreationTimeLow;
            public uint CreationTimeHigh;
            public uint LastAccessTimeLow;
            public uint LastAccessTimeHigh;
            public uint LastWriteTimeLow;
            public uint LastWriteTimeHigh;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
        private static extern IntPtr CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(IntPtr file, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
