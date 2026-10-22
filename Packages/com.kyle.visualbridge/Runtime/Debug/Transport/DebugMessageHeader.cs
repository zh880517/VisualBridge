namespace VisualBridge.Diagnostics
{
    /// <summary>调试消息头。</summary>
    public readonly struct DebugMessageHeader
    {
        public DebugMessageHeader(
            DebugMessageKind kind,
            string category,
            string instance,
            int version,
            string iface,
            string method,
            string requestId,
            long seq,
            long frame)
        {
            Kind = kind;
            Category = category;
            Instance = instance;
            Version = version;
            Interface = iface;
            Method = method;
            RequestId = requestId;
            Seq = seq;
            Frame = frame;
        }

        /// <summary>消息类型。</summary>
        public DebugMessageKind Kind { get; }

        /// <summary>接口类别。</summary>
        public string Category { get; }

        /// <summary>调试实例标识。</summary>
        public string Instance { get; }

        /// <summary>接口版本。</summary>
        public int Version { get; }

        /// <summary>接口全名。</summary>
        public string Interface { get; }

        /// <summary>方法名。</summary>
        public string Method { get; }

        /// <summary>查询请求标识；仅 DebugResult 使用。</summary>
        public string RequestId { get; }

        /// <summary>消息序号。</summary>
        public long Seq { get; }

        /// <summary>帧号；-1 表示无帧号。</summary>
        public long Frame { get; }
    }
}
