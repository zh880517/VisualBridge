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
    /// 应答 getSnapshot / 租约控制 / getDocumentSources、轮询产物目录并向
    /// 订阅客户端推送 artifactsChanged，并按第 17 章语义发布/心跳/清理发现记录。
    /// 单控制者租约（VB-UX-10）：同一时刻至多一个连接持有 debug 租约，租约绑定
    /// 连接，连接断开自动释放；getSnapshot 不受租约约束（观察者语义）。
    /// 本类是服务端（每连接独立线程，允许并发客户端），与客户端的
    /// 单线程同步请求/响应模型不冲突；Runtime 程序集禁止 Unity API，
    /// 日志走可选回调。
    /// </summary>
    public sealed class VisualBridgeRuntimeBridgeServer : IDisposable
    {
        public static readonly string[] AdvertisedCapabilities = { "snapshot", "events", "lease", "sources" };

        /// <summary>welcome.payloads：Runtime 腿目前只实现 JSON（binary 降级为 JSON，连接保持）。</summary>
        private static readonly string[] Payloads = { "json" };

        private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);
        private const int DisposeJoinTimeoutMs = 2000;

        /// <summary>重连宽限期（附录 A.8 的 <c>ReconnectGraceMs</c>）：超过即换发新会话身份。</summary>
        public const int ReconnectGraceMs = 15000;

        private readonly string instanceId;
        private readonly string kind;
        private readonly string token;
        private readonly string artifactsRoot;
        private readonly int generation;
        private readonly string startedAtText;
        private string bootId;
        private string sessionId;
        private readonly string contractHash;
        private readonly Action<string> log;
        private readonly Func<DateTime> utcNow;
        private readonly string recordPath;
        private readonly object connectionsGate = new object();
        private readonly List<Connection> connections = new List<Connection>();
        private readonly object leaseGate = new object();
        private Connection leaseHolder;
        private long nextDebugGeneration;
        /// <summary>最后一条连接结束的时刻（UTC ticks，0 = 从未断开）；宽限判定的起点。</summary>
        private long lastDisconnectedAtTicks;

        private readonly TcpListener listener;
        private readonly Thread acceptThread;
        private readonly Thread heartbeatThread;
        private readonly Thread pollThread;
        private volatile bool stopping;
        private bool disposed;

        private sealed class Connection
        {
            public TcpClient Client;
            public VisualBridgeBridgeSocket Bridge;
            public readonly ManualResetEventSlim Closed = new ManualResetEventSlim(false);
            public bool HelloCompleted;
            public bool WantsEvents;
            public string ClientInstanceId;
            /// <summary>本连接的调试通道（附录 A.2）；握手完成后交给宿主。</summary>
            public VisualBridgeRuntimeDebugLink DebugLink;
        }

        /// <summary>
        /// preferredTcpPort 为 0 时随机分配；指定端口被占用时回退随机端口
        /// （宿主用实际绑定的 TcpPort 更新记录）。
        ///
        /// Player 模式（<c>kind == "player"</c>）改由端口段决定监听地址与端口：
        /// <paramref name="bindAllInterfaces"/> 为 true 时绑定 <c>0.0.0.0</c>，并在
        /// <paramref name="portRangeStart"/>..<paramref name="portRangeEnd"/> 里取第一个可用端口；
        /// 整段被占用时抛 <see cref="InvalidOperationException"/> 让宿主记录错误并停止（不重试死循环）。
        /// </summary>
        public VisualBridgeRuntimeBridgeServer(
            string instanceId,
            string kind,
            int preferredTcpPort,
            string token,
            string artifactsRoot,
            int generation,
            Action<string> log = null,
            bool bindAllInterfaces = false,
            int portRangeStart = 0,
            int portRangeEnd = 0,
            string contractHash = null,
            Func<DateTime> utcNow = null)
        {
            this.instanceId = instanceId ?? throw new ArgumentNullException(nameof(instanceId));
            this.kind = kind ?? throw new ArgumentNullException(nameof(kind));
            this.token = token ?? string.Empty;
            this.artifactsRoot = artifactsRoot ?? throw new ArgumentNullException(nameof(artifactsRoot));
            this.generation = generation;
            this.log = log;
            this.utcNow = utcNow ?? (() => DateTime.UtcNow);
            startedAtText = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            // 会话身份（附录 A.3）：bootId 每次会话启动随机、Domain Reload 不变（宽限到期会换发新会话）；
            // sessionId = endpointId#bootId。
            bootId = Guid.NewGuid().ToString("N");
            sessionId = instanceId + "#" + bootId;
            // Editor 宿主直接传入已读取的指纹；Player 只能在运行时从产物目录读（缺失按空串降级）。
            this.contractHash = contractHash ?? VisualBridgeRuntimeContractHash.Read(artifactsRoot);
            recordPath = Path.Combine(
                Path.GetTempPath(), VisualBridgeRuntimeBridgeDiscovery.DiscoveryDirectoryName, instanceId + ".json");

            listener = CreateListener(preferredTcpPort, bindAllInterfaces, portRangeStart, portRangeEnd);
            TcpPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            WriteDiscoveryRecord();
            if (ListenAddress.Equals(IPAddress.Any) && this.token.Length == 0)
            {
                // 0.0.0.0 + 无 token（Player 腿）：这条监听对局域网完全开放，必须在日志里显式说明，
                // 不能只在文档里写"已接受的风险"。
                log?.Invoke(
                    "[runtime-bridge] WARNING: listening on " + ListenAddress + ":" + TcpPort
                    + " without authentication (局域网内无认证); any machine on the same network can connect.");
            }

            // 执行采集门面是进程级单例：服务端运行期间开启生命周期追踪，
            // 观察者（Graph 调试发射端）由此拿到执行事实。
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "visualbridge-runtime-accept" };
            heartbeatThread = new Thread(HeartbeatLoop) { IsBackground = true, Name = "visualbridge-runtime-heartbeat" };
            pollThread = new Thread(PollLoop) { IsBackground = true, Name = "visualbridge-runtime-poll" };
            acceptThread.Start();
            heartbeatThread.Start();
            pollThread.Start();
        }

        public string InstanceId => instanceId;

        public string Kind => kind;

        public int Generation => generation;

        public int TcpPort { get; }

        /// <summary>实际监听地址：Loopback（Editor Play）或 Any（Player，绑定全部网卡）。</summary>
        public IPAddress ListenAddress => ((IPEndPoint)listener.LocalEndpoint).Address;

        public string Token => token;

        public string ArtifactsRoot => artifactsRoot;

        public string RecordPath => recordPath;

        public string StartedAtText => startedAtText;

        /// <summary>会话身份（附录 A.3）：<c>endpointId#bootId</c>；宽限内跨 Domain Reload 稳定，宽限到期换发新值。</summary>
        public string SessionId => sessionId;

        public string BootId => bootId;

        /// <summary>当前已完成握手的连接数（诊断与单连接闸门用）。</summary>
        internal int HandshakenConnectionCount
        {
            get
            {
                lock (connectionsGate)
                {
                    var count = 0;
                    foreach (var connection in connections)
                    {
                        if (connection.HelloCompleted)
                        {
                            count++;
                        }
                    }

                    return count;
                }
            }
        }

        /// <summary>最后一条连接结束的 UTC 时刻；从未断开时为 null（宽限判定用）。</summary>
        internal DateTime? LastDisconnectedAtUtc
        {
            get
            {
                var ticks = Interlocked.Read(ref lastDisconnectedAtTicks);
                return ticks == 0 ? (DateTime?)null : new DateTime(ticks, DateTimeKind.Utc);
            }
        }

        /// <summary>调试契约指纹（welcome.contractHash）；无契约时为空串。</summary>
        public string ContractHash => contractHash;

        /// <summary>welcome.debugEnabled：宿主是否已挂上调试通道处理器。</summary>
        public bool DebugLinkEnabled => DebugLinkOpened != null;

        /// <summary>
        /// 握手完成的连接把调试通道（附录 A.2）交给宿主：每条新连接一个新实例（<see cref="VisualBridgeRuntimeDebugLink.Generation"/> 递增），
        /// 宿主在处理器里注入调试传输实现。处理器在连接读线程上同步调用，不得阻塞。
        /// </summary>
        public event Action<VisualBridgeRuntimeDebugLink> DebugLinkOpened;

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

            VisualBridgeGraphExecutionCapture.SetTracking(false);

            JoinThread(acceptThread);
            JoinThread(heartbeatThread);
            JoinThread(pollThread);
            try
            {
                File.Delete(recordPath);
            }
            catch (IOException)
            {
                // 记录文件可能被占用；心跳超时兜底判定陈旧。
            }
        }

        /// <summary>
        /// 创建监听器。端口段模式（Player）：在区间内取第一个可用端口，整段占用即失败并停止；
        /// 单端口模式（Editor Play）：优先旧端口，被占用时回退随机端口。
        /// </summary>
        private static TcpListener CreateListener(int preferredTcpPort, bool bindAllInterfaces, int portRangeStart,
            int portRangeEnd)
        {
            var address = bindAllInterfaces ? IPAddress.Any : IPAddress.Loopback;
            if (portRangeStart > 0 && portRangeEnd >= portRangeStart)
            {
                for (var port = portRangeStart; port <= portRangeEnd; port++)
                {
                    try
                    {
                        var candidate = new TcpListener(address, port);
                        candidate.Start();
                        return candidate;
                    }
                    catch (SocketException)
                    {
                        // 该端口被占用：继续试下一个，不重试同一个端口。
                    }
                }

                // 全占用：错误必须可见，绝不无限重试（附录 A.8）。
                throw new InvalidOperationException(
                    "No free runtime bridge port in " + portRangeStart + "-" + portRangeEnd
                    + " (all ports are in use); the runtime bridge is not listening.");
            }

            if (preferredTcpPort > 0)
            {
                try
                {
                    var preferred = new TcpListener(address, preferredTcpPort);
                    preferred.Start();
                    return preferred;
                }
                catch (SocketException)
                {
                    // 端口被旧实例占用（reload 窗口）：回退随机端口。
                }
            }

            var listener = new TcpListener(address, 0);
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
            var connection = new Connection { Client = client };
            try
            {
                connection.Bridge = new VisualBridgeBridgeSocket(
                    client.GetStream(),
                    payload => HandleControlFrame(connection, payload),
                    (payloadKind, payload) => connection.DebugLink?.NotifyDebugFrame(payloadKind, payload),
                    error =>
                    {
                        if (error != null)
                        {
                            log?.Invoke("[runtime-bridge] connection closed: " + error.Message);
                        }

                        connection.Closed.Set();
                    },
                    null,
                    log);
                connection.DebugLink = new VisualBridgeRuntimeDebugLink(
                    connection.Bridge, Interlocked.Increment(ref nextDebugGeneration), log);
                // 先登记连接再启动读写线程：首帧（hello）回调里要能看到"自己已在列表"，
                // 否则单连接闸门与宽限换发会漏掉这条连接。
                lock (connectionsGate)
                {
                    connections.Add(connection);
                }

                connection.Bridge.Start();

                // 帧读取在 BridgeSocket 的读线程上回调；本线程只负责连接生命周期。
                connection.Closed.Wait();
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
                    if (connections.Count == 0)
                    {
                        // 宽限从这里起算（附录 A.8）：下一条连接在 15 s 内带 resumeSessionId 才能续接。
                        Interlocked.Exchange(ref lastDisconnectedAtTicks, utcNow().ToUniversalTime().Ticks);
                    }
                }

                ReleaseLeaseOnDisconnect(connection);
                connection.DebugLink?.NotifyClosed();
                CloseConnection(connection);
                connection.Bridge?.Dispose();
                connection.Closed.Dispose();
            }
        }

        /// <summary>
        /// 控制通道的逐帧分发：首帧必须 hello；之后只接受 request。
        /// 连接级错误回发 error 帧后闭合连接，请求级错误（unknownRequest）保留连接。
        /// </summary>
        private void HandleControlFrame(Connection connection, byte[] payload)
        {
            string text;
            try
            {
                text = Encoding.UTF8.GetString(payload);
            }
            catch (ArgumentException exception)
            {
                FailConnection(connection, "runtime.invalidJson", exception.Message);
                return;
            }

            JObject messageObject;
            try
            {
                messageObject = VisualBridgeRuntimeBridgeValidator.ParseObject(text, "runtime.invalidJson");
            }
            catch (VisualBridgeRuntimeBridgeException exception)
            {
                FailConnection(connection, "runtime.invalidJson", exception.Message);
                return;
            }

            VisualBridgeRuntimeBridgeMessage message;
            try
            {
                message = VisualBridgeRuntimeBridgeValidator.ValidateMessage(messageObject);
            }
            catch (VisualBridgeRuntimeBridgeException exception)
            {
                // 未知 action 是请求级错误（response error，连接保持），其余为连接级错误。
                if (exception.Code == "runtime.unknownRequest")
                {
                    var requestId = (messageObject["requestId"] as JValue)?.Value<string>();
                    if (requestId != null && !string.IsNullOrEmpty(requestId) && requestId.Length <= 128)
                    {
                        WriteLine(connection, VisualBridgeRuntimeBridgeValidator
                            .CreateResponseError(requestId, "runtime.unknownRequest", exception.Message)
                            .ToLine());
                        return;
                    }
                }

                FailConnection(connection, VisualBridgeRuntimeBridgeValidator.MapWireCode(exception.Code), exception.Message);
                return;
            }

            if (!connection.HelloCompleted)
            {
                HandleHello(connection, message);
                return;
            }

            if (message.Type != VisualBridgeRuntimeBridgeMessageType.Request)
            {
                FailConnection(connection, "runtime.unknownMessageType", "Only request messages are allowed after the handshake.");
                return;
            }

            if (message.Action == null)
            {
                // 校验器已保证已知 action；这里只是避免理论上的空引用。
                FailConnection(connection, "runtime.invalidMessage", "Request action is missing.");
                return;
            }

            HandleRequest(connection, message);
        }

        private void HandleHello(Connection connection, VisualBridgeRuntimeBridgeMessage hello)
        {
            if (hello.Type != VisualBridgeRuntimeBridgeMessageType.Hello)
            {
                FailConnection(connection, "runtime.unknownMessageType", "First message must be hello.");
                return;
            }

            // 令牌策略（附录 E.3）：Player 无认证；Editor Play 模式必须携带并匹配记录里的 token。
            if (!string.IsNullOrEmpty(token))
            {
                if (!string.Equals(hello.Token, token, StringComparison.Ordinal))
                {
                    FailConnection(connection, "runtime.invalidToken", "Token does not match the discovery record.");
                    return;
                }
            }

            // 单连接闸门（附录 A.2/E.3 的「一对一」）：Player 腿监听 0.0.0.0 且无认证，
            // 已有活跃连接时第二条一律 runtime.alreadyConnected 并保留第一条。
            // 单连接闸门（附录 A.2/E.3 的「一对一」）：Player 腿监听 0.0.0.0 且无认证，
            // 已有活跃连接时第二条一律 runtime.alreadyConnected 并保留第一条。
            // 占位在 connectionsGate 内完成，避免两条并发 hello 同时通过。
            bool alreadyConnected;
            lock (connectionsGate)
            {
                alreadyConnected = kind == "player" && HasOtherHandshakenConnectionLocked(connection);
                if (!alreadyConnected)
                {
                    connection.HelloCompleted = true;
                }
            }

            if (alreadyConnected)
            {
                FailConnection(
                    connection,
                    "runtime.alreadyConnected",
                    "Another client is already connected; the Player leg accepts one connection at a time.");
                return;
            }

            // 协议版本 4 隐含完整能力集（不再协商 capabilities）。
            connection.WantsEvents = true;
            connection.ClientInstanceId = hello.ClientEndpointId;

            // 续接判定（附录 A.3/A.8）：命中 resumeSessionId 且距上次断开不超过 15 s 才 resumed；
            // 超过宽限必须换发新的 bootId/sessionId，旧会话数据随之作废（绝不无限续接）。
            var now = utcNow().ToUniversalTime();
            var matched = hello.ResumeSessionId != null
                && string.Equals(hello.ResumeSessionId, sessionId, StringComparison.Ordinal);
            var lastDisconnected = LastDisconnectedAtUtc;
            // 没有断开记录 = 本端从未观察到会话消失（仍在宽限内）；有记录则必须 <= 15 s。
            var withinGrace = matched
                && (!lastDisconnected.HasValue
                    || now - lastDisconnected.Value <= TimeSpan.FromMilliseconds(ReconnectGraceMs));
            if (matched && lastDisconnected.HasValue && !withinGrace && HandshakenConnectionCount == 1)
            {
                RotateSession();
            }

            var welcome = VisualBridgeRuntimeBridgeValidator.CreateWelcome(
                instanceId, sessionId, bootId, withinGrace, ConnectTypeOf(kind), generation, contractHash,
                Payloads, DebugLinkEnabled, startedAtText);
            WriteLine(connection, welcome.ToLine());
            NotifyDebugLinkOpened(connection);
        }

        /// <summary>是否已有另一条完成握手的连接（当前连接除外）；调用方必须持有 connectionsGate。</summary>
        private bool HasOtherHandshakenConnectionLocked(Connection candidate)
        {
            foreach (var connection in connections)
            {
                if (connection != candidate && connection.HelloCompleted)
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// 宽限到期：换发新 bootId/sessionId 并清空旧会话数据（租约）。
        /// 没有活动连接时租约本应为空，这里显式清一遍，保证旧会话不留残余。
        /// </summary>
        private void RotateSession()
        {
            var previous = sessionId;
            bootId = Guid.NewGuid().ToString("N");
            sessionId = instanceId + "#" + bootId;
            lock (leaseGate)
            {
                leaseHolder = null;
            }

            log?.Invoke(
                $"[runtime-bridge] reconnect grace expired: session '{previous}' is no longer resumable; issued session '{sessionId}'.");
        }

        /// <summary>welcome.connectType：Editor Play 模式对外是 editor-player，独立 Player 是 player。</summary>
        private static string ConnectTypeOf(string instanceKind)
        {
            return instanceKind == "player" ? "player" : "editor-player";
        }

        /// <summary>握手完成后把调试通道交给宿主；处理器异常只记日志，不断开连接。</summary>
        private void NotifyDebugLinkOpened(Connection connection)
        {
            var handler = DebugLinkOpened;
            if (handler == null || connection.DebugLink == null)
            {
                return;
            }

            try
            {
                handler(connection.DebugLink);
            }
            catch (Exception exception)
            {
                log?.Invoke("[runtime-bridge] debug link handler failed: " + exception.Message);
            }
        }

        /// <summary>连接级错误：回发 error 帧后优雅闭合（确保错误帧先写完）。</summary>
        private static void FailConnection(Connection connection, string code, string detail)
        {
            SendError(connection, code, detail);
            CloseConnection(connection, flushPending: true);
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
                default:
                    SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
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
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
                    .CreateSnapshotResponseOk(request.RequestId, documents)
                    .ToLine());
            }
            catch (VisualBridgeRuntimeBridgeException exception)
            {
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.internalError", exception.Message)
                    .ToLine());
            }
            catch (Exception exception)
            {
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
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
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.leaseDenied", deniedDetail)
                    .ToLine());
                return;
            }

            SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
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
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, errorCode, detail)
                    .ToLine());
                return;
            }

            SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
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
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, errorCode, detail)
                    .ToLine());
                return;
            }

            try
            {
                var sources = VisualBridgeRuntimeArtifactStore.DocumentSources(artifactsRoot);
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
                    .CreateSourcesResponse(request.RequestId, sources)
                    .ToLine());
            }
            catch (Exception exception)
            {
                SendResponse(connection, request.RequestId, VisualBridgeRuntimeBridgeValidator
                    .CreateResponseError(request.RequestId, "runtime.internalError", exception.Message)
                    .ToLine());
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

                // 调试通道的节拍：传输层用它在无消息时也能按周期上报 dropped（附录 A.9）。
                List<Connection> current;
                lock (connectionsGate)
                {
                    current = new List<Connection>(connections);
                }

                foreach (var connection in current)
                {
                    connection.DebugLink?.NotifyTick();
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

        private static void SendError(Connection connection, string code, string detail)
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

        /// <summary>
        /// 发送请求级应答。超过 <see cref="VisualBridgeFraming.MaxMessageBytes"/> 的响应
        /// 不得静默忽略（那会让客户端一直等到超时）：回显明确的请求级错误。
        /// </summary>
        private static void SendResponse(Connection connection, string requestId, string line)
        {
            var bytes = Encoding.UTF8.GetByteCount(line);
            if (bytes > VisualBridgeFraming.MaxMessageBytes)
            {
                WriteLine(
                    connection,
                    VisualBridgeRuntimeBridgeValidator
                        .CreateResponseError(
                            requestId,
                            "runtime.internalError",
                            "Response is " + bytes + " bytes and exceeds MaxMessageBytes ("
                            + VisualBridgeFraming.MaxMessageBytes + "); narrow the request or raise the send limit.")
                        .ToLine());
                return;
            }

            WriteLine(connection, line);
        }

        private static bool WriteLine(Connection connection, string line)
        {
            var bridge = connection.Bridge;
            return bridge != null && bridge.SendControlJson(line);
        }

        /// <summary>
        /// 关闭连接。flushPending 为 true 时先让写线程把已入队的错误帧写完再断开，
        /// 避免「回发 error 后立即断连」把错误帧丢掉。
        /// </summary>
        private static void CloseConnection(Connection connection, bool flushPending = false)
        {
            try
            {
                if (flushPending && connection.Bridge != null)
                {
                    connection.Bridge.CloseGracefully(500);
                }
                else
                {
                    connection.Bridge?.Close();
                }
            }
            catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
            {
                // 桥接层可能已经关闭。
            }

            try
            {
                connection.Client.Close();
            }
            catch (SocketException)
            {
                // 已关闭。
            }
            catch (ObjectDisposedException)
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
}
