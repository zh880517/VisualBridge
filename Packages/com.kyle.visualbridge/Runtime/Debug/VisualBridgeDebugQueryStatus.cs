namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 查询请求的入队结果（附录 B.6）：<see cref="Accepted"/> 表示已入队，
    /// 其余取值由运行期翻译成附录 A.6 的错误码并以 <c>response</c> 回给对端。
    /// </summary>
    public enum VisualBridgeDebugQueryStatus : byte
    {
        /// <summary>已入队，等待主线程 pump 执行。</summary>
        Accepted = 0,

        /// <summary>未挂接或未连接：没有可回应的通道，请求直接丢弃（不产生错误应答）。</summary>
        Unavailable = 1,

        /// <summary>请求信封或参数不合法（含重复请求号、槽位与实例不匹配、参数类型不符）。</summary>
        InvalidArgument = 2,

        /// <summary>排队队列已满（上限 8）：<c>runtime.queryBusy</c>，不入队、不影响已有请求。</summary>
        QueueFull = 3,

        /// <summary>在途请求已达并发上限（8）：<c>runtime.queryBusy</c>。</summary>
        ConcurrencyLimited = 4,

        /// <summary>该分类下没有注册对应接口的处理器：<c>runtime.queryUnregistered</c>。</summary>
        Unregistered = 5,

        /// <summary>实例不存在或已 <c>Finish</c>：<c>runtime.instanceNotFound</c>。</summary>
        InstanceNotFound = 6,
    }
}
