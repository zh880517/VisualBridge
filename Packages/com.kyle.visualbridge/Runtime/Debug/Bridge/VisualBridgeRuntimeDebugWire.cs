using System;
using VisualBridge.Runtime;

namespace VisualBridge.Diagnostics.Bridge
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 把一条连接上的 <see cref="VisualBridgeRuntimeDebugLink"/> 适配成传输层的发送缝（附录 A.2/A.9）：
    /// 只做载荷格式到通道载荷类型的映射与事件转发，不解释消息语义。
    /// 生命周期与连接一致：连接关闭后适配器不再转发任何事件。
    /// </summary>
    public sealed class VisualBridgeRuntimeDebugWire : IVisualBridgeDebugWire, IDisposable
    {
        private readonly VisualBridgeRuntimeDebugLink link;
        private bool disposed;

        public VisualBridgeRuntimeDebugWire(VisualBridgeRuntimeDebugLink link)
        {
            this.link = link ?? throw new ArgumentNullException(nameof(link));
            link.DebugFrameReceived += OnFrameReceived;
            link.Closed += OnClosed;
            link.Tick += OnTick;
        }

        public bool IsOpen => !disposed && link.IsOpen;

        public long Generation => link.Generation;

        public long OverflowDroppedMessages => link.SendCounters.DebugDroppedMessages;

        public event Action<VisualBridgePayloadKind, byte[]> FrameReceived;

        public event Action Closed;

        public event Action Tick;

        public bool SendControl(byte[] payload, VisualBridgeDebugPayloadFormat format)
        {
            return !disposed && link.SendControl(payload, ToPayloadKind(format));
        }

        public bool SendDebug(byte[] payload, VisualBridgeDebugPayloadFormat format)
        {
            return !disposed && link.SendDebug(payload, ToPayloadKind(format));
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            link.DebugFrameReceived -= OnFrameReceived;
            link.Closed -= OnClosed;
            link.Tick -= OnTick;
        }

        private static VisualBridgePayloadKind ToPayloadKind(VisualBridgeDebugPayloadFormat format)
        {
            return format == VisualBridgeDebugPayloadFormat.Binary
                ? VisualBridgePayloadKind.Binary
                : VisualBridgePayloadKind.Json;
        }

        private void OnFrameReceived(VisualBridgePayloadKind payloadKind, byte[] payload)
        {
            FrameReceived?.Invoke(payloadKind, payload);
        }

        private void OnClosed()
        {
            Closed?.Invoke();
        }

        private void OnTick()
        {
            Tick?.Invoke();
        }
    }
#endif
}
