using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 调试契约与传输层之间的注入缝（附录 B.1：Debug.Bridge 把静态 API 的消息接到传输层）。
    /// 由 <c>VisualBridge.Debug.Bridge</c> 注入；运行时只按实例与槽位规则调用，不关心 socket、成帧与载荷格式。
    /// 实现约束：所有成员都可能在业务线程被同步调用，因此不得回调调试 API、不得阻塞、不得自行重试；
    /// 连接事件由宿主显式调用 <see cref="VisualBridgeDebug.Attach"/> / <see cref="VisualBridgeDebug.Detach"/> 表达。
    /// </summary>
    public interface IVisualBridgeDebugTransport
    {
        /// <summary>当前是否已建立可用连接。</summary>
        bool IsConnected { get; }

        /// <summary>运行环境类型；连接态之外的取值由传输层决定。</summary>
        ConnectType ConnectType { get; }

        /// <summary>
        /// 连接代次：每次新连接建立后递增，断连期间不变。运行时据此识别“还没观察到断连就又连上”的重连并重置会话；
        /// 传输层暂时拿不到代次时可以恒返回 0，此时必须由宿主在断连时调用 <see cref="VisualBridgeDebug.Detach"/>。
        /// </summary>
        long ConnectionGeneration { get; }

        /// <summary>发送实例描述；<paramref name="resName"/> / <paramref name="debugInfo"/> 由传输层负责发出后丢弃。</summary>
        void SendCreate(string instanceId, string category, string resName, string debugInfo, ushort instanceSlot);

        /// <summary>发送实例结束。</summary>
        void SendFinish(string instanceId, ushort instanceSlot);

        /// <summary>
        /// 发送已编码的事件载荷。<paramref name="category"/> / <paramref name="iface"/> / <paramref name="method"/>
        /// 供 JSON 降级与诊断使用，<paramref name="frame"/> 在消息构造时刻读取。
        /// </summary>
        void SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method, long frame,
            ReadOnlyMemory<byte> payload);

        /// <summary>发送查询结果载荷；<paramref name="requestSeq"/> 是信封里的请求号。</summary>
        void SendResult(uint requestSeq, ReadOnlyMemory<byte> payload);

        /// <summary>发送失败应答（通道 1 的 response），不进入调试流。</summary>
        void SendReject(uint requestSeq, string reason);
    }
}
