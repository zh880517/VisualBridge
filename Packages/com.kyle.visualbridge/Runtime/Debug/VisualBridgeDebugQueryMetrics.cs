namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 查询运行期的只读计数快照（附录 B.6）：供宿主与测试观察队列、并发与丢弃行为；
    /// 业务不可见。所有计数随会话重置（Install / Uninstall / Detach / 断连）归零。
    /// </summary>
    public readonly struct VisualBridgeDebugQueryMetrics
    {
        internal VisualBridgeDebugQueryMetrics(
            int queuedCount,
            int inFlightCount,
            long acceptedCount,
            long dispatchedCount,
            long completedCount,
            long rejectedCount,
            long timedOutQueuedCount,
            long timedOutExecutingCount,
            long busyRejectedCount,
            long unregisteredRejectedCount,
            long instanceNotFoundRejectedCount,
            long invalidArgumentRejectedCount,
            long unavailableRejectedCount,
            long droppedLateResultCount)
        {
            QueuedCount = queuedCount;
            InFlightCount = inFlightCount;
            AcceptedCount = acceptedCount;
            DispatchedCount = dispatchedCount;
            CompletedCount = completedCount;
            RejectedCount = rejectedCount;
            TimedOutQueuedCount = timedOutQueuedCount;
            TimedOutExecutingCount = timedOutExecutingCount;
            BusyRejectedCount = busyRejectedCount;
            UnregisteredRejectedCount = unregisteredRejectedCount;
            InstanceNotFoundRejectedCount = instanceNotFoundRejectedCount;
            InvalidArgumentRejectedCount = invalidArgumentRejectedCount;
            UnavailableRejectedCount = unavailableRejectedCount;
            DroppedLateResultCount = droppedLateResultCount;
        }

        /// <summary>当前排队等待执行的请求数（上限 8）。</summary>
        public int QueuedCount { get; }

        /// <summary>当前已分发、尚未回发结果的请求数（上限 8）。</summary>
        public int InFlightCount { get; }

        /// <summary>成功入队的累计请求数。</summary>
        public long AcceptedCount { get; }

        /// <summary>已交给业务实现执行的累计请求数。</summary>
        public long DispatchedCount { get; }

        /// <summary>在 pump 里同步回发了结果的累计请求数。</summary>
        public long CompletedCount { get; }

        /// <summary>业务实现回发失败应答（含未应答兜底）的累计请求数。</summary>
        public long RejectedCount { get; }

        /// <summary>排队超时（2000 ms）的累计请求数。</summary>
        public long TimedOutQueuedCount { get; }

        /// <summary>执行超时（3000 ms）的累计请求数。</summary>
        public long TimedOutExecutingCount { get; }

        /// <summary>因队列满 / 并发超限被拒绝的累计请求数（都应答 <c>runtime.queryBusy</c>）。</summary>
        public long BusyRejectedCount { get; }

        /// <summary>因接口未注册被拒绝的累计请求数。</summary>
        public long UnregisteredRejectedCount { get; }

        /// <summary>因实例不存在或已结束时被拒绝的累计请求数。</summary>
        public long InstanceNotFoundRejectedCount { get; }

        /// <summary>因信封 / 槽位 / 参数不合法被拒绝的累计请求数。</summary>
        public long InvalidArgumentRejectedCount { get; }

        /// <summary>未挂接或未连接时静默丢弃的累计请求数。</summary>
        public long UnavailableRejectedCount { get; }

        /// <summary>超时 / 作废后才回发的结果数；这些同时计入会话的 <c>dropped</c> 聚合。</summary>
        public long DroppedLateResultCount { get; }
    }
}
