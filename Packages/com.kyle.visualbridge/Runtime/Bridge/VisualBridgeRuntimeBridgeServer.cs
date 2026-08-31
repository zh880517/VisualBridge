using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// Runtime Bridge 服务端：监听 127.0.0.1、执行 token 首条消息握手、
    /// 应答 getSnapshot / 租约控制 / getDocumentSources / Graph 执行观察
    /// （实例枚举、订阅、浅快照）、轮询产物目录并向订阅客户端推送
    /// artifactsChanged、按「满 64 条或 100ms」冲刷执行事件，并按第 17 章
    /// 语义发布/心跳/清理发现记录。单控制者租约（VB-UX-10）：同一时刻至多
    /// 一个连接持有 debug 租约，租约绑定连接，连接断开自动释放；
    /// getSnapshot 与 Graph 执行观察不受租约约束（观察者语义）。
    /// 本类是服务端（每连接独立线程，允许并发客户端），与客户端的
    /// 单线程同步请求/响应模型不冲突；Runtime 程序集禁止 Unity API，
    /// 日志走可选回调。
    /// </summary>
    public sealed class VisualBridgeRuntimeBridgeServer : IDisposable
    {
        public static readonly string[] AdvertisedCapabilities = { "snapshot", "events", "lease", "sources", "graphExecution" };

        private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan ExecutionFlushInterval = TimeSpan.FromMilliseconds(100);
        private const int DisposeJoinTimeoutMs = 2000;

        private readonly string instanceId;
        private readonly string kind;
        private readonly string token;
        private readonly string artifactsRoot;
        private readonly int generation;
        private readonly string startedAtText;
        private readonly Action<string> log;
        private readonly string recordPath;
        private readonly object connectionsGate = new object();
        private readonly List<Connection> connections = new List<Connection>();
        private readonly object leaseGate = new object();
        private Connection leaseHolder;

        private readonly TcpListener listener;
        private readonly Thread acceptThread;
        private readonly Thread heartbeatThread;
        private readonly Thread pollThread;
        private readonly Thread executionPumpThread;
        private volatile bool stopping;
        private bool disposed;

        private sealed class Connection
        {
            public TcpClient Client;
            public NetworkStream Stream;
            public readonly object WriteGate = new object();
            public bool WantsEvents;
            public string ClientInstanceId;
            /// <summary>当前订阅的执行实例 ID；null 表示未订阅（单实例跟踪）。</summary>
            public string SubscribedExecutionId;
            public readonly StringBuilder LineBuffer = new StringBuilder();
            public readonly byte[] ReadBuffer = new byte[8192];
        }

        /// <summary>
        /// preferredTcpPort 为 0 时随机分配；指定端口被占用时回退随机端口
        /// （宿主用实际绑定的 TcpPort 更新记录）。
        /// </summary>
        public VisualBridgeRuntimeBridgeServer(
            string instanceId,
            string kind,
            int preferredTcpPort,
            string token,
            string artifactsRoot,
            int generation,
            Action<string> log = null)
        {
            this.instanceId = instanceId ?? throw new ArgumentNullException(nameof(instanceId));
            this.kind = kind ?? throw new ArgumentNullException(nameof(kind));
            this.token = token ?? throw new ArgumentNullException(nameof(token));
            this.artifactsRoot = artifactsRoot ?? throw new ArgumentNullException(nameof(artifactsRoot));
            this.generation = generation;
            this.log = log;
            startedAtText = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            recordPath = Path.Combine(
                Path.GetTempPath(), VisualBridgeRuntimeBridgeDiscovery.DiscoveryDirectoryName, instanceId + ".json");

            listener = CreateListener(preferredTcpPort);
            TcpPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            WriteDiscoveryRecord();

            // 执行采集门面是进程级单例：服务端运行期间开启生命周期追踪。
            // mid-play domain reload 窗口内新旧服务端短暂共存时共享同一
            // 注册表与缓冲，事件由先冲刷的泵负责投递（窗口极短，可接受）。
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "visualbridge-runtime-accept" };
            heartbeatThread = new Thread(HeartbeatLoop) { IsBackground = true, Name = "visualbridge-runtime-heartbeat" };
            pollThread = new Thread(PollLoop) { IsBackground = true, Name = "visualbridge-runtime-poll" };
            executionPumpThread = new Thread(ExecutionPumpLoop) { IsBackground = true, Name = "visualbridge-runtime-execution-pump" };
            acceptThread.Start();
            heartbeatThread.Start();
            pollThread.Start();
            executionPumpThread.Start();
        }

        public string InstanceId => instanceId;

        public string Kind => kind;

        public int Generation => generation;

        public int TcpPort { get; }

        public string Token => token;

        public string ArtifactsRoot => artifactsRoot;

        public string RecordPath => recordPath;

        public string StartedAtText => startedAtText;

        /// <summary>当前产物快照（每次调用重新读取产物目录）。</summary>
        public IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> Snapshot()
        {
            return VisualBridgeRuntimeArtifactStore.Snapshot(artifactsRoot);
        }

        /// <summary>全部运行中文档的 Authoring 源映射（每次调用重新读取产物目录）。</summary>
        public IReadOnlyList<VisualBridgeRuntimeDocumentSource> DocumentSources()
        {
            return VisualBridgeRuntimeArtifactStore.DocumentSources(artifactsRoot);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            stopping = true;
            try
            {
                listener.Stop();
            }
            catch (SocketException)
            {
                // 监听套接字已关闭。
            }

            lock (connectionsGate)
            {
                foreach (var connection in connections)
                {
                    CloseConnection(connection);
                }

                connections.Clear();
            }

            lock (leaseGate)
            {
                leaseHolder = null;
            }

            VisualBridgeGraphExecutionCapture.SetSubscribed(false);
            VisualBridgeGraphExecutionCapture.SetTracking(false);

            JoinThread(acceptThread);
            JoinThread(heartbeatThread);
            JoinThread(pollThread);
            JoinThread(executionPumpThread);
            try
            {
                File.Delete(recordPath);
            }
            catch (IOException)
            {
                // 记录文件可能被占用；心跳超时兜底判定陈旧。
            }
        }

        private static TcpListener CreateListener(int preferredTcpPort)
        {
            if (preferredTcpPort > 0)
            {
                try
                {
                    var preferred = new TcpListener(IPAddress.Loopback, preferredTcpPort);
                    preferred.Start();
                    return preferred;
                }
                catch (SocketException)
                {
                    // 端口被旧实例占用（reload 窗口）：回退随机端口。
                }
            }

            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            return listener;
        }

        private void AcceptLoop()
        {
            while (!stopping)
            {
                TcpClient client;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch (Exception exception) when (exception is SocketException || exception is ObjectDisposedException || exception is InvalidOperationException)
                {
                    break;
                }

                // 每连接独立线程：允许并发客户端连接；顶层兜底防止异常击穿线程。
                var handler = new Thread(() =>
                {
                    try
                    {
                        HandleClient(client);
                    }
                    catch (Exception exception)
                    {
                        log?.Invoke($"[runtime-bridge] connection handler failed: {exception.Message}");
                    }
                })
                { IsBackground = true };
                handler.Start();
            }
        }

        private void HandleClient(TcpClient client)
        {
            var connection = new Connection { Client = client, Stream = client.GetStream() };
            try
            {
                lock (connectionsGate)
                {
                    connections.Add(connection);
                }

                // 首条消息必须 hello：非法 JSON/残缺消息/版本不符/未知类型分别按冻结错误码回发后断开。
                string firstLine;
                try
                {
                    firstLine = ReadLine(connection);
                }
                catch (VisualBridgeRuntimeBridgeException)
                {
                    return;
                }

                if (firstLine == null)
                {
                    return;
                }

                JObject helloObject;
                try
                {
                    helloObject = VisualBridgeRuntimeBridgeValidator.ParseObject(firstLine, "runtime.invalidJson");
                }
                catch (VisualBridgeRuntimeBridgeException exception)
                {
                    SendError(connection, "runtime.invalidJson", exception.Message);
                    return;
                }

                VisualBridgeRuntimeBridgeMessage hello;
                try
                {
                    hello = VisualBridgeRuntimeBridgeValidator.ValidateMessage(helloObject);
                }
                catch (VisualBridgeRuntimeBridgeException exception)
                {
                    SendError(connection, VisualBridgeRuntimeBridgeValidator.MapWireCode(exception.Code), exception.Message);
                    return;
                }

                if (hello.Type != VisualBridgeRuntimeBridgeMessageType.Hello)
                {
                    SendError(connection, "runtime.unknownMessageType", "First message must be hello.");
                    return;
                }

                if (!string.Equals(hello.Token, token, StringComparison.Ordinal))
                {
                    SendError(connection, "runtime.invalidToken", "Token does not match the discovery record.");
                    return;
                }

                connection.WantsEvents = hello.SupportsCapability("events");
                connection.ClientInstanceId = hello.ClientInstanceId;
                var welcome = VisualBridgeRuntimeBridgeValidator.CreateWelcome(
                    instanceId, kind, generation, AdvertisedCapabilities, startedAtText);
                WriteLine(connection, welcome.ToLine());

                RequestLoop(connection);
            }
            catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
            {
                // 客户端已断开。
            }
            finally
            {
                lock (connectionsGate)
                {
                    connections.Remove(connection);
                }

                ReleaseLeaseOnDisconnect(connection);
                UpdateExecutionSubscriptionState();
                CloseConnection(connection);
            }
        }

        /// <summary>连接断开时自动释放其持有的租约（租约绑定连接）。</summary>
        private void ReleaseLeaseOnDisconnect(Connection connection)
        {
            lock (leaseGate)
            {
                if (leaseHolder == connection)
                {
                    leaseHolder = null;
                }
            }
        }

        /// <summary>订阅状态变化后同步采集门面；无任何订阅者时停止事件录制。</summary>
        private void UpdateExecutionSubscriptionState()
        {
            lock (connectionsGate)
            {
                foreach (var connection in connections)
                {
                    if (connection.SubscribedExecutionId != null)
                    {
                        VisualBridgeGraphExecutionCapture.SetSubscribed(true);
                        return;
                    }
                }
            }

            VisualBridgeGraphExecutionCapture.SetSubscribed(false);
        }

        private void RequestLoop(Connection connection)
        {
            while (!stopping)
            {
                string line;
                try
                {
                    line = ReadLine(connection);
                }
                catch (VisualBridgeRuntimeBridgeException exception)
                {
                    SendError(connection, VisualBridgeRuntimeBridgeValidator.MapWireCode(exception.Code), exception.Message);
                    return;
                }

                if (line == null)
                {
                    return;
                }

                JObject requestObject;
                try
                {
                    requestObject = VisualBridgeRuntimeBridgeValidator.ParseObject(line, "runtime.invalidJson");
                }
                catch (VisualBridgeRuntimeBridgeException exception)
                {
                    SendError(connection, "runtime.invalidJson", exception.Message);
                    return;
                }

                VisualBridgeRuntimeBridgeMessage request;
                try
                {
                    request = VisualBridgeRuntimeBridgeValidator.ValidateMessage(requestObject);
                    if (request.Type != VisualBridgeRuntimeBridgeMessageType.Request)
                    {
                        throw VisualBridgeRuntimeBridgeValidator.Error(
                            "runtime.invalidMessage", "$.type", "Only request messages are allowed after the handshake.");
                    }
                }
                catch (VisualBridgeRuntimeBridgeException exception)
                {
                    // 未知 action 是请求级错误（response error，连接保持），其余为连接级错误。
                    if (exception.Code == "runtime.unknownRequest")
                    {
                        var requestId = (requestObject["requestId"] as JValue)?.Value<string>();
                        if (requestId != null && !string.IsNullOrEmpty(requestId) && requestId.Length <= 128)
                        {
                            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                                .CreateResponseError(requestId, "runtime.unknownRequest", exception.Message)
                                .ToLine());
                            continue;
                        }
                    }

                    SendError(connection, VisualBridgeRuntimeBridgeValidator.MapWireCode(exception.Code), exception.Message);
                    return;
                }

                HandleRequest(connection, request);
            }
        }

        private void HandleRequest(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            switch (request.Action)
            {
                case "getSnapshot":
                    RespondToSnapshotRequest(connection, request);
                    return;
                case "acquireLease":
                    RespondToAcquireLease(connection, request);
                    return;
                case "releaseLease":
                    RespondToReleaseLease(connection, request);
                    return;
                case "getDocumentSources":
                    RespondToSourcesRequest(connection, request);
                    return;
                case "getGraphExecutionInstances":
                    RespondToGraphExecutionInstances(connection, request);
                    return;
                case "subscribeGraphExecution":
                    RespondToSubscribeGraphExecution(connection, request);
                    return;
                case "unsubscribeGraphExecution":
                    RespondToUnsubscribeGraphExecution(connection, request);
                    return;
                case "getGraphExecutionSnapshot":
                    RespondToGraphExecutionSnapshot(connection, request);
                    return;
                default:
                    SendLine(connection, VisualBridgeRuntimeBridgeValidator
                        .CreateResponseError(request.RequestId, "runtime.unknownRequest", $"Unknown request action '{request.Action}'.")
                        .ToLine());
                    return;
            }
        }

        private void RespondToSnapshotRequest(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            try
            {
                var snapshot = VisualBridgeRuntimeArtifactStore.Snapshot(artifactsRoot);
                var documents = VisualBridgeRuntimeArtifactStore.FilterSnapshot(snapshot, request.DocumentTypeIds);
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateSnapshotResponseOk(request.RequestId, documents)
                    .ToLine());
            }
            catch (VisualBridgeRuntimeBridgeException exception)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.internalError", exception.Message)
                    .ToLine());
            }
            catch (Exception exception)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.internalError", exception.Message)
                    .ToLine());
            }
        }

        /// <summary>acquireLease：无持有者或本连接重复获取 → ok；他人持有 → leaseDenied。</summary>
        private void RespondToAcquireLease(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            string deniedDetail = null;
            lock (leaseGate)
            {
                if (leaseHolder == null || leaseHolder == connection)
                {
                    leaseHolder = connection;
                }
                else
                {
                    deniedDetail = $"Lease held by client {leaseHolder.ClientInstanceId}.";
                }
            }

            if (deniedDetail != null)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.leaseDenied", deniedDetail)
                    .ToLine());
                return;
            }

            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                .CreateLeaseResponse(request.RequestId)
                .ToLine());
        }

        /// <summary>releaseLease：持有者本人 → ok；无租约 → leaseNotHeld；非持有者 → leaseDenied。</summary>
        private void RespondToReleaseLease(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            string errorCode = null;
            string detail = null;
            lock (leaseGate)
            {
                if (leaseHolder == null)
                {
                    errorCode = "runtime.leaseNotHeld";
                    detail = "No client currently holds the lease.";
                }
                else if (leaseHolder != connection)
                {
                    errorCode = "runtime.leaseDenied";
                    detail = $"Lease held by client {leaseHolder.ClientInstanceId}.";
                }
                else
                {
                    leaseHolder = null;
                }
            }

            if (errorCode != null)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, errorCode, detail)
                    .ToLine());
                return;
            }

            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                .CreateLeaseResponse(request.RequestId)
                .ToLine());
        }

        /// <summary>getDocumentSources：要求本连接持有租约（无租约 → leaseRequired；他人持有 → leaseDenied）。</summary>
        private void RespondToSourcesRequest(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            string errorCode = null;
            string detail = null;
            lock (leaseGate)
            {
                if (leaseHolder == null)
                {
                    errorCode = "runtime.leaseRequired";
                    detail = "Document sources require the debug lease.";
                }
                else if (leaseHolder != connection)
                {
                    errorCode = "runtime.leaseDenied";
                    detail = $"Lease held by client {leaseHolder.ClientInstanceId}.";
                }
            }

            if (errorCode != null)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, errorCode, detail)
                    .ToLine());
                return;
            }

            try
            {
                var sources = VisualBridgeRuntimeArtifactStore.DocumentSources(artifactsRoot);
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateSourcesResponse(request.RequestId, sources)
                    .ToLine());
            }
            catch (Exception exception)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.internalError", exception.Message)
                    .ToLine());
            }
        }

        /// <summary>getGraphExecutionInstances：返回运行中实例（可选 documentId 过滤），无需订阅。</summary>
        private void RespondToGraphExecutionInstances(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            var instances = VisualBridgeGraphExecutionCapture.ListInstances(request.DocumentId);
            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                .CreateGraphExecutionInstancesResponse(request.RequestId, instances)
                .ToLine());
        }

        /// <summary>subscribeGraphExecution：实例不存在 → executionNotFound；成功即开录并合成 instanceStarted 开流标记。</summary>
        private void RespondToSubscribeGraphExecution(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            var instance = VisualBridgeGraphExecutionCapture.GetSnapshot(request.ExecutionId);
            if (instance == null)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.executionNotFound", $"Execution '{request.ExecutionId}' is not active.")
                    .ToLine());
                return;
            }

            lock (connectionsGate)
            {
                // 单实例跟踪：新订阅覆盖旧订阅。
                connection.SubscribedExecutionId = request.ExecutionId;
            }

            VisualBridgeGraphExecutionCapture.SetSubscribed(true);
            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                .CreateLeaseResponse(request.RequestId)
                .ToLine());
            // 开流标记：合成 instanceStarted 事件，让客户端的会话记录有明确起点。
            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                .CreateGraphExecutionEvent(new[]
                {
                    new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = request.ExecutionId,
                        FrameIndex = instance.FrameIndex,
                        Kind = "instanceStarted",
                    },
                })
                .ToLine());
        }

        /// <summary>unsubscribeGraphExecution：幂等 ok；最后一个订阅者退出即停止事件录制。</summary>
        private void RespondToUnsubscribeGraphExecution(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            lock (connectionsGate)
            {
                if (string.Equals(connection.SubscribedExecutionId, request.ExecutionId, StringComparison.Ordinal))
                {
                    connection.SubscribedExecutionId = null;
                }
            }

            UpdateExecutionSubscriptionState();
            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                .CreateLeaseResponse(request.RequestId)
                .ToLine());
        }

        /// <summary>getGraphExecutionSnapshot：浅快照（实例元信息 + 当前节点 + 运行状态）；实例不在注册表 → executionNotFound。</summary>
        private void RespondToGraphExecutionSnapshot(Connection connection, VisualBridgeRuntimeBridgeMessage request)
        {
            var instance = VisualBridgeGraphExecutionCapture.GetSnapshot(request.ExecutionId);
            if (instance == null)
            {
                SendLine(connection, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.executionNotFound", $"Execution '{request.ExecutionId}' is not active.")
                    .ToLine());
                return;
            }

            SendLine(connection, VisualBridgeRuntimeBridgeValidator
                .CreateGraphExecutionSnapshotResponse(request.RequestId, instance)
                .ToLine());
        }

        /// <summary>
        /// 执行泵：等待门面缓冲（满 64 条提前唤醒，至多 100ms），按执行实例
        /// 分组推送 graphExecution 批量事件；投递 instanceStopped 后清除对应
        /// 订阅（实例已死，客户端应切换实例），无订阅者时停止录制。
        /// </summary>
        private void ExecutionPumpLoop()
        {
            var drained = new List<VisualBridgeRuntimeGraphExecutionEvent>();
            while (!stopping)
            {
                drained.Clear();
                if (!VisualBridgeGraphExecutionCapture.WaitAndDrain(ExecutionFlushInterval, drained))
                {
                    continue;
                }

                BroadcastGraphExecution(drained);
            }
        }

        private void BroadcastGraphExecution(List<VisualBridgeRuntimeGraphExecutionEvent> events)
        {
            // 按执行实例分组（保持事件原始顺序）。
            var batches = new Dictionary<string, List<VisualBridgeRuntimeGraphExecutionEvent>>(StringComparer.Ordinal);
            foreach (var executionEvent in events)
            {
                if (!batches.TryGetValue(executionEvent.ExecutionId, out var batch))
                {
                    batch = new List<VisualBridgeRuntimeGraphExecutionEvent>();
                    batches[executionEvent.ExecutionId] = batch;
                }

                batch.Add(executionEvent);
            }

            foreach (var entry in batches)
            {
                var containsStopped = false;
                foreach (var executionEvent in entry.Value)
                {
                    if (executionEvent.Kind == "instanceStopped")
                    {
                        containsStopped = true;
                        break;
                    }
                }

                var line = VisualBridgeRuntimeBridgeValidator.CreateGraphExecutionEvent(entry.Value).ToLine();
                List<Connection> subscribers;
                var stoppedSubscribers = new List<Connection>();
                lock (connectionsGate)
                {
                    subscribers = new List<Connection>(connections);
                    if (containsStopped)
                    {
                        // 实例停止：清除对应订阅（最后一批仍需送达），之后无订阅者即停止录制。
                        foreach (var connection in subscribers)
                        {
                            if (string.Equals(connection.SubscribedExecutionId, entry.Key, StringComparison.Ordinal))
                            {
                                connection.SubscribedExecutionId = null;
                                stoppedSubscribers.Add(connection);
                            }
                        }
                    }
                }

                foreach (var connection in subscribers)
                {
                    var isTarget = stoppedSubscribers.Contains(connection)
                        || string.Equals(connection.SubscribedExecutionId, entry.Key, StringComparison.Ordinal);
                    if (!isTarget)
                    {
                        continue;
                    }

                    try
                    {
                        WriteLine(connection, line);
                    }
                    catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
                    {
                        CloseConnection(connection);
                    }
                }

                if (containsStopped)
                {
                    UpdateExecutionSubscriptionState();
                }
            }
        }

        private void HeartbeatLoop()
        {
            while (!stopping)
            {
                if (!SleepInterruptibly(HeartbeatInterval))
                {
                    return;
                }

                try
                {
                    // 心跳即记录 mtime：陈旧判定 = mtime 超过 5 秒或 pid 已死。
                    File.SetLastWriteTimeUtc(recordPath, DateTime.UtcNow);
                }
                catch (Exception exception) when (exception is IOException || exception is UnauthorizedAccessException)
                {
                    log?.Invoke($"[runtime-bridge] heartbeat touch failed: {exception.Message}");
                }
            }
        }

        private void PollLoop()
        {
            var digest = SafeComputeDigest();
            while (!stopping)
            {
                if (!SleepInterruptibly(PollInterval))
                {
                    return;
                }

                var next = SafeComputeDigest();
                if (next == null || next == digest)
                {
                    if (next != null)
                    {
                        digest = next;
                    }

                    continue;
                }

                digest = next;
                try
                {
                    var snapshot = VisualBridgeRuntimeArtifactStore.Snapshot(artifactsRoot);
                    BroadcastArtifactsChanged(snapshot);
                }
                catch (Exception exception)
                {
                    log?.Invoke($"[runtime-bridge] failed to snapshot changed artifacts: {exception.Message}");
                }
            }
        }

        private string SafeComputeDigest()
        {
            try
            {
                return VisualBridgeRuntimeArtifactStore.ComputeDigest(artifactsRoot);
            }
            catch (Exception exception) when (exception is IOException || exception is UnauthorizedAccessException)
            {
                // 产物目录被并发写入时跳过本轮比较。
                return null;
            }
        }

        private void BroadcastArtifactsChanged(IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> snapshot)
        {
            var line = VisualBridgeRuntimeBridgeValidator.CreateArtifactsChangedEvent(snapshot).ToLine();
            List<Connection> subscribers;
            lock (connectionsGate)
            {
                subscribers = new List<Connection>(connections);
            }

            foreach (var connection in subscribers)
            {
                if (!connection.WantsEvents)
                {
                    continue;
                }

                try
                {
                    WriteLine(connection, line);
                }
                catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
                {
                    // 推送失败说明客户端已断开；关闭套接字让其读线程退出。
                    CloseConnection(connection);
                }
            }
        }

        private void WriteDiscoveryRecord()
        {
            var record = new JObject
            {
                ["formatVersion"] = VisualBridgeRuntimeBridgeValidator.DiscoveryFormatVersion,
                ["protocolVersion"] = VisualBridgeRuntimeBridgeValidator.ProtocolVersion,
                ["coreVersion"] = VisualBridgeRuntimeBridgeValidator.CoreVersion,
                ["instanceId"] = instanceId,
                ["kind"] = kind,
                ["capabilities"] = new JArray(AdvertisedCapabilities),
                ["tcpPort"] = TcpPort,
                ["token"] = token,
                ["pid"] = Process.GetCurrentProcess().Id,
                ["generation"] = generation,
                ["startedAt"] = startedAtText,
            };

            // 自检：写盘记录必须能被自己的严格校验器接受。
            VisualBridgeRuntimeBridgeValidator.ValidateDiscoveryRecord(record);

            var directory = Path.GetDirectoryName(recordPath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            // 原子替换：先写临时文件再覆盖，读取方不会看到半截记录。
            var temporaryPath = recordPath + ".tmp";
            File.WriteAllText(temporaryPath, record.ToString(Newtonsoft.Json.Formatting.None));
            try
            {
                File.Delete(recordPath);
            }
            catch (IOException)
            {
                // 旧记录可能不存在。
            }

            File.Move(temporaryPath, recordPath);
        }

        private static string ReadLine(Connection connection)
        {
            while (true)
            {
                var buffered = connection.LineBuffer.ToString();
                var newline = buffered.IndexOf('\n');
                if (newline >= 0)
                {
                    var line = connection.LineBuffer.ToString(0, newline);
                    connection.LineBuffer.Remove(0, newline + 1);
                    if (line.Trim().Length == 0)
                    {
                        continue;
                    }

                    return line;
                }

                int read;
                try
                {
                    read = connection.Stream.Read(connection.ReadBuffer, 0, connection.ReadBuffer.Length);
                }
                catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException)
                {
                    throw VisualBridgeRuntimeBridgeValidator.Error("runtime.invalidMessage", "$", "Connection failed while reading: " + exception.Message);
                }

                if (read == 0)
                {
                    return null;
                }

                connection.LineBuffer.Append(Encoding.UTF8.GetString(connection.ReadBuffer, 0, read));
            }
        }

        private void SendError(Connection connection, string code, string detail)
        {
            try
            {
                WriteLine(connection, VisualBridgeRuntimeBridgeValidator.CreateError(code, detail).ToLine());
            }
            catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
            {
                // 对端已断开。
            }
        }

        private static void SendLine(Connection connection, string line)
        {
            WriteLine(connection, line);
        }

        private static void WriteLine(Connection connection, string line)
        {
            lock (connection.WriteGate)
            {
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                connection.Stream.Write(bytes, 0, bytes.Length);
                connection.Stream.Flush();
            }
        }

        private static void CloseConnection(Connection connection)
        {
            try
            {
                connection.Client.Close();
            }
            catch (SocketException)
            {
                // 已关闭。
            }
        }

        private bool SleepInterruptibly(TimeSpan interval)
        {
            var remaining = interval;
            var watch = Stopwatch.StartNew();
            while (remaining > TimeSpan.Zero)
            {
                if (stopping)
                {
                    return false;
                }

                var slice = remaining > TimeSpan.FromMilliseconds(200) ? TimeSpan.FromMilliseconds(200) : remaining;
                Thread.Sleep(slice);
                remaining = interval - watch.Elapsed;
            }

            return !stopping;
        }

        private static void JoinThread(Thread thread)
        {
            try
            {
                thread.Join(DisposeJoinTimeoutMs);
            }
            catch (ThreadStateException)
            {
                // 线程尚未启动或已退出。
            }
        }
    }

    internal static class RuntimeBridgeCapabilityExtensions
    {
        /// <summary>hello 消息是否声明了指定能力（事件订阅判定）。</summary>
        public static bool SupportsCapability(this VisualBridgeRuntimeBridgeMessage message, string capability)
        {
            return message.Capabilities != null
                && System.Linq.Enumerable.Contains(message.Capabilities, capability);
        }
    }
}
