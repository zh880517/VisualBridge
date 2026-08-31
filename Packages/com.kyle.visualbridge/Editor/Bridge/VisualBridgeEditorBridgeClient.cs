using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public enum VisualBridgeBridgeConnectionState
    {
        Disconnected,
        Connecting,
        Connected,
    }

    /// <summary>
    /// Unity 侧 Editor Bridge 客户端。一个实例持有一条到单个 VS Code 窗口的连接。
    /// V1 协议是严格的请求/响应模型，因此全部流 I/O 在调用方线程上同步执行：
    /// Unity Mono 运行时在 NamedPipeClientStream 上用共享锁串行化并发 Read/Write，
    /// 排除了后台读线程的方案（2026-08-30 实测）。优先使用回环 TCP，因为
    /// NetworkStream 支持读超时；命名管道端点保留为回退。
    /// </summary>
    public sealed class VisualBridgeEditorBridgeClient : IDisposable
    {
        private const int ConnectTimeoutMs = 3000;

        private readonly VisualBridgeBridgeWindow window;
        private readonly string clientInstanceId;
        private readonly List<string> requestedCapabilities;
        private readonly object ioLock = new object();
        private readonly StringBuilder lineBuffer = new StringBuilder();
        private readonly byte[] readBuffer = new byte[8192];

        private Stream stream;
        private TcpClient tcpClient;

        public VisualBridgeEditorBridgeClient(VisualBridgeBridgeWindow window, string clientInstanceId, IEnumerable<string> requestedCapabilities)
        {
            this.window = window ?? throw new ArgumentNullException(nameof(window));
            this.clientInstanceId = clientInstanceId ?? throw new ArgumentNullException(nameof(clientInstanceId));
            this.requestedCapabilities = new List<string>(requestedCapabilities ?? throw new ArgumentNullException(nameof(requestedCapabilities)));
        }

        public VisualBridgeBridgeConnectionState State { get; private set; }

        public VisualBridgeBridgeWindow Window => window;

        public IReadOnlyList<string> ServerCapabilities { get; private set; }

        public string ClientInstanceId => clientInstanceId;

        /// <summary>
        /// 连接窗口的 TCP 端点（Windows 下命名管道回退），完成 hello/welcome
        /// 握手并校验服务端 generation 与发现记录一致。
        /// </summary>
        public VisualBridgeBridgeMessage Connect(int timeoutMs = ConnectTimeoutMs)
        {
            if (State != VisualBridgeBridgeConnectionState.Disconnected)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.connectionFailed", "$", "Client is already connected or connecting.");
            }

            State = VisualBridgeBridgeConnectionState.Connecting;
            try
            {
                stream = OpenTransport(timeoutMs);
                ApplyReadTimeout(stream, timeoutMs);

                var hello = VisualBridgeEditorBridgeValidator.CreateHello(clientInstanceId, window.Token, requestedCapabilities);
                Write(hello.ToLine());

                var reply = ReadMessage(timeoutMs);
                if (reply.Type == VisualBridgeBridgeMessageType.Error)
                {
                    throw VisualBridgeEditorBridgeValidator.Error(
                        reply.ErrorCode,
                        "$",
                        reply.ErrorDetail ?? "Server rejected the connection.");
                }

                if (reply.Type != VisualBridgeBridgeMessageType.Welcome)
                {
                    throw VisualBridgeEditorBridgeValidator.Error(
                        "bridge.protocolViolation",
                        "$.type",
                        $"Expected a welcome message, received '{reply.Type}'.");
                }

                if (reply.ServerGeneration != window.Generation)
                {
                    throw VisualBridgeEditorBridgeValidator.Error(
                        "bridge.staleGeneration",
                        "$.serverGeneration",
                        $"Server generation {reply.ServerGeneration} does not match discovery record generation {window.Generation}; the record is stale.");
                }

                ServerCapabilities = reply.Capabilities;
                State = VisualBridgeBridgeConnectionState.Connected;
                // 保留 welcome 行之后已缓冲的字节：服务端可能紧随其后发送连接级错误。
                return reply;
            }
            catch
            {
                Close();
                throw;
            }
        }

        /// <summary>
        /// 发送 open 或 reveal 请求并等待配对的响应。
        /// </summary>
        public VisualBridgeBridgeMessage SendRequest(VisualBridgeBridgeMessage request, int timeoutMs)
        {
            if (State != VisualBridgeBridgeConnectionState.Connected)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Client is not connected.");
            }

            if (request.Type != VisualBridgeBridgeMessageType.Open && request.Type != VisualBridgeBridgeMessageType.Reveal)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.invalidMessage", "$.type", "Only open and reveal requests can be sent.");
            }

            if (request.RequestId == null)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.invalidMessage", "$.requestId", "Request requires a request id.");
            }

            var capability = request.Type == VisualBridgeBridgeMessageType.Open ? "open" : "reveal";
            if (!ServerCapabilities.Contains(capability, StringComparer.Ordinal))
            {
                throw VisualBridgeEditorBridgeValidator.Error(
                    "bridge.capabilityMissing",
                    "$.type",
                    $"Window '{window.WindowId}' does not advertise the '{capability}' capability.");
            }

            lock (ioLock)
            {
                Write(request.ToLine());
                while (true)
                {
                    var message = ReadMessage(timeoutMs);
                    if (message.Type == VisualBridgeBridgeMessageType.Error)
                    {
                        throw VisualBridgeEditorBridgeValidator.Error(
                            message.ErrorCode,
                            "$",
                            message.ErrorDetail ?? "Server reported a connection-level error.");
                    }

                    if (message.Type == VisualBridgeBridgeMessageType.Response)
                    {
                        if (!string.Equals(message.RequestId, request.RequestId, StringComparison.Ordinal))
                        {
                            throw VisualBridgeEditorBridgeValidator.Error(
                                "bridge.invalidMessage",
                                "$.requestId",
                                $"Server responded to unknown request '{message.RequestId}'.");
                        }

                        return message;
                    }

                    throw VisualBridgeEditorBridgeValidator.Error(
                        "bridge.protocolViolation",
                        "$.type",
                        $"Server must not send '{message.Type}' messages in response to a request.");
                }
            }
        }

        public void Dispose()
        {
            Close();
        }

        public void Close()
        {
            State = VisualBridgeBridgeConnectionState.Disconnected;
            try
            {
                stream?.Dispose();
            }
            catch (IOException)
            {
                // 流可能已被远端拆除。
            }

            try
            {
                tcpClient?.Dispose();
            }
            catch (SocketException)
            {
                // 套接字可能已经关闭。
            }

            stream = null;
            tcpClient = null;
        }

        private Stream OpenTransport(int timeoutMs)
        {
            Exception tcpFailure;
            try
            {
                return OpenTcp(window.TcpPort, timeoutMs);
            }
            catch (Exception exception)
            {
                tcpFailure = exception;
            }

            if (Environment.OSVersion.Platform == PlatformID.Win32NT && !string.IsNullOrEmpty(window.PipePath))
            {
                try
                {
                    return OpenPipe(window.PipePath, timeoutMs);
                }
                catch (Exception pipeFailure)
                {
                    throw VisualBridgeEditorBridgeValidator.Error(
                        "bridge.connectionFailed",
                        "$",
                        $"Failed to connect to window '{window.WindowId}' over TCP ({tcpFailure.Message}) and pipe ({pipeFailure.Message}).");
                }
            }

            throw VisualBridgeEditorBridgeValidator.Error(
                "bridge.connectionFailed",
                "$",
                $"Failed to connect to window '{window.WindowId}' over TCP: {tcpFailure.Message}");
        }

        private Stream OpenTcp(int port, int timeoutMs)
        {
            var client = new TcpClient();
            try
            {
                var async = client.BeginConnect("127.0.0.1", port, null, null);
                if (!async.AsyncWaitHandle.WaitOne(timeoutMs))
                {
                    throw VisualBridgeEditorBridgeValidator.Error("bridge.connectionFailed", "$", "TCP connect timed out.");
                }

                client.EndConnect(async);
                var networkStream = client.GetStream();
                networkStream.ReadTimeout = timeoutMs;
                networkStream.WriteTimeout = timeoutMs;
                tcpClient = client;
                return networkStream;
            }
            catch
            {
                client.Dispose();
                throw;
            }
        }

        private static Stream OpenPipe(string pipePath, int timeoutMs)
        {
            const string prefix = @"\\.\pipe\";
            var pipeName = pipePath.StartsWith(prefix, StringComparison.Ordinal) ? pipePath.Substring(prefix.Length) : pipePath;
            var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
            try
            {
                client.Connect(timeoutMs);
                return client;
            }
            catch
            {
                client.Dispose();
                throw;
            }
        }

        private static void ApplyReadTimeout(Stream target, int timeoutMs)
        {
            // 命名管道流不支持读超时；TCP 流在 OpenTcp 时已携带超时。
            // 管道回退用读超时换取传输可用性，靠连接重置失败。
            if (target is NetworkStream)
            {
                target.ReadTimeout = timeoutMs;
            }
        }

        private void Write(string line)
        {
            var bytes = Encoding.UTF8.GetBytes(line + "\n");
            var target = stream;
            if (target == null)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection closed.");
            }

            try
            {
                target.Write(bytes, 0, bytes.Length);
                target.Flush();
            }
            catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection failed while writing: " + exception.Message);
            }
        }

        private VisualBridgeBridgeMessage ReadMessage(int timeoutMs)
        {
            while (true)
            {
                var newline = lineBuffer.ToString().IndexOf('\n');
                if (newline >= 0)
                {
                    var line = lineBuffer.ToString(0, newline);
                    lineBuffer.Remove(0, newline + 1);
                    if (line.Trim().Length == 0)
                    {
                        continue;
                    }

                    return ParseLine(line);
                }

                var target = stream;
                if (target == null)
                {
                    throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection closed.");
                }

                int read;
                try
                {
                    read = target.Read(readBuffer, 0, readBuffer.Length);
                }
                catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException)
                {
                    throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection failed while reading: " + exception.Message);
                }

                if (read == 0)
                {
                    throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection closed by the server.");
                }

                lineBuffer.Append(Encoding.UTF8.GetString(readBuffer, 0, read));
            }
        }

        private static VisualBridgeBridgeMessage ParseLine(string line)
        {
            JObject value;
            try
            {
                using (var stringReader = new StringReader(line))
                using (var reader = new Newtonsoft.Json.JsonTextReader(stringReader))
                {
                    reader.DateParseHandling = Newtonsoft.Json.DateParseHandling.None;
                    reader.FloatParseHandling = Newtonsoft.Json.FloatParseHandling.Decimal;
                    value = JObject.Load(reader);
                }
            }
            catch
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.invalidJson", "$", "Server sent a non-JSON line.");
            }

            return VisualBridgeEditorBridgeValidator.ValidateMessage(value);
        }
    }
}
