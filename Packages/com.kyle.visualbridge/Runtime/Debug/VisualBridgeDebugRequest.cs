namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 一次反向查询的句柄（附录 B.2）。业务只读 <see cref="InstanceId"/>；
    /// 请求号、方法号与槽位只供运行时与生成代码使用，因此保持 internal。
    /// </summary>
    public readonly struct VisualBridgeDebugRequest
    {
        // 生成的 Dispatcher 位于业务程序集，必须能构造句柄，所以构造函数是 public。
        public VisualBridgeDebugRequest(string instanceId, ushort instanceSlot, ushort methodId, uint requestSeq)
        {
            InstanceId = instanceId;
            InstanceSlot = instanceSlot;
            MethodId = methodId;
            RequestId = requestSeq;
        }

        /// <summary>业务可读的实例 id。</summary>
        public string InstanceId { get; }

        internal ushort InstanceSlot { get; }

        internal ushort MethodId { get; }

        internal uint RequestId { get; }

        internal bool IsValid
        {
            get { return !string.IsNullOrEmpty(InstanceId); }
        }
    }
}
