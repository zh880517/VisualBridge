using System;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// 连接保活参数（附录 A.9）：写线程在连续 <see cref="IntervalMs"/> 未发出任何消息时
    /// 自行入队一条 <c>ping</c>；连续 <see cref="IdleTimeoutMs"/> 未收到任何入站字节即断开。
    /// 默认值 10 s / 30 s 与附录 A.8 的 <c>HeartbeatIntervalMs</c> / <c>IdleTimeoutMs</c> 一致；
    /// 单测通过缩小这两个值来免等待，生产路径不应修改。
    /// </summary>
    public sealed class VisualBridgeHeartbeatOptions
    {
        /// <summary>空闲多久后主动入队 ping（毫秒）。</summary>
        public int IntervalMs { get; set; } = 10000;

        /// <summary>多久没有任何入站字节后判定连接已死（毫秒）。</summary>
        public int IdleTimeoutMs { get; set; } = 30000;

        /// <summary>关闭保活（只在测试需要完全静默的连接时使用）。</summary>
        public bool Disabled { get; set; }

        public static VisualBridgeHeartbeatOptions Default()
        {
            return new VisualBridgeHeartbeatOptions();
        }

        internal int PollMilliseconds
        {
            get
            {
                var interval = IntervalMs <= 0 ? 1000 : IntervalMs;
                // 轮询粒度为心跳间隔的 1/4，上限 100 ms：既能及时发 ping，也不空转。
                return Math.Max(10, Math.Min(100, interval / 4));
            }
        }
    }
}
