using System.Threading;

namespace VisualBridge.Diagnostics
{
    /// <summary>调试运行时计数器；字段只增不减，测试可调用 Reset。</summary>
    public sealed class VisualBridgeDebugCounters
    {
        /// <summary>构建状态错乱（未 End 就再次 Start 等）丢弃的消息数。</summary>
        public long malformed;

        /// <summary>有界队列溢出丢弃的最旧消息数。</summary>
        public long droppedQueue;

        /// <summary>单条成帧超过上限而丢弃的消息数。</summary>
        public long oversize;

        /// <summary>已连接但当前没有正在构建的消息时，被忽略的参数/结束调用数。</summary>
        public long filtered;

        /// <summary>请求处理器抛出的异常数。</summary>
        public long handlerErrors;

        /// <summary>清零全部计数器。</summary>
        public void Reset()
        {
            Interlocked.Exchange(ref malformed, 0);
            Interlocked.Exchange(ref droppedQueue, 0);
            Interlocked.Exchange(ref oversize, 0);
            Interlocked.Exchange(ref filtered, 0);
            Interlocked.Exchange(ref handlerErrors, 0);
        }
    }
}
