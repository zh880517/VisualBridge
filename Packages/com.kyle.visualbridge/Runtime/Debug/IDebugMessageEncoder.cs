using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>一条调试消息的类型（附录 A.5）：普通事件或查询结果。</summary>
    public enum VisualBridgeDebugMessageKind : byte
    {
        /// <summary>debug：事件接口产生的普通消息。</summary>
        Debug = 0,

        /// <summary>debugResult：查询接口的结果回发。</summary>
        DebugResult = 1,
    }

    /// <summary>载荷格式（附录 A.4/A.5）：二进制，或 contractHash 不一致时的 JSON 降级。</summary>
    public enum VisualBridgeDebugPayloadFormat : byte
    {
        Binary = 0,
        Json = 1,
    }

    /// <summary>传输层目标队列：数据消息走数据队列，debugFrame 等控制消息走控制队列。</summary>
    public enum VisualBridgeDebugTargetQueue : byte
    {
        Data = 0,
        Control = 1,
    }

    /// <summary>编码结果；非 <see cref="Ok"/> 表示整条消息被丢弃，由门面层计数。</summary>
    public enum VisualBridgeDebugEncodeStatus : byte
    {
        Ok = 0,

        /// <summary>完整载荷超过 1 MB（附录 A.4）。</summary>
        TooLarge = 1,

        /// <summary>PushParam 收到九种声明类型之外的运行时类型（编码器不做数值转换）。</summary>
        UnsupportedValue = 2,

        /// <summary>二进制载荷的字符串超过 u16 长度上限（编码器无法用声明的长度字段表达）。</summary>
        LengthOverflow = 3,
    }

    /// <summary>
    /// 「完整载荷 + 目标队列」描述（附录 B.4）：编码器 End 产出，门面原样交给传输层。
    /// 控制消息（debugFrame）由运行期构造同样形状的描述，因此传输层只需要一条载荷写出路径。
    /// </summary>
    public readonly struct VisualBridgeDebugEncodedMessage
    {
        public VisualBridgeDebugEncodedMessage(
            VisualBridgeDebugPayloadFormat format,
            VisualBridgeDebugTargetQueue targetQueue,
            ReadOnlyMemory<byte> payload)
            : this(format, targetQueue, payload, VisualBridgeDebugEncodeStatus.Ok)
        {
        }

        public VisualBridgeDebugEncodedMessage(
            VisualBridgeDebugPayloadFormat format,
            VisualBridgeDebugTargetQueue targetQueue,
            ReadOnlyMemory<byte> payload,
            VisualBridgeDebugEncodeStatus status)
        {
            Format = format;
            TargetQueue = targetQueue;
            Payload = payload;
            Status = status;
        }

        public VisualBridgeDebugPayloadFormat Format { get; }

        public VisualBridgeDebugTargetQueue TargetQueue { get; }

        /// <summary>完整载荷；格式由 <see cref="Format"/> 决定，传输层不再二次编码。</summary>
        public ReadOnlyMemory<byte> Payload { get; }

        public VisualBridgeDebugEncodeStatus Status { get; }

        public bool IsEncoded
        {
            get { return Status == VisualBridgeDebugEncodeStatus.Ok; }
        }
    }

    /// <summary>载荷上限（附录 A.4）：单条消息 1 MB；二进制字符串长度字段是 u16。</summary>
    public static class VisualBridgeDebugPayloadLimits
    {
        public const int MaxMessageBytes = 1024 * 1024;

        public const int MaxStringBytes = ushort.MaxValue;
    }

    /// <summary>
    /// 调试运行期的只读诊断快照（附录 B.3.3）：供 E4 的 dropped 聚合读取，不暴露给业务门面。
    /// 所有计数随会话重置归零，消费者需按会话边界处理回退。
    /// </summary>
    public readonly struct VisualBridgeDebugDiagnosticsSnapshot
    {
        public VisualBridgeDebugDiagnosticsSnapshot(long droppedMessages, long droppedOversizeMessages,
            long crossThreadCalls)
        {
            DroppedMessages = droppedMessages;
            DroppedOversizeMessages = droppedOversizeMessages;
            CrossThreadCalls = crossThreadCalls;
        }

        /// <summary>因无连接 / 无编码器 / 编码失败 / 连接换代而丢弃的消息总数。</summary>
        public long DroppedMessages { get; }

        /// <summary>其中因单条载荷超限（含 u16 字符串长度溢出）而丢弃的数量。</summary>
        public long DroppedOversizeMessages { get; }

        public long CrossThreadCalls { get; }
    }

    /// <summary>
    /// E4 的 dropped 聚合读取入口：位于 <c>VisualBridge.Debug</c> 程序集，编辑器宿主与运行时宿主都可直接引用，
    /// 不需要触碰业务门面；宏关闭时返回全零快照。
    /// </summary>
    public static class VisualBridgeDebugMetrics
    {
        public static VisualBridgeDebugDiagnosticsSnapshot GetSnapshot()
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugSession.GetDiagnostics();
#else
            return default;
#endif
        }
    }

    /// <summary>
    /// 调试消息编码器（附录 B.4）：替换编码器的唯一要求是 <see cref="VisualBridgeDebug.SetEncoder"/>
    /// 之后生成代码零改动，因此这里只暴露 Begin/PushParam/End 三步。
    /// </summary>
    public interface IDebugMessageEncoder
    {
        /// <summary>
        /// 开始一条消息。<paramref name="instanceId"/> / <paramref name="category"/> / <paramref name="iface"/> /
        /// <paramref name="method"/> 供 JSON 信封使用（二进制编码器忽略）；<paramref name="methodId"/> /
        /// <paramref name="instanceSlot"/> 供二进制头使用；<paramref name="requestId"/> 只用于 debugResult。
        /// </summary>
        void Begin(
            VisualBridgeDebugMessageKind kind,
            string instanceId,
            string category,
            string iface,
            string method,
            ushort methodId,
            ushort instanceSlot,
            uint requestId);

        /// <summary>
        /// 压入一个非默认参数。运行时值只能是 bool / int / long / ulong / float / double / Enum / string /
        /// byte[] 九种之一：uint→long、short→int 等收窄由生成代码显式转换，编码器不做 object 数值转换。
        /// </summary>
        void PushParam(string name, ushort tag, object value);

        /// <summary>结束一条消息并返回「完整载荷 + 目标队列」描述；非 Ok 表示载荷被丢弃。</summary>
        VisualBridgeDebugEncodedMessage End();
    }
}
