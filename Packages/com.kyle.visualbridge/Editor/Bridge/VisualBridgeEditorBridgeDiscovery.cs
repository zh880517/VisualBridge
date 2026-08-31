using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 枚举本地发现目录中按窗口划分的发现记录，
    /// 过滤心跳过期或发布进程已终止的记录。
    /// </summary>
    public static class VisualBridgeEditorBridgeDiscovery
    {
        public const string DiscoveryDirectoryName = "visualbridge-bridge";
        public static readonly TimeSpan HeartbeatTimeout = TimeSpan.FromSeconds(5);

        /// <summary>
        /// 列出存活的 bridge 窗口。校验失败、心跳过期或进程已死的记录
        /// 会被跳过并逐条报告原因。
        /// </summary>
        public static IReadOnlyList<VisualBridgeBridgeWindow> EnumerateWindows(Action<string> skipReason = null, string directoryOverride = null)
        {
            var directory = directoryOverride ?? DefaultDirectory();
            var windows = new List<VisualBridgeBridgeWindow>();
            if (!Directory.Exists(directory))
            {
                return windows;
            }

            foreach (var file in Directory.GetFiles(directory, "*.json").OrderBy(name => name, StringComparer.Ordinal))
            {
                VisualBridgeBridgeWindow window;
                try
                {
                    window = LoadRecord(file);
                }
                catch (VisualBridgeIntegrationException exception)
                {
                    Report(skipReason, $"skipped '{Path.GetFileName(file)}': {exception.Code}");
                    continue;
                }

                windows.Add(window);
            }

            return windows;
        }

        /// <summary>
        /// 加载并校验单条发现记录；拒绝心跳过期与进程已死的情况。
        /// </summary>
        public static VisualBridgeBridgeWindow LoadRecord(string recordPath)
        {
            var root = VisualBridgeIntegrationProfileLoader.ReadStrictObject(recordPath, "bridge.invalidJson");
            var window = VisualBridgeEditorBridgeValidator.ValidateDiscoveryRecord(root, Path.GetFullPath(recordPath));

            var heartbeatAge = DateTime.UtcNow - File.GetLastWriteTimeUtc(recordPath);
            if (heartbeatAge > HeartbeatTimeout)
            {
                throw VisualBridgeEditorBridgeValidator.Error(
                    "bridge.staleRecord",
                    "$",
                    $"Discovery record heartbeat is {heartbeatAge.TotalSeconds:0.0}s old.");
            }

            if (!IsProcessAlive(window.Pid))
            {
                throw VisualBridgeEditorBridgeValidator.Error(
                    "bridge.staleRecord",
                    "$",
                    $"Discovery record publisher pid {window.Pid} is no longer running.");
            }

            return window;
        }

        public static string DefaultDirectory()
        {
            return Path.Combine(Path.GetTempPath(), DiscoveryDirectoryName);
        }

        /// <summary>
        /// 比较本地绝对路径与发现记录的项目根，统一分隔符；Windows 下不区分大小写。
        /// </summary>
        public static bool IsSamePath(string left, string right)
        {
            var normalizedLeft = NormalizePath(left);
            var normalizedRight = NormalizePath(right);
            var comparison = Path.DirectorySeparatorChar == '\\'
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            return string.Equals(normalizedLeft, normalizedRight, comparison);
        }

        public static string NormalizePath(string value)
        {
            var normalized = (value ?? string.Empty).Replace('\\', '/').TrimEnd('/');
            return normalized;
        }

        private static bool IsProcessAlive(int pid)
        {
            try
            {
                using (var process = Process.GetProcessById(pid))
                {
                    return !process.HasExited;
                }
            }
            catch (ArgumentException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        private static void Report(Action<string> skipReason, string message)
        {
            skipReason?.Invoke(message);
        }
    }
}
