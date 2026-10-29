using System;
using VisualBridge.Runtime;

namespace VisualBridge.Diagnostics.Bridge
{
    /// <summary>
    /// 调试传输层的发送缝（附录 A.9）：传输实现只认这个接口，不依赖具体连接实现，
    /// 因此既能在 Editor Play 模式接 <see cref="VisualBridgeRuntimeDebugWire"/>，也能在单测里接假实现。
    /// </summary>
    public interface IVisualBridgeDebugWire
    {
        /// <summary>
        /// 连接是否可用。实现必须**无锁、短小、不阻塞、不回调**：本属性会在传输层的
        /// <c>gate</c> 内被调用（<c>IsConnected</c> 扫描连接栈、<c>OnWireClosed</c> 出栈后找可恢复的连接），
        /// 在这里取锁或等待会把传输层的锁序拖进第三方实现。
        /// </summary>
        bool IsOpen { get; }

        /// <summary>连接代次：每条新连接递增。</summary>
        long Generation { get; }
        /// <summary>数据队列因容量上限淘汰的消息数（<c>dropped.queueOverflow</c> 取自这里）。</summary>
        long OverflowDroppedMessages { get; }

        /// <summary>通道 1 的控制消息（不淘汰）。</summary>
        bool SendControl(byte[] payload, VisualBridgeDebugPayloadFormat format);

        /// <summary>通道 1 的数据消息（可淘汰）。</summary>
        bool SendDebug(byte[] payload, VisualBridgeDebugPayloadFormat format);

        /// <summary>通道 1 的入站帧（对端发来的 request）。</summary>
        event Action<VisualBridgePayloadKind, byte[]> FrameReceived;

        /// <summary>连接关闭（只触发一次）。</summary>
        event Action Closed;

        /// <summary>心跳节拍（约 1 s），供周期性上报 dropped。</summary>
        event Action Tick;
    }
}
