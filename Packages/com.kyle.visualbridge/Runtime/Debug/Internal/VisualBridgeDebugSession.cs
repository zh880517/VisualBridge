using System;
using System.Collections.Generic;
using System.Threading;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 调试契约的运行时状态机（宏内唯一实现，附录 B.2/B.3）。业务只经 <see cref="VisualBridgeDebug"/> 访问。
    /// 线程模型：Start/PushParam/End 无锁读快照 + [ThreadStatic] 消息上下文；
    /// Create/Finish/Attach/Detach 与断连重置在 <see cref="Gate"/> 内整体替换快照，读侧不会看到半更新状态。
    /// </summary>
    internal static class VisualBridgeDebugSession
    {
        /// <summary>实例上限（附录 B.3）。</summary>
        internal const int MaxInstances = 1024;

        /// <summary>槽位上限：u16 从 1 起分配，65535 之后 Create 失败。</summary>
        internal const int MaxInstanceSlot = 65535;

        private const long NoFrame = -1;

        private static readonly object Gate = new object();

        // 热路径只读这一个 volatile 引用；Create/Finish/断连时整体替换。
        private static VisualBridgeDebugSnapshot s_snapshot = VisualBridgeDebugSnapshot.Disconnected;

        private static IVisualBridgeDebugTransport s_transport;
        private static IDebugMessageEncoder s_encoder;
        private static long s_frame = NoFrame;
        private static bool s_attached;

        // 以下状态只在 Gate 内访问。
        private static int s_nextSlot = 1;
        private static bool s_disconnectApplied;
        private static bool s_instanceLimitWarned;
        private static long s_sessionGeneration;
        private static readonly List<VisualBridgeDebugPendingCreate> s_pendingCreates =
            new List<VisualBridgeDebugPendingCreate>();

        // 查询处理器注册表：key 是 (category, interfaceId)。值里带 Dispatcher 与参数声明表两个委托，
        // 生产路径（生成 Dispatcher）直接调用两个运行期委托，不反射生成成员，IL2CPP 裁剪不会让结果归属
        // 静默失效（附录 B.2.3/B.5）；非标准签名的 Delegate 只作兼容适配。
        private static readonly Dictionary<(string Category, string InterfaceId), VisualBridgeDebugRequestRegistration>
            s_requestHandlers = new Dictionary<(string, string), VisualBridgeDebugRequestRegistration>();

        // 在途消息：数据只写在 Start 线程的 ThreadStatic 槽位里，s_openThreadId 是跨线程可见的“所有权”标记。
        // 其它线程调用 PushParam/End 会被判为跨线程调用并忽略（附录 B.2 的同线程约束）。
        [ThreadStatic] private static VisualBridgeDebugMessage s_activeMessage;
        private static int s_openThreadId;
        private static bool s_crossThreadWarned;

        private static long s_droppedMessages;
        private static long s_droppedOversizeMessages;
        private static long s_crossThreadCalls;

        // 帧通知状态：帧号不进入数据包，只在「连接建立」与「帧值变化且确有数据要发」时发 debugFrame。
        // s_frameSent 在会话重置/断连时清零，重连后必须重新发当前帧（允许 -1 与重复/回退）。
        private static long s_lastFrameSent = NoFrame;
        private static int s_frameSent;

        /// <summary>本次会话里因无连接 / 无编码器 / 编码失败 / 连接换代而丢弃的消息数（会话重置时归零）。</summary>
        internal static long DroppedMessages
        {
            get { return Interlocked.Read(ref s_droppedMessages); }
        }

        /// <summary>本次会话里因单条载荷超过 1 MB 而丢弃的消息数（含二进制 u16 字符串长度溢出，会话重置时归零）。</summary>
        internal static long DroppedOversizeMessages
        {
            get { return Interlocked.Read(ref s_droppedOversizeMessages); }
        }

        /// <summary>本次会话里跨线程调用 PushParam/End 的次数（会话重置时归零）。</summary>
        internal static long CrossThreadCalls
        {
            get { return Interlocked.Read(ref s_crossThreadCalls); }
        }

        /// <summary>当前是否已挂接且传输层报告已连接。</summary>
        internal static bool IsConnected
        {
            get
            {
                var transport = Volatile.Read(ref s_transport);
                return Volatile.Read(ref s_attached) && transport != null && SafeIsConnected(transport);
            }
        }

        /// <summary>运行环境类型；未注入传输时按编译平台给出默认值。</summary>
        internal static ConnectType CurrentConnectType
        {
            get
            {
                var transport = Volatile.Read(ref s_transport);
                if (transport != null)
                {
                    try
                    {
                        return transport.ConnectType;
                    }
                    catch (Exception exception)
                    {
                        VisualBridgeDebugDiagnostics.Warning(
                            "VisualBridgeDebug 读取传输层 ConnectType 失败，退回编译平台默认值：" + exception.Message);
                    }
                }

#if UNITY_EDITOR
                return ConnectType.Editor;
#else
                return ConnectType.Player;
#endif
            }
        }

        /// <summary>注入传输实现并挂接；由 VisualBridge.Debug.Bridge 调用。注入即视为新会话。</summary>
        internal static void SetTransport(IVisualBridgeDebugTransport transport)
        {
            lock (Gate)
            {
                // 附录 B.3.2：Install 是会话切换触发点。无论旧会话是否连接，注入新传输一律重置
                // （实例、槽位、待发描述、连接代次全部作废），旧会话的 pending 不会带进新传输。
                Volatile.Write(ref s_transport, transport);
                Volatile.Write(ref s_attached, transport != null);
                ResetSessionLocked();
                s_disconnectApplied = true;
                RefreshConnectionLocked();
            }
        }

        /// <summary>解除挂接并清空会话状态；由 VisualBridge.Debug.Bridge 调用。</summary>
        internal static void ClearTransport()
        {
            lock (Gate)
            {
                Volatile.Write(ref s_attached, false);
                Volatile.Write(ref s_transport, null);
                ResetSessionLocked();
                s_disconnectApplied = true;
            }
        }

        /// <summary>显式挂接（附录 B.2）：重连后调用，按需 flush 待发描述。</summary>
        internal static void Attach()
        {
            lock (Gate)
            {
                if (Volatile.Read(ref s_transport) == null)
                {
                    // 未注入传输：空实现，不产生任何状态。
                    return;
                }

                Volatile.Write(ref s_attached, true);
                RefreshConnectionLocked();
            }
        }

        /// <summary>显式解除挂接（附录 B.2）：按断连语义重置会话状态。</summary>
        internal static void Detach()
        {
            lock (Gate)
            {
                Volatile.Write(ref s_attached, false);
                ResetSessionLocked();
                s_disconnectApplied = true;
            }
        }

        internal static bool Create(string instanceId, string category, string resName, string debugInfo)
        {
            if (string.IsNullOrEmpty(instanceId))
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug.Create 收到空 instanceId，已忽略。");
                return false;
            }

            if (Volatile.Read(ref s_transport) == null)
            {
                // 未挂接（没有注入传输）：与宏关闭一致，返回 false 且不产生任何状态。
                return false;
            }

            lock (Gate)
            {
                RefreshConnectionLocked();

                var snapshot = s_snapshot;
                if (snapshot.Instances.Contains(instanceId))
                {
                    // 重复 Create：不重复加入、不重发描述，返回 true 并告警（附录 B.3）。
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug.Create 重复实例 '" + instanceId + "'：已在实例集合中，不重发描述。");
                    return true;
                }

                if (snapshot.Instances.Count >= MaxInstances)
                {
                    if (!s_instanceLimitWarned)
                    {
                        s_instanceLimitWarned = true;
                        VisualBridgeDebugDiagnostics.Warning(
                            "VisualBridgeDebug 实例数达到上限 " + MaxInstances + "，后续 Create 失败（每会话只告警一次）。");
                    }

                    return false;
                }

                if (s_nextSlot > MaxInstanceSlot)
                {
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug 槽位耗尽（上限 " + MaxInstanceSlot + "），Create '" + instanceId + "' 失败。");
                    return false;
                }

                ushort instanceSlot = (ushort)s_nextSlot;
                s_nextSlot++;

                var instances = new HashSet<string>(snapshot.Instances, StringComparer.Ordinal) { instanceId };
                var slots = new Dictionary<string, ushort>(snapshot.Slots, StringComparer.Ordinal)
                {
                    [instanceId] = instanceSlot,
                };
                var categories = new Dictionary<ushort, string>(snapshot.Categories)
                {
                    [instanceSlot] = category ?? string.Empty,
                };
                PublishLocked(new VisualBridgeDebugSnapshot(instances, slots, categories, snapshot.Connected));

                var transport = Volatile.Read(ref s_transport);
                if (snapshot.Connected && transport != null)
                {
                    SendCreate(transport, instanceId, category, resName, debugInfo, instanceSlot);
                }
                else
                {
                    // 无连接：描述入队，连接建立后按入队顺序 flush 一次（附录 B.3）。
                    s_pendingCreates.Add(
                        new VisualBridgeDebugPendingCreate(instanceId, category, resName, debugInfo, instanceSlot));
                }

                return true;
            }
        }

        internal static bool Finish(string instanceId)
        {
            if (string.IsNullOrEmpty(instanceId))
            {
                return false;
            }

            if (Volatile.Read(ref s_transport) == null)
            {
                // 未挂接：与宏关闭一致，没有可结束的会话。
                return false;
            }

            lock (Gate)
            {
                RefreshConnectionLocked();

                var snapshot = s_snapshot;
                if (!snapshot.Instances.Contains(instanceId))
                {
                    return false;
                }

                ushort instanceSlot;
                if (!snapshot.Slots.TryGetValue(instanceId, out instanceSlot))
                {
                    instanceSlot = 0;
                }

                var instances = new HashSet<string>(snapshot.Instances, StringComparer.Ordinal);
                instances.Remove(instanceId);
                var slots = new Dictionary<string, ushort>(snapshot.Slots, StringComparer.Ordinal);
                slots.Remove(instanceId);
                var categories = new Dictionary<ushort, string>(snapshot.Categories);
                if (snapshot.Slots.TryGetValue(instanceId, out ushort finishedSlot))
                {
                    categories.Remove(finishedSlot);
                }

                PublishLocked(new VisualBridgeDebugSnapshot(instances, slots, categories, snapshot.Connected));

                // Create 还没 flush：直接撤销待发描述，避免向客户端制造“建了立刻结束”的实例。
                bool createWasPending = RemovePendingLocked(instanceId) > 0;
                var transport = Volatile.Read(ref s_transport);
                if (!createWasPending && snapshot.Connected && transport != null)
                {
                    SendFinish(transport, instanceId, instanceSlot);
                }

                return true;
            }
        }

        internal static bool Start(string instanceId, string category, ushort methodId, string iface, string method)
        {
            // 热路径：只做一次 volatile 读快照，零锁零分配（快照内已含实例集合与连接态）。
            var snapshot = Volatile.Read(ref s_snapshot);

            // 未知实例先返回且不计数：调用方从未 Create，或实例已在断连时作废（附录 B.3.1）。
            if (!snapshot.Instances.Contains(instanceId))
            {
                return false;
            }

            if (!snapshot.Connected)
            {
                // 已挂接但未连接（含还没观察到的断连）：已知实例的事件直接丢弃并计数；
                // 未挂接时与宏关闭一致，不计数。
                if (Volatile.Read(ref s_transport) != null)
                {
                    Interlocked.Increment(ref s_droppedMessages);
                }

                return false;
            }

            if (Volatile.Read(ref s_openThreadId) != 0)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug.Start 在上一条消息 End 之前被调用，已忽略（生成代码必须串行使用）。");
                return false;
            }

            ushort instanceSlot;
            if (!snapshot.Slots.TryGetValue(instanceId, out instanceSlot))
            {
                return false;
            }

            var transport = Volatile.Read(ref s_transport);
            if (transport == null || !SafeIsConnected(transport))
            {
                // 无连接：直接丢弃并计数，不编码、不入队（附录 B.2）。
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            var encoder = Volatile.Read(ref s_encoder);
            if (encoder == null)
            {
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            long frame = Volatile.Read(ref s_frame);
            long generation = SafeGeneration(transport);
            if (Interlocked.CompareExchange(ref s_openThreadId, Thread.CurrentThread.ManagedThreadId, 0) != 0)
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug.Start 并发抢占消息槽位失败，已忽略。");
                return false;
            }

            try
            {
                encoder.Begin(VisualBridgeDebugMessageKind.Debug, instanceId, category, iface, method, methodId,
                    instanceSlot, 0u);
            }
            catch (Exception exception)
            {
                Volatile.Write(ref s_openThreadId, 0);
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 编码器 Begin 抛出异常，消息丢弃：" + exception.Message);
                return false;
            }

            s_activeMessage = new VisualBridgeDebugMessage(
                VisualBridgeDebugMessageKind.Debug, instanceId, category, iface, method, instanceSlot, methodId, 0u,
                frame, generation, encoder);
            return true;
        }

        internal static void PushParam(string name, ushort tag, object value)
        {
            int ownerThreadId = Volatile.Read(ref s_openThreadId);
            if (ownerThreadId == 0)
            {
                return;
            }

            if (ownerThreadId != Thread.CurrentThread.ManagedThreadId)
            {
                // 消息上下文只存在于 Start 线程，其它线程压参数只能丢弃并计数（附录 B.2 同线程约束）。
                MarkCrossThreadCall("PushParam");
                return;
            }

            if (string.IsNullOrEmpty(name))
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug.PushParam 忽略空参数名（name 必填）。");
                return;
            }

            if (name.Length > 64)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug.PushParam 参数名超过 64 字符（生成器应保证不超过），远端可能截断：'" + name + "'。");
            }

            // 用 Start 时绑定的编码器：中途 SetEncoder 不能把同一条消息劈成两个实现（附录 B.2.1）。
            var encoder = s_activeMessage.Encoder;
            if (encoder == null)
            {
                return;
            }

            try
            {
                encoder.PushParam(name, tag, value);
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 编码器 PushParam 抛出异常，参数 '" + name + "' 丢弃：" + exception.Message);
            }
        }

        internal static bool End()
        {
            int ownerThreadId = Volatile.Read(ref s_openThreadId);
            if (ownerThreadId == 0)
            {
                // 另一线程在 Start/End 之间重置了会话：本线程的 ThreadStatic 上下文还在，
                // 仍要收尾已绑定的编码器，避免留下半条消息（附录 B.2.1）。
                CloseAbandonedMessage();
                return false;
            }

            if (ownerThreadId != Thread.CurrentThread.ManagedThreadId)
            {
                // 消息归 Start 线程：这里读不到它的 ThreadStatic 上下文，等 Start 线程 End 或会话重置。
                MarkCrossThreadCall("End");
                return false;
            }

            var message = s_activeMessage;
            s_activeMessage = default;
            Volatile.Write(ref s_openThreadId, 0);

            // 用 Start 时绑定的编码器；即使中途 SetEncoder(null) 也必须调用它的 End 收尾（附录 B.2.1）。
            var encoder = message.Encoder;
            if (encoder == null)
            {
                return false;
            }

            VisualBridgeDebugEncodedMessage encoded;
            try
            {
                // 无论是否已断连都调用 End，保证编码器不会留下半条消息。
                encoded = encoder.End();
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 编码器 End 抛出异常，消息丢弃：" + exception.Message);
                return false;
            }

            if (encoded.Status != VisualBridgeDebugEncodeStatus.Ok)
            {
                CountDropped(encoded.Status);
                return false;
            }

            var transport = Volatile.Read(ref s_transport);
            if (!Volatile.Read(ref s_attached) || transport == null || !SafeIsConnected(transport) ||
                !Volatile.Read(ref s_snapshot).Connected)
            {
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            if (SafeGeneration(transport) != message.ConnectionGeneration)
            {
                // Start 之后连接已换代：旧会话的槽位不能发到新连接（附录 B.3 的连接内槽位语义）。
                Interlocked.Increment(ref s_droppedMessages);
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug.End 检测到连接已换代，消息丢弃（槽位属于上一条连接）。");
                return false;
            }

            try
            {
                // 帧通知先于数据：帧号变化时补一条 debugFrame 控制消息；Create/Finish 不参与帧分组。
                SendFrameBeforeData(transport, message.Frame);
                if (message.Kind == VisualBridgeDebugMessageKind.DebugResult)
                {
                    transport.SendResult(message.RequestSeq, encoded);
                }
                else
                {
                    transport.SendEvent(message.InstanceSlot, message.MethodId, message.Category, message.Iface,
                        message.Method, message.Frame, encoded);
                }

                return true;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug 发送失败，消息丢弃：" + exception.Message);
                return false;
            }
        }

        internal static bool StartResult(VisualBridgeDebugRequest request)
        {
            if (!request.IsValid)
            {
                return false;
            }

            if (Volatile.Read(ref s_openThreadId) != 0)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug.StartResult 在上一条消息 End 之前被调用，已忽略。");
                return false;
            }

            var transport = Volatile.Read(ref s_transport);
            if (transport == null || !SafeIsConnected(transport))
            {
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            var encoder = Volatile.Read(ref s_encoder);
            if (encoder == null)
            {
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            // 实例存活校验（附录 B.6 验收）：实例已 Finish 时句柄作废，不产生任何消息。
            if (!IsInstanceAlive(request.InstanceId))
            {
                VisualBridgeDebugQueryQueue.Discard(request.RequestId);
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            // 超时/作废：晚到结果丢弃并计入 dropped，同时释放句柄（B.6，防长跑泄漏）。
            if (VisualBridgeDebugQueryQueue.CompleteResult(request.RequestId)
                == VisualBridgeDebugQueryCompletion.Expired)
            {
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            long generation = SafeGeneration(transport);
            var snapshot = Volatile.Read(ref s_snapshot);
            string category = string.IsNullOrEmpty(request.Category)
                ? snapshot.GetCategory(request.InstanceSlot)
                : request.Category;

            // 归属只取 7 参句柄携带的值（生成的 Dispatcher 一次构造好）；缺失时按附录 A.5 省略
            // iface/method，消费端按 requestId 兜底。不再反射生成成员（IL2CPP 裁剪安全）。
            string iface = request.InterfaceId;
            string method = request.Method;

            if (Interlocked.CompareExchange(ref s_openThreadId, Thread.CurrentThread.ManagedThreadId, 0) != 0)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug.StartResult 并发抢占消息槽位失败，已忽略。");
                return false;
            }

            try
            {
                encoder.Begin(VisualBridgeDebugMessageKind.DebugResult, request.InstanceId, category, iface, method,
                    request.MethodId, request.InstanceSlot, request.RequestId);
            }
            catch (Exception exception)
            {
                Volatile.Write(ref s_openThreadId, 0);
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 编码器 Begin 抛出异常，结果丢弃：" + exception.Message);
                return false;
            }

            s_activeMessage = new VisualBridgeDebugMessage(
                VisualBridgeDebugMessageKind.DebugResult, request.InstanceId, category, iface, method,
                request.InstanceSlot, request.MethodId, request.RequestId, Volatile.Read(ref s_frame), generation,
                encoder);
            return true;
        }

        internal static bool RejectRequest(VisualBridgeDebugRequest request, string reason)
        {
            if (!request.IsValid)
            {
                return false;
            }

            var transport = Volatile.Read(ref s_transport);
            if (transport == null || !SafeIsConnected(transport))
            {
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            // 超时之后才到的拒绝不再回失败应答（超时应答已经发过），只释放句柄并计入 dropped。
            if (VisualBridgeDebugQueryQueue.CompleteReject(request.RequestId)
                == VisualBridgeDebugQueryCompletion.Expired)
            {
                Interlocked.Increment(ref s_droppedMessages);
                return false;
            }

            try
            {
                transport.SendReject(request.RequestId, reason ?? string.Empty);
                return true;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug 发送失败应答失败：" + exception.Message);
                return false;
            }
        }

        internal static VisualBridgeDebugDiagnosticsSnapshot GetDiagnostics()
        {
            return new VisualBridgeDebugDiagnosticsSnapshot(DroppedMessages, DroppedOversizeMessages, CrossThreadCalls);
        }

        /// <summary>已挂接且传输层报告已连接（查询运行期入队前的连接判定）。</summary>
        internal static bool IsAttachedAndConnected
        {
            get
            {
                var transport = Volatile.Read(ref s_transport);
                return Volatile.Read(ref s_attached) && transport != null && SafeIsConnected(transport);
            }
        }

        /// <summary>实例是否存活（Create 加入、Finish 与断连移除）；一次 volatile 读快照。</summary>
        internal static bool IsInstanceAlive(string instanceId)
        {
            return !string.IsNullOrEmpty(instanceId) && Volatile.Read(ref s_snapshot).Instances.Contains(instanceId);
        }

        /// <summary>实例 id → 槽位 + 槽位绑定的分类；未知实例返回 false。</summary>
        internal static bool TryGetInstanceSlot(string instanceId, out ushort instanceSlot, out string category)
        {
            var snapshot = Volatile.Read(ref s_snapshot);
            if (!string.IsNullOrEmpty(instanceId) && snapshot.Slots.TryGetValue(instanceId, out instanceSlot))
            {
                category = snapshot.GetCategory(instanceSlot);
                return true;
            }

            instanceSlot = 0;
            category = null;
            return false;
        }

        /// <summary>查询失败应答（通道 1 的 response）：未连接时无处回应，只返回 false 不计数。</summary>
        internal static bool SendQueryError(uint requestSeq, string code, string detail)
        {
            var transport = Volatile.Read(ref s_transport);
            if (transport == null || !SafeIsConnected(transport))
            {
                return false;
            }

            try
            {
                transport.SendQueryError(requestSeq, code ?? string.Empty, detail ?? string.Empty);
                return true;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug 发送查询失败应答失败：" + exception.Message);
                return false;
            }
        }

        /// <summary>业务拒绝的失败应答（不含错误码，码由传输层按通道 1 的 response 补齐）。</summary>
        internal static bool SendReject(uint requestSeq, string reason)
        {
            var transport = Volatile.Read(ref s_transport);
            if (transport == null || !SafeIsConnected(transport))
            {
                return false;
            }

            try
            {
                transport.SendReject(requestSeq, reason ?? string.Empty);
                return true;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug 发送失败应答失败：" + exception.Message);
                return false;
            }
        }

        internal static void SetFrame(long frame)
        {
            Volatile.Write(ref s_frame, frame < 0 ? NoFrame : frame);
        }

        /// <summary>计数一次编码级丢弃；TooLarge/LengthOverflow 同时计入 oversize（E4 的 dropped 聚合读取）。</summary>
        private static void CountDropped(VisualBridgeDebugEncodeStatus status)
        {
            Interlocked.Increment(ref s_droppedMessages);
            if (status == VisualBridgeDebugEncodeStatus.TooLarge
                || status == VisualBridgeDebugEncodeStatus.LengthOverflow)
            {
                Interlocked.Increment(ref s_droppedOversizeMessages);
            }

            switch (status)
            {
                case VisualBridgeDebugEncodeStatus.TooLarge:
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug 单条载荷超过 1 MB，已丢弃并计数（不阻塞后续消息）。");
                    break;
                case VisualBridgeDebugEncodeStatus.LengthOverflow:
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug 字符串超过二进制 u16 长度上限，已丢弃并计数。");
                    break;
                case VisualBridgeDebugEncodeStatus.UnsupportedValue:
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug 编码器收到九种声明类型之外的参数值，整条消息已丢弃（收窄由生成代码显式转换）。");
                    break;
            }
        }

        /// <summary>
        /// 数据消息写出前检查帧号：只有「帧值变化且确有数据要发」才补一条 debugFrame。
        /// 连接建立时已经发过当前帧，因此同一帧的后续数据不会再产生控制消息。
        /// </summary>
        private static void SendFrameBeforeData(IVisualBridgeDebugTransport transport, long frame)
        {
            long normalized = frame < 0 ? NoFrame : frame;
            if (Volatile.Read(ref s_frameSent) != 0 && Interlocked.Read(ref s_lastFrameSent) == normalized)
            {
                return;
            }

            if (SendFrame(transport, normalized))
            {
                Interlocked.Exchange(ref s_lastFrameSent, normalized);
                Volatile.Write(ref s_frameSent, 1);
            }
        }

        /// <summary>连接建立后先发当前帧（含 -1 = 无帧）；失败时保持未发送状态，下一条数据消息会重试。</summary>
        private static void SendCurrentFrameLocked(IVisualBridgeDebugTransport transport)
        {
            long frame = Volatile.Read(ref s_frame);
            if (SendFrame(transport, frame))
            {
                Interlocked.Exchange(ref s_lastFrameSent, frame);
                Volatile.Write(ref s_frameSent, 1);
            }
        }

        private static bool SendFrame(IVisualBridgeDebugTransport transport, long frame)
        {
            try
            {
                transport.SendControl(VisualBridgeDebugControlMessages.CreateFrame(frame));
                return true;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 发送 debugFrame 控制消息失败（不影响后续数据消息）：" + exception.Message);
                return false;
            }
        }

        internal static void SetEncoder(IDebugMessageEncoder encoder)
        {
            Volatile.Write(ref s_encoder, encoder);
        }

        internal static void RegisterRequestHandler(string category, string interfaceId, Delegate handler)
        {
            RegisterRequestHandler(category, interfaceId, handler, null);
        }

        internal static void RegisterRequestHandler(string category, string interfaceId, Delegate handler,
            Delegate parameterDecoder)
        {
            lock (Gate)
            {
                var key = (category ?? string.Empty, interfaceId ?? string.Empty);
                if (handler == null)
                {
                    s_requestHandlers.Remove(key);
                    return;
                }

                var dispatcher = handler as VisualBridgeDebugRequestDispatcher;
                if (dispatcher == null)
                {
                    // 兼容非标准委托（手写处理器）：签名相同就按 DynamicInvoke 适配；
                    // 生成代码一律用运行期委托类型，不走这条路径（附录 B.5）。
                    var legacy = handler;
                    dispatcher = (methodId, instanceId, instanceSlot, requestSeq, parameters) =>
                        (bool)legacy.DynamicInvoke(new object[]
                        {
                            methodId, instanceId, instanceSlot, requestSeq, parameters,
                        });
                }

                var decoder = parameterDecoder as VisualBridgeDebugRequestParameterDecoder;
                s_requestHandlers[key] = new VisualBridgeDebugRequestRegistration(
                    key.Item1, key.Item2, dispatcher, decoder);
            }
        }

        /// <summary>按 (category, interfaceId) 取注册项；查询运行期入队时用。</summary>
        internal static bool TryGetRequestHandler(string category, string interfaceId,
            out VisualBridgeDebugRequestRegistration registration)
        {
            registration = null;
            lock (Gate)
            {
                return s_requestHandlers.TryGetValue((category ?? string.Empty, interfaceId ?? string.Empty),
                    out registration);
            }
        }

        /// <summary>
        /// 分类内按方法号反查处理器：方法号在分类内唯一（附录 B.5），所以参数声明表能命中方法号即命中接口。
        /// 用于二进制信封不带 iface 的请求；纯委托调用，不反射生成成员。
        /// </summary>
        internal static bool TryFindRequestHandler(string category, ushort methodId,
            out VisualBridgeDebugRequestRegistration registration)
        {
            registration = null;
            if (string.IsNullOrEmpty(category))
            {
                return false;
            }

            VisualBridgeDebugRequestRegistration[] candidates;
            lock (Gate)
            {
                if (s_requestHandlers.Count == 0)
                {
                    return false;
                }

                var matches = new List<VisualBridgeDebugRequestRegistration>();
                foreach (var pair in s_requestHandlers)
                {
                    if (pair.Value != null && string.Equals(pair.Key.Category, category, StringComparison.Ordinal))
                    {
                        matches.Add(pair.Value);
                    }
                }

                candidates = matches.ToArray();
            }

            for (int index = 0; index < candidates.Length; index++)
            {
                if (candidates[index].TryGetParameters(methodId, out _, out _, out _))
                {
                    registration = candidates[index];
                    return true;
                }
            }

            return false;
        }

        /// <summary>检测连接态变化；必须在 Gate 内调用。断连时重置，建连后 flush 待发描述。</summary>
        private static void RefreshConnectionLocked()
        {
            var transport = Volatile.Read(ref s_transport);
            bool connected = Volatile.Read(ref s_attached) && transport != null && SafeIsConnected(transport);
            if (connected)
            {
                long generation = SafeGeneration(transport);
                if (s_snapshot.Connected && generation == s_sessionGeneration)
                {
                    return;
                }

                if (!s_disconnectApplied)
                {
                    // 没观察到断连的重连（连接代次已变化）：上一个会话的实例、槽位与待发描述全部作废。
                    ResetSessionLocked();
                }

                s_disconnectApplied = false;
                s_sessionGeneration = generation;
                PublishLocked(s_snapshot.WithConnected(true));
                // 附录 A.5：连接建立后先发一条当前帧；之后的数据消息只在帧值变化时补发。
                SendCurrentFrameLocked(transport);
                FlushPendingLocked(transport);
                return;
            }

            if (!s_snapshot.Connected && s_disconnectApplied)
            {
                return;
            }

            ResetSessionLocked();
            s_disconnectApplied = true;
        }

        private static void FlushPendingLocked(IVisualBridgeDebugTransport transport)
        {
            if (s_pendingCreates.Count == 0)
            {
                return;
            }

            for (int index = 0; index < s_pendingCreates.Count; index++)
            {
                var pending = s_pendingCreates[index];
                SendCreate(transport, pending.InstanceId, pending.Category, pending.ResName, pending.DebugInfo,
                    pending.InstanceSlot);
            }

            // flush 只做一次：发送后清空，不重发。
            s_pendingCreates.Clear();
        }

        private static int RemovePendingLocked(string instanceId)
        {
            int removed = 0;
            for (int index = s_pendingCreates.Count - 1; index >= 0; index--)
            {
                if (string.Equals(s_pendingCreates[index].InstanceId, instanceId, StringComparison.Ordinal))
                {
                    s_pendingCreates.RemoveAt(index);
                    removed++;
                }
            }

            return removed;
        }

        private static void ResetSessionLocked()
        {
            // 会话重置前把本线程还没 End 的消息收尾，避免编码器留下半条消息（附录 B.2.1/B.4.1）。
            CloseAbandonedMessage();
            PublishLocked(VisualBridgeDebugSnapshot.Disconnected);
            s_nextSlot = 1;
            s_pendingCreates.Clear();
            s_instanceLimitWarned = false;
            Interlocked.Exchange(ref s_droppedMessages, 0);
            Interlocked.Exchange(ref s_droppedOversizeMessages, 0);
            Interlocked.Exchange(ref s_crossThreadCalls, 0);
            Interlocked.Exchange(ref s_lastFrameSent, NoFrame);
            Volatile.Write(ref s_frameSent, 0);
            // 查询队列、在途与作废表同属本次会话：断连/重装时一起清空（附录 B.6）。
            VisualBridgeDebugQueryQueue.ResetSession();
            s_crossThreadWarned = false;
            s_sessionGeneration = 0;
            s_activeMessage = default;
            Volatile.Write(ref s_openThreadId, 0);
        }

        /// <summary>
        /// 收尾本线程尚未 End 的消息：只调用它绑定的编码器 End()，载荷丢弃。
        /// 用于会话在 Start/End 之间被重置的情况（附录 B.2.1：编码器不能留下半条消息）。
        /// </summary>
        private static void CloseAbandonedMessage()
        {
            var message = s_activeMessage;
            if (message.Encoder == null)
            {
                return;
            }

            s_activeMessage = default;
            try
            {
                message.Encoder.End();
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 收尾未完成消息时编码器 End 抛出异常：" + exception.Message);
            }
        }

        private static void MarkCrossThreadCall(string operation)
        {
            Interlocked.Increment(ref s_crossThreadCalls);
            if (s_crossThreadWarned)
            {
                return;
            }

            s_crossThreadWarned = true;
            VisualBridgeDebugDiagnostics.Warning(
                "VisualBridgeDebug." + operation + " 与 Start 不在同一线程：调试消息要求 Start→PushParam→End 同线程连续调用，本次调用已忽略。");
        }

        private static void PublishLocked(VisualBridgeDebugSnapshot snapshot)
        {
            Volatile.Write(ref s_snapshot, snapshot);
        }

        private static void SendCreate(IVisualBridgeDebugTransport transport, string instanceId, string category,
            string resName, string debugInfo, ushort instanceSlot)
        {
            try
            {
                transport.SendCreate(instanceId, category, resName, debugInfo, instanceSlot);
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 发送实例描述失败，实例 '" + instanceId + "' 未送达：" + exception.Message);
            }
        }

        private static void SendFinish(IVisualBridgeDebugTransport transport, string instanceId, ushort instanceSlot)
        {
            try
            {
                transport.SendFinish(instanceId, instanceSlot);
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 发送实例结束失败，实例 '" + instanceId + "'：" + exception.Message);
            }
        }

        private static bool SafeIsConnected(IVisualBridgeDebugTransport transport)
        {
            try
            {
                return transport.IsConnected;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 读取传输层连接态失败，按未连接处理：" + exception.Message);
                return false;
            }
        }

        private static long SafeGeneration(IVisualBridgeDebugTransport transport)
        {
            try
            {
                return transport.ConnectionGeneration;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 读取传输层连接代次失败，按同一连接处理：" + exception.Message);
                return s_sessionGeneration;
            }
        }
    }
#endif
}
