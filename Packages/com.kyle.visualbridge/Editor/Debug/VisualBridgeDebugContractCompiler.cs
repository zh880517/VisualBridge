using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace VisualBridge.Editor
{
    internal enum VisualBridgeDebugContractCompileMode
    {
        Generate,
        Check,
    }

    /// <summary>生成器产物：RelativePath 始终相对工程根，使用正斜杠。</summary>
    internal sealed class VisualBridgeDebugGeneratedFile
    {
        internal VisualBridgeDebugGeneratedFile(string relativePath, string content)
        {
            RelativePath = relativePath;
            Content = content;
        }

        public string RelativePath { get; }

        public string Content { get; }
    }

    internal sealed class VisualBridgeDebugContractCompileResult
    {
        internal VisualBridgeDebugContractCompileResult(
            VisualBridgeDebugContractCompileMode mode,
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files,
            IReadOnlyList<string> errors,
            IReadOnlyList<string> driftPaths,
            IReadOnlyList<string> writtenPaths)
        {
            Mode = mode;
            Files = files;
            Errors = errors;
            DriftPaths = driftPaths;
            WrittenPaths = writtenPaths;
        }

        public VisualBridgeDebugContractCompileMode Mode { get; }

        public IReadOnlyList<VisualBridgeDebugGeneratedFile> Files { get; }

        public IReadOnlyList<string> Errors { get; }

        public IReadOnlyList<string> DriftPaths { get; }

        public IReadOnlyList<string> WrittenPaths { get; }

        public bool DriftDetected
        {
            get { return Errors.Count != 0 || DriftPaths.Count != 0; }
        }
    }

    /// <summary>
    /// 调试契约代码生成器：扫描带 [VisualBridgeDebuger] 的接口，输出确定性门面、实现、分发器与契约清单。
    /// 核心 Build/Validate 不触碰文件系统，便于脱离 Unity 测试。
    /// </summary>
    public static partial class VisualBridgeDebugContractCompiler
    {
        private static readonly UTF8Encoding s_utf8WithoutBom = new UTF8Encoding(false);

        internal static IReadOnlyList<string> Validate(IReadOnlyList<Type> interfaces)
        {
            return CreateModelSet(interfaces).Errors;
        }

        internal static IReadOnlyList<VisualBridgeDebugGeneratedFile> Build(IReadOnlyList<Type> interfaces)
        {
            var set = CreateModelSet(interfaces);
            if (set.Errors.Count != 0)
            {
                throw new InvalidOperationException(
                    "Debug contract validation failed:\n" + string.Join("\n", set.Errors));
            }

            return EmitFiles(set.Models);
        }

        internal static VisualBridgeDebugContractCompileResult Compile(
            string projectRoot,
            VisualBridgeDebugContractCompileMode mode)
        {
            return Compile(projectRoot, mode, DiscoverInterfaces());
        }

        internal static VisualBridgeDebugContractCompileResult Compile(
            string projectRoot,
            VisualBridgeDebugContractCompileMode mode,
            IReadOnlyList<Type> interfaces)
        {
            if (projectRoot == null)
            {
                throw new ArgumentNullException(nameof(projectRoot));
            }

            var set = CreateModelSet(interfaces);
            if (set.Errors.Count != 0)
            {
                return Failed(mode, set.Errors);
            }

            List<VisualBridgeDebugGeneratedFile> files;
            try
            {
                files = EmitFiles(set.Models).ToList();
            }
            catch (InvalidOperationException exception)
            {
                return Failed(mode, new[] { exception.Message });
            }

            var asmdefErrors = new List<string>();
            files.AddRange(PlanAsmdefs(projectRoot, set.Models, asmdefErrors));
            if (asmdefErrors.Count != 0)
            {
                return Failed(mode, asmdefErrors);
            }

            files = files.OrderBy(file => file.RelativePath, StringComparer.Ordinal).ToList();
            var drift = new List<string>();
            var written = new List<string>();
            foreach (var file in files)
            {
                ResolvedPath resolved = ResolveProjectPath(projectRoot, file.RelativePath);
                byte[] expected = s_utf8WithoutBom.GetBytes(file.Content);
                bool matches = File.Exists(resolved.FullPath)
                    && File.ReadAllBytes(resolved.FullPath).SequenceEqual(expected);
                if (matches)
                {
                    continue;
                }

                if (mode == VisualBridgeDebugContractCompileMode.Check)
                {
                    drift.Add(file.RelativePath);
                    continue;
                }

                Directory.CreateDirectory(Path.GetDirectoryName(resolved.FullPath));
                File.WriteAllBytes(resolved.FullPath, expected);
                written.Add(file.RelativePath);
            }

            return new VisualBridgeDebugContractCompileResult(
                mode,
                files,
                Array.Empty<string>(),
                drift,
                written);
        }

        // 逐目录确认是否需要一个生成 asmdef；不删除任何文件，已存在的目标内容不符则报错。
        private static IReadOnlyList<VisualBridgeDebugGeneratedFile> PlanAsmdefs(
            string projectRoot,
            IReadOnlyList<DebugContractModel> models,
            ICollection<string> errors)
        {
            var result = new List<VisualBridgeDebugGeneratedFile>();
            foreach (var group in models
                         .GroupBy(model => model.GeneratedDirectory, StringComparer.Ordinal)
                         .OrderBy(value => value.Key, StringComparer.Ordinal))
            {
                var assemblies = group
                    .Select(model => model.AssemblyName)
                    .Where(value => !string.IsNullOrEmpty(value))
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToArray();
                var categories = group
                    .Select(model => model.Category)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToArray();
                bool canName = assemblies.Length == 1 && categories.Length == 1;
                string expectedName = canName
                    ? assemblies[0] + ".VisualBridgeGenerated." + categories[0]
                    : null;
                ResolvedPath directory = ResolveProjectPath(projectRoot, group.Key);
                string targetPath = expectedName == null
                    ? null
                    : Path.Combine(directory.FullPath, expectedName + ".asmdef");

                if (targetPath != null && File.Exists(targetPath))
                {
                    string expected = BuildAsmdefContent(expectedName, assemblies[0]);
                    string actual = NormalizeNewLines(File.ReadAllText(targetPath));
                    if (!string.Equals(actual, NormalizeNewLines(expected), StringComparison.Ordinal))
                    {
                        errors.Add(Diagnostic(
                            DiagnosticGeneratedDirectory,
                            group.Key,
                            "Existing asmdef '" + expectedName + ".asmdef' does not match the generated content; refusing to overwrite."));
                    }

                    // 目标 asmdef 已存在（内容一致或已报错），不再规划新文件。
                    continue;
                }

                if (FindNearestAsmdef(projectRoot, group.Key) != null)
                {
                    // 目录已位于某个既有 asmdef 的覆盖范围内，直接写入。
                    continue;
                }

                bool allPredefined = assemblies.Length != 0 && assemblies.All(IsPredefinedAssembly);
                if (allPredefined)
                {
                    continue;
                }

                if (!canName || assemblies.Any(IsPredefinedAssembly))
                {
                    errors.Add(Diagnostic(
                        DiagnosticGeneratedDirectory,
                        group.Key,
                        "Generated directory needs an asmdef but mixes interface assemblies or categories; split the directory first."));
                    continue;
                }

                result.Add(new VisualBridgeDebugGeneratedFile(
                    group.Key + "/" + expectedName + ".asmdef",
                    BuildAsmdefContent(expectedName, assemblies[0])));
            }

            return result;
        }

        private static string BuildAsmdefContent(string name, string interfaceAssembly)
        {
            var json = new Newtonsoft.Json.Linq.JObject();
            json["name"] = name;
            json["references"] = new Newtonsoft.Json.Linq.JArray(interfaceAssembly, "VisualBridge.Debug");
            json["includePlatforms"] = new Newtonsoft.Json.Linq.JArray();
            json["excludePlatforms"] = new Newtonsoft.Json.Linq.JArray();
            json["allowUnsafeCode"] = false;
            json["overrideReferences"] = false;
            json["precompiledReferences"] = new Newtonsoft.Json.Linq.JArray();
            json["autoReferenced"] = true;
            json["defineConstraints"] = new Newtonsoft.Json.Linq.JArray();
            json["versionDefines"] = new Newtonsoft.Json.Linq.JArray();
            json["noEngineReferences"] = false;
            return NormalizeNewLines(json.ToString(Newtonsoft.Json.Formatting.Indented)) + "\n";
        }

        private static string FindNearestAsmdef(string projectRoot, string relativeDirectory)
        {
            ResolvedPath resolved = ResolveProjectPath(projectRoot, relativeDirectory);
            string current = resolved.FullPath;
            while (current != null && IsInsideRoot(resolved.Root, current))
            {
                if (Directory.Exists(current))
                {
                    string[] candidates;
                    try
                    {
                        candidates = Directory.GetFiles(current, "*.asmdef");
                    }
                    catch (Exception)
                    {
                        candidates = Array.Empty<string>();
                    }

                    if (candidates.Length != 0)
                    {
                        Array.Sort(candidates, StringComparer.Ordinal);
                        return candidates[0];
                    }
                }

                if (PathsEqual(current, resolved.Root))
                {
                    break;
                }

                current = Path.GetDirectoryName(current);
            }

            return null;
        }

        private static ResolvedPath ResolveProjectPath(string projectRoot, string relativePath)
        {
            string normalizedRoot = Path.GetFullPath(projectRoot);
            string root = normalizedRoot;
            string[] segments = relativePath.Split('/');
            if (segments.Length >= 2 && string.Equals(segments[0], "Packages", StringComparison.Ordinal))
            {
                // 外部包的物理目录通常位于工程根的上一级（本仓库的 file:../../Packages 布局）。
                string embedded = Path.Combine(normalizedRoot, "Packages", segments[1]);
                if (!Directory.Exists(embedded))
                {
                    string parent = Path.GetFullPath(Path.Combine(normalizedRoot, ".."));
                    if (Directory.Exists(Path.Combine(parent, "Packages", segments[1])))
                    {
                        root = parent;
                    }
                }
            }

            string fullPath = Path.GetFullPath(Path.Combine(
                root,
                relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!IsInsideRoot(root, fullPath))
            {
                throw new InvalidOperationException("Generated path escapes the project root: " + relativePath);
            }

            return new ResolvedPath(root, fullPath);
        }

        private static bool IsInsideRoot(string root, string path)
        {
            string normalizedRoot = Path.GetFullPath(root);
            string normalizedPath = Path.GetFullPath(path);
            if (string.Equals(normalizedPath, normalizedRoot, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return normalizedPath.StartsWith(
                normalizedRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
        }

        private static bool PathsEqual(string left, string right)
        {
            return string.Equals(
                Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeNewLines(string value)
        {
            return value.Replace("\r\n", "\n").Replace("\r", "\n");
        }

        private static VisualBridgeDebugContractCompileResult Failed(
            VisualBridgeDebugContractCompileMode mode,
            IReadOnlyList<string> errors)
        {
            return new VisualBridgeDebugContractCompileResult(
                mode,
                Array.Empty<VisualBridgeDebugGeneratedFile>(),
                errors,
                Array.Empty<string>(),
                Array.Empty<string>());
        }

        private readonly struct ResolvedPath
        {
            public ResolvedPath(string root, string fullPath)
            {
                Root = root;
                FullPath = fullPath;
            }

            public string Root { get; }

            public string FullPath { get; }
        }
    }
}
