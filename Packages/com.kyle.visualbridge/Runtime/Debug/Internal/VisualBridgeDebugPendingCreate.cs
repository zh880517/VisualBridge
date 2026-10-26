namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 无连接时入队的实例描述（附录 B.3：连接建立后按入队顺序 flush 一次，发送后清空）。
    /// 待发队列只存 Create：Create 仍待发时 Finish 会直接撤销它，因此队列长度天然受实例上限约束。
    /// </summary>
    internal readonly struct VisualBridgeDebugPendingCreate
    {
        internal VisualBridgeDebugPendingCreate(string instanceId, string category, string resName, string debugInfo,
            ushort instanceSlot)
        {
            InstanceId = instanceId;
            Category = category;
            ResName = resName;
            DebugInfo = debugInfo;
            InstanceSlot = instanceSlot;
        }

        internal string InstanceId { get; }

        internal string Category { get; }

        internal string ResName { get; }

        internal string DebugInfo { get; }

        internal ushort InstanceSlot { get; }
    }
#endif
}
