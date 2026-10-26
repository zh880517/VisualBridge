using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 调试契约生成器的编排入口（附录 B.5）：发现接口 → 校验 → 号分配 → 发射 → 比较/写盘。
    /// 生成器只在 <c>VisualBridge.Editor</c> 内（Editor-only），不创建 asmdef。
    /// Generate 会写产物、陈旧清理与 <c>Library/</c> 下的清理状态；Check 只读（不建锁、不写任何文件）。
    /// </summary>
    public static class VisualBridgeDebugGenerator
    {
        private const int LockRetryMilliseconds = 50;
        private const int LockTimeoutMilliseconds = 10000;

        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        /// <summary>反射发现全部带 <c>[VisualBridgeDebuger]</c> 的接口；batch 入口用它取得输入。</summary>
        public static IReadOnlyList<Type> DiscoverInterfaces()
        {
            return VisualBridgeDebugGeneratorDiscovery.DiscoverInterfaces();
        }

        /// <summary>入口 IGenerate：生成并写盘（等价于 <see cref="Compile"/> 的 Generate 模式）。</summary>
        public static VisualBridgeDebugCompileResult Generate(VisualBridgeDebugGeneratorSettings settings)
        {
            return Compile(settings, VisualBridgeDebugGenerateMode.Generate);
        }

        /// <summary>入口 ICheck：只比较不写盘（等价于 <see cref="Compile"/> 的 Check 模式）。</summary>
        public static VisualBridgeDebugCompileResult Check(VisualBridgeDebugGeneratorSettings settings)
        {
            return Compile(settings, VisualBridgeDebugGenerateMode.Check);
        }

        /// <summary>
        /// 执行一次 Generate 或 Check。Check 比较**全部**产物（含三个全局产物与陈旧文件），
        /// drift 只从返回值暴露；退出码由 batch 入口映射为 0/1/2。
        /// </summary>
        public static VisualBridgeDebugCompileResult Compile(
            VisualBridgeDebugGeneratorSettings settings,
            VisualBridgeDebugGenerateMode mode)
        {
            if (settings == null)
            {
                throw new ArgumentNullException(nameof(settings));
            }

            var projectRoot = Path.GetFullPath(settings.UnityProjectRoot);
            var artifactsRootRelative = VisualBridgeDebugGeneratorPaths.NormalizeProjectRelative(
                projectRoot,
                settings.ArtifactsRoot,
                "debug.artifactsRootInvalid");
            VisualBridgeDebugAssemblyCoverage.RequireCovered(
                projectRoot,
                VisualBridgeDebugGeneratorPaths.ToFullPath(projectRoot, artifactsRootRelative),
                "VisualBridgeDebugConfig.ArtifactsRoot");

            if (mode == VisualBridgeDebugGenerateMode.Check)
            {
                // Check 只读：不建锁、不写状态文件，连 Library/ 都不创建（评审 P2-10）。
                return Run(settings, mode, projectRoot, artifactsRootRelative);
            }

            using (AcquireLock(projectRoot))
            {
                return Run(settings, mode, projectRoot, artifactsRootRelative);
            }
        }

        private static VisualBridgeDebugCompileResult Run(
            VisualBridgeDebugGeneratorSettings settings,
            VisualBridgeDebugGenerateMode mode,
            string projectRoot,
            string artifactsRootRelative)
        {
            var definition = VisualBridgeDebugGeneratorDiscovery.BuildDefinition(settings.Interfaces, projectRoot);
            foreach (var category in definition.Categories)
            {
                VisualBridgeDebugAssemblyCoverage.RequireCovered(
                    projectRoot,
                    VisualBridgeDebugGeneratorPaths.ToFullPath(projectRoot, category.GeneratedDirectory),
                    "分类 " + category.Name + " 的 GeneratedDirectory");
            }

            var ids = VisualBridgeDebugIdState.Load(Path.Combine(
                VisualBridgeDebugGeneratorPaths.ToFullPath(projectRoot, artifactsRootRelative),
                "debug-ids.json"));
            VisualBridgeDebugIdAllocator.Assign(definition, ids);

            var planned = VisualBridgeDebugEmitter.EmitAll(definition, ids, projectRoot, artifactsRootRelative);
            var outputs = planned.Select(Inspect).ToArray();
            var stale = CollectStaleOutputs(projectRoot, definition, planned, LoadManagedOutputs(projectRoot));
            var contractHash = VisualBridgeDebugContractHash.Compute(definition);

            if (mode == VisualBridgeDebugGenerateMode.Generate)
            {
                Commit(planned, outputs, stale);
                // 记录本次产物清单：下次生成据此清理被删除的分类/接口/被移动的目录与 ArtifactsRoot。
                SaveManagedOutputs(projectRoot, planned);
            }

            return new VisualBridgeDebugCompileResult(mode, outputs, stale, contractHash);
        }

        private static VisualBridgeDebugCompileOutput Inspect(VisualBridgeDebugPlannedFile planned)
        {
            var previous = File.Exists(planned.FullPath) ? File.ReadAllBytes(planned.FullPath) : null;
            return new VisualBridgeDebugCompileOutput(
                planned.FullPath,
                planned.Sha256,
                previous == null ? null : VisualBridgeDebugContractHash.HashFile(previous),
                previous == null || !previous.SequenceEqual(planned.Bytes));
        }

        /// <summary>
        /// 收集已经不再对应任何接口的旧产物：上一次 Generate 记录的产物路径（覆盖删分类、移动目录、
        /// 换 ArtifactsRoot）+ 当前分类目录里带 auto-generated 头的 *.g.cs / *.g.ts。
        /// Check 计 drift，Generate 删除。
        /// </summary>
        private static string[] CollectStaleOutputs(
            string projectRoot,
            VisualBridgeDebugDefinitionModel definition,
            IReadOnlyList<VisualBridgeDebugPlannedFile> planned,
            IReadOnlyList<string> previousManagedOutputs)
        {
            var expected = new HashSet<string>(
                planned.Select(value => value.FullPath),
                VisualBridgeDebugGeneratorPaths.FilePathComparer);
            var candidates = new SortedSet<string>(VisualBridgeDebugGeneratorPaths.FilePathComparer);

            foreach (var relative in previousManagedOutputs)
            {
                string fullPath;
                if (TryResolveManagedOutput(projectRoot, relative, out fullPath))
                {
                    candidates.Add(fullPath);
                }
            }

            foreach (var directory in definition.Categories
                         .Select(category => VisualBridgeDebugGeneratorPaths.ToFullPath(projectRoot, category.GeneratedDirectory))
                         .Distinct(VisualBridgeDebugGeneratorPaths.FilePathComparer))
            {
                if (!Directory.Exists(directory))
                {
                    continue;
                }

                foreach (var path in Directory.EnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly))
                {
                    candidates.Add(path);
                }
            }

            return candidates
                .Where(path => !expected.Contains(path) && File.Exists(path) && IsManagedArtifact(path))
                .ToArray();
        }

        private static bool TryResolveManagedOutput(string projectRoot, string relative, out string fullPath)
        {
            fullPath = null;
            if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative))
            {
                return false;
            }

            if (!relative.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)
                && !relative.EndsWith(".g.ts", StringComparison.OrdinalIgnoreCase)
                && !IsGlobalArtifactName(Path.GetFileName(relative)))
            {
                return false;
            }

            string normalized;
            if (!VisualBridgeDebugGeneratorPaths.TryGetProjectRelative(
                    projectRoot,
                    Path.GetFullPath(Path.Combine(projectRoot, relative.Replace('/', Path.DirectorySeparatorChar))),
                    out normalized)
                || string.IsNullOrEmpty(normalized))
            {
                return false;
            }

            fullPath = VisualBridgeDebugGeneratorPaths.ToFullPath(projectRoot, normalized);
            return true;
        }

        /// <summary>
        /// 生成目录与 ArtifactsRoot 按约定专用于调试契约产物；只清理带 <c>// &lt;auto-generated /&gt;</c>
        /// 标记的 <c>*.g.cs</c> / <c>*.g.ts</c> 与两个 JSON 全局产物，避免误删手写或其它工具的文件。
        /// </summary>
        private static bool IsManagedArtifact(string path)
        {
            var name = Path.GetFileName(path);
            if (IsGlobalArtifactName(name))
            {
                try
                {
                    return File.ReadAllText(path, Utf8WithoutBom)
                        .Contains("\"//\": \"// <auto-generated />\"", StringComparison.Ordinal);
                }
                catch (IOException)
                {
                    return false;
                }
                catch (UnauthorizedAccessException)
                {
                    return false;
                }
            }

            if (!name.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)
                && !name.EndsWith(".g.ts", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            try
            {
                using (var reader = new StreamReader(path, Utf8WithoutBom, false))
                {
                    return string.Equals(reader.ReadLine(), "// <auto-generated />", StringComparison.Ordinal);
                }
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
        }

        private static bool IsGlobalArtifactName(string name)
        {
            return string.Equals(name, "debug-contracts.json", StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, "debug-ids.json", StringComparison.OrdinalIgnoreCase);
        }

        private static void Commit(
            IReadOnlyList<VisualBridgeDebugPlannedFile> planned,
            IReadOnlyList<VisualBridgeDebugCompileOutput> outputs,
            IReadOnlyList<string> stale)
        {
            for (var index = 0; index < planned.Count; index++)
            {
                if (!outputs[index].Changed)
                {
                    continue;
                }

                WriteAtomically(planned[index].FullPath, planned[index].Bytes, outputs[index].PreviousSha256,
                    planned[index].RelativePath);
            }

            foreach (var path in stale)
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
        }

        private static string ManagedOutputsPath(string projectRoot)
        {
            return Path.Combine(projectRoot, "Library", "VisualBridge", "debug-generator-state.json");
        }

        private static IReadOnlyList<string> LoadManagedOutputs(string projectRoot)
        {
            var path = ManagedOutputsPath(projectRoot);
            if (!File.Exists(path))
            {
                return Array.Empty<string>();
            }

            try
            {
                var root = JObject.Parse(File.ReadAllText(path, Utf8WithoutBom));
                var outputs = root["outputs"] as JArray;
                if (outputs == null)
                {
                    return Array.Empty<string>();
                }

                return outputs
                    .Select(token => token.Type == JTokenType.String ? token.Value<string>() : null)
                    .Where(value => !string.IsNullOrEmpty(value))
                    .ToArray();
            }
            catch (Exception exception) when (exception is JsonException || exception is IOException
                                              || exception is UnauthorizedAccessException)
            {
                // 清理状态只是辅助数据，坏了就当空，Generate 会重写。
                return Array.Empty<string>();
            }
        }

        private static void SaveManagedOutputs(string projectRoot, IReadOnlyList<VisualBridgeDebugPlannedFile> planned)
        {
            var path = ManagedOutputsPath(projectRoot);
            var builder = new StringBuilder();
            builder.Append("{\n");
            builder.Append("  \"//\": \"// <auto-generated />\",\n");
            builder.Append("  \"outputs\": [");
            var relativePaths = planned.Select(value => value.RelativePath).OrderBy(value => value, StringComparer.Ordinal).ToArray();
            if (relativePaths.Length == 0)
            {
                builder.Append("]\n");
            }
            else
            {
                builder.Append('\n');
                for (var index = 0; index < relativePaths.Length; index++)
                {
                    builder.Append("    ").Append(JsonConvert.ToString(relativePaths[index]));
                    builder.Append(index + 1 < relativePaths.Length ? ",\n" : "\n");
                }

                builder.Append("  ]\n");
            }

            builder.Append("}\n");
            WriteAtomically(path, Utf8WithoutBom.GetBytes(builder.ToString()), null, path);
        }

        /// <summary>原子替换：先写临时文件再 Replace/Move；替换前复核磁盘内容未被并发改动。</summary>
        private static void WriteAtomically(string fullPath, byte[] bytes, string baselineHash, string displayPath)
        {
            var directory = Path.GetDirectoryName(fullPath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var temporaryPath = fullPath + ".visualbridge." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }

                var exists = File.Exists(fullPath);
                if (baselineHash != null)
                {
                    var currentHash = VisualBridgeDebugContractHash.HashFile(File.ReadAllBytes(fullPath));
                    if (!string.Equals(currentHash, baselineHash, StringComparison.Ordinal))
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "debug.outputChangedBeforeReplace",
                            "产物在计划与写入之间被改动，已放弃本次写入：" + displayPath);
                    }
                }

                if (exists)
                {
                    File.Replace(temporaryPath, fullPath, null);
                }
                else
                {
                    File.Move(temporaryPath, fullPath);
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }

        /// <summary>
        /// 跨进程串行化 <c>debug-ids.json</c> 的读改写（评审 P0：两次 Generate 并发会写坏号表）。
        /// 只有 Generate 取锁；锁文件放在 <c>Library/</c>（不被 Unity 导入、不进版本库），不污染 ArtifactsRoot。
        /// </summary>
        private static IDisposable AcquireLock(string projectRoot)
        {
            var directory = Path.Combine(projectRoot, "Library", "VisualBridge");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "debug-generator.lock");
            var deadline = DateTime.UtcNow.AddMilliseconds(LockTimeoutMilliseconds);
            while (true)
            {
                try
                {
                    return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                }
                catch (IOException)
                {
                    if (DateTime.UtcNow >= deadline)
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "debug.lockTimeout",
                            "等待调试生成器锁超时（另一个 Generate 正在运行）：" + path);
                    }
                }
                catch (UnauthorizedAccessException)
                {
                    if (DateTime.UtcNow >= deadline)
                    {
                        throw new VisualBridgeDebugGeneratorException(
                            "debug.lockTimeout",
                            "无法获取调试生成器锁：" + path);
                    }
                }

                Thread.Sleep(LockRetryMilliseconds);
            }
        }
    }
}
