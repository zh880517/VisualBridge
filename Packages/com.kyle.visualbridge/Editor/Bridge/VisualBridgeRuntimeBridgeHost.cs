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

        /// <summary>
        /// 端口段覆盖（跨 Domain Reload 保存在 SessionState）：只有 E2E 编排会设置它，
        /// 让 Play 模式 server 按 Player 的端口段规则监听，从而覆盖"Unity 监听端口段"这条路径。
        /// 生产路径不设置，走记录里的旧端口 / 随机端口。
        /// </summary>
        private const string PortRangeKey = "VisualBridge.RuntimeBridgeHost.PortRange";

        private static bool lifecycleHooked;
        private static bool shuttingDown;
        private static VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport debugTransport;
        /// <summary>
        /// 保护 <see cref="debugTransport"/> 的「身份比较 + Detach」/安装/卸载不被打断（E10 的 TOCTOU）：
        /// server 重启与旧连接迟到的 <c>Closed</c> 交错时，不能拿旧 transport 去 Detach 新会话。
        /// 与 <see cref="Gate"/> 无关（那把锁保护生命周期），锁序恒为 debugTransportGate → 会话 Gate。
        /// </summary>
        private static readonly object debugTransportGate = new object();

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

        /// <summary>
        /// 配置端口段（仅 E2E 编排使用）：server 在区间内取第一个可用端口监听。
        /// 写 SessionState 是因为设置发生在进入 Play 触发的 Domain Reload 之前。
        /// </summary>
        public static void ConfigurePortRange(int start, int end)
        {
            if (start <= 0 || end < start)
            {
                SessionState.EraseString(PortRangeKey);
                return;
            }

            SessionState.SetString(PortRangeKey, start.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + "-" + end.ToString(System.Globalization.CultureInfo.InvariantCulture));
            UnityEngine.Debug.Log($"[runtime-bridge] port range override {start}-{end} (Player-style listener).");
        }

        private static void ResolvePortRange(out int start, out int end)
        {
            start = 0;
            end = 0;
            var text = SessionState.GetString(PortRangeKey, string.Empty);
            var separator = text.IndexOf('-');
            if (separator <= 0)
            {
                return;
            }

            if (int.TryParse(text.Substring(0, separator), out var parsedStart)
                && int.TryParse(text.Substring(separator + 1), out var parsedEnd)
                && parsedStart > 0 && parsedEnd >= parsedStart)
            {
                start = parsedStart;
                end = parsedEnd;
            }
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

                ResolvePortRange(out var portRangeStart, out var portRangeEnd);
                var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    instanceId,
                    "editor-play",
                    preferredPort,
                    GenerateToken(),
                    ArtifactsRoot(),
                    generation,
                    message => UnityEngine.Debug.Log(message),
                    contractHash: VisualBridgeDebugContractFingerprint.Read(VisualBridgeEditorBridgeService.UnityProjectRoot()),
                    portRangeStart: portRangeStart,
                    portRangeEnd: portRangeEnd);
                if (shuttingDown)
                {
                    server.Dispose();
                    return null;
                }

                CurrentServer = server;
                InstallDebugTransport(server);
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
                RemoveDebugTransport();
                if (server == null)
                {
                    return;
                }

                CurrentServer = null;
                server.Dispose();
                UnityEngine.Debug.Log($"[runtime-bridge] stopped ({reason}); record deleted.");
            }
        }

        /// <summary>
        /// 注入调试传输实现（附录 A.9）：每个 Play 会话一个传输实例，握手完成的连接经
        /// <see cref="VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer.DebugLinkOpened"/> 绑定上来。
        /// 绑定后必须显式 <c>Attach</c>（A.5：连接建立后立即 flush 当前帧与待发描述）。
        /// 连接关闭走 <see cref="OnDebugLinkClosed"/>：只有传输层再没有存活连接时才 <c>Detach</c>
        /// （按断连语义重置会话）；若还有被压栈的存活连接（MCP/临时连接退出），会话保持挂接，
        /// 传输层弹回的那条连接继续收帧——否则面板会「TCP 还连着却一个帧都收不到」。
        /// 载荷格式固定 JSON：契约指纹为空时协商结果必然是 <c>["json"]</c>（E2 的降级规则），
        /// 二进制协商留给 E5 统一 welcome 字段后再切换。
        /// </summary>
        internal static void InstallDebugTransport(VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer server)
        {
            InstallDebugTransport(server, null);
        }

        /// <summary>
        /// 同上，另带一个 <paramref name="installWindowProbe"/> 探针；只有 EditMode 用例调用它。
        /// </summary>
        /// <param name="installWindowProbe">
        /// **仅 EditMode 用例使用**（生产传 null）：在"<c>DebugLinkOpened</c> 已注册、会话尚未 Install"
        /// 时立即回调，**只用于观察字段是否已发布**。位置必须卡在注册之后、Install 之前：HEAD 的回归顺序是
        /// 注册 → Install → 发布，探针若放在 Install 之后就会读到一个已经发布的字段、用例恒真
        /// （F9 评审 P0）。探针不得替生产调用 Install——那样用例就失去"生产路径真的装了会话"的判别力。
        /// </param>
        internal static void InstallDebugTransport(VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer server,
            Action<VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport> installWindowProbe)
        {
            RemoveDebugTransport();
            var transport = new VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport(
                VisualBridge.Diagnostics.ConnectType.EditorPlayer,
                log: message => UnityEngine.Debug.Log(message));
            VisualBridge.Diagnostics.VisualBridgeDebug.SetEncoder(new VisualBridge.Diagnostics.VisualBridgeDebugJsonEncoder());
            // 先发布字段、再注册 DebugLinkOpened（F9 §2）：注册之后随时可能有一条连接"开→关"，
            // 而 OnDebugLinkClosed 的身份校验以"字段已发布"为前提。发布晚于注册时，窗口内的关闭会读到
            // null ⇒ 当成陈旧传输忽略 ⇒ 会话停在 attached 且没有存活连接（旧实现无条件 Detach，没有这个窗口）。
            lock (debugTransportGate)
            {
                debugTransport = transport;
            }

            server.DebugLinkOpened += link =>
            {
                transport.Bind(new VisualBridge.Diagnostics.Bridge.VisualBridgeRuntimeDebugWire(link));
                // 观察点（E10）：日志里能看到"两条连接叠起来"，E2E 用它做因果正控；生产排障同样需要。
                UnityEngine.Debug.Log("[runtime-bridge] debug link stacked (generation="
                    + transport.ConnectionGeneration + ")");
                VisualBridge.Diagnostics.Bridge.VisualBridgeDebugBridge.Attach();
                link.Closed += () => OnDebugLinkClosed(transport);
            };
            // 探针位置 = 注册之后、Install 之前（F9 §2 的判别点）：HEAD 顺序（注册 → Install → 发布）
            // 在这里读到的字段是 null；发布前移之后才不是。探针只观察，不替生产 Install。
            installWindowProbe?.Invoke(transport);
            VisualBridge.Diagnostics.Bridge.VisualBridgeDebugBridge.Install(transport);
        }

        /// <summary>当前装配的传输实例；供 EditMode 用例观察/驱动真实装配路径（不参与生产逻辑）。</summary>
        internal static VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport InstalledDebugTransport
        {
            get
            {
                lock (debugTransportGate)
                {
                    return debugTransport;
                }
            }
        }

        /// <summary>
        /// 一条 debug 连接关闭（E10）：传输层还有存活连接时**不能** Detach。
        /// 时序：<see cref="VisualBridge.Diagnostics.Bridge.VisualBridgeRuntimeDebugWire"/> 构造时先订阅
        /// <c>link.Closed</c>，本处理器后订阅，所以进入这里时传输层的出栈/恢复已经完成；
        /// <c>IsConnected</c> 从 F9 起看的是"栈内任一绑定仍 <c>IsOpen</c>"，因此弹回窗口
        /// （活动 wire 的 <c>IsOpen</c> 已 false、<c>Closed</c> 还没到）里只要被压栈的连接还开着，
        /// 本处理器就不会把面板的会话 Detach 掉；整栈为空时它仍是 false ⇒ 照常 Detach（A.9）。
        /// 「是不是当前安装的 transport」与「Detach」必须在同一把锁内完成（TOCTOU）：否则
        /// Remove/Install 落在比较与 Detach 之间，就会拿旧连接把**新**会话 Detach 掉。
        /// 锁序固定为 debugTransportGate → 会话 Gate（Detach 内部只取会话 Gate；会话侧不会回调宿主），
        /// 且安装/卸载在锁外调用 debug bridge，因此不会反向持锁。
        /// </summary>
        internal static void OnDebugLinkClosed(VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport transport)
        {
            lock (debugTransportGate)
            {
                if (!ReferenceEquals(transport, debugTransport))
                {
                    UnityEngine.Debug.Log("[runtime-bridge] debug link closed (stale transport: ignored)");
                    return;
                }

                if (transport.IsConnected)
                {
                    // 被压栈的连接出栈后回到仍存活的那条：会话保持挂接（E10 的核心不变量）。
                    UnityEngine.Debug.Log("[runtime-bridge] debug link closed (session kept: another link is live)");
                    return;
                }

                UnityEngine.Debug.Log("[runtime-bridge] debug link closed (session detached: no live link left)");
                VisualBridge.Diagnostics.Bridge.VisualBridgeDebugBridge.Detach();
            }
        }

        /// <summary>
        /// 卸载当前传输：先把字段置空、<c>Uninstall</c>（按断连语义清会话），再 <c>Dispose</c> 传输层。
        /// 注意 <see cref="VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport.Dispose"/> → <c>Unbind</c>
        /// **只退订**各条 wire（<see cref="VisualBridge.Diagnostics.Bridge.VisualBridgeRuntimeDebugWire.Dispose"/>
        /// 里也是 <c>-=</c>），**不触发** <c>link.Closed</c>，因此不会回调
        /// <see cref="OnDebugLinkClosed"/>；卸载路径不靠"关闭事件"结算，也不会在这里发生重入 Detach。
        /// （F9 §4 明确这一点：不要按"Dispose 会触发 Closed"去推断生命周期。）
        /// </summary>
        internal static void RemoveDebugTransport()
        {
            VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport transport;
            lock (debugTransportGate)
            {
                transport = debugTransport;
                debugTransport = null;
            }

            if (transport == null)
            {
                return;
            }

            VisualBridge.Diagnostics.Bridge.VisualBridgeDebugBridge.Uninstall();
            transport.Dispose();
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
