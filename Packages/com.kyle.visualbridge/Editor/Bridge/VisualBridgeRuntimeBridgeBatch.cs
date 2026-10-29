using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using VisualBridge.Runtime;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Runtime Bridge Play 模式 E2E 的 batch 入口（供 -executeMethod）。
    /// 通过 SessionState 跨进入 Play 触发的 domain reload 保存编排状态：
    /// 进入 Play → host 启动 server → 内联简客户端连接自身完成
    /// hello/welcome/getSnapshot 往返 → 写结构化结果文件后退出。
    /// 事件链路（artifactsChanged）由 EditMode 测试覆盖：编译产物在
    /// Play 会话中不变，E2E 内改产物目录不可行。托管模式（RunHostedPlayMode）
    /// 另挂一个 Play 模式执行模拟器：持续上报编译图的节点/边执行事件，
    /// 供 VS Code 侧 Graph 页面执行调试 E2E（VB-UX-16）消费。
    /// </summary>
    // InitializeOnLoad 让静态构造在每次 domain reload 后执行，
    // 否则 Step/HostedStep 在进入 Play 的 reload 后不会重新挂接。
    [InitializeOnLoad]
    public static class VisualBridgeRuntimeBridgeBatch
    {
        public const int SuccessExitCode = 0;
        public const int FailureExitCode = 1;

        private const int TotalTimeoutMs = 10_000;
        private const int ReadTimeoutMs = 5_000;

        private const string ActiveKey = "VisualBridge.RuntimeBridgeE2E.Active";
        private const string ResultPathKey = "VisualBridge.RuntimeBridgeE2E.ResultPath";
        private const string DeadlineKey = "VisualBridge.RuntimeBridgeE2E.DeadlineTicks";
        private const string AttemptedKey = "VisualBridge.RuntimeBridgeE2E.Attempted";

        private const string HostedActiveKey = "VisualBridge.RuntimeBridgeHostedE2E.Active";
        private const string HostedQuitPathKey = "VisualBridge.RuntimeBridgeHostedE2E.QuitPath";
        private const string HostedControlPathKey = "VisualBridge.RuntimeBridgeHostedE2E.ControlPath";
        private const string HostedControlConsumedKey = "VisualBridge.RuntimeBridgeHostedE2E.ControlConsumed";
        private const string HostedDeadlineKey = "VisualBridge.RuntimeBridgeHostedE2E.DeadlineTicks";
        private const string HostedStoppingKey = "VisualBridge.RuntimeBridgeHostedE2E.Stopping";

        // Play 模式执行模拟器（VB-UX-16 E2E）：从编译产物取真实图身份与节点 ID，
        // 周期上报节点/边事件直到退出信号；实例保持存活供切换订阅测试。
        private const string HostedSimStartedKey = "VisualBridge.RuntimeBridgeHostedE2E.SimStarted";
        private const string HostedSimExecutionIdKey = "VisualBridge.RuntimeBridgeHostedE2E.SimExecutionId";
        private const string HostedSimNodeIdsKey = "VisualBridge.RuntimeBridgeHostedE2E.SimNodeIds";
        private const string HostedSimCursorKey = "VisualBridge.RuntimeBridgeHostedE2E.SimCursor";
        private const string HostedSimFrameKey = "VisualBridge.RuntimeBridgeHostedE2E.SimFrame";
        private const string HostedSimNextTickKey = "VisualBridge.RuntimeBridgeHostedE2E.SimNextTick";
        private const int HostedSimTickMs = 300;

        static VisualBridgeRuntimeBridgeBatch()
        {
            // domain reload 后重新挂接 update 回调（statics 已被清空）。
            if (SessionState.GetBool(ActiveKey, false))
            {
                EditorApplication.update += Step;
            }

            if (SessionState.GetBool(HostedActiveKey, false))
            {
                EditorApplication.update += HostedStep;
            }
        }

        [MenuItem("Tools/VisualBridge/Runtime Bridge/Run Play Mode E2E (batch)")]
        private static void RunFromMenu()
        {
            UnityEngine.Debug.LogWarning("[runtime-bridge] RunPlayModeE2E 是 batchmode -executeMethod 入口，会在完成后退出 Unity Editor。请通过自动化编排调用。");
        }

        /// <summary>
        /// E2E 主入口。必需环境变量 VISUALBRIDGE_RUNTIME_E2E_RESULT（结果文件路径）；
        /// 结果首行 snapshot=ok 或 snapshot=&lt;错误码&gt;。
        /// </summary>
        public static void RunPlayModeE2E()
        {
            var resultPath = Environment.GetEnvironmentVariable("VISUALBRIDGE_RUNTIME_E2E_RESULT");
            if (string.IsNullOrEmpty(resultPath))
            {
                UnityEngine.Debug.LogError("[runtime-bridge] VISUALBRIDGE_RUNTIME_E2E_RESULT is required for the runtime bridge E2E run.");
                EditorApplication.Exit(FailureExitCode);
                return;
            }

            SessionState.SetBool(ActiveKey, true);
            SessionState.SetString(ResultPathKey, resultPath);
            SessionState.SetString(DeadlineKey, DateTime.UtcNow.AddMilliseconds(TotalTimeoutMs).Ticks.ToString());
            SessionState.SetBool(AttemptedKey, false);
            EditorApplication.update += Step;
            EditorApplication.isPlaying = true;
        }

        /// <summary>
        /// 托管 E2E 入口：进入 Play 并保持 server 存活，直到 VISUALBRIDGE_RUNTIME_E2E_QUIT
        /// 指向的信号文件出现（外部编排方完成 VS Code 侧链路后写入）或超时。供
        /// npm run test:runtime-e2e 编排使用；结果为进程退出码。
        /// </summary>
        public static void RunHostedPlayMode()
        {
            var quitPath = Environment.GetEnvironmentVariable("VISUALBRIDGE_RUNTIME_E2E_QUIT");
            if (string.IsNullOrEmpty(quitPath))
            {
                UnityEngine.Debug.LogError("[runtime-bridge] VISUALBRIDGE_RUNTIME_E2E_QUIT is required for the hosted runtime bridge E2E run.");
                EditorApplication.Exit(FailureExitCode);
                return;
            }

            SessionState.SetBool(HostedActiveKey, true);
            SessionState.SetString(HostedQuitPathKey, quitPath);
            var controlPath = Environment.GetEnvironmentVariable("VISUALBRIDGE_RUNTIME_E2E_CONTROL");
            if (!string.IsNullOrEmpty(controlPath))
            {
                SessionState.SetString(HostedControlPathKey, controlPath);
                SessionState.SetInt(HostedControlConsumedKey, 0);
            }

            SessionState.SetString(HostedDeadlineKey, DateTime.UtcNow.AddMilliseconds(120_000).Ticks.ToString());
            ConfigurePortRangeFromEnvironment();
            EditorApplication.update += HostedStep;
            EditorApplication.isPlaying = true;
        }

        /// <summary>
        /// E2E 可让 Play 模式 server 按 Player 的端口段规则监听
        /// （VISUALBRIDGE_RUNTIME_E2E_PORT_RANGE="28300-28349"），
        /// 供 VS Code 侧验证端口段探测；未设置时保持记录/随机端口。
        /// </summary>
        private static void ConfigurePortRangeFromEnvironment()
        {
            var text = Environment.GetEnvironmentVariable("VISUALBRIDGE_RUNTIME_E2E_PORT_RANGE");
            if (string.IsNullOrEmpty(text))
            {
                return;
            }

            var separator = text.IndexOf('-');
            if (separator <= 0
                || !int.TryParse(text.Substring(0, separator), out var start)
                || !int.TryParse(text.Substring(separator + 1), out var end))
            {
                UnityEngine.Debug.LogError("[runtime-bridge] VISUALBRIDGE_RUNTIME_E2E_PORT_RANGE must look like '28300-28349'.");
                return;
            }

            VisualBridgeRuntimeBridgeHost.ConfigurePortRange(start, end);
        }

        private static void HostedStep()
        {
            if (!SessionState.GetBool(HostedActiveKey, false))
            {
                EditorApplication.update -= HostedStep;
                return;
            }

            var deadlineTicks = SessionState.GetString(HostedDeadlineKey, "0");
            if (long.TryParse(deadlineTicks, out var ticks) && DateTime.UtcNow.Ticks > ticks)
            {
                SessionState.SetBool(HostedActiveKey, false);
                EditorApplication.update -= HostedStep;
                VisualBridgeRuntimeBridgeHost.StopServer("hosted e2e timed out");
                UnityEngine.Debug.LogError("[runtime-bridge] hosted play mode E2E timed out.");
                EditorApplication.Exit(FailureExitCode);
                return;
            }

            var quitPath = SessionState.GetString(HostedQuitPathKey, null);
            if (!string.IsNullOrEmpty(quitPath) && File.Exists(quitPath))
            {
                if (!SessionState.GetBool(HostedStoppingKey, false))
                {
                    // GUI Editor 在 Play 模式中直接 Exit 可能被挂起：先退出 Play，
                    // 等.isPlaying 翻转后再 StopServer 并退出进程。
                    SessionState.SetBool(HostedStoppingKey, true);
                    EditorApplication.isPlaying = false;
                    return;
                }

                if (EditorApplication.isPlaying)
                {
                    return;
                }

                SessionState.SetBool(HostedActiveKey, false);
                SessionState.SetBool(HostedStoppingKey, false);
                EditorApplication.update -= HostedStep;
                VisualBridgeRuntimeBridgeHost.StopServer("hosted e2e finished");
                UnityEngine.Debug.Log("[runtime-bridge] hosted play mode E2E finished.");
                EditorApplication.Exit(SuccessExitCode);
                return;
            }

            if (EditorApplication.isPlaying)
            {
                StepControlFile();
                StepExecutionSimulator();
                StepDebugChannelSimulator();
            }
        }

        /// <summary>
        /// 托管 E2E 的控制文件（仅 batchmode 托管运行使用）：测试进程追加一行命令，本进程执行后把结果
        /// 追加到 <c>&lt;control&gt;.result</c>。目前只有 <c>create &lt;instanceId&gt;</c>：
        /// E10 需要"临时连接关闭之后让探针**新建**一个实例"，用来断言会话仍可写（Detach 时 Create 会被挡）。
        /// 用文件而不是新协议：E2E 编排进程与 Unity 之间没有其它命令通道，且此入口不进入生产路径。
        /// </summary>
        private static void StepControlFile()
        {
            var controlPath = SessionState.GetString(HostedControlPathKey, null);
            if (string.IsNullOrEmpty(controlPath) || !File.Exists(controlPath))
            {
                return;
            }

            string[] lines;
            try
            {
                lines = File.ReadAllLines(controlPath);
            }
            catch (IOException)
            {
                // 测试进程正在写：下一帧再读。
                return;
            }

            var consumed = SessionState.GetInt(HostedControlConsumedKey, 0);
            if (lines.Length <= consumed)
            {
                return;
            }

            for (var index = consumed; index < lines.Length; index++)
            {
                var line = lines[index].Trim();
                if (line.Length == 0)
                {
                    continue;
                }

                var space = line.IndexOf(' ');
                var command = space < 0 ? line : line.Substring(0, space);
                var argument = space < 0 ? string.Empty : line.Substring(space + 1).Trim();
                if (!string.Equals(command, "create", StringComparison.Ordinal) || argument.Length == 0)
                {
                    AppendControlResult(controlPath, "error unknown-command " + line);
                    continue;
                }

                var created = VisualBridge.Diagnostics.VisualBridgeDebug.Create(
                    argument, DebugSimCategory, "E9RuntimeProbe", "E10 临时连接关闭后的新实例");
                var generation = VisualBridgeRuntimeBridgeHost.InstalledDebugTransport?.ConnectionGeneration ?? -1;
                AppendControlResult(controlPath, "create " + argument + " ok=" + created + " generation=" + generation);
            }

            SessionState.SetInt(HostedControlConsumedKey, lines.Length);
        }

        private static void AppendControlResult(string controlPath, string line)
        {
            try
            {
                File.AppendAllText(controlPath + ".result", line + "\n");
            }
            catch (IOException exception)
            {
                UnityEngine.Debug.LogWarning("[runtime-bridge] control result append failed: " + exception.Message);
            }
        }

        // ---- E9 调试通道 E2E：真实的 ch1 调试帧 + 真实查询往返 ----
        // 走生产入口 `VisualBridge.Diagnostics.VisualBridgeDebug`（Play 模式由
        // `VisualBridgeRuntimeBridgeHost.InstallDebugTransport` 注入 transport），
        // 因此 E2E 验证的是线上路径，不是测试专线的假数据。
        private const string DebugSimCategory = "e9-channel";
        private const string DebugSimInterface = "IE9SampleQuery";
        private const string DebugSimInstance = "e9-debug-instance";
        private const string DebugSimMethod = "Echo";
        private const ushort DebugSimEventMethodId = 20;
        private const ushort DebugSimQueryMethodId = 10;
        private const string DebugSimNextTickKey = "VisualBridge.RuntimeBridgeHostedE2E.DebugNextTick";
        private const string DebugSimFrameKey = "VisualBridge.RuntimeBridgeHostedE2E.DebugFrame";
        private const string DebugSimCreatedKey = "VisualBridge.RuntimeBridgeHostedE2E.DebugCreated";
        private const string DebugSimConnectedKey = "VisualBridge.RuntimeBridgeHostedE2E.DebugConnected";
        private const string DebugSimSentKey = "VisualBridge.RuntimeBridgeHostedE2E.DebugSent";
        private const string DebugSimFailedKey = "VisualBridge.RuntimeBridgeHostedE2E.DebugFailed";
        private const int DebugSimTickMs = 300;

        /// <summary>
        /// 每个 tick：连接建立后 Create 实例、幂等注册查询处理器，然后按 300ms 发一条事件。
        /// 诊断计数（sent/failed/connected）写进 Unity 日志，E2E 失败时能区分"Unity 没发"
        /// 与"VS Code 没收/没录"。
        /// </summary>
        private static void StepDebugChannelSimulator()
        {
            if (VisualBridgeRuntimeBridgeHost.CurrentServer == null)
            {
                return;
            }

            var connected = VisualBridge.Diagnostics.VisualBridgeDebug.isConnected;
            if (connected != SessionState.GetBool(DebugSimConnectedKey, false))
            {
                SessionState.SetBool(DebugSimConnectedKey, connected);
                UnityEngine.Debug.Log($"[runtime-bridge] debug channel connected={connected}");
            }

            if (!connected)
            {
                // 断连会重置实例集合与待发队列（Detach 语义）：下次连上要重新 Create。
                SessionState.SetBool(DebugSimCreatedKey, false);
                return;
            }

            // Create 是幂等的；成功后不再每帧调用（重复 Create 会刷警告）。
            if (!SessionState.GetBool(DebugSimCreatedKey, false))
            {
                if (VisualBridge.Diagnostics.VisualBridgeDebug.Create(
                    DebugSimInstance, DebugSimCategory, "E9RuntimeProbe", "E9 调试通道运行时探针"))
                {
                    SessionState.SetBool(DebugSimCreatedKey, true);
                    UnityEngine.Debug.Log("[runtime-bridge] debug instance created: " + DebugSimInstance);
                }
            }

            // 查询处理器每 tick 重注册（幂等）：domain reload 会清掉静态注册表。
            VisualBridge.Diagnostics.VisualBridgeDebug.RegisterRequestHandler(
                DebugSimCategory, DebugSimInterface,
                (VisualBridge.Diagnostics.VisualBridgeDebugRequestDispatcher)((methodId, instanceId, instanceSlot, requestSeq, parameters) =>
                {
                    if (methodId != DebugSimQueryMethodId)
                    {
                        return false;
                    }

                    var request = new VisualBridge.Diagnostics.VisualBridgeDebugRequest(
                        instanceId, instanceSlot, methodId, requestSeq,
                        DebugSimCategory, DebugSimInterface, DebugSimMethod);
                    if (!VisualBridge.Diagnostics.VisualBridgeDebug.StartResult(request))
                    {
                        UnityEngine.Debug.LogWarning("[runtime-bridge] debug query result could not start.");
                        return false;
                    }

                    VisualBridge.Diagnostics.VisualBridgeDebug.PushParam("value", 1, "e9-query-ok");
                    var ended = VisualBridge.Diagnostics.VisualBridgeDebug.End();
                    UnityEngine.Debug.Log($"[runtime-bridge] debug query handled methodId={methodId} instance={instanceId} ended={ended}");
                    return ended;
                }));

            var nextTickTicks = SessionState.GetString(DebugSimNextTickKey, "0");
            if (!long.TryParse(nextTickTicks, out var nextTick) || DateTime.UtcNow.Ticks < nextTick)
            {
                return;
            }

            SessionState.SetString(DebugSimNextTickKey, DateTime.UtcNow.AddMilliseconds(DebugSimTickMs).Ticks.ToString());
            var frame = SessionState.GetInt(DebugSimFrameKey, 0) + 1;
            SessionState.SetInt(DebugSimFrameKey, frame);
            VisualBridge.Diagnostics.VisualBridgeDebug.SetFrame(frame);
            var sent = false;
            if (VisualBridge.Diagnostics.VisualBridgeDebug.Start(
                DebugSimInstance, DebugSimCategory, DebugSimEventMethodId, DebugSimInterface, "Tick"))
            {
                VisualBridge.Diagnostics.VisualBridgeDebug.PushParam("tick", 1, "e9-tick-" + frame);
                sent = VisualBridge.Diagnostics.VisualBridgeDebug.End();
            }

            var sentCount = SessionState.GetInt(DebugSimSentKey, 0) + (sent ? 1 : 0);
            var failedCount = SessionState.GetInt(DebugSimFailedKey, 0) + (sent ? 0 : 1);
            SessionState.SetInt(DebugSimSentKey, sentCount);
            SessionState.SetInt(DebugSimFailedKey, failedCount);
            if (frame % 10 == 0)
            {
                UnityEngine.Debug.Log($"[runtime-bridge] debug-sim frame={frame} sent={sentCount} failed={failedCount} connected={connected}");
            }
        }

        /// <summary>
        /// 托管 E2E 的执行事件源：首帧解析编译图产物并登记执行实例，
        /// 之后每 300ms 轮转节点上报 nodeStart，间或上报 edgeValueChanged。
        /// </summary>
        private static void StepExecutionSimulator()
        {
            if (VisualBridgeRuntimeBridgeHost.CurrentServer == null)
            {
                return;
            }

            if (!SessionState.GetBool(HostedSimStartedKey, false))
            {
                StartExecutionSimulator();
                return;
            }

            var nextTickTicks = SessionState.GetString(HostedSimNextTickKey, "0");
            if (!long.TryParse(nextTickTicks, out var nextTick) || DateTime.UtcNow.Ticks < nextTick)
            {
                return;
            }

            SessionState.SetString(HostedSimNextTickKey, DateTime.UtcNow.AddMilliseconds(HostedSimTickMs).Ticks.ToString());
            var executionId = SessionState.GetString(HostedSimExecutionIdKey, null);
            var nodeIds = (SessionState.GetString(HostedSimNodeIdsKey, "") ?? string.Empty)
                .Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            if (string.IsNullOrEmpty(executionId) || nodeIds.Length == 0)
            {
                return;
            }

            var cursor = SessionState.GetInt(HostedSimCursorKey, 0);
            var frame = SessionState.GetInt(HostedSimFrameKey, 1);
            var nodeId = nodeIds[cursor % nodeIds.Length];
            VisualBridge.Runtime.VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, nodeId, frame);
            if (cursor % 3 == 1)
            {
                VisualBridge.Runtime.VisualBridgeGraphExecutionCapture.OnEdgeValueChanged(
                    executionId, nodeId, 0, "frame " + frame, frame);
            }

            SessionState.SetInt(HostedSimCursorKey, cursor + 1);
            SessionState.SetInt(HostedSimFrameKey, frame + 1);
        }

        private static void StartExecutionSimulator()
        {
            try
            {
                var snapshot = VisualBridge.Runtime.VisualBridgeRuntimeArtifactStore.Snapshot(
                    VisualBridgeRuntimeBridgeHost.ArtifactsRoot());
                VisualBridge.Runtime.VisualBridgeRuntimeDocumentSnapshot graphDocument = null;
                foreach (var document in snapshot)
                {
                    if (document.Kind == "visualbridge.graph.compiled")
                    {
                        graphDocument = document;
                        break;
                    }
                }

                if (graphDocument == null)
                {
                    UnityEngine.Debug.LogWarning("[runtime-bridge] no compiled graph artifact found for the execution simulator.");
                    return;
                }

                // 节点参数使用编译产物内的稳定节点 ID（§2 稳定 ID 映射）。
                var nodeIds = new List<string>();
                var graphs = graphDocument.Data?["graphs"] as JArray;
                var firstGraph = graphs != null && graphs.Count > 0 ? graphs[0] as JObject : null;
                var nodes = firstGraph?["nodes"] as JArray;
                if (nodes != null)
                {
                    foreach (var node in nodes)
                    {
                        var nodeId = (node as JObject)?["id"]?.ToString();
                        if (!string.IsNullOrEmpty(nodeId))
                        {
                            nodeIds.Add(nodeId);
                            if (nodeIds.Count >= 4)
                            {
                                break;
                            }
                        }
                    }
                }

                if (nodeIds.Count == 0)
                {
                    UnityEngine.Debug.LogWarning("[runtime-bridge] the compiled graph artifact carries no node ids.");
                    return;
                }

                var graphName = firstGraph?["title"]?.ToString() ?? graphDocument.DocumentId;
                if (!VisualBridge.Runtime.VisualBridgeGraphExecutionCapture.OnInstanceStarted(
                    graphDocument.DocumentTypeId, graphDocument.DocumentId, graphName, "hero-e2e", out var executionId))
                {
                    UnityEngine.Debug.LogWarning("[runtime-bridge] execution capture is not tracking; simulator not started.");
                    return;
                }

                SessionState.SetString(HostedSimExecutionIdKey, executionId);
                SessionState.SetString(HostedSimNodeIdsKey, string.Join(";", nodeIds));
                SessionState.SetInt(HostedSimCursorKey, 0);
                SessionState.SetInt(HostedSimFrameKey, 1);
                SessionState.SetString(HostedSimNextTickKey, DateTime.UtcNow.AddMilliseconds(HostedSimTickMs).Ticks.ToString());
                SessionState.SetBool(HostedSimStartedKey, true);
                UnityEngine.Debug.Log($"[runtime-bridge] execution simulator started: executionId={executionId} nodes={nodeIds.Count}");
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogError($"[runtime-bridge] failed to start the execution simulator: {exception.Message}");
            }
        }

        private static void Step()
        {
            if (!SessionState.GetBool(ActiveKey, false))
            {
                EditorApplication.update -= Step;
                return;
            }

            var deadlineTicks = SessionState.GetString(DeadlineKey, "0");
            if (long.TryParse(deadlineTicks, out var ticks) && DateTime.UtcNow.Ticks > ticks)
            {
                Finish("snapshot=timeout", FailureExitCode);
                return;
            }

            if (SessionState.GetBool(AttemptedKey, false))
            {
                return;
            }

            var server = VisualBridgeRuntimeBridgeHost.CurrentServer;
            if (server == null)
            {
                // server 由 host 在进入 Play 后（含 reload 兜底）启动。
                return;
            }

            SessionState.SetBool(AttemptedKey, true);
            try
            {
                var result = RunClientRoundtrip(server);
                Finish(result, SuccessExitCode);
            }
            catch (VisualBridge.Runtime.VisualBridgeRuntimeBridgeException exception)
            {
                Finish("snapshot=" + exception.Code, FailureExitCode);
            }
            catch (Exception exception)
            {
                Finish("snapshot=error: " + exception.Message, FailureExitCode);
            }
        }

        /// <summary>
        /// 内联简客户端（单线程同步请求/响应，Mono 并发管道读写死锁教训）：
        /// 连接 127.0.0.1 → hello（记录里的 token）→ welcome → getSnapshot → 校验响应。
        /// </summary>
        private static string RunClientRoundtrip(VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer server)
        {
            // 用磁盘发现记录里的 token 握手（记录写盘路径同时被验证）。
            var record = VisualBridge.Runtime.VisualBridgeRuntimeBridgeDiscovery.ParseRecord(server.RecordPath);
            if (record.TcpPort != server.TcpPort || record.Token != server.Token)
            {
                throw new InvalidOperationException("discovery record does not match the running server.");
            }

            using (var client = new TcpClient())
            {
                var async = client.BeginConnect("127.0.0.1", record.TcpPort, null, null);
                if (!async.AsyncWaitHandle.WaitOne(ReadTimeoutMs))
                {
                    throw new TimeoutException("TCP connect timed out.");
                }

                client.EndConnect(async);
                using (var stream = client.GetStream())
                {
                    stream.ReadTimeout = ReadTimeoutMs;
                    stream.WriteTimeout = ReadTimeoutMs;
                    var frameReader = new VisualBridgeFrameReader();

                    var hello = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.CreateHello(
                        "vscode-e2e-" + Guid.NewGuid().ToString("N"),
                        record.Token,
                        server.ContractHash,
                        new[] { "json" });
                    WriteLine(stream, hello.ToLine());

                    var welcome = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(ReadMessage(stream, frameReader));
                    if (welcome.Type != VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome)
                    {
                        throw new InvalidOperationException("expected a welcome message, received '" + welcome.Type + "'.");
                    }

                    if (welcome.Generation != record.Generation)
                    {
                        throw new InvalidOperationException("welcome generation does not match the discovery record.");
                    }

                    // 握手统一（附录 A.3）：welcome 的会话身份必须与 server 一致，首次连接不算 resume。
                    if (welcome.SessionId != server.SessionId || welcome.BootId != server.BootId)
                    {
                        throw new InvalidOperationException("welcome session identity does not match the server.");
                    }

                    if (welcome.EndpointId != record.InstanceId || welcome.ConnectType != "editor-player")
                    {
                        throw new InvalidOperationException(
                            "welcome endpoint/connectType does not match the editor-play runtime instance.");
                    }

                    if (welcome.Resumed)
                    {
                        throw new InvalidOperationException("a fresh hello must not be reported as resumed.");
                    }

                    var request = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.CreateSnapshotRequest("req-e2e-1", null);
                    WriteLine(stream, request.ToLine());

                    var response = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(ReadMessage(stream, frameReader));
                    if (response.Type != VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Response || !response.IsOk)
                    {
                        throw new InvalidOperationException("expected an ok snapshot response.");
                    }

                    var heroFound = false;
                    foreach (var document in response.Documents)
                    {
                        if (document.DocumentId == "sample.unity.hero.default")
                        {
                            heroFound = true;
                        }
                    }

                    if (!heroFound || response.Documents.Count < 4)
                    {
                        throw new InvalidOperationException(
                            $"snapshot response does not contain the compiled fixtures (documents={response.Documents.Count}, hero.default={heroFound}).");
                    }

                    return "snapshot=ok\ndocuments=" + response.Documents.Count
                        + "\nsession=" + server.SessionId
                        + "\nresume=" + AssertResume(server, record);
                }
            }
        }

        /// <summary>
        /// 会话续接（附录 A.3）：同一条 welcome.sessionId 再来一次必须判 resumed=true，
        /// 伪造的 resumeSessionId 必须判 resumed=false（不得把任意值当成续接）。
        /// </summary>
        private static string AssertResume(
            VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer server,
            VisualBridge.Runtime.VisualBridgeRuntimeInstance record)
        {
            var resumedWelcome = HandshakeOnce(record, server, server.SessionId);
            if (!resumedWelcome.Resumed)
            {
                throw new InvalidOperationException("re-hello with the current sessionId must be reported as resumed.");
            }

            var freshWelcome = HandshakeOnce(record, server, "player-0#bogus");
            if (freshWelcome.Resumed)
            {
                throw new InvalidOperationException("an unknown resumeSessionId must not be reported as resumed.");
            }

            return "matched";
        }

        private static VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessage HandshakeOnce(
            VisualBridge.Runtime.VisualBridgeRuntimeInstance record,
            VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer server,
            string resumeSessionId)
        {
            using (var client = new TcpClient())
            {
                var async = client.BeginConnect("127.0.0.1", record.TcpPort, null, null);
                if (!async.AsyncWaitHandle.WaitOne(ReadTimeoutMs))
                {
                    throw new TimeoutException("TCP connect timed out.");
                }

                client.EndConnect(async);
                using (var stream = client.GetStream())
                {
                    stream.ReadTimeout = ReadTimeoutMs;
                    stream.WriteTimeout = ReadTimeoutMs;
                    var frameReader = new VisualBridgeFrameReader();
                    var hello = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.CreateHello(
                        "vscode-e2e-" + Guid.NewGuid().ToString("N"),
                        record.Token,
                        server.ContractHash,
                        new[] { "json" },
                        resumeSessionId);
                    WriteLine(stream, hello.ToLine());
                    var welcome = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(ReadMessage(stream, frameReader));
                    if (welcome.Type != VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome)
                    {
                        throw new InvalidOperationException("expected a welcome message, received '" + welcome.Type + "'.");
                    }

                    return welcome;
                }
            }
        }

        private static void Finish(string result, int exitCode)
        {
            SessionState.SetBool(ActiveKey, false);
            EditorApplication.update -= Step;
            VisualBridgeRuntimeBridgeHost.StopServer("play mode e2e finished");

            var resultPath = SessionState.GetString(ResultPathKey, null);
            try
            {
                if (!string.IsNullOrEmpty(resultPath))
                {
                    File.WriteAllText(resultPath, result + "\n");
                }
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogError($"[runtime-bridge] failed to write the E2E result: {exception.Message}");
                EditorApplication.Exit(FailureExitCode);
                return;
            }

            UnityEngine.Debug.Log($"[runtime-bridge] play mode E2E finished: {result.Replace("\n", "; ")}");
            EditorApplication.Exit(exitCode);
        }

        private static void WriteLine(NetworkStream stream, string line)
        {
            var frame = VisualBridgeFraming.EncodeFrame(
                VisualBridgeChannel.Editor,
                VisualBridgePayloadKind.Json,
                Encoding.UTF8.GetBytes(line));
            stream.Write(frame, 0, frame.Length);
            stream.Flush();
        }

        private static string ReadMessage(NetworkStream stream, VisualBridgeFrameReader reader)
        {
            var buffer = new byte[8192];
            while (true)
            {
                while (reader.TryReadFrame(out var frame))
                {
                    // 该自检客户端只消费控制通道；调试帧不属于本批次的业务消息。
                    if (frame.Channel != VisualBridgeChannel.Editor)
                    {
                        continue;
                    }

                    return Encoding.UTF8.GetString(frame.Payload);
                }

                var read = stream.Read(buffer, 0, buffer.Length);
                if (read == 0)
                {
                    reader.DiscardPending();
                    throw new IOException("connection closed by the server.");
                }

                reader.Append(buffer, 0, read);
            }
        }
    }
}
