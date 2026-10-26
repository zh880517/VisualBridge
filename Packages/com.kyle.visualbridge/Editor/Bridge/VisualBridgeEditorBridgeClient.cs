using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using Newtonsoft.Json.Linq;
using VisualBridge.Runtime;

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
    /// 线上格式为统一协议的 6 字节帧头（控制通道承载 JSON 消息）；命名管道端点
    /// 已删除，只保留回环 TCP。V1 协议是严格的请求/响应模型，因此全部流 I/O 在
    /// 调用方线程上同步执行。
    /// </summary>
    public sealed class VisualBridgeEditorBridgeClient : IDisposable
    {
        private const int ConnectTimeoutMs = 3000;

        private readonly VisualBridgeBridgeWindow window;
        private readonly string clientInstanceId;
        private readonly List<string> requestedCapabilities;
        private readonly object ioLock = new object();
        private readonly VisualBridgeFrameReader frameReader = new VisualBridgeFrameReader();
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
        /// 连接窗口的 TCP 端点，完成 hello/welcome 握手并校验服务端 generation
        /// 与发现记录一致。
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
            try
            {
                return OpenTcp(window.TcpPort, timeoutMs);
            }
            catch (Exception tcpFailure)
            {
                throw VisualBridgeEditorBridgeValidator.Error(
                    "bridge.connectionFailed",
                    "$",
                    $"Failed to connect to window '{window.WindowId}' over TCP: {tcpFailure.Message}");
            }
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

        private static void ApplyReadTimeout(Stream target, int timeoutMs)
        {
            // 只保留 TCP 端点；NetworkStream 支持读超时。
            if (target is NetworkStream)
            {
                target.ReadTimeout = timeoutMs;
            }
        }

        private void Write(string line)
        {
            var bytes = Encoding.UTF8.GetBytes(line);
            var frame = VisualBridgeFraming.EncodeFrame(
                VisualBridgeChannel.Editor, VisualBridgePayloadKind.Json, bytes);
            var target = stream;
            if (target == null)
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection closed.");
            }

            try
            {
                target.Write(frame, 0, frame.Length);
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
                VisualBridgeFrame frame;
                try
                {
                    if (frameReader.TryReadFrame(out frame))
                    {
                        // 编辑器连接当前只消费控制通道；调试通道帧留给统一协议阶段。
                        if (frame.Channel != VisualBridgeChannel.Editor)
                        {
                            continue;
                        }

                        return ParsePayload(frame.Payload);
                    }
                }
                catch (VisualBridgeFrameException exception)
                {
                    frameReader.DiscardPending();
                    throw VisualBridgeEditorBridgeValidator.Error(
                        "bridge.protocolViolation",
                        "$",
                        "Connection framing failed: " + exception.Message);
                }

                var target = stream;
                if (target == null)
                {
                    frameReader.DiscardPending();
                    throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection closed.");
                }

                int read;
                try
                {
                    read = target.Read(readBuffer, 0, readBuffer.Length);
                }
                catch (Exception exception) when (exception is IOException || exception is ObjectDisposedException || exception is SocketException)
                {
                    frameReader.DiscardPending();
                    throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection failed while reading: " + exception.Message);
                }

                if (read == 0)
                {
                    frameReader.DiscardPending();
                    throw VisualBridgeEditorBridgeValidator.Error("bridge.disconnected", "$", "Connection closed by the server.");
                }

                frameReader.Append(readBuffer, 0, read);
            }
        }

        private static VisualBridgeBridgeMessage ParsePayload(byte[] payload)
        {
            JObject value;
            try
            {
                var text = Encoding.UTF8.GetString(payload);
                using (var stringReader = new StringReader(text))
                using (var reader = new Newtonsoft.Json.JsonTextReader(stringReader))
                {
                    reader.DateParseHandling = Newtonsoft.Json.DateParseHandling.None;
                    reader.FloatParseHandling = Newtonsoft.Json.FloatParseHandling.Decimal;
                    value = JObject.Load(reader);
                }
            }
            catch
            {
                throw VisualBridgeEditorBridgeValidator.Error("bridge.invalidJson", "$", "Server sent a non-JSON payload.");
            }

            return VisualBridgeEditorBridgeValidator.ValidateMessage(value);
        }
    }
}
