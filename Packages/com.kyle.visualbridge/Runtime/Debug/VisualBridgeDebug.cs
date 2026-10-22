using System;
using System.Collections.Generic;
using System.Threading;

namespace VisualBridge.Debug
{
    /// <summary>调试通道运行时门面；生成代码只调用这里。</summary>
    public static class VisualBridgeDebug
    {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
        public const bool isDebugBuild = true;
#else
        public const bool isDebugBuild = false;
#endif

        private static readonly VisualBridgeDebugCounters s_counters = new VisualBridgeDebugCounters();

        /// <summary>运行时计数器。</summary>
        public static VisualBridgeDebugCounters Counters
        {
            get { return s_counters; }
        }

#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
        private static readonly VisualBridgeDebugQueue s_queue = new VisualBridgeDebugQueue(s_counters);
        private static readonly VisualBridgeDebugRegistry s_registry = new VisualBridgeDebugRegistry();
        private static readonly IDebugFramer s_defaultFramer = new NdjsonFramer();
        private static readonly object s_transportGate = new object();

        private static volatile IDebugFramer s_framer = s_defaultFramer;
        private static volatile bool s_isConnected;
        private static volatile bool s_writeFailed;
        private static IDebugTransport s_transport;
        private static Action<bool> s_connectionHandler;

        /// <summary>仅在已连接且有可用传输时为 true。</summary>
        public static bool isConnected
        {
            get { return s_isConnected; }
        }

        /// <summary>当前运行环境。</summary>
        public static VisualBridgeConnectType ConnectType
        {
            get
            {
                if (UnityEngine.Application.isEditor)
                {
                    return UnityEngine.Application.isPlaying
                        ? VisualBridgeConnectType.EditorPlayer
                        : VisualBridgeConnectType.Editor;
                }

                return VisualBridgeConnectType.Player;
            }
        }

        /// <summary>上报实例显示名与筛选关键词；空实例忽略。</summary>
        public static void DescribeInstance(string category, string instance, string label, params string[] keywords)
        {
            if (!s_isConnected || string.IsNullOrEmpty(instance))
            {
                return;
            }

            var header = new DebugMessageHeader(
                DebugMessageKind.Instance,
                category,
                instance,
                0,
                null,
                null,
                null,
                0,
                -1);
            SendMessage(header, new DebugInstanceBody(label ?? string.Empty, NormalizeKeywords(keywords)));
        }

        /// <summary>开始一条消息；requestId 非空表示查询结果。</summary>
        public static void Start(
            string category,
            int version,
            string iface,
            string method,
            string instance = "",
            string requestId = null,
            long frame = -1)
        {
            if (!s_isConnected)
            {
                return;
            }

            DebugMessageBuilder builder = DebugMessageBuilder.Current;
            if (builder.Begin(category, version, iface, method, instance, requestId, frame))
            {
                Interlocked.Increment(ref s_counters.malformed);
#if UNITY_EDITOR
                UnityEngine.Debug.LogError(
                    "[visualbridge] 上一条调试消息尚未 End 就再次 Start，已丢弃上一条。");
#endif
            }
        }

        public static void PushParam(string name, int tag, bool value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.Bool, value));
            }
        }

        public static void PushParam(string name, int tag, int value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.Int32, value));
            }
        }

        public static void PushParam(string name, int tag, long value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.Int64, value));
            }
        }

        public static void PushParam(string name, int tag, ulong value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.UInt64, value));
            }
        }

        public static void PushParam(string name, int tag, float value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.Single, value));
            }
        }

        public static void PushParam(string name, int tag, double value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.Double, value));
            }
        }

        public static void PushParam(string name, int tag, Enum value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.Enum, value));
            }
        }

        public static void PushParam(string name, int tag, string value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.String, value));
            }
        }

        public static void PushParam(string name, int tag, byte[] value)
        {
            DebugMessageBuilder builder = CurrentBuilderForPush();
            if (builder != null)
            {
                builder.Add(new DebugArgValue(name, tag, DebugValueKind.Bytes, value));
            }
        }

        /// <summary>结束当前消息并入队。</summary>
        public static void End()
        {
            if (!s_isConnected)
            {
                return;
            }

            DebugMessageBuilder builder = DebugMessageBuilder.Current;
            if (!builder.IsBuilding)
            {
                Interlocked.Increment(ref s_counters.filtered);
                return;
            }

            DebugArgsBody body;
            DebugMessageHeader header = builder.End(out body);
            SendMessage(header, body);
        }

        /// <summary>替换成帧器；null 恢复默认 NDJSON。</summary>
        public static void SetFramer(IDebugFramer framer)
        {
            s_framer = framer ?? s_defaultFramer;
        }

        /// <summary>登记接口的请求处理器；重复登记以最后一次为准。</summary>
        public static void RegisterRequestHandler(string iface, Action<VisualBridgeDebugRequest> handler)
        {
            if (string.IsNullOrEmpty(iface) || handler == null)
            {
                return;
            }

            if (s_registry.Register(iface, handler))
            {
                UnityEngine.Debug.LogWarning(
                    "[visualbridge] 接口 " + iface + " 的调试请求处理器重复注册，已使用最后一次注册。");
            }
        }

        /// <summary>移除接口的请求处理器。</summary>
        public static void UnregisterRequestHandler(string iface)
        {
            if (string.IsNullOrEmpty(iface))
            {
                return;
            }

            s_registry.Unregister(iface);
        }

        /// <summary>分发入站查询；未登记或处理器异常时回一条结果消息。</summary>
        public static void OnRequest(VisualBridgeDebugRequest request)
        {
            Action<VisualBridgeDebugRequest> handler = null;
            bool found = request.Interface != null && s_registry.TryGet(request.Interface, out handler);
            if (!found || handler == null)
            {
                SendResult(request, "unregistered");
                return;
            }

            try
            {
                handler(request);
            }
            catch (Exception)
            {
                Interlocked.Increment(ref s_counters.handlerErrors);
                SendResult(request, "handlerError");
            }
        }

        /// <summary>查询参数不合法时回一条结果消息。</summary>
        public static void OnRequestArgumentError(VisualBridgeDebugRequest request)
        {
            SendResult(request, "invalidArgument");
        }

        /// <summary>绑定传输并启动写线程。</summary>
        public static void Attach(IDebugTransport transport)
        {
            if (transport == null)
            {
                return;
            }

            lock (s_transportGate)
            {
                if (ReferenceEquals(s_transport, transport))
                {
                    // 同一传输重新 Attach：写线程异常后可借此恢复。
                    s_writeFailed = false;
                    s_isConnected = transport.IsConnected;
                    s_queue.StartWriter(SendBatchCore, HandleWriteError);
                    return;
                }

                DetachCore();

                s_transport = transport;
                s_writeFailed = false;
                s_connectionHandler = connected => HandleConnectionChanged(transport);
                transport.ConnectionChanged += s_connectionHandler;
                s_isConnected = transport.IsConnected;
                s_queue.StartWriter(SendBatchCore, HandleWriteError);
            }
        }

        /// <summary>冲刷队列、停止写线程并释放传输；可重复调用。</summary>
        public static void Detach()
        {
            lock (s_transportGate)
            {
                DetachCore();
            }
        }

        /// <summary>由传输宿主在手动启动时调用；本任务未接入。</summary>
        public static void StartTransport()
        {
        }

        /// <summary>由传输宿主在手动停止时调用；本任务未接入。</summary>
        public static void StopTransport()
        {
        }

        private static DebugMessageBuilder CurrentBuilderForPush()
        {
            if (!s_isConnected)
            {
                return null;
            }

            DebugMessageBuilder builder = DebugMessageBuilder.Current;
            if (!builder.IsBuilding)
            {
                Interlocked.Increment(ref s_counters.filtered);
                return null;
            }

            return builder;
        }

        private static void SendMessage(DebugMessageHeader header, IDebugMessageBody body)
        {
            if (!s_isConnected)
            {
                return;
            }

            IDebugFramer framer = s_framer;
            try
            {
                s_queue.Enqueue(seq =>
                {
                    var withSeq = new DebugMessageHeader(
                        header.Kind,
                        header.Category,
                        header.Instance,
                        header.Version,
                        header.Interface,
                        header.Method,
                        header.RequestId,
                        seq,
                        header.Frame);
                    return framer.Frame(withSeq, body);
                });
            }
            catch (VisualBridgeDebugProtocolException)
            {
                Interlocked.Increment(ref s_counters.oversize);
            }
            catch (Exception)
            {
                Interlocked.Increment(ref s_counters.malformed);
            }
        }

        private static void SendResult(VisualBridgeDebugRequest request, string error)
        {
            var args = new[]
            {
                new DebugArgValue("error", 0, DebugValueKind.String, error),
            };
            var header = new DebugMessageHeader(
                DebugMessageKind.DebugResult,
                request.Category,
                request.Instance,
                request.Version,
                request.Interface,
                request.Method,
                request.RequestId,
                0,
                -1);
            SendMessage(header, new DebugArgsBody(args));
        }

        private static string[] NormalizeKeywords(string[] keywords)
        {
            if (keywords == null || keywords.Length == 0)
            {
                return Array.Empty<string>();
            }

            const int maxKeywords = 16;
            const int maxLength = 64;
            var result = new List<string>(Math.Min(keywords.Length, maxKeywords));
            for (int i = 0; i < keywords.Length && result.Count < maxKeywords; i++)
            {
                string keyword = keywords[i];
                if (keyword == null)
                {
                    continue;
                }

                result.Add(keyword.Length > maxLength ? keyword.Substring(0, maxLength) : keyword);
            }

            return result.ToArray();
        }

        private static void SendBatchCore(IReadOnlyList<byte[]> payloads)
        {
            IDebugTransport transport = s_transport;
            if (transport != null)
            {
                transport.SendBatch(payloads);
            }
        }

        private static void HandleConnectionChanged(IDebugTransport source)
        {
            lock (s_transportGate)
            {
                if (!ReferenceEquals(s_transport, source))
                {
                    return;
                }

                bool connected = source.IsConnected;
                if (!connected)
                {
                    s_writeFailed = false;
                    s_queue.Clear();
                }

                s_isConnected = connected && !s_writeFailed;
            }
        }

        private static void HandleWriteError()
        {
            s_writeFailed = true;
            s_isConnected = false;
        }

        private static void DetachCore()
        {
            IDebugTransport transport = s_transport;
            s_isConnected = false;
            s_writeFailed = false;

            Action<bool> handler = s_connectionHandler;
            s_connectionHandler = null;
            if (transport != null && handler != null)
            {
                try
                {
                    transport.ConnectionChanged -= handler;
                }
                catch
                {
                    // 忽略取消订阅失败。
                }
            }

            // 先冲刷再清空 s_transport，否则写线程的补发会落到空传输。
            s_queue.StopWriter(100);
            s_transport = null;

            if (transport == null)
            {
                return;
            }

            try
            {
                transport.Dispose();
            }
            catch
            {
                // 释放失败不影响门面状态。
            }
        }
#else
        /// <summary>宏关闭时恒为 false。</summary>
        public static bool isConnected
        {
            get { return false; }
        }

        /// <summary>宏关闭时恒为 Player。</summary>
        public static VisualBridgeConnectType ConnectType
        {
            get { return VisualBridgeConnectType.Player; }
        }

        public static void DescribeInstance(string category, string instance, string label, params string[] keywords)
        {
        }

        public static void Start(
            string category,
            int version,
            string iface,
            string method,
            string instance = "",
            string requestId = null,
            long frame = -1)
        {
        }

        public static void PushParam(string name, int tag, bool value)
        {
        }

        public static void PushParam(string name, int tag, int value)
        {
        }

        public static void PushParam(string name, int tag, long value)
        {
        }

        public static void PushParam(string name, int tag, ulong value)
        {
        }

        public static void PushParam(string name, int tag, float value)
        {
        }

        public static void PushParam(string name, int tag, double value)
        {
        }

        public static void PushParam(string name, int tag, Enum value)
        {
        }

        public static void PushParam(string name, int tag, string value)
        {
        }

        public static void PushParam(string name, int tag, byte[] value)
        {
        }

        public static void End()
        {
        }

        public static void SetFramer(IDebugFramer framer)
        {
        }

        public static void RegisterRequestHandler(string iface, Action<VisualBridgeDebugRequest> handler)
        {
        }

        public static void UnregisterRequestHandler(string iface)
        {
        }

        public static void OnRequest(VisualBridgeDebugRequest request)
        {
        }

        public static void OnRequestArgumentError(VisualBridgeDebugRequest request)
        {
        }

        public static void Attach(IDebugTransport transport)
        {
        }

        public static void Detach()
        {
        }

        public static void StartTransport()
        {
        }

        public static void StopTransport()
        {
        }
#endif
    }
}
