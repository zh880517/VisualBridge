namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 查询失败应答的错误码（附录 A.6）。运行期只产出这五个码：业务实现用
    /// <see cref="VisualBridgeDebug.RejectRequest"/> 拒绝时只带 detail，码由传输层按失败应答补齐。
    /// </summary>
    public static class VisualBridgeDebugQueryErrors
    {
        /// <summary>队列或并发超限（附录 B.6：队列 8 / 并发 8）。</summary>
        public const string Busy = "runtime.queryBusy";

        /// <summary>排队 2000 ms 或执行 3000 ms 超时；该请求作废，晚到结果丢弃。</summary>
        public const string Timeout = "runtime.queryTimeout";

        /// <summary>分类内没有注册对应接口的处理器。</summary>
        public const string Unregistered = "runtime.queryUnregistered";

        /// <summary>实例未创建或已结束。</summary>
        public const string InstanceNotFound = "runtime.instanceNotFound";

        /// <summary>请求信封、槽位或参数不合法。</summary>
        public const string InvalidArgument = "runtime.invalidArgument";

        /// <summary>
        /// 业务拒绝（<see cref="VisualBridgeDebug.RejectRequest"/>）：A.6 尚未登记该码，
        /// 由 E6 补登；先收敛成常量，避免传输层与文档两处漂移。
        /// </summary>
        public const string Rejected = "runtime.queryRejected";

        /// <summary>把入队状态翻译成错误码；<see cref="VisualBridgeDebugQueryStatus.Accepted"/> 返回 null。</summary>
        public static string ToCode(VisualBridgeDebugQueryStatus status)
        {
            switch (status)
            {
                case VisualBridgeDebugQueryStatus.QueueFull:
                case VisualBridgeDebugQueryStatus.ConcurrencyLimited:
                    return Busy;
                case VisualBridgeDebugQueryStatus.Unregistered:
                    return Unregistered;
                case VisualBridgeDebugQueryStatus.InstanceNotFound:
                    return InstanceNotFound;
                case VisualBridgeDebugQueryStatus.InvalidArgument:
                    return InvalidArgument;
                default:
                    return null;
            }
        }
    }
}
