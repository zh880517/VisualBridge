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
    /// - 上报总开关由 <see cref="VisualBridgeDebugReporting"/> 承载，但它只拦调试流的四条消息
    ///   （<c>debug</c> / <c>debugCreate</c> / <c>debugFinish</c> / <c>debugFrame</c>，附录 A.2 的
    ///   <c>debugSetEnabled</c>）；<c>response</c> / <c>reject</c> / <c>dropped</c> 不是调试流，
    ///   关闭期间照常送出（否则宿主只能等超时，而业务 handler 可能已经跑过）；
    /// - 入站只接受通道 1 的 JSON <c>request</c>，其余帧按未知槽位/未知方法丢弃并计数，绝不断连；
    ///   总开关关闭时 <c>request</c> 立即以 <c>runtime.debugNotEnabled</c> 拒绝，不入队、不执行业务 handler。
    /// </summary>
    public sealed class VisualBridgeDebugTransport : IVisualBridgeDebugTransport, IVisualBridgeDebugOutboundGate, IDisposable
    {
        /// <summary>dropped 上报的最小间隔（附录 A.9 的「按周期上报」，配合 1 s 心跳）。</summary>
        public const int DroppedReportIntervalMs = 500;

        private const int MaxMessageBytes = VisualBridgeDebugPayloadLimits.MaxMessageBytes;

        /// <summary>
        /// 关闭期查询的失败码（附录 A.6 的 <c>runtime.debugNotEnabled</c>）。F7 已登记进
        /// <c>contract-manifest.json</c> 的 <c>errors.debugQuery</c> 与 <see cref="VisualBridgeDebugQueryErrors"/>：
        /// 宿主拿到的是可映射的码，而不是只能等 4 s 超时。
        /// </summary>
        private const string DebugNotEnabledCode = VisualBridgeDebugQueryErrors.DebugNotEnabled;

        private readonly object gate = new object();
        private readonly object droppedGate = new object();
        private readonly Dictionary<ushort, Slot> slots = new Dictionary<ushort, Slot>();
        /// <summary>
        /// 连接栈（E10）：<c>Bind</c> 压栈，断连/解绑出栈并**恢复到上一条仍然存活的连接**。
        /// 背景：Runtime Bridge 允许同时存在多条连接（Editor Play、Player、MCP 的每次工具调用临时连接），
        /// 而通道 1 的调试流只有一条活动 wire。旧实现是「最后一次绑定者胜出」，MCP 的临时连接一断，
        /// Editor/Player 的槽位与实例表就永久失效（要等重连）。栈语义让临时连接退出后自动回到原连接。
        /// 只有栈顶（活动连接）订阅事件；被压栈的连接退订但不 Dispose，它的槽位/计数随绑定存档，
        /// 恢复时原样取回（见 <see cref="WireBinding"/>）。
        /// </summary>
        private readonly List<WireBinding> wireStack = new List<WireBinding>();
        private readonly ConnectType connectType;
        private readonly Action<string> log;
        private readonly int droppedReportIntervalMs;

        private IVisualBridgeDebugWire wire;
        /// <summary>
        /// 会话所属者的连接代次：本会话**第一条**连上来的那条（栈从空变非空时赋值），
        /// 整栈清空时归零。栈内任何一条连接断开都不改变它（见 <see cref="ConnectionGeneration"/>）。
        /// </summary>
        private long ownerGeneration;
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

        /// <summary>
        /// 当前连接代次：锚定**会话所属者**（本会话建立时的第一条连接），而不是"当前栈底"、
        /// 更不是活动连接（E10）。
        /// 理由：MCP 的临时连接压栈/出栈期间代次必须不变，否则会话层的 <c>RefreshConnectionLocked</c>
        /// 会把实例表当成「没观察到断连的重连」清空。若锚定"当前栈底"，先连者（MCP）断开时栈底会换成
        /// 后连的面板 ⇒ 代次跳变 ⇒ 面板连接着却丢掉整个会话——与 E10 要消灭的症状同源，只是触发顺序相反。
        /// 因此 <c>ownerGeneration</c> 只在**栈从空变非空**时（新会话开始）赋值，整栈清空时归零；
        /// 栈内任何一条连接断开都不改变它。真正的重连（栈空后再连）会拿到新的连接代次 ⇒ 仍会触发会话重置。
        /// 未绑定时为 0（附录 B.1.3 允许传输层恒返回 0，此时由宿主显式 Detach）。
        /// </summary>
        public long ConnectionGeneration
        {
            get
            {
                lock (gate)
                {
                    return wireStack.Count == 0 ? 0L : ownerGeneration;
                }
            }
        }

        /// <summary>
        /// 传输层是否还有可用连接：**栈内任一绑定仍 <see cref="IVisualBridgeDebugWire.IsOpen"/>**（F9）。
        /// 不是"活动 wire 的 IsOpen"：<see cref="VisualBridgeBridgeSocket"/> 在 <c>stopping = true</c>
        /// （<c>HandleConnectionEnd</c>）时就把 <c>IsOpen</c> 翻 false，**早于** <c>NotifyClosed</c> 触发的
        /// <c>Closed</c>；这条缝里活动 wire 已算关闭，但被压栈的连接还开着。旧语义会让会话层的
        /// <c>RefreshConnectionLocked</c> 在缝里走断连分支、清空实例与槽位，
        /// 而面板的 TCP 仍连着——与 E10 修掉的 P0 同型的窄窗口。
        /// 整栈为空（或全部已关）时仍返回 false，附录 A.9 的"最后一条连接关闭即重置"不变。
        /// 发送路径不变：仍只写活动 wire；缝里发送失败按丢弃结算，不再重置会话。
        /// </summary>
        public bool IsConnected
        {
            get
            {
                lock (gate)
                {
                    for (int index = wireStack.Count - 1; index >= 0; index--)
                    {
                        if (wireStack[index].Wire.IsOpen)
                        {
                            return true;
                        }
                    }

                    return false;
                }
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
        /// 绑定一条新连接（压栈）：当前连接的状态（槽位、计数、dropped 上报基线）存档，
        /// 新连接从零开始（附录 A.9：每次连接重新开始），并订阅该连接的入站帧、关闭与心跳节拍。
        /// 宿主在握手完成后调用；**活动 wire** 重复绑定是幂等的（不重置状态）。
        /// 被压栈的同一 wire 再次绑定会再压一条（生产不可达：每条 link 只绑定一次）：栈里允许重复引用，
        /// 但只有最新那条订阅事件，出栈因此必须自顶向下找（见 <see cref="IndexOfLocked"/>）。
        /// 断连时经 <see cref="OnWireClosed"/> 出栈，并恢复到上一条仍然存活的连接。
        /// </summary>
        public void Bind(IVisualBridgeDebugWire target)
        {
            if (target == null)
            {
                Unbind();
                return;
            }

            WireBinding previous = null;
            WireBinding binding;
            lock (gate)
            {
                var active = ActiveWireLocked;
                if (active != null && ReferenceEquals(active.Wire, target))
                {
                    return;
                }

                if (active != null)
                {
                    // 存档活动连接的状态：它被压栈后仍可能恢复（E10 的栈语义）。
                    CaptureStateLocked(active);
                    previous = active;
                }

                binding = new WireBinding(
                    target,
                    (kind, payload) => OnFrameReceived(target, kind, payload),
                    () => OnWireClosed(target),
                    () => OnWireTick(target));
                // ResetConnectionStateLocked 会连带清掉代次；压栈不算新会话，必须把会话所属者带过去。
                var newSession = wireStack.Count == 0;
                var previousOwner = ownerGeneration;
                wireStack.Add(binding);
                wire = target;
                ResetConnectionStateLocked();
                ownerGeneration = newSession ? target.Generation : previousOwner;
            }

            // 只有栈顶订阅；被压栈的连接退订但不 Dispose（它的状态留给出栈恢复）。
            Unsubscribe(previous);
            Subscribe(binding);
        }

        /// <summary>
        /// 显式解绑**全部**连接（断连即重置：槽位/计数/实例表全部作废）。
        /// 生产调用者是 <see cref="Dispose"/>（Play 会话/宿主回收）；<c>Bind(null)</c> 也走这里，
        /// 但当前没有调用者。宿主处理单条连接的 `link.Closed` 时**不**走这里——那走
        /// <see cref="OnWireClosed"/>（只弹断开的那一条，并在还有存活连接时恢复上一条）；
        /// 会话是否 Detach 由宿主按「传输层是否还有存活连接」决定。测试可直接调用来验证整栈清空。
        /// </summary>
        public void Unbind()
        {
            WireBinding[] removed;
            lock (gate)
            {
                removed = wireStack.ToArray();
                wireStack.Clear();
                wire = null;
                ResetConnectionStateLocked();
            }

            for (int index = 0; index < removed.Length; index++)
            {
                Detach(removed[index]);
            }
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

        public bool SendCreate(string instanceId, string category, string resName, string debugInfo, ushort instanceSlot)
        {
            var message = UseBinary()
                ? VisualBridgeDebugWireMessages.CreateBinary(category, instanceId, instanceSlot, resName, debugInfo)
                : VisualBridgeDebugWireMessages.CreateJson(category, instanceId, instanceSlot, resName, debugInfo);
            if (!TrySendDebugControl(message))
            {
                return false;
            }

            // Create 是分类进入协议的唯一入口：只有描述真正发出后才登记槽位，客户端才可能解码后续消息。
            lock (gate)
            {
                slots[instanceSlot] = new Slot(instanceId, category);
            }

            FlushDropped();
            return true;
        }

        public bool SendFinish(string instanceId, ushort instanceSlot)
        {
            if (!VisualBridgeDebugReporting.Enabled)
            {
                // 关闭期抑制 Finish：连槽位失效都不做。会话层会回滚本地移除，传输层若在这里先删槽位，
                // 重开后同一实例的每条事件都会被判 unknownSlot，直到重连（P1-A）。
                return false;
            }

            string category;
            Slot removedSlot = null;
            lock (gate)
            {
                if (slots.TryGetValue(instanceSlot, out var slot))
                {
                    category = slot.Category;
                    removedSlot = slot;
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
            var sent = TrySendDebugControl(message);
            if (!sent && removedSlot != null)
            {
                // 发送失败（队列满 / 连接异常 / 闸门在两步之间关闭）必须把槽位放回去：
                // "先失效后发送"只有在发送成功时才成立，否则会话层回滚了、传输层没有。
                lock (gate)
                {
                    if (!slots.ContainsKey(instanceSlot))
                    {
                        slots[instanceSlot] = removedSlot;
                    }
                }
            }

            FlushDropped();
            return sent;
        }

        public bool SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method,
            long frame, VisualBridgeDebugEncodedMessage message)
        {
            if (!VisualBridgeDebugReporting.Enabled)
            {
                // 抑制不是丢弃：不写数据队列，也不做槽位准入（否则会把"关闭"记成 unknownSlot）。
                return false;
            }

            if (!message.IsEncoded)
            {
                CountEncodeFailure(message.Status);
                return false;
            }

            if (!TryAdmitEvent(instanceSlot, null, category, methodId))
            {
                return false;
            }

            var sent = TrySendData(message);
            FlushDropped();
            return sent;
        }

        public bool SendResult(uint requestSeq, VisualBridgeDebugEncodedMessage message)
        {
            if (!message.IsEncoded)
            {
                CountEncodeFailure(message.Status);
                return false;
            }

            // 查询结果是对宿主请求的应答（A.5 的 response 语义，不是调试流）：开关关闭时仍必须送达，
            // 否则宿主只能等 4 s 超时，且与"关闭期 request 立即被拒、handler 不执行"的答复路径不一致。
            var sent = TrySendMessage(message);
            FlushDropped();
            return sent;
        }

        public bool SendControl(VisualBridgeDebugEncodedMessage message)
        {
            var sent = TrySendDebugControl(message);
            FlushDropped();
            return sent;
        }

        public bool SendQueryError(uint requestSeq, string code, string detail)
        {
            var sent = TrySendControl(VisualBridgeDebugWireMessages.Response(requestSeq, code, detail));
            FlushDropped();
            return sent;
        }

        public bool SendReject(uint requestSeq, string reason)
        {
            // 业务拒绝：码统一取 VisualBridgeDebugQueryErrors.Rejected（附录 A.6 的 runtime.queryRejected）。
            var sent = TrySendControl(VisualBridgeDebugWireMessages.Response(requestSeq,
                VisualBridgeDebugQueryErrors.Rejected, reason));
            FlushDropped();
            return sent;
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
                else if (methodId < VisualBridgeDebugMethodIdRange.FirstCategoryMethodId)
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
            ownerGeneration = 0L;
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

        private void CaptureStateLocked(WireBinding binding)
        {
            binding.Slots = new Dictionary<ushort, Slot>(slots);
            binding.FilteredByServer = filteredByServer;
            binding.UnknownMethod = unknownMethod;
            binding.UnknownSlot = unknownSlot;
            binding.InvalidRequest = invalidRequest;
            binding.OwnEncodeFailed = ownEncodeFailed;
            binding.OwnOversize = ownOversize;
            binding.LastReported = lastReported;
            binding.LastReportedAtMs = lastReportedAtMs;
            binding.DroppedDirty = droppedDirty;
        }

        private void RestoreStateLocked(WireBinding binding)
        {
            slots.Clear();
            foreach (var pair in binding.Slots)
            {
                slots[pair.Key] = pair.Value;
            }

            filteredByServer = binding.FilteredByServer;
            unknownMethod = binding.UnknownMethod;
            unknownSlot = binding.UnknownSlot;
            invalidRequest = binding.InvalidRequest;
            ownEncodeFailed = binding.OwnEncodeFailed;
            ownOversize = binding.OwnOversize;
            lastReported = binding.LastReported;
            lastReportedAtMs = binding.LastReportedAtMs;
            droppedDirty = binding.DroppedDirty;
        }

        private WireBinding ActiveWireLocked => wireStack.Count == 0 ? null : wireStack[wireStack.Count - 1];

        private void Subscribe(WireBinding binding)
        {
            binding.Wire.FrameReceived += binding.FrameHandler;
            binding.Wire.Closed += binding.ClosedHandler;
            binding.Wire.Tick += binding.TickHandler;
        }

        private void Unsubscribe(WireBinding binding)
        {
            if (binding == null)
            {
                return;
            }

            // 只退订，不能 Dispose：被压栈的连接出栈后还要继续用。
            binding.Wire.FrameReceived -= binding.FrameHandler;
            binding.Wire.Closed -= binding.ClosedHandler;
            binding.Wire.Tick -= binding.TickHandler;
        }

        private void Detach(WireBinding binding)
        {
            if (binding == null)
            {
                return;
            }

            var target = binding.Wire;
            target.FrameReceived -= binding.FrameHandler;
            target.Closed -= binding.ClosedHandler;
            target.Tick -= binding.TickHandler;
            // 适配器（VisualBridgeRuntimeDebugWire）由传输层负责收起；宿主创建的裸实现不需要释放。
            (target as IDisposable)?.Dispose();
        }

        /// <summary>
        /// 一条连接断开（E10）：只弹出它自己；若它正是活动连接，则恢复到栈内上一条仍然存活的连接，
        /// 没有存活连接时才真正断连（槽位/计数归零，会话层据此重置）。
        /// </summary>
        private void OnWireClosed(IVisualBridgeDebugWire source)
        {
            WireBinding closed;
            WireBinding restored = null;
            var dropped = new List<WireBinding>();
            lock (gate)
            {
                int index = IndexOfLocked(source);
                if (index < 0)
                {
                    // 已经出栈（重复 Closed / 显式 Unbind 之后）：不重复结算。
                    return;
                }

                closed = wireStack[index];
                bool wasActive = index == wireStack.Count - 1;
                wireStack.RemoveAt(index);
                if (!wasActive)
                {
                    // 只有活动连接订阅事件；被压栈的连接断开时活动连接不受影响。
                    wire = ActiveWireLocked?.Wire;
                }
                else
                {
                    // 栈顶断开：向下找最后一条仍打开的连接；已关闭的中间连接一并收起（永远不会恢复）。
                    while (wireStack.Count > 0)
                    {
                        var candidate = wireStack[wireStack.Count - 1];
                        if (candidate.Wire.IsOpen)
                        {
                            restored = candidate;
                            break;
                        }

                        wireStack.RemoveAt(wireStack.Count - 1);
                        dropped.Add(candidate);
                    }

                    wire = restored?.Wire;
                    if (restored != null)
                    {
                        RestoreStateLocked(restored);
                    }
                    else
                    {
                        ResetConnectionStateLocked();
                    }
                }
            }

            Detach(closed);
            for (int index = 0; index < dropped.Count; index++)
            {
                Detach(dropped[index]);
            }

            if (restored != null)
            {
                Subscribe(restored);
            }
        }

        /// <summary>
        /// 自顶向下找绑定（F9）：同一条 wire 被重复 <c>Bind</c> 时栈里会出现多条引用同一对象的条目，
        /// 但只有**最新**那条订阅了事件（<see cref="Bind"/> 只订阅新压栈的绑定）。
        /// 取栈底方向的第一个匹配会弹出**未订阅**的旧条目，把真正订阅的条目留成死栈顶——
        /// 它再也收不到 <c>Closed</c>，于是永远不会出栈，也无法恢复它下面的存活连接。
        /// </summary>
        private int IndexOfLocked(IVisualBridgeDebugWire source)
        {
            for (int index = wireStack.Count - 1; index >= 0; index--)
            {
                if (ReferenceEquals(wireStack[index].Wire, source))
                {
                    return index;
                }
            }

            return -1;
        }

        private void OnWireTick(IVisualBridgeDebugWire source)
        {
            lock (gate)
            {
                if (!ReferenceEquals(wire, source))
                {
                    // 被压栈的连接（理论上已退订）：它的节拍不属于当前活动连接。
                    return;
                }
            }

            FlushDroppedFromTick();
        }

        private void OnFrameReceived(IVisualBridgeDebugWire source, VisualBridgePayloadKind payloadKind, byte[] payload)
        {
            lock (gate)
            {
                if (!ReferenceEquals(wire, source))
                {
                    // 被压栈的连接（理论上已退订）：丢弃它的入站帧，绝不让非活动连接执行业务查询。
                    return;
                }
            }

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

                if (!VisualBridgeDebugReporting.Enabled)
                {
                    // 总开关关闭（附录 A.2 debugSetEnabled）：查询立即失败，不入队、不执行业务 handler。
                    // 旧实现只把应答闸在出口，宿主侧会看到 handler 已执行却等不到回应——比拒绝更糟。
                    SendQueryError(request.RequestSeq, DebugNotEnabledCode,
                        "debug reporting is disabled; no query handler was executed.");
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
                else if (methodId < VisualBridgeDebugMethodIdRange.FirstCategoryMethodId)
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

        /// <summary>非调试流的控制消息（通道 1 的 response / reject）：不受总开关影响。</summary>
        private bool TrySendControl(VisualBridgeDebugEncodedMessage message)
        {
            return TrySendMessage(message);
        }

        /// <summary>调试流的控制消息（debugCreate / debugFinish / debugFrame）：受总开关拦截。</summary>
        private bool TrySendDebugControl(VisualBridgeDebugEncodedMessage message)
        {
            return VisualBridgeDebugReporting.Enabled && TrySendControl(message);
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

        private bool TrySendData(VisualBridgeDebugEncodedMessage message)
        {
            // 只有调试事件（debug）属于调试流：关闭期间一条都不写数据队列（抑制不计数，见 SendEvent）。
            // debugResult 是宿主查询的应答，走 SendResult 的非闸门路径。
            return VisualBridgeDebugReporting.Enabled && TrySendMessage(message);
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

        /// <summary>
        /// 一条连接的绑定与**它自己的**状态存档（E10 的栈语义）：被压栈时把槽位/计数/上报基线存在这里，
        /// 出栈恢复到它时原样取回。事件处理器按 wire 捕获，避免"所有连接共用一个 handler"时分不清是谁。
        /// </summary>
        private sealed class WireBinding
        {
            internal WireBinding(IVisualBridgeDebugWire wire,
                Action<VisualBridgePayloadKind, byte[]> frameHandler,
                Action closedHandler,
                Action tickHandler)
            {
                Wire = wire;
                FrameHandler = frameHandler;
                ClosedHandler = closedHandler;
                TickHandler = tickHandler;
            }

            internal IVisualBridgeDebugWire Wire { get; }

            internal Action<VisualBridgePayloadKind, byte[]> FrameHandler { get; }

            internal Action ClosedHandler { get; }

            internal Action TickHandler { get; }

            internal Dictionary<ushort, Slot> Slots;

            internal long FilteredByServer;

            internal long UnknownMethod;

            internal long UnknownSlot;

            internal long InvalidRequest;

            internal long OwnEncodeFailed;

            internal long OwnOversize;

            internal VisualBridgeDebugDroppedSnapshot LastReported;

            internal int LastReportedAtMs;

            internal bool DroppedDirty;
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
