using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Play 模式下的 Runtime Bridge 宿主（第 17.2 章生命周期语义）：
    /// 进入 Play 时创建 server（同 instanceId 复用磁盘记录时 generation 递增
    /// 并尽量重绑旧端口），退出 Play 时回收线程并删除记录；
    /// mid-play domain reload 不会重跑播放初始化，由 [InitializeOnLoad]
    /// 静态构造在 reload 后兜底：Play 中但 server 已死（statics 清空）时
    /// 重新拉起（generation 递增）。static 守卫防重复挂钩，
    /// 每次启动入口重置生命周期标志（spike 实测教训）。
    /// </summary>
    [InitializeOnLoad]
    public static class VisualBridgeRuntimeBridgeHost
    {
        private static readonly object Gate = new object();

        private static bool lifecycleHooked;
        private static bool shuttingDown;

        static VisualBridgeRuntimeBridgeHost()
        {
            lock (Gate)
            {
                if (lifecycleHooked)
                {
                    return;
                }

                lifecycleHooked = true;
            }

            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;

            // mid-play domain reload 兜底：reload 后 statics 清空、监听线程全灭，
            // 静态构造重新执行——若仍在 Play 模式则重新拉起 server。
            if (EditorApplication.isPlaying)
            {
                EnsureServerRunning("domain reload recovery");
            }
        }

        /// <summary>当前 Play 会话的 Runtime Bridge server；未运行时为 null。</summary>
        public static VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer CurrentServer { get; private set; }

        public static bool IsServerRunning => CurrentServer != null;

        public static string InstanceId => "editor-" + Process.GetCurrentProcess().Id;

        public static string ArtifactsRoot()
        {
            return Path.Combine(
                VisualBridgeEditorBridgeService.UnityProjectRoot(), "Library", "VisualBridge", "Compiled");
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange change)
        {
            switch (change)
            {
                case PlayModeStateChange.EnteredPlayMode:
                    EnsureServerRunning("entered play mode");
                    break;
                case PlayModeStateChange.ExitingPlayMode:
                    StopServer("exiting play mode");
                    break;
            }
        }

        /// <summary>
        /// 启动（或确认已启动）Play 会话 server。磁盘记录存在且 pid 匹配时
        /// generation 递增并优先重绑旧端口（重绑失败回退随机端口，
        /// 记录写入实际端口）；否则 generation=1。
        /// </summary>
        public static VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer EnsureServerRunning(string reason)
        {
            lock (Gate)
            {
                if (CurrentServer != null)
                {
                    return CurrentServer;
                }

                // 每次启动入口重置生命周期标志（禁 Domain Reload 场景实测教训：
                // 否则心跳/accept 线程立即退出、记录泄漏）。
                shuttingDown = false;

                var instanceId = InstanceId;
                var generation = 1;
                var preferredPort = 0;
                var previous = ReadPreviousRecord(instanceId);
                if (previous != null)
                {
                    generation = previous.Generation + 1;
                    preferredPort = previous.TcpPort;
                    UnityEngine.Debug.Log($"[runtime-bridge] reusing record generation {previous.Generation} -> {generation} (preferred port {preferredPort}).");
                }

                var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    instanceId,
                    "editor-play",
                    preferredPort,
                    GenerateToken(),
                    ArtifactsRoot(),
                    generation,
                    message => UnityEngine.Debug.Log($"[runtime-bridge] {message}"));
                if (shuttingDown)
                {
                    server.Dispose();
                    return null;
                }

                CurrentServer = server;
                UnityEngine.Debug.Log($"[runtime-bridge] started ({reason}): instanceId={instanceId} port={server.TcpPort} generation={generation} record={server.RecordPath}");
                return server;
            }
        }

        /// <summary>停止 server：回收监听/心跳/轮询线程并删除发现记录。</summary>
        public static void StopServer(string reason)
        {
            lock (Gate)
            {
                shuttingDown = true;
                var server = CurrentServer;
                if (server == null)
                {
                    return;
                }

                CurrentServer = null;
                server.Dispose();
                UnityEngine.Debug.Log($"[runtime-bridge] stopped ({reason}); record deleted.");
            }
        }

        [MenuItem("Tools/VisualBridge/Runtime Bridge/Start in Play Mode")]
        private static void StartInPlayModeFromMenu()
        {
            if (EditorApplication.isPlaying)
            {
                EnsureServerRunning("menu");
                return;
            }

            EditorUtility.DisplayDialog(
                "VisualBridge Runtime Bridge",
                "Runtime Bridge 在进入 Play 模式后自动启动。请点击 Play 按钮；状态可用菜单 Tools/VisualBridge/Runtime Bridge/Status 查看。",
                "OK");
        }

        [MenuItem("Tools/VisualBridge/Runtime Bridge/Status")]
        private static void StatusFromMenu()
        {
            var server = CurrentServer;
            if (server == null)
            {
                UnityEngine.Debug.Log($"[runtime-bridge] not running (isPlaying={EditorApplication.isPlaying}). It starts automatically when entering Play mode.");
                return;
            }

            UnityEngine.Debug.Log($"[runtime-bridge] running: instanceId={server.InstanceId} kind={server.Kind} port={server.TcpPort} generation={server.Generation} record={server.RecordPath} artifactsRoot={server.ArtifactsRoot}");
        }

        /// <summary>读取同 instanceId 的旧磁盘记录（不做陈旧判定；mid-play reload 后记录可能心跳冻结）。</summary>
        private static VisualBridge.Runtime.VisualBridgeRuntimeInstance ReadPreviousRecord(string instanceId)
        {
            try
            {
                var recordPath = Path.Combine(
                    VisualBridge.Runtime.VisualBridgeRuntimeBridgeDiscovery.DefaultDirectory(), instanceId + ".json");
                if (!File.Exists(recordPath))
                {
                    return null;
                }

                var record = VisualBridge.Runtime.VisualBridgeRuntimeBridgeDiscovery.ParseRecord(recordPath);
                // 只信任本进程写入的记录：pid 不匹配视为陈旧会话。
                return record.Pid == Process.GetCurrentProcess().Id ? record : null;
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.Log($"[runtime-bridge] failed to read previous record, starting generation 1: {exception.Message}");
                return null;
            }
        }

        /// <summary>生成 ≥192 位十六进制 token（24 字节 → 48 hex 字符）。</summary>
        private static string GenerateToken()
        {
            var bytes = new byte[24];
            using (var generator = RandomNumberGenerator.Create())
            {
                generator.GetBytes(bytes);
            }

            var builder = new System.Text.StringBuilder(bytes.Length * 2);
            foreach (var value in bytes)
            {
                builder.Append(value.ToString("x2"));
            }

            return builder.ToString();
        }
    }
}
