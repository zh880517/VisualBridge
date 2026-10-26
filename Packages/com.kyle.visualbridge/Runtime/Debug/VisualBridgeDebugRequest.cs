namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 一次反向查询的句柄（附录 B.2.3）。业务只读 <see cref="InstanceId"/>；
    /// 请求号、方法号、槽位与结果归属只供运行时与生成代码使用，因此保持 internal。
    /// </summary>
    public readonly struct VisualBridgeDebugRequest
    {
        // 生成的 Dispatcher 位于业务程序集，必须能构造句柄，所以构造函数是 public。
        public VisualBridgeDebugRequest(string instanceId, ushort instanceSlot, ushort methodId, uint requestSeq)
            : this(instanceId, instanceSlot, methodId, requestSeq, null, null, null)
        {
        }

        /// <summary>
        /// 携带结果归属的可选构造函数：D4 的查询运行期从请求信封拿到 category / iface / method 时可直接传入；
        /// 4 参路径（D2 生成的 Dispatcher）省略它们时，运行期会从已注册的 Dispatcher 反查方法名补齐。
        /// </summary>
        public VisualBridgeDebugRequest(string instanceId, ushort instanceSlot, ushort methodId, uint requestSeq,
            string category, string interfaceId, string method)
        {
            InstanceId = instanceId;
            InstanceSlot = instanceSlot;
            MethodId = methodId;
            RequestId = requestSeq;
            Category = category;
            InterfaceId = interfaceId;
            Method = method;
        }

        /// <summary>业务可读的实例 id。</summary>
        public string InstanceId { get; }

        internal ushort InstanceSlot { get; }

        internal ushort MethodId { get; }

        internal uint RequestId { get; }

        /// <summary>结果归属的分类；缺省时由槽位绑定的实例分类补齐。</summary>
        internal string Category { get; }

        /// <summary>结果归属的接口 id；缺省时从已注册 Dispatcher 的接口键补齐。</summary>
        internal string InterfaceId { get; }

        /// <summary>结果归属的方法名；缺省时从已注册 Dispatcher 的 TryGetMethodName 补齐。</summary>
        internal string Method { get; }

        internal bool IsValid
        {
            get { return !string.IsNullOrEmpty(InstanceId); }
        }
    }
}
