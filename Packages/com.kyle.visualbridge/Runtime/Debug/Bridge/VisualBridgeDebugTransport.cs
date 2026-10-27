using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using VisualBridge.Runtime;

namespace VisualBridge.Diagnostics.Bridge
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 生产用调试传输实现（附录 A.2/A.4/A.9）：把 <see cref="VisualBridgeDebug"/> 的产出接到统一连接的通道 1。
    /// 职责边界：
    /// - <c>Create</c> / <c>Finish</c> / <c>debugFrame</c> / <c>dropped</c> / 通道 1 的 <c>response</c> 走控制队列（不淘汰）；
    /// - <c>debug</c> / <c>debugResult</c> 走数据队列（可淘汰）；
    /// - 入队前准入（<see cref="IVisualBridgeDebugOutboundGate"/>）：槽位/方法号校验与 <c>debugCategories</c> /
    ///   <c>debugInstances</c> 筛选都在编码之前完成，未命中不编码、不入队，只累加计数；
    /// - 槽位映射 <c>slot → instance → category</c> 由 <c>Create</c> 建立、<c>debugFinish</c> 或断连立即失效（A.4/A.9）；
    /// - 丢弃计数按周期（心跳约 1 s，节流 500 ms）以 <c>dropped</c> 上报，避免打爆控制队列；
    /// - 入站只接受通道 1 的 JSON <c>request</c>，其余帧按未知槽位/未知方法丢弃并计数，绝不断连。
    /// </summary>
    public sealed class VisualBridgeDebugTransport : IVisualBridgeDebugTransport, IVisualBridgeDebugOutboundGate, IDisposable
    {
        /// <summary>分类方法的起始方法号（附录 A.4：0–9 为系统保留）。</summary>
        public const ushort FirstCategoryMethodId = 10;

        /// <summary>dropped 上报的最小间隔（附录 A.9 的「按周期上报」，配合 1 s 心跳）。</summary>
        public const int DroppedReportIntervalMs = 500;

        private const int MaxMessageBytes = VisualBridgeDebugPayloadLimits.MaxMessageBytes;

        private readonly object gate = new object();
        private readonly object droppedGate = new object();
        private readonly Dictionary<ushort, Slot> slots = new Dictionary<ushort, Slot>();
        private readonly ConnectType connectType;
        private readonly Action<string> log;
        private readonly int droppedReportIntervalMs;

        private IVisualBridgeDebugWire wire;
        private VisualBridgeDebugPayloadFormat format;
        private HashSet<string> categoryFilter;
        private HashSet<string> instanceFilter;
        private long filteredByServer;
        private long unknownMethod;
        private long unknownSlot;
        private long invalidRequest;
        private long ownEncodeFailed;
        private long ownOversize;
        private VisualBridgeDebugDroppedSnapshot lastReported;
        private int lastReportedAtMs;
        private bool droppedDirty;
        private bool disposed;

        public VisualBridgeDebugTransport(ConnectType connectType,
            VisualBridgeDebugPayloadFormat format = VisualBridgeDebugPayloadFormat.Json,
            Action<string> log = null,
            int droppedReportIntervalMs = DroppedReportIntervalMs)
        {
            this.connectType = connectType;
            this.format = format;
            this.log = log;
            this.droppedReportIntervalMs = droppedReportIntervalMs < 0 ? 0 : droppedReportIntervalMs;
        }

        /// <summary>当前连接代次；未绑定时为 0（附录 B.1.3 允许传输层恒返回 0，此时由宿主显式 Detach）。</summary>
        public long ConnectionGeneration
        {
            get
            {
                var current = VolatileWire;
                return current == null ? 0L : current.Generation;
            }
        }

        public bool IsConnected
        {
            get
            {
                var current = VolatileWire;
                return current != null && current.IsOpen;
            }
        }

        public ConnectType ConnectType => connectType;

        /// <summary>控制消息（Create/Finish/dropped/debugFrame/response）使用的载荷格式；由宿主按协商结果设置。</summary>
        public VisualBridgeDebugPayloadFormat PayloadFormat
        {
            get
            {
                lock (gate)
                {
                    return format;
                }
            }
        }

        private IVisualBridgeDebugWire VolatileWire
        {
            get
            {
                lock (gate)
                {
                    return wire;
                }
            }
        }

        /// <summary>
        /// 绑定一条新连接：清空槽位映射与计数（每次连接重新开始），并订阅该连接的入站帧、关闭与心跳节拍。
        /// 宿主在握手完成后调用；重复绑定以最后一次为准。
        /// </summary>
        public void Bind(IVisualBridgeDebugWire target)
        {
            if (target == null)
            {
                Unbind();
                return;
            }

            IVisualBridgeDebugWire previous;
            lock (gate)
            {
                previous = wire;
                wire = null;
                ResetConnectionStateLocked();
                wire = target;
            }

            if (!ReferenceEquals(previous, target))
            {
                Detach(previous);
                target.FrameReceived += OnFrameReceived;
                target.Closed += OnWireClosed;
                target.Tick += OnWireTick;
            }
        }

        /// <summary>解绑（断连）：槽位立即失效，计数归零；不 Dispose 传输实现本身（可再次 Bind）。</summary>
        public void Unbind()
        {
            IVisualBridgeDebugWire previous;
            lock (gate)
            {
                previous = wire;
                wire = null;
                ResetConnectionStateLocked();
            }

            Detach(previous);
        }

        public void SetPayloadFormat(VisualBridgeDebugPayloadFormat value)
        {
            lock (gate)
            {
                format = value;
            }
        }

        /// <summary>
        /// 设置服务端筛选（附录 A.9）：<paramref name="categories"/> / <paramref name="instances"/> 为
        /// null 或空数组都表示「全部」；两者同时存在时按 AND 组合。在入队前生效（不编码、不传输）。
        /// 由宿主在握手拿到 <c>debugCategories</c> / <c>debugInstances</c> 后调用。
        /// </summary>
        public void SetFilter(IReadOnlyList<string> categories, IReadOnlyList<string> instances)
        {
            lock (gate)
            {
                categoryFilter = ToSet(categories);
                instanceFilter = ToSet(instances);
            }
        }

        public void SendCreate(string instanceId, string category, string resName, string debugInfo, ushort instanceSlot)
        {
            var message = UseBinary()
                ? VisualBridgeDebugWireMessages.CreateBinary(category, instanceId, instanceSlot, resName, debugInfo)
                : VisualBridgeDebugWireMessages.CreateJson(category, instanceId, instanceSlot, resName, debugInfo);
            if (!TrySendControl(message))
            {
                return;
            }

            // Create 是分类进入协议的唯一入口：只有描述真正发出后才登记槽位，客户端才可能解码后续消息。
            lock (gate)
            {
                slots[instanceSlot] = new Slot(instanceId, category);
            }

            FlushDropped();
        }

        public void SendFinish(string instanceId, ushort instanceSlot)
        {
            string category = null;
            lock (gate)
            {
                if (slots.TryGetValue(instanceSlot, out var slot))
                {
                    category = slot.Category;
                }
                else
                {
                    // 槽位已在别处失效（并发 Finish / 重连窗口）：按实例 id 反查分类，
                    // 查不到就不写 category 键，不能写 null（附录 A.5 的字段是字符串）。
                    category = FindCategoryByInstanceLocked(instanceId);
                }

                // 槽位映射在 debugFinish 后立即失效（附录 A.9）：先失效再发送，晚到的数据消息不会被误归属。
                slots.Remove(instanceSlot);
            }

            var message = UseBinary()
                ? VisualBridgeDebugWireMessages.FinishBinary(instanceId, instanceSlot)
                : VisualBridgeDebugWireMessages.FinishJson(category, instanceId);
            TrySendControl(message);
            FlushDropped();
        }

        public void SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method,
            long frame, VisualBridgeDebugEncodedMessage message)
        {
            if (!message.IsEncoded)
            {
                CountEncodeFailure(message.Status);
                return;
            }

            if (!TryAdmitEvent(instanceSlot, null, category, methodId))
            {
                return;
            }

            TrySendData(message);
            FlushDropped();
        }

        public void SendResult(uint requestSeq, VisualBridgeDebugEncodedMessage message)
        {
            if (!message.IsEncoded)
            {
                CountEncodeFailure(message.Status);
                return;
            }

            // 查询结果是客户端主动要求的应答（附录 A.5 的 response 语义在调试流之外），不受筛选抑制。
            TrySendData(message);
            FlushDropped();
        }

        public void SendControl(VisualBridgeDebugEncodedMessage message)
        {
            TrySendControl(message);
            FlushDropped();
        }

        public void SendQueryError(uint requestSeq, string code, string detail)
        {
            TrySendControl(VisualBridgeDebugWireMessages.Response(requestSeq, code, detail));
            FlushDropped();
        }

        public void SendReject(uint requestSeq, string reason)
        {
            // 业务拒绝：码统一取 VisualBridgeDebugQueryErrors.Rejected（A.6 登记归 E6）。
            TrySendControl(VisualBridgeDebugWireMessages.Response(requestSeq,
                VisualBridgeDebugQueryErrors.Rejected, reason));
            FlushDropped();
        }

        /// <summary>入队前准入：槽位未知 / 方法号非法 / 筛选未命中 时丢弃并计数（附录 A.4/A.9）。</summary>
        public bool TryAdmitEvent(ushort instanceSlot, string instanceId, string category, ushort methodId)
        {
            bool admitted;
            lock (gate)
            {
                admitted = false;
                if (!slots.TryGetValue(instanceSlot, out var slot))
                {
                    unknownSlot += 1;
                    droppedDirty = true;
                }
                else if (methodId < FirstCategoryMethodId)
                {
                    unknownMethod += 1;
                    droppedDirty = true;
                }
                else if (!IsAllowedLocked(string.IsNullOrEmpty(category) ? slot.Category : category,
                             string.IsNullOrEmpty(instanceId) ? slot.InstanceId : instanceId))
                {
                    filteredByServer += 1;
                    droppedDirty = true;
                }
                else
                {
                    admitted = true;
                }
            }

            if (!admitted)
            {
                // 丢弃即按周期上报（节流在 FlushDropped 内），不依赖后续是否还有消息。
                FlushDropped();
            }

            return admitted;
        }

        /// <summary>当前丢弃计数（含会话语义：encodeFailed/oversize 来自调试运行期的会话计数）。</summary>
        public VisualBridgeDebugDroppedSnapshot GetDroppedSnapshot()
        {
            var session = VisualBridgeDebugMetrics.GetSnapshot();
            long queueOverflow = 0;
            var current = VolatileWire;
            if (current != null)
            {
                try
                {
                    queueOverflow = current.OverflowDroppedMessages;
                }
                catch (Exception exception)
                {
                    log?.Invoke("[debug] reading send counters failed: " + exception.Message);
                }
            }

            lock (gate)
            {
                return new VisualBridgeDebugDroppedSnapshot(
                    filteredByServer,
                    unknownMethod,
                    unknownSlot,
                    invalidRequest,
                    session.DroppedMessages + ownEncodeFailed,
                    session.DroppedOversizeMessages + ownOversize,
                    queueOverflow);
            }
        }

        /// <summary>
        /// 按周期上报 <c>dropped</c>（累计计数）：节流 <see cref="DroppedReportIntervalMs"/>，
        /// 计数无变化不重发；发送失败保持脏标记，下一次节拍重试。
        /// </summary>
        public void FlushDropped()
        {
            FlushDropped(false);
        }

        /// <summary>
        /// 心跳节拍：会话级计数（encodeFailed）与队列淘汰（queueOverflow）不由本对象的丢弃路径累加，
        /// 因此节拍**不受脏标记阻挡**，只靠快照比较与节流去重（否则这两类计数永远等不到上报）。
        /// </summary>
        private void FlushDroppedFromTick()
        {
            FlushDropped(true);
        }

        private void FlushDropped(bool fromTick)
        {
            // 单独一把锁：并发路径（业务线程的丢弃 + 心跳线程的节拍）只有一个线程真正上报，
            // 避免同一份快照被重复写进控制队列。
            lock (droppedGate)
            {
                var current = VolatileWire;
                if (current == null)
                {
                    return;
                }

                lock (gate)
                {
                    if (!fromTick && !droppedDirty)
                    {
                        return;
                    }

                    int now = Environment.TickCount;
                    if (unchecked((uint)(now - lastReportedAtMs)) < droppedReportIntervalMs)
                    {
                        return;
                    }

                    lastReportedAtMs = now;
                }

                var snapshot = GetDroppedSnapshot();
                if (snapshot.SameAs(lastReported))
                {
                    lock (gate)
                    {
                        droppedDirty = false;
                    }

                    return;
                }

                if (!TrySendMessage(VisualBridgeDebugWireMessages.Dropped(snapshot)))
                {
                    return;
                }

                lock (gate)
                {
                    lastReported = snapshot;
                    droppedDirty = false;
                }
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            Unbind();
        }

        private bool UseBinary()
        {
            lock (gate)
            {
                return format == VisualBridgeDebugPayloadFormat.Binary;
            }
        }

        private static HashSet<string> ToSet(IReadOnlyList<string> values)
        {
            if (values == null || values.Count == 0)
            {
                return null;
            }

            var set = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < values.Count; index++)
            {
                if (!string.IsNullOrEmpty(values[index]))
                {
                    set.Add(values[index]);
                }
            }

            return set.Count == 0 ? null : set;
        }

        private bool IsAllowedLocked(string category, string instanceId)
        {
            if (categoryFilter != null && !categoryFilter.Contains(category ?? string.Empty))
            {
                return false;
            }

            if (instanceFilter != null && !instanceFilter.Contains(instanceId ?? string.Empty))
            {
                return false;
            }

            return true;
        }

        /// <summary>按实例 id 反查分类（槽位表只有 slot → 实例的映射，反查是 O(n)，只在 Finish 兜底路径用到）。</summary>
        private string FindCategoryByInstanceLocked(string instanceId)
        {
            if (string.IsNullOrEmpty(instanceId))
            {
                return null;
            }

            foreach (var pair in slots)
            {
                if (string.Equals(pair.Value.InstanceId, instanceId, StringComparison.Ordinal))
                {
                    return pair.Value.Category;
                }
            }

            return null;
        }

        private void ResetConnectionStateLocked()
        {
            slots.Clear();
            filteredByServer = 0;
            unknownMethod = 0;
            unknownSlot = 0;
            invalidRequest = 0;
            ownEncodeFailed = 0;
            ownOversize = 0;
            lastReported = default;
            lastReportedAtMs = 0;
            droppedDirty = false;
        }

        private void Detach(IVisualBridgeDebugWire target)
        {
            if (target == null)
            {
                return;
            }

            target.FrameReceived -= OnFrameReceived;
            target.Closed -= OnWireClosed;
            target.Tick -= OnWireTick;
            // 适配器（VisualBridgeRuntimeDebugWire）由传输层负责收起；宿主创建的裸实现不需要释放。
            (target as IDisposable)?.Dispose();
        }

        private void OnWireClosed()
        {
            // 断连：槽位立即失效（附录 A.9），计数归零；传输实现保留以便重连后重新 Bind。
            Unbind();
        }

        private void OnWireTick()
        {
            FlushDroppedFromTick();
        }

        private void OnFrameReceived(VisualBridgePayloadKind payloadKind, byte[] payload)
        {
            if (payloadKind == VisualBridgePayloadKind.Json)
            {
                if (!VisualBridgeDebugRequestReader.TryRead(payload, out var request, out string error))
                {
                    lock (gate)
                    {
                        invalidRequest += 1;
                        droppedDirty = true;
                    }

                    log?.Invoke("[debug] dropped an inbound frame that is not a valid request: " + error);
                    FlushDropped();
                    return;
                }

                VisualBridgeDebugQueryRuntime.TryEnqueue(request);
                FlushDropped();
                return;
            }

            // 通道 1 的入站只有 JSON request（附录 A.2）：二进制帧按槽位/方法号归类后丢弃并计数，不断连。
            if (payload == null || payload.Length < 4)
            {
                lock (gate)
                {
                    invalidRequest += 1;
                    droppedDirty = true;
                }

                FlushDropped();
                return;
            }

            ushort methodId = (ushort)((payload[0] << 8) | payload[1]);
            ushort instanceSlot = (ushort)((payload[2] << 8) | payload[3]);
            lock (gate)
            {
                if (!slots.ContainsKey(instanceSlot))
                {
                    unknownSlot += 1;
                }
                else if (methodId < FirstCategoryMethodId)
                {
                    unknownMethod += 1;
                }
                else
                {
                    invalidRequest += 1;
                }

                droppedDirty = true;
            }

            FlushDropped();
        }

        private void CountEncodeFailure(VisualBridgeDebugEncodeStatus status)
        {
            lock (gate)
            {
                ownEncodeFailed += 1;
                if (status == VisualBridgeDebugEncodeStatus.TooLarge
                    || status == VisualBridgeDebugEncodeStatus.LengthOverflow)
                {
                    ownOversize += 1;
                }

                droppedDirty = true;
            }
        }

        private bool TrySendControl(VisualBridgeDebugEncodedMessage message)
        {
            return TrySendMessage(message);
        }

        private bool TrySendMessage(VisualBridgeDebugEncodedMessage message)
        {
            if (!message.IsEncoded)
            {
                CountEncodeFailure(message.Status);
                return false;
            }

            var bytes = ToBytes(message.Payload);
            if (bytes.Length > MaxMessageBytes)
            {
                CountEncodeFailure(VisualBridgeDebugEncodeStatus.TooLarge);
                return false;
            }

            var current = VolatileWire;
            if (current == null)
            {
                return false;
            }

            try
            {
                return message.TargetQueue == VisualBridgeDebugTargetQueue.Control
                    ? current.SendControl(bytes, message.Format)
                    : current.SendDebug(bytes, message.Format);
            }
            catch (Exception exception)
            {
                log?.Invoke("[debug] sending a debug message failed: " + exception.Message);
                return false;
            }
        }

        private void TrySendData(VisualBridgeDebugEncodedMessage message)
        {
            TrySendMessage(message);
        }

        private static byte[] ToBytes(ReadOnlyMemory<byte> payload)
        {
            if (payload.Length == 0)
            {
                return Array.Empty<byte>();
            }

            if (MemoryMarshal.TryGetArray(payload, out var segment)
                && segment.Array != null
                && segment.Offset == 0
                && segment.Count == segment.Array.Length)
            {
                // 编码器与消息构建都直接给出 byte[]：不复制。
                return segment.Array;
            }

            return payload.ToArray();
        }

        private sealed class Slot
        {
            internal Slot(string instanceId, string category)
            {
                InstanceId = instanceId ?? string.Empty;
                Category = category ?? string.Empty;
            }

            internal string InstanceId { get; }

            internal string Category { get; }
        }
    }
#endif
}
