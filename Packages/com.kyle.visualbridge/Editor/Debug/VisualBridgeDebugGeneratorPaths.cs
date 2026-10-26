using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace VisualBridge.Editor
{
    /// <summary>路径解析与 asmdef 覆盖判定（附录 B.5 的 VBDBG011）。</summary>
    internal static class VisualBridgeDebugGeneratorPaths
    {
        internal static readonly StringComparer FilePathComparer = Path.DirectorySeparatorChar == '\\'
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;

        private static readonly StringComparison FilePathComparison = Path.DirectorySeparatorChar == '\\'
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        public static StringComparison FilePathComparisonValue => FilePathComparison;

        /// <summary>把项目相对或绝对路径解析为「项目相对、'/' 分隔」的规范化形式；越界时用调用方给的错误码失败。</summary>
        public static string NormalizeProjectRelative(string projectRoot, string path, string code)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new VisualBridgeDebugGeneratorException(code, "路径不能为空。");
            }

            string full;
            try
            {
                full = Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(projectRoot, path));
            }
            catch (Exception exception) when (exception is ArgumentException || exception is NotSupportedException || exception is PathTooLongException)
            {
                throw new VisualBridgeDebugGeneratorException(code, "路径不是合法的相对路径：" + path);
            }

            string relative;
            if (!TryGetProjectRelative(projectRoot, full, out relative))
            {
                throw new VisualBridgeDebugGeneratorException(
                    code,
                    "路径必须位于 Unity 工程根内：" + path + "（工程根 " + projectRoot + "）");
            }

            if (relative.Length == 0)
            {
                // "." / 工程根本身会产出以 "/" 开头的相对路径，拼接后可能写到工程外（评审 P2-8）。
                throw new VisualBridgeDebugGeneratorException(
                    code,
                    "路径必须是工程根下的子目录（不能是工程根或 \".\"）：" + path);
            }

            return relative;
        }

        public static bool TryGetProjectRelative(string projectRoot, string fullPath, out string relative)
        {
            var root = EnsureTrailingSeparator(Path.GetFullPath(projectRoot));
            var full = Path.GetFullPath(fullPath);
            if (string.Equals(full, root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), FilePathComparison))
            {
                relative = string.Empty;
                return true;
            }

            if (!full.StartsWith(root, FilePathComparison))
            {
                relative = null;
                return false;
            }

            relative = full.Substring(root.Length).Replace('\\', '/');
            return true;
        }

        public static string ToFullPath(string projectRoot, string projectRelative)
        {
            if (string.IsNullOrEmpty(projectRelative) || Path.IsPathRooted(projectRelative))
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.outputPathEscape",
                    "产物相对路径非法（空或绝对路径）：" + (projectRelative ?? "<null>"));
            }

            var full = Path.GetFullPath(Path.Combine(
                projectRoot,
                projectRelative.Replace('/', Path.DirectorySeparatorChar)));
            string relative;
            if (!TryGetProjectRelative(projectRoot, full, out relative) || string.IsNullOrEmpty(relative))
            {
                throw new VisualBridgeDebugGeneratorException(
                    "debug.outputPathEscape",
                    "产物路径越出工程根：" + projectRelative);
            }

            return full;
        }

        public static string EnsureTrailingSeparator(string path)
        {
            return path.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? path
                : path + Path.DirectorySeparatorChar;
        }

        public static bool IsUnderAssets(string projectRelative)
        {
            return projectRelative.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase)
                || string.Equals(projectRelative, "Assets", StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>
    /// 生成目录必须已被 asmdef 覆盖（附录 B.5）。预定义程序集放行：Assets 下的目录永远可用
    /// （Assembly-CSharp / Assembly-CSharp-Editor），其余位置要求自身或某个祖先目录含 *.asmdef。
    /// </summary>
    internal static class VisualBridgeDebugAssemblyCoverage
    {
        public static void RequireCovered(string projectRoot, string directoryFullPath, string display)
        {
            string relative;
            if (!VisualBridgeDebugGeneratorPaths.TryGetProjectRelative(projectRoot, directoryFullPath, out relative))
            {
                throw new VisualBridgeDebugGeneratorException(
                    "VBDBG011",
                    display + " 不在 Unity 工程根内，未被任何 asmdef 覆盖：" + directoryFullPath);
            }

            if (VisualBridgeDebugGeneratorPaths.IsUnderAssets(relative))
            {
                // 预定义程序集（Assembly-CSharp / Assembly-CSharp-Editor）总是存在，附录 B.5 明确放行。
                return;
            }

            if (HasAsmdefAncestor(projectRoot, directoryFullPath))
            {
                return;
            }

            throw new VisualBridgeDebugGeneratorException(
                "VBDBG011",
                display + " 未被 asmdef 覆盖（自身或祖先目录需要 *.asmdef，Assets 下的预定义程序集除外）：" + relative);
        }

        private static bool HasAsmdefAncestor(string projectRoot, string directoryFullPath)
        {
            var root = Path.GetFullPath(projectRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var current = Path.GetFullPath(directoryFullPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            while (true)
            {
                if (Directory.Exists(current)
                    && Directory.EnumerateFiles(current, "*.asmdef", SearchOption.TopDirectoryOnly).Any())
                {
                    return true;
                }

                if (string.Equals(current, root, VisualBridgeDebugGeneratorPaths.FilePathComparisonValue))
                {
                    return false;
                }

                var parent = Path.GetDirectoryName(current);
                if (string.IsNullOrEmpty(parent))
                {
                    return false;
                }

                if (!VisualBridgeDebugGeneratorPaths.TryGetProjectRelative(projectRoot, parent, out _))
                {
                    return false;
                }

                current = parent;
            }
        }
    }
}
