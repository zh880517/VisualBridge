using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Runtime Bridge Play 模式 E2E 的 batch 入口（供 -executeMethod）。
    /// 通过 SessionState 跨进入 Play 触发的 domain reload 保存编排状态：
    /// 进入 Play → host 启动 server → 内联简客户端连接自身完成
    /// hello/welcome/getSnapshot 往返 → 写结构化结果文件后退出。
    /// 事件链路（artifactsChanged）由 EditMode 测试覆盖：编译产物在
    /// Play 会话中不变，E2E 内改产物目录不可行。
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
        private const string HostedDeadlineKey = "VisualBridge.RuntimeBridgeHostedE2E.DeadlineTicks";
        private const string HostedStoppingKey = "VisualBridge.RuntimeBridgeHostedE2E.Stopping";

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
            SessionState.SetString(HostedDeadlineKey, DateTime.UtcNow.AddMilliseconds(120_000).Ticks.ToString());
            EditorApplication.update += HostedStep;
            EditorApplication.isPlaying = true;
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

                    var hello = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.CreateHello(
                        Guid.NewGuid().ToString(), record.Token, new[] { "snapshot", "events" });
                    WriteLine(stream, hello.ToLine());

                    var welcome = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(ReadLine(stream));
                    if (welcome.Type != VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome)
                    {
                        throw new InvalidOperationException("expected a welcome message, received '" + welcome.Type + "'.");
                    }

                    if (welcome.Generation != record.Generation)
                    {
                        throw new InvalidOperationException("welcome generation does not match the discovery record.");
                    }

                    var request = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.CreateSnapshotRequest("req-e2e-1", null);
                    WriteLine(stream, request.ToLine());

                    var response = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(ReadLine(stream));
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

                    return "snapshot=ok\ndocuments=" + response.Documents.Count;
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
            var bytes = Encoding.UTF8.GetBytes(line + "\n");
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        private static string ReadLine(NetworkStream stream)
        {
            var buffer = new byte[8192];
            var text = new StringBuilder();
            while (true)
            {
                var read = stream.Read(buffer, 0, buffer.Length);
                if (read == 0)
                {
                    throw new IOException("connection closed by the server.");
                }

                text.Append(Encoding.UTF8.GetString(buffer, 0, read));
                var newline = text.ToString().IndexOf('\n');
                if (newline >= 0)
                {
                    return text.ToString(0, newline);
                }
            }
        }
    }
}
