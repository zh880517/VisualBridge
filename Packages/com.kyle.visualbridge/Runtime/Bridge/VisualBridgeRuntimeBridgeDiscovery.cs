using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// 一条 Runtime 实例发现记录（由 VisualBridgeRuntimeBridgeServer 写入，
    /// 由 VS Code 侧 / 测试枚举）。StaleReason 非空表示记录陈旧：
    /// 心跳（文件 mtime）超过 5 秒或发布进程已死（第 17 章双信号判定）。
    /// </summary>
    public sealed class VisualBridgeRuntimeInstance
    {
        public string InstanceId { get; internal set; }

        public string Kind { get; internal set; }

        public int ProtocolVersion { get; internal set; }

        public int CoreVersion { get; internal set; }

        public IReadOnlyList<string> Capabilities { get; internal set; }

        public int TcpPort { get; internal set; }

        public string Token { get; internal set; }

        public int Pid { get; internal set; }

        public int Generation { get; internal set; }

        public string StartedAt { get; internal set; }

        public string RecordPath { get; internal set; }

        /// <summary>陈旧原因（心跳超时 / pid 已死）；null 表示记录新鲜。</summary>
        public string StaleReason { get; internal set; }

        public bool IsStale => StaleReason != null;

        public bool Supports(string capability)
        {
            return Capabilities != null && System.Linq.Enumerable.Contains(Capabilities, capability);
        }
    }

    /// <summary>
    /// 枚举 &lt;系统临时目录&gt;/visualbridge-runtime 下的实例发现记录。
    /// 记录解析失败直接跳过并报告原因；解析成功的记录带上心跳/pid
    /// 双信号的陈旧判定结果，由调用方决定是否连接（绝不连接陈旧记录）。
    /// </summary>
    public static class VisualBridgeRuntimeBridgeDiscovery
    {
        public const string DiscoveryDirectoryName = "visualbridge-runtime";
        public static readonly TimeSpan HeartbeatTimeout = TimeSpan.FromSeconds(5);

        /// <summary>列出全部可解析的实例记录（含陈旧标记），按记录文件名排序。</summary>
        public static IReadOnlyList<VisualBridgeRuntimeInstance> EnumerateInstances(
            Action<string> skipReason = null, string directoryOverride = null)
        {
            var directory = directoryOverride ?? DefaultDirectory();
            var instances = new List<VisualBridgeRuntimeInstance>();
            if (!Directory.Exists(directory))
            {
                return instances;
            }

            foreach (var file in Directory.GetFiles(directory, "*.json").OrderBy(name => name, StringComparer.Ordinal))
            {
                VisualBridgeRuntimeInstance instance;
                try
                {
                    instance = LoadRecord(file);
                }
                catch (VisualBridgeRuntimeBridgeException exception)
                {
                    skipReason?.Invoke($"skipped '{Path.GetFileName(file)}': {exception.Code}");
                    continue;
                }

                instances.Add(instance);
            }

            return instances;
        }

        /// <summary>
        /// 加载并校验单条记录，附带心跳/pid 双信号陈旧判定
        /// （判定结果在 StaleReason 上，不抛异常）。
        /// </summary>
        public static VisualBridgeRuntimeInstance LoadRecord(string recordPath)
        {
            var instance = ParseRecord(recordPath);
            var reasons = new List<string>();

            var heartbeatAge = DateTime.UtcNow - File.GetLastWriteTimeUtc(recordPath);
            if (heartbeatAge > HeartbeatTimeout)
            {
                reasons.Add($"heartbeat is {heartbeatAge.TotalSeconds:0.0}s old");
            }

            if (!IsProcessAlive(instance.Pid))
            {
                reasons.Add($"pid {instance.Pid} is no longer running");
            }

            instance.StaleReason = reasons.Count > 0 ? string.Join("; ", reasons) : null;
            return instance;
        }

        /// <summary>
        /// 仅解析记录（不做陈旧判定）。宿主在 mid-play domain reload 后
        /// 需要读取陈旧记录里的 generation/tcpPort 做恢复。
        /// </summary>
        public static VisualBridgeRuntimeInstance ParseRecord(string recordPath)
        {
            var instance = VisualBridgeRuntimeBridgeValidator.ParseDiscoveryRecord(File.ReadAllText(recordPath));
            instance.RecordPath = Path.GetFullPath(recordPath);
            return instance;
        }

        public static string DefaultDirectory()
        {
            return Path.Combine(Path.GetTempPath(), DiscoveryDirectoryName);
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
    }
}
