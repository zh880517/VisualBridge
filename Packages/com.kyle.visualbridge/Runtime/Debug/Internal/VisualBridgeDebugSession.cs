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

        /// <summary>
        /// **活跃实例登记**（E11）：与「会话快照」分开的一套状态，只有 <see cref="Finish"/> 与
        /// 换传输（<see cref="SetTransport"/>/<see cref="ClearTransport"/>）才移除。
        ///
        /// 为什么需要它：宿主的断连结算（<see cref="Detach"/>，附录 A.9 的"最后一条连接关闭"）会清空
        /// 会话快照（实例、槽位、待发描述），但**实例本身还在跑**。旧实现把"快照清空"当成"实例消失"，
        /// 于是任何一次连接抖动（端口探测、临时连接、DAP 重连）之后，仍然活着的实例都只能等模块
        /// 自己重新 Create；而模块重发的 Create 会拿到**新槽位**，消费端按 (category, instanceId,
        /// instanceSlot) 建立的查询归属就对不上了——这是 `runtime-e2e` 的 #10 飘红的**一种候选机制**。
        /// 登记表让"活着的实例"跨会话复位保留描述与**首选槽位**，重连后由
        /// <see cref="ReplayRegistrationsLocked"/> 重放。
        /// **边界**：#10 的成因未做统计级 A/B（探测建链的时序同样是候选），本机制只是"从机制上
        /// 消除掉其中一种可能"，不宣称已被定为唯一成因。
        /// </summary>
        private static readonly List<Registration> s_registrations = new List<Registration>();

        /// <summary>
        /// 下一次连上时是否重放登记。只有宿主显式 <see cref="Detach"/>（它**观察到**整栈断开，
        /// 附录 A.9 的结算入口）才置位；会话自己惰性发现的断连（没有宿主结算）仍按旧语义作废登记，
        /// 因为那时无法区分"抖动"与"真的断开"，保守丢弃。
        /// </summary>
        private static bool s_replayPending;

        /// <summary>累计重放的 <c>debugCreate</c> 条数（诊断/trace 用；不参与业务判断）。</summary>
        private static long s_replayedCreates;

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

        /// <summary>
        /// 实例是否在当前会话里登记（G1c 的发射端用它做幂等 Create）。纯只读：与 <see cref="Start"/> 一样
        /// 只做一次 volatile 快照读，不触发连接刷新、不改任何状态。待发 Create 已把实例登记进快照，
        /// 所以"已挂接、无连接"也算已登记；会话重置后则为 false。
        /// </summary>
        internal static bool IsInstanceRegistered(string instanceId)
        {
            if (string.IsNullOrEmpty(instanceId))
            {
                return false;
            }

            var snapshot = Volatile.Read(ref s_snapshot);
            return snapshot.Instances.Contains(instanceId);
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

        /// <summary>显式挂接（附录 B.2）：重连后调用，按需 flush 待发描述并重放仍活着的登记。</summary>
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

                var transport = Volatile.Read(ref s_transport);
                if (transport != null)
                {
                    // 关闭期间连接就建立过：那次 flush 一定失败，而 RefreshConnectionLocked 在
                    // "已连接且同代次"时会早退。重开路径（面板打开上报）必须在这里强制补发一次，
                    // 否则会话快照有实例、传输层没有槽位，之后每条事件都计 unknownSlot，直到重连。
                    FlushPendingLocked(transport);
                    // E11：宿主结算过的断连（Detach）在重连后把仍活着的登记重放回去（沿用原槽位）。
                    ReplayRegistrationsLocked(transport);
                }
            }
        }

        /// <summary>
        /// 显式解除挂接（附录 B.2）：按断连语义重置会话快照，但**保留仍然活着的登记**（E11）。
        /// 下一秒就可能有新连接压上来（探测落选、临时连接退出、面板重开），那时靠重放把实例
        /// 描述送回去；只有 <see cref="Finish"/> 或换传输才会真正注销一条登记。
        /// </summary>
        internal static void Detach()
        {
            lock (Gate)
            {
                Volatile.Write(ref s_attached, false);
                ResetSessionLocked(keepRegistrations: true);
                s_disconnectApplied = true;
                s_replayPending = true;
                VisualBridgeDebugDiagnostics.Log(
                    "[debug-session] detached; " + s_registrations.Count
                    + " live registration(s) kept for replay on the next attach");
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

                // E11：会话复位后同一实例会再次 Create（发射端自愈或模块重发）。登记还在 ⇒ 这不是
                // "新实例"，而是"上一个会话的同一实例"：**沿用首选槽位**重建。槽位漂移会让消费端按
                // instanceSlot 建立的查询归属失效——这是 #10 的一种候选机制（成因未定论，见字段注释）。
                int slotsBefore = s_nextSlot;
                var registration = FindRegistrationLocked(instanceId);
                bool newRegistration = registration == null;
                if (newRegistration)
                {
                    if (s_registrations.Count >= MaxInstances)
                    {
                        if (!s_instanceLimitWarned)
                        {
                            s_instanceLimitWarned = true;
                            VisualBridgeDebugDiagnostics.Warning(
                                "VisualBridgeDebug 登记数达到上限 " + MaxInstances + "，后续 Create 失败（每会话只告警一次）。");
                        }

                        return false;
                    }

                    registration = new Registration();
                    registration.InstanceId = instanceId;
                }

                ushort instanceSlot;
                if (!TryReserveSlotLocked(newRegistration ? 0 : registration.Slot, out instanceSlot))
                {
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug 槽位耗尽（上限 " + MaxInstanceSlot + "），Create '" + instanceId + "' 失败。");
                    return false;
                }

                registration.Category = category ?? string.Empty;
                registration.ResName = resName ?? string.Empty;
                registration.DebugInfo = debugInfo ?? string.Empty;
                registration.Slot = instanceSlot;
                if (newRegistration)
                {
                    s_registrations.Add(registration);
                }
                else if (!snapshot.Connected)
                {
                    VisualBridgeDebugDiagnostics.Log(
                        "[debug-session] re-created '" + instanceId + "' from its live registration (slot="
                        + instanceSlot + ") while the session was detached");
                }

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
                    if (!SendCreate(transport, instanceId, category, resName, debugInfo, instanceSlot))
                    {
                        // 发送失败（例如控制队列满导致连接关闭）时必须回滚本地发布，
                        // 否则本地有、远端没有，调试器与运行时状态永久分叉。
                        // 总开关关闭属于"抑制"而非失败：静默回滚，不告警也不计数（附录 A.5 的 encodeFailed 不含开关）。
                        PublishLocked(snapshot);
                        // 槽位也要退回去：发送失败从未对外公布这个槽位，不回退会让关闭期反复 Create
                        // 耗尽 65535 个槽位（F7-P2-5）。Gate 内 next == slotsBefore + 1；
                        // 若发送失败触发了会话重置（next 已被重置），则保留重置后的值，不能盲目回写。
                        if (s_nextSlot > slotsBefore)
                        {
                            s_nextSlot = slotsBefore;
                        }

                        if (newRegistration)
                        {
                            // 这一次 Create 没有落地：登记也不能留（否则会在下次重连时被重放成幽灵实例）。
                            s_registrations.Remove(registration);
                        }

                        if (VisualBridgeDebugReporting.Enabled)
                        {
                            VisualBridgeDebugDiagnostics.Warning(
                                "VisualBridgeDebug Create '" + instanceId + "' 发送失败，已回滚本地发布。");
                        }

                        return false;
                    }
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
                    // E11：实例已随会话复位从快照消失，但**登记**还在。Finish 是"这条登记不再存活"
                    // 的权威声明，必须在这里注销，否则下一次重连会把它当成仍活着的登记重放回来
                    // （复活已结束的实例，验收红线）。
                    if (RemoveRegistrationLocked(instanceId))
                    {
                        VisualBridgeDebugDiagnostics.Log(
                            "[debug-session] finished '" + instanceId + "' while its session was already reset "
                            + "(live registration dropped; it will not be replayed)");
                    }

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
                    if (!SendFinish(transport, instanceId, instanceSlot))
                    {
                        // 结束帧没送达：恢复本地发布，让下一次 Finish 仍有机会送达。
                        // 关闭期抑制同理不告警（抑制 ≠ 失败）。
                        //
                        // **E11（评审 P1-1）：登记在发送前**从未**注销，所以这里也不需要回滚登记**——
                        // 注销只发生在"结束确实生效"之后（下面 `return true` 之前）。旧写法先注销、
                        // 失败只回滚快照，会让"在跑的实例"从登记表消失：本会话余下时间不可重放，
                        // 而重复 `Create` 又因实例仍在快照里早退，补不回来。
                        PublishLocked(snapshot);
                        if (VisualBridgeDebugReporting.Enabled)
                        {
                            VisualBridgeDebugDiagnostics.Warning(
                                "VisualBridgeDebug Finish '" + instanceId + "' 发送失败，已回滚本地移除。");
                        }

                        return false;
                    }
                }

                // 结束确实生效（待发描述已撤销 / Finish 已送达 / 本来就没有连接可发）：注销登记。
                RemoveRegistrationLocked(instanceId);
                return true;
            }
        }

        internal static bool Start(string instanceId, string category, ushort methodId, string iface, string method)
        {
            // 热路径：只做一次 volatile 读快照，零锁零分配（快照内已含实例集合与连接态）。
            var snapshot = Volatile.Read(ref s_snapshot);

            if (!VisualBridgeDebugReporting.Enabled)
            {
                // 总开关关闭：抑制不是丢弃。不编码、不入队、不计数、不告警（附录 A.5 的 encodeFailed 不含开关）。
                return false;
            }

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

            // 入队前准入（附录 A.9）：槽位/方法号校验与 debugCategories / debugInstances 筛选都在
            // 编码之前完成；未命中即整条消息不编码、不入队，计数由传输层累加并经 dropped 上报。
            var outboundGate = transport as IVisualBridgeDebugOutboundGate;
            if (outboundGate != null && !outboundGate.TryAdmitEvent(instanceSlot, instanceId, category, methodId))
            {
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

            if (!VisualBridgeDebugReporting.Enabled && message.Kind != VisualBridgeDebugMessageKind.DebugResult)
            {
                // 抑制发生在**编码完成之后**（编码器必须 End 收尾，半条消息会污染下一条）：
                // Start 之后开关被关掉时，已编码的调试事件直接丢弃，不写队列、不计数、不告警。
                // 查询结果（debugResult）是宿主请求的应答，不是调试流，不能在这里被吞掉。
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
                var sent = message.Kind == VisualBridgeDebugMessageKind.DebugResult
                    ? transport.SendResult(message.RequestSeq, encoded)
                    : transport.SendEvent(message.InstanceSlot, message.MethodId, message.Category, message.Iface,
                        message.Method, message.Frame, encoded);

                if (!sent)
                {
                    // 入队失败必须可见：数据消息没有真正写出，按丢弃计数并让 End 返回 false（A.9 的丢弃语义）。
                    Interlocked.Increment(ref s_droppedMessages);
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug 数据消息入队失败（未连接 / 队列满 / 载荷超限），消息丢弃。");
                    return false;
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
                return transport.SendReject(request.RequestId, reason ?? string.Empty);
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

        /// <summary>
        /// 是否仍挂接（不要求连接存活）。只给宿主装配的 EditMode 用例用：<see cref="IsAttachedAndConnected"/>
        /// 在"已挂接但无连接"与"已 Detach"两种状态下都是 false，区分不了"窗口内关闭有没有结算成 Detach"。
        /// </summary>
        internal static bool IsAttached
        {
            get { return Volatile.Read(ref s_attached); }
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
                return transport.SendQueryError(requestSeq, code ?? string.Empty, detail ?? string.Empty);
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
                return transport.SendReject(requestSeq, reason ?? string.Empty);
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning("VisualBridgeDebug 发送失败应答失败：" + exception.Message);
                return false;
            }
        }

        /// <summary>当前会话帧号（只读；从未设置时为 -1）。供"没有新帧可传"的路径补齐帧号。</summary>
        internal static long CurrentFrame
        {
            get { return Volatile.Read(ref s_frame); }
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
                // SendControl 现在返回 "是否入队成功"：入队失败时不能把帧标记成已发送（否则同帧后续数据不再补帧）。
                return transport.SendControl(VisualBridgeDebugControlMessages.CreateFrame(frame));
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

        /// <summary>累计重放的 <c>debugCreate</c> 条数（诊断/EditMode 用例读取；不参与业务判断）。</summary>
        internal static long ReplayedCreates
        {
            get { return Interlocked.Read(ref s_replayedCreates); }
        }

        /// <summary>当前仍活着的登记条数（诊断用；与"会话快照里的实例数"是两套状态）。</summary>
        internal static int LiveRegistrations
        {
            get
            {
                lock (Gate)
                {
                    return s_registrations.Count;
                }
            }
        }

        /// <summary>检测连接态变化；必须在 Gate 内调用。断连时重置，建连后 flush 待发描述并重放登记。</summary>
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
                    // 没观察到断连的重连（连接代次已变化）：上一个会话的实例、槽位、待发描述与登记全部作废。
                    // 这条路径没有宿主结算（没有 Detach），无法区分抖动与真断开 ⇒ 保守丢弃，不重放。
                    ResetSessionLocked();
                }

                s_disconnectApplied = false;
                s_sessionGeneration = generation;
                PublishLocked(s_snapshot.WithConnected(true));
                // 附录 A.5：连接建立后先发一条当前帧；之后的数据消息只在帧值变化时补发。
                SendCurrentFrameLocked(transport);
                FlushPendingLocked(transport);
                // E11：宿主结算过的断连（Detach）在重连后把仍活着的登记重放回去（沿用原槽位）。
                ReplayRegistrationsLocked(transport);
                return;
            }

            if (!s_snapshot.Connected && s_disconnectApplied)
            {
                return;
            }

            ResetSessionLocked();
            s_disconnectApplied = true;
        }

        /// <summary>
        /// 重放"仍活着的登记"（E11 §2/§3）：只在宿主 <see cref="Detach"/> 结算过的断连之后、
        /// 重连（<see cref="RefreshConnectionLocked"/> 的建连分支或 <see cref="Attach"/>）时调用。
        ///
        /// 只重放**当前会话快照里没有**的登记：本会话已经发过的实例不重发（否则消费端会看到重复描述）；
        /// 重放**沿用登记的首选槽位**，这样消费端按 (category, instanceId, instanceSlot) 做的查询归属
        /// 在重连前后指向同一条绑定 ⇒ 机制上消除"槽位漂移导致归属失效"这一种 #10 候选成因
        /// （成因未做统计级 A/B 定论，见 `s_registrations` 的注释）。
        /// 发送失败时回滚本次发布并保留登记，等下一次重连/Attach 再试（不静默丢实例）。
        /// </summary>
        private static void ReplayRegistrationsLocked(IVisualBridgeDebugTransport transport)
        {
            if (!s_replayPending || transport == null)
            {
                return;
            }

            // 未连接时重放必然失败（`SendCreate` 没有活动 wire）：**不要**在这里消费标记，
            // 否则"Detach 后先 Attach 一次、连接稍后才建立"会让这次重放永久丢失（评审 P2-1）。
            if (!SafeIsConnected(transport))
            {
                return;
            }

            if (s_registrations.Count == 0)
            {
                s_replayPending = false;
                return;
            }

            bool everyRegistrationHandled = true;
            int replayed = 0;
            for (int index = 0; index < s_registrations.Count; index++)
            {
                var registration = s_registrations[index];
                if (s_snapshot.Instances.Contains(registration.InstanceId))
                {
                    continue;
                }

                int slotsBefore = s_nextSlot;
                var previous = s_snapshot;
                ushort instanceSlot;
                if (!TryReserveSlotLocked(registration.Slot, out instanceSlot))
                {
                    everyRegistrationHandled = false;
                    VisualBridgeDebugDiagnostics.Warning(
                        "VisualBridgeDebug 重放实例 '" + registration.InstanceId + "' 失败：槽位耗尽。");
                    continue;
                }

                registration.Slot = instanceSlot;
                var instances = new HashSet<string>(previous.Instances, StringComparer.Ordinal) { registration.InstanceId };
                var slots = new Dictionary<string, ushort>(previous.Slots, StringComparer.Ordinal)
                {
                    [registration.InstanceId] = instanceSlot,
                };
                var categories = new Dictionary<ushort, string>(previous.Categories)
                {
                    [instanceSlot] = registration.Category,
                };
                PublishLocked(new VisualBridgeDebugSnapshot(instances, slots, categories, previous.Connected));

                if (!SendCreate(transport, registration.InstanceId, registration.Category, registration.ResName,
                        registration.DebugInfo, instanceSlot))
                {
                    PublishLocked(previous);
                    if (s_nextSlot > slotsBefore)
                    {
                        s_nextSlot = slotsBefore;
                    }

                    everyRegistrationHandled = false;
                    if (VisualBridgeDebugReporting.Enabled)
                    {
                        VisualBridgeDebugDiagnostics.Warning(
                            "VisualBridgeDebug 重放实例 '" + registration.InstanceId + "' 发送失败，保留登记等待下一次连接。");
                    }

                    continue;
                }

                replayed++;
            }

            // 只有"每一条都处理成功"才算这次重放完成；失败/槽位耗尽的条目留在登记里，
            // 下一次 Attach/建连继续重试（与 `FlushPendingLocked` 的"只移除真正发出的项"同一纪律）。
            s_replayPending = !everyRegistrationHandled;

            Interlocked.Add(ref s_replayedCreates, replayed);
            VisualBridgeDebugDiagnostics.Log(
                "[debug-session] replayed " + replayed + "/" + s_registrations.Count
                + " live debugCreate(s) after the session reset (slot-preserving)"
                + (everyRegistrationHandled ? string.Empty : "; retry pending"));
        }

        private static void FlushPendingLocked(IVisualBridgeDebugTransport transport)
        {
            if (s_pendingCreates.Count == 0)
            {
                return;
            }

            // 只移除真正发出的项：关闭期抑制 / 队列满导致的失败必须留在队列里，重开或重连后再 flush。
            // 旧实现无条件 Clear，会把"会话快照有实例、传输层没有槽位"永久钉死（之后每条事件都计 unknownSlot）。
            int kept = 0;
            for (int index = 0; index < s_pendingCreates.Count; index++)
            {
                var pending = s_pendingCreates[index];
                if (SendCreate(transport, pending.InstanceId, pending.Category, pending.ResName, pending.DebugInfo,
                        pending.InstanceSlot))
                {
                    continue;
                }

                s_pendingCreates[kept] = pending;
                kept++;
            }

            if (kept < s_pendingCreates.Count)
            {
                s_pendingCreates.RemoveRange(kept, s_pendingCreates.Count - kept);
            }
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

        /// <summary>登记表里按实例 id 查找（Gate 内）。</summary>
        private static Registration FindRegistrationLocked(string instanceId)
        {
            for (int index = 0; index < s_registrations.Count; index++)
            {
                if (string.Equals(s_registrations[index].InstanceId, instanceId, StringComparison.Ordinal))
                {
                    return s_registrations[index];
                }
            }

            return null;
        }

        /// <summary>注销一条登记（实例真正结束）；返回是否确实移除了。</summary>
        private static bool RemoveRegistrationLocked(string instanceId)
        {
            for (int index = s_registrations.Count - 1; index >= 0; index--)
            {
                if (string.Equals(s_registrations[index].InstanceId, instanceId, StringComparison.Ordinal))
                {
                    s_registrations.RemoveAt(index);
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// 预留槽位（Gate 内）：<paramref name="preferred"/> &gt; 0 时优先沿用它（会话复位后的重放/重建），
        /// 被本会话其它实例占用则退回单调分配。<see cref="VisualBridgeDebugSnapshot.Categories"/> 是
        /// "本会话已占用槽位"的唯一真源（与快照一起整体替换），所以这里不需要第二份占用表。
        /// </summary>
        private static bool TryReserveSlotLocked(int preferred, out ushort instanceSlot)
        {
            if (preferred >= 1 && preferred <= MaxInstanceSlot && !s_snapshot.Categories.ContainsKey((ushort)preferred))
            {
                instanceSlot = (ushort)preferred;
                if (s_nextSlot <= instanceSlot)
                {
                    s_nextSlot = instanceSlot + 1;
                }

                return true;
            }

            while (s_nextSlot <= MaxInstanceSlot)
            {
                var candidate = (ushort)s_nextSlot;
                s_nextSlot++;
                if (!s_snapshot.Categories.ContainsKey(candidate))
                {
                    instanceSlot = candidate;
                    return true;
                }
            }

            instanceSlot = 0;
            return false;
        }

        private static void ResetSessionLocked(bool keepRegistrations = false)
        {
            // 会话重置前把本线程还没 End 的消息收尾，避免编码器留下半条消息（附录 B.2.1/B.4.1）。
            CloseAbandonedMessage();
            PublishLocked(VisualBridgeDebugSnapshot.Disconnected);
            if (keepRegistrations)
            {
                // 重放要沿用原槽位：把分配游标抬到所有活登记之上，断连期间新 Create 不会抢占它们的槽位。
                s_nextSlot = 1;
                for (int index = 0; index < s_registrations.Count; index++)
                {
                    int next = s_registrations[index].Slot + 1;
                    if (next > s_nextSlot)
                    {
                        s_nextSlot = next;
                    }
                }
            }
            else
            {
                // 换传输（Install/Uninstall）与"没有人结算"的断连：登记与游标一起作废（附录 B.3.2）。
                s_registrations.Clear();
                s_replayPending = false;
                s_nextSlot = 1;
                Interlocked.Exchange(ref s_replayedCreates, 0);
            }

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

        private static bool SendCreate(IVisualBridgeDebugTransport transport, string instanceId, string category,
            string resName, string debugInfo, ushort instanceSlot)
        {
            try
            {
                return transport.SendCreate(instanceId, category, resName, debugInfo, instanceSlot);
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 发送实例描述失败，实例 '" + instanceId + "' 未送达：" + exception.Message);
                return false;
            }
        }

        private static bool SendFinish(IVisualBridgeDebugTransport transport, string instanceId, ushort instanceSlot)
        {
            try
            {
                return transport.SendFinish(instanceId, instanceSlot);
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 发送实例结束失败，实例 '" + instanceId + "'：" + exception.Message);
                return false;
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

        /// <summary>
        /// 一条"仍然活着"的实例登记（E11）：实例描述（会话复位后重放要用）+ **首选槽位**。
        /// 首选槽位是"这个实例最近一次被消费端看到时用的槽位"，重连后沿用它，
        /// 消费端按 (category, instanceId, instanceSlot) 建立的查询归属才不会被一次抖动切断。
        /// 只有 <see cref="Finish"/> 与换传输会移除登记——**绝不**因为连接断开而移除。
        /// </summary>
        private sealed class Registration
        {
            internal string InstanceId { get; set; }

            internal string Category { get; set; }

            internal string ResName { get; set; }

            internal string DebugInfo { get; set; }

            /// <summary>首选槽位；0 表示还没有（新登记在分配时立即写入）。</summary>
            internal ushort Slot { get; set; }
        }
    }
#endif
}
