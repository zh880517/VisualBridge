using System;
using System.Globalization;
using System.Text;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 门面已接受、尚未 End 的一条消息上下文。
    /// 数据按值存在 Start 线程的 [ThreadStatic] 槽位里，避免 Start 热路径产生堆分配；其它线程读不到它，
    /// 跨线程 PushParam/End 会被判为跨线程调用并忽略（附录 B.2 的 Start→PushParam→End 同线程约束）。
    /// </summary>
    internal readonly struct VisualBridgeDebugMessage
    {
        internal VisualBridgeDebugMessage(VisualBridgeDebugMessageKind kind, string instanceId, string category,
            string iface, string method, ushort instanceSlot, ushort methodId, uint requestSeq, long frame,
            long connectionGeneration, IDebugMessageEncoder encoder)
        {
            Kind = kind;
            InstanceId = instanceId;
            Category = category;
            Iface = iface;
            Method = method;
            InstanceSlot = instanceSlot;
            MethodId = methodId;
            RequestSeq = requestSeq;
            Frame = frame;
            ConnectionGeneration = connectionGeneration;
            Encoder = encoder;
        }

        internal VisualBridgeDebugMessageKind Kind { get; }

        /// <summary>实例 id，供 JSON 信封的 instance 字段。</summary>
        internal string InstanceId { get; }

        internal ushort InstanceSlot { get; }

        internal ushort MethodId { get; }

        internal uint RequestSeq { get; }

        internal long Frame { get; }

        /// <summary>Start 时抓到的连接代次；End 用它判断这条消息是否跨了重连。</summary>
        internal long ConnectionGeneration { get; }

        /// <summary>
        /// Start 时绑定的编码器：整条消息的 Begin/PushParam/End 都用它，
        /// 中途 SetEncoder 只影响下一条消息（避免同一条消息落到两个编码器实现上）。
        /// </summary>
        internal IDebugMessageEncoder Encoder { get; }

        /// <summary>分类名，供 JSON 信封与传输层诊断。</summary>
        internal string Category { get; }

        /// <summary>接口 id，供 JSON 信封与传输层诊断。</summary>
        internal string Iface { get; }

        /// <summary>方法名，供 JSON 信封与传输层诊断。</summary>
        internal string Method { get; }
    }

    /// <summary>
    /// 通道 1 的控制消息构造（附录 A.5）：debugFrame 始终是 JSON，携带完整载荷与控制队列目标，
    /// 由门面在「帧值变化且确有数据要发」或连接建立时交给传输层。
    /// </summary>
    internal static class VisualBridgeDebugControlMessages
    {
        internal static VisualBridgeDebugEncodedMessage CreateFrame(long frame)
        {
            // -1 = 无帧；SetFrame 已把负数归一为 -1，这里再兜底一次，保证线上只有 -1 或 >= 0。
            long normalized = frame < 0 ? -1L : frame;
            string json = "{\"type\":\"debugFrame\",\"frame\":"
                + normalized.ToString(CultureInfo.InvariantCulture) + "}";
            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Json,
                VisualBridgeDebugTargetQueue.Control,
                Encoding.UTF8.GetBytes(json));
        }
    }
#endif
}
