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
        private static readonly Dictionary<(string Category, string InterfaceId), Delegate> s_requestHandlers =
            new Dictionary<(string, string), Delegate>();

        // 在途消息：数据只写在 Start 线程的 ThreadStatic 槽位里，s_openThreadId 是跨线程可见的“所有权”标记。
        // 其它线程调用 PushParam/End 会被判为跨线程调用并忽略（附录 B.2 的同线程约束）。
        [ThreadStatic] private static VisualBridgeDebugMessage s_activeMessage;
        private static int s_openThreadId;
        private static bool s_crossThreadWarned;

        private static long s_droppedMessages;
        private static long s_crossThreadCalls;

        /// <summary>本次会话里因无连接 / 无编码器而丢弃的消息数（会话重置时归零）。</summary>
        internal static long DroppedMessages
        {
            get { return Interlocked.Read(ref s_droppedMessages); }
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
                PublishLocked(new VisualBridgeDebugSnapshot(instances, slots, snapshot.Connected));

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
                PublishLocked(new VisualBridgeDebugSnapshot(instances, slots, snapshot.Connected));

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
                encoder.Begin(methodId, instanceSlot, 0u);
            }
            catch (Exception exception)
            {
                Volatile.Write(ref s_openThreadId, 0);
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 编码器 Begin 抛出异常，消息丢弃：" + exception.Message);
                return false;
            }

            s_activeMessage = new VisualBridgeDebugMessage(
                VisualBridgeDebugMessageKind.Event, instanceSlot, methodId, 0u, frame, generation, category, iface,
                method, encoder);
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

            ReadOnlyMemory<byte> payload;
            try
            {
                // 无论是否已断连都调用 End，保证编码器不会留下半条消息。
                payload = encoder.End();
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 编码器 End 抛出异常，消息丢弃：" + exception.Message);
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
                if (message.Kind == VisualBridgeDebugMessageKind.Result)
                {
                    transport.SendResult(message.RequestSeq, payload);
                }
                else
                {
                    transport.SendEvent(message.InstanceSlot, message.MethodId, message.Category, message.Iface,
                        message.Method, message.Frame, payload);
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

            long generation = SafeGeneration(transport);
            if (Interlocked.CompareExchange(ref s_openThreadId, Thread.CurrentThread.ManagedThreadId, 0) != 0)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug.StartResult 并发抢占消息槽位失败，已忽略。");
                return false;
            }

            try
            {
                encoder.Begin(request.MethodId, request.InstanceSlot, request.RequestId);
            }
            catch (Exception exception)
            {
                Volatile.Write(ref s_openThreadId, 0);
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 编码器 Begin 抛出异常，结果丢弃：" + exception.Message);
                return false;
            }

            s_activeMessage = new VisualBridgeDebugMessage(
                VisualBridgeDebugMessageKind.Result, request.InstanceSlot, request.MethodId, request.RequestId,
                Volatile.Read(ref s_frame), generation, null, null, null, encoder);
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

        internal static void SetFrame(long frame)
        {
            Volatile.Write(ref s_frame, frame < 0 ? NoFrame : frame);
        }

        internal static void SetEncoder(IDebugMessageEncoder encoder)
        {
            Volatile.Write(ref s_encoder, encoder);
        }

        internal static void RegisterRequestHandler(string category, string interfaceId, Delegate handler)
        {
            lock (Gate)
            {
                var key = (category ?? string.Empty, interfaceId ?? string.Empty);
                if (handler == null)
                {
                    s_requestHandlers.Remove(key);
                }
                else
                {
                    s_requestHandlers[key] = handler;
                }
            }
        }

        /// <summary>供 D4 的请求分发取已注册的处理器。</summary>
        internal static bool TryGetRequestHandler(string category, string interfaceId, out Delegate handler)
        {
            lock (Gate)
            {
                return s_requestHandlers.TryGetValue((category ?? string.Empty, interfaceId ?? string.Empty),
                    out handler);
            }
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
            Interlocked.Exchange(ref s_crossThreadCalls, 0);
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
