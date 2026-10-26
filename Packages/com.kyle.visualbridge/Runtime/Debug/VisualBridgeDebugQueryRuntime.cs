namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 查询运行期的宿主入口（附录 B.6）：传输层把解析好的 <see cref="VisualBridgeDebugQueryRequest"/>
    /// 交给 <see cref="TryEnqueue"/>（可在 socket 读线程），主线程每帧调用一次 <see cref="Pump"/>。
    /// pump 的挂接不在本程序集：Player / Play 模式用 <c>PlayerLoop</c> 的 Update（BeforeSceneLoad 注册），
    /// Editor 非播放态用 <c>EditorApplication.update</c>，domain reload 后重新挂接（E5）。
    /// </summary>
    public static class VisualBridgeDebugQueryRuntime
    {
        // 四个常量与 VisualBridgeDebugQueryQueue 的内部常量一一对应（附录 B.6 的唯一口径）；
        // 分开声明是因为宏关闭时队列类型不参与编译，而宿主仍可能读这些常量做预算。

        /// <summary>排队上限 8（满则立即 <c>runtime.queryBusy</c>，不入队）。</summary>
        public const int MaxQueuedRequests = 8;

        /// <summary>并发（在途）上限 8。</summary>
        public const int MaxConcurrentRequests = 8;

        /// <summary>排队超时 2000 ms。</summary>
        public const int QueueTimeoutMilliseconds = 2000;

        /// <summary>执行超时 3000 ms。</summary>
        public const int ExecutionTimeoutMilliseconds = 3000;

        /// <summary>
        /// 校验并入队；返回非 <see cref="VisualBridgeDebugQueryStatus.Accepted"/> 时已按附录 A.6 回失败应答
        /// （<see cref="VisualBridgeDebugQueryStatus.Unavailable"/> 除外，此时没有可回应的通道）。
        /// </summary>
        public static VisualBridgeDebugQueryStatus TryEnqueue(VisualBridgeDebugQueryRequest request)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            var status = VisualBridgeDebugQueryQueue.Enqueue(request);
            if (status != VisualBridgeDebugQueryStatus.Accepted &&
                status != VisualBridgeDebugQueryStatus.Unavailable &&
                request != null && request.RequestSeq != 0u)
            {
                VisualBridgeDebugSession.SendQueryError(request.RequestSeq,
                    VisualBridgeDebugQueryErrors.ToCode(status), Detail(status));
            }

            return status;
#else
            return VisualBridgeDebugQueryStatus.Unavailable;
#endif
        }

        /// <summary>
        /// 主线程每帧最多执行一条请求；返回本次执行的条数（0 或 1）。
        /// 调用方必须保证同一线程（Player / Play 模式的 PlayerLoop.Update，Editor 非播放态的 EditorApplication.update）。
        /// </summary>
        public static int Pump()
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugQueryQueue.Pump();
#else
            return 0;
#endif
        }

        /// <summary>读取队列 / 并发 / 超时 / 丢弃计数快照（业务不可见）。</summary>
        public static VisualBridgeDebugQueryMetrics GetMetrics()
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugQueryQueue.GetMetrics();
#else
            return default;
#endif
        }

#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
        private static string Detail(VisualBridgeDebugQueryStatus status)
        {
            switch (status)
            {
                case VisualBridgeDebugQueryStatus.QueueFull:
                    return "queue full: " + MaxQueuedRequests;
                case VisualBridgeDebugQueryStatus.ConcurrencyLimited:
                    return "concurrency limit: " + MaxConcurrentRequests;
                case VisualBridgeDebugQueryStatus.Unregistered:
                    return "no handler registered for category/interface";
                case VisualBridgeDebugQueryStatus.InstanceNotFound:
                    return "instance not alive";
                default:
                    return "invalid query request";
            }
        }
#endif
    }
}
