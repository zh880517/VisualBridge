using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VisualBridge.Diagnostics.Bridge
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>丢弃累计计数（附录 A.5 的 <c>dropped</c> 载荷，E4 定稿）。</summary>
    public readonly struct VisualBridgeDebugDroppedSnapshot
    {
        public VisualBridgeDebugDroppedSnapshot(long filteredByServer, long unknownMethod, long unknownSlot,
            long invalidRequest, long encodeFailed, long oversize, long queueOverflow)
        {
            FilteredByServer = filteredByServer;
            UnknownMethod = unknownMethod;
            UnknownSlot = unknownSlot;
            InvalidRequest = invalidRequest;
            EncodeFailed = encodeFailed;
            Oversize = oversize;
            QueueOverflow = queueOverflow;
        }

        /// <summary>服务端筛选丢弃（入队前，未编码未传输）。</summary>
        public long FilteredByServer { get; }

        /// <summary>方法号不在分类号段（0–9 为系统保留，分类方法从 10 起）而丢弃。</summary>
        public long UnknownMethod { get; }

        /// <summary>槽位未知或已随 Finish/断连失效而丢弃。</summary>
        public long UnknownSlot { get; }

        /// <summary>入站帧无法解析成 <c>request</c> 而丢弃。</summary>
        public long InvalidRequest { get; }

        /// <summary>会话级丢弃（编码失败、无连接、连接换代）。</summary>
        public long EncodeFailed { get; }

        /// <summary>其中因单条载荷超过 1 MB / 二进制字符串超 u16 而丢弃。</summary>
        public long Oversize { get; }

        /// <summary>数据队列容量淘汰（附录 A.9 的入队处丢最旧）。</summary>
        public long QueueOverflow { get; }

        public bool SameAs(VisualBridgeDebugDroppedSnapshot other)
        {
            return FilteredByServer == other.FilteredByServer && UnknownMethod == other.UnknownMethod
                && UnknownSlot == other.UnknownSlot && InvalidRequest == other.InvalidRequest
                && EncodeFailed == other.EncodeFailed && Oversize == other.Oversize
                && QueueOverflow == other.QueueOverflow;
        }
    }

    /// <summary>
    /// 通道 1 的消息构建（附录 A.2/A.4/A.5）：<c>debugCreate</c> / <c>debugFinish</c> / <c>dropped</c> /
    /// 通道 1 的 <c>response</c>。debug / debugResult / debugFrame 由 <c>VisualBridge.Debug</c> 的
    /// 编码器与运行期构造，这里不重复实现。
    /// 所有 JSON 都是确定性的键顺序，便于两侧 fixture 逐字节比对；全部走控制队列（不淘汰）。
    /// </summary>
    public static class VisualBridgeDebugWireMessages
    {
        private const int MaxMessageBytes = VisualBridgeDebugPayloadLimits.MaxMessageBytes;

        /// <summary><c>debugCreate</c>（JSON）：每实例一条，连接建立时先 flush 待发项（附录 A.5）。</summary>
        public static VisualBridgeDebugEncodedMessage CreateJson(string category, string instance,
            ushort instanceSlot, string resName, string debugInfo)
        {
            var builder = new StringBuilder(128);
            builder.Append("{\"type\":\"debugCreate\",\"category\":");
            AppendJsonString(builder, category ?? string.Empty);
            builder.Append(",\"instance\":");
            AppendJsonString(builder, instance ?? string.Empty);
            builder.Append(",\"instanceSlot\":").Append(instanceSlot.ToString(CultureInfo.InvariantCulture));
            builder.Append(",\"resName\":");
            AppendJsonString(builder, resName ?? string.Empty);
            builder.Append(",\"debugInfo\":");
            AppendJsonString(builder, debugInfo ?? string.Empty);
            builder.Append('}');
            return ControlJson(builder);
        }

        /// <summary><c>debugCreate</c>（二进制）：methodId=1 + 槽位 + 固定 tag 表（0 category / 1 instanceId / 2 resName / 3 debugInfo）。</summary>
        public static VisualBridgeDebugEncodedMessage CreateBinary(string category, string instance,
            ushort instanceSlot, string resName, string debugInfo)
        {
            var payload = BuildFixedTagPayload(1, instanceSlot, new[]
            {
                new KeyValuePair<ushort, string>(0, category),
                new KeyValuePair<ushort, string>(1, instance),
                new KeyValuePair<ushort, string>(2, resName),
                new KeyValuePair<ushort, string>(3, debugInfo),
            });
            return payload == null ? OversizeControl() : ControlBinary(payload);
        }

        /// <summary>
        /// <c>debugFinish</c>（JSON）：每实例最多一条，语义是生命周期结束（附录 A.5）。
        /// <paramref name="category"/> 为 null 时**不写该键**（槽位与实例都已未知），不写 <c>null</c>。
        /// </summary>
        public static VisualBridgeDebugEncodedMessage FinishJson(string category, string instance)
        {
            var builder = new StringBuilder(64);
            builder.Append("{\"type\":\"debugFinish\"");
            if (category != null)
            {
                builder.Append(",\"category\":");
                AppendJsonString(builder, category);
            }

            builder.Append(",\"instance\":");
            AppendJsonString(builder, instance ?? string.Empty);
            builder.Append('}');
            return ControlJson(builder);
        }

        /// <summary><c>debugFinish</c>（二进制）：methodId=2 + 槽位 + 固定 tag 表（0 instanceId）。</summary>
        public static VisualBridgeDebugEncodedMessage FinishBinary(string instance, ushort instanceSlot)
        {
            var payload = BuildFixedTagPayload(2, instanceSlot, new[]
            {
                new KeyValuePair<ushort, string>(0, instance),
            });
            return payload == null ? OversizeControl() : ControlBinary(payload);
        }

        /// <summary><c>dropped</c>（JSON，累计计数）：字段由 E4 定稿并回填附录 A.5。</summary>
        public static VisualBridgeDebugEncodedMessage Dropped(VisualBridgeDebugDroppedSnapshot snapshot)
        {
            var builder = new StringBuilder(192);
            builder.Append("{\"type\":\"dropped\"");
            AppendCounter(builder, "filteredByServer", snapshot.FilteredByServer);
            AppendCounter(builder, "unknownMethod", snapshot.UnknownMethod);
            AppendCounter(builder, "unknownSlot", snapshot.UnknownSlot);
            AppendCounter(builder, "invalidRequest", snapshot.InvalidRequest);
            AppendCounter(builder, "encodeFailed", snapshot.EncodeFailed);
            AppendCounter(builder, "oversize", snapshot.Oversize);
            AppendCounter(builder, "queueOverflow", snapshot.QueueOverflow);
            builder.Append('}');
            return ControlJson(builder);
        }

        /// <summary>通道 1 的 <c>response</c>（查询失败应答，不进调试流）：请求号按 JSON 约定写 <c>"req-&lt;n&gt;"</c>。</summary>
        public static VisualBridgeDebugEncodedMessage Response(uint requestSeq, string code, string detail)
        {
            var builder = new StringBuilder(128);
            builder.Append("{\"type\":\"response\",\"requestId\":");
            AppendJsonString(builder, "req-" + requestSeq.ToString(CultureInfo.InvariantCulture));
            builder.Append(",\"ok\":false,\"code\":");
            AppendJsonString(builder, code ?? string.Empty);
            builder.Append(",\"detail\":");
            AppendJsonString(builder, detail ?? string.Empty);
            builder.Append('}');
            return ControlJson(builder);
        }

        private static VisualBridgeDebugEncodedMessage ControlJson(StringBuilder builder)
        {
            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Json,
                VisualBridgeDebugTargetQueue.Control,
                Encoding.UTF8.GetBytes(builder.ToString()));
        }

        private static VisualBridgeDebugEncodedMessage ControlBinary(byte[] payload)
        {
            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Binary,
                VisualBridgeDebugTargetQueue.Control,
                payload);
        }

        /// <summary>超限（1 MB 或 u16 字符串上限）：返回非 Ok 的空载荷，由调用方计数并丢弃（附录 A.4）。</summary>
        private static VisualBridgeDebugEncodedMessage OversizeControl()
        {
            return new VisualBridgeDebugEncodedMessage(
                VisualBridgeDebugPayloadFormat.Binary,
                VisualBridgeDebugTargetQueue.Control,
                ReadOnlyMemory<byte>.Empty,
                VisualBridgeDebugEncodeStatus.TooLarge);
        }

        /// <summary>
        /// 构建 Create/Finish 的二进制载荷：u16 methodId + u16 slot + 参数区（固定 tag 表，稀疏：空串不写）。
        /// 超过 1 MB 时返回非 Ok 的空载荷（调用方按编码失败计数并丢弃）。
        /// </summary>
        private static byte[] BuildFixedTagPayload(ushort methodId, ushort instanceSlot,
            KeyValuePair<ushort, string>[] fields)
        {
            var parameters = new List<byte[]>(fields.Length);
            int size = 4;
            foreach (var field in fields)
            {
                if (string.IsNullOrEmpty(field.Value))
                {
                    // 稀疏参数区：默认值（空串）不写（附录 A.4）。
                    continue;
                }

                var bytes = Encoding.UTF8.GetBytes(field.Value);
                if (bytes.Length > VisualBridgeDebugPayloadLimits.MaxStringBytes)
                {
                    return null;
                }

                var chunk = new byte[3 + 2 + bytes.Length];
                WriteUInt16BigEndian(chunk, 0, field.Key);
                chunk[2] = 8; // 附录 A.4 的 type 码表：8 = string
                WriteUInt16BigEndian(chunk, 3, (ushort)bytes.Length);
                Buffer.BlockCopy(bytes, 0, chunk, 5, bytes.Length);
                parameters.Add(chunk);
                size += chunk.Length;
                if (size > MaxMessageBytes)
                {
                    return null;
                }
            }

            var payload = new byte[size];
            WriteUInt16BigEndian(payload, 0, methodId);
            WriteUInt16BigEndian(payload, 2, instanceSlot);
            int offset = 4;
            foreach (var parameter in parameters)
            {
                Buffer.BlockCopy(parameter, 0, payload, offset, parameter.Length);
                offset += parameter.Length;
            }

            return payload;
        }

        private static void AppendCounter(StringBuilder builder, string name, long value)
        {
            builder.Append(",\"").Append(name).Append("\":").Append(value.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>JSON 字符串转义（与 <c>VisualBridgeDebugJsonEncoder</c> 同一规则）；null 写 null。</summary>
        private static void AppendJsonString(StringBuilder builder, string value)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }

            builder.Append('"');
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                switch (character)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\b':
                        builder.Append("\\b");
                        break;
                    case '\f':
                        builder.Append("\\f");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(character);
                        }

                        break;
                }
            }

            builder.Append('"');
        }

        private static void WriteUInt16BigEndian(byte[] buffer, int offset, ushort value)
        {
            buffer[offset] = (byte)(value >> 8);
            buffer[offset + 1] = (byte)value;
        }
    }
#endif
}
