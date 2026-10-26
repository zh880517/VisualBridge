namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 门面已接受、尚未 End 的一条消息上下文。
    /// 数据按值存在 Start 线程的 [ThreadStatic] 槽位里，避免 Start 热路径产生堆分配；其它线程读不到它，
    /// 跨线程 PushParam/End 会被判为跨线程调用并忽略（附录 B.2 的 Start→PushParam→End 同线程约束）。
    /// </summary>
    internal readonly struct VisualBridgeDebugMessage
    {
        internal VisualBridgeDebugMessage(VisualBridgeDebugMessageKind kind, ushort instanceSlot, ushort methodId,
            uint requestSeq, long frame, long connectionGeneration, string category, string iface, string method,
            IDebugMessageEncoder encoder)
        {
            Kind = kind;
            InstanceSlot = instanceSlot;
            MethodId = methodId;
            RequestSeq = requestSeq;
            Frame = frame;
            ConnectionGeneration = connectionGeneration;
            Category = category;
            Iface = iface;
            Method = method;
            Encoder = encoder;
        }

        internal VisualBridgeDebugMessageKind Kind { get; }

        internal ushort InstanceSlot { get; }

        internal ushort MethodId { get; }

        internal uint RequestSeq { get; }

        internal long Frame { get; }

        /// <summary>Start 时抓到的连接代次；End 用它判断这条消息是否跨了重连。</summary>
        internal long ConnectionGeneration { get; }

        /// <summary>
        /// Start 时绑定的编码器：整条消息的 Begin/PushParam/End 都用它，
        /// 中途 SetEncoder 只影响下一条消息（避免同一条消息落到两个编码器实现上）。
        /// </summary>
        internal IDebugMessageEncoder Encoder { get; }

        /// <summary>分类名，供传输层做 JSON 降级与诊断。</summary>
        internal string Category { get; }

        /// <summary>接口 id，供传输层做 JSON 降级与诊断。</summary>
        internal string Iface { get; }

        /// <summary>方法名，供传输层做 JSON 降级与诊断。</summary>
        internal string Method { get; }
    }

    internal enum VisualBridgeDebugMessageKind
    {
        /// <summary>Event 接口的普通事件。</summary>
        Event = 0,

        /// <summary>Query 接口的结果回发。</summary>
        Result,
    }
#endif
}
