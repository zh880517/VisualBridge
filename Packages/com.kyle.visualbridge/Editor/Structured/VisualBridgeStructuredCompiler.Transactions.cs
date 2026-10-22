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
        internal static string InputDisplayPath(VisualBridgeResolvedProfile profile, VisualBridgeAuthoringProject project, string path)
        {
            if (IsInside(profile.ProjectRoot, path))
            {
                return RelativePathInside(profile.ProjectRoot, path, "input");
            }

            if (IsInside(project.RootPath, path))
            {
                return RelativePathInside(project.RootPath, path, "input");
            }

            throw Error("compile.inputOutsideProject", path, "Compiler input is outside the Unity Project.");
        }

        private static IReadOnlyList<string> ReadPreviousManagedPaths(string outputRoot)
        {
            var manifestPath = Path.Combine(outputRoot, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                return Array.Empty<string>();
            }

            RejectOutputAlias(manifestPath);
            var manifest = VisualBridgeIntegrationProfileLoader.ReadStrictObject(manifestPath, "compile.manifestInvalidJson");
            RequireKeys(manifest, "manifest", new[] { "formatVersion", "kind", "projectId", "inputs", "outputs" });
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
                    throw Error("compile.manifestInvalid", $"manifest.outputs[{index}]", "Expected an object.");
                }

                RequireKeys(output, $"manifest.outputs[{index}]", new[] { "kind", "path", "sha256" });
                var path = output["path"].Type == JTokenType.String ? output.Value<string>("path") : null;
                ValidateOutputRelativePath(path, $"manifest.outputs[{index}].path");
                RequireHash(output["sha256"], $"manifest.outputs[{index}].sha256");
                if (!unique.Add(path))
                {
                    throw Error("compile.manifestInvalid", $"manifest.outputs[{index}].path", "Duplicate managed output path.");
                }

                result.Add(path);
            }

            return result;
        }

        internal static void CommitTransaction(
            string outputRoot,
            IReadOnlyList<OutputPlan> plans,
            IReadOnlyList<VisualBridgeStructuredCompileOutput> outputs,
            IReadOnlyList<string> stalePaths,
            IEnumerable<InputSnapshot> inputs)
        {
            var changes = plans.Zip(outputs, (plan, output) => new TransactionFile(plan.FullPath, plan.Bytes, output.PreviousSha256, output.Changed))
                .Where(value => value.Changed)
                .ToList();
            changes.AddRange(stalePaths.Select(path => new TransactionFile(path, null, HashFile(path), true)));
            changes = changes.OrderBy(value => value.Path.EndsWith("manifest.json", StringComparison.Ordinal) ? 1 : 0)
                .ThenBy(value => value.Path, FilePathComparer)
                .ToList();
            for (var index = 0; index < changes.Count; index++)
            {
                changes[index].TransactionIndex = index;
                var state = InspectOutputFile(changes[index].Path);
                if (!string.Equals(state.Hash, changes[index].BaselineHash, StringComparison.Ordinal))
                {
                    throw Error("compile.outputChangedBeforeReplace", changes[index].Path, "Output changed after planning and before transaction staging.");
                }

                changes[index].BaselineExists = state.Exists;
                changes[index].BaselineIdentity = state.Identity;
            }

            var transactionId = Guid.NewGuid().ToString("N");
            try
            {
                RejectOutputAlias(outputRoot);
                foreach (var change in changes.Where(value => value.Bytes != null))
                {
                    RejectOutputAlias(change.Path);
                    var directory = Path.GetDirectoryName(change.Path);
                    Directory.CreateDirectory(directory);
                    RejectOutputAlias(change.Path);
                    change.TemporaryPath = Path.Combine(directory, $".visualbridge.{transactionId}.{change.TransactionIndex}.tmp");
                    RejectOutputAlias(change.TemporaryPath);
                    using (var stream = new FileStream(change.TemporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        stream.Write(change.Bytes, 0, change.Bytes.Length);
                        stream.Flush(true);
                    }
                }

                VerifyInputs(inputs);
                VerifyTransactionTargets(outputRoot, changes);

                foreach (var change in changes)
                {
                    VerifyTransactionTarget(outputRoot, change);
                    var directory = Path.GetDirectoryName(change.Path);
                    change.BackupPath = Path.Combine(directory, $".visualbridge.{transactionId}.{change.TransactionIndex}.bak");
                    RejectOutputAlias(change.BackupPath);
                    if (change.Bytes == null)
                    {
                        File.Move(change.Path, change.BackupPath);
                        change.Applied = true;
                    }
                    else if (File.Exists(change.Path))
                    {
                        File.Replace(change.TemporaryPath, change.Path, change.BackupPath);
                        change.Applied = true;
                    }
                    else
                    {
                        File.Move(change.TemporaryPath, change.Path);
                        change.Applied = true;
                        change.Created = true;
                    }
                }
            }
            catch
            {
                RollBack(outputRoot, changes);
                throw;
            }
            finally
            {
                foreach (var change in changes)
                {
                    TryDelete(change.TemporaryPath);
                }
            }

            foreach (var change in changes)
            {
                TryDelete(change.BackupPath);
            }
        }

        private static void VerifyTransactionTargets(string outputRoot, IEnumerable<TransactionFile> changes)
        {
            RejectOutputAlias(outputRoot);
            foreach (var change in changes)
            {
                VerifyTransactionTarget(outputRoot, change);
            }
        }

        private static void VerifyTransactionTarget(string outputRoot, TransactionFile change)
        {
            RejectOutputAlias(outputRoot);
            var state = InspectOutputFile(change.Path);
            if (state.Exists != change.BaselineExists
                || !string.Equals(state.Identity, change.BaselineIdentity, StringComparison.Ordinal)
                || !string.Equals(state.Hash, change.BaselineHash, StringComparison.Ordinal))
            {
                throw Error("compile.outputChangedBeforeReplace", change.Path, "Output identity or content changed before atomic replacement.");
            }
        }

        private static void RollBack(string outputRoot, IEnumerable<TransactionFile> changes)
        {
            foreach (var change in changes.Where(value => value.Applied).Reverse())
            {
                try
                {
                    RejectOutputAlias(outputRoot);
                    RejectOutputAlias(change.Path);
                    RejectOutputAlias(change.BackupPath);
                    if (change.Created)
                    {
                        if (File.Exists(change.Path)) File.Delete(change.Path);
                    }
                    else if (File.Exists(change.BackupPath))
                    {
                        if (File.Exists(change.Path)) File.Delete(change.Path);
                        File.Move(change.BackupPath, change.Path);
                    }
                }
                catch
                {
                    // 保留原始异常；残留的备份保留在目标旁供人工恢复。
                }
            }
        }

        internal static void VerifyInputs(IEnumerable<InputSnapshot> inputs)
        {
            foreach (var input in inputs)
            {
                if (!File.Exists(input.Path) || !string.Equals(HashFile(input.Path), input.Hash, StringComparison.Ordinal))
                {
                    throw Error("compile.inputChanged", input.Path, "Compiler input changed while the compile plan was being built.");
                }
            }
        }

        internal static void EnumerateFilesStrict(string projectRoot, string directory, ISet<string> files)
        {
            var pending = new Stack<string>();
            pending.Push(directory);
            while (pending.Count != 0)
            {
                var current = pending.Pop();
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                {
                    throw Error("compile.pathAliasForbidden", RelativePathInside(projectRoot, current, "documentRoot"), "Symlink or junction directories are forbidden.");
                }

                foreach (var entry in Directory.GetFileSystemEntries(current).OrderBy(value => value, FilePathComparer))
                {
                    var attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        throw Error("compile.pathAliasForbidden", RelativePathInside(projectRoot, entry, "document"), "Symlink or junction entries are forbidden.");
                    }

                    if ((attributes & FileAttributes.Directory) != 0) pending.Push(entry);
                    else files.Add(Path.GetFullPath(entry));
                }
            }
        }

        internal static void RequireFrozenOutputRoot(VisualBridgeResolvedProfile profile)
        {
            var expected = Path.GetFullPath(Path.Combine(profile.ProjectRoot, OutputRelativeRoot.Replace('/', Path.DirectorySeparatorChar)));
            if (!FilePathComparer.Equals(expected, profile.CompileOutputRoot))
            {
                throw Error("compile.outputRootMismatch", "$.compileOutputRoot", $"V1 compileOutputRoot must be exactly '{OutputRelativeRoot}'.");
            }
        }

        internal static OutputPlan CreateOutput(string outputRoot, string relativePath, byte[] bytes, string kind)
        {
            var fullPath = ResolveOutputPath(outputRoot, relativePath);
            return new OutputPlan(relativePath, fullPath, bytes, HashBytes(bytes), kind);
        }

        internal static string ResolveOutputPath(string outputRoot, string relativePath)
        {
            ValidateOutputRelativePath(relativePath, "output");
            var root = Path.GetFullPath(outputRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var path = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!IsInside(root, path))
            {
                throw Error("compile.outputOutsideRoot", relativePath, "Output path leaves compileOutputRoot.");
            }

            return path;
        }

        internal static void ValidateOutputRelativePath(string path, string jsonPath)
        {
            if (string.IsNullOrEmpty(path)
                || path.StartsWith("/", StringComparison.Ordinal)
                || path.Contains("\\")
                || path.Contains(":")
                || path.Contains("//")
                || path.Split('/').Any(segment => segment.Length == 0 || segment == "." || segment == ".."))
            {
                throw Error("compile.outputPathInvalid", jsonPath, "Expected a normalized output-relative path.");
            }
        }

        internal static void RejectDuplicateOutputPaths(IEnumerable<OutputPlan> plans)
        {
            var unique = new HashSet<string>(StringComparer.Ordinal);
            foreach (var plan in plans)
            {
                if (!unique.Add(plan.RelativePath))
                {
                    throw Error("compile.outputCollision", plan.RelativePath, "Multiple documents resolve to the same compiled output path.");
                }
            }
        }

        internal static void RejectOutputAlias(string path)
        {
            var fullPath = Path.GetFullPath(path);
            var current = Path.GetPathRoot(fullPath);
            foreach (var segment in fullPath.Substring(current.Length).Split(Path.DirectorySeparatorChar))
            {
                current = Path.Combine(current, segment);
                if (!File.Exists(current) && !Directory.Exists(current)) return;
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                {
                    throw Error("compile.outputAliasForbidden", path, "compileOutputRoot must not contain symlink or junction segments.");
                }
            }

            if (File.Exists(fullPath))
            {
                GetWindowsFileIdentity(fullPath, true);
            }
        }

    }
}
