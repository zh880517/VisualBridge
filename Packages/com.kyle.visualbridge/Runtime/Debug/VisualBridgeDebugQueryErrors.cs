namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 查询失败应答的错误码（附录 A.6）。清单在 <c>Protocol/contract-manifest.json</c> 的
    /// <c>errors.debugQuery</c>，由 <c>check:protocol</c> 与本类及客户端解码表三方核对。
    /// 运行期只产出这六个码：业务实现用 <see cref="VisualBridgeDebug.RejectRequest"/> 拒绝时只带 detail，
    /// 码由传输层按失败应答补齐。
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
        /// 业务拒绝（附录 A.6，E6 登记）：三条路径都回这个码——业务实现用
        /// <see cref="VisualBridgeDebug.RejectRequest"/> 主动拒绝、生成的 Dispatcher 捕获业务异常后拒绝、
        /// handler 返回 false 且未回发结果（含非生成处理器抛异常，由运行期兜底）。可机器区分的原因在
        /// <c>detail</c>：`handler-returned-false`、`handler-exception: &lt;类型名&gt;`、或业务自定义原因。
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
